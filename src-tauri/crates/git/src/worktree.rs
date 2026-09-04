//! Git worktree manager for parallel coding agent sessions.
//!
//! Each coding session that requests isolation gets its own git worktree on a
//! dedicated branch. This prevents concurrent sessions from conflicting on the
//! same working directory. Worktrees live under `~/.orgii/agent-worktrees/`.
//!
//! The hash-naming pattern keeps each worktree dir unique per repo path.
//!
//! The implementation is split across the submodules below; this file is the
//! facade that keeps every `crate::worktree::*` / `git::worktree::*` path
//! resolving as before.

mod create;
mod git_cmd;
mod inspect;
mod list;
mod merge;
mod paths;
mod porcelain;
mod remove;
mod setup_command;
mod setup_hooks;
mod types;

pub use types::{
    GeneralWorktreeEntry, LinkedWorktreeInfo, MergeStrategy, SessionWorktreeState, WorktreeInfo,
    WorktreeMergeResult, WorktreeMergeStatus,
};

pub use create::{create_linked_worktree, create_session_worktree};
pub use inspect::{get_session_diff, session_worktree_state};
pub use list::{list_all_worktrees, list_session_worktrees, validate_existing_worktree};
pub use merge::{commit_worktree_changes, merge_session_worktree};
pub use remove::{
    cleanup_all_worktrees, prune_stale_worktrees, remove_session_worktree, remove_worktree_path,
};

pub(crate) use paths::{repo_hash, session_branch_name, validate_session_id};
pub(crate) use porcelain::parse_worktree_list_porcelain;
pub(crate) use setup_command::run_worktree_setup_command_with_timeout;
