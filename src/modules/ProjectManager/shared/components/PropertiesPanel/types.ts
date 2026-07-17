import type {
  ProjectHealth,
  ProjectPriority,
  ProjectStatus,
  StatusBreakdown,
} from "@src/types/core/project";
import type { Label, Person, Team } from "@src/types/core/shared";

export type { Label, Person, Team };
export type { ProjectHealth, ProjectPriority, ProjectStatus };

/**
 * A repo linked to a project. `id` is the canonical identifier we persist
 * to `linked_repos` in `meta.yaml` (file-system path for local repos), and
 * `name` is the display label.
 */
export interface LinkedRepoOption {
  id: string;
  name: string;
}

export interface ProjectData {
  id: string;
  name: string;
  description?: string;
  summary?: string;
  /** Stable project slug (e.g. "auth-system"). */
  slug?: string;
  /**
   * Owning project-store org id (`ProjectMeta.org_id`). Read-only; writes
   * always re-read `org_id` from disk (see `useProjectDataFile`).
   */
  orgId?: string;
  /** 3-char alphanumeric prefix used in work item IDs */
  workItemPrefix?: string;
  /** True when prefix is manually configured; false means auto from project name */
  workItemPrefixCustom?: boolean;
  status: ProjectStatus;
  priority: ProjectPriority;
  health: ProjectHealth;
  lead?: Person;
  members?: Person[];
  teams?: Team[];
  labels?: Label[];
  /** Repos linked to this project. Optional and may contain 0..N entries. */
  linkedRepos?: LinkedRepoOption[];
  startDate?: string;
  targetDate?: string;
  completionPercentage?: number;
  statusBreakdown?: StatusBreakdown;
}

/** @deprecated Use PropertiesPanelShellProps + ProjectPropertyFields instead */
export interface PropertiesPanelProps {
  className?: string;
  title?: string;
  mode: "project";
  project: ProjectData;
  onUpdate?: (updates: Partial<ProjectData>) => void;
  availableMembers?: Person[];
  availableTeams?: Team[];
  availableLabels?: Label[];
}

export type PickerType =
  | "status"
  | "priority"
  | "health"
  | "lead"
  | "members"
  | "teams"
  | "labels"
  | "linkedRepos"
  | "startDate"
  | "targetDate"
  | null;

export type ProjectPropertyFieldKey = Exclude<PickerType, null> | "completion";
