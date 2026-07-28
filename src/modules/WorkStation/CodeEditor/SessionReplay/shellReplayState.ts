import type {
  SessionEvent,
  ShellReplayRef,
  ShellReplayState,
} from "@src/engines/SessionCore/core/types";

import type { ShellOperationEntry } from "./types";

const LEGACY_CURSOR_PREVIEW_MAX_BYTES = 32 * 1024;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function eventCallId(event: SessionEvent): string | undefined {
  if (event.callId) return event.callId;
  const argsCallId = event.args?.call_id ?? event.args?.callId;
  if (typeof argsCallId === "string" && argsCallId) return argsCallId;
  const resultCallId = event.result?.call_id ?? event.result?.callId;
  return typeof resultCallId === "string" && resultCallId
    ? resultCallId
    : undefined;
}

function sameReplayIdentity(
  left: ShellReplayRef | null | undefined,
  right: ShellReplayRef | null | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.sessionId === right.sessionId &&
    left.callId === right.callId
  );
}

function replayRefBelongsToEvent(
  ref: ShellReplayRef | null | undefined,
  event: SessionEvent
): ref is ShellReplayRef {
  if (!ref || ref.sessionId !== event.sessionId) return false;
  const callId = eventCallId(event);
  return !callId || ref.callId === callId;
}

function boundedLegacyCursorPreview(
  operation: ShellOperationEntry,
  cursor: SessionEvent | null | undefined,
  ref: ShellReplayRef | undefined
): string | undefined {
  if (
    !cursor ||
    !ref ||
    cursor.id === operation.event.id ||
    cursor.sessionId !== ref.sessionId ||
    eventCallId(cursor) !== ref.callId
  ) {
    return undefined;
  }

  // Only an immutable, separate cursor event's stream preview is time-safe.
  // Never substitute the imported final replay preview/result here: those are
  // mutable completion data and would reveal future output at an early cursor.
  const extractedStream =
    cursor.extracted?.kind === "shell"
      ? cursor.extracted.streamOutput
      : undefined;
  const raw =
    extractedStream ??
    (typeof cursor.args?.streamOutput === "string"
      ? cursor.args.streamOutput
      : typeof cursor.args?.stream_output === "string"
        ? cursor.args.stream_output
        : undefined);
  if (!raw) return undefined;

  const bytes = utf8Encoder.encode(raw);
  if (bytes.length <= LEGACY_CURSOR_PREVIEW_MAX_BYTES) return raw;
  let start = bytes.length - LEGACY_CURSOR_PREVIEW_MAX_BYTES;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return utf8Decoder.decode(bytes.subarray(start));
}

export function shellReplayRefFromEvent(
  event: SessionEvent
): ShellReplayRef | undefined {
  if (replayRefBelongsToEvent(event.shellReplay?.ref, event)) {
    return event.shellReplay.ref;
  }
  const callId = eventCallId(event);
  if (!event.sessionId || !callId) return undefined;
  return { sessionId: event.sessionId, callId, formatVersion: 1 };
}

function safelyCompletedBeforeCursor(
  state: ShellReplayState,
  cursor: SessionEvent | null | undefined
): boolean {
  if (!cursor || state.status === "running" || !state.completedAt) return false;
  const completedAtMs = Date.parse(state.completedAt);
  const cursorAtMs = Date.parse(cursor.createdAt);
  return (
    Number.isFinite(completedAtMs) &&
    Number.isFinite(cursorAtMs) &&
    completedAtMs <= cursorAtMs
  );
}

/**
 * Resolve visibility from the playback cursor, never from a mutable shell row.
 * The latest row is safe only at the live edge, or after its durable completion
 * timestamp is no later than the cursor event.
 */
export function resolveShellReplayStateForCursor(
  operation: ShellOperationEntry,
  cursor: SessionEvent | null | undefined,
  atLiveEdge: boolean
): ShellReplayState | undefined {
  const ref = operation.replayRef ?? shellReplayRefFromEvent(operation.event);
  if (!ref) return undefined;

  const latestState = operation.event.shellReplay;
  if (atLiveEdge && latestState && sameReplayIdentity(latestState.ref, ref)) {
    return latestState;
  }

  const cursorState = cursor?.shellReplayBookmarks?.[ref.callId];
  if (cursorState && sameReplayIdentity(cursorState.ref, ref)) {
    return cursorState;
  }

  if (!latestState || !sameReplayIdentity(latestState.ref, ref))
    return undefined;
  if (safelyCompletedBeforeCursor(latestState, cursor)) {
    return latestState;
  }
  return undefined;
}

export function bindShellOperationToCursor(
  operation: ShellOperationEntry | null,
  cursor: SessionEvent | null | undefined,
  atLiveEdge: boolean
): ShellOperationEntry | null {
  if (!operation) return null;
  const replayState = resolveShellReplayStateForCursor(
    operation,
    cursor,
    atLiveEdge
  );
  const selectedRef =
    operation.replayRef ?? shellReplayRefFromEvent(operation.event);
  const cursorState = selectedRef
    ? cursor?.shellReplayBookmarks?.[selectedRef.callId]
    : undefined;
  const operationHasReplayRef = replayRefBelongsToEvent(
    operation.replayRef,
    operation.event
  );
  const eventHasReplayState = Boolean(
    selectedRef &&
    replayRefBelongsToEvent(
      operation.event.shellReplay?.ref,
      operation.event
    ) &&
    sameReplayIdentity(operation.event.shellReplay?.ref, selectedRef)
  );
  const cursorHasReplayState = Boolean(
    selectedRef &&
    cursorState &&
    sameReplayIdentity(cursorState.ref, selectedRef)
  );
  const hasDurableReplayContract = Boolean(
    operationHasReplayRef || eventHasReplayState || cursorHasReplayState
  );
  const legacyCursorPreview = replayState
    ? undefined
    : boundedLegacyCursorPreview(operation, cursor, selectedRef);
  return {
    ...operation,
    replayRef: hasDurableReplayContract ? selectedRef : undefined,
    replayState,
    output: hasDurableReplayContract ? legacyCursorPreview : operation.output,
    streamOutput: hasDurableReplayContract ? undefined : operation.streamOutput,
    replayCursorEventId: cursor?.id,
  };
}
