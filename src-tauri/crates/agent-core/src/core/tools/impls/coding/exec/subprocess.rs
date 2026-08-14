//! Subprocess execution with bounded memory and durable shell replay.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use core_types::session_event::ShellReplayStatus;
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, watch};
use tracing::warn;

use crate::bus::event_pipeline_bridge;
use crate::tools::traits::ToolError;

use super::registry;
use super::shell_replay::{
    active_state, complete_terminal_prefix_len, mark_writer_task_failure, ShellReplayStream,
    ShellReplayTarget, ShellReplayWriter, SHELL_REPLAY_FRAME_MAX_BYTES,
};

pub(super) const OUTPUT_READ_BUFFER_BYTES: usize = 16 * 1024;
pub(super) const OUTPUT_CHANNEL_CAPACITY: usize = 16;
/// Two reader buffers + UTF-8 carries, the bounded channel, writer/active
/// previews, 30 KiB summary, one in-flight frame, and BufWriter capacity.
#[cfg(test)]
pub(super) const ESTIMATED_RETAINED_OUTPUT_BYTES: usize = (2
    * (OUTPUT_READ_BUFFER_BYTES + OUTPUT_READ_BUFFER_BYTES + 4))
    + (OUTPUT_CHANNEL_CAPACITY * OUTPUT_READ_BUFFER_BYTES)
    + (2 * super::shell_replay::SHELL_REPLAY_PREVIEW_BYTES)
    + super::shell_replay::SHELL_REPLAY_SUMMARY_HEAD_BYTES
    + super::shell_replay::SHELL_REPLAY_SUMMARY_TAIL_BYTES
    + OUTPUT_READ_BUFFER_BYTES
    + (8 * 1024);
const BACKGROUND_SAFETY_TIMEOUT_SECS: u64 = 3600;
const SHELL_TOOL_RESULT_MAX_BYTES: usize = 30 * 1024;

/// How often the background monitor probes the replay bookmark for stall
/// detection. Coarse — the probe is an in-memory RwLock read.
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// How long output must stop growing before the tail is even considered for
/// the interactive-prompt check.
const STALL_THRESHOLD: Duration = Duration::from_secs(45);

#[derive(Debug, Clone)]
pub struct ExecIdentity {
    pub session_id: String,
    pub call_id: String,
}

impl ExecIdentity {
    pub fn new(session_id: impl Into<String>, call_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            call_id: call_id.into(),
        }
    }

    fn replay_target(&self) -> ShellReplayTarget {
        ShellReplayTarget::new(self.session_id.clone(), self.call_id.clone())
    }
}

/// Execution mode for `execute_via_command`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecMode {
    Blocking,
    Background,
}

#[derive(Clone, Copy, Debug)]
pub enum BackgroundReason {
    Explicit,
    Timeout,
}

impl BackgroundReason {
    fn as_wire_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Timeout => "timeout",
        }
    }
}

enum ReplayInput {
    Chunk {
        stream: ShellReplayStream,
        bytes: Vec<u8>,
    },
    ReaderError {
        stream: ShellReplayStream,
        error: String,
    },
}

struct OutputRuntime {
    stdout_task: tokio::task::JoinHandle<()>,
    stderr_task: tokio::task::JoinHandle<()>,
    writer_task: tokio::task::JoinHandle<ReplayDrain>,
    failure_rx: watch::Receiver<Option<String>>,
    log_path: Option<PathBuf>,
    replay_target: ShellReplayTarget,
    app_handle: Option<AppHandle>,
}

struct ReplayDrain {
    replay: ShellReplayWriter,
    write_error: Option<String>,
}

pub(super) fn broadcast_exec_output(
    identity: &ExecIdentity,
    chunk: &str,
    stream: &str,
    sequence: u64,
    persisted_bytes: u64,
) {
    crate::bus::broadcast_event(
        "agent:exec_output",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "chunk": chunk,
            "stream": stream,
            "sequence": sequence,
            "persistedBytes": persisted_bytes,
        }),
    );
}

pub(super) fn broadcast_system_output(identity: &ExecIdentity, chunk: &str) {
    let state = active_state(&identity.session_id, &identity.call_id);
    broadcast_exec_output(
        identity,
        chunk,
        "system",
        state
            .as_ref()
            .map_or(0, |value| value.bookmark.visible_through_sequence),
        state
            .as_ref()
            .map_or(0, |value| value.bookmark.visible_bytes),
    );
}

fn patch_process_state(
    app_handle: Option<&AppHandle>,
    identity: &ExecIdentity,
    merge_args: serde_json::Value,
) {
    if let Some(handle) = app_handle {
        event_pipeline_bridge::update_tool_args_by_call_id(
            handle,
            &identity.session_id,
            &identity.call_id,
            merge_args,
        );
    }
}

fn broadcast_process_started(
    identity: &ExecIdentity,
    pid: u32,
    command: &str,
    app_handle: Option<&AppHandle>,
) {
    patch_process_state(
        app_handle,
        identity,
        serde_json::json!({
            "shellPid": pid,
            "shellProcessStatus": "running",
        }),
    );
    crate::bus::broadcast_event(
        "agent:shell_process_started",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "pid": pid,
            "command": command,
        }),
    );
}

