//! Write-back of session work into the base branch: committing the worktree's
//! pending changes and performing the merge (with checkout save/restore and
//! conflict detection).

use std::path::Path;

use tracing::{error, info, warn};

use super::git_cmd::{current_head_ref, git_stderr, git_stdout, is_working_dir_clean, run_git};
use super::paths::session_worktree_dir;
use super::{session_branch_name, validate_session_id, MergeStrategy, WorktreeMergeResult};

/// Commit any uncommitted changes in a session's worktree.
///
/// Returns `true` if a commit was made, `false` if the worktree was clean.
pub fn commit_worktree_changes(repo_path: &Path, session_id: &str) -> Result<bool, String> {
    let repo_str = repo_path.to_string_lossy().to_string();
    let wt_path = session_worktree_dir(&repo_str, session_id);

    if !wt_path.exists() {
        return Err("Worktree does not exist".to_string());
    }

    // Check for changes
    let status = run_git(&wt_path, &["status", "--porcelain"])?;
    if !status.status.success() {
        return Err(format!("git status failed: {}", git_stderr(&status)));
    }

    let status_text = git_stdout(&status);
    if status_text.is_empty() {
        return Ok(false);
    }

    // Stage all and commit
    let add = run_git(&wt_path, &["add", "."])?;
    if !add.status.success() {
        return Err(format!("git add failed: {}", git_stderr(&add)));
    }

    let commit = run_git(
        &wt_path,
        &[
            "commit",
            "-m",
            &format!("Agent session {} changes", session_id),
        ],
    )?;
    if !commit.status.success() {
        let stderr = git_stderr(&commit);
        let stdout = String::from_utf8_lossy(&commit.stdout);
        // Git prints "nothing to commit" to STDOUT (exit 1); stderr is empty.
        if stderr.contains("nothing to commit") || stdout.contains("nothing to commit") {
            return Ok(false);
        }
        return Err(format!("git commit failed: {}{}", stdout, stderr));
    }

    info!("[worktree] Committed changes in session {}", session_id);
    Ok(true)
}

/// Merge a session's worktree branch back into its base branch.
///
/// `base_branch` must be provided (from the DB record, not guessed from HEAD).
/// Saves and restores the user's current checkout so their working state is not
/// mutated as a side-effect.
pub fn merge_session_worktree(
    repo_path: &Path,
    session_id: &str,
    base_branch: &str,
    strategy: MergeStrategy,
) -> Result<WorktreeMergeResult, String> {
    validate_session_id(session_id)?;
    let repo_str = repo_path.to_string_lossy().to_string();
    let wt_path = session_worktree_dir(&repo_str, session_id);
    let branch = session_branch_name(session_id);

    // Commit any uncommitted changes in the worktree first
    if wt_path.exists() {
        let _ = commit_worktree_changes(repo_path, session_id);
    }

    if strategy == MergeStrategy::LeaveAsBranch {
        return Ok(WorktreeMergeResult {
            merged: false,
            branch,
            base_branch: base_branch.to_string(),
            conflicts: vec![],
            error: None,
        });
    }

    // Check if branch has any commits ahead of base
    let range = format!("{}..{}", base_branch, branch);
    let log_check = run_git(repo_path, &["log", "--oneline", &range]);
    if let Ok(ref output) = log_check {
        if output.status.success() && git_stdout(output).is_empty() {
            return Ok(WorktreeMergeResult {
                merged: false,
                branch,
                base_branch: base_branch.to_string(),
                conflicts: vec![],
                error: Some("No changes to merge".to_string()),
            });
        }
    }

    // Verify the main repo working directory is clean before merging
    let clean = is_working_dir_clean(repo_path)?;
    if !clean {
        return Err("Cannot merge: the repository has uncommitted changes. \
             Commit or stash them first."
            .to_string());
    }

    // Save the user's current checkout so we can restore it after the merge
    let original_ref = current_head_ref(repo_path)?;

    // Checkout the target base branch
    let checkout_base = run_git(repo_path, &["checkout", base_branch])?;
    if !checkout_base.status.success() {
        return Err(format!(
            "Failed to checkout base branch '{}': {}",
            base_branch,
            git_stderr(&checkout_base)
        ));
    }

    // Perform the merge
    let merge_msg = format!("Merge agent session {}", session_id);
    let merge_args: Vec<&str> = match strategy {
        MergeStrategy::AutoMerge => vec!["merge", "--no-ff", &branch, "-m", &merge_msg],
        MergeStrategy::FastForward => vec!["merge", "--ff-only", &branch],
        MergeStrategy::LeaveAsBranch => unreachable!(),
    };

    let merge_output = run_git(repo_path, &merge_args)?;

    let result = if merge_output.status.success() {
        info!("[worktree] Merged branch {} into {}", branch, base_branch);
        Ok(WorktreeMergeResult {
            merged: true,
            branch,
            base_branch: base_branch.to_string(),
            conflicts: vec![],
            error: None,
        })
    } else {
        let stderr = git_stderr(&merge_output);

        // Detect conflict markers (UU, AA, DD, AU, UA, DU, UD)
        let status = run_git(repo_path, &["status", "--porcelain"]);
        let conflicts: Vec<String> = match status {
            Ok(ref out) if out.status.success() => git_stdout(out)
                .lines()
                .filter(|line| line.len() >= 3)
                .filter(|line| {
                    let prefix = &line[..2];
                    matches!(prefix, "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD")
                })
                .filter_map(|line| line.get(3..).map(|s| s.to_string()))
                .collect(),
            _ => vec![],
        };

        // Abort the merge to restore clean state
        let _ = run_git(repo_path, &["merge", "--abort"]);

        if !conflicts.is_empty() {
            warn!(
                "[worktree] Merge conflict for session {}: {} conflicting files",
                session_id,
                conflicts.len()
            );
            Ok(WorktreeMergeResult {
                merged: false,
                branch,
                base_branch: base_branch.to_string(),
                conflicts,
                error: Some("Merge conflicts detected".to_string()),
            })
        } else {
            error!(
                "[worktree] Merge failed for session {}: {}",
                session_id, stderr
            );
            Ok(WorktreeMergeResult {
                merged: false,
                branch,
                base_branch: base_branch.to_string(),
                conflicts: vec![],
                error: Some(format!("Merge failed: {}", stderr)),
            })
        }
    };

    // Restore the user's original checkout (best-effort; don't mask the merge result)
    if original_ref != base_branch {
        let _ = run_git(repo_path, &["checkout", &original_ref]);
    }

    result
}
