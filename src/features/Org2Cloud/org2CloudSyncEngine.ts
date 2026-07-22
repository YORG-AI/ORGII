/**
 * Org2CloudSyncEngine — managed-cloud session PUSH (Phase 6 v1).
 *
 * Deliberately SMALL next to the self-hosted `CollabSyncEngine`: one
 * serialized sync pass over (cloud org × local session), happy-path push +
 * OCC conflict re-anchor + quota/disabled backoff. No pull-merge of remote
 * metadata into local stores yet (the panel lists teammates' sessions
 * directly via `listOrgSessions`).
 *
 * Per pass, for every cloud org that has locally-stored repo scopes
 * (`org2CloudRepoScopesAtom`) and sync not disabled
 * (`org2CloudSyncEnabledAtom`), every OWN local session whose resolved repo
 * scope key matches a scope is a push CANDIDATE. Whether a candidate is
 * actually uploaded — and at what level — is decided by the per-session
 * access ladder (`org2CloudAccessSettingsAtom`, design §13.4):
 * repo-scope matching SELECTS candidates, while the org minimum plus any
 * per-session override GATE the upload (effective 'off' ⇒ skipped entirely,
 * 'metadata_only' ⇒ metadata upsert only, 'full_replay' ⇒ metadata +
 * segments). A candidate that passes the ladder is pushed:
 *
 * 1. metadata upsert (`toRemoteMetadata` shape, hash-gated per pass), then
 * 2. incremental segments push mirroring the collab engine's epoch /
 *    frozen-line / tail bookkeeping — the persisted cursor is the SAME
 *    `CollabSessionPushCursor` shape (`org2CloudPushCursorsAtom`).
 *
 * ORG2_CONFLICT → re-anchor via epoch-bumped rewrite (server epoch read
 * through `getSessionEvents`). ORG2_QUOTA_EXCEEDED / ORG2_SYNC_DISABLED →
 * bounded per-org backoff. Only the actively viewed org surfaces a warning;
 * inactive orgs retry quietly at a slower cadence.
 *
 * Projects/work-items (cloud-parity Phase B): after the session push, every
 * org drives the SAME `ProjectSyncChannel` + Rust bridge as the self-hosted
 * engine, backed by the cloud RPC adapter (`org2CloudProjectsClient`). The
 * pulled state comes from `cloud_list_org_collab_state` behind a persisted
 * per-org cursor (`org2CloudCollabStateCursorsAtom`, serverTime − 2s
 * overlap), bypassed once per engine start for a COMPLETE listing — a row
 * that leaves the visible set without a tombstone can only be proven absent
 * against the full state. Work items are org-wide: no repo-scope selection.
 *
 * Cadence: fixed 60s timer chain plus a debounced pass on local event
 * writes (same `eventStoreProxy.subscribe` trigger the collab engine uses).
 * This chain is the app's ONLY recurring timer (user CPU constraint —
 * every recurring cloud pull rides inside the one pass): a hidden document
 * stretches the SAME chain to `HIDDEN_PASS_INTERVAL_MS`, and the
 * `visibilitychange` back to visible snaps it back with one immediate pass.
 */
import Message from "@src/components/Message";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";

