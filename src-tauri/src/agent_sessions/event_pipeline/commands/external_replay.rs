//! Thin Tauri bridge for imported/managed-CLI bounded replay.
//!
//! Source indexing stays in `orgtrack_core`; this module owns the only
//! dependency on the app EventStore.  Native SDE Agent cache/set/merge paths
//! are untouched.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use agent_core::tools::impls::coding::exec::{
    external_replay::external_shell_inline_segments,
    shell_replay::{
        ShellReplayFrame, ShellReplayRange, ShellReplayStream, SHELL_REPLAY_FORMAT_VERSION,
        SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_PREVIEW_BYTES, SHELL_REPLAY_RANGE_MAX_BYTES,
    },
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use core_types::activity::ActivityChunk;
use core_types::session_event::{
    PayloadRefEncoding, ShellReplayBookmark, ShellReplayRef, ShellReplayState, ShellReplayStatus,
};
use flate2::write::GzEncoder;
use flate2::Compression;
use orgtrack_core::sources::imported_history::replay::{
    self, ImportedHistorySourceId, ReplayChunkDelta, ReplayChunkWindow, ReplayCursor,
    ReplayIndexedChunk, ReplayLimits, ReplayPayloadBodyProjection, ReplayPayloadDescriptor,
    ReplayPayloadEncoding, ReplayPayloadKind, ReplayPayloadRange, ReplayStats, ReplayTurnHeader,
};
use rusqlite::{params, Connection, DatabaseName, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::agent_sessions::event_pipeline::ingestion::{self, types::RawActivityChunk};
use crate::agent_sessions::event_pipeline::store::EventStore;
use crate::agent_sessions::event_pipeline::types::{EventSource, PayloadRef, SessionEvent};

use super::{
    event_conversion::cached_event_to_session_event,
    external_replay_cache::schedule_replay_cache_prune, external_replay_watcher, schedule_notify,
    EventStoreState,
};

pub const MANAGED_CLI_REPLAY_SOURCE_ID: &str = "managed_cli";
/// ORGII-owned collaboration snapshots persisted under `imported-session-*`.
/// This is intentionally outside `ImportedHistorySourceId`: it is not a
/// vendor adapter and must not change the exhaustive 15-source registry.
pub const COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID: &str = "collaboration_snapshot";
const COLLABORATION_SNAPSHOT_SESSION_PREFIX: &str = "imported-session-";
const COLLABORATION_SNAPSHOT_FORK_PREFIX: &str = "agentsession-";
const COLLABORATION_SNAPSHOT_DRIVER_VERSION: u32 = 1;
// One replay response is capped at 4 MiB. Keep a separately bounded resident
// budget for the latest turn plus the selected older turn and its ±1 prefetch
// neighbours; otherwise the newest-suffix cap can evict the page immediately
// after `read_window` applies it.
const EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS: usize = 80;
const EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16: usize = 1_200;
const EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES: usize = 4 * 1024 * 1024;

// Readerless managed-CLI rows live in ORGII's SQLite database, but their
// args/result columns can be arbitrarily large. Keep the database-to-Rust
// boundary independently bounded from the replay IPC budget: small JSON can
// still use the exact legacy serde path, while large JSON is projected by
// SQLite into compact nodes and payload locators.
const LEGACY_INLINE_JSON_MAX_BYTES: usize = 64 * 1024;
const LEGACY_JSON_PROJECTION_MAX_BYTES: usize = 64 * 1024;
const LEGACY_JSON_PROJECTION_MAX_NODES: usize = 256;
const LEGACY_JSON_KEY_MAX_BYTES: usize = 1024;
const LEGACY_UTF8_BOUNDARY_BYTES: usize = 4;

fn with_sessions_replay_writer<T>(
    context: &str,
    operation: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection()
            .map_err(|error| format!("open {context} DB: {error}"))?;
        operation(&mut conn)
    })
}

#[cfg(test)]
static LEGACY_MAX_DB_JSON_FIELD_BYTES: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static EXTERNAL_SHELL_MANIFEST_DB_PROBES: AtomicUsize = AtomicUsize::new(0);

#[cfg(debug_assertions)]
const TEST_REPLAY_LIMITS: ReplayLimits = ReplayLimits {
    max_turns: 10,
    max_events: 200,
    max_ipc_bytes: 4 * 1024 * 1024,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayWindow {
    pub cursor: ReplayCursor,
    pub events: Vec<SessionEvent>,
    /// Smallest source/index sequence scanned into this page. This differs
    /// from the first turn header when a single large turn spans pages and
    /// remains present even if normalization filters every scanned chunk.
    pub window_start_sequence: Option<i64>,
    pub turn_headers: Vec<ReplayTurnHeader>,
    pub total_turn_count: u64,
    pub total_event_count: u64,
    pub has_older: bool,
    pub stats: ReplayStats,
    /// False until the backend watcher service is attached.  Frontends must
    /// keep their visible/active bounded polling fallback while this is false.
    pub watcher_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayDelta {
    pub cursor: ReplayCursor,
    pub events: Vec<SessionEvent>,
    pub removed_event_ids: Vec<String>,
    pub reset_required: bool,
    pub stats: ReplayStats,
    pub watcher_available: bool,
}

/// Compact, prompt-ready imported-history handoff. Rust folds the source
/// pages directly so the renderer never receives a transient SessionEvent[]
/// transcript merely to create a new ORGII session.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayHandoff {
    pub items: Vec<String>,
    pub generation: String,
    pub scanned_bytes: u64,
    pub scanned_events: u64,
}

/// Debug HTTP probes use the same source resolution and bounded storage
/// drivers as the renderer, without requiring a Tauri `AppHandle`/`State`.
/// The helper deliberately does not apply to EventStore: callers only inspect
/// the returned window and can never resurrect the removed full-history IPC.
#[cfg(debug_assertions)]
pub(crate) async fn test_open_managed_replay_window(
    session_id: String,
) -> Result<ExternalReplayWindow, String> {
    let display_session_id = session_id.clone();
    tokio::task::spawn_blocking(move || {
        let window = match resolve_target(MANAGED_CLI_REPLAY_SOURCE_ID, &session_id)? {
            ResolvedTarget::Imported {
                source,
                imported_session_id,
            } => with_sessions_replay_writer("replay index", |conn| {
                replay::open_window(conn, source, &imported_session_id, TEST_REPLAY_LIMITS)
                    .map(BackendWindow::Imported)
            })?,
            ResolvedTarget::CollaborationSnapshot => {
                BackendWindow::CollaborationSnapshot(collaboration_snapshot_read_window_from_conn(
                    &database::db::get_connection()
                        .map_err(|err| format!("open collaboration replay DB: {err}"))?,
                    &session_id,
                    None,
                    None,
                    None,
                    TEST_REPLAY_LIMITS,
                )?)
            }
            ResolvedTarget::LegacyChunks => {
                BackendWindow::Legacy(legacy_open_window(&session_id, TEST_REPLAY_LIMITS)?)
            }
            ResolvedTarget::NotReady => BackendWindow::NotReady,
        };
        let mut response = match window {
            BackendWindow::Imported(window) | BackendWindow::Legacy(window) => {
                normalize_window(window, &display_session_id)
            }
            BackendWindow::CollaborationSnapshot(window) => window,
            BackendWindow::NotReady => {
                not_ready_window(MANAGED_CLI_REPLAY_SOURCE_ID, &display_session_id)
            }
        };
        remap_cursor(
            &mut response.cursor,
            MANAGED_CLI_REPLAY_SOURCE_ID,
            &display_session_id,
        );
        response.events = persist_shell_replays_bounded(
            MANAGED_CLI_REPLAY_SOURCE_ID,
            &display_session_id,
            &response.cursor.generation,
            response.cursor.revision,
            response.events,
        )?;
        finalize_window_wire_budget(&mut response, TEST_REPLAY_LIMITS.max_ipc_bytes)?;
        Ok(response)
    })
    .await
    .map_err(|err| format!("join test replay open task: {err}"))?
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplayExportFormat {
    Json,
    Markdown,
    OrgiiSessionJson,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgiiSessionExportEnvelope {
    pub exported_at: String,
    pub session: serde_json::Value,
    pub original_category: String,
    #[serde(default)]
    pub specs: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayExportResult {
    pub destination_path: String,
    pub bytes_written: u64,
    pub event_count: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayCloudManifest {
    pub token: String,
    pub generation: String,
    pub total_count: u64,
    pub frozen_event_count: u64,
    pub tail_event_count: u64,
    pub frozen_chain_hash: String,
    pub tail_hash: Option<String>,
}

/// One already encoded cloud segment. Rust owns canonical serialization,
/// hashing and gzip so the renderer never materializes a full transcript (or
/// a large event) merely to forward it to the cloud RPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayCloudSegment {
    pub payload_gz: String,
    pub event_count: u64,
    pub segment_hash: String,
    /// Exact JSON bytes of this object after the caller adds a worst-case seq.
    /// Every emitted segment is therefore within the actual RPC wire budget,
    /// not merely an approximate pre-gzip event-size budget.
    pub wire_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayCloudBatch {
    pub segments: Vec<ExternalReplayCloudSegment>,
    pub start_event_index: u64,
    pub next_event_index: u64,
    /// Physical frozen-row cursor. One logical V2 event can span many rows,
    /// including zero-event continuation rows, so event indexes alone cannot
    /// advance a bounded IPC batch.
    pub start_segment_index: u64,
    pub next_segment_index: u64,
    pub eof: bool,
    pub serialized_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReplayCloudPrefixHash {
    pub event_count: u64,
    pub frozen_chain_hash: String,
}

#[derive(Debug)]
struct CloudSpoolEntry {
    path: PathBuf,
    manifest: ExternalReplayCloudManifest,
    last_used: Instant,
    /// One owner lease is created by `prepare`; each in-flight read adds a
    /// short-lived lease. The spool file is never removed while a reader owns
    /// it, even if the renderer releases the token concurrently.
    lease_count: u64,
    owner_released: bool,
}

#[derive(Debug)]
struct CloudSpoolReadLease {
    token: String,
    path: PathBuf,
    manifest: ExternalReplayCloudManifest,
}

impl Drop for CloudSpoolReadLease {
    fn drop(&mut self) {
        release_cloud_spool_read_lease(&self.token);
    }
}

enum ResolvedTarget {
    Imported {
        source: ImportedHistorySourceId,
        imported_session_id: String,
    },
    CollaborationSnapshot,
    LegacyChunks,
    NotReady,
}

#[tauri::command]
pub async fn external_replay_open_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    let request_epoch = begin_replay_request(&session_id, episode_id, true)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let watcher_app = app.clone();
    let watcher_source_id = source_id.clone();
    let watcher_session_id = session_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        // Register before reading the initial snapshot so an append/rewrite in
        // the indexing window cannot fall into a watcher-registration gap.
        // Generation is filled in after the bounded open commits. Re-check
        // the request immediately around acquisition: release can race this
        // blocking task before it starts, and stale A1 work must not recreate
        // a watcher after A→B→A has moved to a newer episode.
        if is_current_replay_request(&watcher_session_id, episode_id, request_epoch) {
            ensure_replay_watch(
                &watcher_app,
                &watcher_source_id,
                &watcher_session_id,
                episode_id,
                None,
            );
            if !is_current_replay_request(&watcher_session_id, episode_id, request_epoch) {
                release_replay_watch_if_stale_episode(&watcher_session_id, episode_id);
            }
        }
        let target = resolve_target(&source_id, &session_id)?;
        match target {
            ResolvedTarget::Imported {
                source,
                imported_session_id,
            } => with_sessions_replay_writer("replay index", |conn| {
                replay::open_window(conn, source, &imported_session_id, requested_limits)
                    .map(BackendWindow::Imported)
            }),
            ResolvedTarget::CollaborationSnapshot => {
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_read_window_from_conn(
                    &conn,
                    &session_id,
                    None,
                    None,
                    None,
                    requested_limits,
                )
                .map(BackendWindow::CollaborationSnapshot)
            }
            ResolvedTarget::LegacyChunks => {
                legacy_open_window(&session_id, requested_limits).map(BackendWindow::Legacy)
            }
            ResolvedTarget::NotReady => Ok(BackendWindow::NotReady),
        }
    })
    .await
    .map_err(|err| format!("join replay open task: {err}"))??;

    match window {
        BackendWindow::NotReady => {
            let mut response = not_ready_window(&requested_source_id, &display_session_id);
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            Ok(response)
        }
        BackendWindow::Imported(window) => {
            let mut response = normalize_window(window, &display_session_id);
            remap_cursor(
                &mut response.cursor,
                &requested_source_id,
                &display_session_id,
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            let generation = response.cursor.generation.clone();
            let revision = response.cursor.revision;
            persist_shell_replays_for_delivery(
                &requested_source_id,
                &display_session_id,
                &generation,
                revision,
                &mut response.events,
            )
            .await?;
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            // Canonical open is authoritative for external/managed history.
            // Keep a synthesized managed user bubble only until the native
            // transcript provides its real user row.
            let has_real_user = response
                .events
                .iter()
                .any(|event| event.source == EventSource::User);
            let synthetic = if has_real_user {
                None
            } else {
                state
                    .with_store_opt(&display_session_id, |store| {
                        store
                            .events()
                            .iter()
                            .find(|event| {
                                event.source == EventSource::User
                                    && event.id.contains("synthesized")
                            })
                            .cloned()
                    })
                    .flatten()
            };
            if let Some(synthetic) = synthetic {
                response.events.insert(0, synthetic);
            }
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            response.watcher_available = ensure_replay_watch(
                &app,
                &requested_source_id,
                &display_session_id,
                episode_id,
                Some(&response.cursor.generation),
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            // `false` is one byte larger than `true`; watcher attachment can
            // therefore never invalidate the already-checked wire budget.
            refresh_window_wire_bytes(&mut response)?;
            state.with_store_mut(&display_session_id, |store| {
                store.set_external_replay_window(response.events.clone());
            });
            state.cap_external_replay_store(
                &display_session_id,
                super::BOUNDED_REPLAY_STORE_MAX_BYTES,
            )?;
            schedule_replay_cache_prune();
            schedule_notify(&app, &state, &display_session_id);
            Ok(response)
        }
        BackendWindow::CollaborationSnapshot(mut response) => {
            remap_cursor(
                &mut response.cursor,
                &requested_source_id,
                &display_session_id,
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            let generation = response.cursor.generation.clone();
            let revision = response.cursor.revision;
            persist_shell_replays_for_delivery(
                &requested_source_id,
                &display_session_id,
                &generation,
                revision,
                &mut response.events,
            )
            .await?;
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            response.watcher_available = ensure_replay_watch(
                &app,
                &requested_source_id,
                &display_session_id,
                episode_id,
                Some(&response.cursor.generation),
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            refresh_window_wire_bytes(&mut response)?;
            state.with_store_mut(&display_session_id, |store| {
                store.set_external_replay_window(response.events.clone())
            });
            state.cap_external_replay_store(
                &display_session_id,
                super::BOUNDED_REPLAY_STORE_MAX_BYTES,
            )?;
            schedule_replay_cache_prune();
            schedule_notify(&app, &state, &display_session_id);
            Ok(response)
        }
        BackendWindow::Legacy(window) => {
            let mut response = normalize_window(window, &display_session_id);
            remap_cursor(
                &mut response.cursor,
                &requested_source_id,
                &display_session_id,
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            let generation = response.cursor.generation.clone();
            let revision = response.cursor.revision;
            persist_shell_replays_for_delivery(
                &requested_source_id,
                &display_session_id,
                &generation,
                revision,
                &mut response.events,
            )
            .await?;
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                return Ok(response);
            }
            response.watcher_available = ensure_replay_watch(
                &app,
                &requested_source_id,
                &display_session_id,
                episode_id,
                Some(&response.cursor.generation),
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            refresh_window_wire_bytes(&mut response)?;
            state.with_store_mut(&display_session_id, |store| {
                store.set_external_replay_window(response.events.clone())
            });
            state.cap_external_replay_store(
                &display_session_id,
                super::BOUNDED_REPLAY_STORE_MAX_BYTES,
            )?;
            schedule_replay_cache_prune();
            schedule_notify(&app, &state, &display_session_id);
            Ok(response)
        }
    }
}

#[tauri::command]
pub async fn external_replay_poll_delta(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    cursor: ReplayCursor,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayDelta, String> {
    let request_epoch = begin_replay_request(&session_id, episode_id, false)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    validate_display_cursor(&source_id, &session_id, &cursor)?;
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let delta =
        tokio::task::spawn_blocking(move || match resolve_target(&source_id, &session_id)? {
            ResolvedTarget::Imported {
                source,
                imported_session_id,
            } => {
                let mut underlying_cursor = cursor;
                underlying_cursor.source_id = source.as_str().to_string();
                underlying_cursor.session_id = imported_session_id.clone();
                with_sessions_replay_writer("replay index", |conn| {
                    replay::poll_delta(
                        conn,
                        source,
                        &imported_session_id,
                        &underlying_cursor,
                        requested_limits,
                    )
                    .map(BackendDelta::Imported)
                })
            }
            ResolvedTarget::CollaborationSnapshot => {
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_poll_delta_from_conn(
                    &conn,
                    &session_id,
                    &cursor,
                    requested_limits,
                )
                .map(BackendDelta::CollaborationSnapshot)
            }
            ResolvedTarget::LegacyChunks => {
                legacy_poll_delta(&session_id, &cursor, requested_limits).map(BackendDelta::Legacy)
            }
            ResolvedTarget::NotReady => Ok(BackendDelta::NotReady),
        })
        .await
        .map_err(|err| format!("join replay poll task: {err}"))??;

    if matches!(delta, BackendDelta::NotReady) {
        let mut response = not_ready_delta(&requested_source_id, &display_session_id);
        finalize_delta_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }
    let mut response = match delta {
        BackendDelta::Imported(delta) | BackendDelta::Legacy(delta) => {
            normalize_delta(delta, &display_session_id)
        }
        BackendDelta::CollaborationSnapshot(delta) => delta,
        BackendDelta::NotReady => unreachable!(),
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        return Ok(response);
    }
    let generation = response.cursor.generation.clone();
    let revision = response.cursor.revision;
    persist_shell_replays_for_delivery(
        &requested_source_id,
        &display_session_id,
        &generation,
        revision,
        &mut response.events,
    )
    .await?;
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        return Ok(response);
    }
    // Preflight with the largest possible stats and the longer `false`
    // watcher value. No EventStore mutation or cursor delivery happens if
    // the final normalized wire response exceeds the caller's hard budget.
    response.stats.upserted_events = response.events.len() as u64;
    response.stats.removed_events = response.removed_event_ids.len() as u64;
    finalize_delta_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        return Ok(response);
    }
    response.watcher_available = ensure_replay_watch(
        &app,
        &requested_source_id,
        &display_session_id,
        episode_id,
        Some(&response.cursor.generation),
    );
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        release_replay_watch_if_stale_episode(&display_session_id, episode_id);
        return Ok(response);
    }
    if response.reset_required {
        state.with_store_mut(&display_session_id, |store| {
            apply_external_replay_delta(store, &response)
        });
        response.stats.upserted_events = response.events.len() as u64;
        response.stats.removed_events = 0;
        state.cap_external_replay_store(
            &display_session_id,
            super::BOUNDED_REPLAY_STORE_MAX_BYTES,
        )?;
        schedule_notify(&app, &state, &display_session_id);
    } else {
        let applied = state.with_store_mut(&display_session_id, |store| {
            apply_external_replay_delta(store, &response)
        });
        response.stats.upserted_events = applied.upserted;
        response.stats.removed_events = applied.removed;
        state.cap_external_replay_store(
            &display_session_id,
            super::BOUNDED_REPLAY_STORE_MAX_BYTES,
        )?;
        if applied.changed {
            schedule_notify(&app, &state, &display_session_id);
        }
    }
    // Actual no-op filtering can only reduce the decimal stats width, and
    // `watcherAvailable=true` is shorter than the preflight `false` value.
    refresh_delta_wire_bytes(&mut response)?;
    if response.reset_required
        || response.stats.parsed_bytes > 0
        || response.stats.parsed_rows > 0
        || response.stats.upserted_events > 0
        || response.stats.removed_events > 0
    {
        schedule_replay_cache_prune();
    }
    Ok(response)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn external_replay_read_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    before_sequence: Option<i64>,
    turn_id: Option<String>,
    turn_index: Option<i64>,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    let request_epoch = begin_replay_request(&session_id, episode_id, false)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        let locator_count = usize::from(before_sequence.is_some())
            + usize::from(turn_id.is_some())
            + usize::from(turn_index.is_some());
        if locator_count > 1 {
            return Err("beforeSequence, turnId and turnIndex are mutually exclusive".to_string());
        }
        match resolve_target(&source_id, &session_id)? {
            ResolvedTarget::Imported {
                source,
                imported_session_id,
            } => with_sessions_replay_writer("replay index", |conn| {
                if let Some(turn_id) = turn_id.as_deref() {
                    replay::read_turn_window(
                        conn,
                        source,
                        &imported_session_id,
                        turn_id,
                        requested_limits,
                    )
                } else if let Some(turn_index) = turn_index {
                    replay::read_turn_window_at_index(
                        conn,
                        source,
                        &imported_session_id,
                        turn_index,
                        requested_limits,
                    )
                } else {
                    replay::read_window(
                        conn,
                        source,
                        &imported_session_id,
                        before_sequence,
                        requested_limits,
                    )
                }
                .map(BackendWindow::Imported)
            }),
            ResolvedTarget::CollaborationSnapshot => {
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_read_window_from_conn(
                    &conn,
                    &session_id,
                    before_sequence,
                    turn_id.as_deref(),
                    turn_index,
                    requested_limits,
                )
                .map(BackendWindow::CollaborationSnapshot)
            }
            ResolvedTarget::LegacyChunks => legacy_read_window(
                &session_id,
                before_sequence,
                turn_id.as_deref(),
                turn_index,
                requested_limits,
            )
            .map(BackendWindow::Legacy),
            ResolvedTarget::NotReady => Ok(BackendWindow::NotReady),
        }
    })
    .await
    .map_err(|err| format!("join replay window task: {err}"))??;
    if matches!(window, BackendWindow::NotReady) {
        let mut response = not_ready_window(&requested_source_id, &display_session_id);
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }
    let mut response = match window {
        BackendWindow::Imported(window) | BackendWindow::Legacy(window) => {
            normalize_window(window, &display_session_id)
        }
        BackendWindow::CollaborationSnapshot(window) => window,
        BackendWindow::NotReady => unreachable!(),
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        return Ok(response);
    }
    let generation = response.cursor.generation.clone();
    let revision = response.cursor.revision;
    persist_shell_replays_for_delivery(
        &requested_source_id,
        &display_session_id,
        &generation,
        revision,
        &mut response.events,
    )
    .await?;
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        return Ok(response);
    }
    response.watcher_available = external_replay_watcher::is_available(&display_session_id);
    finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !is_current_replay_request(&display_session_id, episode_id, request_epoch) {
        return Ok(response);
    }
    state.with_store_mut(&display_session_id, |store| {
        store.merge_round_window_events(response.events.clone())
    });
    state.cap_external_replay_store(&display_session_id, super::BOUNDED_REPLAY_STORE_MAX_BYTES)?;
    if !response.events.is_empty() {
        schedule_notify(&app, &state, &display_session_id);
    }
    schedule_replay_cache_prune();
    Ok(response)
}

/// Side-effect-free bounded replay query for hover cards, export previews,
/// raw transcript virtualization and other read-only consumers. It may advance
/// the persistent compact source index, but it never acquires a foreground
/// watcher, touches EventStore, schedules `es:changed`, or participates in a
/// delivery request epoch.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn external_replay_query_window(
    source_id: String,
    session_id: String,
    before_sequence: Option<i64>,
    turn_id: Option<String>,
    turn_index: Option<i64>,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        load_replay_query_window(
            &source_id,
            &session_id,
            before_sequence,
            turn_id.as_deref(),
            turn_index,
            requested_limits,
        )
    })
    .await
    .map_err(|err| format!("join pure replay query task: {err}"))??;

    let mut response = match window {
        BackendWindow::Imported(window) | BackendWindow::Legacy(window) => {
            normalize_window(window, &display_session_id)
        }
        BackendWindow::CollaborationSnapshot(window) => window,
        BackendWindow::NotReady => not_ready_window(&requested_source_id, &display_session_id),
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );
    finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !response.stats.not_ready {
        schedule_replay_cache_prune();
    }
    Ok(response)
}

/// Build the last usable imported-history handoff items entirely in Rust.
///
/// Like `external_replay_query_window`, this may bring ORGII's rebuildable
/// compact index up to date. It intentionally has no AppHandle, EventStore
/// State, episode id, watcher lease, notification, or request-epoch side
/// effect. Cross-page reads are pinned to one source generation and revision.
#[tauri::command]
pub async fn external_replay_handoff(
    source_id: String,
    session_id: String,
    source_name: String,
) -> Result<ExternalReplayHandoff, String> {
    let handoff = tokio::task::spawn_blocking(move || {
        load_external_replay_handoff(&source_id, &session_id, &source_name)
    })
    .await
    .map_err(|err| format!("join pure replay handoff task: {err}"))??;
    schedule_replay_cache_prune();
    Ok(handoff)
}

/// Prewarm one bounded external-history window and publish it directly into
/// EventStore. Source parsing, normalization, Shell replay persistence and the
/// authoritative replace all remain in Rust; the renderer receives the window
/// only once and never sends its `SessionEvent[]` back over IPC.
///
/// Prewarm episodes are deliberately independent from foreground watcher
/// episodes. A session switch/close clears both registries, while a newer
/// prewarm episode invalidates any late completion from an earlier A visit.
#[tauri::command]
pub async fn external_replay_prewarm_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    // This cheap identity check runs before registering an episode, so a
    // native SDE session can neither call replay nor leave retained guard
    // state, even if a caller spoofs an external source id.
    validate_prewarm_target_identity(&source_id, &session_id)?;
    let request_epoch = begin_prewarm_request(&session_id, episode_id)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        load_replay_query_window(&source_id, &session_id, None, None, None, requested_limits)
    })
    .await
    .map_err(|err| format!("join replay prewarm task: {err}"))??;

    let mut response = match window {
        BackendWindow::Imported(window) | BackendWindow::Legacy(window) => {
            normalize_window(window, &display_session_id)
        }
        BackendWindow::CollaborationSnapshot(window) => window,
        BackendWindow::NotReady => not_ready_window(&requested_source_id, &display_session_id),
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );

    if response.stats.not_ready {
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }
    if !is_current_prewarm_request(&display_session_id, episode_id, request_epoch) {
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }

    let generation = response.cursor.generation.clone();
    let revision = response.cursor.revision;
    persist_shell_replays_for_delivery(
        &requested_source_id,
        &display_session_id,
        &generation,
        revision,
        &mut response.events,
    )
    .await?;
    if !is_current_prewarm_request(&display_session_id, episode_id, request_epoch) {
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }

    // Prewarming is demand-driven and never owns a foreground watcher.
    response.watcher_available = false;
    finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !apply_prewarm_window_if_current(
        &state,
        &display_session_id,
        episode_id,
        request_epoch,
        &response.events,
    ) {
        return Ok(response);
    }
    state.cap_external_replay_store(&display_session_id, super::BOUNDED_REPLAY_STORE_MAX_BYTES)?;
    if is_current_prewarm_request(&display_session_id, episode_id, request_epoch) {
        schedule_notify(&app, &state, &display_session_id);
    }
    schedule_replay_cache_prune();
    Ok(response)
}

fn validate_query_apply_version(
    expected_generation: &str,
    expected_revision: u64,
    current_generation: &str,
    current_revision: u64,
) -> Result<(), String> {
    if current_generation != expected_generation || current_revision != expected_revision {
        return Err(format!(
            "stale external replay query {expected_generation}@{expected_revision}; current compact index is {current_generation}@{current_revision}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn external_replay_release(
    source_id: String,
    session_id: String,
    episode_id: u64,
) -> Result<(), String> {
    // Validate identity so an accidental native-SDE call cannot release an
    // unrelated external foreground lease with a colliding session id.
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID {
            return Err(format!(
                "collaboration snapshot replay release requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID}"
            ));
        }
        validate_collaboration_snapshot_session_id(&session_id)?;
    } else if session_id.starts_with("cliagent-") {
        if source_id != MANAGED_CLI_REPLAY_SOURCE_ID {
            return Err(format!(
                "managed replay release requires sourceId={MANAGED_CLI_REPLAY_SOURCE_ID}"
            ));
        }
    } else {
        let source = ImportedHistorySourceId::parse(&source_id)?;
        source.validate_session_id(&session_id)?;
    }
    release_session_runtime_if_episode(&session_id, episode_id);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn external_replay_read_payload_range(
    source_id: String,
    session_id: String,
    generation: String,
    event_id: String,
    field_path: String,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<ReplayPayloadRange, String> {
    tokio::task::spawn_blocking(move || {
        match resolve_secondary_consumer_target(&source_id, &session_id)? {
            ResolvedTarget::Imported {
                source,
                imported_session_id,
            } => {
                let mut conn = database::db::get_connection()
                    .map_err(|err| format!("open replay index DB: {err}"))?;
                replay::read_payload_range(
                    &mut conn,
                    source,
                    &imported_session_id,
                    &generation,
                    &event_id,
                    &field_path,
                    offset,
                    max_bytes,
                )
            }
            ResolvedTarget::CollaborationSnapshot => {
                let max_bytes = max_bytes
                    .unwrap_or(replay::DEFAULT_PAYLOAD_RANGE_BYTES)
                    .clamp(1, replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_payload_range_from_conn(
                    &conn,
                    &session_id,
                    &generation,
                    &event_id,
                    &field_path,
                    offset,
                    max_bytes,
                )
            }
            ResolvedTarget::LegacyChunks => {
                legacy_payload_range(&session_id, &event_id, &field_path, offset, max_bytes)
            }
            ResolvedTarget::NotReady => Err("Managed native transcript is not bound yet".into()),
        }
    })
    .await
    .map_err(|err| format!("join replay payload task: {err}"))?
}

/// Stream the current generation directly to a destination file. Deferred
/// payloads are spliced in by bounded range reads; neither Rust nor JS builds
/// a complete transcript (or a complete large event) in memory.
#[tauri::command]
pub async fn external_replay_stream_export(
    source_id: String,
    session_id: String,
    destination_path: String,
    format: ReplayExportFormat,
    orgii_envelope: Option<OrgiiSessionExportEnvelope>,
) -> Result<ReplayExportResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        stream_replay_export(
            &source_id,
            &session_id,
            &destination_path,
            format,
            orgii_envelope.as_ref(),
        )
    })
    .await
    .map_err(|err| format!("join replay export task: {err}"))??;
    schedule_replay_cache_prune();
    Ok(result)
}

const STREAM_BATCH_MAX_EVENTS: usize = 200;
const STREAM_BATCH_MAX_BYTES: usize = 256 * 1024;
const EXPORT_PAYLOAD_RANGE_BYTES: usize = 64 * 1024;
const EXPORT_WRITER_BUFFER_BYTES: usize = 256 * 1024;
/// The complete serialized segment object, including base64 gzip and a
/// worst-case sequence number, must fit this limit.
const CLOUD_SEGMENT_WIRE_MAX_BYTES: usize = 256 * 1024;
/// Base64 expands binary by 4/3. Keeping the gzip sink below this bound also
/// bounds the temporary binary and base64 buffers while the exact wire check
/// below accounts for JSON field overhead.
const CLOUD_SEGMENT_GZIP_MAX_BYTES: usize = 191 * 1024;
/// Leaves enough room for the V2 frame header, gzip overhead, base64 growth,
/// and the containing JSON wire object even for high-entropy bytes.
const CLOUD_ATTACHMENT_CHUNK_BYTES: usize = 176 * 1024;
const CLOUD_ATTACHMENT_V2_MAGIC: &[u8] = b"ORGII-REPLAY-ATTACHMENT-V2\0";
const CLOUD_SPOOL_TTL: Duration = Duration::from_secs(10 * 60);

#[tauri::command]
pub async fn external_replay_cloud_prepare(
    source_id: String,
    session_id: String,
) -> Result<ExternalReplayCloudManifest, String> {
    let manifest =
        tokio::task::spawn_blocking(move || prepare_cloud_spool(&source_id, &session_id))
            .await
            .map_err(|err| format!("join replay cloud prepare task: {err}"))??;
    schedule_replay_cache_prune();
    Ok(manifest)
}

#[tauri::command]
pub async fn external_replay_cloud_read_batch(
    token: String,
    start_event_index: u64,
    end_event_index: u64,
    start_segment_index: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<ExternalReplayCloudBatch, String> {
    tokio::task::spawn_blocking(move || {
        read_cloud_spool_batch(
            &token,
            start_event_index,
            end_event_index,
            start_segment_index,
            max_bytes,
        )
    })
    .await
    .map_err(|err| format!("join replay cloud batch task: {err}"))?
}

#[tauri::command]
pub async fn external_replay_cloud_prefix_hash(
    token: String,
    event_count: u64,
) -> Result<ExternalReplayCloudPrefixHash, String> {
    tokio::task::spawn_blocking(move || cloud_spool_prefix_hash(&token, event_count))
        .await
        .map_err(|err| format!("join replay cloud prefix task: {err}"))?
}

#[tauri::command]
pub async fn external_replay_cloud_release(token: String) -> Result<(), String> {
    release_cloud_spool(&token)
}

fn cloud_spools() -> &'static Mutex<HashMap<String, CloudSpoolEntry>> {
    static SPOOLS: OnceLock<Mutex<HashMap<String, CloudSpoolEntry>>> = OnceLock::new();
    SPOOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default)]
struct BoundedCloudGzipBuffer {
    bytes: Vec<u8>,
}

impl Write for BoundedCloudGzipBuffer {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(input.len()) > CLOUD_SEGMENT_GZIP_MAX_BYTES {
            return Err(std::io::Error::other(
                "compressed replay event exceeds the cloud segment wire budget; the current SessionEvent[] RPC has no attachment/continuation type",
            ));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct CloudSegmentEncoder {
    gzip: GzEncoder<BoundedCloudGzipBuffer>,
    digest: Sha256,
}

impl CloudSegmentEncoder {
    fn new() -> Self {
        Self {
            gzip: GzEncoder::new(BoundedCloudGzipBuffer::default(), Compression::default()),
            digest: Sha256::new(),
        }
    }

    fn finish(self, event_count: u64) -> Result<ExternalReplayCloudSegment, String> {
        let segment_hash = format!("{:x}", self.digest.finalize());
        let compressed = self.gzip.finish().map_err(cloud_segment_write_error)?.bytes;
        let payload_gz = BASE64_STANDARD.encode(compressed);
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct BudgetWire<'a> {
            seq: u64,
            payload_gz: &'a str,
            event_count: u64,
            segment_hash: &'a str,
        }
        let wire_bytes = serde_json::to_vec(&BudgetWire {
            // The spool is reused across orgs/cursors, so reserve the largest
            // possible sequence representation before publication.
            seq: u64::MAX,
            payload_gz: &payload_gz,
            event_count,
            segment_hash: &segment_hash,
        })
        .map_err(|err| format!("measure replay cloud wire segment: {err}"))?
        .len();
        if wire_bytes > CLOUD_SEGMENT_WIRE_MAX_BYTES {
            return Err(format!(
                "Cloud replay cannot represent this event without loss: encoded segment is {wire_bytes} bytes (limit {CLOUD_SEGMENT_WIRE_MAX_BYTES}). The current SessionEvent[] RPC has no attachment/continuation type; upload requires the versioned replay-attachment protocol."
            ));
        }
        Ok(ExternalReplayCloudSegment {
            payload_gz,
            event_count,
            segment_hash,
            wire_bytes: wire_bytes as u64,
        })
    }
}

impl Write for CloudSegmentEncoder {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        self.gzip.write_all(input)?;
        self.digest.update(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.gzip.flush()
    }
}

struct DigestingWriter<'a, W: Write> {
    inner: &'a mut W,
    digest: &'a mut Sha256,
}

impl<W: Write> Write for DigestingWriter<'_, W> {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        self.inner.write_all(input)?;
        self.digest.update(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn cloud_segment_write_error(error: std::io::Error) -> String {
    if error
        .to_string()
        .contains("exceeds the cloud segment wire budget")
    {
        return format!(
            "Cloud replay cannot represent this event without loss: compressed payload exceeds the {CLOUD_SEGMENT_WIRE_MAX_BYTES}-byte wire limit. The current SessionEvent[] RPC has no attachment/continuation type; upload requires the versioned replay-attachment protocol."
        );
    }
    format!("encode replay cloud segment: {error}")
}

fn encode_cloud_frozen_event(
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(ExternalReplayCloudSegment, String), String> {
    let mut encoder = CloudSegmentEncoder::new();
    encoder.write_all(b"[").map_err(cloud_segment_write_error)?;
    let mut event_digest = Sha256::new();
    {
        let mut event_writer = DigestingWriter {
            inner: &mut encoder,
            digest: &mut event_digest,
        };
        write_hydrated_event_json(&mut event_writer, event, read_payload)?;
    }
    encoder.write_all(b"]").map_err(cloud_segment_write_error)?;
    Ok((encoder.finish(1)?, format!("{:x}", event_digest.finalize())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAttachmentFrameHeader<'a> {
    kind: &'static str,
    attachment_id: &'a str,
    part_index: u64,
    chunk_offset: u64,
    chunk_bytes: u64,
    final_part: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_hash: Option<&'a str>,
}

fn encode_cloud_attachment_frame(
    header: &CloudAttachmentFrameHeader<'_>,
    chunk: &[u8],
    event_count: u64,
) -> Result<ExternalReplayCloudSegment, String> {
    let header_json = serde_json::to_vec(header)
        .map_err(|err| format!("serialize replay attachment V2 header: {err}"))?;
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| "Replay attachment V2 header exceeds u32".to_string())?;
    let mut encoder = CloudSegmentEncoder::new();
    encoder
        .write_all(CLOUD_ATTACHMENT_V2_MAGIC)
        .map_err(cloud_segment_write_error)?;
    encoder
        .write_all(&header_len.to_be_bytes())
        .map_err(cloud_segment_write_error)?;
    encoder
        .write_all(&header_json)
        .map_err(cloud_segment_write_error)?;
    encoder
        .write_all(chunk)
        .map_err(cloud_segment_write_error)?;
    encoder.finish(event_count)
}

struct StreamingCloudAttachmentEncoder<'a> {
    attachment_id: String,
    chunk: Vec<u8>,
    part_index: u64,
    total_bytes: u64,
    digest: Sha256,
    emit: &'a mut dyn FnMut(ExternalReplayCloudSegment) -> Result<(), String>,
}

impl<'a> StreamingCloudAttachmentEncoder<'a> {
    fn new(
        event_id: &str,
        emit: &'a mut dyn FnMut(ExternalReplayCloudSegment) -> Result<(), String>,
    ) -> Self {
        Self {
            attachment_id: sha256_hex(event_id.as_bytes()),
            chunk: Vec::with_capacity(CLOUD_ATTACHMENT_CHUNK_BYTES),
            part_index: 0,
            total_bytes: 0,
            digest: Sha256::new(),
            emit,
        }
    }

    fn emit_chunk(&mut self, final_part: bool) -> Result<(), String> {
        if self.chunk.is_empty() {
            return Err("Replay attachment V2 cannot emit an empty part".to_string());
        }
        let chunk_bytes = self.chunk.len() as u64;
        let chunk_offset = self.total_bytes.saturating_sub(chunk_bytes);
        let attachment_hash = final_part.then(|| format!("{:x}", self.digest.clone().finalize()));
        let header = CloudAttachmentFrameHeader {
            kind: "event",
            attachment_id: &self.attachment_id,
            part_index: self.part_index,
            chunk_offset,
            chunk_bytes,
            final_part,
            event_bytes: final_part.then_some(self.total_bytes),
            attachment_hash: attachment_hash.as_deref(),
        };
        let segment =
            encode_cloud_attachment_frame(&header, &self.chunk, if final_part { 1 } else { 0 })?;
        (self.emit)(segment)?;
        self.part_index = self.part_index.saturating_add(1);
        self.chunk.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<String, String> {
        self.emit_chunk(true)?;
        Ok(format!("{:x}", self.digest.finalize()))
    }
}

impl Write for StreamingCloudAttachmentEncoder<'_> {
    fn write(&mut self, mut input: &[u8]) -> std::io::Result<usize> {
        let input_len = input.len();
        while !input.is_empty() {
            if self.chunk.len() == CLOUD_ATTACHMENT_CHUNK_BYTES {
                self.emit_chunk(false).map_err(std::io::Error::other)?;
            }
            let available = CLOUD_ATTACHMENT_CHUNK_BYTES.saturating_sub(self.chunk.len());
            let take = available.min(input.len());
            let bytes = &input[..take];
            self.chunk.extend_from_slice(bytes);
            self.digest.update(bytes);
            self.total_bytes = self.total_bytes.saturating_add(take as u64);
            input = &input[take..];
        }
        Ok(input_len)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn is_cloud_segment_budget_error(error: &str) -> bool {
    error.contains("cloud segment wire budget")
        || error.contains("cannot represent this event without loss")
        || error.contains("compressed payload exceeds")
}

fn encode_cloud_event_segments(
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
    emit: &mut dyn FnMut(ExternalReplayCloudSegment) -> Result<(), String>,
) -> Result<String, String> {
    match encode_cloud_frozen_event(event, read_payload) {
        Ok((segment, event_hash)) => {
            emit(segment)?;
            Ok(event_hash)
        }
        Err(error) if is_cloud_segment_budget_error(&error) => {
            let mut encoder = StreamingCloudAttachmentEncoder::new(&event.id, emit);
            write_hydrated_event_json(&mut encoder, event, read_payload)?;
            encoder.finish()
        }
        Err(error) => Err(error),
    }
}

fn prepare_cloud_spool(
    source_id: &str,
    session_id: &str,
) -> Result<ExternalReplayCloudManifest, String> {
    cleanup_cloud_spools();
    let token = uuid::Uuid::new_v4().to_string();
    let final_path = std::env::temp_dir().join(format!("orgii-replay-cloud-{token}.sqlite"));
    let partial_path = final_path.with_extension("sqlite-part");
    let prepared = (|| {
        let mut spool = rusqlite::Connection::open(&partial_path)
            .map_err(|err| format!("create replay cloud spool: {err}"))?;
        spool
            .execute_batch(
                "PRAGMA journal_mode=OFF;
                 PRAGMA synchronous=OFF;
                 CREATE TABLE events (
                    event_index INTEGER PRIMARY KEY,
                    event_hash TEXT NOT NULL,
                    frozen_chain_hash TEXT NOT NULL
                 );
                 CREATE TABLE frozen_segments (
                    segment_index INTEGER PRIMARY KEY,
                    event_index INTEGER NOT NULL,
                    payload_gz TEXT NOT NULL,
                    event_count INTEGER NOT NULL,
                    segment_hash TEXT NOT NULL,
                    wire_bytes INTEGER NOT NULL
                 );
                 CREATE INDEX frozen_segments_event_idx
                    ON frozen_segments(event_index, segment_index);
                 CREATE TABLE tail_segment (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    payload_gz TEXT NOT NULL,
                    event_count INTEGER NOT NULL,
                    segment_hash TEXT NOT NULL,
                    wire_bytes INTEGER NOT NULL
                 );",
            )
            .map_err(|err| format!("initialize replay cloud spool: {err}"))?;
        let tx = spool
            .transaction()
            .map_err(|err| format!("start replay cloud spool transaction: {err}"))?;
        let mut total_count = 0_u64;
        let mut frozen_event_count = 0_u64;
        let mut frozen_segment_count = 0_u64;
        let mut frozen_chain = Sha256::new();
        let generation =
            stream_replay_cloud_events(source_id, session_id, |event, read_payload| {
                let event_index = total_count;
                let mut emit = |segment: ExternalReplayCloudSegment| {
                    tx.execute(
                        "INSERT INTO frozen_segments (
                            segment_index, event_index, payload_gz, event_count,
                            segment_hash, wire_bytes
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        rusqlite::params![
                            frozen_segment_count as i64,
                            event_index as i64,
                            segment.payload_gz,
                            segment.event_count as i64,
                            segment.segment_hash,
                            segment.wire_bytes as i64,
                        ],
                    )
                    .map_err(|err| format!("write replay cloud frozen segment: {err}"))?;
                    frozen_segment_count = frozen_segment_count.saturating_add(1);
                    Ok(())
                };
                let event_hash = encode_cloud_event_segments(event, read_payload, &mut emit)?;
                if frozen_event_count > 0 {
                    frozen_chain.update(b"\n");
                }
                frozen_chain.update(event_hash.as_bytes());
                let chain_hash = format!("{:x}", frozen_chain.clone().finalize());
                tx.execute(
                    "INSERT INTO events (event_index, event_hash, frozen_chain_hash)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![event_index as i64, event_hash, chain_hash],
                )
                .map_err(|err| format!("write replay cloud event hash: {err}"))?;
                // External source events are immutable within one generation.
                // Publishing all of them as a frozen prefix lets oversized
                // V2 events use continuation rows; an in-place source change
                // changes the logical prefix hash and forces an epoch rewrite.
                frozen_event_count = frozen_event_count.saturating_add(1);
                total_count = total_count.saturating_add(1);
                Ok(())
            })?;
        tx.commit()
            .map_err(|err| format!("commit replay cloud spool: {err}"))?;
        drop(spool);
        fs::rename(&partial_path, &final_path)
            .map_err(|err| format!("publish replay cloud spool: {err}"))?;
        Ok::<_, String>(ExternalReplayCloudManifest {
            token: token.clone(),
            generation,
            total_count,
            frozen_event_count,
            tail_event_count: 0,
            frozen_chain_hash: format!("{:x}", frozen_chain.finalize()),
            tail_hash: None,
        })
    })();
    let manifest = match prepared {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_file(&partial_path);
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
    };
    cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            token,
            CloudSpoolEntry {
                path: final_path,
                manifest: manifest.clone(),
                last_used: Instant::now(),
                lease_count: 1,
                owner_released: false,
            },
        );
    Ok(manifest)
}

fn read_cloud_spool_batch(
    token: &str,
    start_event_index: u64,
    end_event_index: u64,
    start_segment_index: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<ExternalReplayCloudBatch, String> {
    let entry = acquire_cloud_spool_read(token)?;
    let end = end_event_index.min(entry.manifest.total_count);
    if start_event_index > end {
        return Err("Replay cloud batch range is reversed".to_string());
    }
    if start_event_index == end {
        return Ok(ExternalReplayCloudBatch {
            segments: Vec::new(),
            start_event_index,
            next_event_index: start_event_index,
            start_segment_index: start_segment_index.unwrap_or(0),
            next_segment_index: start_segment_index.unwrap_or(0),
            eof: true,
            serialized_bytes: 0,
        });
    }
    let byte_limit = max_bytes
        .unwrap_or(STREAM_BATCH_MAX_BYTES)
        .clamp(1, CLOUD_SEGMENT_WIRE_MAX_BYTES);
    let conn = rusqlite::Connection::open_with_flags(
        &entry.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|err| format!("open replay cloud spool: {err}"))?;
    let reading_tail = start_event_index == entry.manifest.frozen_event_count
        && entry.manifest.tail_event_count > 0;
    let resolved_segment_index = if let Some(index) = start_segment_index {
        index
    } else if reading_tail {
        0
    } else {
        conn.query_row(
            "SELECT MIN(segment_index) FROM frozen_segments
             WHERE event_index >= ?1 AND event_index < ?2",
            rusqlite::params![
                start_event_index.min(i64::MAX as u64) as i64,
                end.min(i64::MAX as u64) as i64,
            ],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| format!("locate replay cloud physical cursor: {err}"))?
        .ok_or_else(|| "Replay cloud spool has no segment for the requested event".to_string())?
        .max(0) as u64
    };
    let (query, start, limit) = if reading_tail {
        (
            "SELECT ?1, payload_gz, event_count, segment_hash, wire_bytes
             FROM tail_segment WHERE singleton = 1",
            resolved_segment_index.min(i64::MAX as u64) as i64,
            1_i64,
        )
    } else {
        (
            "SELECT segment_index, payload_gz, event_count, segment_hash, wire_bytes
             FROM frozen_segments
             WHERE segment_index >= ?1 AND event_index >= ?2 AND event_index < ?3
             ORDER BY segment_index ASC LIMIT ?4",
            resolved_segment_index.min(i64::MAX as u64) as i64,
            STREAM_BATCH_MAX_EVENTS as i64,
        )
    };
    let mut stmt = conn
        .prepare(query)
        .map_err(|err| format!("prepare replay cloud batch: {err}"))?;
    let mut rows = if reading_tail {
        stmt.query([start])
    } else {
        stmt.query(rusqlite::params![
            start,
            start_event_index.min(i64::MAX as u64) as i64,
            end.min(i64::MAX as u64) as i64,
            limit,
        ])
    }
    .map_err(|err| format!("query replay cloud batch: {err}"))?;
    let mut segments = Vec::new();
    let mut serialized_bytes = 0_usize;
    let mut consumed_events = 0_u64;
    let mut next_segment_index = resolved_segment_index;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read replay cloud batch row: {err}"))?
    {
        let row_bytes = row.get::<_, i64>(4).unwrap_or_default().max(0) as usize;
        if !segments.is_empty() && serialized_bytes.saturating_add(row_bytes) > byte_limit {
            break;
        }
        if row_bytes > CLOUD_SEGMENT_WIRE_MAX_BYTES {
            return Err("Replay cloud spool contains an over-budget wire segment".to_string());
        }
        let physical_index = row.get::<_, i64>(0).unwrap_or_default().max(0) as u64;
        let event_count = row.get::<_, i64>(2).unwrap_or_default().max(0) as u64;
        segments.push(ExternalReplayCloudSegment {
            payload_gz: row.get(1).map_err(|err| err.to_string())?,
            event_count,
            segment_hash: row.get(3).map_err(|err| err.to_string())?,
            wire_bytes: row_bytes as u64,
        });
        serialized_bytes = serialized_bytes.saturating_add(row_bytes);
        consumed_events = consumed_events.saturating_add(event_count);
        next_segment_index = physical_index.saturating_add(1);
    }
    if segments.is_empty() {
        return Err("Replay cloud physical batch cursor did not resolve a segment".to_string());
    }
    let next_event_index = start_event_index.saturating_add(consumed_events).min(end);
    Ok(ExternalReplayCloudBatch {
        segments,
        start_event_index,
        next_event_index,
        start_segment_index: resolved_segment_index,
        next_segment_index,
        eof: next_event_index >= end,
        serialized_bytes: serialized_bytes as u64,
    })
}

fn cloud_spool_prefix_hash(
    token: &str,
    event_count: u64,
) -> Result<ExternalReplayCloudPrefixHash, String> {
    let entry = acquire_cloud_spool_read(token)?;
    if event_count > entry.manifest.frozen_event_count {
        return Err("Requested prefix crosses the replay mutable tail".to_string());
    }
    let frozen_chain_hash = if event_count == 0 {
        sha256_hex(b"")
    } else {
        let conn = rusqlite::Connection::open_with_flags(
            &entry.path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|err| format!("open replay cloud spool: {err}"))?;
        conn.query_row(
            "SELECT frozen_chain_hash FROM events WHERE event_index=?1",
            [event_count.saturating_sub(1).min(i64::MAX as u64) as i64],
            |row| row.get(0),
        )
        .map_err(|err| format!("read replay cloud prefix hash: {err}"))?
    };
    Ok(ExternalReplayCloudPrefixHash {
        event_count,
        frozen_chain_hash,
    })
}

fn acquire_cloud_spool_read(token: &str) -> Result<CloudSpoolReadLease, String> {
    let mut spools = cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = spools
        .get_mut(token)
        .ok_or_else(|| "Replay cloud spool expired; prepare it again".to_string())?;
    if entry.owner_released {
        return Err("Replay cloud spool was released; prepare it again".to_string());
    }
    entry.last_used = Instant::now();
    entry.lease_count = entry.lease_count.saturating_add(1);
    Ok(CloudSpoolReadLease {
        token: token.to_string(),
        path: entry.path.clone(),
        manifest: entry.manifest.clone(),
    })
}

fn release_cloud_spool(token: &str) -> Result<(), String> {
    let path = {
        let mut spools = cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = spools.get_mut(token) else {
            return Ok(());
        };
        if entry.owner_released {
            return Ok(());
        }
        entry.owner_released = true;
        entry.lease_count = entry.lease_count.saturating_sub(1);
        if entry.lease_count == 0 {
            spools.remove(token).map(|entry| entry.path)
        } else {
            None
        }
    };
    if let Some(path) = path {
        remove_cloud_spool_file(&path)?;
    }
    Ok(())
}

fn release_cloud_spool_read_lease(token: &str) {
    let path = {
        let mut spools = cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = spools.get_mut(token) else {
            return;
        };
        entry.lease_count = entry.lease_count.saturating_sub(1);
        if entry.owner_released && entry.lease_count == 0 {
            spools.remove(token).map(|entry| entry.path)
        } else {
            None
        }
    };
    if let Some(path) = path {
        if let Err(error) = remove_cloud_spool_file(&path) {
            log::warn!("[external-replay] {error}");
        }
    }
}

fn remove_cloud_spool_file(path: &PathBuf) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove replay cloud spool: {err}")),
    }
}

fn cleanup_cloud_spools() {
    let paths = {
        let mut spools = cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let expired = spools
            .iter()
            .filter(|(_, entry)| {
                // `lease_count == 1` is the renderer's idle owner lease. An
                // in-flight reader raises it above one and must never be
                // evicted merely because another session prepared a spool.
                !entry.owner_released
                    && entry.lease_count == 1
                    && now.duration_since(entry.last_used) >= CLOUD_SPOOL_TTL
            })
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        expired
            .into_iter()
            .filter_map(|token| spools.remove(&token).map(|entry| entry.path))
            .collect::<Vec<_>>()
    };
    for path in paths {
        if let Err(error) = remove_cloud_spool_file(&path) {
            log::warn!("[external-replay] {error}");
        }
    }
}

#[cfg(test)]
fn write_stable_json(writer: &mut impl Write, value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::Object(object) => {
            writer.write_all(b"{").map_err(|err| err.to_string())?;
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|err| err.to_string())?;
                }
                serde_json::to_writer(&mut *writer, key).map_err(|err| err.to_string())?;
                writer.write_all(b":").map_err(|err| err.to_string())?;
                write_stable_json(writer, &object[key])?;
            }
            writer.write_all(b"}").map_err(|err| err.to_string())?;
        }
        serde_json::Value::Array(array) => {
            writer.write_all(b"[").map_err(|err| err.to_string())?;
            for (index, item) in array.iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|err| err.to_string())?;
                }
                write_stable_json(writer, item)?;
            }
            writer.write_all(b"]").map_err(|err| err.to_string())?;
        }
        primitive => {
            serde_json::to_writer(writer, primitive).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn stream_replay_export(
    source_id: &str,
    session_id: &str,
    destination_path: &str,
    format: ReplayExportFormat,
    orgii_envelope: Option<&OrgiiSessionExportEnvelope>,
) -> Result<ReplayExportResult, String> {
    let destination = std::path::Path::new(destination_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "Replay export destination has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("create replay export directory {}: {err}", parent.display()))?;
    let destination_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("replay-export");
    let temporary = parent.join(format!(
        ".{destination_name}.orgii-{}.part",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<ReplayExportResult, String> {
        let file = fs::File::create(&temporary)
            .map_err(|err| format!("create replay export {}: {err}", temporary.display()))?;
        let mut writer =
            HashingWriter::new(BufWriter::with_capacity(EXPORT_WRITER_BUFFER_BYTES, file));
        match format {
            ReplayExportFormat::Json => writer.write_all(b"[\n").map_err(|err| err.to_string())?,
            ReplayExportFormat::OrgiiSessionJson => {
                let envelope = orgii_envelope.ok_or_else(|| {
                    "orgii_session_json export requires the small session envelope".to_string()
                })?;
                writer
                    .write_all(
                        b"{\"format\":\"orgii.session.export\",\"version\":1,\"exportedAt\":",
                    )
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.exported_at)
                    .map_err(|err| format!("serialize replay export timestamp: {err}"))?;
                writer
                    .write_all(b",\"session\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.session)
                    .map_err(|err| format!("serialize replay export session: {err}"))?;
                writer
                    .write_all(b",\"payload\":{\"events\":[\n")
                    .map_err(|err| err.to_string())?;
            }
            ReplayExportFormat::Markdown => {}
        }
        let summary = stream_replay_export_events(source_id, session_id, &mut writer, format)?;
        let count = summary.event_count;
        let first_created_at = summary.first_created_at;
        let last_created_at = summary.last_created_at;
        match format {
            ReplayExportFormat::Json => {
                writer.write_all(b"\n]\n").map_err(|err| err.to_string())?
            }
            ReplayExportFormat::OrgiiSessionJson => {
                let envelope = orgii_envelope.expect("validated above");
                writer
                    .write_all(b"\n],\"specs\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.specs)
                    .map_err(|err| format!("serialize replay export specs: {err}"))?;
                let fallback_start = envelope
                    .session
                    .get("created_at")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let fallback_end = envelope
                    .session
                    .get("updated_at")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(fallback_start);
                writer
                    .write_all(b",\"timeRange\":{\"start\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(
                    &mut writer,
                    first_created_at.as_deref().unwrap_or(fallback_start),
                )
                .map_err(|err| format!("serialize replay export time range: {err}"))?;
                writer
                    .write_all(b",\"end\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(
                    &mut writer,
                    last_created_at.as_deref().unwrap_or(fallback_end),
                )
                .map_err(|err| format!("serialize replay export time range: {err}"))?;
                writer
                    .write_all(b"}},\"metadata\":{\"originalCategory\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.original_category)
                    .map_err(|err| format!("serialize replay export category: {err}"))?;
                writer
                    .write_all(format!(",\"eventCount\":{count}}}}}\n").as_bytes())
                    .map_err(|err| err.to_string())?;
            }
            ReplayExportFormat::Markdown => {}
        }
        writer
            .flush()
            .map_err(|err| format!("flush replay export: {err}"))?;
        let (bytes_written, sha256, mut inner) = writer.finish();
        inner
            .flush()
            .map_err(|err| format!("flush replay export file: {err}"))?;
        inner
            .get_ref()
            .sync_all()
            .map_err(|err| format!("sync replay export file: {err}"))?;
        drop(inner);
        fs::rename(&temporary, destination).map_err(|err| {
            format!(
                "publish replay export {} -> {}: {err}",
                temporary.display(),
                destination.display()
            )
        })?;
        Ok(ReplayExportResult {
            destination_path: destination_path.to_string(),
            bytes_written,
            event_count: count,
            sha256,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Default)]
struct ReplayExportSummary {
    event_count: u64,
    first_created_at: Option<String>,
    last_created_at: Option<String>,
}

impl ReplayExportSummary {
    fn observe(&mut self, event: &SessionEvent) {
        if self
            .first_created_at
            .as_ref()
            .is_none_or(|first| event.created_at < *first)
        {
            self.first_created_at = Some(event.created_at.clone());
        }
        if self
            .last_created_at
            .as_ref()
            .is_none_or(|last| event.created_at > *last)
        {
            self.last_created_at = Some(event.created_at.clone());
        }
        self.event_count = self.event_count.saturating_add(1);
    }
}

fn prepare_stream_replay_snapshot(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayCursor, String> {
    replay::prepare_pinned_scan(conn, source, imported_session_id, limits)
}

fn prepare_sessions_stream_replay_snapshot(
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayCursor, String> {
    with_sessions_replay_writer("replay stream preparation", |conn| {
        prepare_stream_replay_snapshot(conn, source, imported_session_id, limits)
    })
}

/// Export-only source scan. Unlike the cloud spool iterator, this deliberately
/// keeps events compact and gives the writer a range reader for each deferred
/// payload. A single 10 MiB output therefore never becomes a 10 MiB `String`.
fn stream_replay_export_events(
    source_id: &str,
    session_id: &str,
    writer: &mut impl Write,
    format: ReplayExportFormat,
) -> Result<ReplayExportSummary, String> {
    let mut summary = ReplayExportSummary::default();
    match resolve_secondary_consumer_target(source_id, session_id)? {
        ResolvedTarget::Imported {
            source,
            imported_session_id,
        } => {
            let limits = ReplayLimits {
                max_turns: 10,
                max_events: STREAM_BATCH_MAX_EVENTS,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let prepared =
                prepare_sessions_stream_replay_snapshot(source, &imported_session_id, limits)?;
            let expected_generation = prepared.generation;
            let expected_revision = prepared.revision;
            let mut payload_conn = database::db::get_connection()
                .map_err(|err| format!("open replay export payload DB: {err}"))?;
            let mut after_sequence = -1_i64;
            loop {
                let scan = with_sessions_replay_writer("replay export scan", |conn| {
                    replay::scan_window_after_generation(
                        conn,
                        source,
                        &imported_session_id,
                        &expected_generation,
                        expected_revision,
                        after_sequence,
                        limits,
                    )
                })?;
                let next_sequence = scan.cursor.through_sequence;
                let has_more = scan.has_more;
                let (events, _) = normalize_indexed_chunks(
                    scan.chunks,
                    session_id,
                    source.as_str(),
                    &scan.cursor.generation,
                );
                for event in events {
                    write_replay_export_event(
                        writer,
                        &event,
                        format,
                        summary.event_count,
                        |payload_ref, offset| {
                            replay::read_payload_range(
                                &mut payload_conn,
                                source,
                                &imported_session_id,
                                &scan.cursor.generation,
                                payload_ref
                                    .replay_source_event_id
                                    .as_deref()
                                    .unwrap_or(&payload_ref.event_id),
                                &payload_ref.field_path,
                                offset,
                                Some(EXPORT_PAYLOAD_RANGE_BYTES),
                            )
                        },
                    )?;
                    summary.observe(&event);
                }
                if !has_more {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Replay export cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let final_scan = with_sessions_replay_writer("replay export finalization", |conn| {
                replay::scan_window_after(
                    conn,
                    source,
                    &imported_session_id,
                    after_sequence,
                    ReplayLimits {
                        max_turns: 1,
                        max_events: 1,
                        max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
                    },
                )
            })?;
            validate_stream_replay_cursor(
                &expected_generation,
                expected_revision,
                &final_scan.cursor,
                "finalizing replay export",
            )?;
        }
        ResolvedTarget::CollaborationSnapshot => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open collaboration replay export DB: {err}"))?;
            let state = collaboration_snapshot_state(&conn, session_id)?;
            let limits = ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: STREAM_BATCH_MAX_EVENTS,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let mut after_sequence = -1_i64;
            loop {
                let indexed = query_collaboration_snapshot_events(
                    &conn,
                    session_id,
                    &state.generation,
                    after_sequence,
                    state.max_sequence.saturating_add(1),
                    limits,
                    false,
                )?;
                if indexed.is_empty() {
                    break;
                }
                let next_sequence = indexed
                    .last()
                    .map_or(after_sequence, |(sequence, _)| *sequence);
                for (_, event) in indexed {
                    write_replay_export_event(
                        writer,
                        &event,
                        format,
                        summary.event_count,
                        |payload_ref, offset| {
                            collaboration_snapshot_payload_range_from_conn(
                                &conn,
                                session_id,
                                &state.generation,
                                payload_ref
                                    .replay_source_event_id
                                    .as_deref()
                                    .unwrap_or(&payload_ref.event_id),
                                &payload_ref.field_path,
                                offset,
                                EXPORT_PAYLOAD_RANGE_BYTES,
                            )
                        },
                    )?;
                    summary.observe(&event);
                }
                if next_sequence >= state.max_sequence {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Collaboration replay export cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let current = collaboration_snapshot_state(&conn, session_id)?;
            validate_query_apply_version(
                &state.generation,
                state.revision,
                &current.generation,
                current.revision,
            )?;
        }
        ResolvedTarget::LegacyChunks => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open managed replay export DB: {err}"))?;
            stream_legacy_replay_events_from_conn(
                &conn,
                session_id,
                "exporting managed replay",
                |event, read_payload| {
                    write_replay_export_event(
                        writer,
                        event,
                        format,
                        summary.event_count,
                        |payload_ref, offset| read_payload(payload_ref, offset),
                    )?;
                    summary.observe(event);
                    Ok(())
                },
            )?;
        }
        ResolvedTarget::NotReady => {
            return Err("Managed native transcript is not bound yet".to_string())
        }
    }
    Ok(summary)
}

fn write_replay_export_event(
    writer: &mut impl Write,
    event: &SessionEvent,
    format: ReplayExportFormat,
    event_index: u64,
    mut read_payload: impl FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    match format {
        ReplayExportFormat::Json | ReplayExportFormat::OrgiiSessionJson => {
            if event_index > 0 {
                writer.write_all(b",\n").map_err(|err| err.to_string())?;
            }
            write_hydrated_event_json(writer, event, &mut read_payload)
        }
        ReplayExportFormat::Markdown => {
            write_markdown_event_streaming(writer, event, &mut read_payload)
        }
    }
}

#[derive(Clone, Copy)]
enum PayloadMarkerEncoding {
    JsonString,
    RawJson,
}

struct PayloadMarker {
    encoded_marker: Vec<u8>,
    payload_ref: PayloadRef,
    encoding: PayloadMarkerEncoding,
}

fn write_hydrated_event_json(
    writer: &mut impl Write,
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    if event.payload_refs.is_empty() {
        return serde_json::to_writer(writer, event)
            .map_err(|err| format!("serialize replay export event: {err}"));
    }

    let mut compact = event.clone();
    let payload_refs = std::mem::take(&mut compact.payload_refs);
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut markers = Vec::with_capacity(payload_refs.len().saturating_mul(2));
    for (index, payload_ref) in payload_refs.into_iter().enumerate() {
        let field_marker = format!("__ORGII_REPLAY_{nonce}_FIELD_{index}__");
        if set_event_payload_marker(&mut compact, &payload_ref.field_path, &field_marker) {
            markers.push(PayloadMarker {
                encoded_marker: serde_json::to_vec(&field_marker)
                    .map_err(|err| format!("encode replay export marker: {err}"))?,
                encoding: match payload_ref.replay_encoding {
                    Some(PayloadRefEncoding::JsonValue) => PayloadMarkerEncoding::RawJson,
                    Some(PayloadRefEncoding::Utf8Text) => PayloadMarkerEncoding::JsonString,
                    None if matches!(payload_ref.field_path.as_str(), "args" | "result") => {
                        PayloadMarkerEncoding::RawJson
                    }
                    None => PayloadMarkerEncoding::JsonString,
                },
                payload_ref: payload_ref.clone(),
            });
        }
        if compact.display_text == payload_ref.preview {
            let display_marker = format!("__ORGII_REPLAY_{nonce}_DISPLAY_{index}__");
            compact.display_text = display_marker.clone();
            markers.push(PayloadMarker {
                encoded_marker: serde_json::to_vec(&display_marker)
                    .map_err(|err| format!("encode replay display marker: {err}"))?,
                payload_ref,
                encoding: PayloadMarkerEncoding::JsonString,
            });
        }
    }

    let encoded = serde_json::to_vec(&compact)
        .map_err(|err| format!("serialize compact replay export event: {err}"))?;
    let mut position = 0_usize;
    while position < encoded.len() {
        let next = markers
            .iter()
            .enumerate()
            .filter_map(|(index, marker)| {
                find_bytes(&encoded[position..], &marker.encoded_marker)
                    .map(|offset| (position + offset, index))
            })
            .min_by_key(|(offset, _)| *offset);
        let Some((offset, marker_index)) = next else {
            writer
                .write_all(&encoded[position..])
                .map_err(|err| format!("write compact replay export event: {err}"))?;
            break;
        };
        writer
            .write_all(&encoded[position..offset])
            .map_err(|err| format!("write replay export marker prefix: {err}"))?;
        let marker = &markers[marker_index];
        stream_payload_to_writer(writer, &marker.payload_ref, marker.encoding, read_payload)?;
        position = offset.saturating_add(marker.encoded_marker.len());
    }
    Ok(())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

fn set_event_payload_marker(event: &mut SessionEvent, field_path: &str, marker: &str) -> bool {
    match field_path {
        "args" => {
            event.args = serde_json::Value::String(marker.to_string());
            true
        }
        "result" => {
            event.result = serde_json::Value::String(marker.to_string());
            true
        }
        _ => {
            let Some((root, path)) = field_path.split_once('.') else {
                return false;
            };
            let value = match root {
                "args" => &mut event.args,
                "result" => &mut event.result,
                _ => return false,
            };
            set_json_string_path(value, path, marker.to_string());
            json_value_at_path(value, path).is_some_and(|value| value.as_str() == Some(marker))
        }
    }
}

fn json_value_at_path<'a>(
    mut value: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    for segment in path.split('.') {
        value = match value {
            serde_json::Value::Object(object) => object.get(segment)?,
            serde_json::Value::Array(array) => array.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(value)
}

fn stream_payload_to_writer(
    writer: &mut impl Write,
    payload_ref: &PayloadRef,
    encoding: PayloadMarkerEncoding,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    if matches!(encoding, PayloadMarkerEncoding::JsonString) {
        writer.write_all(b"\"").map_err(|err| err.to_string())?;
    }
    let mut offset = 0_u64;
    loop {
        let range = read_payload(payload_ref, offset)?;
        match encoding {
            PayloadMarkerEncoding::RawJson => writer
                .write_all(range.text.as_bytes())
                .map_err(|err| format!("write raw replay export payload: {err}"))?,
            PayloadMarkerEncoding::JsonString => {
                let escaped = serde_json::to_vec(&range.text)
                    .map_err(|err| format!("escape replay export payload range: {err}"))?;
                if escaped.len() < 2 {
                    return Err("Encoded replay payload range was not a JSON string".to_string());
                }
                writer
                    .write_all(&escaped[1..escaped.len() - 1])
                    .map_err(|err| format!("write escaped replay export payload: {err}"))?;
            }
        }
        if range.eof {
            break;
        }
        if range.next_offset <= offset {
            return Err("Replay export payload cursor did not advance".to_string());
        }
        offset = range.next_offset;
    }
    if matches!(encoding, PayloadMarkerEncoding::JsonString) {
        writer.write_all(b"\"").map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_markdown_event_streaming(
    writer: &mut impl Write,
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    let heading = match event.source {
        EventSource::User => "**User**\n\n",
        EventSource::Assistant if event.ui_canonical == "agent_message" => "**Assistant**\n\n",
        EventSource::Assistant | EventSource::System => return Ok(()),
    };
    let display_payload = event
        .payload_refs
        .iter()
        .find(|payload_ref| event.display_text == payload_ref.preview);
    if display_payload.is_none() && event.display_text.trim().is_empty() {
        return Ok(());
    }
    writer
        .write_all(heading.as_bytes())
        .map_err(|err| format!("write replay Markdown heading: {err}"))?;
    if let Some(payload_ref) = display_payload {
        stream_payload_to_writer(
            writer,
            payload_ref,
            PayloadMarkerEncoding::RawJson,
            read_payload,
        )?;
    } else {
        writer
            .write_all(event.display_text.trim().as_bytes())
            .map_err(|err| format!("write replay Markdown event: {err}"))?;
    }
    writer
        .write_all(b"\n\n---\n\n")
        .map_err(|err| format!("finish replay Markdown event: {err}"))
}

struct HashingWriter<W> {
    inner: W,
    digest: Sha256,
    bytes: u64,
}

impl<W> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String, W) {
        let hash = self.digest.finalize();
        (self.bytes, format!("{hash:x}"), self.inner)
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.digest.update(&bytes[..written]);
        self.bytes = self.bytes.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

enum BackendWindow {
    Imported(ReplayChunkWindow),
    Legacy(ReplayChunkWindow),
    CollaborationSnapshot(ExternalReplayWindow),
    NotReady,
}

enum BackendDelta {
    Imported(ReplayChunkDelta),
    Legacy(ReplayChunkDelta),
    CollaborationSnapshot(ExternalReplayDelta),
    NotReady,
}

fn load_external_replay_handoff(
    source_id: &str,
    session_id: &str,
    source_name: &str,
) -> Result<ExternalReplayHandoff, String> {
    let source_name = source_name.trim();
    if source_name.is_empty() {
        return Err("external replay handoff sourceName is required".to_string());
    }
    if source_name.encode_utf16().count() > 200 {
        return Err("external replay handoff sourceName exceeds 200 characters".to_string());
    }
    if matches!(
        resolve_target(source_id, session_id)?,
        ResolvedTarget::CollaborationSnapshot
    ) {
        return collect_collaboration_snapshot_handoff(session_id, source_name);
    }
    collect_external_replay_handoff(source_name, |before_sequence, turn_index, limits| {
        load_replay_query_window(
            source_id,
            session_id,
            before_sequence,
            None,
            turn_index,
            limits,
        )
    })
}

fn collect_external_replay_handoff(
    source_name: &str,
    mut load_page: impl FnMut(Option<i64>, Option<i64>, ReplayLimits) -> Result<BackendWindow, String>,
) -> Result<ExternalReplayHandoff, String> {
    let mut before_sequence = None;
    let mut requested_turn_index = None;
    let mut generation: Option<String> = None;
    let mut revision: Option<u64> = None;
    let mut remaining_bytes = EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES;
    let mut scanned_bytes = 0_u64;
    let mut scanned_events = 0_u64;
    let mut items = Vec::new();

    while remaining_bytes > 0 && items.len() < EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
        let page = load_page(
            before_sequence,
            requested_turn_index,
            ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: replay::HARD_MAX_EVENTS,
                max_ipc_bytes: remaining_bytes,
            },
        )?;
        let (window, imported) = match page {
            BackendWindow::Imported(window) => (window, true),
            BackendWindow::Legacy(window) => (window, false),
            BackendWindow::CollaborationSnapshot(_) => {
                return Err(
                    "collaboration snapshot handoff must use its direct bounded SQL fold"
                        .to_string(),
                )
            }
            BackendWindow::NotReady => {
                return Ok(ExternalReplayHandoff {
                    items: Vec::new(),
                    generation: "pending".to_string(),
                    scanned_bytes: 0,
                    scanned_events: 0,
                })
            }
        };
        if let Some(expected) = generation.as_deref() {
            if expected != window.cursor.generation {
                return Err(format!(
                    "External replay changed generation while building Fork handoff: expected {expected}, found {}; retry the Fork from the new generation",
                    window.cursor.generation
                ));
            }
        } else {
            generation = Some(window.cursor.generation.clone());
        }
        if let Some(expected) = revision {
            if expected != window.cursor.revision {
                return Err(format!(
                    "External replay changed revision while building Fork handoff: expected {expected}, found {}; retry the Fork from a consistent replay snapshot",
                    window.cursor.revision
                ));
            }
        } else {
            revision = Some(window.cursor.revision);
        }

        let compact_bytes = compact_handoff_page_bytes(&window.chunks);
        let page_bytes = compact_bytes.max(window.stats.ipc_bytes as usize);
        if page_bytes > remaining_bytes {
            return Err(format!(
                "External replay handoff page exceeded its remaining {remaining_bytes} byte scan budget"
            ));
        }
        remaining_bytes = remaining_bytes.saturating_sub(page_bytes);
        scanned_bytes = scanned_bytes.saturating_add(page_bytes as u64);
        scanned_events = scanned_events.saturating_add(window.chunks.len() as u64);

        let oldest_sequence = window.chunks.iter().map(|chunk| chunk.sequence).min();
        let oldest_turn_index = window
            .turn_headers
            .iter()
            .map(|header| header.turn_index)
            .min();
        let mut page_items = window
            .chunks
            .iter()
            .filter_map(|indexed| handoff_item_from_chunk(&indexed.chunk, source_name))
            .collect::<Vec<_>>();
        page_items.append(&mut items);
        if page_items.len() > EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
            page_items.drain(..page_items.len() - EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS);
        }
        items = page_items;

        let has_older_compact_turn = imported && oldest_turn_index.is_some_and(|index| index > 0);
        if items.len() >= EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS
            || (!window.has_older && !has_older_compact_turn)
            || remaining_bytes == 0
        {
            break;
        }
        if let Some(oldest_turn_index) = oldest_turn_index.filter(|index| imported && *index > 0) {
            let next_turn_index = oldest_turn_index - 1;
            if requested_turn_index.is_some_and(|previous| next_turn_index >= previous) {
                return Err(
                    "External replay handoff turn cursor did not advance to an older turn"
                        .to_string(),
                );
            }
            requested_turn_index = Some(next_turn_index);
            before_sequence = None;
            continue;
        }
        let Some(next_before) = oldest_sequence else {
            return Err("External replay handoff hasOlder page contained no events".to_string());
        };
        if before_sequence.is_some_and(|previous| next_before >= previous) {
            return Err(
                "External replay handoff cursor did not advance to older events".to_string(),
            );
        }
        before_sequence = Some(next_before);
        requested_turn_index = None;
    }

    Ok(ExternalReplayHandoff {
        items,
        generation: generation.unwrap_or_else(|| "empty".to_string()),
        scanned_bytes,
        scanned_events,
    })
}

fn collect_collaboration_snapshot_handoff(
    session_id: &str,
    source_name: &str,
) -> Result<ExternalReplayHandoff, String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open collaboration handoff DB: {error}"))?;
    let state = collaboration_snapshot_state(&conn, session_id)?;
    let mut upper_exclusive = i64::MAX;
    let mut remaining_bytes = EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES;
    let mut scanned_bytes = 0_u64;
    let mut scanned_events = 0_u64;
    let mut items = Vec::new();
    while remaining_bytes > 0 && items.len() < EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
        let page = query_collaboration_snapshot_events(
            &conn,
            session_id,
            &state.generation,
            -1,
            upper_exclusive,
            ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: replay::HARD_MAX_EVENTS,
                max_ipc_bytes: remaining_bytes,
            },
            true,
        )?;
        if page.is_empty() {
            break;
        }
        let page_bytes = page.iter().try_fold(0_usize, |total, (_, event)| {
            serde_json::to_vec(event)
                .map(|bytes| total.saturating_add(bytes.len()))
                .map_err(|error| format!("measure collaboration handoff page: {error}"))
        })?;
        if page_bytes > remaining_bytes {
            return Err(format!(
                "Collaboration replay handoff page exceeded its remaining {remaining_bytes} byte scan budget"
            ));
        }
        remaining_bytes = remaining_bytes.saturating_sub(page_bytes);
        scanned_bytes = scanned_bytes.saturating_add(page_bytes as u64);
        scanned_events = scanned_events.saturating_add(page.len() as u64);
        let oldest_sequence = page.first().map(|(sequence, _)| *sequence).unwrap_or(-1);
        let mut page_items = page
            .iter()
            .filter_map(|(_, event)| {
                let chunk = ActivityChunk {
                    chunk_id: event.id.clone(),
                    session_id: event.session_id.clone(),
                    action_type: event.action_type.clone(),
                    function: event.function_name.clone(),
                    args: event.args.clone(),
                    result: event.result.clone(),
                    thread_id: event.thread_id.clone(),
                    process_id: event.process_id.clone(),
                    created_at: event.created_at.clone(),
                    broadcast_only: false,
                };
                handoff_item_from_chunk(&chunk, source_name)
            })
            .collect::<Vec<_>>();
        page_items.append(&mut items);
        if page_items.len() > EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
            page_items.drain(..page_items.len() - EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS);
        }
        items = page_items;
        if items.len() >= EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS || oldest_sequence < 0 {
            break;
        }
        let has_older = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events
                 WHERE session_id=?1 AND history_sequence<?2)",
                rusqlite::params![session_id, oldest_sequence],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("query older collaboration handoff rows: {error}"))?
            != 0;
        if !has_older {
            break;
        }
        if oldest_sequence >= upper_exclusive {
            return Err("Collaboration replay handoff cursor did not advance".to_string());
        }
        upper_exclusive = oldest_sequence;
    }
    let current = collaboration_snapshot_state(&conn, session_id)?;
    validate_query_apply_version(
        &state.generation,
        state.revision,
        &current.generation,
        current.revision,
    )?;
    Ok(ExternalReplayHandoff {
        items,
        generation: state.generation,
        scanned_bytes,
        scanned_events,
    })
}

fn compact_handoff_page_bytes(chunks: &[ReplayIndexedChunk]) -> usize {
    chunks.iter().fold(0_usize, |total, indexed| {
        total
            .saturating_add(serde_json::to_vec(&indexed.chunk).map_or(0, |bytes| bytes.len()))
            .saturating_add(serde_json::to_vec(&indexed.payloads).map_or(0, |bytes| bytes.len()))
    })
}

fn handoff_item_from_chunk(chunk: &ActivityChunk, source_name: &str) -> Option<String> {
    let action_type = chunk.action_type.as_str();
    let function = chunk.function.as_str();
    if action_type.contains("thinking")
        || action_type.contains("reasoning")
        || matches!(function, "thinking" | "thinking_delta" | "reasoning")
    {
        return None;
    }

    let result_text = handoff_text_value(&chunk.result);
    let args_text = handoff_text_value(&chunk.args);
    let content = result_text.as_deref().or(args_text.as_deref());
    let item = if matches!(action_type, "user" | "user_message")
        || matches!(function, "user" | "user_message")
    {
        content.map(|text| format!("User: {text}"))
    } else if matches!(
        action_type,
        "assistant" | "assistant_message" | "llm_response"
    ) || matches!(
        function,
        "agent_message" | "assistant" | "assistant_message"
    ) {
        content.map(|text| format!("Assistant: {text}"))
    } else if action_type.contains("tool") {
        let mut lines = vec![
            format!("[Imported {source_name} action]"),
            format!(
                "Tool: {}",
                if function.is_empty() {
                    "unknown_tool"
                } else {
                    function
                }
            ),
        ];
        if let Some(args) = args_text {
            lines.push(format!("Input: {args}"));
        }
        if let Some(result) = result_text {
            lines.push(format!("Result at that time: {result}"));
        }
        Some(lines.join("\n"))
    } else {
        content.map(|text| format!("Assistant context: {text}"))
    }?;
    Some(truncate_handoff_utf16(&item))
}

fn handoff_text_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(handoff_text_value)
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        serde_json::Value::Object(object) => ["text", "content", "message", "output", "summary"]
            .into_iter()
            .find_map(|key| object.get(key).and_then(handoff_text_value)),
        _ => None,
    }
}

fn truncate_handoff_utf16(text: &str) -> String {
    if text.encode_utf16().count() <= EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16 {
        return text.to_string();
    }
    let content_budget = EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16.saturating_sub(1);
    let mut output = String::new();
    let mut units = 0_usize;
    for character in text.chars() {
        let next = units.saturating_add(character.len_utf16());
        if next > content_budget {
            break;
        }
        output.push(character);
        units = next;
    }
    output.push('…');
    output
}

fn load_replay_query_window(
    source_id: &str,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<BackendWindow, String> {
    let locator_count = usize::from(before_sequence.is_some())
        + usize::from(turn_id.is_some())
        + usize::from(turn_index.is_some());
    if locator_count > 1 {
        return Err("beforeSequence, turnId and turnIndex are mutually exclusive".to_string());
    }
    match resolve_secondary_consumer_target(source_id, session_id)? {
        ResolvedTarget::Imported {
            source,
            imported_session_id,
        } => with_sessions_replay_writer("replay query index", |conn| {
            if let Some(turn_id) = turn_id {
                replay::read_turn_window(conn, source, &imported_session_id, turn_id, limits)
            } else if let Some(turn_index) = turn_index {
                replay::read_turn_window_at_index(
                    conn,
                    source,
                    &imported_session_id,
                    turn_index,
                    limits,
                )
            } else {
                replay::read_window(conn, source, &imported_session_id, before_sequence, limits)
            }
            .map(BackendWindow::Imported)
        }),
        ResolvedTarget::CollaborationSnapshot => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open collaboration replay query DB: {err}"))?;
            collaboration_snapshot_read_window_from_conn(
                &conn,
                session_id,
                before_sequence,
                turn_id,
                turn_index,
                limits,
            )
            .map(BackendWindow::CollaborationSnapshot)
        }
        ResolvedTarget::LegacyChunks => {
            legacy_read_window(session_id, before_sequence, turn_id, turn_index, limits)
                .map(BackendWindow::Legacy)
        }
        ResolvedTarget::NotReady => Ok(BackendWindow::NotReady),
    }
}

fn resolve_target(source_id: &str, session_id: &str) -> Result<ResolvedTarget, String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID {
            return Err(format!(
                "Collaboration snapshot replay requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID}"
            ));
        }
        validate_collaboration_snapshot_session_id(session_id)?;
        return Ok(ResolvedTarget::CollaborationSnapshot);
    }
    if session_id.starts_with("cliagent-") {
        let session = crate::agent_sessions::cli::persistence::get_session(session_id)
            .map_err(|err| format!("load managed CLI replay target: {err}"))?
            .ok_or_else(|| format!("Managed CLI session not found: {session_id}"))?;
        if session.transcript_source
            == crate::agent_sessions::cli::native_transcript::TRANSCRIPT_SOURCE_NATIVE
        {
            let Some((binding, cli_session_id)) =
                crate::agent_sessions::cli::native_transcript::native_store_key_for_managed_session(
                    session_id,
                )
            else {
                return Ok(ResolvedTarget::NotReady);
            };
            if source_id != MANAGED_CLI_REPLAY_SOURCE_ID && source_id != binding.source {
                return Err(format!(
                    "Managed replay source mismatch: requested {source_id}, bound {}",
                    binding.source
                ));
            }
            return Ok(ResolvedTarget::Imported {
                source: ImportedHistorySourceId::parse(binding.source)?,
                imported_session_id: binding.imported_session_id(&cli_session_id),
            });
        }
        if source_id != MANAGED_CLI_REPLAY_SOURCE_ID {
            return Err(format!(
                "Readerless managed CLI sessions require sourceId={MANAGED_CLI_REPLAY_SOURCE_ID}"
            ));
        }
        return Ok(ResolvedTarget::LegacyChunks);
    }

    let source = ImportedHistorySourceId::parse(source_id)?;
    source.validate_session_id(session_id)?;
    Ok(ResolvedTarget::Imported {
        source,
        imported_session_id: session_id.to_string(),
    })
}

/// Validate only identities admitted to the primary bounded-replay registry.
/// This intentionally excludes snapshot-backed native `agentsession-*` forks,
/// whose compact index is available solely to read-only secondary consumers.
fn validate_prewarm_target_identity(source_id: &str, session_id: &str) -> Result<(), String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID {
            return Err(format!(
                "Collaboration snapshot replay requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID}"
            ));
        }
        return validate_collaboration_snapshot_session_id(session_id);
    }
    if session_id.starts_with("cliagent-") {
        return (source_id == MANAGED_CLI_REPLAY_SOURCE_ID)
            .then_some(())
            .ok_or_else(|| {
                format!("Managed prewarm requires sourceId={MANAGED_CLI_REPLAY_SOURCE_ID}")
            });
    }
    let source = ImportedHistorySourceId::parse(source_id)?;
    source.validate_session_id(session_id)
}

/// Resolve only the read-only/background consumers that are allowed to reuse
/// a Cloud fork's inherited snapshot index. Foreground open/poll/read/release
/// continue to call `resolve_target`, so a native Agent session can never
/// enter replay execution or acquire a replay watcher through this path.
fn resolve_secondary_consumer_target(
    source_id: &str,
    session_id: &str,
) -> Result<ResolvedTarget, String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_FORK_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID {
            return Err(format!(
                "Snapshot-backed native fork secondary replay requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID}"
            ));
        }
        if session_id.len() <= COLLABORATION_SNAPSHOT_FORK_PREFIX.len()
            || session_id.contains(['/', '\\'])
        {
            return Err("Invalid snapshot-backed native fork session id".to_string());
        }
        return Ok(ResolvedTarget::CollaborationSnapshot);
    }
    resolve_target(source_id, session_id)
}

fn ensure_replay_watch(
    app: &AppHandle,
    source_id: &str,
    session_id: &str,
    episode_id: u64,
    generation: Option<&str>,
) -> bool {
    match resolve_replay_watch_paths(source_id, session_id) {
        Ok(paths) => acquire_replay_watch_set(
            paths,
            |path| {
                external_replay_watcher::acquire(
                    app, source_id, session_id, episode_id, generation, path,
                )
            },
            || external_replay_watcher::release_session_if_episode(session_id, episode_id),
        ),
        Err(error) => {
            // Watchers are an optimization. A failed lookup must preserve the
            // typed `watcherAvailable=false` polling fallback, not fail replay.
            external_replay_watcher::release_session_if_episode(session_id, episode_id);
            log::debug!("[external-replay] watcher paths unavailable: {error}");
            false
        }
    }
}

fn acquire_replay_watch_set(
    mut paths: Vec<PathBuf>,
    mut acquire: impl FnMut(&PathBuf) -> bool,
    release: impl FnOnce(),
) -> bool {
    paths.sort();
    paths.dedup();
    if paths.is_empty() || !paths.iter().all(&mut acquire) {
        // All-or-nothing: advertising a healthy primary watcher while a
        // storage-specific sidecar is unwatched would suppress the renderer's
        // visible 5-second fallback and hide changes for up to 60 seconds.
        release();
        return false;
    }
    true
}

fn resolve_replay_watch_paths(source_id: &str, session_id: &str) -> Result<Vec<PathBuf>, String> {
    match resolve_target(source_id, session_id)? {
        ResolvedTarget::Imported {
            source,
            imported_session_id,
        } => {
            let conn = database::db::get_connection()
                .map_err(|error| format!("open replay watcher index DB: {error}"))?;
            replay::watch_paths(&conn, source, &imported_session_id)
        }
        ResolvedTarget::CollaborationSnapshot => Ok(vec![database::db::get_db_path()]),
        ResolvedTarget::LegacyChunks => Ok(vec![database::db::get_db_path()]),
        ResolvedTarget::NotReady => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod replay_watch_set_tests {
    use super::*;

    #[test]
    fn multi_path_acquire_deduplicates_and_succeeds_only_when_every_path_is_watched() {
        let calls = std::cell::RefCell::new(Vec::new());
        let released = std::cell::Cell::new(false);
        let ok = acquire_replay_watch_set(
            vec![
                PathBuf::from("/tmp/qoder-transcript"),
                PathBuf::from("/tmp/qoder-logs"),
                PathBuf::from("/tmp/qoder-logs"),
            ],
            |path| {
                calls.borrow_mut().push(path.clone());
                true
            },
            || released.set(true),
        );
        assert!(ok);
        assert_eq!(calls.borrow().len(), 2);
        assert!(!released.get());
    }

    #[test]
    fn partial_multi_path_failure_releases_the_session_and_forces_poll_fallback() {
        let calls = std::cell::Cell::new(0_usize);
        let released = std::cell::Cell::new(false);
        let ok = acquire_replay_watch_set(
            vec![PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b")],
            |_| {
                let next = calls.get().saturating_add(1);
                calls.set(next);
                next == 1
            },
            || released.set(true),
        );
        assert!(!ok);
        assert_eq!(calls.get(), 2);
        assert!(released.get());
    }
}

fn stream_replay_cloud_events(
    source_id: &str,
    session_id: &str,
    mut consume: impl FnMut(
        &SessionEvent,
        &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
    ) -> Result<(), String>,
) -> Result<String, String> {
    match resolve_secondary_consumer_target(source_id, session_id)? {
        ResolvedTarget::Imported {
            source,
            imported_session_id,
        } => {
            let limits = ReplayLimits {
                max_turns: 10,
                max_events: STREAM_BATCH_MAX_EVENTS,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let prepared =
                prepare_sessions_stream_replay_snapshot(source, &imported_session_id, limits)?;
            let expected_generation = prepared.generation;
            let expected_revision = prepared.revision;
            let mut payload_conn = database::db::get_connection()
                .map_err(|err| format!("open replay stream payload DB: {err}"))?;
            let mut after_sequence = -1_i64;
            loop {
                let scan = with_sessions_replay_writer("replay cloud scan", |conn| {
                    replay::scan_window_after_generation(
                        conn,
                        source,
                        &imported_session_id,
                        &expected_generation,
                        expected_revision,
                        after_sequence,
                        limits,
                    )
                })?;
                let next_sequence = scan.cursor.through_sequence;
                let has_more = scan.has_more;
                let (events, _) = normalize_indexed_chunks(
                    scan.chunks,
                    session_id,
                    source.as_str(),
                    &scan.cursor.generation,
                );
                for event in &events {
                    let mut read_payload = |payload_ref: &PayloadRef, offset: u64| {
                        replay::read_payload_range(
                            &mut payload_conn,
                            source,
                            &imported_session_id,
                            &scan.cursor.generation,
                            payload_ref
                                .replay_source_event_id
                                .as_deref()
                                .unwrap_or(&payload_ref.event_id),
                            &payload_ref.field_path,
                            offset,
                            Some(EXPORT_PAYLOAD_RANGE_BYTES),
                        )
                    };
                    consume(event, &mut read_payload)?;
                }
                if !has_more {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Replay stream cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let final_scan = with_sessions_replay_writer("replay cloud finalization", |conn| {
                replay::scan_window_after(
                    conn,
                    source,
                    &imported_session_id,
                    after_sequence,
                    ReplayLimits {
                        max_turns: 1,
                        max_events: 1,
                        max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
                    },
                )
            })?;
            validate_stream_replay_cursor(
                &expected_generation,
                expected_revision,
                &final_scan.cursor,
                "finalizing cloud replay",
            )?;
            Ok(expected_generation)
        }
        ResolvedTarget::CollaborationSnapshot => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open collaboration replay stream DB: {err}"))?;
            let state = collaboration_snapshot_state(&conn, session_id)?;
            let limits = ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: STREAM_BATCH_MAX_EVENTS,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let mut after_sequence = -1_i64;
            loop {
                let indexed = query_collaboration_snapshot_events(
                    &conn,
                    session_id,
                    &state.generation,
                    after_sequence,
                    state.max_sequence.saturating_add(1),
                    limits,
                    false,
                )?;
                if indexed.is_empty() {
                    break;
                }
                let next_sequence = indexed
                    .last()
                    .map_or(after_sequence, |(sequence, _)| *sequence);
                for (_, event) in &indexed {
                    let mut read_payload = |payload_ref: &PayloadRef, offset: u64| {
                        collaboration_snapshot_payload_range_from_conn(
                            &conn,
                            session_id,
                            &state.generation,
                            payload_ref
                                .replay_source_event_id
                                .as_deref()
                                .unwrap_or(&payload_ref.event_id),
                            &payload_ref.field_path,
                            offset,
                            EXPORT_PAYLOAD_RANGE_BYTES,
                        )
                    };
                    consume(event, &mut read_payload)?;
                }
                if next_sequence >= state.max_sequence {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Collaboration replay stream cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let current = collaboration_snapshot_state(&conn, session_id)?;
            validate_query_apply_version(
                &state.generation,
                state.revision,
                &current.generation,
                current.revision,
            )?;
            Ok(state.generation)
        }
        ResolvedTarget::LegacyChunks => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open managed replay stream DB: {err}"))?;
            stream_legacy_replay_events_from_conn(
                &conn,
                session_id,
                "streaming managed cloud replay",
                |event, read_payload| consume(event, read_payload),
            )
        }
        ResolvedTarget::NotReady => Err("Managed native transcript is not bound yet".to_string()),
    }
}

fn validate_stream_replay_cursor(
    expected_generation: &str,
    expected_revision: u64,
    current: &ReplayCursor,
    operation: &str,
) -> Result<(), String> {
    if current.generation == expected_generation && current.revision == expected_revision {
        return Ok(());
    }
    Err(format!(
        "Replay source changed while {operation}: expected {expected_generation}@{expected_revision}, found {}@{}; retry from the new replay cursor",
        current.generation, current.revision
    ))
}

#[cfg(test)]
fn replace_event_payload(event: &mut SessionEvent, field_path: &str, text: String) {
    let preview = json_field_preview(event, field_path);
    if event.display_text == preview {
        event.display_text = text.clone();
    }
    if field_path == "args" {
        event.args = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
        return;
    }
    if field_path == "result" {
        event.result = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
        return;
    }
    let Some((root, path)) = field_path.split_once('.') else {
        return;
    };
    let value = match root {
        "args" => &mut event.args,
        "result" => &mut event.result,
        _ => return,
    };
    set_json_string_path(value, path, text);
}

fn set_json_string_path(value: &mut serde_json::Value, path: &str, text: String) {
    let mut current = value;
    let mut segments = path.split('.').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            match current {
                serde_json::Value::Object(object) => {
                    object.insert(segment.to_string(), serde_json::Value::String(text));
                }
                serde_json::Value::Array(array) => {
                    let Ok(index) = segment.parse::<usize>() else {
                        return;
                    };
                    let Some(value) = array.get_mut(index) else {
                        return;
                    };
                    *value = serde_json::Value::String(text);
                }
                _ => {}
            }
            return;
        }
        current = match current {
            serde_json::Value::Object(object) => {
                let Some(next) = object.get_mut(segment) else {
                    return;
                };
                next
            }
            serde_json::Value::Array(array) => {
                let Ok(index) = segment.parse::<usize>() else {
                    return;
                };
                let Some(next) = array.get_mut(index) else {
                    return;
                };
                next
            }
            _ => return,
        };
    }
}

fn normalize_window(window: ReplayChunkWindow, session_id: &str) -> ExternalReplayWindow {
    let window_start_sequence = window.chunks.iter().map(|chunk| chunk.sequence).min();
    let (events, ipc_bytes) = normalize_indexed_chunks(
        window.chunks,
        session_id,
        &window.cursor.source_id,
        &window.cursor.generation,
    );
    let mut stats = window.stats;
    stats.normalized_events = events.len() as u64;
    stats.ipc_bytes = ipc_bytes;
    ExternalReplayWindow {
        cursor: window.cursor,
        events,
        window_start_sequence,
        turn_headers: window.turn_headers,
        total_turn_count: window.total_turn_count,
        total_event_count: window.total_event_count,
        has_older: window.has_older,
        stats,
        watcher_available: false,
    }
}

fn normalize_delta(delta: ReplayChunkDelta, session_id: &str) -> ExternalReplayDelta {
    let (events, ipc_bytes) = normalize_indexed_chunks(
        delta.chunks,
        session_id,
        &delta.cursor.source_id,
        &delta.cursor.generation,
    );
    let mut stats = delta.stats;
    stats.normalized_events = events.len() as u64;
    stats.ipc_bytes = ipc_bytes;
    ExternalReplayDelta {
        cursor: delta.cursor,
        events,
        removed_event_ids: delta.removed_event_ids,
        reset_required: delta.reset_required,
        stats,
        watcher_available: false,
    }
}

fn refresh_window_wire_bytes(response: &mut ExternalReplayWindow) -> Result<usize, String> {
    let mut candidate = 0_u64;
    for _ in 0..8 {
        response.stats.ipc_bytes = candidate;
        let measured = serde_json::to_vec(response)
            .map_err(|error| format!("serialize bounded replay window: {error}"))?
            .len() as u64;
        if measured == candidate {
            return Ok(measured as usize);
        }
        candidate = measured;
    }
    response.stats.ipc_bytes = candidate;
    let measured = serde_json::to_vec(response)
        .map_err(|error| format!("serialize bounded replay window: {error}"))?
        .len() as u64;
    response.stats.ipc_bytes = measured;
    Ok(measured as usize)
}

fn refresh_delta_wire_bytes(response: &mut ExternalReplayDelta) -> Result<usize, String> {
    let mut candidate = 0_u64;
    for _ in 0..8 {
        response.stats.ipc_bytes = candidate;
        let measured = serde_json::to_vec(response)
            .map_err(|error| format!("serialize bounded replay delta: {error}"))?
            .len() as u64;
        if measured == candidate {
            return Ok(measured as usize);
        }
        candidate = measured;
    }
    response.stats.ipc_bytes = candidate;
    let measured = serde_json::to_vec(response)
        .map_err(|error| format!("serialize bounded replay delta: {error}"))?
        .len() as u64;
    response.stats.ipc_bytes = measured;
    Ok(measured as usize)
}

fn finalize_window_wire_budget(
    response: &mut ExternalReplayWindow,
    max_ipc_bytes: usize,
) -> Result<(), String> {
    let wire_bytes = refresh_window_wire_bytes(response)?;
    if wire_bytes > max_ipc_bytes {
        return Err(format!(
            "Bounded replay window requires {wire_bytes} serialized bytes after normalization; limit is {max_ipc_bytes}. Reduce maxEvents/maxTurns or read payloads by range"
        ));
    }
    Ok(())
}

fn finalize_delta_wire_budget(
    response: &mut ExternalReplayDelta,
    max_ipc_bytes: usize,
) -> Result<(), String> {
    let wire_bytes = refresh_delta_wire_bytes(response)?;
    if wire_bytes > max_ipc_bytes {
        return Err(format!(
            "Bounded replay delta requires {wire_bytes} serialized bytes after normalization; limit is {max_ipc_bytes}. Retry with a smaller event window"
        ));
    }
    Ok(())
}

async fn persist_shell_replays_for_delivery(
    source_id: &str,
    session_id: &str,
    generation: &str,
    revision: u64,
    events: &mut Vec<SessionEvent>,
) -> Result<(), String> {
    if !events
        .iter()
        .any(|event| event.ui_canonical == core_types::tool_names::RUN_SHELL)
    {
        return Ok(());
    }
    let source_id = source_id.to_string();
    let session_id = session_id.to_string();
    let generation = generation.to_string();
    let owned = std::mem::take(events);
    *events = tokio::task::spawn_blocking(move || {
        persist_shell_replays_bounded(&source_id, &session_id, &generation, revision, owned)
    })
    .await
    .map_err(|error| format!("join external shell replay persistence: {error}"))??;
    Ok(())
}

fn persist_shell_replays_bounded(
    source_id: &str,
    session_id: &str,
    generation: &str,
    revision: u64,
    mut events: Vec<SessionEvent>,
) -> Result<Vec<SessionEvent>, String> {
    match resolve_target(source_id, session_id)? {
        ResolvedTarget::Imported {
            source,
            imported_session_id,
        } => {
            for event in events.iter_mut().filter(|event| {
                event.ui_canonical == core_types::tool_names::RUN_SHELL
                    && event.shell_replay.is_none()
            }) {
                with_sessions_replay_writer("external Shell replay", |conn| {
                    let tx = database::db::begin_immediate(conn).map_err(|error| {
                        format!("begin external Shell manifest transaction: {error}")
                    })?;
                    persist_imported_shell_manifest(
                        &tx,
                        event,
                        source,
                        &imported_session_id,
                        generation,
                    )?;
                    tx.commit()
                        .map_err(|error| format!("publish external Shell manifest: {error}"))
                })?;
            }
            validate_imported_shell_snapshot(source, &imported_session_id, generation, revision)?;
        }
        ResolvedTarget::CollaborationSnapshot => {
            // Collaboration generation identifies the snapshot lineage, while
            // same-lineage rewrites advance revision. Artifact scopes must
            // include both or a same-length UPDATE can reuse stale content.
            let artifact_generation = collaboration_shell_artifact_generation(generation, revision);
            for event in events.iter_mut().filter(|event| {
                event.ui_canonical == core_types::tool_names::RUN_SHELL
                    && event.shell_replay.is_none()
            }) {
                with_sessions_replay_writer("collaboration Shell replay", |conn| {
                    let tx = database::db::begin_immediate(conn).map_err(|error| {
                        format!("begin collaboration Shell manifest transaction: {error}")
                    })?;
                    persist_scoped_shell_manifest(
                        &tx,
                        event,
                        source_id,
                        session_id,
                        &artifact_generation,
                        |payload_ref, offset, max| {
                            collaboration_snapshot_payload_range_from_conn(
                                &tx,
                                session_id,
                                generation,
                                payload_ref
                                    .replay_source_event_id
                                    .as_deref()
                                    .unwrap_or(&payload_ref.event_id),
                                &payload_ref.field_path,
                                offset,
                                max,
                            )
                            .map(|range| range.text.into_bytes())
                        },
                    )?;
                    tx.commit()
                        .map_err(|error| format!("publish collaboration Shell manifest: {error}"))
                })?;
            }
            validate_collaboration_shell_snapshot(session_id, generation, revision)?;
        }
        ResolvedTarget::LegacyChunks => {
            for event in events.iter_mut().filter(|event| {
                event.ui_canonical == core_types::tool_names::RUN_SHELL
                    && event.shell_replay.is_none()
            }) {
                with_sessions_replay_writer("managed Shell replay", |conn| {
                    let tx = database::db::begin_immediate(conn).map_err(|error| {
                        format!("begin managed Shell manifest transaction: {error}")
                    })?;
                    persist_scoped_shell_manifest(
                        &tx,
                        event,
                        source_id,
                        session_id,
                        generation,
                        |payload_ref, offset, max| {
                            legacy_payload_range_from_conn(
                                &tx,
                                session_id,
                                payload_ref
                                    .replay_source_event_id
                                    .as_deref()
                                    .unwrap_or(&payload_ref.event_id),
                                &payload_ref.field_path,
                                offset,
                                max,
                            )
                            .map(|range| range.text.into_bytes())
                        },
                    )?;
                    tx.commit()
                        .map_err(|error| format!("publish managed Shell manifest: {error}"))
                })?;
            }
            validate_legacy_shell_snapshot(session_id, generation, revision)?;
        }
        ResolvedTarget::NotReady => {}
    }
    Ok(events)
}

fn collaboration_shell_artifact_generation(generation: &str, revision: u64) -> String {
    format!("{generation}-r{revision}")
}

fn validate_imported_shell_snapshot(
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    with_sessions_replay_writer("imported Shell validation", |conn| {
        validate_imported_shell_snapshot_from_conn(conn, source, session_id, generation, revision)
    })
}

fn validate_imported_shell_snapshot_from_conn(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    // Re-observe the provider, not merely ORGII's last compact state. A file
    // or WAL can change (including same-size replacement) while the per-event
    // artifact transactions run; a local state lookup would miss that race.
    let observed = replay::scan_window_after(
        conn,
        source,
        session_id,
        i64::MAX,
        ReplayLimits {
            max_turns: 1,
            max_events: 1,
            max_ipc_bytes: 1,
        },
    )?;
    if observed.cursor.generation == generation && observed.cursor.revision == revision {
        return Ok(());
    }
    Err(format!(
        "Imported Shell replay changed while publishing manifests: expected {generation}@{revision}, found {}@{}; retry the bounded replay request",
        observed.cursor.generation, observed.cursor.revision
    ))
}

fn validate_collaboration_shell_snapshot(
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open collaboration Shell validation DB: {error}"))?;
    let current = collaboration_snapshot_state(&conn, session_id)?;
    if current.generation == generation && current.revision == revision {
        return Ok(());
    }
    Err(format!(
        "Collaboration Shell replay changed while publishing manifests: expected {generation}@{revision}, found {}@{}; retry the bounded replay request",
        current.generation, current.revision
    ))
}

fn validate_legacy_shell_snapshot(
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open managed Shell validation DB: {error}"))?;
    let current = legacy_stream_cursor(&conn, session_id)?;
    if current.0 == generation && current.1.max(0) as u64 == revision {
        return Ok(());
    }
    Err(format!(
        "Managed Shell replay changed while publishing manifests: expected {generation}@{revision}, found {}@{}; retry the bounded replay request",
        current.0, current.1
    ))
}

#[derive(Debug, Clone)]
struct CanonicalExternalShellSegment {
    stream: ShellReplayStream,
    artifact: replay::ReplayPayloadArtifactLocator,
    preview: String,
}

fn persist_imported_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    if event.ui_canonical != core_types::tool_names::RUN_SHELL || event.shell_replay.is_some() {
        return Ok(());
    }
    let selected = select_shell_payload_refs(event);
    if selected.is_empty() {
        let source_session_id = source.source_session_id(imported_session_id)?;
        return persist_inline_shell_manifest(
            tx,
            event,
            source.as_str(),
            source_session_id,
            generation,
        );
    }
    let mut segments = Vec::with_capacity(selected.len());
    for payload_ref in selected {
        let source_event_id = payload_ref
            .replay_source_event_id
            .as_deref()
            .unwrap_or(&payload_ref.event_id);
        let artifact = replay::materialize_payload_artifact(
            tx,
            source,
            imported_session_id,
            generation,
            source_event_id,
            &payload_ref.field_path,
        )?;
        if artifact.total_bytes != payload_ref.full_size_bytes as u64 {
            return Err(format!(
                "External Shell payload changed while publishing manifest: expected {} bytes, found {}",
                payload_ref.full_size_bytes, artifact.total_bytes
            ));
        }
        segments.push(CanonicalExternalShellSegment {
            stream: shell_stream_for_payload_ref(payload_ref),
            artifact,
            preview: payload_ref.preview.clone(),
        });
    }
    publish_external_shell_manifest(tx, event, &segments)
}

fn persist_scoped_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    mut read_range: impl FnMut(&PayloadRef, u64, usize) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    if event.ui_canonical != core_types::tool_names::RUN_SHELL || event.shell_replay.is_some() {
        return Ok(());
    }
    let selected = select_shell_payload_refs(event);
    if selected.is_empty() {
        return persist_inline_shell_manifest(tx, event, source_id, source_session_id, generation);
    }
    let mut segments = Vec::with_capacity(selected.len());
    for payload_ref in selected {
        let source_event_id = payload_ref
            .replay_source_event_id
            .as_deref()
            .unwrap_or(&payload_ref.event_id);
        let expected_bytes = payload_ref.full_size_bytes as u64;
        let artifact = if let Some(existing) = replay::find_scoped_payload_artifact(
            tx,
            source_id,
            source_session_id,
            generation,
            source_event_id,
            &payload_ref.field_path,
            expected_bytes,
        )? {
            existing
        } else {
            replay::store_scoped_payload_artifact_streamed(
                tx,
                source_id,
                source_session_id,
                generation,
                source_event_id,
                &payload_ref.field_path,
                expected_bytes,
                |writer| {
                    let mut offset = 0_u64;
                    while offset < expected_bytes {
                        let requested = (expected_bytes - offset)
                            .min(SHELL_REPLAY_RANGE_MAX_BYTES as u64)
                            as usize;
                        let bytes = read_range(payload_ref, offset, requested)?;
                        if bytes.is_empty() || bytes.len() > requested {
                            return Err(format!(
                                "External Shell payload made invalid progress at byte {offset}"
                            ));
                        }
                        writer
                            .write_all(&bytes)
                            .map_err(|error| format!("write external Shell payload: {error}"))?;
                        offset = offset.saturating_add(bytes.len() as u64);
                    }
                    Ok(())
                },
            )?
        };
        segments.push(CanonicalExternalShellSegment {
            stream: shell_stream_for_payload_ref(payload_ref),
            artifact,
            preview: payload_ref.preview.clone(),
        });
    }
    publish_external_shell_manifest(tx, event, &segments)
}

fn persist_inline_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    if event
        .payload_refs
        .iter()
        .any(|payload_ref| payload_ref.field_path == "result")
    {
        return Ok(());
    }
    let parts = external_shell_inline_segments(event);
    if parts.is_empty() {
        return Ok(());
    }
    let mut segments = Vec::with_capacity(parts.len());
    for (ordinal, part) in parts.into_iter().enumerate() {
        let field_path = format!("__shell_inline.{ordinal}");
        let expected_bytes = part.text.len() as u64;
        let artifact = if let Some(existing) = replay::find_scoped_payload_artifact(
            tx,
            source_id,
            source_session_id,
            generation,
            &event.id,
            &field_path,
            expected_bytes,
        )? {
            existing
        } else {
            replay::store_scoped_payload_artifact_streamed(
                tx,
                source_id,
                source_session_id,
                generation,
                &event.id,
                &field_path,
                expected_bytes,
                |writer| {
                    writer
                        .write_all(part.text.as_bytes())
                        .map_err(|error| format!("write inline external Shell payload: {error}"))
                },
            )?
        };
        segments.push(CanonicalExternalShellSegment {
            stream: part.stream,
            artifact,
            preview: utf8_tail_preview(part.text, SHELL_REPLAY_PREVIEW_BYTES),
        });
    }
    publish_external_shell_manifest(tx, event, &segments)
}

fn shell_stream_for_payload_ref(payload_ref: &PayloadRef) -> ShellReplayStream {
    if payload_ref
        .field_path
        .rsplit('.')
        .next()
        .is_some_and(|field| field.eq_ignore_ascii_case("stderr"))
    {
        ShellReplayStream::Stderr
    } else {
        ShellReplayStream::Stdout
    }
}

fn publish_external_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    segments: &[CanonicalExternalShellSegment],
) -> Result<(), String> {
    if segments.is_empty() {
        return Ok(());
    }
    let logical_call_id = event.call_id.as_deref().unwrap_or(&event.id);
    let mut identity = Sha256::new();
    identity.update(b"orgii-external-shell-manifest-v1\0");
    let mut total_bytes = 0_u64;
    let mut last_sequence = 0_u64;
    let mut manifest_rows = Vec::with_capacity(segments.len());
    let mut preview = String::new();
    for (ordinal, segment) in segments.iter().enumerate() {
        let stream_tag = match segment.stream {
            ShellReplayStream::Stdout => 1_u8,
            ShellReplayStream::Stderr => 2_u8,
        };
        identity.update((ordinal as u64).to_le_bytes());
        identity.update([stream_tag]);
        identity.update(segment.artifact.total_bytes.to_le_bytes());
        identity.update(segment.artifact.content_hash.as_bytes());

        let output_byte_start = total_bytes;
        total_bytes = total_bytes
            .checked_add(segment.artifact.total_bytes)
            .ok_or_else(|| "External Shell manifest byte count overflow".to_string())?;
        let frame_count = segment
            .artifact
            .total_bytes
            .saturating_add(SHELL_REPLAY_FRAME_MAX_BYTES as u64 - 1)
            / SHELL_REPLAY_FRAME_MAX_BYTES as u64;
        let first_sequence = last_sequence.saturating_add(1);
        last_sequence = last_sequence
            .checked_add(frame_count)
            .ok_or_else(|| "External Shell manifest sequence overflow".to_string())?;
        manifest_rows.push((
            ordinal as u64,
            segment,
            output_byte_start,
            first_sequence,
            frame_count,
        ));

        if segment.stream == ShellReplayStream::Stderr {
            preview.push_str("[stderr] ");
        }
        preview.push_str(&segment.preview);
        if preview.len() > SHELL_REPLAY_PREVIEW_BYTES * 2 {
            preview = utf8_tail_preview(&preview, SHELL_REPLAY_PREVIEW_BYTES);
        }
    }
    preview = utf8_tail_preview(&preview, SHELL_REPLAY_PREVIEW_BYTES);
    let identity_hash = identity
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let call_id = format!("{logical_call_id}-external-{identity_hash}");

    let existing_identity = tx
        .query_row(
            "SELECT call_id,identity_hash
             FROM imported_replay_shell_manifests
             WHERE session_id=?1 AND logical_call_id=?2",
            params![event.session_id, logical_call_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("read existing external Shell identity: {error}"))?;
    if let Some((existing_call_id, existing_hash)) = existing_identity.as_ref() {
        if existing_hash == &identity_hash {
            if existing_call_id != &call_id {
                return Err("external Shell manifest identity/call id mismatch".to_string());
            }
            tx.execute(
                "UPDATE imported_replay_shell_manifests
                 SET accessed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE session_id=?1 AND call_id=?2
                   AND accessed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')",
                params![event.session_id, call_id],
            )
            .map_err(|error| format!("touch unchanged external Shell manifest: {error}"))?;
            set_external_shell_state(event, call_id, total_bytes, last_sequence, preview);
            return Ok(());
        }
    }

    let old_scopes = {
        let mut statement = tx
            .prepare(
                "SELECT DISTINCT segment.source,segment.source_session_id,segment.generation
                 FROM imported_replay_shell_segments AS segment
                 JOIN imported_replay_shell_manifests AS manifest
                   ON manifest.session_id=segment.session_id AND manifest.call_id=segment.call_id
                 WHERE manifest.session_id=?1 AND manifest.logical_call_id=?2",
            )
            .map_err(|error| format!("prepare old Shell manifest scopes: {error}"))?;
        let rows = statement
            .query_map(params![event.session_id, logical_call_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("query old Shell manifest scopes: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("read old Shell manifest scopes: {error}"))?
    };
    // sessions.db and orgtrack-cli connections do not globally enable
    // foreign_keys, so ON DELETE CASCADE is documentation rather than a
    // cleanup guarantee. Delete the old references explicitly before their
    // manifest; otherwise they retain obsolete content-addressed BLOBs.
    if let Some((old_call_id, _)) = existing_identity.as_ref() {
        tx.execute(
            "DELETE FROM imported_replay_shell_segments
             WHERE session_id=?1 AND call_id=?2",
            params![event.session_id, old_call_id],
        )
        .map_err(|error| format!("delete replaced external Shell segments: {error}"))?;
    }
    tx.execute(
        "DELETE FROM imported_replay_shell_manifests
         WHERE session_id=?1 AND logical_call_id=?2",
        params![event.session_id, logical_call_id],
    )
    .map_err(|error| format!("replace external Shell manifest: {error}"))?;
    tx.execute(
        "INSERT INTO imported_replay_shell_manifests(
             session_id,logical_call_id,call_id,identity_hash,total_bytes,last_sequence,
             terminal_preview,completed_at,accessed_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,
                  strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            event.session_id,
            logical_call_id,
            call_id,
            identity_hash,
            i64::try_from(total_bytes)
                .map_err(|_| "External Shell manifest exceeds SQLite INTEGER".to_string())?,
            i64::try_from(last_sequence)
                .map_err(|_| "External Shell sequence exceeds SQLite INTEGER".to_string())?,
            preview,
            event.created_at,
        ],
    )
    .map_err(|error| format!("insert external Shell manifest: {error}"))?;
    for (ordinal, segment, output_byte_start, first_sequence, frame_count) in manifest_rows {
        tx.execute(
            "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,generation,
                 content_hash,output_byte_start,total_bytes,first_sequence,frame_count
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                event.session_id,
                call_id,
                i64::try_from(ordinal)
                    .map_err(|_| "External Shell segment ordinal overflow".to_string())?,
                segment.stream.as_wire_str(),
                segment.artifact.source_id,
                segment.artifact.source_session_id,
                segment.artifact.generation,
                segment.artifact.content_hash,
                i64::try_from(output_byte_start)
                    .map_err(|_| "External Shell output offset overflow".to_string())?,
                i64::try_from(segment.artifact.total_bytes)
                    .map_err(|_| "External Shell segment size overflow".to_string())?,
                i64::try_from(first_sequence)
                    .map_err(|_| "External Shell first sequence overflow".to_string())?,
                i64::try_from(frame_count)
                    .map_err(|_| "External Shell frame count overflow".to_string())?,
            ],
        )
        .map_err(|error| format!("insert external Shell segment: {error}"))?;
    }

    let mut cleanup_scopes = old_scopes.into_iter().collect::<HashSet<_>>();
    cleanup_scopes.extend(segments.iter().map(|segment| {
        (
            segment.artifact.source_id.clone(),
            segment.artifact.source_session_id.clone(),
            segment.artifact.generation.clone(),
        )
    }));
    for (source, source_session_id, generation) in cleanup_scopes {
        delete_unreferenced_payload_artifacts(tx, &source, &source_session_id, &generation)?;
    }

    set_external_shell_state(event, call_id, total_bytes, last_sequence, preview);
    Ok(())
}

fn set_external_shell_state(
    event: &mut SessionEvent,
    call_id: String,
    total_bytes: u64,
    last_sequence: u64,
    terminal_preview: String,
) {
    event.shell_replay = Some(ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: event.session_id.clone(),
            call_id,
            format_version: SHELL_REPLAY_FORMAT_VERSION,
        },
        bookmark: ShellReplayBookmark {
            visible_through_sequence: last_sequence,
            visible_bytes: total_bytes,
        },
        terminal_preview,
        status: ShellReplayStatus::Complete,
        error: None,
        completed_at: Some(event.created_at.clone()),
    });
}

fn delete_unreferenced_payload_artifacts(
    tx: &Transaction<'_>,
    source: &str,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_payload_artifacts AS artifact
         WHERE artifact.source=?1 AND artifact.source_session_id=?2 AND artifact.generation=?3
           AND NOT EXISTS(
             SELECT 1 FROM imported_replay_payload_artifact_refs AS ref
             WHERE ref.source=artifact.source
               AND ref.source_session_id=artifact.source_session_id
               AND ref.generation=artifact.generation
               AND ref.content_hash=artifact.content_hash
           )
           AND NOT EXISTS(
             SELECT 1 FROM imported_replay_shell_segments AS shell
             WHERE shell.source=artifact.source
               AND shell.source_session_id=artifact.source_session_id
               AND shell.generation=artifact.generation
               AND shell.content_hash=artifact.content_hash
           )",
        params![source, source_session_id, generation],
    )
    .map(|_| ())
    .map_err(|error| format!("delete unreferenced external Shell payload: {error}"))
}

#[derive(Debug)]
struct ExternalShellManifestSegment {
    stream: ShellReplayStream,
    artifact_row_id: i64,
    output_byte_start: u64,
    total_bytes: u64,
    first_sequence: u64,
    frame_count: u64,
}

/// Read an external-CLI Shell manifest when one exists, otherwise preserve
/// the native SDE Agent's #425 `.slog` command unchanged. An invalid external
/// manifest is an error: silently falling through could surface a stale native
/// replay with the same logical call id.
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn shell_replay_read_range(
    session_id: String,
    call_id: String,
    visible_through_sequence: u64,
    visible_bytes: u64,
    offset_bytes: u64,
    limit_bytes: u64,
) -> Result<ShellReplayRange, String> {
    // Native #425 replay is a high-frequency range path. Its call ids never
    // carry the content-addressed external suffix, so bypass both the extra
    // task and the replay-cache connection entirely.
    if !is_external_shell_manifest_call_id(&call_id) {
        return agent_core::tools::impls::coding::exec::shell_replay::shell_replay_read_range(
            session_id,
            call_id,
            visible_through_sequence,
            visible_bytes,
            offset_bytes,
            limit_bytes,
        )
        .await;
    }
    let external_session_id = session_id.clone();
    let external_call_id = call_id.clone();
    #[cfg(test)]
    EXTERNAL_SHELL_MANIFEST_DB_PROBES.fetch_add(1, Ordering::SeqCst);
    let external = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection()
            .map_err(|error| format!("open external Shell replay DB: {error}"))?;
        read_external_shell_manifest_range(
            &conn,
            &external_session_id,
            &external_call_id,
            visible_through_sequence,
            visible_bytes,
            offset_bytes,
            limit_bytes,
        )
    })
    .await
    .map_err(|error| format!("join external Shell range read: {error}"))??;
    if let Some(range) = external {
        return Ok(range);
    }
    agent_core::tools::impls::coding::exec::shell_replay::shell_replay_read_range(
        session_id,
        call_id,
        visible_through_sequence,
        visible_bytes,
        offset_bytes,
        limit_bytes,
    )
    .await
}

fn is_external_shell_manifest_call_id(call_id: &str) -> bool {
    let Some((_, digest)) = call_id.rsplit_once("-external-") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[allow(clippy::too_many_arguments)]
fn read_external_shell_manifest_range(
    conn: &Connection,
    session_id: &str,
    call_id: &str,
    visible_through_sequence: u64,
    visible_bytes: u64,
    offset_bytes: u64,
    limit_bytes: u64,
) -> Result<Option<ShellReplayRange>, String> {
    let manifest_table_exists = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type='table' AND name='imported_replay_shell_manifests'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("inspect external Shell replay schema: {error}"))?;
    if !manifest_table_exists {
        return Ok(None);
    }
    let manifest = conn
        .query_row(
            "SELECT total_bytes,last_sequence
             FROM imported_replay_shell_manifests
             WHERE session_id=?1 AND call_id=?2",
            params![session_id, call_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("read external Shell manifest: {error}"))?;
    let Some((manifest_total, manifest_last_sequence)) = manifest else {
        return Ok(None);
    };
    let manifest_total = nonnegative_sqlite_u64(manifest_total, "manifest total_bytes")?;
    let manifest_last_sequence =
        nonnegative_sqlite_u64(manifest_last_sequence, "manifest last_sequence")?;

    // Acquire cache liveness before opening any artifact BLOB. Cache pruning
    // performs selection and deletion under one IMMEDIATE transaction, so
    // this conditional write and prune have a clear lock order: either this
    // read protects the manifest first, or it observes that prune removed it.
    // Failed/corrupt read attempts may retain a small entry for one TTL; that
    // is preferable to deleting a payload while a reader is opening it.
    conn.execute(
        "UPDATE imported_replay_shell_manifests
         SET accessed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE session_id=?1 AND call_id=?2
           AND accessed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')",
        params![session_id, call_id],
    )
    .map_err(|error| format!("touch external Shell manifest: {error}"))?;

    let mut statement = conn
        .prepare(
            "SELECT segment.ordinal,segment.stream,segment.output_byte_start,
                    segment.total_bytes,segment.first_sequence,segment.frame_count,
                    artifact.rowid,LENGTH(artifact.payload)
             FROM imported_replay_shell_segments AS segment
             LEFT JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=segment.source
              AND artifact.source_session_id=segment.source_session_id
              AND artifact.generation=segment.generation
              AND artifact.content_hash=segment.content_hash
             WHERE segment.session_id=?1 AND segment.call_id=?2
             ORDER BY segment.ordinal ASC",
        )
        .map_err(|error| format!("prepare external Shell segments: {error}"))?;
    let rows = statement
        .query_map(params![session_id, call_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|error| format!("query external Shell segments: {error}"))?;
    let raw_segments = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("read external Shell segments: {error}"))?;
    drop(statement);

    let mut segments = Vec::with_capacity(raw_segments.len());
    let mut expected_output_start = 0_u64;
    let mut expected_first_sequence = 1_u64;
    for (expected_ordinal, row) in raw_segments.into_iter().enumerate() {
        let (
            ordinal,
            stream,
            output_byte_start,
            total_bytes,
            first_sequence,
            frame_count,
            artifact_row_id,
            artifact_bytes,
        ) = row;
        let ordinal = nonnegative_sqlite_u64(ordinal, "segment ordinal")?;
        if ordinal != expected_ordinal as u64 {
            return Err(format!(
                "invalid external Shell segment ordinal {ordinal}; expected {expected_ordinal}"
            ));
        }
        let stream = match stream.as_str() {
            "stdout" => ShellReplayStream::Stdout,
            "stderr" => ShellReplayStream::Stderr,
            other => return Err(format!("invalid external Shell stream {other:?}")),
        };
        let output_byte_start =
            nonnegative_sqlite_u64(output_byte_start, "segment output_byte_start")?;
        let total_bytes = nonnegative_sqlite_u64(total_bytes, "segment total_bytes")?;
        let first_sequence = nonnegative_sqlite_u64(first_sequence, "segment first_sequence")?;
        let frame_count = nonnegative_sqlite_u64(frame_count, "segment frame_count")?;
        let expected_frame_count = total_bytes
            .saturating_add(SHELL_REPLAY_FRAME_MAX_BYTES as u64 - 1)
            / SHELL_REPLAY_FRAME_MAX_BYTES as u64;
        if output_byte_start != expected_output_start
            || first_sequence != expected_first_sequence
            || frame_count != expected_frame_count
        {
            return Err(format!(
                "invalid external Shell segment layout at ordinal {ordinal}"
            ));
        }
        let artifact_row_id = artifact_row_id.ok_or_else(|| {
            format!("external Shell payload artifact missing at ordinal {ordinal}")
        })?;
        let artifact_bytes = nonnegative_sqlite_u64(
            artifact_bytes.ok_or_else(|| {
                format!("external Shell payload length missing at ordinal {ordinal}")
            })?,
            "artifact payload length",
        )?;
        if artifact_bytes != total_bytes {
            return Err(format!(
                "external Shell payload length mismatch at ordinal {ordinal}: expected {total_bytes}, found {artifact_bytes}"
            ));
        }
        segments.push(ExternalShellManifestSegment {
            stream,
            artifact_row_id,
            output_byte_start,
            total_bytes,
            first_sequence,
            frame_count,
        });
        expected_output_start = expected_output_start
            .checked_add(total_bytes)
            .ok_or_else(|| "external Shell output byte count overflow".to_string())?;
        expected_first_sequence = expected_first_sequence
            .checked_add(frame_count)
            .ok_or_else(|| "external Shell sequence overflow".to_string())?;
    }
    if expected_output_start != manifest_total
        || expected_first_sequence.saturating_sub(1) != manifest_last_sequence
    {
        return Err("external Shell manifest summary does not match its segments".to_string());
    }

    let visible_sequence = visible_through_sequence.min(manifest_last_sequence);
    let visible_end = visible_bytes.min(manifest_total);
    let start = offset_bytes.min(visible_end);
    let limit = limit_bytes.min(SHELL_REPLAY_RANGE_MAX_BYTES as u64).max(1);
    let range = if start >= visible_end || visible_sequence == 0 {
        ShellReplayRange {
            frames: Vec::new(),
            next_offset_bytes: start,
            eof: true,
        }
    } else {
        read_external_shell_frames(conn, &segments, visible_sequence, visible_end, start, limit)?
    };

    Ok(Some(range))
}

fn read_external_shell_frames(
    conn: &Connection,
    segments: &[ExternalShellManifestSegment],
    visible_sequence: u64,
    visible_end: u64,
    start: u64,
    limit: u64,
) -> Result<ShellReplayRange, String> {
    let tail_request = start.saturating_add(limit) >= visible_end;
    let mut frames = Vec::new();
    let mut next_offset = start;
    let mut response_bytes = 0_u64;
    let mut rendered_response_bytes = 0_usize;
    'segments: for segment in segments {
        let segment_end = segment
            .output_byte_start
            .checked_add(segment.total_bytes)
            .ok_or_else(|| "external Shell segment end overflow".to_string())?;
        if segment_end <= start || segment.output_byte_start >= visible_end {
            continue;
        }
        let blob = conn
            .blob_open(
                DatabaseName::Main,
                "imported_replay_payload_artifacts",
                "payload",
                segment.artifact_row_id,
                true,
            )
            .map_err(|error| format!("open external Shell payload BLOB: {error}"))?;
        if blob.len() as u64 != segment.total_bytes {
            return Err("external Shell payload changed after manifest validation".to_string());
        }
        let local_start = start.saturating_sub(segment.output_byte_start);
        let mut frame_index = (local_start / SHELL_REPLAY_FRAME_MAX_BYTES as u64)
            .saturating_sub(1)
            .min(segment.frame_count.saturating_sub(1));
        while frame_index < segment.frame_count {
            let sequence = segment
                .first_sequence
                .checked_add(frame_index)
                .ok_or_else(|| "external Shell frame sequence overflow".to_string())?;
            if sequence > visible_sequence {
                break 'segments;
            }
            let candidate_start = frame_index
                .checked_mul(SHELL_REPLAY_FRAME_MAX_BYTES as u64)
                .ok_or_else(|| "external Shell frame offset overflow".to_string())?;
            let candidate_end = frame_index
                .saturating_add(1)
                .saturating_mul(SHELL_REPLAY_FRAME_MAX_BYTES as u64)
                .min(segment.total_bytes);
            let local_frame_start =
                external_shell_utf8_boundary(&blob, candidate_start, segment.total_bytes)?;
            let local_frame_end =
                external_shell_utf8_boundary(&blob, candidate_end, segment.total_bytes)?;
            if local_frame_end <= local_frame_start {
                return Err("external Shell UTF-8 frame made no progress".to_string());
            }
            let frame_start = segment
                .output_byte_start
                .checked_add(local_frame_start)
                .ok_or_else(|| "external Shell frame start overflow".to_string())?;
            let frame_end = segment
                .output_byte_start
                .checked_add(local_frame_end)
                .ok_or_else(|| "external Shell frame end overflow".to_string())?;
            frame_index = frame_index.saturating_add(1);
            if frame_end <= start {
                continue;
            }
            if frame_start >= visible_end || frame_end > visible_end {
                break 'segments;
            }
            if tail_request
                && frame_start < start
                && frame_end < visible_end
                && visible_end.saturating_sub(frame_start) > limit
            {
                continue;
            }
            let frame_bytes = frame_end.saturating_sub(frame_start);
            if !frames.is_empty() && response_bytes.saturating_add(frame_bytes) > limit {
                break 'segments;
            }
            let frame_len = usize::try_from(local_frame_end - local_frame_start)
                .map_err(|_| "external Shell frame exceeds address space".to_string())?;
            if frame_len > SHELL_REPLAY_FRAME_MAX_BYTES + 3 {
                return Err("external Shell UTF-8 frame exceeds its hard bound".to_string());
            }
            let mut payload = vec![0_u8; frame_len];
            blob.read_at_exact(
                &mut payload,
                usize::try_from(local_frame_start).map_err(|_| {
                    "external Shell payload offset exceeds address space".to_string()
                })?,
            )
            .map_err(|error| format!("read external Shell payload BLOB: {error}"))?;
            let text = String::from_utf8(payload)
                .map_err(|_| "external Shell payload is not valid UTF-8".to_string())?;
            if !frames.is_empty()
                && rendered_response_bytes.saturating_add(text.len()) > SHELL_REPLAY_RANGE_MAX_BYTES
            {
                break 'segments;
            }
            rendered_response_bytes = rendered_response_bytes.saturating_add(text.len());
            response_bytes = response_bytes.saturating_add(frame_bytes);
            next_offset = frame_end;
            frames.push(ShellReplayFrame {
                sequence,
                stream: segment.stream.as_wire_str().to_string(),
                byte_start: frame_start,
                byte_end: frame_end,
                text,
            });
            if next_offset >= visible_end || response_bytes >= limit {
                break;
            }
        }
        if next_offset >= visible_end || response_bytes >= limit {
            break;
        }
    }
    Ok(ShellReplayRange {
        frames,
        next_offset_bytes: next_offset,
        eof: next_offset >= visible_end,
    })
}

fn external_shell_utf8_boundary(
    blob: &rusqlite::blob::Blob<'_>,
    candidate: u64,
    total_bytes: u64,
) -> Result<u64, String> {
    if candidate == 0 || candidate >= total_bytes {
        return Ok(candidate.min(total_bytes));
    }
    let mut boundary = candidate;
    let mut byte = [0_u8; 1];
    blob.read_at_exact(
        &mut byte,
        usize::try_from(boundary)
            .map_err(|_| "external Shell UTF-8 boundary exceeds address space".to_string())?,
    )
    .map_err(|error| format!("read external Shell UTF-8 boundary: {error}"))?;
    if byte[0] & 0b1100_0000 != 0b1000_0000 {
        return Ok(boundary);
    }
    for _ in 0..3 {
        boundary = boundary
            .checked_sub(1)
            .ok_or_else(|| "invalid external Shell UTF-8 prefix".to_string())?;
        blob.read_at_exact(
            &mut byte,
            usize::try_from(boundary)
                .map_err(|_| "external Shell UTF-8 boundary exceeds address space".to_string())?,
        )
        .map_err(|error| format!("read external Shell UTF-8 boundary: {error}"))?;
        if byte[0] & 0b1100_0000 != 0b1000_0000 {
            return Ok(boundary);
        }
    }
    Err("external Shell payload has an invalid UTF-8 boundary".to_string())
}

fn nonnegative_sqlite_u64(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("invalid negative external Shell {label}: {value}"))
}

fn select_shell_payload_refs(event: &SessionEvent) -> Vec<&PayloadRef> {
    let result_refs = event
        .payload_refs
        .iter()
        .filter(|payload_ref| payload_ref.field_path.starts_with("result."))
        .collect::<Vec<_>>();
    let suffix = |payload_ref: &PayloadRef, names: &[&str]| {
        payload_ref
            .field_path
            .rsplit('.')
            .next()
            .is_some_and(|field| names.iter().any(|name| field.eq_ignore_ascii_case(name)))
    };
    if let Some(interleaved) = result_refs
        .iter()
        .find(|payload_ref| suffix(payload_ref, &["interleavedOutput", "aggregated_output"]))
    {
        return vec![*interleaved];
    }
    let mut split_streams = result_refs
        .iter()
        .filter(|payload_ref| suffix(payload_ref, &["stdout", "stderr"]))
        .copied()
        .collect::<Vec<_>>();
    if !split_streams.is_empty() {
        split_streams.sort_by_key(|payload_ref| {
            usize::from(
                payload_ref
                    .field_path
                    .rsplit('.')
                    .next()
                    .is_some_and(|field| field.eq_ignore_ascii_case("stderr")),
            )
        });
        return split_streams;
    }
    for name in ["output", "observation", "content"] {
        if let Some(payload_ref) = result_refs
            .iter()
            .find(|payload_ref| suffix(payload_ref, &[name]))
        {
            return vec![*payload_ref];
        }
    }
    Vec::new()
}

fn normalize_indexed_chunks(
    indexed: Vec<ReplayIndexedChunk>,
    session_id: &str,
    replay_source_id: &str,
    replay_generation: &str,
) -> (Vec<SessionEvent>, u64) {
    let payloads = indexed
        .iter()
        .map(|indexed| {
            (
                indexed.chunk.chunk_id.clone(),
                (indexed.chunk.chunk_id.clone(), indexed.payloads.clone()),
            )
        })
        .collect::<HashMap<_, _>>();
    let raw = indexed
        .into_iter()
        .map(|indexed| activity_to_raw(indexed.chunk))
        .collect::<Vec<_>>();
    let mut events = ingestion::ingest_raw_chunks(&raw, session_id).events;
    for event in &mut events {
        let source_payloads = event
            .chunk_id
            .as_ref()
            .and_then(|chunk_id| payloads.get(chunk_id))
            .or_else(|| payloads.get(&event.id));
        let Some((source_event_id, descriptors)) = source_payloads else {
            continue;
        };
        for descriptor in descriptors {
            event.payload_refs.push(PayloadRef {
                event_id: event.id.clone(),
                field_path: descriptor.field_path.clone(),
                preview: json_field_preview(event, &descriptor.field_path),
                full_size_bytes: descriptor.total_bytes.min(usize::MAX as u64) as usize,
                truncated: true,
                replay_encoding: Some(match descriptor.resolved_encoding() {
                    ReplayPayloadEncoding::JsonValue => PayloadRefEncoding::JsonValue,
                    ReplayPayloadEncoding::Utf8Text => PayloadRefEncoding::Utf8Text,
                    ReplayPayloadEncoding::LegacyPathInferred => {
                        unreachable!("resolved replay payload encoding cannot remain legacy")
                    }
                }),
                replay_source_id: Some(replay_source_id.to_string()),
                replay_generation: Some(replay_generation.to_string()),
                replay_source_event_id: Some(source_event_id.clone()),
            });
        }
    }
    let ipc_bytes = serde_json::to_vec(&events).map_or(0, |bytes| bytes.len()) as u64;
    (events, ipc_bytes)
}

fn activity_to_raw(chunk: ActivityChunk) -> RawActivityChunk {
    RawActivityChunk {
        chunk_id: Some(chunk.chunk_id),
        session_id: Some(chunk.session_id),
        action_type: Some(chunk.action_type),
        function: Some(chunk.function),
        args: Some(chunk.args),
        result: Some(chunk.result),
        created_at: Some(chunk.created_at),
        thread_id: chunk.thread_id,
        process_id: chunk.process_id,
        call_id: None,
    }
}

fn json_field_preview(event: &SessionEvent, field_path: &str) -> String {
    let (root, path) = field_path.split_once('.').unwrap_or((field_path, ""));
    let mut value = match root {
        "args" => &event.args,
        "result" => &event.result,
        _ => return String::new(),
    };
    for segment in path.split('.').filter(|segment| !segment.is_empty()) {
        value = match value {
            serde_json::Value::Object(object) => match object.get(segment) {
                Some(next) => next,
                None => return String::new(),
            },
            serde_json::Value::Array(array) => {
                let Ok(index) = segment.parse::<usize>() else {
                    return String::new();
                };
                match array.get(index) {
                    Some(next) => next,
                    None => return String::new(),
                }
            }
            _ => return String::new(),
        };
    }
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn remap_cursor(cursor: &mut ReplayCursor, source_id: &str, session_id: &str) {
    cursor.source_id = source_id.to_string();
    cursor.session_id = session_id.to_string();
}

fn validate_display_cursor(
    source_id: &str,
    session_id: &str,
    cursor: &ReplayCursor,
) -> Result<(), String> {
    if cursor.source_id != source_id || cursor.session_id != session_id {
        return Err("Replay cursor belongs to another display session".to_string());
    }
    Ok(())
}

fn not_ready_window(source_id: &str, session_id: &str) -> ExternalReplayWindow {
    ExternalReplayWindow {
        cursor: ReplayCursor {
            source_id: source_id.to_string(),
            session_id: session_id.to_string(),
            generation: "pending".to_string(),
            revision: 0,
            through_sequence: -1,
        },
        events: Vec::new(),
        window_start_sequence: None,
        turn_headers: Vec::new(),
        total_turn_count: 0,
        total_event_count: 0,
        has_older: false,
        stats: ReplayStats {
            not_ready: true,
            ..ReplayStats::default()
        },
        watcher_available: false,
    }
}

fn not_ready_delta(source_id: &str, session_id: &str) -> ExternalReplayDelta {
    ExternalReplayDelta {
        cursor: not_ready_window(source_id, session_id).cursor,
        events: Vec::new(),
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats {
            not_ready: true,
            ..ReplayStats::default()
        },
        watcher_available: false,
    }
}

fn session_events_equal(left: &SessionEvent, right: &SessionEvent) -> bool {
    serde_json::to_vec(left).ok() == serde_json::to_vec(right).ok()
}

const REPLAY_REQUEST_EPOCH_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_REPLAY_REQUEST_EPOCHS: usize = 64;
const PREWARM_REQUEST_EPOCH_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PREWARM_REQUEST_EPOCHS: usize = 64;

#[derive(Debug, Clone, Copy)]
struct ReplayRequestEpoch {
    value: u64,
    episode_id: u64,
    touched_at: Instant,
}

#[derive(Debug, Clone, Copy)]
struct PrewarmRequestEpoch {
    value: u64,
    episode_id: u64,
    active: bool,
    touched_at: Instant,
}

fn replay_request_epochs() -> &'static Mutex<HashMap<String, ReplayRequestEpoch>> {
    static EPOCHS: OnceLock<Mutex<HashMap<String, ReplayRequestEpoch>>> = OnceLock::new();
    EPOCHS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prewarm_request_epochs() -> &'static Mutex<HashMap<String, PrewarmRequestEpoch>> {
    static EPOCHS: OnceLock<Mutex<HashMap<String, PrewarmRequestEpoch>>> = OnceLock::new();
    EPOCHS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_prewarm_request(session_id: &str, episode_id: u64) -> Result<u64, String> {
    static NEXT_EPOCH: AtomicU64 = AtomicU64::new(0);
    let now = Instant::now();
    let mut epochs = prewarm_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    epochs.retain(|_, entry| now.duration_since(entry.touched_at) < PREWARM_REQUEST_EPOCH_TTL);
    if let Some(current) = epochs.get(session_id) {
        if current.episode_id > episode_id || (!current.active && current.episode_id >= episode_id)
        {
            return Err(format!(
                "stale external replay prewarm episode {episode_id}; current episode is {}",
                current.episode_id
            ));
        }
    }
    if !epochs.contains_key(session_id) && epochs.len() >= MAX_PREWARM_REQUEST_EPOCHS {
        if let Some(oldest) = epochs
            .iter()
            .min_by_key(|(_, entry)| entry.touched_at)
            .map(|(session_id, _)| session_id.clone())
        {
            epochs.remove(&oldest);
        }
    }
    let value = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed).saturating_add(1);
    epochs.insert(
        session_id.to_string(),
        PrewarmRequestEpoch {
            value,
            episode_id,
            active: true,
            touched_at: now,
        },
    );
    Ok(value)
}

fn is_current_prewarm_request(session_id: &str, episode_id: u64, epoch: u64) -> bool {
    prewarm_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .is_some_and(|current| {
            current.active && current.episode_id == episode_id && current.value == epoch
        })
}

/// Mark the latest prewarm episode as cancelled without dropping its episode
/// floor. Keeping a short-lived tombstone prevents a delayed IPC invocation
/// from recreating the just-closed A episode after an A -> B switch.
pub(super) fn cancel_prewarm_requests(session_id: &str) {
    let mut epochs = prewarm_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(current) = epochs.get_mut(session_id) {
        current.active = false;
        current.touched_at = Instant::now();
    }
}

/// Validate the independent prewarm ticket and publish its bounded window as
/// one linearizable operation. The lock order is session manager -> stores ->
/// prewarm registry; `es_switch_session` cancels the old prewarm while holding
/// the manager lock, so either this commit wins before the switch or it cannot
/// write after the switch.
fn apply_prewarm_window_if_current(
    state: &EventStoreState,
    session_id: &str,
    episode_id: u64,
    epoch: u64,
    events: &[SessionEvent],
) -> bool {
    let mut manager = state
        .session_manager
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut stores = state
        .stores
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let epochs = prewarm_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let is_current = epochs.get(session_id).is_some_and(|current| {
        current.active && current.episode_id == episode_id && current.value == epoch
    });
    if !is_current {
        return false;
    }
    manager.register(session_id);
    stores
        .entry(session_id.to_string())
        .or_default()
        .set_external_replay_window(events.to_vec());
    true
}

fn begin_replay_request(
    session_id: &str,
    episode_id: u64,
    allow_activate: bool,
) -> Result<u64, String> {
    static NEXT_EPOCH: AtomicU64 = AtomicU64::new(0);
    let now = Instant::now();
    let mut epochs = replay_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    epochs.retain(|_, entry| now.duration_since(entry.touched_at) < REPLAY_REQUEST_EPOCH_TTL);
    if let Some(current) = epochs.get(session_id) {
        if current.episode_id != episode_id && (!allow_activate || episode_id < current.episode_id)
        {
            return Err(format!(
                "stale external replay foreground episode {episode_id}; current episode is {}",
                current.episode_id
            ));
        }
    } else if !allow_activate {
        return Err("external replay foreground episode is not open".to_string());
    }
    if !epochs.contains_key(session_id) && epochs.len() >= MAX_REPLAY_REQUEST_EPOCHS {
        if let Some(oldest) = epochs
            .iter()
            .min_by_key(|(_, entry)| entry.touched_at)
            .map(|(session_id, _)| session_id.clone())
        {
            // Dropping the ticket only makes that completion stale. It can
            // never become valid for a future episode because tickets are
            // process-global and monotonic.
            epochs.remove(&oldest);
        }
    }
    let value = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed).saturating_add(1);
    epochs.insert(
        session_id.to_string(),
        ReplayRequestEpoch {
            value,
            episode_id,
            touched_at: now,
        },
    );
    Ok(value)
}

fn is_current_replay_request(session_id: &str, episode_id: u64, epoch: u64) -> bool {
    replay_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .is_some_and(|current| current.episode_id == episode_id && current.value == epoch)
}

fn is_current_replay_episode(session_id: &str, episode_id: u64) -> bool {
    replay_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .is_some_and(|current| current.episode_id == episode_id)
}

fn release_replay_watch_if_stale_episode(session_id: &str, episode_id: u64) {
    if !is_current_replay_episode(session_id, episode_id) {
        external_replay_watcher::release_session_if_episode(session_id, episode_id);
    }
}

fn release_session_runtime_if_episode(session_id: &str, episode_id: u64) {
    let released = {
        let mut epochs = replay_request_epochs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if epochs
            .get(session_id)
            .is_some_and(|current| current.episode_id == episode_id)
        {
            epochs.remove(session_id);
            true
        } else {
            false
        }
    };
    if released {
        cancel_prewarm_requests(session_id);
        external_replay_watcher::release_session_if_episode(session_id, episode_id);
    }
}

/// Invalidate pending external replay delivery and release its foreground
/// watcher. Native SDE sessions never create either entry, so calling this
/// from the shared session lifecycle is a strict no-op for native behavior.
pub(super) fn release_session_runtime(session_id: &str) {
    replay_request_epochs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(session_id);
    cancel_prewarm_requests(session_id);
    external_replay_watcher::release_session(session_id);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ReplayApplyResult {
    upserted: u64,
    removed: u64,
    changed: bool,
}

/// External-only authoritative apply path. Native SDE Agent never calls this
/// helper and retains its existing EventStore set/merge semantics.
fn apply_external_replay_delta(
    store: &mut EventStore,
    delta: &ExternalReplayDelta,
) -> ReplayApplyResult {
    if delta.reset_required {
        store.set_external_replay_window(delta.events.clone());
        return ReplayApplyResult {
            upserted: delta.events.len() as u64,
            removed: 0,
            changed: true,
        };
    }
    let mut result = ReplayApplyResult::default();
    for event in delta.events.iter().cloned() {
        let unchanged = store
            .get_by_id(&event.id)
            .is_some_and(|existing| session_events_equal(existing, &event));
        if !unchanged {
            store.upsert(event);
            result.upserted += 1;
        }
    }
    result.removed = store.remove_by_ids(&delta.removed_event_ids) as u64;
    result.changed = result.upserted > 0 || result.removed > 0;
    result
}

// -------------------------------------------------------------------------
// ORGII-owned collaboration snapshot bounded SQL driver.
// -------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CollaborationSnapshotState {
    generation: String,
    revision: u64,
    reset_revision: u64,
    max_sequence: i64,
    event_count: u64,
}

fn validate_collaboration_snapshot_session_id(session_id: &str) -> Result<(), String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX)
        && session_id.len() > COLLABORATION_SNAPSHOT_SESSION_PREFIX.len()
        && !session_id.contains(['/', '\\'])
    {
        return Ok(());
    }
    Err(format!(
        "collaboration snapshot session id must start with {COLLABORATION_SNAPSHOT_SESSION_PREFIX}"
    ))
}

/// Install mutation accounting once, then seed a pre-existing imported copy.
/// INSERTs at the append frontier keep the generation and advance revision;
/// UPDATE/DELETE or out-of-order INSERTs force a generation reset. The
/// triggers observe writes made by the normal cache path without copying any
/// transcript body into a second store.
fn ensure_collaboration_snapshot_state(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    validate_collaboration_snapshot_session_id(session_id)?;
    let state_table_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='collaboration_replay_state')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("inspect collaboration replay state schema: {error}"))?
        != 0;
    let trigger_count = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN(
               'collaboration_replay_events_insert',
               'collaboration_replay_events_delete',
               'collaboration_replay_events_update_old',
               'collaboration_replay_events_update_new'
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("inspect collaboration replay triggers: {error}"))?;
    let state_exists = state_table_exists
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_replay_state WHERE session_id=?1)",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("inspect collaboration replay session state: {error}"))?
            != 0;
    if trigger_count == 4 && state_exists {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collaboration_replay_state (
             session_id TEXT PRIMARY KEY,
             generation INTEGER NOT NULL DEFAULT 0,
             revision INTEGER NOT NULL DEFAULT 0,
             max_sequence INTEGER NOT NULL DEFAULT -1,
             event_count INTEGER NOT NULL DEFAULT 0
         );
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_insert
         AFTER INSERT ON events
         WHEN NEW.session_id GLOB 'imported-session-*'
         BEGIN
           INSERT INTO collaboration_replay_state(
             session_id,generation,revision,max_sequence,event_count
           ) VALUES(
             NEW.session_id,0,1,COALESCE(NEW.history_sequence,NEW.rowid),1
           )
           ON CONFLICT(session_id) DO UPDATE SET
             generation = collaboration_replay_state.generation +
               CASE WHEN collaboration_replay_state.max_sequence=-2 THEN 0
                    WHEN COALESCE(NEW.history_sequence,NEW.rowid) >
                              collaboration_replay_state.max_sequence
                    THEN 0 ELSE 1 END,
             revision = collaboration_replay_state.revision + 1,
             max_sequence = CASE
               WHEN collaboration_replay_state.max_sequence=-2 THEN -2
               ELSE MAX(
                 collaboration_replay_state.max_sequence,
                 COALESCE(NEW.history_sequence,NEW.rowid)
               ) END,
             event_count = collaboration_replay_state.event_count + 1;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_delete
         AFTER DELETE ON events
         WHEN OLD.session_id GLOB 'imported-session-*'
         BEGIN
           UPDATE collaboration_replay_state
           SET generation = generation + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               revision = revision + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               max_sequence = -2,
               event_count = MAX(event_count - 1,0)
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_update_old
         AFTER UPDATE ON events
         WHEN OLD.session_id GLOB 'imported-session-*'
         BEGIN
           UPDATE collaboration_replay_state
           SET generation = generation + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               revision = revision + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               max_sequence = -2,
               event_count = MAX(
                 event_count - CASE WHEN NEW.session_id != OLD.session_id THEN 1 ELSE 0 END,
                 0
               )
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_update_new
         AFTER UPDATE ON events
         WHEN NEW.session_id GLOB 'imported-session-*'
              AND NEW.session_id != OLD.session_id
         BEGIN
           INSERT INTO collaboration_replay_state(
             session_id,generation,revision,max_sequence,event_count
           )
           VALUES(
             NEW.session_id,0,1,COALESCE(NEW.history_sequence,NEW.rowid),1
           )
           ON CONFLICT(session_id) DO UPDATE SET
             generation = collaboration_replay_state.generation +
               CASE WHEN collaboration_replay_state.max_sequence=-2 THEN 0 ELSE 1 END,
             revision = collaboration_replay_state.revision +
               CASE WHEN collaboration_replay_state.max_sequence=-2 THEN 0 ELSE 1 END,
             max_sequence = -2,
             event_count = collaboration_replay_state.event_count + 1;
         END;",
    )
    .map_err(|error| format!("initialize collaboration replay state: {error}"))?;
    conn.execute(
        "INSERT INTO collaboration_replay_state(
           session_id,generation,revision,max_sequence,event_count
         )
         SELECT ?1,0,COUNT(*),
                COALESCE(MAX(COALESCE(history_sequence,rowid)),-1),COUNT(*)
         FROM events WHERE session_id=?1
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )
    .map_err(|error| format!("seed collaboration replay state: {error}"))?;
    Ok(())
}

fn collaboration_snapshot_state(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<CollaborationSnapshotState, String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_FORK_PREFIX) {
        return super::collaboration_snapshot_ingest::collaboration_snapshot_secondary_state(
            conn, session_id,
        )?
        .map(|state| CollaborationSnapshotState {
            generation: state.generation,
            revision: state.revision,
            reset_revision: state.reset_revision,
            max_sequence: state.max_sequence,
            event_count: state.event_count,
        })
        .ok_or_else(|| {
            format!(
                "Native Agent session is not backed by an intact collaboration snapshot: {session_id}"
            )
        });
    }
    ensure_collaboration_snapshot_state(conn, session_id)?;
    let mut state = conn
        .query_row(
            "SELECT generation,revision,max_sequence,event_count
         FROM collaboration_replay_state WHERE session_id=?1",
            [session_id],
            |row| {
                let generation = row.get::<_, i64>(0)?.max(0);
                Ok(CollaborationSnapshotState {
                    generation: format!(
                        "collaboration-v{COLLABORATION_SNAPSHOT_DRIVER_VERSION}-{generation}"
                    ),
                    revision: row.get::<_, i64>(1)?.max(0) as u64,
                    reset_revision: 0,
                    max_sequence: row.get(2)?,
                    event_count: row.get::<_, i64>(3)?.max(0) as u64,
                })
            },
        )
        .map_err(|error| format!("read collaboration replay state: {error}"))?;
    if state.max_sequence == -2 {
        conn.execute(
            "UPDATE collaboration_replay_state
             SET max_sequence=COALESCE((
                   SELECT MAX(history_sequence) FROM events WHERE session_id=?1
                 ),-1),
                 event_count=(
                   SELECT COUNT(*) FROM events WHERE session_id=?1
                 )
             WHERE session_id=?1",
            [session_id],
        )
        .map_err(|error| format!("refresh dirty collaboration replay state: {error}"))?;
        let (max_sequence, event_count) = conn
            .query_row(
                "SELECT max_sequence,event_count FROM collaboration_replay_state
                 WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|error| format!("reload collaboration replay state: {error}"))?;
        state.max_sequence = max_sequence;
        state.event_count = event_count.max(0) as u64;
    }
    let has_unsequenced_rows = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM events
             WHERE session_id=?1 AND history_sequence IS NULL)",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("validate collaboration replay sequences: {error}"))?
        != 0;
    if has_unsequenced_rows {
        return Err(
            "Collaboration snapshot contains an event without history_sequence; retry the atomic import"
                .to_string(),
        );
    }
    Ok(state)
}

fn snapshot_user_predicate() -> &'static str {
    "(event_type IN ('user','user_message')
       OR function_name IN ('user','user_message')
       OR CASE WHEN json_valid(meta_json)
               THEN json_extract(meta_json,'$.source')='user'
               ELSE 0 END)"
}

fn collaboration_snapshot_turn_count(
    conn: &rusqlite::Connection,
    session_id: &str,
    event_count: u64,
) -> Result<u64, String> {
    let sql = format!(
        "SELECT COUNT(*) FROM events WHERE session_id=?1 AND {}",
        snapshot_user_predicate()
    );
    let user_count = conn
        .query_row(&sql, [session_id], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("count collaboration replay turns: {error}"))?
        .max(0) as u64;
    Ok(if user_count == 0 && event_count > 0 {
        1
    } else {
        user_count
    })
}

fn collaboration_snapshot_turn_sequence(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_index: i64,
) -> Result<Option<i64>, String> {
    if turn_index < 0 {
        return Ok(None);
    }
    let sql = format!(
        "SELECT history_sequence FROM events
         WHERE session_id=?1 AND {}
           AND history_sequence IS NOT NULL
         ORDER BY history_sequence ASC,id ASC
         LIMIT 1 OFFSET ?2",
        snapshot_user_predicate()
    );
    conn.query_row(&sql, rusqlite::params![session_id, turn_index], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|error| format!("resolve collaboration replay turn index: {error}"))
}

fn collaboration_snapshot_turn_id_sequence(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT history_sequence FROM events
         WHERE session_id=?1 AND id=?2 AND history_sequence IS NOT NULL",
        rusqlite::params![session_id, turn_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("resolve collaboration replay turn id: {error}"))
}

fn collaboration_snapshot_latest_turn_start(
    conn: &rusqlite::Connection,
    session_id: &str,
    max_turns: usize,
) -> Result<Option<i64>, String> {
    let sql = format!(
        "SELECT history_sequence FROM events
         WHERE session_id=?1 AND {}
           AND history_sequence IS NOT NULL
         ORDER BY history_sequence DESC,id DESC
         LIMIT 1 OFFSET ?2",
        snapshot_user_predicate()
    );
    conn.query_row(
        &sql,
        rusqlite::params![session_id, max_turns.saturating_sub(1) as i64],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("resolve latest collaboration replay turn: {error}"))
}

fn snapshot_root_preview(raw_prefix: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "_replayTruncated": true,
        "_preview": raw_prefix.unwrap_or_else(|| "[payload truncated]".to_string()),
    })
}

fn snapshot_payload_ref(
    event_id: &str,
    field_path: &str,
    preview: String,
    full_size_bytes: i64,
    generation: &str,
    encoding: PayloadRefEncoding,
) -> PayloadRef {
    PayloadRef {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        preview,
        full_size_bytes: full_size_bytes.max(0) as usize,
        truncated: true,
        replay_encoding: Some(encoding),
        replay_source_id: Some(COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID.to_string()),
        replay_generation: Some(generation.to_string()),
        replay_source_event_id: Some(event_id.to_string()),
    }
}

fn query_collaboration_snapshot_events(
    conn: &rusqlite::Connection,
    session_id: &str,
    generation: &str,
    lower_exclusive: i64,
    upper_exclusive: i64,
    limits: ReplayLimits,
    newest_first: bool,
) -> Result<Vec<(i64, SessionEvent)>, String> {
    let limits = limits.bounded();
    let order = if newest_first { "DESC" } else { "ASC" };
    // args are never loaded past the normal preview boundary; result allows
    // the Shell preview boundary. Oversized roots are reconstructed only by
    // `read_payload_range`, never by the ordinary window query.
    let sql = format!(
        "SELECT id,session_id,event_type,function_name,thread_id,
                CASE WHEN length(CAST(args_json AS BLOB))<=?4
                     THEN args_json ELSE '{{}}' END,
                CASE WHEN length(CAST(result_json AS BLOB))<=?5
                     THEN result_json ELSE '{{}}' END,
                created_at,
                CASE WHEN json_valid(meta_json) THEN
                  CASE WHEN length(CAST(json_extract(meta_json,'$.displayText') AS BLOB))>?4
                       THEN json_set(meta_json,'$.displayText',
                            substr(json_extract(meta_json,'$.displayText'),1,2048))
                       ELSE meta_json END
                ELSE meta_json END,
                history_sequence,
                length(CAST(args_json AS BLOB)),
                length(CAST(result_json AS BLOB)),
                CASE WHEN length(CAST(args_json AS BLOB))>?4
                     THEN substr(args_json,1,2048) END,
                CASE WHEN length(CAST(result_json AS BLOB))>?5
                     THEN substr(result_json,1,8192) END,
                CASE WHEN json_valid(meta_json)
                     THEN length(CAST(json_extract(meta_json,'$.displayText') AS BLOB))
                     ELSE 0 END
         FROM events
         WHERE session_id=?1
           AND history_sequence>?2
           AND history_sequence<?3
         ORDER BY history_sequence {order},id {order}
         LIMIT {}",
        limits.max_events
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| format!("prepare bounded collaboration replay: {error}"))?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            lower_exclusive,
            upper_exclusive,
            replay::NORMAL_PAYLOAD_PREVIEW_BYTES as i64,
            replay::SHELL_PAYLOAD_PREVIEW_BYTES as i64,
        ])
        .map_err(|error| format!("query bounded collaboration replay: {error}"))?;
    let mut indexed = Vec::new();
    let mut wire_bytes = 0_usize;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read bounded collaboration replay: {error}"))?
    {
        let sequence: i64 = row.get(9).map_err(|error| error.to_string())?;
        let args_size: i64 = row
            .get::<_, Option<i64>>(10)
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let result_size: i64 = row
            .get::<_, Option<i64>>(11)
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let args_prefix: Option<String> = row.get(12).map_err(|error| error.to_string())?;
        let result_prefix: Option<String> = row.get(13).map_err(|error| error.to_string())?;
        let display_size: i64 = row
            .get::<_, Option<i64>>(14)
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let cached = session_persistence::CachedEvent {
            id: row.get(0).map_err(|error| error.to_string())?,
            session_id: row.get(1).map_err(|error| error.to_string())?,
            event_type: row.get(2).map_err(|error| error.to_string())?,
            function_name: row.get(3).map_err(|error| error.to_string())?,
            thread_id: row.get(4).map_err(|error| error.to_string())?,
            args_json: row.get(5).map_err(|error| error.to_string())?,
            result_json: row.get(6).map_err(|error| error.to_string())?,
            content: String::new(),
            created_at: row.get(7).map_err(|error| error.to_string())?,
            meta_json: row.get(8).map_err(|error| error.to_string())?,
            history_sequence: Some(sequence),
        };
        let mut event = cached_event_to_session_event(&cached);
        event.payload_refs.clear();
        if args_size as usize > replay::NORMAL_PAYLOAD_PREVIEW_BYTES {
            event.args = snapshot_root_preview(args_prefix);
            event.payload_refs.push(snapshot_payload_ref(
                &event.id,
                "args",
                json_field_preview(&event, "args"),
                args_size,
                generation,
                PayloadRefEncoding::JsonValue,
            ));
        }
        let result_limit = if event.ui_canonical == core_types::tool_names::RUN_SHELL {
            replay::SHELL_PAYLOAD_PREVIEW_BYTES
        } else {
            replay::NORMAL_PAYLOAD_PREVIEW_BYTES
        };
        if result_size as usize > result_limit {
            event.result = snapshot_root_preview(result_prefix);
            event.payload_refs.push(snapshot_payload_ref(
                &event.id,
                "result",
                json_field_preview(&event, "result"),
                result_size,
                generation,
                PayloadRefEncoding::JsonValue,
            ));
        }
        if display_size as usize > replay::NORMAL_PAYLOAD_PREVIEW_BYTES {
            event.payload_refs.push(snapshot_payload_ref(
                &event.id,
                "displayText",
                event.display_text.clone(),
                display_size,
                generation,
                PayloadRefEncoding::Utf8Text,
            ));
        }
        // Extraction must see compact values. This prevents a deferred root
        // from being copied into a second large rendering envelope.
        event.extracted = None;
        event.recompute_extracted();
        let next_bytes = serde_json::to_vec(&event)
            .map_err(|error| format!("measure collaboration replay event: {error}"))?
            .len();
        if !indexed.is_empty() && wire_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            break;
        }
        if indexed.is_empty() && next_bytes > limits.max_ipc_bytes {
            return Err(format!(
                "Collaboration replay event {} exceeds the {} byte compact window budget",
                event.id, limits.max_ipc_bytes
            ));
        }
        wire_bytes = wire_bytes.saturating_add(next_bytes);
        indexed.push((sequence, event));
    }
    if newest_first {
        indexed.reverse();
    }
    Ok(indexed)
}

fn collaboration_snapshot_turn_headers(
    conn: &rusqlite::Connection,
    session_id: &str,
    events: &[(i64, SessionEvent)],
) -> Result<Vec<ReplayTurnHeader>, String> {
    if events.is_empty() {
        return Ok(Vec::new());
    }
    let mut starts = events
        .iter()
        .enumerate()
        .filter(|(_, (_, event))| event.source == EventSource::User)
        .map(|(offset, (sequence, event))| (offset, *sequence, event))
        .collect::<Vec<_>>();
    if starts.is_empty() {
        starts.push((0, events[0].0, &events[0].1));
    }
    let mut headers = Vec::with_capacity(starts.len());
    for (position, (offset, start_sequence, event)) in starts.iter().enumerate() {
        let next_offset = starts
            .get(position + 1)
            .map_or(events.len(), |(next, _, _)| *next);
        let end = events.get(next_offset.saturating_sub(1));
        let sql = format!(
            "SELECT COUNT(*) FROM events WHERE session_id=?1
             AND history_sequence<?2 AND {}",
            snapshot_user_predicate()
        );
        let turn_index = conn
            .query_row(&sql, rusqlite::params![session_id, start_sequence], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| format!("index collaboration replay turn: {error}"))?;
        headers.push(ReplayTurnHeader {
            turn_id: event.id.clone(),
            turn_index,
            start_sequence: *start_sequence,
            end_sequence: end.map(|(sequence, _)| *sequence),
            started_at: event.created_at.clone(),
            ended_at: end.map(|(_, event)| event.created_at.clone()),
            event_count: next_offset.saturating_sub(*offset) as u64,
        });
    }
    Ok(headers)
}

fn collaboration_snapshot_read_window_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ExternalReplayWindow, String> {
    let limits = limits.bounded();
    let state = collaboration_snapshot_state(conn, session_id)?;
    let (lower_exclusive, upper_exclusive) = if let Some(turn_id) = turn_id {
        let start = collaboration_snapshot_turn_id_sequence(conn, session_id, turn_id)?
            .ok_or_else(|| format!("Collaboration replay turn is unavailable: {turn_id}"))?;
        let next = conn
            .query_row(
                &format!(
                    "SELECT history_sequence FROM events
                     WHERE session_id=?1 AND history_sequence>?2 AND {}
                     ORDER BY history_sequence ASC,id ASC LIMIT 1",
                    snapshot_user_predicate()
                ),
                rusqlite::params![session_id, start],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("resolve next collaboration replay turn: {error}"))?
            .unwrap_or(i64::MAX);
        (start.saturating_sub(1), next)
    } else if let Some(turn_index) = turn_index {
        let start = collaboration_snapshot_turn_sequence(conn, session_id, turn_index)?
            .ok_or_else(|| {
                format!("Collaboration replay turn index is unavailable: {turn_index}")
            })?;
        let next = collaboration_snapshot_turn_sequence(conn, session_id, turn_index + 1)?
            .unwrap_or(i64::MAX);
        (start.saturating_sub(1), next)
    } else if let Some(before_sequence) = before_sequence {
        (-1, before_sequence)
    } else {
        let start = collaboration_snapshot_latest_turn_start(conn, session_id, limits.max_turns)?
            .unwrap_or(-1);
        (start.saturating_sub(1), i64::MAX)
    };
    let indexed = query_collaboration_snapshot_events(
        conn,
        session_id,
        &state.generation,
        lower_exclusive,
        upper_exclusive,
        limits,
        true,
    )?;
    let through_sequence = indexed.last().map_or(-1, |(sequence, _)| *sequence);
    let min_sequence = indexed.first().map_or(-1, |(sequence, _)| *sequence);
    let has_older = min_sequence >= 0
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events
                 WHERE session_id=?1 AND history_sequence<?2)",
                rusqlite::params![session_id, min_sequence],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("query older collaboration replay events: {error}"))?
            != 0;
    let window_start_sequence = indexed.iter().map(|(sequence, _)| *sequence).min();
    let turn_headers = collaboration_snapshot_turn_headers(conn, session_id, &indexed)?;
    let total_turn_count = collaboration_snapshot_turn_count(conn, session_id, state.event_count)?;
    let parsed_rows = indexed.len() as u64;
    let events = indexed
        .into_iter()
        .map(|(_, event)| event)
        .collect::<Vec<_>>();
    let ipc_bytes = serde_json::to_vec(&events).map_or(0, |bytes| bytes.len()) as u64;
    let current = collaboration_snapshot_state(conn, session_id)?;
    validate_query_apply_version(
        &state.generation,
        state.revision,
        &current.generation,
        current.revision,
    )?;
    Ok(ExternalReplayWindow {
        cursor: ReplayCursor {
            source_id: COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID.to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        events,
        window_start_sequence,
        turn_headers,
        total_turn_count,
        total_event_count: state.event_count,
        has_older,
        stats: ReplayStats {
            parsed_rows,
            normalized_events: parsed_rows,
            ipc_bytes,
            ..ReplayStats::default()
        },
        watcher_available: false,
    })
}

fn collaboration_snapshot_poll_delta_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
) -> Result<ExternalReplayDelta, String> {
    let state = collaboration_snapshot_state(conn, session_id)?;
    if state.generation != cursor.generation {
        return Ok(ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID.to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: -1,
            },
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    if state.reset_revision > cursor.revision {
        return Ok(ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID.to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: -1,
            },
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    if state.revision == cursor.revision && cursor.through_sequence >= state.max_sequence {
        return Ok(ExternalReplayDelta {
            cursor: cursor.clone(),
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: false,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    let indexed = query_collaboration_snapshot_events(
        conn,
        session_id,
        &state.generation,
        cursor.through_sequence,
        state.max_sequence.saturating_add(1),
        limits,
        false,
    )?;
    if indexed.is_empty() && state.revision != cursor.revision {
        return Ok(ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID.to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: -1,
            },
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    let through_sequence = indexed
        .last()
        .map_or(cursor.through_sequence, |(sequence, _)| *sequence);
    let parsed_rows = indexed.len() as u64;
    let events = indexed
        .into_iter()
        .map(|(_, event)| event)
        .collect::<Vec<_>>();
    let ipc_bytes = serde_json::to_vec(&events).map_or(0, |bytes| bytes.len()) as u64;
    let current = collaboration_snapshot_state(conn, session_id)?;
    validate_query_apply_version(
        &state.generation,
        state.revision,
        &current.generation,
        current.revision,
    )?;
    Ok(ExternalReplayDelta {
        cursor: ReplayCursor {
            source_id: COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID.to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        events,
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats {
            parsed_rows,
            normalized_events: parsed_rows,
            ipc_bytes,
            ..ReplayStats::default()
        },
        watcher_available: false,
    })
}

fn collaboration_snapshot_payload_range_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let state = collaboration_snapshot_state(conn, session_id)?;
    if state.generation != generation {
        return Err(format!(
            "Collaboration replay generation changed: requested {generation}, current {}",
            state.generation
        ));
    }
    let (root, path) = field_path.split_once('.').unwrap_or((field_path, ""));
    let (column, json_path) = match root {
        "args" => (
            "args_json",
            (!path.is_empty()).then(|| legacy_sqlite_json_path(path)),
        ),
        "result" => (
            "result_json",
            (!path.is_empty()).then(|| legacy_sqlite_json_path(path)),
        ),
        "displayText" if path.is_empty() => (
            "meta_json",
            Some(Ok::<String, String>("$.displayText".to_string())),
        ),
        _ => return Err("fieldPath must start with args, result or displayText".to_string()),
    };
    let start = offset.min(i64::MAX as u64) as i64;
    let read_bytes = max_bytes.saturating_add(4).min(i64::MAX as usize) as i64;
    let (total_bytes, bytes): (Option<i64>, Option<Vec<u8>>) = if let Some(path) = json_path {
        let path = path?;
        let sql = format!(
            "SELECT length(CAST(json_extract({column},?3) AS BLOB)),
                    substr(CAST(json_extract({column},?3) AS BLOB),?4,?5)
             FROM events WHERE session_id=?1 AND id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![
                session_id,
                event_id,
                path,
                start.saturating_add(1),
                read_bytes
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    } else {
        let sql = format!(
            "SELECT length(CAST({column} AS BLOB)),
                    substr(CAST({column} AS BLOB),?3,?4)
             FROM events WHERE session_id=?1 AND id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![session_id, event_id, start.saturating_add(1), read_bytes],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }
    .map_err(|error| format!("load collaboration replay payload range: {error}"))?;
    let total_bytes = total_bytes
        .ok_or_else(|| format!("collaboration replay payload field not found: {field_path}"))?
        .max(0) as u64;
    let bytes = bytes.unwrap_or_default();
    let mut take = max_bytes.min(bytes.len());
    while take > 0 && std::str::from_utf8(&bytes[..take]).is_err() {
        take -= 1;
    }
    if take == 0 && !bytes.is_empty() {
        return Err(format!(
            "collaboration replay range starts inside invalid UTF-8: {field_path} at {offset}"
        ));
    }
    let text = String::from_utf8(bytes[..take].to_vec())
        .map_err(|error| format!("decode collaboration replay payload range: {error}"))?;
    let next_offset = offset.saturating_add(take as u64).min(total_bytes);
    let range = ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: offset.min(total_bytes),
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    };
    let current = collaboration_snapshot_state(conn, session_id)?;
    if current.generation != generation {
        return Err(format!(
            "Collaboration replay generation changed during payload read: requested {generation}, current {}",
            current.generation
        ));
    }
    Ok(range)
}

// -------------------------------------------------------------------------
// Readerless managed CLI bounded SQL driver.
// -------------------------------------------------------------------------

fn legacy_generation(conn: &rusqlite::Connection, session_id: &str) -> Result<String, String> {
    let epoch = conn
        .query_row(
            "SELECT epoch FROM code_session_history_mutations WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("read managed history generation: {err}"))?
        .unwrap_or(0);
    Ok(format!("chunks-{epoch}"))
}

fn legacy_stream_cursor(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<(String, i64), String> {
    let generation = legacy_generation(conn, session_id)?;
    let max_sequence = conn
        .query_row(
            "SELECT COALESCE(MAX(sequence), -1) FROM code_session_chunks WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("read managed replay stream revision: {err}"))?;
    Ok((generation, max_sequence))
}

fn validate_legacy_stream_cursor(
    expected_generation: &str,
    expected_max_sequence: i64,
    current: &(String, i64),
    operation: &str,
) -> Result<(), String> {
    if current.0 == expected_generation && current.1 == expected_max_sequence {
        return Ok(());
    }
    Err(format!(
        "Managed replay changed while {operation}: expected {expected_generation}@{expected_max_sequence}, found {}@{}; retry from the new replay cursor",
        current.0, current.1
    ))
}

/// Shared readerless managed-CLI scan used by both streamed export and Cloud
/// spooling. Keeping the database cursor and the bounded payload reader on the
/// same connection makes it impossible for either consumer to reintroduce a
/// full args/result materialization behind a separate code path.
fn stream_legacy_replay_events_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    operation: &str,
    mut consume: impl FnMut(
        &SessionEvent,
        &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
    ) -> Result<(), String>,
) -> Result<String, String> {
    let (generation, max_sequence) = legacy_stream_cursor(conn, session_id)?;
    let limits = ReplayLimits {
        max_turns: 10,
        max_events: STREAM_BATCH_MAX_EVENTS,
        max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
    };
    let mut after_sequence = -1_i64;
    loop {
        if legacy_generation(conn, session_id)? != generation {
            return Err(format!(
                "Managed replay changed while {operation}; retry from the new generation"
            ));
        }
        let chunks = query_legacy_chunks(
            conn,
            session_id,
            "sequence > ?2",
            after_sequence,
            Some(max_sequence),
            limits,
            false,
        )?;
        if chunks.is_empty() {
            break;
        }
        let next_sequence = chunks.last().map_or(after_sequence, |chunk| chunk.sequence);
        let (events, _) = normalize_indexed_chunks(
            chunks,
            session_id,
            MANAGED_CLI_REPLAY_SOURCE_ID,
            &generation,
        );
        for event in &events {
            let mut read_payload = |payload_ref: &PayloadRef, offset: u64| {
                legacy_payload_range_from_conn(
                    conn,
                    session_id,
                    payload_ref
                        .replay_source_event_id
                        .as_deref()
                        .unwrap_or(&payload_ref.event_id),
                    &payload_ref.field_path,
                    offset,
                    EXPORT_PAYLOAD_RANGE_BYTES,
                )
            };
            consume(event, &mut read_payload)?;
        }
        if next_sequence <= after_sequence {
            return Err(format!(
                "Managed replay cursor did not advance while {operation}"
            ));
        }
        after_sequence = next_sequence;
    }
    validate_legacy_stream_cursor(
        &generation,
        max_sequence,
        &legacy_stream_cursor(conn, session_id)?,
        operation,
    )?;
    Ok(generation)
}

fn legacy_open_window(session_id: &str, limits: ReplayLimits) -> Result<ReplayChunkWindow, String> {
    legacy_read_window(session_id, None, None, None, limits)
}

fn legacy_read_window(
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let conn =
        database::db::get_connection().map_err(|err| format!("open managed chunks DB: {err}"))?;
    legacy_read_window_from_conn(
        &conn,
        session_id,
        before_sequence,
        turn_id,
        turn_index,
        limits,
    )
}

fn legacy_read_window_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let limits = limits.bounded();
    let (generation, source_revision) = legacy_stream_cursor(conn, session_id)?;
    let source_revision = source_revision.max(0) as u64;
    let (total_event_count, total_turn_count) = legacy_total_counts(conn, session_id)?;
    if total_event_count == 0 {
        return Ok(ReplayChunkWindow {
            cursor: ReplayCursor {
                source_id: MANAGED_CLI_REPLAY_SOURCE_ID.to_string(),
                session_id: session_id.to_string(),
                generation,
                revision: source_revision,
                through_sequence: -1,
            },
            chunks: Vec::new(),
            turn_headers: Vec::new(),
            total_turn_count: 0,
            total_event_count: 0,
            has_older: false,
            stats: ReplayStats::default(),
        });
    }

    let newest_turn_index = if let Some(turn_id) = turn_id {
        Some(legacy_turn_index_for_id(
            conn,
            session_id,
            turn_id,
            total_turn_count,
        )?)
    } else if let Some(turn_index) = turn_index {
        if turn_index < 0 || turn_index >= total_turn_count as i64 {
            return Err(format!(
                "Managed replay turn index is no longer available: {turn_index}"
            ));
        }
        Some(turn_index)
    } else {
        legacy_latest_turn_index_before(conn, session_id, before_sequence.unwrap_or(i64::MAX))?
    };

    let Some(newest_turn_index) = newest_turn_index else {
        return Ok(ReplayChunkWindow {
            cursor: ReplayCursor {
                source_id: MANAGED_CLI_REPLAY_SOURCE_ID.to_string(),
                session_id: session_id.to_string(),
                generation,
                revision: source_revision,
                through_sequence: -1,
            },
            chunks: Vec::new(),
            turn_headers: Vec::new(),
            total_turn_count,
            total_event_count,
            has_older: false,
            stats: ReplayStats::default(),
        });
    };
    let oldest_turn_index = newest_turn_index
        .saturating_sub(limits.max_turns.saturating_sub(1) as i64)
        .max(0);
    let mut turn_headers = Vec::with_capacity(
        newest_turn_index
            .saturating_sub(oldest_turn_index)
            .saturating_add(1) as usize,
    );
    for index in oldest_turn_index..=newest_turn_index {
        turn_headers.push(legacy_turn_header_at_index(
            conn,
            session_id,
            index,
            total_turn_count,
        )?);
    }
    let start_sequence = turn_headers
        .first()
        .map(|header| header.start_sequence)
        .unwrap_or(0);
    let mut end_sequence = turn_headers
        .last()
        .and_then(|header| header.end_sequence)
        .unwrap_or(start_sequence);
    if let Some(before_sequence) = before_sequence {
        end_sequence = end_sequence.min(before_sequence.saturating_sub(1));
    }
    let mut chunks = query_legacy_chunks(
        conn,
        session_id,
        "sequence >= ?2",
        start_sequence,
        Some(end_sequence),
        limits,
        true,
    )?;
    for chunk in &mut chunks {
        if let Some(header) = turn_headers.iter().find(|header| {
            chunk.sequence >= header.start_sequence
                && chunk.sequence <= header.end_sequence.unwrap_or(header.start_sequence)
        }) {
            chunk.turn_index = header.turn_index;
        }
    }
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let has_older = oldest_turn_index > 0
        || chunks
            .first()
            .is_some_and(|chunk| chunk.sequence > start_sequence);
    Ok(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: MANAGED_CLI_REPLAY_SOURCE_ID.to_string(),
            session_id: session_id.to_string(),
            generation,
            // `revision` identifies the source snapshot, while
            // `through_sequence` identifies this page. Older pages from the
            // same snapshot must therefore keep one stable revision.
            revision: source_revision,
            through_sequence,
        },
        chunks,
        turn_headers,
        total_turn_count,
        total_event_count,
        has_older,
        stats: ReplayStats::default(),
    })
}

fn legacy_total_counts(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<(u64, u64), String> {
    let (event_count, user_turn_count) = conn
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN function='user_message' THEN 1 ELSE 0 END)
             FROM code_session_chunks WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map_err(|err| format!("count managed replay turns: {err}"))?;
    let event_count = event_count.max(0) as u64;
    let turn_count = if event_count == 0 {
        0
    } else {
        user_turn_count.unwrap_or(0).max(1) as u64
    };
    Ok((event_count, turn_count))
}

fn legacy_user_turn_anchor_at_index(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_index: i64,
) -> Result<Option<(i64, String, String)>, String> {
    conn.query_row(
        "SELECT sequence,chunk_id,created_at
         FROM code_session_chunks
         WHERE session_id=?1 AND function='user_message'
         ORDER BY sequence ASC LIMIT 1 OFFSET ?2",
        rusqlite::params![session_id, turn_index],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(|err| format!("query managed replay turn {turn_index}: {err}"))
}

fn legacy_turn_header_at_index(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_index: i64,
    total_turn_count: u64,
) -> Result<ReplayTurnHeader, String> {
    if turn_index < 0 || turn_index >= total_turn_count as i64 {
        return Err(format!(
            "Managed replay turn index is no longer available: {turn_index}"
        ));
    }
    let anchor = legacy_user_turn_anchor_at_index(conn, session_id, turn_index)?;
    let (start_sequence, turn_id, started_at) = match anchor {
        Some(anchor) => anchor,
        None if turn_index == 0 && total_turn_count == 1 => conn
            .query_row(
                "SELECT sequence,chunk_id,created_at FROM code_session_chunks
                 WHERE session_id=?1 ORDER BY sequence ASC LIMIT 1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|err| format!("query managed replay fallback turn: {err}"))?,
        None => {
            return Err(format!(
                "Managed replay turn index is no longer available: {turn_index}"
            ))
        }
    };
    let next_start =
        legacy_user_turn_anchor_at_index(conn, session_id, turn_index + 1)?.map(|anchor| anchor.0);
    let (end_sequence, ended_at, event_count) = conn
        .query_row(
            "SELECT MAX(sequence),
                    (SELECT tail.created_at FROM code_session_chunks AS tail
                     WHERE tail.session_id=?1 AND tail.sequence>=?2
                       AND (?3 IS NULL OR tail.sequence<?3)
                     ORDER BY tail.sequence DESC LIMIT 1),
                    COUNT(*)
             FROM code_session_chunks
             WHERE session_id=?1 AND sequence>=?2
               AND (?3 IS NULL OR sequence<?3)",
            rusqlite::params![session_id, start_sequence, next_start],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|err| format!("summarize managed replay turn {turn_index}: {err}"))?;
    Ok(ReplayTurnHeader {
        turn_id,
        turn_index,
        start_sequence,
        end_sequence,
        started_at,
        ended_at,
        event_count: event_count.max(0) as u64,
    })
}

fn legacy_turn_index_for_id(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_id: &str,
    total_turn_count: u64,
) -> Result<i64, String> {
    let row = conn
        .query_row(
            "SELECT sequence,function FROM code_session_chunks
             WHERE session_id=?1 AND chunk_id=?2",
            rusqlite::params![session_id, turn_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("query managed replay turn id {turn_id}: {err}"))?
        .ok_or_else(|| format!("Managed replay turn is no longer available: {turn_id}"))?;
    if row.1 != "user_message" && total_turn_count != 1 {
        return Err(format!(
            "Managed replay turn is no longer available: {turn_id}"
        ));
    }
    conn.query_row(
        "SELECT COUNT(*) FROM code_session_chunks
         WHERE session_id=?1 AND function='user_message' AND sequence<?2",
        rusqlite::params![session_id, row.0],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|err| format!("resolve managed replay turn id {turn_id}: {err}"))
}

fn legacy_latest_turn_index_before(
    conn: &rusqlite::Connection,
    session_id: &str,
    ceiling: i64,
) -> Result<Option<i64>, String> {
    let latest_user_sequence = conn
        .query_row(
            "SELECT sequence FROM code_session_chunks
             WHERE session_id=?1 AND function='user_message' AND sequence<?2
             ORDER BY sequence DESC LIMIT 1",
            rusqlite::params![session_id, ceiling],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("resolve managed replay window turn: {err}"))?;
    if let Some(sequence) = latest_user_sequence {
        let preceding_users = conn
            .query_row(
                "SELECT COUNT(*) FROM code_session_chunks
                 WHERE session_id=?1 AND function='user_message' AND sequence<?2",
                rusqlite::params![session_id, sequence],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| format!("index managed replay window turn: {err}"))?;
        return Ok(Some(preceding_users.max(0)));
    }
    let has_rows = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM code_session_chunks
             WHERE session_id=?1 AND sequence<?2)",
            rusqlite::params![session_id, ceiling],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query managed replay fallback window: {err}"))?
        != 0;
    Ok(has_rows.then_some(0))
}

fn legacy_poll_delta(
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
) -> Result<ReplayChunkDelta, String> {
    let limits = limits.bounded();
    let conn =
        database::db::get_connection().map_err(|err| format!("open managed chunks DB: {err}"))?;
    let generation = legacy_generation(&conn, session_id)?;
    if generation != cursor.generation {
        return Ok(ReplayChunkDelta {
            cursor: ReplayCursor {
                source_id: MANAGED_CLI_REPLAY_SOURCE_ID.to_string(),
                session_id: session_id.to_string(),
                generation,
                revision: 0,
                through_sequence: -1,
            },
            chunks: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
        });
    }
    let chunks = query_legacy_chunks(
        &conn,
        session_id,
        "sequence > ?2",
        cursor.through_sequence,
        None,
        limits,
        false,
    )?;
    let through_sequence = chunks
        .last()
        .map_or(cursor.through_sequence, |chunk| chunk.sequence);
    Ok(ReplayChunkDelta {
        cursor: ReplayCursor {
            source_id: MANAGED_CLI_REPLAY_SOURCE_ID.to_string(),
            session_id: session_id.to_string(),
            generation,
            revision: through_sequence.max(0) as u64,
            through_sequence,
        },
        chunks,
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats::default(),
    })
}

fn query_legacy_chunks(
    conn: &rusqlite::Connection,
    session_id: &str,
    predicate: &str,
    sequence: i64,
    through_sequence: Option<i64>,
    limits: ReplayLimits,
    newest_first: bool,
) -> Result<Vec<ReplayIndexedChunk>, String> {
    let order = if newest_first { "DESC" } else { "ASC" };
    let upper_bound = through_sequence
        .map(|_| " AND sequence <= ?3")
        .unwrap_or_default();
    let normal_preview_read =
        replay::NORMAL_PAYLOAD_PREVIEW_BYTES.saturating_add(LEGACY_UTF8_BOUNDARY_BYTES);
    let shell_preview_read =
        replay::SHELL_PAYLOAD_PREVIEW_BYTES.saturating_add(LEGACY_UTF8_BOUNDARY_BYTES);
    let sql = format!(
        "SELECT sequence, chunk_id, action_type, function,
                length(CAST(args_json AS BLOB)), json_valid(args_json),
                CASE WHEN length(CAST(args_json AS BLOB)) <= {LEGACY_INLINE_JSON_MAX_BYTES}
                     THEN args_json END,
                CASE WHEN length(CAST(args_json AS BLOB)) > {LEGACY_INLINE_JSON_MAX_BYTES}
                     THEN substr(
                         CAST(args_json AS BLOB),
                         1,
                         CASE WHEN function IN ('run_command_line', 'shell')
                              THEN {shell_preview_read} ELSE {normal_preview_read} END
                     ) END,
                length(CAST(result_json AS BLOB)), json_valid(result_json),
                CASE WHEN length(CAST(result_json AS BLOB)) <= {LEGACY_INLINE_JSON_MAX_BYTES}
                     THEN result_json END,
                CASE WHEN length(CAST(result_json AS BLOB)) > {LEGACY_INLINE_JSON_MAX_BYTES}
                     THEN CASE WHEN function IN ('run_command_line', 'shell')
                         THEN substr(
                             CAST(result_json AS BLOB),
                             MAX(1, length(CAST(result_json AS BLOB)) - {shell_preview_read} + 1),
                             {shell_preview_read}
                         )
                         ELSE substr(CAST(result_json AS BLOB), 1, {normal_preview_read})
                     END END,
                thread_id, process_id, created_at
         FROM code_session_chunks WHERE session_id=?1 AND {predicate}{upper_bound}
         ORDER BY sequence {order} LIMIT {}",
        limits.max_events
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare bounded managed chunks: {err}"))?;
    let mut rows = match through_sequence {
        Some(through_sequence) => {
            stmt.query(rusqlite::params![session_id, sequence, through_sequence])
        }
        None => stmt.query(rusqlite::params![session_id, sequence]),
    }
    .map_err(|err| format!("query bounded managed chunks: {err}"))?;
    let mut chunks = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read bounded managed chunk: {err}"))?
    {
        let chunk_id: String = row.get(1).map_err(|err| err.to_string())?;
        let function: String = row.get(3).map_err(|err| err.to_string())?;
        let args_inline: Option<String> = row.get(6).map_err(|err| err.to_string())?;
        let args_root_preview: Option<Vec<u8>> = row.get(7).map_err(|err| err.to_string())?;
        let result_inline: Option<String> = row.get(10).map_err(|err| err.to_string())?;
        let result_root_preview: Option<Vec<u8>> = row.get(11).map_err(|err| err.to_string())?;
        for field_bytes in [
            args_inline.as_ref().map(String::len),
            args_root_preview.as_ref().map(Vec::len),
            result_inline.as_ref().map(String::len),
            result_root_preview.as_ref().map(Vec::len),
        ]
        .into_iter()
        .flatten()
        {
            observe_legacy_db_json_field(field_bytes);
        }
        let shell = function == "run_command_line" || function == "shell";
        let preview_limit = if shell {
            replay::SHELL_PAYLOAD_PREVIEW_BYTES
        } else {
            replay::NORMAL_PAYLOAD_PREVIEW_BYTES
        };
        let (args, mut payloads) = load_legacy_json_field(
            conn,
            session_id,
            &chunk_id,
            LegacyJsonColumn::Args,
            row.get::<_, i64>(4).map_err(|err| err.to_string())?,
            row.get::<_, i64>(5).map_err(|err| err.to_string())? != 0,
            args_inline,
            args_root_preview,
            preview_limit,
            false,
            &function,
        )?;
        let (result, result_payloads) = load_legacy_json_field(
            conn,
            session_id,
            &chunk_id,
            LegacyJsonColumn::Result,
            row.get::<_, i64>(8).map_err(|err| err.to_string())?,
            row.get::<_, i64>(9).map_err(|err| err.to_string())? != 0,
            result_inline,
            result_root_preview,
            preview_limit,
            shell,
            &function,
        )?;
        payloads.extend(result_payloads);
        let chunk = ActivityChunk {
            chunk_id,
            session_id: session_id.to_string(),
            action_type: row.get(2).map_err(|err| err.to_string())?,
            function,
            args,
            result,
            thread_id: row.get(12).map_err(|err| err.to_string())?,
            process_id: row.get(13).map_err(|err| err.to_string())?,
            created_at: row.get(14).map_err(|err| err.to_string())?,
            broadcast_only: false,
        };
        let indexed = ReplayIndexedChunk {
            sequence: row.get(0).map_err(|err| err.to_string())?,
            turn_index: 0,
            chunk,
            payloads,
        };
        let next_bytes = serde_json::to_vec(&indexed.chunk)
            .map_or(0, |bytes| bytes.len())
            .saturating_add(serde_json::to_vec(&indexed.payloads).map_or(0, |bytes| bytes.len()));
        if !chunks.is_empty() && bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            break;
        }
        if chunks.is_empty() && next_bytes > limits.max_ipc_bytes {
            return Err(format!(
                "Managed replay event {} exceeds the {} byte compact window budget",
                indexed.chunk.chunk_id, limits.max_ipc_bytes
            ));
        }
        bytes = bytes.saturating_add(next_bytes);
        chunks.push(indexed);
    }
    if newest_first {
        chunks.reverse();
    }
    Ok(chunks)
}

#[derive(Clone, Copy)]
enum LegacyJsonColumn {
    Args,
    Result,
}

impl LegacyJsonColumn {
    fn column_name(self) -> &'static str {
        match self {
            Self::Args => "args_json",
            Self::Result => "result_json",
        }
    }

    fn root(self) -> &'static str {
        match self {
            Self::Args => "args",
            Self::Result => "result",
        }
    }
}

#[derive(Clone, Copy)]
enum LegacyJsonContainer {
    Object,
    Array,
}

#[derive(Clone)]
enum LegacyJsonPathSegment {
    Key(String),
    Index(usize),
}

#[allow(clippy::too_many_arguments)]
fn load_legacy_json_field(
    conn: &rusqlite::Connection,
    session_id: &str,
    chunk_id: &str,
    column: LegacyJsonColumn,
    total_bytes: i64,
    valid_json: bool,
    inline: Option<String>,
    root_preview: Option<Vec<u8>>,
    preview_limit: usize,
    tail: bool,
    function_name: &str,
) -> Result<(serde_json::Value, Vec<ReplayPayloadDescriptor>), String> {
    let root = column.root();
    let total_bytes = total_bytes.max(0) as u64;
    if let Some(inline) = inline {
        let mut value = serde_json::from_str(&inline)
            .map_err(|err| format!("decode managed chunk {root}: {err}"))?;
        let mut payloads = Vec::new();
        compact_legacy_json_value(
            &mut value,
            root,
            true,
            preview_limit,
            tail,
            chunk_id,
            legacy_payload_kind(function_name, root),
            &mut payloads,
        );
        return Ok((value, payloads));
    }
    if !valid_json {
        return Err(format!(
            "decode managed chunk {root}: invalid JSON in oversized {root} payload"
        ));
    }

    if let Some(projected) = project_legacy_json_field(
        conn,
        session_id,
        chunk_id,
        column,
        total_bytes,
        preview_limit,
        tail,
        function_name,
    )? {
        return Ok(projected);
    }

    let root_preview = root_preview
        .ok_or_else(|| format!("bounded managed chunk {root} preview is missing for {chunk_id}"))?;
    let preview = if tail {
        utf8_tail_preview_bytes(&root_preview, preview_limit)?
    } else {
        utf8_head_preview_bytes(&root_preview, preview_limit)?
    };
    Ok((
        serde_json::Value::String(preview.clone()),
        vec![ReplayPayloadDescriptor {
            field_path: root.to_string(),
            kind: legacy_payload_kind(function_name, root),
            encoding: ReplayPayloadEncoding::JsonValue,
            body_projection: Some(ReplayPayloadBodyProjection {
                field_path: root.to_string(),
                text: preview.clone(),
                truncated: true,
            }),
            spans: Vec::new(),
            total_bytes,
            source_ordinal: None,
            source_key: Some(chunk_id.to_string()),
        }],
    ))
}

#[allow(clippy::too_many_arguments)]
fn project_legacy_json_field(
    conn: &rusqlite::Connection,
    session_id: &str,
    chunk_id: &str,
    column: LegacyJsonColumn,
    root_total_bytes: u64,
    preview_limit: usize,
    tail: bool,
    function_name: &str,
) -> Result<Option<(serde_json::Value, Vec<ReplayPayloadDescriptor>)>, String> {
    let column_name = column.column_name();
    let read_bytes = preview_limit
        .saturating_add(LEGACY_UTF8_BOUNDARY_BYTES)
        .min(i64::MAX as usize) as i64;
    let sql = format!(
        "SELECT tree.id, tree.parent,
                length(CAST(tree.key AS BLOB)),
                substr(CAST(tree.key AS BLOB), 1, {}),
                tree.type,
                CASE WHEN tree.atom IS NULL THEN 0
                     ELSE length(CAST(tree.atom AS BLOB)) END,
                CASE WHEN tree.atom IS NULL THEN NULL
                     WHEN tree.type='text' AND ?3<>0 THEN substr(
                         CAST(tree.atom AS BLOB),
                         MAX(1, length(CAST(tree.atom AS BLOB)) - ?4 + 1),
                         ?4
                     )
                     ELSE substr(CAST(tree.atom AS BLOB), 1, ?4) END
           FROM code_session_chunks AS chunks,
                json_tree(chunks.{column_name}) AS tree
          WHERE chunks.session_id=?1 AND chunks.chunk_id=?2
          ORDER BY tree.id
          LIMIT {}",
        LEGACY_JSON_KEY_MAX_BYTES.saturating_add(LEGACY_UTF8_BOUNDARY_BYTES),
        LEGACY_JSON_PROJECTION_MAX_NODES.saturating_add(1)
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare managed {column_name} projection: {err}"))?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            chunk_id,
            if tail { 1_i64 } else { 0_i64 },
            read_bytes
        ])
        .map_err(|err| format!("query managed {column_name} projection: {err}"))?;
    let mut root_value: Option<serde_json::Value> = None;
    let mut containers = HashMap::<i64, (Vec<LegacyJsonPathSegment>, LegacyJsonContainer)>::new();
    let mut payloads = Vec::new();
    let mut projected_bytes = 0_usize;
    let mut node_count = 0_usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read managed {column_name} projection: {err}"))?
    {
        node_count = node_count.saturating_add(1);
        if node_count > LEGACY_JSON_PROJECTION_MAX_NODES {
            return Ok(None);
        }
        let id: i64 = row.get(0).map_err(|err| err.to_string())?;
        let parent: Option<i64> = row.get(1).map_err(|err| err.to_string())?;
        let key_bytes_total = row
            .get::<_, Option<i64>>(2)
            .map_err(|err| err.to_string())?
            .unwrap_or_default()
            .max(0) as usize;
        let key_bytes: Option<Vec<u8>> = row.get(3).map_err(|err| err.to_string())?;
        let node_type: String = row.get(4).map_err(|err| err.to_string())?;
        let atom_total = row.get::<_, i64>(5).map_err(|err| err.to_string())?.max(0) as u64;
        let atom_bytes: Option<Vec<u8>> = row.get(6).map_err(|err| err.to_string())?;
        if let Some(key_bytes) = &key_bytes {
            observe_legacy_db_json_field(key_bytes.len());
            projected_bytes = projected_bytes.saturating_add(key_bytes.len());
        }
        if let Some(atom_bytes) = &atom_bytes {
            observe_legacy_db_json_field(atom_bytes.len());
            projected_bytes = projected_bytes.saturating_add(atom_bytes.len());
        }
        if projected_bytes > LEGACY_JSON_PROJECTION_MAX_BYTES
            || key_bytes_total > LEGACY_JSON_KEY_MAX_BYTES
        {
            return Ok(None);
        }

        let path = if let Some(parent) = parent {
            let Some((parent_path, parent_kind)) = containers.get(&parent) else {
                return Ok(None);
            };
            let key_bytes = key_bytes.as_deref().unwrap_or_default();
            let key = std::str::from_utf8(key_bytes).ok();
            let segment = match parent_kind {
                LegacyJsonContainer::Object => {
                    let Some(key) = key else {
                        return Ok(None);
                    };
                    if key.is_empty()
                        || key.contains('.')
                        || key.bytes().all(|byte| byte.is_ascii_digit())
                    {
                        return Ok(None);
                    }
                    LegacyJsonPathSegment::Key(key.to_string())
                }
                LegacyJsonContainer::Array => {
                    let Some(index) = key.and_then(|key| key.parse::<usize>().ok()) else {
                        return Ok(None);
                    };
                    LegacyJsonPathSegment::Index(index)
                }
            };
            let mut path = parent_path.clone();
            path.push(segment);
            path
        } else {
            if root_value.is_some() {
                return Ok(None);
            }
            Vec::new()
        };
        let field_path = legacy_field_path(column.root(), &path);
        let kind = if field_path.to_ascii_lowercase().contains("diff") {
            ReplayPayloadKind::ToolDiff
        } else {
            legacy_payload_kind(function_name, column.root())
        };
        let (value, container) = match node_type.as_str() {
            "object" => (
                serde_json::Value::Object(serde_json::Map::new()),
                Some(LegacyJsonContainer::Object),
            ),
            "array" => (
                serde_json::Value::Array(Vec::new()),
                Some(LegacyJsonContainer::Array),
            ),
            "text" => {
                let Some(atom_bytes) = atom_bytes.as_deref() else {
                    return Ok(None);
                };
                let text = if atom_total > preview_limit as u64 {
                    let preview = if tail {
                        utf8_tail_preview_bytes(atom_bytes, preview_limit)?
                    } else {
                        utf8_head_preview_bytes(atom_bytes, preview_limit)?
                    };
                    payloads.push(ReplayPayloadDescriptor {
                        field_path: field_path.clone(),
                        kind,
                        encoding: if path.is_empty() {
                            ReplayPayloadEncoding::JsonValue
                        } else {
                            ReplayPayloadEncoding::Utf8Text
                        },
                        body_projection: path.is_empty().then(|| ReplayPayloadBodyProjection {
                            field_path: field_path.clone(),
                            text: preview.clone(),
                            truncated: true,
                        }),
                        spans: Vec::new(),
                        total_bytes: if path.is_empty() {
                            root_total_bytes
                        } else {
                            atom_total
                        },
                        source_ordinal: None,
                        source_key: Some(chunk_id.to_string()),
                    });
                    preview
                } else {
                    String::from_utf8(atom_bytes.to_vec())
                        .map_err(|err| format!("decode managed {field_path}: {err}"))?
                };
                (serde_json::Value::String(text), None)
            }
            "integer" | "real" => {
                let Some(atom_bytes) = atom_bytes.as_deref() else {
                    return Ok(None);
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(atom_bytes) else {
                    return Ok(None);
                };
                (value, None)
            }
            "true" => (serde_json::Value::Bool(true), None),
            "false" => (serde_json::Value::Bool(false), None),
            "null" => (serde_json::Value::Null, None),
            _ => return Ok(None),
        };
        if path.is_empty() {
            root_value = Some(value);
        } else {
            let Some(root) = root_value.as_mut() else {
                return Ok(None);
            };
            if !insert_legacy_json_node(root, &path, value) {
                return Ok(None);
            }
        }
        if let Some(container) = container {
            containers.insert(id, (path, container));
        }
    }
    Ok(root_value.map(|value| (value, payloads)))
}

fn legacy_field_path(root: &str, path: &[LegacyJsonPathSegment]) -> String {
    let mut output = root.to_string();
    for segment in path {
        output.push('.');
        match segment {
            LegacyJsonPathSegment::Key(key) => output.push_str(key),
            LegacyJsonPathSegment::Index(index) => output.push_str(&index.to_string()),
        }
    }
    output
}

fn insert_legacy_json_node(
    root: &mut serde_json::Value,
    path: &[LegacyJsonPathSegment],
    value: serde_json::Value,
) -> bool {
    let Some((last, parents)) = path.split_last() else {
        *root = value;
        return true;
    };
    let mut current = root;
    for segment in parents {
        current = match (current, segment) {
            (serde_json::Value::Object(object), LegacyJsonPathSegment::Key(key)) => {
                let Some(next) = object.get_mut(key) else {
                    return false;
                };
                next
            }
            (serde_json::Value::Array(array), LegacyJsonPathSegment::Index(index)) => {
                let Some(next) = array.get_mut(*index) else {
                    return false;
                };
                next
            }
            _ => return false,
        };
    }
    match (current, last) {
        (serde_json::Value::Object(object), LegacyJsonPathSegment::Key(key)) => {
            object.insert(key.clone(), value);
            true
        }
        (serde_json::Value::Array(array), LegacyJsonPathSegment::Index(index)) => {
            if *index > array.len() {
                return false;
            }
            if *index == array.len() {
                array.push(value);
            } else {
                array[*index] = value;
            }
            true
        }
        _ => false,
    }
}

fn observe_legacy_db_json_field(_bytes: usize) {
    #[cfg(test)]
    LEGACY_MAX_DB_JSON_FIELD_BYTES.fetch_max(_bytes, Ordering::Relaxed);
}

fn utf8_head_preview_bytes(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    let mut end = bytes.len().min(max_bytes);
    while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
        end -= 1;
    }
    let text = std::str::from_utf8(&bytes[..end])
        .map_err(|err| format!("decode managed payload preview: {err}"))?;
    Ok(format!("{text}\n… [payload truncated]"))
}

fn utf8_tail_preview_bytes(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    let mut start = bytes.len().saturating_sub(max_bytes);
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start = start.saturating_add(1);
    }
    let text = std::str::from_utf8(&bytes[start..])
        .map_err(|err| format!("decode managed payload preview: {err}"))?;
    Ok(format!("[payload truncated] …\n{text}"))
}

#[allow(clippy::too_many_arguments)]
fn compact_legacy_json_value(
    value: &mut serde_json::Value,
    field_path: &str,
    is_root: bool,
    limit: usize,
    tail: bool,
    source_key: &str,
    kind: ReplayPayloadKind,
    payloads: &mut Vec<ReplayPayloadDescriptor>,
) {
    match value {
        serde_json::Value::String(text) if text.len() > limit => {
            let total_bytes = if is_root {
                serde_json::to_string(text).map_or(text.len(), |encoded| encoded.len())
            } else {
                text.len()
            } as u64;
            let preview = if tail {
                utf8_tail_preview(text, limit)
            } else {
                utf8_head_preview(text, limit)
            };
            *text = preview.clone();
            payloads.push(ReplayPayloadDescriptor {
                field_path: field_path.to_string(),
                kind,
                encoding: if is_root {
                    ReplayPayloadEncoding::JsonValue
                } else {
                    ReplayPayloadEncoding::Utf8Text
                },
                body_projection: is_root.then(|| ReplayPayloadBodyProjection {
                    field_path: field_path.to_string(),
                    text: preview.clone(),
                    truncated: true,
                }),
                spans: Vec::new(),
                total_bytes,
                source_ordinal: None,
                source_key: Some(source_key.to_string()),
            });
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                compact_legacy_json_value(
                    item,
                    &format!("{field_path}.{index}"),
                    false,
                    limit,
                    tail,
                    source_key,
                    kind,
                    payloads,
                );
            }
        }
        serde_json::Value::Object(object) => {
            for (key, item) in object {
                // Dot-separated paths mirror the existing PayloadRef wire
                // contract. Provider payload keys containing dots are rare;
                // keep such values inline rather than publish an ambiguous
                // range locator.
                if key.contains('.') {
                    continue;
                }
                let child_path = format!("{field_path}.{key}");
                let child_kind = if child_path.to_ascii_lowercase().contains("diff") {
                    ReplayPayloadKind::ToolDiff
                } else {
                    kind
                };
                compact_legacy_json_value(
                    item,
                    &child_path,
                    false,
                    limit,
                    tail,
                    source_key,
                    child_kind,
                    payloads,
                );
            }
        }
        _ => {}
    }
}

fn legacy_payload_kind(function_name: &str, root: &str) -> ReplayPayloadKind {
    match function_name {
        "user" | "user_message" => ReplayPayloadKind::UserMessage,
        "assistant" | "assistant_message" | "agent_message" => ReplayPayloadKind::AssistantContent,
        "thinking" | "reasoning" => ReplayPayloadKind::Reasoning,
        _ if root == "args" => ReplayPayloadKind::ToolArguments,
        _ => ReplayPayloadKind::ToolOutput,
    }
}

fn utf8_head_preview(text: &str, max_bytes: usize) -> String {
    let mut end = text.len().min(max_bytes);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [payload truncated]", &text[..end])
}

fn utf8_tail_preview(text: &str, max_bytes: usize) -> String {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[payload truncated] …\n{}", &text[start..])
}

fn legacy_payload_range(
    session_id: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<ReplayPayloadRange, String> {
    let max_bytes = max_bytes
        .unwrap_or(replay::DEFAULT_PAYLOAD_RANGE_BYTES)
        .clamp(1, replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
    let conn =
        database::db::get_connection().map_err(|err| format!("open managed chunks DB: {err}"))?;
    legacy_payload_range_from_conn(&conn, session_id, event_id, field_path, offset, max_bytes)
}

fn legacy_payload_range_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let (root, path) = field_path.split_once('.').unwrap_or((field_path, ""));
    let column = match root {
        "args" => "args_json",
        "result" => "result_json",
        _ => return Err("fieldPath must start with args or result".to_string()),
    };
    let start = offset.min(i64::MAX as u64) as i64;
    let read_bytes = max_bytes.saturating_add(4).min(i64::MAX as usize) as i64;
    let (total_bytes, bytes): (Option<i64>, Option<Vec<u8>>) = if path.is_empty() {
        let sql = format!(
            "SELECT length(CAST({column} AS BLOB)),
                    substr(CAST({column} AS BLOB), ?3, ?4)
               FROM code_session_chunks WHERE session_id=?1 AND chunk_id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![session_id, event_id, start.saturating_add(1), read_bytes],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    } else {
        let json_path = legacy_sqlite_json_path(path)?;
        let sql = format!(
            "SELECT length(CAST(json_extract({column}, ?3) AS BLOB)),
                    substr(CAST(json_extract({column}, ?3) AS BLOB), ?4, ?5)
               FROM code_session_chunks WHERE session_id=?1 AND chunk_id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![
                session_id,
                event_id,
                json_path,
                start.saturating_add(1),
                read_bytes
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }
    .map_err(|err| format!("load managed payload range: {err}"))?;
    let total_bytes = total_bytes
        .ok_or_else(|| format!("managed payload field not found: {field_path}"))?
        .max(0) as u64;
    let bytes = bytes.unwrap_or_default();
    observe_legacy_db_json_field(bytes.len());
    let mut take = max_bytes.min(bytes.len());
    while take > 0 && std::str::from_utf8(&bytes[..take]).is_err() {
        take -= 1;
    }
    if take == 0 && !bytes.is_empty() {
        return Err(format!(
            "managed payload range starts inside invalid UTF-8: {field_path} at {offset}"
        ));
    }
    let text = String::from_utf8(bytes[..take].to_vec())
        .map_err(|err| format!("decode managed payload range: {err}"))?;
    let next_offset = offset.saturating_add(take as u64).min(total_bytes);
    Ok(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: offset.min(total_bytes),
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    })
}

fn legacy_sqlite_json_path(path: &str) -> Result<String, String> {
    let mut output = "$".to_string();
    for segment in path.split('.') {
        if segment.is_empty() {
            return Err("managed payload path contains an empty segment".to_string());
        }
        if segment.bytes().all(|byte| byte.is_ascii_digit()) {
            output.push('[');
            output.push_str(segment);
            output.push(']');
        } else {
            output.push_str(".\"");
            for character in segment.chars() {
                match character {
                    '\\' => output.push_str("\\\\"),
                    '"' => output.push_str("\\\""),
                    _ => output.push(character),
                }
            }
            output.push('"');
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;

    use super::*;

    fn event(id: &str, session_id: &str, content: &str) -> SessionEvent {
        ingestion::normalize_single(
            &RawActivityChunk {
                chunk_id: Some(id.to_string()),
                session_id: Some(session_id.to_string()),
                action_type: Some("assistant".to_string()),
                function: Some("assistant".to_string()),
                result: Some(serde_json::json!({"content":content})),
                created_at: Some("2026-07-22T00:00:00Z".to_string()),
                ..RawActivityChunk::default()
            },
            session_id,
        )
    }

    fn external_shell_payload_event(
        id: &str,
        session_id: &str,
        call_id: &str,
        source_event_id: &str,
        full_size_bytes: usize,
    ) -> SessionEvent {
        let mut event = ingestion::normalize_single(
            &RawActivityChunk {
                chunk_id: Some(id.to_string()),
                session_id: Some(session_id.to_string()),
                action_type: Some("tool_call".to_string()),
                function: Some("run_command_line".to_string()),
                result: Some(serde_json::json!({"output":"bounded preview"})),
                created_at: Some("2026-07-22T00:00:00Z".to_string()),
                ..RawActivityChunk::default()
            },
            session_id,
        );
        event.ui_canonical = core_types::tool_names::RUN_SHELL.to_string();
        event.call_id = Some(call_id.to_string());
        event.payload_refs = vec![PayloadRef {
            event_id: event.id.clone(),
            field_path: "result.output".to_string(),
            preview: "bounded preview".to_string(),
            full_size_bytes,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::Utf8Text),
            replay_source_id: Some(MANAGED_CLI_REPLAY_SOURCE_ID.to_string()),
            replay_generation: Some("test-generation".to_string()),
            replay_source_event_id: Some(source_event_id.to_string()),
        }];
        event
    }

    fn ten_mib_utf8_shell_payload() -> String {
        const TARGET: usize = 10 * 1024 * 1024;
        let pattern = "你🙂 shell stdout/stderr boundary\n";
        let mut payload = pattern.repeat(TARGET / pattern.len() + 1);
        let mut boundary = TARGET;
        while !payload.is_char_boundary(boundary) {
            boundary -= 1;
        }
        payload.truncate(boundary);
        payload.extend(std::iter::repeat_n('x', TARGET - boundary));
        assert_eq!(payload.len(), TARGET);
        payload
    }

    fn bounded_utf8_payload_bytes(text: &str, offset: u64, max_bytes: usize) -> Vec<u8> {
        let start = offset as usize;
        assert!(text.is_char_boundary(start));
        let mut end = start.saturating_add(max_bytes).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.as_bytes()[start..end].to_vec()
    }

    fn read_complete_external_shell(
        conn: &Connection,
        session_id: &str,
        call_id: &str,
        total_bytes: u64,
        last_sequence: u64,
    ) -> String {
        let mut output = String::new();
        let mut offset = 0_u64;
        loop {
            let range = read_external_shell_manifest_range(
                conn,
                session_id,
                call_id,
                last_sequence,
                total_bytes,
                offset,
                SHELL_REPLAY_RANGE_MAX_BYTES as u64,
            )
            .expect("read external Shell range")
            .expect("external Shell manifest");
            assert!(range
                .frames
                .iter()
                .all(|frame| frame.text.len() <= SHELL_REPLAY_FRAME_MAX_BYTES + 3));
            for frame in range.frames {
                output.push_str(&frame.text);
            }
            if range.eof {
                break;
            }
            assert!(range.next_offset_bytes > offset);
            offset = range.next_offset_bytes;
        }
        output
    }

    #[test]
    fn native_shell_call_id_performs_zero_external_database_probes() {
        assert!(!is_external_shell_manifest_call_id("native-shell-call"));
        assert!(!is_external_shell_manifest_call_id(
            "looks-external-but-short-external-deadbeef"
        ));
        assert!(is_external_shell_manifest_call_id(&format!(
            "managed-call-external-{}",
            "a".repeat(64)
        )));

        let before = EXTERNAL_SHELL_MANIFEST_DB_PROBES.load(Ordering::SeqCst);
        let result = tokio::runtime::Runtime::new()
            .expect("native Shell range runtime")
            .block_on(shell_replay_read_range(
                "native-shell-probe-session".to_string(),
                "native-shell-probe-call".to_string(),
                1,
                1,
                0,
                1,
            ));
        assert!(
            result.is_err(),
            "the synthetic native replay does not exist"
        );
        assert_eq!(
            EXTERNAL_SHELL_MANIFEST_DB_PROBES.load(Ordering::SeqCst),
            before,
            "native #425 range reads must bypass the external DB/task path"
        );
    }

    #[test]
    fn absent_external_schema_is_an_explicit_native_fallback() {
        let conn = Connection::open_in_memory().expect("native-only replay DB");
        conn.execute_batch(
            "CREATE TABLE shell_replays(
                 session_id TEXT NOT NULL,
                 call_id TEXT NOT NULL,
                 PRIMARY KEY(session_id,call_id)
             );",
        )
        .expect("native-only Shell schema marker");
        let call_id = format!("legacy-live-external-{}", "b".repeat(64));
        let external =
            read_external_shell_manifest_range(&conn, "native-only-session", &call_id, 1, 1, 0, 1)
                .expect("missing external table is not corruption");
        assert!(external.is_none());
    }

    #[test]
    fn imported_shell_final_guard_reobserves_same_size_provider_rewrite() {
        use orgtrack_core::store::sqlite::SqliteRecordStore;

        let directory = tempfile::tempdir().expect("imported Shell provider fixture");
        let source_path = directory.path().join("codex-session.jsonl");
        let initial = concat!(
            "{\"timestamp\":\"2026-07-22T00:00:00Z\",\"type\":\"event_msg\",",
            "\"payload\":{\"type\":\"user_message\",\"message\":\"question\"}}\n",
            "{\"timestamp\":\"2026-07-22T00:00:01Z\",\"type\":\"event_msg\",",
            "\"payload\":{\"type\":\"agent_message\",\"message\":\"answer-AAAA\"}}\n",
        );
        let replacement = initial.replace("answer-AAAA", "answer-BBBB");
        assert_eq!(initial.len(), replacement.len());
        fs::write(&source_path, initial).expect("write initial Codex transcript");

        let source = ImportedHistorySourceId::CodexApp;
        let session_id = "codexapp-shell-provider-race";
        let source_session_id = source
            .source_session_id(session_id)
            .expect("Codex source session id");
        let mut cache = Connection::open_in_memory().expect("imported Shell replay cache");
        SqliteRecordStore::init_tables(&cache).expect("replay tables");
        SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
        cache
            .execute(
                "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES(?1,?2,?3,?4)",
                params![
                    source.as_str(),
                    source_session_id,
                    session_id,
                    source_path.to_string_lossy()
                ],
            )
            .expect("bind Codex provider transcript");
        let opened = replay::open_window(&mut cache, source, session_id, ReplayLimits::default())
            .expect("open initial Codex replay");
        validate_imported_shell_snapshot_from_conn(
            &mut cache,
            source,
            session_id,
            &opened.cursor.generation,
            opened.cursor.revision,
        )
        .expect("unchanged provider remains valid");

        // Keep the physical size identical so this specifically proves the
        // final guard observes provider identity/content rather than trusting
        // the previously published compact state or payload length.
        std::thread::sleep(Duration::from_millis(2));
        fs::write(&source_path, replacement).expect("rewrite Codex transcript in place");
        let error = validate_imported_shell_snapshot_from_conn(
            &mut cache,
            source,
            session_id,
            &opened.cursor.generation,
            opened.cursor.revision,
        )
        .expect_err("same-size provider rewrite must invalidate Shell delivery");
        assert!(error.contains("changed while publishing manifests"));
        assert!(error.contains(&opened.cursor.generation));
    }

    #[test]
    fn collaboration_revision_is_part_of_the_shell_artifact_epoch() {
        use orgtrack_core::store::sqlite::SqliteRecordStore;

        let mut conn = Connection::open_in_memory().expect("collaboration Shell cache");
        SqliteRecordStore::init_tables(&conn).expect("replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
        let session_id = "agentsession-collaboration-shell";
        let generation = "collaboration-secondary-v1";
        let first_payload = format!("BEGIN{}END", "A".repeat(96 * 1024));
        let second_payload = format!("BEGIN{}END", "B".repeat(96 * 1024));
        assert_eq!(first_payload.len(), second_payload.len());

        let mut first = external_shell_payload_event(
            "collaboration-shell-event",
            session_id,
            "collaboration-shell-call",
            "collaboration-shell-event",
            first_payload.len(),
        );
        let first_epoch = collaboration_shell_artifact_generation(generation, 41);
        {
            let tx = conn.transaction().expect("first collaboration revision");
            persist_scoped_shell_manifest(
                &tx,
                &mut first,
                COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID,
                session_id,
                &first_epoch,
                |_, offset, max_bytes| {
                    Ok(bounded_utf8_payload_bytes(
                        &first_payload,
                        offset,
                        max_bytes,
                    ))
                },
            )
            .expect("first collaboration Shell manifest");
            tx.commit().expect("commit first collaboration revision");
        }
        let first_state = first.shell_replay.expect("first collaboration state");
        let first_hash = conn
            .query_row(
                "SELECT content_hash FROM imported_replay_shell_segments
                 WHERE session_id=?1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .expect("first collaboration Shell hash");

        // The collaboration generation is intentionally unchanged; only the
        // cursor revision advances after an in-line snapshot rewrite.
        let second_epoch = collaboration_shell_artifact_generation(generation, 42);
        assert_ne!(first_epoch, second_epoch);
        let mut second = external_shell_payload_event(
            "collaboration-shell-event",
            session_id,
            "collaboration-shell-call",
            "collaboration-shell-event",
            second_payload.len(),
        );
        let mut second_reads = 0_usize;
        {
            let tx = conn
                .transaction()
                .expect("rewritten collaboration revision");
            persist_scoped_shell_manifest(
                &tx,
                &mut second,
                COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID,
                session_id,
                &second_epoch,
                |_, offset, max_bytes| {
                    second_reads += 1;
                    Ok(bounded_utf8_payload_bytes(
                        &second_payload,
                        offset,
                        max_bytes,
                    ))
                },
            )
            .expect("rewritten collaboration Shell manifest");
            tx.commit()
                .expect("commit rewritten collaboration revision");
        }
        assert!(
            second_reads > 0,
            "new revision must not hit the old artifact"
        );
        let second_state = second.shell_replay.expect("second collaboration state");
        let (second_hash, stored_epoch): (String, String) = conn
            .query_row(
                "SELECT content_hash,generation FROM imported_replay_shell_segments
                 WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("rewritten collaboration Shell locator");
        assert_ne!(first_hash, second_hash);
        assert_ne!(
            first_state.replay_ref.call_id,
            second_state.replay_ref.call_id
        );
        assert_eq!(stored_epoch, second_epoch);
        let restored = read_complete_external_shell(
            &conn,
            session_id,
            &second_state.replay_ref.call_id,
            second_state.bookmark.visible_bytes,
            second_state.bookmark.visible_through_sequence,
        );
        assert_eq!(restored, second_payload);
    }

    #[test]
    fn shell_events_commit_independently_and_retry_after_later_failure() {
        use orgtrack_core::store::sqlite::SqliteRecordStore;

        let mut conn = Connection::open_in_memory().expect("per-event Shell cache");
        SqliteRecordStore::init_tables(&conn).expect("replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
        let session_id = "cliagent-per-event-shell";
        let payload = "bounded-event-payload".repeat(4_096);
        let mut first = external_shell_payload_event(
            "event-a",
            session_id,
            "call-a",
            "payload-a",
            payload.len(),
        );
        {
            let tx = conn.transaction().expect("first event transaction");
            persist_scoped_shell_manifest(
                &tx,
                &mut first,
                MANAGED_CLI_REPLAY_SOURCE_ID,
                session_id,
                "chunks-1",
                |_, offset, max_bytes| Ok(bounded_utf8_payload_bytes(&payload, offset, max_bytes)),
            )
            .expect("first event manifest");
            tx.commit().expect("commit first event manifest");
        }

        let mut second = external_shell_payload_event(
            "event-b",
            session_id,
            "call-b",
            "payload-b",
            payload.len(),
        );
        {
            let tx = conn.transaction().expect("second event transaction");
            let error = persist_scoped_shell_manifest(
                &tx,
                &mut second,
                MANAGED_CLI_REPLAY_SOURCE_ID,
                session_id,
                "chunks-1",
                |_, _, _| Ok(Vec::new()),
            )
            .expect_err("second event source fails before commit");
            assert!(error.contains("invalid progress"));
            tx.rollback().expect("rollback failed second event");
        }
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_manifests",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("first manifest survives later failure"),
            1
        );
        assert!(read_external_shell_manifest_range(
            &conn,
            session_id,
            &first
                .shell_replay
                .as_ref()
                .expect("first replay state")
                .replay_ref
                .call_id,
            u64::MAX,
            u64::MAX,
            0,
            SHELL_REPLAY_RANGE_MAX_BYTES as u64,
        )
        .expect("first manifest remains readable")
        .is_some());

        let tx = conn.transaction().expect("second event retry transaction");
        persist_scoped_shell_manifest(
            &tx,
            &mut second,
            MANAGED_CLI_REPLAY_SOURCE_ID,
            session_id,
            "chunks-1",
            |_, offset, max_bytes| Ok(bounded_utf8_payload_bytes(&payload, offset, max_bytes)),
        )
        .expect("retry second event manifest");
        tx.commit().expect("commit retried second event");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_manifests",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("both per-event manifests"),
            2
        );
    }

    #[test]
    fn external_shell_payload_is_one_canonical_body_and_updates_atomically() {
        use orgtrack_core::store::sqlite::SqliteRecordStore;

        let directory = tempfile::tempdir().expect("external Shell cache directory");
        let database_path = directory.path().join("replay-cache.sqlite");
        let mut conn = Connection::open(&database_path).expect("external Shell cache DB");
        SqliteRecordStore::init_tables(&conn).expect("external Shell replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");

        let session_id = "cliagent-shared-shell";
        let source_event_id = "shared-ten-mib-payload";
        let payload = ten_mib_utf8_shell_payload();
        let mut range_reads = 0_usize;
        let mut replay_states = Vec::new();
        {
            let tx = conn.transaction().expect("publish shared Shell manifests");
            for index in 0..50 {
                let mut event = external_shell_payload_event(
                    &format!("shell-event-{index}"),
                    session_id,
                    &format!("shell-call-{index}"),
                    source_event_id,
                    payload.len(),
                );
                persist_scoped_shell_manifest(
                    &tx,
                    &mut event,
                    MANAGED_CLI_REPLAY_SOURCE_ID,
                    session_id,
                    "generation-a",
                    |_, offset, max_bytes| {
                        range_reads += 1;
                        Ok(bounded_utf8_payload_bytes(&payload, offset, max_bytes))
                    },
                )
                .expect("publish shared Shell manifest");
                replay_states.push(event.shell_replay.expect("external Shell replay state"));
            }
            tx.commit().expect("commit shared Shell manifests");
        }
        assert!(range_reads > 1, "the first 10 MiB body is range streamed");
        assert!(range_reads < 50, "later calls reuse the immutable artifact");

        let (artifact_count, artifact_bytes): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),COALESCE(SUM(LENGTH(payload)),0)
                 FROM imported_replay_payload_artifacts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("physical artifact accounting");
        assert_eq!(artifact_count, 1);
        assert_eq!(artifact_bytes as usize, payload.len());
        let original_content_hash = conn
            .query_row(
                "SELECT content_hash FROM imported_replay_payload_artifacts
                 WHERE generation='generation-a'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("original canonical content hash");
        let segment_count = conn
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_segments",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("Shell manifest references");
        assert_eq!(segment_count, 50, "50 calls reference one physical body");
        let artifact_reference_count = conn
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("canonical source references");
        assert_eq!(artifact_reference_count, 1);
        let native_slog_table_count = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='shell_replays'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("native .slog table lookup");
        assert_eq!(
            native_slog_table_count, 0,
            "external path creates no native `.slog`"
        );
        let database_bytes = std::fs::metadata(&database_path)
            .expect("external Shell cache file")
            .len();
        assert!(
            // SQLite may retain the temporary content-key pages on its
            // freelist until a later vacuum, so allow that one transient body
            // in addition to the one live BLOB. Fifty live copies would be
            // roughly 500 MiB and fail this bound by a wide margin.
            database_bytes < (payload.len() as u64) * 3,
            "50 manifests must not make 50 physical 10 MiB bodies: {database_bytes} bytes"
        );

        let first_state = &replay_states[0];
        let restored = read_complete_external_shell(
            &conn,
            session_id,
            &first_state.replay_ref.call_id,
            first_state.bookmark.visible_bytes,
            first_state.bookmark.visible_through_sequence,
        );
        assert_eq!(
            sha256_hex(restored.as_bytes()),
            sha256_hex(payload.as_bytes())
        );

        // Delivering the same immutable epoch again must neither read provider
        // ranges nor rewrite the unchanged manifest/segments.
        let mut unchanged = external_shell_payload_event(
            "shell-event-0",
            session_id,
            "shell-call-0",
            source_event_id,
            payload.len(),
        );
        let unchanged_call_id = {
            let tx = conn.transaction().expect("unchanged Shell delivery");
            let mut repeated_reads = 0_usize;
            persist_scoped_shell_manifest(
                &tx,
                &mut unchanged,
                MANAGED_CLI_REPLAY_SOURCE_ID,
                session_id,
                "generation-a",
                |_, _, _| {
                    repeated_reads += 1;
                    Ok(Vec::new())
                },
            )
            .expect("reuse unchanged Shell manifest");
            assert_eq!(repeated_reads, 0);
            tx.commit().expect("commit unchanged delivery");
            unchanged
                .shell_replay
                .as_ref()
                .expect("unchanged replay state")
                .replay_ref
                .call_id
                .clone()
        };
        assert_eq!(unchanged_call_id, first_state.replay_ref.call_id);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_segments",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("unchanged segment count"),
            50
        );

        // A new immutable generation with the same byte length must be read
        // and hashed again; length alone can never select the old body.
        let mut changed_payload = payload.clone();
        changed_payload.replace_range(0.."你".len(), "界");
        assert_eq!(changed_payload.len(), payload.len());
        let mut changed = external_shell_payload_event(
            "shell-event-0",
            session_id,
            "shell-call-0",
            source_event_id,
            changed_payload.len(),
        );
        let mut changed_reads = 0_usize;
        {
            let tx = conn.transaction().expect("changed Shell generation");
            persist_scoped_shell_manifest(
                &tx,
                &mut changed,
                MANAGED_CLI_REPLAY_SOURCE_ID,
                session_id,
                "generation-b",
                |_, offset, max_bytes| {
                    changed_reads += 1;
                    Ok(bounded_utf8_payload_bytes(
                        &changed_payload,
                        offset,
                        max_bytes,
                    ))
                },
            )
            .expect("publish same-length changed Shell body");
            tx.commit().expect("commit changed Shell generation");
        }
        assert!(changed_reads > 1);
        let changed_state = changed.shell_replay.expect("changed replay state");
        assert_ne!(changed_state.replay_ref.call_id, unchanged_call_id);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_segments
                 WHERE session_id=?1 AND call_id=?2",
                params![session_id, unchanged_call_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("obsolete call segment count"),
            0,
            "replacement must explicitly remove old segments with foreign_keys OFF"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_segments
                 WHERE content_hash=?1",
                [&original_content_hash],
                |row| row.get::<_, i64>(0),
            )
            .expect("remaining shared-body references"),
            49,
            "the other 49 calls still share and retain the original body"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_segments",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("replacement segment count"),
            50
        );
        let changed_restored = read_complete_external_shell(
            &conn,
            session_id,
            &changed_state.replay_ref.call_id,
            changed_state.bookmark.visible_bytes,
            changed_state.bookmark.visible_through_sequence,
        );
        assert_eq!(
            sha256_hex(changed_restored.as_bytes()),
            sha256_hex(changed_payload.as_bytes())
        );
        assert_ne!(
            sha256_hex(payload.as_bytes()),
            sha256_hex(changed_payload.as_bytes())
        );

        // Simulate a failed/crashed replacement: artifact, refs, manifest and
        // segment publication share one transaction, so rollback must leave
        // the last committed canonical body readable.
        let mut rolled_back_payload = changed_payload.clone();
        rolled_back_payload.replace_range(0.."界".len(), "中");
        let mut rolled_back = external_shell_payload_event(
            "shell-event-0",
            session_id,
            "shell-call-0",
            source_event_id,
            rolled_back_payload.len(),
        );
        {
            let tx = conn.transaction().expect("failed Shell replacement");
            persist_scoped_shell_manifest(
                &tx,
                &mut rolled_back,
                MANAGED_CLI_REPLAY_SOURCE_ID,
                session_id,
                "generation-c",
                |_, offset, max_bytes| {
                    Ok(bounded_utf8_payload_bytes(
                        &rolled_back_payload,
                        offset,
                        max_bytes,
                    ))
                },
            )
            .expect("stage failed Shell replacement");
            tx.rollback().expect("rollback failed Shell replacement");
        }
        let committed_call_id = conn
            .query_row(
                "SELECT call_id FROM imported_replay_shell_manifests
                 WHERE session_id=?1 AND logical_call_id='shell-call-0'",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .expect("committed manifest after rollback");
        assert_eq!(committed_call_id, changed_state.replay_ref.call_id);
        let after_rollback = read_complete_external_shell(
            &conn,
            session_id,
            &committed_call_id,
            changed_state.bookmark.visible_bytes,
            changed_state.bookmark.visible_through_sequence,
        );
        assert_eq!(
            sha256_hex(after_rollback.as_bytes()),
            sha256_hex(changed_payload.as_bytes())
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE generation='generation-c'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("rolled-back artifact count"),
            0
        );

        // Repeated identity replacements stay at one segment for this
        // logical call even though this connection deliberately leaves
        // SQLite foreign_keys at its default OFF.
        let changed_artifact = conn
            .query_row(
                "SELECT source,source_session_id,generation,content_hash,LENGTH(payload)
                 FROM imported_replay_payload_artifacts
                 WHERE generation='generation-b'",
                [],
                |row| {
                    Ok(replay::ReplayPayloadArtifactLocator {
                        source_id: row.get(0)?,
                        source_session_id: row.get(1)?,
                        generation: row.get(2)?,
                        content_hash: row.get(3)?,
                        total_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                    })
                },
            )
            .expect("changed canonical artifact");
        for iteration in 0..6 {
            let mut replacement = external_shell_payload_event(
                "shell-event-0",
                session_id,
                "shell-call-0",
                source_event_id,
                changed_payload.len(),
            );
            let tx = conn.transaction().expect("repeat manifest replacement");
            publish_external_shell_manifest(
                &tx,
                &mut replacement,
                &[CanonicalExternalShellSegment {
                    stream: if iteration % 2 == 0 {
                        ShellReplayStream::Stderr
                    } else {
                        ShellReplayStream::Stdout
                    },
                    artifact: changed_artifact.clone(),
                    preview: "changed preview".to_string(),
                }],
            )
            .expect("repeat external Shell replacement");
            tx.commit().expect("commit repeat manifest replacement");
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM imported_replay_shell_segments",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("non-staircase segment count"),
                50
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*)
                     FROM imported_replay_shell_segments AS segment
                     JOIN imported_replay_shell_manifests AS manifest
                       ON manifest.session_id=segment.session_id
                      AND manifest.call_id=segment.call_id
                     WHERE manifest.session_id=?1
                       AND manifest.logical_call_id='shell-call-0'",
                    [session_id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("single live logical-call segment"),
                1
            );
        }
    }

    fn delta(events: Vec<SessionEvent>, removed: Vec<String>, reset: bool) -> ExternalReplayDelta {
        ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: "codex_app".to_string(),
                session_id: "codexapp-test".to_string(),
                generation: "g1".to_string(),
                revision: 1,
                through_sequence: 0,
            },
            events,
            removed_event_ids: removed,
            reset_required: reset,
            stats: ReplayStats::default(),
            watcher_available: false,
        }
    }

    fn handoff_chunk(
        sequence: i64,
        action_type: &str,
        function: &str,
        content: &str,
    ) -> ReplayIndexedChunk {
        let mut chunk = ActivityChunk::new("codexapp-handoff", action_type, function);
        chunk.chunk_id = format!("handoff-{sequence}");
        chunk.result = serde_json::json!({"content":content});
        ReplayIndexedChunk {
            sequence,
            turn_index: sequence,
            chunk,
            payloads: Vec::new(),
        }
    }

    fn handoff_page(
        generation: &str,
        chunks: Vec<ReplayIndexedChunk>,
        has_older: bool,
    ) -> BackendWindow {
        let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
        let ipc_bytes = compact_handoff_page_bytes(&chunks) as u64;
        BackendWindow::Imported(ReplayChunkWindow {
            cursor: ReplayCursor {
                source_id: "codex_app".to_string(),
                session_id: "codexapp-handoff".to_string(),
                generation: generation.to_string(),
                revision: 1,
                through_sequence,
            },
            total_turn_count: chunks.len() as u64,
            total_event_count: chunks.len() as u64,
            chunks,
            turn_headers: Vec::new(),
            has_older,
            stats: ReplayStats {
                ipc_bytes,
                ..ReplayStats::default()
            },
        })
    }

    fn handoff_turn_page(
        generation: &str,
        turn_index: i64,
        total_turns: u64,
        mut chunks: Vec<ReplayIndexedChunk>,
        has_older: bool,
    ) -> BackendWindow {
        for chunk in &mut chunks {
            chunk.turn_index = turn_index;
        }
        let start_sequence = chunks.first().map_or(0, |chunk| chunk.sequence);
        let end_sequence = chunks.last().map(|chunk| chunk.sequence);
        let mut page = handoff_page(generation, chunks, has_older);
        if let BackendWindow::Imported(window) = &mut page {
            window.total_turn_count = total_turns;
            window.turn_headers = vec![ReplayTurnHeader {
                turn_id: format!("turn-{turn_index}"),
                turn_index,
                start_sequence,
                end_sequence,
                started_at: "2026-07-22T00:00:00Z".to_string(),
                ended_at: Some("2026-07-22T00:00:01Z".to_string()),
                event_count: window.chunks.len() as u64,
            }];
        }
        page
    }

    #[test]
    fn stream_cursor_guard_rejects_same_generation_new_revision() {
        let current = ReplayCursor {
            source_id: "opencode".to_string(),
            session_id: "opencode-test".to_string(),
            generation: "g1".to_string(),
            revision: 8,
            through_sequence: 200,
        };
        let error = validate_stream_replay_cursor("g1", 7, &current, "testing")
            .expect_err("same-generation revision changes must reset the stream");
        assert!(error.contains("g1@7"));
        assert!(error.contains("g1@8"));

        let error = validate_legacy_stream_cursor(
            "chunks-3",
            200,
            &("chunks-3".to_string(), 201),
            "testing managed replay",
        )
        .expect_err("same-generation managed appends must reset the stream");
        assert!(error.contains("chunks-3@200"));
        assert!(error.contains("chunks-3@201"));
    }

    #[test]
    fn export_and_cloud_prepare_three_lazy_kv_turns_before_strict_streaming() {
        use orgtrack_core::store::sqlite::SqliteRecordStore;

        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let directory = tempfile::tempdir().expect("lazy stream fixture");
            let source_path = directory.path().join(format!("{}.db", source.as_str()));
            let source_conn = Connection::open(&source_path).expect("KV source DB");
            source_conn
                .execute_batch(
                    "PRAGMA journal_mode=WAL;
                     CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
                )
                .expect("KV source schema");
            let headers = (0..6)
                .map(|index| {
                    serde_json::json!({
                        "bubbleId":format!("b{index}"),
                        "type":if index % 2 == 0 { 1 } else { 2 },
                    })
                })
                .collect::<Vec<_>>();
            source_conn
                .execute(
                    "INSERT INTO cursorDiskKV(key,value) VALUES('composerData:c1',?1)",
                    [serde_json::json!({
                        "composerId":"c1",
                        "createdAt":1,
                        "lastUpdatedAt":6,
                        "fullConversationHeadersOnly":headers,
                    })
                    .to_string()],
                )
                .expect("composer row");
            for index in 0..6 {
                source_conn
                    .execute(
                        "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                        rusqlite::params![
                            format!("bubbleId:c1:b{index}"),
                            serde_json::json!({
                                "bubbleId":format!("b{index}"),
                                "type":if index % 2 == 0 { 1 } else { 2 },
                                "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
                                "text":format!("message {index}"),
                            })
                            .to_string(),
                        ],
                    )
                    .expect("bubble row");
            }

            let mut cache = Connection::open_in_memory().expect("replay cache");
            SqliteRecordStore::init_tables(&cache).expect("replay tables");
            SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
            let session_id = format!("{}c1", source.descriptor().session_prefix);
            cache
                .execute(
                    "INSERT INTO imported_history_session_cache(
                         source,source_session_id,session_id,source_path
                     ) VALUES(?1,'c1',?2,?3)",
                    rusqlite::params![source.as_str(), session_id, source_path.to_string_lossy()],
                )
                .expect("cache source path");
            let limits = ReplayLimits {
                max_turns: 1,
                max_events: 1,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let prepared = prepare_stream_replay_snapshot(&mut cache, source, &session_id, limits)
                .expect("prepare export/cloud snapshot");
            let mut after_sequence = -1_i64;
            let mut sequences = Vec::new();
            loop {
                let scan = replay::scan_window_after_generation(
                    &mut cache,
                    source,
                    &session_id,
                    &prepared.generation,
                    prepared.revision,
                    after_sequence,
                    limits,
                )
                .expect("strict export/cloud scan");
                sequences.extend(scan.chunks.iter().map(|chunk| chunk.sequence));
                after_sequence = scan.cursor.through_sequence;
                if !scan.has_more {
                    break;
                }
            }
            assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
        }
    }

    #[test]
    fn failed_export_preserves_destination_and_removes_unique_partial() {
        let directory = std::env::temp_dir().join(format!(
            "orgii-replay-export-atomic-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("export test directory");
        let destination = directory.join("history.json");
        fs::write(&destination, b"previous-valid-export").expect("old destination");

        let error = stream_replay_export(
            "not-a-replay-source",
            "not-a-session",
            destination.to_str().expect("UTF-8 destination"),
            ReplayExportFormat::Json,
            None,
        )
        .expect_err("invalid source must fail after opening the temporary file");

        assert!(!error.is_empty());
        assert_eq!(
            fs::read(&destination).expect("preserved destination"),
            b"previous-valid-export"
        );
        let partials = fs::read_dir(&directory)
            .expect("export directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".history.json.orgii-") && name.ends_with(".part")
            })
            .count();
        assert_eq!(partials, 0, "failed export left a partial file");

        fs::remove_file(destination).expect("remove destination");
        fs::remove_dir(directory).expect("remove export test directory");
    }

    #[test]
    fn not_ready_is_typed_and_non_destructive() {
        let window = not_ready_window(MANAGED_CLI_REPLAY_SOURCE_ID, "cliagent-test");
        assert!(window.stats.not_ready);
        assert!(window.events.is_empty());
        assert_eq!(window.cursor.generation, "pending");
    }

    #[test]
    fn fork_handoff_keeps_existing_semantics_skips_reasoning_and_caps_utf16_text() {
        let user = handoff_chunk(0, "user_message", "unknown", "fix the sync");
        let thinking = handoff_chunk(1, "reasoning", "thinking", "private chain of thought");
        let mut tool = handoff_chunk(2, "tool_call", "read_file", "old file");
        tool.chunk.args = serde_json::json!({"content":"src/sync.ts"});
        tool.chunk.result = serde_json::json!({"output":"old file"});
        let assistant = handoff_chunk(3, "assistant", "assistant", "I found the issue");

        assert_eq!(
            handoff_item_from_chunk(&user.chunk, "Claude App").as_deref(),
            Some("User: fix the sync")
        );
        assert!(handoff_item_from_chunk(&thinking.chunk, "Claude App").is_none());
        assert_eq!(
            handoff_item_from_chunk(&tool.chunk, "Claude App").as_deref(),
            Some(
                "[Imported Claude App action]\nTool: read_file\nInput: src/sync.ts\nResult at that time: old file"
            )
        );
        assert_eq!(
            handoff_item_from_chunk(&assistant.chunk, "Claude App").as_deref(),
            Some("Assistant: I found the issue")
        );

        let huge = handoff_chunk(4, "raw", "user_message", &"🙂".repeat(2_000));
        let bounded = handoff_item_from_chunk(&huge.chunk, "Codex App").expect("bounded user item");
        assert!(bounded.encode_utf16().count() <= EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn fork_handoff_pages_backwards_with_one_generation_and_no_runtime_side_effects() {
        let session_id = "codexapp-fork-handoff-pure";
        release_session_runtime(session_id);
        let mut calls = 0_usize;
        let handoff = collect_external_replay_handoff("Codex App", |before, turn, limits| {
            calls += 1;
            assert!(limits.max_ipc_bytes <= EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES);
            match calls {
                1 => {
                    assert_eq!(before, None);
                    assert_eq!(turn, None);
                    // Cursor/Windsurf cold indexes can report `hasOlder=false`
                    // because only the latest body is hydrated. The compact
                    // turn header still proves that turn 0 must be requested.
                    Ok(handoff_turn_page(
                        "generation-1",
                        1,
                        2,
                        vec![handoff_chunk(50, "reasoning", "thinking", "private")],
                        false,
                    ))
                }
                2 => {
                    assert_eq!(before, None);
                    assert_eq!(turn, Some(0));
                    Ok(handoff_turn_page(
                        "generation-1",
                        0,
                        2,
                        vec![
                            handoff_chunk(10, "raw", "user_message", "usable older ask"),
                            handoff_chunk(11, "assistant", "assistant", "older answer"),
                        ],
                        false,
                    ))
                }
                _ => panic!("handoff requested an unnecessary page"),
            }
        })
        .expect("paged handoff");
        assert_eq!(
            handoff.items,
            vec![
                "User: usable older ask".to_string(),
                "Assistant: older answer".to_string()
            ]
        );
        assert_eq!(handoff.generation, "generation-1");
        assert_eq!(handoff.scanned_events, 3);
        assert!(handoff.scanned_bytes <= EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES as u64);
        assert!(!replay_request_epochs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id));
        assert!(!external_replay_watcher::is_available(session_id));
    }

    #[test]
    fn fork_handoff_rejects_cross_page_generation_mixing() {
        let mut calls = 0_usize;
        let error = collect_external_replay_handoff("Codex App", |_before, _turn, _limits| {
            calls += 1;
            if calls == 1 {
                Ok(handoff_page(
                    "generation-a",
                    vec![handoff_chunk(50, "reasoning", "thinking", "private")],
                    true,
                ))
            } else {
                Ok(handoff_page(
                    "generation-b",
                    vec![handoff_chunk(10, "raw", "user_message", "older")],
                    false,
                ))
            }
        })
        .expect_err("mixed replay generations must fail closed");
        assert!(error.contains("changed generation"));
        assert!(error.contains("retry"));
    }

    #[test]
    fn fork_handoff_rejects_cross_page_revision_mixing() {
        let mut calls = 0_usize;
        let error = collect_external_replay_handoff("Codex App", |_before, _turn, _limits| {
            calls += 1;
            if calls == 1 {
                Ok(handoff_page(
                    "generation-a",
                    vec![handoff_chunk(50, "reasoning", "thinking", "private")],
                    true,
                ))
            } else {
                let mut page = handoff_page(
                    "generation-a",
                    vec![handoff_chunk(10, "raw", "user_message", "older")],
                    false,
                );
                if let BackendWindow::Imported(window) = &mut page {
                    window.cursor.revision = 2;
                }
                Ok(page)
            }
        })
        .expect_err("mixed replay revisions must fail closed");
        assert!(error.contains("changed revision"));
        assert!(error.contains("retry"));
    }

    #[test]
    fn fork_handoff_returns_only_the_last_eighty_usable_items() {
        let chunks = (0..100)
            .map(|sequence| {
                handoff_chunk(sequence, "raw", "user_message", &format!("item-{sequence}"))
            })
            .collect::<Vec<_>>();
        let handoff = collect_external_replay_handoff("Codex App", |_before, _turn, _limits| {
            Ok(handoff_page("generation-1", chunks.clone(), false))
        })
        .expect("bounded handoff");
        assert_eq!(handoff.items.len(), EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS);
        assert_eq!(
            handoff.items.first().map(String::as_str),
            Some("User: item-20")
        );
        assert_eq!(
            handoff.items.last().map(String::as_str),
            Some("User: item-99")
        );
        assert_eq!(handoff.scanned_events, 100);
        assert!(handoff.scanned_bytes <= EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES as u64);
    }

    #[test]
    fn same_id_and_content_is_a_true_no_op() {
        let existing = event("same", "codexapp-test", "unchanged");
        let mut store = EventStore::new();
        store.set(vec![existing.clone()]);
        let applied =
            apply_external_replay_delta(&mut store, &delta(vec![existing], Vec::new(), false));
        assert_eq!(applied, ReplayApplyResult::default());
    }

    #[test]
    fn removals_are_applied_to_the_display_session_store() {
        let mut store = EventStore::new();
        store.set(vec![event("remove-me", "cliagent-test", "old")]);
        let applied = apply_external_replay_delta(
            &mut store,
            &delta(Vec::new(), vec!["remove-me".to_string()], false),
        );
        assert_eq!(applied.removed, 1);
        assert!(store.get_by_id("remove-me").is_none());
    }

    #[test]
    fn generation_reset_replaces_with_bounded_canonical_window() {
        let mut store = EventStore::new();
        store.set(vec![event("ephemeral", "cliagent-test", "old")]);
        let canonical = event("canonical", "cliagent-test", "new");
        let applied =
            apply_external_replay_delta(&mut store, &delta(vec![canonical], Vec::new(), true));
        assert!(applied.changed);
        assert!(store.get_by_id("ephemeral").is_none());
        assert_eq!(
            store
                .get_by_id("canonical")
                .expect("canonical event")
                .session_id,
            "cliagent-test"
        );
        assert_eq!(
            store.hydration_mode(),
            crate::agent_sessions::event_pipeline::store::HydrationMode::RoundWindow,
            "a generation reset is still a bounded replay window, not a fully hydrated transcript"
        );
    }

    #[test]
    fn newer_request_epoch_invalidates_late_results_without_cross_session_leakage() {
        let session_a = "cliagent-request-epoch-a";
        let session_b = "cliagent-request-epoch-b";
        let first_a = begin_replay_request(session_a, 10, true).expect("open A");
        let first_b = begin_replay_request(session_b, 20, true).expect("open B");

        assert!(is_current_replay_request(session_a, 10, first_a));
        assert!(is_current_replay_request(session_b, 20, first_b));

        let second_a = begin_replay_request(session_a, 10, false).expect("poll A");
        assert!(!is_current_replay_request(session_a, 10, first_a));
        assert!(is_current_replay_request(session_a, 10, second_a));
        assert!(is_current_replay_episode(session_a, 10));
        assert!(is_current_replay_request(session_b, 20, first_b));
    }

    #[test]
    fn release_then_reopen_cannot_resurrect_an_a_to_b_to_a_result() {
        let session_a = "codexapp-request-release-a";
        let stale_a = begin_replay_request(session_a, 100, true).expect("first A");
        release_session_runtime_if_episode(session_a, 100);
        assert!(!is_current_replay_request(session_a, 100, stale_a));
        assert!(!is_current_replay_episode(session_a, 100));

        let reopened_a = begin_replay_request(session_a, 101, true).expect("reopen A");
        assert_ne!(reopened_a, stale_a);
        assert!(is_current_replay_episode(session_a, 101));
        // A delayed cleanup from the first episode cannot release A2.
        release_session_runtime_if_episode(session_a, 100);
        assert!(!is_current_replay_request(session_a, 100, stale_a));
        assert!(is_current_replay_request(session_a, 101, reopened_a));
        release_session_runtime(session_a);
    }

    #[test]
    fn prewarm_episode_is_independent_and_release_rejects_late_a_completion() {
        let session_a = "codexapp-prewarm-episode-a";
        let first = begin_prewarm_request(session_a, 40).expect("first prewarm");
        assert!(is_current_prewarm_request(session_a, 40, first));
        assert!(!replay_request_epochs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_a));

        let current = begin_prewarm_request(session_a, 41).expect("newer prewarm");
        assert!(!is_current_prewarm_request(session_a, 40, first));
        assert!(is_current_prewarm_request(session_a, 41, current));
        assert!(begin_prewarm_request(session_a, 40).is_err());

        release_session_runtime(session_a);
        assert!(!is_current_prewarm_request(session_a, 41, current));
        assert!(begin_prewarm_request(session_a, 41).is_err());
        let reopened = begin_prewarm_request(session_a, 42).expect("reopened prewarm");
        assert_ne!(reopened, first);
        assert!(is_current_prewarm_request(session_a, 42, reopened));
        release_session_runtime(session_a);
    }

    #[test]
    fn foreground_release_cancels_current_prewarm_without_touching_native_state() {
        let external_session = "codexapp-prewarm-release";
        let foreground = begin_replay_request(external_session, 500, true).expect("foreground");
        let prewarm = begin_prewarm_request(external_session, 12).expect("prewarm");
        assert!(is_current_replay_request(external_session, 500, foreground));
        assert!(is_current_prewarm_request(external_session, 12, prewarm));
        release_session_runtime_if_episode(external_session, 500);
        assert!(!is_current_prewarm_request(external_session, 12, prewarm));

        let native_session = "sdeagent-native-prewarm-boundary";
        assert!(validate_prewarm_target_identity("codex_app", native_session).is_err());
        assert!(!prewarm_request_epochs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(native_session));
    }

    #[test]
    fn cancelled_prewarm_cannot_commit_or_reopen_the_same_episode() {
        let session_id = "codexapp-prewarm-atomic-commit";
        let state = EventStoreState::new();
        let stale_epoch = begin_prewarm_request(session_id, 70).expect("first prewarm");
        cancel_prewarm_requests(session_id);

        assert!(!apply_prewarm_window_if_current(
            &state,
            session_id,
            70,
            stale_epoch,
            &[event("stale", session_id, "must not publish")],
        ));
        assert!(state
            .with_store_opt(session_id, |store| store.events().len())
            .is_none());
        assert!(begin_prewarm_request(session_id, 70).is_err());

        let current_epoch = begin_prewarm_request(session_id, 71).expect("next visit");
        assert!(apply_prewarm_window_if_current(
            &state,
            session_id,
            71,
            current_epoch,
            &[event("current", session_id, "publish")],
        ));
        assert_eq!(
            state.with_store_opt(session_id, |store| store.events().len()),
            Some(1)
        );
        release_session_runtime(session_id);
    }

    #[test]
    fn stale_query_generation_or_revision_cannot_be_applied() {
        validate_query_apply_version("generation-b", 8, "generation-b", 8)
            .expect("current query is accepted");
        assert!(validate_query_apply_version("generation-a", 7, "generation-b", 8).is_err());
        assert!(validate_query_apply_version("generation-b", 7, "generation-b", 8).is_err());
    }

    #[test]
    fn final_wire_budget_counts_normalized_payload_refs_and_fails_closed() {
        let mut replay_event = event("payload", "codexapp-test", "preview");
        replay_event.payload_refs.push(PayloadRef {
            event_id: replay_event.id.clone(),
            field_path: "result.content".to_string(),
            preview: "x".repeat(70 * 1024),
            full_size_bytes: 10 * 1024 * 1024,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::Utf8Text),
            replay_source_id: Some("codex_app".to_string()),
            replay_generation: Some("g1".to_string()),
            replay_source_event_id: Some("payload".to_string()),
        });
        let cursor = ReplayCursor {
            source_id: "codex_app".to_string(),
            session_id: "codexapp-test".to_string(),
            generation: "g1".to_string(),
            revision: 7,
            through_sequence: 7,
        };
        let mut window = ExternalReplayWindow {
            cursor: cursor.clone(),
            events: vec![replay_event],
            window_start_sequence: Some(7),
            turn_headers: Vec::new(),
            total_turn_count: 1,
            total_event_count: 1,
            has_older: false,
            stats: ReplayStats::default(),
            watcher_available: false,
        };
        let error = finalize_window_wire_budget(&mut window, 64 * 1024)
            .expect_err("payload ref must count toward wire bytes");
        assert!(error.contains("serialized bytes"));
        assert_eq!(
            window.cursor, cursor,
            "failed wire check never advances cursor"
        );
    }

    #[test]
    fn two_hundred_max_preview_events_stay_under_the_hard_wire_cap() {
        let events = (0..200)
            .map(|index| {
                let mut row = event(
                    &format!("event-{index}"),
                    "codexapp-test",
                    &"x".repeat(replay::NORMAL_PAYLOAD_PREVIEW_BYTES),
                );
                row.payload_refs.push(PayloadRef {
                    event_id: row.id.clone(),
                    field_path: "result.content".to_string(),
                    preview: String::new(),
                    full_size_bytes: 10 * 1024 * 1024,
                    truncated: true,
                    replay_encoding: Some(PayloadRefEncoding::Utf8Text),
                    replay_source_id: Some("codex_app".to_string()),
                    replay_generation: Some("g1".to_string()),
                    replay_source_event_id: Some(row.id.clone()),
                });
                row
            })
            .collect::<Vec<_>>();
        let mut window = ExternalReplayWindow {
            cursor: ReplayCursor {
                source_id: "codex_app".to_string(),
                session_id: "codexapp-test".to_string(),
                generation: "g1".to_string(),
                revision: 200,
                through_sequence: 199,
            },
            events,
            window_start_sequence: Some(0),
            turn_headers: Vec::new(),
            total_turn_count: 1,
            total_event_count: 200,
            has_older: false,
            stats: ReplayStats::default(),
            watcher_available: false,
        };
        finalize_window_wire_budget(&mut window, replay::HARD_MAX_IPC_BYTES)
            .expect("200 normal previews fit hard cap");
        assert!(window.stats.ipc_bytes <= replay::HARD_MAX_IPC_BYTES as u64);
    }

    #[test]
    fn native_session_release_does_not_create_replay_runtime_state() {
        let native_session = "osagent-native-replay-boundary";
        release_session_runtime(native_session);
        assert!(!replay_request_epochs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(native_session));
        assert!(!external_replay_watcher::is_available(native_session));
    }

    #[test]
    fn stable_json_matches_the_frontend_sorted_key_contract() {
        let mut bytes = Vec::new();
        write_stable_json(
            &mut bytes,
            &serde_json::json!({"z": [3, {"b": true, "a": null}], "a": 1}),
        )
        .expect("stable json");
        assert_eq!(
            String::from_utf8(bytes).expect("utf8"),
            r#"{"a":1,"z":[3,{"a":null,"b":true}]}"#
        );
    }

    #[test]
    fn hashing_writer_reports_exact_stream_hash_and_byte_count() {
        let mut writer = HashingWriter::new(Vec::new());
        writer.write_all(b"bounded ").expect("first write");
        writer.write_all(b"export").expect("second write");
        let (bytes, hash, output) = writer.finish();
        assert_eq!(bytes, 14);
        assert_eq!(output, b"bounded export");
        assert_eq!(hash, sha256_hex(b"bounded export"));
    }

    #[test]
    fn hydrated_export_splices_large_json_strings_in_bounded_ranges() {
        let preview = "small preview";
        let mut replay_event = event("large", "codexapp-test", preview);
        replay_event.payload_refs = vec![PayloadRef {
            event_id: replay_event.id.clone(),
            field_path: "result.content".to_string(),
            preview: preview.to_string(),
            full_size_bytes: 0,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::Utf8Text),
            replay_source_id: Some("codex_app".to_string()),
            replay_generation: Some("g1".to_string()),
            replay_source_event_id: Some("large".to_string()),
        }];
        let full = format!("{}END", "quote=\" slash=\\ newline=\n 中🙂 ".repeat(40_000));
        replay_event.payload_refs[0].full_size_bytes = full.len();
        let mut output = Vec::new();
        let mut calls = 0_usize;
        write_hydrated_event_json(&mut output, &replay_event, &mut |payload_ref, offset| {
            assert_eq!(payload_ref.field_path, "result.content");
            calls += 1;
            let start = offset as usize;
            let mut end = start.saturating_add(7 * 1024).min(full.len());
            while end > start && !full.is_char_boundary(end) {
                end -= 1;
            }
            Ok(ReplayPayloadRange {
                event_id: payload_ref.event_id.clone(),
                field_path: payload_ref.field_path.clone(),
                offset,
                next_offset: end as u64,
                eof: end == full.len(),
                total_bytes: full.len() as u64,
                text: full[start..end].to_string(),
            })
        })
        .expect("stream hydrated event");

        let decoded: serde_json::Value =
            serde_json::from_slice(&output).expect("valid streamed event JSON");
        assert_eq!(
            decoded.pointer("/result/content").and_then(|v| v.as_str()),
            Some(full.as_str())
        );
        assert_eq!(
            decoded.get("displayText").and_then(|v| v.as_str()),
            Some(full.as_str())
        );
        assert!(decoded.get("payloadRefs").is_none());
        assert!(
            calls > 2,
            "field and display copies must both use range reads"
        );
    }

    #[test]
    fn hydrated_export_restores_large_payload_inside_an_array() {
        let preview = "array preview";
        let mut replay_event = event("array", "managed-session", preview);
        replay_event.args = serde_json::json!({"items":[preview, "kept"]});
        replay_event.display_text = preview.to_string();
        replay_event.payload_refs = vec![PayloadRef {
            event_id: replay_event.id.clone(),
            field_path: "args.items.0".to_string(),
            preview: preview.to_string(),
            full_size_bytes: 0,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::Utf8Text),
            replay_source_id: Some(MANAGED_CLI_REPLAY_SOURCE_ID.to_string()),
            replay_generation: Some("legacy-generation".to_string()),
            replay_source_event_id: Some("array".to_string()),
        }];
        let mut full = "array-payload-中🙂".repeat(600_000);
        while full.len() < 10 * 1024 * 1024 {
            full.push_str("tail-🙂");
        }
        replay_event.payload_refs[0].full_size_bytes = full.len();

        let mut output = Vec::new();
        let mut calls = 0_usize;
        write_hydrated_event_json(&mut output, &replay_event, &mut |payload_ref, offset| {
            calls += 1;
            let start = offset as usize;
            let mut end = start.saturating_add(256 * 1024).min(full.len());
            while end > start && !full.is_char_boundary(end) {
                end -= 1;
            }
            Ok(ReplayPayloadRange {
                event_id: payload_ref.event_id.clone(),
                field_path: payload_ref.field_path.clone(),
                offset,
                next_offset: end as u64,
                eof: end == full.len(),
                total_bytes: full.len() as u64,
                text: full[start..end].to_string(),
            })
        })
        .expect("stream array payload");

        let decoded: serde_json::Value =
            serde_json::from_slice(&output).expect("valid streamed array event");
        let restored = decoded
            .pointer("/args/items/0")
            .and_then(serde_json::Value::as_str)
            .expect("restored array payload");
        assert_eq!(sha256_hex(restored.as_bytes()), sha256_hex(full.as_bytes()));
        assert_eq!(
            decoded
                .get("displayText")
                .and_then(serde_json::Value::as_str),
            Some(full.as_str())
        );
        assert!(calls > 2, "large array payload must be range streamed");
    }

    #[test]
    fn hydrated_export_replaces_root_json_payload_without_quoting_it() {
        let mut replay_event = event("args", "codexapp-test", "tool");
        replay_event.args = serde_json::json!({"payloadPreview":"truncated"});
        replay_event.payload_refs = vec![PayloadRef {
            event_id: replay_event.id.clone(),
            field_path: "args".to_string(),
            preview: replay_event.args.to_string(),
            full_size_bytes: 30,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::JsonValue),
            replay_source_id: Some("claude_code".to_string()),
            replay_generation: Some("g1".to_string()),
            replay_source_event_id: Some("args".to_string()),
        }];
        let full = r#"{"command":"printf \"hello\"","path":"src/lib.rs"}"#;
        let mut output = Vec::new();
        write_hydrated_event_json(&mut output, &replay_event, &mut |payload_ref, offset| {
            assert_eq!(offset, 0);
            Ok(ReplayPayloadRange {
                event_id: payload_ref.event_id.clone(),
                field_path: payload_ref.field_path.clone(),
                offset: 0,
                next_offset: full.len() as u64,
                eof: true,
                total_bytes: full.len() as u64,
                text: full.to_string(),
            })
        })
        .expect("stream root args");
        let decoded: serde_json::Value = serde_json::from_slice(&output).expect("valid event JSON");
        assert_eq!(
            decoded.pointer("/args/path").and_then(|v| v.as_str()),
            Some("src/lib.rs")
        );

        replace_event_payload(&mut replay_event, "args", full.to_string());
        assert_eq!(
            replay_event.args.get("path").and_then(|v| v.as_str()),
            Some("src/lib.rs")
        );
    }

    fn managed_replay_test_schema(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE code_session_chunks (
                chunk_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                function TEXT NOT NULL,
                args_json TEXT NOT NULL,
                result_json TEXT NOT NULL,
                thread_id TEXT,
                process_id TEXT,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE code_session_history_mutations (
                session_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL
             );",
        )
        .expect("managed replay schema");
    }

    fn insert_managed_replay_chunk(
        conn: &rusqlite::Connection,
        session_id: &str,
        chunk_id: &str,
        sequence: i64,
        function: &str,
    ) {
        let action_type = match function {
            "user_message" => "user",
            "assistant_message" => "assistant",
            _ => "tool_call",
        };
        conn.execute(
            "INSERT INTO code_session_chunks(
                chunk_id,session_id,action_type,function,args_json,result_json,
                thread_id,process_id,sequence,created_at
             ) VALUES(?1,?2,?3,?4,'{}','{}',NULL,NULL,?5,?6)",
            rusqlite::params![
                chunk_id,
                session_id,
                action_type,
                function,
                sequence,
                format!("2026-07-22T00:00:{sequence:02}Z")
            ],
        )
        .expect("insert managed replay chunk");
    }

    fn managed_replay_limits(max_turns: usize) -> ReplayLimits {
        ReplayLimits {
            max_turns,
            max_events: 200,
            max_ipc_bytes: 4 * 1024 * 1024,
        }
    }

    #[test]
    fn managed_chunk_replacement_resets_old_window_but_append_stays_delta() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().expect("managed replay test DB");
        crate::agent_sessions::cli::init_cli_agent_tables(&conn).expect("managed CLI schema");
        for session_id in ["cliagent-epoch-old", "cliagent-epoch-new"] {
            conn.execute(
                "INSERT INTO code_sessions(session_id,created_at,updated_at)
                 VALUES(?1,'2026-07-23T00:00:00Z','2026-07-23T00:00:00Z')",
                [session_id],
            )
            .expect("managed replay session");
        }
        drop(conn);

        let make_chunk = |chunk_id: &str, session_id: &str, output: &str| {
            let mut chunk = ActivityChunk::new(session_id, "tool_result", "run_command_line");
            chunk.chunk_id = chunk_id.to_string();
            chunk.args = serde_json::json!({"command":"printf replay"});
            chunk.result = serde_json::json!({"output":output});
            chunk.created_at = "2026-07-23T00:00:00Z".to_string();
            chunk
        };
        let original = make_chunk("epoch-shell", "cliagent-epoch-old", "AAAA");
        crate::agent_sessions::cli::persistence::insert_chunk(&original, 0)
            .expect("initial managed append");
        let opened = legacy_open_window("cliagent-epoch-old", managed_replay_limits(1))
            .expect("initial managed window");
        assert_eq!(opened.cursor.generation, "chunks-0");

        let appended = make_chunk("epoch-append", "cliagent-epoch-old", "tail");
        crate::agent_sessions::cli::persistence::insert_chunk(&appended, 1)
            .expect("managed append delta");
        let append_delta = legacy_poll_delta(
            "cliagent-epoch-old",
            &opened.cursor,
            managed_replay_limits(1),
        )
        .expect("managed append poll");
        assert!(!append_delta.reset_required);
        assert_eq!(append_delta.cursor.generation, opened.cursor.generation);
        assert_eq!(append_delta.chunks.len(), 1);

        crate::agent_sessions::cli::persistence::insert_chunk(&original, 0)
            .expect("idempotent managed replace");
        let unchanged = legacy_poll_delta(
            "cliagent-epoch-old",
            &append_delta.cursor,
            managed_replay_limits(1),
        )
        .expect("idempotent managed poll");
        assert!(!unchanged.reset_required);
        assert!(unchanged.chunks.is_empty());

        let changed = make_chunk("epoch-shell", "cliagent-epoch-old", "BBBB");
        crate::agent_sessions::cli::persistence::insert_chunk(&changed, 0)
            .expect("same-length managed replacement");
        let reset = legacy_poll_delta(
            "cliagent-epoch-old",
            &append_delta.cursor,
            managed_replay_limits(1),
        )
        .expect("managed replacement reset");
        assert!(reset.reset_required);
        assert_eq!(reset.cursor.generation, "chunks-1");

        let moved = make_chunk("epoch-shell", "cliagent-epoch-new", "BBBB");
        crate::agent_sessions::cli::persistence::insert_chunk(&moved, 0)
            .expect("cross-session managed replacement");
        let old_reset = legacy_poll_delta(
            "cliagent-epoch-old",
            &reset.cursor,
            managed_replay_limits(1),
        )
        .expect("old session reset after move");
        assert!(old_reset.reset_required);
        assert_eq!(old_reset.cursor.generation, "chunks-2");
        let new_window = legacy_open_window("cliagent-epoch-new", managed_replay_limits(1))
            .expect("new session window after move");
        assert_eq!(new_window.cursor.generation, "chunks-1");
        assert!(new_window
            .chunks
            .iter()
            .any(|chunk| chunk.chunk.chunk_id == "epoch-shell"));
    }

    #[test]
    fn readerless_managed_cli_pages_compact_turn_headers_without_duplicates() {
        let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
        managed_replay_test_schema(&conn);
        conn.execute(
            "INSERT INTO code_session_history_mutations VALUES(?1, 3)",
            ["cliagent-turns"],
        )
        .expect("managed replay generation");
        for (chunk_id, sequence, function) in [
            ("u0", 0, "user_message"),
            ("a0", 1, "assistant_message"),
            ("u1", 2, "user_message"),
            ("t1", 3, "run_command_line"),
            ("a1", 4, "assistant_message"),
            ("u2", 5, "user_message"),
            ("a2", 6, "assistant_message"),
        ] {
            insert_managed_replay_chunk(&conn, "cliagent-turns", chunk_id, sequence, function);
        }

        let latest = legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            None,
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("latest managed turn");
        assert_eq!(latest.cursor.generation, "chunks-3");
        assert_eq!(latest.total_turn_count, 3);
        assert_eq!(latest.total_event_count, 7);
        assert!(latest.has_older);
        assert_eq!(latest.turn_headers.len(), 1);
        assert_eq!(latest.turn_headers[0].turn_id, "u2");
        assert_eq!(latest.turn_headers[0].turn_index, 2);
        assert_eq!(latest.turn_headers[0].start_sequence, 5);
        assert_eq!(latest.turn_headers[0].end_sequence, Some(6));
        assert_eq!(latest.turn_headers[0].event_count, 2);
        assert_eq!(
            latest
                .chunks
                .iter()
                .map(|chunk| (chunk.sequence, chunk.turn_index))
                .collect::<Vec<_>>(),
            vec![(5, 2), (6, 2)]
        );

        let middle = legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            None,
            None,
            Some(1),
            managed_replay_limits(1),
        )
        .expect("middle managed turn by index");
        assert_eq!(middle.turn_headers[0].turn_id, "u1");
        assert_eq!(
            middle
                .chunks
                .iter()
                .map(|chunk| (chunk.sequence, chunk.turn_index))
                .collect::<Vec<_>>(),
            vec![(2, 1), (3, 1), (4, 1)]
        );

        let oldest = legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            None,
            Some("u0"),
            None,
            managed_replay_limits(1),
        )
        .expect("oldest managed turn by id");
        assert!(!oldest.has_older);
        assert_eq!(oldest.turn_headers[0].turn_index, 0);
        assert_eq!(
            oldest
                .chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );

        let prior = legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            Some(latest.turn_headers[0].start_sequence),
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("managed turn before latest");
        assert_eq!(prior.turn_headers[0].turn_id, "u1");
        assert_eq!(prior.cursor.generation, latest.cursor.generation);
        assert_eq!(prior.cursor.revision, latest.cursor.revision);
        assert_ne!(
            prior.cursor.through_sequence,
            latest.cursor.through_sequence
        );
        assert_eq!(
            prior
                .chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert!(prior.chunks.iter().all(|chunk| !latest
            .chunks
            .iter()
            .any(|item| item.sequence == chunk.sequence)));

        let latest_two = legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            None,
            None,
            None,
            managed_replay_limits(2),
        )
        .expect("latest two managed turns");
        assert_eq!(
            latest_two
                .turn_headers
                .iter()
                .map(|header| (&header.turn_id, header.turn_index))
                .collect::<Vec<_>>(),
            vec![(&"u1".to_string(), 1), (&"u2".to_string(), 2)]
        );
        assert_eq!(
            latest_two
                .chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3, 4, 5, 6]
        );

        assert!(legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            None,
            Some("a1"),
            None,
            managed_replay_limits(1),
        )
        .expect_err("non-anchor turn id must fail")
        .contains("no longer available"));
        assert!(legacy_read_window_from_conn(
            &conn,
            "cliagent-turns",
            None,
            None,
            Some(3),
            managed_replay_limits(1),
        )
        .expect_err("stale turn index must fail")
        .contains("no longer available"));
    }

    #[test]
    fn readerless_large_single_turn_pages_from_actual_window_start_without_gaps() {
        let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
        managed_replay_test_schema(&conn);
        let session_id = "cliagent-large-single-turn";
        conn.execute(
            "INSERT INTO code_session_history_mutations VALUES(?1, 11)",
            [session_id],
        )
        .expect("managed replay generation");
        insert_managed_replay_chunk(&conn, session_id, "user-0", 0, "user_message");
        for sequence in 1..=450_i64 {
            insert_managed_replay_chunk(
                &conn,
                session_id,
                &format!("assistant-{sequence}"),
                sequence,
                "assistant_message",
            );
        }
        let filtered_page = normalize_window(
            legacy_read_window_from_conn(
                &conn,
                session_id,
                None,
                None,
                None,
                managed_replay_limits(1),
            )
            .expect("filtered large-turn page"),
            session_id,
        );
        assert!(filtered_page.events.is_empty());
        assert_eq!(filtered_page.window_start_sequence, Some(251));
        assert!(filtered_page.has_older);
        conn.execute(
            "UPDATE code_session_chunks
             SET result_json=json_object('content',chunk_id)
             WHERE session_id=?1",
            [session_id],
        )
        .expect("make large-turn chunks visible to normalization");

        let latest_chunks = legacy_read_window_from_conn(
            &conn,
            session_id,
            None,
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("latest large-turn page");
        let latest_sequences = latest_chunks
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>();
        assert_eq!(latest_sequences.len(), 200);
        assert_eq!(latest_sequences.first(), Some(&251));
        assert_eq!(latest_sequences.last(), Some(&450));
        let latest = normalize_window(latest_chunks, session_id);
        assert_eq!(latest.window_start_sequence, Some(251));
        assert_eq!(latest.turn_headers[0].start_sequence, 0);
        assert!(latest.has_older);

        let middle_chunks = legacy_read_window_from_conn(
            &conn,
            session_id,
            latest.window_start_sequence,
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("middle large-turn page");
        let middle_sequences = middle_chunks
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>();
        assert_eq!(middle_sequences.len(), 200);
        assert_eq!(middle_sequences.first(), Some(&51));
        assert_eq!(middle_sequences.last(), Some(&250));
        let middle = normalize_window(middle_chunks, session_id);
        assert_eq!(middle.window_start_sequence, Some(51));
        assert_eq!(middle.turn_headers[0].start_sequence, 0);
        assert!(middle.has_older);
        assert_eq!(middle.cursor.generation, latest.cursor.generation);
        assert_eq!(middle.cursor.revision, latest.cursor.revision);

        let oldest_chunks = legacy_read_window_from_conn(
            &conn,
            session_id,
            middle.window_start_sequence,
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("oldest large-turn page");
        let oldest_sequences = oldest_chunks
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>();
        assert_eq!(oldest_sequences.len(), 51);
        assert_eq!(oldest_sequences.first(), Some(&0));
        assert_eq!(oldest_sequences.last(), Some(&50));
        let oldest = normalize_window(oldest_chunks, session_id);
        assert_eq!(oldest.window_start_sequence, Some(0));
        assert!(!oldest.has_older);

        let mut sequences = oldest_sequences
            .into_iter()
            .chain(middle_sequences)
            .chain(latest_sequences)
            .collect::<Vec<_>>();
        sequences.sort_unstable();
        sequences.dedup();
        assert_eq!(sequences, (0..=450_i64).collect::<Vec<_>>());
    }

    #[test]
    fn readerless_managed_cli_uses_one_fallback_turn_without_user_rows() {
        let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
        managed_replay_test_schema(&conn);
        insert_managed_replay_chunk(&conn, "cliagent-fallback", "a0", 10, "assistant_message");
        insert_managed_replay_chunk(&conn, "cliagent-fallback", "t0", 11, "run_command_line");

        let window = legacy_read_window_from_conn(
            &conn,
            "cliagent-fallback",
            None,
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("managed fallback turn");
        assert_eq!(window.total_turn_count, 1);
        assert_eq!(window.turn_headers[0].turn_id, "a0");
        assert_eq!(window.turn_headers[0].start_sequence, 10);
        assert_eq!(window.turn_headers[0].end_sequence, Some(11));
        assert_eq!(window.turn_headers[0].event_count, 2);
        assert_eq!(
            window
                .chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![10, 11]
        );
    }

    #[test]
    fn readerless_managed_cli_compacts_ten_mib_row_and_ranges_without_full_column_reads() {
        let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
        conn.execute_batch(
            "CREATE TABLE code_session_chunks (
                chunk_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                function TEXT NOT NULL,
                args_json TEXT NOT NULL,
                result_json TEXT NOT NULL,
                thread_id TEXT,
                process_id TEXT,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE code_session_history_mutations (
                session_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL
             );
             INSERT INTO code_session_history_mutations VALUES('cliagent-large', 7);",
        )
        .expect("managed chunks schema");
        let full = format!("{}END", "中🙂shell-output\n".repeat(550_000));
        let expected_payload_hash = sha256_hex(full.as_bytes());
        let result_json = serde_json::to_string(&serde_json::json!({"output":full}))
            .expect("large managed result");
        assert!(result_json.len() > 10 * 1024 * 1024);
        conn.execute(
            "INSERT INTO code_session_chunks VALUES(
                'chunk-large','cliagent-large','tool_call','run_command_line',
                '{\"command\":\"printf test\"}',?1,NULL,NULL,0,'2026-07-22T00:00:00Z'
             )",
            [result_json],
        )
        .expect("insert managed chunk");

        LEGACY_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
        let chunks = query_legacy_chunks(
            &conn,
            "cliagent-large",
            "sequence < ?2",
            i64::MAX,
            None,
            ReplayLimits {
                max_turns: 1,
                max_events: 200,
                max_ipc_bytes: 4 * 1024 * 1024,
            },
            true,
        )
        .expect("bounded managed open row");
        assert_eq!(chunks.len(), 1);
        assert!(serde_json::to_vec(&chunks[0].chunk).unwrap().len() < 64 * 1024);
        assert_eq!(chunks[0].payloads.len(), 1);
        assert_eq!(chunks[0].payloads[0].field_path, "result.output");
        assert!(
            LEGACY_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed) <= LEGACY_INLINE_JSON_MAX_BYTES,
            "open must not copy a source-sized SQLite JSON column into Rust"
        );
        assert!(
            chunks[0]
                .chunk
                .result
                .get("output")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|preview| preview.len() < 64 * 1024 && preview.is_char_boundary(0)),
            "projected preview must remain bounded valid UTF-8"
        );

        LEGACY_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
        let unchanged = query_legacy_chunks(
            &conn,
            "cliagent-large",
            "sequence > ?2",
            0,
            None,
            ReplayLimits {
                max_turns: 1,
                max_events: 200,
                max_ipc_bytes: 4 * 1024 * 1024,
            },
            false,
        )
        .expect("unchanged managed poll");
        assert!(unchanged.is_empty());
        assert_eq!(
            LEGACY_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed),
            0,
            "unchanged poll must not fetch any JSON field"
        );

        LEGACY_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
        let mut rebuilt_hash = Sha256::new();
        let mut offset = 0_u64;
        let mut calls = 0_usize;
        loop {
            let range = legacy_payload_range_from_conn(
                &conn,
                "cliagent-large",
                "chunk-large",
                "result.output",
                offset,
                64 * 1024,
            )
            .expect("managed payload range");
            assert!(range.text.len() <= 64 * 1024);
            rebuilt_hash.update(range.text.as_bytes());
            calls += 1;
            if range.eof {
                break;
            }
            assert!(range.next_offset > offset);
            offset = range.next_offset;
        }
        assert!(calls > 100);
        assert_eq!(
            format!("{:x}", rebuilt_hash.finalize()),
            expected_payload_hash
        );
        assert!(
            LEGACY_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed) <= 64 * 1024 + 4,
            "payload-range must only fetch the requested slice plus UTF-8 boundary bytes"
        );

        #[derive(Default)]
        struct HashingSink {
            bytes: u64,
            hash: Sha256,
        }

        impl std::io::Write for HashingSink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes = self.bytes.saturating_add(bytes.len() as u64);
                self.hash.update(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        LEGACY_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
        let mut export_sink = HashingSink::default();
        let export_generation = stream_legacy_replay_events_from_conn(
            &conn,
            "cliagent-large",
            "testing managed export",
            |event, read_payload| write_hydrated_event_json(&mut export_sink, event, read_payload),
        )
        .expect("stream managed export");
        assert_eq!(export_generation, "chunks-7");
        assert!(export_sink.bytes > full.len() as u64);
        assert!(
            LEGACY_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
                <= EXPORT_PAYLOAD_RANGE_BYTES + LEGACY_UTF8_BOUNDARY_BYTES,
            "streamed export must not fetch a source-sized SQLite JSON column"
        );

        LEGACY_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
        let mut cloud_hash = Sha256::new();
        let mut cloud_ranges = 0_usize;
        let cloud_generation = stream_legacy_replay_events_from_conn(
            &conn,
            "cliagent-large",
            "testing managed Cloud spool",
            |event, read_payload| {
                let payload_ref = event
                    .payload_refs
                    .iter()
                    .find(|payload_ref| payload_ref.field_path == "result.output")
                    .ok_or_else(|| "managed Cloud payload locator is missing".to_string())?;
                let mut offset = 0_u64;
                loop {
                    let range = read_payload(payload_ref, offset)?;
                    cloud_hash.update(range.text.as_bytes());
                    cloud_ranges = cloud_ranges.saturating_add(1);
                    if range.eof {
                        break;
                    }
                    if range.next_offset <= offset {
                        return Err("managed Cloud payload cursor did not advance".to_string());
                    }
                    offset = range.next_offset;
                }
                Ok(())
            },
        )
        .expect("stream managed Cloud spool");
        assert_eq!(cloud_generation, "chunks-7");
        assert!(cloud_ranges > 20);
        assert_eq!(
            format!("{:x}", cloud_hash.finalize()),
            expected_payload_hash
        );
        assert!(
            LEGACY_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
                <= EXPORT_PAYLOAD_RANGE_BYTES + LEGACY_UTF8_BOUNDARY_BYTES,
            "Cloud spool must share the bounded database/range path"
        );

        let invalid = "x".repeat(128 * 1024);
        conn.execute(
            "INSERT INTO code_session_chunks VALUES(
                'chunk-invalid','cliagent-large','tool_call','tool',
                '{}',?1,NULL,NULL,1,'2026-07-22T00:00:01Z'
             )",
            [invalid],
        )
        .expect("insert oversized non-JSON managed chunk");
        LEGACY_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
        let error = query_legacy_chunks(
            &conn,
            "cliagent-large",
            "sequence > ?2",
            0,
            None,
            ReplayLimits {
                max_turns: 1,
                max_events: 200,
                max_ipc_bytes: 4 * 1024 * 1024,
            },
            false,
        )
        .expect_err("oversized non-JSON must preserve fail-closed semantics");
        assert!(error.contains("invalid JSON"));
        assert!(
            LEGACY_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
                <= replay::NORMAL_PAYLOAD_PREVIEW_BYTES + LEGACY_UTF8_BOUNDARY_BYTES,
            "invalid oversized JSON must fail without copying the full column"
        );
    }

    fn collaboration_snapshot_test_schema(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                function_name TEXT,
                thread_id TEXT,
                args_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                meta_json TEXT,
                history_sequence INTEGER
             );
             CREATE INDEX idx_test_events_session_sequence
             ON events(session_id,history_sequence);",
        )
        .expect("collaboration snapshot schema");
    }

    fn collaboration_snapshot_meta(source: &str, display_text: &str) -> String {
        serde_json::to_string(&serde_json::json!({
            "source": source,
            "displayText": display_text,
            "displayStatus": "completed",
            "displayVariant": "message",
            "activityStatus": "processed",
            "uiCanonical": if source == "user" { "user_message" } else { "assistant_message" },
        }))
        .expect("snapshot event metadata")
    }

    #[test]
    fn collaboration_snapshot_is_special_and_never_matches_native_agent_ids() {
        assert!(matches!(
            resolve_target(
                COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID,
                "imported-session-test"
            ),
            Ok(ResolvedTarget::CollaborationSnapshot)
        ));
        assert!(
            resolve_target(COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID, "sdeagent-native").is_err()
        );
        assert!(resolve_target("codex_app", "imported-session-test").is_err());
        assert_eq!(ImportedHistorySourceId::ALL.len(), 15);
    }

    #[test]
    fn collaboration_snapshot_window_is_bounded_ranges_ten_mib_and_polls_true_deltas() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("snapshot replay DB");
        collaboration_snapshot_test_schema(&conn);
        let session_id = "imported-session-bounded";
        let large_content = format!("{}END", "snapshot-output\n".repeat(700_000));
        let large_result = serde_json::to_string(&serde_json::json!({
            "content": large_content,
            "status": "done",
        }))
        .expect("large snapshot result");
        {
            let tx = conn.transaction().expect("snapshot insert transaction");
            let mut insert = tx
                .prepare(
                    "INSERT INTO events(
                       id,session_id,event_type,function_name,thread_id,args_json,
                       result_json,content,created_at,meta_json,history_sequence
                     ) VALUES(?1,?2,?3,?4,NULL,'{}',?5,'',?6,?7,?8)",
                )
                .expect("snapshot insert statement");
            for sequence in 0..205_i64 {
                let user = sequence == 0;
                let event_id = format!("snapshot-{sequence}");
                let result = if sequence == 204 {
                    large_result.as_str()
                } else {
                    "{\"content\":\"small\"}"
                };
                insert
                    .execute(rusqlite::params![
                        event_id,
                        session_id,
                        if user { "user_message" } else { "assistant" },
                        if user {
                            "user_message"
                        } else {
                            "assistant_message"
                        },
                        result,
                        format!("2026-07-22T00:{:02}:{:02}Z", sequence / 60, sequence % 60),
                        collaboration_snapshot_meta(
                            if user { "user" } else { "assistant" },
                            if user { "start" } else { "answer" },
                        ),
                        sequence,
                    ])
                    .expect("insert snapshot row");
            }
            drop(insert);
            tx.commit().expect("commit snapshot rows");
        }

        let limits = ReplayLimits {
            max_turns: 1,
            max_events: 200,
            max_ipc_bytes: 4 * 1024 * 1024,
        };
        let window = collaboration_snapshot_read_window_from_conn(
            &conn, session_id, None, None, None, limits,
        )
        .expect("bounded collaboration window");
        assert_eq!(window.events.len(), 200);
        assert_eq!(window.total_event_count, 205);
        assert!(window.has_older);
        assert!(window.stats.ipc_bytes < 4 * 1024 * 1024);
        let large = window
            .events
            .iter()
            .find(|event| event.id == "snapshot-204")
            .expect("large event remains in latest window");
        let payload = large
            .payload_refs
            .iter()
            .find(|reference| reference.field_path == "result")
            .expect("large result is deferred at the canonical root");
        assert!(payload.full_size_bytes > 10 * 1024 * 1024);

        let mut rebuilt = String::new();
        let mut offset = 0_u64;
        loop {
            let range = collaboration_snapshot_payload_range_from_conn(
                &conn,
                session_id,
                &window.cursor.generation,
                "snapshot-204",
                "result",
                offset,
                replay::HARD_MAX_PAYLOAD_RANGE_BYTES,
            )
            .expect("bounded collaboration payload range");
            assert!(range.text.len() <= replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
            rebuilt.push_str(&range.text);
            if range.eof {
                break;
            }
            assert!(range.next_offset > offset);
            offset = range.next_offset;
        }
        assert_eq!(rebuilt, large_result);

        let unchanged =
            collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &window.cursor, limits)
                .expect("unchanged collaboration poll");
        assert!(unchanged.events.is_empty());
        assert_eq!(unchanged.stats.parsed_rows, 0);
        assert!(!unchanged.reset_required);

        conn.execute(
            "INSERT INTO events(
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,meta_json,history_sequence
             ) VALUES(
               'snapshot-205',?1,'assistant','assistant_message','{}',
               '{\"content\":\"appended\"}','','2026-07-22T00:03:25Z',?2,205
             )",
            rusqlite::params![
                session_id,
                collaboration_snapshot_meta("assistant", "appended")
            ],
        )
        .expect("append collaboration event");
        let delta =
            collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &window.cursor, limits)
                .expect("collaboration append delta");
        assert_eq!(delta.events.len(), 1);
        assert_eq!(delta.events[0].id, "snapshot-205");
        assert_eq!(delta.cursor.generation, window.cursor.generation);
        assert!(!delta.reset_required);

        conn.execute(
            "UPDATE events SET result_json='{\"content\":\"rewritten\"}'
             WHERE id='snapshot-205'",
            [],
        )
        .expect("rewrite collaboration event");
        let reset =
            collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &delta.cursor, limits)
                .expect("collaboration rewrite reset");
        assert!(reset.reset_required);
        assert_ne!(reset.cursor.generation, delta.cursor.generation);

        conn.execute("DELETE FROM events WHERE session_id=?1", [session_id])
            .expect("bulk-delete collaboration snapshot");
        let deleted = collaboration_snapshot_state(&conn, session_id)
            .expect("refresh state once after bulk delete");
        assert_eq!(deleted.event_count, 0);
        assert_eq!(deleted.max_sequence, -1);
    }

    #[test]
    fn snapshot_backed_native_fork_secondary_replay_keeps_native_execution_isolated() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("native fork replay DB");
        session_persistence::init_session_tables(&conn).expect("native session schema");
        super::super::collaboration_snapshot_ingest::install_snapshot_schema_for_test(&mut conn)
            .expect("collaboration snapshot schema");
        let session_id = "agentsession-snapshot-secondary";
        let inherited_count = 1_000_i64;
        {
            let tx = conn
                .transaction()
                .expect("seed inherited snapshot transaction");
            let mut insert_event = tx
                .prepare(
                    "INSERT INTO events(
                       id,session_id,event_type,function_name,thread_id,args_json,
                       result_json,content,created_at,meta_json,history_sequence
                     ) VALUES(?1,?2,?3,?4,NULL,?5,?6,'',?7,?8,?9)",
                )
                .expect("prepare inherited event insert");
            let mut insert_map = tx
                .prepare(
                    "INSERT INTO collaboration_snapshot_event_map(
                       session_id,event_id,original_id,physical_seq,event_index,
                       logical_index,is_tail
                     ) VALUES(?1,?2,?3,?4,0,?5,0)",
                )
                .expect("prepare inherited map insert");
            for sequence in 0..inherited_count {
                let event_id = format!("{session_id}~inherited-{sequence}");
                let user = sequence == 0;
                insert_event
                    .execute(rusqlite::params![
                        event_id,
                        session_id,
                        if user { "user_message" } else { "assistant" },
                        if user {
                            "user_message"
                        } else {
                            "assistant_message"
                        },
                        if user {
                            "{\"content\":\"inherited question\"}"
                        } else {
                            "{}"
                        },
                        if user {
                            "{}"
                        } else {
                            "{\"content\":\"inherited answer\"}"
                        },
                        format!("2026-07-22T00:{:02}:{:02}Z", sequence / 60, sequence % 60),
                        collaboration_snapshot_meta(
                            if user { "user" } else { "assistant" },
                            if user {
                                "inherited question"
                            } else {
                                "inherited answer"
                            },
                        ),
                        sequence,
                    ])
                    .expect("insert inherited event");
                insert_map
                    .execute(rusqlite::params![
                        session_id,
                        event_id,
                        format!("inherited-{sequence}"),
                        sequence + 1,
                        sequence,
                    ])
                    .expect("insert inherited map row");
            }
            drop(insert_map);
            drop(insert_event);
            tx.execute(
                "INSERT INTO sessions(session_id,event_count,cached_at)
                 VALUES(?1,?2,0)",
                rusqlite::params![session_id, inherited_count],
            )
            .expect("insert native fork session row");
            tx.execute(
                "INSERT INTO collaboration_snapshot_ingest_state(
                   session_id,epoch,frozen_seq,event_count,frozen_event_count,
                   tail_hash,updated_at
                 ) VALUES(?1,7,?2,?2,?2,NULL,0)",
                rusqlite::params![session_id, inherited_count],
            )
            .expect("insert native fork snapshot cursor");
            tx.commit().expect("commit inherited snapshot");
        }

        assert!(resolve_target(COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID, session_id).is_err());
        assert!(matches!(
            resolve_secondary_consumer_target(COLLABORATION_SNAPSHOT_REPLAY_SOURCE_ID, session_id),
            Ok(ResolvedTarget::CollaborationSnapshot)
        ));
        let replay_state_table: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master
                 WHERE type='table' AND name='collaboration_replay_state')",
                [],
                |row| row.get(0),
            )
            .expect("inspect imported replay accounting table");
        assert_eq!(replay_state_table, 0);
        let frontier_plan = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT history_sequence FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 1",
            )
            .expect("prepare native fork frontier plan")
            .query_map([session_id], |row| row.get::<_, String>(3))
            .expect("query native fork frontier plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect native fork frontier plan");
        assert!(frontier_plan
            .iter()
            .any(|detail| detail.contains("idx_events_session_sequence")));

        let limits = ReplayLimits {
            max_turns: 1,
            max_events: 200,
            max_ipc_bytes: 4 * 1024 * 1024,
        };
        let inherited_window = collaboration_snapshot_read_window_from_conn(
            &conn, session_id, None, None, None, limits,
        )
        .expect("read bounded inherited window");
        assert_eq!(inherited_window.events.len(), 200);
        assert_eq!(inherited_window.total_event_count, inherited_count as u64);
        assert_eq!(
            inherited_window.cursor.through_sequence,
            inherited_count - 1
        );

        let suffix_user_id = format!("{session_id}~native-user");
        let suffix_assistant_id = format!("{session_id}~native-assistant");
        let large_result = serde_json::to_string(&serde_json::json!({
            "content": format!("{}END", "native-suffix-output\n".repeat(550_000)),
            "status": "done",
        }))
        .expect("large native suffix result");
        {
            let tx = conn
                .transaction()
                .expect("append native suffix transaction");
            tx.execute(
                "INSERT INTO events(
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,meta_json,history_sequence
                 ) VALUES(?1,?2,'user_message','user_message',?3,'{}','',?4,?5,?6)",
                rusqlite::params![
                    suffix_user_id,
                    session_id,
                    "{\"content\":\"native suffix question\"}",
                    "2026-07-22T01:00:00Z",
                    collaboration_snapshot_meta("user", "native suffix question"),
                    inherited_count,
                ],
            )
            .expect("insert native suffix user");
            tx.execute(
                "INSERT INTO events(
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,meta_json,history_sequence
                 ) VALUES(?1,?2,'assistant','assistant_message','{}',?3,'',?4,?5,?6)",
                rusqlite::params![
                    suffix_assistant_id,
                    session_id,
                    large_result,
                    "2026-07-22T01:00:01Z",
                    collaboration_snapshot_meta("assistant", "native suffix answer"),
                    inherited_count + 1,
                ],
            )
            .expect("insert native suffix assistant");
            tx.execute(
                "UPDATE sessions SET event_count=?2 WHERE session_id=?1",
                rusqlite::params![session_id, inherited_count + 2],
            )
            .expect("publish native suffix count");
            tx.commit().expect("commit native suffix");
        }

        let appended = collaboration_snapshot_poll_delta_from_conn(
            &conn,
            session_id,
            &inherited_window.cursor,
            limits,
        )
        .expect("poll native suffix delta");
        assert!(!appended.reset_required);
        assert_eq!(
            appended.cursor.generation,
            inherited_window.cursor.generation
        );
        assert!(appended.cursor.revision > inherited_window.cursor.revision);
        assert_eq!(
            appended
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec![suffix_user_id.as_str(), suffix_assistant_id.as_str()]
        );

        let suffix_turn = collaboration_snapshot_read_window_from_conn(
            &conn,
            session_id,
            None,
            Some(&suffix_user_id),
            None,
            limits,
        )
        .expect("address native suffix turn");
        assert_eq!(suffix_turn.events.len(), 2);
        assert_eq!(suffix_turn.events[1].id, suffix_assistant_id);
        let payload = suffix_turn.events[1]
            .payload_refs
            .iter()
            .find(|reference| reference.field_path == "result")
            .expect("native suffix large result is deferred");
        assert!(payload.full_size_bytes > 10 * 1024 * 1024);

        let mut expected_hash = Sha256::new();
        expected_hash.update(large_result.as_bytes());
        let expected_hash = format!("{:x}", expected_hash.finalize());
        let mut actual_hash = Sha256::new();
        let mut offset = 0_u64;
        loop {
            let range = collaboration_snapshot_payload_range_from_conn(
                &conn,
                session_id,
                &appended.cursor.generation,
                &suffix_assistant_id,
                "result",
                offset,
                replay::HARD_MAX_PAYLOAD_RANGE_BYTES,
            )
            .expect("read native suffix payload range");
            assert!(range.text.len() <= replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
            actual_hash.update(range.text.as_bytes());
            if range.eof {
                break;
            }
            assert!(range.next_offset > offset);
            offset = range.next_offset;
        }
        assert_eq!(format!("{:x}", actual_hash.finalize()), expected_hash);

        let batch_limits = ReplayLimits {
            max_turns: 10,
            max_events: 17,
            max_ipc_bytes: 4 * 1024 * 1024,
        };
        let mut lower = -1_i64;
        let mut ordered_ids = Vec::new();
        loop {
            let batch = query_collaboration_snapshot_events(
                &conn,
                session_id,
                &appended.cursor.generation,
                lower,
                i64::MAX,
                batch_limits,
                false,
            )
            .expect("stream native fork event batch");
            assert!(batch.len() <= 17);
            if batch.is_empty() {
                break;
            }
            lower = batch.last().expect("non-empty batch").0;
            ordered_ids.extend(batch.into_iter().map(|(_, event)| event.id));
        }
        assert_eq!(ordered_ids.len(), (inherited_count + 2) as usize);
        assert_eq!(
            ordered_ids.first(),
            Some(&format!("{session_id}~inherited-0"))
        );
        assert_eq!(
            &ordered_ids[ordered_ids.len() - 2..],
            &[suffix_user_id.clone(), suffix_assistant_id.clone()]
        );

        conn.execute(
            "UPDATE events SET result_json='{\"content\":\"rewritten\"}' WHERE id=?1",
            [&suffix_assistant_id],
        )
        .expect("rewrite native suffix event");
        let rewritten = collaboration_snapshot_poll_delta_from_conn(
            &conn,
            session_id,
            &appended.cursor,
            limits,
        )
        .expect("poll rewritten native suffix");
        assert!(rewritten.reset_required);
        assert_eq!(rewritten.cursor.generation, appended.cursor.generation);
        assert!(rewritten.cursor.revision > appended.cursor.revision);

        conn.execute("DELETE FROM events WHERE id=?1", [&suffix_assistant_id])
            .expect("delete native suffix event");
        conn.execute(
            "UPDATE sessions SET event_count=?2 WHERE session_id=?1",
            rusqlite::params![session_id, inherited_count + 1],
        )
        .expect("publish native suffix delete count");
        let delete_delta = collaboration_snapshot_poll_delta_from_conn(
            &conn,
            session_id,
            &rewritten.cursor,
            limits,
        )
        .expect("poll deleted native suffix");
        assert!(delete_delta.reset_required);
        assert_eq!(delete_delta.cursor.generation, rewritten.cursor.generation);
        let deleted =
            super::super::collaboration_snapshot_ingest::collaboration_snapshot_secondary_state(
                &conn, session_id,
            )
            .expect("read deleted native suffix state")
            .expect("native fork remains snapshot-backed after suffix delete");
        assert_eq!(deleted.event_count, (inherited_count + 1) as u64);
        assert_eq!(deleted.max_sequence, inherited_count);
    }

    #[test]
    fn cloud_spool_batch_is_byte_bounded_and_prefix_addressable() {
        let token = format!("test-{}", uuid::Uuid::new_v4());
        let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
        let conn = rusqlite::Connection::open(&path).expect("spool db");
        conn.execute_batch(
            "CREATE TABLE events (
                event_index INTEGER PRIMARY KEY,
                event_hash TEXT NOT NULL,
                frozen_chain_hash TEXT NOT NULL
             );
             CREATE TABLE frozen_segments (
                segment_index INTEGER PRIMARY KEY,
                event_index INTEGER NOT NULL,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );
             CREATE TABLE tail_segment (
                singleton INTEGER PRIMARY KEY,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );",
        )
        .expect("spool schema");
        let events = [
            event("a", "cliagent-test", "one"),
            event("b", "cliagent-test", "two"),
            event("c", "cliagent-test", "three"),
        ];
        let mut first_size = 0_usize;
        for (index, event) in events.iter().enumerate() {
            let (segment, _) = encode_cloud_frozen_event(event, &mut |_, _| {
                panic!("compact event has no deferred payload")
            })
            .expect("encode event segment");
            if index == 0 {
                first_size = segment.wire_bytes as usize;
            }
            conn.execute(
                "INSERT INTO events VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    index as i64,
                    format!("event-{index}"),
                    format!("chain-{index}"),
                ],
            )
            .expect("insert event");
            conn.execute(
                "INSERT INTO frozen_segments VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    index as i64,
                    index as i64,
                    segment.payload_gz,
                    segment.event_count as i64,
                    segment.segment_hash,
                    segment.wire_bytes as i64,
                ],
            )
            .expect("insert frozen segment");
        }
        conn.execute(
            "INSERT INTO tail_segment VALUES (1, 'tail-payload', 1, 'tail-hash', 12)",
            [],
        )
        .expect("insert tail segment");
        drop(conn);
        let manifest = ExternalReplayCloudManifest {
            token: token.clone(),
            generation: "g1".to_string(),
            total_count: 3,
            frozen_event_count: 3,
            tail_event_count: 0,
            frozen_chain_hash: "chain-2".to_string(),
            tail_hash: None,
        };
        cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.clone(),
                CloudSpoolEntry {
                    path: path.clone(),
                    manifest,
                    last_used: Instant::now(),
                    lease_count: 1,
                    owner_released: false,
                },
            );

        let batch = read_cloud_spool_batch(&token, 0, 3, None, Some(first_size + 1))
            .expect("bounded batch");
        assert_eq!(batch.segments.len(), 1);
        assert_eq!(batch.next_event_index, 1);
        assert!(!batch.eof);
        assert!(batch.serialized_bytes <= (first_size + 1) as u64);
        let prefix = cloud_spool_prefix_hash(&token, 2).expect("prefix");
        assert_eq!(prefix.frozen_chain_hash, "chain-1");
        let empty = read_cloud_spool_batch(&token, 3, 3, None, None).expect("empty frozen range");
        assert!(empty.segments.is_empty());
        assert_eq!(empty.next_event_index, 3);
        assert!(empty.eof);

        release_cloud_spool(&token).expect("release spool");
        assert!(!path.exists());
    }

    #[test]
    fn cloud_spool_release_waits_for_in_flight_read_lease() {
        let token = format!("test-lease-{}", uuid::Uuid::new_v4());
        let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
        fs::write(&path, b"leased").expect("leased spool file");
        cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.clone(),
                CloudSpoolEntry {
                    path: path.clone(),
                    manifest: ExternalReplayCloudManifest {
                        token: token.clone(),
                        generation: "g-lease".to_string(),
                        total_count: 0,
                        frozen_event_count: 0,
                        tail_event_count: 0,
                        frozen_chain_hash: sha256_hex(b""),
                        tail_hash: None,
                    },
                    last_used: Instant::now(),
                    lease_count: 1,
                    owner_released: false,
                },
            );

        let read_lease = acquire_cloud_spool_read(&token).expect("acquire read lease");
        release_cloud_spool(&token).expect("release owner lease");
        assert!(path.exists(), "active read must keep the spool file alive");
        assert!(acquire_cloud_spool_read(&token).is_err());

        drop(read_lease);
        assert!(!path.exists(), "last reader removes the released spool");
    }

    #[test]
    fn nine_live_cloud_spools_are_not_lru_evicted() {
        let mut entries = Vec::new();
        for index in 0..9 {
            let token = format!("test-nine-{index}-{}", uuid::Uuid::new_v4());
            let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
            fs::write(&path, b"live").expect("live spool file");
            cloud_spools()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    token.clone(),
                    CloudSpoolEntry {
                        path: path.clone(),
                        manifest: ExternalReplayCloudManifest {
                            token: token.clone(),
                            generation: format!("g-{index}"),
                            total_count: 0,
                            frozen_event_count: 0,
                            tail_event_count: 0,
                            frozen_chain_hash: sha256_hex(b""),
                            tail_hash: None,
                        },
                        last_used: Instant::now(),
                        lease_count: 1,
                        owner_released: false,
                    },
                );
            entries.push((token, path));
        }

        cleanup_cloud_spools();

        for (token, path) in &entries {
            assert!(path.exists(), "live spool {token} was evicted");
            drop(acquire_cloud_spool_read(token).expect("live token remains readable"));
        }
        for (token, path) in entries {
            release_cloud_spool(&token).expect("release live spool");
            assert!(!path.exists());
        }
    }

    #[test]
    fn cloud_spool_physical_cursor_advances_across_zero_event_v2_parts() {
        let token = format!("test-v2-{}", uuid::Uuid::new_v4());
        let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
        let conn = rusqlite::Connection::open(&path).expect("V2 spool db");
        conn.execute_batch(
            "CREATE TABLE events (
                event_index INTEGER PRIMARY KEY,
                event_hash TEXT NOT NULL,
                frozen_chain_hash TEXT NOT NULL
             );
             CREATE TABLE frozen_segments (
                segment_index INTEGER PRIMARY KEY,
                event_index INTEGER NOT NULL,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );
             CREATE TABLE tail_segment (
                singleton INTEGER PRIMARY KEY,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );",
        )
        .expect("V2 spool schema");
        let attachment_id = sha256_hex(b"event-v2");
        let attachment_hash = sha256_hex(b"abcdef");
        let first = encode_cloud_attachment_frame(
            &CloudAttachmentFrameHeader {
                kind: "event",
                attachment_id: &attachment_id,
                part_index: 0,
                chunk_offset: 0,
                chunk_bytes: 3,
                final_part: false,
                event_bytes: None,
                attachment_hash: None,
            },
            b"abc",
            0,
        )
        .expect("first V2 row");
        let final_segment = encode_cloud_attachment_frame(
            &CloudAttachmentFrameHeader {
                kind: "event",
                attachment_id: &attachment_id,
                part_index: 1,
                chunk_offset: 3,
                chunk_bytes: 3,
                final_part: true,
                event_bytes: Some(6),
                attachment_hash: Some(&attachment_hash),
            },
            b"def",
            1,
        )
        .expect("final V2 row");
        for (segment_index, segment) in [first.clone(), final_segment].into_iter().enumerate() {
            conn.execute(
                "INSERT INTO frozen_segments VALUES (?1, 0, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    segment_index as i64,
                    segment.payload_gz,
                    segment.event_count as i64,
                    segment.segment_hash,
                    segment.wire_bytes as i64,
                ],
            )
            .expect("insert V2 physical row");
        }
        conn.execute("INSERT INTO events VALUES (0, ?1, ?1)", [&attachment_hash])
            .expect("insert V2 logical event");
        drop(conn);
        cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.clone(),
                CloudSpoolEntry {
                    path: path.clone(),
                    manifest: ExternalReplayCloudManifest {
                        token: token.clone(),
                        generation: "g-v2".to_string(),
                        total_count: 1,
                        frozen_event_count: 1,
                        tail_event_count: 0,
                        frozen_chain_hash: attachment_hash,
                        tail_hash: None,
                    },
                    last_used: Instant::now(),
                    lease_count: 1,
                    owner_released: false,
                },
            );

        let first_batch =
            read_cloud_spool_batch(&token, 0, 1, None, Some(first.wire_bytes as usize))
                .expect("first V2 physical batch");
        assert_eq!(first_batch.segments.len(), 1);
        assert_eq!(first_batch.next_event_index, 0);
        assert_eq!(first_batch.next_segment_index, 1);
        assert!(!first_batch.eof);
        let final_batch =
            read_cloud_spool_batch(&token, 0, 1, Some(1), None).expect("final V2 physical batch");
        assert_eq!(final_batch.next_event_index, 1);
        assert_eq!(final_batch.next_segment_index, 2);
        assert!(final_batch.eof);

        release_cloud_spool(&token).expect("release V2 spool");
    }

    #[test]
    fn ten_mib_single_event_is_streamed_into_one_bounded_lossless_cloud_wire() {
        let total = 10 * 1024 * 1024;
        let mut replay_event = event("large", "cliagent-test", "preview");
        replay_event.result = serde_json::json!({"content":"preview"});
        replay_event.display_text = "preview".to_string();
        replay_event.payload_refs = vec![PayloadRef {
            event_id: replay_event.id.clone(),
            field_path: "result.content".to_string(),
            preview: "preview".to_string(),
            full_size_bytes: total,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::Utf8Text),
            replay_source_id: Some("codex_app".to_string()),
            replay_generation: Some("g1".to_string()),
            replay_source_event_id: Some("source-large".to_string()),
        }];
        let mut largest_range = 0_usize;
        let (segment, _) = encode_cloud_frozen_event(&replay_event, &mut |_, offset| {
            let start = offset as usize;
            let bytes = total.saturating_sub(start).min(EXPORT_PAYLOAD_RANGE_BYTES);
            largest_range = largest_range.max(bytes);
            Ok(ReplayPayloadRange {
                event_id: "source-large".to_string(),
                field_path: "result.content".to_string(),
                offset,
                text: "x".repeat(bytes),
                next_offset: offset.saturating_add(bytes as u64),
                eof: start.saturating_add(bytes) >= total,
                total_bytes: total as u64,
            })
        })
        .expect("compressible large event wire");
        assert!(largest_range <= EXPORT_PAYLOAD_RANGE_BYTES);
        assert!(segment.wire_bytes <= CLOUD_SEGMENT_WIRE_MAX_BYTES as u64);

        let compressed = BASE64_STANDARD
            .decode(segment.payload_gz)
            .expect("base64 segment");
        let mut decoded = String::new();
        GzDecoder::new(compressed.as_slice())
            .read_to_string(&mut decoded)
            .expect("gzip segment");
        let value: serde_json::Value = serde_json::from_str(&decoded).expect("segment JSON");
        assert_eq!(
            value[0]["result"]["content"]
                .as_str()
                .expect("full result")
                .len(),
            total
        );
    }

    #[test]
    fn replay_attachment_v2_frame_matches_the_typescript_golden_hash() {
        let attachment_id = sha256_hex(b"golden");
        let attachment_hash = sha256_hex(b"abc");
        let header = CloudAttachmentFrameHeader {
            kind: "event",
            attachment_id: &attachment_id,
            part_index: 0,
            chunk_offset: 0,
            chunk_bytes: 3,
            final_part: true,
            event_bytes: Some(3),
            attachment_hash: Some(&attachment_hash),
        };
        let segment = encode_cloud_attachment_frame(&header, b"abc", 1).expect("golden frame");
        assert_eq!(
            segment.segment_hash,
            "1cf7b415e8558ddb0d72bcf9212ff381c9a57bfd719628824a61e4a67bcf3126"
        );
    }

    #[test]
    fn ten_mib_high_entropy_event_round_trips_through_bounded_v2_rows() {
        let total = 10 * 1024 * 1024;
        let mut replay_event = event("random", "cliagent-test", "preview");
        replay_event.result = serde_json::json!({"content":"preview"});
        replay_event.payload_refs = vec![PayloadRef {
            event_id: replay_event.id.clone(),
            field_path: "result.content".to_string(),
            preview: "preview".to_string(),
            full_size_bytes: total,
            truncated: true,
            replay_encoding: Some(PayloadRefEncoding::Utf8Text),
            replay_source_id: Some("codex_app".to_string()),
            replay_generation: Some("g1".to_string()),
            replay_source_event_id: Some("source-random".to_string()),
        }];
        let mut largest_range = 0_usize;
        let mut segments = Vec::new();
        let event_hash = encode_cloud_event_segments(
            &replay_event,
            &mut |_, offset| {
                let start = offset as usize;
                let bytes = total.saturating_sub(start).min(EXPORT_PAYLOAD_RANGE_BYTES);
                largest_range = largest_range.max(bytes);
                let text = (start..start + bytes)
                    .map(|index| {
                        let mut value = index as u64 + 0x9e37_79b9_7f4a_7c15;
                        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
                        let alphabet =
                            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
                        alphabet[(value ^ (value >> 31)) as usize % alphabet.len()] as char
                    })
                    .collect::<String>();
                Ok(ReplayPayloadRange {
                    event_id: "source-random".to_string(),
                    field_path: "result.content".to_string(),
                    offset,
                    text,
                    next_offset: offset.saturating_add(bytes as u64),
                    eof: start.saturating_add(bytes) >= total,
                    total_bytes: total as u64,
                })
            },
            &mut |segment| {
                segments.push(segment);
                Ok(())
            },
        )
        .expect("V2 attachment rows");

        assert!(largest_range <= EXPORT_PAYLOAD_RANGE_BYTES);
        assert!(segments.len() > 2);
        assert_eq!(
            segments
                .iter()
                .map(|segment| segment.event_count)
                .sum::<u64>(),
            1
        );
        let mut hydrated_event = Vec::new();
        for (part_index, segment) in segments.iter().enumerate() {
            assert!(segment.wire_bytes <= CLOUD_SEGMENT_WIRE_MAX_BYTES as u64);
            let compressed = BASE64_STANDARD
                .decode(&segment.payload_gz)
                .expect("base64 V2 frame");
            let mut frame = Vec::new();
            GzDecoder::new(compressed.as_slice())
                .read_to_end(&mut frame)
                .expect("gzip V2 frame");
            assert_eq!(sha256_hex(&frame), segment.segment_hash);
            assert!(frame.starts_with(CLOUD_ATTACHMENT_V2_MAGIC));
            let header_offset = CLOUD_ATTACHMENT_V2_MAGIC.len();
            let header_len = u32::from_be_bytes(
                frame[header_offset..header_offset + 4]
                    .try_into()
                    .expect("V2 header length"),
            ) as usize;
            let payload_offset = header_offset + 4 + header_len;
            let header: serde_json::Value =
                serde_json::from_slice(&frame[header_offset + 4..payload_offset])
                    .expect("V2 header JSON");
            assert_eq!(header["partIndex"].as_u64(), Some(part_index as u64));
            assert_eq!(
                header["chunkOffset"].as_u64(),
                Some(hydrated_event.len() as u64)
            );
            let final_part = part_index + 1 == segments.len();
            assert_eq!(header["finalPart"].as_bool(), Some(final_part));
            assert_eq!(segment.event_count, u64::from(final_part));
            hydrated_event.extend_from_slice(&frame[payload_offset..]);
            if final_part {
                assert_eq!(
                    header["eventBytes"].as_u64(),
                    Some(hydrated_event.len() as u64)
                );
                assert_eq!(header["attachmentHash"].as_str(), Some(event_hash.as_str()));
            }
        }
        assert_eq!(sha256_hex(&hydrated_event), event_hash);
        let value: serde_json::Value =
            serde_json::from_slice(&hydrated_event).expect("hydrated event JSON");
        assert_eq!(
            value["result"]["content"]
                .as_str()
                .expect("full V2 result")
                .len(),
            total
        );
    }
}
