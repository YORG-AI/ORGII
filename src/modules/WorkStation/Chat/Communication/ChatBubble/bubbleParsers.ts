/** Pure todo helpers shared by the Communication chat bubbles. */
import type { ExtractedTodoData } from "@src/engines/SessionCore/rendering/types/universalProps";

export type CommunicationTodoItem = ExtractedTodoData["todos"][number];

export const normalizeTodoStatus = (status: string): string =>
  (status || "").toLowerCase();

export const isTodoCompleted = (status: string): boolean => {
  const statusNorm = normalizeTodoStatus(status);
  return statusNorm.includes("completed") || statusNorm === "completed";
};

export const isTodoInProgress = (status: string): boolean =>
  normalizeTodoStatus(status) === "in_progress";

export function renderCommunicationTodoLabel(
  todo: CommunicationTodoItem
): string {
  if (
    isTodoInProgress(todo.status) &&
    todo.activeForm &&
    todo.activeForm.trim()
  ) {
    return todo.activeForm;
  }
  return todo.content;
}

export function hasOpenCommunicationTodoBlockers(
  todo: CommunicationTodoItem,
  allTodos: CommunicationTodoItem[]
): boolean {
  if (!todo.blockedBy || todo.blockedBy.length === 0) return false;
  return todo.blockedBy.some((blockerIndex) => {
    const blocker = allTodos.find(
      (todoItem, index) =>
        index === blockerIndex || Number(todoItem.id) === blockerIndex
    );
    if (!blocker) return false;
    const statusNorm = normalizeTodoStatus(blocker.status);
    return statusNorm !== "completed" && statusNorm !== "cancelled";
  });
}

export function communicationTodoRowKey(todoId: string, index: number): string {
  return `communication-todo:${todoId || "missing"}:${index}`;
}
