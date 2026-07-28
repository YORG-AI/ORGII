import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { createLogger } from "@src/hooks/logger";
import type { ActivityChunk } from "@src/types/session/session";

import {
  forgetTranscriptSignature,
  rememberTranscriptSignature,
} from "../externalHistoryTranscriptSignatures";
import type {
  AdapterSendInput,
  EventHandlerCallbacks,
  SessionAdapter,
  SessionEventHandler,
} from "../types";

const logger = createLogger("ExternalHistoryAdapter");
const EXTERNAL_HISTORY_INITIAL_CHUNK_LIMIT = 200;
const MAX_IN_FLIGHT_EXTERNAL_HISTORY_LOADS = 8;
const inFlightExternalHistoryLoads = new Map<string, Promise<SessionEvent[]>>();

interface ExternalHistorySessionAdapter extends SessionAdapter {
  loadHistoryFromObservedSignature(
    sessionId: string,
    signal: AbortSignal,
    observedSignature: string
  ): Promise<SessionEvent[]>;
}

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
  // A source-level window already contains lightweight headers/placeholders
  // for older turns. Slicing that response here would make those turns
  // unreachable even though their bodies are available through the turn
  // loader. Trust the source's bounded wire contract.
  if (options.supportsWindowedReplay !== undefined) {
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

async function readTranscriptSignature(
  source: NonNullable<ReturnType<typeof getImportedHistorySourceBySessionId>>,
  sessionId: string
): Promise<string | null> {
  if (!source.statTranscript) return null;
  try {
    const stat = await source.statTranscript(sessionId);
    return stat ? `${stat.mtimeMs}:${stat.sizeBytes}` : null;
  } catch {
    return null;
  }
}

function recordLoadedTranscriptSignature(
  sessionId: string,
  signatureBefore: string | null,
  signatureAfter: string | null
): void {
  if (signatureBefore && signatureBefore === signatureAfter) {
    // Seed the auto-refresh guard with the exact snapshot just rendered. The
    // old path left it empty, so the first 3–5 second tick parsed and
    // normalized the same (occasionally hundreds-of-MiB) transcript again.
    rememberTranscriptSignature(sessionId, signatureBefore);
  } else if (signatureBefore !== signatureAfter) {
    // The writer moved while this load was in flight. Keep the next cheap stat
    // eligible to refresh instead of claiming the newer snapshot was shown.
    forgetTranscriptSignature(sessionId);
  }
}

async function loadExternalHistorySnapshot(
  sessionId: string,
  observedSignature?: string
): Promise<SessionEvent[]> {
  const source = getImportedHistorySourceBySessionId(sessionId);
  if (!source) {
    logger.warn("No external history loader registered for session", sessionId);
    return [];
  }
  const signatureBefore =
    observedSignature ?? (await readTranscriptSignature(source, sessionId));
  const chunks = await source.loadPreviewChunks(sessionId);
  if (!Array.isArray(chunks) || chunks.length === 0) {
    const signatureAfter = await readTranscriptSignature(source, sessionId);
    recordLoadedTranscriptSignature(sessionId, signatureBefore, signatureAfter);
    return [];
  }
  const initialWindow = selectExternalHistoryInitialWindow(chunks, {
    supportsWindowedReplay: source.supportsWindowedReplay,
  });
  const events = await processChunksRust(initialWindow, sessionId);
  const signatureAfter = await readTranscriptSignature(source, sessionId);
  recordLoadedTranscriptSignature(sessionId, signatureBefore, signatureAfter);
  return events;
}

function getOrStartExternalHistoryLoad(
  sessionId: string,
  observedSignature?: string
): Promise<SessionEvent[]> {
  const existing = inFlightExternalHistoryLoads.get(sessionId);
  if (existing) return existing;

  const request = loadExternalHistorySnapshot(sessionId, observedSignature);
  if (
    inFlightExternalHistoryLoads.size < MAX_IN_FLIGHT_EXTERNAL_HISTORY_LOADS
  ) {
    inFlightExternalHistoryLoads.set(sessionId, request);
    void request.then(
      () => {
        if (inFlightExternalHistoryLoads.get(sessionId) === request) {
          inFlightExternalHistoryLoads.delete(sessionId);
        }
      },
      () => {
        if (inFlightExternalHistoryLoads.get(sessionId) === request) {
          inFlightExternalHistoryLoads.delete(sessionId);
        }
      }
    );
  }
  return request;
}

async function loadExternalHistory(
  sessionId: string,
  signal: AbortSignal,
  observedSignature?: string
): Promise<SessionEvent[]> {
  const events = await getOrStartExternalHistoryLoad(
    sessionId,
    observedSignature
  );
  return signal.aborted ? [] : events;
}

export const externalHistoryAdapter: ExternalHistorySessionAdapter = {
  category: "external_history",

  loadHistory: loadExternalHistory,

  loadHistoryFromObservedSignature: (sessionId, signal, observedSignature) =>
    loadExternalHistory(sessionId, signal, observedSignature),

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
