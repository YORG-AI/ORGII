//! Data shapes exchanged with callers of the worktree module: worktree
//! descriptors, merge status, and the session-worktree state snapshot.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ============================================
// Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    /// `None` when the info was reconstructed from `git worktree list` (porcelain
    /// output does not include the base ref). Always `Some` when returned by
    /// `create_session_worktree` or `create_linked_worktree`.
    pub base_branch: Option<String>,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedWorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head_sha: String,
}

// `MergeStrategy` and `WorktreeMergeResult` are pure data and live in
// `core_types` so that downstream crates (notably `agent_sessions`) can
// reference them without depending on the `git` module. Re-exported
// here so existing `crate::worktree::MergeStrategy` paths still
// resolve.
pub use core_types::worktree::{MergeStrategy, WorktreeMergeResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeMergeStatus {
    Pending,
    Merged,
    Conflict,
    Skipped,
    Failed,
}

impl std::fmt::Display for WorktreeMergeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Pending => "pending",
            Self::Merged => "merged",
            Self::Conflict => "conflict",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        })
    }
}

impl WorktreeMergeStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "merged" => Some(Self::Merged),
            "conflict" => Some(Self::Conflict),
            "skipped" => Some(Self::Skipped),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Snapshot of a session worktree's unmerged work, used to decide whether
/// post-run cleanup may destroy it (see the agent tool's worktree
/// disposition: keep when dirty/ahead, remove only when clean).
#[derive(Debug, Clone)]
pub struct SessionWorktreeState {
    pub worktree_path: PathBuf,
    pub branch: String,
    pub worktree_exists: bool,
    /// Uncommitted changes in the worktree (`git status --porcelain`).
    pub dirty: bool,
    /// Commits on the session branch that are not on the base branch.
    /// Always 0 when the caller does not know the base branch.
    pub commits_ahead_of_base: u64,
}

impl SessionWorktreeState {
    /// True when removing the worktree + branch would destroy work.
    pub fn has_changes(&self) -> bool {
        self.dirty || self.commits_ahead_of_base > 0
    }
}

/// Entry from `git worktree list` for the general (non-agent) listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralWorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head_sha: String,
    pub is_main: bool,
}
