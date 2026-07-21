import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export const TERMINAL_READ_ONLY_MAX_PREVIEW_BYTES = 32 * 1024;

export interface TerminalExecOutputDetail {
  sessionId: string;
  callId: string;
  chunk: string;
  stream: "stdout" | "stderr";
}

export interface TerminalHistoryPreview {
  key: string;
  command: string;
  output: string;
  exitCode?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function outputKey(sessionId: string, callId: string): string {
  return `${sessionId.length}:${sessionId}${callId}`;
}

/**
 * Keep only a valid UTF-8 tail. React and XtermOutput must never retain the
 * complete shell stream; the durable replay file is the source of truth.
 */
export function appendBoundedTerminalTail(
  previous: string,
  chunk: string,
  maxBytes = TERMINAL_READ_ONLY_MAX_PREVIEW_BYTES
): string {
  if (!chunk || maxBytes <= 0) return maxBytes <= 0 ? "" : previous;

  const previousBytes = encoder.encode(previous);
  const chunkBytes = encoder.encode(chunk);
  const combined = new Uint8Array(previousBytes.length + chunkBytes.length);
  combined.set(previousBytes);
  combined.set(chunkBytes, previousBytes.length);

  if (combined.length <= maxBytes) return previous + chunk;

  let start = combined.length - maxBytes;
  // A byte tail can begin in the middle of a multi-byte codepoint. Skip its
  // continuation bytes so TextDecoder never inserts a replacement character.
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return decoder.decode(combined.subarray(start));
}

export function execOutputKey(
  detail: Partial<TerminalExecOutputDetail> | null | undefined,
  expectedSessionId: string
): string | null {
  if (
    !detail ||
    detail.sessionId !== expectedSessionId ||
    typeof detail.callId !== "string" ||
    detail.callId.length === 0 ||
    typeof detail.chunk !== "string" ||
    (detail.stream !== "stdout" && detail.stream !== "stderr")
  ) {
    return null;
  }
  return outputKey(detail.sessionId, detail.callId);
}

/** Build a bounded history fallback without touching the old full result. */
export function historyPreviewFromEvent(
  event: SessionEvent
): TerminalHistoryPreview | null {
  const replay = event.shellReplay;
  if (!replay || replay.ref.sessionId !== event.sessionId) return null;

  const eventCallId = event.callId;
  if (eventCallId && eventCallId !== replay.ref.callId) return null;

  const command =
    event.command ||
    (typeof event.args?.command === "string" ? event.args.command : "");

  return {
    key: outputKey(replay.ref.sessionId, replay.ref.callId),
    command,
    output: appendBoundedTerminalTail("", replay.terminalPreview),
    exitCode: event.shellExitCode,
  };
}
