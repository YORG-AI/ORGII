import type {
  WorkItemFrontmatter,
  WorkItemPartialUpdate,
} from "@src/api/http/project";
import type { WorkItem } from "@src/types/core/workItem";

interface WorkItemNavigationState {
  index: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function getWorkItemNavigationState(
  workItems: WorkItem[],
  activeWorkItemId: string
): WorkItemNavigationState {
  const index = workItems.findIndex(
    (item) => item.session_id === activeWorkItemId
  );
  return {
    index,
    hasPrev: index > 0,
    hasNext: index >= 0 && index < workItems.length - 1,
  };
}

export function getAdjacentWorkItemId(
  workItems: WorkItem[],
  currentIndex: number,
  direction: "prev" | "next"
): string | null {
  const offset = direction === "prev" ? -1 : 1;
  return workItems[currentIndex + offset]?.session_id ?? null;
}

export function applyStandaloneWorkItemUpdates(
  frontmatter: WorkItemFrontmatter,
  updates: Partial<WorkItem>
): WorkItemFrontmatter {
  const next = { ...frontmatter };
  if (updates.name !== undefined) next.title = updates.name;
  if (updates.workItemStatus !== undefined) {
    next.status = updates.workItemStatus;
  }
  if (updates.priority !== undefined) next.priority = updates.priority;
  if (updates.star !== undefined) next.starred = updates.star;
  if ("assignee" in updates) next.assignee = updates.assignee?.id;
  if ("assigneeType" in updates) {
    next.assignee_type = updates.assigneeType;
  }
  if (updates.labels !== undefined) {
    next.labels = updates.labels.map((label) => label.id);
  }
  if ("milestone" in updates) {
    next.milestone = updates.milestone?.id;
  }
  if ("startDate" in updates) next.start_date = updates.startDate;
  if ("endDate" in updates) next.target_date = updates.endDate ?? undefined;
  if ("target_date" in updates) {
    next.target_date = updates.target_date ?? undefined;
  }
  if (updates.todos !== undefined) {
    next.todos = updates.todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    }));
  }
  if (updates.comments !== undefined) {
    next.comments = updates.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      created_at: comment.created_at,
    }));
  }
  if (updates.linkedSessions !== undefined) {
    next.linked_sessions = updates.linkedSessions;
  }
  if (updates.orchestratorConfig !== undefined) {
    next.orchestrator_config = updates.orchestratorConfig;
  }
  if (updates.orchestratorState !== undefined) {
    next.orchestrator_state = updates.orchestratorState;
  }
  if (updates.schedule !== undefined) {
    next.schedule = updates.schedule ?? undefined;
  }
  if (updates.executionLock !== undefined) {
    next.execution_lock = updates.executionLock;
  }
  if (updates.closeOut !== undefined) next.close_out = updates.closeOut;
  if (updates.workProducts !== undefined) {
    next.work_products = updates.workProducts;
  }
  next.updated_at = new Date().toISOString();
  return next;
}

/**
 * Map UI updates onto a `WorkItemPartialUpdate` for the atomic
 * partial-update command. Mirrors {@link applyStandaloneWorkItemUpdates}
 * field for field, but the read-modify-write happens inside the Rust
 * `BEGIN IMMEDIATE` transaction instead of client-side — a client-side
 * merge followed by a whole-row write can silently drop concurrent
 * edits (the lost-update race the store docs warn about).
 */
export function standaloneWorkItemUpdatesToPartial(
  updates: Partial<WorkItem>,
  body?: string
): WorkItemPartialUpdate {
  const partial: WorkItemPartialUpdate = {};
  if (updates.name !== undefined) partial.title = updates.name;
  if (body !== undefined) partial.body = body;
  if (updates.workItemStatus !== undefined) {
    partial.status = updates.workItemStatus;
  }
  if (updates.priority !== undefined) partial.priority = updates.priority;
  if (updates.star !== undefined) partial.starred = updates.star;
  if ("assignee" in updates) partial.assignee = updates.assignee?.id ?? null;
  if ("assigneeType" in updates) {
    partial.assigneeType = updates.assigneeType ?? null;
  }
  if (updates.labels !== undefined) {
    partial.labels = updates.labels.map((label) => label.id);
  }
  if ("milestone" in updates) {
    partial.milestone = updates.milestone?.id ?? null;
  }
  if ("startDate" in updates) partial.startDate = updates.startDate ?? null;
  if ("endDate" in updates) partial.targetDate = updates.endDate ?? null;
  if ("target_date" in updates) {
    partial.targetDate = updates.target_date ?? null;
  }
  if (updates.todos !== undefined) {
    partial.todos = updates.todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    }));
  }
  if (updates.comments !== undefined) {
    partial.comments = updates.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      created_at: comment.created_at,
    }));
  }
  if (updates.linkedSessions !== undefined) {
    partial.linkedSessions = updates.linkedSessions;
  }
  if (updates.orchestratorConfig !== undefined) {
    partial.orchestratorConfig = updates.orchestratorConfig;
  }
  if (updates.orchestratorState !== undefined) {
    partial.orchestratorState = updates.orchestratorState;
  }
  if (updates.schedule !== undefined) {
    partial.schedule = updates.schedule ?? null;
  }
  if (updates.executionLock !== undefined) {
    partial.executionLock = updates.executionLock ?? null;
  }
  if (updates.closeOut !== undefined) {
    partial.closeOut = updates.closeOut ?? null;
  }
  if (updates.workProducts !== undefined) {
    partial.workProducts = updates.workProducts;
  }
  return partial;
}
