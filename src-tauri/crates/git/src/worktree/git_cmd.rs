//! Thin git invocation layer shared by the worktree submodules: the retrying
//! `git` runner plus the stdout/stderr and HEAD/cleanliness accessors built
//! on top of it.

use std::path::Path;
use std::process::Output;

use crate::util::run_git_with_retry;

const GIT_RETRIES: u32 = 3;

/// Check that a repo working directory is clean (no uncommitted changes).
pub(super) fn is_working_dir_clean(repo_path: &Path) -> Result<bool, String> {
    let output = run_git(repo_path, &["status", "--porcelain"])?;
    if !output.status.success() {
        return Err(format!("git status failed: {}", git_stderr(&output)));
    }
    Ok(git_stdout(&output).is_empty())
}

pub(super) fn run_git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    run_git_with_retry(cwd, args, GIT_RETRIES)
}

pub(super) fn git_stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub(super) fn git_stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

/// Get the current branch or HEAD commit of a repo.
pub(super) fn current_head_ref(repo_path: &Path) -> Result<String, String> {
    let output = run_git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !output.status.success() {
        return Err(format!("Failed to get HEAD: {}", git_stderr(&output)));
    }
    let branch = git_stdout(&output);
    if branch == "HEAD" {
        let output = run_git(repo_path, &["rev-parse", "HEAD"])?;
        if output.status.success() {
            return Ok(git_stdout(&output));
        }
    }
    Ok(branch)
}
