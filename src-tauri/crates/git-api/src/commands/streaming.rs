/**
 * Streaming Git Operations with Server-Sent Events (SSE)
 *
 * Provides real-time output streaming for long-running git operations.
 * Uses Server-Sent Events (SSE) for efficient one-way server→client streaming.
 *
 * NOTE: Uses pre_exec on Unix to close inherited file descriptors (3-1024)
 * to prevent "Bad file descriptor" errors from WebView FD inheritance.
 */
#[cfg(test)]
#[path = "tests/streaming_tests.rs"]
mod tests;

use axum::{
    extract::{Path, Query},
    response::sse::{Event, KeepAlive},
    response::{IntoResponse, Response, Sse},
};
use futures::stream::Stream;
use serde::Deserialize;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use git::{tokio_git_command, util::is_transient_error};

use super::commit::append_orgii_coauthor_trailer;

type GitEventStream = Pin<Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>>;

// ============================================
// Error Type Detection
// ============================================

/// Detect error type from combined output (for streaming responses)
pub(crate) fn detect_error_type_from_output(output: &str, operation: &str) -> &'static str {
    let lower = output.to_lowercase();

    match operation {
        "push" => {
            // Non-fast-forward (remote has changes we don't have)
            if lower.contains("non-fast-forward")
                || lower.contains("fetch first")
                || lower.contains("updates were rejected")
                || lower.contains("failed to push some refs")
            {
                return "non_fast_forward";
            }

            // Protected branch
            if lower.contains("protected branch")
                || lower.contains("branch is protected")
                || lower.contains("cannot push to")
                || lower.contains("pre-receive hook declined")
                || lower.contains("remote rejected")
            {
                return "protected_branch";
            }
        }
        "pull" => {
            // Uncommitted changes would be overwritten
            if lower.contains("would be overwritten")
                || lower.contains("your local changes")
                || lower.contains("uncommitted changes")
                || lower.contains("please commit your changes or stash them")
            {
                return "uncommitted_changes";
            }

            // Merge conflicts
            if lower.contains("conflict") || lower.contains("automatic merge failed") {
                return "merge_conflicts";
            }
        }
        "fetch"
            // Check for deleted branches
            if lower.contains("[deleted]") => {
                return "remote_branch_deleted";
            }
        _ => {}
    }

    // Common errors across all operations
    if lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("invalid username or password")
        || lower.contains("invalid username or token")
        || lower.contains("bad credentials")
        || lower.contains("http basic: access denied")
        || lower.contains("could not read username")
        || lower.contains("unable to get password from user")
        || lower.contains("permission denied (publickey)")
        || lower.contains("repository not found")
        || lower.contains("saml")
        || lower.contains("sso")
        || lower.contains("password authentication was removed")
        || lower.contains("requested url returned error: 403")
    {
        return "authentication_failed";
    }

    if lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("unable to access")
        || lower.contains("connection timed out")
    {
        return "network_error";
    }

    "unknown"
}

// ============================================
// Query Parameters
// ============================================

#[derive(Deserialize)]
pub struct PushStreamQuery {
    pub path: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub set_upstream: Option<bool>,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Deserialize)]
pub struct PullStreamQuery {
    pub path: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// Pull strategy: "merge" (default), "rebase", or "ff-only"
    #[serde(default)]
    pub strategy: Option<String>,
}

#[derive(Deserialize)]
pub struct FetchStreamQuery {
    pub path: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub prune: Option<bool>,
    #[serde(default)]
    pub refspec: Option<String>,
}

#[derive(Deserialize)]
pub struct CommitStreamQuery {
    pub path: String,
    pub message: String,
    #[serde(default)]
    pub coauthor: Option<bool>,
}

#[derive(Deserialize)]
pub struct StageStreamQuery {
    pub path: String,
    pub files: String, // JSON array of files
}

