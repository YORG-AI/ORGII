//! Background tokio worker that drains the sync outbox.
//!
//! Three cycles run on independent timers:
//! - **push cycle** every `PUSH_INTERVAL_SECS` (default 30s): claim
//!   pending rows, dispatch to the matching `SyncAdapter`, persist
//!   success / failure-with-backoff. Tail-end GC sweep deletes
//!   succeeded rows older than [`OUTBOX_GC_RETENTION_MS`].
//! - **merge cycle** every `MERGE_INTERVAL_SECS` (default 30s):
//!   drains `merge_external` rows produced by the pull cycle, runs
//!   the resolver against the local item's revision watermarks, and
//!   applies the chosen partial update + revision stamps.
//! - **pull cycle** every `PULL_INTERVAL_SECS` (default 5min): for
//!   every project with an attached adapter, fetch external changes
//!   since the last cursor and append `merge_external` outbox rows
//!   for the merge cycle to consume.
//!
//! The worker is process-singleton: spawned once at app boot from
//! `lib.rs::run`, lives for the process lifetime, and exits only when
//! the runtime shuts down.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::{debug, info, warn};

use super::events;
use super::io;

/// Push cycle interval. Matches the workspace setting
/// `general.syncIntervalSecs` default.
pub const PUSH_INTERVAL_SECS: u64 = 30;
/// Pull cycle interval — runs less aggressively because pulls are far
/// more expensive (one HTTP roundtrip per project).
pub const PULL_INTERVAL_SECS: u64 = 5 * 60;
/// Merge cycle interval. Lock-step with the push cycle so a freshly
/// pulled remote change can land within one tick of arriving in the
/// outbox.
pub const MERGE_INTERVAL_SECS: u64 = 30;
/// Cap on pushes per tick. Keeps the worker from monopolizing the
/// runtime if the outbox piles up.
pub const MAX_PUSHES_PER_TICK: usize = 32;
/// Cap on merge applications per tick. Bounded for the same reason
/// as `MAX_PUSHES_PER_TICK`; hundreds of inbound rows shouldn't stall
/// the worker.
pub const MAX_MERGES_PER_TICK: usize = 32;
/// Audit retention for succeeded outbox rows. After this window the
/// row is GC'd by [`io::gc_succeeded`] — the field watermark in
/// `workitem_extras.field_revisions` is enough to drive subsequent
/// merges, and the adapter's external state is the source of truth.
pub const OUTBOX_GC_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Cap on rows GC'd per tick. Bounded so a long-stalled sweep doesn't
/// monopolize the worker.
pub const OUTBOX_GC_LIMIT: usize = 500;

/// Webhook freshness window. When a project received a webhook
/// delivery within this many milliseconds, the next scheduled pull
/// cycle skips that project — the webhook payload already supplied
/// the inbound changes, and re-pulling would be wasted bandwidth +
/// a doubled chance of hitting an adapter rate limit.
///
/// Slightly longer than the pull cadence (5 min) so a missed tick
/// doesn't immediately fall back to polling, but short enough that
/// a flaky webhook (e.g. tunnel hiccup) recovers within one extra
/// pull cycle.
pub const WEBHOOK_FRESHNESS_WINDOW_MS: i64 = 10 * 60 * 1000;

/// Import cycle interval. Imports run on their own timer
/// because `pull_all` calls are far heavier than incremental pulls
/// (full repo history → potentially hundreds of pages) and we don't
/// want the bulk walk to fight the incremental cycle for adapter
/// rate budget. One tick per minute lets a freshly attached project
/// start moving within a UX-visible window without saturating the
/// remote.
pub const IMPORT_INTERVAL_SECS: u64 = 60;
/// Cap on import pages per tick per project. One page per tick gives
/// the merge cycle time to drain the resulting outbox rows before the
/// next page lands — keeps the queue depth bounded even on huge
/// projects. Tune up if support requests show "import is too slow".
pub const MAX_IMPORT_PAGES_PER_TICK: usize = 1;

mod bulk_import;
mod identity;
mod merge;
mod merge_helpers;
mod pull;
mod push;

pub use bulk_import::import_cycle;
pub use merge::merge_cycle;
pub use merge_helpers::partial_update_from_map;
pub use pull::{pull_cycle, pull_one_project_by_slug};
pub use push::push_cycle;

/// Spawn the singleton sync worker.
///
/// Called from Tauri's synchronous `setup` hook in `lib.rs::run`, which
/// has no ambient tokio runtime — `tokio::spawn` would panic there. We
/// use `tauri::async_runtime::spawn` (mirrors the sibling scheduler
/// + channel-restore tasks) so the future is parked on Tauri's runtime.
///
/// Idempotent at the call site only — calling twice spawns two tasks.
/// `lib.rs::run` is responsible for calling this exactly once per process.
///
/// `app_handle` is stashed via [`events::init_emitter`] so every
/// worker cycle can emit `orgii-project-sync-status` events to the
/// frontend. Tests skip the emit by never calling `init_emitter` — the
/// emitter silently no-ops without an AppHandle.
///
/// Boot-time orphan recovery runs synchronously before the loop starts:
/// any rows left in `in_flight` from a previous crashed run are demoted
/// back to `pending` so the worker can retry them.
pub fn start_worker(app_handle: tauri::AppHandle) {
    events::init_emitter(app_handle);
    if let Err(err) = recover_in_flight_orphans() {
        warn!("[sync::worker] in-flight orphan recovery failed: {}", err);
    }
    match identity::normalize_existing_external_short_ids() {
        Ok(count) if count > 0 => info!(
            "[sync::worker] normalized {} adapter-owned work-item identifier(s)",
            count
        ),
        Ok(_) => {}
        Err(err) => warn!(
            "[sync::worker] adapter-owned identifier normalization failed: {}",
            err
        ),
    }
    tauri::async_runtime::spawn(async move {
        info!(
            "[sync::worker] started (push={}s, pull={}s, max_per_tick={})",
            PUSH_INTERVAL_SECS, PULL_INTERVAL_SECS, MAX_PUSHES_PER_TICK
        );
        run_loop(LoopConfig::default()).await;
    });
}

