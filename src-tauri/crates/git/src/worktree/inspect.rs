//! Read-only queries about a session worktree: its unmerged-work snapshot and
//! the diff against its base branch.

use std::path::Path;

use super::git_cmd::{git_stderr, git_stdout, is_working_dir_clean, run_git};
use super::paths::session_worktree_dir;
use super::{session_branch_name, validate_session_id, SessionWorktreeState};

/// Inspect a session worktree for unmerged work: uncommitted file state
/// and commits ahead of `base_branch` (when known). A missing worktree
/// directory reports `worktree_exists: false` with `dirty: false`; the
/// ahead-count is still computed so a manually pruned worktree with a
/// surviving committed branch is not treated as clean.
pub fn session_worktree_state(
    repo_path: &Path,
    session_id: &str,
    base_branch: Option<&str>,
) -> Result<SessionWorktreeState, String> {
    validate_session_id(session_id)?;
    let repo_str = repo_path.to_string_lossy().to_string();
    let worktree_path = session_worktree_dir(&repo_str, session_id);
    let branch = session_branch_name(session_id);

    let worktree_exists = worktree_path.exists();
    let dirty = if worktree_exists {
        !is_working_dir_clean(&worktree_path)?
    } else {
        false
    };

    let mut commits_ahead_of_base = 0u64;
    if let Some(base) = base_branch {
        let branch_exists = matches!(
            run_git(repo_path, &["rev-parse", "--verify", &branch]),
            Ok(ref output) if output.status.success()
        );
        if branch_exists {
            let range = format!("{}..{}", base, branch);
            let output = run_git(repo_path, &["rev-list", "--count", &range])?;
            if !output.status.success() {
                return Err(format!(
                    "git rev-list --count {} failed: {}",
                    range,
                    git_stderr(&output)
                ));
            }
            commits_ahead_of_base = git_stdout(&output).parse().unwrap_or(0);
        }
    }

    Ok(SessionWorktreeState {
        worktree_path,
        branch,
        worktree_exists,
        dirty,
        commits_ahead_of_base,
    })
}

/// Get diff between a session's branch and its base branch.
pub fn get_session_diff(
    repo_path: &Path,
    session_id: &str,
    base_branch: &str,
) -> Result<String, String> {
    let branch = session_branch_name(session_id);
    let output = run_git(
        repo_path,
        &[
            "diff",
            "--unified=3",
            &format!("{}...{}", base_branch, branch),
        ],
    )?;

    if !output.status.success() {
        return Err(format!("git diff failed: {}", git_stderr(&output)));
    }

    Ok(git_stdout(&output))
}
