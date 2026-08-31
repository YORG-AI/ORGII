import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { extractTodoData } from "@src/engines/SessionCore/rendering/props";
import { normalizeActivity } from "@src/lib/activityData";
import { isTodoEvent } from "@src/modules/WorkStation/Chat/Communication/utils";
import type { TodoItem } from "@src/store/ui/todoAtom";
import { preserveTodoContent } from "@src/store/ui/todoMerge";

import { sanitizeTodoDisplayText } from "./todoNormalization";

export function isManageTodoEvent(event: SessionEvent): boolean {
  const fn = event.functionName || "";
  const actionType = event.actionType || "";

  if (fn && isTodoEvent(fn)) return true;
  if (actionType && isTodoEvent(actionType)) return true;

  return false;
}

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
    if (nextTodos.length === 0) continue;
    todos = preserveTodoContent(todos, nextTodos);
  }

  return todos;
}
