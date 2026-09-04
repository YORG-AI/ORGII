//! `events.jsonl` → [`ActivityChunk`] replay: pair tool starts with their
//! completions, then emit user/assistant/tool chunks under bounded budgets.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde_json::Value;

use crate::sources::imported_history::{
    self, paths as imported_paths, watermark::WatermarkedTranscriptReader, ImportedToolCall,
};

use super::bounded::{bounded_data_str, bounded_nonempty, bounded_tool_arguments};
use super::paths::{copilot_source_id_from_session_id, resolve_copilot_events_path};
use super::tools::{map_copilot_tool_call, tool_result_text};
use super::types::CopilotEventLine;
use super::{
    COPILOT_METADATA_PARSER_VERSION, COPILOT_PROVIDER_SLUG, MAX_EVENTS_FILE_BYTES, MAX_ID_BYTES,
    MAX_REPLAY_CHUNKS, MAX_REPLAY_MESSAGE_CHARS, MAX_REPLAY_TEXT_BYTES, MAX_REPLAY_TOOL_RECORDS,
    MAX_TOOL_REQUESTS_PER_EVENT,
};

pub fn load_copilot_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = copilot_source_id_from_session_id(session_id)?;
    let path = resolve_copilot_events_path(conn, source_session_id)?;
    load_copilot_history_from_path(session_id, &path)
}

// ---------------------------------------------------------------------------
// events.jsonl → ActivityChunk conversion
// ---------------------------------------------------------------------------

pub(super) fn load_copilot_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect Copilot history {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("Unsafe Copilot history path: {}", path.display()));
    }
    let (mtime, size) = imported_paths::file_metadata_signature(path, "Copilot")?;
    if size > MAX_EVENTS_FILE_BYTES {
        return Err("Copilot history exceeds the replay safety limit".to_string());
    }

    let mut tool_results: HashMap<String, (Option<bool>, String)> = HashMap::new();
    let mut tool_start_args: HashMap<String, Value> = HashMap::new();
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Copilot",
        None,
        COPILOT_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    while let Some(line) = reader.next_line()? {
        let Ok(event) = serde_json::from_str::<CopilotEventLine>(line.text.trim()) else {
            continue;
        };
        index_copilot_tool_event(&event, &mut tool_results, &mut tool_start_args)?;
    }

    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Copilot",
        None,
        COPILOT_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    let mut chunks = Vec::new();
    let mut retained_bytes = 0usize;
    let mut sequence = 0usize;
    while let Some(line) = reader.next_line()? {
        let Ok(event) = serde_json::from_str::<CopilotEventLine>(line.text.trim()) else {
            continue;
        };
        append_copilot_event_chunks(
            session_id,
            &event,
            &tool_results,
            &tool_start_args,
            &mut chunks,
            &mut sequence,
            &mut retained_bytes,
        )?;
    }
    Ok(chunks)
}

