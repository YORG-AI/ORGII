import type {
  FollowUpRef,
  LinkedSession,
  OrchestratorConfig,
  OrchestratorState,
  ProofOfWork,
} from "./agentWorkflow";
import type { CommentEntry, TodoEntry } from "./common";
import type { WorkItemRoutineSource, WorkItemSchedule } from "./routines";

export const WORK_ITEM_HISTORY_ACTION = {
  CREATED: "created",
  UPDATED: "updated",
  COMMENTED: "commented",
  DELETED: "deleted",
  RESTORED: "restored",
  MOVED: "moved",
} as const;

export type WorkItemHistoryAction =
  (typeof WORK_ITEM_HISTORY_ACTION)[keyof typeof WORK_ITEM_HISTORY_ACTION];

export interface WorkItemHistoryChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface WorkItemHistoryEvent {
  id: string;
  action: WorkItemHistoryAction;
  timestamp: string;
  actorId?: string;
  actorName?: string;
  changes?: WorkItemHistoryChange[];
  summary?: string;
}

export const WORK_ITEM_ASSIGNEE_TARGET_KIND = {
  HUMAN: "human",
  AGENT: "agent",
  AGENT_ORG: "agent_org",
} as const;

export type WorkItemAssigneeTargetKind =
  (typeof WORK_ITEM_ASSIGNEE_TARGET_KIND)[keyof typeof WORK_ITEM_ASSIGNEE_TARGET_KIND];

export interface WorkItemAssigneeTarget {
  kind: WorkItemAssigneeTargetKind;
  targetId: string;
}

export const WORK_ITEM_EXECUTION_LOCK_REASON = {
  MANUAL_START: "manual_start",
  ROUTINE_AUTO_START: "routine_auto_start",
  ASSIGNMENT_WAKEUP: "assignment_wakeup",
  FOLLOW_UP: "follow_up",
} as const;

export type WorkItemExecutionLockReason =
  (typeof WORK_ITEM_EXECUTION_LOCK_REASON)[keyof typeof WORK_ITEM_EXECUTION_LOCK_REASON];

export interface WorkItemExecutionLock {
  activeSessionId?: string;
  activeAgentOrgRunId?: string;
  executionTarget?: WorkItemAssigneeTarget;
  lockedAt?: string;
  lockReason?: WorkItemExecutionLockReason;
  /**
   * Collab execution-lock holder (design §16.6). Set by the server
   * (`orgii_acquire_work_item_lock` forces it to the authenticated member)
   * and synced down inside the work item payload. Absent on purely local
   * (non-collab) locks. Consumers use it to disable "start agent" when a
   * teammate already holds the lock.
   */
  lockedByMemberId?: string;
}

export const WORK_ITEM_CLOSE_OUT_STATUS = {
  NONE: "none",
  DONE: "done",
  NEEDS_REVIEW: "needs_review",
  CHANGES_REQUESTED: "changes_requested",
  BLOCKED: "blocked",
  FOLLOW_UP_REQUIRED: "follow_up_required",
} as const;

export type WorkItemCloseOutStatus =
  (typeof WORK_ITEM_CLOSE_OUT_STATUS)[keyof typeof WORK_ITEM_CLOSE_OUT_STATUS];

export interface WorkItemCloseOut {
  status: WorkItemCloseOutStatus;
  sessionId?: string;
  reviewerTarget?: WorkItemAssigneeTarget;
  summary?: string;
  decisionReason?: string;
  nextOwner?: WorkItemAssigneeTarget;
  createdAt?: string;
  resolvedAt?: string;
}

export const WORK_ITEM_WORK_PRODUCT_TYPE = {
  BRANCH: "branch",
  COMMIT: "commit",
  PULL_REQUEST: "pull_request",
  FILE_CHANGE: "file_change",
  VALIDATION: "validation",
  PREVIEW: "preview",
  DEPLOYMENT: "deployment",
  SCREENSHOT: "screenshot",
  DOCUMENT: "document",
  RISK_NOTE: "risk_note",
} as const;

export type WorkItemWorkProductType =
  (typeof WORK_ITEM_WORK_PRODUCT_TYPE)[keyof typeof WORK_ITEM_WORK_PRODUCT_TYPE];

export const WORK_ITEM_WORK_PRODUCT_STATUS = {
  UNKNOWN: "unknown",
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  MERGED: "merged",
  DEPLOYED: "deployed",
} as const;

export type WorkItemWorkProductStatus =
  (typeof WORK_ITEM_WORK_PRODUCT_STATUS)[keyof typeof WORK_ITEM_WORK_PRODUCT_STATUS];

export const WORK_ITEM_WORK_PRODUCT_REVIEW_STATE = {
  NONE: "none",
  PENDING: "pending",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
} as const;

export type WorkItemWorkProductReviewState =
  (typeof WORK_ITEM_WORK_PRODUCT_REVIEW_STATE)[keyof typeof WORK_ITEM_WORK_PRODUCT_REVIEW_STATE];

