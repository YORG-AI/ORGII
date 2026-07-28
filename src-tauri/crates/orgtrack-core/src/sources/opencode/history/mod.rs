//! OpenCode imported history reader
//!
//! Reads OpenCode's local SQLite history database and converts message parts
//! into ORGII's canonical `ActivityChunk` shape for read-only replay.

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
        SOURCE_OPENCODE,
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

pub const OPENCODE_SESSION_PREFIX: &str = "opencodeapp-";
const OPENCODE_PROVIDER_SLUG: &str = "opencode";
const OPENCODE_DB_FILENAME: &str = "opencode.db";
// Version 4 adds per-session file-impact extraction from normalized edit parts.
// v5: capture cache_read/cache_write tokens separately (input stays cache-inclusive).
const OPENCODE_METADATA_PARSER_VERSION: i64 = 5;

pub type OpenCodeHistorySessionRow = ImportedHistorySessionRow;
pub type OpenCodeHistorySessionPage = ImportedHistorySessionPage;
pub type OpenCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct OpenCodeSessionMeta {
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
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Clone)]
struct OpenCodePartRow {
    part_id: String,
    message_id: String,
    role: String,
    part: OpenCodePart,
    time_created: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpenCodeModelValue {
    id: String,
    model_id: String,
    provider_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpenCodePart {
    #[serde(rename = "type")]
    part_type: String,
    text: String,
    tool: String,
    call_id: String,
    state: Option<OpenCodeToolState>,
    time: Option<OpenCodePartTime>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct OpenCodeToolState {
    status: String,
    input: Value,
    output: String,
    metadata: Value,
    title: String,
}

impl Default for OpenCodeToolState {
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
struct OpenCodePartTime {
    start: i64,
    end: i64,
}

pub fn list_opencode_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<OpenCodeHistorySessionPage, String> {
    sync_opencode_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_OPENCODE, limit, offset)
}

pub fn list_opencode_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<OpenCodeRecentPath>, String> {
    sync_opencode_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_OPENCODE, limit)
}

pub fn load_opencode_history_for_session(session_id: &str) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = opencode_source_id_from_session_id(session_id)?;
    let Some((conn, _db_path)) = open_opencode_db()? else {
        return Ok(Vec::new());
    };
    load_opencode_compatible_history_from_conn(
        &conn,
        session_id,
        source_session_id,
        OPENCODE_PROVIDER_SLUG,
    )
}

/// Parse the message/part schema shared by OpenCode-compatible stores.
///
/// Mimo Code persists the same normalized part records in its own SQLite
/// database, so its importer supplies a distinct provider slug while sharing
/// this conversion path.
pub(crate) fn load_opencode_compatible_history_from_conn(
    conn: &Connection,
    session_id: &str,
    source_session_id: &str,
    provider_slug: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let parts = load_ordered_parts(conn, source_session_id)?;
    let mut chunks = Vec::new();
    for (sequence, row) in parts.iter().enumerate() {
        if let Some(chunk) = part_row_to_chunk(session_id, provider_slug, sequence, row) {
            chunks.push(chunk);
        }
    }
    Ok(chunks)
}

#[cfg(test)]
fn load_opencode_history_from_conn(
    conn: &Connection,
    session_id: &str,
    source_session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    load_opencode_compatible_history_from_conn(
        conn,
        session_id,
        source_session_id,
        OPENCODE_PROVIDER_SLUG,
    )
}

#[cfg(test)]
fn text_to_user_chunk(
    session_id: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    text_to_user_chunk_with_provider(session_id, OPENCODE_PROVIDER_SLUG, sequence, row)
}

#[cfg(test)]
#[path = "../history_tests.rs"]
mod tests;
