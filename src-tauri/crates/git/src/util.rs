//! Shared git subprocess utilities — retry logic and FD-safe spawning
//!
//! Used by both `git/watch` and `api/git/commands` so FD-safety is
//! applied consistently in one place.
//!
//! **FD safety (Unix):** before spawning any `git` subprocess, `pre_exec`
//! closes all inherited file descriptors (3–1024) to prevent
//! "Bad file descriptor (os error 9)" from WebView FD leakage.
//! See: `docs/development/bad-file-descriptor-root-cause-0124.md`
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use app_paths::{system_git_candidate_paths, system_git_executable};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

// ============================================
// Constants
// ============================================

/// Default retry count for git commands
pub const DEFAULT_RETRIES: u32 = 5;

/// Base delay between retries in milliseconds
const RETRY_BASE_DELAY_MS: u64 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGitExecutable {
    pub path: PathBuf,
}

// ============================================
// Error Detection
// ============================================

/// Check if an error is a transient system error that can be retried
pub fn is_transient_error(error_msg: &str) -> bool {
    error_msg.contains("Bad file descriptor")
        || error_msg.contains("Resource temporarily unavailable")
        || error_msg.contains("os error 9")
        || error_msg.contains("Too many open files")
        || error_msg.contains("os error 24")
}

/// Convert technical error messages to user-friendly messages
pub fn user_friendly_error(technical_error: &str, operation: &str) -> String {
    if is_transient_error(technical_error) {
        format!(
            "The system is busy processing other requests. Please try {} again in a moment. ({})",
            operation, technical_error
        )
    } else if technical_error.contains("not a git repository") {
        "This folder is not a git repository.".to_string()
    } else if technical_error.contains("permission denied")
        || technical_error.contains("Permission denied")
    {
        "Permission denied. Please check file permissions.".to_string()
    } else {
        format!("Git operation failed: {}", technical_error)
    }
}

/// Get a human-readable operation name from git args
pub fn operation_name_from_args(args: &[&str]) -> &'static str {
    match args.first() {
        Some(&"status") => "checking status",
        Some(&"branch") => "branch operation",
        Some(&"checkout") => "checkout",
        Some(&"commit") => "commit",
        Some(&"push") => "push",
        Some(&"pull") => "pull",
        Some(&"fetch") => "fetch",
        Some(&"merge") => "merge",
        Some(&"rebase") => "rebase",
        Some(&"stash") => "stash operation",
        Some(&"log") => "viewing history",
        Some(&"diff") => "viewing changes",
        Some(&"add") => "staging files",
        Some(&"reset") => "reset",
        Some(&"revert") => "revert",
        Some(&"cherry-pick") => "cherry-pick",
        Some(&"remote") => "remote operation",
        Some(&"rev-parse") => "this operation",
        Some(&"rev-list") => "this operation",
        Some(&"symbolic-ref") => "this operation",
        Some(&"show-ref") => "this operation",
        _ => "this operation",
    }
}

// ============================================
// Core Git Command Execution
// ============================================

pub fn resolved_git_executable() -> Result<PathBuf, String> {
    resolved_git_executable_details().map(|resolved| resolved.path)
}

pub fn resolved_git_executable_details() -> Result<ResolvedGitExecutable, String> {
    resolve_git_executable_from_candidates(system_git_executable(), system_git_candidate_paths())
}

pub fn resolve_git_executable_from_candidates(
    system_git: Option<PathBuf>,
    system_candidates: Vec<PathBuf>,
) -> Result<ResolvedGitExecutable, String> {
    system_git
        .map(|path| ResolvedGitExecutable { path })
        .ok_or_else(|| {
            format!(
                "System Git executable not found or not runnable. Checked: {}",
                format_candidate_paths(system_candidates)
            )
        })
}

fn format_candidate_paths(paths: Vec<PathBuf>) -> String {
    paths
        .into_iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Windows `CREATE_NO_WINDOW` process creation flag.
///
/// The app binary is built with `windows_subsystem = "windows"`, so it has no
/// console of its own. Every console subprocess we spawn (here: `git`) would
/// otherwise allocate a *new* console window that flashes on screen. Because
/// git status polling runs frequently (file watcher / status bar), the user
/// sees terminals "keep coming out". Passing this flag suppresses the window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn git_command() -> Result<Command, String> {
    let git_executable = resolved_git_executable_details()?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(&git_executable.path);
        command.creation_flags(CREATE_NO_WINDOW);
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Ok(Command::new(&git_executable.path))
    }
}

