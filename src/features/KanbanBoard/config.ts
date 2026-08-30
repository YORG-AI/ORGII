/**
 * KanbanBoard Configuration
 *
 * Defines task statuses, column settings, and icons for the Kanban board.
 */
import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDashedIcon,
  CircleIcon,
  Clock01Icon,
  Layers01Icon,
} from "@src/icons";
import {
  GITHUB_ISSUE_STATUS,
  WORK_ITEM_STATUS,
} from "@src/types/core/workItem";

import type { KanbanColumnConfig, TaskStatus } from "./types";

// ============================================
// Default Column Configuration
// ============================================

// `title` is an i18n key (with optional namespace prefix). `KanbanColumn`
// passes it through `t()`, so it resolves at render time and respects the
// user's locale.
export const DEFAULT_KANBAN_COLUMNS: KanbanColumnConfig[] = [
  {
    id: WORK_ITEM_STATUS.BACKLOG,
    title: "projects:workItems.statusLabels.backlog",
    icon: CircleDashedIcon,
    color: "var(--color-neutral-6)",
    bgColor: "color-mix(in srgb, var(--color-neutral-6) 10%, transparent)",
    dotColor: "var(--color-neutral-6)",
    headerBgColor: "color-mix(in srgb, var(--color-neutral-6) 8%, transparent)",
  },
  {
    id: WORK_ITEM_STATUS.PLANNED,
    title: "projects:workItems.statusLabels.planned",
    icon: CircleIcon,
    color: "var(--color-neutral-6)",
    bgColor: "color-mix(in srgb, var(--color-neutral-6) 10%, transparent)",
    dotColor: "var(--color-neutral-6)",
    headerBgColor: "color-mix(in srgb, var(--color-neutral-6) 8%, transparent)",
  },
  {
    id: WORK_ITEM_STATUS.IN_PROGRESS,
    title: "projects:workItems.statusLabels.in_progress",
    icon: Clock01Icon,
    color: "var(--color-primary-6)",
    bgColor: "color-mix(in srgb, var(--color-primary-6) 10%, transparent)",
    dotColor: "var(--color-primary-6)",
    headerBgColor: "color-mix(in srgb, var(--color-primary-6) 8%, transparent)",
  },
  {
    id: WORK_ITEM_STATUS.IN_REVIEW,
    title: "projects:workItems.statusLabels.in_review",
    icon: Layers01Icon,
    color: "var(--color-warning-6)",
    bgColor: "color-mix(in srgb, var(--color-warning-6) 10%, transparent)",
    dotColor: "var(--color-warning-6)",
    headerBgColor: "color-mix(in srgb, var(--color-warning-6) 8%, transparent)",
  },
  {
    id: WORK_ITEM_STATUS.COMPLETED,
    title: "projects:workItems.statusLabels.completed",
    icon: CheckmarkCircle01Icon,
    color: "var(--color-success-6)",
    bgColor: "color-mix(in srgb, var(--color-success-6) 10%, transparent)",
    dotColor: "var(--color-success-6)",
    headerBgColor: "color-mix(in srgb, var(--color-success-6) 8%, transparent)",
  },
  {
    id: WORK_ITEM_STATUS.CANCELLED,
    title: "projects:workItems.statusLabels.cancelled",
    icon: CancelCircleIcon,
    color: "var(--color-danger-6)",
    bgColor: "color-mix(in srgb, var(--color-danger-6) 10%, transparent)",
    dotColor: "var(--color-danger-6)",
    headerBgColor: "color-mix(in srgb, var(--color-danger-6) 8%, transparent)",
  },
  {
    id: WORK_ITEM_STATUS.DUPLICATE,
    title: "projects:workItems.statusLabels.duplicate",
    icon: CancelCircleIcon,
    color: "var(--color-text-3)",
    bgColor: "color-mix(in srgb, var(--color-text-3) 10%, transparent)",
    dotColor: "var(--color-text-3)",
    headerBgColor: "color-mix(in srgb, var(--color-text-3) 8%, transparent)",
  },
];

export const GITHUB_ISSUE_KANBAN_COLUMNS: KanbanColumnConfig[] = [
  {
    id: GITHUB_ISSUE_STATUS.OPEN,
    title: "projects:workItems.statusLabels.open",
    icon: CircleIcon,
    color: "var(--color-success-6)",
    bgColor: "color-mix(in srgb, var(--color-success-6) 10%, transparent)",
    dotColor: "var(--color-success-6)",
    headerBgColor: "color-mix(in srgb, var(--color-success-6) 8%, transparent)",
  },
  {
    id: GITHUB_ISSUE_STATUS.CLOSED,
    title: "projects:workItems.statusLabels.closed",
    icon: CheckmarkCircle01Icon,
    color: "var(--color-text-3)",
    bgColor: "color-mix(in srgb, var(--color-text-3) 10%, transparent)",
    dotColor: "var(--color-text-3)",
    headerBgColor: "color-mix(in srgb, var(--color-text-3) 8%, transparent)",
  },
];

// ============================================
// Helper Functions
// ============================================

export function getColumnConfig(
  status: TaskStatus,
  columns: KanbanColumnConfig[] = DEFAULT_KANBAN_COLUMNS
): KanbanColumnConfig {
  return columns.find((col) => col.id === status) || columns[0];
}
