//! Builds per-turn system-prompt reminders for active background jobs.
//!
//! Injected into `dynamic_sections` in `UnifiedMessageProcessor::process()` so
//! the model is aware of running / unacknowledged-completed shell processes and
//! subagents without having to call `await_output list` every turn.
//!
//! Design goals:
//! - **Accurate status** — uses real-time registry state, not cached text.
//! - **Result delivery** — a completed subagent's final result is inlined
//!   directly (capped) so the parent can act on it immediately instead of
//!   spending a tool call on `await_output`. Inlined jobs are acknowledged
//!   by the caller via [`inlined_result_handles`].
//! - **Auto-cleanup** — completed jobs whose output was read via AwaitTool
//!   are excluded (acknowledged).
//! - **Compact** — one block, bounded per-result budget.

use crate::tools::impls::coding::exec::registry::{JobSnapshot, JobStatus};

/// Cap on an inlined subagent result inside the reminder. Full text remains
/// available via `await_output(monitor)` before acknowledgement and in the
/// subagent transcript afterwards. Public so the agent tool's completion
/// path knows when to persist the full report to disk and prepend a
/// `read_file` pointer that survives this head-truncation
/// (`agent::helpers::with_full_result_pointer`).
pub const INLINE_RESULT_MAX_CHARS: usize = 8_000;

/// Handles whose final result the reminder inlines — the caller must
/// acknowledge exactly these so results are delivered once.
pub fn inlined_result_handles(jobs: &[JobSnapshot]) -> Vec<String> {
    jobs.iter()
        .filter(|job| job.has_unread_output && job.final_result.is_some())
        .map(|job| job.handle.clone())
        .collect()
}

fn terminal_status_label(status: &JobStatus) -> String {
    match status {
        JobStatus::Exited(code) => format!("exit {code}"),
        JobStatus::Killed => "killed".to_string(),
        JobStatus::Completed => "completed".to_string(),
        JobStatus::Failed => "failed".to_string(),
        JobStatus::Running => "running".to_string(),
    }
}

const STALLED_ANNOTATION: &str =
    "⚠ no recent output and the tail looks like an interactive prompt — likely waiting for input";

/// One advice line for stalled shells, shared by the reminder and the
/// mid-turn note so the recovery instruction stays identical everywhere.
const STALLED_ADVICE: &str = "A job marked as waiting for input will never finish on its own: \
     kill it with run_shell(kill_handle=\"<handle>\") and re-run non-interactively \
     (pipe the answer, e.g. `echo y | cmd`, or pass a yes/non-interactive flag).";

fn push_terminal_entry(lines: &mut Vec<String>, job: &JobSnapshot) {
    lines.push(format!(
        "- `{}` ({}) — `{}` [{}]",
        job.handle,
        job.kind_label,
        job.label,
        terminal_status_label(&job.status),
    ));
    // Subagent results are inlined so the parent can act immediately
    // (result travels WITH the completion notice, not behind another
    // tool call).
    if let Some(ref result) = job.final_result {
        let capped = if result.len() > INLINE_RESULT_MAX_CHARS {
            format!(
                "{}\n[result truncated at {}K chars — full text in the subagent transcript]",
                crate::utils::safe_truncate_utf8(result, INLINE_RESULT_MAX_CHARS),
                INLINE_RESULT_MAX_CHARS / 1000
            )
        } else {
            result.clone()
        };
        lines.push(format!("  <result>\n{}\n  </result>", capped));
    }
}

pub fn build_background_jobs_reminder(jobs: &[JobSnapshot]) -> String {
    let mut running: Vec<&JobSnapshot> = Vec::new();
    let mut unread_completed: Vec<&JobSnapshot> = Vec::new();

    for job in jobs {
        if matches!(job.status, JobStatus::Running) {
            running.push(job);
        } else if job.has_unread_output {
            unread_completed.push(job);
        }
    }

    let mut lines = Vec::with_capacity(jobs.len() + 6);
    lines.push("# Background Jobs".to_string());
    lines.push(String::new());

    if !running.is_empty() {
        lines.push(format!("**Running ({}):**", running.len()));
        for job in &running {
            let age_display = format_age(job.age_ms);
            let stall_note = if job.stalled_waiting_input {
                format!(" — {STALLED_ANNOTATION}")
            } else {
                String::new()
            };
            lines.push(format!(
                "- `{}` ({}) — `{}` ({}){}",
                job.handle, job.kind_label, job.label, age_display, stall_note,
            ));
        }
        if running.iter().any(|job| job.stalled_waiting_input) {
            lines.push(STALLED_ADVICE.to_string());
        }
    }

    if !unread_completed.is_empty() {
        if !running.is_empty() {
            lines.push(String::new());
        }
        lines.push(format!(
            "**Completed — unread output ({}):**",
            unread_completed.len()
        ));
        for job in &unread_completed {
            push_terminal_entry(&mut lines, job);
        }
    }

    lines.push(String::new());

    let any_inlined = unread_completed.iter().any(|j| j.final_result.is_some());
    let any_pending_read = unread_completed.iter().any(|j| j.final_result.is_none());
    if any_inlined {
        lines.push(
            "The <result> blocks above are the completed subagents' final reports — act on them \
             directly; no await_output call is needed for those."
                .to_string(),
        );
    }
    if any_pending_read && running.is_empty() {
        lines.push(
            "Use `await_output(command=\"monitor\", handles=[...])` to read the remaining jobs' output."
                .to_string(),
        );
    } else if !running.is_empty() {
        lines.push(
            "Do NOT call `await_output` repeatedly to poll — the system will notify you \
             automatically when jobs finish, both mid-turn and by resuming an idle session. \
             Continue with other work."
                .to_string(),
        );
    }

    lines.join("\n")
}

