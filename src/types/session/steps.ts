export interface WsSpec {
  session_id: string;
  spec: string;
  created_time: string;
  spec_id: string;
  content?: string;
  observation_watermark?: string;
  status?: string;
  step_id?: string | null;
}

/**
 * BackendEvent - Event format from backend API/WebSocket
 *
 * This is the EXTERNAL format that arrives from:
 * - REST API: GET /api/v2/sessions/{id}/activity
 * - WebSocket: session.activity messages
 *
 * Converted to SessionEvent at ingestion boundary via normalizeChunk().
 * Internal code should use SessionEvent, not BackendEvent.
 */
export interface BackendEvent {
  /** Unique identifier - the original chunk_id from backend */
  chunk_id: string;
  /** Session this event belongs to */
  session_id: string;
  /** Event type (action_type from backend) */
  type: string;
  /** Function/tool name */
  function: string;
  /** Function arguments */
  args: Record<string, string>;
  /** Status history */
  status: Record<string, string>;
  /** Event result */
  result: unknown;
  /** Additional metadata */
  event_metadata: Record<string, unknown>;
  /** Event source (e.g., "assistant", "user") */
  source: string;
  /** Creation timestamp */
  created_time: string;
}

export interface GithubIssue {
  chunk_id: string;
  session_id: string;
  issue_id: number;
  title: string;
  body: string;
  state: string;
  user: string;
  created_at: string;
  updated_at: string;
  comments_url: string;
  html_url: string;
  labels: string;
}

export interface SessionConfig {
  feedback_wait_time_minutes: number;
  thought_action_wait_time_seconds: number;
  model_for_reasoning: string;
  model_for_coding: string;
  auto_retrieval_enabled: boolean;
  package_installation_allowed: boolean;
  ide_extensions: Record<string, unknown>;
  github_token_enable: boolean;
}
export interface WpSessionConfig {
  cur: SessionConfig | undefined;
  origin: SessionConfig | undefined;
}

export interface WpApiKey {
  chunk_id: string;
  api_key: string;
  description: string;
}
export interface WpApiKeyList {
  cur: WpApiKey[];
  origin: WpApiKey[];
}

export interface ContextAddMap {
  init_tab: string;
  follow_tab_add: string;
  follow_tab_load: string;
}
export interface WpWebItem {
  chunk_id: string;
  link: string;
  description: string;
}

export interface WpSnapShot {
  snapshot_id: string;
  session_id: string;
  created_time: string;
  snapshot_path: string;
  title: string;
}

export interface FileEdits {
  session_id?: string;
  added: number;
  deleted: number;
  modified: number;
}

export interface FeedBackInfo {
  isFeedBack: boolean;
  info?: Record<string, unknown>;
  callback?: () => void;
}

export interface ReviewItem {
  type: string;
  displayd_type: string;
  item_id: string;
  item_title: string;
}
export interface Artifact {
  artifact_type: string;
  artifact_id: string;
  review_items: ReviewItem[];
  title?: string;
}

// Git Action Types

// ============================================================================
// Git API Types
// ============================================================================

// File status codes as per Git spec
export type GitFileStatusCode =
  | "M" // Modified
  | "A" // Added
  | "D" // Deleted
  | "R" // Renamed
  | "C" // Copied
  | "U" // Unmerged (conflict)
  | "?" // Untracked
  | "!"; // Ignored

// File in working directory
export interface GitWorkingDirectoryFile {
  path: string;
  status: GitFileStatusCode;
  staged: boolean;
  original_path: string | null; // For renamed files
}

// Working directory status
export interface GitWorkingDirectory {
  files: GitWorkingDirectoryFile[];
  staged_count?: number;
  unstaged_count?: number;
  untracked_count?: number;
}

// Branch ahead/behind counts
export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

// Full repository status
export interface GitRepositoryStatus {
  current_branch: string;
  current_upstream_branch: string | null;
  current_tip: string;
  branch_ahead_behind: GitAheadBehind | null;
  exists: boolean;
  merge_head_found: boolean;
  squash_msg_found: boolean;
  rebase_in_progress: boolean;
  cherry_pick_in_progress: boolean;
  working_directory: GitWorkingDirectory;
  do_conflicted_files_exist: boolean;
}

// Branch information
export interface GitBranchInfo {
  name: string;
  upstream: string | null;
  tip_sha: string;
  branch_type: "local" | "remote";
  ref: string;
  is_current: boolean;
  last_commit_date: string;
}

export interface GitBranchesResponse {
  status: number;
  data: {
    branches: GitBranchInfo[];
    current_branch: string;
  };
}

export interface GitCommitPerson {
  name: string;
  email: string;
  date: string;
}

export interface GitCommitInfo {
  sha: string;
  short_sha: string;
  summary: string;
  body: string;
  author: GitCommitPerson;
  committer: GitCommitPerson;
  parent_shas: string[];
}

export interface GitCommitsResponse {
  status: number;
  data: {
    commits: GitCommitInfo[];
    total_count: number | null;
  };
}

// Remote information
export interface GitRemoteInfo {
  name: string;
  url: string;
  fetch_url: string;
  push_url: string;
}

export interface GitRemotesResponse {
  status: number;
  data: {
    remotes: GitRemoteInfo[];
  };
}

// Suggested action type
export type GitSuggestedActionType =
  | "pull"
  | "push"
  | "publish_repository"
  | "publish_branch"
  | "create_pr"
  | "commit"
  | "none";

export interface GitSuggestedAction {
  action: GitSuggestedActionType;
  reason: string;
  description?: string; // Optional second-line contextual info (no numbers)
  details: Record<string, unknown>;
}

export interface GitSuggestedActionResponse {
  status: number;
  data: GitSuggestedAction;
}

// Git operation responses
export interface GitOperationResult {
  message: string;
}

// ============================================
// Cursor History Types
// ============================================
