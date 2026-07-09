//! Tauri commands for the Rust EventStore
//!
//! Thin wrappers around per-session `EventStore` instances and derived computations.
//! Each command acquires the `Mutex`, resolves the target session (explicit
//! `session_id` argument or the active session), performs the operation, and
//! returns.
//!
//! Notification scheduling (100ms batched `es:changed` events) is handled by
//! a background tokio task spawned at app startup. Each snapshot is tagged with
//! the `sessionId` it describes so the frontend can route to per-session
//! listeners.

mod analytics;
mod batch_update;
mod cache_bridge;
pub(crate) mod event_conversion;
mod extractors;
mod history;
mod ingestion;
mod pagination;
mod search;
mod session_manager;
mod snapshot;
mod store_commands;
mod turn_window;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use core_types::extracted::ExtractedData;
use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, SessionDiffChunkRecord, SessionRecord, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::edit_extraction::{
    artifacts_from_extracted_edit, final_diff_from_chunks, EditArtifactContext,
};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const STREAMING_SIMULATOR_UPSERT_LIMIT: usize = 48;

fn backfill_provider_subagent_prompts(events: &mut [SessionEvent]) {
    prompt_backfill::backfill_subagent_prompts_with_resolver(
        events,
        session_providers::subagent_prompt,
    );
}

pub(crate) fn prepare_loaded_events(
    session_id: &str,
    events: Vec<SessionEvent>,
) -> Vec<SessionEvent> {
    let events = event_conversion::dedup_by_call_id(events);
    let mut events = event_conversion::dedup_stream_transcript_chunk_pairs(events);
    event_conversion::backfill_tool_inputs_from_messages(session_id, &mut events);
    event_conversion::backfill_subagent_links(session_id, &mut events);
    backfill_provider_subagent_prompts(&mut events);
    // Compaction boundaries live only in `agent_messages` (never in the
    // event cache) — merge them in so the chat shows the compacted marker.
    event_conversion::merge_compact_boundary_events(session_id, &mut events);
    events
}

use session_persistence::CachedEvent;

use crate::agent_sessions::event_pipeline::derived::compute_derived;
use crate::agent_sessions::event_pipeline::ingestion::prompt_backfill;
use crate::agent_sessions::event_pipeline::payload_compaction::compact_event_for_snapshot;
use crate::agent_sessions::event_pipeline::session_manager::SessionStoreManager;
use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::store::EventStore;
use crate::agent_sessions::event_pipeline::types::{
    SessionEvent, SnapshotDelta, StreamingSnapshot,
};

// ============================================================================
// Managed State
// ============================================================================

/// Multi-session EventStore state.
///
/// Holds one `EventStore` per session id. The "active" session is tracked by
/// `SessionStoreManager` and is the default target when a command is invoked
/// without an explicit `session_id` argument. Any session (active or not) can
/// be read, written, and broadcast independently — this is what enables
/// SubagentBlock chat-in-chat and cross-session replay.
pub struct EventStoreState {
    /// All live per-session stores. Populated lazily: the first write or read
    /// for a session materializes its `EventStore`.
    pub stores: Mutex<HashMap<String, EventStore>>,
    pub session_manager: Mutex<SessionStoreManager>,
    /// Tracks which sessions already have a batched notification pending.
    pub notify_pending: Mutex<HashSet<String>>,
}

impl Default for EventStoreState {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStoreState {
    pub fn new() -> Self {
        Self {
            stores: Mutex::new(HashMap::new()),
            session_manager: Mutex::new(SessionStoreManager::new()),
            notify_pending: Mutex::new(HashSet::new()),
        }
    }

    /// Resolve the target session id for a command.
    ///
    /// - If `explicit` is `Some`, returns it unchanged.
    /// - Otherwise falls back to the active session from `SessionStoreManager`.
    /// - Returns an error string when neither is available (mis-use by caller).
    pub fn resolve_session_id(&self, explicit: Option<String>) -> Result<String, String> {
        if let Some(sid) = explicit {
            return Ok(sid);
        }
        let mgr = self
            .session_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        mgr.active_id()
            .map(|s| s.to_string())
            .ok_or_else(|| "no active session and no explicit sessionId provided".to_string())
    }

