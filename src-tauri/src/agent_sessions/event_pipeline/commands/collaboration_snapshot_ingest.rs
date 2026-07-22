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

const IMPORTED_SESSION_PREFIX: &str = "imported-session-";
const AGENT_SESSION_PREFIX: &str = "agentsession-";
const COPY_ID_DELIMITER: &str = "~";
const STAGING_DIR_NAME: &str = "collaboration-snapshot-staging";
const STAGING_VERSION: i64 = 1;
const STAGING_STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_WIRE_BYTES: usize = 256 * 1024;
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAGE_SEGMENTS: usize = 200;
const MAX_DECOMPRESSED_V1_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_V2_BYTES: u64 = 512 * 1024;
const FRAME_MAGIC: &[u8] = b"ORGII-REPLAY-ATTACHMENT-V2\0";
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

#[derive(Debug, Clone)]
struct StagingManifest {
    token: String,
    local_session_id: String,
    epoch: i64,
    expected_count: u64,
    expected_frozen_seq: u64,
    expected_tail_hash: Option<String>,
    replace: bool,
    previous: Option<CollaborationSnapshotCursor>,
    page_count: u64,
    next_cursor_json: Option<String>,
    page_chain_complete: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentFrameHeader {
    kind: String,
    attachment_id: String,
    part_index: u64,
    chunk_offset: u64,
    chunk_bytes: u64,
    final_part: bool,
    #[serde(default)]
    event_bytes: Option<u64>,
    #[serde(default)]
    attachment_hash: Option<String>,
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid_prefix = [IMPORTED_SESSION_PREFIX, AGENT_SESSION_PREFIX]
        .into_iter()
        .find(|prefix| session_id.starts_with(prefix) && session_id.len() > prefix.len());
    if valid_prefix.is_some() && !session_id.contains(['/', '\\']) {
        return Ok(());
    }
    Err(format!(
        "collaboration snapshot target must start with {IMPORTED_SESSION_PREFIX} or {AGENT_SESSION_PREFIX}"
    ))
}

fn is_imported_snapshot_session(session_id: &str) -> bool {
    session_id.starts_with(IMPORTED_SESSION_PREFIX)
}

fn validate_hash(label: &str, hash: &str) -> Result<(), String> {
    if hash.len() == HASH_HEX_BYTES && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{label} must be a 64-character SHA-256 hex digest"))
    }
}

fn namespace_copy_id(local_session_id: &str, original_id: &str) -> String {
    let prefix = format!("{local_session_id}{COPY_ID_DELIMITER}");
    if original_id.starts_with(&prefix) {
        original_id.to_string()
    } else {
        format!("{prefix}{original_id}")
    }
}

fn normalize_event(
    mut event: SessionEvent,
    local_session_id: &str,
) -> Result<SessionEvent, String> {
    if event.id.is_empty() {
        return Err("collaboration snapshot event id cannot be empty".to_string());
    }
    event.id = namespace_copy_id(local_session_id, &event.id);
    event.chunk_id = event
        .chunk_id
        .take()
        .map(|id| namespace_copy_id(local_session_id, &id));
    event.session_id = local_session_id.to_string();
    Ok(event)
}

fn staging_root() -> Result<PathBuf, String> {
    let db = app_paths::sessions_db();
    let parent = db
        .parent()
        .ok_or_else(|| "sessions.db has no parent directory".to_string())?;
    Ok(parent.join(STAGING_DIR_NAME))
}

fn validate_token(token: &str) -> Result<Uuid, String> {
    let parsed = Uuid::parse_str(token).map_err(|_| "invalid snapshot ingest token".to_string())?;
    if parsed.to_string() != token {
        return Err("snapshot ingest token is not canonical".to_string());
    }
    Ok(parsed)
}

fn staging_path(root: &Path, token: &str) -> Result<PathBuf, String> {
    validate_token(token)?;
    Ok(root.join(format!("{token}.sqlite")))
}

fn remove_staging_files(path: &Path) {
    let _ = fs::remove_file(path);
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let _ = fs::remove_file(PathBuf::from(wal));
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    let _ = fs::remove_file(PathBuf::from(shm));
}

fn remove_token_temp_files(root: &Path, token: &str) {
    let prefix = format!("{token}-");
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn cleanup_stale_staging(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("create snapshot staging dir: {error}"))?;
    let now = SystemTime::now();
    let entries =
        fs::read_dir(root).map_err(|error| format!("read snapshot staging dir: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_sqlite = path.extension().and_then(|value| value.to_str()) == Some("sqlite");
        let is_temp = path.extension().and_then(|value| value.to_str()) == Some("tmp");
        let modified = entry.metadata().and_then(|meta| meta.modified());
        let is_stale = modified
            .ok()
            .and_then(|value| now.duration_since(value).ok())
            .is_some_and(|age| age >= STAGING_STALE_AFTER);
        if is_temp && is_stale {
            let _ = fs::remove_file(path);
        } else if is_sqlite && is_stale {
            if let Some(token) = path.file_stem().and_then(|value| value.to_str()) {
                remove_token_temp_files(root, token);
            }
            remove_staging_files(&path);
        }
    }
    Ok(())
}

fn configure_staging_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         PRAGMA temp_store=FILE;
         CREATE TABLE IF NOT EXISTS manifest (
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           version INTEGER NOT NULL,
           token TEXT NOT NULL,
           local_session_id TEXT NOT NULL,
           epoch INTEGER NOT NULL,
           expected_count INTEGER NOT NULL,
           expected_frozen_seq INTEGER NOT NULL,
           expected_tail_hash TEXT,
           replace_snapshot INTEGER NOT NULL,
           previous_json TEXT,
           page_count INTEGER NOT NULL DEFAULT 0,
           next_cursor_json TEXT,
           page_chain_complete INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS staged_wires (
           seq INTEGER PRIMARY KEY,
           segment_hash TEXT NOT NULL,
           event_count INTEGER NOT NULL,
           is_tail INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS staged_events (
           normalized_id TEXT PRIMARY KEY,
           original_id TEXT NOT NULL,
           physical_seq INTEGER NOT NULL,
           event_index INTEGER NOT NULL,
           is_tail INTEGER NOT NULL,
           event_type TEXT NOT NULL,
           function_name TEXT,
           thread_id TEXT,
           args_json TEXT NOT NULL,
           result_json TEXT NOT NULL,
           content TEXT NOT NULL,
           created_at TEXT NOT NULL,
           meta_json TEXT
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_events_order
           ON staged_events(is_tail, physical_seq, event_index);
         CREATE TABLE IF NOT EXISTS attachment_parts (
           attachment_id TEXT NOT NULL,
           part_index INTEGER NOT NULL,
           physical_seq INTEGER NOT NULL UNIQUE,
           chunk_offset INTEGER NOT NULL,
           chunk BLOB NOT NULL,
           final_part INTEGER NOT NULL,
           event_bytes INTEGER,
           attachment_hash TEXT,
           PRIMARY KEY(attachment_id,part_index)
         );",
    )
    .map_err(|error| format!("initialize snapshot staging database: {error}"))?;
    Ok(())
}

fn open_staging(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err("snapshot ingest token is missing or expired".to_string());
    }
    let conn =
        Connection::open(path).map_err(|error| format!("open snapshot staging db: {error}"))?;
    configure_staging_connection(&conn)?;
    Ok(conn)
}

fn load_manifest(conn: &Connection) -> Result<StagingManifest, String> {
    conn.query_row(
        "SELECT token,local_session_id,epoch,expected_count,expected_frozen_seq,
                expected_tail_hash,replace_snapshot,previous_json,page_count,
                next_cursor_json,page_chain_complete
         FROM manifest WHERE singleton=1 AND version=?1",
        [STAGING_VERSION],
        |row| {
            let previous_json: Option<String> = row.get(7)?;
            let previous = previous_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(StagingManifest {
                token: row.get(0)?,
                local_session_id: row.get(1)?,
                epoch: row.get(2)?,
                expected_count: row.get::<_, i64>(3)?.max(0) as u64,
                expected_frozen_seq: row.get::<_, i64>(4)?.max(0) as u64,
                expected_tail_hash: row.get(5)?,
                replace: row.get::<_, i64>(6)? != 0,
                previous,
                page_count: row.get::<_, i64>(8)?.max(0) as u64,
                next_cursor_json: row.get(9)?,
                page_chain_complete: row.get::<_, i64>(10)? != 0,
            })
        },
    )
    .map_err(|error| format!("read snapshot staging manifest: {error}"))
}

fn begin_at_root(
    root: &Path,
    request: CollaborationSnapshotIngestBeginRequest,
) -> Result<CollaborationSnapshotIngestBeginResult, String> {
    validate_session_id(&request.local_session_id)?;
    if request.epoch < 0 {
        return Err("snapshot epoch must be non-negative".to_string());
    }
    if let Some(hash) = request.tail_hash.as_deref() {
        validate_hash("tailHash", hash)?;
    }
    if !request.replace && request.previous.is_none() {
        return Err("incremental snapshot ingest requires a previous cursor".to_string());
    }
    if request.local_session_id.starts_with(AGENT_SESSION_PREFIX)
        && (!request.replace || request.previous.is_some())
    {
        return Err(
            "native fork snapshot ingest must be an unconditional full replacement".to_string(),
        );
    }
    if let Some(previous) = request.previous.as_ref() {
        if previous.epoch < 0 {
            return Err("previous snapshot epoch must be non-negative".to_string());
        }
        if let Some(hash) = previous.tail_hash.as_deref() {
            validate_hash("previous.tailHash", hash)?;
        }
        if !request.replace && previous.epoch != request.epoch {
            return Err("incremental snapshot ingest cannot change epoch".to_string());
        }
        if !request.replace && previous.frozen_seq > request.expected_frozen_seq {
            return Err("incremental snapshot frozen sequence moved backwards".to_string());
        }
    }

    cleanup_stale_staging(root)?;
    let token = Uuid::new_v4().to_string();
    let path = staging_path(root, &token)?;
    let conn =
        Connection::open(&path).map_err(|error| format!("create snapshot staging db: {error}"))?;
    configure_staging_connection(&conn)?;
    let previous_json = request
        .previous
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("serialize previous snapshot cursor: {error}"))?;
    conn.execute(
        "INSERT INTO manifest(
           singleton,version,token,local_session_id,epoch,expected_count,
           expected_frozen_seq,expected_tail_hash,replace_snapshot,previous_json
         ) VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            STAGING_VERSION,
            token,
            request.local_session_id,
            request.epoch,
            i64::try_from(request.expected_count).map_err(|_| "expectedCount is too large")?,
            i64::try_from(request.expected_frozen_seq)
                .map_err(|_| "expectedFrozenSeq is too large")?,
            request.tail_hash,
            request.replace,
            previous_json,
        ],
    )
    .map_err(|error| format!("write snapshot staging manifest: {error}"))?;
    Ok(CollaborationSnapshotIngestBeginResult { token })
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_begin(
    request: CollaborationSnapshotIngestBeginRequest,
) -> Result<CollaborationSnapshotIngestBeginResult, String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || begin_at_root(&root, request))
        .await
        .map_err(|error| error.to_string())?
}

struct DecodedWireFile {
    path: PathBuf,
    bytes: u64,
    hash: String,
    is_v2: bool,
}

struct TempFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(mut self) -> PathBuf {
        self.armed = false;
        self.path.clone()
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Drop for DecodedWireFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn decode_wire_to_file(
    root: &Path,
    token: &str,
    wire: &CollaborationSnapshotWire,
) -> Result<DecodedWireFile, String> {
    validate_hash("segmentHash", &wire.segment_hash)?;
    let compressed = BASE64_STANDARD
        .decode(&wire.payload_gz)
        .map_err(|error| format!("segment {} has invalid base64: {error}", wire.seq))?;
    let temp_path = root.join(format!("{token}-wire-{}-{}.tmp", wire.seq, Uuid::new_v4()));
    let temp_guard = TempFileGuard::new(temp_path.clone());
    let file = File::create(&temp_path)
        .map_err(|error| format!("create decoded wire staging file: {error}"))?;
    let mut output = BufWriter::with_capacity(64 * 1024, file);
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut prefix = Vec::with_capacity(FRAME_MAGIC.len());
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = decoder
            .read(&mut buffer)
            .map_err(|error| format!("gunzip segment {}: {error}", wire.seq))?;
        if read == 0 {
            break;
        }
        if prefix.len() < FRAME_MAGIC.len() {
            let remaining = FRAME_MAGIC.len() - prefix.len();
            prefix.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "decoded segment byte count overflow".to_string())?;
        // Before the magic is known, use the V1 ceiling. Once the prefix is
        // complete, V2's much smaller physical-frame ceiling applies.
        let is_v2 = prefix.len() == FRAME_MAGIC.len() && prefix == FRAME_MAGIC;
        let limit = if is_v2 {
            MAX_DECOMPRESSED_V2_BYTES
        } else {
            MAX_DECOMPRESSED_V1_BYTES
        };
        if total > limit {
            return Err(format!(
                "decoded segment {} exceeds the {} byte limit",
                wire.seq, limit
            ));
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("stage decoded segment {}: {error}", wire.seq))?;
    }
    output
        .flush()
        .map_err(|error| format!("flush decoded segment {}: {error}", wire.seq))?;
    let hash = format!("{:x}", hasher.finalize());
    if hash != wire.segment_hash.to_ascii_lowercase() {
        return Err(format!("segment {} content hash mismatch", wire.seq));
    }
    Ok(DecodedWireFile {
        path: temp_guard.disarm(),
        bytes: total,
        hash,
        is_v2: prefix == FRAME_MAGIC,
    })
}

