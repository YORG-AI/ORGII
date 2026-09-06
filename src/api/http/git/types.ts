/**
 * Git API Types
 *
 * All type definitions for the Git API endpoints.
 */

// ============================================================================
// Error Types - Structured Git Errors
// ============================================================================

export type GitErrorType =
  | "local_changes_overwritten"
  | "merge_conflicts"
  | "rebase_conflicts"
  | "cherry_pick_conflicts"
  | "push_not_fast_forward"
  | "push_rejected"
  | "auth_failed"
  | "repo_not_found"
  | "branch_not_found"
  | "branch_already_exists"
  | "not_a_git_repo"
  | "detached_head"
  | "unresolved_conflicts"
  | "lock_file_exists"
  | "network_error"
  | "permission_denied"
  | "stash_exists"
  | "no_changes"
  | "unknown";

export interface GitError {
  error_type: GitErrorType;
  message: string;
  files_affected?: string[];
  can_stash_and_retry?: boolean;
  has_existing_stash?: boolean;
}

// ============================================================================
// Status Types
// ============================================================================

// File status in working directory
export interface GitWorkingDirectoryFile {
  path: string;
  status: "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!"; // Modified, Added, Deleted, Renamed, Copied, Unmerged, Untracked, Ignored
  staged: boolean;
  original_path: string | null; // For renamed files
}

// Working directory status
export interface GitWorkingDirectory {
  files: GitWorkingDirectoryFile[];
  // Counts for quick access (computed from files array or git status)
  staged_count?: number;
  unstaged_count?: number;
  untracked_count?: number;
}

// Branch ahead/behind counts
export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

// Full repository status response
export interface GitStatusData {
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

// ============================================================================
// Branch Types
// ============================================================================

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

// Ahead/behind response

// Default branch response

// Python backend branch types

// ============================================================================
// Commit Types
// ============================================================================

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

export interface GitCommitResultFull {
  success: boolean;
  sha: string | null;
  short_sha: string | null;
  message: string | null;
  files_committed: number;
  error?: GitError | null;
}

export interface GitCommitResponse {
  status: number;
  data: GitCommitResultFull;
}

// ============================================================================
// Remote Types
// ============================================================================

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

export interface GitCredentialFillResponse {
  status: number;
  data: {
    found: boolean;
    username?: string;
    password?: string;
  };
}

// ============================================================================
// Suggested Action Types
// ============================================================================

export type GitSuggestedActionType =
  | "pull"
  | "push"
  | "publish_repository"
  | "publish_branch"
  | "create_pr"
  | "commit"
  | "none";

export interface GitSuggestedActionData {
  action: GitSuggestedActionType;
  reason: string;
  details: Record<string, unknown>;
}

export interface GitSuggestedActionResponse {
  status: number;
  data: GitSuggestedActionData;
}

// ============================================================================
// Operation Response Types
// ============================================================================

export interface GitOperationResponse {
  status: number;
  data: {
    success: boolean;
    message: string;
    error_type: import("./streaming").GitErrorType;
  };
}

export interface GitPullResponse {
  status: number;
  data: {
    success: boolean;
    message: string;
    conflicts: string[] | null;
    error_type: import("./streaming").GitErrorType;
  };
}

// ============================================================================
// File Content Types
// ============================================================================

export interface GitFileContentResult {
  content: string;
  encoding: string;
  ref: string;
  file_path: string;
  size: number;
  exists: boolean;
}

// ============================================================================
// Diff Types
// ============================================================================

// Diff line types - API returns "deletion" not "removal"
export type GitDiffLineType = "context" | "addition" | "deletion";

export interface GitDiffLine {
  type: GitDiffLineType;
  content: string;
  // API uses old_line_number/new_line_number
  old_line_number: number | null;
  new_line_number: number | null;
  // Alternate field names (some older code may use these)
  old_line?: number | null;
  new_line?: number | null;
}

export interface GitDiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: GitDiffLine[];
}

export interface GitDiffStats {
  insertions: number;
  deletions: number;
  files_changed: number;
}

export type GitFileDiffStatus = "modified" | "added" | "deleted" | "renamed";

export interface GitFileDiffResult {
  file_path: string;
  old_path: string | null;
  status: GitFileDiffStatus;
  old_content: string;
  new_content: string;
  /** Flat fields from Rust — no nested stats object */
  insertions: number;
  deletions: number;
  hunks: GitDiffHunk[];
  binary: boolean;
}

