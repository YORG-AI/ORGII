export interface TodoContentLike {
  id?: string;
  content?: string;
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