fn stage_cached_event(
    tx: &Transaction<'_>,
    event: SessionEvent,
    local_session_id: &str,
    physical_seq: u64,
    event_index: u64,
    is_tail: bool,
) -> Result<(), String> {
    let original_id = event.id.clone();
    let normalized = normalize_event(event, local_session_id)?;
    let cached = session_event_to_cached_event(&normalized);
    tx.execute(
        "INSERT INTO staged_events(
           normalized_id,original_id,physical_seq,event_index,is_tail,event_type,
           function_name,thread_id,args_json,result_json,content,created_at,meta_json
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            cached.id,
            original_id,
            i64::try_from(physical_seq).map_err(|_| "physical sequence is too large")?,
            i64::try_from(event_index).map_err(|_| "event index is too large")?,
            is_tail,
            cached.event_type,
            cached.function_name,
            cached.thread_id,
            cached.args_json,
            cached.result_json,
            cached.content,
            cached.created_at,
            cached.meta_json,
        ],
    )
    .map_err(|error| format!("stage event {original_id}: {error}"))?;
    Ok(())
}

struct StreamingEventArrayVisitor<'a> {
    tx: &'a Transaction<'a>,
    local_session_id: &'a str,
    physical_seq: u64,
    is_tail: bool,
}

impl<'de> Visitor<'de> for StreamingEventArrayVisitor<'_> {
    type Value = u64;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a legacy replay SessionEvent array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut count = 0_u64;
        while let Some(event) = sequence.next_element::<SessionEvent>()? {
            stage_cached_event(
                self.tx,
                event,
                self.local_session_id,
                self.physical_seq,
                count,
                self.is_tail,
            )
            .map_err(serde::de::Error::custom)?;
            count += 1;
        }
        Ok(count)
    }
}

fn stage_v1_wire(
    tx: &Transaction<'_>,
    decoded: &DecodedWireFile,
    wire: &CollaborationSnapshotWire,
    local_session_id: &str,
) -> Result<(), String> {
    let file = File::open(&decoded.path)
        .map_err(|error| format!("open decoded segment {}: {error}", wire.seq))?;
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    let count = serde::Deserializer::deserialize_seq(
        &mut deserializer,
        StreamingEventArrayVisitor {
            tx,
            local_session_id,
            physical_seq: wire.seq,
            is_tail: wire.seq == 0,
        },
    )
    .map_err(|error| format!("decode legacy segment {}: {error}", wire.seq))?;
    deserializer
        .end()
        .map_err(|error| format!("legacy segment {} has trailing data: {error}", wire.seq))?;
    if count != wire.event_count {
        return Err(format!(
            "segment {} declared {} events but decoded {count}",
            wire.seq, wire.event_count
        ));
    }
    Ok(())
}

fn read_u32_be(bytes: &[u8]) -> Result<usize, String> {
    let array: [u8; 4] = bytes
        .try_into()
        .map_err(|_| "attachment header length is truncated".to_string())?;
    Ok(u32::from_be_bytes(array) as usize)
}

fn stage_v2_wire(
    tx: &Transaction<'_>,
    decoded: &DecodedWireFile,
    wire: &CollaborationSnapshotWire,
) -> Result<(), String> {
    if wire.seq == 0 {
        return Err("Replay Attachment V2 cannot be used for the mutable tail".to_string());
    }
    let bytes = fs::read(&decoded.path)
        .map_err(|error| format!("read attachment frame {}: {error}", wire.seq))?;
    let prefix_bytes = FRAME_MAGIC.len() + 4;
    if bytes.len() < prefix_bytes || !bytes.starts_with(FRAME_MAGIC) {
        return Err(format!("attachment frame {} has invalid magic", wire.seq));
    }
    let header_bytes = read_u32_be(&bytes[FRAME_MAGIC.len()..prefix_bytes])?;
    let payload_offset = prefix_bytes
        .checked_add(header_bytes)
        .ok_or_else(|| "attachment frame header length overflow".to_string())?;
    if header_bytes == 0 || payload_offset > bytes.len() {
        return Err(format!("attachment frame {} header is truncated", wire.seq));
    }
    let header: AttachmentFrameHeader =
        serde_json::from_slice(&bytes[prefix_bytes..payload_offset])
            .map_err(|error| format!("attachment frame {} header is invalid: {error}", wire.seq))?;
    if header.kind != "event" || header.attachment_id.is_empty() {
        return Err(format!(
            "attachment frame {} header kind/id is invalid",
            wire.seq
        ));
    }
    validate_hash("attachmentId", &header.attachment_id)?;
    let chunk = &bytes[payload_offset..];
    if header.chunk_bytes != chunk.len() as u64 {
        return Err(format!(
            "attachment frame {} chunk length mismatch",
            wire.seq
        ));
    }
    if wire.event_count != u64::from(header.final_part) {
        return Err(format!(
            "attachment frame {} eventCount is inconsistent",
            wire.seq
        ));
    }
    match (
        header.final_part,
        header.event_bytes,
        header.attachment_hash.as_deref(),
    ) {
        (false, None, None) => {}
        (true, Some(event_bytes), Some(hash)) => {
            validate_hash("attachmentHash", hash)?;
            if header
                .chunk_offset
                .checked_add(header.chunk_bytes)
                .is_none_or(|end| end != event_bytes)
            {
                return Err(format!(
                    "attachment frame {} final length mismatch",
                    wire.seq
                ));
            }
        }
        _ => {
            return Err(format!(
                "attachment frame {} final metadata is inconsistent",
                wire.seq
            ))
        }
    }
    tx.execute(
        "INSERT INTO attachment_parts(
           attachment_id,part_index,physical_seq,chunk_offset,chunk,final_part,
           event_bytes,attachment_hash
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            header.attachment_id,
            i64::try_from(header.part_index).map_err(|_| "attachment part index too large")?,
            i64::try_from(wire.seq).map_err(|_| "physical sequence too large")?,
            i64::try_from(header.chunk_offset).map_err(|_| "attachment offset too large")?,
            chunk,
            header.final_part,
            header
                .event_bytes
                .map(i64::try_from)
                .transpose()
                .map_err(|_| "attachment event size too large")?,
            header.attachment_hash,
        ],
    )
    .map_err(|error| format!("stage attachment frame {}: {error}", wire.seq))?;
    Ok(())
}

fn cursor_json(cursor: &CollaborationSnapshotWireCursor) -> Result<String, String> {
    serde_json::to_string(cursor).map_err(|error| format!("serialize wire cursor: {error}"))
}

fn validate_page_contract(
    manifest: &StagingManifest,
    request: &CollaborationSnapshotIngestPageRequest,
) -> Result<(), String> {
    if request.epoch != manifest.epoch
        || request.frozen_seq != manifest.expected_frozen_seq
        || request.count != manifest.expected_count
        || request.tail_hash != manifest.expected_tail_hash
    {
        return Err("wire page snapshot summary changed during ingestion".to_string());
    }
    if request.has_more != request.next_cursor.is_some() {
        return Err("wire page hasMore and nextCursor disagree".to_string());
    }
    if request.segments.len() > MAX_PAGE_SEGMENTS {
        return Err(format!(
            "wire page has {} rows (limit {MAX_PAGE_SEGMENTS})",
            request.segments.len()
        ));
    }
    let mut seen_sequences = std::collections::HashSet::new();
    let actual_wire_bytes = request.segments.iter().try_fold(0_usize, |total, wire| {
        if !seen_sequences.insert(wire.seq) {
            return Err(format!("wire page repeats physical seq {}", wire.seq));
        }
        let bytes = serde_json::to_vec(wire)
            .map_err(|error| format!("measure physical wire {}: {error}", wire.seq))?
            .len();
        if bytes > MAX_WIRE_BYTES {
            return Err(format!(
                "physical wire {} is {bytes} bytes (limit {MAX_WIRE_BYTES})",
                wire.seq
            ));
        }
        total
            .checked_add(bytes)
            .ok_or_else(|| "wire page byte count overflow".to_string())
    })?;
    if actual_wire_bytes > MAX_PAGE_BYTES || request.returned_wire_bytes != actual_wire_bytes as u64
    {
        return Err(format!(
            "wire page byte count is {actual_wire_bytes}, reported {} (limit {MAX_PAGE_BYTES})",
            request.returned_wire_bytes
        ));
    }
    if manifest.page_count > 0 {
        let expected = manifest
            .next_cursor_json
            .as_deref()
            .ok_or_else(|| "wire page chain was already complete".to_string())?;
        if cursor_json(&request.cursor)? != expected {
            return Err("wire page cursor does not continue the prior page".to_string());
        }
    }
    match &request.cursor {
        CollaborationSnapshotWireCursor::Forward {
            after_seq,
            through_seq,
        } => {
            if through_seq.is_some_and(|through| through != manifest.expected_frozen_seq) {
                return Err("forward wire cursor changed the frozen high-water mark".to_string());
            }
            for wire in request.segments.iter().filter(|wire| wire.seq > 0) {
                if wire.seq <= *after_seq || through_seq.is_some_and(|through| wire.seq > through) {
                    return Err(format!(
                        "forward page row {} is outside its cursor",
                        wire.seq
                    ));
                }
            }
        }
        CollaborationSnapshotWireCursor::Backward { before_seq } => {
            for wire in request.segments.iter().filter(|wire| wire.seq > 0) {
                if before_seq.is_some_and(|before| wire.seq >= before) {
                    return Err(format!(
                        "backward page row {} is outside its cursor",
                        wire.seq
                    ));
                }
            }
        }
    }
    if request.tail_included != request.segments.iter().any(|wire| wire.seq == 0) {
        return Err("wire page tailIncluded does not match seq 0 presence".to_string());
    }
    if request.tail_included && manifest.expected_tail_hash.is_none() {
        return Err("wire page returned an unpinned mutable tail".to_string());
    }
    if let Some(tail) = request.segments.iter().find(|wire| wire.seq == 0) {
        if Some(tail.segment_hash.as_str()) != manifest.expected_tail_hash.as_deref() {
            return Err("wire page mutable tail hash mismatch".to_string());
        }
    }
    if let Some(next) = request.next_cursor.as_ref() {
        if std::mem::discriminant(next) != std::mem::discriminant(&request.cursor) {
            return Err("wire page continuation changes direction".to_string());
        }
    }
    let mut frozen_sequences = request
        .segments
        .iter()
        .filter_map(|wire| (wire.seq > 0).then_some(wire.seq))
        .collect::<Vec<_>>();
    frozen_sequences.sort_unstable();
    match (&request.cursor, request.next_cursor.as_ref()) {
        (
            CollaborationSnapshotWireCursor::Forward { .. },
            Some(CollaborationSnapshotWireCursor::Forward {
                after_seq,
                through_seq,
            }),
        ) => {
            if frozen_sequences.last().copied() != Some(*after_seq)
                || *through_seq != Some(manifest.expected_frozen_seq)
            {
                return Err(
                    "forward page continuation does not advance to its last row".to_string()
                );
            }
        }
        (
            CollaborationSnapshotWireCursor::Backward { .. },
            Some(CollaborationSnapshotWireCursor::Backward { before_seq }),
        ) => {
            if frozen_sequences.first().copied() != *before_seq {
                return Err(
                    "backward page continuation does not continue before its first row".to_string(),
                );
            }
        }
        (_, None) => {}
        _ => return Err("wire page continuation changes direction".to_string()),
    }
    Ok(())
}

fn page_progress(
    conn: &Connection,
    complete: bool,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    let (rows, events): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(event_count),0) FROM staged_wires",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("read snapshot ingest progress: {error}"))?;
    Ok(CollaborationSnapshotIngestProgress {
        accepted_physical_rows: rows.max(0) as u64,
        accepted_logical_events: events.max(0) as u64,
        complete,
    })
}

