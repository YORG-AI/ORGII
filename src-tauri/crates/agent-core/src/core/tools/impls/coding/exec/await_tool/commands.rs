//! Subcommand implementations: `wait_for`, `monitor`, `list`.
//!
//! Each method is invoked via `AwaitTool::execute_text` after the dispatcher
//! validates `command`. Implementations live here so `mod.rs` only owns the
//! `Tool` trait surface.

use ::regex::Regex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

use super::super::registry;
use super::body::{find_match_line, read_body};
use super::params::{
    parse_handles, parse_tail_lines, parse_wait_mode, resolve_job_or_unknown, WaitMode,
    DEFAULT_BLOCK_MS, POLL_INTERVAL_MS,
};
use super::response::{build_list_response, build_response};
use super::snapshot::{running_snapshot, terminal_snapshot, HandleSnapshot, AWAIT_STATUS_RUNNING};
use super::AwaitTool;
use crate::tools::traits::ToolError;
use serde_json::Value;

const MAX_ACCUMULATED_OUTPUT_BYTES: usize = 256 * 1024;
const AWAIT_CANCELLED_MESSAGE: &str = "await_output cancelled by turn boundary";

async fn sleep_or_cancel(duration: Duration, cancel_flag: Option<&Arc<AtomicBool>>) -> bool {
    let Some(cancel_flag) = cancel_flag else {
        tokio::time::sleep(duration).await;
        return false;
    };
    if cancel_flag.load(Ordering::Relaxed) {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        _ = async {
            loop {
                if cancel_flag.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        } => true,
    }
}

fn replay_body_is_authoritative(kind: &registry::JobKind) -> bool {
    matches!(
        kind,
        registry::JobKind::Shell {
            replay_session_id: Some(_),
            replay_call_id: Some(_),
            ..
        }
    )
}

fn append_bounded_output_tail(output: &mut String, chunk: &str) {
    output.push_str(chunk);
    if output.len() <= MAX_ACCUMULATED_OUTPUT_BYTES {
        return;
    }
    let mut remove = output.len().saturating_sub(MAX_ACCUMULATED_OUTPUT_BYTES);
    while remove < output.len() && !output.is_char_boundary(remove) {
        remove += 1;
    }
    output.drain(..remove);
}

impl AwaitTool {
    /// `command=wait_for` — block until some termination / pattern-match condition
    /// is met across one or many handles, or the block timeout elapses.
    pub(super) async fn run_wait_for(&self, params: &Value) -> Result<String, ToolError> {
        let cancel_flag = self.cancel_flag.lock().await.clone();
        if cancel_flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Ok(AWAIT_CANCELLED_MESSAGE.to_string());
        }
        let handles = parse_handles(params)?;
        let pattern_str = params.get("pattern").and_then(|v| v.as_str());
        let block_ms = params
            .get("block_until_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_BLOCK_MS);
        let tail_count = parse_tail_lines(params);
        let wait_mode = parse_wait_mode(params)?;

        // Pattern matching only makes sense for a single handle — with multiple
        // handles it's ambiguous which job's output should be matched.
        if pattern_str.is_some() && handles.len() > 1 {
            return Err(ToolError::InvalidParams(
                "`pattern` is only supported with a single handle; \
                 call wait_for per-handle if you need pattern matching across jobs"
                    .into(),
            ));
        }

        let regex = if let Some(pat) = pattern_str {
            Some(
                Regex::new(pat)
                    .map_err(|err| ToolError::InvalidParams(format!("Invalid regex: {}", err)))?,
            )
        } else {
            None
        };

        // Resolve all handles up-front. A vanished-but-tombstoned handle
        // resolves to its real terminal status (precise "it finished"); a
        // genuinely unknown handle returns an error so the agent learns it
        // mistyped, instead of being told a non-existent job "completed".
        let jobs: Vec<(String, registry::JobKind)> = handles
            .iter()
            .map(|h| resolve_job_or_unknown(h).map(|(_, kind)| (h.clone(), kind)))
            .collect::<Result<_, _>>()?;

        // Non-blocking call (block_until_ms=0): return immediate snapshots.
        if block_ms == 0 {
            let snapshots: Vec<HandleSnapshot> = jobs
                .iter()
                .map(|(h, kind)| {
                    let (status, _) = registry::get_status(h)
                        .unwrap_or((registry::JobStatus::Completed, kind.clone()));
                    let body = read_body(h, kind);
                    if matches!(status, registry::JobStatus::Running) {
                        let matched = regex.as_ref().map(|re| re.is_match(&body));
                        let match_line = regex
                            .as_ref()
                            .and_then(|re| find_match_line(&body, re).map(String::from));
                        running_snapshot(h, kind, 0, matched, match_line, body)
                    } else {
                        registry::acknowledge_output(h);
                        terminal_snapshot(h, kind, &status, body)
                    }
                })
                .collect();
            return Ok(build_response(&snapshots, tail_count));
        }

        // Subscribe to every handle before we start checking so we don't miss
        // output chunks emitted between the initial `read_body` and the poll
        // loop.
        let mut receivers: Vec<Option<tokio::sync::broadcast::Receiver<String>>> = jobs
            .iter()
            .map(|(h, kind)| {
                if replay_body_is_authoritative(kind) {
                    None
                } else {
                    registry::subscribe(h)
                }
            })
            .collect();
        let mut accumulated: Vec<String> =
            jobs.iter().map(|(h, kind)| read_body(h, kind)).collect();
        let start = Instant::now();
        let deadline = start + Duration::from_millis(block_ms);

        // Pattern pre-check against existing buffered output.
        if let Some(ref re) = regex {
            if let Some(body) = accumulated.first() {
                if re.is_match(body) {
                    let (h, kind) = &jobs[0];
                    let match_line = find_match_line(body, re).map(String::from);
                    let snap = running_snapshot(
                        h,
                        kind,
                        0,
                        Some(true),
                        match_line,
                        std::mem::take(&mut accumulated[0]),
                    );
                    return Ok(build_response(&[snap], tail_count));
                }
            }
        }

        // Shared poll loop across all handles. We don't spawn per-handle tasks
        // because (a) broadcast::Receiver isn't Sync for easy joining, and (b)
        // poll rates are low (250ms). Iterating handles per tick keeps the
        // implementation straightforward.
        let mut terminated: Vec<bool> = vec![false; jobs.len()];
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let poll_dur = remaining.min(Duration::from_millis(POLL_INTERVAL_MS));
            if sleep_or_cancel(poll_dur, cancel_flag.as_ref()).await {
                return Ok(AWAIT_CANCELLED_MESSAGE.to_string());
            }

            // Drain any buffered output chunks from each handle's receiver
            // and re-check termination/pattern.
            for (idx, (h, kind)) in jobs.iter().enumerate() {
                if terminated[idx] {
                    continue;
                }

                if let Some(receiver) = receivers[idx].as_mut() {
                    while let Ok(chunk) = receiver.try_recv() {
                        // Pattern matching intentionally operates on the most
                        // recent 256 KiB window; complete shell history lives
                        // in Session Replay and is never accumulated here.
                        append_bounded_output_tail(&mut accumulated[idx], &chunk);
                    }
                } else {
                    accumulated[idx] = read_body(h, kind);
                }

                // Pattern match is only valid for single-handle calls.
                if let Some(ref re) = regex {
                    if re.is_match(&accumulated[idx]) {
                        let match_line = find_match_line(&accumulated[idx], re).map(String::from);
                        let waited = start.elapsed().as_millis() as u64;
                        let snap = running_snapshot(
                            h,
                            kind,
                            waited,
                            Some(true),
                            match_line,
                            std::mem::take(&mut accumulated[idx]),
                        );
                        return Ok(build_response(&[snap], tail_count));
                    }
                }

                // Termination check.
                let is_terminal = match registry::get_status(h) {
                    Some((status, _)) => !matches!(status, registry::JobStatus::Running),
                    // Gone from registry — treat as completed (cleaned up).
                    None => true,
                };
                if is_terminal {
                    terminated[idx] = true;
                }
            }

            let done_count = terminated.iter().filter(|&&t| t).count();
            let short_circuit = match wait_mode {
                WaitMode::Any => done_count > 0,
                WaitMode::All => done_count == terminated.len(),
            };
            if short_circuit {
                break;
            }
        }

        // Build final snapshots for every handle.
        let waited = start.elapsed().as_millis() as u64;
        let snapshots: Vec<HandleSnapshot> = jobs
            .iter()
            .enumerate()
            .map(|(idx, (h, kind))| {
                let body = read_body(h, kind);
                accumulated[idx] = body.clone();
                match registry::get_status(h) {
                    Some((status, _)) if !matches!(status, registry::JobStatus::Running) => {
                        registry::acknowledge_output(h);
                        terminal_snapshot(h, kind, &status, body)
                    }
                    None => {
                        registry::acknowledge_output(h);
                        // Reaped between resolution and now: use the tombstoned
                        // terminal status when available (precise), else fall
                        // back to Completed (the job is gone, so it's done).
                        let status = registry::resolve_status_with_tombstone(h)
                            .map(|(s, _)| s)
                            .unwrap_or(registry::JobStatus::Completed);
                        terminal_snapshot(h, kind, &status, body)
                    }
                    Some(_) => {
                        let matched = regex.as_ref().map(|re| re.is_match(&body));
                        let match_line = regex
                            .as_ref()
                            .and_then(|re| find_match_line(&body, re).map(String::from));
                        running_snapshot(h, kind, waited, matched, match_line, body)
                    }
                }
            })
            .collect();

        let mut response = build_response(&snapshots, tail_count);

        // Add a hint for single-handle searches that timed out.
        if handles.len() == 1 {
            let snap = &snapshots[0];
            if snap.status == AWAIT_STATUS_RUNNING {
                let is_subagent = matches!(snap.kind, registry::JobKind::Subagent { .. });
                if is_subagent {
                    response.push_str(
                        "\nThe subagent is still working. Do NOT call await_output again to poll — \
                         proceed with other tasks. You will be notified automatically when it finishes.",
                    );
                } else {
                    if let Some(pat) = pattern_str {
                        if snap.pattern_matched == Some(false) {
                            response.push_str(&format!(
                                "\nPattern \"{}\" not matched yet. The process is still running.",
                                pat,
                            ));
                        }
                    }
                    if registry::is_stalled_waiting_input(&snap.handle) == Some(true) {
                        response.push_str(&format!(
                            "\nThe process has produced no output for a while and its last line \
                             looks like an interactive prompt — it is likely waiting for input \
                             and will never finish on its own. Kill it with \
                             run_shell(kill_handle=\"{}\") and re-run non-interactively \
                             (pipe the answer, e.g. `echo y | cmd`, or pass a yes/non-interactive \
                             flag).",
                            snap.handle,
                        ));
                    } else {
                        response.push_str(
                            "\nThe process is still running. Do NOT keep re-issuing the same wait — \
                             if you have other work, continue with it; if this job's result is all \
                             that remains, end your turn now. The session resumes automatically when \
                             the process exits, with its output in the Background Jobs reminder.",
                        );
                    }
                }
            }
        }

        Ok(response)
    }

    /// `command=monitor` — non-blocking snapshot of one or many handles.
    ///
    /// For each handle: current status + its own `--- [<handle>] last N lines ---`
    /// tail block. Replaces the old `status` / `tail` subcommands (both were
    /// semantically identical non-blocking snapshots).
    pub(super) async fn run_monitor(&self, params: &Value) -> Result<String, ToolError> {
        let handles = parse_handles(params)?;
        let tail_count = parse_tail_lines(params);

        let snapshots: Vec<HandleSnapshot> = handles
            .iter()
            .map(|h| {
                // A reaped-but-tombstoned job renders with its real terminal
                // status; a genuinely unknown handle errors so the agent learns
                // it mistyped rather than seeing a fake "completed".
                let (status, kind) = resolve_job_or_unknown(h)?;
                let body = read_body(h, &kind);
                if !matches!(status, registry::JobStatus::Running) {
                    registry::acknowledge_output(h);
                    Ok(terminal_snapshot(h, &kind, &status, body))
                } else {
                    Ok(running_snapshot(h, &kind, 0, None, None, body))
                }
            })
            .collect::<Result<_, ToolError>>()?;

        Ok(build_response(&snapshots, tail_count))
    }

    /// `command=list` — list background jobs for the current session (or globally).
    pub(super) async fn run_list(&self, params: &Value) -> Result<String, ToolError> {
        let scope = params
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("session");

        let session_filter = if scope == "global" {
            None
        } else {
            let session_key = self.session_key.lock().await;
            session_key.clone()
        };

        let snapshots = registry::list_jobs(session_filter.as_deref());
        Ok(build_list_response(&snapshots))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::traits::Tool;

    #[tokio::test]
    async fn wait_for_returns_promptly_when_turn_is_cancelled() {
        let tool = AwaitTool::new();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        tool.set_cancel_flag(Arc::clone(&cancel_flag)).await;

        let pid = 4_294_000_001_u32;
        let handle = pid.to_string();
        registry::register_shell(
            pid,
            "test wait".to_string(),
            std::env::temp_dir().join("orgii-await-cancel-test.log"),
            "await-cancel-test-session".to_string(),
        );

        let cancel = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel_flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let result = tool
            .run_wait_for(&serde_json::json!({
                "handles": [handle],
                "block_until_ms": 60_000,
            }))
            .await
            .expect("cancelled wait should return a result");
        cancel.await.expect("cancel task");
        registry::remove(&pid.to_string());

        assert_eq!(result, AWAIT_CANCELLED_MESSAGE);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
