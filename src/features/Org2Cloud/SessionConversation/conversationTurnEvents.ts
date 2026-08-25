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

/**
 * Slice one newly appended native-transcript turn from two authoritative
 * snapshots. External CLIs own their transcript schema and therefore cannot
 * persist ORG2's internal turnIntentId. Their stable normalized event ids are
 * the boundary instead: the old snapshot must remain an exact prefix, then
 * the first appended user row anchors the new agent tail.
 *
 * `null` fails closed when history was rewritten or no user boundary exists;
 * publishing from an ambiguous offset could duplicate an older agent turn.
 */
export function sliceAppendedTurnTail(
  before: readonly SessionEvent[],
  after: readonly SessionEvent[]
): SessionEvent[] | null {
  if (after.length < before.length) return null;
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const current = after[index];
    if (
      previous.id !== current.id ||
      previous.chunk_id !== current.chunk_id ||
      previous.source !== current.source
    ) {
      return null;
    }
  }

  const appended = after.slice(before.length);
  const userIndex = appended.findIndex((event) => event.source === "user");
  if (userIndex < 0) return null;

  const tail: SessionEvent[] = [];
  for (let index = userIndex + 1; index < appended.length; index += 1) {
    const event = appended[index];
    if (event.source === "user") break;
    tail.push(event);
  }
  return tail;
}
