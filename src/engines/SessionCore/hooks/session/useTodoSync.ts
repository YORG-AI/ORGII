/**
 * useTodoSync Hook
 *
 * Syncs manage_todo events from session updates into the per-session
 * todo slot. Three data paths:
 *
 * 1. **Cold-start / session switch**: `getTodos(sessionId)` fetches
 *    persisted todos from the Rust SQLite backend.
 * 2. **Event store (live + replay)**: scans session events for the
 *    latest `manage_todo` tool event up to the current replay cursor.
 * 3. **IPC push (live)**: `agent:todos_updated` via
 *    `handleTodosUpdated` (eventHandlers/agentSpecific.ts).
 *
 * Mounted from `ChatView` so the sticky pin bar stays aligned with chat
 * blocks even when the IPC push is missed.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef } from "react";

import { getTodos } from "@src/api/tauri/agent";
import { currentEventAtom } from "@src/engines/SessionCore/core/atoms";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { simulatorEventsAtom } from "@src/engines/SessionCore/derived/simulatorEvents";
import { extractTodoData } from "@src/engines/SessionCore/rendering/props";
import { createLogger } from "@src/hooks/logger";
import { normalizeActivity } from "@src/lib/activityData";
import { isTodoEvent } from "@src/modules/WorkStation/Chat/Communication/utils";
import {
  type TodoItem,
  clearTodosForSessionAtom,
  getTodosForSession,
  sessionTodoMapAtom,
  updateTodosForSessionAtom,
} from "@src/store/ui/todoAtom";
import { preserveTodoContent } from "@src/store/ui/todoMerge";

import {
  type RawPersistedTodoItem,
  isExpectedTodoLoadRejection,
  normalizePersistedTodo as normalizePersistedTodoCore,
  normalizePersistedTodoList as normalizePersistedTodoListCore,
  sanitizeTodoDisplayText,
} from "./todoNormalization";

const log = createLogger("useTodoSync");

// ============================================
// Helper Functions
// ============================================

export function isManageTodoEvent(event: SessionEvent): boolean {
  const fn = event.functionName || "";
  const actionType = event.actionType || "";

  if (fn && isTodoEvent(fn)) return true;
  if (actionType && isTodoEvent(actionType)) return true;

  return false;
}

/**
 * Re-export the dependency-light normalisation helpers so the
 * existing consumers of `useTodoSync` (and its tests) don't have to
 * change their import paths. The actual implementations live in
 * `./todoNormalization` so they can be unit-tested without pulling
 * in jotai atoms (which require `localStorage`).
 */
export type { RawPersistedTodoItem };
export const normalizePersistedTodo = normalizePersistedTodoCore;
export const normalizePersistedTodoList = normalizePersistedTodoListCore;

function eventMatchesSession(event: SessionEvent, sessionId: string): boolean {
  const eventSid = event.sessionId;
  return !eventSid || eventSid === sessionId;
}

export function findLatestManageTodoEvent(
  events: readonly SessionEvent[],
  sessionId: string,
  maxIndex = events.length - 1
): SessionEvent | null {
  const limit = Math.min(maxIndex, events.length - 1);
  for (let index = limit; index >= 0; index--) {
    const event = events[index];
    if (!isManageTodoEvent(event)) continue;
    if (!eventMatchesSession(event, sessionId)) continue;
    return event;
  }
  return null;
}

export function serializeTodoSnapshot(todos: TodoItem[]): string {
  return JSON.stringify(
    todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      activeForm: todo.activeForm,
      status: todo.status,
      blockedBy: todo.blockedBy,
    }))
  );
}

function extractTodosFromEvent(event: SessionEvent): TodoItem[] {
  const normalized = normalizeActivity(
    event as unknown as Record<string, unknown>
  );

  const todoData = extractTodoData({
    eventId: event.id,
    eventType: "manage_todo",
    args: normalized.args,
    result: normalized.result,
    status: "success" as const,
    variant: "chat" as const,
    context: "chat" as const,
    rustExtracted: event.extracted,
  });

  return todoData.todos.map((todo, idx) => {
    const raw = todo as unknown as Record<string, unknown>;
    const activeForm =
      typeof raw.activeForm === "string" && raw.activeForm.length > 0
        ? (raw.activeForm as string)
        : undefined;
    const blockedBy = Array.isArray(raw.blockedBy)
      ? (raw.blockedBy as number[])
      : todo.blockedBy;
    return {
      id: todo.id || `event-todo-${idx}`,
      content: sanitizeTodoDisplayText(todo.content || ""),
      activeForm: activeForm ? sanitizeTodoDisplayText(activeForm) : undefined,
      status: (todo.status || "pending") as TodoItem["status"],
      ...(blockedBy && blockedBy.length > 0 ? { blockedBy } : {}),
    };
  });
}

function hasAuthoritativeEmptyTodoSnapshot(event: SessionEvent): boolean {
  return (
    event.displayStatus !== "running" &&
    event.extracted?.kind === "todo" &&
    event.extracted.todos.length === 0
  );
}

