//! Coalescing debouncer for `rebuild_turn_index`.
//!
//! `save_events` historically called `rebuild_turn_index` synchronously
//! at the tail of every batch. For a single human-driven session that
//! cost is unmeasurable, but the streaming agent pipeline (parent +
//! N subagents) issues hundreds of `save_events` per second, each
//! pulling the writer mutex twice in quick succession (events INSERT,
//! then index DELETE+INSERT). Worse, every rebuild re-runs
//! `normalize_session_sequences` (per-row UPDATEs) over the full event
//! tail, multiplying writer-lock work.
//!
//! The index is **eventually consistent** by design: `load_turn_index`
//! calls `ensure_turn_index_fresh`, which compares
//! `indexed_event_count` / `indexed_max_sequence` against the live
//! `events` table and rebuilds lazily. Dropping the synchronous rebuild
//! from the hot path is therefore safe — any reader will catch up.
//!
//! To keep the index reasonably fresh for background consumers (and to
//! cap worst-case rebuild cost on the next read), we additionally
//! schedule a coalesced background rebuild per session ID. Multiple
//! `save_events` calls within `DEBOUNCE_DELAY` collapse to a single
//! rebuild.
//!
//! One process-wide condvar worker owns exact per-session deadlines. It is
//! fully parked while no rebuild is scheduled; concurrent sessions do not
//! create additional OS threads or fixed-cadence wakeups.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Quiet period before a coalesced rebuild fires. Tuned to the
/// human-perceptible "did the turn list update?" budget: a few hundred
/// ms is invisible in the UI, and 250ms is short enough that even
/// long-running tool calls (which stream events at sub-second cadence)
/// fold into one rebuild between turns.
const DEBOUNCE_DELAY: Duration = Duration::from_millis(250);

struct ScheduledState {
    /// Session → exact quiet-period deadline. A new write replaces the
    /// deadline, so continuous streaming stays coalesced without periodic
    /// per-session wakeups.
    scheduled: HashMap<String, Instant>,
    /// One process-wide worker owns all deadlines.
    worker_running: bool,
}

static SCHEDULED: OnceLock<(Mutex<ScheduledState>, Condvar)> = OnceLock::new();

fn scheduled_state() -> &'static (Mutex<ScheduledState>, Condvar) {
    SCHEDULED.get_or_init(|| {
        (
            Mutex::new(ScheduledState {
                scheduled: HashMap::new(),
                worker_running: false,
            }),
            Condvar::new(),
        )
    })
}

/// Schedule a background `rebuild_turn_index` for `session_id`.
///
/// Multiple calls within [`DEBOUNCE_DELAY`] collapse into a single
/// rebuild. Failures are logged and dropped — the index is recomputed
/// from `events` on next read via `ensure_turn_index_fresh`, so a
/// dropped background rebuild does not cause data loss.
pub fn schedule(session_id: &str) {
    let session_owned = session_id.to_string();
    let (state_lock, wake) = scheduled_state();

    // Atomically replace this session's deadline and decide whether this
    // call must create the single process-wide worker.
    let needs_worker = {
        let mut state = match state_lock.lock() {
            Ok(guard) => guard,
            // Poisoned mutex: another thread panicked while holding it.
            // The state itself is just a scheduling cache, so recovering
            // and continuing is strictly better than propagating the
            // panic into the writer hot path.
            Err(poisoned) => poisoned.into_inner(),
        };
        state
            .scheduled
            .insert(session_owned.clone(), Instant::now() + DEBOUNCE_DELAY);
        let needs_worker = !state.worker_running;
        state.worker_running = true;
        needs_worker
    };
    // Wake the worker if this write moved the earliest deadline.
    wake.notify_one();

    if !needs_worker {
        return;
    }

    let spawn_result = std::thread::Builder::new()
        .name("turn-index-debounce".to_string())
        .spawn(debounce_worker);

    // If thread spawn failed (OS thread limit hit) clear the in-flight
    // flag so the next `schedule()` call can try again; otherwise we'd
    // wedge this session's debouncer forever.
    if let Err(err) = spawn_result {
        tracing::warn!("[turn-index-debounce] failed to spawn worker for {session_owned}: {err}");
        let mut state = match state_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.worker_running = false;
    }
}

/// Process-wide exact-deadline worker. It blocks on a condvar while empty and
/// wakes only for a new/earlier deadline or when the next rebuild is due.
fn debounce_worker() {
    let (state_lock, wake) = scheduled_state();
    loop {
        let due_sessions = {
            let mut state = match state_lock.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };

            while state.scheduled.is_empty() {
                state = match wake.wait(state) {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }

            let next_deadline = state
                .scheduled
                .values()
                .copied()
                .min()
                .expect("scheduled map is non-empty");
            let now = Instant::now();
            if next_deadline > now {
                let timeout = next_deadline.saturating_duration_since(now);
                let (next_state, _) = match wake.wait_timeout(state, timeout) {
                    Ok(result) => result,
                    Err(poisoned) => poisoned.into_inner(),
                };
                drop(next_state);
                continue;
            }

            let due = state
                .scheduled
                .iter()
                .filter(|(_, deadline)| **deadline <= now)
                .map(|(session, _)| session.clone())
                .collect::<Vec<_>>();
            for session in &due {
                state.scheduled.remove(session);
            }
            due
        };

        for session in due_sessions {
            if let Err(err) = super::turn_index::rebuild_turn_index(&session) {
                // Read-time rebuild will recover; just log.
                tracing::warn!("[turn-index-debounce] rebuild failed for {session}: {err}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_does_not_panic_for_unknown_session() {
        // Smoke test only — actual rebuild path exercised by integration
        // tests in `turn_index`.
        schedule("session-that-does-not-exist");
    }
}
