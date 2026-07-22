//! Qoder imported-history reader
//!
//! Reads Qoder's per-project conversation-history store (see the module docs
//! for the on-disk layout) and converts each transcript into ORGII's canonical
//! `ActivityChunk` shape for read-only replay. The transcript lines carry
//! Anthropic-style content blocks, so tool calls and their results are paired
//! back together like the Cline reader does.
//!
//! Task directory names are only unique within one project cache dir (they are
//! truncated task-id prefixes), so the source session id is the composite
//! `<project-dir>/<task-dir>` — directory names cannot contain `/`, which makes
//! the split-back unambiguous.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        ImportedHistoryRecordSignature, SOURCE_QODER,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

const CATALOG_PREFIX_BYTES: u64 = 1024 * 1024;

pub const QODER_SESSION_PREFIX: &str = "qoderapp-";
const QODER_PROVIDER_SLUG: &str = "qoder";
// Version 2 derives per-session file impact from the chat-editing snapshot
// store (the transcript itself carries no edit data).
const QODER_METADATA_PARSER_VERSION: i64 = 2;
const CONVERSATION_HISTORY_DIR: &str = "conversation-history";
/// Global-storage key holding the quest task list (title/status/timestamps).
const QUEST_SNAPSHOT_KEY: &str = "aicoding.questTaskListSnapshot";
/// Cap a single tool-result body so a runaway command output can't bloat the
/// cache/replay payload. The replay UI virtualizes long text anyway.
pub(super) const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;

pub type QoderHistorySessionRow = ImportedHistorySessionRow;
pub type QoderHistorySessionPage = ImportedHistorySessionPage;
pub type QoderRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct QoderHistoryMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    repo_path: Option<String>,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Clone)]
struct QoderDiscoveredRecord {
    record: ImportedHistoryDiscoveredRecord,
    snapshot: Option<QoderQuestTask>,
}

impl QoderDiscoveredRecord {
    fn signature(&self) -> ImportedHistoryRecordSignature {
        self.record.signature()
    }
}

/// One task entry from the `aicoding.questTaskListSnapshot` global-storage key.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct QoderQuestTask {
    id: String,
    name: String,
    title: String,
    query: String,
    create_time: i64,
    updated_at_timestamp: i64,
    last_user_query_at: i64,
    file_path: String,
}

/// One transcript JSONL line: `{role, message:{content:[blocks]}}`.
#[derive(Debug, Default, Deserialize)]
struct QoderTranscriptLine {
    #[serde(default)]
    role: String,
    #[serde(default)]
    message: QoderTranscriptMessage,
}

#[derive(Debug, Default, Deserialize)]
struct QoderTranscriptMessage {
    #[serde(default)]
    content: Value,
}

pub fn list_qoder_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<QoderHistorySessionPage, String> {
    sync_qoder_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_QODER, limit, offset)
}

pub fn list_qoder_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<QoderRecentPath>, String> {
    sync_qoder_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_QODER, limit)
}

pub fn load_qoder_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = qoder_source_id_from_session_id(session_id)?;
    let path = resolve_qoder_transcript_path(conn, source_session_id)?;
    let transcript = read_qoder_transcript(&path)?;
    let chunks = transcript_to_chunks(session_id, &transcript);
    // Best-effort: recover the tool trajectory from Qoder's per-launch logs
    // (see the log_enrichment module docs for what survives there). The
    // cached workspace path sharpens invoke attribution when available.
    let (project_dir_name, task_dir_name) = source_session_id
        .split_once('/')
        .unwrap_or(("", source_session_id));
    let workspace_path =
        imported_cache::query_cached_session_from_conn(conn, SOURCE_QODER, source_session_id)
            .ok()
            .flatten()
            .and_then(|cached| cached.repo_path);
    Ok(super::log_enrichment::enrich_with_agent_log(
        session_id,
        task_dir_name,
        project_dir_name,
        workspace_path.as_deref(),
        chunks,
    ))
}

