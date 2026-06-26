//! OpenCode imported history reader
//!
//! Reads OpenCode's local SQLite history database and converts message parts
//! into ORGII's canonical `ActivityChunk` shape for read-only replay.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_OPENCODE},
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

const OPENCODE_SESSION_PREFIX: &str = "opencodeapp-";
const OPENCODE_PROVIDER_SLUG: &str = "opencode";
const OPENCODE_DB_FILENAME: &str = "opencode.db";
const OPENCODE_METADATA_PARSER_VERSION: i64 = 1;

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
    time_created: i64,
    time_updated: i64,
}

#[derive(Debug, Clone)]
struct OpenCodePartRow {
    part_id: String,
    message_id: String,
    role: String,
    part: OpenCodePart,
    time_created: i64,
}

#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpenCodeModelValue {
    id: String,
    model_id: String,
    provider_id: String,
}

impl Default for OpenCodeModelValue {
    fn default() -> Self {
        Self {
            id: String::new(),
            model_id: String::new(),
            provider_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
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

impl Default for OpenCodePart {
    fn default() -> Self {
        Self {
            part_type: String::new(),
            text: String::new(),
            tool: String::new(),
            call_id: String::new(),
            state: None,
            time: None,
        }
    }
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
    load_opencode_history_from_conn(&conn, session_id, source_session_id)
}

fn sync_opencode_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    let Some((conn, db_path)) = open_opencode_db()? else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_OPENCODE,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&db_path, "OpenCode")?;
    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        &db_path,
        source_mtime_ms,
        source_size_bytes,
    )?;
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let inputs = metas
        .into_iter()
        .map(session_meta_to_cache_input)
        .collect::<Vec<_>>();
    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_OPENCODE, live_ids, inputs)
}

