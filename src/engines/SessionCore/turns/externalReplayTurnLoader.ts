import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";
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
  startExternalReplayTurnEpisode,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";

import type { SessionTurnLoader } from "./types";

const inFlightTurnLoads = new Map<string, Promise<void>>();

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

    const lease = getActiveExternalReplayLease(sessionId);
    if (!lease) {
      throw new Error(`Missing foreground replay lease for ${sessionId}`);
    }

    const loadKey = `${sessionId}:${turnId}`;
    const inFlight = inFlightTurnLoads.get(loadKey);
    if (inFlight) return inFlight;

    const turnIndex = externalReplayTurnIndexFromId(turnId);
    const episode = captureExternalReplayTurnEpisode(sessionId);
    const expectedGeneration = episode.generation;
    const work = readExternalReplaySession(lease, {
      ...(turnIndex === null ? { turnId } : { turnIndex }),
      limits: { maxTurns: 1, maxEvents: 200, maxIpcBytes: 4 * 1024 * 1024 },
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
          return;
        }
        mergeExternalReplayTurnWindow(sessionId, window);
      })
      .finally(() => {
        if (inFlightTurnLoads.get(loadKey) === work) {
          inFlightTurnLoads.delete(loadKey);
        }
      });

    inFlightTurnLoads.set(loadKey, work);
    return work;
  },
};
