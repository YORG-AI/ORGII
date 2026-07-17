/**
 * Todo / Task List Atoms
 *
 * Per-session todo storage. The underlying state is a Map keyed by
 * sessionId so the parent session's todos never mix with a subagent's
 * (or any other sibling session's) todos.
 *
 * The legacy "current session" atoms (`todosAtom`, `todosVisibleAtom`,
 * `todoStateAtom`) are derived off `workstationActiveSessionIdAtom` —
 * NOT the pipeline. They answer "what should the WorkStation chrome
 * (pin bar, todo UI) show?" and must stay anchored to the user's
 * persistent selection, not a transient pipeline claim from a kanban
 * detail panel showing some other session's chat.
 *
 * New callers that need a specific session should use
 * `todosForSessionAtom(sessionId)` or the explicit `*ForSessionAtom`
 * write atoms.
 */
import { atom } from "jotai";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";

import { preserveTodoContent } from "./todoMerge";

// ============================================
// Types
// ============================================

export interface TodoItem {
  id: string;
  content: string;
  /**
   * Present-continuous label shown while this todo is `in_progress`
   * (e.g. "Running tests" for a content of "Run tests"). Ported from
   * Claude Code V2 Task tools — see
   * `src-tauri/src/agent_core/core/tools/impls/coding/todo.rs`.
   * Optional: if missing, renderers fall back to `content`.
   */
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /**
   * Indices of tasks that must complete before this task can start.
   * Mirrors Claude Code Task V2 `blockedBy` field. Stored as 1-based
   * task indices (matching the Rust backend's `index` field).
   */
  blockedBy?: number[];
}

export interface TodoState {
  todos: TodoItem[];
  isUpdating: boolean;
  lastUpdatedAt: string | null;
  isVisible: boolean;
}

const EMPTY_TODO_STATE: TodoState = {
  todos: [],
  isUpdating: false,
  lastUpdatedAt: null,
  isVisible: false,
};

const EMPTY_TODOS: readonly TodoItem[] = Object.freeze([]);

function isTerminalTodoStatus(todo: TodoItem): boolean {
  const status = todo.status.toLowerCase();
  return status === "completed" || status === "cancelled";
}

export function getTodoBatchTitle(todos: readonly TodoItem[]): string {
  const activeTodo = todos.find(
    (todo) => todo.status.toLowerCase() === "in_progress"
  );
  const representativeTodo =
    activeTodo ?? todos.find((todo) => !isTerminalTodoStatus(todo)) ?? todos[0];

  if (!representativeTodo) return "";
  if (representativeTodo.status.toLowerCase() === "in_progress") {
    return representativeTodo.activeForm?.trim() || representativeTodo.content;
  }
  return representativeTodo.content;
}

// ============================================
// Per-session map
// ============================================

/**
 * Map of sessionId → TodoState. Subagents and parent sessions each own
 * their own slot; no global write ever affects another session's slot.
 */
export const sessionTodoMapAtom = atom<Map<string, TodoState>>(new Map());
sessionTodoMapAtom.debugLabel = "sessionTodoMapAtom";

// ============================================
// Derived read atoms (scoped by current active session)
// ============================================

/**
 * TodoState for the currently-active session. The old `todoStateAtom`
 * identifier is retained so internal code that reads "the session in
 * focus" (PlanTodoPill, subagent pinned previews, etc.)
 * keeps working unchanged.
 */
export const todoStateAtom = atom((get) => {
  const activeId = get(workstationActiveSessionIdAtom);
  if (!activeId) return EMPTY_TODO_STATE;
  return get(sessionTodoMapAtom).get(activeId) ?? EMPTY_TODO_STATE;
});
todoStateAtom.debugLabel = "todoStateAtom";

export const todosAtom = atom((get) => get(todoStateAtom).todos as TodoItem[]);
todosAtom.debugLabel = "todosAtom";

export const todosVisibleAtom = atom(
  (get) => get(todoStateAtom).todos.length > 0
);
todosVisibleAtom.debugLabel = "todosVisibleAtom";

/**
 * Read-only access to a specific session's todos. Returns a stable
 * empty array reference when the session has never had todos.
 */
export function getTodosForSession(
  map: Map<string, TodoState>,
  sessionId: string | null | undefined
): TodoItem[] {
  if (!sessionId) return EMPTY_TODOS as TodoItem[];
  return (map.get(sessionId) ?? EMPTY_TODO_STATE).todos;
}

// ============================================
// Session-scoped write atoms
// ============================================

export interface UpdateTodosPayload {
  sessionId: string;
  todos: TodoItem[];
  merge?: boolean;
  timestamp?: string;
}

/**
 * Replace or merge todos for a specific session's slot.
 */
export const updateTodosForSessionAtom = atom(
  null,
  (get, set, payload: UpdateTodosPayload) => {
    const { sessionId, todos: newTodos, merge = true, timestamp } = payload;
    if (!sessionId) return;

    const current = get(sessionTodoMapAtom);
    const prev = current.get(sessionId) ?? EMPTY_TODO_STATE;
    const reconciledNewTodos = preserveTodoContent(prev.todos, newTodos);

    let nextTodos: TodoItem[];
    if (merge && prev.todos.length > 0) {
      const todoMap = new Map(prev.todos.map((todo) => [todo.id, todo]));
      reconciledNewTodos.forEach((todo) => {
        todoMap.set(todo.id, todo);
      });
      nextTodos = Array.from(todoMap.values());
    } else {
      nextTodos = reconciledNewTodos;
    }

    const nextState: TodoState = {
      todos: nextTodos,
      isUpdating: false,
      lastUpdatedAt: timestamp || new Date().toISOString(),
      isVisible: nextTodos.length > 0,
    };

    const nextMap = new Map(current);
    nextMap.set(sessionId, nextState);
    set(sessionTodoMapAtom, nextMap);
  }
);

/**
 * Clear a specific session's todos slot.
 */
export const clearTodosForSessionAtom = atom(
  null,
  (get, set, sessionId: string | null | undefined) => {
    if (!sessionId) return;
    const current = get(sessionTodoMapAtom);
    if (!current.has(sessionId)) return;
    const nextMap = new Map(current);
    nextMap.delete(sessionId);
    set(sessionTodoMapAtom, nextMap);
  }
);
