/**
 * Read/plan half of the session push plane: materializing a session's events
 * (authoritative full read, or a bounded imported-history suffix validated
 * against the cursor's checkpoint) and turning them into a `PreparedPushEvents`
 * whose lazy `plan()` computes hashes, the frozen line and the tail.
 *
 * Second link of the Org2CloudSessionSync inheritance chain
 * (state -> pushEvents -> turnIndex -> upload -> Org2CloudSessionSync); the
 * network-facing halves live further down.
 */
import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { rpc } from "@src/api/tauri/rpc";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { createLogger } from "@src/hooks/logger";
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
import {
  EVENT_HASH_CONCURRENCY,
  appendMerkleFrontier,
  buildMerkleFrontier,
  hashStringList,
  isValidMerkleFrontier,
  merkleFrontierCommitment,
} from "./org2CloudMerkleFrontier";
import { Org2CloudSessionSyncState } from "./org2CloudSessionSync.state";
import type {
  PreparedPushEvents,
  PreparedPushPlan,
} from "./org2CloudSessionSync.types";
import type {
  CollabSessionPushCursor,
  ImportedReplayCheckpoint,
} from "./org2CloudSyncAtoms";

const log = createLogger("Org2CloudSyncEngine");

const IMPORTED_INCREMENTAL_TURN_LIMIT = 50;
export const IMPORTED_INCREMENTAL_SEGMENT_LIMIT = 16;
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

export class Org2CloudSessionSyncPushEvents extends Org2CloudSessionSyncState {
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

  protected async computeFrozenHashAtCount(
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
  protected async frozenChainMatchesCursor(
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

  protected preparePushEventsForPass(
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
}
