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
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
        SOURCE_ZCODE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

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

fn sync_zcode_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    sync_zcode_history_cache_inner(cache_conn, true)
}

fn sync_zcode_history_cache_inner(
    cache_conn: &mut Connection,
    include_legacy_impact: bool,
) -> Result<(), String> {
    let Some((conn, db_path)) = open_zcode_db()? else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_ZCODE,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&db_path, "ZCode")?;
    let metas =
        list_all_zcode_session_meta_from_conn(&conn, &db_path, source_mtime_ms, source_size_bytes)?;
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let changed_ids = imported_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_ZCODE,
        &metas,
        zcode_meta_signature,
    )?
    .into_iter()
    .map(|meta| meta.source_session_id.clone())
    .collect::<HashSet<_>>();
    let mut inputs = Vec::with_capacity(changed_ids.len());
    for mut meta in metas
        .into_iter()
        .filter(|meta| changed_ids.contains(&meta.source_session_id))
    {
        if include_legacy_impact {
            let session_id = format!("{ZCODE_SESSION_PREFIX}{}", meta.source_session_id);
            meta.impact = load_zcode_impact_from_conn(&conn, &session_id, &meta.source_session_id)?;
        } else if let Some(cached) = imported_cache::query_cached_session_from_conn(
            cache_conn,
            SOURCE_ZCODE,
            &meta.source_session_id,
        )? {
            meta.impact = cached.impact;
        }
        inputs.push(session_meta_to_cache_input(meta));
    }
    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_ZCODE, live_ids, inputs)
}

fn zcode_meta_signature(meta: &ZCodeSessionMeta) -> ImportedHistoryRecordSignature {
    ImportedHistoryRecordSignature {
        source_session_id: meta.source_session_id.clone(),
        source_path: meta.source_path.clone(),
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint.clone(),
        parser_version: ZCODE_METADATA_PARSER_VERSION,
    }
}