    /// Run a closure against the target session's store (creating it if absent).
    ///
    /// Automatically registers the session in `SessionStoreManager` so it
    /// participates in LRU eviction and `active_id` resolution.
    pub fn with_store_mut<F, R>(&self, session_id: &str, f: F) -> R
    where
        F: FnOnce(&mut EventStore) -> R,
    {
        {
            let mut mgr = self
                .session_manager
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            mgr.register(session_id);
        }
        let mut stores = self.stores.lock().unwrap_or_else(|e| e.into_inner());
        let store = stores.entry(session_id.to_string()).or_default();
        f(store)
    }

    /// Run a closure against the target session's store if it exists.
    /// Returns `None` without materializing a store for unknown sessions.
    pub fn with_store_opt<F, R>(&self, session_id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&EventStore) -> R,
    {
        let stores = self.stores.lock().unwrap_or_else(|e| e.into_inner());
        stores.get(session_id).map(f)
    }
}

// ============================================================================
// Notification Helpers
// ============================================================================

const NOTIFY_EVENT_NAME: &str = "es:changed";
const STREAMING_BATCH_MS: u64 = 33;
const ACTION_TYPE_TOOL_CALL: &str = "tool_call";
const ACTION_TYPE_TOOL_RESULT: &str = "tool_result";

/// Tauri `es:changed` payload wrapper. The `sessionId` is always present so
/// frontend listeners can route to the correct per-session subscriber.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEnvelope<T: Serialize> {
    session_id: String,
    #[serde(flatten)]
    snapshot: T,
}

/// Schedule a frontend notification for `session_id`. During streaming,
/// batches at `STREAMING_BATCH_MS` intervals per-session.
pub(crate) fn schedule_notify(app: &AppHandle, state: &EventStoreState, session_id: &str) {
    let streaming = state
        .with_store_opt(session_id, EventStore::is_streaming)
        .unwrap_or(false);

    if streaming {
        let mut pending = state
            .notify_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !pending.insert(session_id.to_string()) {
            return;
        }
        let app_handle = app.clone();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(STREAMING_BATCH_MS)).await;
            let state = app_handle.state::<EventStoreState>();
            {
                let mut pending = state
                    .notify_pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                pending.remove(&sid);
            }
            emit_snapshot(&app_handle, &state, &sid);
        });
    } else {
        emit_snapshot(app, state, session_id);
    }
}