/// Reset every `in_flight` outbox row to `pending` so the next push
/// cycle re-claims it. The worker is process-singleton, so finding a
/// row in `in_flight` at boot can only mean the previous process
/// crashed mid-push — without this sweep those rows would stick in
/// `in_flight` forever and never be re-attempted.
fn recover_in_flight_orphans() -> Result<usize, String> {
    let conn = io::conn()?;
    io::reset_in_flight_to_pending(&conn).inspect(|&count| {
        if count > 0 {
            info!(
                "[sync::worker] recovered {} in-flight orphan(s) to pending",
                count
            );
        }
    })
}

/// Configuration knobs for the worker loop. Public so tests can swap in
/// a tiny tick interval.
#[derive(Debug, Clone, Copy)]
pub struct LoopConfig {
    pub push_interval: Duration,
    pub pull_interval: Duration,
    pub merge_interval: Duration,
    pub import_interval: Duration,
    pub max_pushes_per_tick: usize,
    pub max_merges_per_tick: usize,
    pub max_import_pages_per_tick: usize,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            push_interval: Duration::from_secs(PUSH_INTERVAL_SECS),
            pull_interval: Duration::from_secs(PULL_INTERVAL_SECS),
            merge_interval: Duration::from_secs(MERGE_INTERVAL_SECS),
            import_interval: Duration::from_secs(IMPORT_INTERVAL_SECS),
            max_pushes_per_tick: MAX_PUSHES_PER_TICK,
            max_merges_per_tick: MAX_MERGES_PER_TICK,
            max_import_pages_per_tick: MAX_IMPORT_PAGES_PER_TICK,
        }
    }
}

async fn run_loop(config: LoopConfig) {
    let mut last_pull_tick = std::time::Instant::now() - config.pull_interval;
    let mut last_merge_tick = std::time::Instant::now() - config.merge_interval;
    let mut last_import_tick = std::time::Instant::now() - config.import_interval;
    loop {
        tokio::time::sleep(config.push_interval).await;
        if let Err(err) = push_cycle(config.max_pushes_per_tick).await {
            warn!("[sync::worker] push cycle failed: {}", err);
        }
        if let Err(err) = gc_cycle().await {
            warn!("[sync::worker] gc cycle failed: {}", err);
        }
        if last_merge_tick.elapsed() >= config.merge_interval {
            if let Err(err) = merge_cycle(config.max_merges_per_tick).await {
                warn!("[sync::worker] merge cycle failed: {}", err);
            }
            last_merge_tick = std::time::Instant::now();
        }
        if last_pull_tick.elapsed() >= config.pull_interval {
            if let Err(err) = pull_cycle().await {
                warn!("[sync::worker] pull cycle failed: {}", err);
            }
            last_pull_tick = std::time::Instant::now();
        }
        if last_import_tick.elapsed() >= config.import_interval {
            if let Err(err) = import_cycle(config.max_import_pages_per_tick).await {
                warn!("[sync::worker] import cycle failed: {}", err);
            }
            last_import_tick = std::time::Instant::now();
        }
    }
}

/// Tail-end garbage collection of succeeded outbox rows. Runs once
/// per push tick — cheap when there's nothing to delete, bounded by
/// [`OUTBOX_GC_LIMIT`] when there is.
async fn gc_cycle() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let conn = io::conn()?;
        let deleted = io::gc_succeeded(&conn, now_ms(), OUTBOX_GC_RETENTION_MS, OUTBOX_GC_LIMIT)?;
        if deleted > 0 {
            debug!(
                "[sync::worker] gc swept {} succeeded outbox row(s)",
                deleted
            );
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("gc-cycle join error: {}", err))?
}

pub(super) async fn finalize_success(id: i64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = io::conn()?;
        io::mark_succeeded(&conn, id)
    })
    .await
    .map_err(|err| format!("finalize-success join error: {}", err))?
}

/// Mark the row as failed. `retryable=false` (Permanent / AuthFailed
/// errors) jumps straight to `Abandoned`; `retryable=true` walks the
/// configured backoff schedule and abandons only after the budget is
/// exhausted. Both paths persist `last_error` so `project_sync_status`
/// can surface the message.
pub(super) async fn finalize_failure(
    id: i64,
    message: &str,
    retryable: bool,
) -> Result<(), String> {
    let owned_message = message.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = io::conn()?;
        let now = now_ms();
        let force_abandon = !retryable;
        let _final_status =
            io::mark_failed_with_backoff(&conn, id, now, &owned_message, force_abandon)?;
        Ok(())
    })
    .await
    .map_err(|err| format!("finalize-failure join error: {}", err))?
}

/// Convert the current wall clock to Unix-epoch milliseconds. Mirrors
/// `projects::io::helpers::now_ms` so the sync layer doesn't depend on
/// a private helper. Internal: only the worker reads the wall clock.
pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

/// Public accessor for the worker's wall-clock helper. Exposed so
/// command handlers (e.g. attach-adapter, import retry) can stamp
/// rows with the same monotonic source the worker uses.
pub fn now_ms_pub() -> i64 {
    now_ms()
}

#[cfg(debug_assertions)]
mod debug;

#[cfg(debug_assertions)]
pub use debug::pump_once_for_project;

#[cfg(test)]
mod tests;
