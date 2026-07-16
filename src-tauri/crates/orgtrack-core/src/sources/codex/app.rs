//! Codex app event reader
//!
//! Reads Codex rollout JSONL files from `~/.codex/sessions/YYYY/MM/DD/` and
//! converts them into ORGII's canonical `ActivityChunk` shape. These rows are
//! imported history only: ORGII does not own the Codex process or write back to
//! Codex's local files.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_CODEX_APP,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

const CODEX_APP_SESSION_PREFIX: &str = "codexapp-";
const CODEX_PROVIDER_SLUG: &str = "codex";
const CODEX_APP_METADATA_PARSER_VERSION: i64 = 8;

pub type CodexAppSessionRow = ImportedHistorySessionRow;
pub type CodexAppSessionPage = ImportedHistorySessionPage;
pub type CodexAppRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct CodexAppSessionMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    parent_session_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: Option<String>,
    repo_path: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Deserialize)]
struct CodexJsonlLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "type")]
    line_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct CodexTurnContextPayload {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
}

#[derive(Debug, Clone)]
struct CodexSessionIndexEntry {
    thread_name: String,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexSessionIndexLine {
    #[serde(default)]
    id: String,
    #[serde(default)]
    thread_name: String,
    #[serde(default)]
    updated_at: Option<String>,
}

pub fn list_codex_app_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CodexAppSessionPage, String> {
    sync_codex_app_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CODEX_APP, limit, offset)
}

pub fn list_codex_app_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<CodexAppRecentPath>, String> {
    sync_codex_app_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CODEX_APP, limit)
}

pub fn load_codex_app_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = codex_file_stem_from_session_id(session_id)?;
    let path = resolve_codex_session_path(conn, file_stem)?;
    load_codex_app_from_path(session_id, &path)
}

fn sync_codex_app_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_codex_app_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_CODEX_APP, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_codex_session_meta(record)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CODEX_APP,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_codex_app_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut sessions = Vec::new();
    for sessions_dir in codex_sessions_dirs()? {
        if sessions_dir.is_dir() {
            let title_index = load_codex_session_index_for_sessions_dir(&sessions_dir)?;
            let mut files = Vec::new();
            collect_codex_session_files(&sessions_dir, &mut files)?;
            for path in files {
                let Some(file_stem) = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(ToString::to_string)
                else {
                    continue;
                };
                let (source_mtime_ms, source_size_bytes) =
                    imported_paths::file_metadata_signature(&path, "Codex")?;
                let source_fingerprint = codex_source_fingerprint(&file_stem, &title_index);
                sessions.push(ImportedHistoryDiscoveredRecord {
                    source_session_id: file_stem.clone(),
                    source_path: path,
                    source_record_key: file_stem,
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint,
                    parser_version: CODEX_APP_METADATA_PARSER_VERSION,
                });
            }
        }
    }
    Ok(sessions)
}

fn collect_codex_session_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Codex dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Codex dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_codex_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            out.push(path);
        }
    }
    Ok(())
}

fn load_codex_session_index_for_sessions_dir(
    sessions_dir: &Path,
) -> Result<HashMap<String, CodexSessionIndexEntry>, String> {
    let Some(root) = sessions_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_codex_session_index(&root.join("session_index.jsonl"))
}

