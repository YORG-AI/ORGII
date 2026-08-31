import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { TodoItem } from "@src/store/ui/todoAtom";

import {
  extractTodosFromManageTodoSequence,
  findLatestManageTodoEvent,
  serializeTodoSnapshot,
} from "./todoReplayDerivation";

export interface SyncTodosFromReplayEventsInput {
  sessionId: string;
  pipelineSessionId: string | null | undefined;
  liveEvents: readonly SessionEvent[];
  simulatorEvents: readonly SessionEvent[];
  currentEvent: SessionEvent | null;
  lastSnapshot: string | null;
}

export interface SyncTodosFromReplayEventsResult {
  todos: TodoItem[];
  timestamp: string;
  snapshot: string;
}

/**
 * Derive the todo pin-bar snapshot from replay/live events up to the current
 * cursor. Returns `null` when there is nothing new to write (empty events,
 * pipeline mismatch, or unchanged snapshot).
 *
 * Live composer sync (`liveEvents`) always reads the latest manage_todo state
 * and ignores the global replay cursor — simulator scrubbing shares
 * `currentEventAtom` but must not reshape the sticky pin bar in ChatView.
 */
export function syncTodosFromReplayEvents(
  input: SyncTodosFromReplayEventsInput
): SyncTodosFromReplayEventsResult | null {
  const {
    sessionId,
    pipelineSessionId,
    liveEvents,
    simulatorEvents,
    currentEvent,
    lastSnapshot,
  } = input;

  if (!pipelineSessionId || pipelineSessionId !== sessionId) {
    return null;
  }

  const useLiveEvents = liveEvents.length > 0;
  const replayEvents = useLiveEvents ? liveEvents : simulatorEvents;
  if (replayEvents.length === 0) {
    return null;
  }

  const currentEventId = useLiveEvents ? null : (currentEvent?.id ?? null);

  let maxIndex = replayEvents.length - 1;
  if (currentEventId) {
    const currentIndex = replayEvents.findIndex(
      (event) => event.id === currentEventId
    );
    if (currentIndex !== -1) {
      maxIndex = currentIndex;
    }
  }

  const latestTodoEvent = findLatestManageTodoEvent(
    replayEvents,
    sessionId,
    maxIndex
  );
  if (!latestTodoEvent) {
    return null;
  }

  const todos = extractTodosFromManageTodoSequence(
    replayEvents,
    sessionId,
    maxIndex
  );
  if (todos.length === 0) {
    return null;
  }

  const snapshot = serializeTodoSnapshot(todos);
  if (snapshot === lastSnapshot) {
    return null;
  }

  return {
    todos,
    timestamp: latestTodoEvent.createdAt,
    snapshot,
  };
}