export function extractTodosFromManageTodoSequence(
  events: readonly SessionEvent[],
  sessionId: string,
  maxIndex = events.length - 1
): TodoItem[] {
  const limit = Math.min(maxIndex, events.length - 1);
  let todos: TodoItem[] = [];

  for (let index = 0; index <= limit; index++) {
    const event = events[index];
    if (!isManageTodoEvent(event)) continue;
    if (!eventMatchesSession(event, sessionId)) continue;

    const nextTodos = extractTodosFromEvent(event);
    if (nextTodos.length === 0) {
      if (hasAuthoritativeEmptyTodoSnapshot(event)) todos = [];
      continue;
    }
    todos = preserveTodoContent(todos, nextTodos);
  }

  return todos;
}

// ============================================
// Hook
// ============================================

export function useTodoSync(sessionId?: string): void {
  const simulatorEvents = useAtomValue(simulatorEventsAtom);
  const liveEvents = useAtomValue(eventsAtom);
  const pipelineSessionId = useAtomValue(sessionIdAtom);
  const currentEvent = useAtomValue(currentEventAtom);
  const updateTodosForSession = useSetAtom(updateTodosForSessionAtom);
  const clearTodosForSession = useSetAtom(clearTodosForSessionAtom);
  const store = useStore();

  const lastSessionIdRef = useRef<string | undefined>(sessionId);
  const lastProcessedTodoSnapshotRef = useRef<string | null>(null);

  // Clear todos on session change, then load persisted todos from backend
  useEffect(() => {
    if (sessionId !== lastSessionIdRef.current) {
      const prev = lastSessionIdRef.current;
      lastSessionIdRef.current = sessionId;
      lastProcessedTodoSnapshotRef.current = null;
      // Only clear when actually switching to a *different* session.
      // A transient undefined (panel remount / layout shuffle) must not
      // wipe the live slot — that caused the todo pill to flash 0 and
      // then "recover" via the async getTodos reload below.
      if (prev && sessionId && prev !== sessionId) clearTodosForSession(prev);
    }

    if (!sessionId) return;

    let cancelled = false;
    const currentSessionId = sessionId;

    getTodos(currentSessionId)
      .then((items) => {
        if (cancelled) return;
        if (currentSessionId !== lastSessionIdRef.current) return;
        // Cold-start restore only: if live `agent:todos_updated` pushes
        // already populated this slot while the fetch was in flight, the
        // persisted snapshot is staler than what's on screen — overwriting
        // would visibly regress the progress pill (e.g. 6/12 → 0/12).
        const liveTodos = getTodosForSession(
          store.get(sessionTodoMapAtom),
          currentSessionId
        );
        if (liveTodos.length > 0) return;
        const todos = normalizePersistedTodoList(items);
        if (todos.length === 0) return;
        updateTodosForSession({
          sessionId: currentSessionId,
          todos,
          merge: false,
        });
      })
      .catch((err) => {
        // Previously this catch was a complete no-op which masked
        // "todos never reload after refresh" bugs whenever the
        // Rust side returned an unexpected rejection (transport
        // error, schema mismatch, etc.). We now keep silent for
        // the *known* benign rejection — "session is not a coding
        // agent" — and warn loudly for everything else.
        if (cancelled) return;
        if (isExpectedTodoLoadRejection(err)) return;
        log.warn(
          `[useTodoSync] Failed to load persisted todos (session=${currentSessionId}):`,
          err
        );
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, clearTodosForSession, updateTodosForSession, store]);

  // Process todo events — find the latest manage_todo up to the replay cursor.
  // Prefer the full event store when it matches this surface's session so
  // merged tool_result payloads refresh the pin bar on the same tool_call id.
  useEffect(() => {
    if (!sessionId) return;
    if (pipelineSessionId && pipelineSessionId !== sessionId) return;

    const replayEvents =
      pipelineSessionId === sessionId && liveEvents.length > 0
        ? liveEvents
        : simulatorEvents;
    if (!replayEvents || replayEvents.length === 0) return;

    const currentEventId = currentEvent?.id ?? null;

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

    if (!latestTodoEvent) return;

    const todos = extractTodosFromManageTodoSequence(
      replayEvents,
      sessionId,
      maxIndex
    );
    const snapshot = serializeTodoSnapshot(todos);
    if (snapshot === lastProcessedTodoSnapshotRef.current) return;

    if (todos.length === 0) {
      clearTodosForSession(sessionId);
      lastProcessedTodoSnapshotRef.current = snapshot;
      return;
    }

    updateTodosForSession({
      sessionId,
      todos,
      merge: false,
      timestamp: latestTodoEvent.createdAt,
    });

    lastProcessedTodoSnapshotRef.current = snapshot;
  }, [
    sessionId,
    pipelineSessionId,
    liveEvents,
    simulatorEvents,
    currentEvent,
    updateTodosForSession,
    clearTodosForSession,
  ]);
}

export default useTodoSync;
