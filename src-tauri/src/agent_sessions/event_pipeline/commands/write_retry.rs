//! SQLite Write-Through with Retry
//!
//! Synchronous and fire-and-forget helpers that persist `SessionEvent`s to
//! the `events` SQLite table, retrying through transient writer contention.
//! [`bulk_writer`] coalesces the high-frequency streaming `push_events` path
//! into a single in-flight worker per session so a burst of calls folds into
//! one writer-mutex acquisition instead of one `spawn_blocking` task each.

use session_persistence::CachedEvent;

/// Maximum retry attempts for critical write-throughs (subagent linkage stamps).
///
/// With the process-wide writer mutex installed in `database::db::writer`,
/// most contention is queued in Rust before reaching SQLite. The retry
/// loop here remains as a defense-in-depth against cross-process
/// contention (manual `sqlite3` inspection) and against any rare path
/// that still races at the file-lock layer.
pub(super) const CRITICAL_WRITE_MAX_RETRIES: u32 = 8;
/// Maximum retry attempts for bulk event writes.
pub(crate) const BULK_WRITE_MAX_RETRIES: u32 = 5;
/// Base delay between retries (exponential back-off, jittered).
const RETRY_BASE_DELAY_MS: u64 = 50;
/// Cap on per-attempt back-off — prevents pathological tail latency
/// where late attempts would otherwise sleep for multiple seconds.
const RETRY_MAX_DELAY_MS: u64 = 800;

/// Compute the back-off delay for attempt N (0-indexed).
///
/// Uses exponential growth (`base * 2^attempt`) capped at
/// [`RETRY_MAX_DELAY_MS`] with ±25% jitter to break up coordinated
/// retries from many writers waking on the same release edge.
fn retry_backoff_delay_ms(attempt: u32) -> u64 {
    let raw = RETRY_BASE_DELAY_MS.saturating_mul(1u64 << attempt.min(6));
    let capped = raw.min(RETRY_MAX_DELAY_MS);
    let jitter_window = capped / 2;
    let jitter_offset = pseudo_jitter_ms(attempt, jitter_window);
    capped
        .saturating_sub(jitter_window / 2)
        .saturating_add(jitter_offset)
}

/// Deterministic-ish jitter that does not require pulling in `rand` on
/// the hot write path. Uses thread-id + attempt + a monotonic counter
/// so concurrent writers get distinct values.
fn pseudo_jitter_ms(attempt: u32, window: u64) -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    if window == 0 {
        return 0;
    }
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let thread_bits: u64 = {
        let id = std::thread::current().id();
        let mut acc: u64 = 0xcbf29ce4_84222325;
        for byte in format!("{id:?}").as_bytes() {
            acc ^= *byte as u64;
            acc = acc.wrapping_mul(0x0000_0001_0000_01b3);
        }
        acc
    };
    let mixed = n
        .wrapping_mul(0x9e37_79b9_7f4a_7c15)
        .wrapping_add(thread_bits)
        .wrapping_add(attempt as u64);
    mixed % window
}

