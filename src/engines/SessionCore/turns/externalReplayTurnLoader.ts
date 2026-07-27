import {
  type ExternalReplayLimits,
  type ExternalReplayWindow,
  resolveExternalReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import {
  type Snapshot,
  eventStoreProxy,
} from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  getActiveExternalReplayLease,
  openExternalReplaySession,
  readExternalReplaySession,
} from "@src/engines/SessionCore/sync/externalReplayTransport";
import {
  captureExternalReplayTurnEpisode,
  externalReplayTurnIndexFromId,
  isCurrentExternalReplayTurnEpisode,
  mergeExternalReplayTurnWindow,
  previousExternalReplayTurnSliceStart,
  previousExternalReplayWindowStart,
  startExternalReplayTurnEpisode,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";

import type { SessionTurnLoader } from "./types";

const inFlightTurnLoads = new Map<
  string,
  Promise<ExternalReplayWindow | undefined>
>();
const EXTERNAL_REPLAY_TURN_SLICE_LIMITS = {
  maxTurns: 1,
  maxEvents: 200,
  maxIpcBytes: 4 * 1024 * 1024,
} as const;
const EXTERNAL_REPLAY_SCROLL_WINDOW_LIMITS = {
  maxTurns: 10,
  maxEvents: 200,
  maxIpcBytes: 4 * 1024 * 1024,
} as const;
const REPLAY_SNAPSHOT_VISIBLE_TIMEOUT_MS = 5_000;

function snapshotContainsEventIds(
  snapshot: Snapshot | null,
  eventIds: readonly string[]
): boolean {
  if (!snapshot) return false;
  if ("eventIndex" in snapshot) {
    return eventIds.every((eventId) =>
      Object.prototype.hasOwnProperty.call(snapshot.eventIndex, eventId)
    );
  }
  const visibleIds = new Set([
    ...snapshot.chatEvents.map((event) => event.id),
    ...snapshot.sortedSimulatorEvents.map((event) => event.id),
  ]);
  return eventIds.every((eventId) => visibleIds.has(eventId));
}

function createReplaySnapshotBarrier(
  sessionId: string,
  signal: AbortSignal | undefined
): {
  dispose: () => void;
  waitForEvents: (
    eventIds: readonly string[],
    isCurrent: () => boolean
  ) => Promise<void>;
} {
  let latestNotifiedSnapshot: Snapshot | null = null;
  let settled = false;
  let waiter:
    | {
        baselineContainsEvents: boolean;
        baselineVersion: number;
        eventIds: readonly string[];
        isCurrent: () => boolean;
        resolve: () => void;
      }
    | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const settleIfVisible = (snapshot: Snapshot | null): void => {
    if (!waiter || settled) return;
    if (!waiter.isCurrent() || signal?.aborted) {
      settled = true;
      waiter.resolve();
      return;
    }
    if (
      snapshotContainsEventIds(snapshot, waiter.eventIds) &&
      (waiter.baselineContainsEvents ||
        (snapshot?.version ?? -1) > waiter.baselineVersion)
    ) {
      settled = true;
      waiter.resolve();
    }
  };

  const unsubscribe = eventStoreProxy.subscribeSession(
    sessionId,
    (snapshot) => {
      latestNotifiedSnapshot = snapshot;
      settleIfVisible(snapshot);
    }
  );
  const baselineSnapshot =
    eventStoreProxy.getLatestSessionSnapshot(sessionId) ??
    latestNotifiedSnapshot;
  const abort = (): void => {
    if (!waiter || settled) return;
    settled = true;
    waiter.resolve();
  };
  signal?.addEventListener("abort", abort, { once: true });

  return {
    dispose() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    },
    waitForEvents(eventIds, isCurrent) {
      if (eventIds.length === 0 || !isCurrent() || signal?.aborted) {
        return Promise.resolve();
      }
      const baselineVersion = baselineSnapshot?.version ?? -1;
      const baselineContainsEvents = snapshotContainsEventIds(
        baselineSnapshot,
        eventIds
      );
      return new Promise<void>((resolve, reject) => {
        waiter = {
          baselineContainsEvents,
          baselineVersion,
          eventIds,
          isCurrent,
          resolve,
        };
        // The envelope may have arrived between the RPC resolving and this
        // waiter being installed. This read force-flushes any pending delta;
        // the membership/version checks make it a real publication barrier.
        settleIfVisible(
          eventStoreProxy.getLatestSessionSnapshot(sessionId) ??
            latestNotifiedSnapshot
        );
        if (settled) return;
        timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `Timed out waiting for bounded replay events to become visible for ${sessionId}`
            )
          );
        }, REPLAY_SNAPSHOT_VISIBLE_TIMEOUT_MS);
      });
    },
  };
}

