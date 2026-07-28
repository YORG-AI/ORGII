//! Git worktree manager for parallel coding agent sessions.
//!
//! Each coding session that requests isolation gets its own git worktree on a
//! dedicated branch. This prevents concurrent sessions from conflicting on the
//! same working directory. Worktrees live under `~/.orgii/agent-worktrees/`.
//!
//! The hash-naming pattern keeps each worktree dir unique per repo path.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{error, info, warn};

use core_types::session::CLI_SESSION_PREFIX;

use super::util::run_git_with_retry;

const GIT_RETRIES: u32 = 3;
/// Fallback used when the caller does not supply a configurable limit.
const DEFAULT_MAX_CONCURRENT_WORKTREES: usize = 8;
const WORKTREE_CONFIG_DIR: &str = ".cursor";
const WORKTREE_CONFIG_FILE: &str = "worktrees.json";
/// Legacy config path (pre-.cursor migration). Checked as a fallback so
/// existing repos that have not migrated still get their hooks executed.
const WORKTREE_CONFIG_LEGACY_DIR: &str = ".orgii";
const SETUP_WORKTREE_KEY: &str = "setup-worktree";
const SETUP_WORKTREE_UNIX_KEY: &str = "setup-worktree-unix";
const SETUP_WORKTREE_WINDOWS_KEY: &str = "setup-worktree-windows";
const ROOT_WORKTREE_PATH_ENV: &str = "ROOT_WORKTREE_PATH";
const WORKTREE_SETUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

// ============================================
// Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    /// `None` when the info was reconstructed from `git worktree list` (porcelain
    /// output does not include the base ref). Always `Some` when returned by
    /// `create_session_worktree` or `create_linked_worktree`.
    pub base_branch: Option<String>,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedWorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head_sha: String,
}

// `MergeStrategy` and `WorktreeMergeResult` are pure data and live in
// `core_types` so that downstream crates (notably `agent_sessions`) can
// reference them without depending on the `git` module. Re-exported
// here so existing `crate::worktree::MergeStrategy` paths still
// resolve.
pub use core_types::worktree::{MergeStrategy, WorktreeMergeResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeMergeStatus {
    Pending,
    Merged,
    Conflict,
    Skipped,
    Failed,
}

impl std::fmt::Display for WorktreeMergeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Pending => "pending",
            Self::Merged => "merged",
            Self::Conflict => "conflict",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        })
    }
}

impl WorktreeMergeStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "merged" => Some(Self::Merged),
            "conflict" => Some(Self::Conflict),
            "skipped" => Some(Self::Skipped),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

// ============================================
// Helpers
// ============================================

/// Compute a human-readable directory name for the repo.
/// Format: `{repo-name}-{short-hash}` (e.g. `my-app-dd62a8a1`).
pub(crate) fn repo_hash(repo_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(repo_path.as_bytes());
    let result = hasher.finalize();
    let short_hash = &format!("{:x}", result)[..8];

    let repo_name = Path::new(repo_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");

    let sanitized: String = repo_name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .to_lowercase();

    let trimmed = sanitized.trim_matches('-');
    let mut collapsed = String::with_capacity(trimmed.len());
    let mut prev_hyphen = false;
    for ch in trimmed.chars() {
        if ch == '-' {
            if !prev_hyphen {
                collapsed.push('-');
            }
            prev_hyphen = true;
        } else {
            collapsed.push(ch);
            prev_hyphen = false;
        }
    }

    let name_part = if collapsed.is_empty() {
        "repo"
    } else {
        &collapsed
    };
    format!("{}-{}", name_part, short_hash)
}

/// Root directory for agent worktrees: `~/.orgii/agent-worktrees/`.
/// Thin re-export so this module's call sites stay short; the path
/// itself is owned by the `app_paths` workspace crate.
fn agent_worktrees_root() -> PathBuf {
    app_paths::agent_worktrees_root()
}

/// Validate session_id to prevent path traversal and invalid branch names.
pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("session_id cannot be empty".to_string());
    }
    if session_id.contains("..")
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains('\0')
    {
        return Err(format!(
            "session_id contains invalid characters: {}",
            session_id
        ));
    }
    Ok(())
}

/// Worktree directory for a specific repo + session.
fn session_worktree_dir(repo_path: &str, session_id: &str) -> PathBuf {
    let hash = repo_hash(repo_path);
    agent_worktrees_root().join(hash).join(session_id)
}

