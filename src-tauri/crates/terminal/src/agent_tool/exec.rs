//! Agent command execution within a PTY session.
//!
//! Marker-based output capture for interactive shell commands.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tauri::async_runtime::Mutex as AsyncMutex;
use tokio::sync::broadcast;
use tracing::{info, warn};

use std::sync::Arc;

use crate::pty_commands::pty::PtySession;

use super::{clean_pty_output, truncate_output, write_to_session};

/// Execution state machine for tracking PTY command lifecycle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ExecPhase {
    WaitingForMarker,
    Completed,
}

impl std::fmt::Display for ExecPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecPhase::WaitingForMarker => write!(f, "waiting_for_marker"),
            ExecPhase::Completed => write!(f, "completed"),
        }
    }
}

/// Execute a command in a PTY session and capture its output.
///
/// Uses a shell-variable-based marker to avoid false matches on the command
/// echo. Returns `(captured_output, exit_code)`.
pub async fn exec_in_pty(
    command: &str,
    working_dir: Option<&PathBuf>,
    session_id: &str,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
    output_rx: &mut broadcast::Receiver<String>,
    timeout: Duration,
) -> Result<(String, i32), String> {
    let marker_id = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let done_marker = format!("__ORGII_DONE_{}", marker_id);

    // Drain stale output
    let drain_deadline = tokio::time::Instant::now() + Duration::from_millis(50);
    let mut drained_count: u32 = 0;

    loop {
        let remaining = drain_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, output_rx.recv()).await {
            Ok(Ok(_chunk)) => {
                drained_count += 1;
            }
            Ok(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                drained_count += skipped as u32;
            }
            _ => break,
        }
    }

    if drained_count > 0 {
        info!(
            "[exec_in_pty] drained {} stale chunks before command",
            drained_count
        );
    }

    let mut phase = ExecPhase::WaitingForMarker;

    let wrapped_command = if let Some(work_dir) = working_dir {
        format!(
            " __M={marker}; cd {dir} && {cmd}; printf '\\n%s__%d__\\n' \"$__M\" $?\n",
            marker = done_marker,
            dir = super::shell_escape(work_dir.to_string_lossy().as_ref()),
            cmd = command,
        )
    } else {
        format!(
            " __M={marker}; {cmd}; printf '\\n%s__%d__\\n' \"$__M\" $?\n",
            marker = done_marker,
            cmd = command,
        )
    };

    info!(
        "[exec_in_pty] phase={} marker={} cmd={}",
        phase,
        marker_id,
        if command.chars().count() > 80 {
            command
                .char_indices()
                .nth(80)
                .map(|(index, _)| &command[..index])
                .unwrap_or(command)
        } else {
            command
        }
    );

    write_to_session(session_id, &wrapped_command, sessions.clone()).await?;

    let mut collected_output = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut lagged_count: u32 = 0;
    let mut chunks_received: u32 = 0;
    let mut last_output_time = tokio::time::Instant::now();
    let watchdog_interval = Duration::from_secs(5);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            info!(
                "[exec_in_pty] TIMEOUT phase={} marker={} chunks={} output_len={}",
                phase,
                marker_id,
                chunks_received,
                collected_output.len()
            );
            return Err(format!(
                "Command timed out after {}s: {}",
                timeout.as_secs(),
                command
            ));
        }

        let recv_timeout = remaining.min(Duration::from_secs(2));

        match tokio::time::timeout(recv_timeout, output_rx.recv()).await {
            Ok(Ok(chunk)) => {
                chunks_received += 1;
                last_output_time = tokio::time::Instant::now();
                collected_output.push_str(&chunk);

                if let Some(exit_info) = extract_done_marker(&collected_output, &done_marker) {
                    phase = ExecPhase::Completed;
                    info!(
                        "[exec_in_pty] phase={} marker={} chunks={} exit={}",
                        phase, marker_id, chunks_received, exit_info.1
                    );
                    return Ok(exit_info);
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                lagged_count += 1;
                info!(
                    "[exec_in_pty] LAGGED skipped={} lag_count={} marker={}",
                    skipped, lagged_count, marker_id
                );

                collected_output.clear();
                collected_output.push_str("[...output truncated due to buffer overflow...]\n");

                let reprobe = " printf '\\n%s__%d__\\n' \"$__M\" $?\n".to_string();
                if let Err(err) = write_to_session(session_id, &reprobe, sessions.clone()).await {
                    warn!(
                        "[exec_in_pty] Failed to write reprobe marker after lag: {}",
                        err
                    );
                }
                last_output_time = tokio::time::Instant::now();
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => {
                info!("[exec_in_pty] CLOSED marker={}", marker_id);
                return Err("PTY session closed unexpectedly".to_string());
            }
            Err(_) => {
                let silence = last_output_time.elapsed();
                if silence >= watchdog_interval {
                    info!(
                        "[exec_in_pty] WATCHDOG reprobe after {:.1}s silence, marker={}",
                        silence.as_secs_f64(),
                        marker_id
                    );
                    let reprobe = " printf '\\n%s__%d__\\n' \"$__M\" $?\n".to_string();
                    if let Err(err) = write_to_session(session_id, &reprobe, sessions.clone()).await
                    {
                        warn!(
                            "[exec_in_pty] Failed to write watchdog reprobe marker: {}",
                            err
                        );
                    }
                    last_output_time = tokio::time::Instant::now();
                }
            }
        }
    }
}

/// Extract the done marker from collected output.
pub(crate) fn extract_done_marker(output: &str, done_marker: &str) -> Option<(String, i32)> {
    let stripped = clean_pty_output(output);
    let pattern_prefix = format!("{done_marker}__");

    if let Some(marker_start) = stripped.rfind(&pattern_prefix) {
        let after_prefix = &stripped[marker_start + pattern_prefix.len()..];
        if let Some(end_pos) = after_prefix.find("__") {
            let exit_code_str = &after_prefix[..end_pos];

            if let Ok(exit_code) = exit_code_str.parse::<i32>() {
                let raw_output = &stripped[..marker_start];
                let cleaned = strip_command_echo(raw_output);
                let truncated = truncate_output(&cleaned);

                return Some((truncated, exit_code));
            }
        }
    }
    None
}

/// Remove the command echo line(s) from collected output.
pub(crate) fn strip_command_echo(output: &str) -> String {
    let trimmed = output.trim_start();

    if let Some(echo_end) = trimmed.find('\n') {
        let after_echo = &trimmed[echo_end + 1..];
        after_echo.trim().to_string()
    } else {
        String::new()
    }
}
