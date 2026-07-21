import type { WorkItemsViewTab } from "../../types";

export function supportsWorkItemStatusFilter(tab: WorkItemsViewTab): boolean {
  return tab === "List" || tab === "Kanban";
}

export function shouldShowWorkItemStatusFilter(
  tab: WorkItemsViewTab,
  statusFilter: string | undefined,
  hasChangeHandler: boolean
): boolean {
  return (
    supportsWorkItemStatusFilter(tab) &&
    Boolean(statusFilter) &&
    hasChangeHandler
  );
}

export function shouldShowCollapseAll(
  tab: WorkItemsViewTab,
  hasCollapseHandler: boolean
): boolean {
  return tab === "List" && hasCollapseHandler;
}
