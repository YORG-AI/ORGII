import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { makeAssistantEvent, makeThinkingEvent } from "../shared/eventBuilders";

/** Build the live typewriter event while Rust accumulates final stream text. */
export function buildCliStreamingEvent(
  streamEventId: string,
  sessionId: string,
  content: string,
  kind: "message" | "thinking",
  createdAt: string
): SessionEvent {
  const isMessage = kind === "message";
  const baseEvent = isMessage
    ? makeAssistantEvent(streamEventId, sessionId, content, true)
    : makeThinkingEvent(streamEventId, sessionId, content, true);

  return {
    ...baseEvent,
    createdAt,
    result: isMessage
      ? { content, observation: content, role: "assistant", is_delta: true }
      : { thought: content, content, observation: content, is_delta: true },
  };
}
