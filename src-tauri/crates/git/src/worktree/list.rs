//! Enumerating worktrees registered with git: the full listing, the
//! agent-session subset, and validation of a caller-selected linked worktree.

use std::path::{Path, PathBuf};

use super::git_cmd::{git_stderr, git_stdout, run_git};
use super::paths::agent_worktrees_root;
use super::{parse_worktree_list_porcelain, repo_hash, GeneralWorktreeEntry, WorktreeInfo};

/// List ALL git worktrees for a repo (main + linked).
///
/// Unlike `list_session_worktrees`, this returns every worktree
/// registered by git, not just agent-managed ones.
pub fn list_all_worktrees(repo_path: &Path) -> Result<Vec<GeneralWorktreeEntry>, String> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    if !output.status.success() {
        return Err(format!("git worktree list failed: {}", git_stderr(&output)));
    }

    Ok(parse_worktree_list_porcelain(&git_stdout(&output)))
}

/// Resolve and validate a linked worktree selected for session execution.
/// The main checkout is deliberately rejected: callers should use local mode
/// for it, while this function is reserved for a distinct registered checkout.
pub fn validate_existing_worktree(
    repo_path: &Path,
    worktree_path: &Path,
) -> Result<GeneralWorktreeEntry, String> {
    let canonical_repo = repo_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve repo path: {err}"))?;
    let canonical_worktree = worktree_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve worktree path: {err}"))?;
    if !canonical_worktree.is_dir() {
        return Err(format!(
            "Worktree path is not a directory: {}",
            canonical_worktree.display()
        ));
    }

    let entries = list_all_worktrees(&canonical_repo)?;
    let mut entry = entries
        .into_iter()
        .find(|entry| {
            Path::new(&entry.path)
                .canonicalize()
                .map(|path| path == canonical_worktree)
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            format!(
                "Path is not a registered worktree for {}: {}",
                canonical_repo.display(),
                canonical_worktree.display()
            )
        })?;

    if entry.is_main || canonical_repo == canonical_worktree {
        return Err("The main checkout must use local workspace mode".to_string());
    }

    entry.path = canonical_worktree.to_string_lossy().to_string();
    Ok(entry)
}

/// List all agent session worktrees for a repo.
pub fn list_session_worktrees(repo_path: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    if !output.status.success() {
        return Err(format!("git worktree list failed: {}", git_stderr(&output)));
    }

    let stdout = git_stdout(&output);
    let repo_str = repo_path.to_string_lossy().to_string();
    let agent_root = agent_worktrees_root();
    let repo_wt_root = agent_root.join(repo_hash(&repo_str));

    let mut worktrees = Vec::new();

    for entry in stdout.split("\n\n") {
        if entry.trim().is_empty() {
            continue;
        }

        let mut wt_path = String::new();
        let mut wt_branch = String::new();

        for line in entry.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                wt_path = path.to_string();
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                wt_branch = branch_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch_ref)
                    .to_string();
            }
        }

        if wt_path.is_empty() || !wt_branch.starts_with("agent/") {
            continue;
        }

        // Only include worktrees under our agent-worktrees directory
        let wt_pathbuf = PathBuf::from(&wt_path);
        if !wt_pathbuf.starts_with(&repo_wt_root) {
            continue;
        }

        // Extract session_id from the directory name
        let session_id = wt_pathbuf
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            continue;
        }

        worktrees.push(WorktreeInfo {
            path: wt_path,
            branch: wt_branch,
            base_branch: None, // Not available from porcelain output
            session_id,
        });
    }

    Ok(worktrees)
}