/// Mid-turn note injected by the turn executor when background-job events
/// land while a turn is already running: completions with unread output,
/// and running shells latched as waiting for interactive input. The
/// turn-start reminder covers turn boundaries; this covers everything that
/// happens between iterations of the same turn, so the model learns about a
/// finished build without polling for it or waiting for the next turn.
///
/// The caller acknowledges [`inlined_result_handles`] after injecting, same
/// contract as the reminder.
pub fn build_completion_notification(jobs: &[JobSnapshot]) -> String {
    let mut completed: Vec<&JobSnapshot> = Vec::new();
    let mut stalled: Vec<&JobSnapshot> = Vec::new();
    for job in jobs {
        if matches!(job.status, JobStatus::Running) {
            if job.stalled_waiting_input {
                stalled.push(job);
            }
        } else if job.has_unread_output {
            completed.push(job);
        }
    }

    let mut lines = Vec::with_capacity(jobs.len() + 8);
    lines.push("<system-reminder>".to_string());
    lines.push("Background job update — while you were working:".to_string());

    if !completed.is_empty() {
        lines.push(format!("**Finished ({}):**", completed.len()));
        for job in &completed {
            push_terminal_entry(&mut lines, job);
        }
    }

    if !stalled.is_empty() {
        lines.push(format!("**Waiting for input ({}):**", stalled.len()));
        for job in &stalled {
            lines.push(format!(
                "- `{}` ({}) — `{}` ({}) — {}",
                job.handle,
                job.kind_label,
                job.label,
                format_age(job.age_ms),
                STALLED_ANNOTATION,
            ));
        }
        lines.push(STALLED_ADVICE.to_string());
    }

    if completed.iter().any(|job| job.final_result.is_some()) {
        lines.push(
            "The <result> blocks above are the finished subagents' final reports — act on them \
             directly."
                .to_string(),
        );
    }
    if completed.iter().any(|job| job.final_result.is_none()) {
        lines.push(
            "Read finished shell output with `await_output(command=\"monitor\", handles=[...])` \
             if you need it. Do not re-launch finished jobs."
                .to_string(),
        );
    }

    lines.push("</system-reminder>".to_string());
    lines.join("\n")
}

