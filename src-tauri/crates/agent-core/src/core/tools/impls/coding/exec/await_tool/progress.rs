//! Progress fingerprints for the turn executor's repeat guard.
//!
//! `await_output` is the one tool whose *identical* re-invocation is the
//! intended protocol: the model re-issues the same `wait_for` while a
//! background job runs. The executor's repeat guard must therefore judge
//! "progress", not "same arguments" — and progress for a background job is
//! exactly (status, output cursor). This module renders that pair into a
//! stable string per handle:
//!
//! - **replay-backed shells**: the Session Replay bookmark
//!   (`visible_through_sequence` + `visible_bytes`) — monotonic, unlike the
//!   256 KiB body tail whose length plateaus on chatty jobs.
//! - **legacy log shells**: the log file size (append-only).
//! - **subagents**: the registry's monotonic `output_seq` line counter plus
//!   whether a final result has landed.
//! - **terminal / tombstoned / unknown handles**: the terminal status alone —
//!   stable, so a model re-reading the same finished result still trips the
//!   guard (that IS a loop).
//!
//! Fingerprints are compared only between calls with identical arguments, so
//! the rendered string never needs to be canonical across argument shapes —
//! it only needs to change iff the observed state changed.

use serde_json::Value;

use super::super::{registry, shell_replay};
use super::params::parse_handles;

/// Fingerprint one handle's observed state. Never blocks; every probe is a
/// registry / in-memory-map / stat lookup.
fn handle_fingerprint(handle: &str) -> String {
    let Some((status, kind)) = registry::resolve_status_with_tombstone(handle) else {
        return format!("{handle}=unknown");
    };

    let status_part = match &status {
        registry::JobStatus::Running => "running".to_string(),
        registry::JobStatus::Exited(code) => format!("exited:{code}"),
        registry::JobStatus::Killed => "killed".to_string(),
        registry::JobStatus::Completed => "completed".to_string(),
        registry::JobStatus::Failed => "failed".to_string(),
    };
    if !matches!(status, registry::JobStatus::Running) {
        return format!("{handle}={status_part}");
    }

    let cursor = match &kind {
        registry::JobKind::Shell {
            replay_session_id: Some(session_id),
            replay_call_id: Some(call_id),
            ..
        } => match shell_replay::active_state(session_id, call_id) {
            Some(state) => format!(
                "seq:{}:bytes:{}",
                state.bookmark.visible_through_sequence, state.bookmark.visible_bytes
            ),
            // Replay already finalized (or not yet inserted) while the job
            // row still says Running — a transition state that itself
            // constitutes progress relative to a live bookmark.
            None => "replay-closed".to_string(),
        },
        registry::JobKind::Shell { log_path, .. } => match std::fs::metadata(log_path) {
            Ok(meta) => format!("log:{}", meta.len()),
            Err(_) => "log:absent".to_string(),
        },
        registry::JobKind::Subagent { .. } => format!(
            "lines:{}:final:{}",
            registry::get_output_seq(handle).unwrap_or(0),
            registry::get_final_result(handle).is_some()
        ),
    };
    // A stall-latch flip is information the model hasn't seen yet (the next
    // wait response carries the kill-and-rerun advisory), so it counts as
    // progress for the repeat guard.
    let stalled = if registry::is_stalled_waiting_input(handle) == Some(true) {
        ":stalled"
    } else {
        ""
    };
    format!("{handle}={status_part}@{cursor}{stalled}")
}

