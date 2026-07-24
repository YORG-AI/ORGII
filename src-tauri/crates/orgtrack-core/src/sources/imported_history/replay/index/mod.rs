//! ORGII-owned compact replay index synchronization and bounded queries.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::Utc;
use core_types::activity::ActivityChunk;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};

use super::{
    codex_jsonl, jsonl_driver, payload_artifact, qoder_sidecar, sqlite_driver, structured_driver,
    whole_json_driver, ImportedHistorySourceId, ReplayChunkDelta, ReplayChunkScan,
    ReplayChunkWindow, ReplayCursor, ReplayIndexedChunk, ReplayLimits,
    ReplayPayloadArtifactLocator, ReplayPayloadDescriptor, ReplayPayloadRange, ReplayStats,
    ReplayTurnHeader, HARD_MAX_PAYLOAD_RANGE_BYTES,
};

/// Replay indexing can touch hundreds of MiB inside one atomic generation
/// transaction. The application-wide SQLite default permits a 64 MiB page
/// cache, which lets dirty replay-index pages alone exceed the #443 process
/// growth budget. This connection-local cap keeps the atomic transaction but
/// makes its resident cache explicitly byte-bounded.
const REPLAY_INDEX_CACHE_KIB: i64 = 16 * 1024;

fn begin_replay_write_transaction<'conn>(
    conn: &'conn mut Connection,
    context: &str,
) -> Result<Transaction<'conn>, String> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("start {context} transaction: {err}"))
}

#[derive(Debug, Clone)]
pub(super) struct ReplayIndexState {
    pub generation: String,
    pub revision: u64,
    pub parser_version: u32,
    pub source_identity: String,
    pub driver_cursor_json: String,
    pub indexed_size_bytes: u64,
    pub indexed_mtime_ns: i64,
    pub total_events: u64,
    pub total_turns: u64,
    pub state_updated_at_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ReplaySyncResult {
    pub stats: ReplayStats,
    pub generation_changed: bool,
}

#[derive(Debug)]
pub(super) struct ResolvedSource {
    pub(super) source_session_id: String,
    pub(super) path: PathBuf,
}

#[derive(Debug, Clone)]
struct SourcePhysicalSnapshot {
    identity: String,
    size_bytes: u64,
    mtime_ns: i64,
    sample_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RejectedSnapshotKind {
    ClineInvalidDocument,
    CursorCliLineageChanged,
}

impl RejectedSnapshotKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ClineInvalidDocument => "cline_invalid_document",
            Self::CursorCliLineageChanged => "cursor_cli_lineage_changed",
        }
    }
}

struct DriverSyncOutcome {
    stats: ReplayStats,
    driver_cursor_json: String,
    indexed_size_bytes: u64,
    total_events: u64,
    total_turns: u64,
    removed_event_ids: Vec<String>,
}

mod payload;
mod query;
mod source_identity;
mod sync;

pub(super) use payload::{materialize_payload_artifact, read_payload_range};
pub(super) use query::{
    hydrate_turn_if_needed, read_delta, read_recent_window, read_scan_after, read_window_before,
    read_window_for_turn, read_window_for_turn_index,
};
#[cfg(test)]
pub(super) use source_identity::take_file_sample_count;
pub(super) use source_identity::{load_state, resolve_source};
pub(super) use sync::sync_index;

#[cfg(test)]
#[path = "../tests/index.rs"]
mod tests;
