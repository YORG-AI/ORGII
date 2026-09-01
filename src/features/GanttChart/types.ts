/**
 * GanttChart Types
 *
 * Shared types for the reusable GanttChart component.
 */
import type React from "react";

import type { CliAgentType } from "@src/api/types/keys";
import type { Label } from "@src/types/core/shared";

// ============================================
// Time Scale / View Scope Types
// ============================================

/**
 * ViewScope defines the time range being displayed:
 * - "1d": 1 day with hourly divisions (24 columns)
 * - "3d": 3 days with AM/PM divisions (6 columns)
 * - "7d": 7 days (7 columns)
 * - "1m": ~30 days (days of month)
 * - "3m": ~90 days (3 months, showing weeks or days)
 */
export type GanttViewScope = "1d" | "3d" | "7d" | "1m" | "3m";

/**
 * TimeUnit is the granularity for each column
 */
type GanttTimeUnit = "hour" | "halfday" | "day" | "week" | "month";

// GanttTimeScale maps to ViewScope
export type GanttTimeScale = "day" | "week" | "month" | "quarter";

// ============================================
// Task Types
// ============================================

type GanttTaskStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "overdue"
  | "cancelled";

export interface GanttTaskSegment {
  id: string;
  startDate: Date | string;
  endDate: Date | string;
  barLabel?: string;
  startClipped?: boolean;
  endClipped?: boolean;
}

export interface GanttTask {
  id: string;
  title: string;
  startDate: Date | string;
  endDate: Date | string;
  status?: GanttTaskStatus;
  progress?: number; // 0-100 percentage
  assignee?: string;
  labels?: Label[];
  color?: string;
  dependencies?: string[]; // IDs of tasks this depends on (predecessors)
  sessionId?: string;
  agentIconId?: string;
  cliAgentType?: CliAgentType;
  sidebarMeta?: React.ReactNode;
  barLabel?: string;
  startClipped?: boolean;
  endClipped?: boolean;
  segments?: GanttTaskSegment[];
}

export interface GanttMarker {
  id: string;
  title: string;
  timestamp: Date | string;
  endTimestamp?: Date | string;
  label?: string;
  color?: string;
  ariaLabel?: string;
}

export interface GanttMarkerRow {
  id: string;
  title: string;
  markers: GanttMarker[];
  badgeLabel?: string;
}

// ============================================
// Milestone Types
// ============================================

type GanttMilestoneType = "deadline" | "release" | "review" | "custom";

export interface GanttMilestone {
  id: string;
  title: string;
  date: Date | string;
  type: GanttMilestoneType;
  color?: string;
  description?: string;
}

// ============================================
// Config Types
// ============================================

/**
 * Configuration for each view scope
 */
interface ViewScopeConfig {
  /** Number of days in this view scope */
  days: number;
  /** Number of columns to display */
  columns: number;
  /** Time unit for each column */
  unit: GanttTimeUnit;
  /** Label for the selector */
  label: string;
}

export const VIEW_SCOPE_CONFIGS: Record<GanttViewScope, ViewScopeConfig> = {
  "1d": { days: 1, columns: 24, unit: "hour", label: "1d" },
  "3d": { days: 3, columns: 6, unit: "halfday", label: "3d" },
  "7d": { days: 7, columns: 7, unit: "day", label: "7d" },
  "1m": { days: 30, columns: 30, unit: "day", label: "1m" },
  "3m": { days: 90, columns: 12, unit: "week", label: "3m" }, // ~12 weeks
};

export interface GanttConfig {
  /** Row height in pixels */
  rowHeight: number;
  /** Header height in pixels */
  headerHeight: number;
  /** Sidebar width in pixels */
  sidebarWidth: number;
  /** Minimum column width (used as fallback) */
  minColumnWidth: number;
  /** Colors for different statuses */
  statusColors: Record<GanttTaskStatus, string>;
}

export const DEFAULT_GANTT_CONFIG: GanttConfig = {
  rowHeight: 40,
  headerHeight: 56,
  sidebarWidth: 240,
  minColumnWidth: 40,
  statusColors: {
    not_started: "#6b7280",
    in_progress: "#3b82f6",
    completed: "#10b981",
    overdue: "#ef4444",
    cancelled: "#9ca3af",
  },
};