async function loadExternalReplaySelection(
  sessionId: string,
  selection:
    | { turnId: string }
    | { turnIndex: number }
    | { beforeSequence: number },
  loadKey: string,
  limits: Required<ExternalReplayLimits>
): Promise<ExternalReplayWindow | undefined> {
  const lease = getActiveExternalReplayLease(sessionId);
  if (!lease) {
    throw new Error(`Missing foreground replay lease for ${sessionId}`);
  }
  const episode = captureExternalReplayTurnEpisode(sessionId);
  // A fast A → B → A switch creates a new renderer episode (and normally a
  // new foreground lease) for A. The old request may still be pending and
  // will correctly fail its guards, but the new episode must not reuse that
  // doomed Promise.
  const episodeLoadKey = `${loadKey}:lease:${lease.episodeId}:episode:${episode.id}`;
  const inFlight = inFlightTurnLoads.get(episodeLoadKey);
  if (inFlight) return inFlight;

  const expectedGeneration = episode.generation;
  const snapshotBarrier = createReplaySnapshotBarrier(sessionId, lease.signal);
  const work = readExternalReplaySession(lease, {
    ...selection,
    limits,
  })
    .then(async (window) => {
      if (!window) return;
      if (!isCurrentExternalReplayTurnEpisode(sessionId, episode)) return;
      if (
        getActiveExternalReplayLease(sessionId)?.episodeId !== lease.episodeId
      ) {
        return;
      }
      if (
        expectedGeneration !== null &&
        window.cursor.generation !== expectedGeneration
      ) {
        // `read_window` is bounded but it is not allowed to join two source
        // generations. Reopen replaces the Rust EventStore window and the
        // compact turn catalog atomically from the renderer's perspective.
        const resetEpisode = startExternalReplayTurnEpisode(sessionId);
        const resetWindow = await openExternalReplaySession(lease);
        if (
          !resetWindow ||
          !isCurrentExternalReplayTurnEpisode(sessionId, resetEpisode)
        ) {
          return;
        }
        mergeExternalReplayTurnWindow(sessionId, resetWindow);
        return resetWindow;
      }
      mergeExternalReplayTurnWindow(sessionId, window);
      await snapshotBarrier.waitForEvents(
        window.events.map((event) => event.id),
        () =>
          isCurrentExternalReplayTurnEpisode(sessionId, episode) &&
          getActiveExternalReplayLease(sessionId)?.episodeId === lease.episodeId
      );
      return window;
    })
    .finally(() => {
      snapshotBarrier.dispose();
      if (inFlightTurnLoads.get(episodeLoadKey) === work) {
        inFlightTurnLoads.delete(episodeLoadKey);
      }
    });

  inFlightTurnLoads.set(episodeLoadKey, work);
  return work;
}

/**
 * Extend non-paginated history by one bounded event slice.
 *
 * A single provider turn may contain thousands of tool events. Paging by the
 * previous turn id would skip the unread remainder of that large turn, so the
 * continuous scroller always resumes from the earliest resident sequence.
 */
export async function loadPreviousExternalReplayWindow(
  sessionId: string
): Promise<boolean> {
  if (!resolveExternalReplayTarget(sessionId)) return false;
  const beforeSequence = previousExternalReplayWindowStart(sessionId);
  if (beforeSequence === null) return false;
  const window = await loadExternalReplaySelection(
    sessionId,
    { beforeSequence },
    `${sessionId}:before:${beforeSequence}`,
    EXTERNAL_REPLAY_SCROLL_WINDOW_LIMITS
  );
  return (
    window?.windowStartSequence !== null &&
    window?.windowStartSequence !== undefined &&
    window.windowStartSequence < beforeSequence
  );
}

/** Continue the unread prefix of one selected paginated replay turn. */
export async function loadPreviousExternalReplayTurnSlice(
  sessionId: string,
  turnIndex: number
): Promise<void> {
  if (!resolveExternalReplayTarget(sessionId)) return;
  const beforeSequence = previousExternalReplayTurnSliceStart(
    sessionId,
    turnIndex
  );
  if (beforeSequence === null) return;
  await loadExternalReplaySelection(
    sessionId,
    { beforeSequence },
    `${sessionId}:turn:${turnIndex}:before:${beforeSequence}`,
    EXTERNAL_REPLAY_TURN_SLICE_LIMITS
  );
}

/**
 * Load one older turn through the foreground bounded-replay lease.
 *
 * `externalReplayReadWindow` applies the bounded body directly in Rust, so
 * there is no renderer-side ActivityChunk round trip. A generation change
 * triggers an authoritative bounded reopen; it never merges a page from the
 * replacement source into the previous generation's presentation catalog.
 */
export const externalReplayTurnLoader: SessionTurnLoader = {
  async loadTurnBodyIntoStore({ sessionId, turnId }) {
    if (!resolveExternalReplayTarget(sessionId)) return;

    const turnIndex = externalReplayTurnIndexFromId(turnId);
    const selection = turnIndex === null ? { turnId } : { turnIndex };
    await loadExternalReplaySelection(
      sessionId,
      selection,
      `${sessionId}:turn:${turnId}`,
      EXTERNAL_REPLAY_TURN_SLICE_LIMITS
    );
  },
};
