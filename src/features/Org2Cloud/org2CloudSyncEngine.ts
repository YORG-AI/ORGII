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
 * repo-scope matching SELECTS candidates, the org-default / per-session
 * override ladder GATES the upload (effective 'off' ⇒ skipped entirely,
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
 * one-time warning toast + back off that org until the next engine start.
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
 * Comment agent tasks (agent-pickup Phase 5): after the project plane,
 * every org pulls `cloud_list_comment_tasks` behind its own persisted
 * cursor (`org2CloudCommentTaskCursorsAtom`, same serverTime − 2s overlap
 * discipline, full listing once per engine start) and `updated_at`
 * LWW-merges the rows into the in-memory `org2CloudCommentTasksAtom`.
 *
 * Cadence: fixed 60s timer chain plus a debounced pass on local event
 * writes (same `eventStoreProxy.subscribe` trigger the collab engine uses).
 * This chain is the app's ONLY recurring timer (user CPU constraint —
 * every recurring cloud pull rides inside the one pass): a hidden document
 * stretches the SAME chain to `HIDDEN_PASS_INTERVAL_MS`, and the
 * `visibilitychange` back to visible snaps it back with one immediate pass.
 */
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";
import { createCollabAvatarIdentity } from "@src/store/collaboration/protocol";
import {
  COLLAB_IDENTITY_KIND,
  COLLAB_ROLE,
  COLLAB_SESSION_ACCESS_MODE,
} from "@src/store/collaboration/types";
import type {
  CollabMemberRecord,
  CollabOrgRecord,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import type { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import {
  createDefaultAccessSettings,
  pickMatchingOrgScope,
  sha256Hex,
  stableStringify,
  toRemoteMetadata,
} from "../TeamCollaboration/collabSyncUtils";
import { ProjectSyncChannel } from "../TeamCollaboration/engine/ProjectSyncChannel";
import {
  computeFrozenEventCount,
  splitFrozenIntoSegments,
} from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import type { ProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import { tauriProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import {
  getSessionForkedFrom,
  getSessionTaskContext,
} from "../TeamCollaboration/forkSession";
import {
  peekShareableScopeKeys,
  primeShareableScopeKey,
} from "../TeamCollaboration/repoScopeResolver";
import {
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
  taggedCloudOrgIds,
  withoutCloudOrgTag,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import { computeSegmentHash } from "../TeamCollaboration/sync/collabGzip";
import { ORG2_CLOUD_EXPECTED_SCHEMA_VERSION, getCloudEndpoint } from "./config";
import type { CloudPushAccess } from "./org2CloudAccessSettings";
import {
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
  resolveCloudPushAccess,
} from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession, schemaVersion } from "./org2CloudClient";
import {
  mergeCommentTasks,
  org2CloudCommentTasksAtom,
} from "./org2CloudCommentTasksAtom";
import * as org2CloudCommentTasksClient from "./org2CloudCommentTasksClient";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
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
import type { CollabSessionPushCursor } from "./org2CloudSyncAtoms";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudCommentTaskCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";
import * as org2CloudSyncClient from "./org2CloudSyncClient";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";

const log = createLogger("Org2CloudSyncEngine");

type CloudStore = ReturnType<typeof getInstrumentedStore>;

/** The app's ONLY recurring timer (user CPU constraint): every recurring
 * cloud pull — sessions, projects, comment tasks — rides this one chain. */
export const PASS_INTERVAL_MS = 60_000;
/**
 * Hidden-document pass cadence (user-approved CPU feature): while the
 * document is hidden the SAME single timer chain merely reschedules at 5
 * minutes instead of 60s — no second timer is ever added — and the
 * `visibilitychange` back to visible collapses it into an immediate pass.
 */
export const HIDDEN_PASS_INTERVAL_MS = 300_000;
const ACTIVITY_DEBOUNCE_MS = 3_000;
/** `orgii-data-changed` → projects-plane pass debounce (coalesces mutation bursts). */
export const DATA_CHANGED_DEBOUNCE_MS = 1_500;
/**
 * The Rust collaboration outbox's first retry slot is 30 seconds. A failed
 * push must therefore schedule one projects-plane attempt just after that
 * deadline; otherwise a hidden/background desktop instance can strand the
 * row until the five-minute inbound fallback. This is failure-driven and
 * one-shot — the single recurring cloud timer remains `schedulePass`.
 */
export const PROJECT_PUSH_RETRY_DELAY_MS = 30_250;
/** Repo-scope mirror refresh cadence (server truth changes rarely). */
const SCOPE_HYDRATE_TTL_MS = 10 * 60_000;
/**
 * Events-plane no-change gate TTL. A session whose events plane was
 * verified in sync is skipped (no full-history IPC read, no per-event
 * re-hash) until its event store signals a write — the safety TTL forces
 * a real verification periodically in case a write path ever bypasses the
 * `es:changed` subscription (imports, other windows' edge cases).
 */
const EVENTS_CLEAN_TTL_MS = 10 * 60_000;
/** Re-probe a schema-mismatched custom endpoint after this long (an
 * in-place backend upgrade must heal without an app relaunch). */
const SCHEMA_MISMATCH_REPROBE_MS = 5 * 60_000;
/** Collab-state delta cursor safety overlap (mirrors CollabSyncEngine §9.4). */
const CURSOR_OVERLAP_MS = 2_000;

/**
 * Inbound (cloud→local) fallback cadence. Since inbound pulls are now driven
 * by Supabase Realtime (useOrg2CloudRealtime), the recurring pass only performs
 * the inbound planes (repo scopes / projects+work-items / comment-tasks) as an
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

/** Client seam so tests inject fetch-free fakes. */
export type Org2CloudSyncClientDeps = Pick<
  typeof org2CloudSyncClient,
  | "upsertSessionMetadata"
  | "appendSessionEvents"
  | "rewriteSessionEvents"
  | "getSessionEvents"
  | "getOrgRepoScopes"
  | "deleteSession"
>;

/** Projects/work-items RPC seam (Phase B), same fetch-free-fakes purpose. */
export type Org2CloudProjectsClientDeps = CloudProjectsRpc;

/** Comment agent-task listing seam (agent-pickup Phase 5), same purpose. */
export type Org2CloudTasksClientDeps = Pick<
  typeof org2CloudCommentTasksClient,
  "listCommentTasks"
>;

/** Non-DOM contexts (workers, node-side tests) behave as visible. */
function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/** `schema_version()` probe seam (Phase C custom-endpoint gate). */
export type Org2CloudSchemaVersionProbe = () => Promise<number | null>;

/**
 * Cloud metadata reuses the EXACT `toRemoteMetadata` output shape: the cloud
 * "member" is the cloud user (userId as memberId). The `access` argument is
 * the RESOLVED per-session ladder outcome (`resolveCloudPushAccess`) — a
 * synthetic settings record carries it through `toRemoteMetadata` so the
 * wire `accessMode`/`visibility`/`replayLevel` reflect the ladder, never a
 * hardcoded FULL_REPLAY grant. The server (0010) persists both columns and
 * rejects 'off'/unknown modes — callers must only pass ladder outcomes.
 */
export function buildCloudSessionMetadata(
  session: Session,
  orgId: string,
  userId: string,
  displayName: string,
  scopeKey: string | null,
  access: CloudPushAccess
): RemoteTeammateSessionMetadata {
  const org: CollabOrgRecord = {
    id: orgId,
    name: "",
    createdAt: "",
  };
  const member: CollabMemberRecord = {
    id: userId,
    orgId,
    displayName,
    avatar: createCollabAvatarIdentity(displayName),
    role: COLLAB_ROLE.MEMBER,
    identityKind: COLLAB_IDENTITY_KIND.HUMAN,
    joinedAt: "",
  };
  const settings = {
    ...createDefaultAccessSettings(orgId, userId),
    accessMode: access.accessMode,
    sessionVisibility: { [session.session_id]: access.visibility },
  };
  // Fork lineage survives a session-list reload only in the durable
  // fork-relay registry: `toFrontendSession` has no `forkedFrom` field, so
  // the first `loadSessions()` after a fork strips it off the row. Restore
  // it from the registry (same fallback the local ⑂ badge uses) before
  // building the wire metadata — otherwise the next push overwrites the
  // server row without lineage and every teammate loses the fork thread.
  const withLineage: Session = {
    ...session,
    forkedFrom: getSessionForkedFrom(session),
  };
  // The comment-task backlink has the same stripping problem in a sharper
  // form: `addressesComment` never exists on the Session row at all — its
  // only durable local home is the fork-relay registry's `taskContext`.
  // Restore it on EVERY push (not just the first) or the first
  // post-`loadSessions()` push would overwrite the server row without the
  // fork→thread provenance and every teammate loses the "Addressing
  // comment" attribution.
  const taskContext = getSessionTaskContext(session);
  return toRemoteMetadata(
    withLineage,
    org,
    member,
    settings,
    scopeKey,
    taskContext
      ? {
          commentId: taskContext.commentId,
          sourceSessionId: taskContext.sourceSessionId,
        }
      : undefined
  );
}

/** True for local sessions that may ever be pushed to the cloud. */
export function isCloudPushCandidate(session: Session): boolean {
  // Only IMPORTED TEAMMATE COPIES are excluded: a session pulled from the
  // cloud (`importedFrom` set) must never round-trip back out under our user
  // id — it already lives in the cloud under its original owner. The user's
  // OWN external history (imported Claude Code / Cursor / … CLI sessions,
  // category "external_history", NO importedFrom) IS shareable: its full
  // transcript is loaded from the source adapter at push time (see
  // `loadPushEvents`), so teammates get real replay, not just metadata.
  return !session.importedFrom;
}

export class Org2CloudSyncEngine {
  private store: CloudStore | null = null;
  private started = false;
  /** Bumped on stop(); in-flight passes check it before writing. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private dataChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private projectPushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private dataChangedUnlisten: Promise<UnlistenFn> | null = null;
  private eventStoreUnsubscribe: (() => void) | null = null;
  private passRunning = false;
  private passDirty = false;
  /** Explicit user-action waiters. Ordinary `runSyncPass` callers retain the
   * historical coalescing semantics; these resolve only once the active pass
   * and every dirty follow-up have drained. */
  private readonly passDrainWaiters: Array<() => void> = [];
  /** Last time the inbound planes were pulled (fallback-cadence gate). */
  private lastInboundPassAtMs = 0;
  /** Set by a Realtime invalidation so the next pass runs inbound now. */
  private forceInboundNextPass = false;
  /** Set by `orgii-data-changed` so the next pass drains the projects plane. */
  private forceProjectsNextPass = false;
  /** Org id → entitlement backoff deadline (epoch ms). */
  private readonly orgBackoffUntilMs = new Map<string, number>();
  /** Orgs already warned during the current backoff window. */
  private readonly warnedOrgIds = new Set<string>();
  /** `${orgId}:${sessionId}` → hash of the last upserted metadata. */
  private readonly lastPushedMetadataHashes = new Map<string, string>();
  /**
   * Events-plane no-change gate (the metadata plane's dedup counterpart):
   * sessionId → orgId → epoch ms when the plane was last VERIFIED in sync
   * (pushed, or proven unchanged against the cursor). While an entry is
   * live (see EVENTS_CLEAN_TTL_MS) `pushSession` skips the full-history
   * `getPersistedEvents` read + per-event re-hash for that (org, session).
   * Invalidated whole-session by the `es:changed` subscription.
   */
  private readonly cleanEventPlanes = new Map<string, Map<string, number>>();
  /** sessionId → bump count of local event-store activity; lets a pass
   * detect writes that landed WHILE it was reading/pushing (never mark a
   * plane clean over a mid-push write). */
  private readonly eventActivityStamps = new Map<string, number>();
  /** orgId → last repo-scope hydration attempt (TTL-gated per pass). */
  private readonly scopeHydratedAtMs = new Map<string, number>();
  /** Cloud orgId → aliased local project-org id (ensured once per start). */
  private readonly projectOrgAliasIds = new Map<string, string>();
  /** Orgs whose CURRENT start already pulled one COMPLETE collab-state listing. */
  private readonly fullCollabStateOrgIds = new Set<string>();
  /** Same once-per-start full-listing latch for the comment-task plane. */
  private readonly fullCommentTaskOrgIds = new Set<string>();
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
  private readonly tasksClient: Org2CloudTasksClientDeps;
  private readonly projectSyncBridge: ProjectSyncBridge;
  private readonly probeSchemaVersion: Org2CloudSchemaVersionProbe;

  constructor(
    client: Org2CloudSyncClientDeps = org2CloudSyncClient,
    projectsClient: Org2CloudProjectsClientDeps = org2CloudProjectsClient,
    tasksClient: Org2CloudTasksClientDeps = org2CloudCommentTasksClient,
    projectSyncBridge: ProjectSyncBridge = tauriProjectSyncBridge,
    probeSchemaVersion: Org2CloudSchemaVersionProbe = schemaVersion
  ) {
    this.client = client;
    this.projectsClient = projectsClient;
    this.tasksClient = tasksClient;
    this.projectSyncBridge = projectSyncBridge;
    this.probeSchemaVersion = probeSchemaVersion;
  }

  /**
   * `visibilitychange` → visible: collapse the (possibly 5-minute) hidden
   * chain into an immediate pass. One `setTimeout(0)` through the EXISTING
   * chain — never an extra recurring timer (user CPU constraint). Bound
   * property so `start()`/`stop()` add/remove the same reference.
   */
  private readonly onVisibilityChange = (): void => {
    if (!this.started) return;
    if (isDocumentHidden()) return;
    this.schedulePass(0);
  };

  /** Idempotent: subsequent calls while running are no-ops. */
  start(store: CloudStore): void {
    if (this.started) return;
    this.started = true;
    this.store = store;
    this.eventStoreUnsubscribe = eventStoreProxy.subscribe(
      (_snapshot, sessionId) => {
        this.noteSessionEventActivity(sessionId);
        this.scheduleActivityPass();
      }
    );
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.dataChangedUnlisten = listen("orgii-data-changed", () => {
      this.scheduleProjectsPass();
    });
    this.schedulePass(0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    if (this.dataChangedTimer !== null) clearTimeout(this.dataChangedTimer);
    this.dataChangedTimer = null;
    if (this.projectPushRetryTimer !== null) {
      clearTimeout(this.projectPushRetryTimer);
    }
    this.projectPushRetryTimer = null;
    void this.dataChangedUnlisten?.then((unlisten) => unlisten());
    this.dataChangedUnlisten = null;
    this.eventStoreUnsubscribe?.();
    this.eventStoreUnsubscribe = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.orgBackoffUntilMs.clear();
    this.warnedOrgIds.clear();
    this.lastPushedMetadataHashes.clear();
    this.cleanEventPlanes.clear();
    this.eventActivityStamps.clear();
    this.scopeHydratedAtMs.clear();
    this.projectOrgAliasIds.clear();
    this.fullCollabStateOrgIds.clear();
    this.fullCommentTaskOrgIds.clear();
    this.schemaGate = null;
    this.schemaMismatchToastedUrls.clear();
    this.passRunning = false;
    this.passDirty = false;
    for (const resolve of this.passDrainWaiters.splice(0)) resolve();
    this.lastInboundPassAtMs = 0;
    this.forceInboundNextPass = false;
    this.forceProjectsNextPass = false;
    this.store = null;
  }

  /** Run a pass now (test seam / manual trigger). Serialized. */
  async runSyncPass(): Promise<void> {
    if (!this.started || !this.store) return;
    if (this.passRunning) {
      this.passDirty = true;
      return;
    }
    this.passRunning = true;
    const generation = this.generation;
    try {
      await this.syncAllOrgs(generation);
    } catch (error) {
      log.warn("cloud sync pass failed:", error);
    } finally {
      this.passRunning = false;
      if (this.started && this.generation === generation && this.passDirty) {
        this.passDirty = false;
        void this.runSyncPass();
      } else {
        for (const resolve of this.passDrainWaiters.splice(0)) resolve();
      }
    }
  }

  /**
   * User-action seam: request a pass and wait until it plus any coalesced dirty
   * follow-up has drained. Timers, Realtime invalidations and tests should keep
   * using `runSyncPass()` so their established one-pass timing is unchanged.
   */
  async runSyncPassAndWaitForDrain(): Promise<void> {
    if (!this.started || !this.store) return;
    const drained = new Promise<void>((resolve) => {
      this.passDrainWaiters.push(resolve);
    });
    void this.runSyncPass();
    await drained;
  }

  /**
   * Realtime-invalidation seam. A Postgres-changes event on an org's inbound
   * planes (projects / work-items / comment-tasks) means "re-pull now". Drop
   * the once-per-start full-listing latches and the repo-scope TTL for the
   * affected org (or ALL orgs when `orgId` is omitted — the reconnect case,
   * where events may have been missed while the socket was down) so the next
   * pass performs a COMPLETE listing that can observe server-side tombstones,
   * then run a pass immediately. Reuses every existing cursor / LWW / apply
   * path — realtime only changes WHEN a pull happens, never HOW.
   */
  invalidateOrgInbound(orgId?: string): void {
    if (!this.started) return;
    if (orgId) {
      this.clearOrgBackoff(orgId);
      this.fullCollabStateOrgIds.delete(orgId);
      this.fullCommentTaskOrgIds.delete(orgId);
      this.scopeHydratedAtMs.delete(orgId);
    } else {
      this.orgBackoffUntilMs.clear();
      this.warnedOrgIds.clear();
      this.fullCollabStateOrgIds.clear();
      this.fullCommentTaskOrgIds.clear();
      this.scopeHydratedAtMs.clear();
    }
    this.forceInboundNextPass = true;
    void this.runSyncPass();
  }

  /** Resume an org immediately after a user-controlled access/policy change. */
  resumeOrg(orgId: string): void {
    this.invalidateOrgInbound(orgId);
  }

  private schedulePass(delayMs: number): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSyncPass().finally(() => {
        // A hidden document stretches the SAME chain to the 5-minute
        // cadence; `onVisibilityChange` snaps it back with an immediate
        // pass. Still the app's only recurring timer (user CPU constraint).
        this.schedulePass(
          isDocumentHidden() ? HIDDEN_PASS_INTERVAL_MS : PASS_INTERVAL_MS
        );
      });
    }, delayMs);
  }

  private scheduleActivityPass(): void {
    if (!this.started) return;
    // Hidden documents ride the stretched 5-minute chain ONLY (the module
    // guarantee above): local event churn — an agent running while the
    // window is minimized is the canonical case — must not reintroduce a
    // ~3s-gap full-pass cadence in the background. `onVisibilityChange`
    // already snaps back with one immediate pass on return.
    if (isDocumentHidden()) return;
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (isDocumentHidden()) return; // hid during the debounce window
      void this.runSyncPass();
    }, ACTIVITY_DEBOUNCE_MS);
  }

  /** `orgii-data-changed` → prompt debounced projects-plane drain; the remote-apply echo self-terminates (empty outbox + advanced cursor ⇒ no re-emit). */
  private scheduleProjectsPass(): void {
    if (!this.started) return;
    this.forceProjectsNextPass = true;
    if (isDocumentHidden()) return;
    if (this.dataChangedTimer !== null) clearTimeout(this.dataChangedTimer);
    this.dataChangedTimer = setTimeout(() => {
      this.dataChangedTimer = null;
      if (isDocumentHidden()) return;
      void this.runSyncPass();
    }, DATA_CHANGED_DEBOUNCE_MS);
  }

  /**
   * Revisit failed project/work-item pushes when Rust's durable outbox makes
   * them eligible again. Unlike user-edit debouncing, this must also fire for
   * an occluded/hidden second desktop instance: the explicit failed mutation
   * created durable work that cannot wait for the background fallback.
   */
  private scheduleProjectPushRetry(): void {
    if (!this.started || this.projectPushRetryTimer !== null) return;
    this.projectPushRetryTimer = setTimeout(() => {
      this.projectPushRetryTimer = null;
      if (!this.started) return;
      this.forceProjectsNextPass = true;
      void this.runSyncPass();
    }, PROJECT_PUSH_RETRY_DELAY_MS);
  }

  /** `es:changed` for a session: drop its clean markers so the next pass
   * re-verifies, and stamp the write so a mid-push write is never masked. */
  private noteSessionEventActivity(sessionId: string): void {
    this.eventActivityStamps.set(
      sessionId,
      (this.eventActivityStamps.get(sessionId) ?? 0) + 1
    );
    this.cleanEventPlanes.delete(sessionId);
  }

  private isEventPlaneClean(orgId: string, sessionId: string): boolean {
    const cleanAt = this.cleanEventPlanes.get(sessionId)?.get(orgId);
    return cleanAt !== undefined && Date.now() - cleanAt < EVENTS_CLEAN_TTL_MS;
  }

  /** Mark (org, session) verified — unless a write landed since
   * `stampAtRead` was taken (the pass read a now-stale history). */
  private markEventPlaneClean(
    orgId: string,
    sessionId: string,
    stampAtRead: number
  ): void {
    if ((this.eventActivityStamps.get(sessionId) ?? 0) !== stampAtRead) return;
    let byOrg = this.cleanEventPlanes.get(sessionId);
    if (!byOrg) {
      byOrg = new Map();
      this.cleanEventPlanes.set(sessionId, byOrg);
    }
    byOrg.set(orgId, Date.now());
  }

  private async syncAllOrgs(generation: number): Promise<void> {
    const store = this.store;
    if (!store) return;
    const auth = store.get(org2CloudAuthAtom);
    if (!auth) return;
    const orgs = store.get(org2CloudOrgsAtom);
    if (orgs.length === 0) return;
    for (const org of orgs) {
      if (this.generation !== generation) return;
      await this.ensureProjectOrgAlias(org);
    }
    if (!(await this.passesSchemaGate(generation))) return;
    const enabledByOrg = store.get(org2CloudSyncEnabledAtom);
    const tags = store.get(sessionOrgTagsAtom);
    // Access ladder (§13.4): read the PERSISTED settings every pass — the
    // ratchet lives here. A per-session override (mode or restricted
    // visibility) is always honored over the org default, so an automated
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
        if (this.generation !== generation) return;
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
          if (this.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              await this.retractSession(fresh, org.orgId, session.session_id);
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
        if (!forkedFrom && !tagged && !ownedByOrg) {
          if (this.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              await this.retractSession(fresh, org.orgId, session.session_id);
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
        const matchedScope = pickMatchingOrgScope(scopeKeys, scopes);
        if (matchedScope === null) {
          if (tagged) {
            if (this.wasCloudPushed(org.orgId, session.session_id)) {
              try {
                await this.retractSession(fresh, org.orgId, session.session_id);
              } catch (error) {
                if (this.generation !== generation) return;
                if (this.isBackoffError(error)) {
                  this.backOffOrg(org.orgId, error);
                  break;
                }
                log.warn(
                  `cloud retract failed for out-of-scope tagged session ${session.session_id}:`,
                  error
                );
                // Keep the tag: retry the retract next pass rather than
                // orphan a live server row.
                continue;
              }
            }
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
        // org default is OFF until raised, per-session overrides win, and
        // an effective-off session is skipped (never uploaded). A TAGGED
        // session still pushes, floored to metadata_only when its effective
        // mode is off ('off' must never reach the server — ORG2_VALIDATION).
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
          if (this.wasCloudPushed(org.orgId, session.session_id)) {
            try {
              await this.retractSession(fresh, org.orgId, session.session_id);
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
          await this.pushSession(
            fresh,
            org.orgId,
            session,
            matchedScope,
            access
          );
        } catch (error) {
          if (this.generation !== generation) return;
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
    // local toggle and this run's backoff (which the session loop above may
    // have just set) gate it.
    //
    // Inbound-fallback gate: these two planes (projects+work-items and comment
    // tasks below) are now Realtime-driven (useOrg2CloudRealtime →
    // invalidateOrgInbound). On an ordinary recurring pass they run only as a
    // safety net at INBOUND_FALLBACK_INTERVAL_MS cadence; a Realtime
    // invalidation sets forceInboundNextPass so a live event pulls immediately.
    // The outbound push loop above is unaffected and runs every pass.
    const nowMs = Date.now();
    const runInbound =
      this.forceInboundNextPass ||
      nowMs - this.lastInboundPassAtMs >= INBOUND_FALLBACK_INTERVAL_MS;
    this.forceInboundNextPass = false;
    const runProjects = runInbound || this.forceProjectsNextPass;
    this.forceProjectsNextPass = false;
    if (runProjects) {
      for (const org of orgs) {
        if (this.generation !== generation) return;
        if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
        if (enabledByOrg[org.orgId] === false) continue;
        if (this.isOrgBackedOff(org.orgId)) continue;
        try {
          await this.syncOrgProjects(fresh, org, generation);
        } catch (error) {
          if (this.generation !== generation) return;
          if (this.isBackoffError(error)) {
            this.backOffOrg(org.orgId, error);
            continue;
          }
          log.warn(`cloud project sync failed for org ${org.orgId}:`, error);
        }
      }
    }
    if (runInbound) {
      this.lastInboundPassAtMs = nowMs;

      // Comment agent tasks (agent-pickup Phase 5), AFTER the project plane.
      // Org-wide like work items — task visibility mirrors the session-listing
      // predicate SERVER-side, so no client-side scope selection here either.
      // The `isBackoffError` classification is kept for consistency with the
      // other planes even though `cloud_list_comment_tasks` can only raise
      // membership/org errors — never ORG2_QUOTA_EXCEEDED (0002 rule: quota
      // exists only on the human-affordance create RPC).
      for (const org of orgs) {
        if (this.generation !== generation) return;
        if (getCloudEndpoint().supabaseUrl !== passSupabaseUrl) return;
        if (enabledByOrg[org.orgId] === false) continue;
        if (this.isOrgBackedOff(org.orgId)) continue;
        try {
          await this.syncCommentTasks(fresh, org, generation);
        } catch (error) {
          if (this.generation !== generation) return;
          if (this.isBackoffError(error)) {
            this.backOffOrg(org.orgId, error);
            continue;
          }
          log.warn(
            `cloud comment-task sync failed for org ${org.orgId}:`,
            error
          );
        }
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
    generation: number
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
    const cycle = await channel.sync({
      org: { id: org.orgId, name: org.name, projectOrgId, createdAt: "" },
      state: toCollabOrgState(state),
    });
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

  // --- Comment agent tasks (agent-pickup design §4, Phase 5) ----------------

  /**
   * One org's comment agent-task pull: `cloud_list_comment_tasks` delta →
   * `updated_at` LWW merge into the in-memory task map → advance the
   * persisted cursor (serverTime − CURSOR_OVERLAP_MS, the collab-state
   * cursor discipline). Once per engine start the cursor is bypassed and
   * the org's map is REBUILT from the complete listing
   * (`mergeCommentTasks({}, tasks)`): a task whose session was hard-deleted
   * or whose visibility was revoked leaves the listing without a tombstone
   * and can only be proven absent against the full state (same rationale as
   * the collab-state listing). Rows here can never carry a lease token —
   * structurally, via `CloudCommentTaskWireSchema` (0002 invariant 1).
   */
  private async syncCommentTasks(
    auth: Org2CloudAuthState,
    org: Org2CloudOrg,
    generation: number
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    const isFullListing = !this.fullCommentTaskOrgIds.has(org.orgId);
    const since = isFullListing
      ? null
      : (store.get(org2CloudCommentTaskCursorsAtom)[org.orgId] ?? null);
    const listing = await this.tasksClient.listCommentTasks(
      auth.accessToken,
      org.orgId,
      since
    );
    if (this.generation !== generation) return;

    this.fullCommentTaskOrgIds.add(org.orgId);
    store.set(org2CloudCommentTasksAtom, (current) => {
      // Full listing rebuilds from {} (revocation-absence rationale above);
      // a delta merges LWW into the existing map. `mergeCommentTasks` is
      // identity-stable, so an empty delta never churns the atom.
      const existing = isFullListing ? {} : (current[org.orgId] ?? {});
      const merged = mergeCommentTasks(existing, listing.tasks);
      if (merged === current[org.orgId]) return current;
      return { ...current, [org.orgId]: merged };
    });
    // Anchor the delta cursor on the server clock minus a safety overlap so
    // client skew cannot skip rows (the merge is an idempotent LWW).
    const cursorAt = listing.serverTime
      ? new Date(
          new Date(listing.serverTime).getTime() - CURSOR_OVERLAP_MS
        ).toISOString()
      : new Date().toISOString();
    store.set(org2CloudCommentTaskCursorsAtom, (current) => ({
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
    this.orgBackoffUntilMs.set(orgId, Date.now() + ORG_BACKOFF_COOLDOWN_MS);
    if (this.warnedOrgIds.has(orgId)) return;
    this.warnedOrgIds.add(orgId);
    const key = isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")
      ? "navigation:cloud.sync.quotaExceededToast"
      : "navigation:cloud.sync.syncDisabledToast";
    Message.warning(i18n.t(key));
    log.warn(`cloud sync backed off for org ${orgId}:`, error);
  }

  private clearOrgBackoff(orgId: string): void {
    this.orgBackoffUntilMs.delete(orgId);
    this.warnedOrgIds.delete(orgId);
  }

  private isOrgBackedOff(orgId: string): boolean {
    const untilMs = this.orgBackoffUntilMs.get(orgId);
    if (untilMs === undefined) return false;
    if (Date.now() < untilMs) return true;
    this.clearOrgBackoff(orgId);
    return false;
  }

  // --- Segments push (mirrors CollabSyncEngine §7.3, cloud RPC names) -------

  private getCursor(
    orgId: string,
    sessionId: string
  ): CollabSessionPushCursor | undefined {
    return this.store?.get(org2CloudPushCursorsAtom)[`${orgId}:${sessionId}`];
  }

  private setCursor(cursor: CollabSessionPushCursor): void {
    this.store?.set(org2CloudPushCursorsAtom, (current) => ({
      ...current,
      [`${cursor.orgId}:${cursor.sessionId}`]: cursor,
    }));
  }

  private async computeFrozenChainHash(
    perEventHashes: string[],
    frozenEventCount: number
  ): Promise<string> {
    return sha256Hex(perEventHashes.slice(0, frozenEventCount).join("\n"));
  }

  /**
   * Drop the pass-level metadata dedup hash for one (org, session), forcing
   * the next pass to re-upsert even when the metadata is byte-identical.
   * MUST be called after `deleteSession` (untag soft-tombstone): the row's
   * `deleted_at` makes `cloud_append_session_events` throw
   * ORG2_SESSION_NOT_FOUND (a non-backoff code), and with a stale hash the
   * engine would skip the very upsert that clears `deleted_at` — a per-pass
   * error loop until the metadata happens to change or the app restarts.
   */
  invalidatePushedMetadataHash(orgId: string, sessionId: string): void {
    this.lastPushedMetadataHashes.delete(`${orgId}:${sessionId}`);
  }

  /**
   * True when a live row for (org, session) is on the server AND survives
   * restarts: a persisted segments cursor (any full_replay past) or the
   * persisted metadata marker (a metadata_only rung leaves no cursor). The
   * in-memory hash is a same-run fast path only — the persisted marker is
   * what lets a downgrade-to-Off in a LATER run still retract. Gates the
   * effective-off retraction so a never-pushed candidate is never needlessly
   * deleted.
   */
  private wasCloudPushed(orgId: string, sessionId: string): boolean {
    const key = `${orgId}:${sessionId}`;
    return (
      this.lastPushedMetadataHashes.has(key) ||
      this.getPushedMetadataMarker(orgId, sessionId) ||
      this.getCursor(orgId, sessionId) !== undefined
    );
  }

  private getPushedMetadataMarker(orgId: string, sessionId: string): boolean {
    return (
      this.store?.get(org2CloudPushedMetadataAtom)[`${orgId}:${sessionId}`] ===
      true
    );
  }

  private setPushedMetadataMarker(orgId: string, sessionId: string): void {
    this.store?.set(org2CloudPushedMetadataAtom, (current) => ({
      ...current,
      [`${orgId}:${sessionId}`]: true,
    }));
  }

  private clearPushedMetadataMarker(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    this.store?.set(org2CloudPushedMetadataAtom, (current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  /** Drop the persisted segments cursor for one (org, session). */
  private clearCursor(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    this.store?.set(org2CloudPushCursorsAtom, (current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  /**
   * Soft-tombstone a previously-pushed session that has dropped to
   * effective-off WITHOUT a tag (the CloudSyncLevelDialog 'Off' path). Same
   * server delete + dedup-hash drop as the MoveToOrgDialog untag, PLUS a
   * cursor + persisted-metadata-marker clear: a repo-scope-matched candidate
   * stays in the pass loop every pass, so without dropping all three the
   * delete would re-fire forever. Dropping them makes the retract fire
   * exactly once; a later re-share re-anchors as a first push (the server
   * keeps the segments).
   *
   * `ORG2_SESSION_NOT_FOUND` is swallowed as idempotent success: the
   * persisted marker can outlive an already-deleted row (retract triggered
   * from a marker set in a PRIOR run, or a row a teammate already removed),
   * and re-throwing would loop the delete every pass without ever clearing
   * the marker. The row is gone either way — clear local state and return.
   */
  private async retractSession(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string
  ): Promise<void> {
    try {
      await this.client.deleteSession(auth.accessToken, orgId, sessionId);
    } catch (error) {
      if (!isOrg2SyncErrorCode(error, "ORG2_SESSION_NOT_FOUND")) throw error;
    }
    this.invalidatePushedMetadataHash(orgId, sessionId);
    this.clearPushedMetadataMarker(orgId, sessionId);
    this.clearCursor(orgId, sessionId);
  }

  private async upsertMetadataIfChanged(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const displayName =
      auth.profile?.displayName ?? auth.profile?.primaryEmail ?? auth.userId;
    const metadata = buildCloudSessionMetadata(
      session,
      orgId,
      auth.userId,
      displayName,
      scopeKey,
      access
    );
    const key = `${orgId}:${session.session_id}`;
    const hash = await sha256Hex(stableStringify(metadata));
    if (this.lastPushedMetadataHashes.get(key) === hash) return;
    await this.client.upsertSessionMetadata(
      auth.accessToken,
      orgId,
      session.session_id,
      metadata
    );
    this.lastPushedMetadataHashes.set(key, hash);
    this.setPushedMetadataMarker(orgId, session.session_id);
  }

  /**
   * The full event transcript to upload for a session.
   *
   * Native sessions read the persisted (SQLite-cached) ORG2 event stream. But
   * the user's OWN external history (imported Claude Code / Cursor / Codex /
   * … CLI sessions) has NO persisted stream — its events are reconstructed on
   * demand from each tool's own store into a WINDOWED in-memory view, so
   * `getPersistedEvents` returns [] for them and a full_replay push would
   * silently ship nothing. For those we read the COMPLETE (non-windowed)
   * transcript straight from the source adapter at push time, so shared
   * external sessions replay in full for teammates. Imported teammate copies
   * never reach here (excluded by `isCloudPushCandidate`).
   */
  private async loadPushEvents(sessionId: string): Promise<SessionEvent[]> {
    if (isImportedHistorySession(sessionId)) {
      const source = getImportedHistorySourceBySessionId(sessionId);
      if (!source) return [];
      const chunks = await source.loadFullTranscriptChunks(sessionId);
      if (!Array.isArray(chunks) || chunks.length === 0) return [];
      return processChunksRust(chunks, sessionId);
    }
    return eventStoreProxy.getPersistedEvents(sessionId);
  }

  private async pushSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const sessionId = session.session_id;
    if (access.accessMode === COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY) {
      // Metadata-only ladder rung: the listing row updates but event
      // segments are never shipped (mirrors the self-hosted
      // isRemoteSessionEventsPublishAllowed gate). Segments pushed under an
      // earlier full_replay grant stay server-side; the 0010 server already
      // refuses to serve them (ORG2_REPLAY_NOT_AVAILABLE).
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      return;
    }
    if (this.isEventPlaneClean(orgId, sessionId)) {
      // Events plane verified in sync and no local write since (metadata
      // dedup counterpart): skip the full-history IPC read + per-event
      // re-hash — an idle fully-pushed transcript must not be
      // deserialized+hashed every pass. Metadata stays hash-gated.
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      return;
    }
    const stampAtRead = this.eventActivityStamps.get(sessionId) ?? 0;
    const events = await this.loadPushEvents(sessionId);
    const cursor = this.getCursor(orgId, sessionId);
    if (!cursor && events.length === 0) {
      // A brand-new/empty full-replay session still needs a metadata row.
      // Returning here used to make an explicit replay share impossible to
      // verify until the owner sent a first message: no row existed at all,
      // even though `full_replay` was the selected policy. The server's
      // zero-valued events summary is the canonical empty replay snapshot.
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      this.markEventPlaneClean(orgId, sessionId, stampAtRead);
      return;
    }
    if (cursor && events.length < cursor.pushedCount) {
      // Truncated-read guard (same as the collab engine): a persisted view
      // shorter than what we already pushed is an incomplete cache read,
      // never a shorter session — do not rewrite the remote copy away.
      log.warn(
        `persisted read for ${sessionId} returned ${events.length} events ` +
          `but the cloud cursor covers ${cursor.pushedCount}; skipping`
      );
      return;
    }

    const perEventHashes = await Promise.all(
      events.map((event) => sha256Hex(stableStringify(event)))
    );
    const frozenEventCount = computeFrozenEventCount(events);
    const tailEvents = events.slice(frozenEventCount);
    const tailHash =
      tailEvents.length > 0 ? await computeSegmentHash(tailEvents) : null;
    const frozenChainHash = await this.computeFrozenChainHash(
      perEventHashes,
      frozenEventCount
    );

    if (cursor) {
      let frozenIntact = frozenEventCount >= cursor.frozenEventCount;
      if (frozenIntact && cursor.frozenEventCount > 0) {
        const chainAtCursor =
          cursor.frozenEventCount === frozenEventCount
            ? frozenChainHash
            : await this.computeFrozenChainHash(
                perEventHashes,
                cursor.frozenEventCount
              );
        frozenIntact = chainAtCursor === cursor.frozenChainHash;
      }

      if (frozenIntact) {
        const newFrozenEvents = events.slice(
          cursor.frozenEventCount,
          frozenEventCount
        );
        if (
          newFrozenEvents.length === 0 &&
          tailHash === cursor.tailHash &&
          events.length === cursor.pushedCount
        ) {
          // Nothing changed since the last push — still refresh metadata
          // (hash-gated, usually a no-op).
          await this.upsertMetadataIfChanged(
            auth,
            orgId,
            session,
            scopeKey,
            access
          );
          this.markEventPlaneClean(orgId, sessionId, stampAtRead);
          return;
        }
        await this.upsertMetadataIfChanged(
          auth,
          orgId,
          session,
          scopeKey,
          access
        );
        const frozenSegments = splitFrozenIntoSegments(
          newFrozenEvents,
          cursor.frozenSeq + 1
        );
        try {
          await this.client.appendSessionEvents(auth.accessToken, {
            orgId,
            sessionId,
            expectedEpoch: cursor.epoch,
            expectedFrozenSeq: cursor.frozenSeq,
            expectedTailHash: cursor.tailHash,
            newFrozenSegments: frozenSegments,
            tail: tailEvents.length > 0 ? tailEvents : null,
            totalCount: events.length,
          });
          this.setCursor({
            orgId,
            sessionId,
            epoch: cursor.epoch,
            frozenSeq: cursor.frozenSeq + frozenSegments.length,
            pushedCount: events.length,
            frozenEventCount,
            frozenChainHash,
            tailHash,
          });
          this.markEventPlaneClean(orgId, sessionId, stampAtRead);
          return;
        } catch (error) {
          if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
          // OCC rejection → re-anchor on the server epoch below.
          await this.rewriteSession(auth, orgId, session, scopeKey, access, {
            events,
            frozenEventCount,
            frozenChainHash,
            tailEvents,
            tailHash,
            newEpoch: null,
          });
          this.markEventPlaneClean(orgId, sessionId, stampAtRead);
          return;
        }
      }

      // Frozen region mutated in place → epoch+1 full rewrite.
      await this.rewriteSession(auth, orgId, session, scopeKey, access, {
        events,
        frozenEventCount,
        frozenChainHash,
        tailEvents,
        tailHash,
        newEpoch: cursor.epoch + 1,
      });
      this.markEventPlaneClean(orgId, sessionId, stampAtRead);
      return;
    }

    // First push (no cursor): optimistic epoch-1 anchor; server-side OCC
    // bounces us into the re-anchor path when state already exists.
    await this.rewriteSession(auth, orgId, session, scopeKey, access, {
      events,
      frozenEventCount,
      frozenChainHash,
      tailEvents,
      tailHash,
      newEpoch: 1,
    });
    this.markEventPlaneClean(orgId, sessionId, stampAtRead);
  }

  /**
   * Epoch-bumped full rewrite. `newEpoch: null` (and any ORG2_CONFLICT on a
   * concrete epoch) re-anchors on the server epoch — read via
   * `getSessionEvents` — exactly once; a second conflict propagates.
   */
  private async rewriteSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    plan: {
      events: SessionEvent[];
      frozenEventCount: number;
      frozenChainHash: string;
      tailEvents: SessionEvent[];
      tailHash: string | null;
      newEpoch: number | null;
    }
  ): Promise<void> {
    const sessionId = session.session_id;
    let epoch = plan.newEpoch;
    let reanchored = epoch === null;
    if (epoch === null) {
      epoch = (await this.readServerEpoch(auth, orgId, sessionId)) + 1;
    }
    await this.upsertMetadataIfChanged(auth, orgId, session, scopeKey, access);
    const frozenSegments = splitFrozenIntoSegments(
      plan.events.slice(0, plan.frozenEventCount),
      1
    );
    for (;;) {
      try {
        await this.client.rewriteSessionEvents(auth.accessToken, {
          orgId,
          sessionId,
          newEpoch: epoch,
          frozenSegments,
          tail: plan.tailEvents.length > 0 ? plan.tailEvents : null,
          totalCount: plan.events.length,
        });
        this.setCursor({
          orgId,
          sessionId,
          epoch,
          frozenSeq: frozenSegments.length,
          pushedCount: plan.events.length,
          frozenEventCount: plan.frozenEventCount,
          frozenChainHash: plan.frozenChainHash,
          tailHash: plan.tailHash,
        });
        return;
      } catch (error) {
        if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT") || reanchored) {
          throw error;
        }
        reanchored = true;
        epoch = (await this.readServerEpoch(auth, orgId, sessionId)) + 1;
      }
    }
  }

  private async readServerEpoch(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string
  ): Promise<number> {
    const snapshot = await this.client.getSessionEvents(
      auth.accessToken,
      orgId,
      sessionId
    );
    return snapshot.epoch ?? 0;
  }
}

/** Module singleton — mounted once via `useOrg2CloudSyncEngine`. */
export const org2CloudSyncEngine = new Org2CloudSyncEngine();
