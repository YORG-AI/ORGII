//! Claude Code imported history reader
//!
//! Reads Claude Code JSONL transcripts from `~/.claude/projects/*/*.jsonl` and
//! converts them into ORGII's canonical `ActivityChunk` shape for read-only
//! replay.

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
        SOURCE_CLAUDE_CODE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

const CLAUDE_CODE_SESSION_PREFIX: &str = "claudecodeapp-";
const CLAUDE_CODE_PROVIDER_SLUG: &str = "claudecode";
const CLAUDE_CODE_METADATA_PARSER_VERSION: i64 = 3;

pub type ClaudeCodeHistorySessionRow = ImportedHistorySessionRow;
pub type ClaudeCodeHistorySessionPage = ImportedHistorySessionPage;
pub type ClaudeCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct ClaudeCodeHistoryMeta {
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
    model: Option<String>,
    repo_path: Option<String>,
    branch: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeJsonlLine {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    git_branch: String,
    #[serde(default)]
    message: Option<ClaudeMessage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    #[serde(default)]
    model: String,
    #[serde(default)]
    content: Value,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
struct ClaudeSessionTitle {
    name: String,
    name_source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionMetadataFile {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_source: Option<String>,
}

#[derive(Debug, Clone)]
struct ClaudeCodeSessionFile {
    file_stem: String,
    path: PathBuf,
}

pub fn list_claude_code_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ClaudeCodeHistorySessionPage, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CLAUDE_CODE, limit, offset)
}

pub fn list_claude_code_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ClaudeCodeRecentPath>, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CLAUDE_CODE, limit)
}

pub fn load_claude_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    load_claude_code_history_from_path(session_id, &path)
}

fn sync_claude_code_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_claude_code_history_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        &discovered,
        |record| record.signature(),
    )?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_claude_session_meta(record)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_claude_code_history_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    for projects_dir in claude_projects_dirs()? {
        if projects_dir.is_dir() {
            let title_index = load_claude_session_titles_for_projects_dir(&projects_dir)?;
            let mut files = Vec::new();
            collect_claude_session_files(&projects_dir, &mut files)?;
            for file in files {
                let (source_mtime_ms, source_size_bytes) =
                    imported_paths::file_metadata_signature(&file.path, "Claude")?;
                records.push(ImportedHistoryDiscoveredRecord {
                    source_session_id: file.file_stem.clone(),
                    source_path: file.path,
                    source_record_key: file.file_stem.clone(),
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint: claude_source_fingerprint(&file.file_stem, &title_index),
                    parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
                });
            }
        }
    }
    Ok(records)
}

fn collect_claude_session_files(
    dir: &Path,
    out: &mut Vec<ClaudeCodeSessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Claude dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Claude dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_claude_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            out.push(ClaudeCodeSessionFile {
                file_stem: file_stem.to_string(),
                path,
            });
        }
    }
    Ok(())
}

fn load_claude_session_titles_for_projects_dir(
    projects_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let Some(root) = projects_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_claude_session_titles(&root.join("sessions"))
}

fn load_claude_session_titles(
    sessions_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let mut entries = HashMap::new();
    if !sessions_dir.is_dir() {
        return Ok(entries);
    }

    for entry in fs::read_dir(sessions_dir)
        .map_err(|err| format!("Failed to read Claude sessions dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Failed to read Claude session entry: {err}"))?;
        let path = entry.path();
        if !path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            continue;
        }
        let contents = fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read Claude session metadata {}: {err}",
                path.display()
            )
        })?;
        let parsed: ClaudeSessionMetadataFile = match serde_json::from_str(&contents) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let session_id = parsed.session_id.trim();
        let name = parsed.name.trim();
        if session_id.is_empty() || name.is_empty() {
            continue;
        }
        entries.insert(
            session_id.to_string(),
            ClaudeSessionTitle {
                name: name.to_string(),
                name_source: parsed.name_source,
            },
        );
    }

    Ok(entries)
}

fn claude_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, ClaudeSessionTitle>,
) -> String {
    title_index
        .get(file_stem)
        .map(|title| {
            format!(
                "session-meta:{}:{}",
                title.name_source.as_deref().unwrap_or_default(),
                title.name
            )
        })
        .unwrap_or_default()
}

fn claude_session_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(sessions_dir) = claude_sessions_dir_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_claude_session_titles(&sessions_dir)?;
    Ok(title_index
        .get(&record.source_record_key)
        .map(|title| imported_history::truncate_name(&title.name, 200))
        .unwrap_or_default())
}

fn claude_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path.ancestors().find_map(|ancestor| {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some("projects") {
            return ancestor.parent().map(|root| root.join("sessions"));
        }
        None
    })
}