// Batch file diff input - supports renamed files with original_path
export interface GitBatchFileDiffInput {
  /** Current file path */
  path: string;
  /** Original file path for renamed files (used to fetch old content) */
  original_path?: string | null;
}

// Batch file diff
// Note: Rust backend returns "files" field, matching the Rust struct
export interface GitBatchFileDiffResult {
  files: GitFileDiffResult[];
  stats?: {
    insertions: number;
    deletions: number;
    files_changed: number;
  };
}

// Diff summary
export interface GitDiffSummaryFile {
  path: string;
  status: GitFileDiffStatus;
  additions: number;
  deletions: number;
  is_binary: boolean;
}

export interface GitDiffSummaryResult {
  total_files: number;
  total_additions: number;
  total_deletions: number;
  files: GitDiffSummaryFile[];
}

// Per-file numstat (lightweight — no content)
export interface GitFileNumstat {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitDiffNumstatResult {
  files: GitFileNumstat[];
  total_insertions: number;
  total_deletions: number;
  files_changed: number;
}

/**
 * Combined numstat result for both staged and unstaged changes.
 * Returned by the numstat-combined endpoint (performance optimization).
 */
export interface GitDiffNumstatCombinedResult {
  /** Per-file stats with merged staged+unstaged counts */
  files: GitFileNumstat[];
  /** Total insertions (staged + unstaged) */
  totalInsertions: number;
  /** Total deletions (staged + unstaged) */
  totalDeletions: number;
  /** Total files changed */
  filesChanged: number;
}

// Commit diff
export interface CommitDiffResult {
  commit_sha: string;
  short_sha: string;
  parent_sha: string | null;
  parent_shas: string[];
  selected_parent_index: number | null;
  parent_mode: string;
  summary: string;
  body: string;
  author: GitCommitPerson | null;
  committer: GitCommitPerson | null;
  files: GitFileDiffResult[];
  stats: GitDiffStats;
}

// ============================================================================
// Stash Types
// ============================================================================

export interface StashEntry {
  index: number;
  message: string;
  branch: string | null;
  commit_sha: string | null;
}

export interface StashList {
  stashes: StashEntry[];
}

export interface StashResult {
  success: boolean;
  message: string;
  stash_ref: string | null;
}

// ============================================================================
// Worktree Types
// ============================================================================

export interface GitWorktreeDiffSummary {
  total_files: number;
  total_additions: number;
  total_deletions: number;
  committed_files: number;
  committed_additions: number;
  committed_deletions: number;
  uncommitted_files: number;
  uncommitted_additions: number;
  uncommitted_deletions: number;
  base_ref?: string | null;
}

export interface GitWorktreeEntry {
  path: string;
  branch: string;
  head_sha: string;
  is_main: boolean;
  diff_summary?: GitWorktreeDiffSummary | null;
}

// ============================================================================
// Staging Types
// ============================================================================

export interface FileOperationResult {
  success: boolean;
  message: string;
  files_affected: number;
  error?: GitError | null;
}

// ============================================================================
// Merge Types
// ============================================================================

export interface MergeResult {
  success: boolean;
  message: string;
  has_conflicts: boolean;
  conflicted_files: string[];
  commit_sha: string | null;
  error?: GitError | null;
}

// ============================================================================
// Rebase Types
// ============================================================================

export interface RebaseResult {
  success: boolean;
  message: string;
  has_conflicts: boolean;
  conflicted_files: string[];
  commits_rebased: number;
  error?: GitError | null;
}

// ============================================================================
// Cherry-pick Types
// ============================================================================

export interface CherryPickResult {
  success: boolean;
  message: string;
  has_conflicts: boolean;
  conflicted_files: string[];
  commit_sha: string | null;
  error?: GitError | null;
}

// ============================================================================
// Revert Types
// ============================================================================

export interface RevertResult {
  success: boolean;
  message: string;
  has_conflicts: boolean;
  conflicted_files: string[];
  commit_sha: string | null;
  error?: GitError | null;
}

// ============================================================================
// Reset Types
// ============================================================================

export type ResetMode = "soft" | "mixed" | "hard";

export interface ResetResult {
  success: boolean;
  message: string;
  previous_head: string | null;
  new_head: string | null;
  error?: GitError | null;
}

// ============================================================================
// Blame Types
// ============================================================================

export interface BlameLine {
  line_number: number;
  content: string;
  commit_sha: string;
  short_sha: string;
  author: string;
  author_email: string;
  author_time: string;
  summary: string;
  original_line: number;
}

export interface BlameResult {
  file_path: string;
  ref: string;
  lines: BlameLine[];
  total_lines: number;
}