fn format_age(age_ms: u64) -> String {
    let secs = age_ms / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_running(handle: &str, label: &str) -> JobSnapshot {
        JobSnapshot {
            handle: handle.to_string(),
            label: label.to_string(),
            kind_label: "shell".to_string(),
            status: JobStatus::Running,
            age_ms: 45_000,
            has_unread_output: false,
            final_result: None,
            stalled_waiting_input: false,
        }
    }

    fn make_completed(handle: &str, label: &str, code: i32) -> JobSnapshot {
        JobSnapshot {
            handle: handle.to_string(),
            label: label.to_string(),
            kind_label: "shell".to_string(),
            status: JobStatus::Exited(code),
            age_ms: 120_000,
            has_unread_output: true,
            final_result: None,
            stalled_waiting_input: false,
        }
    }

    fn make_acknowledged(handle: &str, label: &str) -> JobSnapshot {
        JobSnapshot {
            handle: handle.to_string(),
            label: label.to_string(),
            kind_label: "shell".to_string(),
            status: JobStatus::Exited(0),
            age_ms: 300_000,
            has_unread_output: false,
            final_result: None,
            stalled_waiting_input: false,
        }
    }

    fn make_completed_subagent(handle: &str, result: &str) -> JobSnapshot {
        JobSnapshot {
            handle: handle.to_string(),
            label: "Explore".to_string(),
            kind_label: "subagent:explore".to_string(),
            status: JobStatus::Completed,
            age_ms: 60_000,
            has_unread_output: true,
            final_result: Some(result.to_string()),
            stalled_waiting_input: false,
        }
    }

    #[test]
    fn running_jobs_appear() {
        let jobs = vec![make_running("12345", "npm run dev")];
        let result = build_background_jobs_reminder(&jobs);
        assert!(result.contains("Running (1)"));
        assert!(result.contains("`12345`"));
        assert!(result.contains("npm run dev"));
        assert!(result.contains("45s"));
    }

    #[test]
    fn completed_unread_appears() {
        let jobs = vec![make_completed("99999", "cargo test", 1)];
        let result = build_background_jobs_reminder(&jobs);
        assert!(result.contains("Completed — unread output (1)"));
        assert!(result.contains("exit 1"));
    }

    #[test]
    fn acknowledged_jobs_excluded() {
        let jobs = vec![make_acknowledged("11111", "sleep 10")];
        let result = build_background_jobs_reminder(&jobs);
        assert!(
            !result.contains("11111"),
            "Acknowledged job should not appear: {result}"
        );
        assert!(!result.contains("Running"));
        assert!(!result.contains("Completed"));
    }

    #[test]
    fn mixed_jobs() {
        let jobs = vec![
            make_running("100", "npm run dev"),
            make_completed("200", "cargo build", 0),
            make_acknowledged("300", "sleep 5"),
        ];
        let result = build_background_jobs_reminder(&jobs);
        assert!(result.contains("Running (1)"));
        assert!(result.contains("`100`"));
        assert!(result.contains("Completed — unread output (1)"));
        assert!(result.contains("`200`"));
        assert!(!result.contains("`300`"));
    }

    #[test]
    fn age_formatting() {
        assert_eq!(format_age(5_000), "5s");
        assert_eq!(format_age(90_000), "1m 30s");
        assert_eq!(format_age(3_661_000), "1h 1m");
    }

    #[test]
    fn subagent_result_is_inlined() {
        let jobs = vec![make_completed_subagent(
            "agent-x",
            "Found 3 call sites in foo.rs",
        )];
        let result = build_background_jobs_reminder(&jobs);
        assert!(result.contains("<result>"), "got: {result}");
        assert!(result.contains("Found 3 call sites in foo.rs"));
        assert!(result.contains("act on them"));
        // No await_output nudge for inlined results.
        assert!(!result.contains("to read the remaining jobs"));
    }

    #[test]
    fn long_result_is_capped() {
        let long = "x".repeat(10_000);
        let jobs = vec![make_completed_subagent("agent-y", &long)];
        let result = build_background_jobs_reminder(&jobs);
        assert!(result.contains("[result truncated"));
    }

    #[test]
    fn inlined_handles_only_cover_result_bearing_jobs() {
        let jobs = vec![
            make_completed_subagent("agent-z", "done"),
            make_completed("shell-1", "cargo test", 0),
            make_running("shell-2", "npm run dev"),
        ];
        assert_eq!(inlined_result_handles(&jobs), vec!["agent-z".to_string()]);
    }

    fn make_stalled(handle: &str, label: &str) -> JobSnapshot {
        JobSnapshot {
            stalled_waiting_input: true,
            ..make_running(handle, label)
        }
    }

    #[test]
    fn reminder_annotates_stalled_running_jobs() {
        let result =
            build_background_jobs_reminder(&[make_stalled("500", "npx create-thing init")]);
        assert!(result.contains("waiting for input"), "got: {result}");
        assert!(
            result.contains("kill_handle"),
            "advice line missing: {result}"
        );

        let clean = build_background_jobs_reminder(&[make_running("501", "npm run dev")]);
        assert!(!clean.contains("waiting for input"));
    }

    #[test]
    fn completion_note_renders_finished_and_stalled_jobs() {
        let note = build_completion_notification(&[
            make_completed("46496", "cargo check && cargo test", 0),
            make_completed_subagent("agent-x", "Found 3 call sites"),
            make_stalled("777", "git push"),
        ]);
        assert!(note.starts_with("<system-reminder>"), "got: {note}");
        assert!(note.ends_with("</system-reminder>"));
        assert!(note.contains("Finished (2)"));
        assert!(note.contains("`46496`") && note.contains("[exit 0]"));
        assert!(note.contains("<result>") && note.contains("Found 3 call sites"));
        assert!(note.contains("Waiting for input (1)") && note.contains("`777`"));
        assert!(note.contains("kill_handle"));
        assert!(note.contains("Do not re-launch finished jobs"));
    }

    #[test]
    fn completion_note_skips_healthy_running_and_acknowledged_jobs() {
        let note = build_completion_notification(&[
            make_running("600", "npm run dev"),
            make_acknowledged("601", "sleep 5"),
            make_completed("602", "cargo build", 1),
        ]);
        assert!(!note.contains("`600`"));
        assert!(!note.contains("`601`"));
        assert!(note.contains("`602`") && note.contains("[exit 1]"));
    }
}
