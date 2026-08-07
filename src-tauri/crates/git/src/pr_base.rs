//! Resolve a GitHub pull request into a git-resolvable base commit-ish so an
//! isolated worktree can be created from it.
//!
//! The worktree source picker (frontend) lets the user pick an open PR — but a
//! PR number is not something `git worktree add` can consume. Fork / cross-repo
//! PRs are the hard case: their head branch lives in a different remote that the
//! user has almost certainly not added, so `git fetch origin <head-branch>`
//! fails. GitHub always mirrors *every* PR head under
//! `refs/pull/<number>/head` in the **base** repo, which is how we recover the
//! head commit for fork PRs.
//!
//! The resolution mirrors `stablyai/orca`'s `resolveGitHubPrStartPoint`:
//!
//!  1. **Same-repo PR** — `git fetch <remote> <head_branch>` then
//!     `git rev-parse --verify FETCH_HEAD` to read the head SHA.
//!  2. **Fork / cross-repo PR** — if the branch fetch fails with a
//!     "missing remote ref" error, fall back to
//!     `git fetch <remote> refs/pull/<n>/head` + the same rev-parse.
//!
//! The resolved head SHA is returned as `base_ref`, a fully git-resolvable
//! commit-ish that is fed unchanged into `create_session_worktree` as the base
//! of `git worktree add -b agent/<session> <path> <base_ref>`.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::util::{close_inherited_fds, git_command};

/// Default remote to resolve PRs against.
const DEFAULT_REMOTE: &str = "origin";

/// Hard cap on any single `git fetch`/`rev-parse` invocation. `git fetch`
/// cannot hang on a credential prompt (we set `GIT_TERMINAL_PROMPT=0`), but a
/// slow / stalled network can still block indefinitely, so we bound it.
const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(90);

// ============================================
// Types
// ============================================

/// Which fetch strategy produced the resolved head SHA.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrBaseSource {
    /// `git fetch <remote> <head_branch>` (same-repo PR).
    Branch,
    /// `git fetch <remote> refs/pull/<n>/head` (fork / cross-repo PR, or the
    /// branch fetch was unavailable).
    PullRef,
}

/// Structured result of resolving a PR into a git-usable base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrBaseResolution {
    /// Git-resolvable commit-ish for `git worktree add … <base_ref>`. Always the
    /// resolved head SHA — usable regardless of whether the PR head branch
    /// exists locally.
    pub base_ref: String,
    /// The PR head commit SHA (identical to `base_ref`; kept as an explicit
    /// field so callers do not have to know the two are the same).
    pub head_sha: String,
    /// The PR head branch name, when the caller supplied one. Purely a label
    /// hint for the UI — the worktree is always created on `agent/<session>`,
    /// so this is not used as a base by git.
    pub branch_name_override: Option<String>,
    /// `refs/remotes/<remote>/<base_branch>` when a base branch was supplied.
    /// Mirrors orca's `compareBaseRef`: the ref a caller would diff the session
    /// branch against. Not consumed by worktree creation.
    pub compare_base_ref: Option<String>,
    /// Which fetch strategy succeeded.
    pub source: PrBaseSource,
}

/// Outcome of a single git invocation, decoupled from `std::process::Output`
/// so the resolution logic can be unit-tested with a mock runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitInvocation {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

// ============================================
// Pure helpers (unit-tested)
// ============================================

/// Detect the "the remote does not advertise this ref" class of `git fetch`
/// failure. This is the signal to stop treating the PR as same-repo and fall
/// back to the `refs/pull/<n>/head` fetch. Any *other* failure (auth, network,
/// not-a-repo) must surface, not silently fall through.
pub fn is_missing_remote_ref_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("couldn't find remote ref")
        || lower.contains("couldnt find remote ref")
        || lower.contains("couldn't find remote reference")
        || lower.contains("no such ref was fetched")
        || (lower.contains("remote ref") && lower.contains("not found"))
        || (lower.contains("ref") && lower.contains("does not exist") && lower.contains("remote"))
}

/// The GitHub-mirrored refspec for a PR head in the base repo.
pub fn pull_head_refspec(pr_number: u64) -> String {
    format!("refs/pull/{pr_number}/head")
}

/// Normalize a caller-supplied remote, falling back to `origin` for
/// empty/whitespace input.
pub fn normalize_remote(remote: Option<&str>) -> String {
    match remote.map(str::trim) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => DEFAULT_REMOTE.to_string(),
    }
}

/// Build the `compare_base_ref` (`refs/remotes/<remote>/<base>`) when a
/// non-empty base branch is known.
fn compare_base_ref(remote: &str, base_branch: Option<&str>) -> Option<String> {
    base_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|base| format!("refs/remotes/{remote}/{base}"))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

// ============================================
// Core resolution (generic over a git runner → unit-testable)
// ============================================

