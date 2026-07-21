//! Transcript loading and tool-call chunk assembly.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::sources::imported_history::{self, strip_orgii_exec_mode_bridge, ImportedToolCall};

use super::desktop_exec::{
    codex_tool_exit_code, codex_tool_output_failed, codex_tool_output_text,
    normalize_codex_exec_tool_calls,
};
use super::normalize::{
    normalize_codex_tool_calls, normalize_tool_name_key, normalize_web_search_args,
};
use super::CodexJsonlLine;

const CODEX_PROVIDER_SLUG: &str = "codex";

struct PendingBackgroundToolCall {
    calls: Vec<ImportedToolCall>,
    latest_output: String,
}

#[derive(Debug)]
struct CodexExecResult {
    output: String,
    session_id: Option<String>,
    exit_code: Option<i64>,
}

pub fn load_codex_app_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, Vec<ImportedToolCall>> = HashMap::new();
    let mut background_tool_calls: HashMap<String, PendingBackgroundToolCall> = HashMap::new();
    let mut pending_task_turn_id: Option<String> = None;
    let mut active_task_turn_id: Option<String> = None;
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
            // Codex writes task_started immediately before its user_message.
            // Hold it until the user chunk exists so the projector can attach
            // the lifecycle marker to the correct conversational turn.
            "task_started" => {
                pending_task_turn_id = parsed
                    .payload
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
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
                    if let Some(turn_id) = pending_task_turn_id.take() {
                        chunks.push(imported_history::task_lifecycle_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            imported_history::ACTION_TYPE_TASK_START,
                            &turn_id,
                        ));
                        sequence += 1;
                        active_task_turn_id = Some(turn_id);
                    }
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
            "web_search_call" => {
                if let Some(call) = web_search_call_from_payload(&parsed.payload, &created_at) {
                    chunks.push(codex_tool_call_chunk(session_id, sequence, &call, "", None));
                    sequence += 1;
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = parsed.payload.get("call_id").and_then(Value::as_str);
                if let Some(call_id) = call_id {
                    if let Some(calls) = pending_tool_calls.remove(call_id) {
                        let output_value = parsed.payload.get("output");
                        let output = codex_tool_output_text(output_value);
                        if let Some(cell_id) = wait_cell_id(&calls) {
                            let cell_key = background_cell_key(cell_id);
                            if let Some(mut background) = background_tool_calls.remove(&cell_key) {
                                if let Some(next_cell_id) = background_cell_id(&output) {
                                    background.latest_output = output;
                                    background_tool_calls
                                        .insert(background_cell_key(&next_cell_id), background);
                                } else {
                                    let final_output = if output.trim().is_empty() {
                                        background.latest_output
                                    } else {
                                        output
                                    };
                                    resolve_codex_tool_outputs(
                                        session_id,
                                        background.calls,
                                        output_value,
                                        &final_output,
                                        &mut chunks,
                                        &mut sequence,
                                        &mut background_tool_calls,
                                    );
                                }
                                continue;
                            }
                        }
                        if let Some(cell_id) = background_cell_id(&output) {
                            background_tool_calls.insert(
                                background_cell_key(&cell_id),
                                PendingBackgroundToolCall {
                                    calls,
                                    latest_output: output,
                                },
                            );
                            continue;
                        }
                        resolve_codex_tool_outputs(
                            session_id,
                            calls,
                            output_value,
                            &output,
                            &mut chunks,
                            &mut sequence,
                            &mut background_tool_calls,
                        );
                    }
                }
            }
            "task_complete" => {
                if let Some(turn_id) =
                    lifecycle_turn_id(&parsed.payload, active_task_turn_id.as_deref())
                {
                    chunks.push(imported_history::task_lifecycle_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        imported_history::ACTION_TYPE_TASK_COMPLETED,
                        turn_id,
                    ));
                    sequence += 1;
                    active_task_turn_id = None;
                }
            }
            "turn_aborted" => {
                if let Some(turn_id) =
                    lifecycle_turn_id(&parsed.payload, active_task_turn_id.as_deref())
                {
                    chunks.push(imported_history::task_lifecycle_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        imported_history::ACTION_TYPE_TASK_FAILED,
                        turn_id,
                    ));
                    sequence += 1;
                    active_task_turn_id = None;
                }
            }
            _ => {}
        }
    }

    for calls in pending_tool_calls.into_values() {
        for call in calls {
            chunks.push(codex_tool_call_chunk(session_id, sequence, &call, "", None));
            sequence += 1;
        }
    }
    for background in background_tool_calls.into_values() {
        if background
            .calls
            .iter()
            .all(|call| call.canonical_name == imported_history::FUNCTION_AWAIT_OUTPUT)
        {
            continue;
        }
        let outputs = output_parts_for_tool_calls(&background.calls, &background.latest_output);
        for (call, output) in background.calls.iter().zip(outputs.iter()) {
            chunks.push(codex_tool_call_chunk(
                session_id, sequence, call, output, None,
            ));
            sequence += 1;
        }
    }

    Ok(chunks)
}