fn emit_snapshot(app: &AppHandle, state: &EventStoreState, session_id: &str) {
    use crate::agent_sessions::event_pipeline::derived::{
        build_simulator_preview_indexes, is_visible_in_chat, is_visible_in_messages,
        is_visible_in_simulator, latest_canvas_preview, sort_if_unsorted, sort_simulator_events,
    };
    use crate::agent_sessions::event_pipeline::types::EventDisplayStatus;

    let mut stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
    let Some(store) = stores.get_mut(session_id) else {
        return;
    };
    if store.is_streaming() {
        let events = store.events();
        let mut chat_events = Vec::with_capacity(events.len() / 2);
        let mut sorted_simulator_events = Vec::with_capacity(events.len() / 2);
        let mut has_running_event = false;

        for e in events.iter() {
            if e.display_status == EventDisplayStatus::Running {
                has_running_event = true;
            }
            if is_visible_in_chat(e) {
                chat_events.push(compact_event_for_snapshot(e));
            }
            if is_visible_in_simulator(e) {
                sorted_simulator_events.push(compact_event_for_snapshot(e));
            }
        }

        sort_if_unsorted(&mut chat_events);
        sort_simulator_events(&mut sorted_simulator_events);
        let simulator_upsert_start = sorted_simulator_events
            .len()
            .saturating_sub(STREAMING_SIMULATOR_UPSERT_LIMIT);
        let simulator_event_upserts = sorted_simulator_events[simulator_upsert_start..].to_vec();
        let preview_indexes = build_simulator_preview_indexes(&sorted_simulator_events);
        let latest_canvas_preview = latest_canvas_preview(events);

        let snapshot = StreamingSnapshot {
            version: store.version(),
            event_count: store.event_count(),
            chat_events,
            sorted_simulator_events: Vec::new(),
            simulator_event_upserts,
            sorted_simulator_event_ids: preview_indexes.sorted_simulator_event_ids,
            event_preview_by_id: preview_indexes.event_preview_by_id,
            created_at_by_id: preview_indexes.created_at_by_id,
            thread_id_by_id: preview_indexes.thread_id_by_id,
            function_name_by_id: preview_indexes.function_name_by_id,
            display_status_by_id: preview_indexes.display_status_by_id,
            display_variant_by_id: preview_indexes.display_variant_by_id,
            last_event: store.last_event().map(compact_event_for_snapshot),
            streaming: true,
            has_running_event,
            latest_canvas_preview,
        };
        let envelope = SnapshotEnvelope {
            session_id: session_id.to_string(),
            snapshot,
        };
        app.emit(NOTIFY_EVENT_NAME, &envelope).ok();
        return;
    }

    if store.should_emit_full_snapshot() {
        let derived = compute_derived(store.events(), store.version());
        let envelope = SnapshotEnvelope {
            session_id: session_id.to_string(),
            snapshot: derived,
        };
        // Only mark the full snapshot as emitted when the emit actually
        // succeeded; otherwise we'd silently drop the baseline and the
        // frontend would never receive a full snapshot for this version.
        if app.emit(NOTIFY_EVENT_NAME, &envelope).is_ok() {
            store.mark_full_snapshot_emitted();
        }
        return;
    }

    let version = store.version();
    let event_count = store.event_count();
    let (base_version, changed_ids, removed_ids) = store.take_delta_tracking();
    let events = store.events();
    let changed_id_set = changed_ids.iter().collect::<std::collections::HashSet<_>>();
    let upserts = events
        .iter()
        .filter(|event| changed_id_set.contains(&event.id))
        .map(compact_event_for_snapshot)
        .collect::<Vec<_>>();
    let event_ids = events
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    let mut chat_event_ids = Vec::with_capacity(events.len() / 2);
    let mut messages_event_ids = Vec::with_capacity(events.len() / 2);
    let mut simulator_preview_events = Vec::with_capacity(events.len() / 2);
    let mut has_running_event = false;
    for event in events {
        if event.display_status == EventDisplayStatus::Running {
            has_running_event = true;
        }
        if is_visible_in_chat(event) {
            chat_event_ids.push(event.id.clone());
        }
        if is_visible_in_messages(event) {
            messages_event_ids.push(event.id.clone());
        }
        if is_visible_in_simulator(event) {
            simulator_preview_events.push(compact_event_for_snapshot(event));
        }
    }
    sort_simulator_events(&mut simulator_preview_events);
    let preview_indexes = build_simulator_preview_indexes(&simulator_preview_events);
    let latest_canvas_preview = latest_canvas_preview(events);
    let chat_event_count = chat_event_ids.len();
    let snapshot = SnapshotDelta {
        version,
        base_version,
        event_count,
        upserts,
        removed_ids,
        event_ids,
        chat_event_ids,
        messages_event_ids,
        sorted_simulator_event_ids: preview_indexes.sorted_simulator_event_ids,
        event_preview_by_id: preview_indexes.event_preview_by_id,
        created_at_by_id: preview_indexes.created_at_by_id,
        thread_id_by_id: preview_indexes.thread_id_by_id,
        function_name_by_id: preview_indexes.function_name_by_id,
        display_status_by_id: preview_indexes.display_status_by_id,
        display_variant_by_id: preview_indexes.display_variant_by_id,
        last_event_id: store.last_event().map(|event| event.id.clone()),
        chat_event_count,
        has_running_event,
        latest_canvas_preview,
        snapshot_delta: true,
    };
    let envelope = SnapshotEnvelope {
        session_id: session_id.to_string(),
        snapshot,
    };
    app.emit(NOTIFY_EVENT_NAME, &envelope).ok();
}

// ============================================================================
// SQLite Write-Through with Retry
// ============================================================================

/// Maximum retry attempts for critical write-throughs (subagent linkage stamps).
///
/// With the process-wide writer mutex installed in `database::db::writer`,
/// most contention is queued in Rust before reaching SQLite. The retry
/// loop here remains as a defense-in-depth against cross-process
/// contention (manual `sqlite3` inspection) and against any rare path
/// that still races at the file-lock layer.
const CRITICAL_WRITE_MAX_RETRIES: u32 = 8;
/// Maximum retry attempts for bulk event writes.
pub(super) const BULK_WRITE_MAX_RETRIES: u32 = 5;
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
pub(super) fn persist_events_with_retry(
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

fn persist_runtime_edit_artifacts_async(session_id: String, events: Vec<(usize, SessionEvent)>) {
    tokio::task::spawn_blocking(move || {
        if let Err(err) = persist_runtime_edit_artifacts(&session_id, events) {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[orgtrack_runtime_artifacts] failed to persist runtime edit artifacts"
            );
        }
    });
}

