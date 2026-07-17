/**
 * Project Types
 *
 * Type definitions for projects (collections of work items).
 */
import type { Label, Person, Team } from "./shared";

// ============================================
// Status & Priority Types
// ============================================

/**
 * Project status
 */
export type ProjectStatus =
  | "backlog"
  | "planned"
  | "in_progress"
  | "completed"
  | "canceled";

/**
 * Project priority
 */
export type ProjectPriority = "urgent" | "high" | "medium" | "low" | "none";

/**
 * Project health indicator
 */
export type ProjectHealth = "on_track" | "at_risk" | "off_track" | "no_updates";

// ============================================
// Core Project Types
// ============================================

/**
 * Repository reference
 */
export interface Repository {
  id: string;
  name: string;
  url?: string;
  path?: string;
}

/**
 * Work item status breakdown
 */
export interface StatusBreakdown {
  backlog: number;
  planned: number;
  in_progress: number;
  in_review: number;
  completed: number;
  cancelled: number;
}

/**
 * Project entity
 */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Public project slug used by URLs and backend project-store lookups. */
  slug?: string;
  /**
   * Owning project-store org id (`ProjectMeta.org_id`). Absent for external
   * (e.g. Linear) rows.
   */
  orgId?: string;
  /** 3-char alphanumeric prefix used in work item IDs (e.g. "AUT") */
  workItemPrefix?: string;
  /** True when prefix is manually configured in project settings */
  workItemPrefixCustom?: boolean;
  status: ProjectStatus;
  priority: ProjectPriority;
  health: ProjectHealth;
  lead?: Person;
  members?: Person[];
  teams?: Team[];
  labels?: Label[];
  linkedRepos?: Repository[];
  startDate?: string;
  targetDate?: string;
  createdAt: string;
  updatedAt: string;
  workItemCount?: number;
  completionPercentage?: number;
  statusBreakdown?: StatusBreakdown;
}
