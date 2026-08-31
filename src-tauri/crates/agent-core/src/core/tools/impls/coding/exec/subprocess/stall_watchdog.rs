//! Interactive-stall detection for background subprocesses.

use std::time::{Duration, Instant};

use super::super::{registry, shell_replay::active_state};
use super::events::broadcast_system_output;
use super::ExecIdentity;

/// How often the background monitor probes the replay bookmark for stall
/// detection. Coarse — the probe is an in-memory RwLock read.
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// How long output must stop growing before the tail is even considered for
/// the interactive-prompt check.
const STALL_THRESHOLD: Duration = Duration::from_secs(45);

/// Stall detector for a backgrounded shell: when the replay bookmark stops
/// advancing for [`STALL_THRESHOLD`] and the terminal preview's last line
/// looks like an interactive prompt, latch the job as waiting-for-input.
/// The latch feeds the Background Jobs reminder, the mid-turn note, the
/// await_output hint, and a one-shot owner wake — everything needed for the
/// model to kill the process and re-run it non-interactively instead of
/// waiting out the 1h safety timeout. Output resuming clears the latch and
/// re-arms the advisory.
pub(super) struct StallWatchdog {
    last_probe: Instant,
    last_bytes: u64,
    last_growth: Instant,
    latched: bool,
}

impl StallWatchdog {
    pub(super) fn new() -> Self {
        let now = Instant::now();
        Self {
            last_probe: now,
            last_bytes: 0,
            last_growth: now,
            latched: false,
        }
    }

    pub(super) fn probe(&mut self, identity: &ExecIdentity, pid: u32) {
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
pub(super) fn looks_like_interactive_prompt(tail: &str) -> bool {
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
