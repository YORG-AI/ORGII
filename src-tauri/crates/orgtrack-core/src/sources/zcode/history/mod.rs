//! ZCode imported history reader
//!
//! ZCode (z.ai's coding agent) stores its CLI history in a single SQLite
//! database at `~/.zcode/cli/db/db.sqlite`. The schema is OpenCode-family
//! (`session` / `message` / `part`), so the transcript conversion mirrors the
//! OpenCode reader. Two structural differences are handled here:
//!   - tokens live in separate `turn_usage` / `model_usage` tables rather than
//!     on the session row, so they are aggregated per session.
//!   - a session's `task_type = 'subagent_child'` (with `parent_id` pointing at
//!     the spawning session) marks a sub-agent, which we hide from the top-level
//!     list and link to its parent — the same shape the sidebar collapses.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
        SOURCE_ZCODE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

mod discovery;
mod parts;
mod sync;

use discovery::*;
use parts::*;
use sync::*;

pub const ZCODE_SESSION_PREFIX: &str = "zcodeapp-";
const ZCODE_PROVIDER_SLUG: &str = "zcode";
const ZCODE_SUBAGENT_TASK_TYPE: &str = "subagent_child";
// v2: capture cache_read/cache_write tokens separately (input stays cache-inclusive).
const ZCODE_METADATA_PARSER_VERSION: i64 = 2;

pub type ZCodeHistorySessionRow = ImportedHistorySessionRow;
pub type ZCodeHistorySessionPage = ImportedHistorySessionPage;
pub type ZCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct ZCodeSessionMeta {
    source_session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    title: String,
    directory: String,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    time_created: i64,
    time_updated: i64,
    parent_id: Option<String>,
    is_subagent: bool,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Clone)]
struct ZCodePartRow {
    part_id: String,
    message_id: String,
    role: String,
    part: ZCodePart,
    time_created: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ZCodePart {
    #[serde(rename = "type")]
    part_type: String,
    text: String,
    tool: String,
    call_id: String,
    state: Option<ZCodeToolState>,
    time: Option<ZCodePartTime>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct ZCodeToolState {
    status: String,
    input: Value,
    output: String,
    metadata: Value,
    title: String,
}

impl Default for ZCodeToolState {
    fn default() -> Self {
        Self {
            status: String::new(),
            input: Value::Null,
            output: String::new(),
            metadata: Value::Null,
            title: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct ZCodePartTime {
    start: i64,
    end: i64,
}

pub fn list_zcode_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ZCodeHistorySessionPage, String> {
    sync_zcode_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_ZCODE, limit, offset)
}

pub fn list_zcode_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ZCodeRecentPath>, String> {
    sync_zcode_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_ZCODE, limit)
}

pub fn load_zcode_history_for_session(session_id: &str) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = zcode_source_id_from_session_id(session_id)?;
    let Some((conn, _db_path)) = open_zcode_db()? else {
        return Ok(Vec::new());
    };
    load_zcode_history_from_conn(&conn, session_id, source_session_id)
}

pub(crate) fn refresh_catalog(cache_conn: &mut Connection) -> Result<(), String> {
    sync_zcode_history_cache_inner(cache_conn, false)
}

fn load_zcode_impact_from_conn(
    conn: &Connection,
    session_id: &str,
    source_session_id: &str,
) -> Result<ImportedHistoryImpactStats, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.message_id, json_extract(m.data, '$.role'), p.data, p.time_created
             FROM part p
             JOIN message m ON m.id = p.message_id
             WHERE p.session_id = ?1
               AND json_extract(p.data, '$.type') = 'tool'
               AND lower(COALESCE(json_extract(p.data, '$.tool'), ''))
                   IN ('write', 'edit', 'patch', 'apply_patch')
             ORDER BY p.time_created ASC, p.id ASC",
        )
        .map_err(|err| format!("Failed to prepare ZCode compact impact query: {err}"))?;
    let mut rows = stmt
        .query([source_session_id])
        .map_err(|err| format!("Failed to query ZCode compact impact rows: {err}"))?;
    let mut touched = std::collections::BTreeSet::new();
    let mut impact = ImportedHistoryImpactStats::default();
    let mut sequence = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Failed to read ZCode compact impact row: {err}"))?
    {
        let Some(raw_data) = row
            .get::<_, Option<String>>(3)
            .map_err(|err| format!("Failed to read ZCode compact tool payload: {err}"))?
        else {
            continue;
        };
        let chunk = replay_chunk_from_part_json(
            session_id,
            sequence,
            row.get::<_, Option<String>>(0)
                .map_err(|err| err.to_string())?
                .unwrap_or_default(),
            row.get::<_, Option<String>>(1)
                .map_err(|err| err.to_string())?
                .unwrap_or_default(),
            row.get::<_, Option<String>>(2)
                .map_err(|err| err.to_string())?
                .unwrap_or_default(),
            &raw_data,
            row.get::<_, Option<i64>>(4)
                .map_err(|err| err.to_string())?
                .unwrap_or_default(),
        )?;
        sequence = sequence.saturating_add(1);
        let Some(chunk) = chunk else { continue };
        let one = imported_history::impact_from_edit_chunks(std::slice::from_ref(&chunk));
        impact.lines_added = impact.lines_added.saturating_add(one.lines_added);
        impact.lines_removed = impact.lines_removed.saturating_add(one.lines_removed);
        touched.extend(one.touched_files);
    }
    impact.touched_files = touched.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
    Ok(impact)
}

/// Normalize one ZCode `part` row for the bounded SQLite replay driver.
/// The caller streams rows and invokes this only for new or changed hashes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn replay_chunk_from_part_json(
    session_id: &str,
    sequence: usize,
    part_id: String,
    message_id: String,
    role: String,
    raw_data: &str,
    time_created: i64,
) -> Result<Option<ActivityChunk>, String> {
    let part = serde_json::from_str::<ZCodePart>(raw_data)
        .map_err(|err| format!("Failed to parse ZCode replay part {part_id}: {err}"))?;
    let row = ZCodePartRow {
        part_id,
        message_id,
        role,
        part,
        time_created,
    };
    Ok(part_row_to_chunk(session_id, sequence, &row))
}

/// Candidate on-disk locations for ZCode's CLI history database. Exposed so the
/// external-CLI detection layer can report the store path.
pub fn zcode_history_candidate_paths() -> Vec<PathBuf> {
    let Some(home_dir) = dirs::home_dir() else {
        return Vec::new();
    };
    zcode_history_candidate_paths_for_home(&home_dir)
}

#[cfg(test)]
#[path = "../history_tests.rs"]
mod tests;
