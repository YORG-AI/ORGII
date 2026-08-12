import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { rpc } from "@src/api/tauri/rpc";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import { createLogger } from "@src/hooks/logger";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";
import type { ActivityChunk } from "@src/types/session/session";
import {
  isCliSession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

import {
  sha256Hex,
  stableStringify,
} from "../TeamCollaboration/collabSyncUtils";
import {
  computeFrozenEventCount,
  splitFrozenIntoSegments,
} from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import { computeSegmentHash } from "../TeamCollaboration/sync/collabGzip";
import type { CloudPushAccess } from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { broadcastOrgControlChangedToPeers } from "./org2CloudControlBus";
import {
  EVENT_HASH_CONCURRENCY,
  appendMerkleFrontier,
  buildMerkleFrontier,
  hashStringList,
  isValidMerkleFrontier,
  merkleFrontierCommitment,
} from "./org2CloudMerkleFrontier";
import {
  buildCloudSessionMetadata,
  metadataPayloadForHash,
} from "./org2CloudSessionSync.metadata";
import { Org2CloudSessionSyncState } from "./org2CloudSessionSync.state";
import type {
  Org2CloudSyncClientDeps,
  PreparedPushEvents,
  PreparedPushPlan,
} from "./org2CloudSessionSync.types";
import type {
  CollabSessionPushCursor,
  ImportedReplayCheckpoint,
} from "./org2CloudSyncAtoms";
import {
  type CloudSessionTurnSummary,
  isOrg2SyncErrorCode,
} from "./org2CloudSyncClient";
import type { CloudStore } from "./org2CloudSyncLifecycle";

export {
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSessionSync.metadata";
export type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";

const log = createLogger("Org2CloudSyncEngine");

/** Largest cursor accepted by the backend's int4 `p_after_seq` argument. */
const HEAD_READ_AFTER_SEQ = 2_147_483_647;

/**
 * Keep every segment mutation comfortably below PostgREST / PostgreSQL
 * statement-timeout and renderer-RSS cliffs. Each frozen segment is bounded
 * to 256 KiB before gzip, so a batch carries at most ~4 MiB of canonical
 * input and the client codec only materializes one batch of wire payloads.
 */
export const SESSION_SEGMENT_UPLOAD_BATCH_SIZE = 16;

const IMPORTED_INCREMENTAL_TURN_LIMIT = 50;
const IMPORTED_INCREMENTAL_SEGMENT_LIMIT = 16;
/**
 * Force one full authoritative reread after this many consecutive bounded
 * passes. A historical rewrite that preserves every provider turn id outside
 * the reread overlap cannot be detected from the compact checkpoint alone;
 * the periodic full read bounds that blind spot at ~64 appended turns while
 * amortizing its O(total) read cost to under 2% of passes. The reread never
 * uploads by itself: an intact prefix rides the ordinary delta append and
 * only a genuine chain mismatch pays the epoch rewrite.
 */
export const IMPORTED_INCREMENTAL_REANCHOR_EVERY = 64;

interface ImportedReplayAnchorDraft {
  turnIds: string[];
  lastTurnStartEventIndex: number;
  lastTurnStartChunkIndex: number;
}

interface LoadedPushEvents {
  events: SessionEvent[];
  localContentRevision?: number;
  anchorDraft?: ImportedReplayAnchorDraft;
  precomputedEventHashes?: string[];
  precomputedLocalFrozenEventCount?: number;
  baseChunkCount?: number;
}

/** Per-session transient retry policy (org entitlement failures back off elsewhere). */
export const SESSION_PUSH_RETRY_BASE_MS = 60_000;
export const SESSION_PUSH_RETRY_MAX_MS = 30 * 60_000;

interface SessionPushRetryState {
  failures: number;
  retryAtMs: number;
}

/** Prompt previews published to the turn index are content-capped. */
const TURN_INDEX_PROMPT_MAX_CHARS = 240;
/**
 * Client-side publish cap: sessions with more rounds skip the index (the
 * viewer falls back to the plain progress download). Stays under whatever
 * cap the server enforces on the jsonb payload.
 */
const TURN_INDEX_MAX_ROUNDS = 2_000;

/** Mirror of Rust normalize_turn_user_preview (turn_window.rs) + truncation. */
export function normalizeTurnPromptPreview(preview: string): string {
  const trimmed = preview.trim();
  const stripped = trimmed.startsWith("user_message ")
    ? trimmed.slice("user_message ".length)
    : trimmed.startsWith("user ")
      ? trimmed.slice("user ".length)
      : trimmed;
  const normalized = stripped.trim();
  return normalized.length > TURN_INDEX_PROMPT_MAX_CHARS
    ? `${normalized.slice(0, TURN_INDEX_PROMPT_MAX_CHARS)}…`
    : normalized;
}

async function hashEventsBounded(events: SessionEvent[]): Promise<string[]> {
  const hashes = new Array<string>(events.length);
  for (let start = 0; start < events.length; start += EVENT_HASH_CONCURRENCY) {
    const end = Math.min(start + EVENT_HASH_CONCURRENCY, events.length);
    const batch = events.slice(start, end);
    const batchHashes = await Promise.all(
      batch.map((event) => sha256Hex(stableStringify(event)))
    );
    for (let index = 0; index < batchHashes.length; index += 1) {
      hashes[start + index] = batchHashes[index];
    }
  }
  return hashes;
}

function lastUserChunkIndex(chunks: readonly ActivityChunk[]): number {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index].function === "user_message") return index;
  }
  return -1;
}
/**
 * Owns one session's metadata/event push plane, including persisted cursors,
 * event-clean stamps, OCC re-anchors, and retract bookkeeping.
 *
 * In-memory bookkeeping (pushed-metadata hashes, clean-event-plane stamps,
 * cursor/pushed-marker storage) lives in the Org2CloudSessionSyncState base
 * class in org2CloudSessionSync.state.ts; this subclass adds the
 * network-facing push/rewrite orchestration that calls the sync client.
 */