pub(crate) fn refresh_catalog(conn: &mut Connection) -> Result<(), String> {
    sync_qoder_history_cache(conn)
}

fn sync_qoder_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_qoder_history_records()?;
    let signatures = discovered
        .iter()
        .map(QoderDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_QODER, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for discovered in changed {
        if imported_cache::advance_cached_catalog_record_from_conn(
            conn,
            SOURCE_QODER,
            &discovered.record,
            None,
        )? {
            continue;
        }
        inputs.push(session_meta_to_cache_input(parse_qoder_session_meta(
            discovered,
        )));
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_QODER,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_qoder_history_records() -> Result<Vec<QoderDiscoveredRecord>, String> {
    let snapshot_tasks = read_quest_snapshot_tasks();
    let mut records = Vec::new();
    for projects_dir in qoder_projects_dirs()? {
        records.extend(discover_records_in_projects_dir(
            &projects_dir,
            &snapshot_tasks,
        )?);
    }
    Ok(records)
}

fn discover_records_in_projects_dir(
    projects_dir: &Path,
    snapshot_tasks: &[QoderQuestTask],
) -> Result<Vec<QoderDiscoveredRecord>, String> {
    let mut records = Vec::new();
    if !projects_dir.is_dir() {
        return Ok(records);
    }
    let Ok(project_entries) = fs::read_dir(projects_dir) else {
        return Ok(records);
    };
    for project_entry in project_entries.flatten() {
        let project_dir = project_entry.path();
        let Some(project_dir_name) = project_dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let history_dir = project_dir.join(CONVERSATION_HISTORY_DIR);
        let Ok(task_entries) = fs::read_dir(&history_dir) else {
            continue;
        };
        for task_entry in task_entries.flatten() {
            let task_dir = task_entry.path();
            let Some(task_dir_name) = task_dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let transcript_path = task_dir.join(format!("{task_dir_name}.jsonl"));
            if !transcript_path.is_file() {
                continue;
            }
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&transcript_path, "Qoder")?;
            let snapshot =
                match_snapshot_task(snapshot_tasks, project_dir_name, task_dir_name).cloned();
            let source_session_id = format!("{project_dir_name}/{task_dir_name}");
            // Fold in the edit-store signature so edits landing after a sync
            // re-parse the session even when the transcript is unchanged.
            let source_fingerprint = format!(
                "{}|edits:{}",
                snapshot
                    .as_ref()
                    .map(quest_task_fingerprint)
                    .unwrap_or_default(),
                super::log_enrichment::edit_store_signature(
                    task_dir_name,
                    snapshot.as_ref().map(|task| task.id.as_str()),
                ),
            );
            records.push(QoderDiscoveredRecord {
                record: ImportedHistoryDiscoveredRecord {
                    source_session_id: source_session_id.clone(),
                    source_path: transcript_path,
                    source_record_key: source_session_id,
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint,
                    parser_version: QODER_METADATA_PARSER_VERSION,
                },
                snapshot,
            });
        }
    }
    Ok(records)
}

/// Match a conversation-history dir to its quest-snapshot entry. The task dir
/// name is a truncated prefix of the full quest id, and the project cache dir
/// is `<workspace-basename>-<hash>`, so require both to line up.
fn match_snapshot_task<'a>(
    tasks: &'a [QoderQuestTask],
    project_dir_name: &str,
    task_dir_name: &str,
) -> Option<&'a QoderQuestTask> {
    tasks.iter().find(|task| {
        !task.id.is_empty()
            && task.id.starts_with(task_dir_name)
            && project_dir_matches_workspace(project_dir_name, &task.file_path)
    })
}

fn project_dir_matches_workspace(project_dir_name: &str, workspace_path: &str) -> bool {
    let Some(basename) = Path::new(workspace_path.trim())
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    project_dir_name
        .strip_prefix(basename)
        .is_some_and(|rest| rest.starts_with('-'))
}

