import type { WorkItemPartialUpdate } from "@src/api/http/project";
import type { WorkItem } from "@src/types/core/workItem";

export type WorkItemUiPatch = Omit<
  Partial<WorkItem>,
  "assignee" | "milestone" | "endDate" | "target_date"
> & {
  assignee?: WorkItem["assignee"] | null;
  milestone?: WorkItem["milestone"] | null;
  endDate?: WorkItem["endDate"] | null;
  target_date?: WorkItem["target_date"] | null;
};

/**
 * Map a UI-shaped Work Item patch onto the canonical project-store payload.
 *
 * Shared by every Work Item surface so the Chat Panel and Team Inbox cannot
 * drift on which fields are persisted.
 */
export function toWorkItemPartialUpdate(
  updates: WorkItemUiPatch
): WorkItemPartialUpdate {
  const payload: WorkItemPartialUpdate = {};

  if (updates.name !== undefined) payload.title = updates.name;
  if (updates.spec !== undefined) payload.body = updates.spec;
  if (updates.workItemStatus !== undefined) {
    payload.status = updates.workItemStatus;
  }
  if (updates.priority !== undefined) payload.priority = updates.priority;
  if (updates.project?.id) payload.project = updates.project.id;
  if (updates.star !== undefined) payload.starred = updates.star;
  if ("assignee" in updates) payload.assignee = updates.assignee?.id ?? null;
  if ("assigneeType" in updates) {
    payload.assigneeType = updates.assigneeType ?? null;
  }
  if ("labels" in updates) {
    payload.labels = updates.labels?.map((label) => label.id) ?? [];
  }
  if ("milestone" in updates) {
    payload.milestone = updates.milestone?.id ?? null;
  }
  if ("startDate" in updates) payload.startDate = updates.startDate ?? null;
  if ("endDate" in updates) payload.targetDate = updates.endDate ?? null;
  if ("target_date" in updates) {
    payload.targetDate = updates.target_date ?? null;
  }
  if (updates.todos !== undefined) {
    payload.todos = updates.todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    }));
  }
  if (updates.comments !== undefined) {
    payload.comments = updates.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      created_at: comment.created_at,
    }));
  }
  if (updates.linkedSessions !== undefined) {
    payload.linkedSessions = updates.linkedSessions;
  }
  if (updates.orchestratorConfig !== undefined) {
    payload.orchestratorConfig = updates.orchestratorConfig;
  }
  if (updates.orchestratorState !== undefined) {
    payload.orchestratorState = updates.orchestratorState;
  }
  if (updates.schedule !== undefined) payload.schedule = updates.schedule;
  if (updates.executionLock !== undefined) {
    payload.executionLock = updates.executionLock;
  }
  if (updates.closeOut !== undefined) payload.closeOut = updates.closeOut;
  if (updates.workProducts !== undefined) {
    payload.workProducts = updates.workProducts;
  }

  return payload;
}
