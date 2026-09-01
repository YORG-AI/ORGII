/**
 * Local types for WorkItem page
 */
import type { MemberEntry } from "@src/api/http/project";
import {
  WORK_ITEM_STATUS,
  type WorkItemStatus,
} from "@src/types/core/workItem";

// ============================================
// Activity Types
// ============================================

export type ActivityType =
  | "created"
  | "moved"
  | "commented"
  | "updated"
  | "assigned"
  | "unassigned"
  | "labeled"
  | "unlabeled";

// ============================================
// View Types
// ============================================

export type WorkItemsViewTab =
  | "List"
  | "Kanban"
  | "Gantt"
  | "Calendar"
  | "Overview"
  | "Settings";

export type StatusFilterType =
  | "all"
  | "backlog"
  | "todo"
  | "inProgress"
  | "inReview"
  | "done"
  | "cancelled"
  | "duplicate"
  | "open"
  | "closed";

/** Pre-computed status counts used by work-item filters and summaries. */
export interface StatusCounts {
  all: number;
  backlog: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
  cancelled: number;
  duplicate: number;
  open: number;
  closed: number;
  [key: string]: number;
}

// ============================================
// Filter Mapping
// ============================================

export const FILTER_TO_STATUS: Record<StatusFilterType, WorkItemStatus | null> =
  {
    all: null,
    backlog: "backlog",
    todo: "planned",
    inProgress: "in_progress",
    inReview: "in_review",
    done: "completed",
    cancelled: "cancelled",
    duplicate: "duplicate",
    open: WORK_ITEM_STATUS.GITHUB_OPEN,
    closed: WORK_ITEM_STATUS.GITHUB_CLOSED,
  };

export const WORK_ITEMS_DEFAULT_STATUS: WorkItemStatus =
  WORK_ITEM_STATUS.PLANNED;

export const STATUS_FILTER_KEYS: StatusFilterType[] = [
  "all",
  "todo",
  "inProgress",
  "inReview",
  "done",
  "backlog",
  "cancelled",
  "duplicate",
];

export const GITHUB_ISSUE_STATUS_FILTER_KEYS: StatusFilterType[] = [
  "all",
  "open",
  "closed",
];

// ============================================
// Assignment Change Detection Types
// ============================================

/** Describes a single assignee change detected after a sync/pull */
export interface AssignmentChange {
  workItemId: string;
  workItemTitle: string;
  shortId: string;
  projectSlug: string;
  /** Work item priority from frontmatter */
  priority: string;
  /** Work item description (markdown body) */
  description: string;
  /** Previous assignee member ID (null = was unassigned) */
  previousAssignee: string | null;
  /** New assignee member ID (null = was unassigned) */
  newAssignee: string | null;
}

export type OnAssignmentChanges = (
  changes: AssignmentChange[],
  members: MemberEntry[]
) => void;
