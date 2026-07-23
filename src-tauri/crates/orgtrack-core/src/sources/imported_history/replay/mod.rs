//! Storage-agnostic bounded replay for imported CLI histories.
//!
//! The public API exposes source-neutral generations, revisions and sequence
//! cursors.  Driver positions (JSONL byte offsets, SQLite keys, whole-JSON
//! generations) stay private and are persisted in ORGII-owned compact index
//! tables.  No API in this module falls back to a provider's full-history
//! loader.

mod cache_policy;
mod codex_jsonl;
#[cfg(test)]
mod conformance_tests;
mod index;
mod jsonl_driver;
mod metadata_projection;
mod payload_artifact;
#[cfg(test)]
mod perf_tests;
mod qoder_sidecar;
pub mod registry;
mod sqlite_driver;
mod structured_driver;
mod whole_json_driver;

use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};

pub use cache_policy::{
    prune_cache, ReplayCacheEviction, ReplayCacheEvictionReason, ReplayCachePolicy,
    ReplayCachePruneReport, DEFAULT_REPLAY_CACHE_MAX_BYTES, DEFAULT_REPLAY_CACHE_PROTECT_RECENT,
    DEFAULT_REPLAY_CACHE_TARGET_BYTES, DEFAULT_REPLAY_CACHE_TTL,
};
pub use registry::{
    ImportedHistorySourceId, ImportedReplayDescriptor, ReplayAdapterSupport, ReplayStorageFamily,
};

pub const DEFAULT_MAX_TURNS: usize = 1;
pub const HARD_MAX_TURNS: usize = 10;
pub const DEFAULT_MAX_EVENTS: usize = 200;
pub const HARD_MAX_EVENTS: usize = 200;
pub const DEFAULT_MAX_IPC_BYTES: usize = 4 * 1024 * 1024;
pub const HARD_MAX_IPC_BYTES: usize = 4 * 1024 * 1024;
pub const NORMAL_PAYLOAD_PREVIEW_BYTES: usize = 8 * 1024;
pub const SHELL_PAYLOAD_PREVIEW_BYTES: usize = 32 * 1024;
pub const DEFAULT_PAYLOAD_RANGE_BYTES: usize = 64 * 1024;
pub const HARD_MAX_PAYLOAD_RANGE_BYTES: usize = 256 * 1024;
pub const INVALIDATED_EVENT_NAME: &str = "external-replay://invalidated";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayLimits {
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    #[serde(default = "default_max_events")]
    pub max_events: usize,
    #[serde(default = "default_max_ipc_bytes")]
    pub max_ipc_bytes: usize,
}

const fn default_max_turns() -> usize {
    DEFAULT_MAX_TURNS
}
const fn default_max_events() -> usize {
    DEFAULT_MAX_EVENTS
}
const fn default_max_ipc_bytes() -> usize {
    DEFAULT_MAX_IPC_BYTES
}

impl Default for ReplayLimits {
    fn default() -> Self {
        Self {
            max_turns: DEFAULT_MAX_TURNS,
            max_events: DEFAULT_MAX_EVENTS,
            max_ipc_bytes: DEFAULT_MAX_IPC_BYTES,
        }
    }
}

