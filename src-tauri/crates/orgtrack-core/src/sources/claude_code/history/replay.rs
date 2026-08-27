use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::sources::imported_history::{self, ImportedToolCall};

use super::discovery::{claude_file_stem_from_session_id, resolve_claude_session_path};
use super::tools::{apply_claude_edit_diff, claude_tool_call_from_item};
use super::types::{is_harness_injected_user_line, ClaudeJsonlLine};
use super::CLAUDE_CODE_PROVIDER_SLUG;

pub fn load_claude_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    load_claude_code_history_from_path(session_id, &path)
}

pub(super) fn load_claude_code_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    load_claude_code_history_from_reader(session_id, BufReader::new(file), 0, None)
}

pub(super) fn load_claude_code_history_from_reader<R: BufRead>(
    session_id: &str,
    reader: R,
    start_sequence: usize,
    forced_first_user_id: Option<&str>,
) -> Result<Vec<ActivityChunk>, String> {
    let mut chunks = Vec::new();
    let mut pending_tool_calls: imported_history::PendingCallMap<ImportedToolCall> =
        imported_history::PendingCallMap::new();
    let mut sequence = start_sequence;
    let mut forced_first_user_id = forced_first_user_id;

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
        let harness_injected = is_harness_injected_user_line(&parsed);
        let Some(message) = parsed.message else {
            continue;
        };

        match parsed.r#type.as_str() {
            "user" => {
                if let Some(tool_result_output) = claude_tool_result_text(&message.content) {
                    if let Some((call_id, output)) = tool_result_output {
                        if let Some(call) = pending_tool_calls.remove(&call_id) {
                            let mut chunk = imported_history::tool_call_chunk(
                                session_id,
                                CLAUDE_CODE_PROVIDER_SLUG,
                                sequence,
                                &call,
                                &output,
                            );
                            // Edit/MultiEdit/Write results carry a
                            // `structuredPatch`; attach it as the exact diff so
                            // the edit card renders the real change.
                            apply_claude_edit_diff(&mut chunk, parsed.tool_use_result.as_ref());
                            chunks.push(chunk);
                            sequence += 1;
                        }
                    }
                } else {
                    // Strip the GUI exec-mode briefing; a bridge-only message
                    // carries no user-authored text, so emit no bubble.
                    let text = claude_content_text(&message.content)
                        .map(|text| {
                            imported_history::strip_orgii_exec_mode_bridge(&text).to_string()
                        })
                        .unwrap_or_default();
                    let images = claude_content_image_data_urls(&message.content);
                    if !harness_injected && (!text.trim().is_empty() || !images.is_empty()) {
                        let mut chunk = imported_history::user_message_chunk(
                            session_id,
                            CLAUDE_CODE_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            &text,
                        );
                        if let Some(turn_id) = forced_first_user_id.take() {
                            chunk.chunk_id = turn_id.to_string();
                        }
                        if !images.is_empty() {
                            chunk.result["images"] = json!(images);
                        }
                        chunks.push(chunk);
                        sequence += 1;
                    }
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

    for call in pending_tool_calls.drain_in_file_order() {
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

pub(super) fn claude_content_items(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

pub(super) fn claude_content_text(content: &Value) -> Option<String> {
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

fn claude_content_image_data_urls(content: &Value) -> Vec<String> {
    let Value::Array(items) = content else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("image") {
                return None;
            }
            let source = item.get("source")?;
            if source.get("type").and_then(Value::as_str) != Some("base64") {
                return None;
            }
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let data = source.get("data").and_then(Value::as_str)?;
            if data.is_empty() {
                return None;
            }
            Some(format!("data:{media_type};base64,{data}"))
        })
        .collect()
}

pub(super) fn claude_tool_result_text(content: &Value) -> Option<Option<(String, String)>> {
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
