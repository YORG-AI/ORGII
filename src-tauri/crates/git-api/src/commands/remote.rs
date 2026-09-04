/**
 * Remote Operations
 *
 * Manage remotes, push, pull, fetch.
 * All operations use retry logic for transient errors.
 */
#[cfg(test)]
#[path = "tests/remote_tests.rs"]
mod tests;

use super::utils::run_git;
use crate::types::*;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use git::{close_inherited_fds, git_command};
use std::io::Write;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

const GIT_CREDENTIAL_FILL_TIMEOUT: Duration = Duration::from_millis(1_200);

/// List remotes without requiring a system Git executable.
///
/// Remote discovery is read-only repository metadata. Using libgit2 here
/// keeps workspace identity resolution available on clean Windows installs,
/// where New Session can already select a registered checkout even though
/// `git.exe` is not installed yet.
pub fn list_remotes(repo_path: &Path) -> Result<Vec<GitRemoteInfo>, String> {
    // A selected workspace may be a package/subfolder rather than the Git
    // root. Match `git -C <folder>` semantics by discovering upward.
    let repository = git2::Repository::discover(repo_path).map_err(|error| {
        format!(
            "Not a git repository at {}: {}",
            repo_path.display(),
            error.message()
        )
    })?;
    let remote_names = repository
        .remotes()
        .map_err(|error| format!("Failed to read git remotes: {}", error.message()))?;
    let mut remotes = Vec::new();

    for name in remote_names.iter().flatten() {
        let remote = repository
            .find_remote(name)
            .map_err(|error| format!("Failed to read git remote {name}: {}", error.message()))?;
        let fetch_url = remote.url().map(ToString::to_string);
        // Git uses the fetch URL for pushes when no separate pushurl exists.
        let push_url = remote
            .pushurl()
            .map(ToString::to_string)
            .or_else(|| fetch_url.clone());
        let Some(url) = fetch_url.clone().or_else(|| push_url.clone()) else {
            continue;
        };

        remotes.push(GitRemoteInfo {
            name: name.to_string(),
            url,
            fetch_url,
            push_url,
        });
    }

    remotes.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(remotes)
}

/// Add a remote
pub fn add_remote(repo_path: &Path, name: &str, url: &str) -> Result<GitRemoteInfo, String> {
    let output = run_git(repo_path, &["remote", "add", name, url])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(GitRemoteInfo {
        name: name.to_string(),
        url: url.to_string(),
        fetch_url: Some(url.to_string()),
        push_url: Some(url.to_string()),
    })
}

/// Update remote URL
pub fn update_remote(repo_path: &Path, name: &str, url: &str) -> Result<GitRemoteInfo, String> {
    let output = run_git(repo_path, &["remote", "set-url", name, url])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(GitRemoteInfo {
        name: name.to_string(),
        url: url.to_string(),
        fetch_url: Some(url.to_string()),
        push_url: Some(url.to_string()),
    })
}

/// Delete a remote
pub fn delete_remote(repo_path: &Path, name: &str) -> Result<(), String> {
    let output = run_git(repo_path, &["remote", "remove", name])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct CredentialTarget {
    protocol: String,
    host: String,
    path: Option<String>,
}

fn credential_target_from_remote(remote_url: &str) -> Option<CredentialTarget> {
    let trimmed = remote_url.trim();
    let without_protocol = trimmed.strip_prefix("https://")?;
    let (host, path) = without_protocol
        .split_once('/')
        .map_or((without_protocol, None), |(host, path)| (host, Some(path)));
    if host.is_empty() {
        return None;
    }
    Some(CredentialTarget {
        protocol: "https".to_string(),
        host: host.to_string(),
        path: path.map(ToString::to_string),
    })
}

fn credential_input_for_target(target: &CredentialTarget) -> String {
    let mut input = format!("protocol={}\nhost={}\n", target.protocol, target.host);
    if let Some(path) = &target.path {
        input.push_str(&format!("path={path}\n"));
    }
    input.push('\n');
    input
}

fn parse_credential_output(output: &str) -> GitCredentialFillResult {
    let mut username = None;
    let mut password = None;

    for line in output.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("password=") {
            password = Some(value.to_string());
        }
    }

    GitCredentialFillResult {
        found: username.as_ref().is_some_and(|value| !value.is_empty())
            && password.as_ref().is_some_and(|value| !value.is_empty()),
        username,
        password,
    }
}

