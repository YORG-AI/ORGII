use super::utils::run_git;
/**
 * Staging Operations
 *
 * Stage, unstage, and discard file changes.
 * All operations use retry logic for transient errors.
 */
use std::path::Path;

#[cfg(test)]
#[path = "tests/staging_tests.rs"]
mod tests;

/// Stage all files
pub fn stage_all_files(repo_path: &Path) -> Result<(), String> {
    let output = run_git(repo_path, &["add", "-A"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Stage a specific file
pub fn stage_file(repo_path: &Path, file: &str) -> Result<(), String> {
    let output = run_git(repo_path, &["add", file])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Unstage files
pub fn unstage_files(repo_path: &Path, files: &[String]) -> Result<(), String> {
    for file in files {
        let output = run_git(repo_path, &["reset", "HEAD", file])?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    Ok(())
}

/// Discard changes in files
///
/// Handles different file states:
/// - Untracked files ("??"): deleted from filesystem
/// - Staged new files ("A "): unstage with `git reset HEAD`, then delete
/// - Modified tracked files (" M", "M ", "MM"): unstage if needed, then `git checkout -- file`
/// - Deleted tracked files (" D", "D "): unstage if needed, then `git checkout -- file` to restore
/// - Special case: "." means discard ALL changes (untracked, staged, and modified)
pub fn discard_changes(repo_path: &Path, files: &[String]) -> Result<(), String> {
    // Special case: "." means discard everything
    let discard_all = files.len() == 1 && files[0] == ".";

    // First, get the status of all files to determine how to handle each.
    // `-z` is load-bearing: without it, git quotes-and-escapes any non-ASCII
    // path (default core.quotePath), so the parsed name never matched the
    // real file — a targeted discard errored out and "discard all" silently
    // skipped the file while reporting success. `-z` paths are verbatim and
    // NUL-separated, and a rename's original path arrives as its own
    // NUL-separated field instead of a literal "new -> old" string.
    let status_output = run_git(repo_path, &["status", "--porcelain", "-z"])?;

    if !status_output.status.success() {
        return Err(String::from_utf8_lossy(&status_output.stderr).to_string());
    }

    let status_str = String::from_utf8_lossy(&status_output.stdout);

    // Parse status to categorize files
    // Format: XY filename (where X is index status, Y is worktree status)
    // X = index status: A=added, M=modified, D=deleted, R=renamed, ?=untracked
    // Y = worktree status: M=modified, D=deleted, ?=untracked
    let mut untracked_files: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut staged_new_files: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut staged_files: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut conflict_files: std::collections::HashSet<&str> = std::collections::HashSet::new();

    let mut entries = status_str.split('\0');
    // Not a `for` loop: a rename's original path is consumed from the same
    // iterator inside the body.
    while let Some(entry) = entries.next() {
        if entry.len() < 3 {
            continue;
        }
        let index_status = entry.chars().next().unwrap_or(' ');
        let worktree_status = entry.chars().nth(1).unwrap_or(' ');
        let file_path = &entry[3..];

        // Conflict files: UU, AA, DD, AU, UA, DU, UD
        if index_status == 'U'
            || worktree_status == 'U'
            || (index_status == 'A' && worktree_status == 'A')
            || (index_status == 'D' && worktree_status == 'D')
        {
            conflict_files.insert(file_path);
            continue;
        }

        if index_status == 'R' || index_status == 'C' {
            // The entry names the NEW path; the ORIGINAL path follows as its
            // own NUL field (consume it so it is not misread as an entry).
            // Discarding a rename means deleting the new path like a staged
            // new file and restoring the original like a staged change.
            staged_new_files.insert(file_path);
            if let Some(original) = entries.next() {
                if !original.is_empty() {
                    staged_files.insert(original);
                }
            }
            continue;
        }

        match index_status {
            '?' => {
                // "??" = untracked file
                untracked_files.insert(file_path);
            }
            'A' => {
                // "A " or "AM" = staged new file (added to index but not in HEAD)
                staged_new_files.insert(file_path);
            }
            'M' | 'D' => {
                // Staged modification/deletion - needs unstaging before checkout
                staged_files.insert(file_path);
            }
            _ => {}
        }
    }

    // When discarding all, collect every file from status
    let all_files: Vec<String> = if discard_all {
        untracked_files
            .iter()
            .chain(staged_new_files.iter())
            .chain(staged_files.iter())
            .chain(conflict_files.iter())
            .map(|s| s.to_string())
            .collect::<std::collections::HashSet<String>>()
            .into_iter()
            .collect()
    } else {
        Vec::new()
    };

    let files_to_process: &[String] = if discard_all { &all_files } else { files };

    for file in files_to_process {
        let file_path = repo_path.join(file);

        if conflict_files.contains(file.as_str()) {
            // Conflict file: restore to pre-merge state using HEAD version
            // First reset the index entry, then checkout from HEAD
            let _ = run_git(repo_path, &["reset", "HEAD", "--", file]);
            let output = run_git(repo_path, &["checkout", "HEAD", "--", file])?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
        } else if untracked_files.contains(file.as_str()) {
            // Untracked file: delete from filesystem
            if file_path.exists() {
                if file_path.is_dir() {
                    std::fs::remove_dir_all(&file_path)
                        .map_err(|e| format!("Failed to delete directory {}: {}", file, e))?;
                } else {
                    std::fs::remove_file(&file_path)
                        .map_err(|e| format!("Failed to delete file {}: {}", file, e))?;
                }
            }
        } else if staged_new_files.contains(file.as_str()) {
            // Staged new file: unstage first, then delete
            let _ = run_git(repo_path, &["reset", "HEAD", "--", file]);
            // Now delete the file
            if file_path.exists() {
                if file_path.is_dir() {
                    std::fs::remove_dir_all(&file_path)
                        .map_err(|e| format!("Failed to delete directory {}: {}", file, e))?;
                } else {
                    std::fs::remove_file(&file_path)
                        .map_err(|e| format!("Failed to delete file {}: {}", file, e))?;
                }
            }
        } else {
            // Tracked file (modified/deleted): may need to unstage first
            if staged_files.contains(file.as_str()) {
                let _ = run_git(repo_path, &["reset", "HEAD", "--", file]);
            }

            // Now checkout to discard working tree changes
            let output = run_git(repo_path, &["checkout", "--", file])?;

            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
        }
    }

    // For discard-all, also run git checkout -- . to catch any remaining tracked changes
    // (e.g., files with only worktree modifications that weren't in the staged set)
    if discard_all {
        let output = run_git(repo_path, &["checkout", "--", "."])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Don't fail if checkout has nothing to do
            if !stderr.is_empty() && !stderr.contains("error: pathspec") {
                return Err(stderr.to_string());
            }
        }
    }

    Ok(())
}

/// Resolve a merge conflict file using a strategy
///
/// Strategies:
/// - "ours": Accept the current branch version (git checkout --ours)
/// - "theirs": Accept the incoming branch version (git checkout --theirs)
///
/// After checkout, the file is staged with `git add` to mark it resolved.
pub fn resolve_conflict(repo_path: &Path, file: &str, strategy: &str) -> Result<(), String> {
    let flag = match strategy {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => {
            return Err(format!(
                "Invalid strategy: {}. Use 'ours' or 'theirs'.",
                strategy
            ))
        }
    };

    let output = run_git(repo_path, &["checkout", flag, "--", file])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Stage the file to mark conflict as resolved
    let output = run_git(repo_path, &["add", file])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}
