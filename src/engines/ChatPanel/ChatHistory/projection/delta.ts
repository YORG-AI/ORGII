import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export interface AppendChatProjectionDelta {
  kind: "append";
  baseVersion: number;
  sourceVersion: number;
  appendedEvents: SessionEvent[];
}

export interface ReplaceChatProjectionDelta {
  kind: "replace";
  baseVersion: number;
  sourceVersion: number;
  upserts: SessionEvent[];
  removedIds: string[];
  eventIds: string[];
}

export type ChatProjectionDelta =
  | AppendChatProjectionDelta
  | ReplaceChatProjectionDelta;

/**
 * Build a projection delta from immutable EventStore snapshots.
 *
 * The snapshot materializer preserves object identity for unchanged events and
 * replaces the event object whenever any field changes. Comparing the complete
 * object reference is therefore both cheaper and safer than maintaining a
 * hand-written field signature, which can silently miss newly projection-
 * relevant fields such as `source`, `functionName`, `uiCanonical`, or nested
 * tool arguments/results.
 */
export function buildProjectionDelta(
  previous: readonly SessionEvent[],
  next: readonly SessionEvent[],
  baseVersion: number,
  sourceVersion: number
): ChatProjectionDelta {
  if (next.length >= previous.length) {
    let isPureAppend = true;
    for (let index = 0; index < previous.length; index++) {
      if (previous[index] !== next[index]) {
        isPureAppend = false;
        break;
      }
    }
    if (isPureAppend) {
      return {
        kind: "append",
        baseVersion,
        sourceVersion,
        appendedEvents: next.slice(previous.length),
      };
    }
  }

  const previousById = new Map(previous.map((event) => [event.id, event]));
  const nextIds = new Set(next.map((event) => event.id));
  const upserts: SessionEvent[] = [];
  for (const event of next) {
    const existing = previousById.get(event.id);
    if (existing !== event) upserts.push(event);
  }
  return {
    kind: "replace",
    baseVersion,
    sourceVersion,
    upserts,
    removedIds: previous
      .filter((event) => !nextIds.has(event.id))
      .map((event) => event.id),
    eventIds: next.map((event) => event.id),
  };
}