pub fn fill_git_credentials(
    repo_path: &Path,
    remote_url: &str,
) -> Result<GitCredentialFillResult, String> {
    let Some(target) = credential_target_from_remote(remote_url) else {
        return Ok(GitCredentialFillResult {
            found: false,
            username: None,
            password: None,
        });
    };

    let mut command = git_command()?;
    command
        .args([
            "-c",
            "credential.interactive=false",
            "-c",
            "core.askPass=",
            "credential",
            "fill",
        ])
        .current_dir(repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    close_inherited_fds(&mut command);

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to run git credential fill: {err}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(credential_input_for_target(&target).as_bytes())
            .map_err(|err| format!("Failed to write credential query: {err}"))?;
    }

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|err| format!("Failed to read credential fill output: {err}"))?;
                if !output.status.success() {
                    return Ok(GitCredentialFillResult {
                        found: false,
                        username: None,
                        password: None,
                    });
                }
                return Ok(parse_credential_output(&String::from_utf8_lossy(
                    &output.stdout,
                )));
            }
            Ok(None) if started_at.elapsed() >= GIT_CREDENTIAL_FILL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(GitCredentialFillResult {
                    found: false,
                    username: None,
                    password: None,
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to poll credential fill: {err}"));
            }
        }
    }
}

fn approve_git_credentials(repo_path: &Path, username: &str, token: &str) {
    let credential_input =
        format!("protocol=https\nhost=github.com\nusername={username}\npassword={token}\n\n");

    let Ok(mut command) = git_command() else {
        return;
    };

    command
        .args([
            "-c",
            "credential.interactive=false",
            "-c",
            "core.askPass=",
            "credential",
            "approve",
        ])
        .current_dir(repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    close_inherited_fds(&mut command);

    let Ok(mut child) = command.spawn() else {
        return;
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(credential_input.as_bytes());
    }

    let _ = child.wait();
}

fn run_remote_git(
    repo_path: &Path,
    args: &[&str],
    auth_username: Option<&str>,
    auth_token: Option<&str>,
    store_auth: bool,
) -> Result<Output, String> {
    if let (Some(username), Some(token)) = (auth_username, auth_token) {
        let basic_value = BASE64_STANDARD.encode(format!("{username}:{token}"));
        let auth_header = format!("Authorization: Basic {basic_value}");
        let mut command = git_command()?;
        command
            .args(["-c", "credential.interactive=false", "-c", "core.askPass="])
            .args(args)
            .current_dir(repo_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("GCM_INTERACTIVE", "Never")
            .env("GCM_MODAL_PROMPT", "0")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraHeader")
            .env("GIT_CONFIG_VALUE_0", auth_header)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        close_inherited_fds(&mut command);
        let output = command
            .output()
            .map_err(|err| format!("Failed to run authenticated git {:?}: {err}", args))?;
        if store_auth && output.status.success() {
            approve_git_credentials(repo_path, username, token);
        }
        return Ok(output);
    }

    let mut command = git_command()?;
    command
        .args(["-c", "credential.interactive=false", "-c", "core.askPass="])
        .args(args)
        .current_dir(repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    close_inherited_fds(&mut command);
    command
        .output()
        .map_err(|err| format!("Failed to run git {:?}: {err}", args))
}

/// True when `needle` occurs in `haystack` as a whole word — not embedded in
/// a longer identifier. Git output quotes URLs, branch names, and paths, so a
/// bare substring match on short tokens like "sso" fires on "processor" or
/// "associate" and misroutes ordinary failures into the auth dialog.
pub(crate) fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let before_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric();
        let after = abs + needle.len();
        let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

/// Whether a push should pass `-u` for the current branch.
///
/// - No upstream configured: yes.
/// - Upstream on the push remote but under a different branch name (the
///   renamed-branch scenario): yes.
/// - Upstream already `<remote>/<current>`: no.
/// - Upstream on a *different* remote: no — that is deliberate user
///   configuration, and `-u` would silently overwrite it.
///
/// The previous implementation compared only the last `/`-segment of the
/// upstream ref, so every branch with a slash in its name ("feat/x" vs the
/// segment "x") re-set its upstream on every push.
pub(crate) fn should_set_upstream(
    upstream: Option<&str>,
    current_branch: &str,
    remote: &str,
) -> bool {
    match upstream {
        None => true,
        Some(upstream) => match upstream.strip_prefix(&format!("{remote}/")) {
            Some(short) => short != current_branch,
            None => false,
        },
    }
}

/// Detect error type from push error message
pub(crate) fn detect_push_error_type(message: &str) -> GitErrorType {
    let lower = message.to_lowercase();

    // Protected branch / server-side policy rejection. Checked BEFORE the
    // non-fast-forward patterns: git appends "error: failed to push some refs"
    // to every rejection, so the broader non-fast-forward arm would otherwise
    // shadow this one and the UI would tell the user to pull, which cannot
    // help against a policy rejection.
    if lower.contains("protected branch")
        || lower.contains("branch is protected")
        || lower.contains("cannot push to")
        || lower.contains("pre-receive hook declined")
        || lower.contains("remote rejected")
    {
        return GitErrorType::ProtectedBranch;
    }

    // Non-fast-forward (remote has changes we don't have)
    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("updates were rejected")
        || lower.contains("failed to push some refs")
    {
        return GitErrorType::NonFastForward;
    }

    // Authentication failed
    if lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("invalid username or password")
        || lower.contains("invalid username or token")
        || lower.contains("bad credentials")
        || lower.contains("http basic: access denied")
        || lower.contains("could not read username")
        || lower.contains("unable to get password from user")
        || lower.contains("permission denied")
        || lower.contains("fatal: authentication")
        || lower.contains("repository not found")
        || contains_word(&lower, "saml")
        || contains_word(&lower, "sso")
        || lower.contains("password authentication was removed")
        || lower.contains("requested url returned error: 403")
    {
        return GitErrorType::AuthenticationFailed;
    }

    // Network error
    if lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("unable to access")
        || lower.contains("connection timed out")
    {
        return GitErrorType::NetworkError;
    }

    GitErrorType::Unknown
}

/// Push to remote
pub fn push_to_remote(repo_path: &Path, request: &PushRequest) -> Result<GitPushResult, String> {
    let remote_name = request.remote.as_deref().unwrap_or("origin");

    // Get current branch name
    let current_branch = run_git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    // Check if upstream exists and matches current branch name
    let upstream_branch = current_branch.as_ref().and_then(|cb| {
        let upstream_ref = format!("{}@{{upstream}}", cb);
        run_git(repo_path, &["rev-parse", "--abbrev-ref", &upstream_ref])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });

    // Determine if we need to set upstream
    let needs_set_upstream = request.set_upstream
        || match (&current_branch, &upstream_branch) {
            (Some(current), upstream) => {
                should_set_upstream(upstream.as_deref(), current, remote_name)
            }
            (None, upstream) => upstream.is_none(),
        };

    let mut args = vec!["push"];

    if needs_set_upstream {
        args.push("-u");
    }

    if request.force {
        args.push("--force");
    }

    args.push(remote_name);

    // Use explicit branch name if provided, otherwise use current branch
    if let Some(b) = request.branch.as_deref() {
        args.push(b);
    } else if let Some(ref cb) = current_branch {
        // Push current branch to same-named remote branch
        args.push(cb);
    }

    log::info!("[GitAPI] Executing: git {:?}", args);

    let output = run_remote_git(
        repo_path,
        &args,
        request.auth_username.as_deref(),
        request.auth_token.as_deref(),
        request.store_auth,
    )?;

    let message = if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Git often writes success info to stderr
        if stdout.is_empty() {
            stderr.to_string()
        } else {
            stdout.to_string()
        }
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };

    let error_type = if output.status.success() {
        GitErrorType::None
    } else {
        detect_push_error_type(&message)
    };

    Ok(GitPushResult {
        success: output.status.success(),
        message,
        error_type,
    })
}

/// Detect error type from pull error message
pub(crate) fn detect_pull_error_type(message: &str) -> (GitErrorType, Option<Vec<String>>) {
    let lower = message.to_lowercase();

    // Uncommitted changes would be overwritten
    if lower.contains("would be overwritten")
        || lower.contains("your local changes")
        || lower.contains("uncommitted changes")
        || lower.contains("please commit your changes or stash them")
    {
        // Git lists the blocking files one per line, tab-indented. The prefix
        // must be tested on the raw line — trimming first strips the very tab
        // being tested for.
        let mut affected_files = Vec::new();
        for line in message.lines() {
            if let Some(file) = line.strip_prefix('\t') {
                let file = file.trim();
                if !file.is_empty() {
                    affected_files.push(file.to_string());
                }
            }
        }
        return (
            GitErrorType::UncommittedChanges,
            if affected_files.is_empty() {
                None
            } else {
                Some(affected_files)
            },
        );
    }

    // Merge conflicts
    if lower.contains("conflict") || lower.contains("automatic merge failed") {
        return (GitErrorType::MergeConflicts, None);
    }

    // Authentication failed
    if lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("invalid username or password")
        || lower.contains("invalid username or token")
        || lower.contains("bad credentials")
        || lower.contains("http basic: access denied")
        || lower.contains("could not read username")
        || lower.contains("unable to get password from user")
        || lower.contains("repository not found")
        || contains_word(&lower, "saml")
        || contains_word(&lower, "sso")
        || lower.contains("password authentication was removed")
        || lower.contains("requested url returned error: 403")
    {
        return (GitErrorType::AuthenticationFailed, None);
    }

    // Network error
    if lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("unable to access")
        || lower.contains("connection timed out")
    {
        return (GitErrorType::NetworkError, None);
    }

    (GitErrorType::Unknown, None)
}

/// Strategy flags for `git pull`.
///
/// Rebase pulls carry `--autostash`: without it git refuses to start whenever
/// the working tree is dirty at all ("cannot pull with rebase: You have
/// unstaged changes"), even when nothing overlaps the incoming commits.
/// Autostash restores parity with merge pulls, which natively tolerate
/// non-overlapping local changes and still stop on genuine overlap.
pub(crate) fn pull_strategy_args(strategy: Option<&str>) -> &'static [&'static str] {
    match strategy {
        Some("rebase") => &["--rebase", "--autostash"],
        Some("ff-only") => &["--ff-only"],
        _ => &["--no-rebase"], // merge or unknown → explicit merge
    }
}

/// Pull from remote
pub fn pull_from_remote(
    repo_path: &Path,
    remote: Option<&str>,
    branch: Option<&str>,
    strategy: Option<&str>,
    auth_username: Option<&str>,
    auth_token: Option<&str>,
    store_auth: bool,
) -> Result<GitPullResult, String> {
    let mut args = vec!["pull"];
    args.extend_from_slice(pull_strategy_args(strategy));

    if let Some(r) = remote {
        args.push(r);
    }

    if let Some(b) = branch {
        args.push(b);
    }

    let output = run_remote_git(repo_path, &args, auth_username, auth_token, store_auth)?;

    // Git splits meaningful pull output across both streams: the merge
    // machinery reports "CONFLICT (content): …" on stdout while stderr carries
    // only fetch progress, and a successful pull puts the autostash-conflict
    // warning ("Your changes are safe in the stash") on stderr. Classification
    // and the conflict sniff below must see both, in both branches.
    let message = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    // Check for conflicts
    let conflicts = if message.contains("CONFLICT") || message.contains("conflict") {
        // Get list of conflicted files (also uses retry via run_git)
        run_git(repo_path, &["diff", "--name-only", "--diff-filter=U"])
            .ok()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|s| s.to_string())
                    .collect()
            })
    } else {
        None
    };

    let (error_type, affected_files) = if output.status.success() {
        (GitErrorType::None, None)
    } else {
        detect_pull_error_type(&message)
    };

    Ok(GitPullResult {
        success: output.status.success(),
        message,
        conflicts,
        error_type,
        affected_files,
    })
}

