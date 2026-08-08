/**
 * Shared constants for ProjectWorkItemsTabContent and its extracted sibling
 * modules (data loader, workspace-data hook). Extracted to keep the
 * tab-content component under the 600-line limit.
 */

export const STORY_WORK_ITEMS_VISIBLE_TABS = ["List", "Kanban"] as const;
export const WORKSPACE_ACTIVE_READ_BUCKET = "active";
export const WORKSPACE_COMPLETED_READ_BUCKET = "completed";
