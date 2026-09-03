import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { WORK_ITEM_PRIORITY_ORDER, WORK_ITEM_STATUS_ORDER } from "./constants";

function isWorkItemStatus(status: string): status is WorkItemStatus {
  return WORK_ITEM_STATUS_ORDER.includes(status as WorkItemStatus);
}

export function toWorkItemStatus(status: string): WorkItemStatus {
  return isWorkItemStatus(status) ? status : "backlog";
}

function isWorkItemPriority(priority: string): priority is WorkItemPriority {
  return WORK_ITEM_PRIORITY_ORDER.includes(priority as WorkItemPriority);
}

export function toWorkItemPriority(priority: string): WorkItemPriority {
  return isWorkItemPriority(priority) ? priority : "none";
}
