/**
 * Backend-agnostic teammate-session import/fork helpers + segments push
 * planning.
 *
 * `importRemoteSession` is THE consolidated teammate-session import (design
 * §7.4 + M5 dedup); `forkSession` (design §16.11) is its WRITABLE sibling.
 * Both are backend-agnostic — their only backend dependency is
 * `client.getSessionEventSegments`, satisfied on the managed cloud by
 * `org2CloudBackendAdapter`. The segments planning helpers
 * (`computeFrozenEventCount` / `splitFrozenIntoSegments`) and the shared OCC
 * conflict matcher (`isCollabConflictError`) serve the cloud push engine and
 * the ProjectSyncChannel. The self-hosted engine's pull-application/push
 * helpers were deleted with the in-app self-hosted track (cloud-parity
 * Phase E).
 */
import { listKeys } from "@src/api/services/keyValidation";
import { indexOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session/dispatchTypes";
import type { KeyInfo } from "@src/api/types/keys";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { lastModelPairMapAtom } from "@src/store/session/creatorDefaultModelAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { upsertSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionForkedFrom,
  SessionImportedFrom,
} from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { sha256Hex } from "../collabSyncUtils";
import {
  isModelRunnableWithAccount,
  resolveForkModel,
} from "../forkModelFallback";
import type {
  CollabSyncBackendClient,
  SessionEventSegmentRecord,
  SessionEventsSegmentInput,
} from "../sync/CollabSyncBackend";

const log = createLogger("collabSyncEngineHelpers");

/**
 * Deterministic local session id for a teammate-session import, derived from
 * (orgId, sourceSessionId). A FAILED import (durable cache write returned 0)
 * used to mint a fresh random id per retry, leaking one orphaned event-store
 * entry per pull cycle; a deterministic id makes every retry land on the
 * same local id, so an aborted attempt is simply overwritten.
 */
export async function deriveImportedSessionId(
  orgId: string,
  sourceSessionId: string
): Promise<string> {
  const digest = await sha256Hex(`${orgId}:${sourceSessionId}`);
  return `imported-session-${digest.slice(0, 32)}`;
}

export function rewriteEventsForImportedSnapshot(
  events: SessionEvent[],
  localSessionId: string
): SessionEvent[] {
  return events.map((event) => ({ ...event, sessionId: localSessionId }));
}

/** Legacy (pre-M3) shape: import provenance JSON-encoded in error_message. */
export interface ImportedSessionMetadata {
  originalSessionId?: string;
  orgId?: string;
  ownerMemberId?: string;
  contentHash?: string;
}

/**
 * Legacy fallback only: pre-M3 collab imports stored provenance in
 * `error_message`. New imports carry the first-class `importedFrom` field;
 * this parser exists so those old rows are still FOUND (and upgraded in
 * place on the next import).
 */
export function parseImportedSessionMetadata(
  session: Session
): ImportedSessionMetadata | null {
  if (session.category !== "external_history") return null;
  if (!session.error_message) return null;
  try {
    const parsed = JSON.parse(session.error_message) as ImportedSessionMetadata;
    return parsed;
  } catch {
    return null;
  }
}

export function findImportedSession(
  sessions: Session[],
  orgId: string,
  sourceSessionId: string
): Session | undefined {
  return sessions.find((session) => {
    if (
      session.importedFrom?.orgId === orgId &&
      session.importedFrom.sourceSessionId === sourceSessionId
    ) {
      return true;
    }
    const meta = parseImportedSessionMetadata(session);
    return meta?.orgId === orgId && meta?.originalSessionId === sourceSessionId;
  });
}

// ============================================================================
// Segments push planning (design §7.3)
// ============================================================================

