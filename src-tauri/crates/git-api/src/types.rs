//! Git HTTP API types — request/response and shared value objects
//!
//! All types derive `utoipa::ToSchema` for automatic OpenAPI generation.
//! Covers: git status, diff, branches, commits, remotes, stash, merge state.
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ============================================
// Git Status Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitStatus {
    pub current_branch: String,
    pub current_upstream_branch: Option<String>,
    pub current_tip: String,
    pub branch_ahead_behind: Option<AheadBehind>,
    pub exists: bool,
    pub merge_head_found: bool,
    pub squash_msg_found: bool,
    pub rebase_in_progress: bool,
    pub cherry_pick_in_progress: bool,
    pub working_directory: WorkingDirectory,
    pub do_conflicted_files_exist: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkingDirectory {
    pub files: Vec<WorkingDirectoryFile>,
    // Counts for quick access (computed from files array or git status)
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
}

/// OpenAPI-facing mirror of [`git::types::WorkingDirectoryFile`].
///
/// The pure-data struct lives in the `git` module so that `git/` does not
/// pull `utoipa`. This parallel struct adds `ToSchema` for OpenAPI generation
/// and `From` conversions in both directions.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkingDirectoryFile {
    pub path: String,
    #[schema(example = "M")]
    pub status: String, // M, A, D, R, C, U, ?, !
    pub staged: bool,
    pub original_path: Option<String>,
}

impl From<git::types::WorkingDirectoryFile> for WorkingDirectoryFile {
    fn from(value: git::types::WorkingDirectoryFile) -> Self {
        Self {
            path: value.path,
            status: value.status,
            staged: value.staged,
            original_path: value.original_path,
        }
    }
}

impl From<WorkingDirectoryFile> for git::types::WorkingDirectoryFile {
    fn from(value: WorkingDirectoryFile) -> Self {
        Self {
            path: value.path,
            status: value.status,
            staged: value.staged,
            original_path: value.original_path,
        }
    }
}

