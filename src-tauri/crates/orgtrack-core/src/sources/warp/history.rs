//! Warp imported history reader.
//!
//! Warp stores local agent conversations in `warp.sqlite`. Conversation-level
//! metadata is JSON in `agent_conversations`; task transcripts are protobuf
//! blobs in `agent_tasks`. This module opens the database read-only and uses
//! Warp's published protobuf descriptor to project both into ORGII's shared
//! imported-history cache and `ActivityChunk` replay format.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};

use chrono::NaiveDateTime;
use core_types::activity::ActivityChunk;
use prost_reflect::DynamicMessage;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
        SOURCE_WARP,
    },
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedHistorySessionRow,
    ImportedToolCall,
};

const WARP_SESSION_PREFIX: &str = "warpapp-";
const WARP_PROVIDER_SLUG: &str = "warp";
const WARP_DB_FILENAME: &str = "warp.sqlite";
const WARP_TASK_PROTO_NAME: &str = "warp.multi_agent.v1.Task";
const WARP_METADATA_PARSER_VERSION: i64 = 1;

pub type WarpHistorySessionRow = ImportedHistorySessionRow;
pub type WarpHistorySessionPage = ImportedHistorySessionPage;
pub type WarpRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WarpConversationSummary {
    initial_query: String,
    title: String,
    initial_working_directory: Option<String>,
    is_unlisted_auto_code_diff: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WarpConversationData {
    conversation_usage_metadata: Option<WarpConversationUsageMetadata>,
    parent_conversation_id: Option<String>,
    agent_name: Option<String>,
    is_remote_child: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WarpConversationUsageMetadata {
    token_usage: Vec<WarpModelTokenUsage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WarpModelTokenUsage {
    model_id: String,
    #[serde(alias = "total_tokens")]
    warp_tokens: u32,
    byok_tokens: u32,
    custom_endpoint_tokens: u32,
}

#[derive(Debug, Clone)]
struct WarpConversationRecord {
    conversation_id: String,
    conversation_data_json: String,
    last_modified_at: String,
    summary_json: Option<String>,
    task_count: i64,
    task_bytes: i64,
}

impl WarpConversationRecord {
    fn signature(&self, db_path: &Path) -> ImportedHistoryRecordSignature {
        ImportedHistoryRecordSignature {
            source_session_id: self.conversation_id.clone(),
            source_path: db_path.to_string_lossy().to_string(),
            source_mtime_ms: parse_warp_timestamp_ms(&self.last_modified_at).unwrap_or(0),
            source_size_bytes: self.task_bytes,
            source_fingerprint: warp_source_fingerprint(self),
            parser_version: WARP_METADATA_PARSER_VERSION,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct WarpTaskAnalysis {
    chunks: Vec<ActivityChunk>,
    initial_query: Option<String>,
    root_description: Option<String>,
    model: Option<String>,
    created_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Clone)]
struct OrderedMessage {
    task_index: usize,
    message_index: usize,
    timestamp_ms: Option<i64>,
    created_at: String,
    value: Value,
}

pub fn list_warp_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<WarpHistorySessionPage, String> {
    sync_warp_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_WARP, limit, offset)
}

pub fn list_warp_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<WarpRecentPath>, String> {
    sync_warp_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_WARP, limit)
}

pub fn load_warp_history_for_session(session_id: &str) -> Result<Vec<ActivityChunk>, String> {
    let conversation_id = warp_conversation_id_from_session_id(session_id)?;
    let Some((conn, _db_path)) = open_warp_db()? else {
        return Ok(Vec::new());
    };
    let records = load_task_blobs(&conn, conversation_id)?;
    let fallback_ms = load_conversation_last_modified_ms(&conn, conversation_id)?.unwrap_or(0);
    Ok(analyze_task_blobs(session_id, &records, fallback_ms).chunks)
}

fn sync_warp_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    let Some((source_conn, db_path)) = open_warp_db()? else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_WARP,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };

    let records = list_conversation_records(&source_conn)?;
    let signatures = records
        .iter()
        .map(|record| record.signature(&db_path))
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(cache_conn, SOURCE_WARP, &records, |record| {
            record.signature(&db_path)
        })?;
    let mut inputs = Vec::with_capacity(changed.len());

    for record in changed {
        let fallback_ms = parse_warp_timestamp_ms(&record.last_modified_at).unwrap_or(0);
        let task_blobs = load_task_blobs(&source_conn, &record.conversation_id)?;
        let analysis = analyze_task_blobs(
            &format!("{WARP_SESSION_PREFIX}{}", record.conversation_id),
            &task_blobs,
            fallback_ms,
        );
        inputs.push(conversation_to_cache_input(
            record.clone(),
            analysis,
            &db_path,
        ));
    }

    imported_cache::sync_source_cache_from_conn(
        cache_conn,
        SOURCE_WARP,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn list_conversation_records(conn: &Connection) -> Result<Vec<WarpConversationRecord>, String> {
    if !table_exists(conn, "agent_conversations")? || !table_exists(conn, "agent_tasks")? {
        return Ok(Vec::new());
    }
    let summary_expr = if column_exists(conn, "agent_conversations", "summary")? {
        "summary"
    } else {
        "NULL"
    };
    let sql = format!(
        "SELECT c.conversation_id, c.conversation_data, \
                CAST(c.last_modified_at AS TEXT), {summary_expr}, \
                (SELECT COUNT(*) FROM agent_tasks t WHERE t.conversation_id = c.conversation_id), \
                (SELECT COALESCE(SUM(LENGTH(t.task)), 0) FROM agent_tasks t WHERE t.conversation_id = c.conversation_id) \
         FROM agent_conversations c ORDER BY c.last_modified_at ASC, c.id ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("Failed to prepare Warp conversation query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WarpConversationRecord {
                conversation_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                conversation_data_json: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                last_modified_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                summary_json: row.get(3)?,
                task_count: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                task_bytes: row.get::<_, Option<i64>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to query Warp conversations: {err}"))?;

    let mut records = Vec::new();
    for row in rows {
        let record = row.map_err(|err| format!("Failed to read Warp conversation row: {err}"))?;
        if !record.conversation_id.trim().is_empty() {
            records.push(record);
        }
    }
    Ok(records)
}

fn conversation_to_cache_input(
    record: WarpConversationRecord,
    analysis: WarpTaskAnalysis,
    db_path: &Path,
) -> ImportedHistoryCacheInput {
    let signature = record.signature(db_path);
    let summary = record
        .summary_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<WarpConversationSummary>(raw).ok())
        .unwrap_or_default();
    let data = serde_json::from_str::<WarpConversationData>(&record.conversation_data_json)
        .unwrap_or_default();
    let usage = data.conversation_usage_metadata.unwrap_or_default();
    let total_tokens = usage
        .token_usage
        .iter()
        .map(|item| {
            i64::from(item.warp_tokens)
                + i64::from(item.byok_tokens)
                + i64::from(item.custom_endpoint_tokens)
        })
        .sum();
    let usage_model = usage
        .token_usage
        .iter()
        .rev()
        .map(|item| item.model_id.trim())
        .find(|model| !model.is_empty())
        .map(str::to_string);

    let title = non_empty(Some(&summary.title))
        .or_else(|| non_empty(analysis.root_description.as_deref()))
        .or_else(|| non_empty(Some(&summary.initial_query)))
        .or_else(|| non_empty(analysis.initial_query.as_deref()))
        .or_else(|| non_empty(data.agent_name.as_deref()))
        .unwrap_or_else(|| "Warp conversation".to_string());
    let fallback_updated_at = parse_warp_timestamp_ms(&record.last_modified_at).unwrap_or(0);
    let created_at_ms = analysis.created_at_ms.unwrap_or(fallback_updated_at);
    let updated_at_ms = analysis.updated_at_ms.unwrap_or(fallback_updated_at);
    let parent_session_id = non_empty(data.parent_conversation_id.as_deref())
        .map(|parent| format!("{WARP_SESSION_PREFIX}{parent}"));
    let listable =
        !data.is_remote_child && !summary.is_unlisted_auto_code_diff && !analysis.chunks.is_empty();
    let source_metadata_json = serde_json::to_string(&json!({
        "initialQuery": non_empty(Some(&summary.initial_query)).or(analysis.initial_query),
        "taskCount": record.task_count,
    }))
    .ok();

    ImportedHistoryCacheInput {
        source: SOURCE_WARP,
        source_session_id: record.conversation_id.clone(),
        session_id: format!("{WARP_SESSION_PREFIX}{}", record.conversation_id),
        source_path: signature.source_path,
        source_record_key: record.conversation_id,
        source_mtime_ms: signature.source_mtime_ms,
        source_size_bytes: signature.source_size_bytes,
        source_fingerprint: signature.source_fingerprint,
        parser_version: signature.parser_version,
        name: imported_history::truncate_name(&title, 200),
        created_at_ms,
        updated_at_ms,
        model: analysis.model.or(usage_model),
        input_tokens: total_tokens,
        output_tokens: 0,
        repo_path: non_empty(summary.initial_working_directory.as_deref()),
        branch: None,
        impact: analysis.impact,
        listable,
        source_metadata_json,
        parent_session_id,
    }
}

fn warp_source_fingerprint(record: &WarpConversationRecord) -> String {
    [
        record.conversation_id.as_str(),
        record.conversation_data_json.as_str(),
        record.summary_json.as_deref().unwrap_or_default(),
        record.last_modified_at.as_str(),
        &record.task_count.to_string(),
        &record.task_bytes.to_string(),
    ]
    .join("|")
}

fn analyze_task_blobs(
    session_id: &str,
    task_blobs: &[Vec<u8>],
    fallback_ms: i64,
) -> WarpTaskAnalysis {
    let fallback_created_at = imported_history::epoch_ms_to_iso(fallback_ms);
    let mut task_values = Vec::new();
    for blob in task_blobs {
        if let Ok(task) = decode_task_json(blob) {
            task_values.push(task);
        }
    }

    let mut analysis = WarpTaskAnalysis {
        root_description: task_values
            .iter()
            .find(|task| is_root_task(task))
            .and_then(|task| field_str(task, &["description"]))
            .and_then(|value| non_empty(Some(value))),
        ..WarpTaskAnalysis::default()
    };

    let mut messages = Vec::new();
    for (task_index, task) in task_values.iter().enumerate() {
        let Some(task_messages) = field(task, &["messages"]).and_then(Value::as_array) else {
            continue;
        };
        for (message_index, message) in task_messages.iter().enumerate() {
            let timestamp_ms = field(message, &["timestamp"]).and_then(timestamp_value_to_epoch_ms);
            let created_at = field(message, &["timestamp"])
                .and_then(timestamp_value_to_iso)
                .unwrap_or_else(|| fallback_created_at.clone());
            messages.push(OrderedMessage {
                task_index,
                message_index,
                timestamp_ms,
                created_at,
                value: message.clone(),
            });
        }
    }
    messages.sort_by_key(|message| {
        (
            message.timestamp_ms.unwrap_or(i64::MAX),
            message.task_index,
            message.message_index,
        )
    });

    analysis.created_at_ms = messages.iter().filter_map(|item| item.timestamp_ms).min();
    analysis.updated_at_ms = messages.iter().filter_map(|item| item.timestamp_ms).max();

    let tool_results = messages
        .iter()
        .filter_map(|message| {
            let result = field(&message.value, &["toolCallResult", "tool_call_result"])?;
            let call_id = field_str(result, &["toolCallId", "tool_call_id"])?;
            Some((call_id.to_string(), result.clone()))
        })
        .collect::<HashMap<_, _>>();

    for (sequence, message) in messages.iter().enumerate() {
        if let Some(user_query) = field(&message.value, &["userQuery", "user_query"]) {
            if let Some(query) = field_str(user_query, &["query"]).and_then(|q| non_empty(Some(q)))
            {
                if analysis.initial_query.is_none() {
                    analysis.initial_query = Some(query.clone());
                }
                analysis.chunks.push(imported_history::user_message_chunk(
                    session_id,
                    WARP_PROVIDER_SLUG,
                    sequence,
                    &message.created_at,
                    &query,
                ));
            }
            continue;
        }
        if let Some(agent_output) = field(&message.value, &["agentOutput", "agent_output"]) {
            if let Some(text) = field_str(agent_output, &["text"]).and_then(|t| non_empty(Some(t)))
            {
                analysis
                    .chunks
                    .push(imported_history::assistant_message_chunk(
                        session_id,
                        WARP_PROVIDER_SLUG,
                        sequence,
                        &message.created_at,
                        &text,
                    ));
            }
            continue;
        }
        if let Some(reasoning) = field(&message.value, &["agentReasoning", "agent_reasoning"]) {
            if let Some(text) =
                field_str(reasoning, &["reasoning"]).and_then(|t| non_empty(Some(t)))
            {
                analysis.chunks.push(imported_history::thinking_chunk(
                    session_id,
                    WARP_PROVIDER_SLUG,
                    sequence,
                    &message.created_at,
                    &text,
                ));
            }
            continue;
        }
        if let Some(model_used) = field(&message.value, &["modelUsed", "model_used"]) {
            analysis.model = field_str(model_used, &["modelDisplayName", "model_display_name"])
                .and_then(|model| non_empty(Some(model)))
                .or_else(|| {
                    field_str(model_used, &["modelId", "model_id"])
                        .and_then(|model| non_empty(Some(model)))
                })
                .or(analysis.model);
            continue;
        }
        let Some(tool_call) = field(&message.value, &["toolCall", "tool_call"]) else {
            continue;
        };
        let Some((raw_name, payload)) = tool_variant(tool_call) else {
            continue;
        };
        accumulate_impact(&mut analysis.impact, raw_name, payload);
        let call_id = field_str(tool_call, &["toolCallId", "tool_call_id"])
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("warp-{sequence}"));
        let (canonical_name, args) = normalize_warp_tool_call(raw_name, payload.clone());
        let output = tool_results
            .get(&call_id)
            .map(tool_result_text)
            .unwrap_or_default();
        let call = ImportedToolCall {
            call_id,
            raw_name: camel_to_snake(raw_name),
            canonical_name,
            args,
            created_at: message.created_at.clone(),
        };
        analysis.chunks.push(imported_history::tool_call_chunk(
            session_id,
            WARP_PROVIDER_SLUG,
            sequence,
            &call,
            &output,
        ));
    }

    analysis
}

fn decode_task_json(blob: &[u8]) -> Result<Value, String> {
    let descriptor = warp_multi_agent_api::get_descriptor_pool()
        .get_message_by_name(WARP_TASK_PROTO_NAME)
        .ok_or_else(|| format!("Missing Warp protobuf descriptor: {WARP_TASK_PROTO_NAME}"))?;
    let message = DynamicMessage::decode(descriptor, blob)
        .map_err(|err| format!("Failed to decode Warp task protobuf: {err}"))?;
    serde_json::to_value(message).map_err(|err| format!("Failed to project Warp task JSON: {err}"))
}

fn normalize_warp_tool_call(raw_name: &str, payload: Value) -> (String, Value) {
    match raw_name {
        "runShellCommand" | "run_shell_command" => {
            let command = field_str(&payload, &["command"]).unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({ "command": command, "cmd": command, "payload": payload }),
            )
        }
        "readFiles" | "read_files" => (imported_history::FUNCTION_READ_FILE.to_string(), payload),
        "applyFileDiffs" | "apply_file_diffs" | "editDocuments" | "edit_documents"
        | "createDocuments" | "create_documents" => {
            let file_path = first_edited_file_path(&payload).unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({
                    "action": camel_to_snake(raw_name),
                    "file_path": file_path,
                    "payload": payload,
                }),
            )
        }
        "grep" | "searchCodebase" | "search_codebase" => {
            (imported_history::FUNCTION_CODE_SEARCH.to_string(), payload)
        }
        "fileGlob" | "file_glob" | "fileGlobV2" | "file_glob_v2" => (
            imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
            payload,
        ),
        _ => (camel_to_snake(raw_name), payload),
    }
}

fn tool_variant(tool_call: &Value) -> Option<(&str, &Value)> {
    tool_call.as_object()?.iter().find_map(|(key, value)| {
        (!matches!(key.as_str(), "toolCallId" | "tool_call_id")).then_some((key.as_str(), value))
    })
}

fn tool_result_text(result: &Value) -> String {
    let payload = result
        .as_object()
        .and_then(|object| {
            object.iter().find_map(|(key, value)| {
                (!matches!(key.as_str(), "toolCallId" | "tool_call_id")).then_some(value)
            })
        })
        .unwrap_or(result);
    serde_json::to_string(payload).unwrap_or_default()
}

fn accumulate_impact(impact: &mut ImportedHistoryImpactStats, raw_name: &str, payload: &Value) {
    if !matches!(raw_name, "applyFileDiffs" | "apply_file_diffs") {
        return;
    }
    let mut touched = impact
        .touched_files
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    for diff in field(payload, &["diffs"])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(path) =
            field_str(diff, &["filePath", "file_path"]).and_then(|p| non_empty(Some(p)))
        {
            touched.insert(path);
        }
        impact.lines_removed += field_str(diff, &["search"])
            .map(line_count)
            .unwrap_or_default();
        impact.lines_added += field_str(diff, &["replace"])
            .map(line_count)
            .unwrap_or_default();
    }
    for new_file in field(payload, &["newFiles", "new_files"])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(path) =
            field_str(new_file, &["filePath", "file_path"]).and_then(|p| non_empty(Some(p)))
        {
            touched.insert(path);
        }
        impact.lines_added += field_str(new_file, &["content"])
            .map(line_count)
            .unwrap_or_default();
    }
    for deleted_file in field(payload, &["deletedFiles", "deleted_files"])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(path) =
            field_str(deleted_file, &["filePath", "file_path"]).and_then(|p| non_empty(Some(p)))
        {
            touched.insert(path);
        }
    }
    for update in field(payload, &["v4aUpdates", "v4a_updates"])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(path) =
            field_str(update, &["filePath", "file_path"]).and_then(|p| non_empty(Some(p)))
        {
            touched.insert(path);
        }
        for hunk in field(update, &["hunks"])
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            impact.lines_removed += field_str(hunk, &["old"])
                .map(line_count)
                .unwrap_or_default();
            impact.lines_added += field_str(hunk, &["new"])
                .map(line_count)
                .unwrap_or_default();
        }
    }
    impact.touched_files = touched.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
}