/** displayStatus values after which an event no longer mutates in place. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
]);

/**
 * Frozen line (design §7.2): the frozen region is the longest event PREFIX
 * whose every event carries a terminal displayStatus ("completed"/"failed").
 * The first "running" / "pending" / "awaiting_user" event and everything
 * after it belong to the mutable tail. Events with no displayStatus (should
 * not happen — Rust always stamps it) count as terminal: a later in-place
 * mutation is still caught by the per-event hash chain and only costs an
 * epoch rewrite, whereas treating them as non-terminal would pin the frozen
 * line forever.
 */
export function computeFrozenEventCount(events: SessionEvent[]): number {
  for (let index = 0; index < events.length; index += 1) {
    const status = events[index]?.displayStatus;
    if (typeof status === "string" && !TERMINAL_EVENT_STATUSES.has(status)) {
      return index;
    }
  }
  return events.length;
}

/** Per-segment size budget (design §7.3 step 3a), measured pre-gzip. */
const SEGMENT_MAX_BYTES = 256 * 1024;

/**
 * Greedily pack frozen events into ≤256KB segments (at least one event per
 * segment, so an oversized single event still ships). `startSeq` is the seq
 * of the first produced segment.
 */
export function splitFrozenIntoSegments(
  events: SessionEvent[],
  startSeq: number
): SessionEventsSegmentInput[] {
  const segments: SessionEventsSegmentInput[] = [];
  let current: SessionEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const eventBytes = JSON.stringify(event).length;
    if (current.length > 0 && currentBytes + eventBytes > SEGMENT_MAX_BYTES) {
      segments.push({ seq: startSeq + segments.length, events: current });
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) {
    segments.push({ seq: startSeq + segments.length, events: current });
  }
  return segments;
}

/**
 * True for the server's opaque OCC rejection (append/rewrite anchors, the
 * project channel's whole-row upserts, lock acquisition): the self-hosted
 * plane raises `ORGII_CONFLICT`, the managed cloud raises `ORG2_CONFLICT`
 * (cloud-parity Phase B) — one dispatcher for both backends.
 */
export function isCollabConflictError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("ORGII_CONFLICT") ||
      error.message.includes("ORG2_CONFLICT"))
  );
}

// ============================================================================
// Consolidated remote-session import (design §7.4, dedups the old M5 copies)
// ============================================================================

/**
 * The segments-fetch capability shared by `importRemoteSession` (read-only
 * replay copy) and `forkSession` (writable relay copy). Both fetch the SAME
 * remote history through `fetchAndAssembleSegments`; they differ only in what
 * kind of local session the assembled events land in.
 */
export interface RemoteSessionFetchOptions {
  client: Pick<CollabSyncBackendClient, "getSessionEventSegments">;
  orgId: string;
  remoteSession: RemoteTeammateSessionMetadata;
  /**
   * Link-share capability (design §6.4): when set, every segments fetch
   * authenticates with the token alone — the caller is typically NOT an org
   * member (guest deep link). The token is the only credential.
   * `remoteSession` then comes from `resolveSessionShare`, whose projection
   * includes the segments summary this importer diffs against.
   */
  shareToken?: string;
}

export interface ImportRemoteSessionOptions extends RemoteSessionFetchOptions {
  /**
   * Invoked with the local session id BEFORE any event-store write, so the
   * engine can arm its self-import guard (the eventStore write re-enters the
   * push subscription).
   */
  onBeforeWrite?: (localSessionId: string) => void;
  /**
   * Viewer-local checkout of the shared repo. When present, the authorized
   * replay is indexed into Session Blame with owner paths remapped to this
   * workspace. The owner's absolute `remoteSession.repoPath` is never used as
   * a local navigation path.
   */
  workspaceRepoPath?: string;
}

export interface ImportRemoteSessionResult {
  localSessionId: string;
  /** false ⇒ the local cursor already matched the remote summary. */
  updated: boolean;
}

interface AssembledSegments {
  events: SessionEvent[];
  epoch: number;
  frozenSeq: number;
  frozenCount: number;
  tailHash: string | null;
}

