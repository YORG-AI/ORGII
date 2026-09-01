//! Worktree teardown: removing a registered worktree path, removing a
//! session's worktree plus branch, and the bulk prune/cleanup sweeps.

use std::path::Path;

use tracing::{info, warn};

use super::git_cmd::{git_stderr, run_git};
use super::paths::session_worktree_dir;
use super::{list_all_worktrees, list_session_worktrees, session_branch_name, validate_session_id};

/// Remove a session's worktree and optionally delete its branch.
pub fn remove_worktree_path(
    repo_path: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), String> {
    let canonical_repo = repo_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve repo path: {}", err))?;
    let canonical_worktree = worktree_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve worktree path: {}", err))?;

    if canonical_repo == canonical_worktree {
        return Err("Cannot remove the main worktree".to_string());
    }

    let registered = list_all_worktrees(&canonical_repo)?;
    let is_registered = registered.iter().any(|entry| {
        Path::new(&entry.path)
            .canonicalize()
            .map(|path| path == canonical_worktree)
            .unwrap_or(false)
    });

    if !is_registered {
        return Err(format!(
            "Path is not a registered worktree: {}",
            canonical_worktree.display()
        ));
    }

    let worktree_path_string = canonical_worktree.to_string_lossy().to_string();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&worktree_path_string);

    let output = run_git(&canonical_repo, &args)?;
    if !output.status.success() {
        return Err(format!(
            "git worktree remove failed: {}",
            git_stderr(&output)
        ));
    }

    info!(
        "[worktree] Removed worktree: {}",
        canonical_worktree.display()
    );
    Ok(())
}

pub fn remove_session_worktree(
    repo_path: &Path,
    session_id: &str,
    delete_branch: bool,
) -> Result<(), String> {
    validate_session_id(session_id)?;
    let repo_str = repo_path.to_string_lossy().to_string();
    let wt_path = session_worktree_dir(&repo_str, session_id);
    let branch = session_branch_name(session_id);
    let mut cleanup_errors = Vec::new();

    // Try git worktree remove first (handles both directory and registry)
    if wt_path.exists() {
        if let Err(err) = remove_worktree_path(repo_path, &wt_path, true) {
            warn!(
                "[worktree] git worktree remove failed, cleaning up manually: {}",
                err
            );
            if wt_path.exists() {
                std::fs::remove_dir_all(&wt_path)
                    .map_err(|err| format!("Failed to remove worktree dir: {}", err))?;
            }
            match run_git(repo_path, &["worktree", "prune"]) {
                Ok(output) if output.status.success() => {}
                Ok(output) => cleanup_errors.push(format!(
                    "git worktree prune failed: {}",
                    git_stderr(&output)
                )),
                Err(error) => cleanup_errors.push(error),
            }
        }
    } else {
        match run_git(repo_path, &["worktree", "prune"]) {
            Ok(output) if output.status.success() => {}
            Ok(output) => cleanup_errors.push(format!(
                "git worktree prune failed: {}",
                git_stderr(&output)
            )),
            Err(error) => cleanup_errors.push(error),
        }
    }

    if delete_branch {
        match run_git(repo_path, &["rev-parse", "--verify", &branch]) {
            Ok(output) if output.status.success() => {
                let del = run_git(repo_path, &["branch", "-D", &branch]);
                match del {
                    Ok(ref out) if out.status.success() => {
                        info!("[worktree] Deleted branch: {}", branch);
                    }
                    Ok(ref out) => {
                        cleanup_errors.push(format!(
                            "Failed to delete branch {}: {}",
                            branch,
                            git_stderr(out)
                        ));
                    }
                    Err(err) => {
                        cleanup_errors.push(format!("Failed to delete branch {}: {}", branch, err));
                    }
                }
            }
            Ok(_) => {}
            Err(error) => cleanup_errors.push(format!(
                "Failed to verify branch {} before deletion: {}",
                branch, error
            )),
        }
    }

    if cleanup_errors.is_empty() {
        Ok(())
    } else {
        Err(cleanup_errors.join("; "))
    }
}

/// Prune stale worktrees that no longer have associated sessions.
///
/// Called on app startup. Checks the `~/.orgii/agent-worktrees/` directory
/// and removes any worktrees whose session IDs are not in the provided set.
pub fn prune_stale_worktrees(
    repo_path: &Path,
    active_session_ids: &[String],
) -> Result<u32, String> {
    let worktrees = list_session_worktrees(repo_path)?;
    let mut pruned = 0u32;

    let active_set: std::collections::HashSet<&str> =
        active_session_ids.iter().map(|s| s.as_str()).collect();

    for wt in &worktrees {
        if !active_set.contains(wt.session_id.as_str()) {
            info!(
                "[worktree] Pruning stale worktree for session: {}",
                wt.session_id
            );
            if let Err(err) = remove_session_worktree(repo_path, &wt.session_id, true) {
                warn!(
                    "[worktree] Failed to prune stale worktree {}: {}",
                    wt.session_id, err
                );
            } else {
                pruned += 1;
            }
        }
    }

    if pruned > 0 {
        info!("[worktree] Pruned {} stale worktrees", pruned);
    }

    Ok(pruned)
}

/// Clean up all agent worktrees for a repo.
pub fn cleanup_all_worktrees(repo_path: &Path) -> Result<u32, String> {
    let worktrees = list_session_worktrees(repo_path)?;
    let mut cleaned = 0u32;

    for wt in &worktrees {
        if let Err(err) = remove_session_worktree(repo_path, &wt.session_id, true) {
            warn!(
                "[worktree] Failed to clean up worktree {}: {}",
                wt.session_id, err
            );
        } else {
            cleaned += 1;
        }
    }

    Ok(cleaned)
}
