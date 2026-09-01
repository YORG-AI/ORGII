//! Worktree creation: the explicit-branch linked worktree and the
//! per-agent-session worktree (including limit enforcement and stale-state
//! cleanup before `git worktree add`).

use std::path::Path;

use tracing::{error, info};

use super::git_cmd::{current_head_ref, git_stderr, git_stdout, run_git};
use super::paths::session_worktree_dir;
use super::setup_hooks::run_worktree_setup_hooks;
use super::{
    list_session_worktrees, session_branch_name, validate_session_id, LinkedWorktreeInfo,
    WorktreeInfo,
};

/// Fallback used when the caller does not supply a configurable limit.
const DEFAULT_MAX_CONCURRENT_WORKTREES: usize = 8;

// ============================================
// Public API
// ============================================

/// Create a linked worktree for an explicit branch name.
///
/// Unlike [`create_session_worktree`], this is not tied to an agent session:
/// the caller supplies the branch and target path. Existing local branches are
/// reused; otherwise a new branch is created from `base_ref` (or `HEAD`).
pub fn create_linked_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
    base_ref: Option<&str>,
) -> Result<LinkedWorktreeInfo, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch cannot be empty".to_string());
    }
    let path_string = worktree_path.to_string_lossy().to_string();
    if worktree_path.exists() {
        return Err(format!("Worktree path already exists: {}", path_string));
    }
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create worktree parent dir: {}", err))?;
    }

    let branch_exists = run_git(repo_path, &["rev-parse", "--verify", branch])
        .map(|output| output.status.success())
        .unwrap_or(false);
    let output = if branch_exists {
        run_git(repo_path, &["worktree", "add", &path_string, branch])?
    } else {
        run_git(
            repo_path,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                &path_string,
                base_ref.unwrap_or("HEAD"),
            ],
        )?
    };

    if !output.status.success() {
        return Err(format!("git worktree add failed: {}", git_stderr(&output)));
    }

    if let Err(err) = run_worktree_setup_hooks(repo_path, worktree_path) {
        let _ = run_git(repo_path, &["worktree", "remove", "--force", &path_string]);
        if !branch_exists {
            let _ = run_git(repo_path, &["branch", "-D", branch]);
        }
        return Err(err);
    }

    let head_sha = run_git(worktree_path, &["rev-parse", "HEAD"])
        .map(|output| git_stdout(&output))
        .unwrap_or_default();
    Ok(LinkedWorktreeInfo {
        path: path_string,
        branch: branch.to_string(),
        head_sha,
    })
}

/// Create an isolated worktree for a coding agent session.
///
/// Creates a new branch from `base_branch` (or current HEAD) and sets up
/// a worktree at `~/.orgii/agent-worktrees/{repo-hash}/{session-id}/`.
///
/// `max_count` — caller-supplied limit from `git.worktree.maxCount`.
/// Falls back to `DEFAULT_MAX_CONCURRENT_WORKTREES` when `None`.
pub fn create_session_worktree(
    repo_path: &Path,
    session_id: &str,
    base_branch: Option<&str>,
    max_count: Option<usize>,
) -> Result<WorktreeInfo, String> {
    validate_session_id(session_id)?;
    let repo_str = repo_path.to_string_lossy().to_string();
    let wt_path = session_worktree_dir(&repo_str, session_id);
    let branch = session_branch_name(session_id);

    // Enforce configurable max concurrent worktrees for this repo
    let limit = max_count.unwrap_or(DEFAULT_MAX_CONCURRENT_WORKTREES);
    let existing = list_session_worktrees(repo_path)?;
    if existing.len() >= limit {
        return Err(format!(
            "Maximum concurrent worktrees ({limit}) reached for this repo. \
             Merge or discard existing sessions first."
        ));
    }

    // Determine base branch
    let base = match base_branch {
        Some(b) => b.to_string(),
        None => current_head_ref(repo_path)?,
    };

    // Clean up stale worktree if path exists but isn't registered
    if wt_path.exists() {
        info!(
            "[worktree] Cleaning up stale worktree directory: {}",
            wt_path.display()
        );
        let _ = run_git(repo_path, &["worktree", "prune"]);
        if wt_path.exists() {
            std::fs::remove_dir_all(&wt_path)
                .map_err(|err| format!("Failed to remove stale worktree: {}", err))?;
        }
    }

    // Delete branch if it exists (stale from previous run)
    let branch_check = run_git(repo_path, &["rev-parse", "--verify", &branch]);
    if let Ok(ref output) = branch_check {
        if output.status.success() {
            info!("[worktree] Deleting stale branch: {}", branch);
            let _ = run_git(repo_path, &["branch", "-D", &branch]);
        }
    }

    // Create parent directory
    if let Some(parent) = wt_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create worktree parent dir: {}", err))?;
    }

    // Create worktree with new branch
    let wt_path_str = wt_path.to_string_lossy().to_string();
    let output = run_git(
        repo_path,
        &["worktree", "add", "-b", &branch, &wt_path_str, &base],
    )?;

    if !output.status.success() {
        let stderr = git_stderr(&output);
        error!("[worktree] Failed to create worktree: {}", stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    info!(
        "[worktree] Created worktree for session {} at {} (branch: {}, base: {})",
        session_id,
        wt_path.display(),
        branch,
        base
    );

    if let Err(err) = run_worktree_setup_hooks(repo_path, &wt_path) {
        let _ = run_git(repo_path, &["worktree", "remove", "--force", &wt_path_str]);
        let _ = run_git(repo_path, &["branch", "-D", &branch]);
        return Err(err);
    }

    Ok(WorktreeInfo {
        path: wt_path_str,
        branch,
        base_branch: Some(base),
        session_id: session_id.to_string(),
    })
}