fn broadcast_process_backgrounded(
    identity: &ExecIdentity,
    pid: u32,
    reason: BackgroundReason,
    app_handle: Option<&AppHandle>,
) {
    patch_process_state(
        app_handle,
        identity,
        serde_json::json!({
            "shellPid": pid,
            "shellProcessStatus": "background",
        }),
    );
    crate::bus::broadcast_event(
        "agent:shell_process_backgrounded",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "pid": pid,
            "reason": reason.as_wire_str(),
        }),
    );
}

fn broadcast_process_exited(
    identity: &ExecIdentity,
    pid: u32,
    exit_code: Option<i32>,
    killed: bool,
    app_handle: Option<&AppHandle>,
) {
    patch_process_state(
        app_handle,
        identity,
        serde_json::json!({
            "shellPid": pid,
            "shellProcessStatus": if killed { "killed" } else { "exited" },
            "shellExitCode": exit_code,
        }),
    );
    crate::bus::broadcast_event(
        "agent:shell_process_exited",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "pid": pid,
            "exitCode": exit_code,
            "killed": killed,
        }),
    );
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) -> std::io::Result<()> {
    let group_result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if group_result == 0 {
        return Ok(());
    }
    let group_error = std::io::Error::last_os_error();
    if unsafe { libc::kill(pid as libc::pid_t, signal) } == 0 {
        return Ok(());
    }
    let process_error = std::io::Error::last_os_error();
    if group_error.raw_os_error() == Some(libc::ESRCH) {
        Err(process_error)
    } else {
        Err(group_error)
    }
}

#[cfg(unix)]
async fn terminate_child_tree(pid: u32, child: &mut tokio::process::Child) {
    if pid != 0 {
        if let Err(err) = signal_process_group(pid, libc::SIGTERM) {
            if err.raw_os_error() != Some(libc::ESRCH) {
                warn!("[subprocess] failed to SIGTERM process group {pid}: {err}");
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Err(err) = signal_process_group(pid, libc::SIGKILL) {
            if err.raw_os_error() != Some(libc::ESRCH) {
                warn!("[subprocess] failed to SIGKILL process group {pid}: {err}");
            }
        }
    }
    if let Err(err) = child.kill().await {
        if err.kind() != std::io::ErrorKind::InvalidInput {
            warn!("[subprocess] failed to kill child process: {err}");
        }
    }
}

#[cfg(windows)]
async fn terminate_child_tree(_pid: u32, child: &mut tokio::process::Child) {
    if let Err(err) = child.kill().await {
        warn!("[subprocess] failed to kill child process: {err}");
    }
}

/// Inject the orgtrack identity for agent-plane CLI calls (design M6):
/// `org2-pm` resolves actor/session/scope/mode from these instead of
/// trusting model-typed flags, and the host binary directory rides the
/// front of PATH so the bundled CLI always matches the app version.
///
/// Subagents resolve to their top-level ancestor: the workspace marker
/// (`agent_session_context.json`) is bound to the session that owns the
/// workspace, so the injected identity must match it or every CLI call
/// from a worker sharing that workspace would be refused as spoofing.
fn configure_orgtrack_environment(cmd: &mut tokio::process::Command, session_id: &str) {
    let mut session_id = session_id.to_string();
    let mut record = match crate::session::persistence::get_session(&session_id) {
        Ok(Some(record)) => record,
        _ => return,
    };
    for _ in 0..16 {
        let Some(parent_id) = record.parent_session_id.clone() else {
            break;
        };
        match crate::session::persistence::get_session(&parent_id) {
            Ok(Some(parent)) => {
                session_id = parent_id;
                record = parent;
            }
            _ => break,
        }
    }
    cmd.env("ORGII_SESSION_REF", format!("org2:{session_id}"));
    let agent = record
        .agent_definition_id
        .as_deref()
        .unwrap_or("os")
        .trim_start_matches("builtin:")
        .to_string();
    cmd.env("ORGII_ACTOR", format!("agent:{agent}"));
    cmd.env(
        "ORGII_MODE",
        record.product_mode.as_deref().unwrap_or("build"),
    );
    if let Some(slug) = record.project_slug.as_deref() {
        cmd.env("ORGII_SCOPE", slug);
    }
    if let Some(org) =
        project_management::projects::io::resolve_local_org_scope(record.org_id.as_deref())
    {
        cmd.env("ORGII_ORG", org);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let base_path = cmd
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
                .and_then(|(_, value)| value.map(|value| value.to_os_string()))
                .or_else(|| std::env::var_os("PATH"));
            let mut paths = vec![dir.to_path_buf()];
            if let Some(existing_path) = base_path {
                paths.extend(std::env::split_paths(&existing_path));
            }
            if let Ok(joined_path) = std::env::join_paths(paths) {
                cmd.env("PATH", joined_path);
            }
        }
    }
}

fn configure_git_environment(cmd: &mut tokio::process::Command) {
    let resolved = match git::resolved_git_executable_details() {
        Ok(resolved) => resolved,
        Err(err) => {
            warn!("[subprocess] Git executable resolution failed: {err}");
            return;
        }
    };
    if let Some(git_bin_dir) = resolved.path.parent() {
        let mut paths = vec![git_bin_dir.to_path_buf()];
        if let Some(existing_path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing_path));
        }
        match std::env::join_paths(paths) {
            Ok(joined_path) => {
                cmd.env("PATH", joined_path);
            }
            Err(err) => warn!("[subprocess] failed to join PATH with Git directory: {err}"),
        }
    }
}