async function fetchAndAssembleSegments(
  options: RemoteSessionFetchOptions,
  afterSeq: number,
  baseFrozenEvents: SessionEvent[],
  expectedEpoch: number | null
): Promise<AssembledSegments | null> {
  const { client, orgId, remoteSession, shareToken } = options;
  const snapshot = await client.getSessionEventSegments({
    orgId,
    sessionRowId: remoteSession.id,
    afterSeq,
    shareToken,
  });
  if (snapshot.epoch === null || snapshot.count === null) return null;
  // The snapshot is authoritative over the (possibly stale) list summary; a
  // mid-flight epoch change invalidates the incremental base.
  if (expectedEpoch !== null && snapshot.epoch !== expectedEpoch) return null;

  const frozen: SessionEventSegmentRecord[] = snapshot.segments
    .filter((segment) => !segment.isTail)
    .sort((a, b) => a.seq - b.seq);
  // Contiguity (design §7.4): frozen seqs must run afterSeq+1..frozenSeq
  // with no gaps, and the reassembled stream must match the summary count.
  let expectedSeq = afterSeq;
  for (const segment of frozen) {
    if (segment.seq !== expectedSeq + 1) return null;
    expectedSeq = segment.seq;
  }
  if ((snapshot.frozenSeq ?? 0) !== expectedSeq) return null;

  const tailSegment =
    snapshot.segments.find((segment) => segment.isTail) ?? null;
  const tailEvents = tailSegment?.events ?? [];
  const events = [
    ...baseFrozenEvents,
    ...frozen.flatMap((segment) => segment.events),
    ...tailEvents,
  ];
  if (events.length !== snapshot.count) return null;
  return {
    events,
    epoch: snapshot.epoch,
    frozenSeq: snapshot.frozenSeq ?? 0,
    frozenCount: events.length - tailEvents.length,
    tailHash: tailSegment?.segmentHash ?? snapshot.tailHash,
  };
}

/**
 * In-flight dedup for `importRemoteSession`, keyed `${orgId}:${sourceSessionId}`.
 * The engine PullLoop and a panel replay click can race on the same remote
 * session; without dedup both run the fetch + event-store write concurrently
 * (double egress, and interleaved set/saveToCache on the same local id).
 */
const inFlightRemoteSessionImports = new Map<
  string,
  Promise<ImportRemoteSessionResult | null>
>();

/**
 * THE import path for teammate sessions — used by both the engine PullLoop
 * (auto-import) and the panel's direct-replay action. Handles:
 * - cursor comparison against the remote summary (no-op when unchanged),
 * - incremental application (new frozen segments appended to the local
 *   frozen prefix, tail region replaced) with local-count + contiguity
 *   validation, falling back to a full refetch on any mismatch,
 * - persistence (`saveToCache`, fix P7) and the `importedFrom` cursor.
 *
 * Concurrent calls for the same (orgId, sourceSessionId) share one in-flight
 * promise. Returns null when the owner has published no segments and nothing
 * was previously imported (callers may fall back to the snapshot-request
 * flow); THROWS when the durable cache write fails so callers treat the
 * import as retryable rather than silently absent.
 */
export async function importRemoteSession(
  options: ImportRemoteSessionOptions
): Promise<ImportRemoteSessionResult | null> {
  const key = `${options.orgId}:${options.remoteSession.sourceSessionId}`;
  let task = inFlightRemoteSessionImports.get(key);
  if (!task) {
    task = importRemoteSessionInner(options).finally(() => {
      inFlightRemoteSessionImports.delete(key);
    });
    inFlightRemoteSessionImports.set(key, task);
  }
  const result = await task;
  if (result && options.workspaceRepoPath) {
    try {
      await indexOrgtrackCollaborationSession({
        localSessionId: result.localSessionId,
        sourceSessionId: options.remoteSession.sourceSessionId,
        title: options.remoteSession.title,
        workspacePath: options.workspaceRepoPath,
        sourceWorkspacePath: options.remoteSession.repoPath,
        orgId: options.orgId,
        sessionRowId: options.remoteSession.id,
        ownerMemberId: options.remoteSession.ownerMemberId,
        ownerDisplayName: options.remoteSession.ownerDisplayName,
      });
    } catch (error) {
      // Replay remains usable; every later open retries this derived index.
      log.warn("failed to index collaboration replay for Session Blame", {
        localSessionId: result.localSessionId,
        error,
      });
    }
  }
  return result;
}

