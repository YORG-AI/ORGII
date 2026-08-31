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
use super::remote::{contains_word, pull_strategy_args, should_set_upstream};

type GitEventStream = Pin<Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>>;

// ============================================
// Error Type Detection
// ============================================

/// Detect error type from combined output (for streaming responses)
pub(crate) fn detect_error_type_from_output(output: &str, operation: &str) -> &'static str {
    let lower = output.to_lowercase();

    match operation {
        "push" => {
            // Protected branch / policy rejection — checked BEFORE the
            // non-fast-forward patterns, because git appends "error: failed to
            // push some refs" to every rejection and the broader arm would
            // shadow this one (see detect_push_error_type in remote.rs).
            if lower.contains("protected branch")
                || lower.contains("branch is protected")
                || lower.contains("cannot push to")
                || lower.contains("pre-receive hook declined")
                || lower.contains("remote rejected")
            {
                return "protected_branch";
            }

            // Non-fast-forward (remote has changes we don't have)
            if lower.contains("non-fast-forward")
                || lower.contains("fetch first")
                || lower.contains("updates were rejected")
                || lower.contains("failed to push some refs")
            {
                return "non_fast_forward";
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
        || contains_word(&lower, "saml")
        || contains_word(&lower, "sso")
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

/// Core of the git SSE stream: yields `(event_kind, payload)` pairs.
///
/// Split from the SSE layer so the streaming behavior is unit-testable:
/// axum's `Event` offers no way to read its data back.
///
/// Behavioral contract (each point fixes a defect the previous
/// implementation had):
/// - stdout and stderr are drained CONCURRENTLY and lines are yielded as
///   they arrive. Git writes progress to stderr while stdout is still open;
///   draining stdout to EOF first deadlocked both sides once stderr's pipe
///   buffer (64 KiB) filled, and nothing streamed until the process exited.
/// - Only SPAWN failures retry on transient errors. Retrying because the
///   command's OUTPUT contained a transient-error string re-ran a command
///   that had already executed — a `git commit` could commit twice — and
///   orphaned the first child without awaiting it.
/// - Payloads are built with serde_json. Hand-rolled escaping dropped
///   backslashes and carriage returns, so Windows paths, quoted-path
///   output, and progress lines produced frames the client's JSON.parse
///   rejected.
fn stream_git_events(
    mut cmd: Command,
    command_str: String,
    operation: &'static str,
) -> impl Stream<Item = (&'static str, serde_json::Value)> {
    configure_command_for_fd_safety(&mut cmd);

    async_stream::stream! {
        yield ("start", serde_json::json!({ "command": command_str }));

        const MAX_RETRIES: u32 = 3;
        let mut attempt = 0;
        let mut child = loop {
            attempt += 1;
            match cmd.spawn() {
                Ok(child) => break child,
                Err(e) => {
                    let error_str = e.to_string();
                    if is_transient_error(&error_str) && attempt < MAX_RETRIES {
                        tokio::time::sleep(tokio::time::Duration::from_millis(
                            100 * attempt as u64,
                        ))
                        .await;
                        continue;
                    }
                    yield (
                        "error",
                        serde_json::json!({ "error": error_str, "error_type": "unknown" }),
                    );
                    return;
                }
            }
        };

        let (line_tx, mut line_rx) =
            tokio::sync::mpsc::unbounded_channel::<(&'static str, String)>();
        let mut readers = tokio::task::JoinSet::new();
        if let Some(stdout) = child.stdout.take() {
            let tx = line_tx.clone();
            readers.spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx.send(("stdout", line)).is_err() {
                        break;
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let tx = line_tx.clone();
            readers.spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx.send(("stderr", line)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(line_tx);

        let mut combined_lines: Vec<String> = Vec::new();
        while let Some((source, line)) = line_rx.recv().await {
            yield (
                "output",
                serde_json::json!({ "stream": source, "line": line }),
            );
            combined_lines.push(line);
        }
        while readers.join_next().await.is_some() {}

        match child.wait().await {
            Ok(status) => {
                let error_type = if status.success() {
                    "none"
                } else {
                    detect_error_type_from_output(&combined_lines.join("\n"), operation)
                };
                yield (
                    "end",
                    serde_json::json!({
                        "success": status.success(),
                        "error_type": error_type,
                    }),
                );
            }
            Err(e) => {
                let error_msg = e.to_string();
                let error_type = detect_error_type_from_output(&error_msg, operation);
                yield (
                    "error",
                    serde_json::json!({ "error": error_msg, "error_type": error_type }),
                );
            }
        }
    }
}

/// Wrap the event core into the SSE wire stream.
async fn stream_git_command(
    cmd: Command,
    command_str: String,
    operation: &'static str,
) -> GitEventStream {
    use futures::StreamExt as _;
    Box::pin(
        stream_git_events(cmd, command_str, operation)
            .map(|(kind, data)| Ok(Event::default().event(kind).data(data.to_string()))),
    )
}

fn sse_response(stream: GitEventStream) -> Response {
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn stream_error_response(error: String, error_type: &'static str) -> Response {
    let stream = futures::stream::once(async move {
        Ok(Event::default()
            .event("error")
            .data(serde_json::json!({ "error": error, "error_type": error_type }).to_string()))
    });

    sse_response(Box::pin(stream) as GitEventStream)
}

fn git_resolution_error_response(error: String) -> Response {
    stream_error_response(error, "git_unavailable")
}

// ============================================
// SSE Stream Handlers
// ============================================

/// `git rev-parse --abbrev-ref <spec>` — None on failure or a detached HEAD.
async fn rev_parse_abbrev(repo_path: &std::path::Path, spec: &str) -> Option<String> {
    let mut cmd = tokio_git_command().ok()?;
    let output = cmd
        .args(["rev-parse", "--abbrev-ref", spec])
        .current_dir(repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

/// Stream git push output via Server-Sent Events
pub async fn push_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<PushStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    let remote = query.remote.unwrap_or_else(|| "origin".to_string());
    let force = query.force.unwrap_or(false);

    // Mirror push_to_remote: auto-detect a missing or renamed upstream instead
    // of trusting a client flag that defaults to false — without this, the
    // first push of a new branch through the streaming path always failed
    // with "the current branch has no upstream branch".
    let current_branch = rev_parse_abbrev(&repo_path, "HEAD").await;
    let set_upstream = if query.set_upstream.unwrap_or(false) {
        true
    } else if let Some(current) = current_branch.as_deref() {
        let upstream = rev_parse_abbrev(&repo_path, &format!("{current}@{{upstream}}")).await;
        should_set_upstream(upstream.as_deref(), current, &remote)
    } else {
        false
    };

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
    // `-u` needs an explicit refspec: a bare `git push -u origin` on a branch
    // without an upstream still fails, so fall back to the current branch.
    let branch = query.branch.or(current_branch);
    if let Some(branch) = &branch {
        cmd.arg(branch);
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

    let command_str = format!(
        "git push{} {}{}",
        if set_upstream { " -u" } else { "" },
        remote,
        branch
            .as_deref()
            .map(|b| format!(" {b}"))
            .unwrap_or_default()
    );
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

    let strategy_args = pull_strategy_args(query.strategy.as_deref());
    cmd.args(strategy_args);

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

    let command_str = format!("git pull {} {}", strategy_args.join(" "), remote);
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
    // Null stdin + no-prompt env like every sibling handler: with
    // commit.gpgsign enabled, a GPG pinentry could otherwise block on the
    // inherited stdin and hang the SSE stream indefinitely.
    cmd.arg("commit")
        .arg("-m")
        .arg(&message)
        .current_dir(&repo_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_str = format!("git commit -m \"{message}\"");
    let stream = stream_git_command(cmd, command_str, "commit").await;

    sse_response(stream)
}

/// Stream git add (stage) output via Server-Sent Events
pub async fn stage_stream(
    Path(_repo_id): Path<String>,
    Query(query): Query<StageStreamQuery>,
) -> Response {
    let repo_path = PathBuf::from(&query.path);
    // The `files` query param is a JSON-encoded array. A malformed or empty
    // list must error the stream: a bare `git add` with no pathspec exits 0
    // having staged nothing ("Nothing specified, nothing added."), and the
    // old fallback then reported a successful `git add .` — the next commit
    // was silently empty or partial. Callers that mean "everything" pass
    // ["."] explicitly (commitOps.stage does).
    let files: Vec<String> = match serde_json::from_str(&query.files) {
        Ok(f) => f,
        Err(err) => {
            return stream_error_response(
                format!("stage request had a malformed files list: {err}"),
                "invalid_request",
            );
        }
    };
    if files.is_empty() {
        return stream_error_response(
            "stage request listed no files".to_string(),
            "invalid_request",
        );
    }

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

    let command_str = format!("git add {}", files.join(" "));

    let stream = stream_git_command(cmd, command_str, "stage").await;

    sse_response(stream)
}
