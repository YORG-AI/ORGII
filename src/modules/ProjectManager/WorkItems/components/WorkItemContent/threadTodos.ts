import type { TodoItem } from "@src/types/core/workItem";

export const THREAD_TODO_MAX_LENGTH = 120;

export function normalizeThreadTodos(
  todos: readonly TodoItem[] | null | undefined
): TodoItem[] {
  return (todos ?? [])
    .map((todo) => ({
      ...todo,
      content: todo.content.trim(),
    }))
    .filter((todo) => todo.content.length > 0);
}

export function createThreadTodo(
  content: string,
  now: number
): TodoItem | null {
  const normalized = content.trim().slice(0, THREAD_TODO_MAX_LENGTH);
  if (!normalized) return null;

  return {
    id: `todo-${now}`,
    content: normalized,
    status: "pending",
  };
}
