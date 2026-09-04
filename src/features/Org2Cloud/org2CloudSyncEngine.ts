/**
 * Org2CloudSyncEngine — managed-cloud session PUSH (Phase 6 v1).
 *
 * Deliberately SMALL next to the self-hosted `CollabSyncEngine`: one
 * serialized sync pass over (cloud org × local session), happy-path push +
 * OCC conflict re-anchor + quota/disabled backoff. No pull-merge of remote
 * metadata into local stores yet (the panel lists teammates' sessions
 * directly via `listOrgSessions`).
 *
 * Per pass, the session plane visits the actively viewed org plus every org
 * whose admin enabled background upload. For each visited org that has
 * locally-stored repo scopes (`org2CloudRepoScopesAtom`) and sync not disabled
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
 * inactive orgs use a longer event-triggered cooldown.
 *
 * Projects/work-items (cloud-parity Phase B): after the session push, every
 * org drives the SAME `ProjectSyncChannel` + Rust bridge as the self-hosted
 * engine, backed by the cloud RPC adapter (`org2CloudProjectsClient`). The
 * pulled state comes from `cloud_list_org_collab_state` behind a persisted
 * per-org cursor (`org2CloudCollabStateCursorsAtom`, serverTime − 2s
 * overlap), bypassed for a COMPLETE listing only for the ACTIVE org on
 * start/reconnect/roster recovery — a row that leaves the visible set
 * without a tombstone can only be proven absent against the full state, and
 * background orgs get that authoritative listing when next activated (the
 * SUBSCRIBED edge forces it). Work items are org-wide: no repo-scope
 * selection.
 *
 * Scheduling is event-driven: start/roster changes, local EventStore writes,
 * the durable project outbox event, Realtime invalidations, reconnect,
 * visibility regain, and explicit user actions. There is no recurring cloud
 * pass. Debounce and bounded retry timers only coalesce or recover concrete
 * events; they never poll for new work.
 *
 * This file is the thin orchestration shell — the pass loop (`syncAllOrgs`)
 * plus wiring. Cohesive sub-concerns are split into co-located composed
 * helpers (mirroring the existing `Org2CloudSessionSync` composition):
 * `org2CloudSyncEngine.schemaGate.ts`, `.orgBackoff.ts`, `.repoScopeSync.ts`,
 * `.sessionColdStart.ts`, `.projectsChannel.ts`, `.constants.ts`.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import type { ProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import { tauriProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import { getSessionForkedFrom } from "../TeamCollaboration/forkSession";
import {
  peekMatchingOrgRepoScope,
  subscribeShareableScopeKeys,
} from "../TeamCollaboration/repoScopeResolver";
import {
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
  taggedCloudOrgIds,
  withoutCloudOrgTag,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import { getCloudEndpoint } from "./config";
import {
  hasExplicitCloudShareIntent,
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
  resolveCloudPushAccess,
} from "./org2CloudAccessSettings";
import {
  type Org2CloudAuthState,
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";
import { ensureFreshSession, schemaVersion } from "./org2CloudClient";
import { resolveOrgEndpoint } from "./org2CloudEndpointDirectory";
import { setOrgEndpointDirectory } from "./org2CloudOrgEndpointRouter";
import {
  buildCloudOrgSelectorValue,
  isOrgBackgroundUploadEnabled,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "./org2CloudOrgsAtom";
import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import * as org2CloudProjectsClient from "./org2CloudProjectsClient";
import {
  PUSH_ADMISSION_DENIAL,
  decidePushAdmission,
} from "./org2CloudPushAdmission";
import {
  Org2CloudSessionSync,
  type Org2CloudSyncClientDeps,
} from "./org2CloudSessionSync";
import { isCloudPushCandidate } from "./org2CloudSessionSync";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";
import * as org2CloudSyncClient from "./org2CloudSyncClient";
import {
  VANISHED_SESSION_RETRACT_CONFIRMATIONS,
  VANISHED_SESSION_SWEEP_INTERVAL_MS,
} from "./org2CloudSyncEngine.constants";
import {
  Org2CloudOrgBackoffTracker,
  isCloudSyncBackoffError,
} from "./org2CloudSyncEngine.orgBackoff";
import {
  Org2CloudProjectsChannel,
  type Org2CloudProjectsClientDeps,
} from "./org2CloudSyncEngine.projectsChannel";
import {
  Org2CloudRepoScopeSync,
  getSessionScopeKeys,
} from "./org2CloudSyncEngine.repoScopeSync";
import {
  orgsWithLocalPushMarkers,
  reconcileOrgRetracts,
} from "./org2CloudSyncEngine.retractReconcile";
import {
  Org2CloudSchemaGate,
  type Org2CloudSchemaVersionProbe,
} from "./org2CloudSyncEngine.schemaGate";
import { Org2CloudSessionColdStart } from "./org2CloudSyncEngine.sessionColdStart";
import {
  type ContinuationStatusResolver,
  type LocalSessionIdResolver,
  type SupersededPushedSession,
  findSupersededPushedSessions,
  findSupersededSelfOwnedRemoteSessions,
  findVanishedPushedSessionIds,
  resolveContinuationStatusesViaCache,
  resolveLocalSessionIdsViaAggregateList,
} from "./org2CloudSyncEngine.vanishedSessions";
import { recordSyncEvent } from "./org2CloudSyncJournal";
import {
  type CloudStore,
  Org2CloudSyncLifecycle,
} from "./org2CloudSyncLifecycle";

export {
  DATA_CHANGED_DEBOUNCE_MS,
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
  PROJECT_PUSH_RETRY_DELAY_MS,
} from "./org2CloudSyncLifecycle";
export {
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSessionSync";
export type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync";
export {
  COLLAB_LISTING_SHARE_WINDOW_MS,
  ORG_BACKOFF_COOLDOWN_MS,
  INACTIVE_ORG_BACKOFF_COOLDOWN_MS,
} from "./org2CloudSyncEngine.constants";
export type { Org2CloudProjectsClientDeps } from "./org2CloudSyncEngine.projectsChannel";
export type { Org2CloudSchemaVersionProbe } from "./org2CloudSyncEngine.schemaGate";

const log = createLogger("Org2CloudSyncEngine");
const SCOPE_RESOLUTION_DEBOUNCE_MS = 1_000;

export class Org2CloudSyncEngine extends Org2CloudSyncLifecycle {
  /** Last roster version for each locally owned external-history session. */
  private readonly externalHistoryRosterVersions = new Map<string, string>();
  private externalHistoryRosterInitialized = false;
  private sessionRosterUnsubscribe: (() => void) | null = null;
  private scopeResolutionUnsubscribe: (() => void) | null = null;
  private scopeResolutionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-org entitlement backoff deadlines + notification state, split out
   * to `Org2CloudOrgBackoffTracker` — see that module for the per-map
   * rationale (kept together there since a policy signal touches more than
   * one at once). */
  private readonly orgBackoff: Org2CloudOrgBackoffTracker;
  /** Generation whose background-org retract reconcile already ran (P2). */
  private reconciledGeneration = -1;
  /** "orgId|sessionId" keys whose push failed with ORG2_RETENTION_EXPIRED.
   * Retention only recedes further within a signed-in run, so the push is
   * doomed until the org's entitlement changes — parked until the next
   * resetSyncState() (sign-in cycle / endpoint switch / app restart)
   * instead of re-walking the full upload chain every pass. */
  private readonly retentionParked = new Set<string>();
  /** TTL-gated `org2CloudRepoScopesAtom` mirror hydration, split out to
   * `Org2CloudRepoScopeSync`. */
  private readonly repoScopeSync: Org2CloudRepoScopeSync;
  /** Project-org alias + collab-state channel bookkeeping (cloud-parity
   * Phase B), split out to `Org2CloudProjectsChannel`. */
  private readonly projectsChannel: Org2CloudProjectsChannel;
  /** Owner-session summary cold-start cache, split out to
   * `Org2CloudSessionColdStart`. */
  private readonly sessionColdStart: Org2CloudSessionColdStart;
  /** Custom-endpoint schema gate (Phase C), split out to
   * `Org2CloudSchemaGate` — see that module for the per-URL verdict
   * caching rationale. */
  private readonly schemaGate: Org2CloudSchemaGate;

  private readonly client: Org2CloudSyncClientDeps;
  private readonly projectsClient: Org2CloudProjectsClientDeps;
  private readonly projectSyncBridge: ProjectSyncBridge;
  private readonly sessionSync: Org2CloudSessionSync;
  /** Confirms vanished-session suspects against every local store; a
   * constructor seam so engine tests can fake local resolution. */
  private readonly resolveLocalSessionIds: LocalSessionIdResolver;
  /** Continuation status of push-marked suspects; same seam pattern. */
  private readonly resolveContinuationStatuses: ContinuationStatusResolver;
  /** Per-org timestamp of the last vanished-session GC sweep. */
  private readonly lastVanishedSweepAtMs = new Map<string, number>();

  /** Self-owned live remote session ids per org, captured from the
   * cold-start listing so the ghost sweep can reuse it instead of paying a
   * second listing for orgs the push loop already covered. Retracted ids
   * are removed in place so a stale entry cannot re-suspect forever. */
  private readonly selfOwnedRemoteIdsByOrg = new Map<string, Set<string>>();
  /** `${orgId}:${sessionId}` → consecutive sweeps confirmed absent. A
   * suspect retracts only at VANISHED_SESSION_RETRACT_CONFIRMATIONS, so one
   * empty lookup during a cache rebuild cannot mass-retract live rows. */
  private readonly vanishedStrikes = new Map<string, number>();
  /** Same two-strike discipline for superseded-continuation retracts. */
  private readonly supersededStrikes = new Map<string, number>();

  constructor(
    client: Org2CloudSyncClientDeps = org2CloudSyncClient,
    projectsClient: Org2CloudProjectsClientDeps = org2CloudProjectsClient,
    projectSyncBridge: ProjectSyncBridge = tauriProjectSyncBridge,
    probeSchemaVersion: Org2CloudSchemaVersionProbe = schemaVersion,
    resolveLocalSessionIds: LocalSessionIdResolver = resolveLocalSessionIdsViaAggregateList,
    resolveContinuationStatuses: ContinuationStatusResolver = resolveContinuationStatusesViaCache
  ) {
    super();
    this.client = client;
    this.projectsClient = projectsClient;
    this.projectSyncBridge = projectSyncBridge;
    this.sessionSync = new Org2CloudSessionSync(() => this.store, client);
    this.orgBackoff = new Org2CloudOrgBackoffTracker((orgId) =>
      this.isActiveOrg(orgId)
    );
    this.repoScopeSync = new Org2CloudRepoScopeSync(() => this.store, client);
    this.projectsChannel = new Org2CloudProjectsChannel(
      () => this.store,
      projectsClient,
      projectSyncBridge
    );
    this.sessionColdStart = new Org2CloudSessionColdStart(client);
    this.schemaGate = new Org2CloudSchemaGate(probeSchemaVersion);
    this.resolveLocalSessionIds = resolveLocalSessionIds;
    this.resolveContinuationStatuses = resolveContinuationStatuses;
  }

  override start(store: CloudStore): void {
    if (this.sessionRosterUnsubscribe) return;
    super.start(store);
    this.captureExternalHistoryRosterActivity(store);
    this.sessionRosterUnsubscribe = store.sub(sessionsAtom, () => {
      this.captureExternalHistoryRosterActivity(store);
    });
    this.scopeResolutionUnsubscribe = subscribeShareableScopeKeys(() => {
      if (this.scopeResolutionTimer !== null) return;
      this.scopeResolutionTimer = setTimeout(() => {
        this.scopeResolutionTimer = null;
        void this.runSyncPass({ pushSessions: true });
      }, SCOPE_RESOLUTION_DEBOUNCE_MS);
    });
  }

  override stop(): void {
    this.sessionRosterUnsubscribe?.();
    this.sessionRosterUnsubscribe = null;
    this.scopeResolutionUnsubscribe?.();
    this.scopeResolutionUnsubscribe = null;
    if (this.scopeResolutionTimer !== null) {
      clearTimeout(this.scopeResolutionTimer);
    }
    this.scopeResolutionTimer = null;
    this.externalHistoryRosterVersions.clear();
    this.externalHistoryRosterInitialized = false;
    super.stop();
  }

  /**
   * Imported providers refresh sessionsAtom directly instead of writing the
   * EventStore. Convert only meaningful source-version changes into the same
   * bounded quiet-window trigger used by native event notifications.
   */
  private captureExternalHistoryRosterActivity(store: CloudStore): void {
    const shouldNotifyChanges = this.externalHistoryRosterInitialized;
    const nextVersions = new Map<string, string>();
    const changedSessionIds: string[] = [];
    for (const session of store.get(sessionsAtom)) {
      if (
        !isImportedHistorySession(session.session_id) ||
        !isCloudPushCandidate(session)
      ) {
        continue;
      }
      const version = session.updated_at ?? "";
      nextVersions.set(session.session_id, version);
      if (
        this.externalHistoryRosterVersions.get(session.session_id) !== version
      ) {
        changedSessionIds.push(session.session_id);
      }
    }
    this.externalHistoryRosterVersions.clear();
    for (const [sessionId, version] of nextVersions) {
      this.externalHistoryRosterVersions.set(sessionId, version);
    }
    this.externalHistoryRosterInitialized = true;
    // Bootstrap already schedules the authoritative first pass. Treating the
    // initial roster as fresh activity added a redundant 30-second replay.
    if (!shouldNotifyChanges) return;
    if (changedSessionIds.length === 0) return;
    for (const sessionId of changedSessionIds) {
      this.noteSessionEventActivity(sessionId);
    }
    // One timer coalesces every changed imported session into one cloud pass.
    this.scheduleActivityPass(changedSessionIds[0]!);
  }

  protected override resetSyncState(): void {
    this.retentionParked.clear();
    this.orgBackoff.reset();
    this.sessionSync.reset();
    this.repoScopeSync.reset();
    this.projectsChannel.reset();
    this.sessionColdStart.reset();
    this.schemaGate.reset();
    this.lastVanishedSweepAtMs.clear();
    this.vanishedStrikes.clear();
    this.selfOwnedRemoteIdsByOrg.clear();
  }

  protected override clearAllOrgBackoffs(): void {
    // Same underlying bookkeeping resetSyncState() clears — this call site
    // is a mid-session invalidation, not a full engine reset.
    this.orgBackoff.reset();
  }

  protected override invalidateFullInboundState(orgId?: string): void {
    this.repoScopeSync.invalidate(orgId);
  }

  protected override noteSessionEventActivity(sessionId: string): void {
    this.sessionSync.noteSessionEventActivity(sessionId);
  }

  protected override afterSyncPass(): void {
    this.sessionSync.endPass();
  }

  protected override async syncAllOrgs(
    generation: number,
    options: { pushSessions: boolean }
  ): Promise<void> {
    if (options.pushSessions) this.sessionSync.beginPass();
    const store = this.store;
    if (!store) return;
    const auth = store.get(org2CloudAuthAtom);
    if (!auth) return;
    const orgs = store.get(org2CloudOrgsAtom);
    const sessionsAtPassStart = store.get(sessionsAtom);
    this.pruneRemovedOrgState(orgs, sessionsAtPassStart);
    if (orgs.length === 0) return;
    for (const org of orgs) {
      if (this.generation !== generation) return;
      await this.projectsChannel.ensureProjectOrgAlias(org);
    }
    if (
      !(await this.schemaGate.passesSchemaGate(
        generation,
        (gen) => this.generation === gen
      ))
    ) {
      return;
    }
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

    // The session plane follows visible-org demand unless an admin explicitly
    // enables background upload. That policy keeps eligible member sessions
    // publishing without requiring the org to be opened, while ordinary
    // inactive orgs still incur no session scan or scope RPC. Switching/opening
    // an org causes its Realtime subscription to request an immediate full
    // session pass; policy changes arrive through the roster lifecycle key.
    // Sharding Phase A: publish the roster's resolved home endpoints so
    // org-scoped data-plane calls route to each org's home project. Rebuilt
    // every pass — a directory cutover (or rollback) takes effect on the
    // next pass without restart. Empty/absent homeEndpoint keeps the
    // official endpoint, so pre-0007 backends behave exactly as before.
    setOrgEndpointDirectory(
      orgs.map((org) => [
        org.orgId,
        resolveOrgEndpoint(org, getCloudEndpoint()),
      ])
    );
    // Explicitly tagged sessions must publish (and keep publishing
    // updates) no matter which org the user is looking at — otherwise
    // Move to Org completes its awaited pass without ever visiting the
    // target org, reports success, and the session stays invisible to
    // every other member until the owner happens to activate that org.
    const sessionPushOrgs = orgs.filter(
      (org) =>
        this.isActiveOrg(org.orgId) ||
        isOrgBackgroundUploadEnabled(org) ||
        orgsWithTaggedSessions.has(org.orgId)
    );
    await this.repoScopeSync.hydrateRepoScopes(
      fresh,
      sessionPushOrgs,
      generation,
      (gen) => this.generation === gen
    );
    if (this.generation !== generation) return;

    const scopesByOrg = store.get(org2CloudRepoScopesAtom);
    const targets = options.pushSessions
      ? sessionPushOrgs.filter(
          (org) =>
            ((scopesByOrg[org.orgId]?.length ?? 0) > 0 ||
              orgsWithTaggedSessions.has(org.orgId)) &&
            enabledByOrg[org.orgId] !== false &&
            !this.orgBackoff.isOrgBackedOff(org.orgId)
        )
      : [];

    for (const org of targets) {
      // Bail the whole pass if the endpoint changed under us (see
      // passSupabaseUrl) — never push this backend's sessions elsewhere.
      if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
      const scopes = scopesByOrg[org.orgId] ?? [];
      const remoteSummaries =
        await this.sessionColdStart.loadSessionSummariesForColdStart(
          fresh,
          org.orgId,
          generation,
          (gen) => this.generation === gen
        );
      if (remoteSummaries === null) continue;
      if (remoteSummaries instanceof Map) {
        this.selfOwnedRemoteIdsByOrg.set(
          org.orgId,
          new Set(remoteSummaries.keys())
        );
      }
      for (const session of store.get(sessionsAtom)) {
        if (this.generation !== generation) return;
        if (!isCloudPushCandidate(session)) continue;
        if (this.retentionParked.has(`${org.orgId}|${session.session_id}`)) {
          continue;
        }
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
        const admission = decidePushAdmission({
          orgId: org.orgId,
          session,
          forkedFrom,
          tagged,
          ownedByOrg: session.orgId === buildCloudOrgSelectorValue(org.orgId),
          shareIntent: hasExplicitCloudShareIntent(
            accessByOrg[org.orgId],
            session.session_id
          ),
        });
        if (
          !admission.admitted &&
          admission.denial === PUSH_ADMISSION_DENIAL.FORK_OUTSIDE_SOURCE_ORG
        ) {
          if (this.sessionSync.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              log.info(
                `cloud retract [${admission.denial}]: session ${session.session_id} org ${org.orgId}`
              );
              await this.sessionSync.retractSession(
                fresh,
                org.orgId,
                session.session_id
              );
            } catch (error) {
              if (this.generation !== generation) return;
              if (isCloudSyncBackoffError(error)) {
                this.orgBackoff.backOffOrg(org.orgId, error);
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
        if (!admission.admitted) {
          if (this.sessionSync.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              log.info(
                `cloud retract [${admission.denial}]: session ${session.session_id} org ${org.orgId}`
              );
              await this.sessionSync.retractSession(
                fresh,
                org.orgId,
                session.session_id
              );
            } catch (error) {
              if (this.generation !== generation) return;
              if (isCloudSyncBackoffError(error)) {
                this.orgBackoff.backOffOrg(org.orgId, error);
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
        const scopeKeys = getSessionScopeKeys(session);
        // undefined = git-remote resolution still in flight; the next
        // event-driven pass picks the session up once the keys land.
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
        const matchedScope = peekMatchingOrgRepoScope(scopeKeys, scopes);
        if (matchedScope === undefined) {
          // A pending or failed network-identity lookup cannot prove
          // out-of-scope. Skip until the resolver's completion event runs one
          // coalesced follow-up pass. Expected steady-state on every poll
          // while resolution is in flight — trace-level, not console noise.
          log.trace(
            `scope check deferred for session ${session.session_id} org ` +
              `${org.orgId}: network identity unresolved this pass`
          );
          continue;
        }
        if (matchedScope === null) {
          // The scope mirror is persisted and restored empty-or-stale on
          // boot. An unconfirmed mirror cannot prove "out of scope": acting
          // on it retracts live shared rows and strips their org tags during
          // the first passes after launch. Skip the session until this run
          // has read the org's scopes from the server.
          if (!this.repoScopeSync.hasServerConfirmedScopes(org.orgId)) {
            // Same expected steady-state as the network-identity wait above:
            // fires on every poll until the org's scopes land — trace-level.
            log.trace(
              `scope check deferred for session ${session.session_id} org ` +
                `${org.orgId}: repo scopes not yet confirmed this run`
            );
            continue;
          }
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
              if (isCloudSyncBackoffError(error)) {
                this.orgBackoff.backOffOrg(org.orgId, error);
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
        // Reaching here means admission passed, and every admission route
        // (provenance, tag, ownership, intent, scope match) is floor-eligible
        // — so the floor always applies at this point.
        const access = resolveCloudPushAccess(
          accessByOrg[org.orgId],
          session.session_id,
          tagged,
          floorByOrg[org.orgId]
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
              if (isCloudSyncBackoffError(error)) {
                this.orgBackoff.backOffOrg(org.orgId, error);
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
        const remoteSummary = remoteSummaries?.get(session.session_id);
        if (remoteSummary) {
          await this.sessionSync.seedFromRemoteSummary(
            fresh,
            org.orgId,
            session,
            matchedScope,
            access,
            remoteSummary
          );
          if (this.generation !== generation) return;
        }
        try {
          await this.sessionSync.pushSession(
            fresh,
            org.orgId,
            session,
            matchedScope,
            access
          );
        } catch (error) {
          if (this.generation !== generation) return;
          if (isCloudSyncBackoffError(error)) {
            this.orgBackoff.backOffOrg(org.orgId, error);
            break; // Stop touching this org for the rest of the run.
          }
          if (
            org2CloudSyncClient.isOrg2SyncErrorCode(
              error,
              "ORG2_RETENTION_EXPIRED"
            )
          ) {
            this.retentionParked.add(`${org.orgId}|${session.session_id}`);
            recordSyncEvent({
              level: "warn",
              kind: "session_retention_parked",
              orgId: org.orgId,
              message: `Push parked for session ${session.session_id}: past the org's retention window`,
              code: "ORG2_RETENTION_EXPIRED",
            });
            log.warn(
              `cloud push parked for retention-expired session ${session.session_id}`
            );
            continue;
          }
          log.warn(
            `cloud push failed for session ${session.session_id}:`,
            error
          );
        }
      }
      // GC, after the per-session loop: every retract path above only runs
      // for sessions VISITED in sessionsAtom, so a session that left the
      // roster (deleted locally, or an imported continuation sibling the
      // backend election demoted) keeps its server row and push markers
      // forever — teammates see a ghost. Confirmed-vanished marked ids are
      // retracted here with the same backoff handling as the other paths.
      if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
      await this.retractVanishedSessions(fresh, org.orgId, generation);
      if (this.generation !== generation) return;
    }

    // The GC above only covered `targets`, but stale rows outlive that set:
    // an org the user switched away from (no background upload), whose
    // scopes are unresolved this run, or that lost its last scope/tag keeps
    // this device's push-marked ghosts forever — Team Sessions then shows a
    // duplicate row per context-window continuation. Sweep every org with
    // local push markers, same rails as the P2 reconcile below.
    if (options.pushSessions) {
      const markedOrgIds = orgsWithLocalPushMarkers(
        store.get(org2CloudPushCursorsAtom),
        store.get(org2CloudPushedMetadataAtom)
      );
      const sweptOrgIds = new Set(targets.map((org) => org.orgId));
      for (const org of orgs) {
        if (!markedOrgIds.has(org.orgId)) continue;
        if (sweptOrgIds.has(org.orgId)) continue;
        if (enabledByOrg[org.orgId] === false) continue;
        if (this.generation !== generation) return;
        if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
        await this.retractVanishedSessions(fresh, org.orgId, generation);
        if (this.generation !== generation) return;
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
    // These planes are Realtime-driven and scoped to the invalidated org.
    // Ordinary signals retain their delta cursors; only reconnect/roster
    // recovery clears the full-listing latch above.
    // Consume requests only after auth/schema/outbound setup succeeds; an
    // offline or mismatched backend must leave them pending for the next pass.
    const requestedInboundOrgIds = new Set(this.pendingInboundOrgIds);
    this.pendingInboundOrgIds.clear();
    const requestedFullInboundOrgIds = new Set(this.pendingFullInboundOrgIds);
    this.pendingFullInboundOrgIds.clear();
    const forceAllInbound = this.forceAllInboundNextPass;
    this.forceAllInboundNextPass = false;
    if (forceAllInbound) {
      // Complete listings are reserved for the org the user is looking at;
      // background orgs recover through their delta cursors here (the pulled
      // state includes LWW tombstones) and get their own authoritative full
      // listing from the SUBSCRIBED edge when they are next activated. This
      // keeps start/online/roster recovery from issuing O(orgs) full listings.
      for (const org of orgs) {
        if (this.isActiveOrg(org.orgId)) {
          requestedFullInboundOrgIds.add(org.orgId);
        } else {
          requestedInboundOrgIds.add(org.orgId);
        }
      }
    }
    for (const orgId of requestedFullInboundOrgIds) {
      requestedInboundOrgIds.add(orgId);
      this.projectsChannel.invalidateFullListing(orgId);
    }
    const inboundOrgIds = new Set(requestedInboundOrgIds);
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
        if (this.orgBackoff.isOrgProjectBackedOff(org.orgId)) continue;
        try {
          // Realtime-only pulls do not probe the local outbox. A concrete
          // local mutation/start/reconnect request drains it.
          await this.projectsChannel.syncOrgProjects(
            fresh,
            org,
            generation,
            { pushOutbox: pushProjects },
            {
              isCurrentGeneration: (gen) => this.generation === gen,
              scheduleProjectPushRetry: () => this.scheduleProjectPushRetry(),
            }
          );
        } catch (error) {
          if (this.generation !== generation) return;
          if (isCloudSyncBackoffError(error)) {
            this.orgBackoff.backOffOrg(org.orgId, error);
            continue;
          }
          // A listing can fail before ProjectSyncChannel gets far enough to
          // return per-row pushErrors. When this pass was supposed to drain
          // the durable outbox, keep a bounded one-shot retry rather than
          // stranding the write until another unrelated event.
          if (pushProjects) {
            this.scheduleProjectPushRetry();
          }
          log.warn(`cloud project sync failed for org ${org.orgId}:`, error);
        }
      }
    }

    // P2: retract-only reconcile for orgs the user is NOT looking at.
    // Background upload gives opted-in orgs a full session pass, but the
    // reconcile remains the safety net for every other inactive org — and for
    // background-upload orgs excluded from `targets` after their final scope
    // or tag disappears. Once per engine run: same admission decision, same
    // server-confirmed scope boundary, only rows THIS client push-marked. See
    // the module header for the rails.
    if (this.reconciledGeneration !== generation) {
      this.reconciledGeneration = generation;
      const cursors = store.get(org2CloudPushCursorsAtom);
      const pushedMetadata = store.get(org2CloudPushedMetadataAtom);
      const markedOrgIds = orgsWithLocalPushMarkers(cursors, pushedMetadata);
      const backgroundOrgs = orgs.filter(
        (org) =>
          markedOrgIds.has(org.orgId) &&
          !this.isActiveOrg(org.orgId) &&
          enabledByOrg[org.orgId] !== false &&
          !this.orgBackoff.isOrgBackedOff(org.orgId)
      );
      if (backgroundOrgs.length > 0) {
        await this.repoScopeSync.hydrateRepoScopes(
          fresh,
          backgroundOrgs,
          generation,
          (gen) => this.generation === gen
        );
        if (this.generation !== generation) return;
        log.info(
          `retract reconcile: covering ${backgroundOrgs.length} background org(s) with local push markers`
        );
        for (const org of backgroundOrgs) {
          if (this.generation !== generation) return;
          if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
          await reconcileOrgRetracts(
            {
              store,
              accessByOrg,
              wasCloudPushed: (orgId, sessionId) =>
                this.sessionSync.wasCloudPushed(orgId, sessionId),
              retractSession: (orgId, sessionId) =>
                this.sessionSync.retractSession(fresh, orgId, sessionId),
              hasServerConfirmedScopes: (orgId) =>
                this.repoScopeSync.hasServerConfirmedScopes(orgId),
              isCurrentGeneration: () => this.generation === generation,
            },
            org.orgId
          );
        }
      }
    }
  }

  protected override clearOrgBackoff(orgId: string): void {
    this.orgBackoff.clearOrgBackoff(orgId);
  }

  /**
   * Vanished-session GC for one org: retract cloud rows THIS device
   * push-marked whose sessions no longer resolve anywhere locally.
   *
   * TTL-throttled: the suspect set is dominated by marked sessions that
   * merely fell out of the paginated roster, and each sweep costs one
   * confirming backend lookup — not worth paying every 60s pass for a rare
   * condition. Marked-but-resolvable ids are left alone; markers clear on
   * successful retraction, so a healthy steady state has no suspects.
   */
  private async retractVanishedSessions(
    fresh: Org2CloudAuthState,
    orgId: string,
    generation: number
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    if (this.orgBackoff.isOrgBackedOff(orgId)) return;
    const now = Date.now();
    const lastSweepAt = this.lastVanishedSweepAtMs.get(orgId) ?? 0;
    if (now - lastSweepAt < VANISHED_SESSION_SWEEP_INTERVAL_MS) return;
    this.lastVanishedSweepAtMs.set(orgId, now);

    const markedSessionIds = this.sessionSync.markedSessionIds(orgId);
    const liveSessions = store.get(sessionsAtom);
    const liveSessionIds = new Set(
      liveSessions.map((session) => session.session_id)
    );
    const vanishedIds = await findVanishedPushedSessionIds({
      orgId,
      markedSessionIds,
      liveSessionIds,
      resolveSessionIds: this.resolveLocalSessionIds,
    });
    if (this.generation !== generation) return;
    const confirmedAbsent = new Set(vanishedIds);
    for (const key of this.vanishedStrikes.keys()) {
      if (!key.startsWith(`${orgId}:`)) continue;
      if (!confirmedAbsent.has(key.slice(orgId.length + 1))) {
        this.vanishedStrikes.delete(key);
      }
    }
    for (const sessionId of vanishedIds) {
      if (this.generation !== generation) return;
      const strikeKey = `${orgId}:${sessionId}`;
      const strikes = (this.vanishedStrikes.get(strikeKey) ?? 0) + 1;
      if (strikes < VANISHED_SESSION_RETRACT_CONFIRMATIONS) {
        this.vanishedStrikes.set(strikeKey, strikes);
        log.info(
          `vanished-session suspect ${sessionId} org ${orgId} confirmed ` +
            `absent (${strikes}/${VANISHED_SESSION_RETRACT_CONFIRMATIONS}); ` +
            `deferring retract to the next sweep`
        );
        continue;
      }
      try {
        log.info(
          `cloud retract [vanished locally]: session ${sessionId} org ${orgId}`
        );
        await this.sessionSync.retractSession(fresh, orgId, sessionId);
        this.vanishedStrikes.delete(strikeKey);
        this.selfOwnedRemoteIdsByOrg.get(orgId)?.delete(sessionId);
      } catch (error) {
        if (this.generation !== generation) return;
        if (isCloudSyncBackoffError(error)) {
          this.orgBackoff.backOffOrg(orgId, error);
          return;
        }
        // Markers survive a failed retract, so the next sweep retries.
        log.warn(
          `cloud retract failed for vanished session ${sessionId}:`,
          error
        );
      }
    }

    // Continuation-superseded reconcile: a compaction demotes the old
    // sibling out of the roster while its Team Sessions row lingers as a
    // stale duplicate of the family. Retract it ONLY when the family's
    // listable winner is itself replay-pushed to this org — the conversation
    // stays represented by exactly one live row. NOTE the deliberate content
    // tradeoff: the demoted row is the only cloud replay of the pre-compact
    // detail; the winner carries the compacted continuation. The source
    // transcript stays on the owner's disk and can always be re-shared.
    const superseded = await findSupersededPushedSessions({
      orgId,
      markedSessionIds,
      liveSessionIds,
      resolveStatuses: this.resolveContinuationStatuses,
    });
    if (this.generation !== generation) return;
    // Marker-free arm: judge the server's own list of this account's rows,
    // so ghosts survive neither a clobbered marker map nor a same-account
    // second device. The cold-start listing is reused when the push loop
    // already fetched it; only never-targeted orgs pay their own listing.
    // Listing failure = unknown; the arm just sits out.
    let remoteSelfIds: Set<string> | null =
      this.selfOwnedRemoteIdsByOrg.get(orgId) ?? null;
    if (!remoteSelfIds) {
      try {
        remoteSelfIds = new Set(
          await this.sessionSync.listSelfOwnedLiveRemoteSessionIds(fresh, orgId)
        );
        this.selfOwnedRemoteIdsByOrg.set(orgId, remoteSelfIds);
      } catch (error) {
        if (this.generation !== generation) return;
        if (isCloudSyncBackoffError(error)) {
          this.orgBackoff.backOffOrg(orgId, error);
          return;
        }
        log.warn(`self-owned remote listing failed for org ${orgId}:`, error);
      }
    }
    if (this.generation !== generation) return;
    let remoteSuperseded: SupersededPushedSession[] = [];
    if (remoteSelfIds) {
      remoteSuperseded = await findSupersededSelfOwnedRemoteSessions({
        orgId,
        remoteSelfSessionIds: [...remoteSelfIds].filter(
          (sessionId) => !markedSessionIds.has(sessionId)
        ),
        liveSessionIds,
        resolveStatuses: this.resolveContinuationStatuses,
      });
      if (this.generation !== generation) return;
    }
    const allSuperseded = [...superseded, ...remoteSuperseded];
    const supersededNow = new Set(
      allSuperseded.map((entry) => entry.sessionId)
    );
    for (const key of this.supersededStrikes.keys()) {
      if (!key.startsWith(`${orgId}:`)) continue;
      if (!supersededNow.has(key.slice(orgId.length + 1))) {
        this.supersededStrikes.delete(key);
      }
    }
    for (const { sessionId, lineageId } of allSuperseded) {
      if (this.generation !== generation) return;
      const winner = liveSessions.find(
        (session) =>
          session.session_id !== sessionId &&
          session.continuationLineageId === lineageId &&
          (this.sessionSync.hasReplayPushed(orgId, session.session_id) ||
            remoteSelfIds?.has(session.session_id) === true)
      );
      if (!winner) {
        log.info(
          `superseded continuation ${sessionId} org ${orgId} kept: no ` +
            `replay-pushed winner for lineage ${lineageId} on this device yet`
        );
        continue;
      }
      const strikeKey = `${orgId}:${sessionId}`;
      const strikes = (this.supersededStrikes.get(strikeKey) ?? 0) + 1;
      if (strikes < VANISHED_SESSION_RETRACT_CONFIRMATIONS) {
        this.supersededStrikes.set(strikeKey, strikes);
        log.info(
          `superseded-continuation suspect ${sessionId} org ${orgId} ` +
            `(winner ${winner.session_id}, ` +
            `${strikes}/${VANISHED_SESSION_RETRACT_CONFIRMATIONS}); ` +
            `deferring retract to the next sweep`
        );
        continue;
      }
      try {
        log.info(
          `cloud retract [superseded continuation]: session ${sessionId} ` +
            `org ${orgId} (winner ${winner.session_id})`
        );
        await this.sessionSync.retractSession(fresh, orgId, sessionId);
        this.supersededStrikes.delete(strikeKey);
        this.selfOwnedRemoteIdsByOrg.get(orgId)?.delete(sessionId);
      } catch (error) {
        if (this.generation !== generation) return;
        if (isCloudSyncBackoffError(error)) {
          this.orgBackoff.backOffOrg(orgId, error);
          return;
        }
        log.warn(
          `cloud retract failed for superseded continuation ${sessionId}:`,
          error
        );
      }
    }
  }

  /** The engine singleton outlives individual memberships. Keep every
   * app-lifetime org/session cache bounded by the authoritative live roster
   * and current local session list. */
  private pruneRemovedOrgState(
    orgs: readonly Org2CloudOrg[],
    sessions: readonly Session[]
  ): void {
    const currentOrgIds = new Set(orgs.map((org) => org.orgId));
    this.orgBackoff.prune(currentOrgIds);
    this.repoScopeSync.prune(currentOrgIds);
    this.projectsChannel.prune(currentOrgIds);
    this.sessionColdStart.prune(currentOrgIds);
    for (const orgId of this.lastVanishedSweepAtMs.keys()) {
      if (!currentOrgIds.has(orgId)) this.lastVanishedSweepAtMs.delete(orgId);
    }
    for (const orgId of this.selfOwnedRemoteIdsByOrg.keys()) {
      if (!currentOrgIds.has(orgId)) {
        this.selfOwnedRemoteIdsByOrg.delete(orgId);
      }
    }
    for (const key of this.vanishedStrikes.keys()) {
      const orgId = key.slice(0, key.indexOf(":"));
      if (!currentOrgIds.has(orgId)) this.vanishedStrikes.delete(key);
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