/// Branch name for a session. Strips known prefixes to keep branch names
/// concise, and sanitizes characters that are invalid in git ref names
/// (e.g. `:` from builtin agent IDs like `builtin:explore`).
pub(crate) fn session_branch_name(session_id: &str) -> String {
    let suffix = session_id
        .strip_prefix(CLI_SESSION_PREFIX)
        .unwrap_or(session_id);
    if suffix.is_empty() {
        return format!("agent/{}", sanitize_branch_chars(session_id));
    }
    format!("agent/{}", sanitize_branch_chars(suffix))
}

/// Replace characters that are invalid in git branch names with `-`.
/// Git ref format rules (git-check-ref-format): no `:`  ` ` `~` `^` `?` `*` `[` `\` + control chars.
fn sanitize_branch_chars(s: &str) -> String {
    s.chars()
        .map(|ch| {
            if ch == ':'
                || ch == ' '
                || ch == '~'
                || ch == '^'
                || ch == '?'
                || ch == '*'
                || ch == '['
                || ch == '\\'
                || ch.is_ascii_control()
            {
                '-'
            } else {
                ch
            }
        })
        .collect()
}

/// Check that a repo working directory is clean (no uncommitted changes).
fn is_working_dir_clean(repo_path: &Path) -> Result<bool, String> {
    let output = run_git(repo_path, &["status", "--porcelain"])?;
    if !output.status.success() {
        return Err(format!("git status failed: {}", git_stderr(&output)));
    }
    Ok(git_stdout(&output).is_empty())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    run_git_with_retry(cwd, args, GIT_RETRIES)
}

fn git_stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn git_stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

/// Get the current branch or HEAD commit of a repo.
fn current_head_ref(repo_path: &Path) -> Result<String, String> {
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

// ============================================
// Public API
// ============================================

/// Create a linked worktree for an explicit branch name.
///
/// Unlike [`create_session_worktree`], this is not tied to an agent session:
/// the caller supplies the branch and target path. Existing local branches are
/// reused; otherwise a new branch is created from `base_ref` (or `HEAD`).
pub fn create_linked_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
    base_ref: Option<&str>,
) -> Result<LinkedWorktreeInfo, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch cannot be empty".to_string());
    }
    let path_string = worktree_path.to_string_lossy().to_string();
    if worktree_path.exists() {
        return Err(format!("Worktree path already exists: {}", path_string));
    }
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create worktree parent dir: {}", err))?;
    }

    let branch_exists = run_git(repo_path, &["rev-parse", "--verify", branch])
        .map(|output| output.status.success())
        .unwrap_or(false);
    let output = if branch_exists {
        run_git(repo_path, &["worktree", "add", &path_string, branch])?
    } else {
        run_git(
            repo_path,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                &path_string,
                base_ref.unwrap_or("HEAD"),
            ],
        )?
    };

    if !output.status.success() {
        return Err(format!("git worktree add failed: {}", git_stderr(&output)));
    }

    if let Err(err) = run_worktree_setup_hooks(repo_path, worktree_path) {
        let _ = run_git(repo_path, &["worktree", "remove", "--force", &path_string]);
        if !branch_exists {
            let _ = run_git(repo_path, &["branch", "-D", branch]);
        }
        return Err(err);
    }

    let head_sha = run_git(worktree_path, &["rev-parse", "HEAD"])
        .map(|output| git_stdout(&output))
        .unwrap_or_default();
    Ok(LinkedWorktreeInfo {
        path: path_string,
        branch: branch.to_string(),
        head_sha,
    })
}