pub fn tokio_git_command() -> Result<tokio::process::Command, String> {
    let git_executable = resolved_git_executable_details()?;
    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new(&git_executable.path);
        command.creation_flags(CREATE_NO_WINDOW);
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Ok(tokio::process::Command::new(&git_executable.path))
    }
}

#[cfg(unix)]
pub fn close_inherited_fds(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            for fd in 3..1024 {
                libc::close(fd);
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub fn close_inherited_fds(_command: &mut Command) {}

/// Spawn a git command with pre_exec FD safety on Unix.
/// This is the low-level spawn that ensures file descriptors from WebView
/// are not inherited by the git process.
///
/// Returns the child process spawn result (not waited).
fn spawn_git_command_internal(args: &[&str], cwd: &Path) -> std::io::Result<std::process::Child> {
    let mut cmd = git_command().map_err(std::io::Error::other)?;
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    close_inherited_fds(&mut cmd);

    cmd.spawn()
}

/// Run git command with retry logic for transient system errors.
/// Uses pre_exec on Unix to close inherited file descriptors.
///
/// # Arguments
/// * `repo_path` - Path to the git repository
/// * `args` - Git command arguments (e.g., ["status", "--porcelain"])
/// * `max_retries` - Maximum number of retry attempts
///
/// # Returns
/// * `Ok(Output)` - Command output on success
/// * `Err(String)` - Error message if all retries fail
pub fn run_git_with_retry(
    repo_path: &Path,
    args: &[&str],
    max_retries: u32,
) -> Result<Output, String> {
    let mut last_error = String::new();

    for attempt in 0..max_retries {
        match spawn_git_command_internal(args, repo_path) {
            Ok(child) => match child.wait_with_output() {
                Ok(output) => return Ok(output),
                Err(e) => {
                    last_error = format!("{}", e);
                }
            },
            Err(e) => {
                last_error = format!("{}", e);

                // Only retry transient errors
                if !is_transient_error(&last_error) {
                    return Err(format!("Failed to spawn git {:?}: {}", args, e));
                }
            }
        }

        // Brief pause before retry (exponential backoff)
        if attempt < max_retries - 1 {
            let delay = RETRY_BASE_DELAY_MS * (1 << attempt); // 2^attempt * base
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
    }

    Err(format!(
        "git {:?} failed after {} retries: {}",
        args, max_retries, last_error
    ))
}

/// Run git command with retry logic, returning user-friendly errors.
/// Uses pre_exec on Unix to close inherited file descriptors.
///
/// This is the preferred function for user-facing operations as it
/// provides helpful error messages.
pub fn run_git_with_retry_friendly(
    repo_path: &Path,
    args: &[&str],
    max_retries: u32,
) -> Result<Output, String> {
    let operation = operation_name_from_args(args);

    run_git_with_retry(repo_path, args, max_retries).map_err(|e| user_friendly_error(&e, operation))
}

/// Run git command with default retry count (5 retries) and user-friendly errors.
/// Convenience wrapper for run_git_with_retry_friendly with standard retry count.
pub fn run_git(repo_path: &Path, args: &[&str]) -> Result<Output, String> {
    run_git_with_retry_friendly(repo_path, args, DEFAULT_RETRIES)
}

/// Run git command with --no-optional-locks flag for status operations.
/// This reduces lock contention when checking status frequently.
pub fn run_git_status_with_retry(
    repo_path: &Path,
    args: &[&str],
    max_retries: u32,
) -> Result<Output, String> {
    // Prepend --no-optional-locks to reduce lock contention
    let mut git_args = vec!["--no-optional-locks"];
    git_args.extend_from_slice(args);

    // Convert Vec<&str> to slice for the call
    let args_slice: Vec<&str> = git_args.to_vec();
    run_git_with_retry(repo_path, &args_slice, max_retries)
}

// ============================================
// Git Proxy Detection
// ============================================

#[derive(serde::Serialize, Default)]
pub struct GitProxyInfo {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub source: Option<String>,
}

/// Read a single git config key. Returns None if unset.
fn read_git_config_key(repo_path: Option<&Path>, key: &str) -> Option<String> {
    let mut cmd = git_command().ok()?;
    cmd.args(["config", "--get", key])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }
    close_inherited_fds(&mut cmd);
    let output = cmd.output().ok()?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    } else {
        None
    }
}

/// Read a key from the user's global Git config without allowing repository or
/// system-level values to participate in resolution.
fn read_global_git_config_key(key: &str) -> Option<String> {
    let mut cmd = git_command().ok()?;
    cmd.args(["config", "--global", "--get", key])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    close_inherited_fds(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Detect git proxy configuration from git config and environment variables.
/// Checks repo-level config first, then global, then env vars.
#[tauri::command]
pub async fn get_git_proxy_config(repo_path: Option<String>) -> Result<GitProxyInfo, String> {
    tokio::task::spawn_blocking(move || {
        let path = repo_path.as_deref().map(Path::new);

        // 1. Try git config (respects repo > global > system precedence)
        let http_proxy = read_git_config_key(path, "http.proxy");
        let https_proxy = read_git_config_key(path, "https.proxy");

        if http_proxy.is_some() || https_proxy.is_some() {
            return GitProxyInfo {
                http_proxy,
                https_proxy,
                source: Some("git config".to_string()),
            };
        }

        let env_http_proxy = std::env::var("HTTP_PROXY")
            .ok()
            .or_else(|| std::env::var("http_proxy").ok())
            .filter(|v| !v.is_empty());
        let env_https_proxy = std::env::var("HTTPS_PROXY")
            .ok()
            .or_else(|| std::env::var("https_proxy").ok())
            .or_else(|| std::env::var("ALL_PROXY").ok())
            .or_else(|| std::env::var("all_proxy").ok())
            .filter(|v| !v.is_empty());

        let env_source = if env_http_proxy.is_some() || env_https_proxy.is_some() {
            Some("environment".to_string())
        } else {
            None
        };

        GitProxyInfo {
            http_proxy: env_http_proxy,
            https_proxy: env_https_proxy,
            source: env_source,
        }
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))
}

/// Write a single git config key at the given scope.
fn write_git_config_key(
    repo_path: Option<&Path>,
    key: &str,
    value: &str,
    global: bool,
) -> Result<(), String> {
    let mut cmd = git_command()?;
    if global {
        cmd.args(["config", "--global", key, value]);
    } else {
        cmd.args(["config", key, value]);
    }
    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    close_inherited_fds(&mut cmd);
    let output = cmd
        .output()
        .map_err(|err| format!("Failed to run git config: {}", err))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git config failed: {}", stderr))
    }
}

/// Remove a single git config key at the given scope.
fn unset_git_config_key(repo_path: Option<&Path>, key: &str, global: bool) -> Result<(), String> {
    let mut cmd = git_command()?;
    if global {
        cmd.args(["config", "--global", "--unset", key]);
    } else {
        cmd.args(["config", "--unset", key]);
    }
    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    close_inherited_fds(&mut cmd);
    let output = cmd
        .output()
        .map_err(|err| format!("Failed to run git config: {}", err))?;
    // Exit code 5 means the key was not set — treat as success
    if output.status.success() || output.status.code() == Some(5) {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git config --unset failed: {}", stderr))
    }
}

/// Set git proxy configuration (writes to global git config by default,
/// or repo-level if repo_path is provided and global is false).
#[tauri::command]
pub async fn set_git_proxy_config(
    http_proxy: Option<String>,
    https_proxy: Option<String>,
    repo_path: Option<String>,
    global: Option<bool>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = repo_path.as_deref().map(Path::new);
        let is_global = global.unwrap_or(true);

        if let Some(ref value) = http_proxy {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                unset_git_config_key(path, "http.proxy", is_global)?;
            } else {
                write_git_config_key(path, "http.proxy", trimmed, is_global)?;
            }
        }

        if let Some(ref value) = https_proxy {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                unset_git_config_key(path, "https.proxy", is_global)?;
            } else {
                write_git_config_key(path, "https.proxy", trimmed, is_global)?;
            }
        }

        Ok(())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Remove git proxy configuration entirely.
#[tauri::command]
pub async fn unset_git_proxy_config(
    repo_path: Option<String>,
    global: Option<bool>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = repo_path.as_deref().map(Path::new);
        let is_global = global.unwrap_or(true);

        unset_git_config_key(path, "http.proxy", is_global)?;
        unset_git_config_key(path, "https.proxy", is_global)?;

        Ok(())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

// ============================================
// Git User Identity
// ============================================

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct GitUserIdentity {
    pub email: Option<String>,
    pub name: Option<String>,
    /// GitHub username from `~/.config/gh/hosts.yml` (gh CLI)
    pub github_username: Option<String>,
}

/// The identity-related subset of the user's global Git config that can be
/// captured as an ORGII Git profile and switched as one unit.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, Default)]
pub struct GitGlobalProfile {
    pub name: String,
    pub email: String,
    pub signing_key: Option<String>,
    pub sign_commits: bool,
}

fn git_config_bool_is_true(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "yes" | "on" | "1"
    )
}

/// Read the GitHub username from the `gh` CLI config file.
fn read_gh_cli_username() -> Option<String> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".config/gh/hosts.yml");
    let content = std::fs::read_to_string(config_path).ok()?;

    // Look for "user: <username>" under "github.com:"
    let mut in_github = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("github.com") {
            in_github = true;
            continue;
        }
        // If we hit another top-level host, stop
        if in_github && !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.is_empty() {
            break;
        }
        if in_github && trimmed.starts_with("user:") {
            let username = trimmed.strip_prefix("user:")?.trim().to_string();
            if !username.is_empty() {
                return Some(username);
            }
        }
    }
    None
}

