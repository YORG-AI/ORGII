export type WorkItemRunStatus =
  | "queued"
  | "deferred"
  | "dispatching"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkItemRunTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; scheduleKey: string }
  | { kind: "routine"; routineId: string; fireId: string }
  | {
      kind: "discussion_comment";
      commentId: string;
      authorId?: string | null;
    }
  | {
      kind: "stage_barrier";
      parentWorkItemId: string;
      stage?: number | null;
      settledKey: string;
    }
  | { kind: "review"; previousRunId: string }
  | { kind: "follow_up"; previousRunId: string }
  | { kind: "retry"; previousRunId: string };

export type WorkItemRunTarget =
  | {
      kind: "start_work_item";
      accountId?: string | null;
      modelId?: string | null;
    }
  | { kind: "resume_session"; sessionId: string };

export interface WorkItemRunTargetSnapshot {
  target: WorkItemRunTarget;
  workItemRevision: number;
  workItemTitle?: string | null;
  workItemBody?: string | null;
  projectDescription?: string | null;
  workspacePath?: string | null;
  repository?: string | null;
  repositoryRef?: string | null;
  defaultBranch?: string | null;
  linkedRepositories?: string[];
  allowSharedCheckout?: boolean;
  workspaceMode?: "local_workspace" | "worktree" | null;
  agentDefinitionId?: string | null;
  agentOrgId?: string | null;
}

export interface WorkItemRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface WorkItemRun {
  id: string;
  projectSlug?: string | null;
  orgId: string;
  workItemId: string;
  trigger: WorkItemRunTrigger;
  targetSnapshot: WorkItemRunTargetSnapshot;
  input: unknown;
  status: WorkItemRunStatus;
  attempt: number;
  maxAttempts: number;
  parentRunId?: string | null;
  sessionId?: string | null;
  usage: WorkItemRunUsage;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface EnqueueWorkItemRunRequest {
  projectSlug?: string | null;
  orgId: string;
  workItemId: string;
  trigger: WorkItemRunTrigger;
  targetSnapshot: WorkItemRunTargetSnapshot;
  input?: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
  parentRunId?: string | null;
}
