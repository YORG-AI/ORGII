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
import { useSetAtom, useStore } from "jotai";
import { useEffect, useRef } from "react";

import { getTodos } from "@src/api/tauri/agent";
import { todoReplaySyncInputsAtom } from "@src/engines/SessionCore/derived/todoReplaySyncInputsAtom";
import { createLogger } from "@src/hooks/logger";
import {
  clearTodosForSessionAtom,
  getTodosForSession,
  sessionTodoMapAtom,
  updateTodosForSessionAtom,
} from "@src/store/ui/todoAtom";

import { syncTodosFromReplayEvents } from "./syncTodosFromReplayEvents";
import {
  type RawPersistedTodoItem,
  isExpectedTodoLoadRejection,
  normalizePersistedTodo as normalizePersistedTodoCore,
  normalizePersistedTodoList as normalizePersistedTodoListCore,
} from "./todoNormalization";

const log = createLogger("useTodoSync");

export {
  extractTodosFromManageTodoSequence,
  findLatestManageTodoEvent,
  isManageTodoEvent,
  serializeTodoSnapshot,
} from "./todoReplayDerivation";

/**
 * Re-export the dependency-light normalisation helpers so the
 * existing consumers of `useTodoSync` (and its tests) don't have to
 * change their import paths.
 */
export type { RawPersistedTodoItem };
export const normalizePersistedTodo = normalizePersistedTodoCore;
export const normalizePersistedTodoList = normalizePersistedTodoListCore;

export function useTodoSync(sessionId?: string): void {
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

  useEffect(() => {
    if (!sessionId) return;

    const syncFromEvents = () => {
      const activeSessionId = lastSessionIdRef.current;
      if (!activeSessionId) return;

      const inputs = store.get(todoReplaySyncInputsAtom);
      const result = syncTodosFromReplayEvents({
        sessionId: activeSessionId,
        pipelineSessionId: inputs.pipelineSessionId,
        liveEvents: inputs.liveEvents,
        simulatorEvents: inputs.simulatorEvents,
        currentEvent: inputs.currentEvent,
        lastSnapshot: lastProcessedTodoSnapshotRef.current,
      });
      if (!result) return;

      updateTodosForSession({
        sessionId: activeSessionId,
        todos: result.todos,
        merge: false,
        timestamp: result.timestamp,
      });
      lastProcessedTodoSnapshotRef.current = result.snapshot;
    };

    const unsubscribe = store.sub(todoReplaySyncInputsAtom, syncFromEvents);
    syncFromEvents();

    return unsubscribe;
  }, [sessionId, store, updateTodosForSession]);
}

export default useTodoSync;
