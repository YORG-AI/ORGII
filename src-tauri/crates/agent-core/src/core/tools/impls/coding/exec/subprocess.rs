//! Subprocess execution with bounded memory and durable shell replay.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use core_types::session_event::ShellReplayStatus;
use tauri::AppHandle;
use tracing::warn;

use crate::tools::traits::ToolError;

use super::shell_replay::{ShellReplayTarget, ShellReplayWriter};

mod background;
mod environment;
mod events;
mod output_runtime;
mod process_tree;
mod stall_watchdog;

use background::handle_backgrounded;
use environment::{configure_git_environment, configure_orgtrack_environment};
pub(super) use events::{broadcast_exec_output, broadcast_system_output};
use events::{broadcast_process_exited, broadcast_process_started};
#[cfg(test)]
pub(super) use output_runtime::ESTIMATED_RETAINED_OUTPUT_BYTES;
use output_runtime::{drain_output, format_summary, spawn_output_runtime};
use process_tree::terminate_child_tree;

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

#[cfg(test)]
mod tests;
