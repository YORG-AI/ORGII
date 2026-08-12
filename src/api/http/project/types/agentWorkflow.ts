export type OrchestratorPhase =
  | "idle"
  | "coding"
  | "sde"
  | "review"
  | "follow_up"
  | "completed"
  | "failed"
  | "awaiting_user";

export type ReviewOutcome = "approved" | "changes_requested" | "inconclusive";

export type PrStatus = "draft" | "open" | "merged" | "closed";

export type AgentRole =
  | "coding"
  | "sde"
  | "review"
  | "orchestrator"
  | "custom"
  | "sub_agent";

export type LinkedSessionType = "native" | "cli";

export type LinkedSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface LinkedSession {
  session_id: string;
  session_type: LinkedSessionType;
  agent_role: AgentRole;
  started_at: string;
  completed_at?: string;
  status: LinkedSessionStatus;
  cost_usd: number;
  total_tokens: number;
  parent_session_id?: string;
  sub_agent_name?: string;
  sub_agent_instance?: number;
  result_preview?: string;
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  lines_added: number;
  lines_removed: number;
  old_path?: string;
}

export interface DiffStats {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  files?: FileChange[];
}

export interface TestResults {
  passed: number;
  failed: number;
  coverage_delta?: string;
}

export type ReviewCommentSeverity =
  | "error"
  | "warning"
  | "suggestion"
  | "praise";

export interface ReviewComment {
  file_path?: string;
  line?: number;
  severity: ReviewCommentSeverity;
  message: string;
}

export type ResolutionStatus = "fixed" | "not_fixed" | "partially_fixed";

export interface ResolvedFromPrevious {
  round: number;
  comment_index: number;
  status: ResolutionStatus;
}

export interface ReviewFeedback {
  outcome: ReviewOutcome;
  summary: string;
  comments: ReviewComment[];
  session_id: string;
  reviewed_at: string;
  resolved_from_previous?: ResolvedFromPrevious[];
}

export interface ProofOfWork {
  branch?: string;
  pr_url?: string;
  pr_status?: PrStatus;
  diff_stats?: DiffStats;
  test_results?: TestResults;
  review_outcome?: ReviewOutcome;
  review_feedback?: ReviewFeedback;
  review_history?: ReviewFeedback[];
  total_cost_usd: number;
  total_tokens: number;
}

export type ReviewerRefType = "agent" | "org" | "human" | "self_review";

export interface ReviewerRef {
  type: ReviewerRefType;
  id?: string;
}

export interface ReviewConfig {
  reviewer: ReviewerRef;
  max_rounds: number;
  model_id?: string;
  account_id?: string;
}

export interface OrchestratorConfig {
  /** @deprecated Use review_config instead */
  review_enabled: boolean;
  review_config?: ReviewConfig;
  follow_up_enabled: boolean;
  auto_retry_on_failure: boolean;
  max_retry_count: number;
  auto_create_pr: boolean;
  selected_account_id?: string;
  selected_model_id?: string;
  sub_agent_ids?: string[];
  org_id?: string;
  agent_mode?: string;
  agent_definition_id?: string;
  worktree_path?: string;
  workspace_mode?: "local_workspace" | "worktree";
}

export interface LastFailure {
  session_id?: string;
  reason?: string;
  timestamp?: string;
}

export interface OrchestratorState {
  current_phase: OrchestratorPhase;
  retry_count: number;
  review_round: number;
  last_failure?: LastFailure;
  interrupted: boolean;
  interrupted_phase?: OrchestratorPhase;
  active_config?: OrchestratorConfig;
}

export interface FollowUpRef {
  short_id: string;
  reason?: string;
}

export interface AgentDefaults {
  orchestrator_config: OrchestratorConfig;
}