/// Create an isolated worktree for a coding agent session.
///
/// Creates a new branch from `base_branch` (or current HEAD) and sets up
/// a worktree at `~/.orgii/agent-worktrees/{repo-hash}/{session-id}/`.
///
/// `max_count` — caller-supplied limit from `git.worktree.maxCount`.
/// Falls back to `DEFAULT_MAX_CONCURRENT_WORKTREES` when `None`.
pub fn create_session_worktree(
    repo_path: &Path,
    session_id: &str,
    base_branch: Option<&str>,
    max_count: Option<usize>,
) -> Result<WorktreeInfo, String> {
    validate_session_id(session_id)?;
    let repo_str = repo_path.to_string_lossy().to_string();
    let wt_path = session_worktree_dir(&repo_str, session_id);
    let branch = session_branch_name(session_id);

    // Enforce configurable max concurrent worktrees for this repo
    let limit = max_count.unwrap_or(DEFAULT_MAX_CONCURRENT_WORKTREES);
    let existing = list_session_worktrees(repo_path)?;
    if existing.len() >= limit {
        return Err(format!(
            "Maximum concurrent worktrees ({limit}) reached for this repo. \
             Merge or discard existing sessions first."
        ));
    }

    // Determine base branch
    let base = match base_branch {
        Some(b) => b.to_string(),
        None => current_head_ref(repo_path)?,
    };

    // Clean up stale worktree if path exists but isn't registered
    if wt_path.exists() {
        info!(
            "[worktree] Cleaning up stale worktree directory: {}",
            wt_path.display()
        );
        let _ = run_git(repo_path, &["worktree", "prune"]);
        if wt_path.exists() {
            std::fs::remove_dir_all(&wt_path)
                .map_err(|err| format!("Failed to remove stale worktree: {}", err))?;
        }
    }

    // Delete branch if it exists (stale from previous run)
    let branch_check = run_git(repo_path, &["rev-parse", "--verify", &branch]);
    if let Ok(ref output) = branch_check {
        if output.status.success() {
            info!("[worktree] Deleting stale branch: {}", branch);
            let _ = run_git(repo_path, &["branch", "-D", &branch]);
        }
    }

    // Create parent directory
    if let Some(parent) = wt_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create worktree parent dir: {}", err))?;
    }

    // Create worktree with new branch
    let wt_path_str = wt_path.to_string_lossy().to_string();
    let output = run_git(
        repo_path,
        &["worktree", "add", "-b", &branch, &wt_path_str, &base],
    )?;

    if !output.status.success() {
        let stderr = git_stderr(&output);
        error!("[worktree] Failed to create worktree: {}", stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    info!(
        "[worktree] Created worktree for session {} at {} (branch: {}, base: {})",
        session_id,
        wt_path.display(),
        branch,
        base
    );

    if let Err(err) = run_worktree_setup_hooks(repo_path, &wt_path) {
        let _ = run_git(repo_path, &["worktree", "remove", "--force", &wt_path_str]);
        let _ = run_git(repo_path, &["branch", "-D", &branch]);
        return Err(err);
    }

    Ok(WorktreeInfo {
        path: wt_path_str,
        branch,
        base_branch: Some(base),
        session_id: session_id.to_string(),
    })
}

fn run_worktree_setup_hooks(repo_path: &Path, worktree_path: &Path) -> Result<(), String> {
    // Prefer the canonical path; fall back to the legacy .orgii path so that
    // repos which have not migrated yet still have their hooks executed.
    let config_path = {
        let canonical = repo_path
            .join(WORKTREE_CONFIG_DIR)
            .join(WORKTREE_CONFIG_FILE);
        if canonical.exists() {
            canonical
        } else {
            let legacy = repo_path
                .join(WORKTREE_CONFIG_LEGACY_DIR)
                .join(WORKTREE_CONFIG_FILE);
            if legacy.exists() {
                info!(
                    "[worktree] Using legacy config at {}; consider migrating to {}",
                    legacy.display(),
                    repo_path
                        .join(WORKTREE_CONFIG_DIR)
                        .join(WORKTREE_CONFIG_FILE)
                        .display()
                );
                legacy
            } else {
                return Ok(());
            }
        }
    };

    let content = std::fs::read_to_string(&config_path)
        .map_err(|err| format!("failed to read {}: {}", config_path.display(), err))?;
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse {}: {}", config_path.display(), err))?;

    let mut commands = setup_commands_for_platform(&parsed)?;
    if commands.is_empty() {
        return Ok(());
    }

    info!(
        "[worktree] Running {} setup hook(s) in {}",
        commands.len(),
        worktree_path.display()
    );

    for command in commands.drain(..) {
        run_worktree_setup_command(repo_path, worktree_path, &command)?;
    }

    Ok(())
}

fn setup_commands_for_platform(config: &serde_json::Value) -> Result<Vec<String>, String> {
    let mut commands = read_setup_command_array(config, SETUP_WORKTREE_KEY)?;
    let platform_key = if cfg!(windows) {
        SETUP_WORKTREE_WINDOWS_KEY
    } else {
        SETUP_WORKTREE_UNIX_KEY
    };
    commands.extend(read_setup_command_array(config, platform_key)?);
    Ok(commands)
}

fn read_setup_command_array(config: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    let Some(value) = config.get(key) else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .ok_or_else(|| format!("{} must be an array of shell command strings", key))?;
    let mut commands = Vec::with_capacity(array.len());
    for entry in array {
        let command = entry
            .as_str()
            .ok_or_else(|| format!("{} entries must be shell command strings", key))?
            .trim();
        if !command.is_empty() {
            commands.push(command.to_string());
        }
    }
    Ok(commands)
}

fn run_worktree_setup_command(
    repo_path: &Path,
    worktree_path: &Path,
    command: &str,
) -> Result<(), String> {
    run_worktree_setup_command_with_timeout(
        repo_path,
        worktree_path,
        command,
        WORKTREE_SETUP_COMMAND_TIMEOUT,
    )
}

pub(crate) fn run_worktree_setup_command_with_timeout(
    repo_path: &Path,
    worktree_path: &Path,
    command: &str,
    timeout: Duration,
) -> Result<(), String> {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = Command::new("sh");
        process.arg("-c").arg(command);
        process
    };

    // Suppress the transient console window the spawned `cmd` would otherwise
    // flash on Windows (the GUI binary has no console of its own).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(super::util::CREATE_NO_WINDOW);
    }

    process
        .current_dir(worktree_path)
        .env(ROOT_WORKTREE_PATH_ENV, repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    process.process_group(0);
    super::util::close_inherited_fds(&mut process);

    let mut child = process.spawn().map_err(|err| {
        format!(
            "failed to run worktree setup command {:?}: {}",
            command, err
        )
    })?;
    let child_id = child.id();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child_id as i32), libc::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let mut taskkill = Command::new("taskkill");
                    taskkill.args(["/PID", &child_id.to_string(), "/T", "/F"]);
                    use std::os::windows::process::CommandExt;
                    taskkill.creation_flags(super::util::CREATE_NO_WINDOW);
                    let _ = taskkill.output();
                }
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!(
                    "worktree setup command timed out after {}s and was terminated: {}",
                    timeout.as_secs_f64(),
                    command
                ));
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!("failed waiting for worktree setup command: {err}"));
            }
        }
    };
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    if status.success() {
        return Ok(());
    }

    Err(format!(
        "worktree setup command failed: {}\nstatus: {:?}\nstdout:\n{}\nstderr:\n{}",
        command,
        status.code(),
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ))
}

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

