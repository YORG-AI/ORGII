//! WorkBuddy imported history reader
//!
//! Reads WorkBuddy/CodeBuddy JSONL transcripts from `~/.workbuddy/projects/**`,
//! `~/.codebuddy/projects/**`, and history files, then converts them into ORGII's canonical
//! `ActivityChunk` shape for read-only replay through the existing
//! external-history pipeline.

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
        SOURCE_WORKBUDDY,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

const WORKBUDDY_SESSION_PREFIX: &str = "workbuddyapp-";
const WORKBUDDY_PROVIDER_SLUG: &str = "workbuddy";
const WORKBUDDY_METADATA_PARSER_VERSION: i64 = 1;

pub type WorkBuddyHistorySessionRow = ImportedHistorySessionRow;
pub type WorkBuddyHistorySessionPage = ImportedHistorySessionPage;
pub type WorkBuddyRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct WorkBuddyHistoryMeta {
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
#[serde(default, rename_all = "camelCase")]
struct WorkBuddyJsonlLine {
    r#type: String,
    timestamp: Option<Value>,
    created_at: Option<Value>,
    cwd: String,
    project: String,
    git_branch: String,
    session_id: String,
    role: String,
    content: Value,
    raw_content: Value,
    provider_data: Value,
    ai_title: String,
    call_id: String,
    name: String,
    arguments: Value,
    output: Value,
    status: String,
    message: Option<WorkBuddyMessage>,
    function_call: Option<WorkBuddyFunctionCall>,
    function_call_result: Option<WorkBuddyFunctionCallResult>,
    display: String,
}

impl Default for WorkBuddyJsonlLine {
    fn default() -> Self {
        Self {
            r#type: String::new(),
            timestamp: None,
            created_at: None,
            cwd: String::new(),
            project: String::new(),
            git_branch: String::new(),
            session_id: String::new(),
            role: String::new(),
            content: Value::Null,
            raw_content: Value::Null,
            provider_data: Value::Null,
            ai_title: String::new(),
            call_id: String::new(),
            name: String::new(),
            arguments: Value::Null,
            output: Value::Null,
            status: String::new(),
            message: None,
            function_call: None,
            function_call_result: None,
            display: String::new(),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct WorkBuddyMessage {
    role: String,
    model: String,
    content: Value,
    usage: Option<WorkBuddyUsage>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct WorkBuddyUsage {
    input_tokens: i64,
    output_tokens: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    cache_read_input_tokens: i64,
    cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct WorkBuddyFunctionCall {
    call_id: String,
    id: String,
    name: String,
    arguments: Value,
    input: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct WorkBuddyFunctionCallResult {
    call_id: String,
    id: String,
    output: Value,
    result: Value,
    content: Value,
    status: String,
}

#[derive(Debug, Clone)]
struct WorkBuddySessionFile {
    file_stem: String,
    path: PathBuf,
}

pub fn list_workbuddy_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<WorkBuddyHistorySessionPage, String> {
    sync_workbuddy_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_WORKBUDDY, limit, offset)
}

pub fn list_workbuddy_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<WorkBuddyRecentPath>, String> {
    sync_workbuddy_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_WORKBUDDY, limit)
}

pub fn load_workbuddy_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = workbuddy_file_stem_from_session_id(session_id)?;
    let path = resolve_workbuddy_session_path(conn, source_session_id)?;
    load_workbuddy_history_from_path(session_id, &path)
}

fn sync_workbuddy_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_workbuddy_history_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_WORKBUDDY, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_workbuddy_session_meta(&record)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_WORKBUDDY,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_workbuddy_history_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut files = Vec::new();
    for root in workbuddy_history_roots()? {
        if root.is_dir() {
            collect_workbuddy_session_files(&root, &mut files)?;
        } else if root.is_file() {
            push_workbuddy_session_file(&root, &mut files);
        }
    }
    files
        .into_iter()
        .map(|file| {
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&file.path, "WorkBuddy")?;
            let source_session_id = workbuddy_source_session_id(&file.file_stem, &file.path);
            Ok(ImportedHistoryDiscoveredRecord {
                source_session_id,
                source_path: file.path,
                source_record_key: file.file_stem,
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint: String::new(),
                parser_version: WORKBUDDY_METADATA_PARSER_VERSION,
            })
        })
        .collect()
}

fn collect_workbuddy_session_files(
    dir: &Path,
    out: &mut Vec<WorkBuddySessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read WorkBuddy dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read WorkBuddy dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_workbuddy_session_files(&path, out)?;
        } else {
            push_workbuddy_session_file(&path, out);
        }
    }
    Ok(())
}