fn load_codex_session_index(
    index_path: &Path,
) -> Result<HashMap<String, CodexSessionIndexEntry>, String> {
    let mut entries = HashMap::new();
    if !index_path.is_file() {
        return Ok(entries);
    }

    let file = fs::File::open(index_path).map_err(|err| {
        format!(
            "Failed to open Codex session index {}: {err}",
            index_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line.map_err(|err| {
            format!(
                "Failed to read Codex session index {}: {err}",
                index_path.display()
            )
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexSessionIndexLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let id = parsed.id.trim();
        let thread_name = parsed.thread_name.trim();
        if id.is_empty() || thread_name.is_empty() {
            continue;
        }
        entries.insert(
            id.to_string(),
            CodexSessionIndexEntry {
                thread_name: thread_name.to_string(),
                updated_at: parsed.updated_at,
            },
        );
    }

    Ok(entries)
}

fn codex_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, CodexSessionIndexEntry>,
) -> String {
    codex_title_entry_for_file_stem(file_stem, title_index)
        .map(|entry| {
            format!(
                "session-index:{}:{}",
                entry.updated_at.as_deref().unwrap_or_default(),
                entry.thread_name
            )
        })
        .unwrap_or_default()
}

fn codex_session_index_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(index_path) = codex_index_path_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_codex_session_index(&index_path)?;
    Ok(
        codex_title_entry_for_file_stem(&record.source_record_key, &title_index)
            .map(|entry| imported_history::truncate_name(&entry.thread_name, 200))
            .unwrap_or_default(),
    )
}

fn codex_index_path_for_session_path(session_path: &Path) -> Option<PathBuf> {
    codex_sessions_dir_for_session_path(session_path).and_then(|sessions_dir| {
        sessions_dir
            .parent()
            .map(|root| root.join("session_index.jsonl"))
    })
}

fn codex_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path
        .ancestors()
        .find(|ancestor| ancestor.file_name().and_then(|name| name.to_str()) == Some("sessions"))
        .map(Path::to_path_buf)
}

fn codex_title_entry_for_file_stem<'a>(
    file_stem: &str,
    title_index: &'a HashMap<String, CodexSessionIndexEntry>,
) -> Option<&'a CodexSessionIndexEntry> {
    codex_thread_id_from_file_stem(file_stem).and_then(|thread_id| title_index.get(thread_id))
}

fn codex_thread_id_from_file_stem(file_stem: &str) -> Option<&str> {
    if is_uuid_like(file_stem) {
        return Some(file_stem);
    }
    if file_stem.len() < 36 {
        return None;
    }
    let candidate = &file_stem[file_stem.len() - 36..];
    is_uuid_like(candidate).then_some(candidate)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

fn parse_codex_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<CodexAppSessionMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Codex history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut external_title = codex_session_index_title_for_record(record)?;
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();
    let mut parent_thread_id: Option<String> = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if let Some(timestamp) = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            if timestamp > updated_at_ms {
                updated_at_ms = timestamp;
            }
        }
        if first_prompt.is_empty() {
            if let Some(message) = user_message_from_payload(&parsed.payload) {
                first_prompt = imported_history::truncate_name(&message, 200);
            }
        }
        if external_title.is_empty() && parsed.line_type == "session_meta" {
            if let Some(title) = session_title_from_payload(&parsed.payload) {
                external_title = imported_history::truncate_name(&title, 200);
            }
        }
        if parent_thread_id.is_none() && parsed.line_type == "session_meta" {
            parent_thread_id = parent_thread_id_from_session_meta_payload(
                &parsed.payload,
                codex_thread_id_from_file_stem(&record.source_record_key),
            );
        }
        if model.is_none() || repo_path.is_none() {
            if let Ok(turn_context) =
                serde_json::from_value::<CodexTurnContextPayload>(parsed.payload.clone())
            {
                if model.is_none() && !turn_context.model.trim().is_empty() {
                    model = Some(turn_context.model);
                }
                if repo_path.is_none() && !turn_context.cwd.trim().is_empty() {
                    repo_path = Some(turn_context.cwd);
                }
            }
        }
        if parsed.payload.get("type").and_then(Value::as_str) == Some("token_count") {
            if let Some(total_usage) = parsed.payload.get("total_token_usage") {
                input_tokens = total_usage
                    .get("input_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(input_tokens);
                output_tokens = total_usage
                    .get("output_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(output_tokens);
            }
        }
        collect_codex_impact_from_payload(&parsed.payload, &mut impact, &mut touched_files);
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    let name = if !external_title.is_empty() {
        external_title
    } else if first_prompt.is_empty() {
        record.source_record_key.clone()
    } else {
        first_prompt
    };
    Ok(Some(CodexAppSessionMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: format!("{CODEX_APP_SESSION_PREFIX}{}", record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        parent_session_id: parent_thread_id
            .as_deref()
            .and_then(|thread_id| codex_parent_session_id_for_record(record, thread_id)),
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            record.source_mtime_ms
        },
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            record.source_mtime_ms
        },
        model,
        repo_path,
        input_tokens,
        output_tokens,
        impact,
    }))
}

fn session_meta_to_cache_input(meta: CodexAppSessionMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CODEX_APP,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        repo_path: meta.repo_path,
        branch: None,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: meta.parent_session_id,
    }
}