// ============================================
// Branch Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitBranchInfo {
    pub name: String,
    pub upstream: Option<String>,
    pub tip_sha: String,
    pub branch_type: String, // "local" or "remote"
    #[serde(rename = "ref")]
    pub ref_name: String, // e.g., "refs/heads/main"
    pub is_current: bool,
    pub last_commit_date: Option<String>, // ISO 8601 format
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitBranchesData {
    pub branches: Vec<GitBranchInfo>,
    pub current_branch: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BranchesResponse {
    pub status: i32,
    pub data: GitBranchesData,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CurrentBranchResponse {
    pub status: i32,
    pub data: GitBranchInfo,
}

/// Fast response for current branch name only (no full branch info)
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitCurrentBranchName {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CurrentBranchNameResponse {
    pub status: i32,
    pub data: GitCurrentBranchName,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GitRemotesData {
    pub remotes: Vec<GitRemoteInfo>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RemotesResponse {
    pub status: i32,
    pub data: GitRemotesData,
}

// ============================================
// Commit Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitCommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
    pub body: String,
    pub author: GitCommitAuthor,
    pub committer: GitCommitAuthor,
    pub parent_shas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitCommitAuthor {
    pub name: String,
    pub email: String,
    pub date: String, // ISO 8601 format
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitCommitsData {
    pub commits: Vec<GitCommitInfo>,
    pub total_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CommitsResponse {
    pub status: i32,
    pub data: GitCommitsData,
}

// ============================================
// Remote Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitRemoteInfo {
    pub name: String,
    pub url: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
}

// ============================================
// Git Error Types (for dialogs)
// ============================================

/// Error types that can be detected and shown in dialogs
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum GitErrorType {
    /// No error
    #[default]
    None,
    /// Remote has commits that local doesn't have (push rejected)
    NonFastForward,
    /// Target branch is protected
    ProtectedBranch,
    /// Authentication failed
    AuthenticationFailed,
    /// Remote branch was deleted
    RemoteBranchDeleted,
    /// Local uncommitted changes would be overwritten
    UncommittedChanges,
    /// Network/connection error
    NetworkError,
    /// Merge conflicts occurred
    MergeConflicts,
    /// Permission denied
    PermissionDenied,
    /// Generic/unknown error
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitFetchResult {
    pub success: bool,
    pub message: String,
    /// Detected error type for frontend dialog handling
    #[serde(default)]
    pub error_type: GitErrorType,
    /// Branches that were deleted on remote (detected during prune)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_branches: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitPushResult {
    pub success: bool,
    pub message: String,
    /// Detected error type for frontend dialog handling
    #[serde(default)]
    pub error_type: GitErrorType,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitPullResult {
    pub success: bool,
    pub message: String,
    pub conflicts: Option<Vec<String>>,
    /// Detected error type for frontend dialog handling
    #[serde(default)]
    pub error_type: GitErrorType,
    /// Files that would be overwritten (for uncommitted changes error)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_files: Option<Vec<String>>,
}

// ============================================
// Request Types
// ============================================
// Note: Suggested action is now computed on the frontend (see GitStatusContext.tsx)

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CommitRequest {
    pub message: String,
    pub description: Option<String>,
    pub stage_all: bool,
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub coauthor: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct StageFilesRequest {
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PushRequest {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub set_upstream: bool,
    pub force: bool,
    #[serde(default)]
    pub auth_username: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub store_auth: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PullRequest {
    pub remote: Option<String>,
    pub branch: Option<String>,
    /// Pull strategy: "merge" (default), "rebase", or "ff-only"
    #[serde(default)]
    pub strategy: Option<String>,
    #[serde(default)]
    pub auth_username: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub store_auth: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct FetchRequest {
    pub remote: Option<String>,
    pub prune: bool,
    #[serde(default)]
    pub auth_username: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub store_auth: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct GitCredentialFillRequest {
    pub remote_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitCredentialFillResult {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GitCredentialFillResponse {
    pub status: i32,
    pub data: GitCredentialFillResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateBranchRequest {
    pub name: String,
    #[serde(default)]
    pub start_point: Option<String>,
    #[serde(default)]
    pub checkout: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CheckoutRequest {
    pub ref_name: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RenameBranchRequest {
    pub old_name: Option<String>,
    pub new_name: String,
    #[serde(default)]
    pub force: bool,
}

// ============================================
// Response Wrappers (Concrete types for OpenAPI)
// ============================================

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GitStatusResponse {
    pub status: i32,
    pub data: GitStatus,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AheadBehindResponse {
    pub status: i32,
    pub data: AheadBehind,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorktreeDiffSummary {
    pub total_files: u32,
    pub total_additions: u32,
    pub total_deletions: u32,
    pub committed_files: u32,
    pub committed_additions: u32,
    pub committed_deletions: u32,
    pub uncommitted_files: u32,
    pub uncommitted_additions: u32,
    pub uncommitted_deletions: u32,
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head_sha: String,
    pub is_main: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_summary: Option<WorktreeDiffSummary>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateWorktreeRequest {
    pub worktree_path: String,
    pub branch: String,
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RemoveWorktreeRequest {
    pub worktree_path: String,
    #[serde(default = "default_force_remove_worktree")]
    pub force: bool,
}

fn default_force_remove_worktree() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorktreeListResponse {
    pub status: i32,
    pub data: Vec<WorktreeEntry>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorktreeRemoveResponse {
    pub status: i32,
    pub data: WorktreeEntry,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ApiError {
    pub error: String,
    pub error_type: String,
    pub details: Option<String>,
}

// ============================================
// File Content Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitFileContentResult {
    pub content: String,
    pub encoding: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub file_path: String,
    pub size: usize,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileContentResponse {
    pub status: i32,
    pub data: GitFileContentResult,
}

// ============================================
// Stash Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GitStashListData {
    pub stashes: Vec<StashEntry>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct StashListResponse {
    pub status: i32,
    pub data: GitStashListData,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitStashResult {
    pub success: bool,
    pub message: String,
    pub stash_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct StashResultResponse {
    pub status: i32,
    pub data: GitStashResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct StashPushRequest {
    pub files: Option<Vec<String>>,
    pub message: Option<String>,
    pub include_untracked: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct StashApplyRequest {
    pub index: u32,
    pub pop: bool,
}

// ============================================
// Merge/Rebase/Cherry-pick Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitMergeResult {
    pub success: bool,
    pub message: String,
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MergeResultResponse {
    pub status: i32,
    pub data: GitMergeResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct MergeRequest {
    pub branch: String,
    pub no_ff: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitRebaseResult {
    pub success: bool,
    pub message: String,
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RebaseResultResponse {
    pub status: i32,
    pub data: GitRebaseResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RebaseRequest {
    pub upstream: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitCherryPickResult {
    pub success: bool,
    pub message: String,
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CherryPickResultResponse {
    pub status: i32,
    pub data: GitCherryPickResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CherryPickRequest {
    pub commit: String,
    pub no_commit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitRevertResult {
    pub success: bool,
    pub message: String,
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RevertResultResponse {
    pub status: i32,
    pub data: GitRevertResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RevertRequest {
    pub commit: String,
    pub no_commit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitResetResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResetResultResponse {
    pub status: i32,
    pub data: GitResetResult,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ResetRequest {
    #[serde(rename = "ref")]
    pub target_ref: String,
    pub mode: String, // "soft", "mixed", "hard"
}

// ============================================
// Remote Management Request Types
// ============================================

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AddRemoteRequest {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateRemoteRequest {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RemoteInfoResponse {
    pub status: i32,
    pub data: GitRemoteInfo,
}

// ============================================
// Discard Changes Request
// ============================================

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct DiscardChangesRequest {
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ResolveConflictRequest {
    pub file: String,
    pub strategy: String,
}

// ============================================
// Legacy Diff Types (for simple diff stat APIs)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DiffFileStat {
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
}

// ============================================
// Amend Commit Request
// ============================================

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AmendCommitRequest {
    pub message: Option<String>,
    pub files: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CommitInfoResponse {
    pub status: i32,
    pub data: GitCommitInfo,
}

// ============================================
// Diff Types (for file/staged/commit diffs)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DiffLineType(pub String); // "context", "addition", "deletion"

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DiffLine {
    #[serde(rename = "type")]
    pub line_type: String, // "context", "addition", "deletion"
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

/// Git diff hunk for HTTP API responses
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitDiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// Git diff statistics for HTTP API responses
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitDiffStats {
    pub insertions: u32,
    pub deletions: u32,
    pub files_changed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileDiffResult {
    pub file_path: String,
    pub old_path: Option<String>,
    pub status: String, // "added", "modified", "deleted", "renamed", "copied"
    pub hunks: Vec<GitDiffHunk>,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileDiffResponse {
    pub status: i32,
    pub data: FileDiffResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BatchFileDiffResult {
    pub files: Vec<FileDiffResult>,
    pub stats: GitDiffStats,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BatchFileDiffResponse {
    pub status: i32,
    pub data: BatchFileDiffResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileNumstat {
    pub path: String,
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DiffNumstatResult {
    pub files: Vec<FileNumstat>,
    pub total_insertions: u32,
    pub total_deletions: u32,
    pub files_changed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommitDiffResult {
    pub commit_sha: String,
    pub short_sha: String,
    pub parent_sha: Option<String>,
    pub parent_shas: Vec<String>,
    pub selected_parent_index: Option<usize>,
    pub parent_mode: String,
    pub summary: String,
    pub body: String,
    pub author: Option<GitCommitAuthor>,
    pub committer: Option<GitCommitAuthor>,
    pub files: Vec<FileDiffResult>,
    pub stats: GitDiffStats,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CommitDiffResponse {
    pub status: i32,
    pub data: CommitDiffResult,
}

// ============================================
// Blame Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitBlameLineInfo {
    pub line_number: u32,
    pub content: String,
    pub commit_sha: String,
    pub short_sha: String,
    pub author: String,
    pub author_email: String,
    pub author_time: String,
    pub summary: String,
    pub original_line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitBlameResult {
    pub file_path: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub lines: Vec<GitBlameLineInfo>,
    pub total_lines: u32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BlameResponse {
    pub status: i32,
    pub data: GitBlameResult,
}

// ============================================
// Request Types for Diff
// ============================================

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct BatchFileDiffRequest {
    pub file_paths: Vec<String>,
    /// Map of new_path -> original_path for renamed files.
    /// Used to read old content from the original location in HEAD.
    #[serde(default)]
    pub original_paths: Option<std::collections::HashMap<String, String>>,
    pub from_ref: Option<String>,
    pub to_ref: Option<String>,
    pub context_lines: Option<u32>,
}