import { ProjectSyncChannel } from "../TeamCollaboration/engine/ProjectSyncChannel";
import type { ProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import { tauriProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import { getSessionForkedFrom } from "../TeamCollaboration/forkSession";
import { isScopeMatchableImportedSession } from "../TeamCollaboration/importedSessionScopeMatch";
import {
  peekShareableScopeKeys,
  primeShareableScopeKey,
  resolveMatchingOrgRepoScope,
} from "../TeamCollaboration/repoScopeResolver";
import {
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
  taggedCloudOrgIds,
  withoutCloudOrgTag,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import { ORG2_CLOUD_EXPECTED_SCHEMA_VERSION, getCloudEndpoint } from "./config";
import {
  hasExplicitCloudShareIntent,
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
  resolveCloudPushAccess,
} from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession, schemaVersion } from "./org2CloudClient";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "./org2CloudOrgsAtom";
import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import { ensureProjectOrgForCloudOrg } from "./org2CloudProjectOrgAlias";
import * as org2CloudProjectsClient from "./org2CloudProjectsClient";
import type { CloudProjectsRpc } from "./org2CloudProjectsClient";
import {
  createCloudProjectSyncClient,
  isOrg2ProjectsErrorCode,
  toCollabOrgState,
} from "./org2CloudProjectsClient";
import {
  Org2CloudSessionSync,
  type Org2CloudSyncClientDeps,
} from "./org2CloudSessionSync";
import { isCloudPushCandidate } from "./org2CloudSessionSync";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";
import * as org2CloudSyncClient from "./org2CloudSyncClient";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";
import { Org2CloudSyncLifecycle } from "./org2CloudSyncLifecycle";

export {
  DATA_CHANGED_DEBOUNCE_MS,
  HIDDEN_PASS_INTERVAL_MS,
  PASS_INTERVAL_MS,
  PROJECT_PUSH_RETRY_DELAY_MS,
} from "./org2CloudSyncLifecycle";
export {
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSessionSync";
export type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync";

const log = createLogger("Org2CloudSyncEngine");

/** Repo-scope mirror refresh cadence (server truth changes rarely). */
const SCOPE_HYDRATE_TTL_MS = 10 * 60_000;
/** Re-probe a schema-mismatched custom endpoint after this long (an
 * in-place backend upgrade must heal without an app relaunch). */
const SCHEMA_MISMATCH_REPROBE_MS = 5 * 60_000;
/** Collab-state delta cursor safety overlap (mirrors CollabSyncEngine §9.4). */
const CURSOR_OVERLAP_MS = 2_000;

/**
 * Inbound (cloud→local) fallback cadence. Since inbound pulls are now driven
 * by Supabase Realtime (useOrg2CloudRealtime), the recurring pass only performs
 * the inbound planes (repo scopes / projects+work-items / comments) as an
 * eventual-consistency SAFETY NET — for when the socket is down, an event was
 * missed, or the custom backend has no Realtime. Outbound push is UNAFFECTED:
 * it stays event-driven (es:changed) with the full-cadence pass as its own
 * safety net. A Realtime invalidation (`invalidateOrgInbound`) bypasses this
 * gate so a live event still triggers an immediate inbound pull.
 */
const INBOUND_FALLBACK_INTERVAL_MS = 5 * 60_000;

/** Entitlement failures are retried after this bounded cool-down. Realtime
 * policy signals and explicit user changes clear the deadline immediately. */
export const ORG_BACKOFF_COOLDOWN_MS = 5 * 60_000;
/** A background org should not wake the app every five minutes for a quota
 * condition the user is not currently looking at. Selecting or explicitly
 * changing that org still clears this deadline immediately. */
export const INACTIVE_ORG_BACKOFF_COOLDOWN_MS = 30 * 60_000;

/** Projects/work-items RPC seam (Phase B), same fetch-free-fakes purpose. */
export type Org2CloudProjectsClientDeps = CloudProjectsRpc;

/** `schema_version()` probe seam (Phase C custom-endpoint gate). */
export type Org2CloudSchemaVersionProbe = () => Promise<number | null>;

export class Org2CloudSyncEngine extends Org2CloudSyncLifecycle {
  /** Org id → entitlement backoff deadline (epoch ms). */
  private readonly orgBackoffUntilMs = new Map<string, number>();
  /**
   * Org id → plane that caused the entitlement backoff. Session replay quota
   * must not block the projects/work-items control plane: users still need to
   * delete shared data while replay uploads are over quota.
   */
  private readonly orgBackoffKinds = new Map<
    string,
    "session_quota" | "sync_disabled"
  >();
  /** Whether the current deadline was established while the org was visible.
   * Selecting an org whose deadline came from a background pass resumes it. */
  private readonly orgBackoffAudiences = new Map<
    string,
    "active" | "inactive"
  >();
  /** Strongest report already emitted for the current entitlement episode.
   * An inactive log can be upgraded once to an active toast; automatic expiry
   * otherwise preserves the marker so persistent failures cannot make noise. */
  private readonly reportedBackoffAudiences = new Map<
    string,
    "active" | "inactive"
  >();
  /** orgId → last repo-scope hydration attempt (TTL-gated per pass). */
  private readonly scopeHydratedAtMs = new Map<string, number>();
  /** Cloud orgId → aliased local project-org id (ensured once per start). */
  private readonly projectOrgAliasIds = new Map<string, string>();
  /** Orgs whose CURRENT start already pulled one COMPLETE collab-state listing. */
  private readonly fullCollabStateOrgIds = new Set<string>();
  /**
   * Custom-endpoint schema gate (Phase C), KEYED BY the probed supabaseUrl:
   * the engine singleton is never stopped in production, so an endpoint
   * switch must re-probe by itself — a verdict for endpoint A can neither
   * bless nor brick endpoint B. 'ok' sticks for its URL; 'mismatch'
   * re-probes after a TTL so an in-place backend upgrade (same URL) heals
   * without an app relaunch. The toast fires once per URL per start().
   */
  private schemaGate: {
    supabaseUrl: string;
    verdict: "ok" | "mismatch";
    probedAtMs: number;
  } | null = null;
  private readonly schemaMismatchToastedUrls = new Set<string>();

  private readonly client: Org2CloudSyncClientDeps;
  private readonly projectsClient: Org2CloudProjectsClientDeps;
  private readonly projectSyncBridge: ProjectSyncBridge;
  private readonly probeSchemaVersion: Org2CloudSchemaVersionProbe;
  private readonly sessionSync: Org2CloudSessionSync;

  constructor(
    client: Org2CloudSyncClientDeps = org2CloudSyncClient,
    projectsClient: Org2CloudProjectsClientDeps = org2CloudProjectsClient,
    projectSyncBridge: ProjectSyncBridge = tauriProjectSyncBridge,
    probeSchemaVersion: Org2CloudSchemaVersionProbe = schemaVersion
  ) {
    super();
    this.client = client;
    this.projectsClient = projectsClient;
    this.projectSyncBridge = projectSyncBridge;
    this.probeSchemaVersion = probeSchemaVersion;
    this.sessionSync = new Org2CloudSessionSync(() => this.store, client);
  }

  protected override resetSyncState(): void {
    this.orgBackoffUntilMs.clear();
    this.orgBackoffKinds.clear();
    this.orgBackoffAudiences.clear();
    this.reportedBackoffAudiences.clear();
    this.sessionSync.reset();
    this.scopeHydratedAtMs.clear();
    this.projectOrgAliasIds.clear();
    this.fullCollabStateOrgIds.clear();
    this.schemaGate = null;
    this.schemaMismatchToastedUrls.clear();
  }

  protected override clearAllOrgBackoffs(): void {
    this.orgBackoffUntilMs.clear();
    this.orgBackoffKinds.clear();
    this.orgBackoffAudiences.clear();
    this.reportedBackoffAudiences.clear();
  }

  protected override invalidateFullInboundState(orgId?: string): void {
    if (orgId) this.scopeHydratedAtMs.delete(orgId);
    else this.scopeHydratedAtMs.clear();
  }

  protected override noteSessionEventActivity(sessionId: string): void {
    this.sessionSync.noteSessionEventActivity(sessionId);
  }

  protected override async syncAllOrgs(
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    this.sessionSync.beginPass();
    const store = this.store;
    if (!store) return;
    const auth = store.get(org2CloudAuthAtom);
    if (!auth) return;
    const orgs = store.get(org2CloudOrgsAtom);
    const sessionsAtPassStart = store.get(sessionsAtom);
    this.pruneRemovedOrgState(orgs, sessionsAtPassStart);
    if (orgs.length === 0) return;
    for (const org of orgs) {
      if (signal.aborted || this.generation !== generation) return;
      await this.ensureProjectOrgAlias(org);
    }
    if (!(await this.passesSchemaGate(generation))) return;
    const enabledByOrg = store.get(org2CloudSyncEnabledAtom);
    const tags = store.get(sessionOrgTagsAtom);
    // Access ladder (§13.4): read the PERSISTED settings every pass — the
    // ratchet lives here. A per-session override (mode or restricted
    // visibility) is always honored before applying the org minimum, so an automated
    // re-push can never rebuild metadata "from defaults" and silently flip
    // a session back to org/full_replay.
    const accessByOrg = store.get(org2CloudAccessSettingsAtom);
    // Admin sharing floor mirror (0002), re-read every pass like the ladder:
    // the effective per-session mode is raised to at least the org's floor
    // before it goes on the wire (the server backstops this).
    const floorByOrg = store.get(org2CloudSharingFloorAtom);
    // Repo scopes are the HARD boundary (server-enforced since the scope
    // governance change: upsert raises ORG2_SCOPE_FORBIDDEN outside them).
    // Orgs with tagged sessions are still VISITED even without scopes so the
    // loop below can invalidate now-out-of-scope tags (retract + untag);
    // they no longer cause any pushes by themselves.
    const orgsWithTaggedSessions = taggedCloudOrgIds(tags);

    // Endpoint identity captured at pass start. Every RPC re-resolves
    // getCloudEndpoint() at call time, so a mid-pass endpoint switch would
    // otherwise send this pass's still-valid OLD-backend JWT + session
    // payloads to the NEW backend. The token's own backend is recorded on
    // the auth state — bail the moment the active endpoint diverges from it.
    const passSupabaseUrl = auth.supabaseUrl;

    const fresh = await ensureFreshSession(auth);
    if (this.generation !== generation) return;
    if (!fresh) {
      log.warn("cloud sync pass skipped: token refresh failed");
      return;
    }
    // Compare-and-set: an endpoint switch (resetCloudStateForEndpointSwitch)
    // or a manual sign-out may have wiped/replaced the atom while the
    // refresh was in flight — never resurrect a signed-out state with
    // old-backend tokens; abandon the pass instead.
    if (store.get(org2CloudAuthAtom) !== auth) return;
    if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
    commitRefreshedAuth(
      (updater) => store.set(org2CloudAuthAtom, updater),
      auth,
      fresh
    );

    // Refresh the local scope mirror from server truth BEFORE picking
    // targets — a second device has no locally-set scopes at all until
    // hydration lands.
    await this.hydrateRepoScopes(fresh, orgs, generation);
    if (this.generation !== generation) return;

    const scopesByOrg = store.get(org2CloudRepoScopesAtom);
    const targets = orgs.filter(
      (org) =>
        ((scopesByOrg[org.orgId]?.length ?? 0) > 0 ||
          orgsWithTaggedSessions.has(org.orgId)) &&
        enabledByOrg[org.orgId] !== false &&
        !this.isOrgBackedOff(org.orgId)
    );

    for (const org of targets) {
      // Bail the whole pass if the endpoint changed under us (see
      // passSupabaseUrl) — never push this backend's sessions elsewhere.
      if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
      const scopes = scopesByOrg[org.orgId] ?? [];
      for (const session of store.get(sessionsAtom)) {
        if (signal.aborted || this.generation !== generation) return;
        if (!isCloudPushCandidate(session)) continue;
        // A fork is a continuation inside the source collaboration boundary,
        // not a new ordinary repo session. Repo scopes may overlap across a
        // team org and the forker's personal org, so scope matching alone
        // would leak the fork into every matching org. Durable fork
        // provenance is the authority for the implicit destination: an
        // untagged fork publishes only back to its source org. An explicit
        // user tag to this org overrides provenance for this org only; repo
        // scope and membership are still enforced below and server-side.
        // Also retract a wrong-org row produced by an older client whenever
        // this engine has a persisted/current-run push marker for it.
        const forkedFrom = getSessionForkedFrom(session);
        // Re-read LIVE tags before applying provenance. A guest fork may be
        // explicitly moved into one of this user's orgs, and an untag can land
        // while this pass awaits an earlier push.
        const tagged = isSessionTaggedToCloudOrg(
          store.get(sessionOrgTagsAtom),
          session.session_id,
          org.orgId
        );
        if (forkedFrom && forkedFrom.orgId !== org.orgId && !tagged) {
          if (this.sessionSync.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              log.info(
                `cloud retract [fork outside source org]: session ${session.session_id} org ${org.orgId}`
              );
              await this.sessionSync.retractSession(
                fresh,
                org.orgId,
                session.session_id
              );
            } catch (error) {
              if (this.generation !== generation) return;
              if (this.isBackoffError(error)) {
                this.backOffOrg(org.orgId, error);
                break;
              }
              log.warn(
                `cloud retract failed for fork outside source org ${session.session_id}:`,
                error
              );
            }
          }
          continue;
        }
        // Re-read the LIVE tags atom per session rather than the pass-start
        // `tags` snapshot: an untag from MoveToOrgDialog can land while this
        // pass awaits an earlier session's push. The untag already
        // soft-tombstoned the server row (deleteSession); pushing off a stale
        // snapshot would upsert metadata and clear `deleted_at`, resurrecting
        // a tag-only row that no later pass (now untagged and unscoped) ever
        // deletes again. (The pass-start snapshot still drives the coarse
        // org-target selection above, which self-heals on the next pass.)
        // Repo scope is a governance boundary, never an org-membership
        // selector. An ordinary session publishes only to the cloud org it was
        // explicitly created under, or to an org explicitly chosen via Move.
        // This prevents a Personal session from leaking into every team org
        // that happens to configure the same Git remote. Fork provenance has
        // already constrained untagged forks to their source org above.
        const ownedByOrg =
          session.orgId === buildCloudOrgSelectorValue(org.orgId);
        const shareIntent = hasExplicitCloudShareIntent(
          accessByOrg[org.orgId],
          session.session_id
        );
        const scopeAutoMatched = isScopeMatchableImportedSession(session);
        if (
          !forkedFrom &&
          !tagged &&
          !ownedByOrg &&
          !shareIntent &&
          !scopeAutoMatched
        ) {
          if (this.sessionSync.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              log.info(
                `cloud retract [ownership-gate (untagged/unowned/no-intent)]: session ${session.session_id} org ${org.orgId}`
              );
              await this.sessionSync.retractSession(
                fresh,
                org.orgId,
                session.session_id
              );
            } catch (error) {
              if (this.generation !== generation) return;
              if (this.isBackoffError(error)) {
                this.backOffOrg(org.orgId, error);
                break;
              }
              log.warn(
                `cloud retract failed outside explicit org ownership ${session.session_id}:`,
                error
              );
            }
          }
          continue;
        }
        const scopeKeys = this.getSessionScopeKeys(session);
        // undefined = git-remote resolution still in flight; the next pass
        // (60s / activity) picks the session up once the keys land.
        if (scopeKeys === undefined) continue;
        // Repo scope is the HARD boundary — a tag never bypasses it (the
        // server rejects out-of-scope upserts with ORG2_SCOPE_FORBIDDEN
        // anyway). Multi-remote aware: ANY of the checkout's remotes
        // (origin fork, team upstream, …) may hit an org scope; the matched
        // ORG-side scope string is what gets pushed as repoScopeKey, so the
        // server's exact-string check agrees. Forks are NOT special-cased:
        // a fork syncs back only once it sits in a local checkout of the
        // repo (the fork flow requires picking one), so its own remotes
        // carry the match. A tag that has fallen out of scope (admin
        // removed the scope, or it never matched) is INVALIDATED here:
        // retract the server row if we ever pushed it, then drop the tag so
        // the org falls out of the target set. scopeKeys null (no git
        // remote) is out of scope by definition.
        const matchedScope = await resolveMatchingOrgRepoScope(
          scopeKeys,
          scopes
        );
        if (matchedScope === null) {
          if (this.sessionSync.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              log.info(
                `cloud retract [out-of-scope (no matching org scope)]: session ${session.session_id} org ${org.orgId}`
              );
              await this.sessionSync.retractSession(
                fresh,
                org.orgId,
                session.session_id
              );
            } catch (error) {
              if (this.generation !== generation) return;
              if (this.isBackoffError(error)) {
                this.backOffOrg(org.orgId, error);
                break;
              }
              log.warn(
                `cloud retract failed for out-of-scope session ${session.session_id}:`,
                error
              );
              // Keep the tag: retry the retract next pass rather than
              // orphan a live server row.
              continue;
            }
          }
          if (tagged) {
            store.set(sessionOrgTagsAtom, (current) =>
              withoutCloudOrgTag(current, session.session_id, org.orgId)
            );
            log.info(
              `dropped out-of-scope org tag: session ${session.session_id} → org ${org.orgId}`
            );
          }
          continue;
        }
        // BEHAVIOR CHANGE (intended, §13.4): scope matching only made this
        // session a CANDIDATE — adding a repo scope no longer auto-uploads
        // at full replay. The access ladder gates the actual upload: the
        // local mode is OFF until overridden or raised by the org minimum, and
        // an effective-off session is skipped (never uploaded). A TAGGED
        // session still pushes, floored to metadata_only when its effective
        // mode is off ('off' must never reach the server — ORG2_VALIDATION).
        // The admin sharing floor lifts every ADMITTED session. Imported CLI
        // history is admitted by repo-scope matching above: the sidebar groups
        // it into that org automatically, so showing the effective floor in
        // Settings while withholding the matching cloud push would make the
        // rendered policy lie. Ordinary Personal sessions still require org
        // ownership, a tag, fork provenance, or explicit share intent.
        const floorEligible =
          Boolean(forkedFrom) ||
          tagged ||
          ownedByOrg ||
          shareIntent ||
          scopeAutoMatched;
        const access = resolveCloudPushAccess(
          accessByOrg[org.orgId],
          session.session_id,
          tagged,
          floorEligible ? floorByOrg[org.orgId] : undefined
        );
        if (!access) {
          // Effective-off and NOT tagged: the ladder grants nothing this
          // pass. But if we ALREADY published this session (a full_replay
          // past leaves a persisted segments cursor; any rung leaves a
          // metadata hash this run), 'Off' must actively RETRACT it, not just
          // skip — a bare skip leaves the last-pushed access_mode + segments
          // live, so a full_replay→off downgrade keeps teammates on full
          // replay (strictly LESS private than picking 'Metadata only', which
          // re-pushes the lowered column). Soft-tombstone it the same way an
          // untag does. §13.4.
          if (this.sessionSync.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              log.info(
                `cloud retract [effective-off ladder]: session ${session.session_id} org ${org.orgId}`
              );
              await this.sessionSync.retractSession(
                fresh,
                org.orgId,
                session.session_id
              );
            } catch (error) {
              if (this.generation !== generation) return;
              if (this.isBackoffError(error)) {
                this.backOffOrg(org.orgId, error);
                break; // Stop touching this org for the rest of the run.
              }
              log.warn(
                `cloud retract failed for session ${session.session_id}:`,
                error
              );
            }
          }
          continue;
        }
        try {
          await this.sessionSync.pushSession(
            fresh,
            org.orgId,
            session,
            matchedScope,
            access,
            signal
          );
        } catch (error) {
          if (signal.aborted || this.generation !== generation) return;
          if (this.isBackoffError(error)) {
            this.backOffOrg(org.orgId, error);
            break; // Stop touching this org for the rest of the run.
          }
          log.warn(
            `cloud push failed for session ${session.session_id}:`,
            error
          );
        }
      }
    }

    // Projects / work items (cloud-parity Phase B), AFTER the session push.
    // Deliberately over ALL orgs, not the session `targets`: shared work
    // items are org-wide (no repo-scope selection), so an org with neither
    // scopes nor tagged sessions still syncs its project plane. Only the
    // local toggle and entitlement-disable backoff gate it. Session replay
    // quota backoff deliberately does NOT: project/work-item tombstones are
    // a control-plane operation and must still drain while uploads are full.
    //
    // Inbound-fallback gate: these planes are Realtime-driven and scoped to
    // the invalidated org. Ordinary signals retain their delta cursors; only
    // reconnect recovery clears the full-listing latch above. Each org owns
    // its own fallback timestamp so a noisy org cannot starve a quiet one.
    // Consume requests only after auth/schema/outbound setup succeeds; an
    // offline or mismatched backend must leave them pending for the next pass.
    const requestedInboundOrgIds = new Set(this.pendingInboundOrgIds);
    this.pendingInboundOrgIds.clear();
    const requestedFullInboundOrgIds = new Set(this.pendingFullInboundOrgIds);
    this.pendingFullInboundOrgIds.clear();
    const forceAllInbound = this.forceAllInboundNextPass;
    this.forceAllInboundNextPass = false;
    if (forceAllInbound) {
      for (const org of orgs) requestedFullInboundOrgIds.add(org.orgId);
    }
    for (const orgId of requestedFullInboundOrgIds) {
      requestedInboundOrgIds.add(orgId);
      this.fullCollabStateOrgIds.delete(orgId);
    }
    const nowMs = Date.now();
    const inboundOrgIds = new Set(requestedInboundOrgIds);
    const fallbackInboundOrgIds = new Set<string>();
    for (const org of orgs) {
      const lastInbound = this.lastInboundPassAtMs.get(org.orgId) ?? 0;
      if (nowMs - lastInbound >= INBOUND_FALLBACK_INTERVAL_MS) {
        inboundOrgIds.add(org.orgId);
        fallbackInboundOrgIds.add(org.orgId);
      }
    }
    const pushProjects = this.forceProjectsNextPass;
    this.forceProjectsNextPass = false;
    const projectOrgIds = pushProjects
      ? new Set(orgs.map((org) => org.orgId))
      : inboundOrgIds;
    if (projectOrgIds.size > 0) {
      for (const org of orgs) {
        if (!projectOrgIds.has(org.orgId)) continue;
        if (this.generation !== generation) return;
        if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
        if (enabledByOrg[org.orgId] === false) continue;
        if (this.isOrgProjectBackedOff(org.orgId)) continue;
        try {
          // Realtime-only pulls do not probe the local outbox. Local mutation
          // requests and periodic safety passes still drain it.
          await this.syncOrgProjects(fresh, org, generation, {
            pushOutbox: pushProjects || fallbackInboundOrgIds.has(org.orgId),
          });
        } catch (error) {
          if (this.generation !== generation) return;
          if (this.isBackoffError(error)) {
            this.backOffOrg(org.orgId, error);
            continue;
          }
          // A listing can fail before ProjectSyncChannel gets far enough to
          // return per-row pushErrors. When this pass was supposed to drain
          // the durable outbox, keep the same bounded retry guarantee rather
          // than stranding the write until the minute fallback cadence.
          if (pushProjects || fallbackInboundOrgIds.has(org.orgId)) {
            this.scheduleProjectPushRetry();
          }
          log.warn(`cloud project sync failed for org ${org.orgId}:`, error);
        }
      }
    }
    if (inboundOrgIds.size > 0) {
      // Constraint: marks each inbound-due org's pass timestamp so the
      // projects-plane inbound-fallback cadence (lastInboundPassAtMs, read
      // above) stays gated. Same enabled/backoff predicate the pull used.
      for (const org of orgs) {
        if (!inboundOrgIds.has(org.orgId)) continue;
        if (enabledByOrg[org.orgId] === false) continue;
        if (this.isOrgProjectBackedOff(org.orgId)) continue;
        this.lastInboundPassAtMs.set(org.orgId, nowMs);
      }
    }
  }

  /**
   * Custom-endpoint schema gate (cloud-parity Phase C): a self-deployed
   * backend upgrades on its own cadence, so before the first sync work of a
   * start() the engine probes `schema_version()` and requires an EXACT match
   * with `ORG2_CLOUD_EXPECTED_SCHEMA_VERSION`. Mismatch ⇒ sync stays
   * disabled for this start + one warning toast (the design's only error
   * surface — deployment docs live in the infra repo). A failed probe
   * (`null`) skips the pass and re-probes next pass: a backend that cannot
   * answer the anon probe cannot serve the sync RPCs either. The OFFICIAL
   * endpoint skips the gate — it is upgraded in lockstep with app releases.
   */
  private async passesSchemaGate(generation: number): Promise<boolean> {
    const endpoint = getCloudEndpoint();
    if (endpoint.isOfficial) return true;
    const cached = this.schemaGate;
    if (cached && cached.supabaseUrl === endpoint.supabaseUrl) {
      if (cached.verdict === "ok") return true;
      // Mismatch: hold the verdict for a TTL, then re-probe — the backend
      // may have been upgraded in place.
      if (Date.now() - cached.probedAtMs < SCHEMA_MISMATCH_REPROBE_MS) {
        return false;
      }
    }
    // First probe for this URL (or a switch away from a cached one, or a
    // mismatch past its TTL): ask the backend.
    const backendVersion = await this.probeSchemaVersion();
    if (this.generation !== generation) return false;
    if (backendVersion === null) {
      log.warn("schema_version probe failed; skipping cloud sync pass");
      return false;
    }
    if (backendVersion !== ORG2_CLOUD_EXPECTED_SCHEMA_VERSION) {
      this.schemaGate = {
        supabaseUrl: endpoint.supabaseUrl,
        verdict: "mismatch",
        probedAtMs: Date.now(),
      };
      if (!this.schemaMismatchToastedUrls.has(endpoint.supabaseUrl)) {
        this.schemaMismatchToastedUrls.add(endpoint.supabaseUrl);
        Message.warning(
          i18n.t("navigation:cloud.sync.schemaMismatchToast", {
            backend: backendVersion,
            expected: ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
          })
        );
      }
      log.warn(
        `cloud sync disabled: custom backend schema_version ${backendVersion}` +
          `, app expects ${ORG2_CLOUD_EXPECTED_SCHEMA_VERSION}`
      );
      return false;
    }
    this.schemaGate = {
      supabaseUrl: endpoint.supabaseUrl,
      verdict: "ok",
      probedAtMs: Date.now(),
    };
    return true;
  }

  // --- Projects / work items channel (cloud-parity Phase B) ----------------

  /**
   * Local project-org alias for one cloud org (`sync_provider='orgii_collab'`
   * + `external_org_id=<cloudOrgId>`), ensured once per engine start. The
   * create/join flows stamp the alias too — this is the self-heal for orgs
   * that predate Phase B (or whose stamp failed). null ⇒ skip the org this
   * pass and retry next pass.
   */
  private async ensureProjectOrgAlias(
    org: Org2CloudOrg
  ): Promise<string | null> {
    const cached = this.projectOrgAliasIds.get(org.orgId);
    if (cached) return cached;
    try {
      const projectOrg = await ensureProjectOrgForCloudOrg(org);
      this.projectOrgAliasIds.set(org.orgId, projectOrg.id);
      return projectOrg.id;
    } catch (error) {
      log.warn(
        `project-org alias ensure failed for cloud org ${org.orgId}:`,
        error
      );
      return null;
    }
  }

  /**
   * One org's projects/work-items cycle: pull the collab-state delta, hand
   * it to the shared ProjectSyncChannel (apply + outbox drain/push/ack),
   * then advance the persisted cursor. Once per engine start the cursor is
   * bypassed for a COMPLETE listing — a row that leaves the visible set
   * without a tombstone can only be proven absent against the full state
   * (same revocation-absence rationale as the session listing).
   */
  private async syncOrgProjects(
    auth: Org2CloudAuthState,
    org: Org2CloudOrg,
    generation: number,
    options: { pushOutbox: boolean }
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    const projectOrgId = await this.ensureProjectOrgAlias(org);
    if (this.generation !== generation || !projectOrgId) return;

    const isFullListing = !this.fullCollabStateOrgIds.has(org.orgId);
    const since = isFullListing
      ? undefined
      : store.get(org2CloudCollabStateCursorsAtom)[org.orgId];
    const state = await this.projectsClient.listOrgCollabState(
      auth.accessToken,
      org.orgId,
      since
    );
    if (this.generation !== generation) return;

    // Same channel + Rust bridge as the retired self-hosted engine; the cloud
    // client owns authentication through its captured JWT.
    const channel = new ProjectSyncChannel({
      client: createCloudProjectSyncClient(
        auth.accessToken,
        this.projectsClient
      ),
      bridge: this.projectSyncBridge,
    });
    const cycle = await channel.sync(
      {
        org: { id: org.orgId, name: org.name, projectOrgId, createdAt: "" },
        state: toCollabOrgState(state),
      },
      { pushOutbox: options.pushOutbox }
    );
    if (this.generation !== generation) return;

    // The channel acks per-row push failures instead of throwing (Rust-side
    // backoff owns the entries), so the entitlement rejection from the GATED
    // upsert RPCs — the projects plane's only ORG2_SYNC_DISABLED source; the
    // listing RPC we await directly is ungated — can only surface through
    // the cycle result. Rethrow it into the same backoff+toast path as the
    // session plane; otherwise a disabled org re-drains its outbox every
    // pass forever with no user-visible signal.
    const syncDisabled = cycle.pushErrors.find((error) =>
      isOrg2ProjectsErrorCode(error, "ORG2_SYNC_DISABLED")
    );
    if (syncDisabled !== undefined) throw syncDisabled;
    if (cycle.pushErrors.length > 0) this.scheduleProjectPushRetry();

    this.fullCollabStateOrgIds.add(org.orgId);
    // Anchor the delta cursor on the server clock minus a safety overlap so
    // client skew cannot skip rows (consumers are idempotent) — the
    // self-hosted delta-cursor discipline.
    const cursorAt = state.serverTime
      ? new Date(
          new Date(state.serverTime).getTime() - CURSOR_OVERLAP_MS
        ).toISOString()
      : new Date().toISOString();
    store.set(org2CloudCollabStateCursorsAtom, (current) => ({
      ...current,
      [org.orgId]: cursorAt,
    }));
  }

  /**
   * Best-effort, TTL-gated hydration of `org2CloudRepoScopesAtom` from
   * `cloud_get_org_repo_scopes`. Failures only log — the mirror keeps its
   * last-known scopes and the pass proceeds (offline pushes still work).
   *
   * Known narrow race (accepted): a hydration response fetched BEFORE a
   * concurrent panel save resolves can land AFTER it and briefly revert the
   * mirror to the pre-save scopes. Self-heals on the panel's own post-save
   * refetch / the next TTL pass, so no versioning is layered on here.
   */
  private async hydrateRepoScopes(
    auth: Org2CloudAuthState,
    orgs: Array<{ orgId: string }>,
    generation: number
  ): Promise<void> {
    for (const org of orgs) {
      const lastAttempt = this.scopeHydratedAtMs.get(org.orgId) ?? 0;
      if (Date.now() - lastAttempt < SCOPE_HYDRATE_TTL_MS) continue;
      this.scopeHydratedAtMs.set(org.orgId, Date.now());
      try {
        const state = await this.client.getOrgRepoScopes(
          auth.accessToken,
          org.orgId
        );
        if (this.generation !== generation) return;
        this.store?.set(org2CloudRepoScopesAtom, (current) => ({
          ...current,
          [org.orgId]: state.repoScopes,
        }));
      } catch (error) {
        if (this.generation !== generation) return;
        log.warn(`repo-scope hydration failed for org ${org.orgId}:`, error);
      }
    }
  }

  /** ALL shareable keys for the session's checkout (multi-remote), from the
   * resolver cache. undefined = resolution in flight (primed here). */
  private getSessionScopeKeys(session: Session): string[] | null | undefined {
    if (!session.repoPath) return null;
    const keys = peekShareableScopeKeys(session.repoPath);
    if (keys === undefined) primeShareableScopeKey(session.repoPath);
    return keys;
  }

  private isBackoffError(error: unknown): boolean {
    return (
      isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED") ||
      isOrg2SyncErrorCode(error, "ORG2_SYNC_DISABLED") ||
      // Projects/work-items RPCs (Phase B) gate on the same entitlement.
      isOrg2ProjectsErrorCode(error, "ORG2_SYNC_DISABLED")
    );
  }

  private backOffOrg(orgId: string, error: unknown): void {
    const isActiveOrg = this.isActiveOrg(orgId);
    const cooldownMs = isActiveOrg
      ? ORG_BACKOFF_COOLDOWN_MS
      : INACTIVE_ORG_BACKOFF_COOLDOWN_MS;
    this.orgBackoffUntilMs.set(orgId, Date.now() + cooldownMs);
    this.orgBackoffAudiences.set(orgId, isActiveOrg ? "active" : "inactive");
    this.orgBackoffKinds.set(
      orgId,
      isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")
        ? "session_quota"
        : "sync_disabled"
    );
    const previousAudience = this.reportedBackoffAudiences.get(orgId);
    if (previousAudience === "active" || (!isActiveOrg && previousAudience)) {
      return;
    }
    this.reportedBackoffAudiences.set(
      orgId,
      isActiveOrg ? "active" : "inactive"
    );
    const key = isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")
      ? "navigation:cloud.sync.quotaExceededToast"
      : "navigation:cloud.sync.syncDisabledToast";
    if (isActiveOrg) Message.warning(i18n.t(key));
    log.warn(
      `cloud sync backed off for ${isActiveOrg ? "active" : "inactive"} org ${orgId} for ${cooldownMs} ms:`,
      error
    );
  }

  protected override clearOrgBackoff(orgId: string): void {
    this.orgBackoffUntilMs.delete(orgId);
    this.orgBackoffKinds.delete(orgId);
    this.orgBackoffAudiences.delete(orgId);
    this.reportedBackoffAudiences.delete(orgId);
  }

  /** Automatic expiry permits one bounded retry without starting a new
   * notification episode. A persistent entitlement error therefore remains
   * silent until a meaningful external/user signal calls clearOrgBackoff(). */
  private expireOrgBackoff(orgId: string): void {
    this.orgBackoffUntilMs.delete(orgId);
    this.orgBackoffKinds.delete(orgId);
    this.orgBackoffAudiences.delete(orgId);
  }

  /** The engine singleton outlives individual memberships. Keep every
   * app-lifetime org/session cache bounded by the authoritative live roster
   * and current local session list. */
  private pruneRemovedOrgState(
    orgs: readonly Org2CloudOrg[],
    sessions: readonly Session[]
  ): void {
    const currentOrgIds = new Set(orgs.map((org) => org.orgId));
    for (const orgId of this.orgBackoffUntilMs.keys()) {
      if (!currentOrgIds.has(orgId)) this.orgBackoffUntilMs.delete(orgId);
    }
    for (const orgId of this.orgBackoffKinds.keys()) {
      if (!currentOrgIds.has(orgId)) this.orgBackoffKinds.delete(orgId);
    }
    for (const orgId of this.orgBackoffAudiences.keys()) {
      if (!currentOrgIds.has(orgId)) this.orgBackoffAudiences.delete(orgId);
    }
    for (const orgId of this.reportedBackoffAudiences.keys()) {
      if (!currentOrgIds.has(orgId)) {
        this.reportedBackoffAudiences.delete(orgId);
      }
    }
    for (const orgId of this.scopeHydratedAtMs.keys()) {
      if (!currentOrgIds.has(orgId)) this.scopeHydratedAtMs.delete(orgId);
    }
    for (const orgId of this.projectOrgAliasIds.keys()) {
      if (!currentOrgIds.has(orgId)) this.projectOrgAliasIds.delete(orgId);
    }
    for (const orgId of this.fullCollabStateOrgIds) {
      if (!currentOrgIds.has(orgId)) this.fullCollabStateOrgIds.delete(orgId);
    }
    for (const orgId of this.lastInboundPassAtMs.keys()) {
      if (!currentOrgIds.has(orgId)) this.lastInboundPassAtMs.delete(orgId);
    }
    for (const orgId of this.pendingInboundOrgIds) {
      if (!currentOrgIds.has(orgId)) this.pendingInboundOrgIds.delete(orgId);
    }
    for (const orgId of this.pendingFullInboundOrgIds) {
      if (!currentOrgIds.has(orgId)) {
        this.pendingFullInboundOrgIds.delete(orgId);
      }
    }
    this.sessionSync.prune(
      currentOrgIds,
      new Set(sessions.map((session) => session.session_id))
    );
  }

  /** Match the Realtime demand rule: an open management surface is the
   * strongest visible-org signal, otherwise the sidebar scope is active. */
  private isActiveOrg(orgId: string): boolean {
    const store = this.store;
    if (!store) return false;
    const managementOrgId = store.get(chatPanelSelectedCloudOrgAtom)?.orgId;
    return (
      (managementOrgId ?? store.get(sidebarActiveCloudOrgIdAtom)) === orgId
    );
  }

  private isOrgBackedOff(orgId: string): boolean {
    const untilMs = this.orgBackoffUntilMs.get(orgId);
    if (untilMs === undefined) return false;
    if (
      this.isActiveOrg(orgId) &&
      this.orgBackoffAudiences.get(orgId) === "inactive"
    ) {
      this.expireOrgBackoff(orgId);
      return false;
    }
    if (Date.now() < untilMs) return true;
    this.expireOrgBackoff(orgId);
    return false;
  }

  /** Session replay quota pauses only the session plane. Sync-disabled is an
   * org-wide entitlement gate and therefore still pauses project RPCs. */
  private isOrgProjectBackedOff(orgId: string): boolean {
    if (!this.isOrgBackedOff(orgId)) return false;
    return this.orgBackoffKinds.get(orgId) !== "session_quota";
  }

  /** Force the next pass to re-upsert one session's metadata row. */
  invalidatePushedMetadataHash(orgId: string, sessionId: string): void {
    this.sessionSync.invalidatePushedMetadataHash(orgId, sessionId);
  }

  /** Retained private test seam; the session module owns the implementation. */
  private loadPushEvents(sessionId: string): Promise<SessionEvent[]> {
    return this.sessionSync.loadPushEvents(sessionId);
  }
}

/** Module singleton — mounted once via `useOrg2CloudSyncEngine`. */
export const org2CloudSyncEngine = new Org2CloudSyncEngine();