fn parent_thread_id_from_session_meta_payload(
    payload: &Value,
    current_thread_id: Option<&str>,
) -> Option<String> {
    let is_subagent = payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || payload.pointer("/source/subagent").is_some();
    if !is_subagent {
        return None;
    }

    let direct_candidates = [
        payload.get("parent_thread_id"),
        payload.pointer("/source/subagent/thread_spawn/parent_thread_id"),
        payload.get("forked_from_id"),
        payload.get("session_id"),
    ];

    for candidate in direct_candidates {
        if let Some(parent_thread_id) = candidate
            .and_then(Value::as_str)
            .and_then(|value| normalize_parent_thread_id_candidate(value, current_thread_id))
        {
            return Some(parent_thread_id);
        }
    }
    None
}

fn normalize_parent_thread_id_candidate(
    value: &str,
    current_thread_id: Option<&str>,
) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || Some(trimmed) == current_thread_id {
        return None;
    }
    Some(trimmed.to_string())
}

fn codex_parent_session_id_for_record(
    record: &ImportedHistoryDiscoveredRecord,
    parent_thread_id: &str,
) -> Option<String> {
    let parent_file_stem =
        codex_file_stem_for_thread_id_near_session(&record.source_path, parent_thread_id)?;
    Some(format!("{CODEX_APP_SESSION_PREFIX}{parent_file_stem}"))
}

fn codex_file_stem_for_thread_id_near_session(
    session_path: &Path,
    thread_id: &str,
) -> Option<String> {
    let sessions_dir = codex_sessions_dir_for_session_path(session_path)?;
    let mut files = Vec::new();
    collect_codex_session_files(&sessions_dir, &mut files).ok()?;
    files.into_iter().find_map(|path| {
        let file_stem = path.file_stem().and_then(|value| value.to_str())?;
        (codex_thread_id_from_file_stem(file_stem) == Some(thread_id))
            .then(|| file_stem.to_string())
    })
}

fn collect_codex_impact_from_payload(
    payload: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let Some(payload_type) = payload.get("type").and_then(Value::as_str) else {
        return;
    };
    let patch = match payload_type {
        "function_call" if payload.get("name").and_then(Value::as_str) == Some("apply_patch") => {
            payload
                .get("arguments")
                .and_then(Value::as_str)
                .map(imported_history::parse_inner_json)
                .and_then(|args| patch_from_codex_args(&args))
        }
        "custom_tool_call"
            if payload.get("name").and_then(Value::as_str) == Some("apply_patch") =>
        {
            payload
                .get("input")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        _ => None,
    };
    if let Some(patch) = patch {
        accumulate_patch_impact(&patch, impact, touched_files);
    }
}

fn patch_from_codex_args(args: &Value) -> Option<String> {
    args.get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("input").and_then(Value::as_str))
        .map(str::to_string)
}

fn accumulate_patch_impact(
    patch: &str,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    for line in patch.lines() {
        if let Some(path) = patch_file_path_from_line(line) {
            touched_files.insert(path);
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            impact.lines_added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            impact.lines_removed += 1;
        }
    }
}

fn patch_file_path_from_line(line: &str) -> Option<String> {
    for prefix in [
        "*** Add File:",
        "*** Update File:",
        "*** Modify File:",
        "*** Delete File:",
    ] {
        if let Some(path) = line.strip_prefix(prefix) {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    if let Some(rest) = line.strip_prefix("diff --git ") {
        let mut parts = rest.split_whitespace();
        let _old_path = parts.next();
        return parts.next().and_then(normalize_patch_path);
    }
    line.strip_prefix("+++ ")
        .and_then(normalize_patch_path)
        .filter(|path| path != "/dev/null")
}

fn normalize_patch_path(path: &str) -> Option<String> {
    let normalized = path
        .strip_prefix("b/")
        .or_else(|| path.strip_prefix("a/"))
        .unwrap_or(path)
        .trim();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_string())
    }
}

