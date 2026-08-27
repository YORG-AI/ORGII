/**
 * Streamed replay download for remote-session import.
 *
 * Both streamers persist bounded server pages straight to SQLite so a large
 * replay never materializes in WebView memory: `streamFresh…` rebuilds a copy
 * from page 1, `streamIncremental…` splices a delta onto an existing one.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";

import { rewriteEventsForImportedSnapshot } from "./collabImportIdentity";
import type { RemoteSessionFetchOptions } from "./collabRemoteFetch";
import { throwIfAborted, validateSegmentIntegrity } from "./collabRemoteFetch";

const log = createLogger("collabSyncEngineHelpers");

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
  /**
   * Pause capture: on an aborted fresh stream, receives the last PERSISTED
   * position (epoch / frozen seq / counts) so the caller can offer a resume
   * that continues past it. Persisted pages are deliberately NOT rolled back
   * on abort when this is provided. Never called when nothing durable was
   * written (the next start is a plain fresh stream).
   */
  onPauseState?: (state: {
    epoch: number;
    seq: number;
    count: number;
    frozenCount: number;
  }) => void;
  /**
   * Continue a previously paused fresh download: skip straight to the
   * incremental streamer with this cursor. Epoch drift or a persisted-count
   * mismatch degrades to a full fresh restream, so a stale cursor can never
   * corrupt the copy.
   */
  resumeCursor?: {
    epoch: number;
    seq: number;
    count: number;
    frozenCount: number;
  } | null;
}

export interface PersistedStreamSummary {
  epoch: number;
  frozenSeq: number;
  frozenCount: number;
  count: number;
  tailHash: string | null;
}

const STREAM_IMPORT_MAX_ATTEMPTS = 3;

function isReplayEpochConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error
      ? (error as Error & { code?: unknown }).code === "ORG2_CONFLICT"
      : error.message.includes("ORG2_CONFLICT"))
  );
}

/**
 * Fresh large imports never need the full replay in JS or Rust memory. Decode
 * one server page, validate it, namespace it, and upsert it directly into
 * SQLite. Only the initial turn window is hydrated after the final summary
 * reconciles. An epoch race clears the partial rows and restarts from page 1.
 */