fn parse_claude_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<ClaudeCodeHistoryMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Claude history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut external_title = claude_session_title_for_record(record)?;
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Claude history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
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
        if repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            repo_path = Some(parsed.cwd.clone());
        }
        if branch.is_none() && !parsed.git_branch.trim().is_empty() {
            branch = Some(parsed.git_branch.clone());
        }
        if external_title.is_empty() && parsed.r#type == "summary" {
            let summary = parsed.summary.trim();
            if !summary.is_empty() {
                external_title = imported_history::truncate_name(summary, 200);
            }
        }
        if let Some(message) = parsed.message {
            if first_prompt.is_empty() && parsed.r#type == "user" {
                if let Some(text) = claude_content_text(&message.content) {
                    first_prompt = imported_history::truncate_name(&text, 200);
                }
            }
            if model.is_none()
                && !message.model.trim().is_empty()
                && !message.model.starts_with('<')
            {
                model = Some(message.model.clone());
            }
            if parsed.r#type == "assistant" {
                for item in claude_content_items(&message.content) {
                    collect_claude_impact_from_item(item, &mut impact, &mut touched_files);
                }
            }
            if let Some(usage) = message.usage {
                input_tokens += usage.input_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                output_tokens += usage.output_tokens;
            }
        }
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    Ok(Some(ClaudeCodeHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: format!("{CLAUDE_CODE_SESSION_PREFIX}{}", record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name: if !external_title.is_empty() {
            external_title
        } else if first_prompt.is_empty() {
            record.source_record_key.clone()
        } else {
            first_prompt
        },
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
        branch,
        input_tokens,
        output_tokens,
        impact,
    }))
}

fn session_meta_to_cache_input(meta: ClaudeCodeHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CLAUDE_CODE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

fn collect_claude_impact_from_item(
    item: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let Some(tool_name) = item.get("name").and_then(Value::as_str) else {
        return;
    };
    if !matches!(tool_name, "Edit" | "MultiEdit" | "Write") {
        return;
    }
    let Some(input) = item.get("input") else {
        return;
    };
    let Some(file_path) = input
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| input.get("path").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    touched_files.insert(file_path.to_string());
    match tool_name {
        "Write" => {
            if let Some(content) = input.get("content").and_then(Value::as_str) {
                impact.lines_added += count_text_lines(content);
            }
        }
        "Edit" => {
            accumulate_claude_edit_input(input, impact);
        }
        "MultiEdit" => {
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for edit in edits {
                    accumulate_claude_edit_input(edit, impact);
                }
            }
        }
        _ => {}
    }
}

fn accumulate_claude_edit_input(input: &Value, impact: &mut ImportedHistoryImpactStats) {
    if let Some(old_string) = input.get("old_string").and_then(Value::as_str) {
        impact.lines_removed += count_text_lines(old_string);
    }
    if let Some(new_string) = input.get("new_string").and_then(Value::as_str) {
        impact.lines_added += count_text_lines(new_string);
    }
}

fn count_text_lines(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

fn load_claude_code_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, ImportedToolCall> = HashMap::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Claude history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let Some(message) = parsed.message else {
            continue;
        };

        match parsed.r#type.as_str() {
            "user" => {
                if let Some(tool_result_output) = claude_tool_result_text(&message.content) {
                    if let Some((call_id, output)) = tool_result_output {
                        if let Some(call) = pending_tool_calls.remove(&call_id) {
                            chunks.push(imported_history::tool_call_chunk(
                                session_id,
                                CLAUDE_CODE_PROVIDER_SLUG,
                                sequence,
                                &call,
                                &output,
                            ));
                            sequence += 1;
                        }
                    }
                } else if let Some(text) = claude_content_text(&message.content) {
                    chunks.push(imported_history::user_message_chunk(
                        session_id,
                        CLAUDE_CODE_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "assistant" => {
                for item in claude_content_items(&message.content) {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    match item_type {
                        "text" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    CLAUDE_CODE_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "thinking" => {
                            if let Some(text) = item.get("thinking").and_then(Value::as_str) {
                                chunks.push(imported_history::thinking_chunk(
                                    session_id,
                                    CLAUDE_CODE_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "tool_use" => {
                            if let Some(call) = claude_tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    for call in pending_tool_calls.into_values() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            CLAUDE_CODE_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

fn claude_tool_call_from_item(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("id")?.as_str()?.to_string();
    let raw_name = item.get("name")?.as_str()?.to_string();
    let args = item.get("input").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_claude_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn normalize_claude_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "Bash" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "Edit" | "MultiEdit" | "Write" => (
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
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn claude_content_items(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn claude_content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
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

fn claude_tool_result_text(content: &Value) -> Option<Option<(String, String)>> {
    let Value::Array(items) = content else {
        return None;
    };
    let result_item = items
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))?;
    let call_id = result_item.get("tool_use_id")?.as_str()?.to_string();
    let output = match result_item.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    Some(Some((call_id, output)))
}

fn claude_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CLAUDE_CODE_SESSION_PREFIX) else {
        return Err(format!(
            "Invalid Claude Code history session id: {session_id}"
        ));
    };
    if file_stem.is_empty() {
        return Err("Claude Code history session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

fn resolve_claude_session_path(conn: &Connection, file_stem: &str) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CLAUDE_CODE, file_stem)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for projects_dir in claude_projects_dirs()? {
        if projects_dir.is_dir() {
            collect_claude_session_files(&projects_dir, &mut files)?;
        }
    }
    files
        .into_iter()
        .find(|file| file.file_stem == file_stem)
        .map(|file| file.path)
        .ok_or_else(|| format!("Claude Code history file not found for session: {file_stem}"))
}

fn claude_projects_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(claude_projects_dir_candidates(&home))
}

fn claude_projects_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".claude"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude Code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("claude-code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Claude Code"));
        roots.push(home.join("AppData").join("Roaming").join("claude-code"));
        roots.push(home.join("AppData").join("Roaming").join("Claude"));
        roots.push(home.join("AppData").join("Local").join("Claude Code"));
        roots.push(home.join("AppData").join("Local").join("claude-code"));
        roots.push(home.join("AppData").join("Local").join("Claude"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("claude-code"));
        roots.push(home.join(".local").join("share").join("claude-code"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("projects"))
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
