//! Qoder imported history reader.
//!
//! Qoder CLI stores read-only JSONL transcripts under
//! `~/.qoder/projects/<project-id>/<session-id>.jsonl`; newer builds may place
//! the same files below a `transcript/` directory. The Qoder IDE companion uses
//! the same transcript contract when it launches the CLI with a custom config
//! root. This module discovers both layouts, delta-syncs metadata into the
//! shared imported-history cache, and projects messages/tools into the canonical
//! `ActivityChunk` replay format.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
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
        SOURCE_QODER,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

const QODER_SESSION_PREFIX: &str = "qoderapp-";
const QODER_PROVIDER_SLUG: &str = "qoder";
const QODER_METADATA_PARSER_VERSION: i64 = 2;

pub type QoderHistorySessionRow = ImportedHistorySessionRow;
pub type QoderHistorySessionPage = ImportedHistorySessionPage;
pub type QoderRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct QoderSessionFile {
    source_session_id: String,
    path: PathBuf,
    source_record_key: String,
}

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
    model: Option<String>,
    repo_path: Option<String>,
    branch: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    impact: ImportedHistoryImpactStats,
    parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct QoderJsonlLine {
    r#type: String,
    uuid: String,
    session_id: String,
    timestamp: Option<Value>,
    cwd: String,
    git_branch: String,
    is_sidechain: bool,
    custom_title: String,
    ai_title: String,
    last_prompt: String,
    summary: String,
    model: String,
    message: Option<QoderMessage>,
    tool_use_result: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct QoderMessage {
    role: String,
    model: String,
    content: Value,
    usage: Option<QoderUsage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct QoderUsage {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_input_tokens: i64,
    cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
struct QoderToolResult {
    output: String,
    sidecar: Option<Value>,
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
    let path = resolve_qoder_session_path(conn, source_session_id)?;
    let lines = read_qoder_lines(&path)?;
    Ok(qoder_chunks_from_lines(session_id, &lines))
}

fn sync_qoder_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_qoder_history_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_QODER,
        &discovered,
        ImportedHistoryDiscoveredRecord::signature,
    )?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_qoder_session_meta(record)? {
            inputs.push(qoder_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_QODER,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_qoder_history_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    let mut seen_ids = HashSet::new();
    for projects_dir in qoder_history_candidate_paths() {
        if !projects_dir.is_dir() {
            continue;
        }
        for file in collect_qoder_session_files(&projects_dir)? {
            if !seen_ids.insert(file.source_session_id.clone()) {
                continue;
            }
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&file.path, "Qoder")?;
            records.push(ImportedHistoryDiscoveredRecord {
                source_session_id: file.source_session_id,
                source_path: file.path,
                source_record_key: file.source_record_key,
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint: String::new(),
                parser_version: QODER_METADATA_PARSER_VERSION,
            });
        }
    }
    Ok(records)
}

fn collect_qoder_session_files(projects_dir: &Path) -> Result<Vec<QoderSessionFile>, String> {
    let mut files = Vec::new();
    if !projects_dir.is_dir() {
        return Ok(files);
    }
    let entries = fs::read_dir(projects_dir)
        .map_err(|err| format!("Failed to read Qoder projects dir: {err}"))?;
    for project_entry in entries {
        let project_entry =
            project_entry.map_err(|err| format!("Failed to read Qoder project entry: {err}"))?;
        if !project_entry.path().is_dir() {
            continue;
        }
        let project_id = project_entry.file_name().to_string_lossy().to_string();
        for entry in fs::read_dir(project_entry.path())
            .map_err(|err| format!("Failed to read Qoder project session dir: {err}"))?
        {
            let entry =
                entry.map_err(|err| format!("Failed to read Qoder session entry: {err}"))?;
            let path = entry.path();
            if path.is_file() && is_jsonl(&path) {
                let Some(stem) = file_stem(&path) else {
                    continue;
                };
                files.push(QoderSessionFile {
                    source_session_id: stem.clone(),
                    source_record_key: format!("{project_id}/{stem}.jsonl"),
                    path,
                });
                continue;
            }
            if !path.is_dir() {
                continue;
            }
            let parent_id = entry.file_name().to_string_lossy().to_string();
            let subagents_dir = path.join("subagents");
            if !subagents_dir.is_dir() {
                continue;
            }
            for subagent in fs::read_dir(&subagents_dir)
                .map_err(|err| format!("Failed to read Qoder subagents dir: {err}"))?
            {
                let subagent = subagent
                    .map_err(|err| format!("Failed to read Qoder subagent entry: {err}"))?;
                let subagent_path = subagent.path();
                if !subagent_path.is_file() || !is_jsonl(&subagent_path) {
                    continue;
                }
                let Some(stem) = file_stem(&subagent_path) else {
                    continue;
                };
                let source_session_id = format!("{parent_id}--{stem}");
                files.push(QoderSessionFile {
                    source_record_key: format!("{project_id}/{parent_id}/subagents/{stem}.jsonl"),
                    source_session_id,
                    path: subagent_path,
                });
            }
        }

        let transcript_dir = project_entry.path().join("transcript");
        if transcript_dir.is_dir() {
            for entry in fs::read_dir(&transcript_dir)
                .map_err(|err| format!("Failed to read Qoder transcript dir: {err}"))?
            {
                let entry =
                    entry.map_err(|err| format!("Failed to read Qoder transcript entry: {err}"))?;
                let path = entry.path();
                if !path.is_file() || !is_jsonl(&path) {
                    continue;
                }
                let Some(stem) = file_stem(&path) else {
                    continue;
                };
                files.push(QoderSessionFile {
                    source_session_id: stem.clone(),
                    source_record_key: format!("{project_id}/transcript/{stem}.jsonl"),
                    path,
                });
            }
        }
    }
    Ok(files)
}

fn parse_qoder_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<QoderHistoryMeta>, String> {
    let lines = read_qoder_lines(&record.source_path)?;
    if lines.is_empty() {
        return Ok(None);
    }
    let tool_results = qoder_tool_results(&lines);
    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut custom_title = String::new();
    let mut ai_title = String::new();
    let mut last_prompt = String::new();
    let mut summary = String::new();
    let mut first_prompt = String::new();
    let mut runtime_model = None;
    let mut message_model = None;
    let mut repo_path = None;
    let mut branch = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();
    let mut parent_source_id = None;

    for line in &lines {
        if let Some(timestamp) = qoder_timestamp_ms(line.timestamp.as_ref()) {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            updated_at_ms = updated_at_ms.max(timestamp);
        }
        if let Some(value) = non_empty(&line.cwd) {
            repo_path = Some(value);
        }
        if let Some(value) = non_empty(&line.git_branch) {
            branch = Some(value);
        }
        if line.is_sidechain && parent_source_id.is_none() {
            parent_source_id =
                non_empty(&line.session_id).filter(|id| id != &record.source_session_id);
        }
        match line.r#type.as_str() {
            "custom-title" => {
                if let Some(value) = non_empty(&line.custom_title) {
                    custom_title = value;
                }
            }
            "ai-title" => {
                if let Some(value) = non_empty(&line.ai_title) {
                    ai_title = value;
                }
            }
            "last-prompt" => {
                if let Some(value) = non_empty(&line.last_prompt) {
                    last_prompt = value;
                }
            }
            "summary" => {
                if let Some(value) = non_empty(&line.summary) {
                    summary = value;
                }
            }
            "runtime-config" => {
                if let Some(value) = non_empty(&line.model) {
                    runtime_model = Some(value);
                }
            }
            _ => {}
        }
        let Some(message) = &line.message else {
            continue;
        };
        if first_prompt.is_empty() && line.r#type == "user" {
            if let Some(text) = qoder_message_text(&message.content) {
                first_prompt = imported_history::truncate_name(&text, 200);
            }
        }
        if let Some(value) = non_empty(&message.model) {
            message_model = Some(value);
        }
        if let Some(usage) = &message.usage {
            input_tokens += usage.input_tokens
                + usage.cache_read_input_tokens
                + usage.cache_creation_input_tokens;
            output_tokens += usage.output_tokens;
        }
        if line.r#type == "assistant" {
            for item in content_items(&message.content) {
                if item_type(item) != "tool_use" {
                    continue;
                }
                let call_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                collect_qoder_impact(
                    item.get("name").and_then(Value::as_str).unwrap_or_default(),
                    item.get("input").unwrap_or(&Value::Null),
                    tool_results
                        .get(call_id)
                        .and_then(|result| result.sidecar.as_ref()),
                    &mut impact,
                    &mut touched_files,
                );
            }
        }
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
    let fallback_ms = record.source_mtime_ms / 1_000_000;
    let name = [custom_title, ai_title, last_prompt, summary, first_prompt]
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_else(|| record.source_session_id.clone());

    Ok(Some(QoderHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: format!("{QODER_SESSION_PREFIX}{}", record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name: imported_history::truncate_name(&name, 200),
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            fallback_ms
        },
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            fallback_ms
        },
        model: message_model.or(runtime_model),
        repo_path,
        branch,
        input_tokens,
        output_tokens,
        impact,
        parent_session_id: parent_source_id.map(|id| format!("{QODER_SESSION_PREFIX}{id}")),
    }))
}

