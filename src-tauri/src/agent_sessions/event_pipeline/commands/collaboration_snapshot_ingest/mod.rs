//! Byte-bounded Cloud collaboration snapshot ingestion.
//!
//! The renderer passes opaque compressed physical rows, never a complete
//! `SessionEvent[]`. Rows are verified and folded into a token-scoped staging
//! SQLite file. Publishing is a single `sessions.db` transaction, so a
//! malformed page, cancellation, process crash, or failed commit leaves the
//! previous imported snapshot visible.

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Utc;
use flate2::read::GzDecoder;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent_sessions::event_pipeline::commands::event_conversion::{
    cached_event_to_session_event, session_event_to_cached_event,
};
use crate::agent_sessions::event_pipeline::types::SessionEvent;

use super::replay_cloud_wire::{
    decode_replay_attachment_v2_frame, ReplayAttachmentV2FrameHeader,
    CLOUD_PAGE_MAX_BYTES as MAX_PAGE_BYTES, CLOUD_PAGE_MAX_SEGMENTS as MAX_PAGE_SEGMENTS,
    CLOUD_SEGMENT_WIRE_MAX_BYTES as MAX_WIRE_BYTES,
    LEGACY_V1_MAX_DECOMPRESSED_BYTES as MAX_DECOMPRESSED_V1_BYTES,
    REPLAY_ATTACHMENT_V2_MAGIC as FRAME_MAGIC,
    REPLAY_ATTACHMENT_V2_MAX_DECOMPRESSED_BYTES as MAX_DECOMPRESSED_V2_BYTES,
};
#[cfg(test)]
use super::replay_cloud_wire::{
    encode_replay_attachment_v2_frame, REPLAY_ATTACHMENT_CHUNK_BYTES as ATTACHMENT_CHUNK_BYTES,
};

const IMPORTED_SESSION_PREFIX: &str = "imported-session-";
const AGENT_SESSION_PREFIX: &str = "agentsession-";
const COPY_ID_DELIMITER: &str = "~";
const STAGING_DIR_NAME: &str = "collaboration-snapshot-staging";
const STAGING_VERSION: i64 = 1;
const STAGING_STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const HASH_HEX_BYTES: usize = 64;
const HANDOFF_MAX_ITEMS: usize = 80;
const HANDOFF_MAX_ITEM_UTF16: usize = 1_200;
const HANDOFF_SCAN_BYTES: usize = 4 * 1024 * 1024;
const HANDOFF_FIELD_PREVIEW_BYTES: i64 = 8 * 1024;
const HANDOFF_FIELD_PREVIEW_CHARS: i64 = 2 * 1024;
const SNAPSHOT_INVALIDATION_TRIGGER_COUNT: i64 = 6;
const SNAPSHOT_INDEX_COUNT: i64 = 2;
const SECONDARY_MUTATION_TRIGGERS_SQL: &str =
    "CREATE TABLE IF NOT EXISTS collaboration_snapshot_secondary_state (
       session_id TEXT PRIMARY KEY,
       generation INTEGER NOT NULL DEFAULT 0,
       revision INTEGER NOT NULL DEFAULT 0,
       reset_revision INTEGER NOT NULL DEFAULT 0,
       max_sequence INTEGER NOT NULL DEFAULT -1,
       event_count INTEGER NOT NULL DEFAULT 0
     );
     CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_native_events_insert_touch
       AFTER INSERT ON events
       WHEN NEW.session_id GLOB 'agentsession-*'
       BEGIN
         UPDATE collaboration_snapshot_secondary_state
         SET revision=revision+1,
             reset_revision=CASE
               WHEN NEW.history_sequence IS NULL
                 OR NEW.history_sequence<=max_sequence
               THEN revision+1 ELSE reset_revision END,
             max_sequence=CASE
               WHEN NEW.history_sequence IS NULL THEN max_sequence
               ELSE MAX(max_sequence,NEW.history_sequence) END,
             event_count=event_count+1
         WHERE session_id=NEW.session_id;
       END;
     CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_native_events_delete_touch
       AFTER DELETE ON events
       WHEN OLD.session_id GLOB 'agentsession-*'
       BEGIN
         UPDATE collaboration_snapshot_secondary_state
         SET revision=revision+1,
             reset_revision=revision+1,
             max_sequence=COALESCE((
               SELECT history_sequence FROM events
               WHERE session_id=OLD.session_id AND history_sequence IS NOT NULL
               ORDER BY history_sequence DESC LIMIT 1
             ),-1),
             event_count=MAX(event_count-1,0)
         WHERE session_id=OLD.session_id;
       END;
     CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_native_events_update_touch
       AFTER UPDATE ON events
       WHEN OLD.session_id GLOB 'agentsession-*'
         OR NEW.session_id GLOB 'agentsession-*'
       BEGIN
         UPDATE collaboration_snapshot_secondary_state
         SET revision=revision+1,
             reset_revision=revision+1,
             max_sequence=COALESCE((
               SELECT history_sequence FROM events
               WHERE session_id=OLD.session_id AND history_sequence IS NOT NULL
               ORDER BY history_sequence DESC LIMIT 1
             ),-1),
             event_count=MAX(
               event_count-CASE WHEN NEW.session_id!=OLD.session_id THEN 1 ELSE 0 END,
               0
             )
         WHERE session_id=OLD.session_id;
         UPDATE collaboration_snapshot_secondary_state
         SET revision=revision+1,
             reset_revision=revision+1,
             max_sequence=COALESCE((
               SELECT history_sequence FROM events
               WHERE session_id=NEW.session_id AND history_sequence IS NOT NULL
               ORDER BY history_sequence DESC LIMIT 1
             ),-1),
             event_count=event_count+1
         WHERE session_id=NEW.session_id AND NEW.session_id!=OLD.session_id;
       END;";
