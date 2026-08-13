export interface WorkItemSchedule {
  /** One-time trigger: ISO 8601 timestamp */
  at?: string;
  /** Recurring trigger: cron expression (e.g. "0 18 * * 3" = every Wed 6pm) */
  cron?: string;
  enabled: boolean;
  /** Last time a cron schedule fired (ISO 8601), used for dedup */
  last_run?: string;
}

export type RoutineTrigger =
  | { kind: "one_time"; at: string }
  | { kind: "cron"; cron: string; timezone: string };

export const ROUTINE_FIRE_STATUS = {
  PENDING: "pending",
  STARTED: "started",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
  COALESCED: "coalesced",
  QUEUED: "queued",
} as const;

export type RoutineFireStatus =
  (typeof ROUTINE_FIRE_STATUS)[keyof typeof ROUTINE_FIRE_STATUS];

export const ROUTINE_OUTPUT_MODE = {
  DIRECT_SESSION: "direct_session",
  CREATE_WORK_ITEM: "create_work_item",
  UPDATE_EXISTING_WORK_ITEM: "update_existing_work_item",
} as const;

export type RoutineOutputMode =
  (typeof ROUTINE_OUTPUT_MODE)[keyof typeof ROUTINE_OUTPUT_MODE];

export const ROUTINE_CONCURRENCY_POLICY = {
  COALESCE_IF_ACTIVE: "coalesce_if_active",
  SKIP_IF_ACTIVE: "skip_if_active",
  QUEUE_IF_ACTIVE: "queue_if_active",
  ALWAYS_CREATE: "always_create",
} as const;

export type RoutineConcurrencyPolicy =
  (typeof ROUTINE_CONCURRENCY_POLICY)[keyof typeof ROUTINE_CONCURRENCY_POLICY];

export const ROUTINE_CATCH_UP_POLICY = {
  SKIP_MISSED: "skip_missed",
  RUN_ONCE: "run_once",
  RUN_ALL_LIMITED: "run_all_limited",
} as const;

export type RoutineCatchUpPolicy =
  (typeof ROUTINE_CATCH_UP_POLICY)[keyof typeof ROUTINE_CATCH_UP_POLICY];

export interface RoutineOutputPolicy {
  mode: RoutineOutputMode;
  concurrencyPolicy: RoutineConcurrencyPolicy;
  catchUpPolicy: RoutineCatchUpPolicy;
  maxCatchUpRuns: number;
  idempotencyScope: string;
  createWorkItemStatus: string;
  createWorkItemProjectSlug?: string;
  createWorkItemTitle?: string;
  createWorkItemBody?: string;
  /** CreateWorkItem mode: immediately start the created item.
   *  Backend default is false (legacy policies stay backlog-only);
   *  the wizard defaults new routines to true. */
  autoStart: boolean;
  /** UpdateExistingWorkItem mode: target work item short_id. */
  updateWorkItemShortId?: string;
  /** UpdateExistingWorkItem mode: project slug of the target item. */
  updateWorkItemProjectSlug?: string;
}
export type RoutineRunTarget =
  | { kind: "agent_definition"; agentDefinitionId?: string }
  | { kind: "agent_org"; agentOrgId: string };

export interface RoutineResourceSelection {
  keySource?: string;
  accountId?: string;
  model?: string;
  nativeHarnessType?: string;
}

export type RoutineWorkspaceTarget =
  | { kind: "none" }
  | {
      kind: "local_workspace";
      workspacePath: string;
      additionalDirectories: string[];
    }
  | {
      kind: "worktree";
      workspacePath: string;
      worktreePath?: string;
      branch?: string;
      createIsolated: boolean;
      additionalDirectories: string[];
    };

export interface RoutineRunTemplate {
  prompt: string;
  target: RoutineRunTarget;
  resources: RoutineResourceSelection;
  workspace: RoutineWorkspaceTarget;
  mode?: string;
  name?: string;
}

export interface RoutineDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  runTemplate: RoutineRunTemplate;
  outputPolicy: RoutineOutputPolicy;
  /** Scheduler evaluation watermark (ISO 8601), backend-managed. */
  lastEvaluatedAt?: string;
  /** Next computed fire time (ISO 8601), backend-managed, display only. */
  nextFireAt?: string;
  /** Latest durable occurrence summary, projected by the backend. */
  lastFireAt?: string;
  lastFireStatus?: RoutineFireStatus;
  lastFireError?: string;
  lastFireSessionId?: string;
  lastFireWorkItemId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineFire {
  id: string;
  routineId: string;
  firedAt: string;
  status: RoutineFireStatus;
  sessionId?: string;
  agentOrgRunId?: string;
  workItemId?: string;
  coalescedIntoFireId?: string;
  idempotencyKey?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkItemRoutineSource {
  routineId: string;
  routineFireId: string;
  routineName: string;
  firedAt: string;
}

export interface RoutineFireResult {
  fire: RoutineFire;
  sessionId?: string;
  agentOrgRunId?: string;
}