/// Read git user.email, user.name, and GitHub username.
#[tauri::command]
pub async fn get_git_user_identity(repo_path: Option<String>) -> Result<GitUserIdentity, String> {
    tokio::task::spawn_blocking(move || {
        let path = repo_path.as_deref().map(Path::new);
        GitUserIdentity {
            email: read_git_config_key(path, "user.email"),
            name: read_git_config_key(path, "user.name"),
            github_username: read_gh_cli_username(),
        }
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))
}

/// Read the identity-related values from the user's global Git config.
#[tauri::command]
pub async fn get_git_global_profile() -> Result<GitGlobalProfile, String> {
    tokio::task::spawn_blocking(move || {
        let sign_commits = read_global_git_config_key("commit.gpgsign")
            .is_some_and(|value| git_config_bool_is_true(&value));
        GitGlobalProfile {
            name: read_global_git_config_key("user.name").unwrap_or_default(),
            email: read_global_git_config_key("user.email").unwrap_or_default(),
            signing_key: read_global_git_config_key("user.signingkey"),
            sign_commits,
        }
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))
}

/// Activate a Git profile by writing its identity-related values to the user's
/// global Git config. Empty optional values remove the corresponding key so a
/// previously-active profile cannot leak into the new one.
#[tauri::command]
pub async fn set_git_global_profile(profile: GitGlobalProfile) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let name = profile.name.trim();
        let email = profile.email.trim();
        if name.is_empty() {
            return Err("Git profile name cannot be empty".to_string());
        }
        if email.is_empty() {
            return Err("Git profile email cannot be empty".to_string());
        }

        write_git_config_key(None, "user.name", name, true)?;
        write_git_config_key(None, "user.email", email, true)?;

        match profile.signing_key.as_deref().map(str::trim) {
            Some(signing_key) if !signing_key.is_empty() => {
                write_git_config_key(None, "user.signingkey", signing_key, true)?;
            }
            _ => unset_git_config_key(None, "user.signingkey", true)?,
        }

        write_git_config_key(
            None,
            "commit.gpgsign",
            if profile.sign_commits {
                "true"
            } else {
                "false"
            },
            true,
        )
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[cfg(test)]
mod git_profile_tests {
    use super::git_config_bool_is_true;

    #[test]
    fn parses_git_boolean_spellings() {
        for truthy in ["true", "TRUE", "yes", "on", "1"] {
            assert!(git_config_bool_is_true(truthy));
        }
        for falsy in ["false", "no", "off", "0", ""] {
            assert!(!git_config_bool_is_true(falsy));
        }
    }
}
