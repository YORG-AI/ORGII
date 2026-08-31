/**
 * Projects a Work Item edit made in the detail pane back onto the Inbox row
 * that surfaced it.
 *
 * Returns the replacement row, or `null` when the edit moved the item out of
 * the viewer's assignment scope and the row should disappear.
 */
import type { WorkItem } from "@src/types/core/workItem";

import type { AssignedWorkItem } from "./types";

export function reconcileWorkItemUpdate(
  sourceItem: AssignedWorkItem,
  workItem: WorkItem,
  viewerMemberIds: readonly string[]
): AssignedWorkItem | null {
  const assignee = workItem.assignee;
  const belongsToViewer = assignee
    ? viewerMemberIds.length > 0
      ? viewerMemberIds.includes(assignee.id)
      : assignee.id === sourceItem.payload.assigneeMemberId
    : false;
  const status =
    workItem.workItemStatus ?? workItem.status ?? sourceItem.payload.status;
  const updatedAt = workItem.updated_time || sourceItem.payload.updatedAt;
  return assignee && belongsToViewer
    ? {
        ...sourceItem,
        occurredAt: updatedAt,
        payload: {
          ...sourceItem.payload,
          title: workItem.name || sourceItem.payload.title,
          status,
          priority: workItem.priority ?? sourceItem.payload.priority,
          assigneeMemberId: assignee.id,
          assigneeName: assignee.name,
          summary: workItem.spec?.trim() || undefined,
          handoff: workItem.handoff,
          updatedAt,
        },
      }
    : null;
}