async fn pump_output<R>(mut reader: R, stream: ShellReplayStream, tx: mpsc::Sender<ReplayInput>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; OUTPUT_READ_BUFFER_BYTES];
    let mut pending = Vec::with_capacity(OUTPUT_READ_BUFFER_BYTES + 4);
    loop {
        debug_assert!(pending.len() < SHELL_REPLAY_FRAME_MAX_BYTES);
        let read_capacity = SHELL_REPLAY_FRAME_MAX_BYTES.saturating_sub(pending.len());
        match reader.read(&mut buffer[..read_capacity]).await {
            Ok(0) => {
                if !pending.is_empty() {
                    let _ = tx
                        .send(ReplayInput::Chunk {
                            stream,
                            bytes: std::mem::take(&mut pending),
                        })
                        .await;
                }
                break;
            }
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);
                let prefix = complete_terminal_prefix_len(&pending);
                if prefix == 0 {
                    continue;
                }
                let bytes: Vec<u8> = pending.drain(..prefix).collect();
                if tx.send(ReplayInput::Chunk { stream, bytes }).await.is_err() {
                    break;
                }
            }
            Err(err) => {
                let _ = tx
                    .send(ReplayInput::ReaderError {
                        stream,
                        error: err.to_string(),
                    })
                    .await;
                break;
            }
        }
    }
}

fn spawn_output_runtime(
    identity: ExecIdentity,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    replay: ShellReplayWriter,
) -> OutputRuntime {
    let log_path = Some(replay.path().to_path_buf());
    let replay_target = replay.target();
    let app_handle = replay.app_handle();
    let (tx, mut rx) = mpsc::channel::<ReplayInput>(OUTPUT_CHANNEL_CAPACITY);
    let (failure_tx, failure_rx) = watch::channel::<Option<String>>(None);

    let stdout_tx = tx.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            pump_output(stdout, ShellReplayStream::Stdout, stdout_tx).await;
        }
    });
    let stderr_tx = tx.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            pump_output(stderr, ShellReplayStream::Stderr, stderr_tx).await;
        }
    });
    drop(tx);

    let writer_task = tokio::spawn(async move {
        let mut replay = replay;
        let mut write_error = None;
        let mut flush_interval = tokio::time::interval(Duration::from_millis(50));
        flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let input = tokio::select! {
                input = rx.recv() => input,
                _ = flush_interval.tick() => {
                    if let Err(err) = replay.flush_due_state() {
                        replay.mark_incomplete(err.clone());
                        let _ = failure_tx.send(Some(err.clone()));
                        write_error = Some(err);
                        break;
                    }
                    continue;
                }
            };
            let Some(input) = input else {
                break;
            };
            let (stream, bytes) = match input {
                ReplayInput::Chunk { stream, bytes } => (stream, bytes),
                ReplayInput::ReaderError { stream, error } => {
                    let message = format!("{} reader failed: {error}", stream.as_wire_str());
                    replay.mark_incomplete(message.clone());
                    let _ = failure_tx.send(Some(message.clone()));
                    write_error = Some(message);
                    break;
                }
            };

            let append = match replay.append(stream, &bytes) {
                Ok(append) => append,
                Err(err) => {
                    replay.mark_incomplete(err.clone());
                    let _ = failure_tx.send(Some(err.clone()));
                    write_error = Some(err);
                    break;
                }
            };

            broadcast_exec_output(
                &identity,
                &String::from_utf8_lossy(&bytes),
                stream.as_wire_str(),
                append.sequence,
                append.persisted_bytes,
            );
        }

        if write_error.is_none() {
            if let Err(err) = replay.flush_running_state() {
                replay.mark_incomplete(err.clone());
                let _ = failure_tx.send(Some(err.clone()));
                write_error = Some(err);
            }
        }
        ReplayDrain {
            replay,
            write_error,
        }
    });

    OutputRuntime {
        stdout_task,
        stderr_task,
        writer_task,
        failure_rx,
        log_path,
        replay_target,
        app_handle,
    }
}

async fn join_reader(mut task: tokio::task::JoinHandle<()>, stream: &str) -> Result<(), String> {
    match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(format!("{stream} reader task failed: {err}")),
        Err(_) => {
            warn!("[subprocess] {stream} reader did not finish within 5s; aborting");
            task.abort();
            let _ = task.await;
            Err(format!(
                "{stream} reader did not drain within the 5s completion barrier"
            ))
        }
    }
}

