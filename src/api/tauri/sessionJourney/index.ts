import { invoke } from "@tauri-apps/api/core";

export type TaskStartPosition = "最近用户消息" | "下一条用户消息";
export type TaskOutcome =
  | "completed"
  | "partially_completed"
  | "paused"
  | "abandoned"
  | "redirected";
export type ReviewState =
  | "queued"
  | "ready"
  | "confirmed"
  | "discarded"
  | "failed";

export interface JourneyTask {
  id: string;
  name: string;
  branch_id: string;
  state: string;
  start_sequence: number | null;
  finish_sequence: number | null;
  outcome: TaskOutcome | null;
}
export interface JourneyCheckpoint {
  id: string;
  task_id: string;
  message_id: string;
  sequence: number;
  name: string;
}
export interface JourneyFork {
  id: string;
  parent_branch_id: string;
  parent_anchor_message_id: string | null;
  anchor_sequence: number;
  state: string;
  handoff_capsule: {
    objective: string;
    conclusion: string;
    open_questions: string[];
    confirmed_items: string[];
  } | null;
}
export interface JourneyReview {
  id: string;
  fork_id: string;
  state: ReviewState;
  annotation: string | null;
  source_start_sequence: number;
  source_end_sequence: number;
  promoted_fact_ids: string[];
}
export interface JourneySnapshot {
  session_id: string;
  revision: number;
  active_branch_id: string;
  active_task_id: string | null;
  tasks: Record<string, JourneyTask>;
  checkpoints: Record<string, JourneyCheckpoint>;
  branches: Record<string, JourneyFork>;
  reviews: Record<string, JourneyReview>;
}
export interface JourneySnapshotResponse {
  snapshot: JourneySnapshot;
  revision: number;
}
export interface JourneyWriteResponse {
  revision: number;
}
export interface ForkCompareItem {
  branch_id: string;
  branch_name: string;
  state: string;
  tasks: Array<{
    task_id: string;
    name: string;
    state: string;
    outcome: TaskOutcome | null;
  }>;
  task_outcome: TaskOutcome | null;
  conclusion: string | null;
  unresolved: string[];
  evidence: string[];
}
export interface ForkCompareGroup {
  parent_branch_id: string;
  parent_anchor_message_id: string | null;
  anchor_sequence: number;
  forks: ForkCompareItem[];
}
export interface ForkCompareResponse {
  groups: ForkCompareGroup[];
}

export interface CreateTaskRequest {
  sessionId: string;
  expectedRevision: number;
  taskId: string;
  name: string;
  position: TaskStartPosition;
}
export interface CreateForkRequest {
  sessionId: string;
  expectedRevision: number;
  forkId: string;
  taskId: string;
  taskName: string;
  /**
   * An explicit durable user-message anchor. Omit only for the dedicated
   * direct-Fork flow: the backend then resolves the latest durable user
   * message and verifies that it belongs to the active branch atomically.
   */
  anchorMessageId?: string | null;
}
export interface CreateCheckpointRequest {
  sessionId: string;
  expectedRevision: number;
  checkpointId: string;
  name: string;
  messageId: string;
}
export interface FinishTaskRequest {
  sessionId: string;
  expectedRevision: number;
  outcome: TaskOutcome;
  messageId: string;
}
export interface PromoteFactRequest {
  sessionId: string;
  expectedRevision: number;
  reviewId: string;
  factId: string;
  text: string;
  evidenceStartMessageId: string;
  evidenceEndMessageId: string;
}
export interface DiscardForkRequest {
  sessionId: string;
  expectedRevision: number;
  reviewId: string;
}
export interface ReturnToParentRequest {
  sessionId: string;
  expectedRevision: number;
  reviewId: string;
}
export interface ForkCloseRequest {
  sessionId: string;
  expectedRevision: number;
  forkId: string;
  reviewId: string;
  outcome: TaskOutcome;
  messageId: string;
}
export interface RuntimeProvenance {
  modelId: string;
  accountId: string;
  protocol: string;
}
export interface RetryReviewRequest {
  sessionId: string;
  expectedRevision: number;
  reviewId: string;
}

/** Typed desktop boundary. UI code must not invoke Journey command strings. */
export const sessionJourneyApi = {
  snapshot: (sessionId: string) =>
    invoke<JourneySnapshotResponse>("journey_snapshot", { sessionId }),
  startTask: (request: CreateTaskRequest) =>
    invoke<JourneyWriteResponse>("journey_task_start", { request }),
  checkpoint: (request: CreateCheckpointRequest) =>
    invoke<JourneyWriteResponse>("journey_checkpoint", { request }),
  finishTask: (request: FinishTaskRequest) =>
    invoke<JourneyWriteResponse>("journey_task_finish", { request }),
  startFork: (request: CreateForkRequest) =>
    invoke<JourneyWriteResponse>("journey_fork_start", { request }),
  closeFork: (request: ForkCloseRequest, jobId: string) =>
    invoke<{ job_id: string; state: string }>("journey_fork_close", {
      request,
      jobId,
    }),
  retryReview: (request: RetryReviewRequest) =>
    invoke<JourneyWriteResponse>("journey_review_retry", { request }),
  reviews: (sessionId: string) =>
    invoke<JourneyReview[]>("journey_review_list", { sessionId }),
  forkCompare: (sessionId: string) =>
    invoke<ForkCompareResponse>("journey_fork_compare", { sessionId }),
  readyDraft: (sessionId: string, reviewId: string) =>
    invoke<string | null>("journey_ready_draft", { sessionId, reviewId }),
  confirm: (request: PromoteFactRequest) =>
    invoke<JourneyWriteResponse>("journey_confirm", { request }),
  discard: (request: DiscardForkRequest) =>
    invoke<{
      revision: number;
      parent_branch_id: string;
      parent_anchor_message_id: string;
      parent_anchor_sequence: number;
    }>("journey_discard", { request }),
  returnToParent: (request: ReturnToParentRequest) =>
    invoke<{
      revision: number;
      parent_branch_id: string;
      parent_anchor_message_id: string;
      parent_anchor_sequence: number;
    }>("journey_return_parent", { request }),
};
