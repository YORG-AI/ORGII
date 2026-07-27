/**
 * Stream Handlers
 *
 * Handlers for message, thinking, and tool call delta events.
 * Also handles agent:streaming_complete from Rust StreamingBuffer.
 */
import { createLogger } from "@src/hooks/logger";

import {
  appendBoundedToolCallArgs,
  makeRoomForToolCallDelta,
  mergeStreamingText,
} from "../../shared/streamTextAccumulator";
import { capStreamContent } from "../../shared/subagentTracking";
import type { AgentWSEvent, StreamRefs } from "../../shared/types";
import {
  clearMessageStreamRefs,
  clearStreamingInfo,
  clearThinkingStreamRefs,
  getToolCallId,
  getToolName,
  updateStreamingInfo,
} from "./streamHelpers";
import type { EventHandlerContext } from "./types";

const log = createLogger("StreamHandlers");

function toolCallDeltaMessageId(toolCallId: string): string {
  return `tool-call-${toolCallId}`;
}

function appendLiveStreamDelta(
  refs: StreamRefs,
  delta: string,
  idPrefix: string,
  sessionId: string
): void {
  if (!refs.idRef.current) {
    refs.idRef.current = `${idPrefix}-${sessionId}-${Date.now()}`;
  }
  refs.contentRef.current = capStreamContent(
    mergeStreamingText(refs.contentRef.current, delta)
  );
}

export function handleMessageDelta(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  const delta = event.content || "";
  ctx.setStreaming(true);

  if (!delta) return;

  if (!ctx.assistantStreamRef || !ctx.thinkingStreamRef) {
    log.warn(
      "[streamHandlers] handleMessageDelta: StreamRefs missing, dropping delta"
    );
    return;
  }

  appendLiveStreamDelta(
    ctx.assistantStreamRef.current,
    delta,
    "stream-msg-live",
    sessionId
  );

  const streamRefs = ctx.assistantStreamRef.current;
  const rawAccumulated = streamRefs.contentRef.current;

  updateStreamingInfo(ctx, true, false, rawAccumulated);
}

export function handleThinkingDelta(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  const delta = event.content || "";
  ctx.setStreaming(true);

  if (!ctx.thinkingStreamRef) {
    log.warn(
      "[streamHandlers] handleThinkingDelta: thinkingStreamRef missing, dropping delta"
    );
    return;
  }

  appendLiveStreamDelta(
    ctx.thinkingStreamRef.current,
    delta,
    "stream-think-live",
    sessionId
  );
  const streamRefs = ctx.thinkingStreamRef.current;
  const accumulated = streamRefs.contentRef.current;
  updateStreamingInfo(ctx, true, true, accumulated);
}

/**
 * Accumulate a streamed tool_call fragment.
 *
 * Tool-call deltas are buffered in memory only. The durable `tool_call` row is
 * written by Rust when the call identity and payload are authoritative; token-
 * frequency deltas must never create EventStore rows.
 */
export function handleToolCallDelta(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  if (!ctx.features.hasToolCallDelta || !ctx.toolCallDeltaBuffersRef) return;

  const deltaIndex = event.index ?? 0;
  const argsDelta = event.argumentsDelta ?? "";
  const incomingId = getToolCallId(event);

  let buffer = ctx.toolCallDeltaBuffersRef.current.get(deltaIndex);
  const isNewBuffer = !buffer;
  if (!buffer) {
    makeRoomForToolCallDelta(ctx.toolCallDeltaBuffersRef.current, deltaIndex);
    buffer = {
      toolCallId: incomingId || undefined,
      toolName: getToolName(event),
      argsJson: "",
      messageId: incomingId ? toolCallDeltaMessageId(incomingId) : null,
    };
    ctx.toolCallDeltaBuffersRef.current.set(deltaIndex, buffer);

    clearMessageStreamRefs(ctx);
    clearThinkingStreamRefs(ctx);
    clearStreamingInfo(ctx);
    ctx.setStreaming(true);
  }

  if (incomingId) {
    if (!buffer.toolCallId) {
      buffer.toolCallId = incomingId;
      buffer.messageId = toolCallDeltaMessageId(incomingId);
    } else if (buffer.toolCallId !== incomingId) {
      log.warn(
        "[streamHandlers] tool_call_id drift within delta stream — ignoring",
        {
          index: deltaIndex,
          existingId: buffer.toolCallId,
          incomingId,
          sessionId,
        }
      );
      return;
    }
  } else if (isNewBuffer) {
    log.warn(
      "[streamHandlers] tool_call delta arrived without tool_call_id — buffering until id lands",
      { index: deltaIndex, sessionId }
    );
  }

  const toolName = getToolName(event);
  if (toolName !== "unknown") {
    buffer.toolName = toolName;
    if (buffer.toolCallId) {
      buffer.messageId = toolCallDeltaMessageId(buffer.toolCallId);
    }
  }
  buffer.argsJson = appendBoundedToolCallArgs(buffer.argsJson, argsDelta);

  if (!buffer.toolCallId || !buffer.messageId) {
    return;
  }

  // Tool-call deltas stay ephemeral; the authoritative tool_call event is written by Rust.
}

/**
 * Handle agent:streaming_complete from Rust StreamingBuffer.
 *
 * Rust Agent already pushed the authoritative completed stream event into the
 * backend EventStore before broadcasting this notification. The frontend must
 * not upsert/replace that event again; it only removes transient live-stream
 * placeholders so current-turn UI stops showing stale partial text.
 */
export async function handleStreamingComplete(
  event: AgentWSEvent,
  _sessionId: string,
  ctx: EventHandlerContext
): Promise<void> {
  const streamType = event.streamType as "message" | "thinking" | undefined;

  if (streamType === "message") {
    clearMessageStreamRefs(ctx);
    ctx.setStreaming(false);
    // `intermediate: true` — a per-message stream completion is NOT this
    // turn's terminal. Multi-step turns complete several message streams
    // before the real agent:complete / agent:turn_completed arrives, so this
    // must never feed the turn-lifecycle FSM.
    ctx.onStatusChangeRef.current?.("completed", undefined, {
      intermediate: true,
    });
    if (ctx.streamingCompleteHandledRef) {
      ctx.streamingCompleteHandledRef.current = true;
    }
    return;
  }

  if (streamType === "thinking") {
    clearThinkingStreamRefs(ctx);
    return;
  }

  log.warn("[streamHandlers] unknown streaming_complete stream type", {
    streamType,
  });
}
