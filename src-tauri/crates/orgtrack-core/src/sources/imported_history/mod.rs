pub mod cache;
pub mod metadata;
pub mod paths;

use std::collections::HashMap;
use std::path::Path;

use chrono::TimeZone;
use core_types::activity::ActivityChunk;
use serde::Serialize;
use serde_json::{json, Value};

pub const IMPORTED_HISTORY_CATEGORY: &str = "external_history";
pub const IMPORTED_STATUS_COMPLETED: &str = "completed";
pub const ACTION_TYPE_RAW: &str = "raw";
pub const ACTION_TYPE_ASSISTANT: &str = "assistant";
pub const ACTION_TYPE_THINKING: &str = "thinking";
pub const ACTION_TYPE_TOOL_CALL: &str = "tool_call";
pub const FUNCTION_USER_MESSAGE: &str = "user_message";
pub const FUNCTION_ASSISTANT: &str = "assistant";
pub const FUNCTION_THINKING: &str = "thinking";
pub const FUNCTION_READ_FILE: &str = "read_file";
pub const FUNCTION_RUN_COMMAND_LINE: &str = "run_command_line";
pub const FUNCTION_EDIT_FILE: &str = "edit_file_by_replace";
pub const FUNCTION_CODE_SEARCH: &str = "grep";
pub const DEFAULT_LIST_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySessionRow {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub category: &'static str,
    pub read_only: bool,
    pub model: Option<String>,
    pub total_tokens: i64,
    pub background: bool,
    pub is_active: bool,
    pub repo_path: Option<String>,
    pub storage_path: Option<String>,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySessionPage {
    pub sessions: Vec<ImportedHistorySessionRow>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistoryRecentPath {
    pub path: String,
    pub name: Option<String>,
    pub last_used_at: String,
    pub session_count: usize,
}

pub struct ImportedHistoryRowInput {
    pub session_id: String,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub repo_path: Option<String>,
    pub storage_path: Option<String>,
    pub branch: Option<String>,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImportedToolCall {
    pub call_id: String,
    pub raw_name: String,
    pub canonical_name: String,
    pub args: Value,
    pub created_at: String,
}

pub fn effective_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_LIST_LIMIT
    } else {
        limit
    }
}

pub fn page_from_rows(
    mut rows: Vec<ImportedHistorySessionRow>,
    limit: usize,
    offset: usize,
) -> ImportedHistorySessionPage {
    rows.sort_by(|session_a, session_b| session_b.updated_at.cmp(&session_a.updated_at));
    let limit = effective_limit(limit);
    let has_more = rows.len() > offset.saturating_add(limit);
    let sessions = rows.into_iter().skip(offset).take(limit).collect();
    ImportedHistorySessionPage { sessions, has_more }
}

pub fn row_from_input(input: ImportedHistoryRowInput) -> ImportedHistorySessionRow {
    let repo_name = input.repo_path.as_deref().and_then(repo_name_from_path);
    ImportedHistorySessionRow {
        session_id: input.session_id,
        name: input.name,
        status: IMPORTED_STATUS_COMPLETED.to_string(),
        created_at: epoch_ms_to_iso(input.created_at_ms),
        updated_at: epoch_ms_to_iso(input.updated_at_ms),
        category: IMPORTED_HISTORY_CATEGORY,
        read_only: true,
        model: input.model,
        total_tokens: input.input_tokens + input.output_tokens,
        background: false,
        is_active: false,
        repo_path: input.repo_path,
        storage_path: input.storage_path,
        repo_name,
        branch: input.branch,
        files_changed: input.files_changed,
        lines_added: input.lines_added,
        lines_removed: input.lines_removed,
        touched_files: input.touched_files,
        parent_session_id: input.parent_session_id,
    }
}

pub fn recent_paths_from_rows(
    rows: &[ImportedHistorySessionRow],
) -> Vec<ImportedHistoryRecentPath> {
    let paths = rows
        .iter()
        .filter_map(|row| {
            let path = row.repo_path.as_deref()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(ImportedHistoryRecentPath {
                path: path.to_string(),
                name: repo_name_from_path(path),
                last_used_at: row.updated_at.clone(),
                session_count: 1,
            })
        })
        .collect::<Vec<_>>();
    recent_paths_from_paths(&paths)
}

pub fn recent_paths_from_paths(
    paths: &[ImportedHistoryRecentPath],
) -> Vec<ImportedHistoryRecentPath> {
    let mut path_stats: HashMap<String, (Option<String>, String, usize)> = HashMap::new();

    for recent_path in paths {
        let path = recent_path.path.trim();
        if path.is_empty() {
            continue;
        }

        let entry = path_stats.entry(path.to_string()).or_insert_with(|| {
            (
                recent_path
                    .name
                    .clone()
                    .or_else(|| repo_name_from_path(path)),
                recent_path.last_used_at.clone(),
                0,
            )
        });
        if recent_path.last_used_at > entry.1 {
            entry.1 = recent_path.last_used_at.clone();
        }
        entry.2 += recent_path.session_count;
    }

    let mut recent_paths = path_stats
        .into_iter()
        .map(
            |(path, (name, last_used_at, session_count))| ImportedHistoryRecentPath {
                name,
                path,
                last_used_at,
                session_count,
            },
        )
        .collect::<Vec<_>>();
    recent_paths.sort_by(|path_a, path_b| path_b.last_used_at.cmp(&path_a.last_used_at));
    recent_paths
}

pub fn user_message_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    message: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_RAW, FUNCTION_USER_MESSAGE);
    chunk.chunk_id = format!("{provider_slug}-user-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "type": "user",
        "message": { "content": message, "role": "user" },
    });
    chunk
}

pub fn assistant_message_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    message: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_ASSISTANT, FUNCTION_ASSISTANT);
    chunk.chunk_id = format!("{provider_slug}-asst-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "observation": message,
        "content": message,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
    });
    chunk
}

pub fn thinking_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    thought: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_THINKING, FUNCTION_THINKING);
    chunk.chunk_id = format!("{provider_slug}-thinking-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "thought": thought,
        "content": thought,
        "observation": thought,
        "is_delta": false,
    });
    chunk
}

pub fn tool_call_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_TOOL_CALL, &call.canonical_name);
    chunk.chunk_id = format!("{provider_slug}-tool-{sequence}-{}", call.call_id);
    chunk.created_at = call.created_at.clone();
    chunk.args = call.args.clone();
    chunk.result = json!({
        "success": true,
        "status": IMPORTED_STATUS_COMPLETED,
        "call_id": call.call_id,
        "output": output,
        "observation": output,
        "raw_tool_name": call.raw_name,
    });
    chunk
}

pub fn parse_inner_json(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or_else(|_| json!({ "input": raw }))
}

pub fn parse_iso_to_epoch_ms_opt(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

pub fn normalize_created_at(raw: &str) -> String {
    if raw.is_empty() {
        return chrono::Utc::now().to_rfc3339();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        dt.with_timezone(&chrono::Utc).to_rfc3339()
    } else {
        raw.to_string()
    }
}

pub fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::Utc
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

pub fn repo_name_from_path(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
}

pub fn truncate_name(name: &str, max_len: usize) -> String {
    let trimmed = name.trim();
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(max_len.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}
