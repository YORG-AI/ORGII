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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

#[cfg(test)]
use super::replay_cloud_wire::REPLAY_ATTACHMENT_V2_MAGIC as CLOUD_ATTACHMENT_V2_MAGIC;
use super::{
    event_conversion::cached_event_to_session_event,
    external_replay_cache::schedule_replay_cache_prune,
    external_replay_watcher,
    replay_cloud_wire::{
        encode_replay_attachment_v2_frame,
        ReplayAttachmentV2FrameHeader as CloudAttachmentFrameHeader, CLOUD_PAGE_MAX_SEGMENTS,
        CLOUD_SEGMENT_WIRE_MAX_BYTES,
        REPLAY_ATTACHMENT_CHUNK_BYTES as CLOUD_ATTACHMENT_CHUNK_BYTES,
    },
    schedule_notify, EventStoreState,
};

pub const MANAGED_CLI_REPLAY_TARGET_ID: &str = "managed_cli";
/// ORGII-owned collaboration snapshots persisted under `imported-session-*`.
/// This is intentionally outside `ImportedHistorySourceId`: it is not a
/// vendor adapter and must not change the exhaustive 15-source registry.
pub const COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID: &str = "collaboration_snapshot";
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
// still use the exact managed-chunk serde path, while large JSON is projected by
// SQLite into compact nodes and payload locators.
const MANAGED_CHUNK_INLINE_JSON_MAX_BYTES: usize = 64 * 1024;
const MANAGED_CHUNK_JSON_PROJECTION_MAX_BYTES: usize = 64 * 1024;
const MANAGED_CHUNK_JSON_PROJECTION_MAX_NODES: usize = 256;
const MANAGED_CHUNK_JSON_KEY_MAX_BYTES: usize = 1024;
const MANAGED_CHUNK_UTF8_BOUNDARY_BYTES: usize = 4;

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

/// Open a short-lived connection for visible replay work without queueing
/// behind the process-wide catalog-writer mutex.
///
/// Source discovery holds that mutex while it walks every installed provider,
/// including intervals where it owns no SQLite write transaction. Foreground
/// Shell materialization and delta polls must not wait for that unrelated
/// filesystem work. Replay synchronization still begins an IMMEDIATE
/// transaction, so SQLite itself remains the serialization boundary and the
/// configured busy timeout continues to coordinate a second ORGII process.
fn with_foreground_replay_connection<T>(
    context: &str,
    operation: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut conn = database::db::get_connection()
        .map_err(|error| format!("open foreground {context} DB: {error}"))?;
    operation(&mut conn)
}

#[cfg(test)]
static MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES: AtomicUsize = AtomicUsize::new(0);
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
        let window = match resolve_target(MANAGED_CLI_REPLAY_TARGET_ID, &session_id)? {
            ResolvedReplayTarget::Imported {
                source,
                imported_session_id,
            } => open_foreground_imported_window(source, &imported_session_id, TEST_REPLAY_LIMITS)
                .map(ResolvedReplayWindow::Imported)?,
            ResolvedReplayTarget::CollaborationSnapshot => {
                ResolvedReplayWindow::CollaborationSnapshot(
                    collaboration_snapshot_read_window_from_conn(
                        &database::db::get_connection()
                            .map_err(|err| format!("open collaboration replay DB: {err}"))?,
                        &session_id,
                        None,
                        None,
                        None,
                        TEST_REPLAY_LIMITS,
                    )?,
                )
            }
            ResolvedReplayTarget::ManagedChunkStore => {
                ResolvedReplayWindow::ManagedChunks(managed_chunk_open_window(
                    &session_id,
                    replay_storage_limits_with_normalization_headroom(TEST_REPLAY_LIMITS),
                )?)
            }
            ResolvedReplayTarget::NotReady => ResolvedReplayWindow::NotReady,
        };
        let mut response = match window {
            ResolvedReplayWindow::Imported(window)
            | ResolvedReplayWindow::ManagedChunks(window) => {
                normalize_window(window, &display_session_id)
            }
            ResolvedReplayWindow::CollaborationSnapshot(window) => window,
            ResolvedReplayWindow::NotReady => {
                not_ready_window(MANAGED_CLI_REPLAY_TARGET_ID, &display_session_id)
            }
        };
        remap_cursor(
            &mut response.cursor,
            MANAGED_CLI_REPLAY_TARGET_ID,
            &display_session_id,
        );
        response.events = persist_shell_replays_bounded(
            MANAGED_CLI_REPLAY_TARGET_ID,
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

enum ResolvedReplayTarget {
    Imported {
        source: ImportedHistorySourceId,
        imported_session_id: String,
    },
    CollaborationSnapshot,
    ManagedChunkStore,
    NotReady,
}

const STREAM_BATCH_MAX_EVENTS: usize = CLOUD_PAGE_MAX_SEGMENTS;
const STREAM_BATCH_MAX_BYTES: usize = CLOUD_SEGMENT_WIRE_MAX_BYTES;
const EXPORT_PAYLOAD_RANGE_BYTES: usize = 64 * 1024;
const EXPORT_WRITER_BUFFER_BYTES: usize = 256 * 1024;
/// Base64 expands binary by 4/3. Keeping the gzip sink below this bound also
/// bounds the temporary binary and base64 buffers while the exact wire check
/// below accounts for JSON field overhead.
const CLOUD_SEGMENT_GZIP_MAX_BYTES: usize = 191 * 1024;
const CLOUD_SPOOL_TTL: Duration = Duration::from_secs(10 * 60);

mod cloud;
mod collaboration;
mod export;
mod handoff;
mod managed_chunks;
mod payload;
mod request_guard;
mod shell;
mod target;
mod window;
mod wire_budget;

pub use cloud::*;
use collaboration::*;
pub use export::*;
pub use handoff::*;
use managed_chunks::*;
pub use payload::*;
use request_guard::{
    apply_foreground_delta_if_current, apply_foreground_window_if_current,
    apply_prewarm_window_if_current, begin_validated_foreground_request,
    begin_validated_prewarm_request, is_current_prewarm_request, is_current_replay_request,
    release_replay_watch_if_stale_episode, release_session_runtime_if_episode, ReplayWindowPublish,
};
pub(super) use request_guard::{cancel_prewarm_requests, release_session_runtime};
pub use shell::*;
use target::*;
use window::validate_query_apply_version;
pub use window::*;
use wire_budget::*;

#[cfg(test)]
mod tests;
