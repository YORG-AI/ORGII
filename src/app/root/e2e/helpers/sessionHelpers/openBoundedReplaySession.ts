import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  type ExternalReplaySessionLease,
  activateExternalReplaySession,
  deactivateExternalReplaySession,
  openExternalReplaySession,
} from "@src/engines/SessionCore/sync/externalReplayTransport";
import {
  mergeExternalReplayTurnWindow,
  startExternalReplayTurnEpisode,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";

const OPEN_ATTEMPTS = 5;
const RETRY_DELAY_MS = 400;

export interface OpenedE2EBoundedReplaySession {
  events: SessionEvent[];
  lease: ExternalReplaySessionLease;
}

/**
 * Open the same foreground bounded-replay episode used by the product.
 *
 * This intentionally does not use the pure query/apply debug RPCs: the
 * foreground open owns EventStore application, watcher creation and request
 * epochs. The caller owns the returned lease and must deactivate it when the
 * E2E session is switched, reset or fails to finish opening.
 */
export async function openBoundedReplaySessionForE2E(
  sessionId: string
): Promise<OpenedE2EBoundedReplaySession | null> {
  if (!resolveExternalReplayTarget(sessionId)) return null;

  const lease = activateExternalReplaySession(sessionId);
  try {
    for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
      const replay = await openExternalReplaySession(lease);
      if (!replay) {
        throw new Error(
          `Bounded replay episode was superseded while opening ${sessionId}`
        );
      }

      startExternalReplayTurnEpisode(sessionId, replay.cursor.generation);
      mergeExternalReplayTurnWindow(sessionId, replay);

      // A newly launched managed CLI can temporarily have no native binding.
      // Rust deliberately preserves its live EventStore in that state.
      const events = replay.stats.notReady
        ? await eventStoreProxy.getEvents(sessionId)
        : replay.events;
      if (!replay.stats.notReady || events.length > 0) {
        return { events, lease };
      }

      if (attempt < OPEN_ATTEMPTS) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, RETRY_DELAY_MS)
        );
      } else {
        return { events, lease };
      }
    }

    return { events: [], lease };
  } catch (error) {
    deactivateExternalReplaySession(lease);
    throw error;
  }
}