/// Synchronous retry loop for `save_events`.
///
/// SQLite WAL mode allows concurrent readers but only one writer at a time.
/// During high-throughput subagent execution (many tool calls per second across
/// parent + child sessions), concurrent writes pile up and the 5s
/// `busy_timeout` can be exhausted. Without retry, critical stamps like
/// `subagentSessionId` are lost from disk and the UI breaks on session reload.
///
/// Must be called from a blocking-safe context (inside `spawn_blocking` or
/// a sync function that's OK to sleep briefly).
pub(crate) fn save_events_retry(
    label: &str,
    sid: &str,
    events: &[CachedEvent],
    max_retries: u32,
) -> Result<(), String> {
    use session_persistence as sqlite_cache;

    for attempt in 0..max_retries {
        match sqlite_cache::save_events(sid, events) {
            Ok(_) => return Ok(()),
            Err(err) if attempt + 1 < max_retries => {
                let delay_ms = retry_backoff_delay_ms(attempt);
                let attempt_num = attempt + 1;
                tracing::debug!(
                    "[event-pipeline] {label} write-through attempt {attempt_num}/{max_retries} \
                     failed for {sid}: {err} — retrying in {delay_ms}ms"
                );
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            Err(err) => {
                let message = format!(
                    "[event-pipeline] {label} write-through failed for {sid} \
                     after {max_retries} attempts: {err}"
                );
                tracing::warn!("{message}");
                return Err(message);
            }
        }
    }

    Err(format!(
        "[event-pipeline] {label} write-through failed for {sid}: no attempts were run"
    ))
}

/// Fire-and-forget variant: spawns `save_events_retry` onto `spawn_blocking`.
///
/// For `BULK_WRITE_MAX_RETRIES` (the streaming `push_events` path) callers
/// route through a per-session coalescer in [`bulk_writer`]; rapid
/// sequential calls fold into one writer-mutex acquisition. Critical
/// writes (subagent linkage stamps) bypass the coalescer to keep
/// stamping latency at single-digit ms.
pub(crate) fn persist_events_with_retry(
    label: &'static str,
    sid: String,
    events: Vec<CachedEvent>,
    max_retries: u32,
) {
    if max_retries == BULK_WRITE_MAX_RETRIES {
        bulk_writer::enqueue(label, sid, events);
        return;
    }
    tokio::task::spawn_blocking(move || {
        let _ = save_events_retry(label, &sid, &events, max_retries);
    });
}

/// Per-session bulk-write coalescer.
///
/// The streaming agent pipeline can emit dozens of `push_events` calls
/// per second per session. Each call previously spawned its own
/// `spawn_blocking` task and queued for the writer mutex. The mutex now
/// guarantees serialization, but the blocking-pool task overhead
/// remains and the worker stack of pending writes can grow unboundedly
/// during a burst.
///
/// `bulk_writer` keeps a single in-flight worker per session. New
/// events are appended to the session's pending vec; if a worker is
/// already running it picks them up when it finishes the current batch.
/// Otherwise the enqueue call spawns a fresh worker that drains the
/// queue until it goes empty.
///
/// Failure mode: any individual `save_events_retry` failure is logged
/// by `save_events_retry` itself; the worker continues with the next
/// pending batch (so a transient failure does not stop the queue).
mod bulk_writer {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use session_persistence::CachedEvent;

    use super::{save_events_retry, BULK_WRITE_MAX_RETRIES};

    struct Pending {
        label: &'static str,
        events: Vec<CachedEvent>,
    }

    struct CoalescerState {
        /// For each session: either absent (no worker, no pending) or
        /// `Some(Option<Pending>)`. The outer `Some` marks an in-flight
        /// worker; the inner `Option<Pending>` is `None` while the
        /// worker has nothing extra queued and `Some` once another
        /// batch has been enqueued for it to drain.
        per_session: HashMap<String, Option<Pending>>,
    }

    static STATE: OnceLock<Mutex<CoalescerState>> = OnceLock::new();

    fn state() -> &'static Mutex<CoalescerState> {
        STATE.get_or_init(|| {
            Mutex::new(CoalescerState {
                per_session: HashMap::new(),
            })
        })
    }

    /// Append `events` to `sid`'s pending queue. Spawns a worker if
    /// none is in flight.
    pub fn enqueue(label: &'static str, sid: String, events: Vec<CachedEvent>) {
        let spawn_with: Option<Vec<CachedEvent>> = {
            let mut guard = match state().lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match guard.per_session.get_mut(&sid) {
                Some(slot) => {
                    match slot {
                        Some(pending) => {
                            // Worker in flight AND a follow-up batch
                            // already queued: append to it. The
                            // `label` of the pending batch wins; both
                            // refer to the same write-through code path.
                            pending.events.extend(events);
                        }
                        None => {
                            // Worker in flight but no follow-up batch
                            // queued — install a new pending batch.
                            *slot = Some(Pending { label, events });
                        }
                    }
                    None
                }
                None => {
                    // No worker for this session yet. Mark "in flight,
                    // no follow-up queued" and spawn one ourselves.
                    guard.per_session.insert(sid.clone(), None);
                    Some(events)
                }
            }
        };

        if let Some(first_batch) = spawn_with {
            spawn_worker(label, sid, first_batch);
        }
    }

    /// RAII guard that releases the per-session worker slot on drop.
    ///
    /// If `save_events_retry` panics mid-loop the worker task aborts,
    /// but the `per_session` map entry would otherwise stay forever in
    /// "worker in flight" state and wedge all future writes for that
    /// session. This guard ensures the slot is released on every exit
    /// path (normal return, panic, or thread cancellation).
    ///
    /// On graceful exit the worker calls `release_now()` *while still
    /// holding* the same lock that observed the empty pending queue,
    /// which races-out cleanly against a concurrent `enqueue`.
    struct WorkerSlotGuard {
        sid: String,
        released: bool,
    }

    impl WorkerSlotGuard {
        fn new(sid: String) -> Self {
            Self {
                sid,
                released: false,
            }
        }

        /// Mark the slot as already released so the `Drop` impl skips
        /// re-acquiring the state lock.
        fn mark_released(&mut self) {
            self.released = true;
        }
    }

    impl Drop for WorkerSlotGuard {
        fn drop(&mut self) {
            if self.released {
                return;
            }
            // Panic / unexpected exit path: best-effort slot release.
            // If a follow-up batch was queued by `enqueue` after the
            // panic but before this drop, we promote it back to a
            // "no worker" state — the next `enqueue` will pick it up
            // and respawn. We do *not* try to recover the queued
            // events here because we're already on an unwind path and
            // re-entering `save_events_retry` would be unsafe.
            let mut guard = match state().lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some(slot) = guard.per_session.get_mut(&self.sid) {
                if let Some(pending) = slot.take() {
                    tracing::warn!(
                        "[bulk-writer] worker for {} exited with {} pending events queued; \
                         next enqueue will respawn",
                        self.sid,
                        pending.events.len()
                    );
                }
                guard.per_session.remove(&self.sid);
            }
        }
    }

    fn spawn_worker(label: &'static str, sid: String, first_batch: Vec<CachedEvent>) {
        tokio::task::spawn_blocking(move || {
            let mut guard = WorkerSlotGuard::new(sid.clone());
            let mut current_label = label;
            let mut current_events = first_batch;
            loop {
                let _ =
                    save_events_retry(current_label, &sid, &current_events, BULK_WRITE_MAX_RETRIES);

                // Drain the next pending batch, or shut down if empty.
                // We mark `guard` as released *inside* the state lock
                // on the shutdown branch so a concurrent `enqueue`
                // either sees the slot still present (and appends) or
                // sees it gone (and spawns a fresh worker) — never
                // both.
                let next = {
                    let mut state_guard = match state().lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    match state_guard.per_session.get_mut(&sid) {
                        Some(slot) => match slot.take() {
                            Some(pending) => Some(pending),
                            None => {
                                state_guard.per_session.remove(&sid);
                                guard.mark_released();
                                None
                            }
                        },
                        None => {
                            guard.mark_released();
                            None
                        }
                    }
                };

                match next {
                    Some(pending) => {
                        current_label = pending.label;
                        current_events = pending.events;
                    }
                    None => return,
                }
            }
        });
    }
}
