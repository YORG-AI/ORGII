import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { createLogger } from "@src/hooks/logger";
import type { ActivityChunk } from "@src/types/session/session";

import type {
  AdapterSendInput,
  EventHandlerCallbacks,
  SessionAdapter,
  SessionEventHandler,
} from "../types";

const logger = createLogger("ExternalHistoryAdapter");
const EXTERNAL_HISTORY_INITIAL_CHUNK_LIMIT = 200;

function isUserMessageChunk(chunk: ActivityChunk): boolean {
  return (
    chunk.action_type === "raw" &&
    (chunk.function === "user_message" || chunk.function === "user")
  );
}

export function selectExternalHistoryInitialWindow(
  chunks: ActivityChunk[],
  options: { supportsWindowedReplay?: boolean } = {}
): ActivityChunk[] {
  if (options.supportsWindowedReplay === false) {
    return chunks;
  }

  if (chunks.length <= EXTERNAL_HISTORY_INITIAL_CHUNK_LIMIT) {
    return chunks;
  }

  let startIndex = Math.max(
    0,
    chunks.length - EXTERNAL_HISTORY_INITIAL_CHUNK_LIMIT
  );
  const tailStartIndex = startIndex;
  while (startIndex > 0 && !isUserMessageChunk(chunks[startIndex])) {
    startIndex -= 1;
  }
  if (!isUserMessageChunk(chunks[startIndex])) {
    startIndex = tailStartIndex;
  }

  return chunks.slice(startIndex);
}

function createNoopEventHandler(): SessionEventHandler {
  return {
    handleEvent(): void {},
    reset(): void {},
    get isStreaming() {
      return false;
    },
    dispose(): void {},
  };
}

async function loadExternalHistory(
  sessionId: string,
  signal: AbortSignal
): Promise<SessionEvent[]> {
  const source = getImportedHistorySourceBySessionId(sessionId);
  if (!source) {
    logger.warn("No external history loader registered for session", sessionId);
    return [];
  }
  const chunks = await source.loadPreviewChunks(sessionId);
  if (signal.aborted || !Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }
  const initialWindow = selectExternalHistoryInitialWindow(chunks, {
    supportsWindowedReplay: source.supportsWindowedReplay,
  });
  const events = await processChunksRust(initialWindow, sessionId);
  if (signal.aborted) return [];
  return events;
}

export const externalHistoryAdapter: SessionAdapter = {
  category: "external_history",

  loadHistory: loadExternalHistory,

  async postLoad() {
    return { runStatus: "completed" };
  },

  createEventHandler(
    _sessionId: string,
    _callbacks: EventHandlerCallbacks
  ): SessionEventHandler {
    return createNoopEventHandler();
  },

  async sendMessage(input: AdapterSendInput): Promise<void> {
    throw new Error(
      `External history sessions are read-only and cannot receive messages (${input.sessionId}).`
    );
  },

  async stopSession(): Promise<void> {},
};
