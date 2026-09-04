import type { HostedKeyActivityEvent } from "@src/api/http/session/hostedKey";
import type { ActivityChunk } from "@src/types/session/session";

/**
 * Convert HostedKeyActivityEvent to ActivityChunk
 *
 * Only converts events that contain actual activity data (chunks).
 * Events like session.status_changed, files.changed, etc. are metadata
 * events that don't contain renderable activity chunks.
 *
 * The WebSocket message is wrapped in HostedKeyActivityEvent.data, so chunk may be at:
 * - data.chunk (WS message has chunk at root)
 * - data.data.chunk (WS message has nested data.chunk)
 */
export function eventToChunk(
  event: HostedKeyActivityEvent
): ActivityChunk | null {
  const data = event.data || {};
  const nestedData = (data.data as Record<string, unknown>) || {};

  const chunk =
    (nestedData.chunk as Record<string, unknown>) ||
    (data.chunk as Record<string, unknown>) ||
    null;

  if (event.event_type === "session.activity" && chunk) {
    return chunk as unknown as ActivityChunk;
  }

  if (event.event_type === "agent.event") {
    return {
      chunk_id:
        event.event_id || (data.event_id as string) || crypto.randomUUID(),
      action_type: (data.event_type as string) || "unknown",
      function:
        (data.tool_name as string) || (data.event_type as string) || "unknown",
      args: (data.args as Record<string, unknown>) || {},
      result: (data.result as Record<string, unknown>) || data,
      created_at: event.created_at || (data.timestamp as string),
    };
  }

  const skipEventTypes = [
    "session.status_changed",
    "files.changed",
    "session.completed",
    "session.failed",
    "session.cancelled",
  ];

  if (skipEventTypes.includes(event.event_type)) {
    return null;
  }

  if (chunk) {
    return chunk as unknown as ActivityChunk;
  }

  return null;
}

/**
 * Detect "empty thinking end markers" — frames the agent emits to close
 * out a thinking stream when there was no incremental content.
 *
 * These frames carry no displayable text and the UI deliberately filters
 * them out, but they MUST also be filtered out of the persisted activity
 * buffer. Previously the UI path used an inline predicate to skip them
 * AFTER the event was already pushed into `eventBufferRef`, so the
 * server-side activity log accumulated phantom thinking frames the user
 * never saw. On next replay (e.g. session reload, cross-device sync)
 * the extra frames appeared in the client history as orphan empty
 * thinking blocks.
 *
 * Centralizing the predicate as a module-level pure function:
 *   - lets the buffer-push path and the UI dispatch path share the
 *     SAME definition (no drift),
 *   - allows unit testing without spinning up the hook or mocking
 *     React,
 *   - documents the contract once instead of scattering it across
 *     two callbacks.
 *
 * Returns `true` only when ALL of the following are true:
 *   1. The event maps to a chunk at all (`eventToChunk` non-null).
 *   2. The chunk's action type is one of the thinking variants
 *      (`llm_thinking` or `thinking`).
 *   3. The chunk is NOT a delta (`result.is_delta !== true`).
 *   4. The chunk has no thinking content in any of the recognized
 *      payload locations (`thought`, `content`, `observation`).
 *
 * Any failure to meet a condition → returns `false` (the event is
 * NOT a phantom and should be processed normally).
 */
export function isEmptyThinkingEndFrame(
  event: HostedKeyActivityEvent
): boolean {
  const chunk = eventToChunk(event);
  if (!chunk) return false;
  const isThinkingType =
    chunk.action_type === "llm_thinking" || chunk.action_type === "thinking";
  if (!isThinkingType) return false;
  const isDelta = chunk.result?.is_delta === true;
  if (isDelta) return false;
  const hasContent = Boolean(
    (chunk.result?.thought as string)?.trim() ||
    (chunk.result?.content as string)?.trim() ||
    (chunk.result?.observation as string)?.trim()
  );
  return !hasContent;
}
