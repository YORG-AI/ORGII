import type {
  WorkItemMutationActor,
  WorkItemPartialUpdate,
} from "@src/api/http/project";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

export type WorkItemUiPatch = Omit<
  Partial<WorkItem>,
  "assignee" | "milestone" | "project" | "endDate" | "target_date"
> & {
  assignee?: WorkItem["assignee"] | null;
  milestone?: WorkItem["milestone"] | null;
  project?: WorkItem["project"] | null;
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
  updates: WorkItemUiPatch,
  actor?: Pick<Person, "id" | "name"> | null
): WorkItemPartialUpdate {
  const payload: WorkItemPartialUpdate = {};

  if (updates.name !== undefined) payload.title = updates.name;
  if (updates.spec !== undefined) payload.body = updates.spec;
  if (updates.workItemStatus !== undefined) {
    payload.status = updates.workItemStatus;
  }
  if (updates.priority !== undefined) payload.priority = updates.priority;
  if ("project" in updates) payload.project = updates.project?.id ?? null;
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
      mentioned_user_ids: comment.mentioned_user_ids,
      parent_id: comment.parent_id,
      thread_id: comment.thread_id,
      resolved_at: comment.resolved_at,
      resolved_by: comment.resolved_by,
      conclusion: comment.conclusion,
      agent_session_id: comment.agent_session_id,
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

  return withWorkItemMutationActor(payload, actor);
}

export function withWorkItemMutationActor(
  payload: WorkItemPartialUpdate,
  actor?: Pick<Person, "id" | "name"> | null
): WorkItemPartialUpdate {
  const hasMutation = Object.keys(payload).some((field) => field !== "actor");
  if (!hasMutation || !actor) return payload;

  const id = actor.id.trim();
  const name = actor.name.trim();
  if (!id || !name) return payload;

  const normalizedActor: WorkItemMutationActor = { id, name };
  return { ...payload, actor: normalizedActor };
}