fn load_codex_app_from_path(session_id: &str, path: &Path) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, Vec<ImportedToolCall>> = HashMap::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let Some(payload_type) = parsed.payload.get("type").and_then(Value::as_str) else {
            continue;
        };

        match payload_type {
            "user_message" => {
                if let Some(message) = user_message_from_payload(&parsed.payload) {
                    chunks.push(imported_history::user_message_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &message,
                    ));
                    sequence += 1;
                }
            }
            "agent_message" => {
                if let Some(message) = parsed.payload.get("message").and_then(Value::as_str) {
                    chunks.push(imported_history::assistant_message_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        message,
                    ));
                    sequence += 1;
                }
            }
            "message" => {
                if parsed.payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(text) = content_text_from_payload(&parsed.payload) {
                        chunks.push(imported_history::assistant_message_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            &text,
                        ));
                        sequence += 1;
                    }
                }
            }
            "reasoning" | "agent_reasoning" => {
                if let Some(text) = reasoning_text_from_payload(&parsed.payload) {
                    chunks.push(imported_history::thinking_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "function_call" => {
                if let Some((call_id, calls)) =
                    pending_tool_calls_from_payload(&parsed.payload, &created_at)
                {
                    pending_tool_calls.insert(call_id, calls);
                }
            }
            "custom_tool_call" => {
                if let Some((call_id, calls)) =
                    pending_custom_tool_calls_from_payload(&parsed.payload, &created_at)
                {
                    pending_tool_calls.insert(call_id, calls);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = parsed.payload.get("call_id").and_then(Value::as_str);
                if let Some(call_id) = call_id {
                    if let Some(calls) = pending_tool_calls.remove(call_id) {
                        let output = parsed
                            .payload
                            .get("output")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let outputs = output_parts_for_tool_calls(&calls, output);
                        for (call, output) in calls.iter().zip(outputs.iter()) {
                            chunks.push(codex_tool_call_chunk(session_id, sequence, call, output));
                            sequence += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for calls in pending_tool_calls.into_values() {
        for call in calls {
            chunks.push(codex_tool_call_chunk(session_id, sequence, &call, ""));
            sequence += 1;
        }
    }

    Ok(chunks)
}

fn codex_tool_call_chunk(
    session_id: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
) -> ActivityChunk {
    let mut chunk =
        imported_history::tool_call_chunk(session_id, CODEX_PROVIDER_SLUG, sequence, call, output);
    if call.canonical_name == imported_history::FUNCTION_CODE_SEARCH {
        if let Some(result) = chunk.result.as_object_mut() {
            result.insert("content".to_string(), Value::String(output.to_string()));
            let matches = parse_rg_output_matches(output)
                .into_iter()
                .map(|(file, line, content)| {
                    json!({
                        "file": file,
                        "line": line,
                        "content": content,
                    })
                })
                .collect::<Vec<_>>();
            result.insert("matches".to_string(), Value::Array(matches));
        }
    }
    chunk
}

fn output_parts_for_tool_calls(calls: &[ImportedToolCall], output: &str) -> Vec<String> {
    if calls.len() <= 1 {
        return vec![output.to_string()];
    }

    let limits = calls
        .iter()
        .map(read_line_limit_from_call)
        .collect::<Option<Vec<_>>>();
    let Some(limits) = limits else {
        return vec![output.to_string(); calls.len()];
    };

    let lines = output.split_inclusive('\n').collect::<Vec<_>>();
    let mut cursor = 0usize;
    calls
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let remaining = lines.len().saturating_sub(cursor);
            let take = if index + 1 == calls.len() {
                remaining
            } else {
                limits[index].min(remaining)
            };
            let part = lines[cursor..cursor.saturating_add(take)].concat();
            cursor = cursor.saturating_add(take);
            part
        })
        .collect()
}

fn read_line_limit_from_call(call: &ImportedToolCall) -> Option<usize> {
    if call.canonical_name != imported_history::FUNCTION_READ_FILE {
        return None;
    }
    call.args
        .get("limit")
        .and_then(Value::as_i64)
        .and_then(|value| usize::try_from(value).ok())
}

fn pending_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let arguments = payload
        .get("arguments")
        .and_then(Value::as_str)
        .map(imported_history::parse_inner_json)
        .unwrap_or_else(|| json!({}));
    let normalized_calls = normalize_codex_tool_calls(&raw_name, arguments);
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

fn pending_custom_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let input = payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = if raw_name == "apply_patch" {
        json!({ "patch": input })
    } else {
        json!({ "input": input })
    };
    let normalized_calls = normalize_codex_tool_calls(&raw_name, args);
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

fn split_call_id(call_id: &str, index: usize, total: usize) -> String {
    if total <= 1 {
        call_id.to_string()
    } else {
        format!("{call_id}:part-{index}")
    }
}

fn normalize_codex_tool_calls(raw_name: &str, args: Value) -> Vec<(String, Value)> {
    let key = normalize_tool_name_key(raw_name);
    match key.as_str() {
        "shell" | "shell_command" | "bash" | "terminal" | "terminal_command" | "run_shell"
        | "run_command" | "execute" | "exec" => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_arg_values_from_shell_args(&shell_args) {
                read_args
                    .into_iter()
                    .map(|args| (imported_history::FUNCTION_READ_FILE.to_string(), args))
                    .collect()
            } else if let Some(search_args) = rg_search_args_from_shell_args(&shell_args) {
                vec![(
                    imported_history::FUNCTION_CODE_SEARCH.to_string(),
                    search_args,
                )]
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "rg" | "ripgrep" | "grep" | "search" | "code_search" | "search_code"
        | "search_codebase" => vec![(
            imported_history::FUNCTION_CODE_SEARCH.to_string(),
            normalize_search_args(args),
        )],
        "cat" | "sed" | "head" | "tail" => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_args_from_shell_args(&shell_args) {
                vec![(imported_history::FUNCTION_READ_FILE.to_string(), read_args)]
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "apply_patch" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_apply_patch_args(args),
        )],
        "edit" | "edit_file" | "write" | "write_file" | "create_file" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        )],
        _ => vec![(raw_name.to_string(), args)],
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| args.get("workdir").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "command": command.clone(),
        "cmd": command,
        "cwd": cwd.clone(),
        "workdir": cwd,
        "payload": args,
    })
}

fn normalize_apply_patch_args(args: Value) -> Value {
    let patch = args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let file_path = first_apply_patch_file_path(&patch).unwrap_or_default();
    json!({
        "action": "apply_patch",
        "patch": patch.clone(),
        "patch_text": patch,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "payload": args,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    if args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .is_some()
    {
        return normalize_apply_patch_args(args);
    }

    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("target_file").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let old_content = args
        .get("old_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("old_str").and_then(Value::as_str))
        .or_else(|| args.get("old_string").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let new_content = args
        .get("new_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("new_str").and_then(Value::as_str))
        .or_else(|| args.get("new_string").and_then(Value::as_str))
        .or_else(|| args.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    json!({
        "action": raw_name,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "old_content": old_content.clone(),
        "new_content": new_content.clone(),
        "content": new_content,
        "payload": args,
    })
}

fn normalize_search_args(args: Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("pattern").and_then(Value::as_str))
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("regex").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "payload": args,
    })
}

fn read_file_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    read_file_arg_values_from_shell_args(shell_args)?
        .into_iter()
        .next()
}

fn read_file_arg_values_from_shell_args(shell_args: &Value) -> Option<Vec<Value>> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }

    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let commands = split_shell_read_command_chain(command)?;
    let command_count = commands.len();
    let mut read_args_values = Vec::with_capacity(command_count);

    for (index, command_part) in commands.iter().enumerate() {
        let tokens = shell_tokens(command_part);
        let read_args = read_file_args_from_tokens(&tokens)?;
        if command_count > 1 && read_args.limit.is_none() {
            return None;
        }
        let mut value = shell_read_args_to_value(
            read_args,
            command_part,
            &cwd,
            shell_args,
            command,
            index,
            command_count,
        );
        if command_count == 1 {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("source_command");
                obj.remove("command_index");
                obj.remove("command_count");
            }
        }
        read_args_values.push(value);
    }

    if read_args_values.is_empty() {
        None
    } else {
        Some(read_args_values)
    }
}

fn shell_read_args_to_value(
    read_args: ShellReadArgs,
    command: &str,
    cwd: &str,
    shell_args: &Value,
    source_command: &str,
    command_index: usize,
    command_count: usize,
) -> Value {
    json!({
        "path": read_args.path.clone(),
        "file_path": read_args.path.clone(),
        "target_file": read_args.path,
        "offset": read_args.offset,
        "limit": read_args.limit,
        "command": command,
        "source_command": source_command,
        "command_index": command_index,
        "command_count": command_count,
        "cwd": cwd,
        "payload": shell_args.clone(),
    })
}

struct ShellReadArgs {
    path: String,
    offset: Option<i64>,
    limit: Option<i64>,
}

fn split_shell_read_command_chain(command: &str) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            current.push(ch);
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            continue;
        }

        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_command_part(&mut parts, &mut current)?;
            }
            '|' if chars.peek() == Some(&'|') => return None,
            ';' => {
                push_shell_command_part(&mut parts, &mut current)?;
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }
    push_shell_command_part(&mut parts, &mut current)?;
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn push_shell_command_part(parts: &mut Vec<String>, current: &mut String) -> Option<()> {
    let part = current.trim();
    if part.is_empty() {
        return None;
    }
    parts.push(part.to_string());
    current.clear();
    Some(())
}

