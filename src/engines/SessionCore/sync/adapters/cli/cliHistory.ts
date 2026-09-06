import { convertFileSrc } from "@tauri-apps/api/core";

import { rpc } from "@src/api/tauri/rpc";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { createLogger } from "@src/hooks/logger";
import type {
  ActivityChunk,
  CliSessionStatus,
} from "@src/types/session/session";

import type { PostLoadResult } from "../../types";

const log = createLogger("CliAdapter");

interface StoredSession {
  status: string;
  errorMessage?: string | null;
  totalTokens?: number;
  /** 'chunks' (legacy DB transcript) or 'native' (CLI's own store). */
  transcriptSource?: string;
}

function convertResultImages(event: SessionEvent): SessionEvent {
  const result = event.result as Record<string, unknown> | undefined;
  if (!result?.images || !Array.isArray(result.images)) return event;
  const converted = (result.images as string[]).map((imgRef) =>
    imgRef.startsWith("data:") ? imgRef : convertFileSrc(imgRef)
  );
  return { ...event, result: { ...result, images: converted } };
}

export async function loadCliHistory(
  sessionId: string,
  signal: AbortSignal
): Promise<SessionEvent[]> {
  const chunks = (await rpc.cli.chunks({ sessionId })) as ActivityChunk[];
  if (signal.aborted || !Array.isArray(chunks)) return [];
  const events = await processChunksRust(chunks, sessionId);
  if (signal.aborted) return [];
  return events.map(convertResultImages);
}

/**
 * Read the provider file set's opaque revision through the same Rust binding
 * that owns CLI transcript replay. `undefined` means this is a legacy DB
 * transcript; `null` means a native transcript is currently
 * unbound/unavailable and must not be cached as a stable canonical snapshot.
 */
export async function loadCliTranscriptRevision(
  sessionId: string
): Promise<string | null | undefined> {
  const result = await rpc.cli.transcriptRevision({ sessionId });
  if (!result.native) return undefined;
  return result.revision ?? null;
}

export async function postLoadCliSession(
  sessionId: string,
  signal: AbortSignal
): Promise<PostLoadResult> {
  const result: PostLoadResult = {};
  try {
    const storedSession = (await rpc.cli.status({
      sessionId,
    })) as StoredSession | null;
    if (signal.aborted || !storedSession) return result;

    if (storedSession.transcriptSource) {
      result.transcriptSource = storedSession.transcriptSource;
    }

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
