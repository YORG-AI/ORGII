use super::utils::run_git;
use crate::types::*;
/**
 * Stash Operations
 *
 * Save, list, apply, and drop stashes.
 * All operations use retry logic for transient errors.
 */
use std::path::Path;

#[cfg(test)]
#[path = "tests/stash_tests.rs"]
mod tests;

/// Create a stash
pub fn stash_push(
    repo_path: &Path,
    files: Option<&[String]>,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<GitStashResult, String> {
    let mut args = vec!["stash", "push"];

    if include_untracked {
        args.push("--include-untracked");
    }

    if let Some(msg) = message {
        args.push("-m");
        args.push(msg);
    }

    // If specific files are provided, add them
    if let Some(file_list) = files {
        args.push("--");
        for file in file_list {
            args.push(file);
        }
    }

    let output = run_git(repo_path, &args)?;

    let message_out = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    };

    // `git stash push` exits 0 without stashing anything when the tree is
    // clean ("No local changes to save"). Reporting a stash_ref in that case
    // pointed callers at whatever unrelated stash happened to sit at
    // stash@{0} — a destructive mis-target for any follow-up pop or drop.
    let stashed = !message_out.contains("No local changes to save");

    Ok(GitStashResult {
        success: true,
        message: message_out,
        stash_ref: stashed.then(|| "stash@{0}".to_string()),
    })
}

/// List stashes
pub fn stash_list(repo_path: &Path) -> Result<Vec<StashEntry>, String> {
    // %gd is the real selector ("stash@{N}"). Deriving the index from line
    // position instead desynchronized on any line the parser skipped, and a
    // follow-up stash_drop/apply(index) then destroyed the WRONG stash.
    // %H is the stash commit id — the only identity that survives other
    // stashes being pushed or dropped.
    let output = run_git(repo_path, &["stash", "list", "--format=%gd|%H|%gs"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut stashes = Vec::new();

    for line in stdout.lines() {
        // splitn(3) keeps any '|' inside the subject intact.
        let mut parts = line.splitn(3, '|');
        let (Some(selector), Some(sha), Some(subject)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Some(index) = selector
            .strip_prefix("stash@{")
            .and_then(|rest| rest.strip_suffix('}'))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };

        // The subject is "WIP on <branch>: <sha> <msg>" for bare stashes or
        // "On <branch>: <msg>" for `stash push -m`.
        let branch = subject
            .strip_prefix("WIP on ")
            .or_else(|| subject.strip_prefix("On "))
            .and_then(|rest| rest.split(':').next())
            .map(|branch| branch.to_string());

        stashes.push(StashEntry {
            index,
            message: subject.to_string(),
            branch,
            commit_sha: Some(sha.to_string()),
        });
    }

    Ok(stashes)
}

/// Apply a stash
pub fn stash_apply(repo_path: &Path, index: u32, pop: bool) -> Result<GitStashResult, String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let command = if pop { "pop" } else { "apply" };

    let output = run_git(repo_path, &["stash", command, &stash_ref])?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    };

    Ok(GitStashResult {
        success: true,
        message,
        stash_ref: Some(stash_ref),
    })
}

/// Drop a stash
pub fn stash_drop(repo_path: &Path, index: u32) -> Result<GitStashResult, String> {
    let stash_ref = format!("stash@{{{}}}", index);

    let output = run_git(repo_path, &["stash", "drop", &stash_ref])?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    };

    Ok(GitStashResult {
        success: true,
        message,
        stash_ref: Some(stash_ref),
    })
}

/// Clear all stashes
pub fn stash_clear(repo_path: &Path) -> Result<GitStashResult, String> {
    let output = run_git(repo_path, &["stash", "clear"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(GitStashResult {
        success: true,
        message: "All stashes cleared".to_string(),
        stash_ref: None,
    })
}