fn persist_runtime_edit_artifacts(
    session_id: &str,
    events: Vec<(usize, SessionEvent)>,
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }

    let conn = get_connection().map_err(|err| err.to_string())?;
    let store = SqliteRecordStore::new(&conn);
    let session = runtime_artifact_session_record(session_id)?;
    store.upsert_session(&session)?;

    let mut chunks_by_file: HashMap<String, Vec<SessionDiffChunkRecord>> = HashMap::new();
    for (sequence_index, event) in events {
        let Some(ExtractedData::Edit(edit)) = event.extracted.as_ref() else {
            continue;
        };
        let context = EditArtifactContext {
            source: SOURCE_ORGII_RUST_AGENTS.to_string(),
            source_session_id: Some(session.source_session_id.clone()),
            session_id: session.session_id.clone(),
            source_event_id: Some(event.id.clone()),
            turn_id: event.thread_id.clone(),
            sequence_index: sequence_index as i64,
            timestamp: Some(event.created_at.clone()),
            workspace_path: event
                .repo_path
                .clone()
                .or_else(|| session.workspace_path.clone()),
            metadata: session.metadata.clone(),
        };
        let artifacts = artifacts_from_extracted_edit(&context, edit);
        for artifact in &artifacts.edits {
            store.upsert_edit_artifact(artifact)?;
        }
        for chunk in artifacts.chunks {
            chunks_by_file
                .entry(chunk.file_path.clone())
                .or_default()
                .push(chunk.clone());
            store.upsert_diff_chunk(&chunk)?;
        }
    }

    for (file_path, chunks) in chunks_by_file {
        if let Some(final_diff) = final_diff_from_chunks(
            SOURCE_ORGII_RUST_AGENTS,
            &session.session_id,
            &file_path,
            &chunks,
        ) {
            store.upsert_final_diff(&final_diff)?;
        }
    }

    Ok(())
}

fn runtime_artifact_session_record(session_id: &str) -> Result<SessionRecord, String> {
    let Some(record) =
        agent_core::session::persistence::get_session(session_id).map_err(|err| err.to_string())?
    else {
        return Ok(SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: SOURCE_ORGII_RUST_AGENTS.to_string(),
            source_session_id: session_id.to_string(),
            session_id: session_id.to_string(),
            title: session_id.to_string(),
            status: None,
            created_at: None,
            updated_at: None,
            completed_at: None,
            workspace_path: None,
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            metadata: AgentMetadata {
                dispatch_category: Some("rust_agent".to_string()),
                origin: Some(SOURCE_ORGII_RUST_AGENTS.to_string()),
                ..AgentMetadata::default()
            },
        });
    };

    let rust_agent_type = match record.session_type.as_str() {
        agent_core::session::persistence::session_type::DESKTOP => Some("os".to_string()),
        agent_core::session::persistence::session_type::CODING
        | agent_core::session::persistence::session_type::ORG_MEMBER => Some("sde".to_string()),
        agent_core::session::persistence::session_type::GATEWAY => Some("gateway".to_string()),
        _ => Some("custom".to_string()),
    };

    Ok(SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: SOURCE_ORGII_RUST_AGENTS.to_string(),
        source_session_id: record.session_id.clone(),
        session_id: record.session_id,
        title: record.name.clone(),
        status: Some(record.status),
        created_at: Some(record.created_at),
        updated_at: Some(record.updated_at),
        completed_at: None,
        workspace_path: record
            .workspace_path
            .clone()
            .or_else(|| record.worktree_path.clone()),
        branch: record.worktree_branch.or(record.base_branch),
        parent_session_id: record.parent_session_id,
        org_member_id: record.org_member_id,
        metadata: AgentMetadata {
            dispatch_category: Some("rust_agent".to_string()),
            rust_agent_type,
            agent_exec_mode: record.agent_exec_mode,
            model: record.model,
            key_source: Some(record.key_source.to_string()),
            origin: Some(SOURCE_ORGII_RUST_AGENTS.to_string()),
            display_name: Some(record.name),
            ..AgentMetadata::default()
        },
    })
}