fn apply_page_at_root(
    root: &Path,
    request: CollaborationSnapshotIngestPageRequest,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    let path = staging_path(root, &request.token)?;
    let mut conn = open_staging(&path)?;
    let manifest = load_manifest(&conn)?;
    if manifest.token != request.token {
        return Err("snapshot ingest token does not match its manifest".to_string());
    }
    validate_page_contract(&manifest, &request)?;

    let page_cursor_json = cursor_json(&request.cursor)?;
    let next_cursor_json = request.next_cursor.as_ref().map(cursor_json).transpose()?;
    let page_hash = sha256_hex(
        &serde_json::to_vec(&request.segments)
            .map_err(|error| format!("hash wire page: {error}"))?,
    );
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS staged_pages(
           cursor_json TEXT PRIMARY KEY,
           page_hash TEXT NOT NULL,
           next_cursor_json TEXT,
           complete INTEGER NOT NULL
         );",
    )
    .map_err(|error| format!("initialize snapshot page receipts: {error}"))?;
    let prior_page: Option<(String, Option<String>, bool)> = conn
        .query_row(
            "SELECT page_hash,next_cursor_json,complete FROM staged_pages WHERE cursor_json=?1",
            [&page_cursor_json],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
        )
        .optional()
        .map_err(|error| format!("read snapshot page receipt: {error}"))?;
    if let Some((prior_hash, prior_next, prior_complete)) = prior_page {
        if prior_hash != page_hash
            || prior_next != next_cursor_json
            || prior_complete == request.has_more
        {
            return Err("wire page retry differs from the accepted page".to_string());
        }
        return page_progress(&conn, !request.has_more);
    }

    let tx = conn
        .transaction()
        .map_err(|error| format!("begin snapshot page transaction: {error}"))?;
    for wire in &request.segments {
        let prior: Option<(String, i64)> = tx
            .query_row(
                "SELECT segment_hash,event_count FROM staged_wires WHERE seq=?1",
                [i64::try_from(wire.seq).map_err(|_| "physical sequence is too large")?],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read staged physical row {}: {error}", wire.seq))?;
        if let Some((hash, count)) = prior {
            if hash == wire.segment_hash && count == wire.event_count as i64 {
                continue;
            }
            return Err(format!(
                "physical row {} changed during ingestion",
                wire.seq
            ));
        }
        let decoded = decode_wire_to_file(root, &request.token, wire)?;
        if decoded.hash != wire.segment_hash.to_ascii_lowercase() || decoded.bytes == 0 {
            return Err(format!(
                "physical row {} decoded to invalid content",
                wire.seq
            ));
        }
        if decoded.is_v2 {
            stage_v2_wire(&tx, &decoded, wire)?;
        } else {
            stage_v1_wire(&tx, &decoded, wire, &manifest.local_session_id)?;
        }
        tx.execute(
            "INSERT INTO staged_wires(seq,segment_hash,event_count,is_tail)
             VALUES(?1,?2,?3,?4)",
            params![
                i64::try_from(wire.seq).map_err(|_| "physical sequence is too large")?,
                wire.segment_hash.to_ascii_lowercase(),
                i64::try_from(wire.event_count).map_err(|_| "event count is too large")?,
                wire.seq == 0,
            ],
        )
        .map_err(|error| format!("record physical row {}: {error}", wire.seq))?;
    }
    tx.execute(
        "INSERT INTO staged_pages(cursor_json,page_hash,next_cursor_json,complete)
         VALUES(?1,?2,?3,?4)",
        params![
            page_cursor_json,
            page_hash,
            next_cursor_json,
            !request.has_more,
        ],
    )
    .map_err(|error| format!("record accepted wire page: {error}"))?;
    tx.execute(
        "UPDATE manifest SET page_count=page_count+1,next_cursor_json=?1,
                             page_chain_complete=?2 WHERE singleton=1",
        params![next_cursor_json, !request.has_more],
    )
    .map_err(|error| format!("advance snapshot wire cursor: {error}"))?;
    tx.commit()
        .map_err(|error| format!("commit snapshot wire page: {error}"))?;
    page_progress(&conn, !request.has_more)
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_apply_wire_page(
    request: CollaborationSnapshotIngestPageRequest,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || apply_page_at_root(&root, request))
        .await
        .map_err(|error| error.to_string())?
}

fn finalize_one_attachment(
    tx: &Transaction<'_>,
    root: &Path,
    token: &str,
    local_session_id: &str,
    attachment_id: &str,
) -> Result<(), String> {
    let event_path = root.join(format!("{token}-event-{}.tmp", Uuid::new_v4()));
    let _event_guard = TempFileGuard::new(event_path.clone());
    let event_file = File::create(&event_path)
        .map_err(|error| format!("create attachment event staging file: {error}"))?;
    let mut output = BufWriter::with_capacity(64 * 1024, event_file);
    let mut hasher = Sha256::new();
    let mut expected_part = 0_i64;
    let mut expected_offset = 0_i64;
    let mut final_metadata: Option<(i64, String, i64)> = None;
    {
        let mut statement = tx
            .prepare(
                "SELECT part_index,physical_seq,chunk_offset,chunk,final_part,
                        event_bytes,attachment_hash
                 FROM attachment_parts WHERE attachment_id=?1 ORDER BY part_index ASC",
            )
            .map_err(|error| format!("prepare attachment {attachment_id}: {error}"))?;
        let mut rows = statement
            .query([attachment_id])
            .map_err(|error| format!("query attachment {attachment_id}: {error}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("read attachment {attachment_id}: {error}"))?
        {
            let part_index: i64 = row.get(0).map_err(|error| error.to_string())?;
            let physical_seq: i64 = row.get(1).map_err(|error| error.to_string())?;
            let offset: i64 = row.get(2).map_err(|error| error.to_string())?;
            let chunk: Vec<u8> = row.get(3).map_err(|error| error.to_string())?;
            let final_part = row.get::<_, i64>(4).map_err(|error| error.to_string())? != 0;
            let event_bytes: Option<i64> = row.get(5).map_err(|error| error.to_string())?;
            let attachment_hash: Option<String> = row.get(6).map_err(|error| error.to_string())?;
            if part_index != expected_part || offset != expected_offset {
                return Err(format!(
                    "attachment {attachment_id} has missing or reordered parts"
                ));
            }
            if final_metadata.is_some() {
                return Err(format!(
                    "attachment {attachment_id} has data after its final part"
                ));
            }
            output
                .write_all(&chunk)
                .map_err(|error| format!("write attachment {attachment_id}: {error}"))?;
            hasher.update(&chunk);
            expected_part += 1;
            expected_offset = expected_offset
                .checked_add(chunk.len() as i64)
                .ok_or_else(|| "attachment byte count overflow".to_string())?;
            if final_part {
                let size = event_bytes
                    .ok_or_else(|| format!("attachment {attachment_id} final size is missing"))?;
                let hash = attachment_hash
                    .ok_or_else(|| format!("attachment {attachment_id} final hash is missing"))?;
                final_metadata = Some((size, hash, physical_seq));
            } else if event_bytes.is_some() || attachment_hash.is_some() {
                return Err(format!(
                    "attachment {attachment_id} has premature final metadata"
                ));
            }
        }
    }
    output
        .flush()
        .map_err(|error| format!("flush attachment {attachment_id}: {error}"))?;
    drop(output);
    let result = (|| {
        let (event_bytes, expected_hash, physical_seq) = final_metadata
            .ok_or_else(|| format!("attachment {attachment_id} is missing its final part"))?;
        if event_bytes != expected_offset {
            return Err(format!("attachment {attachment_id} total size mismatch"));
        }
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != expected_hash.to_ascii_lowercase() {
            return Err(format!(
                "attachment {attachment_id} complete event hash mismatch"
            ));
        }
        let file = File::open(&event_path)
            .map_err(|error| format!("open assembled attachment {attachment_id}: {error}"))?;
        let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
        let event = SessionEvent::deserialize(&mut deserializer)
            .map_err(|error| format!("parse attachment {attachment_id} event: {error}"))?;
        deserializer.end().map_err(|error| {
            format!("attachment {attachment_id} event has trailing data: {error}")
        })?;
        stage_cached_event(tx, event, local_session_id, physical_seq as u64, 0, false)?;
        tx.execute(
            "DELETE FROM attachment_parts WHERE attachment_id=?1",
            [attachment_id],
        )
        .map_err(|error| format!("clear attachment {attachment_id} parts: {error}"))?;
        Ok(())
    })();
    result
}

fn finalize_attachments(
    conn: &mut Connection,
    root: &Path,
    manifest: &StagingManifest,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("begin attachment finalization: {error}"))?;
    loop {
        let attachment_id: Option<String> = tx
            .query_row(
                "SELECT attachment_id FROM attachment_parts ORDER BY physical_seq ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("find pending attachment: {error}"))?;
        let Some(attachment_id) = attachment_id else {
            break;
        };
        finalize_one_attachment(
            &tx,
            root,
            &manifest.token,
            &manifest.local_session_id,
            &attachment_id,
        )?;
    }
    tx.commit()
        .map_err(|error| format!("commit attachment finalization: {error}"))
}

fn validate_complete_staging(
    conn: &Connection,
    manifest: &StagingManifest,
) -> Result<(u64, u64), String> {
    if manifest.page_count == 0 || !manifest.page_chain_complete {
        return Err("snapshot wire page chain is incomplete".to_string());
    }
    let base_frozen_seq = if manifest.replace {
        0
    } else {
        manifest
            .previous
            .as_ref()
            .map_or(0, |cursor| cursor.frozen_seq)
    };
    let expected_physical = manifest
        .expected_frozen_seq
        .checked_sub(base_frozen_seq)
        .ok_or_else(|| "snapshot frozen sequence moved backwards".to_string())?;
    let (physical_count, min_seq, max_seq): (i64, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT COUNT(*),MIN(seq),MAX(seq) FROM staged_wires WHERE seq>0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("validate frozen physical rows: {error}"))?;
    if physical_count.max(0) as u64 != expected_physical
        || (expected_physical > 0
            && (min_seq != Some((base_frozen_seq + 1) as i64)
                || max_seq != Some(manifest.expected_frozen_seq as i64)))
    {
        return Err(format!(
            "snapshot frozen rows are incomplete: expected {}..={}, got count={} min={min_seq:?} max={max_seq:?}",
            base_frozen_seq + 1,
            manifest.expected_frozen_seq,
            physical_count
        ));
    }
    let has_tail: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM staged_wires WHERE seq=0)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("validate snapshot tail: {error}"))?
        != 0;
    if has_tail != manifest.expected_tail_hash.is_some() {
        return Err("snapshot mutable tail is incomplete".to_string());
    }
    let staged_logical: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(event_count),0) FROM staged_wires",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("count staged logical events: {error}"))?;
    let staged_events: i64 = conn
        .query_row("SELECT COUNT(*) FROM staged_events", [], |row| row.get(0))
        .map_err(|error| format!("count staged event rows: {error}"))?;
    if staged_events != staged_logical {
        return Err(format!(
            "snapshot decoded event count {staged_events} does not match physical rows {staged_logical}"
        ));
    }
    let base_frozen_count = if manifest.replace {
        0
    } else {
        manifest
            .previous
            .as_ref()
            .map_or(0, |cursor| cursor.frozen_count)
    };
    let final_count = base_frozen_count
        .checked_add(staged_logical.max(0) as u64)
        .ok_or_else(|| "snapshot logical event count overflow".to_string())?;
    if final_count != manifest.expected_count {
        return Err(format!(
            "snapshot logical count is {final_count}, expected {}",
            manifest.expected_count
        ));
    }
    let staged_frozen: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM staged_events WHERE is_tail=0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("count staged frozen events: {error}"))?;
    let final_frozen_count = base_frozen_count
        .checked_add(staged_frozen.max(0) as u64)
        .ok_or_else(|| "snapshot frozen event count overflow".to_string())?;
    Ok((final_count, final_frozen_count))
}

fn ensure_destination_schema(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS collaboration_snapshot_ingest_state (
           session_id TEXT PRIMARY KEY,
           epoch INTEGER NOT NULL,
           frozen_seq INTEGER NOT NULL,
           event_count INTEGER NOT NULL,
           frozen_event_count INTEGER NOT NULL,
           tail_hash TEXT,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS collaboration_snapshot_event_map (
           session_id TEXT NOT NULL,
           event_id TEXT NOT NULL,
           original_id TEXT NOT NULL,
           physical_seq INTEGER NOT NULL,
           event_index INTEGER NOT NULL,
           logical_index INTEGER NOT NULL,
           is_tail INTEGER NOT NULL,
           PRIMARY KEY(session_id,event_id)
         );
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_events_insert_invalidate
         AFTER INSERT ON events
         WHEN NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=NEW.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_events_delete_invalidate
         AFTER DELETE ON events
         WHEN OLD.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_events_update_invalidate
         AFTER UPDATE ON events
         WHEN OLD.session_id GLOB 'imported-session-*'
           OR NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id IN (OLD.session_id,NEW.session_id);
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_map_insert_invalidate
         AFTER INSERT ON collaboration_snapshot_event_map
         WHEN NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=NEW.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_map_delete_invalidate
         AFTER DELETE ON collaboration_snapshot_event_map
         WHEN OLD.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_map_update_invalidate
         AFTER UPDATE ON collaboration_snapshot_event_map
         WHEN OLD.session_id GLOB 'imported-session-*'
           OR NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id IN (OLD.session_id,NEW.session_id);
         END;",
    )
    .map_err(|error| format!("initialize collaboration snapshot destination schema: {error}"))?;
    ensure_secondary_mutation_triggers(tx)
}

fn ensure_secondary_mutation_triggers(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SECONDARY_MUTATION_TRIGGERS_SQL)
        .map_err(|error| format!("initialize native fork snapshot mutation tracking: {error}"))
}

fn drop_secondary_mutation_triggers(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(DROP_SECONDARY_MUTATION_TRIGGERS_SQL)
        .map_err(|error| format!("suspend native fork snapshot mutation tracking: {error}"))
}

fn create_destination_indexes(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_collaboration_snapshot_event_order
           ON collaboration_snapshot_event_map(session_id,logical_index);
         CREATE INDEX IF NOT EXISTS idx_collaboration_snapshot_event_tail
           ON collaboration_snapshot_event_map(session_id,is_tail,event_id);",
    )
    .map_err(|error| format!("initialize collaboration snapshot destination indexes: {error}"))
}

#[cfg(test)]
pub(super) fn install_snapshot_schema_for_test(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("begin collaboration snapshot test schema: {error}"))?;
    ensure_destination_schema(&tx)?;
    create_destination_indexes(&tx)?;
    tx.commit()
        .map_err(|error| format!("commit collaboration snapshot test schema: {error}"))
}

fn destination_indexes_are_installed(conn: &Connection) -> Result<bool, String> {
    let installed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
               'idx_collaboration_snapshot_event_order',
               'idx_collaboration_snapshot_event_tail'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect collaboration snapshot indexes: {error}"))?;
    Ok(installed == SNAPSHOT_INDEX_COUNT)
}