const DROP_SECONDARY_MUTATION_TRIGGERS_SQL: &str =
    "DROP TRIGGER IF EXISTS collaboration_snapshot_native_events_insert_touch;
     DROP TRIGGER IF EXISTS collaboration_snapshot_native_events_delete_touch;
     DROP TRIGGER IF EXISTS collaboration_snapshot_native_events_update_touch;";
const DELETE_TAIL_EVENTS_SQL: &str = "DELETE FROM events WHERE id IN (
       SELECT event_id FROM collaboration_snapshot_event_map
       WHERE session_id=?1 AND is_tail=1
     )";
const DELETE_TAIL_MAP_SQL: &str =
    "DELETE FROM collaboration_snapshot_event_map WHERE session_id=?1 AND is_tail=1";
const PUBLISH_REPLAY_ACCOUNTING_SQL: &str = "INSERT INTO collaboration_replay_state(
       session_id,generation,revision,max_sequence,event_count
     ) VALUES(?1,0,?2,?3,?2)
     ON CONFLICT(session_id) DO UPDATE SET
       generation=collaboration_replay_state.generation+1,
       revision=collaboration_replay_state.revision+1,
       max_sequence=excluded.max_sequence,
       event_count=excluded.event_count";
const CURSOR_SENTINEL_SQL: &str = "SELECT
       EXISTS(
         SELECT 1
         FROM collaboration_snapshot_event_map m
              INDEXED BY idx_collaboration_snapshot_event_order
         JOIN events e ON e.id=m.event_id
         WHERE m.session_id=?1 AND m.logical_index=0 AND e.session_id=?1
       ),
       EXISTS(
         SELECT 1
         FROM collaboration_snapshot_event_map m
              INDEXED BY idx_collaboration_snapshot_event_order
         JOIN events e ON e.id=m.event_id
         WHERE m.session_id=?1 AND m.logical_index=?2 AND e.session_id=?1
       )";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotCursor {
    pub epoch: i64,
    pub frozen_seq: u64,
    pub count: u64,
    pub frozen_count: u64,
    pub tail_hash: Option<String>,
}