fn push_workbuddy_session_file(path: &Path, out: &mut Vec<WorkBuddySessionFile>) {
    if !path
        .extension()
        .is_some_and(|extension| extension == "jsonl")
    {
        return;
    }
    let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return;
    };
    if file_stem.starts_with("agent-") || file_stem == "recording" {
        return;
    }
    out.push(WorkBuddySessionFile {
        file_stem: file_stem.to_string(),
        path: path.to_path_buf(),
    });
}

fn parse_workbuddy_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<WorkBuddyHistoryMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open WorkBuddy history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read WorkBuddy history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: WorkBuddyJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if let Some(timestamp) = timestamp_value_to_epoch_ms(parsed.timestamp.as_ref())
            .or_else(|| timestamp_value_to_epoch_ms(parsed.created_at.as_ref()))
        {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            if timestamp > updated_at_ms {
                updated_at_ms = timestamp;
            }
        }
        if repo_path.is_none() {
            repo_path = non_empty_string(&parsed.cwd).or_else(|| non_empty_string(&parsed.project));
        }
        if branch.is_none() && !parsed.git_branch.trim().is_empty() {
            branch = Some(parsed.git_branch.clone());
        }
        if !parsed.ai_title.trim().is_empty() {
            first_prompt = imported_history::truncate_name(&parsed.ai_title, 200);
        }
        if first_prompt.is_empty() && !parsed.display.trim().is_empty() {
            first_prompt = imported_history::truncate_name(&parsed.display, 200);
        }
        if let Some(message) = effective_message(&parsed) {
            if first_prompt.is_empty() && message.role == "user" {
                if let Some(text) = content_text(&message.content) {
                    first_prompt = imported_history::truncate_name(&text, 200);
                }
            }
            if model.is_none() && !message.model.trim().is_empty() {
                model = Some(message.model.clone());
            }
            if let Some(usage) = message.usage {
                input_tokens += usage.input_tokens
                    + usage.prompt_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                output_tokens += usage.output_tokens + usage.completion_tokens;
            }
            if message.role == "assistant" {
                for item in content_items(&message.content) {
                    collect_impact_from_item(item, &mut impact, &mut touched_files);
                }
            }
        }
        if let Some(call) = effective_function_call(&parsed) {
            collect_impact_from_function_call(&call, &mut impact, &mut touched_files);
        }
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    Ok(Some(WorkBuddyHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: format!("{WORKBUDDY_SESSION_PREFIX}{}", record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name: if first_prompt.is_empty() {
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

fn session_meta_to_cache_input(meta: WorkBuddyHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_WORKBUDDY,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: WORKBUDDY_METADATA_PARSER_VERSION,
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
    }
}

fn load_workbuddy_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open WorkBuddy history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, ImportedToolCall> = HashMap::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read WorkBuddy history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: WorkBuddyJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = timestamp_value_to_iso(parsed.timestamp.as_ref())
            .or_else(|| timestamp_value_to_iso(parsed.created_at.as_ref()))
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        if parsed.r#type == "reasoning" {
            if let Some(text) = reasoning_text(&parsed) {
                chunks.push(imported_history::assistant_message_chunk(
                    session_id,
                    WORKBUDDY_PROVIDER_SLUG,
                    sequence,
                    &created_at,
                    &text,
                ));
                sequence += 1;
            }
        }

        if let Some(call) = effective_function_call(&parsed)
            .as_ref()
            .and_then(|call| function_call_to_imported_tool_call(call, &created_at))
        {
            pending_tool_calls.insert(call.call_id.clone(), call);
        }

        if let Some(result) = effective_function_result(&parsed) {
            let call_id = function_result_call_id(&result);
            if !call_id.is_empty() {
                if let Some(call) = pending_tool_calls.remove(&call_id) {
                    chunks.push(imported_history::tool_call_chunk(
                        session_id,
                        WORKBUDDY_PROVIDER_SLUG,
                        sequence,
                        &call,
                        &function_result_output(&result),
                    ));
                    sequence += 1;
                }
            }
        }

        let Some(message) = effective_message(&parsed) else {
            continue;
        };
        match message.role.as_str() {
            "user" => {
                if let Some((call_id, output)) = tool_result_from_content(&message.content) {
                    if let Some(call) = pending_tool_calls.remove(&call_id) {
                        chunks.push(imported_history::tool_call_chunk(
                            session_id,
                            WORKBUDDY_PROVIDER_SLUG,
                            sequence,
                            &call,
                            &output,
                        ));
                        sequence += 1;
                    }
                } else if let Some(text) = content_text(&message.content) {
                    chunks.push(imported_history::user_message_chunk(
                        session_id,
                        WORKBUDDY_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "assistant" => {
                for item in content_items(&message.content) {
                    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                        "text" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    WORKBUDDY_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "thinking" => {
                            if let Some(text) = item
                                .get("thinking")
                                .and_then(Value::as_str)
                                .or_else(|| item.get("text").and_then(Value::as_str))
                            {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    WORKBUDDY_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "tool_use" | "function_call" => {
                            if let Some(call) = block_tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
                if chunks
                    .last()
                    .is_none_or(|chunk| chunk.created_at != created_at)
                {
                    if let Some(text) = assistant_scalar_text(&message.content) {
                        chunks.push(imported_history::assistant_message_chunk(
                            session_id,
                            WORKBUDDY_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            &text,
                        ));
                        sequence += 1;
                    }
                }
            }
            _ => {}
        }
    }

    for call in pending_tool_calls.into_values() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            WORKBUDDY_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

fn effective_message(parsed: &WorkBuddyJsonlLine) -> Option<WorkBuddyMessage> {
    if let Some(message) = parsed.message.as_ref() {
        return Some(WorkBuddyMessage {
            role: message.role.clone(),
            model: message.model.clone(),
            content: message.content.clone(),
            usage: message.usage.clone(),
        });
    }
    if parsed.r#type != "message" || parsed.role.trim().is_empty() {
        return None;
    }
    let model = parsed
        .provider_data
        .get("requestModelName")
        .and_then(Value::as_str)
        .or_else(|| {
            parsed
                .provider_data
                .get("requestModelId")
                .and_then(Value::as_str)
        })
        .or_else(|| parsed.provider_data.get("model").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    Some(WorkBuddyMessage {
        role: parsed.role.clone(),
        model,
        content: parsed.content.clone(),
        usage: None,
    })
}

fn effective_function_call(parsed: &WorkBuddyJsonlLine) -> Option<WorkBuddyFunctionCall> {
    if let Some(call) = parsed.function_call.as_ref() {
        return Some(call.clone());
    }
    if parsed.r#type != "function_call" {
        return None;
    }
    Some(WorkBuddyFunctionCall {
        call_id: parsed.call_id.clone(),
        id: String::new(),
        name: parsed.name.clone(),
        arguments: parsed.arguments.clone(),
        input: Value::Null,
    })
}

fn effective_function_result(parsed: &WorkBuddyJsonlLine) -> Option<WorkBuddyFunctionCallResult> {
    if let Some(result) = parsed.function_call_result.as_ref() {
        return Some(result.clone());
    }
    if parsed.r#type != "function_call_result" {
        return None;
    }
    Some(WorkBuddyFunctionCallResult {
        call_id: parsed.call_id.clone(),
        id: String::new(),
        output: parsed.output.clone(),
        result: Value::Null,
        content: Value::Null,
        status: parsed.status.clone(),
    })
}

fn reasoning_text(parsed: &WorkBuddyJsonlLine) -> Option<String> {
    content_text(&parsed.content).or_else(|| content_text(&parsed.raw_content))
}

fn block_tool_call_from_item(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("callId").and_then(Value::as_str))
        .or_else(|| item.get("call_id").and_then(Value::as_str))?
        .to_string();
    let raw_name = item
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| item.get("tool").and_then(Value::as_str))?
        .to_string();
    let args = item
        .get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_workbuddy_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn function_call_to_imported_tool_call(
    call: &WorkBuddyFunctionCall,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = non_empty_string(&call.call_id).or_else(|| non_empty_string(&call.id))?;
    let raw_name = non_empty_string(&call.name)?;
    let args = if !call.arguments.is_null() {
        parse_argument_value(&call.arguments)
    } else if !call.input.is_null() {
        parse_argument_value(&call.input)
    } else {
        json!({})
    };
    let (canonical_name, args) = normalize_workbuddy_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn parse_argument_value(value: &Value) -> Value {
    match value {
        Value::String(text) => imported_history::parse_inner_json(text),
        other => other.clone(),
    }
}

fn function_result_call_id(result: &WorkBuddyFunctionCallResult) -> String {
    non_empty_string(&result.call_id)
        .or_else(|| non_empty_string(&result.id))
        .unwrap_or_default()
}

fn function_result_output(result: &WorkBuddyFunctionCallResult) -> String {
    if !result.output.is_null() {
        value_to_text(&result.output)
    } else if !result.result.is_null() {
        value_to_text(&result.result)
    } else if !result.content.is_null() {
        value_to_text(&result.content)
    } else {
        result.status.clone()
    }
}

fn normalize_workbuddy_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "Bash" | "Shell" | "shell" | "run_command" | "terminal" | "terminal_command" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "Edit" | "MultiEdit" | "Write" | "edit_file" | "edit_file_v2" | "write_file"
        | "apply_patch" => (
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
        .or_else(|| args.get("targetFile").and_then(Value::as_str))
        .or_else(|| args.get("relativeWorkspacePath").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn collect_impact_from_item(
    item: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if item_type != "tool_use" && item_type != "function_call" {
        return;
    }
    let Some(raw_name) = item
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| item.get("tool").and_then(Value::as_str))
    else {
        return;
    };
    let args = item
        .get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    collect_edit_impact(raw_name, &args, impact, touched_files);
}

fn collect_impact_from_function_call(
    call: &WorkBuddyFunctionCall,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    collect_edit_impact(&call.name, &call.arguments, impact, touched_files);
    collect_edit_impact(&call.name, &call.input, impact, touched_files);
}

fn collect_edit_impact(
    raw_name: &str,
    args: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if !matches!(
        raw_name,
        "Edit"
            | "MultiEdit"
            | "Write"
            | "edit_file"
            | "edit_file_v2"
            | "write_file"
            | "apply_patch"
    ) {
        return;
    }
    if let Some(file_path) = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("targetFile").and_then(Value::as_str))
        .or_else(|| args.get("relativeWorkspacePath").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        touched_files.insert(file_path.to_string());
    }
    if raw_name == "Write" || raw_name == "write_file" {
        if let Some(content) = args.get("content").and_then(Value::as_str) {
            impact.lines_added += count_text_lines(content);
        }
    }
    if let Some(old_string) = args.get("old_string").and_then(Value::as_str) {
        impact.lines_removed += count_text_lines(old_string);
    }
    if let Some(new_string) = args.get("new_string").and_then(Value::as_str) {
        impact.lines_added += count_text_lines(new_string);
    }
    if let Some(edits) = args.get("edits").and_then(Value::as_array) {
        for edit in edits {
            if let Some(old_string) = edit.get("old_string").and_then(Value::as_str) {
                impact.lines_removed += count_text_lines(old_string);
            }
            if let Some(new_string) = edit.get("new_string").and_then(Value::as_str) {
                impact.lines_added += count_text_lines(new_string);
            }
        }
    }
}

fn count_text_lines(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

fn content_items(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        other => other.as_str().map(str::to_string),
    }
}

fn assistant_scalar_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

fn tool_result_from_content(content: &Value) -> Option<(String, String)> {
    let Value::Array(items) = content else {
        return None;
    };
    let result_item = items.iter().find(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("tool_result" | "function_call_result")
        )
    })?;
    let call_id = result_item
        .get("tool_use_id")
        .and_then(Value::as_str)
        .or_else(|| result_item.get("callId").and_then(Value::as_str))
        .or_else(|| result_item.get("call_id").and_then(Value::as_str))?
        .to_string();
    let output = result_item
        .get("content")
        .or_else(|| result_item.get("output"))
        .map(value_to_text)
        .unwrap_or_default();
    Some((call_id, output))
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| object.get("content").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn timestamp_value_to_epoch_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().map(normalize_numeric_timestamp_ms),
        Value::String(text) => imported_history::parse_iso_to_epoch_ms_opt(text)
            .or_else(|| text.parse::<i64>().ok().map(normalize_numeric_timestamp_ms)),
        _ => None,
    }
}

fn timestamp_value_to_iso(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .map(normalize_numeric_timestamp_ms)
            .map(imported_history::epoch_ms_to_iso),
        Value::String(text) => imported_history::parse_iso_to_epoch_ms_opt(text)
            .map(imported_history::epoch_ms_to_iso)
            .or_else(|| {
                text.parse::<i64>()
                    .ok()
                    .map(normalize_numeric_timestamp_ms)
                    .map(imported_history::epoch_ms_to_iso)
            })
            .or_else(|| Some(imported_history::normalize_created_at(text))),
        _ => None,
    }
}

fn normalize_numeric_timestamp_ms(value: i64) -> i64 {
    if value.abs() < 10_000_000_000 {
        value.saturating_mul(1_000)
    } else {
        value
    }
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn workbuddy_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(WORKBUDDY_SESSION_PREFIX) else {
        return Err(format!(
            "Invalid WorkBuddy history session id: {session_id}"
        ));
    };
    if source_session_id.is_empty() {
        return Err("WorkBuddy history session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

fn resolve_workbuddy_session_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_WORKBUDDY, source_session_id)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for root in workbuddy_history_roots()? {
        if root.is_dir() {
            collect_workbuddy_session_files(&root, &mut files)?;
        } else if root.is_file() {
            push_workbuddy_session_file(&root, &mut files);
        }
    }
    files
        .into_iter()
        .find(|file| workbuddy_source_session_id(&file.file_stem, &file.path) == source_session_id)
        .map(|file| file.path)
        .ok_or_else(|| format!("WorkBuddy history file not found for session: {source_session_id}"))
}

fn workbuddy_source_session_id(file_stem: &str, path: &Path) -> String {
    if is_uuid_like(file_stem) {
        return file_stem.to_string();
    }
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{file_stem}-{hash:016x}")
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) && *byte == b'-'
            || !matches!(index, 8 | 13 | 18 | 23) && byte.is_ascii_hexdigit()
    })
}

fn workbuddy_history_roots() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(workbuddy_history_root_candidates(&home))
}

fn workbuddy_history_root_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".workbuddy").join("projects"));
    roots.push(home.join(".workbuddy").join("sessions"));
    roots.push(home.join(".workbuddy").join("history.jsonl"));
    roots.push(home.join(".codebuddy").join("projects"));
    roots.push(home.join(".codebuddy").join("sessions"));
    roots.push(home.join(".codebuddy").join("history.jsonl"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("CodeBuddyExtension"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(
            home.join("AppData")
                .join("Roaming")
                .join("CodeBuddyExtension"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("CodeBuddyExtension"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .collect()
}