fn rev_parse_fetch_head<R>(run: &mut R) -> Result<String, String>
where
    R: FnMut(&[&str]) -> Result<GitInvocation, String>,
{
    let out = run(&["rev-parse", "--verify", "FETCH_HEAD"])?;
    if !out.success {
        return Err(format!(
            "git rev-parse --verify FETCH_HEAD failed: {}",
            out.stderr.trim()
        ));
    }
    let sha = out.stdout.trim().to_string();
    if sha.is_empty() {
        return Err("git rev-parse --verify FETCH_HEAD returned empty output".to_string());
    }
    Ok(sha)
}

/// Resolve a PR into a git-usable base ref, running git through the supplied
/// `run` closure. Extracted from the Tauri command so the branch→pull-ref
/// fallback and error classification can be exercised without a live repo.
pub fn resolve_pr_base_with<R>(
    remote: &str,
    pr_number: u64,
    head_branch: Option<&str>,
    base_branch: Option<&str>,
    mut run: R,
) -> Result<PrBaseResolution, String>
where
    R: FnMut(&[&str]) -> Result<GitInvocation, String>,
{
    let head = non_empty(head_branch);

    // Attempt 1 — same-repo PR: fetch the head branch by name.
    if let Some(head_ref) = head {
        let fetch = run(&["fetch", "--no-tags", remote, head_ref])?;
        if fetch.success {
            let sha = rev_parse_fetch_head(&mut run)?;
            return Ok(PrBaseResolution {
                base_ref: sha.clone(),
                head_sha: sha,
                branch_name_override: Some(head_ref.to_string()),
                compare_base_ref: compare_base_ref(remote, base_branch),
                source: PrBaseSource::Branch,
            });
        }
        if !is_missing_remote_ref_error(&fetch.stderr) {
            return Err(format!(
                "git fetch {remote} {head_ref} failed: {}",
                fetch.stderr.trim()
            ));
        }
        // Missing remote ref → PR head lives in a fork; fall through.
    }

    // Attempt 2 — fork / cross-repo PR (or no head branch known): every PR head
    // is mirrored under refs/pull/<n>/head in the base repo.
    let refspec = pull_head_refspec(pr_number);
    let fetch = run(&["fetch", "--no-tags", remote, &refspec])?;
    if !fetch.success {
        return Err(format!(
            "git fetch {remote} {refspec} failed: {}",
            fetch.stderr.trim()
        ));
    }
    let sha = rev_parse_fetch_head(&mut run)?;
    Ok(PrBaseResolution {
        base_ref: sha.clone(),
        head_sha: sha,
        branch_name_override: head.map(str::to_string),
        compare_base_ref: compare_base_ref(remote, base_branch),
        source: PrBaseSource::PullRef,
    })
}

// ============================================
// Real git runner (subprocess with timeout)
// ============================================

/// Run a git command capturing stdout/stderr, enforcing a wall-clock timeout.
///
/// `GIT_TERMINAL_PROMPT=0` prevents git from blocking on an interactive
/// credential prompt; the timeout guards against a stalled network transfer.
/// stdout/stderr are drained on dedicated threads so a chatty `git fetch`
/// progress stream cannot deadlock on a full pipe buffer.
fn run_git_capture_with_timeout(
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<GitInvocation, String> {
    let mut cmd = git_command()?;
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    close_inherited_fds(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("failed to spawn git {:?}: {err}", args))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {} timed out after {}s",
                        args.join(" "),
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(format!("git {} wait failed: {err}", args.join(" "))),
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok(GitInvocation {
        success: status.success(),
        stdout,
        stderr,
    })
}

/// Resolve a PR into a git-usable base ref against a real repository on disk.
pub fn resolve_pr_base(
    repo_path: &Path,
    remote: Option<&str>,
    pr_number: u64,
    head_branch: Option<&str>,
    base_branch: Option<&str>,
) -> Result<PrBaseResolution, String> {
    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(format!("Invalid repo path: {}", repo_path.display()));
    }
    let remote = normalize_remote(remote);
    resolve_pr_base_with(&remote, pr_number, head_branch, base_branch, |args| {
        run_git_capture_with_timeout(args, repo_path, GIT_FETCH_TIMEOUT)
    })
}

// ============================================
// Tauri command
// ============================================

/// Resolve a GitHub PR into a git-resolvable base ref for isolated worktree
/// creation. Fetches the PR head (by branch name, falling back to
/// `refs/pull/<n>/head` for fork PRs) and returns its SHA as `baseRef`.
#[tauri::command(rename_all = "camelCase")]
pub async fn worktree_resolve_pr_base(
    repo_path: String,
    pr_number: u64,
    remote: Option<String>,
    head_branch: Option<String>,
    base_branch: Option<String>,
) -> Result<PrBaseResolution, String> {
    log::info!(
        "[worktree] resolve_pr_base repo={repo_path} pr={pr_number} remote={remote:?} head={head_branch:?}"
    );
    tokio::task::spawn_blocking(move || {
        resolve_pr_base(
            Path::new(&repo_path),
            remote.as_deref(),
            pr_number,
            head_branch.as_deref(),
            base_branch.as_deref(),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