export async function streamFreshRemoteSessionToCache(
  options: ImportRemoteSessionOptions,
  localSessionId: string
): Promise<PersistedStreamSummary | null> {
  const stream = options.client.streamSessionEventSegments;
  if (!stream) return null;

  for (let attempt = 0; attempt < STREAM_IMPORT_MAX_ATTEMPTS; attempt += 1) {
    let epoch: number | null = null;
    let expectedFrozenSeq = 0;
    let persistedCount = 0;
    let frozenCount = 0;
    let tailHash: string | null = null;
    // Pause bookkeeping: expectedFrozenSeq advances during page VALIDATION,
    // before the page persists — a resume cursor must only ever describe
    // rows that actually landed in SQLite.
    let lastPersistedFrozenSeq = 0;

    try {
      const summary = await stream(
        {
          orgId: options.orgId,
          sessionRowId: options.remoteSession.id,
          afterSeq: 0,
          ...(options.shareToken !== undefined
            ? { shareToken: options.shareToken }
            : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
        async (page) => {
          throwIfAborted(options.signal);
          if (page.epoch === null || page.count === null) return;
          if (epoch === null) {
            // First page with data: only now is it certain the owner still
            // publishes segments. Clearing here rather than at attempt
            // start lets an EXISTING local copy survive the unpublished
            // race (this path also serves full restreams of stale imports).
            await eventStoreProxy.clearPersistedHistory(localSessionId);
            epoch = page.epoch;
          } else if (page.epoch !== epoch) {
            throw new Error(
              "ORG2_CONFLICT session events epoch changed during streamed import"
            );
          }

          const frozen = page.segments
            .filter((segment) => !segment.isTail)
            .sort((a, b) => a.seq - b.seq);
          const tails = page.segments.filter((segment) => segment.isTail);
          if (tails.length > 1) {
            throw new Error("Replay page contained more than one tail");
          }
          for (const segment of [...frozen, ...tails]) {
            await validateSegmentIntegrity(segment);
          }
          for (const segment of frozen) {
            if (segment.seq !== expectedFrozenSeq + 1) {
              throw new Error("Replay page contained a frozen-segment gap");
            }
            expectedFrozenSeq = segment.seq;
          }

          const tail = tails[0] ?? null;
          const sourceEvents = [
            ...frozen.flatMap((segment) => segment.events),
            ...(tail?.events ?? []),
          ];
          const localEvents = rewriteEventsForImportedSnapshot(
            sourceEvents,
            localSessionId
          );
          if (localEvents.length > 0) {
            const savedCount = await eventStoreProxy.persistEventsBatch(
              localEvents,
              localSessionId
            );
            if (savedCount <= 0) {
              throw new Error(
                `Failed to persist streamed import ${options.remoteSession.sourceSessionId}`
              );
            }
          }
          persistedCount += localEvents.length;
          frozenCount += frozen.reduce(
            (count, segment) => count + segment.events.length,
            0
          );
          lastPersistedFrozenSeq = expectedFrozenSeq;
          if (tail) tailHash = tail.segmentHash;
          options.onProgress?.({
            loadedEvents: persistedCount,
            totalEvents: page.count,
          });
        }
      );

      if (summary.epoch === null || summary.count === null) {
        // No page carried data, so nothing was cleared or persisted — an
        // existing local copy is untouched.
        return null;
      }
      if (
        epoch !== summary.epoch ||
        expectedFrozenSeq !== (summary.frozenSeq ?? 0) ||
        persistedCount !== summary.count
      ) {
        throw new Error("Streamed replay summary did not reconcile");
      }
      throwIfAborted(options.signal);
      options.onProgress?.({
        loadedEvents: persistedCount,
        totalEvents: summary.count,
        phase: "finalizing",
      });
      const finalizedCount =
        await eventStoreProxy.finalizePersistedImport(localSessionId);
      if (finalizedCount !== summary.count) {
        throw new Error(
          `Streamed replay finalize count ${finalizedCount} did not match ${summary.count}`
        );
      }
      throwIfAborted(options.signal);
      const loaded = await eventStoreProxy.loadInitialTurnWindow(
        localSessionId,
        0
      );
      if (summary.count > 0 && loaded <= 0) {
        throw new Error("Failed to hydrate streamed replay turn window");
      }
      return {
        epoch: summary.epoch,
        frozenSeq: summary.frozenSeq ?? 0,
        frozenCount,
        count: persistedCount,
        tailHash: tailHash ?? summary.tailHash,
      };
    } catch (error) {
      if (options.signal?.aborted && options.onPauseState) {
        // Pause, not failure: keep the persisted pages and hand the caller
        // a cursor describing them. Nothing durable ⇒ no capture — the next
        // start is an ordinary fresh stream.
        if (epoch !== null && persistedCount > 0) {
          options.onPauseState({
            epoch,
            seq: lastPersistedFrozenSeq,
            count: persistedCount,
            frozenCount,
          });
        }
        throw error;
      }
      if (epoch !== null) {
        // Partial rows were written this attempt; drop them.
        await eventStoreProxy.clearPersistedHistory(localSessionId);
        await eventStoreProxy.clear(localSessionId).catch(() => undefined);
      }
      if (
        isReplayEpochConflict(error) &&
        attempt + 1 < STREAM_IMPORT_MAX_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Streamed replay import exhausted its retry budget");
}

/**
 * Incremental streamed refresh for an already-imported replay: fetch only
 * frozen segments past the cursor plus the current tail, upsert them into
 * the existing persisted rows (event ids are stable across tail freezes, so
 * re-sent tail events dedup in place), then republish. Returns null when the
 * delta cannot be applied cleanly — the caller restreams from scratch. The
 * finalize count check is the safety net: any drift (a tail rewritten in
 * place, legacy un-namespaced rows) surfaces as a count mismatch.
 */
export async function streamIncrementalRemoteSessionToCache(
  options: ImportRemoteSessionOptions,
  localSessionId: string,
  cursor: { epoch: number; seq: number; count: number; frozenCount: number }
): Promise<PersistedStreamSummary | null> {
  const stream = options.client.streamSessionEventSegments;
  if (!stream) return null;
  // Cheap probe (COUNT, no event load): the local store must hold exactly
  // what the cursor claims before a delta may be spliced onto it.
  const persistedCount =
    await eventStoreProxy.countPersistedEvents(localSessionId);
  if (persistedCount !== cursor.count) {
    log.info("incremental declined: persisted count diverged from cursor", {
      localSessionId,
      persistedCount,
      cursorCount: cursor.count,
    });
    return null;
  }

  let expectedFrozenSeq = cursor.seq;
  let appendedFrozenCount = 0;
  let appendedCount = 0;
  let tailHash: string | null = null;
  let lastPersistedFrozenSeq = cursor.seq;
  try {
    const summary = await stream(
      {
        orgId: options.orgId,
        sessionRowId: options.remoteSession.id,
        afterSeq: cursor.seq,
        ...(options.shareToken !== undefined
          ? { shareToken: options.shareToken }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      async (page) => {
        throwIfAborted(options.signal);
        if (page.epoch === null || page.count === null) return;
        if (page.epoch !== cursor.epoch) {
          throw new Error(
            "ORG2_CONFLICT session events epoch changed during incremental import"
          );
        }
        const frozen = page.segments
          .filter((segment) => !segment.isTail)
          .sort((a, b) => a.seq - b.seq);
        const tails = page.segments.filter((segment) => segment.isTail);
        if (tails.length > 1) {
          throw new Error("Replay page contained more than one tail");
        }
        for (const segment of [...frozen, ...tails]) {
          await validateSegmentIntegrity(segment);
        }
        for (const segment of frozen) {
          if (segment.seq !== expectedFrozenSeq + 1) {
            throw new Error("Replay page contained a frozen-segment gap");
          }
          expectedFrozenSeq = segment.seq;
        }
        const tail = tails[0] ?? null;
        const sourceEvents = [
          ...frozen.flatMap((segment) => segment.events),
          ...(tail?.events ?? []),
        ];
        const localEvents = rewriteEventsForImportedSnapshot(
          sourceEvents,
          localSessionId
        );
        if (localEvents.length > 0) {
          const savedCount = await eventStoreProxy.persistEventsBatch(
            localEvents,
            localSessionId
          );
          if (savedCount <= 0) {
            throw new Error(
              `Failed to persist incremental import ${options.remoteSession.sourceSessionId}`
            );
          }
        }
        appendedCount += localEvents.length;
        appendedFrozenCount += frozen.reduce(
          (count, segment) => count + segment.events.length,
          0
        );
        lastPersistedFrozenSeq = expectedFrozenSeq;
        if (tail) tailHash = tail.segmentHash;
        options.onProgress?.({
          // Approximate: overlap with the re-sent tail dedups on upsert.
          loadedEvents: Math.min(
            page.count,
            cursor.frozenCount + appendedCount
          ),
          totalEvents: page.count,
        });
      }
    );

    if (summary.epoch === null || summary.count === null) return null;
    if (summary.epoch !== cursor.epoch) {
      throw new Error("Incremental replay summary epoch did not match cursor");
    }
    if (expectedFrozenSeq !== (summary.frozenSeq ?? 0)) {
      throw new Error("Incremental replay summary did not reconcile");
    }
    throwIfAborted(options.signal);
    options.onProgress?.({
      loadedEvents: summary.count,
      totalEvents: summary.count,
      phase: "finalizing",
    });
    const finalizedCount =
      await eventStoreProxy.finalizePersistedImport(localSessionId);
    if (finalizedCount !== summary.count) {
      throw new Error(
        `Incremental replay finalize count ${finalizedCount} did not match ${summary.count}`
      );
    }
    throwIfAborted(options.signal);
    const loaded = await eventStoreProxy.loadInitialTurnWindow(
      localSessionId,
      0
    );
    if (summary.count > 0 && loaded <= 0) {
      throw new Error("Failed to hydrate incremental replay turn window");
    }
    return {
      epoch: summary.epoch,
      frozenSeq: summary.frozenSeq ?? 0,
      frozenCount: cursor.frozenCount + appendedFrozenCount,
      count: finalizedCount,
      tailHash: tailHash ?? summary.tailHash,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      // Pause capture for the incremental case. The tail upsert dedups
      // re-sent events, so the durable count is PROBED, not derived —
      // making the pause resumable instead of leaving unfinalized rows
      // for the next start's count probe to disown.
      if (options.onPauseState) {
        const persisted = await eventStoreProxy
          .countPersistedEvents(localSessionId)
          .catch(() => null);
        if (persisted !== null && persisted > 0) {
          options.onPauseState({
            epoch: cursor.epoch,
            seq: lastPersistedFrozenSeq,
            count: persisted,
            frozenCount: cursor.frozenCount + appendedFrozenCount,
          });
        }
      }
      throw error;
    }
    log.warn("incremental replay refresh failed; falling back to restream", {
      localSessionId,
      error,
    });
    return null;
  }
}