async function importRemoteSessionInner(
  options: ImportRemoteSessionOptions
): Promise<ImportRemoteSessionResult | null> {
  const { orgId, remoteSession, onBeforeWrite, shareToken } = options;
  const store = getInstrumentedStore();
  const sessions = store.get(sessionsAtom) as Session[];
  const existing = findImportedSession(
    sessions,
    orgId,
    remoteSession.sourceSessionId
  );
  // Legacy (error_message) imports have no usable cursor → full refetch.
  const cursor = existing?.importedFrom ?? null;

  if (
    remoteSession.eventsEpoch === undefined ||
    remoteSession.eventsCount === undefined
  ) {
    // No segments published (or publishing stopped): keep any local copy.
    return existing
      ? { localSessionId: existing.session_id, updated: false }
      : null;
  }

  if (
    existing &&
    cursor &&
    cursor.epoch === remoteSession.eventsEpoch &&
    cursor.seq === (remoteSession.eventsFrozenSeq ?? 0) &&
    cursor.count === remoteSession.eventsCount &&
    (cursor.tailHash ?? null) === (remoteSession.eventsTailHash ?? null)
  ) {
    // Cursor no-op — but only if the local store still HAS the events. A
    // cache row can outlive its event data (restart/cleanup churn), and
    // trusting the cursor then pins an unrecoverable empty replay: every
    // click returns here and Reload re-reads the same empty store. Verify
    // before short-circuiting; fall through to a full refetch when hollow.
    const persisted = await eventStoreProxy.getPersistedEvents(
      existing.session_id
    );
    if (persisted.length > 0 || remoteSession.eventsCount === 0) {
      return { localSessionId: existing.session_id, updated: false };
    }
  }

  let assembled: AssembledSegments | null = null;
  if (
    existing &&
    cursor &&
    cursor.epoch >= 1 &&
    cursor.epoch === remoteSession.eventsEpoch &&
    cursor.frozenCount !== undefined &&
    (remoteSession.eventsFrozenSeq ?? 0) >= cursor.seq
  ) {
    // Incremental: verify the local store still holds exactly what the
    // cursor claims before splicing onto it (design §7.4 last line).
    const localEvents = await eventStoreProxy.getPersistedEvents(
      existing.session_id
    );
    if (localEvents.length === cursor.count) {
      assembled = await fetchAndAssembleSegments(
        options,
        cursor.seq,
        localEvents.slice(0, cursor.frozenCount),
        cursor.epoch
      );
    }
  }
  if (!assembled) {
    // Full refetch: epoch change, missing/legacy cursor, or any validation
    // failure above.
    assembled = await fetchAndAssembleSegments(options, 0, [], null);
  }
  if (!assembled) {
    return existing
      ? { localSessionId: existing.session_id, updated: false }
      : null;
  }

  // Deterministic id (not random): a retry after a failed durable write must
  // reuse the same local id instead of leaking a new orphan per attempt.
  const localSessionId =
    existing?.session_id ??
    (await deriveImportedSessionId(orgId, remoteSession.sourceSessionId));
  onBeforeWrite?.(localSessionId);
  const localEvents = rewriteEventsForImportedSnapshot(
    assembled.events,
    localSessionId
  );
  const now = new Date().toISOString();
  const importedFrom: SessionImportedFrom = {
    orgId,
    sourceSessionId: remoteSession.sourceSessionId,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    externalHistorySource:
      remoteSession.origin?.kind === "external_history"
        ? remoteSession.origin.source
        : existing?.importedFrom?.externalHistorySource,
    epoch: assembled.epoch,
    seq: assembled.frozenSeq,
    count: localEvents.length,
    frozenCount: assembled.frozenCount,
    tailHash: assembled.tailHash ?? undefined,
    importedAt: now,
    shareToken: shareToken ?? existing?.importedFrom?.shareToken,
  };
  // Durably cache the events BEFORE persisting the session record + cursor.
  // The cursor claims the import is complete, so if we persisted it first and
  // then the cache write failed (saveToCache swallows errors and returns 0) or
  // the app crashed in between, the next pull would see a matching cursor and
  // never re-fetch — stranding a permanently empty transcript. Ordering the
  // durable write first means a failure just leaves no record and the next
  // pull retries cleanly.
  await eventStoreProxy.set(localEvents, localSessionId);
  const savedCount = await eventStoreProxy.saveToCache(localSessionId);
  if (localEvents.length > 0 && savedCount <= 0) {
    // Cache write failed for a non-empty import — do not persist a "complete"
    // cursor. For a NEW import also drop the just-set events again: with no
    // session record pointing at them they would sit as an orphaned event
    // store entry until the retry overwrites them.
    if (!existing) {
      await eventStoreProxy.clear(localSessionId);
    }
    // Throw (not null): null means "nothing published", which callers treat
    // as final. This failure is transient and must surface as retryable.
    throw new Error(
      `Failed to durably persist imported session ${remoteSession.sourceSessionId} (saveToCache returned ${savedCount})`
    );
  }
  upsertSession({
    session_id: localSessionId,
    status: "completed",
    created_at: existing?.created_at ?? now,
    updated_at: now,
    completed_at: now,
    name: remoteSession.title,
    repoPath: remoteSession.repoPath,
    category: "external_history",
    // No stored model: the imported copy's composer is a FORK ENTRY, not a
    // live agent — leaving model unset makes the composer show the normal
    // "Select model" picker over the viewer's OWN local models/keys (the
    // model the fork will actually run with), instead of a dead
    // "Collaboration Snapshot" label the viewer can't run.
    model: undefined,
    agentIconId: "archive",
    agentDisplayName: "Collaboration Snapshot",
    pinned: existing?.pinned ?? false,
    // Ownership stamp (`Session.orgId`, distinct from `importedFrom.orgId`
    // provenance — see sessionAtom/types.ts): filing the import under the
    // org makes it match the sidebar org selector. Only MEMBER imports are
    // stamped — the engine PullLoop and the panel replay both run in member
    // context (org sync profile, no token). A share-token import is the
    // GUEST path (CollabShareImportDialog, no local membership): it stays
    // under Personal, i.e. no orgId (preserving any prior member stamp).
    orgId: shareToken ? existing?.orgId : orgId,
    importedFrom,
    // Retire the legacy error_message idiom for collab imports; clears any
    // leftover value on upgraded pre-M3 rows.
    error_message: undefined,
  });
  persistSessions(store.get(sessionsAtom) as Session[]);
  return { localSessionId, updated: true };
}

