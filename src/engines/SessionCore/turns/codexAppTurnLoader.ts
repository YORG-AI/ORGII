import { codexAppTurnWindow } from "@src/api/tauri/externalHistory";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { isCodexAppSession } from "@src/util/session/sessionDispatch";

import type { SessionTurnLoader } from "./types";

export const codexAppTurnLoader: SessionTurnLoader = {
  async loadTurnBodyIntoStore({ sessionId, turnId }) {
    if (!isCodexAppSession(sessionId)) return false;

    const turnWindow = await codexAppTurnWindow({ sessionId, turnId });
    if (!Array.isArray(turnWindow.chunks) || turnWindow.chunks.length === 0) {
      return false;
    }
    const events = await processChunksRust(turnWindow.chunks, sessionId);
    if (events.length === 0) return false;
    await eventStoreProxy.mergeRoundWindowEvents(events, sessionId);
    return true;
  },
};