fn lifecycle_turn_id<'a>(payload: &'a Value, active_turn_id: Option<&'a str>) -> Option<&'a str> {
    payload
        .get("turn_id")
        .and_then(Value::as_str)
        .or(active_turn_id)
}

fn resolve_codex_tool_outputs(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    output_value: Option<&Value>,
    fallback_output: &str,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut HashMap<String, PendingBackgroundToolCall>,
) {
    let mut results = codex_exec_results(output_value);
    if results.len() == calls.len() {
        for (call, result) in calls.into_iter().zip(results.drain(..)) {
            resolve_codex_call_group(
                transcript_session_id,
                vec![call],
                result,
                chunks,
                sequence,
                background_tool_calls,
            );
        }
        return;
    }
    if results.len() == 1 {
        resolve_codex_call_group(
            transcript_session_id,
            calls,
            results.remove(0),
            chunks,
            sequence,
            background_tool_calls,
        );
        return;
    }

    emit_codex_call_group(
        transcript_session_id,
        calls,
        fallback_output,
        None,
        chunks,
        sequence,
    );
}

fn resolve_codex_call_group(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    result: CodexExecResult,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut HashMap<String, PendingBackgroundToolCall>,
) {
    if calls.len() == 1 && calls[0].canonical_name == imported_history::FUNCTION_AWAIT_OUTPUT {
        resolve_write_stdin_call(
            transcript_session_id,
            calls.into_iter().next().expect("single continuation call"),
            result,
            chunks,
            sequence,
            background_tool_calls,
        );
        return;
    }

    if result.exit_code.is_none() {
        if let Some(session_id) = result.session_id.as_deref() {
            background_tool_calls.insert(
                background_session_key(session_id),
                PendingBackgroundToolCall {
                    calls,
                    latest_output: result.output,
                },
            );
            return;
        }
    }

    emit_codex_call_group(
        transcript_session_id,
        calls,
        &result.output,
        result.exit_code,
        chunks,
        sequence,
    );
}

fn resolve_write_stdin_call(
    transcript_session_id: &str,
    continuation: ImportedToolCall,
    result: CodexExecResult,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut HashMap<String, PendingBackgroundToolCall>,
) {
    let source_session_id = continuation
        .args
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(mut background) =
        background_tool_calls.remove(&background_session_key(source_session_id))
    else {
        emit_codex_call_group(
            transcript_session_id,
            vec![continuation],
            &result.output,
            result.exit_code,
            chunks,
            sequence,
        );
        return;
    };

    record_stdin_event(&mut background.calls, &continuation);
    append_incremental_output(&mut background.latest_output, &result.output);

    if result.exit_code.is_none() {
        if let Some(next_session_id) = result.session_id.as_deref() {
            background_tool_calls.insert(background_session_key(next_session_id), background);
            return;
        }
    }

    emit_codex_call_group(
        transcript_session_id,
        background.calls,
        &background.latest_output,
        result.exit_code,
        chunks,
        sequence,
    );
}

fn record_stdin_event(calls: &mut [ImportedToolCall], continuation: &ImportedToolCall) {
    let chars = continuation
        .args
        .get("chars")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if chars.is_empty() {
        return;
    }
    let kind = if chars == "\u{3}" {
        "interrupt"
    } else {
        "input"
    };
    let event = json!({
        "kind": kind,
        "chars": chars,
        "created_at": continuation.created_at,
    });
    for call in calls {
        let Some(args) = call.args.as_object_mut() else {
            continue;
        };
        let events = args
            .entry("stdin_events")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut();
        if let Some(events) = events {
            events.push(event.clone());
        }
    }
}

fn append_incremental_output(existing: &mut String, next: &str) {
    if !next.is_empty() {
        existing.push_str(next);
    }
}

fn emit_codex_call_group(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    output: &str,
    exit_code: Option<i64>,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
) {
    let outputs = output_parts_for_tool_calls(&calls, output);
    for (call, output) in calls.iter().zip(outputs.iter()) {
        chunks.push(codex_tool_call_chunk(
            transcript_session_id,
            *sequence,
            call,
            output,
            exit_code,
        ));
        *sequence += 1;
    }
}

fn codex_exec_results(output: Option<&Value>) -> Vec<CodexExecResult> {
    let parts = match output {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>(),
        Some(Value::String(text)) => vec![text.as_str()],
        _ => Vec::new(),
    };

    let mut results: Vec<CodexExecResult> = Vec::new();
    for part in parts {
        if let Some(result) = codex_exec_result_from_text(part) {
            results.push(result);
        } else if !is_codex_script_wrapper_text(part) {
            if let Some(result) = results.last_mut() {
                append_incremental_output(&mut result.output, part);
            }
        }
    }
    results
}

