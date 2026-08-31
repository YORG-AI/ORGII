//! Background process monitoring, replay finalization, registry retention, and owner wake.

use std::time::{Duration, Instant};

use core_types::session_event::ShellReplayStatus;
use tauri::AppHandle;

use crate::tools::traits::ToolError;

use super::super::registry;
use super::super::shell_replay::active_state;
use super::events::{
    broadcast_process_backgrounded, broadcast_process_exited, broadcast_system_output,
};
use super::output_runtime::{drain_output, OutputRuntime};
use super::process_tree::terminate_child_tree;
use super::stall_watchdog::StallWatchdog;
use super::{BackgroundReason, ExecIdentity};

const BACKGROUND_SAFETY_TIMEOUT_SECS: u64 = 3600;
pub(super) const SHELL_TOOL_RESULT_MAX_BYTES: usize = 30 * 1024;

pub(super) fn bounded_background_result(
    mut preview: String,
    header: &str,
    log_info: &str,
) -> String {
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

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_backgrounded(
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