export class Org2CloudSessionSync extends Org2CloudSessionSyncState {
  /** Transient event-plane failures, bounded by live (org, session) pairs. */
  private readonly sessionPushRetryStates = new Map<
    string,
    SessionPushRetryState
  >();

  /** A short read must repeat identically across passes before it rewrites. */
  private readonly sessionShrinkCandidates = new Map<string, number>();

  constructor(
    getStore: () => CloudStore | null,
    private readonly client: Org2CloudSyncClientDeps
  ) {
    super(getStore);
  }

  override reset(): void {
    super.reset();
    this.sessionPushRetryStates.clear();
    this.sessionShrinkCandidates.clear();
  }

  override prune(
    liveOrgIds: ReadonlySet<string>,
    liveSessionIds: ReadonlySet<string>
  ): void {
    super.prune(liveOrgIds, liveSessionIds);
    for (const states of [
      this.sessionPushRetryStates,
      this.sessionShrinkCandidates,
    ] as const) {
      for (const key of states.keys()) {
        const separatorIndex = key.indexOf(":");
        const orgId =
          separatorIndex === -1 ? key : key.slice(0, separatorIndex);
        const sessionId =
          separatorIndex === -1 ? "" : key.slice(separatorIndex + 1);
        if (!liveOrgIds.has(orgId) || !liveSessionIds.has(sessionId)) {
          states.delete(key);
        }
      }
    }
  }

  private isSessionPushBackedOff(orgId: string, sessionId: string): boolean {
    const key = `${orgId}:${sessionId}`;
    const state = this.sessionPushRetryStates.get(key);
    if (!state) return false;
    if (Date.now() < state.retryAtMs) return true;
    return false;
  }

  private noteSessionPushFailure(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    const previous = this.sessionPushRetryStates.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const delayMs = Math.min(
      SESSION_PUSH_RETRY_BASE_MS * 2 ** (failures - 1),
      SESSION_PUSH_RETRY_MAX_MS
    );
    this.sessionPushRetryStates.set(key, {
      failures,
      retryAtMs: Date.now() + delayMs,
    });
  }

  private clearSessionPushFailure(orgId: string, sessionId: string): void {
    this.sessionPushRetryStates.delete(`${orgId}:${sessionId}`);
  }

  private shouldBackOffSessionFailure(error: unknown): boolean {
    // Entitlement failures already have org-wide active/inactive backoff and
    // toast policy in Org2CloudSyncEngine. Duplicating that state here would
    // keep one session asleep after the org is explicitly resumed.
    return (
      !isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED") &&
      !isOrg2SyncErrorCode(error, "ORG2_SYNC_DISABLED")
    );
  }

  /** Seed volatile cold-start caches from a server-authoritative listing. */
  async seedFromRemoteSummary(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    remote: RemoteTeammateSessionMetadata
  ): Promise<void> {
    const key = `${orgId}:${session.session_id}`;
    if (this.remoteSeedAttemptedKeys.has(key)) return;
    this.remoteSeedAttemptedKeys.add(key);
    if (
      remote.deletedAt ||
      remote.ownerUserId !== auth.userId ||
      remote.sourceSessionId !== session.session_id
    ) {
      return;
    }
    const displayName =
      auth.profile?.displayName ?? auth.profile?.primaryEmail ?? auth.userId;
    const localMetadata = buildCloudSessionMetadata(
      session,
      orgId,
      auth.userId,
      displayName,
      scopeKey,
      access,
      auth.profile?.avatarUrl
    );
    const [localHash, remoteHash] = await Promise.all([
      sha256Hex(stableStringify(metadataPayloadForHash(localMetadata))),
      sha256Hex(stableStringify(metadataPayloadForHash(remote))),
    ]);
    if (localHash === remoteHash) {
      // upsertMetadataIfChanged gates on the FULL payload hash; seeding the
      // stripped comparison hash would never match it and every restart would
      // re-upsert an identical payload for every pushed session.
      this.lastPushedMetadataHashes.set(
        key,
        await sha256Hex(stableStringify(localMetadata))
      );
      this.setPushedMetadataMarker(orgId, session.session_id);
    }

    // Metadata and transcript are independent planes. Even if a title or
    // access field changed locally, a cursor stamped with this exact local
    // content version plus the server summary proves the event plane clean.
    // Legacy cursors lack the stamp and deliberately take one normal read.
    const cursor = this.getCursor(orgId, session.session_id);
    if (
      !cursor ||
      remote.eventsEpoch !== cursor.epoch ||
      remote.eventsFrozenSeq !== cursor.frozenSeq ||
      remote.eventsCount !== cursor.pushedCount ||
      (remote.eventsTailHash ?? null) !== cursor.tailHash
    ) {
      return;
    }
    let localContentRevision: number | undefined;
    if (!isImportedHistorySession(session.session_id)) {
      const durable = await eventStoreProxy.getPersistedEventRevision(
        session.session_id
      );
      if (durable && durable.eventCount > 0) {
        if (durable.eventCount !== cursor.pushedCount) return;
        if (
          cursor.localContentRevision !== undefined &&
          cursor.localContentRevision !== durable.revision
        ) {
          return;
        }
        // Legacy revisions are upgraded from the server cursor + local count
        // proof. Crucially this is independent of Session.updated_at: rename,
        // pin and org-access edits are metadata changes and must not trigger a
        // multi-GB replay materialization.
        localContentRevision = durable.revision;
        if (cursor.localContentRevision !== durable.revision) {
          this.setCursor({ ...cursor, localContentRevision: durable.revision });
        }
      } else if (cursor.localContentUpdatedAt !== session.updated_at) {
        return;
      }
    } else if (cursor.localContentUpdatedAt !== session.updated_at) {
      return;
    }
    this.markEventPlaneClean(
      orgId,
      session,
      this.eventActivityStamps.get(session.session_id) ?? 0,
      Date.now(),
      localContentRevision
    );
  }