// ============================================================================
// Fork & continue (design §16.11 — session relay)
// ============================================================================

/**
 * Fresh id for a forked session. The `agentsession-` prefix maps to the
 * `rust_agent` category in `SESSION_PREFIX_REGISTRY` — the SAME runnable
 * category a normal local agent session uses — and is deliberately NOT the
 * `imported-session-` prefix (read-only external history).
 */
export function createForkedSessionId(): string {
  return `agentsession-${crypto.randomUUID()}`;
}

/**
 * Locale-neutral fork marker for the forked session's display name.
 * Forking a fork must not stack markers ("⑂ ⑂ title") — one glyph carries
 * the provenance; the lineage chain lives in forkedFrom, not the name.
 */
export function buildForkedSessionName(sourceTitle: string): string {
  return `⑂ ${sourceTitle.replace(/^(?:⑂\s*)+/u, "")}`;
}

export interface ForkSessionResult {
  localSessionId: string;
  /** Display name persisted on the forked record (source title + ⑂ marker). */
  name: string;
  /** Events inherited from the source (== forkedFrom.atCount). */
  eventCount: number;
  /**
   * The workspace the fork actually landed in — a LOCAL checkout resolved
   * from the source's repoScopeKey when `workspaceRepoPath` was supplied,
   * else the owner's raw repoPath (legacy callers). undefined ⇒ the fork
   * opened without a workspace.
   */
  repoPath?: string;
  model?: string;
  accountId?: string;
  modelFallback?: { inheritedModel: string; fallbackModel?: string };
}

