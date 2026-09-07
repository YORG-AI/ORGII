/**
 * Shared Status Types & Colors for Work Item Views
 *
 * Unified status definitions for Kanban, Gantt, Calendar, and List views.
 * All views should use these shared colors for consistency.
 */
import type { WorkItemStatus } from "./workItem";

// ============================================
// View-Specific Status Types
// ============================================

/**
 * Kanban column status
 */
export type KanbanStatus = WorkItemStatus;

/**
 * Gantt task status
 */
export type GanttStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "overdue"
  | "cancelled";

// ============================================
// Status Color Palette
// ============================================

/**
 * Unified color palette for all status-based styling.
 * Uses semantic color names that map to Tailwind classes.
 *
 * Colors follow a consistent pattern:
 * - Gray: Not started / Scheduled / Todo
 * - Blue: In progress
 * - Amber: In review / At risk
 * - Green: Completed / Done
 * - Red: Overdue
 * - Slate: Cancelled
 */
export const STATUS_COLORS = {
  // Primary status colors (hex for gradients/dynamic styling)
  gray: {
    base: "#6b7280",
    dark: "#4b5563",
    light: "#9ca3af",
    tw: "gray-500", // Tailwind class suffix
  },
  blue: {
    base: "#3b82f6",
    dark: "#2563eb",
    light: "#60a5fa",
    tw: "blue-500",
  },
  amber: {
    base: "#f59e0b",
    dark: "#d97706",
    light: "#fbbf24",
    tw: "amber-500",
  },
  green: {
    base: "#10b981",
    dark: "#059669",
    light: "#34d399",
    tw: "green-500",
  },
  red: {
    base: "#ef4444",
    dark: "#dc2626",
    light: "#f87171",
    tw: "red-500",
  },
  slate: {
    base: "#64748b",
    dark: "#475569",
    light: "#94a3b8",
    tw: "slate-500",
  },
} as const;

// ============================================
// Status to Color Mapping
// ============================================

/**
 * Maps WorkItemStatus to color key
 */
export const WORK_ITEM_STATUS_COLOR: Record<
  WorkItemStatus,
  keyof typeof STATUS_COLORS
> = {
  backlog: "gray",
  planned: "gray",
  in_progress: "blue",
  in_review: "amber",
  completed: "green",
  cancelled: "slate",
  duplicate: "slate",
  open: "blue",
  closed: "green",
};

/**
 * Maps KanbanStatus to color key
 */
export const KANBAN_STATUS_COLOR: Record<
  KanbanStatus,
  keyof typeof STATUS_COLORS
> = WORK_ITEM_STATUS_COLOR;

/**
 * Maps GanttStatus to color key
 */
export const GANTT_STATUS_COLOR: Record<
  GanttStatus,
  keyof typeof STATUS_COLORS
> = {
  not_started: "gray",
  in_progress: "blue",
  completed: "green",
  overdue: "red",
  cancelled: "slate",
};

// ============================================
// Helper Functions
// ============================================

/**
 * Get the color config for a WorkItemStatus
 */
export function getStatusColor(status: WorkItemStatus) {
  const colorKey = WORK_ITEM_STATUS_COLOR[status];
  return STATUS_COLORS[colorKey];
}

/**
 * Get CSS gradient for task bar
 */
export function getStatusGradient(status: GanttStatus): string {
  const colorKey = GANTT_STATUS_COLOR[status];
  const color = STATUS_COLORS[colorKey];
  return `linear-gradient(135deg, ${color.base}, ${color.dark})`;
}
