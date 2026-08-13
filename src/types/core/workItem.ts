/**
 * Work Item Types
 *
 * Consolidated work item type definitions.
 * Merged from: workitem.ts + app/manage/workItem.ts
 */
import type {
  FollowUpRef,
  LinkedSession,
  OrchestratorConfig,
  OrchestratorState,
  ProofOfWork,
  WorkItemCloseOut,
  WorkItemExecutionLock,
  WorkItemHandoff,
  WorkItemHistoryEvent,
  WorkItemOriginSession,
  WorkItemRoutineSource,
  WorkItemSchedule,
  WorkItemWorkProduct,
} from "@src/api/http/project/types";

import type { Label, Person } from "./shared";

// ============================================
// Status & Priority Types
// ============================================

/**
 * Work item status
 */
export type GitHubIssueStatus = "open" | "closed";

export type WorkItemStatus =
  | "backlog"
  | "planned"
  | "in_progress"
  | "in_review"
  | "completed"
  | "cancelled"
  | "duplicate"
  | GitHubIssueStatus;

export const WORK_ITEM_STATUS = {
  BACKLOG: "backlog",
  PLANNED: "planned",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  DUPLICATE: "duplicate",
  GITHUB_OPEN: "open",
  GITHUB_CLOSED: "closed",
} as const;

export const GITHUB_ISSUE_STATUS = {
  OPEN: WORK_ITEM_STATUS.GITHUB_OPEN,
  CLOSED: WORK_ITEM_STATUS.GITHUB_CLOSED,
} as const;

/**
 * Work item priority
 */
export type WorkItemPriority = "none" | "urgent" | "high" | "medium" | "low";

// ============================================
// Related Entity Types
// ============================================

/**
 * Project reference for work items
 */
export interface WorkItemProject {
  id: string;
  name: string;
  icon?: string;
  color?: string;
}

/**
 * Milestone reference for work items
 */
export interface WorkItemMilestone {
  id: string;
  name: string;
  dueDate?: string;
  progress?: number;
}

/**
 * Work item label (extends base Label)
 */
export type WorkItemLabel = Label;

// ============================================
// Core Work Item Types
// ============================================

/**
 * Base work item data shared across the UI.
 *
 * Field names retain wire-style snake_case (`session_id`, `created_time`,
 * etc.) to match the existing read sites; renaming them is a separate
 * sweep. The shape is now lean — fields that were never read in the
 * project-first model have been removed.
 */
export interface WorkItemBase {
  session_id: string;
  /** User-facing identifier; distinct from the stable internal row id. */
  shortId?: string;
  user_id: string;
  name: string;
  status: string;
  spec: string;
  star: boolean;
  target_date: string | null;
  created_time: string;
  updated_time: string;
  deletedAt?: string;
  /**
   * Optional summary metadata. The only sub-field actually consumed by
   * the UI is `file_change_summary`; the rest of the legacy session
   * metadata blob (file_diff, watermarks, token_consumption,
   * workflow_context) has been removed.
   */
  session_metadata?: {
    file_change_summary: string | null;
  };
}

/**
 * A single to-do entry inside a work item
 */
export interface TodoItem {
  id: string;
  content: string;
  /** "pending" | "in_progress" | "completed" */
  status: string;
}

/**
 * A comment on a work item
 */
export interface WorkItemComment {
  id: string;
  author: string;
  content: string;
  created_at: string;
  mentioned_user_ids?: string[];
  parent_id?: string;
  thread_id?: string;
  resolved_at?: string;
  resolved_by?: string;
  conclusion?: boolean;
  agent_session_id?: string;
}

// ============================================
// Agent Workflow Types (re-exported from project store for UI use)
// ============================================

export type {
  OrchestratorPhase,
  ReviewOutcome,
  PrStatus,
  AgentRole,
  LinkedSessionType,
  LinkedSessionStatus,
  LinkedSession,
  WorkItemOriginSession,
  DiffStats,
  TestResults,
  ProofOfWork,
  OrchestratorConfig,
  WorkItemHistoryAction,
  WorkItemHistoryChange,
  WorkItemHistoryEvent,
  WorkItemAssigneeTarget,
  WorkItemAssigneeTargetKind,
  WorkItemExecutionLock,
  WorkItemExecutionLockReason,
  WorkItemCloseOut,
  WorkItemCloseOutStatus,
  WorkItemWorkProduct,
  WorkItemWorkProductType,
  WorkItemWorkProductStatus,
  WorkItemWorkProductReviewState,
  LastFailure,
  OrchestratorState,
  FollowUpRef,
} from "@src/api/http/project/types";

/**
 * A market delegation entry on a work item
 */
export interface WorkItemDelegation {
  taskId: string;
  agentAppId: string;
  agentAppName: string;
  skillId: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  costUsd: number;
  createdAt: string;
  completedAt?: string;
}

/**
 * Extended work item with UI-specific fields
 */
export interface WorkItem extends WorkItemBase {
  workItemStatus?: WorkItemStatus;
  priority?: WorkItemPriority;
  assignee?: Person;
  assigneeType?: string;
  createdBy?: Person;
  lead?: Person[];
  members?: Person[];
  labels?: WorkItemLabel[];
  project?: WorkItemProject;
  milestone?: WorkItemMilestone;
  startDate?: string;
  endDate?: string;
  linkedSessions?: LinkedSession[];
  originSession?: WorkItemOriginSession;
  subIssueCount?: number;
  todos?: TodoItem[];
  comments?: WorkItemComment[];
  history?: WorkItemHistoryEvent[];
  handoff?: WorkItemHandoff;
  delegations?: WorkItemDelegation[];
  orchestratorConfig?: OrchestratorConfig;
  orchestratorState?: OrchestratorState;
  proofOfWork?: ProofOfWork;
  followUpItems?: FollowUpRef[];
  schedule?: WorkItemSchedule | null;
  routineSource?: WorkItemRoutineSource;
  executionLock?: WorkItemExecutionLock;
  closeOut?: WorkItemCloseOut;
  workProducts?: WorkItemWorkProduct[];
}
