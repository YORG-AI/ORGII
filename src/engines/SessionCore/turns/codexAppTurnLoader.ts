import { codexAppTurnWindow } from "@src/api/tauri/externalHistory";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { isCodexAppSession } from "@src/util/session/sessionDispatch";

import type { SessionTurnLoader } from "./types";

export const codexAppTurnLoader: SessionTurnLoader = {
  async loadTurnBodyIntoStore({ sessionId, turnId }) {
    if (!isCodexAppSession(sessionId)) return;

    const turnWindow = await codexAppTurnWindow({ sessionId, turnId });
    if (!Array.isArray(turnWindow.chunks) || turnWindow.chunks.length === 0) {
      return;
    }
    const events = await processChunksRust(turnWindow.chunks, sessionId);
    if (events.length === 0) return;
    await eventStoreProxy.mergeEvents(events, sessionId);
  },
};