fn list_all_zcode_session_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<ZCodeSessionMeta>, String> {
    // Tokens live in `turn_usage` (not on the session row): input folds in the
    // cache read/creation tokens, output folds in reasoning — mirroring how the
    // OpenCode reader accounts a session's totals. `model_id` comes from the
    // most recent `model_usage` request for the session.
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.directory, s.parent_id, s.task_type, \
                    s.time_created, s.time_updated, \
                    (SELECT COALESCE(SUM(input_tokens + cache_read_input_tokens \
                        + cache_creation_input_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id), \
                    (SELECT COALESCE(SUM(output_tokens + reasoning_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id), \
                    (SELECT model_id FROM model_usage \
                     WHERE session_id = s.id AND model_id IS NOT NULL AND model_id != '' \
                     ORDER BY started_at DESC LIMIT 1), \
                    (SELECT COALESCE(SUM(cache_read_input_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id), \
                    (SELECT COALESCE(SUM(cache_creation_input_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id) \
             FROM session s \
             WHERE s.time_archived IS NULL",
        )
        .map_err(|err| format!("Failed to prepare ZCode session query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let task_type = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            Ok(ZCodeSessionMeta {
                source_session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                source_path: String::new(),
                source_record_key: String::new(),
                source_mtime_ms: 0,
                source_size_bytes: 0,
                source_fingerprint: String::new(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                directory: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model: row
                    .get::<_, Option<String>>(9)?
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                input_tokens: row.get::<_, Option<i64>>(7)?.unwrap_or_default(),
                output_tokens: row.get::<_, Option<i64>>(8)?.unwrap_or_default(),
                cache_read_tokens: row.get::<_, Option<i64>>(10)?.unwrap_or_default(),
                cache_write_tokens: row.get::<_, Option<i64>>(11)?.unwrap_or_default(),
                time_created: row.get::<_, Option<i64>>(5)?.unwrap_or_default(),
                time_updated: row.get::<_, Option<i64>>(6)?.unwrap_or_default(),
                parent_id: row
                    .get::<_, Option<String>>(3)?
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                is_subagent: task_type == ZCODE_SUBAGENT_TASK_TYPE,
                impact: ImportedHistoryImpactStats::default(),
            })
        })
        .map_err(|err| format!("Failed to query ZCode sessions: {err}"))?;

    // A single `db.sqlite` backs every session, so fold its WAL/`-shm` sidecars
    // into each session's fingerprint once.
    let sidecar_signature = imported_paths::sqlite_sidecar_signature(db_path);
    let mut sessions = Vec::new();
    for row in rows {
        let mut meta = row.map_err(|err| format!("Failed to read ZCode session row: {err}"))?;
        if meta.source_session_id.trim().is_empty() {
            continue;
        }
        meta.source_path = db_path.to_string_lossy().to_string();
        meta.source_record_key = meta.source_session_id.clone();
        meta.source_mtime_ms = source_mtime_ms;
        meta.source_size_bytes = source_size_bytes;
        meta.source_fingerprint = zcode_source_fingerprint(&meta, &sidecar_signature);
        sessions.push(meta);
    }
    Ok(sessions)
}

/// Content-aware change fingerprint for a ZCode session. The `db.sqlite` mtime
/// alone can stay flat across a same-mtime rewrite, so this folds the session's
/// own identity/title/timestamp/token/parent fields together with the shared
/// WAL/`-shm` sidecar signature.
fn zcode_source_fingerprint(meta: &ZCodeSessionMeta, sidecar_signature: &str) -> String {
    [
        meta.source_session_id.as_str(),
        meta.title.as_str(),
        meta.model.as_deref().unwrap_or_default(),
        &meta.time_created.to_string(),
        &meta.time_updated.to_string(),
        &meta.input_tokens.to_string(),
        &meta.output_tokens.to_string(),
        meta.parent_id.as_deref().unwrap_or_default(),
        sidecar_signature,
    ]
    .join("|")
}

fn session_meta_to_cache_input(meta: ZCodeSessionMeta) -> ImportedHistoryCacheInput {
    let updated_at_ms = if meta.time_updated > 0 {
        meta.time_updated
    } else {
        meta.time_created
    };
    // Sub-agents are hidden from the top-level list and linked to their parent,
    // matching the sidebar's collapse behaviour.
    let listable = !meta.is_subagent;
    let parent_session_id = if meta.is_subagent {
        meta.parent_id
            .as_deref()
            .map(|parent_id| format!("{ZCODE_SESSION_PREFIX}{parent_id}"))
    } else {
        None
    };
    ImportedHistoryCacheInput {
        source: SOURCE_ZCODE,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{ZCODE_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: ZCODE_METADATA_PARSER_VERSION,
        name: imported_history::truncate_name(&meta.title, 200),
        created_at_ms: meta.time_created,
        updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: (!meta.directory.trim().is_empty()).then_some(meta.directory),
        branch: None,
        impact: meta.impact,
        listable,
        source_metadata_json: None,
        parent_session_id,
    }
}

fn load_zcode_history_from_conn(
    conn: &Connection,
    session_id: &str,
    source_session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let parts = load_ordered_parts(conn, source_session_id)?;
    let mut chunks = Vec::new();
    for (sequence, row) in parts.iter().enumerate() {
        if let Some(chunk) = part_row_to_chunk(session_id, sequence, row) {
            chunks.push(chunk);
        }
    }
    Ok(chunks)
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

fn load_ordered_parts(
    conn: &Connection,
    source_session_id: &str,
) -> Result<Vec<ZCodePartRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.message_id, json_extract(m.data, '$.role'), p.data, p.time_created \
             FROM part p \
             JOIN message m ON m.id = p.message_id \
             WHERE p.session_id = ?1 \
             ORDER BY p.time_created ASC, p.id ASC",
        )
        .map_err(|err| format!("Failed to prepare ZCode part query: {err}"))?;
    let rows = stmt
        .query_map([source_session_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
            ))
        })
        .map_err(|err| format!("Failed to query ZCode parts: {err}"))?;

    let mut parts = Vec::new();
    for row in rows {
        let (part_id, message_id, role, Some(raw_data), time_created) =
            row.map_err(|err| format!("Failed to read ZCode part row: {err}"))?
        else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<ZCodePart>(&raw_data) else {
            continue;
        };
        parts.push(ZCodePartRow {
            part_id,
            message_id,
            role,
            part,
            time_created,
        });
    }
    Ok(parts)
}

fn part_row_to_chunk(
    session_id: &str,
    sequence: usize,
    row: &ZCodePartRow,
) -> Option<ActivityChunk> {
    match row.part.part_type.as_str() {
        "text" if row.role == "user" => text_to_user_chunk(session_id, sequence, row),
        "text" => text_to_assistant_chunk(session_id, sequence, row),
        "reasoning" => reasoning_to_chunk(session_id, sequence, row),
        "tool" => tool_to_chunk(session_id, sequence, row),
        _ => None,
    }
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

fn text_to_user_chunk(
    session_id: &str,
    sequence: usize,
    row: &ZCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::user_message_chunk(
        session_id,
        ZCODE_PROVIDER_SLUG,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn text_to_assistant_chunk(
    session_id: &str,
    sequence: usize,
    row: &ZCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::assistant_message_chunk(
        session_id,
        ZCODE_PROVIDER_SLUG,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn reasoning_to_chunk(
    session_id: &str,
    sequence: usize,
    row: &ZCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::thinking_chunk(
        session_id,
        ZCODE_PROVIDER_SLUG,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn tool_to_chunk(session_id: &str, sequence: usize, row: &ZCodePartRow) -> Option<ActivityChunk> {
    let state = row.part.state.as_ref()?;
    let raw_name = row.part.tool.trim();
    if raw_name.is_empty() {
        return None;
    }
    let call_id = if row.part.call_id.trim().is_empty() {
        row.part_id.clone()
    } else {
        row.part.call_id.clone()
    };
    let args = state.input.clone();
    let (canonical_name, args) = normalize_zcode_tool_call(raw_name, args);
    let call = ImportedToolCall {
        call_id,
        raw_name: raw_name.to_string(),
        canonical_name,
        args,
        created_at: row_created_at(row),
    };
    let output = tool_output_text(state);
    let mut chunk = imported_history::tool_call_chunk(
        session_id,
        ZCODE_PROVIDER_SLUG,
        sequence,
        &call,
        &output,
    );
    if let Some(result_obj) = chunk.result.as_object_mut() {
        if !state.status.trim().is_empty() {
            result_obj.insert("status".to_string(), Value::String(state.status.clone()));
        }
        if !state.title.trim().is_empty() {
            result_obj.insert("title".to_string(), Value::String(state.title.clone()));
        }
        if !row.message_id.trim().is_empty() {
            result_obj.insert(
                "message_id".to_string(),
                Value::String(row.message_id.clone()),
            );
        }
    }
    Some(chunk)
}

/// Map ZCode's tool names onto ORGII's canonical functions. ZCode uses
/// Claude-Code-style capitalized names (`Bash`, `Edit`, `Write`), so the match
/// is case-insensitive.
fn normalize_zcode_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name.to_lowercase().as_str() {
        "bash" | "shell" | "execute" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "write" | "edit" | "multiedit" | "patch" | "apply_patch" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "command": command,
        "cmd": command,
        "payload": args,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("filePath")
        .and_then(Value::as_str)
        .or_else(|| args.get("file_path").and_then(Value::as_str))
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn tool_output_text(state: &ZCodeToolState) -> String {
    if !state.output.trim().is_empty() {
        return state.output.clone();
    }
    state
        .metadata
        .get("output")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default()
}

fn row_created_at(row: &ZCodePartRow) -> String {
    let timestamp = row
        .part
        .time
        .as_ref()
        .map(|time| {
            if time.start > 0 {
                time.start
            } else if time.end > 0 {
                time.end
            } else {
                row.time_created
            }
        })
        .unwrap_or(row.time_created);
    imported_history::epoch_ms_to_iso(timestamp)
}

fn zcode_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(ZCODE_SESSION_PREFIX) else {
        return Err(format!("Invalid ZCode session id: {session_id}"));
    };
    if source_session_id.trim().is_empty() {
        return Err("ZCode session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

fn open_zcode_db() -> Result<Option<(Connection, PathBuf)>, String> {
    for path in zcode_history_candidate_paths() {
        if path.is_file() {
            let conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|err| format!("Failed to open ZCode database {}: {err}", path.display()))?;
            return Ok(Some((conn, path)));
        }
    }
    Ok(None)
}

/// Candidate on-disk locations for ZCode's CLI history database. Exposed so the
/// external-CLI detection layer can report the store path.
pub fn zcode_history_candidate_paths() -> Vec<PathBuf> {
    let Some(home_dir) = dirs::home_dir() else {
        return Vec::new();
    };
    zcode_history_candidate_paths_for_home(&home_dir)
}

fn zcode_history_candidate_paths_for_home(home_dir: &Path) -> Vec<PathBuf> {
    // ZCode's CLI keeps its store at `~/.zcode/cli/db/db.sqlite` on every
    // platform (`%USERPROFILE%\.zcode\...` on Windows).
    vec![home_dir
        .join(".zcode")
        .join("cli")
        .join("db")
        .join("db.sqlite")]
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