fn first_edited_file_path(payload: &Value) -> Option<String> {
    [
        "diffs",
        "newFiles",
        "new_files",
        "deletedFiles",
        "deleted_files",
        "v4aUpdates",
        "v4a_updates",
    ]
    .iter()
    .find_map(|key| {
        field(payload, &[*key])
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| field_str(row, &["filePath", "file_path", "documentId", "document_id"]))
            .and_then(|path| non_empty(Some(path)))
    })
}

fn is_root_task(task: &Value) -> bool {
    field(task, &["dependencies"])
        .and_then(|dependencies| field_str(dependencies, &["parentTaskId", "parent_task_id"]))
        .map(|parent| parent.trim().is_empty())
        .unwrap_or(true)
}

fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    let object = value.as_object()?;
    names.iter().find_map(|name| object.get(*name))
}

fn field_str<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    field(value, names).and_then(Value::as_str)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn line_count(value: &str) -> i64 {
    if value.is_empty() {
        0
    } else {
        value.lines().count() as i64
    }
}

fn camel_to_snake(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for (index, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn timestamp_value_to_iso(value: &Value) -> Option<String> {
    if let Some(raw) = value.as_str() {
        return Some(imported_history::normalize_created_at(raw));
    }
    let seconds = field(value, &["seconds"])?;
    let seconds = seconds
        .as_i64()
        .or_else(|| seconds.as_str().and_then(|raw| raw.parse().ok()))?;
    let nanos = field(value, &["nanos"])
        .and_then(Value::as_i64)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp(seconds, nanos.max(0) as u32).map(|dt| dt.to_rfc3339())
}

fn timestamp_value_to_epoch_ms(value: &Value) -> Option<i64> {
    timestamp_value_to_iso(value)
        .as_deref()
        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
}

fn parse_warp_timestamp_ms(value: &str) -> Option<i64> {
    imported_history::parse_iso_to_epoch_ms_opt(value).or_else(|| {
        ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"]
            .iter()
            .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
            .map(|dt| dt.and_utc().timestamp_millis())
    })
}

fn load_task_blobs(conn: &Connection, conversation_id: &str) -> Result<Vec<Vec<u8>>, String> {
    if !table_exists(conn, "agent_tasks")? {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT task FROM agent_tasks WHERE conversation_id = ?1 ORDER BY id ASC")
        .map_err(|err| format!("Failed to prepare Warp task query: {err}"))?;
    let rows = stmt
        .query_map([conversation_id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|err| format!("Failed to query Warp tasks: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read Warp task row: {err}"))
}

fn load_conversation_last_modified_ms(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<i64>, String> {
    if !table_exists(conn, "agent_conversations")? {
        return Ok(None);
    }
    let raw = conn
        .query_row(
            "SELECT CAST(last_modified_at AS TEXT) FROM agent_conversations WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(raw.as_deref().and_then(parse_warp_timestamp_ms))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|err| format!("Failed to inspect Warp table {table}: {err}"))
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|err| format!("Failed to inspect Warp table {table}: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("Failed to inspect Warp table {table}: {err}"))?;
    for row in rows {
        if row.map_err(|err| format!("Failed to inspect Warp column: {err}"))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn warp_conversation_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(conversation_id) = session_id.strip_prefix(WARP_SESSION_PREFIX) else {
        return Err(format!("Invalid Warp session id: {session_id}"));
    };
    if conversation_id.trim().is_empty() {
        return Err("Warp session id is missing source id".to_string());
    }
    Ok(conversation_id)
}

fn open_warp_db() -> Result<Option<(Connection, PathBuf)>, String> {
    for path in warp_history_candidate_paths() {
        if !path.is_file() {
            continue;
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|err| format!("Failed to open Warp database {}: {err}", path.display()))?;
        return Ok(Some((conn, path)));
    }
    Ok(None)
}

/// Candidate `warp.sqlite` locations used by both import and source detection.
pub fn warp_history_candidate_paths() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut candidates = warp_db_candidate_paths_for_home(&home);
    if let Some(xdg_state_home) = env::var_os("XDG_STATE_HOME") {
        candidates.push(PathBuf::from(xdg_state_home).join("warp-terminal/warp.sqlite"));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join("warp/Warp/data/warp.sqlite"));
    }
    if let Some(data_local) = dirs::data_local_dir() {
        candidates.push(data_local.join("warp/Warp/data/warp.sqlite"));
    }
    dedupe_paths(candidates)
}

fn warp_db_candidate_paths_for_home(home: &Path) -> Vec<PathBuf> {
    dedupe_paths(vec![
        home.join("Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable").join(WARP_DB_FILENAME),
        home.join("Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Preview").join(WARP_DB_FILENAME),
        home.join("Library/Application Support/dev.warp.Warp-Stable").join(WARP_DB_FILENAME),
        home.join("Library/Application Support/dev.warp.Warp-Preview").join(WARP_DB_FILENAME),
        home.join(".local/state/warp-terminal").join(WARP_DB_FILENAME),
        home.join("AppData/Local/warp/Warp/data").join(WARP_DB_FILENAME),
    ])
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
