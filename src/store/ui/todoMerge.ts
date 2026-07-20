export interface TodoContentLike {
  id?: string;
  content?: string;
  status?: string;
}

function meaningfulContent(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Preserve the last known non-empty title for a todo row when a later
 * incremental snapshot carries the same row with `content: ""`.
 */
export function preserveTodoContent<T extends TodoContentLike>(
  previousTodos: readonly TodoContentLike[],
  incomingTodos: readonly T[]
): T[] {
  if (previousTodos.length === 0 || incomingTodos.length === 0) {
    return [...incomingTodos];
  }

  const previousById = new Map<string, string>();
  previousTodos.forEach((todo) => {
    const content = meaningfulContent(todo.content);
    if (todo.id && content) {
      previousById.set(todo.id, content);
    }
  });

  return incomingTodos.map((todo, index) => {
    if (meaningfulContent(todo.content)) return todo;

    const previousContent =
      (todo.id ? previousById.get(todo.id) : undefined) ??
      meaningfulContent(previousTodos[index]?.content);
    if (!previousContent) return todo;

    return {
      ...todo,
      content: previousContent,
    };
  });
}

function isSameTodoBatch(
  eventTodos: readonly TodoContentLike[],
  currentTodos: readonly TodoContentLike[]
): boolean {
  if (eventTodos.length === 0 || eventTodos.length !== currentTodos.length) {
    return false;
  }

  return eventTodos.every((eventTodo, index) => {
    const currentTodo = currentTodos[index];
    if (!currentTodo) return false;

    const eventContent = meaningfulContent(eventTodo.content);
    const currentContent = meaningfulContent(currentTodo.content);
    if (eventContent && currentContent) return eventContent === currentContent;

    return Boolean(eventTodo.id && eventTodo.id === currentTodo.id);
  });
}

/**
 * Render an old manage_todo event with the latest status snapshot when both
 * lists describe the same batch. This keeps a 1/4 write card live as later
 * update calls complete rows, without rewriting unrelated historical batches.
 */
export function reconcileTodoSnapshot<T extends TodoContentLike>(
  eventTodos: readonly T[],
  currentTodos: readonly T[]
): T[] {
  const eventWithTitles = preserveTodoContent(currentTodos, eventTodos);
  if (!isSameTodoBatch(eventWithTitles, currentTodos)) {
    return eventWithTitles;
  }

  return preserveTodoContent(eventWithTitles, currentTodos);
}