impl ReplayLimits {
    pub fn bounded(self) -> Self {
        Self {
            max_turns: self.max_turns.clamp(1, HARD_MAX_TURNS),
            max_events: self.max_events.clamp(1, HARD_MAX_EVENTS),
            max_ipc_bytes: self.max_ipc_bytes.clamp(1, HARD_MAX_IPC_BYTES),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCursor {
    pub source_id: String,
    pub session_id: String,
    pub generation: String,
    pub revision: u64,
    pub through_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTurnHeader {
    pub turn_id: String,
    pub turn_index: i64,
    pub start_sequence: i64,
    pub end_sequence: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub event_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStats {
    pub parsed_bytes: u64,
    pub parsed_rows: u64,
    pub normalized_events: u64,
    pub upserted_events: u64,
    pub removed_events: u64,
    pub ipc_bytes: u64,
    pub not_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPayloadDescriptor {
    pub field_path: String,
    pub kind: ReplayPayloadKind,
    /// Encoding of bytes returned by payload range reads. New adapters must
    /// set this explicitly; the legacy value exists only so replay rows
    /// written before this field was introduced remain readable.
    #[serde(default)]
    pub encoding: ReplayPayloadEncoding,
    /// Bounded semantic body selected before a root JSON value is compacted.
    /// Markdown/CSV consumers use this instead of hydrating the whole root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_projection: Option<ReplayPayloadBodyProjection>,
    pub spans: Vec<ReplaySourceSpan>,
    pub total_bytes: u64,
    /// Ordinal of the normalized payload-bearing item within one JSONL line.
    /// This is persisted only as a source locator; public cursors remain
    /// storage-neutral.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ordinal: Option<u32>,
    /// Stable provider row/KV key used by SQLite adapters for range reads.
    /// It is an internal locator and is never exposed in [`ReplayCursor`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
}

impl ReplayPayloadDescriptor {
    /// Resolve rows written before `encoding` became explicit without
    /// preserving path-shape inference in new production call sites.
    pub fn resolved_encoding(&self) -> ReplayPayloadEncoding {
        match self.encoding {
            ReplayPayloadEncoding::LegacyPathInferred => {
                if self.field_path.contains('.') {
                    ReplayPayloadEncoding::Utf8Text
                } else {
                    ReplayPayloadEncoding::JsonValue
                }
            }
            encoding => encoding,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayPayloadEncoding {
    /// Compatibility-only value for cached descriptors that predate this
    /// field. Newly constructed descriptors must never use it.
    #[default]
    LegacyPathInferred,
    /// Payload ranges form one complete serialized JSON value.
    JsonValue,
    /// Payload ranges form decoded UTF-8 string content.
    Utf8Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPayloadBodyProjection {
    pub field_path: String,
    pub text: String,
    pub truncated: bool,
}

/// Select and bound the same semantic body used by transcript renderers
/// before a canonical root JSON payload is replaced by a compact preview.
/// `fallback_json` should be the already-serialized root when the root has no
/// well-known text field, avoiding a second session-sized serialization.
pub fn replay_payload_body_projection(
    root: &str,
    value: &serde_json::Value,
    fallback_json: Option<&str>,
    max_bytes: usize,
    tail: bool,
) -> Option<ReplayPayloadBodyProjection> {
    let (field_path, text) = replay_body_candidate(root, value)
        .or_else(|| fallback_json.map(|text| (root.to_string(), text)))?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (text, truncated) = bounded_body_preview(text, max_bytes, tail);
    Some(ReplayPayloadBodyProjection {
        field_path,
        text: text.to_string(),
        truncated,
    })
}

fn replay_body_candidate<'a>(
    root: &str,
    value: &'a serde_json::Value,
) -> Option<(String, &'a str)> {
    match value {
        serde_json::Value::String(text) => Some((root.to_string(), text)),
        serde_json::Value::Object(map) => {
            if let Some(text) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(serde_json::Value::as_str)
            {
                if !text.trim().is_empty() {
                    return Some((format!("{root}.message.content"), text));
                }
            }
            for key in [
                "content",
                "text",
                "observation",
                "cmd",
                "command",
                "body",
                "summary",
                "prompt",
                "description",
            ] {
                let Some(text) = map.get(key).and_then(serde_json::Value::as_str) else {
                    continue;
                };
                if !text.trim().is_empty() {
                    return Some((format!("{root}.{key}"), text));
                }
            }
            None
        }
        _ => None,
    }
}

fn bounded_body_preview(text: &str, max_bytes: usize, tail: bool) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    if tail {
        let mut start = text.len().saturating_sub(max_bytes);
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        (&text[start..], true)
    } else {
        let mut end = text.len().min(max_bytes);
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        (&text[..end], true)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayPayloadKind {
    UserMessage,
    AgentMessage,
    AssistantContent,
    Reasoning,
    ToolOutput,
    ToolArguments,
    ToolDiff,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySourceSpan {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone)]
pub struct ReplayIndexedChunk {
    pub sequence: i64,
    pub turn_index: i64,
    pub chunk: ActivityChunk,
    pub payloads: Vec<ReplayPayloadDescriptor>,
}

#[derive(Debug, Clone)]
pub struct ReplayChunkWindow {
    pub cursor: ReplayCursor,
    pub chunks: Vec<ReplayIndexedChunk>,
    pub turn_headers: Vec<ReplayTurnHeader>,
    pub total_turn_count: u64,
    pub total_event_count: u64,
    pub has_older: bool,
    pub stats: ReplayStats,
}

#[derive(Debug, Clone)]
pub struct ReplayChunkDelta {
    pub cursor: ReplayCursor,
    pub chunks: Vec<ReplayIndexedChunk>,
    pub removed_event_ids: Vec<String>,
    pub reset_required: bool,
    pub stats: ReplayStats,
}

/// Source-neutral forward scan used by backend-only streaming consumers.
///
/// Unlike `ReplayChunkWindow`, this does not apply turn pagination: callers
/// advance strictly by sequence and keep each batch bounded by `ReplayLimits`.
/// The type is intentionally not part of the renderer wire protocol.
#[derive(Debug, Clone)]
pub struct ReplayChunkScan {
    pub cursor: ReplayCursor,
    pub chunks: Vec<ReplayIndexedChunk>,
    pub has_more: bool,
    pub stats: ReplayStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPayloadRange {
    pub event_id: String,
    pub field_path: String,
    pub offset: u64,
    pub next_offset: u64,
    pub eof: bool,
    pub total_bytes: u64,
    pub text: String,
}

/// Immutable locator for one content-addressed payload body in ORGII's replay
/// cache. This type is backend-only: renderer wire types continue to expose
/// only source-neutral event/field payload references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayPayloadArtifactLocator {
    pub source_id: String,
    pub source_session_id: String,
    pub generation: String,
    pub content_hash: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayInvalidated {
    pub session_id: String,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
}

/// Register one already-resolved external transcript without scanning its
/// body. Lifecycle hooks can learn about a child transcript before the next
/// catalog refresh; replay still needs the canonical source path in order to
/// build its bounded compact index. Existing catalog metadata is deliberately
/// preserved -- this only establishes the source/session/path binding.
pub fn bind_source_path(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    session_id: &str,
    source_path: &Path,
) -> Result<(), String> {
    source.validate_session_id(session_id)?;
    let expected_source_session_id = source.source_session_id(session_id)?;
    if expected_source_session_id != source_session_id {
        return Err(format!(
            "Replay source identity mismatch: session {session_id} resolves to {expected_source_session_id}, not {source_session_id}"
        ));
    }
    if !source_path.is_file() {
        return Err(format!(
            "Replay source path is not a file: {}",
            source_path.display()
        ));
    }
    let source_path = source_path
        .canonicalize()
        .unwrap_or_else(|_| source_path.to_path_buf());
    conn.execute(
        "INSERT INTO imported_history_session_cache (
             source,source_session_id,session_id,source_path,source_record_key,
             parser_version,listable,updated_at
         ) VALUES (?1,?2,?3,?4,?2,?5,0,?6)
         ON CONFLICT(source,source_session_id) DO UPDATE SET
             session_id=excluded.session_id,
             source_path=excluded.source_path,
             source_record_key=excluded.source_record_key,
             parser_version=excluded.parser_version,
             updated_at=excluded.updated_at",
        rusqlite::params![
            source.as_str(),
            source_session_id,
            session_id,
            source_path.to_string_lossy(),
            i64::from(source.descriptor().parser_version),
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|err| format!("bind imported replay source path: {err}"))?;
    Ok(())
}

/// Physical sources whose mutations can invalidate one replay session.
///
/// This is a backend lifecycle API, not part of the renderer wire protocol;
/// storage-specific sidecar locations never cross IPC.
pub fn watch_paths(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
) -> Result<Vec<PathBuf>, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let resolved = index::resolve_source(conn, source, session_id)?;
    let mut paths = vec![resolved.path.clone()];
    if source == ImportedHistorySourceId::Qoder {
        paths.extend(qoder_sidecar::watch_paths(
            &resolved.source_session_id,
            &resolved.path,
        ));
    }
    for path in &mut paths {
        *path = path.canonicalize().unwrap_or_else(|_| path.clone());
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub fn open_window(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let sync = index::sync_index(conn, source, session_id)?;
    let mut window = index::read_recent_window(conn, source, session_id, limits.bounded())?;
    merge_sync_stats(&mut window.stats, sync.stats);
    Ok(window)
}

pub fn poll_delta(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
) -> Result<ReplayChunkDelta, String> {
    source.validate_session_id(session_id)?;
    validate_cursor_identity(source, session_id, cursor)?;
    ensure_supported(source)?;
    let sync = index::sync_index(conn, source, session_id)?;
    index::read_delta(conn, source, session_id, cursor, limits.bounded(), sync)
}

pub fn read_window(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    before_sequence: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let sync = index::sync_index(conn, source, session_id)?;
    let mut window =
        index::read_window_before(conn, source, session_id, before_sequence, limits.bounded())?;
    merge_sync_stats(&mut window.stats, sync.stats);
    Ok(window)
}

/// Read one compact-index turn by its stable header id. This is the bounded
/// replacement for Cursor IDE's legacy lazy `cursorIdeTurnWindow` hydration.
pub fn read_turn_window(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    turn_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    index::sync_index(conn, source, session_id)?;
    index::read_window_for_turn(conn, source, session_id, turn_id, limits.bounded())
}

pub fn read_turn_window_at_index(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    turn_index: i64,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    index::sync_index(conn, source, session_id)?;
    index::read_window_for_turn_index(conn, source, session_id, turn_index, limits.bounded())
}

/// Project compact metadata for visible imported-history turns without
/// materializing an `ActivityChunk` transcript or applying the 200-event
/// renderer window limit.
pub fn project_turn_metadata(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    requested_turn_ids: Option<&[String]>,
) -> Result<Vec<crate::projectors::turn_metadata::ProjectedTurnMetadata>, String> {
    ensure_supported(source)?;
    metadata_projection::project_turn_metadata(conn, source, session_id, requested_turn_ids)
}

pub fn scan_window_after(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    after_sequence: i64,
    limits: ReplayLimits,
) -> Result<ReplayChunkScan, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let sync = index::sync_index(conn, source, session_id)?;
    index::read_scan_after(
        conn,
        source,
        session_id,
        after_sequence,
        limits.bounded(),
        sync,
    )
}

/// Continue a backend-only scan against one already-synchronized immutable
/// replay cursor. This is used by consumers that must atomically replace a
/// derived read model: they first complete a normal generation/revision-checked
/// scan, then replay that exact compact snapshot inside their own SQLite
/// transaction. It deliberately does not touch the external source or start a
/// nested replay-index transaction.
pub fn scan_window_after_generation(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    revision: u64,
    after_sequence: i64,
    limits: ReplayLimits,
) -> Result<ReplayChunkScan, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let scan = index::read_scan_after(
        conn,
        source,
        session_id,
        after_sequence,
        limits.bounded(),
        index::ReplaySyncResult::default(),
    )?;
    if scan.cursor.generation != generation || scan.cursor.revision != revision {
        return Err(format!(
            "Replay cursor changed while publishing a derived snapshot: expected {generation}@{revision}, found {}@{}",
            scan.cursor.generation, scan.cursor.revision
        ));
    }
    Ok(scan)
}

const MAX_PINNED_SCAN_RESTARTS: usize = 2;

/// Materialize every compact turn through bounded pages, then return one
/// stable generation/revision that strict snapshot readers can replay.
///
/// This first pass deliberately retains no chunks. It is required for lazy
/// SQLite/KV sources, whose older turns legitimately advance the replay
/// revision when materialized. Once all turns are present, a fresh source sync
/// verifies that the transcript did not change during preparation. A changing
/// source restarts at most twice; it can never keep a caller in an endless
/// chase of a live transcript.
pub fn prepare_pinned_scan(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayCursor, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let limits = limits.bounded();

    retry_pinned_scan_preparation(session_id, || {
        prepare_pinned_scan_attempt(conn, source, session_id, limits)
    })
}

fn retry_pinned_scan_preparation(
    session_id: &str,
    mut attempt: impl FnMut() -> Result<Option<ReplayCursor>, String>,
) -> Result<ReplayCursor, String> {
    for restart in 0..=MAX_PINNED_SCAN_RESTARTS {
        if let Some(cursor) = attempt()? {
            return Ok(cursor);
        }
        if restart == MAX_PINNED_SCAN_RESTARTS {
            break;
        }
    }
    Err(format!(
        "Imported replay source {session_id} kept changing while preparing a pinned scan after {MAX_PINNED_SCAN_RESTARTS} restarts"
    ))
}

fn prepare_pinned_scan_attempt(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<Option<ReplayCursor>, String> {
    let mut previous_sequence = -1_i64;
    let mut scan = scan_window_after(conn, source, session_id, previous_sequence, limits)?;
    loop {
        if scan.has_more && scan.cursor.through_sequence <= previous_sequence {
            return Err(format!(
                "Bounded replay preparation made no progress for {session_id} after sequence {previous_sequence}"
            ));
        }
        previous_sequence = scan.cursor.through_sequence;
        if !scan.has_more {
            break;
        }
        let Some(next) =
            continue_pinned_scan_preparation(conn, source, session_id, &scan.cursor, limits)?
        else {
            return Ok(None);
        };
        scan = next;
    }

    let prepared = scan.cursor;
    let verification =
        scan_window_after(conn, source, session_id, prepared.through_sequence, limits)?;
    if verification.cursor.generation != prepared.generation
        || verification.cursor.revision != prepared.revision
        || verification.has_more
        || !verification.chunks.is_empty()
    {
        return Ok(None);
    }
    Ok(Some(verification.cursor))
}

/// Continue only the discard-only preparation pass without observing the
/// external source again. Revision growth here can only come from lazy turn
/// materialization on this connection. A concurrent index change requests a
/// bounded restart instead of weakening the final strict snapshot.
fn continue_pinned_scan_preparation(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
) -> Result<Option<ReplayChunkScan>, String> {
    validate_cursor_identity(source, session_id, cursor)?;
    let resolved = index::resolve_source(conn, source, session_id)?;
    let state = index::load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared before continuation".to_string())?;
    if state.generation != cursor.generation || state.revision != cursor.revision {
        return Ok(None);
    }
    let scan = index::read_scan_after(
        conn,
        source,
        session_id,
        cursor.through_sequence,
        limits.bounded(),
        index::ReplaySyncResult::default(),
    )?;
    if scan.cursor.generation != cursor.generation || scan.cursor.revision < cursor.revision {
        return Ok(None);
    }
    Ok(Some(scan))
}

#[allow(clippy::too_many_arguments)]
pub fn read_payload_range(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<ReplayPayloadRange, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_PAYLOAD_RANGE_BYTES)
        .clamp(1, HARD_MAX_PAYLOAD_RANGE_BYTES);
    index::read_payload_range(
        conn, source, session_id, generation, event_id, field_path, offset, max_bytes,
    )
}

/// Ensure one deferred payload has an immutable content-addressed artifact.
///
/// The caller owns `tx` so publishing a derived Shell manifest can occur in
/// the same transaction as the content hash. Direct provider ranges are read
/// in bounded pages and streamed into SQLite incremental BLOB I/O; no complete
/// payload is assembled in Rust.
#[allow(clippy::too_many_arguments)]
pub fn materialize_payload_artifact(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
) -> Result<ReplayPayloadArtifactLocator, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    index::materialize_payload_artifact(tx, source, session_id, generation, event_id, field_path)
}

/// Store a payload produced by an ORGII-owned replay adapter (managed CLI or
/// collaboration snapshot) in the same content-addressed artifact store.
/// The caller keeps manifest publication in this transaction.
#[allow(clippy::too_many_arguments)]
pub fn store_scoped_payload_artifact_streamed<F>(
    tx: &Transaction<'_>,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    total_bytes: u64,
    produce: F,
) -> Result<ReplayPayloadArtifactLocator, String>
where
    F: FnOnce(&mut dyn std::io::Write) -> Result<(), String>,
{
    if source_id.is_empty() || source_session_id.is_empty() || generation.is_empty() {
        return Err("Replay payload artifact scope must be non-empty".to_string());
    }
    let content_hash = payload_artifact::store_streamed_for_scope(
        tx,
        source_id,
        source_session_id,
        generation,
        event_id,
        field_path,
        total_bytes,
        produce,
    )?;
    Ok(ReplayPayloadArtifactLocator {
        source_id: source_id.to_string(),
        source_session_id: source_session_id.to_string(),
        generation: generation.to_string(),
        content_hash,
        total_bytes,
    })
}

/// Reuse a body only inside an immutable ORGII-owned managed/snapshot epoch.
/// Vendor adapters intentionally do not call this API because their rows may
/// update in place while the surrounding replay generation remains stable.
#[allow(clippy::too_many_arguments)]
pub fn find_scoped_payload_artifact(
    tx: &Transaction<'_>,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    expected_bytes: u64,
) -> Result<Option<ReplayPayloadArtifactLocator>, String> {
    if source_id.is_empty() || source_session_id.is_empty() || generation.is_empty() {
        return Err("Replay payload artifact scope must be non-empty".to_string());
    }
    let Some(content_hash) = payload_artifact::find_for_immutable_scope(
        tx,
        source_id,
        source_session_id,
        generation,
        event_id,
        field_path,
        expected_bytes,
    )?
    else {
        return Ok(None);
    };
    Ok(Some(ReplayPayloadArtifactLocator {
        source_id: source_id.to_string(),
        source_session_id: source_session_id.to_string(),
        generation: generation.to_string(),
        content_hash,
        total_bytes: expected_bytes,
    }))
}

/// Return whether a JSON object field exists only in a compact replay row.
///
/// Compatibility serializers that walk a preview instead of replacing a
/// root payload must omit these fields. They are useful to ORGII's bounded UI
/// and metadata projection, but were not present in the provider transcript.
pub fn is_compact_only_replay_field(key: &str) -> bool {
    matches!(key, "_replayTruncated" | "_preview")
        || key == crate::development_artifact::REPLAY_GIT_ARTIFACTS_FIELD
}

fn ensure_supported(source: ImportedHistorySourceId) -> Result<(), String> {
    let descriptor = source.descriptor();
    if descriptor.support != ReplayAdapterSupport::Incremental {
        return Err(format!(
            "Bounded replay adapter for {} ({:?}) is not implemented; refusing full-history fallback",
            descriptor.source_id, descriptor.storage_family
        ));
    }
    Ok(())
}

fn merge_sync_stats(target: &mut ReplayStats, sync: ReplayStats) {
    target.parsed_bytes = target.parsed_bytes.saturating_add(sync.parsed_bytes);
    target.parsed_rows = target.parsed_rows.saturating_add(sync.parsed_rows);
    target.normalized_events = target
        .normalized_events
        .saturating_add(sync.normalized_events);
    target.upserted_events = target.upserted_events.saturating_add(sync.upserted_events);
    target.removed_events = target.removed_events.saturating_add(sync.removed_events);
    target.not_ready |= sync.not_ready;
}

fn validate_cursor_identity(
    source: ImportedHistorySourceId,
    session_id: &str,
    cursor: &ReplayCursor,
) -> Result<(), String> {
    if cursor.source_id != source.as_str() || cursor.session_id != session_id {
        return Err("Replay cursor belongs to another source/session".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteRecordStore;

    fn codex_fixture() -> (rusqlite::Connection, std::path::PathBuf, String) {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory replay DB");
        SqliteRecordStore::init_tables(&conn).expect("replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        let path = std::env::temp_dir().join(format!(
            "orgii-codex-replay-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let session_id = "codexapp-replay-fixture".to_string();
        conn.execute(
            "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES ('codex_app', 'replay-fixture', ?1, ?2)",
            rusqlite::params![session_id, path.to_string_lossy()],
        )
        .expect("cache fixture source");
        (conn, path, session_id)
    }

    fn jsonl(payload: serde_json::Value) -> String {
        serde_json::json!({
            "timestamp": "2026-07-22T00:00:00Z",
            "type": "event_msg",
            "payload": payload,
        })
        .to_string()
    }

    #[test]
    fn limits_are_always_hard_bounded() {
        let limits = ReplayLimits {
            max_turns: usize::MAX,
            max_events: usize::MAX,
            max_ipc_bytes: usize::MAX,
        }
        .bounded();
        assert_eq!(limits.max_turns, HARD_MAX_TURNS);
        assert_eq!(limits.max_events, HARD_MAX_EVENTS);
        assert_eq!(limits.max_ipc_bytes, HARD_MAX_IPC_BYTES);
    }

    #[test]
    fn compact_only_fields_are_explicit_for_compatibility_serializers() {
        for key in [
            "_replayTruncated",
            "_preview",
            crate::development_artifact::REPLAY_GIT_ARTIFACTS_FIELD,
        ] {
            assert!(is_compact_only_replay_field(key), "{key}");
        }
        assert!(!is_compact_only_replay_field("output"));
        assert!(!is_compact_only_replay_field("path"));
    }

    #[test]
    fn payload_encoding_is_explicit_on_new_wire_rows_and_inferred_only_for_legacy_rows() {
        let legacy_root: ReplayPayloadDescriptor = serde_json::from_value(serde_json::json!({
            "fieldPath":"args",
            "kind":"tool_arguments",
            "spans":[],
            "totalBytes":12
        }))
        .expect("legacy root descriptor");
        let legacy_nested: ReplayPayloadDescriptor = serde_json::from_value(serde_json::json!({
            "fieldPath":"result.content.0.text",
            "kind":"assistant_content",
            "spans":[],
            "totalBytes":12
        }))
        .expect("legacy nested descriptor");
        assert_eq!(
            legacy_root.resolved_encoding(),
            ReplayPayloadEncoding::JsonValue
        );
        assert_eq!(
            legacy_nested.resolved_encoding(),
            ReplayPayloadEncoding::Utf8Text
        );

        let descriptor = ReplayPayloadDescriptor {
            field_path: "args".to_string(),
            kind: ReplayPayloadKind::ToolArguments,
            encoding: ReplayPayloadEncoding::JsonValue,
            body_projection: Some(ReplayPayloadBodyProjection {
                field_path: "args.command".to_string(),
                text: "cargo test".to_string(),
                truncated: false,
            }),
            spans: Vec::new(),
            total_bytes: 12,
            source_ordinal: None,
            source_key: None,
        };
        let wire = serde_json::to_value(descriptor).expect("descriptor wire JSON");
        assert_eq!(wire["encoding"], "json_value");
        assert_eq!(wire["bodyProjection"]["fieldPath"], "args.command");
        assert_eq!(wire["bodyProjection"]["text"], "cargo test");
    }

    #[test]
    fn root_body_projection_uses_semantic_priority_and_utf8_byte_limit() {
        let value = serde_json::json!({
            "description":"lower-priority",
            "command":format!("BEGIN{}END", "你".repeat(20))
        });
        let projection = replay_payload_body_projection("args", &value, None, 20, false)
            .expect("semantic body projection");
        assert_eq!(projection.field_path, "args.command");
        assert!(projection.text.starts_with("BEGIN"));
        assert!(projection.text.len() <= 20);
        assert!(projection.truncated);
        assert!(std::str::from_utf8(projection.text.as_bytes()).is_ok());
    }

    #[test]
    fn lifecycle_source_binding_preserves_existing_catalog_metadata() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory replay DB");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        let source_session_id = "rollout-2026-07-22T00-00-00-fixture";
        let session_id = format!("codexapp-{source_session_id}");
        let source_path = std::env::temp_dir().join(format!(
            "orgii-replay-binding-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::write(&source_path, b"{}\n").expect("write replay source");
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path,name,input_tokens,listable
             ) VALUES('codex_app',?1,?2,'/stale/path','curated title',42,1)",
            rusqlite::params![source_session_id, session_id],
        )
        .expect("insert catalog metadata");

        bind_source_path(
            &conn,
            ImportedHistorySourceId::CodexApp,
            source_session_id,
            &session_id,
            &source_path,
        )
        .expect("bind lifecycle source");

        let (bound_path, title, input_tokens, listable): (String, String, i64, i64) = conn
            .query_row(
                "SELECT source_path,name,input_tokens,listable
                   FROM imported_history_session_cache
                  WHERE source='codex_app' AND source_session_id=?1",
                [source_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read rebound catalog row");
        assert_eq!(
            std::path::PathBuf::from(bound_path),
            source_path.canonicalize().expect("canonical source")
        );
        assert_eq!(title, "curated title");
        assert_eq!(input_tokens, 42);
        assert_eq!(listable, 1);

        let mismatch = bind_source_path(
            &conn,
            ImportedHistorySourceId::CodexApp,
            "different-source-key",
            &session_id,
            &source_path,
        )
        .expect_err("source identity mismatch");
        assert!(mismatch.contains("Replay source identity mismatch"));
        let _ = std::fs::remove_file(source_path);
    }

    #[test]
    fn every_registered_adapter_is_incremental() {
        for source in ImportedHistorySourceId::ALL {
            ensure_supported(source).expect("all 15 imported sources have bounded replay");
        }
    }

    #[test]
    fn codex_append_is_incremental_and_partial_tail_is_retried() {
        use std::io::Write;

        let (mut conn, path, session_id) = codex_fixture();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"hello"}))
            ),
        )
        .expect("initial JSONL");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open bounded replay");
        assert_eq!(opened.chunks.len(), 1);
        let cursor = opened.cursor;

        let partial = jsonl(serde_json::json!({
            "type":"agent_message",
            "message":"arrives only after newline"
        }));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append fixture");
        file.write_all(partial.as_bytes()).expect("partial record");
        file.flush().expect("flush partial");
        let partial_delta = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &cursor,
            ReplayLimits::default(),
        )
        .expect("poll partial tail");
        assert!(partial_delta.chunks.is_empty());
        assert_eq!(partial_delta.stats.parsed_bytes, 0);
        assert_eq!(partial_delta.cursor.revision, cursor.revision);

        file.write_all(b"\n").expect("finish record");
        file.flush().expect("flush newline");
        drop(file);
        let completed_delta = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &cursor,
            ReplayLimits::default(),
        )
        .expect("poll completed record");
        assert_eq!(completed_delta.chunks.len(), 1);
        assert!(completed_delta.stats.parsed_bytes > 0);
        assert_eq!(
            completed_delta.chunks[0].chunk.function,
            super::super::FUNCTION_ASSISTANT
        );
        let mut unchanged_cursor = completed_delta.cursor;
        for poll in 0..20 {
            let unchanged = poll_delta(
                &mut conn,
                ImportedHistorySourceId::CodexApp,
                &session_id,
                &unchanged_cursor,
                ReplayLimits::default(),
            )
            .unwrap_or_else(|error| panic!("unchanged poll {poll} failed: {error}"));
            assert!(unchanged.chunks.is_empty(), "unchanged poll {poll}");
            assert_eq!(
                unchanged.stats,
                ReplayStats::default(),
                "unchanged poll {poll} must parse, normalize, upsert, and send nothing"
            );
            unchanged_cursor = unchanged.cursor;
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unchanged_integrity_sample_refreshes_the_sixty_second_watermark() {
        let (mut conn, path, session_id) = codex_fixture();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"hello"}))
            ),
        )
        .expect("initial JSONL");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open bounded replay");

        conn.execute(
            "UPDATE imported_replay_state SET updated_at='1970-01-01T00:00:00Z'
             WHERE source='codex_app' AND source_session_id='replay-fixture'",
            [],
        )
        .expect("expire integrity watermark");
        index::take_file_sample_count();
        let before_touch = chrono::Utc::now().timestamp_millis();
        let sampled = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("integrity poll");
        assert_eq!(sampled.stats, ReplayStats::default());
        assert_eq!(index::take_file_sample_count(), 1);
        let touched = index::load_state(&conn, ImportedHistorySourceId::CodexApp, "replay-fixture")
            .expect("load touched replay state")
            .expect("touched replay state");
        assert!(touched.state_updated_at_ms >= before_touch);

        let fast = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &sampled.cursor,
            ReplayLimits::default(),
        )
        .expect("metadata-only poll");
        assert_eq!(fast.stats, ReplayStats::default());
        assert_eq!(
            index::take_file_sample_count(),
            0,
            "the refreshed watermark must prevent another full integrity sample"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn codex_same_inode_growing_rewrite_resets_generation() {
        let (mut conn, path, session_id) = codex_fixture();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"old"}))
            ),
        )
        .expect("initial JSONL");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open initial generation");

