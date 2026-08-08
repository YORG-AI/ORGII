import { cursorIdeTurnWindow } from "@src/api/tauri/externalHistory";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import type { SessionTurnLoader } from "./types";

const inFlightTurnLoads = new Map<string, Promise<boolean>>();

export const cursorIdeTurnLoader: SessionTurnLoader = {
  async loadTurnBodyIntoStore({ sessionId, turnId }) {
    if (!isCursorIdeSession(sessionId)) return false;

    const loadKey = `${sessionId}:${turnId}`;
    const inFlight = inFlightTurnLoads.get(loadKey);
    if (inFlight) return inFlight;

    const work = (async () => {
      try {
        const turnWindow = await cursorIdeTurnWindow({
          sessionId,
          userBubbleId: turnId,
        });
        const { chunks } = turnWindow;
        if (!Array.isArray(chunks) || chunks.length === 0) return false;
        const events = await processChunksRust(chunks, sessionId);
        if (events.length === 0) return false;
        await eventStoreProxy.mergeRoundWindowEvents(events, sessionId);
        return true;
      } finally {
        inFlightTurnLoads.delete(loadKey);
      }
    })();

    inFlightTurnLoads.set(loadKey, work);
    return work;
  },
};
