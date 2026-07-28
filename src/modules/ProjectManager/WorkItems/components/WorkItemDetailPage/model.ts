import type { WorkItemFrontmatter } from "@src/api/http/project";
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
  if ("endDate" in updates) next.target_date = updates.endDate ?? undefined;
  return next;
}