/// Fingerprint an `await_output` call's observed state, or `None` when the
/// call does not observe pollable jobs (`list`, unparsable handles) — those
/// fall back to the guard's plain args-identity semantics.
pub(super) fn call_progress_fingerprint(params: &Value) -> Option<String> {
    let command = params
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("monitor");
    if command != "wait_for" && command != "monitor" {
        return None;
    }
    let handles = parse_handles(params).ok()?;
    Some(
        handles
            .iter()
            .map(|h| handle_fingerprint(h))
            .collect::<Vec<_>>()
            .join("|"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn unknown_handle_fingerprint_is_stable() {
        let params = serde_json::json!({
            "command": "wait_for",
            "handles": ["4294000777"],
        });
        let first = call_progress_fingerprint(&params).expect("fingerprint");
        let second = call_progress_fingerprint(&params).expect("fingerprint");
        assert_eq!(first, second);
        assert!(first.contains("unknown"));
    }

    #[test]
    fn list_and_malformed_calls_have_no_fingerprint() {
        assert_eq!(
            call_progress_fingerprint(&serde_json::json!({ "command": "list" })),
            None
        );
        assert_eq!(
            call_progress_fingerprint(&serde_json::json!({ "command": "wait_for" })),
            None,
            "missing handles must fall back to args-identity semantics"
        );
    }

    #[test]
    fn subagent_fingerprint_advances_with_output_and_status() {
        let handle = "agent-progress-fp".to_string();
        let (_tx, _cancel) = registry::register_subagent(
            handle.clone(),
            "delegate".into(),
            "Worker".into(),
            "progress-fp-session".into(),
        );
        let params = serde_json::json!({
            "command": "wait_for",
            "handles": [handle],
        });

        let idle = call_progress_fingerprint(&params).expect("fingerprint");
        assert_eq!(
            idle,
            call_progress_fingerprint(&params).expect("fingerprint"),
            "no output, no status change → fingerprint must be stable"
        );

        registry::push_output_line(&handle, "tool call: read_file".into());
        let after_output = call_progress_fingerprint(&params).expect("fingerprint");
        assert_ne!(idle, after_output, "new output must advance the cursor");

        registry::mark_exited(&handle, registry::JobStatus::Completed);
        let terminal = call_progress_fingerprint(&params).expect("fingerprint");
        assert_ne!(after_output, terminal, "termination is progress");
        assert_eq!(
            terminal,
            call_progress_fingerprint(&params).expect("fingerprint"),
            "a terminal result re-read forever is a loop → fingerprint stays put"
        );

        registry::remove(&handle);
    }

    #[test]
    fn stall_latch_flip_advances_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let log_path: PathBuf = dir.path().join("stall.log");
        std::fs::write(&log_path, b"Username for 'https://github.com':").unwrap();

        let pid = 4_294_000_999_u32;
        let _tx = registry::register_shell(
            pid,
            "git push".into(),
            log_path,
            "progress-fp-stall-session".into(),
        );
        let params = serde_json::json!({
            "command": "wait_for",
            "handles": [pid.to_string()],
        });

        let before = call_progress_fingerprint(&params).expect("fingerprint");
        registry::mark_stalled_waiting_input(&pid.to_string());
        let after = call_progress_fingerprint(&params).expect("fingerprint");
        assert_ne!(
            before, after,
            "the stall latch flipping is new information for the model"
        );
        assert!(after.contains(":stalled"));

        registry::remove(&pid.to_string());
    }

    #[test]
    fn legacy_shell_fingerprint_tracks_log_growth() {
        let dir = tempfile::tempdir().unwrap();
        let log_path: PathBuf = dir.path().join("progress.log");
        std::fs::write(&log_path, b"first\n").unwrap();

        let pid = 4_294_000_888_u32;
        let _tx = registry::register_shell(
            pid,
            "cargo test".into(),
            log_path.clone(),
            "progress-fp-shell-session".into(),
        );
        let params = serde_json::json!({
            "command": "wait_for",
            "handles": [pid.to_string()],
        });

        let before = call_progress_fingerprint(&params).expect("fingerprint");
        assert_eq!(
            before,
            call_progress_fingerprint(&params).expect("fingerprint")
        );

        std::fs::write(&log_path, b"first\nsecond\n").unwrap();
        let after = call_progress_fingerprint(&params).expect("fingerprint");
        assert_ne!(before, after, "log growth must advance the fingerprint");

        registry::remove(&pid.to_string());
    }
}