/// Push live events into any session's store from Rust-side code (no Tauri
/// command round-trip). Callers: `UnifiedEventHandler` (parent) and
/// `UnifiedSubagentHandler` (child) — both funnel every SessionEvent they
/// produce through this single write path.
///
/// After merging into the in-memory store, non-placeholder events are
/// persisted to the `events` SQLite table via `spawn_blocking` (fire-and-
/// forget). This write-through means interrupted sessions keep their
/// history even if `broadcast_complete` / the 30s frontend timer never run.
pub fn push_events_to_session(
    app: &AppHandle,
    state: &EventStoreState,
    session_id: &str,
    events: Vec<SessionEvent>,
) {
    if events.is_empty() {
        return;
    }

    let result_call_ids: HashSet<String> = events
        .iter()
        .filter(|event| event.action_type == ACTION_TYPE_TOOL_RESULT)
        .filter_map(|event| event.call_id.clone())
        .collect();

    let mut persistable: Vec<_> = events
        .iter()
        .filter(|e| !event_conversion::is_ts_placeholder_id(&e.id))
        .map(event_conversion::session_event_to_cached_event)
        .collect();

    let merged_tool_calls = state.with_store_mut(session_id, |store| {
        store.merge_events(events);
        if result_call_ids.is_empty() {
            return Vec::new();
        }
        store
            .events()
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                event.action_type == ACTION_TYPE_TOOL_CALL
                    && event
                        .call_id
                        .as_ref()
                        .is_some_and(|call_id| result_call_ids.contains(call_id))
            })
            .map(|(sequence_index, event)| (sequence_index, event.clone()))
            .collect::<Vec<_>>()
    });

    let mut impact_events = Vec::new();
    let mut runtime_artifact_events = Vec::new();
    for (sequence_index, event) in merged_tool_calls {
        if event_conversion::is_ts_placeholder_id(&event.id) {
            continue;
        }
        impact_events.push(event.clone());
        if matches!(event.extracted, Some(ExtractedData::Edit(_))) {
            runtime_artifact_events.push((sequence_index, event.clone()));
        }
        persistable.push(event_conversion::session_event_to_cached_event(&event));
    }

    if !impact_events.is_empty() {
        crate::orgtrack::impact_indexer::record_session_events_async(
            session_id.to_string(),
            impact_events,
        );
    }
    if !runtime_artifact_events.is_empty() {
        persist_runtime_edit_artifacts_async(session_id.to_string(), runtime_artifact_events);
    }

    schedule_notify(app, state, session_id);

    if !persistable.is_empty() {
        persist_events_with_retry(
            "push_events",
            session_id.to_string(),
            persistable,
            BULK_WRITE_MAX_RETRIES,
        );
    }
}

/// Merge `merge_args` into the last still-running spawning tool_call event
/// (matching any of `function_names`) and persist the updated event to SQLite.
///
/// This is the write-through counterpart of `EventStore::update_spawning_tool_args`.
/// In-memory patches that are never written back (e.g. stamping
/// `subagentSessionId` onto the parent's `agent` tool_call event at spawn time)
/// would otherwise be lost on session reload: the SQLite copy still has the
/// pre-patch args, so re-opened sessions would show subagent blocks with no
/// child-session trajectory. Callers that need the patch to survive reload
/// (subagent linkage, elapsed-time stamping) should use this helper instead
/// of calling `update_spawning_tool_args` directly.
///
/// Returns the event id of the patched event when one was found.
pub fn update_spawning_tool_args_with_persist(
    app: &AppHandle,
    state: &EventStoreState,
    session_id: &str,
    function_names: &[&str],
    merge_args: serde_json::Value,
) -> Option<String> {
    let updated = state.with_store_mut(session_id, |store| {
        let id = store.update_spawning_tool_args(function_names, merge_args)?;
        store.get_by_id(&id).cloned().map(|event| (id, event))
    });

    let (event_id, event) = updated?;

    schedule_notify(app, state, session_id);

    if !event_conversion::is_ts_placeholder_id(&event.id) {
        let cached = event_conversion::session_event_to_cached_event(&event);
        persist_events_with_retry(
            "spawning-tool",
            session_id.to_string(),
            vec![cached],
            CRITICAL_WRITE_MAX_RETRIES,
        );
    }

    Some(event_id)
}