fn read_file_args_from_tokens(tokens: &[String]) -> Option<ShellReadArgs> {
    if tokens.is_empty() {
        return None;
    }
    if let Some(read_args) = read_file_args_from_nl_sed_pipeline(tokens) {
        return Some(read_args);
    }
    if tokens.iter().any(|token| is_shell_separator(token)) {
        return None;
    }

    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    match executable {
        "cat" => read_file_args_from_cat(&tokens[1..]),
        "sed" => read_file_args_from_sed(&tokens[1..]),
        "head" => read_file_args_from_head_tail(&tokens[1..], true),
        "tail" => read_file_args_from_head_tail(&tokens[1..], false),
        _ => None,
    }
}

fn read_file_args_from_nl_sed_pipeline(tokens: &[String]) -> Option<ShellReadArgs> {
    if tokens
        .iter()
        .any(|token| matches!(token.as_str(), "&&" | "||" | ";"))
    {
        return None;
    }

    let mut pipe_indices = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "|").then_some(index));
    let pipe_index = pipe_indices.next()?;
    if pipe_indices.next().is_some() || pipe_index == 0 || pipe_index + 1 >= tokens.len() {
        return None;
    }

    let path = read_file_path_from_nl(&tokens[..pipe_index])?;
    let (offset, limit) = read_range_from_pipeline_sed(&tokens[(pipe_index + 1)..])?;
    Some(ShellReadArgs {
        path,
        offset,
        limit,
    })
}