/// Parse deleted branches from fetch output
fn parse_deleted_branches(message: &str) -> Option<Vec<String>> {
    let mut deleted = Vec::new();

    for line in message.lines() {
        let trimmed = line.trim();
        // Git prune output format: " - [deleted]         (none)     -> origin/branch-name"
        if trimmed.contains("[deleted]") {
            // Extract branch name after "->"
            if let Some(pos) = trimmed.find("->") {
                let branch = trimmed[pos + 2..].trim().to_string();
                if !branch.is_empty() {
                    deleted.push(branch);
                }
            }
        }
    }

    if deleted.is_empty() {
        None
    } else {
        Some(deleted)
    }
}

/// Detect error type from fetch error message
pub(crate) fn detect_fetch_error_type(message: &str) -> GitErrorType {
    let lower = message.to_lowercase();

    // Authentication failed
    if lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("invalid username or password")
        || lower.contains("invalid username or token")
        || lower.contains("bad credentials")
        || lower.contains("http basic: access denied")
        || lower.contains("could not read username")
        || lower.contains("unable to get password from user")
        || lower.contains("repository not found")
        || contains_word(&lower, "saml")
        || contains_word(&lower, "sso")
        || lower.contains("password authentication was removed")
        || lower.contains("requested url returned error: 403")
    {
        return GitErrorType::AuthenticationFailed;
    }

    // Network error
    if lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("unable to access")
        || lower.contains("connection timed out")
    {
        return GitErrorType::NetworkError;
    }

    GitErrorType::Unknown
}

/// Fetch from remote
pub fn fetch_from_remote(
    repo_path: &Path,
    remote: Option<&str>,
    prune: bool,
    auth_username: Option<&str>,
    auth_token: Option<&str>,
    store_auth: bool,
) -> Result<GitFetchResult, String> {
    let mut args = vec!["fetch"];

    if prune {
        args.push("--prune");
    }

    if let Some(r) = remote {
        args.push(r);
    } else {
        args.push("--all");
    }

    let output = run_remote_git(repo_path, &args, auth_username, auth_token, store_auth)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = format!("{}{}", stdout, stderr);

    // Parse deleted branches if prune was requested
    let deleted_branches = if prune {
        parse_deleted_branches(&message)
    } else {
        None
    };

    let error_type = if output.status.success() {
        // Check if we have deleted branches that might affect current branch
        if deleted_branches.is_some() {
            GitErrorType::RemoteBranchDeleted
        } else {
            GitErrorType::None
        }
    } else {
        detect_fetch_error_type(&message)
    };

    Ok(GitFetchResult {
        success: output.status.success(),
        message,
        error_type,
        deleted_branches,
    })
}