/// Snapshot of a session worktree's unmerged work, used to decide whether
/// post-run cleanup may destroy it (see the agent tool's worktree
/// disposition: keep when dirty/ahead, remove only when clean).
#[derive(Debug, Clone)]
pub struct SessionWorktreeState {
    pub worktree_path: PathBuf,
    pub branch: String,
    pub worktree_exists: bool,
    /// Uncommitted changes in the worktree (`git status --porcelain`).
    pub dirty: bool,
    /// Commits on the session branch that are not on the base branch.
    /// Always 0 when the caller does not know the base branch.
    pub commits_ahead_of_base: u64,
}

impl SessionWorktreeState {
    /// True when removing the worktree + branch would destroy work.
    pub fn has_changes(&self) -> bool {
        self.dirty || self.commits_ahead_of_base > 0
    }
}

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
        if stderr.contains("nothing to commit") {
            return Ok(false);
        }
        return Err(format!("git commit failed: {}", stderr));
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

/// Entry from `git worktree list` for the general (non-agent) listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralWorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head_sha: String,
    pub is_main: bool,
}

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

/// Parse the porcelain output of `git worktree list --porcelain`.
///
/// Extracted as a pure function so it can be unit-tested without a real repo.
pub(crate) fn parse_worktree_list_porcelain(stdout: &str) -> Vec<GeneralWorktreeEntry> {
    let mut entries = Vec::new();
    let mut is_first = true;

    for entry in stdout.split("\n\n") {
        if entry.trim().is_empty() {
            continue;
        }

        let mut wt_path = String::new();
        let mut wt_branch = String::new();
        let mut head_sha = String::new();
        let mut is_bare = false;

        for line in entry.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                wt_path = path.to_string();
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                wt_branch = branch_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch_ref)
                    .to_string();
            } else if let Some(sha) = line.strip_prefix("HEAD ") {
                head_sha = sha.to_string();
            } else if line == "bare" {
                is_bare = true;
            }
        }

        if wt_path.is_empty() || is_bare {
            is_first = false;
            continue;
        }

        entries.push(GeneralWorktreeEntry {
            path: wt_path,
            branch: wt_branch,
            head_sha,
            is_main: is_first,
        });
        is_first = false;
    }

    entries
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
