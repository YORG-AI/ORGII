import React from "react";

import { getWorkItemStatusConfig } from "@src/modules/ProjectManager/config/manage";
import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { WORK_ITEM_PRIORITY_ORDER, WORK_ITEM_STATUS_ORDER } from "./constants";
import type { SidebarAnyWorkItem } from "./types";

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

export function statusIconElement(status: WorkItemStatus): React.ReactElement {
  const config = getWorkItemStatusConfig(status);
  return (
    <span
      className="inline-flex items-center leading-none"
      style={{ color: config.color }}
    >
      {config.icon}
    </span>
  );
}

export function sortWorkItemsByActivity<T extends SidebarAnyWorkItem>(
  workItems: readonly T[]
): T[] {
  return workItems.slice().sort((itemA, itemB) => {
    const getTime = (item: SidebarAnyWorkItem) =>
      item.source === "local"
        ? new Date(item.updatedAt || item.createdAt).getTime()
        : 0;
    return getTime(itemB) - getTime(itemA);
  });
}