  /** Soft-tombstone a prior push and clear every local pushed marker. */
  /** Live server rows this ACCOUNT owns in the org, regardless of which
   * device pushed them or whether local push markers survived. */
  async listSelfOwnedLiveRemoteSessionIds(
    auth: Org2CloudAuthState,
    orgId: string
  ): Promise<string[]> {
    const result = await this.client.listOrgSessions(auth.accessToken, orgId);
    return result.sessions
      .filter((row) => row.ownerUserId === auth.userId && !row.deletedAt)
      .map((row) => row.sourceSessionId);
  }

  async retractSession(
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
    this.lastPushedTurnIndexHashes.delete(`${orgId}:${sessionId}`);
    this.clearPushedMetadataMarker(orgId, sessionId);
    this.clearCursor(orgId, sessionId);
    broadcastOrgControlChangedToPeers(orgId, "sessions");
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
      access,
      auth.profile?.avatarUrl
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
    broadcastOrgControlChangedToPeers(orgId, "sessions");
  }

  private async loadFullPushEvents(
    sessionId: string
  ): Promise<LoadedPushEvents> {
    if (isImportedHistorySession(sessionId)) {
      const source = getImportedHistorySourceBySessionId(sessionId);
      if (!source) return { events: [] };
      const chunks = await source.loadFullTranscriptChunks(sessionId);
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return { events: [] };
      }
      const events = await processChunksRust(chunks, sessionId);
      if (!source.loadCloudTurnIds || !source.loadCloudTurnWindows) {
        return { events };
      }
      try {
        // Source turn ids are provider-native seek cursors. They intentionally
        // need not equal normalized event ids (Codex uses byte offsets here),
        // so prove the final turn boundary by normalizing its exact window and
        // matching it against the authoritative transcript suffix.
        const turnIds = await source.loadCloudTurnIds(sessionId);
        if (
          turnIds.some((turnId) => !turnId) ||
          new Set(turnIds).size !== turnIds.length
        ) {
          return { events };
        }
        const lastTurnId = turnIds.at(-1);
        if (lastTurnId) {
          const lastTurnStartChunkIndex = lastUserChunkIndex(chunks);
          if (lastTurnStartChunkIndex < 0) return { events };
          const windows = await source.loadCloudTurnWindows(
            sessionId,
            [lastTurnId],
            lastTurnStartChunkIndex
          );
          if (
            windows.length === 1 &&
            windows[0].turnId === lastTurnId &&
            windows[0].chunks.length > 0
          ) {
            const lastTurnEvents = await processChunksRust(
              windows[0].chunks,
              sessionId
            );
            const lastTurnStartEventIndex =
              events.length - lastTurnEvents.length;
            if (
              lastTurnEvents.length > 0 &&
              lastTurnStartEventIndex >= 0 &&
              stableStringify(events.slice(lastTurnStartEventIndex)) ===
                stableStringify(lastTurnEvents)
            ) {
              return {
                events,
                anchorDraft: {
                  turnIds,
                  lastTurnStartEventIndex,
                  lastTurnStartChunkIndex,
                },
              };
            }
          }
        }
      } catch (error) {
        log.warn(
          `could not establish incremental replay anchor for ${sessionId}; ` +
            "using the authoritative full path",
          error
        );
      }
      return { events };
    }
    const revisionBefore =
      await eventStoreProxy.getPersistedEventRevision(sessionId);
    const persisted = await eventStoreProxy.getPersistedEvents(sessionId);
    const revisionAfter =
      await eventStoreProxy.getPersistedEventRevision(sessionId);
    const localContentRevision =
      revisionBefore &&
      revisionAfter &&
      revisionBefore.revision === revisionAfter.revision &&
      revisionAfter.eventCount === persisted.length
        ? revisionAfter.revision
        : undefined;
    if (persisted.length > 0 || !isCliSession(sessionId)) {
      return { events: persisted, localContentRevision };
    }
    // Live CLI sessions keep their transcript of record in the CLI's native
    // store (account-profile aware) and never write the events cache, so a
    // persisted read alone pushes a hollow session: metadata with no replay,
    // and the pass then stamps the event plane clean. Load the full native
    // transcript through the same command the session-resume path uses.
    const chunks = (await rpc.cli.chunks({ sessionId })) as ActivityChunk[];
    if (!Array.isArray(chunks) || chunks.length === 0) return { events: [] };
    return { events: await processChunksRust(chunks, sessionId) };
  }

  /** Authoritative complete loader retained for first anchor and recovery. */
  async loadPushEvents(sessionId: string): Promise<SessionEvent[]> {
    return (await this.loadFullPushEvents(sessionId)).events;
  }

  private async tryLoadIncrementalImportedPushEvents(
    sessionId: string,
    cursor: CollabSessionPushCursor
  ): Promise<(LoadedPushEvents & { baseEventCount: number }) | null> {
    const checkpoint = cursor.importedReplay;
    if (!checkpoint || checkpoint.version !== 1) return null;
    // Cadence gate: after enough bounded passes, decline the checkpoint so
    // this pass takes the full authoritative read, which validates the whole
    // frozen prefix against the cursor's chain commitment and stamps a fresh
    // checkpoint (pass count 0). This is the only detector for a historical
    // rewrite that preserves every provider turn id outside the reread
    // overlap; without it that blind spot is unbounded.
    if (
      (checkpoint.incrementalPassCount ?? 0) >=
      IMPORTED_INCREMENTAL_REANCHOR_EVERY
    ) {
      return null;
    }
    const source = getImportedHistorySourceBySessionId(sessionId);
    if (!source?.loadCloudTurnIds || !source.loadCloudTurnWindows) return null;
    if (
      !isValidMerkleFrontier(
        checkpoint.frozenHashFrontier,
        cursor.frozenEventCount
      )
    ) {
      return null;
    }
    if (
      (await merkleFrontierCommitment(
        checkpoint.frozenHashFrontier,
        cursor.frozenEventCount
      )) !== cursor.frozenChainHash
    ) {
      return null;
    }

    const turnIds = await source.loadCloudTurnIds(sessionId);
    if (
      turnIds.some((turnId) => !turnId) ||
      new Set(turnIds).size !== turnIds.length
    ) {
      return null;
    }
    const reloadIndex = turnIds.indexOf(checkpoint.reloadTurnId);
    if (reloadIndex < 0) return null;
    if (
      (await hashStringList(turnIds.slice(0, reloadIndex))) !==
      checkpoint.prefixTurnIdsHash
    ) {
      return null;
    }
    const reloadTurnIds = turnIds.slice(reloadIndex);
    if (
      reloadTurnIds.length === 0 ||
      reloadTurnIds.length > IMPORTED_INCREMENTAL_TURN_LIMIT
    ) {
      return null;
    }
    const windows = await source.loadCloudTurnWindows(
      sessionId,
      reloadTurnIds,
      checkpoint.retainedChunkCount
    );
    if (
      windows.length !== reloadTurnIds.length ||
      windows.some(
        (window, index) =>
          window.turnId !== reloadTurnIds[index] || window.chunks.length === 0
      )
    ) {
      return null;
    }

    const events: SessionEvent[] = [];
    let lastTurnStartEventIndex = 0;
    let precedingChunkCount = 0;
    let lastTurnStartChunkIndex = 0;
    for (let index = 0; index < windows.length; index += 1) {
      if (index === windows.length - 1) {
        lastTurnStartEventIndex = events.length;
        lastTurnStartChunkIndex = precedingChunkCount;
      }
      events.push(
        ...(await processChunksRust(windows[index].chunks, sessionId))
      );
      precedingChunkCount += windows[index].chunks.length;
    }
    const expectedBase =
      cursor.frozenEventCount - checkpoint.frozenOverlapCount;
    if (
      expectedBase < 0 ||
      checkpoint.retainedEventCount !== expectedBase ||
      checkpoint.frozenOverlapCount > events.length
    ) {
      return null;
    }
    const perEventHashes = await hashEventsBounded(events);
    if (
      (await hashStringList(
        perEventHashes.slice(0, checkpoint.frozenOverlapCount)
      )) !== checkpoint.frozenOverlapHash
    ) {
      return null;
    }
    const totalEventCount = checkpoint.retainedEventCount + events.length;
    if (totalEventCount < cursor.pushedCount) return null;

    const localFrozenEventCount = computeFrozenEventCount(events);
    const priorFrozenInsideWindow =
      cursor.frozenEventCount - checkpoint.retainedEventCount;
    if (localFrozenEventCount < priorFrozenInsideWindow) return null;
    const newFrozenEvents = events.slice(
      priorFrozenInsideWindow,
      localFrozenEventCount
    );
    if (
      splitFrozenIntoSegments(newFrozenEvents, cursor.frozenSeq + 1).length >
      IMPORTED_INCREMENTAL_SEGMENT_LIMIT
    ) {
      return null;
    }
    return {
      baseEventCount: checkpoint.retainedEventCount,
      baseChunkCount: checkpoint.retainedChunkCount,
      events,
      anchorDraft: {
        turnIds,
        lastTurnStartEventIndex,
        lastTurnStartChunkIndex,
      },
      precomputedEventHashes: perEventHashes,
      precomputedLocalFrozenEventCount: localFrozenEventCount,
    };
  }

  private async buildImportedReplayCheckpoint(
    draft: ImportedReplayAnchorDraft | undefined,
    baseEventCount: number,
    baseChunkCount: number,
    events: readonly SessionEvent[],
    perEventHashes: readonly string[],
    frozenEventCount: number,
    frozenHashFrontier: Array<string | null> | undefined,
    incrementalPassCount: number
  ): Promise<ImportedReplayCheckpoint | undefined> {
    if (!draft || draft.turnIds.length === 0 || !frozenHashFrontier) {
      return undefined;
    }
    const retainedEventCount = baseEventCount + draft.lastTurnStartEventIndex;
    if (frozenEventCount < retainedEventCount) return undefined;
    const frozenOverlapCount = frozenEventCount - retainedEventCount;
    if (draft.lastTurnStartEventIndex + frozenOverlapCount > events.length) {
      return undefined;
    }
    return {
      version: 1,
      reloadTurnId: draft.turnIds[draft.turnIds.length - 1],
      prefixTurnIdsHash: await hashStringList(draft.turnIds.slice(0, -1)),
      retainedEventCount,
      retainedChunkCount: baseChunkCount + draft.lastTurnStartChunkIndex,
      frozenOverlapCount,
      frozenOverlapHash: await hashStringList(
        perEventHashes.slice(
          draft.lastTurnStartEventIndex,
          draft.lastTurnStartEventIndex + frozenOverlapCount
        )
      ),
      frozenHashFrontier,
      incrementalPassCount,
    };
  }

  private createPreparedPushEvents(
    stampAtRead: number,
    mode: "full" | "incremental",
    baseEventCount: number,
    loaded: LoadedPushEvents,
    cursor?: CollabSessionPushCursor
  ): PreparedPushEvents {
    const { events, anchorDraft } = loaded;
    let planPromise: Promise<PreparedPushPlan> | null = null;
    const plan = (): Promise<PreparedPushPlan> => {
      if (!planPromise) {
        planPromise = (async () => {
          const perEventHashes =
            loaded.precomputedEventHashes ?? (await hashEventsBounded(events));
          const localFrozenEventCount =
            loaded.precomputedLocalFrozenEventCount ??
            computeFrozenEventCount(events);
          const frozenEventCount = baseEventCount + localFrozenEventCount;
          const totalEventCount = baseEventCount + events.length;
          const tailEvents = events.slice(localFrozenEventCount);
          const tailHash =
            tailEvents.length > 0 ? await computeSegmentHash(tailEvents) : null;
          const usesIncrementalHash =
            Boolean(anchorDraft) ||
            (mode === "incremental" && Boolean(cursor?.importedReplay));
          const frozenHashMode = usesIncrementalHash ? "merkle-v1" : "flat-v1";
          let frozenHashFrontier: Array<string | null> | undefined;
          let frozenChainHash: string;
          if (mode === "incremental" && cursor) {
            const priorFrozenInsideWindow =
              cursor.frozenEventCount - baseEventCount;
            const newFrozenHashes = perEventHashes.slice(
              priorFrozenInsideWindow,
              localFrozenEventCount
            );
            const currentFrontier = cursor.importedReplay?.frozenHashFrontier;
            if (!currentFrontier) {
              throw new Error(
                "Incremental imported replay lost its hash frontier"
              );
            }
            frozenHashFrontier = await appendMerkleFrontier(
              currentFrontier,
              cursor.frozenEventCount,
              newFrozenHashes
            );
            frozenChainHash = await merkleFrontierCommitment(
              frozenHashFrontier,
              frozenEventCount
            );
          } else if (usesIncrementalHash) {
            frozenHashFrontier = await buildMerkleFrontier(
              perEventHashes.slice(0, localFrozenEventCount)
            );
            frozenChainHash = await merkleFrontierCommitment(
              frozenHashFrontier,
              frozenEventCount
            );
          } else {
            frozenChainHash = await this.computeFrozenChainHash(
              perEventHashes,
              localFrozenEventCount
            );
          }
          return {
            perEventHashes,
            frozenHashMode,
            totalEventCount,
            frozenEventCount,
            localFrozenEventCount,
            tailEvents,
            tailHash,
            frozenChainHash,
            importedReplay: await this.buildImportedReplayCheckpoint(
              anchorDraft,
              baseEventCount,
              loaded.baseChunkCount ?? 0,
              events,
              perEventHashes,
              frozenEventCount,
              frozenHashFrontier,
              // A full read resets the re-anchor cadence; each bounded pass
              // advances it toward the next forced authoritative reread.
              mode === "incremental"
                ? (cursor?.importedReplay?.incrementalPassCount ?? 0) + 1
                : 0
            ),
          };
        })();
      }
      return planPromise;
    };
    return {
      stampAtRead,
      mode,
      baseEventCount,
      localContentRevision: loaded.localContentRevision,
      events,
      plan,
    };
  }

  private async computeFrozenHashAtCount(
    perEventHashes: string[],
    frozenEventCount: number,
    mode: PreparedPushPlan["frozenHashMode"]
  ): Promise<string> {
    if (mode === "flat-v1") {
      return this.computeFrozenChainHash(perEventHashes, frozenEventCount);
    }
    const frontier = await buildMerkleFrontier(
      perEventHashes.slice(0, frozenEventCount)
    );
    return merkleFrontierCommitment(frontier, frozenEventCount);
  }

  /**
   * True when a commitment over this pass's per-event hashes at the cursor's
   * frozen line reproduces the cursor's stored chain hash in either hash
   * mode. The cursor's likely mode is tried first; the second pass only runs
   * across a flat↔merkle transition, which is rare and bounded to in-memory
   * hashing of the already-loaded hash vector.
   */
  private async frozenChainMatchesCursor(
    cursor: CollabSessionPushCursor,
    plan: PreparedPushPlan
  ): Promise<boolean> {
    const preferred: PreparedPushPlan["frozenHashMode"] = cursor.importedReplay
      ? "merkle-v1"
      : "flat-v1";
    const other: PreparedPushPlan["frozenHashMode"] =
      preferred === "merkle-v1" ? "flat-v1" : "merkle-v1";
    for (const mode of [preferred, other]) {
      const chainAtCursor =
        cursor.frozenEventCount === plan.frozenEventCount &&
        mode === plan.frozenHashMode
          ? plan.frozenChainHash
          : await this.computeFrozenHashAtCount(
              plan.perEventHashes,
              cursor.frozenEventCount,
              mode
            );
      if (chainAtCursor === cursor.frozenChainHash) return true;
    }
    return false;
  }

  private preparePushEventsForPass(
    sessionId: string,
    cursor?: CollabSessionPushCursor,
    forceFull = false
  ): Promise<PreparedPushEvents> {
    const cursorKey =
      !forceFull && cursor?.importedReplay
        ? stableStringify(cursor.importedReplay)
        : "full";
    const prepareKey = `${sessionId}:${cursorKey}`;
    const cached = this.passPushPrepareCache.get(prepareKey);
    if (cached) return cached;
    const prepared = (async (): Promise<PreparedPushEvents> => {
      const stampAtRead = this.eventActivityStamps.get(sessionId) ?? 0;
      if (!forceFull && cursor && isImportedHistorySession(sessionId)) {
        try {
          const incremental = await this.tryLoadIncrementalImportedPushEvents(
            sessionId,
            cursor
          );
          if (incremental) {
            return this.createPreparedPushEvents(
              stampAtRead,
              "incremental",
              incremental.baseEventCount,
              incremental,
              cursor
            );
          }
        } catch (error) {
          log.warn(
            `incremental replay preparation failed for ${sessionId}; ` +
              "using the authoritative full path",
            error
          );
        }
      }
      return this.createPreparedPushEvents(
        stampAtRead,
        "full",
        0,
        await this.loadFullPushEvents(sessionId)
      );
    })();
    this.cachePreparedPushEvents(prepareKey, prepared);
    return prepared;
  }

  async pushSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const sessionId = session.session_id;
    if (
      access.accessMode !== COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY &&
      this.isSessionPushBackedOff(orgId, sessionId)
    ) {
      // Metadata remains cheap and live while the expensive transcript plane
      // sleeps. The hash gate makes this a no-RPC no-op when unchanged.
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      return;
    }
    try {
      await this.pushSessionOnce(auth, orgId, session, scopeKey, access);
      this.clearSessionPushFailure(orgId, sessionId);
    } catch (error) {
      if (this.shouldBackOffSessionFailure(error)) {
        this.noteSessionPushFailure(orgId, sessionId);
      }
      throw error;
    }
  }

  private async pushSessionOnce(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const sessionId = session.session_id;
    if (access.accessMode === COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      // A metadata-only pass invalidates local segment knowledge. If policy
      // later rises to full replay, rebuild the authoritative transcript.
      this.cleanEventPlanes.get(sessionId)?.delete(orgId);
      this.clearCursor(orgId, sessionId);
      return;
    }
    // The external-history scanner updates sessionsAtom directly, without an
    // EventStore notification. Gate on the source's updated_at as well as the
    // event-store stamp, and defer metadata together with replay so a live CLI
    // turn does not produce one cloud upsert per scanner refresh.
    if (!this.isExternalHistorySettled(session)) return;
    if (this.isEventPlaneClean(orgId, session)) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      return;
    }
    const cursor = this.getCursor(orgId, sessionId);
    const prepared = await this.preparePushEventsForPass(sessionId, cursor);
    const { stampAtRead, mode, baseEventCount, localContentRevision, events } =
      prepared;
    const markPreparedClean = () =>
      this.markEventPlaneClean(
        orgId,
        session,
        stampAtRead,
        Date.now(),
        localContentRevision
      );
    if (!cursor && events.length === 0) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      markPreparedClean();
      return;
    }
    const shrinkKey = `${orgId}:${sessionId}`;
    let confirmedShrink = false;
    // Equals the plan's totalEventCount without forcing the plan: the shrink
    // dance below returns without pushing on its first observation, and
    // hashing a GB-scale transcript just to skip would defeat this pass.
    const observedTotalEventCount = baseEventCount + events.length;
    if (cursor && observedTotalEventCount < cursor.pushedCount) {
      if (observedTotalEventCount === 0) {
        // A hollow local read can NEVER authorize erasing the cloud copy.
        // An empty store (wiped cache, missing provider DB, rebuilding
        // import) reads zero on EVERY pass, so consecutive-pass
        // confirmation is no evidence of intent — and the cloud row may be
        // the only surviving copy (cursoride-93121e8a lost its 301 cloud
        // events to exactly this rewrite on 2026-07-31). Recovery for a
        // hollow local store is seed/import, not an empty rewrite.
        this.sessionShrinkCandidates.delete(shrinkKey);
        log.rateLimited(
          `hollow-push-${shrinkKey}`,
          60_000,
          `persisted read for ${sessionId} returned 0 events but the ` +
            `cloud cursor covers ${cursor.pushedCount}; refusing hollow ` +
            `epoch rewrite`
        );
        return;
      }
      if (
        this.sessionShrinkCandidates.get(shrinkKey) === observedTotalEventCount
      ) {
        this.sessionShrinkCandidates.delete(shrinkKey);
        confirmedShrink = true;
        log.info(
          `persisted read for ${sessionId} returned ${observedTotalEventCount} events ` +
            `on consecutive passes while the cloud cursor covers ` +
            `${cursor.pushedCount}; re-anchoring via epoch rewrite`
        );
      } else {
        this.sessionShrinkCandidates.set(shrinkKey, observedTotalEventCount);
        log.warn(
          `persisted read for ${sessionId} returned ${observedTotalEventCount} events ` +
            `but the cloud cursor covers ${cursor.pushedCount}; skipping`
        );
        return;
      }
    } else {
      this.sessionShrinkCandidates.delete(shrinkKey);
    }

    const preparedPlan = await prepared.plan();
    const {
      perEventHashes,
      frozenHashMode,
      totalEventCount,
      frozenEventCount,
      localFrozenEventCount,
      tailEvents,
      tailHash,
      frozenChainHash,
      importedReplay,
    } = preparedPlan;

    if (cursor && mode === "incremental") {
      const priorFrozenInsideWindow = cursor.frozenEventCount - baseEventCount;
      const newFrozenEvents = events.slice(
        priorFrozenInsideWindow,
        localFrozenEventCount
      );
      if (
        newFrozenEvents.length === 0 &&
        tailHash === cursor.tailHash &&
        totalEventCount === cursor.pushedCount
      ) {
        await this.upsertMetadataIfChanged(
          auth,
          orgId,
          session,
          scopeKey,
          access
        );
        if (importedReplay) {
          this.setCursor({
            ...cursor,
            frozenChainHash,
            importedReplay,
          });
        }
        markPreparedClean();
        return;
      }
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      try {
        await this.appendIncrementalSession(
          auth,
          orgId,
          sessionId,
          cursor,
          newFrozenEvents,
          preparedPlan
        );
      } catch (error) {
        if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
        const fullPrepared = await this.preparePushEventsForPass(
          sessionId,
          cursor,
          true
        );
        const fullPlan = await fullPrepared.plan();
        await this.rewriteSession(auth, orgId, session, scopeKey, access, {
          events: fullPrepared.events,
          ...fullPlan,
          newEpoch: null,
        });
      }
      broadcastOrgControlChangedToPeers(orgId, "sessions");
      markPreparedClean();
      void this.publishTurnIndexBestEffort(auth, orgId, session, stampAtRead);
      return;
    }

    if (cursor) {
      let frozenIntact =
        !confirmedShrink && frozenEventCount >= cursor.frozenEventCount;
      if (frozenIntact && cursor.frozenEventCount > 0) {
        // The cursor's commitment may be in either hash mode: flat-v1 cursors
        // predate the imported-replay checkpoint, a failed turn-id probe
        // downgrades a checkpointed cursor, and an interrupted batch append
        // persists a merkle commitment without its checkpoint. Both modes
        // commit to the same per-event hashes, so intactness accepts a match
        // in either — an intact history rides the delta append and adopts
        // this plan's mode there; a mode change alone must never force the
        // O(total) epoch rewrite.
        frozenIntact = await this.frozenChainMatchesCursor(
          cursor,
          preparedPlan
        );
      }

      if (!frozenIntact) {
        // An epoch rewrite re-uploads the ENTIRE frozen history. It is the
        // expensive path, so name the condition that forced it: a silent
        // rewrite loop is indistinguishable from steady state in the ledger.
        log.info(
          `epoch rewrite for ${sessionId} org ${orgId}: ` +
            `confirmedShrink=${confirmedShrink} ` +
            `frozen=${frozenEventCount} cursorFrozen=${cursor.frozenEventCount} ` +
            `chainMismatch=${
              !confirmedShrink && frozenEventCount >= cursor.frozenEventCount
            }`
        );
      }

      if (frozenIntact) {
        const newFrozenEvents = events.slice(
          cursor.frozenEventCount,
          frozenEventCount
        );
        if (
          newFrozenEvents.length === 0 &&
          tailHash === cursor.tailHash &&
          totalEventCount === cursor.pushedCount
        ) {
          await this.upsertMetadataIfChanged(
            auth,
            orgId,
            session,
            scopeKey,
            access
          );
          if (importedReplay && frozenChainHash !== cursor.frozenChainHash) {
            // Same content in an upgraded hash mode: converge the local
            // cursor (a checkpoint plus its merkle commitment) so the next
            // delta takes the bounded path — no network write is needed.
            // The downgrade direction deliberately keeps the cursor: a
            // still-valid checkpoint must survive a transiently failed probe.
            this.setCursor({ ...cursor, frozenChainHash, importedReplay });
          }
          markPreparedClean();
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
          await this.appendSessionBatches(
            auth,
            orgId,
            sessionId,
            cursor,
            frozenSegments,
            {
              events,
              perEventHashes,
              frozenHashMode,
              totalEventCount,
              frozenEventCount,
              localFrozenEventCount,
              frozenChainHash,
              tailEvents,
              tailHash,
              importedReplay,
            }
          );
          broadcastOrgControlChangedToPeers(orgId, "sessions");
          markPreparedClean();
          void this.publishTurnIndexBestEffort(
            auth,
            orgId,
            session,
            stampAtRead
          );
          return;
        } catch (error) {
          if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
          await this.rewriteSession(auth, orgId, session, scopeKey, access, {
            events,
            perEventHashes,
            frozenHashMode,
            totalEventCount,
            frozenEventCount,
            localFrozenEventCount,
            frozenChainHash,
            tailEvents,
            tailHash,
            importedReplay,
            newEpoch: null,
          });
          markPreparedClean();
          void this.publishTurnIndexBestEffort(
            auth,
            orgId,
            session,
            stampAtRead
          );
          return;
        }
      }

      await this.rewriteSession(auth, orgId, session, scopeKey, access, {
        events,
        perEventHashes,
        frozenHashMode,
        totalEventCount,
        frozenEventCount,
        localFrozenEventCount,
        frozenChainHash,
        tailEvents,
        tailHash,
        importedReplay,
        newEpoch: cursor.epoch + 1,
      });
      markPreparedClean();
      void this.publishTurnIndexBestEffort(auth, orgId, session, stampAtRead);
      return;
    }

    await this.rewriteSession(auth, orgId, session, scopeKey, access, {
      events,
      perEventHashes,
      frozenHashMode,
      totalEventCount,
      frozenEventCount,
      localFrozenEventCount,
      frozenChainHash,
      tailEvents,
      tailHash,
      importedReplay,
      newEpoch: 1,
    });
    markPreparedClean();
    void this.publishTurnIndexBestEffort(auth, orgId, session, stampAtRead);
  }

  /**
   * Best-effort 0012 turn-index publish, fired after every successful
   * events push (the index only ever changes together with events). Reads
   * the local per-round index, normalizes prompt previews, and uploads a
   * wholesale replacement for the cursor's epoch. Progressive enhancement
   * only: capability/endpoint gating lives in the client wrapper, the
   * in-memory hash gate dedups repeat passes, and every failure is logged
   * and swallowed — a push must never fail or retry-storm on this.
   */
  private async publishTurnIndexBestEffort(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    stampAtRead: number
  ): Promise<void> {
    const sessionId = session.session_id;
    try {
      const upsertTurnIndex = this.client.upsertSessionTurnIndex;
      if (!upsertTurnIndex) return;
      // The local turn index is read AFTER the events push and reflects the
      // LIVE store. If events landed since the pushed snapshot, the index
      // would advertise rounds whose bodies are not on the server yet
      // (phantom placeholders for every viewer); skip — the push those
      // events trigger republishes.
      if ((this.eventActivityStamps.get(sessionId) ?? 0) !== stampAtRead) {
        return;
      }
      // The cursor the push just committed carries the epoch this index
      // describes; without one there is nothing published to annotate.
      const cursor = this.getCursor(orgId, sessionId);
      if (!cursor) return;
      const summaries = await loadTurnIndex(sessionId);
      if (summaries.length === 0 || summaries.length > TURN_INDEX_MAX_ROUNDS) {
        return;
      }
      const turns: CloudSessionTurnSummary[] = summaries.map((turn) => ({
        turnId: turn.turnId,
        prompt: normalizeTurnPromptPreview(turn.userPreview),
        eventCount: Math.max(0, turn.eventCount),
        bodyEventCount: Math.max(0, turn.bodyEventCount),
        ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
        ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
        ...(turn.durationMs != null ? { durationMs: turn.durationMs } : {}),
        ...(turn.nextTurnId ? { nextTurnId: turn.nextTurnId } : {}),
      }));
      const key = `${orgId}:${sessionId}`;
      const hash = await sha256Hex(
        stableStringify({ epoch: cursor.epoch, turns })
      );
      if (this.lastPushedTurnIndexHashes.get(key) === hash) return;
      const published = await upsertTurnIndex(
        auth.accessToken,
        orgId,
        sessionId,
        cursor.epoch,
        turns
      );
      if (published) this.lastPushedTurnIndexHashes.set(key, hash);
    } catch (error) {
      log.warn(`turn-index publish skipped for ${sessionId}`, error);
    }
  }

  /**
   * One bounded append for a validated imported-history suffix. Large deltas
   * never enter this path: preparation falls back to the authoritative full
   * planner before any network mutation.
   */
  private async appendIncrementalSession(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    cursor: CollabSessionPushCursor,
    newFrozenEvents: SessionEvent[],
    plan: PreparedPushPlan
  ): Promise<void> {
    const frozenSegments = splitFrozenIntoSegments(
      newFrozenEvents,
      cursor.frozenSeq + 1
    );
    if (frozenSegments.length > IMPORTED_INCREMENTAL_SEGMENT_LIMIT) {
      throw new Error("Incremental imported replay exceeded its segment bound");
    }
    await this.client.appendSessionEvents(auth.accessToken, {
      orgId,
      sessionId,
      expectedEpoch: cursor.epoch,
      expectedFrozenSeq: cursor.frozenSeq,
      expectedTailHash: cursor.tailHash,
      newFrozenSegments: frozenSegments,
      tail: plan.tailEvents.length > 0 ? plan.tailEvents : null,
      totalCount: plan.totalEventCount,
    });
    this.setCursor({
      orgId,
      sessionId,
      epoch: cursor.epoch,
      frozenSeq: cursor.frozenSeq + frozenSegments.length,
      pushedCount: plan.totalEventCount,
      frozenEventCount: plan.frozenEventCount,
      frozenChainHash: plan.frozenChainHash,
      tailHash: plan.tailHash,
      ...(plan.importedReplay ? { importedReplay: plan.importedReplay } : {}),
    });
  }

  /**
   * Extend an established epoch in statement-timeout-safe batches. Every
   * acknowledged batch advances the durable cursor, so a transport failure or
   * app restart resumes after the last committed segment instead of reloading,
   * re-encoding, and re-uploading the complete transcript.
   */
  private async appendSessionBatches(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    initialCursor: CollabSessionPushCursor,
    frozenSegments: ReturnType<typeof splitFrozenIntoSegments>,
    plan: PreparedPushPlan & { events: SessionEvent[] }
  ): Promise<CollabSessionPushCursor> {
    let cursor = initialCursor;
    // An empty frozen delta still needs one append to replace the mutable tail
    // (or repair total_count), so model it as a single empty final batch.
    const batchCount = Math.max(
      1,
      Math.ceil(frozenSegments.length / SESSION_SEGMENT_UPLOAD_BATCH_SIZE)
    );
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const start = batchIndex * SESSION_SEGMENT_UPLOAD_BATCH_SIZE;
      const batch = frozenSegments.slice(
        start,
        start + SESSION_SEGMENT_UPLOAD_BATCH_SIZE
      );
      const finalBatch = batchIndex === batchCount - 1;
      const appendedEventCount = batch.reduce(
        (count, segment) => count + segment.events.length,
        0
      );
      const nextFrozenEventCount = cursor.frozenEventCount + appendedEventCount;
      const nextFrozenSeq = cursor.frozenSeq + batch.length;
      const nextChainHash =
        nextFrozenEventCount === plan.frozenEventCount
          ? plan.frozenChainHash
          : await this.computeFrozenHashAtCount(
              plan.perEventHashes,
              nextFrozenEventCount,
              plan.frozenHashMode
            );
      const nextTail = finalBatch ? plan.tailEvents : [];
      const nextTailHash = finalBatch ? plan.tailHash : null;
      const nextPushedCount = finalBatch
        ? plan.totalEventCount
        : nextFrozenEventCount;

      await this.client.appendSessionEvents(auth.accessToken, {
        orgId,
        sessionId,
        expectedEpoch: cursor.epoch,
        expectedFrozenSeq: cursor.frozenSeq,
        expectedTailHash: cursor.tailHash,
        newFrozenSegments: batch,
        tail: nextTail.length > 0 ? nextTail : null,
        totalCount: nextPushedCount,
      });
      cursor = {
        orgId,
        sessionId,
        epoch: cursor.epoch,
        frozenSeq: nextFrozenSeq,
        pushedCount: nextPushedCount,
        frozenEventCount: nextFrozenEventCount,
        frozenChainHash: nextChainHash,
        tailHash: nextTailHash,
        ...(finalBatch && plan.importedReplay
          ? { importedReplay: plan.importedReplay }
          : {}),
      };
      this.setCursor(cursor);
    }
    return cursor;
  }

  /** Full epoch rewrite; conflicts re-anchor on the current server epoch once. */
  private async rewriteSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    plan: PreparedPushPlan & {
      events: SessionEvent[];
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
        const progressive =
          frozenSegments.length > SESSION_SEGMENT_UPLOAD_BATCH_SIZE;
        const initialSegments = progressive
          ? frozenSegments.slice(0, SESSION_SEGMENT_UPLOAD_BATCH_SIZE)
          : frozenSegments;
        const initialFrozenEventCount = initialSegments.reduce(
          (count, segment) => count + segment.events.length,
          0
        );
        const initialChainHash =
          initialFrozenEventCount === plan.frozenEventCount
            ? plan.frozenChainHash
            : await this.computeFrozenHashAtCount(
                plan.perEventHashes,
                initialFrozenEventCount,
                plan.frozenHashMode
              );
        await this.client.rewriteSessionEvents(auth.accessToken, {
          orgId,
          sessionId,
          newEpoch: epoch,
          frozenSegments: initialSegments,
          tail:
            !progressive && plan.tailEvents.length > 0 ? plan.tailEvents : null,
          totalCount: progressive
            ? initialFrozenEventCount
            : plan.totalEventCount,
        });
        const cursor: CollabSessionPushCursor = {
          orgId,
          sessionId,
          epoch,
          frozenSeq: initialSegments.length,
          pushedCount: progressive
            ? initialFrozenEventCount
            : plan.totalEventCount,
          frozenEventCount: initialFrozenEventCount,
          frozenChainHash: initialChainHash,
          tailHash: progressive ? null : plan.tailHash,
          ...(!progressive && plan.importedReplay
            ? { importedReplay: plan.importedReplay }
            : {}),
        };
        this.setCursor(cursor);
        if (progressive) {
          await this.appendSessionBatches(
            auth,
            orgId,
            sessionId,
            cursor,
            frozenSegments.slice(initialSegments.length),
            plan
          );
        }
        broadcastOrgControlChangedToPeers(orgId, "sessions");
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
      sessionId,
      { afterSeq: HEAD_READ_AFTER_SEQ }
    );
    return snapshot.epoch ?? 0;
  }
}