fn list_all_opencode_session_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<OpenCodeSessionMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, directory, model, tokens_input, tokens_output, \
                    tokens_reasoning, tokens_cache_read, tokens_cache_write, \
                    time_created, time_updated \
             FROM session \
             WHERE time_archived IS NULL",
        )
        .map_err(|err| format!("Failed to prepare OpenCode session query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let input_tokens = row.get::<_, Option<i64>>(4)?.unwrap_or_default()
                + row.get::<_, Option<i64>>(7)?.unwrap_or_default()
                + row.get::<_, Option<i64>>(8)?.unwrap_or_default();
            let output_tokens = row.get::<_, Option<i64>>(5)?.unwrap_or_default()
                + row.get::<_, Option<i64>>(6)?.unwrap_or_default();
            Ok(OpenCodeSessionMeta {
                source_session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                source_path: String::new(),
                source_record_key: String::new(),
                source_mtime_ms: 0,
                source_size_bytes: 0,
                source_fingerprint: String::new(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                directory: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model: row.get(3)?,
                input_tokens,
                output_tokens,
                time_created: row.get::<_, Option<i64>>(9)?.unwrap_or_default(),
                time_updated: row.get::<_, Option<i64>>(10)?.unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to query OpenCode sessions: {err}"))?;

    let mut sessions = Vec::new();
    for row in rows {
        let mut meta = row.map_err(|err| format!("Failed to read OpenCode session row: {err}"))?;
        if meta.source_session_id.trim().is_empty() {
            continue;
        }
        meta.source_path = db_path.to_string_lossy().to_string();
        meta.source_record_key = meta.source_session_id.clone();
        meta.source_mtime_ms = source_mtime_ms;
        meta.source_size_bytes = source_size_bytes;
        meta.source_fingerprint = source_mtime_ms.to_string();
        sessions.push(meta);
    }
    Ok(sessions)
}

fn session_meta_to_cache_input(meta: OpenCodeSessionMeta) -> ImportedHistoryCacheInput {
    let model = meta.model.as_deref().and_then(parse_model_name);
    let updated_at_ms = if meta.time_updated > 0 {
        meta.time_updated
    } else {
        meta.time_created
    };
    ImportedHistoryCacheInput {
        source: SOURCE_OPENCODE,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{OPENCODE_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: OPENCODE_METADATA_PARSER_VERSION,
        name: imported_history::truncate_name(&meta.title, 200),
        created_at_ms: meta.time_created,
        updated_at_ms,
        model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        repo_path: (!meta.directory.trim().is_empty()).then_some(meta.directory),
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: true,
        source_metadata_json: None,
    }
}

fn parse_model_name(raw_model: &str) -> Option<String> {
    let trimmed = raw_model.trim();
    if trimmed.is_empty() {
        return None;
    }
    let Ok(parsed) = serde_json::from_str::<OpenCodeModelValue>(trimmed) else {
        return Some(trimmed.to_string());
    };
    if !parsed.id.trim().is_empty() {
        Some(parsed.id)
    } else if !parsed.model_id.trim().is_empty() {
        Some(parsed.model_id)
    } else if !parsed.provider_id.trim().is_empty() {
        Some(parsed.provider_id)
    } else {
        None
    }
}

fn load_opencode_history_from_conn(
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

fn load_ordered_parts(
    conn: &Connection,
    source_session_id: &str,
) -> Result<Vec<OpenCodePartRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.message_id, json_extract(m.data, '$.role'), p.data, p.time_created \
             FROM part p \
             JOIN message m ON m.id = p.message_id \
             WHERE p.session_id = ?1 \
             ORDER BY p.time_created ASC, p.id ASC",
        )
        .map_err(|err| format!("Failed to prepare OpenCode part query: {err}"))?;
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
        .map_err(|err| format!("Failed to query OpenCode parts: {err}"))?;

    let mut parts = Vec::new();
    for row in rows {
        let (part_id, message_id, role, Some(raw_data), time_created) =
            row.map_err(|err| format!("Failed to read OpenCode part row: {err}"))?
        else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<OpenCodePart>(&raw_data) else {
            continue;
        };
        parts.push(OpenCodePartRow {
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
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    match row.part.part_type.as_str() {
        "text" if row.role == "user" => text_to_user_chunk(session_id, sequence, row),
        "text" => text_to_assistant_chunk(session_id, sequence, row),
        "reasoning" => reasoning_to_chunk(session_id, sequence, row),
        "tool" => tool_to_chunk(session_id, sequence, row),
        _ => None,
    }
}

fn text_to_user_chunk(
    session_id: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::user_message_chunk(
        session_id,
        OPENCODE_PROVIDER_SLUG,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn text_to_assistant_chunk(
    session_id: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::assistant_message_chunk(
        session_id,
        OPENCODE_PROVIDER_SLUG,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn reasoning_to_chunk(
    session_id: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::thinking_chunk(
        session_id,
        OPENCODE_PROVIDER_SLUG,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn tool_to_chunk(
    session_id: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
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
    let (canonical_name, args) = normalize_opencode_tool_call(raw_name, args);
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
        OPENCODE_PROVIDER_SLUG,
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

fn normalize_opencode_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "bash" | "shell" | "execute" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "write" | "edit" | "patch" | "apply_patch" => (
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

fn tool_output_text(state: &OpenCodeToolState) -> String {
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

fn row_created_at(row: &OpenCodePartRow) -> String {
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

fn opencode_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(OPENCODE_SESSION_PREFIX) else {
        return Err(format!("Invalid OpenCode session id: {session_id}"));
    };
    if source_session_id.trim().is_empty() {
        return Err("OpenCode session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

fn open_opencode_db() -> Result<Option<(Connection, PathBuf)>, String> {
    for path in opencode_db_candidate_paths() {
        if path.is_file() {
            let conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|err| format!("Failed to open OpenCode database {}: {err}", path.display()))?;
            return Ok(Some((conn, path)));
        }
    }
    Ok(None)
}

fn opencode_db_candidate_paths() -> Vec<PathBuf> {
    let Some(home_dir) = dirs::home_dir() else {
        return Vec::new();
    };
    opencode_db_candidate_paths_for_home(&home_dir)
}

fn opencode_db_candidate_paths_for_home(home_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home_dir.join(".local").join("share").join("opencode"));

    if let Some(data_local_dir) = dirs::data_local_dir() {
        roots.push(data_local_dir.join("opencode"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        roots.push(data_dir.join("opencode"));
    }

    #[cfg(target_os = "macos")]
    {
        let app_support = home_dir.join("Library").join("Application Support");
        roots.push(app_support.join("opencode"));
        roots.push(app_support.join("OpenCode"));
        roots.push(app_support.join("ai.opencode.desktop"));
        roots.push(app_support.join("ai.opencode.desktop").join("opencode"));
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home_dir.join("AppData").join("Roaming").join("opencode"));
        roots.push(home_dir.join("AppData").join("Roaming").join("OpenCode"));
        roots.push(
            home_dir
                .join("AppData")
                .join("Roaming")
                .join("ai.opencode.desktop"),
        );
        roots.push(home_dir.join("AppData").join("Local").join("opencode"));
        roots.push(home_dir.join("AppData").join("Local").join("OpenCode"));
        roots.push(
            home_dir
                .join("AppData")
                .join("Local")
                .join("ai.opencode.desktop"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home_dir.join(".config").join("opencode"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join(OPENCODE_DB_FILENAME))
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
