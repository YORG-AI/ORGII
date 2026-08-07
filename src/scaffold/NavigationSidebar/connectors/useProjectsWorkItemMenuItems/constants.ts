import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import { LOAD_MORE_GROUP_PREFIX } from "../types";

export const PROJECTS_PROJECT_OVERVIEW_PREFIX = "projects-project-overview:";
export const PROJECTS_WORK_ITEM_PREFIX = "projects-work-item:";
export const PROJECTS_LINEAR_WORK_ITEM_PREFIX = "projects-linear-work-item:";
export const PROJECTS_LINEAR_LOAD_PREFIX = "projects-linear-load:";
export const PROJECTS_LOCAL_ORG_PREFIX = "projects-local-org:";
export const PROJECTS_LINEAR_ORG_PREFIX = "projects-linear-org:";
export const PROJECTS_WORK_ITEM_CREATE_PREFIX = `${PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID}:`;
export const PROJECTS_WORK_ITEM_GROUP_PREFIX = "projects-work-items:";
export const UNKNOWN_ORG_KEY = "__unknown_org__";
export const UNKNOWN_PROJECT_KEY = "__unknown_project__";

export const WORK_ITEM_STATUS_ORDER: readonly WorkItemStatus[] = [
  "in_progress",
  "in_review",
  "planned",
  "backlog",
  "completed",
  "cancelled",
  "duplicate",
];

export const WORK_ITEM_PRIORITY_ORDER: readonly WorkItemPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

export { LOAD_MORE_GROUP_PREFIX };