fn read_file_path_from_nl(tokens: &[String]) -> Option<String> {
    if tokens.is_empty() {
        return None;
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    if executable != "nl" {
        return None;
    }

    let mut paths = Vec::new();
    let mut index = 1usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "--" {
            paths.extend(tokens[(index + 1)..].iter().cloned());
            break;
        }
        if token.starts_with('-') {
            index += if nl_option_consumes_next(token) { 2 } else { 1 };
            continue;
        }
        paths.push(token.to_string());
        index += 1;
    }

    single_shell_path_arg(&paths)
}

fn nl_option_consumes_next(token: &str) -> bool {
    matches!(
        token,
        "-b" | "-d" | "-f" | "-h" | "-i" | "-l" | "-n" | "-s" | "-v" | "-w"
    ) || matches!(
        token,
        "--body-numbering"
            | "--section-delimiter"
            | "--footer-numbering"
            | "--header-numbering"
            | "--line-increment"
            | "--join-blank-lines"
            | "--number-format"
            | "--number-separator"
            | "--starting-line-number"
            | "--number-width"
    )
}

fn read_range_from_pipeline_sed(tokens: &[String]) -> Option<(Option<i64>, Option<i64>)> {
    if tokens.is_empty() {
        return None;
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    if executable != "sed" {
        return None;
    }

    let mut index = 1usize;
    let mut has_quiet = false;
    let mut range_expr: Option<&str> = None;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--quiet" | "--silent" => {
                has_quiet = true;
                index += 1;
            }
            "-e" | "--expression" => {
                range_expr = tokens.get(index + 1).map(String::as_str);
                index += 2;
            }
            _ if token.starts_with('-') => return None,
            _ if range_expr.is_none() => {
                range_expr = Some(token);
                index += 1;
            }
            _ => return None,
        }
    }

    if !has_quiet {
        return None;
    }
    sed_range_to_offset_limit(range_expr?)
}

fn read_file_args_from_cat(tokens: &[String]) -> Option<ShellReadArgs> {
    let paths = shell_path_args(
        tokens,
        &["-n", "-b", "-s", "-v", "-e", "-t", "-A", "--number"],
    )?;
    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset: None,
        limit: None,
    })
}

