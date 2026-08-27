use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::sources::imported_history::{self, ImportedToolCall};

use super::super::desktop_exec::{codex_tool_exit_code, codex_tool_output_failed};
use super::super::normalize::normalize_tool_name_key;
use super::CODEX_PROVIDER_SLUG;

mod exec_results;
mod normalization;

use exec_results::{append_incremental_output, codex_exec_results, CodexExecResult};
pub(crate) use normalization::pending_custom_tool_calls_from_payload;
pub(super) use normalization::{pending_tool_calls_from_payload, web_search_call_from_payload};

pub(super) struct PendingBackgroundToolCall {
    pub(super) calls: Vec<ImportedToolCall>,
    pub(super) latest_output: String,
}

pub(super) fn attach_subagent_activity_to_pending_call(
    payload: &Value,
    pending_tool_calls: &mut imported_history::PendingCallMap<Vec<ImportedToolCall>>,
) {
    if payload.get("kind").and_then(Value::as_str) != Some("started") {
        return;
    }
    let Some(call_id) = payload.get("event_id").and_then(Value::as_str) else {
        return;
    };
    let Some(calls) = pending_tool_calls.get_mut(call_id) else {
        return;
    };
    let Some(call) = calls
        .iter_mut()
        .find(|call| call.canonical_name == "subagent")
    else {
        return;
    };
    let Some(args) = call.args.as_object_mut() else {
        return;
    };
    if let Some(thread_id) = payload
        .get("agent_thread_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.insert(
            "codexAgentThreadId".to_string(),
            Value::String(thread_id.to_string()),
        );
    }
    if let Some(agent_path) = payload
        .get("agent_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.insert(
            "agent_path".to_string(),
            Value::String(agent_path.to_string()),
        );
    }
}

pub(super) fn lifecycle_turn_id<'a>(
    payload: &'a Value,
    active_turn_id: Option<&'a str>,
) -> Option<&'a str> {
    payload
        .get("turn_id")
        .and_then(Value::as_str)
        .or(active_turn_id)
}

pub(super) fn codex_task_error_message(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    if error.is_null() {
        return None;
    }

    let message = error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))
        .map(str::trim)
        .filter(|message| !message.is_empty());
    Some(match message {
        Some(message) => message.to_string(),
        None if error.as_object().is_some_and(|object| object.is_empty()) => {
            "Codex task failed".to_string()
        }
        None => format!("Codex task failed: {error}"),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn resolve_codex_tool_outputs(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    file_order: u64,
    output_value: Option<&Value>,
    fallback_output: &str,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut imported_history::PendingCallMap<PendingBackgroundToolCall>,
) {
    let mut results = codex_exec_results(output_value);
    if results.len() == calls.len() {
        for (call, result) in calls.into_iter().zip(results.drain(..)) {
            resolve_codex_call_group(
                transcript_session_id,
                vec![call],
                file_order,
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
            file_order,
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
    file_order: u64,
    result: CodexExecResult,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut imported_history::PendingCallMap<PendingBackgroundToolCall>,
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
            background_tool_calls.reinsert(
                background_session_key(session_id),
                file_order,
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
    background_tool_calls: &mut imported_history::PendingCallMap<PendingBackgroundToolCall>,
) {
    let source_session_id = continuation
        .args
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some((background_order, mut background)) =
        background_tool_calls.take(&background_session_key(source_session_id))
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
            background_tool_calls.reinsert(
                background_session_key(next_session_id),
                background_order,
                background,
            );
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

pub(super) fn background_cell_key(cell_id: &str) -> String {
    format!("cell:{cell_id}")
}

fn background_session_key(session_id: &str) -> String {
    format!("session:{session_id}")
}

pub(super) fn background_cell_id(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Script running with cell ID ")
            .map(str::trim)
            .filter(|cell_id| !cell_id.is_empty())
            .map(str::to_string)
    })
}

pub(super) fn wait_cell_id(calls: &[ImportedToolCall]) -> Option<&str> {
    let [call] = calls else {
        return None;
    };
    if normalize_tool_name_key(&call.raw_name) != "wait" {
        return None;
    }
    call.args.get("cell_id").and_then(Value::as_str)
}

pub(super) fn codex_tool_call_chunk(
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