        // `fs::write` truncates and rewrites the existing inode.  Make the
        // replacement longer than the previous complete-line cursor so size
        // metadata alone would look exactly like an append.
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({
                    "type":"user_message",
                    "message":"replacement-is-deliberately-longer-than-old"
                }))
            ),
        )
        .expect("same-inode growing rewrite");
        let delta = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("poll rewritten source");
        assert!(delta.reset_required);
        assert_ne!(delta.cursor.generation, opened.cursor.generation);
        let replacement = serde_json::to_string(
            &delta
                .chunks
                .iter()
                .map(|chunk| &chunk.chunk)
                .collect::<Vec<_>>(),
        )
        .expect("replacement chunks");
        assert!(replacement.contains("replacement-is-deliberately-longer-than-old"));
        assert!(!replacement.contains("\"old\""));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn codex_delta_honors_max_turns_across_many_new_turns() {
        use std::io::Write;

        let (mut conn, path, session_id) = codex_fixture();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"seed"}))
            ),
        )
        .expect("seed JSONL");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open seed");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append turns");
        for turn in 0..11 {
            writeln!(
                file,
                "{}",
                jsonl(serde_json::json!({
                    "type":"user_message",
                    "message":format!("turn-{turn}")
                }))
            )
            .expect("append turn");
        }
        drop(file);
        let limits = ReplayLimits {
            max_turns: 10,
            max_events: 200,
            max_ipc_bytes: HARD_MAX_IPC_BYTES,
        };
        let first = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor,
            limits,
        )
        .expect("first bounded delta");
        assert_eq!(
            first
                .chunks
                .iter()
                .map(|chunk| chunk.turn_index)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            10
        );
        let second = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &first.cursor,
            limits,
        )
        .expect("remaining turn delta");
        assert_eq!(
            second
                .chunks
                .iter()
                .map(|chunk| chunk.turn_index)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            1
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn codex_large_body_is_source_backed_and_range_bounded() {
        let (mut conn, path, session_id) = codex_fixture();
        let large = format!("BEGIN-{}-END", "你".repeat(10_000));
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"hello"})),
                jsonl(serde_json::json!({"type":"agent_message","message":large.clone()})),
            ),
        )
        .expect("large JSONL");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open bounded replay");
        let assistant = opened
            .chunks
            .iter()
            .find(|chunk| chunk.chunk.function == super::super::FUNCTION_ASSISTANT)
            .expect("assistant event");
        assert!(serde_json::to_vec(&assistant.chunk).unwrap().len() < 16 * 1024);
        assert_eq!(assistant.payloads.len(), 1);

        let mut reconstructed = String::new();
        let mut offset = 0_u64;
        loop {
            let range = read_payload_range(
                &mut conn,
                ImportedHistorySourceId::CodexApp,
                &session_id,
                &opened.cursor.generation,
                &assistant.chunk.chunk_id,
                "result.content",
                offset,
                Some(1024),
            )
            .expect("read source-backed payload range");
            assert!(range.text.len() <= 1024);
            reconstructed.push_str(&range.text);
            offset = range.next_offset;
            if range.eof {
                break;
            }
        }
        assert_eq!(reconstructed, large);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn compact_ipc_budget_counts_payload_descriptors_and_fails_closed() {
        let (mut conn, path, session_id) = codex_fixture();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({
                    "type":"agent_message",
                    "message":"x".repeat(20_000)
                }))
            ),
        )
        .expect("descriptor fixture");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open descriptor fixture");
        assert_eq!(opened.chunks.len(), 1);
        let chunk_only = serde_json::to_vec(&opened.chunks[0].chunk)
            .expect("serialize chunk")
            .len();
        let descriptors = serde_json::to_vec(&opened.chunks[0].payloads)
            .expect("serialize descriptors")
            .len();
        assert!(descriptors > 0);

        let error = read_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            None,
            ReplayLimits {
                max_turns: 1,
                max_events: 200,
                max_ipc_bytes: chunk_only,
            },
        )
        .expect_err("descriptor bytes must not bypass the compact limit");
        assert!(error.contains("compact window budget"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn codex_ten_mib_shell_payload_is_materialized_once_and_generation_scoped() {
        fn hash_text(text: &str) -> u64 {
            text.as_bytes()
                .iter()
                .fold(0xcbf29ce484222325_u64, |hash, byte| {
                    (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
                })
        }

        fn transcript(output: &str) -> String {
            format!(
                "{}\n{}\n{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"run it"})),
                jsonl(serde_json::json!({
                    "type":"function_call",
                    "name":"shell_command",
                    "arguments":"{\"command\":\"printf payload\"}",
                    "call_id":"call-large-output"
                })),
                jsonl(serde_json::json!({
                    "type":"function_call_output",
                    "call_id":"call-large-output",
                    "output":output
                })),
            )
        }

        let (mut conn, path, session_id) = codex_fixture();
        let old_output = format!("OLD:{}:END", "A".repeat(10 * 1024 * 1024));
        std::fs::write(&path, transcript(&old_output)).expect("10 MiB Codex transcript");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("index 10 MiB Codex transcript");
        assert_eq!(opened.stats.parsed_rows, 3);
        let shell = opened
            .chunks
            .iter()
            .find(|chunk| chunk.chunk.function == super::super::FUNCTION_RUN_COMMAND_LINE)
            .expect("Codex Shell event");
        let artifact_count = conn
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source='codex_app' AND generation=?1",
                [&opened.cursor.generation],
                |row| row.get::<_, i64>(0),
            )
            .expect("Codex artifact count");
        assert_eq!(artifact_count, 1);

        codex_jsonl::reset_payload_fallback_decodes();
        let mut reconstructed = String::with_capacity(old_output.len());
        let mut offset = 0_u64;
        loop {
            let range = read_payload_range(
                &mut conn,
                ImportedHistorySourceId::CodexApp,
                &session_id,
                &opened.cursor.generation,
                &shell.chunk.chunk_id,
                "result.output",
                offset,
                Some(HARD_MAX_PAYLOAD_RANGE_BYTES),
            )
            .expect("read Codex Shell artifact page");
            assert!(range.text.len() <= HARD_MAX_PAYLOAD_RANGE_BYTES);
            assert!(range.next_offset > offset || range.eof);
            reconstructed.push_str(&range.text);
            offset = range.next_offset;
            if range.eof {
                break;
            }
        }
        assert_eq!(hash_text(&reconstructed), hash_text(&old_output));
        assert_eq!(reconstructed.len(), old_output.len());
        assert_eq!(codex_jsonl::payload_fallback_decodes(), 0);

        let new_output = format!("NEW:{}:END", "B".repeat(10 * 1024 * 1024));
        assert_eq!(new_output.len(), old_output.len());
        std::fs::write(&path, transcript(&new_output)).expect("same-size replacement");
        let replaced = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("replace Codex generation");
        assert!(replaced.reset_required);
        assert_ne!(replaced.cursor.generation, opened.cursor.generation);
        let replacement_shell = replaced
            .chunks
            .iter()
            .find(|chunk| chunk.chunk.function == super::super::FUNCTION_RUN_COMMAND_LINE)
            .expect("replacement Shell event");
        let replacement = read_payload_range(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &replaced.cursor.generation,
            &replacement_shell.chunk.chunk_id,
            "result.output",
            0,
            Some(64),
        )
        .expect("replacement artifact page");
        assert!(replacement.text.starts_with("NEW:BBBB"));
        assert_eq!(codex_jsonl::payload_fallback_decodes(), 0);
        let generations = conn
            .query_row(
                "SELECT COUNT(DISTINCT generation) FROM imported_replay_payload_artifacts
                 WHERE source='codex_app'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("live artifact generations");
        assert_eq!(generations, 1, "replaced generation artifacts are retired");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pinned_generation_scan_rejects_a_mixed_snapshot() {
        let (mut conn, path, session_id) = codex_fixture();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                jsonl(serde_json::json!({"type":"user_message","message":"pinned"}))
            ),
        )
        .expect("pinned scan fixture");
        let opened = open_window(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open pinned generation");
        let error = scan_window_after_generation(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            "another-generation",
            opened.cursor.revision,
            -1,
            ReplayLimits::default(),
        )
        .expect_err("derived snapshots must not mix generations");
        assert!(error.contains("expected another-generation"));
        let error = scan_window_after_generation(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor.generation,
            opened.cursor.revision.saturating_add(1),
            -1,
            ReplayLimits::default(),
        )
        .expect_err("derived snapshots must not mix revisions");
        assert!(error.contains(&format!("@{}", opened.cursor.revision.saturating_add(1))));
        let pinned = scan_window_after_generation(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor.generation,
            opened.cursor.revision,
            -1,
            ReplayLimits::default(),
        )
        .expect("scan pinned generation");
        assert_eq!(pinned.cursor.generation, opened.cursor.generation);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pinned_scan_preparation_restarts_only_twice() {
        let attempts = std::cell::Cell::new(0usize);
        let error = retry_pinned_scan_preparation("codexapp-changing", || {
            attempts.set(attempts.get().saturating_add(1));
            Ok(None)
        })
        .expect_err("continuously changing source must stop");
        assert_eq!(attempts.get(), MAX_PINNED_SCAN_RESTARTS + 1);
        assert!(error.contains("kept changing"));
        assert!(error.contains("after 2 restarts"));
    }
}