fn read_file_args_from_sed(tokens: &[String]) -> Option<ShellReadArgs> {
    let mut index = 0usize;
    let mut has_quiet = false;
    let mut range_expr: Option<&str> = None;
    let mut paths: Vec<String> = Vec::new();

    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--quiet" | "--silent" => {
                has_quiet = true;
                index += 1;
            }
            "-e" | "--expression" => {
                range_expr = tokens.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--" => {
                paths.extend(tokens[(index + 1)..].iter().cloned());
                break;
            }
            _ if token.starts_with('-') => return None,
            _ if range_expr.is_none() => {
                range_expr = Some(token);
                index += 1;
            }
            _ => {
                paths.push(token.to_string());
                index += 1;
            }
        }
    }

    if !has_quiet {
        return None;
    }
    let (offset, limit) = sed_range_to_offset_limit(range_expr?)?;
    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset,
        limit,
    })
}

fn read_file_args_from_head_tail(tokens: &[String], is_head: bool) -> Option<ShellReadArgs> {
    let mut index = 0usize;
    let mut line_count: Option<i64> = None;
    let mut paths = Vec::new();

    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--lines" => {
                line_count = tokens
                    .get(index + 1)
                    .and_then(|value| value.trim_start_matches('+').parse::<i64>().ok());
                index += 2;
            }
            "--" => {
                paths.extend(tokens[(index + 1)..].iter().cloned());
                break;
            }
            _ if token.starts_with("-n") && token.len() > 2 => {
                line_count = token[2..].trim_start_matches('+').parse::<i64>().ok();
                index += 1;
            }
            _ if token.starts_with("--lines=") => {
                line_count = token
                    .trim_start_matches("--lines=")
                    .trim_start_matches('+')
                    .parse::<i64>()
                    .ok();
                index += 1;
            }
            _ if token.starts_with('-') => return None,
            _ => {
                paths.push(token.to_string());
                index += 1;
            }
        }
    }

    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset: if is_head { Some(0) } else { None },
        limit: line_count,
    })
}

fn shell_path_args(tokens: &[String], flag_allowlist: &[&str]) -> Option<Vec<String>> {
    let mut paths = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "--" {
            paths.extend(tokens[(index + 1)..].iter().cloned());
            break;
        }
        if token.starts_with('-') {
            if flag_allowlist.contains(&token) {
                index += 1;
                continue;
            }
            return None;
        }
        paths.push(token.to_string());
        index += 1;
    }
    Some(paths)
}

fn single_shell_path_arg(paths: &[String]) -> Option<String> {
    if paths.len() != 1 {
        return None;
    }
    let path = paths[0].trim();
    if path.is_empty() || path == "-" {
        return None;
    }
    Some(path.to_string())
}

fn sed_range_to_offset_limit(expr: &str) -> Option<(Option<i64>, Option<i64>)> {
    let expr = expr.trim().trim_end_matches(';');
    if expr.contains('/') || expr.contains('s') {
        return None;
    }
    let mut parts = expr
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let first_part = parts.next()?;
    let (offset, limit) = sed_single_range_to_offset_limit(first_part)?;
    for part in parts {
        sed_single_range_to_offset_limit(part)?;
    }
    if expr.contains(';') {
        return Some((offset, None));
    }
    Some((offset, limit))
}

fn sed_single_range_to_offset_limit(expr: &str) -> Option<(Option<i64>, Option<i64>)> {
    if !expr.ends_with('p') {
        return None;
    }
    let range = expr.trim_end_matches('p').trim();
    if let Some((start_raw, end_raw)) = range.split_once(',') {
        let start = start_raw.trim().parse::<i64>().ok()?;
        let end = end_raw.trim().parse::<i64>().ok()?;
        if start < 1 || end < start {
            return None;
        }
        return Some((Some(start - 1), Some(end - start + 1)));
    }
    let line = range.parse::<i64>().ok()?;
    if line < 1 {
        return None;
    }
    Some((Some(line - 1), Some(1)))
}

fn normalize_tool_name_key(raw_name: &str) -> String {
    raw_name
        .trim()
        .strip_prefix("mcp_orgii_")
        .unwrap_or_else(|| raw_name.trim())
        .chars()
        .map(|ch| match ch {
            '-' | ' ' | '.' => '_',
            _ => ch.to_ascii_lowercase(),
        })
        .collect()
}

fn rg_search_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }

    let tokens = shell_tokens(command);
    let rg_index = tokens.iter().enumerate().find_map(|(index, token)| {
        if !is_rg_executable(token) {
            return None;
        }
        if index == 0
            || tokens
                .get(index.saturating_sub(1))
                .is_some_and(|prev| is_shell_separator(prev))
        {
            Some(index)
        } else {
            None
        }
    })?;

    let query =
        rg_pattern_from_tokens(&tokens[(rg_index + 1)..]).unwrap_or_else(|| command.to_string());
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "command": command,
        "cwd": cwd,
        "payload": shell_args.clone(),
    }))
}