export interface ForkExecutionSelection {
  accountId: string;
  model: string;
}

export interface ForkSessionOptions extends RemoteSessionFetchOptions {
  /** Explicit local credentials/model chosen by the member continuing it. */
  execution?: ForkExecutionSelection;
  /**
   * Fork workspace override (fork-relay repoPath fix): when the key is
   * PRESENT, the forked record's repoPath is this LOCAL checkout — or none
   * at all when null — instead of `remoteSession.repoPath`, which is the
   * OWNER's absolute path and generally does not exist on this machine
   * (an agent dispatched into it would run in a bogus workspace).
   * `forkTeammateSession` always passes this after resolving the source's
   * repoScopeKey against local checkouts.
   */
  workspaceRepoPath?: string | null;
}

/**
 * "Fork & continue" (design §16.11): land a replay-capable teammate session's
 * FULL event history as a new WRITABLE local session, so an agent can run on
 * this machine, with this member's key, continuing from the teammate's
 * context. NOT multi-writer — the fork is an ordinary single-writer session
 * that merely records its origin in `forkedFrom`.
 *
 * Shares the exact fetch/assembly path with `importRemoteSession`
 * (`fetchAndAssembleSegments`, always a full refetch from seq 0 — a fork has
 * no incremental cursor to splice onto) and mirrors its durable-write
 * ordering: events are cached BEFORE the session record is persisted, so a
 * failed cache write can never leave a forked record with no events (fix P7's
 * ordering, same rationale as the importer).
 *
 * Unlike an import, the created session:
 * - gets a fresh NORMAL id (`agentsession-*`, category `rust_agent`) so it is
 *   runnable and dispatchable;
 * - sets `forkedFrom` (provenance only) and NOT `importedFrom` — verified
 *   against `isSessionPushAllowed` (collabSyncUtils.ts), which excludes only
 *   `category === "external_history"` and `importedFrom`-bearing sessions:
 *   a fork has neither, so the member's continuation correctly syncs back to
 *   the org under their OWN member id, per their accessMode;
 * - carries `created_at = now`, so the `shareSince` "only new sessions" gate
 *   treats the fork as new work (it is — the inherited history was already
 *   shared by its owner).
 *
 * Permission is the source session's replay visibility (design §16.11): the
 * segments fetch succeeds only under FULL_REPLAY or a replay-level share —
 * enforced server-side, nothing new here. Returns null when the owner has
 * published no segments (metadata-only sessions have nothing to inherit);
 * THROWS on a failed durable write so callers surface it as retryable.
 */