fn codex_exec_result_from_text(text: &str) -> Option<CodexExecResult> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    let object = value.as_object()?;
    if !object.contains_key("output")
        && !object.contains_key("session_id")
        && !object.contains_key("sessionId")
        && !object.contains_key("exit_code")
        && !object.contains_key("exitCode")
    {
        return None;
    }
    Some(CodexExecResult {
        output: object
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        session_id: object
            .get("session_id")
            .or_else(|| object.get("sessionId"))
            .and_then(json_scalar_string),
        exit_code: object
            .get("exit_code")
            .or_else(|| object.get("exitCode"))
            .and_then(Value::as_i64),
    })
}

fn json_scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn is_codex_script_wrapper_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("Script completed")
        || trimmed.starts_with("Script running with cell ID")
        || trimmed.starts_with("Script failed")
        || trimmed.starts_with("Script error")
}

fn background_cell_key(cell_id: &str) -> String {
    format!("cell:{cell_id}")
}

fn background_session_key(session_id: &str) -> String {
    format!("session:{session_id}")
}

fn background_cell_id(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Script running with cell ID ")
            .map(str::trim)
            .filter(|cell_id| !cell_id.is_empty())
            .map(str::to_string)
    })
}

fn wait_cell_id(calls: &[ImportedToolCall]) -> Option<&str> {
    let [call] = calls else {
        return None;
    };
    if normalize_tool_name_key(&call.raw_name) != "wait" {
        return None;
    }
    call.args.get("cell_id").and_then(Value::as_str)
}

fn codex_tool_call_chunk(
    session_id: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
    structured_exit_code: Option<i64>,
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
    let exit_code = structured_exit_code.or_else(|| codex_tool_exit_code(output));
    let failed = codex_tool_output_failed(output, exit_code);
    if let Some(result) = chunk.result.as_object_mut() {
        if let Some(exit_code) = exit_code {
            result.insert("exit_code".to_string(), json!(exit_code));
        }
        if failed {
            result.insert("success".to_string(), Value::Bool(false));
            result.insert("status".to_string(), Value::String("failed".to_string()));
            result.insert("is_error".to_string(), Value::Bool(true));
            result.insert(
                "failure".to_string(),
                json!({
                    "command": call.args.get("command").and_then(Value::as_str).unwrap_or_default(),
                    "stdout": "",
                    "stderr": output,
                    "exitCode": exit_code,
                }),
            );
        }
    }
    chunk
}

pub(crate) fn output_parts_for_tool_calls(calls: &[ImportedToolCall], output: &str) -> Vec<String> {
    if calls.len() <= 1 {
        return vec![output.to_string()];
    }

    // A multiline Desktop shell script may normalize to several reads followed
    // by a different final operation (for example three `sed` reads then
    // `rg`). Each bounded read consumes its known number of lines; the final
    // tool receives the remainder.
    let bounded_prefix_limits = calls[..calls.len() - 1]
        .iter()
        .map(read_line_limit_from_call)
        .collect::<Option<Vec<_>>>();
    let Some(limits) = bounded_prefix_limits else {
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

pub(crate) fn pending_custom_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let input = payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let normalized_calls = if normalize_tool_name_key(&raw_name) == "exec" {
        normalize_codex_exec_tool_calls(input)
    } else {
        let args = if raw_name == "apply_patch" {
            json!({ "patch": input })
        } else {
            json!({ "input": input })
        };
        normalize_codex_tool_calls(&raw_name, args)
    };
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

fn web_search_call_from_payload(payload: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = payload.get("id")?.as_str()?.to_string();
    let action = payload.get("action").cloned().unwrap_or_else(|| json!({}));
    Some(ImportedToolCall {
        call_id,
        raw_name: "web_search_call".to_string(),
        canonical_name: "web_search".to_string(),
        args: normalize_web_search_args(action),
        created_at: created_at.to_string(),
    })
}

fn split_call_id(call_id: &str, index: usize, total: usize) -> String {
    if total <= 1 {
        call_id.to_string()
    } else {
        format!("{call_id}:part-{index}")
    }
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

pub(crate) fn user_message_from_payload(payload: &Value) -> Option<String> {
    let raw = payload.get("message").and_then(Value::as_str)?;
    let stripped = strip_orgii_exec_mode_bridge(raw);
    // Bridge-only messages carry no user-authored text: skip them entirely
    // (no replay bubble, no title candidate).
    if stripped.trim().is_empty() {
        return None;
    }
    Some(stripped.to_string())
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