fn read_destination_cursor(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    let raw = conn
        .query_row(
            "SELECT epoch,frozen_seq,event_count,frozen_event_count,tail_hash
             FROM collaboration_snapshot_ingest_state WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read current collaboration snapshot cursor: {error}"))?;
    let Some((epoch, frozen_seq, count, frozen_count, tail_hash)) = raw else {
        return Ok(None);
    };
    if epoch < 0 || frozen_seq < 0 || count < 0 || frozen_count < 0 {
        return Err("current collaboration snapshot cursor contains negative values".to_string());
    }
    Ok(Some(CollaborationSnapshotCursor {
        epoch,
        frozen_seq: frozen_seq as u64,
        count: count as u64,
        frozen_count: frozen_count as u64,
        tail_hash,
    }))
}

fn destination_snapshot_has_sentinels(
    conn: &Connection,
    session_id: &str,
    event_count: u64,
) -> Result<bool, String> {
    if event_count == 0 {
        return Ok(true);
    }
    let last_index = i64::try_from(event_count - 1)
        .map_err(|_| "collaboration snapshot event count is too large".to_string())?;
    let (has_first, has_last): (i64, i64) = conn
        .query_row(
            CURSOR_SENTINEL_SQL,
            params![session_id, last_index],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("validate collaboration snapshot sentinels: {error}"))?;
    Ok(has_first == 1 && has_last == 1)
}

fn destination_snapshot_constant_time_metadata(
    conn: &Connection,
    session_id: &str,
    cursor: &CollaborationSnapshotCursor,
) -> Result<Option<CollaborationSnapshotSessionMetadata>, String> {
    let session_metadata = conn
        .query_row(
            "SELECT event_count,time_range_start,time_range_end
             FROM sessions WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read collaboration snapshot session metadata: {error}"))?;
    let Some((session_event_count, time_range_start, time_range_end)) = session_metadata else {
        return Ok(None);
    };
    if session_event_count < 0 || session_event_count as u64 != cursor.count {
        return Ok(None);
    }
    if !destination_snapshot_has_sentinels(conn, session_id, cursor.count)? {
        return Ok(None);
    }
    Ok(Some(CollaborationSnapshotSessionMetadata {
        time_range_start,
        time_range_end,
    }))
}

fn get_cursor_from_connection(
    conn: &Connection,
    local_session_id: &str,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    validate_session_id(local_session_id)?;
    if !is_imported_snapshot_session(local_session_id) {
        return Err(
            "only imported-session collaboration snapshots expose an ingest cursor".to_string(),
        );
    }
    let (required_tables, required_triggers, required_indexes): (i64, i64, i64) = conn
        .query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN type='table' AND name IN (
                 'collaboration_snapshot_ingest_state',
                 'collaboration_snapshot_event_map',
                 'events',
                 'sessions'
               ) THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN type='trigger' AND name IN (
                 'collaboration_snapshot_events_insert_invalidate',
                 'collaboration_snapshot_events_delete_invalidate',
                 'collaboration_snapshot_events_update_invalidate',
                 'collaboration_snapshot_map_insert_invalidate',
                 'collaboration_snapshot_map_delete_invalidate',
                 'collaboration_snapshot_map_update_invalidate'
               ) THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN type='index' AND name IN (
                 'idx_collaboration_snapshot_event_order',
                 'idx_collaboration_snapshot_event_tail'
               ) THEN 1 ELSE 0 END),0)
             FROM sqlite_master",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("inspect collaboration snapshot cursor schema: {error}"))?;
    if required_tables != 4
        || required_triggers != SNAPSHOT_INVALIDATION_TRIGGER_COUNT
        || required_indexes != SNAPSHOT_INDEX_COUNT
    {
        return Ok(None);
    }
    let cursor = match read_destination_cursor(conn, local_session_id) {
        Ok(Some(cursor)) => cursor,
        Ok(None) => return Ok(None),
        Err(_) => return Ok(None),
    };
    if cursor.epoch < 0
        || cursor.frozen_count > cursor.count
        || cursor
            .tail_hash
            .as_deref()
            .is_some_and(|hash| validate_hash("tailHash", hash).is_err())
    {
        return Ok(None);
    }
    match destination_snapshot_constant_time_metadata(conn, local_session_id, &cursor) {
        Ok(Some(_)) => Ok(Some(cursor)),
        Ok(None) | Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_get_cursor(
    request: CollaborationSnapshotIngestGetCursorRequest,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection()
            .map_err(|error| format!("open sessions.db for snapshot cursor: {error}"))?;
        get_cursor_from_connection(&conn, &request.local_session_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn has_snapshot_backed_native_fork(conn: &Connection, session_id: &str) -> Result<bool, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(false);
    }
    validate_session_id(session_id)?;
    if !destination_indexes_are_installed(conn)? {
        return Ok(false);
    }
    let Some(cursor) = read_destination_cursor(conn, session_id)? else {
        return Ok(false);
    };
    if cursor.frozen_count > cursor.count
        || cursor
            .tail_hash
            .as_deref()
            .is_some_and(|hash| validate_hash("tailHash", hash).is_err())
    {
        return Ok(false);
    }
    let session_event_count = conn
        .query_row(
            "SELECT event_count FROM sessions WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("read snapshot-backed fork metadata: {error}"))?;
    let Some(session_event_count) = session_event_count else {
        return Ok(false);
    };
    if session_event_count < 0 || (session_event_count as u64) < cursor.count {
        return Ok(false);
    }
    destination_snapshot_has_sentinels(conn, session_id, cursor.count)
}

fn has_native_snapshot_marker(conn: &Connection, session_id: &str) -> Result<bool, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(false);
    }
    validate_session_id(session_id)?;
    let state_table_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='collaboration_snapshot_ingest_state')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("inspect native fork snapshot marker schema: {error}"))?
        != 0;
    if !state_table_exists {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM collaboration_snapshot_ingest_state
         WHERE session_id=?1)",
        [session_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|error| format!("read native fork snapshot marker: {error}"))
}

/// Cheap crate-local origin check for background/native consumers.
///
/// The prefix guard avoids opening SQLite for OS/SDE ids that can never be a
/// Cloud-created Agent fork. This deliberately checks the persisted snapshot
/// marker, not full sentinel integrity: a damaged inherited prefix must still
/// fail closed instead of triggering a history-sized native turn rebuild.
pub(crate) fn is_snapshot_backed_native_fork(session_id: &str) -> Result<bool, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(false);
    }
    let conn = database::db::get_connection()
        .map_err(|error| format!("open sessions.db for native fork snapshot probe: {error}"))?;
    has_native_snapshot_marker(&conn, session_id)
}

/// Resolve a snapshot-backed native fork without scanning or materializing
/// its inherited history. The `events` table remains the canonical view, so
/// `event_count` and `max_sequence` include native events appended after the
/// inherited map frontier. Append advances only the wire revision; destructive
/// mutations advance `reset_revision`; a newly published inherited snapshot
/// advances the generation.
pub(super) fn collaboration_snapshot_secondary_state(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<CollaborationSnapshotSecondaryState>, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(None);
    }
    validate_session_id(session_id)?;
    ensure_secondary_mutation_triggers(conn)?;
    if !has_snapshot_backed_native_fork(conn, session_id)? {
        return Ok(None);
    }
    let cursor = read_destination_cursor(conn, session_id)?.ok_or_else(|| {
        "snapshot-backed native fork lost its ingest cursor after validation".to_string()
    })?;
    let session_event_count = conn
        .query_row(
            "SELECT event_count FROM sessions WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("read native fork secondary replay state: {error}"))?;
    if session_event_count < 0 {
        return Err("native fork secondary replay state contains negative values".to_string());
    }
    let mut mutation_state = conn
        .query_row(
            "SELECT generation,revision,reset_revision,max_sequence,event_count
             FROM collaboration_snapshot_secondary_state WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read native fork mutation cursor: {error}"))?;
    if mutation_state.is_none() {
        let max_sequence = conn
            .query_row(
                "SELECT history_sequence FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("seed native fork replay frontier: {error}"))?
            .unwrap_or(-1);
        conn.execute(
            "INSERT INTO collaboration_snapshot_secondary_state(
               session_id,generation,revision,reset_revision,max_sequence,event_count
             ) VALUES(?1,0,0,0,?2,?3)
             ON CONFLICT(session_id) DO NOTHING",
            params![session_id, max_sequence, session_event_count],
        )
        .map_err(|error| format!("seed native fork mutation cursor: {error}"))?;
        mutation_state = conn
            .query_row(
                "SELECT generation,revision,reset_revision,max_sequence,event_count
                 FROM collaboration_snapshot_secondary_state WHERE session_id=?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("reload native fork mutation cursor: {error}"))?;
    }
    let (
        mut secondary_generation,
        mut mutation_revision,
        mut reset_revision,
        mut max_sequence,
        tracked_event_count,
    ) = mutation_state.ok_or_else(|| "native fork mutation cursor is unavailable".to_string())?;
    if secondary_generation < 0
        || mutation_revision < 0
        || reset_revision < 0
        || tracked_event_count < 0
    {
        return Err("native fork mutation cursor contains negative values".to_string());
    }
    if tracked_event_count != session_event_count {
        max_sequence = conn
            .query_row(
                "SELECT history_sequence FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("repair native fork replay frontier: {error}"))?
            .unwrap_or(-1);
        secondary_generation = secondary_generation.saturating_add(1);
        mutation_revision = mutation_revision.saturating_add(1);
        reset_revision = mutation_revision;
        conn.execute(
            "UPDATE collaboration_snapshot_secondary_state
             SET generation=?2,revision=?3,reset_revision=?3,
                 max_sequence=?4,event_count=?5
             WHERE session_id=?1",
            params![
                session_id,
                secondary_generation,
                mutation_revision,
                max_sequence,
                session_event_count,
            ],
        )
        .map_err(|error| format!("repair native fork mutation cursor: {error}"))?;
    }
    let has_unsequenced = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM events
             WHERE session_id=?1 AND history_sequence IS NULL)",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("validate native fork replay sequences: {error}"))?
        != 0;
    if has_unsequenced {
        return Err("snapshot-backed native fork contains an unsequenced event".to_string());
    }
    let generation_material = format!(
        "v2|{}|{}|{}|{}|{}|{}",
        cursor.epoch,
        cursor.frozen_seq,
        cursor.count,
        cursor.frozen_count,
        cursor.tail_hash.as_deref().unwrap_or("-"),
        secondary_generation,
    );
    Ok(Some(CollaborationSnapshotSecondaryState {
        generation: format!(
            "collaboration-fork-v2-{}",
            sha256_hex(generation_material.as_bytes())
        ),
        revision: mutation_revision as u64,
        reset_revision: reset_revision as u64,
        max_sequence,
        event_count: session_event_count as u64,
    }))
}

/// Secondary-consumer capability probe for a Cloud-created native fork.
///
/// This does not opt the session into external replay for execution or the
/// SessionCore open path. It only proves that the immutable inherited prefix
/// still has its atomically published snapshot state and indexed sentinels.
#[tauri::command]
pub async fn collaboration_snapshot_secondary_probe(
    request: CollaborationSnapshotSecondaryProbeRequest,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection()
            .map_err(|error| format!("open sessions.db for fork snapshot probe: {error}"))?;
        has_snapshot_backed_native_fork(&conn, &request.session_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn drop_replay_accounting_triggers(tx: &Transaction<'_>) -> Result<(), String> {
    // A full replacement must not emit one generation/accounting mutation per
    // row. The ingest transaction publishes the exact aggregate state once
    // below; the next replay access reinstalls these
    // CREATE-IF-NOT-EXISTS triggers.
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS collaboration_replay_events_insert;
         DROP TRIGGER IF EXISTS collaboration_replay_events_delete;
         DROP TRIGGER IF EXISTS collaboration_replay_events_update_old;
         DROP TRIGGER IF EXISTS collaboration_replay_events_update_new;",
    )
    .map_err(|error| format!("suspend per-row collaboration replay accounting: {error}"))
}

fn publish_replay_accounting_state(
    tx: &Transaction<'_>,
    session_id: &str,
    event_count: i64,
    max_sequence: i64,
) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS collaboration_replay_state (
           session_id TEXT PRIMARY KEY,
           generation INTEGER NOT NULL DEFAULT 0,
           revision INTEGER NOT NULL DEFAULT 0,
           max_sequence INTEGER NOT NULL DEFAULT -1,
           event_count INTEGER NOT NULL DEFAULT 0
         );",
    )
    .map_err(|error| format!("initialize collaboration replay accounting state: {error}"))?;
    tx.execute(
        PUBLISH_REPLAY_ACCOUNTING_SQL,
        params![session_id, event_count, max_sequence],
    )
    .map_err(|error| format!("publish collaboration replay accounting state: {error}"))?;
    Ok(())
}

fn handoff_text_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Array(values) => {
            let mut joined = String::new();
            for text in values.iter().filter_map(handoff_text_value) {
                if !joined.is_empty() {
                    joined.push('\n');
                }
                joined.push_str(&text);
                if joined.encode_utf16().count() >= HANDOFF_MAX_ITEM_UTF16 {
                    break;
                }
            }
            (!joined.is_empty()).then_some(joined)
        }
        serde_json::Value::Object(object) => ["text", "content", "message", "output", "summary"]
            .into_iter()
            .find_map(|key| object.get(key).and_then(handoff_text_value)),
        _ => None,
    }
}