/// Fields that feed name/timestamps/repo-path, so a snapshot-side change
/// (rename, new activity) re-parses the session even when the JSONL is
/// untouched.
fn quest_task_fingerprint(task: &QoderQuestTask) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        task.id,
        task.name,
        task.title,
        task.query,
        task.create_time,
        task.updated_at_timestamp,
        task.last_user_query_at,
        task.file_path,
    )
}

fn parse_qoder_session_meta(discovered: &QoderDiscoveredRecord) -> QoderHistoryMeta {
    let record = &discovered.record;
    let snapshot = discovered.snapshot.as_ref();

    // The signature mtime is nanoseconds (see `file_metadata_signature`);
    // scale it down where a real epoch-ms value is needed.
    let mtime_ms = record.source_mtime_ms / 1_000_000;
    let created_at_ms = snapshot
        .map(|task| task.create_time)
        .filter(|ms| *ms > 0)
        .unwrap_or(mtime_ms);
    let updated_at_ms = snapshot
        .map(|task| task.updated_at_timestamp.max(task.last_user_query_at))
        .filter(|ms| *ms > 0)
        .unwrap_or(mtime_ms);

    let name = snapshot
        .and_then(|task| {
            [&task.title, &task.name, &task.query]
                .into_iter()
                .map(|value| value.trim())
                .find(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| first_user_text_from_path(&record.source_path))
        .map(|value| imported_history::truncate_name(&value, 200))
        .unwrap_or_else(|| record.source_session_id.clone());

    let repo_path = snapshot
        .map(|task| task.file_path.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let session_id = format!("{QODER_SESSION_PREFIX}{}", record.source_session_id);
    // Edits live in Qoder's compact snapshot store. Catalog refresh must not
    // deserialize the whole JSONL merely to search for a hypothetical
    // fallback edit block; the bounded replay adapter owns transcript bodies.
    let task_dir_name = record
        .source_session_id
        .split_once('/')
        .map(|(_, task)| task)
        .unwrap_or(record.source_session_id.as_str());
    let edit_impact = super::log_enrichment::session_edit_impact(
        task_dir_name,
        snapshot.map(|task| task.id.as_str()),
    );
    let impact = edit_impact;

    QoderHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        created_at_ms,
        updated_at_ms,
        repo_path,
        impact,
    }
}

fn session_meta_to_cache_input(meta: QoderHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_QODER,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: QODER_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        // The transcript/snapshot carry no per-session model or token usage.
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: meta.repo_path,
        branch: None,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

fn transcript_to_chunks(
    session_id: &str,
    transcript: &[QoderTranscriptLine],
) -> Vec<ActivityChunk> {
    // Pass 1: collect tool results so each `tool_use` can be paired with the
    // matching `tool_result` regardless of which later line carried it.
    let mut tool_outputs: HashMap<String, Value> = HashMap::new();
    let mut tool_failures: HashMap<String, bool> = HashMap::new();
    for line in transcript {
        for block in content_blocks(&line.message.content) {
            if block_type(block) == "tool_result" {
                if let Some(id) = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    tool_failures.insert(
                        id.to_string(),
                        block.get("is_error").and_then(Value::as_bool) == Some(true),
                    );
                    tool_outputs.insert(
                        id.to_string(),
                        block.get("content").cloned().unwrap_or(Value::Null),
                    );
                }
            }
        }
    }

    // Pass 2: emit chunks in transcript order. The lines carry no timestamps,
    // so chunk `created_at` stays empty and replay falls back to sequence
    // order.
    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    for line in transcript {
        let is_user = line.role == "user";
        for block in content_blocks(&line.message.content) {
            match block_type(block) {
                "text" => {
                    let raw = block.get("text").and_then(Value::as_str).unwrap_or("");
                    let text = if is_user {
                        extract_user_query(raw)
                    } else {
                        raw.trim().to_string()
                    };
                    if text.is_empty() {
                        continue;
                    }
                    if is_user {
                        chunks.push(imported_history::user_message_chunk(
                            session_id,
                            QODER_PROVIDER_SLUG,
                            sequence,
                            "",
                            &text,
                        ));
                    } else {
                        chunks.push(imported_history::assistant_message_chunk(
                            session_id,
                            QODER_PROVIDER_SLUG,
                            sequence,
                            "",
                            &text,
                        ));
                    }
                    sequence += 1;
                }
                "thinking" => {
                    let thought = block
                        .get("thinking")
                        .or_else(|| block.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if thought.is_empty() {
                        continue;
                    }
                    chunks.push(imported_history::thinking_chunk(
                        session_id,
                        QODER_PROVIDER_SLUG,
                        sequence,
                        "",
                        thought,
                    ));
                    sequence += 1;
                }
                "tool_use" => {
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let raw_name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let output = value_to_text(tool_outputs.get(&call_id));
                    let call = ImportedToolCall {
                        call_id: call_id.clone(),
                        raw_name: raw_name.clone(),
                        // Qoder's tool vocabulary is not mapped yet; pass the
                        // raw name through so the replay renders a generic
                        // tool card instead of dropping the call.
                        canonical_name: raw_name,
                        args: block.get("input").cloned().unwrap_or(Value::Null),
                        created_at: String::new(),
                    };
                    let mut chunk = imported_history::tool_call_chunk(
                        session_id,
                        QODER_PROVIDER_SLUG,
                        sequence,
                        &call,
                        &output,
                    );
                    if tool_failures.get(&call_id).copied().unwrap_or_default() {
                        if let Some(result) = chunk.result.as_object_mut() {
                            result.insert("success".to_string(), Value::Bool(false));
                            result
                                .insert("status".to_string(), Value::String("failed".to_string()));
                        }
                    }
                    chunks.push(chunk);
                    sequence += 1;
                }
                // `tool_result` blocks were consumed in pass 1.
                _ => {}
            }
        }
    }

    chunks
}

/// Qoder wraps the typed prompt as `<user_query>…</user_query>` behind
/// injected `<system-reminder>` blocks (locale directives etc.). Unwrap to the
/// inner query; when the wrapper is absent, just drop the reminder blocks.
fn extract_user_query(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(start) = trimmed.find("<user_query>") {
        let after = &trimmed[start + "<user_query>".len()..];
        let inner = after
            .find("</user_query>")
            .map(|end| &after[..end])
            .unwrap_or(after);
        return inner.trim().to_string();
    }
    strip_system_reminders(trimmed)
}

fn strip_system_reminders(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<system-reminder>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</system-reminder>") {
            Some(end) => rest = &rest[start + end + "</system-reminder>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn read_qoder_transcript(path: &Path) -> Result<Vec<QoderTranscriptLine>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to open Qoder history {}: {err}", path.display()))?;
    // Tolerate individual malformed lines (e.g. a torn tail write) instead of
    // failing the whole transcript.
    Ok(raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

/// Content is normally an array of blocks; tolerate anything else as empty.
fn content_blocks(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

fn first_user_text(transcript: &[QoderTranscriptLine]) -> Option<String> {
    for line in transcript {
        if line.role != "user" {
            continue;
        }
        for block in content_blocks(&line.message.content) {
            if block_type(block) == "text" {
                let text =
                    extract_user_query(block.get("text").and_then(Value::as_str).unwrap_or(""));
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn first_user_text_from_path(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file.take(CATALOG_PREFIX_BYTES)).lines() {
        let Ok(line) = line else { continue };
        let Ok(parsed) = serde_json::from_str::<QoderTranscriptLine>(line.trim()) else {
            continue;
        };
        if let Some(text) = first_user_text(std::slice::from_ref(&parsed)) {
            return Some(text);
        }
    }
    None
}

/// Flatten a `tool_result.content` value (string, array of blocks, or object)
/// into readable text, capped so a huge output can't bloat the payload.
fn value_to_text(value: Option<&Value>) -> String {
    let mut out = String::new();
    if let Some(value) = value {
        append_value_text(value, &mut out);
    }
    let out = out.trim();
    if out.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        let truncated: String = out.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
        format!("{truncated}\n… (truncated)")
    } else {
        out.to_string()
    }
}

fn append_value_text(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => push_line(out, text),
        Value::Array(items) => {
            for item in items {
                append_value_text(item, out);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get("text") {
                push_line(out, text);
            } else if let Some(Value::String(text)) = map.get("result") {
                push_line(out, text);
            } else {
                push_line(out, &value.to_string());
            }
        }
        Value::Null => {}
        other => push_line(out, &other.to_string()),
    }
}

fn push_line(out: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(text);
}

/// Best-effort read of the quest task list from Qoder's global `state.vscdb`.
/// The running app may hold the database, so any failure degrades to "no
/// enrichment" instead of failing discovery.
fn read_quest_snapshot_tasks() -> Vec<QoderQuestTask> {
    qoder_global_state_db_candidates()
        .into_iter()
        .filter(|path| path.is_file())
        .find_map(|path| read_quest_snapshot_tasks_from_db(&path).ok())
        .unwrap_or_default()
}

fn read_quest_snapshot_tasks_from_db(path: &Path) -> Result<Vec<QoderQuestTask>, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("Failed to open Qoder state db {}: {err}", path.display()))?;
    let raw = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [QUEST_SNAPSHOT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Qoder quest snapshot: {err}"))?;
    Ok(raw
        .as_deref()
        .map(parse_quest_snapshot_tasks)
        .unwrap_or_default())
}

/// Snapshot shape: `{version, updatedAt, folders: {<key>: {tasks: [task…]}}}`.
fn parse_quest_snapshot_tasks(raw: &str) -> Vec<QoderQuestTask> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(folders) = value.get("folders").and_then(Value::as_object) else {
        return Vec::new();
    };
    folders
        .values()
        .filter_map(|folder| folder.get("tasks").and_then(Value::as_array))
        .flatten()
        .filter_map(|task| serde_json::from_value(task.clone()).ok())
        .collect()
}

fn qoder_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(rest) = session_id.strip_prefix(QODER_SESSION_PREFIX) else {
        return Err(format!("Invalid Qoder history session id: {session_id}"));
    };
    if rest.is_empty() {
        return Err("Qoder history session id is missing its source id".to_string());
    }
    Ok(rest)
}

fn resolve_qoder_transcript_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_QODER, source_session_id)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    // Directory names cannot contain '/', so the composite splits cleanly.
    if let Some((project_dir_name, task_dir_name)) = source_session_id.split_once('/') {
        for projects_dir in qoder_projects_dirs()? {
            let candidate = projects_dir
                .join(project_dir_name)
                .join(CONVERSATION_HISTORY_DIR)
                .join(task_dir_name)
                .join(format!("{task_dir_name}.jsonl"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "Qoder history file not found for session: {source_session_id}"
    ))
}

/// Existing-store probe locations for the Data Sources inventory.
pub fn qoder_history_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.extend(qoder_projects_dir_candidates(&home));
    }
    paths.extend(qoder_global_state_db_candidates());
    imported_paths::dedupe_paths(paths)
}

fn qoder_projects_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(qoder_projects_dir_candidates(&home))
}

/// `~/.qoder/cache/projects` — the per-project conversation-history root.
fn qoder_projects_dir_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".qoder").join("cache").join("projects")]
}

/// VS Code-family per-user data root: `Qoder/User/globalStorage/state.vscdb`.
fn qoder_global_state_db_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data) = dirs::data_dir() {
        roots.push(data);
    }
    if let Some(config) = dirs::config_dir() {
        roots.push(config);
    }
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .map(|root| {
            root.join("Qoder")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb")
        })
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