fn shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("&&".to_string());
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("||".to_string());
            }
            ';' | '|' => {
                push_shell_token(&mut tokens, &mut current);
                tokens.push(ch.to_string());
            }
            ch if ch.is_whitespace() => push_shell_token(&mut tokens, &mut current),
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    push_shell_token(&mut tokens, &mut current);
    tokens
}

fn push_shell_token(tokens: &mut Vec<String>, current: &mut String) {
    if current.is_empty() {
        return;
    }
    tokens.push(std::mem::take(current));
}

fn is_shell_separator(token: &str) -> bool {
    matches!(token, "&&" | "||" | ";" | "|")
}

fn is_rg_executable(token: &str) -> bool {
    let executable = token.rsplit('/').next().unwrap_or(token);
    matches!(executable, "rg" | "ripgrep" | "grep")
}

fn rg_pattern_from_tokens(tokens: &[String]) -> Option<String> {
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if is_shell_separator(token) {
            return None;
        }
        if token == "--" {
            return tokens.get(index + 1).cloned();
        }
        if token == "-e" || token == "--regexp" {
            return tokens.get(index + 1).cloned();
        }
        if let Some(rest) = token.strip_prefix("-e") {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
        if rg_flag_consumes_next(token) {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(token.to_string());
    }
    None
}

fn rg_flag_consumes_next(token: &str) -> bool {
    matches!(
        token,
        "-g" | "--glob"
            | "-t"
            | "--type"
            | "-T"
            | "--type-not"
            | "-C"
            | "--context"
            | "-A"
            | "--after-context"
            | "-B"
            | "--before-context"
            | "-m"
            | "--max-count"
            | "--sort"
            | "--sort-files"
    )
}

fn first_apply_patch_file_path(patch: &str) -> Option<String> {
    for line in patch.lines() {
        if let Some(path) = patch_file_path_from_line(line) {
            if path != "/dev/null" {
                return Some(path);
            }
        }
    }
    None
}

fn parse_rg_output_matches(output: &str) -> Vec<(String, i64, String)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            let file = parts.next()?.trim();
            let line_number = parts.next()?.parse::<i64>().ok()?;
            let content = parts.next().unwrap_or_default();
            if file.is_empty() {
                return None;
            }
            Some((file.to_string(), line_number, content.to_string()))
        })
        .collect()
}

fn user_message_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("message")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn session_title_from_payload(payload: &Value) -> Option<String> {
    [
        "title",
        "name",
        "threadName",
        "thread_name",
        "conversationTitle",
        "conversation_title",
    ]
    .iter()
    .filter_map(|key| payload.get(*key).and_then(Value::as_str))
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn content_text_from_payload(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(content_part_text)
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

fn content_part_text(part: &Value) -> Option<String> {
    part.get("text")
        .and_then(Value::as_str)
        .or_else(|| part.get("content").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn reasoning_text_from_payload(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let summary = payload.get("summary")?.as_array()?;
    let parts = summary
        .iter()
        .filter_map(content_part_text)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn codex_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CODEX_APP_SESSION_PREFIX) else {
        return Err(format!("Invalid Codex app session id: {session_id}"));
    };
    if file_stem.is_empty() {
        return Err("Codex app session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

fn resolve_codex_session_path(conn: &Connection, file_stem: &str) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CODEX_APP, file_stem)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for sessions_dir in codex_sessions_dirs()? {
        if sessions_dir.is_dir() {
            collect_codex_session_files(&sessions_dir, &mut files)?;
        }
    }
    files
        .into_iter()
        .find(|path| path.file_stem().and_then(|value| value.to_str()) == Some(file_stem))
        .ok_or_else(|| format!("Codex app file not found for session: {file_stem}"))
}

fn codex_sessions_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(codex_sessions_dir_candidates(&home))
}

fn codex_sessions_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".codex"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Codex"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("codex"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Codex"));
        roots.push(home.join("AppData").join("Roaming").join("codex"));
        roots.push(home.join("AppData").join("Local").join("Codex"));
        roots.push(home.join("AppData").join("Local").join("codex"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("codex"));
        roots.push(home.join(".local").join("share").join("codex"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("sessions"))
        .collect()
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