fn qoder_meta_to_cache_input(meta: QoderHistoryMeta) -> ImportedHistoryCacheInput {
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
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: meta.parent_session_id,
    }
}

fn qoder_chunks_from_lines(session_id: &str, lines: &[QoderJsonlLine]) -> Vec<ActivityChunk> {
    let tool_results = qoder_tool_results(lines);
    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    for line in lines {
        let created_at = qoder_timestamp_iso(line.timestamp.as_ref());
        let Some(message) = &line.message else {
            continue;
        };
        match line.r#type.as_str() {
            "user" => {
                if let Some(text) = qoder_message_text(&message.content) {
                    chunks.push(imported_history::user_message_chunk(
                        session_id,
                        QODER_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "assistant" => {
                for item in content_items(&message.content) {
                    match item_type(item) {
                        "text" => {
                            let Some(text) = item
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|text| !text.is_empty())
                            else {
                                continue;
                            };
                            chunks.push(imported_history::assistant_message_chunk(
                                session_id,
                                QODER_PROVIDER_SLUG,
                                sequence,
                                &created_at,
                                text,
                            ));
                            sequence += 1;
                        }
                        "thinking" => {
                            let Some(text) = item
                                .get("thinking")
                                .or_else(|| item.get("text"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|text| !text.is_empty())
                            else {
                                continue;
                            };
                            chunks.push(imported_history::thinking_chunk(
                                session_id,
                                QODER_PROVIDER_SLUG,
                                sequence,
                                &created_at,
                                text,
                            ));
                            sequence += 1;
                        }
                        "tool_use" => {
                            let raw_name =
                                item.get("name").and_then(Value::as_str).unwrap_or("tool");
                            let call_id = item
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|id| !id.is_empty())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("qoder-{sequence}"));
                            let args = item.get("input").cloned().unwrap_or_else(|| json!({}));
                            let (canonical_name, args) = normalize_qoder_tool_call(raw_name, args);
                            let call = ImportedToolCall {
                                call_id: call_id.clone(),
                                raw_name: raw_name.to_string(),
                                canonical_name,
                                args,
                                created_at: created_at.clone(),
                            };
                            let result = tool_results.get(&call_id);
                            let mut chunk = imported_history::tool_call_chunk(
                                session_id,
                                QODER_PROVIDER_SLUG,
                                sequence,
                                &call,
                                result
                                    .map(|value| value.output.as_str())
                                    .unwrap_or_default(),
                            );
                            apply_qoder_edit_diff(
                                &mut chunk,
                                result.and_then(|value| value.sidecar.as_ref()),
                            );
                            chunks.push(chunk);
                            sequence += 1;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    chunks
}

fn qoder_tool_results(lines: &[QoderJsonlLine]) -> HashMap<String, QoderToolResult> {
    let mut results = HashMap::new();
    for line in lines {
        let Some(message) = &line.message else {
            continue;
        };
        for item in content_items(&message.content) {
            if item_type(item) != "tool_result" {
                continue;
            }
            let Some(call_id) = item
                .get("tool_use_id")
                .or_else(|| item.get("toolUseId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            results.insert(
                call_id.to_string(),
                QoderToolResult {
                    output: value_to_text(item.get("content")),
                    sidecar: line.tool_use_result.clone(),
                },
            );
        }
    }
    results
}

fn normalize_qoder_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match normalized_tool_name(raw_name).as_str() {
        "bash" | "shell" | "runcommand" | "runcommandline" => {
            let command = args
                .get("command")
                .or_else(|| args.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({ "command": command, "cmd": command }),
            )
        }
        "read" | "readfile" => {
            let file_path = args
                .get("file_path")
                .or_else(|| args.get("filePath"))
                .or_else(|| args.get("path"))
                .cloned()
                .unwrap_or(Value::Null);
            (
                imported_history::FUNCTION_READ_FILE.to_string(),
                json!({ "file_path": file_path }),
            )
        }
        "edit" | "write" | "multiedit" => {
            let file_path = args
                .get("file_path")
                .or_else(|| args.get("filePath"))
                .or_else(|| args.get("path"))
                .cloned()
                .unwrap_or(Value::Null);
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({
                    "action": if normalized_tool_name(raw_name) == "write" { "create" } else { "edit" },
                    "file_path": file_path,
                    "old_string": args.get("old_string").or_else(|| args.get("oldString")).cloned().unwrap_or_else(|| json!("")),
                    "new_string": args.get("new_string").or_else(|| args.get("newString")).or_else(|| args.get("content")).cloned().unwrap_or_else(|| json!("")),
                }),
            )
        }
        "grep" | "search" | "searchcodebase" => {
            (imported_history::FUNCTION_CODE_SEARCH.to_string(), args)
        }
        "glob" | "globfiles" => (
            imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
            args,
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn collect_qoder_impact(
    raw_name: &str,
    args: &Value,
    sidecar: Option<&Value>,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if !matches!(
        normalized_tool_name(raw_name).as_str(),
        "edit" | "write" | "multiedit"
    ) {
        return;
    }
    if let Some(path) = qoder_file_path(args) {
        touched_files.insert(path.to_string());
    }
    if let Some((_, added, removed)) = sidecar.and_then(qoder_unified_diff_from_patch) {
        impact.lines_added += added;
        impact.lines_removed += removed;
        return;
    }
    if normalized_tool_name(raw_name) == "multiedit" {
        for edit in args
            .get("edits")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            impact.lines_removed += text_line_count(
                edit.get("old_string")
                    .or_else(|| edit.get("oldString"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            impact.lines_added += text_line_count(
                edit.get("new_string")
                    .or_else(|| edit.get("newString"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
        }
        return;
    }
    impact.lines_removed += text_line_count(
        args.get("old_string")
            .or_else(|| args.get("oldString"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    impact.lines_added += text_line_count(
        args.get("new_string")
            .or_else(|| args.get("newString"))
            .or_else(|| args.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
}

fn apply_qoder_edit_diff(chunk: &mut ActivityChunk, sidecar: Option<&Value>) {
    let Some((diff, added, removed)) = sidecar.and_then(qoder_unified_diff_from_patch) else {
        return;
    };
    if let Some(result) = chunk.result.as_object_mut() {
        result.insert("diff".to_string(), Value::String(diff));
        result.insert("linesAdded".to_string(), json!(added));
        result.insert("linesRemoved".to_string(), json!(removed));
    }
}

fn qoder_unified_diff_from_patch(result: &Value) -> Option<(String, i64, i64)> {
    let hunks = result
        .get("structuredPatch")
        .or_else(|| result.get("structured_patch"))
        .and_then(Value::as_array)?;
    if hunks.is_empty() {
        return None;
    }
    let path = result
        .get("filePath")
        .or_else(|| result.get("file_path"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut diff = format!("--- {path}\n+++ {path}\n");
    let mut added = 0;
    let mut removed = 0;
    for hunk in hunks {
        let old_start = integer_field(hunk, &["oldStart", "old_start"]);
        let old_lines = integer_field(hunk, &["oldLines", "old_lines"]);
        let new_start = integer_field(hunk, &["newStart", "new_start"]);
        let new_lines = integer_field(hunk, &["newLines", "new_lines"]);
        diff.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        for line in hunk
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(text) = line.as_str() else {
                continue;
            };
            match text.as_bytes().first() {
                Some(b'+') => added += 1,
                Some(b'-') => removed += 1,
                _ => {}
            }
            diff.push_str(text);
            diff.push('\n');
        }
    }
    Some((diff, added, removed))
}

fn read_qoder_lines(path: &Path) -> Result<Vec<QoderJsonlLine>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Qoder history {}: {err}", path.display()))?;
    let mut lines = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|err| format!("Failed to read Qoder history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str(trimmed) {
            lines.push(parsed);
        }
    }
    Ok(lines)
}

fn content_items(content: &Value) -> Vec<&Value> {
    content
        .as_array()
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn item_type(item: &Value) -> &str {
    item.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn qoder_message_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => non_empty(text),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter(|item| matches!(item_type(item), "text" | "input_text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            non_empty(&text)
        }
        _ => None,
    }
}

fn value_to_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| item.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn qoder_timestamp_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().map(|raw| {
            if raw.abs() < 10_000_000_000 {
                raw * 1000
            } else {
                raw
            }
        }),
        Value::String(text) => text
            .parse::<i64>()
            .ok()
            .map(|raw| {
                if raw.abs() < 10_000_000_000 {
                    raw * 1000
                } else {
                    raw
                }
            })
            .or_else(|| imported_history::parse_iso_to_epoch_ms_opt(text)),
        _ => None,
    }
}

fn qoder_timestamp_iso(value: Option<&Value>) -> String {
    qoder_timestamp_ms(value)
        .map(imported_history::epoch_ms_to_iso)
        .unwrap_or_default()
}

fn qoder_file_path(args: &Value) -> Option<&str> {
    args.get("file_path")
        .or_else(|| args.get("filePath"))
        .or_else(|| args.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
}

fn integer_field(value: &Value, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_i64))
        .unwrap_or_default()
}

fn text_line_count(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

fn normalized_tool_name(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "jsonl")
}

fn file_stem(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn qoder_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_id) = session_id.strip_prefix(QODER_SESSION_PREFIX) else {
        return Err(format!("Invalid Qoder history session id: {session_id}"));
    };
    if source_id.is_empty() {
        return Err("Qoder history session id is missing its source id".to_string());
    }
    Ok(source_id)
}

fn resolve_qoder_session_path(
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
    discover_qoder_history_records()?
        .into_iter()
        .find(|record| record.source_session_id == source_session_id)
        .map(|record| record.source_path)
        .ok_or_else(|| format!("Qoder history file not found for session: {source_session_id}"))
}

/// Candidate Qoder `projects` directories used by both import and detection.
pub fn qoder_history_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["QODER_CONFIG_DIR", "QODER_CLI_HOME"] {
        if let Some(root) = env::var_os(key).filter(|value| !value.is_empty()) {
            candidates.push(PathBuf::from(root).join("projects"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.extend(qoder_projects_dir_candidates_for_home(&home));
    }
    if let Some(app_data) = env::var_os("APPDATA") {
        candidates.extend(qoder_ide_projects_candidates(
            Path::new(&app_data).join("Qoder"),
        ));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.extend(qoder_ide_projects_candidates(
            Path::new(&local_app_data).join("Qoder"),
        ));
    }
    imported_paths::dedupe_paths(candidates)
}

fn qoder_projects_dir_candidates_for_home(home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![home.join(".qoder/projects")];
    candidates.extend(qoder_ide_projects_candidates(
        home.join("Library/Application Support/Qoder"),
    ));
    candidates.extend(qoder_ide_projects_candidates(home.join(".config/Qoder")));
    candidates.extend(qoder_ide_projects_candidates(
        home.join(".local/share/Qoder"),
    ));
    candidates
}

fn qoder_ide_projects_candidates(app_root: PathBuf) -> Vec<PathBuf> {
    ["qoder.qoder-cli-vscode-ide-companion", "qoder.qoder"]
        .into_iter()
        .map(|extension| {
            app_root
                .join("User/globalStorage")
                .join(extension)
                .join("projects")
        })
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