fn truncate_handoff_item(text: &str) -> String {
    if text.encode_utf16().count() <= HANDOFF_MAX_ITEM_UTF16 {
        return text.to_string();
    }
    let budget = HANDOFF_MAX_ITEM_UTF16.saturating_sub(1);
    let mut output = String::new();
    let mut units = 0_usize;
    for character in text.chars() {
        let next = units.saturating_add(character.len_utf16());
        if next > budget {
            break;
        }
        output.push(character);
        units = next;
    }
    output.push('…');
    output
}

fn handoff_item_from_event(event: &SessionEvent) -> Option<String> {
    let action_type = event.action_type.as_str();
    let function = event.function_name.as_str();
    if action_type.contains("thinking")
        || action_type.contains("reasoning")
        || matches!(function, "thinking" | "thinking_delta" | "reasoning")
    {
        return None;
    }
    let result = handoff_text_value(&event.result);
    let args = handoff_text_value(&event.args);
    let content = result.as_deref().or(args.as_deref()).or_else(|| {
        let text = event.display_text.trim();
        (!text.is_empty()).then_some(text)
    });
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
            "[Imported Collaboration Snapshot action]".to_string(),
            format!(
                "Tool: {}",
                if function.is_empty() {
                    "unknown_tool"
                } else {
                    function
                }
            ),
        ];
        if let Some(args) = args {
            lines.push(format!("Input: {args}"));
        }
        if let Some(result) = result {
            lines.push(format!("Result at that time: {result}"));
        }
        Some(lines.join("\n"))
    } else {
        content.map(|text| format!("Assistant context: {text}"))
    }?;
    Some(truncate_handoff_item(&item))
}

fn collect_published_handoff(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<(Vec<String>, u64, u64), String> {
    let mut statement = tx
        .prepare(
            "SELECT id,session_id,event_type,function_name,thread_id,
                    CASE WHEN length(CAST(args_json AS BLOB))<=?2
                         THEN args_json
                         WHEN json_valid(args_json) THEN json_object(
                           'content',substr(COALESCE(
                             json_extract(args_json,'$.content'),
                             json_extract(args_json,'$.text'),
                             json_extract(args_json,'$.message'),
                             json_extract(args_json,'$.command'),
                             json_extract(args_json,'$.path'),
                             json_extract(args_json,'$.description'),''
                           ),1,?3)
                         ) ELSE '{}' END,
                    CASE WHEN length(CAST(result_json AS BLOB))<=?2
                         THEN result_json
                         WHEN json_valid(result_json) THEN json_object(
                           'content',substr(COALESCE(
                             json_extract(result_json,'$.content'),
                             json_extract(result_json,'$.text'),
                             json_extract(result_json,'$.message'),
                             json_extract(result_json,'$.output'),
                             json_extract(result_json,'$.summary'),''
                           ),1,?3)
                         ) ELSE '{}' END,
                    '',created_at,
                    CASE WHEN length(CAST(meta_json AS BLOB))<=?2
                         THEN meta_json ELSE json_object(
                           'source',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.source') END,
                           'displayText',CASE WHEN json_valid(meta_json)
                             THEN substr(json_extract(meta_json,'$.displayText'),1,1200) END,
                           'displayStatus',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.displayStatus') END,
                           'displayVariant',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.displayVariant') END,
                           'activityStatus',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.activityStatus') END,
                           'uiCanonical',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.uiCanonical') END,
                           'chunk_id',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.chunk_id') END
                         ) END,
                    history_sequence,
                    MIN(COALESCE(length(CAST(args_json AS BLOB)),0),?2) +
                    MIN(COALESCE(length(CAST(result_json AS BLOB)),0),?2) +
                    MIN(COALESCE(length(CAST(meta_json AS BLOB)),0),?2) +
                    COALESCE(length(CAST(id AS BLOB)),0) +
                    COALESCE(length(CAST(event_type AS BLOB)),0) +
                    COALESCE(length(CAST(function_name AS BLOB)),0) +
                    COALESCE(length(CAST(created_at AS BLOB)),0)
             FROM events
             WHERE session_id=?1 AND history_sequence IS NOT NULL
             ORDER BY history_sequence DESC
             LIMIT 400",
        )
        .map_err(|error| format!("prepare collaboration handoff fold: {error}"))?;
    let mut rows = statement
        .query(params![
            session_id,
            HANDOFF_FIELD_PREVIEW_BYTES,
            HANDOFF_FIELD_PREVIEW_CHARS,
        ])
        .map_err(|error| format!("query collaboration handoff fold: {error}"))?;
    let mut remaining = HANDOFF_SCAN_BYTES;
    let mut scanned_bytes = 0_u64;
    let mut scanned_events = 0_u64;
    let mut newest_first = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read collaboration handoff row: {error}"))?
    {
        let row_bytes = row
            .get::<_, Option<i64>>(11)
            .map_err(|error| error.to_string())?
            .unwrap_or(0)
            .max(0) as usize;
        if row_bytes > remaining {
            break;
        }
        remaining -= row_bytes;
        scanned_bytes = scanned_bytes.saturating_add(row_bytes as u64);
        scanned_events = scanned_events.saturating_add(1);
        let cached = session_persistence::CachedEvent {
            id: row.get(0).map_err(|error| error.to_string())?,
            session_id: row.get(1).map_err(|error| error.to_string())?,
            event_type: row.get(2).map_err(|error| error.to_string())?,
            function_name: row.get(3).map_err(|error| error.to_string())?,
            thread_id: row.get(4).map_err(|error| error.to_string())?,
            args_json: row.get(5).map_err(|error| error.to_string())?,
            result_json: row.get(6).map_err(|error| error.to_string())?,
            content: row.get(7).map_err(|error| error.to_string())?,
            created_at: row.get(8).map_err(|error| error.to_string())?,
            meta_json: row.get(9).map_err(|error| error.to_string())?,
            history_sequence: row.get(10).map_err(|error| error.to_string())?,
        };
        let event = cached_event_to_session_event(&cached);
        if let Some(item) = handoff_item_from_event(&event) {
            newest_first.push(item);
            if newest_first.len() >= HANDOFF_MAX_ITEMS {
                break;
            }
        }
        if remaining == 0 {
            break;
        }
    }
    newest_first.reverse();
    Ok((newest_first, scanned_bytes, scanned_events))
}

fn extend_time_range(
    time_range_start: &mut Option<String>,
    time_range_end: &mut Option<String>,
    created_at: &str,
) {
    if time_range_start
        .as_deref()
        .is_none_or(|current| created_at < current)
    {
        *time_range_start = Some(created_at.to_string());
    }
    if time_range_end
        .as_deref()
        .is_none_or(|current| created_at > current)
    {
        *time_range_end = Some(created_at.to_string());
    }
}

fn publish_staged_snapshot(
    destination: &Connection,
    staging: &Connection,
    manifest: &StagingManifest,
    final_count: u64,
    final_frozen_count: u64,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    // Incremental publication may read destination state only through primary
    // keys or bounded/indexed sentinels. History-sized aggregation belongs on
    // the token-scoped staging DB, whose size is exactly the incoming delta.
    let tx = database::db::begin_immediate(destination)
        .map_err(|error| format!("begin collaboration snapshot publish: {error}"))?;
    ensure_destination_schema(&tx)?;
    let current = match read_destination_cursor(&tx, &manifest.local_session_id) {
        Ok(cursor) => cursor,
        Err(_) if manifest.replace && manifest.previous.is_none() => None,
        Err(error) => return Err(error),
    };
    if let Some(previous) = manifest.previous.as_ref() {
        if current.as_ref() != Some(previous) {
            return Err("local collaboration snapshot changed before commit".to_string());
        }
    } else if !manifest.replace {
        return Err("incremental collaboration snapshot has no prior cursor".to_string());
    }
    let previous_session_metadata = if !manifest.replace {
        if !destination_indexes_are_installed(&tx)? {
            return Err(
                "local collaboration snapshot indexes are missing; rebuild required".to_string(),
            );
        }
        let current_cursor = current.as_ref().ok_or_else(|| {
            "incremental collaboration snapshot has no published base".to_string()
        })?;
        Some(
            destination_snapshot_constant_time_metadata(
                &tx,
                &manifest.local_session_id,
                current_cursor,
            )?
            .ok_or_else(|| {
                "local collaboration snapshot base is incomplete; rebuild required".to_string()
            })?,
        )
    } else {
        None
    };

    let target_cursor = CollaborationSnapshotCursor {
        epoch: manifest.epoch,
        frozen_seq: manifest.expected_frozen_seq,
        count: final_count,
        frozen_count: final_frozen_count,
        tail_hash: manifest.expected_tail_hash.clone(),
    };
    if !manifest.replace && current.as_ref() == Some(&target_cursor) {
        let (handoff_items, handoff_scanned_bytes, handoff_scanned_events) =
            collect_published_handoff(&tx, &manifest.local_session_id)?;
        tx.commit()
            .map_err(|error| format!("finish unchanged collaboration snapshot: {error}"))?;
        return Ok(CollaborationSnapshotIngestCommitResult {
            local_session_id: manifest.local_session_id.clone(),
            epoch: target_cursor.epoch,
            frozen_seq: target_cursor.frozen_seq,
            event_count: target_cursor.count,
            frozen_event_count: target_cursor.frozen_count,
            tail_hash: target_cursor.tail_hash,
            handoff_items,
            handoff_scanned_bytes,
            handoff_scanned_events,
        });
    }

    let imported_snapshot = is_imported_snapshot_session(&manifest.local_session_id);
    let native_snapshot = manifest.local_session_id.starts_with(AGENT_SESSION_PREFIX);
    if imported_snapshot {
        drop_replay_accounting_triggers(&tx)?;
    }
    if native_snapshot {
        // Replacing a large fork must not issue one state UPDATE per inherited
        // event. Rollback restores the previous triggers on failure; success
        // reinstalls them after publishing the new aggregate state below.
        drop_secondary_mutation_triggers(&tx)?;
    }
    if manifest.replace {
        tx.execute(
            "DELETE FROM events WHERE session_id=?1",
            [&manifest.local_session_id],
        )
        .map_err(|error| format!("clear prior collaboration snapshot events: {error}"))?;
        tx.execute(
            "DELETE FROM collaboration_snapshot_event_map WHERE session_id=?1",
            [&manifest.local_session_id],
        )
        .map_err(|error| format!("clear prior collaboration snapshot event map: {error}"))?;
        create_destination_indexes(&tx)?;
    } else {
        tx.execute(DELETE_TAIL_EVENTS_SQL, [&manifest.local_session_id])
            .map_err(|error| format!("replace prior collaboration snapshot tail: {error}"))?;
        tx.execute(DELETE_TAIL_MAP_SQL, [&manifest.local_session_id])
            .map_err(|error| format!("clear prior collaboration snapshot tail map: {error}"))?;
    }

    let base_logical_index = if manifest.replace {
        0_i64
    } else {
        i64::try_from(
            manifest
                .previous
                .as_ref()
                .map_or(0, |value| value.frozen_count),
        )
        .map_err(|_| "previous frozen event count is too large")?
    };
    let (mut time_start, mut time_end) = previous_session_metadata
        .map(|metadata| (metadata.time_range_start, metadata.time_range_end))
        .unwrap_or_default();
    let mut statement = staging
        .prepare(
            "SELECT normalized_id,original_id,physical_seq,event_index,is_tail,event_type,
                    function_name,thread_id,args_json,result_json,content,created_at,meta_json
             FROM staged_events ORDER BY is_tail ASC,physical_seq ASC,event_index ASC",
        )
        .map_err(|error| format!("prepare staged collaboration events: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("query staged collaboration events: {error}"))?;
    let mut offset = 0_i64;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read staged collaboration event: {error}"))?
    {
        let event_id: String = row.get(0).map_err(|error| error.to_string())?;
        let original_id: String = row.get(1).map_err(|error| error.to_string())?;
        let physical_seq: i64 = row.get(2).map_err(|error| error.to_string())?;
        let event_index: i64 = row.get(3).map_err(|error| error.to_string())?;
        let is_tail: bool = row.get::<_, i64>(4).map_err(|error| error.to_string())? != 0;
        let logical_index = base_logical_index
            .checked_add(offset)
            .ok_or_else(|| "published logical event index overflow".to_string())?;
        let created_at: String = row.get(11).map_err(|error| error.to_string())?;
        extend_time_range(&mut time_start, &mut time_end, &created_at);
        tx.execute(
            "INSERT INTO events(
               id,session_id,event_type,function_name,thread_id,args_json,result_json,
               content,created_at,meta_json,history_sequence
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                event_id,
                manifest.local_session_id,
                row.get::<_, String>(5).map_err(|error| error.to_string())?,
                row.get::<_, Option<String>>(6)
                    .map_err(|error| error.to_string())?,
                row.get::<_, Option<String>>(7)
                    .map_err(|error| error.to_string())?,
                row.get::<_, String>(8).map_err(|error| error.to_string())?,
                row.get::<_, String>(9).map_err(|error| error.to_string())?,
                row.get::<_, String>(10)
                    .map_err(|error| error.to_string())?,
                created_at,
                row.get::<_, Option<String>>(12)
                    .map_err(|error| error.to_string())?,
                logical_index,
            ],
        )
        .map_err(|error| format!("publish collaboration event {event_id}: {error}"))?;
        tx.execute(
            "INSERT INTO collaboration_snapshot_event_map(
               session_id,event_id,original_id,physical_seq,event_index,logical_index,is_tail
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                manifest.local_session_id,
                event_id,
                original_id,
                physical_seq,
                event_index,
                logical_index,
                is_tail,
            ],
        )
        .map_err(|error| format!("publish collaboration event map: {error}"))?;
        offset += 1;
    }

    let published_logical_count = base_logical_index
        .checked_add(offset)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| "published logical event count overflow".to_string())?;
    if published_logical_count != final_count {
        return Err(format!(
            "published logical event count mismatch: expected {final_count}, got {published_logical_count}"
        ));
    }

    let now = Utc::now().timestamp();
    let final_event_count =
        i64::try_from(final_count).map_err(|_| "final event count is too large")?;
    let final_frozen_event_count =
        i64::try_from(final_frozen_count).map_err(|_| "final frozen event count is too large")?;
    let final_max_sequence = if final_event_count == 0 {
        -1
    } else {
        final_event_count - 1
    };
    tx.execute(
        "INSERT INTO sessions(
           session_id,event_count,cached_at,time_range_start,time_range_end,specs_json
         ) VALUES(?1,?2,?3,?4,?5,NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           event_count=excluded.event_count,
           cached_at=excluded.cached_at,
           time_range_start=excluded.time_range_start,
           time_range_end=excluded.time_range_end",
        params![
            manifest.local_session_id,
            final_event_count,
            now,
            time_start,
            time_end,
        ],
    )
    .map_err(|error| format!("publish collaboration session metadata: {error}"))?;
    tx.execute(
        "INSERT INTO collaboration_snapshot_ingest_state(
           session_id,epoch,frozen_seq,event_count,frozen_event_count,tail_hash,updated_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(session_id) DO UPDATE SET
           epoch=excluded.epoch,
           frozen_seq=excluded.frozen_seq,
           event_count=excluded.event_count,
           frozen_event_count=excluded.frozen_event_count,
           tail_hash=excluded.tail_hash,
           updated_at=excluded.updated_at",
        params![
            manifest.local_session_id,
            manifest.epoch,
            i64::try_from(manifest.expected_frozen_seq)
                .map_err(|_| "final frozen sequence is too large")?,
            final_event_count,
            final_frozen_event_count,
            manifest.expected_tail_hash,
            now,
        ],
    )
    .map_err(|error| format!("publish collaboration snapshot cursor: {error}"))?;
    if native_snapshot {
        tx.execute(
            "INSERT INTO collaboration_snapshot_secondary_state(
               session_id,generation,revision,reset_revision,max_sequence,event_count
             ) VALUES(?1,0,0,0,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET
               generation=collaboration_snapshot_secondary_state.generation+1,
               revision=collaboration_snapshot_secondary_state.revision+1,
               reset_revision=collaboration_snapshot_secondary_state.revision+1,
               max_sequence=excluded.max_sequence,
               event_count=excluded.event_count",
            params![
                manifest.local_session_id,
                final_max_sequence,
                final_event_count,
            ],
        )
        .map_err(|error| format!("publish native fork secondary replay state: {error}"))?;
        ensure_secondary_mutation_triggers(&tx)?;
    }
    tx.execute(
        "DELETE FROM session_turns WHERE session_id=?1",
        [&manifest.local_session_id],
    )
    .map_err(|error| format!("invalidate collaboration turn summaries: {error}"))?;
    tx.execute(
        "DELETE FROM session_turn_index_state WHERE session_id=?1",
        [&manifest.local_session_id],
    )
    .map_err(|error| format!("invalidate collaboration turn index state: {error}"))?;
    if imported_snapshot {
        publish_replay_accounting_state(
            &tx,
            &manifest.local_session_id,
            final_event_count,
            final_max_sequence,
        )?;
    }
    let (handoff_items, handoff_scanned_bytes, handoff_scanned_events) =
        collect_published_handoff(&tx, &manifest.local_session_id)?;
    tx.commit()
        .map_err(|error| format!("commit collaboration snapshot publish: {error}"))?;

    Ok(CollaborationSnapshotIngestCommitResult {
        local_session_id: manifest.local_session_id.clone(),
        epoch: manifest.epoch,
        frozen_seq: manifest.expected_frozen_seq,
        event_count: final_count,
        frozen_event_count: final_frozen_count,
        tail_hash: manifest.expected_tail_hash.clone(),
        handoff_items,
        handoff_scanned_bytes,
        handoff_scanned_events,
    })
}

