//! Per-command invocation-rate tracking for orgtrack Tauri commands.
//!
//! Logs a warning when any orgtrack command is called unusually often within
//! a rolling window — a cheap signal for runaway frontend polling loops,
//! without adding meaningful overhead beyond a mutex-guarded counter.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const ORGTRACK_CALL_LOG_WINDOW: Duration = Duration::from_secs(30);
const ORGTRACK_CALL_LOG_THRESHOLD: u64 = 10;

#[derive(Debug)]
struct CommandCallStats {
    window_started_at: Instant,
    count: u64,
}

static ORGTRACK_CALL_STATS: OnceLock<Mutex<HashMap<&'static str, CommandCallStats>>> =
    OnceLock::new();

pub(super) fn record_orgtrack_command_call(command: &'static str) {
    let stats = ORGTRACK_CALL_STATS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = match stats.lock() {
        Ok(guard) => guard,
        Err(err) => {
            tracing::warn!(
                command,
                error = %err,
                "[orgtrack] command frequency tracker mutex poisoned"
            );
            return;
        }
    };

    let now = Instant::now();
    let entry = guard.entry(command).or_insert_with(|| CommandCallStats {
        window_started_at: now,
        count: 0,
    });

    if entry.window_started_at.elapsed() >= ORGTRACK_CALL_LOG_WINDOW {
        if entry.count >= ORGTRACK_CALL_LOG_THRESHOLD {
            tracing::warn!(
                command,
                calls = entry.count,
                window_secs = ORGTRACK_CALL_LOG_WINDOW.as_secs(),
                "[orgtrack] high command invocation rate"
            );
        }
        entry.window_started_at = now;
        entry.count = 0;
    }

    entry.count = entry.count.saturating_add(1);
}