async fn drain_output(runtime: OutputRuntime) -> Result<ReplayDrain, String> {
    let stdout_error = join_reader(runtime.stdout_task, "stdout").await.err();
    let stderr_error = join_reader(runtime.stderr_task, "stderr").await.err();
    let mut drain = match runtime.writer_task.await {
        Ok(drain) => drain,
        Err(err) => {
            let message = format!("shell replay writer task failed: {err}");
            let mark_result = mark_writer_task_failure(
                &runtime.replay_target,
                runtime.log_path.as_deref(),
                runtime.app_handle.as_ref(),
                message.clone(),
            );
            return Err(match mark_result {
                Ok(()) => message,
                Err(mark_err) => format!("{message}; failed to mark replay incomplete: {mark_err}"),
            });
        }
    };
    if drain.write_error.is_none() {
        drain.write_error = stdout_error.or(stderr_error);
    }
    Ok(drain)
}

fn format_summary(summary: String, exit_code: i32) -> String {
    let summary = if summary.is_empty() {
        "(no output)".to_string()
    } else {
        summary
    };
    if exit_code == 0 {
        summary
    } else {
        format!("{summary}\n[exit code: {exit_code}]")
    }
}

fn bounded_background_result(mut preview: String, header: &str, log_info: &str) -> String {
    let suffix = format!("\n\n{header}{log_info}");
    let preview_budget = SHELL_TOOL_RESULT_MAX_BYTES.saturating_sub(suffix.len());
    if preview.len() > preview_budget {
        let mut start = preview.len() - preview_budget;
        while start < preview.len() && !preview.is_char_boundary(start) {
            start += 1;
        }
        preview.drain(..start);
    }
    let result = format!("{preview}{suffix}");
    debug_assert!(result.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
    result
}

/// Execute a command with O(1) process memory regardless of output size.
#[allow(clippy::too_many_arguments)]
pub async fn execute_via_command(
    command: &str,
    work_dir: PathBuf,
    timeout_secs: u64,
    wait_secs: Option<u64>,
    mode: ExecMode,
    identity: &ExecIdentity,
    shell_replays_root: &Path,
    app_handle: Option<AppHandle>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<String, ToolError> {
    let mut replay = ShellReplayWriter::create(
        shell_replays_root,
        identity.replay_target(),
        command,
        &work_dir,
        app_handle.clone(),
    )
    .map_err(|err| {
        ToolError::ExecutionFailed(format!(
            "Command was not started because complete shell replay could not be created: {err}"
        ))
    })?;
    broadcast_system_output(identity, &format!("$ {command}"));

    #[cfg(unix)]
    let mut cmd = {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c");
        command
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut command = tokio::process::Command::new("cmd");
        command.arg("/C");
        command
    };
    configure_git_environment(&mut cmd);
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    configure_orgtrack_environment(&mut cmd, &identity.session_id);
    cmd.arg(command)
        .current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(app_platform::CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            let message = format!("Failed to spawn command: {err}");
            replay.mark_incomplete(message.clone());
            return Err(ToolError::ExecutionFailed(message));
        }
    };
    let pid = child.id().unwrap_or(0);
    if pid == 0 {
        warn!("[subprocess] child.id() returned None; PID tracking disabled");
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let runtime = spawn_output_runtime(identity.clone(), stdout, stderr, replay);
    broadcast_process_started(identity, pid, command, app_handle.as_ref());

    let effective_wait = wait_secs.unwrap_or(timeout_secs);
    if mode == ExecMode::Background {
        return handle_backgrounded(
            command,
            pid,
            effective_wait,
            BackgroundReason::Explicit,
            child,
            runtime,
            identity.clone(),
            app_handle,
        );
    }

    let wait_started_at = Instant::now();
    let mut runtime = Some(runtime);
    loop {
        if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            terminate_child_tree(pid, &mut child).await;
            let drain = match drain_output(runtime.take().expect("output runtime present")).await {
                Ok(drain) => drain,
                Err(err) => {
                    broadcast_process_exited(identity, pid, None, true, app_handle.as_ref());
                    return Err(ToolError::ExecutionFailed(format!(
                        "Command cancelled; shell replay writer failed: {err}"
                    )));
                }
            };
            let replay_result = if let Some(err) = drain.write_error {
                drain
                    .replay
                    .finalize(ShellReplayStatus::Incomplete, Some(err))
            } else {
                drain.replay.finalize(ShellReplayStatus::Complete, None)
            };
            broadcast_system_output(identity, &format!("[process {pid} cancelled by user]"));
            broadcast_process_exited(identity, pid, None, true, app_handle.as_ref());
            if let Err(err) = replay_result {
                return Err(ToolError::ExecutionFailed(format!(
                    "Command cancelled; shell replay is incomplete: {err}"
                )));
            }
            return Err(ToolError::ExecutionFailed(
                "Command cancelled by user".to_string(),
            ));
        }

        if let Some(err) = runtime
            .as_ref()
            .and_then(|runtime| runtime.failure_rx.borrow().clone())
        {
            terminate_child_tree(pid, &mut child).await;
            let drain = match drain_output(runtime.take().expect("output runtime present")).await {
                Ok(drain) => drain,
                Err(writer_err) => {
                    broadcast_process_exited(identity, pid, None, true, app_handle.as_ref());
                    return Err(ToolError::ExecutionFailed(format!(
                        "Command stopped because shell replay writer failed: {writer_err}"
                    )));
                }
            };
            let _ = drain
                .replay
                .finalize(ShellReplayStatus::Incomplete, Some(err.clone()));
            broadcast_process_exited(identity, pid, None, true, app_handle.as_ref());
            return Err(ToolError::ExecutionFailed(format!(
                "Command stopped because complete shell replay failed: {err}"
            )));
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                let was_signaled = status.code().is_none();
                let exit_code = status.code().unwrap_or(-1);
                let drain =
                    match drain_output(runtime.take().expect("output runtime present")).await {
                        Ok(drain) => drain,
                        Err(err) => {
                            broadcast_process_exited(
                                identity,
                                pid,
                                status.code(),
                                was_signaled,
                                app_handle.as_ref(),
                            );
                            return Err(ToolError::ExecutionFailed(format!(
                                "Command finished but shell replay writer failed: {err}"
                            )));
                        }
                    };
                if let Some(err) = drain.write_error {
                    let _ = drain
                        .replay
                        .finalize(ShellReplayStatus::Incomplete, Some(err.clone()));
                    broadcast_process_exited(
                        identity,
                        pid,
                        status.code(),
                        was_signaled,
                        app_handle.as_ref(),
                    );
                    return Err(ToolError::ExecutionFailed(format!(
                        "Command output replay is incomplete: {err}"
                    )));
                }
                if was_signaled {
                    broadcast_system_output(identity, &format!("[process {pid} killed by signal]"));
                } else {
                    broadcast_system_output(identity, &format!("[exit code: {exit_code}]"));
                }
                let summary = match drain.replay.finalize(ShellReplayStatus::Complete, None) {
                    Ok(summary) => summary,
                    Err(err) => {
                        broadcast_process_exited(
                            identity,
                            pid,
                            status.code(),
                            was_signaled,
                            app_handle.as_ref(),
                        );
                        return Err(ToolError::ExecutionFailed(format!(
                            "Command finished but complete shell replay failed: {err}"
                        )));
                    }
                };
                broadcast_process_exited(
                    identity,
                    pid,
                    status.code(),
                    was_signaled,
                    app_handle.as_ref(),
                );
                return Ok(format_summary(summary, exit_code));
            }
            Ok(None) => {}
            Err(err) => {
                terminate_child_tree(pid, &mut child).await;
                let drain = match drain_output(runtime.take().expect("output runtime present"))
                    .await
                {
                    Ok(drain) => drain,
                    Err(writer_err) => {
                        broadcast_process_exited(identity, pid, None, true, app_handle.as_ref());
                        return Err(ToolError::ExecutionFailed(format!(
                            "Failed to wait for process; shell replay writer failed: {writer_err}"
                        )));
                    }
                };
                let message = format!("Failed to wait for process: {err}");
                let _ = drain
                    .replay
                    .finalize(ShellReplayStatus::Incomplete, Some(message.clone()));
                broadcast_process_exited(identity, pid, None, true, app_handle.as_ref());
                return Err(ToolError::ExecutionFailed(message));
            }
        }

        if wait_started_at.elapsed() >= Duration::from_secs(effective_wait) {
            return handle_backgrounded(
                command,
                pid,
                effective_wait,
                BackgroundReason::Timeout,
                child,
                runtime.take().expect("output runtime present"),
                identity.clone(),
                app_handle,
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_backgrounded(
    command: &str,
    pid: u32,
    effective_wait: u64,
    reason: BackgroundReason,
    mut child: tokio::process::Child,
    runtime: OutputRuntime,
    identity: ExecIdentity,
    app_handle: Option<AppHandle>,
) -> Result<String, ToolError> {
    let log_path = runtime.log_path.clone();
    let human_line = match reason {
        BackgroundReason::Explicit => format!("[process {pid} running in background]"),
        BackgroundReason::Timeout => {
            format!("[process {pid} backgrounded after {effective_wait}s]")
        }
    };
    broadcast_system_output(&identity, &human_line);
    broadcast_process_backgrounded(&identity, pid, reason, app_handle.as_ref());

    if pid != 0 {
        let registry_path = log_path.clone().unwrap_or_default();
        let _ = registry::register_shell_replay(
            pid,
            command.to_string(),
            registry_path,
            identity.session_id.clone(),
            identity.call_id.clone(),
        );
    }

    let preview = active_state(&identity.session_id, &identity.call_id)
        .map(|state| state.terminal_preview)
        .filter(|preview| !preview.is_empty())
        .unwrap_or_else(|| match reason {
            BackgroundReason::Explicit => "(running in background)".to_string(),
            BackgroundReason::Timeout => "(no output yet)".to_string(),
        });
    let log_info = if log_path.is_some() {
        format!(
            "\nComplete output: Session Replay\n\n\
             To wait for completion: await_output(command=\"wait_for\", handles=[\"{pid}\"], block_until_ms=60000)\n\
             To wait for a pattern:  await_output(command=\"wait_for\", handles=[\"{pid}\"], pattern=\"your_regex\", block_until_ms=60000)\n\
             To check status:        await_output(command=\"monitor\", handles=[\"{pid}\"])\n\
             To read tail:           await_output(command=\"monitor\", handles=[\"{pid}\"], tail_lines=100)\n\
             To kill:                run_shell(kill_handle=\"{pid}\")\n\
             If it is still running after a wait or two, STOP waiting: continue with other work or end your turn — \
             the session resumes automatically when the process exits."
        )
    } else {
        format!("\nTo kill: run_shell(kill_handle=\"{pid}\")")
    };
    let header = match reason {
        BackgroundReason::Explicit => format!("[process started in background as PID {pid}]"),
        BackgroundReason::Timeout => {
            format!("[process still running after {effective_wait}s — backgrounded as PID {pid}]")
        }
    };

    tokio::spawn(async move {
        let mut runtime = Some(runtime);
        let started = Instant::now();
        let mut stall_watchdog = StallWatchdog::new();
        let (exit_code, killed, replay_failure) = loop {
            if let Some(err) = runtime
                .as_ref()
                .and_then(|runtime| runtime.failure_rx.borrow().clone())
            {
                terminate_child_tree(pid, &mut child).await;
                break (None, true, Some(err));
            }
            match child.try_wait() {
                Ok(Some(status)) => break (status.code(), status.code().is_none(), None),
                Ok(None) => {}
                Err(err) => {
                    terminate_child_tree(pid, &mut child).await;
                    break (
                        None,
                        true,
                        Some(format!("wait for background process: {err}")),
                    );
                }
            }
            if started.elapsed() >= Duration::from_secs(BACKGROUND_SAFETY_TIMEOUT_SECS) {
                terminate_child_tree(pid, &mut child).await;
                break (
                    None,
                    true,
                    Some("background process exceeded 1h safety timeout".to_string()),
                );
            }
            stall_watchdog.probe(&identity, pid);
            tokio::time::sleep(Duration::from_millis(50)).await;
        };

        let drain = match drain_output(runtime.take().expect("output runtime present")).await {
            Ok(drain) => drain,
            Err(writer_err) => {
                if pid != 0 {
                    let job_status = if killed {
                        registry::JobStatus::Killed
                    } else {
                        registry::JobStatus::Exited(exit_code.unwrap_or(-1))
                    };
                    registry::mark_exited(&pid.to_string(), job_status);
                }
                broadcast_system_output(
                    &identity,
                    &format!("[background shell replay writer failed: {writer_err}]"),
                );
                broadcast_process_exited(&identity, pid, exit_code, killed, app_handle.as_ref());
                finish_background_job(pid, &identity.session_id).await;
                return;
            }
        };
        let replay_error = replay_failure.or(drain.write_error);
        let replay_result = if let Some(err) = replay_error.clone() {
            drain
                .replay
                .finalize(ShellReplayStatus::Incomplete, Some(err))
        } else {
            drain.replay.finalize(ShellReplayStatus::Complete, None)
        };
        let replay_incomplete = replay_result.is_err();

        if pid != 0 {
            let job_status = if killed {
                registry::JobStatus::Killed
            } else {
                registry::JobStatus::Exited(exit_code.unwrap_or(-1))
            };
            registry::mark_exited(&pid.to_string(), job_status);
        }
        if killed {
            broadcast_system_output(&identity, &format!("[background process {pid} stopped]"));
        } else {
            broadcast_system_output(
                &identity,
                &format!(
                    "[background process {pid} exited with code {}]",
                    exit_code.unwrap_or(-1)
                ),
            );
        }
        if replay_incomplete {
            broadcast_system_output(
                &identity,
                "[Session Replay is incomplete even though process termination status is known]",
            );
        }
        broadcast_process_exited(&identity, pid, exit_code, killed, app_handle.as_ref());
        finish_background_job(pid, &identity.session_id).await;
    });

    Ok(bounded_background_result(preview, &header, &log_info))
}

/// Shared completion tail for a backgrounded shell: push a job-completion
/// wake to the owning session (the shell counterpart of the subagent
/// completion push — the coordinator claims exactly-once and no-ops for
/// killed shells or a still-running owner), then retain the registry entry
/// until the output is acknowledged so the Background Jobs reminder of the
/// resumed turn can still see it. The old flat 60s eviction raced exactly
/// that window: a session idle for longer than a minute lost the entry
/// before any turn could read it.
async fn finish_background_job(pid: u32, session_id: &str) {
    if pid == 0 {
        return;
    }
    crate::tools::impls::orchestration::job_wake::current_job_completion_wake_hook()
        .wake_owner(session_id);
    registry::retain_until_acknowledged_then_remove(
        &pid.to_string(),
        Duration::from_secs(30 * 60),
        "subprocess",
    )
    .await;
}

/// Stall detector for a backgrounded shell: when the replay bookmark stops
/// advancing for [`STALL_THRESHOLD`] and the terminal preview's last line
/// looks like an interactive prompt, latch the job as waiting-for-input.
/// The latch feeds the Background Jobs reminder, the mid-turn note, the
/// await_output hint, and a one-shot owner wake — everything needed for the
/// model to kill the process and re-run it non-interactively instead of
/// waiting out the 1h safety timeout. Output resuming clears the latch and
/// re-arms the advisory.
struct StallWatchdog {
    last_probe: Instant,
    last_bytes: u64,
    last_growth: Instant,
    latched: bool,
}

impl StallWatchdog {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            last_probe: now,
            last_bytes: 0,
            last_growth: now,
            latched: false,
        }
    }

    fn probe(&mut self, identity: &ExecIdentity, pid: u32) {
        if pid == 0 || self.last_probe.elapsed() < STALL_CHECK_INTERVAL {
            return;
        }
        self.last_probe = Instant::now();
        let Some(state) = active_state(&identity.session_id, &identity.call_id) else {
            return;
        };
        let bytes = state.bookmark.visible_bytes;
        if bytes > self.last_bytes {
            self.last_bytes = bytes;
            self.last_growth = Instant::now();
            if self.latched {
                self.latched = false;
                registry::clear_stalled_waiting_input(&pid.to_string());
            }
            return;
        }
        if self.latched || self.last_growth.elapsed() < STALL_THRESHOLD {
            return;
        }
        if !looks_like_interactive_prompt(&state.terminal_preview) {
            return;
        }
        self.latched = true;
        if registry::mark_stalled_waiting_input(&pid.to_string()) {
            broadcast_system_output(
                identity,
                &format!("[process {pid} appears to be waiting for interactive input]"),
            );
            crate::tools::impls::orchestration::job_wake::current_job_completion_wake_hook()
                .wake_owner(&identity.session_id);
        }
    }
}

/// Whether the last non-empty line of a terminal tail looks like an
/// interactive prompt. Deliberately conservative — the stall threshold has
/// already passed when this runs, so the goal is catching the classic
/// confirmation / credential / REPL prompts without misfiring on quiet
/// long-running servers.
fn looks_like_interactive_prompt(tail: &str) -> bool {
    let Some(raw_line) = tail.lines().rev().find(|line| !line.trim().is_empty()) else {
        return false;
    };
    let line = raw_line
        .trim()
        .strip_prefix("[stderr]")
        .map(str::trim)
        .unwrap_or_else(|| raw_line.trim());
    let lower = line.to_ascii_lowercase();

    // Lone REPL / shell prompts ("$", ">", ">>>", "irb>", "%", "#").
    if matches!(line, "$" | ">" | ">>>" | "#" | "%") {
        return true;
    }

    // [y/n]-style confirmations, with optional trailing ':' / '?' / '.'.
    let confirm_core = lower.trim_end_matches([':', '?', '.', ' ']);
    for suffix in ["[y/n]", "(y/n)", "[yes/no]", "(yes/no)", "[y/n/a]"] {
        if confirm_core.ends_with(suffix) {
            return true;
        }
    }

    // Credential prompts: "Password:", "Enter passphrase for ...:".
    if lower.ends_with(':')
        && [
            "password",
            "passphrase",
            "username",
            "login",
            "pin",
            "token",
        ]
        .iter()
        .any(|kw| lower.contains(kw))
    {
        return true;
    }

    // "Press ENTER to continue" / "press any key".
    if lower.contains("press enter") || lower.contains("press any key") {
        return true;
    }

    // Question-shaped confirmations ("Do you want to ...?", "Overwrite ...?").
    if lower.ends_with('?')
        && [
            "do you",
            "would you",
            "are you sure",
            "continue",
            "proceed",
            "overwrite",
            "replace",
            "install",
            "ok to",
            "accept",
        ]
        .iter()
        .any(|kw| lower.contains(kw))
    {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn interactive_prompt_detection_matches_common_prompts() {
        for tail in [
            "Cloning into 'repo'...\nUsername for 'https://github.com':",
            "sudo: reading password\n[stderr] Password:",
            "Overwrite existing file? [y/N]",
            "Do you want to continue? (yes/no):",
            "some output\nAccept the license terms? [y/n]?",
            "Press ENTER to continue",
            "compiling...\n>>>",
            "$",
            "Enter passphrase for key '/Users/x/.ssh/id_ed25519':",
        ] {
            assert!(
                looks_like_interactive_prompt(tail),
                "should match prompt tail: {tail:?}"
            );
        }
    }

    #[test]
    fn interactive_prompt_detection_ignores_ordinary_output() {
        for tail in [
            "",
            "   \n  ",
            "Compiling agent_core v0.1.0",
            "test result: ok. 3164 passed; 0 failed",
            "webpack compiled successfully in 4123 ms",
            "GET /api/health 200 3ms",
            "warning: unused variable `x`",
            "vite v5.0.0 dev server running at:\n> Local: http://localhost:5173/",
            "What's next?\n  cd app && npm run dev",
        ] {
            assert!(
                !looks_like_interactive_prompt(tail),
                "should NOT match ordinary tail: {tail:?}"
            );
        }
    }

    #[test]
    fn background_tool_result_stays_inside_model_budget() {
        let preview = "中🙂ansi\x1b[31m".repeat(8_000);
        let result = bounded_background_result(
            preview,
            "[process started in background as PID 42]",
            "\nComplete output: Session Replay",
        );
        assert!(result.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
        assert!(result.contains("Session Replay"));
        assert!(!result.contains('\u{fffd}'));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writer_join_failure_marks_exact_replay_incomplete_without_panicking() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let target = ShellReplayTarget::new("join-failure-session", "join-failure-call");
        let mut writer =
            ShellReplayWriter::create(&root, target.clone(), "emit", Path::new("/tmp"), None)
                .unwrap();
        writer
            .append(ShellReplayStream::Stdout, b"before panic")
            .unwrap();
        let log_path = Some(writer.path().to_path_buf());
        let (_failure_tx, failure_rx) = watch::channel(None);
        let runtime = OutputRuntime {
            stdout_task: tokio::spawn(async {}),
            stderr_task: tokio::spawn(async {}),
            writer_task: tokio::spawn(async move {
                let _owned_writer = writer;
                panic!("injected writer failure");
            }),
            failure_rx,
            log_path,
            replay_target: target.clone(),
            app_handle: None,
        };

        let error = match drain_output(runtime).await {
            Ok(_) => panic!("injected writer failure unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(error.contains("writer task failed"));
        let state =
            super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.status, ShellReplayStatus::Incomplete);
        assert!(state.error.unwrap().contains("writer task failed"));
        assert!(active_state(&target.session_id, &target.call_id).is_none());
    }

    async fn wait_for_terminal_replay(session_id: &str, call_id: &str) -> ShellReplayStatus {
        for _ in 0..100 {
            if let Some(state) =
                super::super::shell_replay::load_replay_state(session_id, call_id).unwrap()
            {
                if state.status != ShellReplayStatus::Running {
                    return state.status;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("replay {session_id}/{call_id} did not cross its completion barrier");
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial_test::serial]
    async fn real_subprocess_background_timeout_and_cancel_cross_completion_barrier() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let cwd = std::env::temp_dir();
        let session_id = "subprocess-lifecycle-session";

        let explicit = ExecIdentity::new(session_id, "call-explicit-background");
        let launch = execute_via_command(
            "printf explicit-background",
            cwd.clone(),
            10,
            None,
            ExecMode::Background,
            &explicit,
            &root,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(launch.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
        assert_eq!(
            wait_for_terminal_replay(session_id, "call-explicit-background").await,
            ShellReplayStatus::Complete
        );

        let timed = ExecIdentity::new(session_id, "call-wait-timeout-background");
        let launch = execute_via_command(
            "printf timeout-background",
            cwd.clone(),
            10,
            Some(0),
            ExecMode::Blocking,
            &timed,
            &root,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(launch.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
        assert_eq!(
            wait_for_terminal_replay(session_id, "call-wait-timeout-background").await,
            ShellReplayStatus::Complete
        );

        let cancelled = ExecIdentity::new(session_id, "call-cancelled");
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let set_cancel = {
            let cancel_flag = cancel_flag.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                cancel_flag.store(true, Ordering::Relaxed);
            }
        };
        let execute = execute_via_command(
            "printf before-cancel; sleep 10",
            cwd,
            20,
            None,
            ExecMode::Blocking,
            &cancelled,
            &root,
            None,
            Some(cancel_flag.as_ref()),
        );
        let (result, ()) = tokio::join!(execute, set_cancel);
        assert!(result.is_err());
        assert_ne!(
            wait_for_terminal_replay(session_id, "call-cancelled").await,
            ShellReplayStatus::Running
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial_test::serial]
    #[ignore = "real 10 MiB subprocess/RSS-adjacent acceptance"]
    async fn real_subprocess_ten_megabytes_is_complete_and_bounded() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let identity = ExecIdentity::new("subprocess-10m-session", "subprocess-10m-call");
        let result = execute_via_command(
            "yes x | head -c 10485760",
            std::env::temp_dir(),
            30,
            None,
            ExecMode::Blocking,
            &identity,
            &root,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(result.len() <= super::super::shell_replay::SHELL_REPLAY_SUMMARY_MAX_BYTES);
        let state =
            super::super::shell_replay::load_replay_state(&identity.session_id, &identity.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.status, ShellReplayStatus::Complete);
        assert_eq!(state.bookmark.visible_bytes, 10 * 1024 * 1024);
        assert!(
            state.terminal_preview.len() <= super::super::shell_replay::SHELL_REPLAY_PREVIEW_BYTES
        );
    }
}