/// Like `update_spawning_tool_args_with_persist` but targets a specific
/// tool_call event by its LLM-assigned `call_id` instead of the ambiguous
/// "last running spawning tool" heuristic.
///
/// Required for parallel `background: true` subagent launches so each
/// handler stamps its own parent event.
pub fn update_tool_args_by_call_id_with_persist(
    app: &AppHandle,
    state: &EventStoreState,
    session_id: &str,
    call_id: &str,
    merge_args: serde_json::Value,
) -> Option<String> {
    let updated = state.with_store_mut(session_id, |store| {
        let id = store.update_tool_args_by_call_id(call_id, merge_args)?;
        store.get_by_id(&id).cloned().map(|event| (id, event))
    });

    let (event_id, event) = updated?;

    schedule_notify(app, state, session_id);

    if !event_conversion::is_ts_placeholder_id(&event.id) {
        let cached = event_conversion::session_event_to_cached_event(&event);
        persist_events_with_retry(
            "call-id",
            session_id.to_string(),
            vec![cached],
            CRITICAL_WRITE_MAX_RETRIES,
        );
    }

    Some(event_id)
}

#[cfg(test)]
mod runtime_artifact_tests {
    use super::*;
    use core_types::extracted::ExtractedEditData;
    use orgtrack_core::edit_extraction::artifacts_from_extracted_edit;
    use orgtrack_core::repo_sync::paths::record_id;

    #[test]
    fn runtime_projection_uses_backfill_record_id_shape() {
        let edit = ExtractedEditData {
            file_path: "src/main.rs".to_string(),
            file_name: "main.rs".to_string(),
            language: "rust".to_string(),
            content: None,
            line_count: None,
            old_content: Some("fn main() {}\n".to_string()),
            new_content: Some("fn main() { println!(\"hi\"); }\n".to_string()),
            diff: None,
            old_start_line: Some(1),
            new_start_line: Some(1),
            lines_added: Some(1),
            lines_removed: Some(1),
            is_deleted: false,
            apply_patch_segments: Vec::new(),
        };
        let context = EditArtifactContext {
            source: SOURCE_ORGII_RUST_AGENTS.to_string(),
            source_session_id: Some("sdeagent-1".to_string()),
            session_id: "sdeagent-1".to_string(),
            source_event_id: Some("tool-call-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            sequence_index: 7,
            timestamp: Some("2026-06-17T00:00:00Z".to_string()),
            workspace_path: Some("/tmp/repo".to_string()),
            metadata: AgentMetadata::default(),
        };

        let artifacts = artifacts_from_extracted_edit(&context, &edit);

        assert_eq!(artifacts.edits.len(), 1);
        assert_eq!(artifacts.chunks.len(), 1);
        assert_eq!(
            artifacts.edits[0].record_id,
            record_id(&[
                "edit",
                SOURCE_ORGII_RUST_AGENTS,
                "sdeagent-1",
                "tool-call-1",
                "7",
                "0",
                "src/main.rs",
            ])
        );
        assert_eq!(
            artifacts.chunks[0].record_id,
            record_id(&[
                "diff_chunk",
                SOURCE_ORGII_RUST_AGENTS,
                "sdeagent-1",
                "tool-call-1",
                "7",
                "0",
                "src/main.rs",
            ])
        );
    }
}

// ============================================================================
// Re-exports
//
// Re-export all Tauri commands from submodules. Using `pub use *` ensures the
// `#[tauri::command]` macro-generated `__cmd__` functions are also exported.
// ============================================================================

// Store commands
pub use store_commands::*;

// Session manager commands
pub use session_manager::*;

// Snapshot commands
pub use snapshot::*;

// Cache bridge commands
pub use cache_bridge::*;

// Event conversion helpers (CachedEvent <-> SessionEvent, dedup, backfill, filtering)
pub use event_conversion::*;

// Turn window commands
pub use turn_window::*;

// Analytics commands
pub use analytics::*;

// Pagination commands
pub use pagination::*;

// Batch update commands
pub use batch_update::*;

// Ingestion commands
pub use ingestion::*;

// Extractor commands
pub use extractors::*;

// Search commands
pub use search::*;

// History commands
pub use history::*;
