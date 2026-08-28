use super::utils::{get_conflicted_files, run_git};
use crate::types::*;
/**
 * Merge, Rebase, Cherry-pick, Revert, and Reset Operations
 *
 * Advanced git operations for combining and manipulating commits.
 * All operations use retry logic for transient errors.
 */
use std::path::Path;

#[cfg(test)]
#[path = "tests/merge_tests.rs"]
mod tests;

// ============================================
// Merge Operations
// ============================================

/// Merge a branch
pub fn merge_branch(
    repo_path: &Path,
    branch: &str,
    no_ff: bool,
    message: Option<&str>,
) -> Result<GitMergeResult, String> {
    let mut args = vec!["merge"];

    if no_ff {
        args.push("--no-ff");
    }

    if let Some(msg) = message {
        args.push("-m");
        args.push(msg);
    }

    args.push(branch);

    let output = run_git(repo_path, &args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // A conflict is a state, not a substring: a clean run whose diffstat
    // lists a file named CONFLICTS.md must not report failure. Exit 0 means
    // no conflicts; on failure the unmerged-file list is the ground truth.
    let conflicted_files = if output.status.success() {
        vec![]
    } else {
        get_conflicted_files(repo_path)
    };
    let has_conflicts = !conflicted_files.is_empty();

    Ok(GitMergeResult {
        success: output.status.success() && !has_conflicts,
        message: format!("{}{}", stdout, stderr),
        has_conflicts,
        conflicted_files,
    })
}

/// Abort merge
pub fn merge_abort(repo_path: &Path) -> Result<(), String> {
    let output = run_git(repo_path, &["merge", "--abort"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Continue merge
pub fn merge_continue(repo_path: &Path) -> Result<GitMergeResult, String> {
    let output = run_git(repo_path, &["merge", "--continue"])?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };

    Ok(GitMergeResult {
        success: output.status.success(),
        message,
        has_conflicts: false,
        conflicted_files: vec![],
    })
}

// ============================================
// Rebase Operations
// ============================================

/// Args for `git rebase`.
///
/// `--autostash` for the same reason pulls carry it (see
/// `remote::pull_strategy_args`): a bare `git rebase` refuses to start on any
/// dirty working tree ("cannot rebase: You have unstaged changes"), even when
/// nothing overlaps the replayed commits.
pub(crate) fn rebase_args<'a>(upstream: &'a str, branch: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["rebase", "--autostash", upstream];
    if let Some(b) = branch {
        args.push(b);
    }
    args
}

/// Rebase onto branch
pub fn rebase_branch(
    repo_path: &Path,
    upstream: &str,
    branch: Option<&str>,
) -> Result<GitRebaseResult, String> {
    let args = rebase_args(upstream, branch);

    let output = run_git(repo_path, &args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // A conflict is a state, not a substring: a clean run whose diffstat
    // lists a file named CONFLICTS.md must not report failure. Exit 0 means
    // no conflicts; on failure the unmerged-file list is the ground truth.
    let conflicted_files = if output.status.success() {
        vec![]
    } else {
        get_conflicted_files(repo_path)
    };
    let has_conflicts = !conflicted_files.is_empty();

    Ok(GitRebaseResult {
        success: output.status.success() && !has_conflicts,
        message: format!("{}{}", stdout, stderr),
        has_conflicts,
        conflicted_files,
    })
}

/// Continue rebase
pub fn rebase_continue(repo_path: &Path) -> Result<GitRebaseResult, String> {
    let output = run_git(
        repo_path,
        // core.editor=true: continuing after a resolved conflict otherwise
        // opens the commit-message editor, which hangs (or aborts the
        // continue) in a process with no TTY.
        &["-c", "core.editor=true", "rebase", "--continue"],
    )?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };

    Ok(GitRebaseResult {
        success: output.status.success(),
        message,
        has_conflicts: false,
        conflicted_files: vec![],
    })
}

/// Abort rebase
pub fn rebase_abort(repo_path: &Path) -> Result<(), String> {
    let output = run_git(repo_path, &["rebase", "--abort"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Skip current commit in rebase
pub fn rebase_skip(repo_path: &Path) -> Result<GitRebaseResult, String> {
    let output = run_git(repo_path, &["rebase", "--skip"])?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // A conflict is a state, not a substring: a clean run whose diffstat
    // lists a file named CONFLICTS.md must not report failure. Exit 0 means
    // no conflicts; on failure the unmerged-file list is the ground truth.
    let conflicted_files = if output.status.success() {
        vec![]
    } else {
        get_conflicted_files(repo_path)
    };
    let has_conflicts = !conflicted_files.is_empty();

    Ok(GitRebaseResult {
        success: output.status.success() && !has_conflicts,
        message: format!("{}{}", stdout, stderr),
        has_conflicts,
        conflicted_files,
    })
}

// ============================================
// Cherry-pick Operations
// ============================================

/// Cherry-pick a commit
pub fn cherry_pick_commit(
    repo_path: &Path,
    commit: &str,
    no_commit: bool,
) -> Result<GitCherryPickResult, String> {
    let mut args = vec!["cherry-pick"];

    if no_commit {
        args.push("-n");
    }

    args.push(commit);

    let output = run_git(repo_path, &args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // A conflict is a state, not a substring: a clean run whose diffstat
    // lists a file named CONFLICTS.md must not report failure. Exit 0 means
    // no conflicts; on failure the unmerged-file list is the ground truth.
    let conflicted_files = if output.status.success() {
        vec![]
    } else {
        get_conflicted_files(repo_path)
    };
    let has_conflicts = !conflicted_files.is_empty();

    Ok(GitCherryPickResult {
        success: output.status.success() && !has_conflicts,
        message: format!("{}{}", stdout, stderr),
        has_conflicts,
        conflicted_files,
    })
}

/// Continue cherry-pick
pub fn cherry_pick_continue(repo_path: &Path) -> Result<GitCherryPickResult, String> {
    let output = run_git(
        repo_path,
        // core.editor=true: see rebase_continue.
        &["-c", "core.editor=true", "cherry-pick", "--continue"],
    )?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };

    Ok(GitCherryPickResult {
        success: output.status.success(),
        message,
        has_conflicts: false,
        conflicted_files: vec![],
    })
}

/// Abort cherry-pick
pub fn cherry_pick_abort(repo_path: &Path) -> Result<(), String> {
    let output = run_git(repo_path, &["cherry-pick", "--abort"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

// ============================================
// Revert Operations
// ============================================

/// Revert a commit
pub fn revert_commit(
    repo_path: &Path,
    commit: &str,
    no_commit: bool,
) -> Result<GitRevertResult, String> {
    let mut args = vec!["revert"];

    if no_commit {
        args.push("-n");
    }

    args.push(commit);

    let output = run_git(repo_path, &args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // A conflict is a state, not a substring: a clean run whose diffstat
    // lists a file named CONFLICTS.md must not report failure. Exit 0 means
    // no conflicts; on failure the unmerged-file list is the ground truth.
    let conflicted_files = if output.status.success() {
        vec![]
    } else {
        get_conflicted_files(repo_path)
    };
    let has_conflicts = !conflicted_files.is_empty();

    Ok(GitRevertResult {
        success: output.status.success() && !has_conflicts,
        message: format!("{}{}", stdout, stderr),
        has_conflicts,
        conflicted_files,
    })
}

/// Abort revert
pub fn revert_abort(repo_path: &Path) -> Result<(), String> {
    let output = run_git(repo_path, &["revert", "--abort"])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Continue revert
pub fn revert_continue(repo_path: &Path) -> Result<GitRevertResult, String> {
    let output = run_git(
        repo_path,
        // core.editor=true: see rebase_continue.
        &["-c", "core.editor=true", "revert", "--continue"],
    )?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };

    Ok(GitRevertResult {
        success: output.status.success(),
        message,
        has_conflicts: false,
        conflicted_files: vec![],
    })
}

// ============================================
// Reset Operations
// ============================================

/// Reset HEAD
pub fn reset_head(
    repo_path: &Path,
    target_ref: &str,
    mode: &str,
) -> Result<GitResetResult, String> {
    let mode_flag = format!("--{}", mode);

    let output = run_git(repo_path, &["reset", &mode_flag, target_ref])?;

    let message = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    };

    Ok(GitResetResult {
        success: true,
        message,
    })
}

/// Reset a specific file to a ref
pub fn reset_file(
    repo_path: &Path,
    file_path: &str,
    target_ref: &str,
) -> Result<GitResetResult, String> {
    let output = run_git(repo_path, &["checkout", target_ref, "--", file_path])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(GitResetResult {
        success: true,
        message: format!("Reset {} to {}", file_path, target_ref),
    })
}
