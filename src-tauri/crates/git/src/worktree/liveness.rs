//! Liveness and per-session filesystem state for isolated worktrees.

use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

use tracing::warn;

use super::git_cmd::{git_stderr, git_stdout, run_git};
use super::paths::agent_worktrees_root;

/// OS advisory lock held by the process actively using a worktree.
const WORKTREE_LOCK_FILENAME: &str = ".orgii-worktree.lock";
/// Per-session private TMPDIR, removed with the owning worktree.
pub const SESSION_WORKTREE_TMP_DIRNAME: &str = ".orgii-tmp";

fn worktree_lock_path(worktree_path: &Path) -> PathBuf {
    worktree_path.join(WORKTREE_LOCK_FILENAME)
}

#[cfg(unix)]
fn flock_try_exclusive(file: &std::fs::File) -> std::io::Result<bool> {
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if ret == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(err)
    }
}

#[cfg(not(unix))]
fn flock_try_exclusive(_file: &std::fs::File) -> std::io::Result<bool> {
    Ok(true)
}

/// Holds the advisory lock open; dropping it releases the lock.
pub struct WorktreeLockGuard {
    _file: std::fs::File,
}

#[cfg(unix)]
impl Drop for WorktreeLockGuard {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub fn try_acquire_worktree_lock(
    worktree_path: &Path,
) -> Result<Option<WorktreeLockGuard>, String> {
    let path = worktree_lock_path(worktree_path);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|err| format!("Failed to open worktree lock {}: {}", path.display(), err))?;
    match flock_try_exclusive(&file) {
        Ok(true) => Ok(Some(WorktreeLockGuard { _file: file })),
        Ok(false) => Ok(None),
        Err(err) => Err(format!("Failed to lock {}: {}", path.display(), err)),
    }
}

pub(crate) fn worktree_lock_is_held(worktree_path: &Path) -> bool {
    match try_acquire_worktree_lock(worktree_path) {
        Ok(Some(_guard)) => false,
        Ok(None) => true,
        Err(err) => {
            warn!(
                "[worktree] Failed to probe lock at {}; treating worktree as in use: {}",
                worktree_path.display(),
                err
            );
            true
        }
    }
}

/// Keep lock/tmp artifacts out of every worktree's git status.
pub(crate) fn ensure_worktree_excludes(worktree_path: &Path) -> Result<(), String> {
    let output = run_git(worktree_path, &["rev-parse", "--git-path", "info/exclude"])?;
    if !output.status.success() {
        return Err(format!(
            "Failed to resolve git exclude file: {}",
            git_stderr(&output)
        ));
    }
    let raw = git_stdout(&output);
    let exclude_path = {
        let candidate = PathBuf::from(&raw);
        if candidate.is_absolute() {
            candidate
        } else {
            worktree_path.join(candidate)
        }
    };
    if let Some(parent) = exclude_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {}", parent.display(), err))?;
    }
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let lines = existing.lines().map(str::trim).collect::<Vec<_>>();
    let mut appended = String::new();
    for pattern in [
        format!("/{WORKTREE_LOCK_FILENAME}"),
        format!("/{SESSION_WORKTREE_TMP_DIRNAME}/"),
    ] {
        if lines.contains(&pattern.as_str()) {
            continue;
        }
        if appended.is_empty() && !existing.is_empty() && !existing.ends_with('\n') {
            appended.push('\n');
        }
        appended.push_str(&pattern);
        appended.push('\n');
    }
    if appended.is_empty() {
        return Ok(());
    }
    let mut merged = existing;
    merged.push_str(&appended);
    std::fs::write(&exclude_path, merged)
        .map_err(|err| format!("Failed to write {}: {}", exclude_path.display(), err))
}

pub fn session_worktree_root_for_path(candidate: &Path) -> Option<PathBuf> {
    let root = agent_worktrees_root();
    let relative = candidate.strip_prefix(&root).ok()?;
    let mut components = relative.components();
    let repo_hash = components.next()?.as_os_str();
    let session_id = components.next()?.as_os_str();
    Some(root.join(repo_hash).join(session_id))
}

pub fn session_worktree_tmp_dir(worktree_root: &Path) -> PathBuf {
    worktree_root.join(SESSION_WORKTREE_TMP_DIRNAME)
}
