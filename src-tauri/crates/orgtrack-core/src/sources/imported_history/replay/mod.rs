//! Storage-agnostic bounded replay for imported CLI histories.
//!
//! The public API exposes source-neutral generations, revisions and sequence
//! cursors.  Driver positions (JSONL byte offsets, SQLite keys, whole-JSON
//! generations) stay private and are persisted in ORGII-owned compact index
//! tables.  No API in this module falls back to a provider's full-history
//! loader.

mod cache_policy;
#[cfg(test)]
mod conformance_tests;
mod drivers;
mod index;
mod metadata_projection;
mod model;
mod payload_artifact;
#[cfg(test)]
mod perf_tests;
pub mod registry;

use drivers::jsonl::{self as jsonl_driver, codex as codex_jsonl, qoder_sidecar};
use drivers::sqlite as sqlite_driver;
use drivers::structured as structured_driver;
use drivers::whole_json as whole_json_driver;

use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};

pub use cache_policy::{
    prune_cache, ReplayCacheEviction, ReplayCacheEvictionReason, ReplayCachePolicy,
    ReplayCachePruneReport, DEFAULT_REPLAY_CACHE_MAX_BYTES, DEFAULT_REPLAY_CACHE_PROTECT_RECENT,
    DEFAULT_REPLAY_CACHE_TARGET_BYTES, DEFAULT_REPLAY_CACHE_TTL,
};
pub use model::*;
pub use registry::{
    ImportedHistorySourceId, ImportedReplayDescriptor, ReplayAdapterSupport, ReplayStorageFamily,
};

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

/// Read the newest bounded window from an already-published compact index.
///
/// This is an explicitly stale-tolerant read for secondary consumers that do
/// not own source synchronization. Visible UI opens must call [`open_window`]
/// on a short-lived foreground connection so a provider append is reflected
/// immediately. A cache miss remains explicit.
pub fn open_cached_window(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<Option<ReplayChunkWindow>, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    let resolved = index::resolve_source(conn, source, session_id)?;
    if index::load_state(conn, source, &resolved.source_session_id)?.is_none() {
        return Ok(None);
    }
    index::read_recent_window(conn, source, session_id, limits.bounded()).map(Some)
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

/// Read a bounded older window from the last atomically published generation.
///
/// Cursor IDE and Windsurf cold indexes intentionally omit older turn bodies,
/// so their foreground pager must retain the synchronized hydration path.
pub fn read_cached_window(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    before_sequence: Option<i64>,
    limits: ReplayLimits,
) -> Result<Option<ReplayChunkWindow>, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return Ok(None);
    }
    let resolved = index::resolve_source(conn, source, session_id)?;
    if index::load_state(conn, source, &resolved.source_session_id)?.is_none() {
        return Ok(None);
    }
    index::read_window_before(conn, source, session_id, before_sequence, limits.bounded()).map(Some)
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

/// Read one already-materialized turn without synchronizing the provider.
pub fn read_cached_turn_window(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    turn_id: &str,
    limits: ReplayLimits,
) -> Result<Option<ReplayChunkWindow>, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return Ok(None);
    }
    let resolved = index::resolve_source(conn, source, session_id)?;
    if index::load_state(conn, source, &resolved.source_session_id)?.is_none() {
        return Ok(None);
    }
    index::read_window_for_turn(conn, source, session_id, turn_id, limits.bounded()).map(Some)
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

/// Read one already-materialized turn index without synchronizing the provider.
pub fn read_cached_turn_window_at_index(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    turn_index: i64,
    limits: ReplayLimits,
) -> Result<Option<ReplayChunkWindow>, String> {
    source.validate_session_id(session_id)?;
    ensure_supported(source)?;
    if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return Ok(None);
    }
    let resolved = index::resolve_source(conn, source, session_id)?;
    if index::load_state(conn, source, &resolved.source_session_id)?.is_none() {
        return Ok(None);
    }
    index::read_window_for_turn_index(conn, source, session_id, turn_index, limits.bounded())
        .map(Some)
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

/// Project compact metadata without synchronizing the provider or taking a
/// write transaction. Most adapters read only ORGII's published index;
/// Cursor/Windsurf additionally perform bounded, exact user-bubble lookups
/// against their read-only KV store. `None` means no compact index exists yet.
pub fn project_cached_turn_metadata(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    requested_turn_ids: Option<&[String]>,
) -> Result<Option<Vec<crate::projectors::turn_metadata::ProjectedTurnMetadata>>, String> {
    ensure_supported(source)?;
    metadata_projection::project_cached_turn_metadata(conn, source, session_id, requested_turn_ids)
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

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
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
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
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
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
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
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
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
#[path = "tests/facade.rs"]
mod tests;