/// Configure command with pre_exec to close inherited file descriptors on Unix
/// This prevents "Bad file descriptor" errors from WebView FD inheritance
#[cfg(unix)]
fn configure_command_for_fd_safety(cmd: &mut Command) {
    // SAFETY: We only close file descriptors, which is safe
    unsafe {
        cmd.pre_exec(|| {
            // Close file descriptors 3-1024 to avoid inheriting bad FDs from WebView
            for fd in 3..1024 {
                libc::close(fd);
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_command_for_fd_safety(_cmd: &mut Command) {
    // No-op on non-Unix systems
}

/// Helper function to stream git command output with retry logic for transient errors
/// Retries up to 3 times on "Bad file descriptor" and similar transient errors
/// The `operation` parameter is used for error type detection ("push", "pull", "fetch", etc.)
async fn stream_git_command(
    mut cmd: Command,
    command_str: String,
    operation: &'static str,
) -> GitEventStream {
    // Configure command for file descriptor safety
    configure_command_for_fd_safety(&mut cmd);

    let stream = async_stream::stream! {
        yield Ok(Event::default()
            .event("start")
            .data(format!("{{\"command\":\"{}\"}}", command_str)));

        const MAX_RETRIES: u32 = 3;
        let mut attempt = 0;

        loop {
            attempt += 1;

            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(e) => {
                    let error_str = e.to_string();

                    // Check if this is a transient error that can be retried
                    if is_transient_error(&error_str) && attempt < MAX_RETRIES {
                        // Wait briefly before retrying (exponential backoff)
                        tokio::time::sleep(tokio::time::Duration::from_millis(100 * attempt as u64)).await;
                        continue;
                    }

                    let error_msg = error_str.replace("\"", "\\\"");
                    yield Ok(Event::default()
                        .event("error")
                        .data(format!("{{\"error\":\"{}\",\"error_type\":\"unknown\"}}", error_msg)));
                    return;
                }
            };

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let mut all_lines: Vec<(String, String)> = Vec::new();

            if let Some(stdout) = stdout {
                let reader = BufReader::new(stdout);
                if let Ok(lines) = tokio::spawn(async move {
                    let mut lines_reader = reader.lines();
                    let mut output = Vec::new();
                    while let Ok(Some(line)) = lines_reader.next_line().await {
                        output.push(("stdout".to_string(), line));
                    }
                    output
                }).await {
                    all_lines.extend(lines);
                }
            }

            if let Some(stderr) = stderr {
                let reader = BufReader::new(stderr);
                if let Ok(lines) = tokio::spawn(async move {
                    let mut lines_reader = reader.lines();
                    let mut output = Vec::new();
                    while let Ok(Some(line)) = lines_reader.next_line().await {
                        output.push(("stderr".to_string(), line));
                    }
                    output
                }).await {
                    all_lines.extend(lines);
                }
            }

            // Check if any output line indicates a transient error
            let has_transient_error = all_lines.iter().any(|(_, line)| is_transient_error(line));

            if has_transient_error && attempt < MAX_RETRIES {
                // Wait briefly before retrying
                tokio::time::sleep(tokio::time::Duration::from_millis(100 * attempt as u64)).await;
                continue;
            }

            // Collect all output for error type detection
            let combined_output: String = all_lines.iter()
                .map(|(_, line)| line.as_str())
                .collect::<Vec<_>>()
                .join("\n");

            for (stream, line) in &all_lines {
                let escaped_line = line.replace("\"", "\\\"").replace("\n", "\\n");
                yield Ok(Event::default()
                    .event("output")
                    .data(format!("{{\"stream\":\"{}\",\"line\":\"{}\"}}", stream, escaped_line)));
            }

            match child.wait().await {
                Ok(status) => {
                    let error_type = if status.success() {
                        "none"
                    } else {
                        detect_error_type_from_output(&combined_output, operation)
                    };

                    yield Ok(Event::default()
                        .event("end")
                        .data(format!("{{\"success\":{},\"error_type\":\"{}\"}}", status.success(), error_type)));
                }
                Err(e) => {
                    let error_msg = e.to_string().replace("\"", "\\\"");
                    let error_type = detect_error_type_from_output(&error_msg, operation);
                    yield Ok(Event::default()
                        .event("error")
                        .data(format!("{{\"error\":\"{}\",\"error_type\":\"{}\"}}", error_msg, error_type)));
                }
            }

            // Successfully completed, exit the retry loop
            break;
        }
    };

    Box::pin(stream)
}

fn sse_response(stream: GitEventStream) -> Response {
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn stream_error_response(error: String, error_type: &'static str) -> Response {
    let escaped = error.replace('"', "\\\"");
    let stream = futures::stream::once(async move {
        Ok(Event::default().event("error").data(format!(
            "{{\"error\":\"{}\",\"error_type\":\"{}\"}}",
            escaped, error_type
        )))
    });

    sse_response(Box::pin(stream) as GitEventStream)
}

fn git_resolution_error_response(error: String) -> Response {
    stream_error_response(error, "git_unavailable")
}

// ============================================
// SSE Stream Handlers
// ============================================

/// Stream git push output via Server-Sent Events
pub async fn push_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<PushStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    let remote = query.remote.unwrap_or_else(|| "origin".to_string());
    let set_upstream = query.set_upstream.unwrap_or(false);
    let force = query.force.unwrap_or(false);

    let mut cmd = match tokio_git_command() {
        Ok(command) => command,
        Err(err) => return git_resolution_error_response(err),
    };
    cmd.args(["-c", "credential.interactive=false", "-c", "core.askPass="])
        .arg("push");

    if set_upstream {
        cmd.arg("-u");
    }
    if force {
        cmd.arg("--force");
    }

    cmd.arg(&remote);
    if let Some(branch) = query.branch {
        cmd.arg(&branch);
    }

    cmd.current_dir(&repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_str = format!("git push {}", remote);
    let stream = stream_git_command(cmd, command_str, "push").await;

    sse_response(stream)
}

/// Stream git pull output via Server-Sent Events
pub async fn pull_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<PullStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    let remote = query.remote.unwrap_or_else(|| "origin".to_string());

    let mut cmd = match tokio_git_command() {
        Ok(command) => command,
        Err(err) => return git_resolution_error_response(err),
    };
    cmd.args(["-c", "credential.interactive=false", "-c", "core.askPass="])
        .arg("pull");

    let strategy_flag = match query.strategy.as_deref() {
        Some("rebase") => {
            cmd.arg("--rebase");
            " --rebase"
        }
        Some("ff-only") => {
            cmd.arg("--ff-only");
            " --ff-only"
        }
        _ => {
            cmd.arg("--no-rebase");
            " --no-rebase"
        }
    };

    cmd.arg(&remote);

    if let Some(branch) = query.branch {
        cmd.arg(&branch);
    }

    cmd.current_dir(&repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_str = format!("git pull{} {}", strategy_flag, remote);
    let stream = stream_git_command(cmd, command_str, "pull").await;

    sse_response(stream)
}

/// Stream git fetch output via Server-Sent Events
pub async fn fetch_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<FetchStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    let remote = query.remote.unwrap_or_else(|| "origin".to_string());
    let prune = query.prune.unwrap_or(true);

    let mut cmd = match tokio_git_command() {
        Ok(command) => command,
        Err(err) => return git_resolution_error_response(err),
    };
    cmd.args(["-c", "credential.interactive=false", "-c", "core.askPass="])
        .arg("fetch")
        .arg(&remote);

    if prune {
        cmd.arg("--prune");
    }

    if let Some(refspec) = query.refspec.as_deref() {
        let Some((source, target)) = refspec.split_once(':') else {
            return stream_error_response("Invalid fetch refspec".to_string(), "invalid_refspec");
        };
        let source_pr = source
            .strip_prefix("pull/")
            .and_then(|rest| rest.strip_suffix("/head"));
        let target_pr = target.strip_prefix("refs/orgii/pr/");
        if source_pr.is_none()
            || target_pr.is_none()
            || source_pr != target_pr
            || !source_pr
                .unwrap_or_default()
                .chars()
                .all(|ch| ch.is_ascii_digit())
        {
            return stream_error_response("Invalid fetch refspec".to_string(), "invalid_refspec");
        }
        cmd.arg(refspec);
    }

    cmd.current_dir(&repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_str = match query.refspec.as_deref() {
        Some(refspec) => format!("git fetch {} {}", remote, refspec),
        None => format!("git fetch {}", remote),
    };
    let stream = stream_git_command(cmd, command_str, "fetch").await;

    sse_response(stream)
}

/// Stream git commit output via Server-Sent Events
pub async fn commit_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<CommitStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    let message = append_orgii_coauthor_trailer(&query.message, query.coauthor.unwrap_or(false));

    let mut cmd = match tokio_git_command() {
        Ok(command) => command,
        Err(err) => return git_resolution_error_response(err),
    };
    cmd.arg("commit")
        .arg("-m")
        .arg(&message)
        .current_dir(&repo_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_str = format!("git commit -m \"{}\"", message.replace("\"", "\\\""));
    let stream = stream_git_command(cmd, command_str, "commit").await;

    sse_response(stream)
}

/// Stream git add (stage) output via Server-Sent Events
pub async fn stage_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<StageStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    // The `files` query param is a JSON-encoded array. A silent
    // empty fallback would make `git add` run as a no-op, with
    // the user seeing no error and no effect. Warn so a malformed
    // request from the frontend is visible in logs while still
    // degrading to a no-op (we won't error the SSE stream for a
    // request shape we can't parse).
    let files: Vec<String> = match serde_json::from_str(&query.files) {
        Ok(f) => f,
        Err(err) => {
            tracing::warn!(
                error = %err,
                files_param = %query.files,
                "git::stage_stream: files query param is not a JSON array; running git add as no-op"
            );
            Vec::new()
        }
    };

    let mut cmd = match tokio_git_command() {
        Ok(command) => command,
        Err(err) => return git_resolution_error_response(err),
    };
    cmd.arg("add");
    for file in &files {
        cmd.arg(file);
    }
    cmd.current_dir(&repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_str = if files.is_empty() {
        "git add .".to_string()
    } else {
        format!("git add {}", files.join(" "))
    };

    let stream = stream_git_command(cmd, command_str, "stage").await;

    sse_response(stream)
}