#[derive(Debug, Clone)]
struct CollaborationSnapshotSessionMetadata {
    time_range_start: Option<String>,
    time_range_end: Option<String>,
}

/// Constant-space state for secondary consumers of a Cloud-created native
/// fork. This is deliberately separate from imported-session replay state:
/// its presence never opts the native SessionCore open/send path into replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CollaborationSnapshotSecondaryState {
    pub generation: String,
    pub revision: u64,
    pub reset_revision: u64,
    pub max_sequence: i64,
    pub event_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestBeginRequest {
    pub local_session_id: String,
    pub epoch: i64,
    pub expected_count: u64,
    pub expected_frozen_seq: u64,
    pub tail_hash: Option<String>,
    pub replace: bool,
    #[serde(default)]
    pub previous: Option<CollaborationSnapshotCursor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestBeginResult {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "direction", rename_all = "lowercase")]
pub enum CollaborationSnapshotWireCursor {
    Forward {
        #[serde(rename = "afterSeq")]
        after_seq: u64,
        #[serde(rename = "throughSeq", default)]
        through_seq: Option<u64>,
    },
    Backward {
        #[serde(rename = "beforeSeq", default)]
        before_seq: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotWire {
    pub seq: u64,
    pub payload_gz: String,
    pub event_count: u64,
    pub segment_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestPageRequest {
    pub token: String,
    pub epoch: i64,
    pub frozen_seq: u64,
    pub count: u64,
    pub tail_hash: Option<String>,
    pub cursor: CollaborationSnapshotWireCursor,
    #[serde(default)]
    pub next_cursor: Option<CollaborationSnapshotWireCursor>,
    pub tail_included: bool,
    pub has_more: bool,
    pub returned_wire_bytes: u64,
    pub segments: Vec<CollaborationSnapshotWire>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestProgress {
    pub accepted_physical_rows: u64,
    pub accepted_logical_events: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestTokenRequest {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestGetCursorRequest {
    pub local_session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotSecondaryProbeRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSnapshotIngestCommitResult {
    pub local_session_id: String,
    pub epoch: i64,
    pub frozen_seq: u64,
    pub event_count: u64,
    pub frozen_event_count: u64,
    pub tail_hash: Option<String>,
    pub handoff_items: Vec<String>,
    pub handoff_scanned_bytes: u64,
    pub handoff_scanned_events: u64,
}

mod publish;
mod schema;
mod staging;
mod wire;

#[tauri::command]
pub async fn collaboration_snapshot_ingest_begin(
    request: CollaborationSnapshotIngestBeginRequest,
) -> Result<CollaborationSnapshotIngestBeginResult, String> {
    staging::collaboration_snapshot_ingest_begin_impl(request).await
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_apply_wire_page(
    request: CollaborationSnapshotIngestPageRequest,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    wire::collaboration_snapshot_ingest_apply_wire_page_impl(request).await
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_get_cursor(
    request: CollaborationSnapshotIngestGetCursorRequest,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    schema::collaboration_snapshot_ingest_get_cursor_impl(request).await
}

#[tauri::command]
pub async fn collaboration_snapshot_secondary_probe(
    request: CollaborationSnapshotSecondaryProbeRequest,
) -> Result<bool, String> {
    schema::collaboration_snapshot_secondary_probe_impl(request).await
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_commit(
    request: CollaborationSnapshotIngestTokenRequest,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    publish::collaboration_snapshot_ingest_commit_impl(request).await
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_abort(
    request: CollaborationSnapshotIngestTokenRequest,
) -> Result<(), String> {
    staging::collaboration_snapshot_ingest_abort_impl(request).await
}

pub(super) use schema::collaboration_snapshot_secondary_state;
#[cfg(test)]
pub(super) use schema::install_snapshot_schema_for_test;
pub(crate) use schema::is_snapshot_backed_native_fork;

#[cfg(test)]
mod tests;