export interface WorkItemWorkProduct {
  id: string;
  sessionId?: string;
  productType: WorkItemWorkProductType;
  title: string;
  provider?: string;
  externalId?: string;
  url?: string;
  status?: WorkItemWorkProductStatus;
  reviewState?: WorkItemWorkProductReviewState;
  isPrimary: boolean;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemFrontmatter {
  id: string;
  short_id: string;
  title: string;
  project?: string;
  status: string;
  priority: string;
  assignee?: string;
  assignee_type?: string;
  labels: string[];
  milestone?: string;
  parent?: string;
  start_date?: string;
  target_date?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  starred: boolean;
  todos: TodoEntry[];
  comments?: CommentEntry[];
  history?: WorkItemHistoryEvent[];
  linked_sessions?: LinkedSession[];
  proof_of_work?: ProofOfWork;
  orchestrator_config?: OrchestratorConfig;
  orchestrator_state?: OrchestratorState;
  follow_up_items?: FollowUpRef[];
  schedule?: WorkItemSchedule;
  routine_source?: WorkItemRoutineSource;
  execution_lock?: WorkItemExecutionLock;
  close_out?: WorkItemCloseOut;
  work_products?: WorkItemWorkProduct[];
}

export interface WorkItemData {
  frontmatter: WorkItemFrontmatter;
  body: string;
  filename: string;
}

/**
 * Partial update payload for work items.
 *
 * All fields are optional — only provided fields are updated. The Rust
 * backend runs the read-modify-write inside an `IMMEDIATE` transaction
 * so concurrent partial updates serialize safely.
 */
export interface WorkItemPartialUpdate {
  title?: string;
  body?: string;
  status?: string;
  priority?: string;
  project?: string | null;
  starred?: boolean;
  assignee?: string | null;
  assigneeType?: string | null;
  labels?: string[];
  milestone?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  todos?: TodoEntry[];
  comments?: CommentEntry[];
  linkedSessions?: LinkedSession[];
  orchestratorConfig?: OrchestratorConfig;
  orchestratorState?: OrchestratorState;
  schedule?: WorkItemSchedule | null;
  executionLock?: WorkItemExecutionLock | null;
  closeOut?: WorkItemCloseOut | null;
  workProducts?: WorkItemWorkProduct[];
}

export interface ResolvedPerson {
  id: string;
  name: string;
  avatar?: string;
  color: string;
}

export interface ResolvedLabel {
  id: string;
  name: string;
  color: string;
}

export interface ResolvedProject {
  id: string;
  name: string;
}

export interface ResolvedMilestone {
  id: string;
  name: string;
}

/**
 * Work item with pre-resolved labels, members, and computed fields.
 * Field names are camelCase (Rust uses `serde(rename_all = "camelCase")`).
 */
export interface EnrichedWorkItem {
  id: string;
  shortId: string;
  title: string;
  body: string;
  filename: string;

  status: string;
  priority: string;
  starred: boolean;

  assignee?: ResolvedPerson;
  assigneeType?: string;
  labels: ResolvedLabel[];
  project?: ResolvedProject;
  milestone?: ResolvedMilestone;

  startDate?: string;
  targetDate?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  createdBy?: string;
  createdByPerson?: ResolvedPerson;

  todos: TodoEntry[];
  comments: CommentEntry[];
  history: WorkItemHistoryEvent[];

  linkedSessions: LinkedSession[];
  proofOfWork?: ProofOfWork;
  orchestratorConfig?: OrchestratorConfig;
  orchestratorState?: OrchestratorState;
  followUpItems: FollowUpRef[];
  schedule?: WorkItemSchedule;
  routineSource?: WorkItemRoutineSource;
  executionLock?: WorkItemExecutionLock;
  closeOut?: WorkItemCloseOut;
  workProducts: WorkItemWorkProduct[];
}

export type RustKanbanStatus =
  | "backlog"
  | "planned"
  | "in_progress"
  | "in_review"
  | "completed"
  | "cancelled"
  | "duplicate";

export interface RustKanbanTask {
  id: string;
  title: string;
  description?: string;
  status: RustKanbanStatus;
  priority?: string;
  assignee?: string;
  labels: ResolvedLabel[];
}

export type RustGanttStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "overdue"
  | "cancelled";

export interface RustGanttTask {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  status: RustGanttStatus;
  assignee?: string;
  labels: ResolvedLabel[];
}

export interface RustCalendarEvent {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  status: string;
  assignee?: ResolvedPerson;
  labels: ResolvedLabel[];
  allDay: boolean;
}

export interface StatusCounts {
  all: number;
  backlog: number;
  planned: number;
  inProgress: number;
  inReview: number;
  completed: number;
  cancelled: number;
  duplicate: number;
}

export interface GroupedWorkItems {
  backlog: EnrichedWorkItem[];
  planned: EnrichedWorkItem[];
  inProgress: EnrichedWorkItem[];
  inReview: EnrichedWorkItem[];
  completed: EnrichedWorkItem[];
  cancelled: EnrichedWorkItem[];
  duplicate: EnrichedWorkItem[];
}

/**
 * Complete work items response with all pre-computed views.
 * Single IPC call returns everything needed for display.
 */
export interface WorkItemsViewData {
  items: EnrichedWorkItem[];
  counts: StatusCounts;
  kanbanTasks: RustKanbanTask[];
  ganttTasks: RustGanttTask[];
  calendarEvents: RustCalendarEvent[];
  grouped: GroupedWorkItems;
}

export interface BatchItemError {
  shortId: string;
  error: string;
}

export interface BatchDeleteResult {
  deleted: string[];
  errors: BatchItemError[];
}

export interface BatchUpdateResult {
  updated: EnrichedWorkItem[];
  errors: BatchItemError[];
}
