import type { SessionEvent } from "@src/engines/SessionCore/core/types";

/** Canonical clean user row published to the shared conversation plane. */
export function buildConversationPlaneUserEvent(input: {
  id: string;
  createdAt: string;
  displayText: string;
  turnIntentId: string;
}): SessionEvent {
  return {
    id: input.id,
    chunk_id: input.id,
    sessionId: "conversation",
    createdAt: input.createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: { content: input.displayText, role: "user" },
      turnIntentId: input.turnIntentId,
    },
    source: "user",
    displayText: input.displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

export function turnIntentIdOf(event: SessionEvent): string | null {
  if (event.source !== "user") return null;
  const intent = (event.result as { turnIntentId?: unknown } | undefined)
    ?.turnIntentId;
  return typeof intent === "string" && intent.length > 0 ? intent : null;
}

export function findUserEventByIntent(
  events: readonly SessionEvent[],
  turnIntentId: string
): SessionEvent | null {
  return events.find((event) => turnIntentIdOf(event) === turnIntentId) ?? null;
}

/**
 * Non-user events belonging to one exact runtime turn. Duplicate frontend
 * and backend user rows for the same intent are skipped; the next distinct
 * user intent closes the slice.
 */
export function sliceTurnTailByIntent(
  events: readonly SessionEvent[],
  turnIntentId: string
): SessionEvent[] | null {
  const start = events.findIndex(
    (event) => turnIntentIdOf(event) === turnIntentId
  );
  if (start < 0) return null;

  const tail: SessionEvent[] = [];
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.source === "user") {
      if (turnIntentIdOf(event) !== turnIntentId) break;
      continue;
    }
    tail.push(event);
  }
  return tail;
}
