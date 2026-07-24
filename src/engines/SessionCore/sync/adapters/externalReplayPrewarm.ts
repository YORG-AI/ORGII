/** Source-neutral prewarming on top of the bounded replay state. */
import {
  externalReplayPrewarmWindow,
  resolveExternalReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  captureExternalReplayTurnEpisode,
  isCurrentExternalReplayTurnEpisode,
  mergeExternalReplayTurnWindow,
  startExternalReplayTurnEpisode,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";

const inFlightLoads = new Map<string, Promise<void>>();

/**
 * Pre-warm a parent or nested Cursor composer without a full-bubble fallback.
 * Repeated and concurrent calls are coalesced; the Rust command owns the
 * EventStore write, so the bounded SessionEvent window crosses IPC only once.
 */
export async function ensureExternalReplayEventsInStore(
  sessionId: string,
  options?: { forceReload?: boolean }
): Promise<void> {
  if (!resolveExternalReplayTarget(sessionId)) return;
  if (!options?.forceReload) {
    const existing = eventStoreProxy.getLatestSessionSnapshot(sessionId);
    if (existing && existing.eventCount > 0) return;
  }

  const inFlight = inFlightLoads.get(sessionId);
  if (inFlight && !options?.forceReload) return inFlight;
  const episode = options?.forceReload
    ? startExternalReplayTurnEpisode(sessionId)
    : captureExternalReplayTurnEpisode(sessionId);
  const work: Promise<void> = externalReplayPrewarmWindow(sessionId, episode.id)
    .then((window) => {
      if (!isCurrentExternalReplayTurnEpisode(sessionId, episode)) return;
      mergeExternalReplayTurnWindow(sessionId, window);
    })
    .catch((error: unknown) => {
      // A newer prewarm may reach Rust before an older queued IPC request.
      // That old request is expected to fail its monotonic episode guard and
      // must not surface as a load error for the now-current session.
      if (!isCurrentExternalReplayTurnEpisode(sessionId, episode)) return;
      throw error;
    })
    .finally(() => {
      if (inFlightLoads.get(sessionId) === work) {
        inFlightLoads.delete(sessionId);
      }
    });
  inFlightLoads.set(sessionId, work);
  return work;
}
