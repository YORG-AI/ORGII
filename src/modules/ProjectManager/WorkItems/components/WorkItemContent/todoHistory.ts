interface TodoHistoryEntry {
  id: string;
  content: string;
  status: string;
}

type TodoHistoryTranslator = (
  key: string,
  options?: Record<string, unknown>
) => string;

/**
 * Converts persisted before/after checklist snapshots into user-facing,
 * item-level actions. Returning null deliberately keeps malformed legacy
 * snapshots on the generic field-change fallback.
 */
export function describeTodoHistoryChange(
  oldValue: unknown,
  newValue: unknown,
  t: TodoHistoryTranslator
): string[] | null {
  const previousTodos = parseTodoSnapshot(oldValue);
  const nextTodos = parseTodoSnapshot(newValue);
  if (!previousTodos || !nextTodos) return null;

  const previousById = uniqueTodosById(previousTodos);
  const nextById = uniqueTodosById(nextTodos);
  if (!previousById || !nextById) return null;

  const descriptions: string[] = [];

  for (const nextTodo of nextTodos) {
    const previousTodo = previousById.get(nextTodo.id);
    if (!previousTodo) {
      descriptions.push(
        t("workItems.activity.todoAdded", { todo: nextTodo.content })
      );
      continue;
    }

    if (previousTodo.content !== nextTodo.content) {
      descriptions.push(
        t("workItems.activity.todoRenamed", {
          from: previousTodo.content,
          to: nextTodo.content,
        })
      );
    }

    if (previousTodo.status !== nextTodo.status) {
      descriptions.push(describeTodoStatusChange(previousTodo, nextTodo, t));
    }
  }

  for (const previousTodo of previousTodos) {
    if (!nextById.has(previousTodo.id)) {
      descriptions.push(
        t("workItems.activity.todoRemoved", { todo: previousTodo.content })
      );
    }
  }

  return descriptions.length > 0 ? descriptions : null;
}

function describeTodoStatusChange(
  previousTodo: TodoHistoryEntry,
  nextTodo: TodoHistoryEntry,
  t: TodoHistoryTranslator
): string {
  const options = { todo: nextTodo.content };

  if (nextTodo.status === "completed") {
    return t("workItems.activity.todoCompleted", options);
  }
  if (previousTodo.status === "completed") {
    return t("workItems.activity.todoReopened", options);
  }
  if (nextTodo.status === "in_progress") {
    return t("workItems.activity.todoStarted", options);
  }
  if (nextTodo.status === "pending") {
    return t("workItems.activity.todoMarkedPending", options);
  }
  return t("workItems.activity.todoUpdated", options);
}

function parseTodoSnapshot(value: unknown): TodoHistoryEntry[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const todos: TodoHistoryEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.content !== "string" ||
      typeof record.status !== "string" ||
      record.id.length === 0 ||
      record.content.length === 0
    ) {
      return null;
    }
    todos.push({
      id: record.id,
      content: record.content,
      status: record.status,
    });
  }
  return todos;
}

function uniqueTodosById(
  todos: readonly TodoHistoryEntry[]
): Map<string, TodoHistoryEntry> | null {
  const byId = new Map<string, TodoHistoryEntry>();
  for (const todo of todos) {
    if (byId.has(todo.id)) return null;
    byId.set(todo.id, todo);
  }
  return byId;
}