fn commit_at_root_with_connection(
    root: &Path,
    token: &str,
    destination: &Connection,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    let path = staging_path(root, token)?;
    let result = (|| {
        let mut staging = open_staging(&path)?;
        let manifest = load_manifest(&staging)?;
        if manifest.token != token {
            return Err("snapshot ingest token does not match its manifest".to_string());
        }
        finalize_attachments(&mut staging, root, &manifest)?;
        let (final_count, final_frozen_count) = validate_complete_staging(&staging, &manifest)?;
        publish_staged_snapshot(
            destination,
            &staging,
            &manifest,
            final_count,
            final_frozen_count,
        )
    })();
    // A commit token is single-use. Validation and SQLite failures are
    // fail-closed and cannot be repaired by replaying an ambiguous suffix.
    remove_staging_files(&path);
    remove_token_temp_files(root, token);
    result
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_commit(
    request: CollaborationSnapshotIngestTokenRequest,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| {
            let destination = database::db::get_connection()
                .map_err(|error| format!("open sessions.db for snapshot publish: {error}"))?;
            commit_at_root_with_connection(&root, &request.token, &destination)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn abort_at_root(root: &Path, token: &str) -> Result<(), String> {
    let path = staging_path(root, token)?;
    remove_staging_files(&path);
    remove_token_temp_files(root, token);
    Ok(())
}

#[tauri::command]
pub async fn collaboration_snapshot_ingest_abort(
    request: CollaborationSnapshotIngestTokenRequest,
) -> Result<(), String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || abort_at_root(&root, &request.token))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::Write as _;

    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tempfile::TempDir;

    use super::*;
    use crate::agent_sessions::event_pipeline::types::{
        ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource,
    };

    fn test_event(id: &str, source: EventSource, text: &str) -> SessionEvent {
        let (action_type, function_name) = match source {
            EventSource::User => ("user_message", "user_message"),
            EventSource::Assistant => ("assistant_message", "agent_message"),
            EventSource::System => ("tool_call", "read"),
        };
        SessionEvent {
            id: id.to_string(),
            chunk_id: Some(format!("chunk-{id}")),
            session_id: "source-session".to_string(),
            created_at: "2026-07-22T00:00:00.000Z".to_string(),
            function_name: function_name.to_string(),
            ui_canonical: function_name.to_string(),
            action_type: action_type.to_string(),
            args: serde_json::json!({ "content": text }),
            result: serde_json::json!({}),
            source,
            display_text: text.to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: EventDisplayVariant::Message,
            activity_status: ActivityStatus::Agent,
            thread_id: None,
            process_id: None,
            call_id: None,
            file_path: None,
            command: None,
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: Some(HashMap::new()),
            last_extract_at: None,
        }
    }

    fn gzip_base64(bytes: &[u8]) -> String {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).expect("gzip bytes");
        BASE64_STANDARD.encode(encoder.finish().expect("finish gzip"))
    }

    fn v1_wire(seq: u64, events: &[SessionEvent]) -> CollaborationSnapshotWire {
        let bytes = serde_json::to_vec(events).expect("serialize event segment");
        CollaborationSnapshotWire {
            seq,
            payload_gz: gzip_base64(&bytes),
            event_count: events.len() as u64,
            segment_hash: sha256_hex(&bytes),
        }
    }

    fn page_bytes(segments: &[CollaborationSnapshotWire]) -> u64 {
        segments
            .iter()
            .map(|wire| serde_json::to_vec(wire).expect("measure wire").len() as u64)
            .sum()
    }

    fn backward_page(
        token: &str,
        epoch: i64,
        frozen_seq: u64,
        count: u64,
        before_seq: Option<u64>,
        next_before_seq: Option<u64>,
        segments: Vec<CollaborationSnapshotWire>,
    ) -> CollaborationSnapshotIngestPageRequest {
        let has_more = next_before_seq.is_some();
        CollaborationSnapshotIngestPageRequest {
            token: token.to_string(),
            epoch,
            frozen_seq,
            count,
            tail_hash: None,
            cursor: CollaborationSnapshotWireCursor::Backward { before_seq },
            next_cursor: next_before_seq.map(|before_seq| {
                CollaborationSnapshotWireCursor::Backward {
                    before_seq: Some(before_seq),
                }
            }),
            tail_included: false,
            has_more,
            returned_wire_bytes: page_bytes(&segments),
            segments,
        }
    }

    fn forward_page(
        token: &str,
        epoch: i64,
        frozen_seq: u64,
        count: u64,
        after_seq: u64,
        segments: Vec<CollaborationSnapshotWire>,
        has_more: bool,
    ) -> CollaborationSnapshotIngestPageRequest {
        let last = segments
            .iter()
            .map(|wire| wire.seq)
            .max()
            .unwrap_or(after_seq);
        CollaborationSnapshotIngestPageRequest {
            token: token.to_string(),
            epoch,
            frozen_seq,
            count,
            tail_hash: None,
            cursor: CollaborationSnapshotWireCursor::Forward {
                after_seq,
                through_seq: Some(frozen_seq),
            },
            next_cursor: has_more.then_some(CollaborationSnapshotWireCursor::Forward {
                after_seq: last,
                through_seq: Some(frozen_seq),
            }),
            tail_included: false,
            has_more,
            returned_wire_bytes: page_bytes(&segments),
            segments,
        }
    }

    fn destination() -> Connection {
        let conn = Connection::open_in_memory().expect("destination db");
        session_persistence::init_session_tables(&conn).expect("session schema");
        conn
    }

    fn begin_replace(
        root: &Path,
        session_id: &str,
        epoch: i64,
        count: u64,
        frozen_seq: u64,
    ) -> String {
        begin_at_root(
            root,
            CollaborationSnapshotIngestBeginRequest {
                local_session_id: session_id.to_string(),
                epoch,
                expected_count: count,
                expected_frozen_seq: frozen_seq,
                tail_hash: None,
                replace: true,
                previous: None,
            },
        )
        .expect("begin ingest")
        .token
    }

    #[test]
    fn v1_backward_pages_publish_atomically_and_namespace_ids() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "imported-session-v1-pages";
        let first = test_event("first", EventSource::User, "hello");
        let second = test_event("second", EventSource::Assistant, "world");
        let token = begin_replace(root, session_id, 4, 2, 2);
        let second_wire = v1_wire(2, std::slice::from_ref(&second));
        apply_page_at_root(
            root,
            backward_page(&token, 4, 2, 2, None, Some(2), vec![second_wire]),
        )
        .expect("newest page");
        let first_wire = v1_wire(1, std::slice::from_ref(&first));
        apply_page_at_root(
            root,
            backward_page(&token, 4, 2, 2, Some(2), None, vec![first_wire]),
        )
        .expect("oldest page");

        let result =
            commit_at_root_with_connection(root, &token, &destination).expect("publish snapshot");
        assert_eq!(result.event_count, 2);
        assert_eq!(result.frozen_event_count, 2);
        assert_eq!(
            result.handoff_items,
            vec!["User: hello", "Assistant: world"]
        );
        let ids = destination
            .prepare("SELECT id FROM events WHERE session_id=?1 ORDER BY history_sequence")
            .expect("prepare ids")
            .query_map([session_id], |row| row.get::<_, String>(0))
            .expect("query ids")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect ids");
        assert_eq!(
            ids,
            vec![
                format!("{session_id}~first"),
                format!("{session_id}~second")
            ]
        );
        assert!(!staging_path(root, &token).expect("stage path").exists());
    }

    #[test]
    fn native_fork_snapshot_publishes_without_external_replay_accounting() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "agentsession-cloud-fork";
        let event = test_event("source-event", EventSource::User, "fork context");
        let token = begin_replace(root, session_id, 9, 1, 1);
        let wire = v1_wire(1, std::slice::from_ref(&event));
        apply_page_at_root(root, backward_page(&token, 9, 1, 1, None, None, vec![wire]))
            .expect("stage native fork snapshot");
        let result = commit_at_root_with_connection(root, &token, &destination)
            .expect("publish native fork snapshot");
        assert_eq!(result.local_session_id, session_id);
        assert_eq!(result.handoff_items, vec!["User: fork context"]);
        let event_id: String = destination
            .query_row(
                "SELECT id FROM events WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("native fork event");
        assert_eq!(event_id, format!("{session_id}~source-event"));
        let replay_state_table: i64 = destination
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='collaboration_replay_state'",
                [],
                |row| row.get(0),
            )
            .expect("replay state table count");
        assert_eq!(replay_state_table, 0);
        assert!(has_snapshot_backed_native_fork(&destination, session_id)
            .expect("probe intact native fork"));
        assert!(has_native_snapshot_marker(&destination, session_id)
            .expect("read native fork origin marker"));
        let initial_state = collaboration_snapshot_secondary_state(&destination, session_id)
            .expect("read initial native fork secondary state")
            .expect("native fork has secondary state");
        assert_eq!(initial_state.revision, 0);
        assert_eq!(initial_state.reset_revision, 0);
        assert_eq!(initial_state.max_sequence, 0);
        assert_eq!(initial_state.event_count, 1);

        let replacement = test_event("source-event", EventSource::User, "new fork context");
        let replacement_token = begin_replace(root, session_id, 10, 1, 1);
        let replacement_wire = v1_wire(1, std::slice::from_ref(&replacement));
        apply_page_at_root(
            root,
            backward_page(
                &replacement_token,
                10,
                1,
                1,
                None,
                None,
                vec![replacement_wire],
            ),
        )
        .expect("stage replacement native fork snapshot");
        commit_at_root_with_connection(root, &replacement_token, &destination)
            .expect("replace native fork snapshot");
        let replaced_state = collaboration_snapshot_secondary_state(&destination, session_id)
            .expect("read replaced native fork secondary state")
            .expect("replaced native fork remains snapshot-backed");
        assert_ne!(replaced_state.generation, initial_state.generation);
        assert_eq!(replaced_state.revision, initial_state.revision + 1);
        assert_eq!(replaced_state.reset_revision, replaced_state.revision);
        assert_eq!(replaced_state.max_sequence, 0);
        assert_eq!(replaced_state.event_count, 1);

        destination
            .execute(
                "INSERT INTO events(
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,history_sequence
                 ) VALUES(?1,?2,'assistant_message','agent_message','{}','{}',
                          'native suffix','2026-07-22T00:00:01.000Z',1)",
                params![format!("{session_id}~native-suffix"), session_id],
            )
            .expect("append native suffix event");
        destination
            .execute(
                "UPDATE sessions SET event_count=2 WHERE session_id=?1",
                [session_id],
            )
            .expect("publish native suffix count");
        assert!(has_snapshot_backed_native_fork(&destination, session_id)
            .expect("probe native fork with suffix"));
        let appended_state = collaboration_snapshot_secondary_state(&destination, session_id)
            .expect("read appended native fork secondary state")
            .expect("native fork remains snapshot-backed");
        assert_eq!(appended_state.generation, replaced_state.generation);
        assert_eq!(appended_state.revision, replaced_state.revision + 1);
        assert_eq!(appended_state.reset_revision, replaced_state.reset_revision);
        assert_eq!(appended_state.max_sequence, 1);
        assert_eq!(appended_state.event_count, 2);

        destination
            .execute(
                "UPDATE events SET result_json='{\"content\":\"updated suffix\"}'
                 WHERE id=?1",
                [format!("{session_id}~native-suffix")],
            )
            .expect("update native suffix event");
        let updated_state = collaboration_snapshot_secondary_state(&destination, session_id)
            .expect("read updated native fork secondary state")
            .expect("updated native fork remains snapshot-backed");
        assert_eq!(updated_state.generation, appended_state.generation);
        assert_eq!(updated_state.revision, appended_state.revision + 1);
        assert_eq!(updated_state.reset_revision, updated_state.revision);
        assert_eq!(updated_state.max_sequence, 1);
        assert_eq!(updated_state.event_count, 2);

        destination
            .execute(
                "DELETE FROM events WHERE id=?1",
                [format!("{session_id}~source-event")],
            )
            .expect("remove inherited sentinel");
        assert!(!has_snapshot_backed_native_fork(&destination, session_id)
            .expect("reject hollow native fork"));
        assert!(has_native_snapshot_marker(&destination, session_id)
            .expect("damaged snapshot still fails closed for background consumers"));
        assert!(
            !has_snapshot_backed_native_fork(&destination, "agentsession-native")
                .expect("ordinary native session has no snapshot")
        );
        assert!(
            !has_snapshot_backed_native_fork(&destination, "sdeagent-native")
                .expect("SDE session is never snapshot-backed")
        );
    }

    #[test]
    fn cursor_query_returns_only_an_intact_imported_snapshot() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "imported-session-cursor";
        let event = test_event("cursor-event", EventSource::User, "cursor payload");
        let token = begin_replace(root, session_id, 12, 1, 1);
        let wire = v1_wire(1, std::slice::from_ref(&event));
        apply_page_at_root(
            root,
            backward_page(&token, 12, 1, 1, None, None, vec![wire]),
        )
        .expect("stage cursor snapshot");
        commit_at_root_with_connection(root, &token, &destination)
            .expect("publish cursor snapshot");

        let intact_cursor = get_cursor_from_connection(&destination, session_id)
            .expect("read intact cursor")
            .expect("intact cursor exists");
        assert_eq!(
            intact_cursor,
            CollaborationSnapshotCursor {
                epoch: 12,
                frozen_seq: 1,
                count: 1,
                frozen_count: 1,
                tail_hash: None,
            }
        );
        assert_eq!(
            serde_json::to_value(&intact_cursor).expect("serialize cursor wire value"),
            serde_json::json!({
                "epoch": 12,
                "frozenSeq": 1,
                "count": 1,
                "frozenCount": 1,
                "tailHash": null,
            })
        );

        let trigger_count: i64 = destination
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='trigger' AND name LIKE 'collaboration_snapshot_%_invalidate'",
                [],
                |row| row.get(0),
            )
            .expect("snapshot invalidation trigger count");
        assert_eq!(trigger_count, SNAPSHOT_INVALIDATION_TRIGGER_COUNT);
        let query_plan = destination
            .prepare(&format!("EXPLAIN QUERY PLAN {CURSOR_SENTINEL_SQL}"))
            .expect("prepare sentinel query plan")
            .query_map(params![session_id, 0_i64], |row| row.get::<_, String>(3))
            .expect("query sentinel plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect sentinel plan");
        assert!(query_plan
            .iter()
            .any(|detail| detail.contains("idx_collaboration_snapshot_event_order")));
        assert!(!query_plan
            .iter()
            .any(|detail| detail.contains("SCAN m") || detail.contains("SCAN e")));

        destination
            .execute("DELETE FROM events WHERE session_id=?1", [session_id])
            .expect("make snapshot hollow");
        let state_rows: i64 = destination
            .query_row(
                "SELECT COUNT(*) FROM collaboration_snapshot_ingest_state
                 WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("count invalidated state");
        assert_eq!(state_rows, 0);
        assert_eq!(
            get_cursor_from_connection(&destination, session_id).expect("read hollow cursor"),
            None
        );

        destination
            .execute(
                "INSERT INTO collaboration_snapshot_ingest_state(
                   session_id,epoch,frozen_seq,event_count,frozen_event_count,tail_hash,updated_at
                 ) VALUES(?1,12,1,1,1,NULL,0)",
                [session_id],
            )
            .expect("restore stale cursor state");
        assert_eq!(
            get_cursor_from_connection(&destination, session_id)
                .expect("sentinel rejects hollow cursor"),
            None
        );
        destination
            .execute(
                "UPDATE collaboration_snapshot_ingest_state SET event_count=-1
                 WHERE session_id=?1",
                [session_id],
            )
            .expect("corrupt cursor state");
        assert_eq!(
            get_cursor_from_connection(&destination, session_id).expect("read invalid cursor"),
            None
        );

        let repair_event = test_event("repair-event", EventSource::Assistant, "repaired");
        let repair_token = begin_replace(root, session_id, 13, 1, 1);
        let repair_wire = v1_wire(1, std::slice::from_ref(&repair_event));
        apply_page_at_root(
            root,
            backward_page(&repair_token, 13, 1, 1, None, None, vec![repair_wire]),
        )
        .expect("stage repaired cursor snapshot");
        commit_at_root_with_connection(root, &repair_token, &destination)
            .expect("full replacement repairs an invalid cursor");
        assert_eq!(
            get_cursor_from_connection(&destination, session_id).expect("read repaired cursor"),
            Some(CollaborationSnapshotCursor {
                epoch: 13,
                frozen_seq: 1,
                count: 1,
                frozen_count: 1,
                tail_hash: None,
            })
        );
    }

    #[test]
    fn cursor_query_rejects_native_agent_sessions() {
        let destination = destination();
        let error = get_cursor_from_connection(&destination, "agentsession-native-fork")
            .expect_err("native sessions must not expose external snapshot cursors");
        assert!(error.contains("only imported-session"));
    }

    #[test]
    fn incremental_destination_queries_use_indexes_on_a_large_map() {
        let mut destination = destination();
        let session_id = "imported-session-large-cursor-map";
        let tx = destination.transaction().expect("large map transaction");
        ensure_destination_schema(&tx).expect("snapshot schema");
        create_destination_indexes(&tx).expect("snapshot indexes");
        tx.execute_batch(
            "WITH digits(n) AS (
               VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
             ), sequence(i) AS (
               SELECT a.n + 10*b.n + 100*c.n + 1000*d.n
               FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
             )
             INSERT INTO events(
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             )
             SELECT printf('imported-session-large-cursor-map~event-%d',i),
                    'imported-session-large-cursor-map','user_message','user_message',
                    '{}','{}','','2026-07-22T00:00:00.000Z',i
             FROM sequence;

             WITH digits(n) AS (
               VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
             ), sequence(i) AS (
               SELECT a.n + 10*b.n + 100*c.n + 1000*d.n
               FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
             )
             INSERT INTO collaboration_snapshot_event_map(
               session_id,event_id,original_id,physical_seq,event_index,logical_index,is_tail
             )
             SELECT 'imported-session-large-cursor-map',
                    printf('imported-session-large-cursor-map~event-%d',i),
                    printf('event-%d',i),i+1,0,i,0
             FROM sequence;

             INSERT INTO sessions(session_id,event_count,cached_at)
             VALUES('imported-session-large-cursor-map',10000,0);
             INSERT INTO collaboration_snapshot_ingest_state(
               session_id,epoch,frozen_seq,event_count,frozen_event_count,tail_hash,updated_at
             ) VALUES('imported-session-large-cursor-map',1,10000,10000,10000,NULL,0);",
        )
        .expect("seed large cursor map");
        tx.commit().expect("commit large cursor map");

        let cursor = get_cursor_from_connection(&destination, session_id)
            .expect("read large cursor map")
            .expect("large cursor remains healthy");
        assert_eq!(cursor.count, 10_000);
        let query_plan = destination
            .prepare(&format!("EXPLAIN QUERY PLAN {CURSOR_SENTINEL_SQL}"))
            .expect("prepare large sentinel query plan")
            .query_map(params![session_id, 9_999_i64], |row| {
                row.get::<_, String>(3)
            })
            .expect("query large sentinel plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect large sentinel plan");
        assert!(query_plan
            .iter()
            .any(|detail| detail.contains("idx_collaboration_snapshot_event_order")));
        assert!(!query_plan
            .iter()
            .any(|detail| detail.contains("SCAN m") || detail.contains("SCAN e")));

        let delete_tail_plan = destination
            .prepare(&format!("EXPLAIN QUERY PLAN {DELETE_TAIL_EVENTS_SQL}"))
            .expect("prepare indexed tail delete plan")
            .query_map([session_id], |row| row.get::<_, String>(3))
            .expect("query indexed tail delete plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect indexed tail delete plan");
        assert!(delete_tail_plan
            .iter()
            .any(|detail| detail.contains("idx_collaboration_snapshot_event_tail")));
        assert!(!delete_tail_plan.iter().any(|detail| {
            let detail = detail.to_ascii_uppercase();
            detail.contains("SCAN EVENTS")
                || detail.contains("SCAN COLLABORATION_SNAPSHOT_EVENT_MAP")
        }));
        let delete_tail_map_plan = destination
            .prepare(&format!("EXPLAIN QUERY PLAN {DELETE_TAIL_MAP_SQL}"))
            .expect("prepare indexed tail map delete plan")
            .query_map([session_id], |row| row.get::<_, String>(3))
            .expect("query indexed tail map delete plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect indexed tail map delete plan");
        assert!(delete_tail_map_plan
            .iter()
            .any(|detail| detail.contains("idx_collaboration_snapshot_event_tail")));
        assert!(!delete_tail_map_plan.iter().any(|detail| {
            detail
                .to_ascii_uppercase()
                .contains("SCAN COLLABORATION_SNAPSHOT_EVENT_MAP")
        }));

        let handoff_plan = destination
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT id FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 400",
            )
            .expect("prepare bounded handoff plan")
            .query_map([session_id], |row| row.get::<_, String>(3))
            .expect("query bounded handoff plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect bounded handoff plan");
        assert!(handoff_plan
            .iter()
            .any(|detail| detail.contains("idx_events_session_sequence")));
        assert!(!handoff_plan
            .iter()
            .any(|detail| { detail.to_ascii_uppercase().contains("SCAN EVENTS") }));

        let replay_sql = PUBLISH_REPLAY_ACCOUNTING_SQL.to_ascii_uppercase();
        assert!(!replay_sql.contains("SELECT"));
        assert!(!replay_sql.contains("FROM EVENTS"));
        assert!(!replay_sql.contains("COUNT("));
        assert!(!replay_sql.contains("MAX("));
    }

    #[test]
    fn commit_handoff_is_last_80_bounded_items_and_skips_thinking() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "agentsession-bounded-handoff";
        let mut events = (0..82)
            .map(|index| {
                test_event(
                    &format!("user-{index}"),
                    EventSource::User,
                    &format!("{index}-{}", "x".repeat(2_000)),
                )
            })
            .collect::<Vec<_>>();
        let mut thinking = test_event("thinking", EventSource::Assistant, "private reasoning");
        thinking.action_type = "thinking".to_string();
        thinking.function_name = "reasoning".to_string();
        thinking.display_variant = EventDisplayVariant::Thinking;
        events.push(thinking);
        let token = begin_replace(root, session_id, 1, events.len() as u64, 1);
        let wire = v1_wire(1, &events);
        apply_page_at_root(
            root,
            backward_page(&token, 1, 1, events.len() as u64, None, None, vec![wire]),
        )
        .expect("stage handoff events");
        let result = commit_at_root_with_connection(root, &token, &destination)
            .expect("publish handoff events");
        assert_eq!(result.handoff_items.len(), HANDOFF_MAX_ITEMS);
        assert!(result
            .handoff_items
            .iter()
            .all(|item| item.encode_utf16().count() <= HANDOFF_MAX_ITEM_UTF16));
        assert!(result
            .handoff_items
            .iter()
            .all(|item| !item.contains("private reasoning")));
        assert!(result.handoff_scanned_bytes <= HANDOFF_SCAN_BYTES as u64);
    }

    #[test]
    fn incremental_publish_preserves_frozen_prefix_and_replaces_tail() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "imported-session-incremental";
        let mut first = test_event("first", EventSource::User, "first");
        first.created_at = "2026-07-20T00:00:00.000Z".to_string();
        let mut old_tail = test_event("old-tail", EventSource::Assistant, "old tail");
        old_tail.created_at = "2026-07-21T00:00:00.000Z".to_string();
        let first_wire = v1_wire(1, std::slice::from_ref(&first));
        let old_tail_wire = v1_wire(0, std::slice::from_ref(&old_tail));
        let old_tail_hash = old_tail_wire.segment_hash.clone();
        let token = begin_at_root(
            root,
            CollaborationSnapshotIngestBeginRequest {
                local_session_id: session_id.to_string(),
                epoch: 1,
                expected_count: 2,
                expected_frozen_seq: 1,
                tail_hash: Some(old_tail_hash.clone()),
                replace: true,
                previous: None,
            },
        )
        .expect("begin initial snapshot")
        .token;
        let segments = vec![first_wire, old_tail_wire];
        apply_page_at_root(
            root,
            CollaborationSnapshotIngestPageRequest {
                token: token.clone(),
                epoch: 1,
                frozen_seq: 1,
                count: 2,
                tail_hash: Some(old_tail_hash.clone()),
                cursor: CollaborationSnapshotWireCursor::Backward { before_seq: None },
                next_cursor: None,
                tail_included: true,
                has_more: false,
                returned_wire_bytes: page_bytes(&segments),
                segments,
            },
        )
        .expect("stage initial snapshot");
        commit_at_root_with_connection(root, &token, &destination)
            .expect("publish initial snapshot");

        let previous = CollaborationSnapshotCursor {
            epoch: 1,
            frozen_seq: 1,
            count: 2,
            frozen_count: 1,
            tail_hash: Some(old_tail_hash),
        };
        let mut second = test_event("second", EventSource::User, "second");
        second.created_at = "2026-07-22T00:00:00.000Z".to_string();
        let mut new_tail = test_event("new-tail", EventSource::Assistant, "new tail");
        new_tail.created_at = "2026-07-23T00:00:00.000Z".to_string();
        let second_wire = v1_wire(2, std::slice::from_ref(&second));
        let new_tail_wire = v1_wire(0, std::slice::from_ref(&new_tail));
        let new_tail_hash = new_tail_wire.segment_hash.clone();
        let token = begin_at_root(
            root,
            CollaborationSnapshotIngestBeginRequest {
                local_session_id: session_id.to_string(),
                epoch: 1,
                expected_count: 3,
                expected_frozen_seq: 2,
                tail_hash: Some(new_tail_hash.clone()),
                replace: false,
                previous: Some(previous),
            },
        )
        .expect("begin incremental snapshot")
        .token;
        let segments = vec![second_wire, new_tail_wire];
        apply_page_at_root(
            root,
            CollaborationSnapshotIngestPageRequest {
                token: token.clone(),
                epoch: 1,
                frozen_seq: 2,
                count: 3,
                tail_hash: Some(new_tail_hash.clone()),
                cursor: CollaborationSnapshotWireCursor::Forward {
                    after_seq: 1,
                    through_seq: Some(2),
                },
                next_cursor: None,
                tail_included: true,
                has_more: false,
                returned_wire_bytes: page_bytes(&segments),
                segments,
            },
        )
        .expect("stage incremental snapshot");
        let result = commit_at_root_with_connection(root, &token, &destination)
            .expect("publish incremental snapshot");
        assert_eq!(result.event_count, 3);
        assert_eq!(result.frozen_event_count, 2);
        assert_eq!(result.tail_hash.as_deref(), Some(new_tail_hash.as_str()));
        let ids = destination
            .prepare("SELECT id FROM events WHERE session_id=?1 ORDER BY history_sequence")
            .expect("prepare ids")
            .query_map([session_id], |row| row.get::<_, String>(0))
            .expect("query ids")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect ids");
        assert_eq!(
            ids,
            vec![
                format!("{session_id}~first"),
                format!("{session_id}~second"),
                format!("{session_id}~new-tail"),
            ]
        );
        let session_time_range: (Option<String>, Option<String>) = destination
            .query_row(
                "SELECT time_range_start,time_range_end FROM sessions WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("incremental session time range");
        assert_eq!(
            session_time_range,
            (
                Some("2026-07-20T00:00:00.000Z".to_string()),
                Some("2026-07-23T00:00:00.000Z".to_string()),
            )
        );

        let replay_accounting_before: (i64, i64, i64, i64) = destination
            .query_row(
                "SELECT generation,revision,max_sequence,event_count
                 FROM collaboration_replay_state WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("replay accounting before no-op");
        assert_eq!(replay_accounting_before, (1, 3, 2, 3));
        let unchanged_cursor = CollaborationSnapshotCursor {
            epoch: 1,
            frozen_seq: 2,
            count: 3,
            frozen_count: 2,
            tail_hash: Some(new_tail_hash.clone()),
        };
        let unchanged_tail_wire = v1_wire(0, std::slice::from_ref(&new_tail));
        let token = begin_at_root(
            root,
            CollaborationSnapshotIngestBeginRequest {
                local_session_id: session_id.to_string(),
                epoch: 1,
                expected_count: 3,
                expected_frozen_seq: 2,
                tail_hash: Some(new_tail_hash.clone()),
                replace: false,
                previous: Some(unchanged_cursor),
            },
        )
        .expect("begin unchanged snapshot")
        .token;
        let segments = vec![unchanged_tail_wire];
        apply_page_at_root(
            root,
            CollaborationSnapshotIngestPageRequest {
                token: token.clone(),
                epoch: 1,
                frozen_seq: 2,
                count: 3,
                tail_hash: Some(new_tail_hash),
                cursor: CollaborationSnapshotWireCursor::Forward {
                    after_seq: 2,
                    through_seq: Some(2),
                },
                next_cursor: None,
                tail_included: true,
                has_more: false,
                returned_wire_bytes: page_bytes(&segments),
                segments,
            },
        )
        .expect("stage unchanged snapshot");
        commit_at_root_with_connection(root, &token, &destination)
            .expect("commit unchanged snapshot");
        let replay_accounting_after: (i64, i64, i64, i64) = destination
            .query_row(
                "SELECT generation,revision,max_sequence,event_count
                 FROM collaboration_replay_state WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("replay accounting after no-op");
        assert_eq!(replay_accounting_after, replay_accounting_before);
    }

    fn v2_wires(event: &SessionEvent) -> Vec<CollaborationSnapshotWire> {
        let event_bytes = serde_json::to_vec(event).expect("serialize attachment event");
        let attachment_hash = sha256_hex(&event_bytes);
        let attachment_id = sha256_hex(event.id.as_bytes());
        let chunk_bytes = 176 * 1024;
        event_bytes
            .chunks(chunk_bytes)
            .enumerate()
            .map(|(part_index, chunk)| {
                let chunk_offset = part_index * chunk_bytes;
                let final_part = chunk_offset + chunk.len() == event_bytes.len();
                let header = serde_json::json!({
                    "kind": "event",
                    "attachmentId": attachment_id,
                    "partIndex": part_index,
                    "chunkOffset": chunk_offset,
                    "chunkBytes": chunk.len(),
                    "finalPart": final_part,
                    "eventBytes": final_part.then_some(event_bytes.len()),
                    "attachmentHash": final_part.then_some(attachment_hash.clone()),
                });
                let header_bytes = serde_json::to_vec(&header).expect("serialize frame header");
                let mut frame =
                    Vec::with_capacity(FRAME_MAGIC.len() + 4 + header_bytes.len() + chunk.len());
                frame.extend_from_slice(FRAME_MAGIC);
                frame.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
                frame.extend_from_slice(&header_bytes);
                frame.extend_from_slice(chunk);
                CollaborationSnapshotWire {
                    seq: part_index as u64 + 1,
                    payload_gz: gzip_base64(&frame),
                    event_count: u64::from(final_part),
                    segment_hash: sha256_hex(&frame),
                }
            })
            .collect()
    }

    #[test]
    fn v2_ten_mib_event_stages_parts_and_restores_exact_payload() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "imported-session-v2-large";
        let payload = "x".repeat(10 * 1024 * 1024);
        let mut event = test_event("large", EventSource::Assistant, "large result");
        event.result = serde_json::json!({ "content": payload.clone() });
        let wires = v2_wires(&event);
        assert!(wires.iter().all(|wire| {
            serde_json::to_vec(wire).expect("measure v2 wire").len() <= MAX_WIRE_BYTES
        }));
        let frozen_seq = wires.len() as u64;
        let token = begin_replace(root, session_id, 7, 1, frozen_seq);
        let mut after_seq = 0_u64;
        for (index, chunk) in wires.chunks(12).enumerate() {
            let has_more = (index + 1) * 12 < wires.len();
            let page = forward_page(
                &token,
                7,
                frozen_seq,
                1,
                after_seq,
                chunk.to_vec(),
                has_more,
            );
            after_seq = chunk.last().expect("wire chunk").seq;
            apply_page_at_root(root, page).expect("stage v2 page");
        }
        let result = commit_at_root_with_connection(root, &token, &destination)
            .expect("publish v2 snapshot");
        assert_eq!(result.event_count, 1);
        let result_json: String = destination
            .query_row(
                "SELECT result_json FROM events WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("load large result");
        let restored: serde_json::Value = serde_json::from_str(&result_json).expect("parse result");
        let restored_payload = restored
            .get("content")
            .and_then(serde_json::Value::as_str)
            .expect("content");
        assert_eq!(restored_payload.len(), 10 * 1024 * 1024);
        assert_eq!(
            sha256_hex(restored_payload.as_bytes()),
            sha256_hex(payload.as_bytes())
        );
    }

    #[test]
    fn hash_gap_and_abort_fail_closed() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "imported-session-fail-closed";
        let event = test_event("event", EventSource::User, "payload");

        let bad_token = begin_replace(root, session_id, 1, 1, 1);
        let mut bad_wire = v1_wire(1, std::slice::from_ref(&event));
        bad_wire.segment_hash = "0".repeat(64);
        let error = apply_page_at_root(
            root,
            backward_page(&bad_token, 1, 1, 1, None, None, vec![bad_wire]),
        )
        .expect_err("hash mismatch must fail");
        assert!(error.contains("hash mismatch"));
        abort_at_root(root, &bad_token).expect("abort bad token");
        assert!(!staging_path(root, &bad_token)
            .expect("bad stage path")
            .exists());

        let gap_token = begin_replace(root, session_id, 2, 1, 2);
        let wire = v1_wire(2, std::slice::from_ref(&event));
        apply_page_at_root(
            root,
            backward_page(&gap_token, 2, 2, 1, None, None, vec![wire]),
        )
        .expect("stage gapped page");
        let error = commit_at_root_with_connection(root, &gap_token, &destination)
            .expect_err("missing physical row must fail");
        assert!(error.contains("incomplete"));
        assert_eq!(
            destination
                .query_row("SELECT COUNT(*) FROM events", [], |row| row
                    .get::<_, i64>(0))
                .expect("count destination"),
            0
        );
        assert!(!staging_path(root, &gap_token)
            .expect("gap stage path")
            .exists());
    }

    #[test]
    fn commit_failure_rolls_back_old_snapshot_and_cleans_staging() {
        let temp = TempDir::new().expect("tempdir");
        let root = temp.path();
        let destination = destination();
        let session_id = "imported-session-rollback";
        destination
            .execute(
                "INSERT INTO events(
                   id,session_id,event_type,args_json,result_json,content,created_at,history_sequence
                 ) VALUES('old',?1,'user_message','{}','{}','old','2026-01-01',0)",
                [session_id],
            )
            .expect("seed old event");
        destination
            .execute_batch(
                "CREATE TRIGGER reject_new_snapshot BEFORE INSERT ON events
                 WHEN NEW.id LIKE '%~new'
                 BEGIN SELECT RAISE(ABORT,'forced commit failure'); END;",
            )
            .expect("failure trigger");
        let token = begin_replace(root, session_id, 3, 1, 1);
        let wire = v1_wire(
            1,
            &[test_event("new", EventSource::Assistant, "replacement")],
        );
        apply_page_at_root(root, backward_page(&token, 3, 1, 1, None, None, vec![wire]))
            .expect("stage replacement");
        let error = commit_at_root_with_connection(root, &token, &destination)
            .expect_err("forced publish failure");
        assert!(error.contains("forced commit failure"));
        let ids = destination
            .prepare("SELECT id FROM events WHERE session_id=?1")
            .expect("prepare retained ids")
            .query_map([session_id], |row| row.get::<_, String>(0))
            .expect("query retained ids")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect retained ids");
        assert_eq!(ids, vec!["old"]);
        assert!(!staging_path(root, &token).expect("stage path").exists());
    }
}