export async function forkSession(
  options: ForkSessionOptions
): Promise<ForkSessionResult | null> {
  const { orgId, remoteSession, shareToken } = options;
  // Workspace choice: an explicit workspaceRepoPath (resolved local
  // checkout, possibly null = none) wins over the owner's absolute path.
  const repoPath =
    "workspaceRepoPath" in options
      ? (options.workspaceRepoPath ?? undefined)
      : remoteSession.repoPath;
  if (
    remoteSession.eventsEpoch === undefined ||
    remoteSession.eventsCount === undefined
  ) {
    // No published segments — nothing to inherit (metadata-only session).
    return null;
  }

  let localKeys: KeyInfo[] | null = null;
  try {
    localKeys = await listKeys();
  } catch {
    localKeys = null;
  }
  if (
    options.execution &&
    (localKeys === null ||
      !isModelRunnableWithAccount(
        options.execution.accountId,
        options.execution.model,
        localKeys
      ))
  ) {
    throw new Error(
      "The selected account/model is no longer available; choose another before forking."
    );
  }
  const store = getInstrumentedStore();
  const defaultModel =
    store.get(lastModelPairMapAtom)[DISPATCH_CATEGORY.RUST_AGENT]?.modelId;
  const resolvedModel = options.execution
    ? { model: options.execution.model, fellBack: false }
    : resolveForkModel(remoteSession.model, localKeys, defaultModel);

  // Full fetch from seq 0, same assembly + validation as the importer.
  const assembled = await fetchAndAssembleSegments(options, 0, [], null);
  if (!assembled) return null;

  const localSessionId = createForkedSessionId();
  const localEvents = rewriteEventsForImportedSnapshot(
    assembled.events,
    localSessionId
  );
  const now = new Date().toISOString();

  // Durable events first, session record second (mirror importRemoteSession):
  // if the cache write fails, no record must claim the fork exists.
  await eventStoreProxy.set(localEvents, localSessionId);
  const savedCount = await eventStoreProxy.saveToCache(localSessionId);
  if (localEvents.length > 0 && savedCount <= 0) {
    // Drop the just-set events again — no session record points at them, and
    // a fork id is random, so (unlike the importer's deterministic id) a
    // retry would not overwrite this orphan.
    await eventStoreProxy.clear(localSessionId);
    throw new Error(
      `Failed to durably persist forked session ${remoteSession.sourceSessionId} (saveToCache returned ${savedCount})`
    );
  }

  const forkedFrom: SessionForkedFrom = {
    orgId,
    sourceSessionId: remoteSession.sourceSessionId,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    atCount: localEvents.length,
    forkedAt: now,
    // Root inheritance: forking a fork keeps pointing at the ORIGINAL
    // session, so the whole relay chain groups under one thread even when
    // intermediate parents age out of the retention window.
    rootSessionId:
      remoteSession.forkedFrom?.rootSessionId ?? remoteSession.sourceSessionId,
  };
  const name = buildForkedSessionName(remoteSession.title);
  upsertSession({
    session_id: localSessionId,
    status: "completed",
    created_at: now,
    updated_at: now,
    name,
    repoPath,
    branch: remoteSession.branch,
    // Runnable category (NOT "external_history"): the fork must be
    // dispatchable and eligible for collab push as this member's own session.
    category: DISPATCH_CATEGORY.RUST_AGENT,
    // Inherit the source's agent/model identity: the fork continues that
    // conversation, and teammate hover cards read these off the pushed
    // metadata. A later run with a different model overwrites them. The
    // model itself is only kept when it is runnable on the forker's OWN
    // keys (resolveForkModel) — otherwise the creator default, or unset.
    cliAgentType: remoteSession.cliAgentType as Session["cliAgentType"],
    agentDisplayName: remoteSession.agentDisplayName,
    model: resolvedModel.model,
    accountId: options.execution?.accountId,
    pinned: false,
    // Ownership stamp, same rule as importRemoteSession: a member's fork is
    // filed under the source org so the sidebar org selector lists it; a
    // guest (share-token) fork stays under Personal. Today forks only run in
    // member context (panel fork action), so the guard is future-proofing.
    orgId: shareToken ? undefined : orgId,
    forkedFrom,
    // Deliberately NO importedFrom: that field marks read-only replay copies
    // and excludes them from push (isSessionPushAllowed).
  });
  persistSessions(store.get(sessionsAtom) as Session[]);
  return {
    localSessionId,
    name,
    eventCount: localEvents.length,
    repoPath,
    model: resolvedModel.model,
    accountId: options.execution?.accountId,
    ...(resolvedModel.fellBack && remoteSession.model
      ? {
          modelFallback: {
            inheritedModel: remoteSession.model,
            fallbackModel: resolvedModel.model,
          },
        }
      : {}),
  };
}