fn index_copilot_tool_event(
    event: &CopilotEventLine,
    tool_results: &mut HashMap<String, (Option<bool>, String)>,
    tool_start_args: &mut HashMap<String, Value>,
) -> Result<(), String> {
    match event.r#type.as_str() {
        "tool.execution_complete" => {
            if let Some(call_id) = bounded_data_str(&event.data, "toolCallId", MAX_ID_BYTES) {
                if !tool_results.contains_key(&call_id)
                    && tool_results.len() >= MAX_REPLAY_TOOL_RECORDS
                {
                    return Err("Copilot replay exceeds the tool-result safety limit".to_string());
                }
                let success = event.data.get("success").and_then(Value::as_bool);
                let output = tool_result_text(
                    event
                        .data
                        .get("result")
                        .and_then(|result| result.get("content")),
                );
                tool_results.insert(call_id, (success, output));
            }
        }
        "tool.execution_start" => {
            if let Some(call_id) = bounded_data_str(&event.data, "toolCallId", MAX_ID_BYTES) {
                if !tool_start_args.contains_key(&call_id)
                    && tool_start_args.len() >= MAX_REPLAY_TOOL_RECORDS
                {
                    return Err("Copilot replay exceeds the tool-argument safety limit".to_string());
                }
                if let Some(arguments) =
                    event.data.get("arguments").and_then(bounded_tool_arguments)
                {
                    tool_start_args.insert(call_id, arguments);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_copilot_event_chunks(
    session_id: &str,
    event: &CopilotEventLine,
    tool_results: &HashMap<String, (Option<bool>, String)>,
    tool_start_args: &HashMap<String, Value>,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    retained_bytes: &mut usize,
) -> Result<(), String> {
    let created_at = bounded_nonempty(&event.timestamp, MAX_ID_BYTES).unwrap_or_default();
    match event.r#type.as_str() {
        "user.message" => {
            let Some(text) = event.data.get("content").and_then(Value::as_str) else {
                return Ok(());
            };
            let text = bounded_replay_text(text);
            if text.is_empty() {
                return Ok(());
            }
            let chunk = imported_history::user_message_chunk(
                session_id,
                COPILOT_PROVIDER_SLUG,
                *sequence,
                &created_at,
                &text,
            );
            push_copilot_replay_chunk(chunks, retained_bytes, chunk)?;
            *sequence = sequence.saturating_add(1);
        }
        "assistant.message" => {
            if let Some(text) = event.data.get("content").and_then(Value::as_str) {
                let text = bounded_replay_text(text);
                if !text.is_empty() {
                    let chunk = imported_history::assistant_message_chunk(
                        session_id,
                        COPILOT_PROVIDER_SLUG,
                        *sequence,
                        &created_at,
                        &text,
                    );
                    push_copilot_replay_chunk(chunks, retained_bytes, chunk)?;
                    *sequence = sequence.saturating_add(1);
                }
            }
            let requests = event
                .data
                .get("toolRequests")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if requests.len() > MAX_TOOL_REQUESTS_PER_EVENT {
                return Err("Copilot replay event exceeds the tool safety limit".to_string());
            }
            for request in requests {
                let call_id = request
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                    .unwrap_or_default();
                let raw_name = request
                    .get("name")
                    .and_then(Value::as_str)
                    .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                    .unwrap_or_else(|| "tool".to_string());
                let arguments = request
                    .get("arguments")
                    .filter(|value| !value.is_null())
                    .and_then(bounded_tool_arguments)
                    .or_else(|| tool_start_args.get(&call_id).cloned())
                    .unwrap_or(Value::Null);
                let (canonical_name, args) = map_copilot_tool_call(&raw_name, &arguments);
                let paired = tool_results.get(&call_id);
                let output = paired.map(|(_, output)| output.as_str()).unwrap_or("");
                let call = ImportedToolCall {
                    call_id: call_id.clone(),
                    raw_name,
                    canonical_name,
                    args,
                    created_at: created_at.clone(),
                };
                let mut chunk = imported_history::tool_call_chunk(
                    session_id,
                    COPILOT_PROVIDER_SLUG,
                    *sequence,
                    &call,
                    output,
                );
                if paired.and_then(|(success, _)| *success) == Some(false) {
                    if let Some(result) = chunk.result.as_object_mut() {
                        result.insert("success".to_string(), Value::Bool(false));
                        result.insert("status".to_string(), Value::String("failed".to_string()));
                    }
                }
                push_copilot_replay_chunk(chunks, retained_bytes, chunk)?;
                *sequence = sequence.saturating_add(1);
            }
        }
        _ => {}
    }
    Ok(())
}

fn push_copilot_replay_chunk(
    chunks: &mut Vec<ActivityChunk>,
    retained_bytes: &mut usize,
    chunk: ActivityChunk,
) -> Result<(), String> {
    let chunk_bytes = chunk
        .args
        .to_string()
        .len()
        .saturating_add(chunk.result.to_string().len())
        .saturating_add(chunk.function.len())
        .saturating_add(chunk.created_at.len());
    if chunks.len() >= MAX_REPLAY_CHUNKS
        || retained_bytes.saturating_add(chunk_bytes) > MAX_REPLAY_TEXT_BYTES
    {
        return Err("Copilot replay exceeds the bounded in-memory safety limit".to_string());
    }
    *retained_bytes = retained_bytes.saturating_add(chunk_bytes);
    chunks.push(chunk);
    Ok(())
}

fn bounded_replay_text(text: &str) -> String {
    text.trim().chars().take(MAX_REPLAY_MESSAGE_CHARS).collect()
}

#[cfg(test)]
pub(super) fn events_to_chunks(
    session_id: &str,
    events: &[CopilotEventLine],
) -> Vec<ActivityChunk> {
    let mut tool_results = HashMap::new();
    let mut tool_start_args = HashMap::new();
    for event in events {
        index_copilot_tool_event(event, &mut tool_results, &mut tool_start_args)
            .expect("test tool index");
    }
    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    let mut retained_bytes = 0usize;
    for event in events {
        append_copilot_event_chunks(
            session_id,
            event,
            &tool_results,
            &tool_start_args,
            &mut chunks,
            &mut sequence,
            &mut retained_bytes,
        )
        .expect("test replay");
    }
    chunks
}
