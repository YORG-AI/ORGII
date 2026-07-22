import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { createLogger } from "@src/hooks/logger";
import type { CliSessionStatus } from "@src/types/session/session";

import { registerSessionTranscriptSource } from "../../nativeTranscriptReconcile";
import type { PostLoadResult } from "../../types";

const log = createLogger("CliAdapter");

interface StoredSession {
  status: string;
  errorMessage?: string | null;
  totalTokens?: number;
  /** 'chunks' (legacy DB transcript) or 'native' (CLI's own store). */
  transcriptSource?: string;
}

export async function postLoadCliSession(
  sessionId: string,
  signal: AbortSignal
): Promise<PostLoadResult> {
  const result: PostLoadResult = {};
  try {
    const storedSession = await tauriInvoke<StoredSession | null>(
      "cli_agent_status",
      { sessionId }
    );
    if (signal.aborted || !storedSession) return result;

    registerSessionTranscriptSource(sessionId, storedSession.transcriptSource);

    if (typeof storedSession.totalTokens === "number") {
      result.contextTokens = storedSession.totalTokens;
    }

    const status = storedSession.status as CliSessionStatus;
    if (status !== "idle") {
      result.runStatus = status;
      if (
        (status === "failed" || status === "error") &&
        storedSession.errorMessage
      ) {
        result.runError = storedSession.errorMessage;
      }
    }
  } catch (error) {
    log.warn("[CliAdapter] postLoad status fetch failed:", error);
  }
  return result;
}
