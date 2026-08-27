use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::projectors::turn_metadata::ProjectedTurnMetadata;
use crate::sources::imported_history::{self, ImportedToolCall};

use super::super::desktop_exec::codex_tool_output_text;
use super::super::CodexJsonlLine;
use super::cache::CodexTurnOffset;
use super::collector::{CodexTranscriptCollectionMode, CodexTranscriptCollector};
use super::messages::{
    content_text_from_payload, reasoning_text_from_payload, strip_ignored_embedded_images,
    user_message_chunk_from_line,
};
use super::tool_calls::{
    attach_subagent_activity_to_pending_call, background_cell_id, background_cell_key,
    codex_task_error_message, codex_tool_call_chunk, lifecycle_turn_id,
    output_parts_for_tool_calls, pending_custom_tool_calls_from_payload,
    pending_tool_calls_from_payload, resolve_codex_tool_outputs, wait_cell_id,
    web_search_call_from_payload, PendingBackgroundToolCall,
};
use super::CODEX_PROVIDER_SLUG;

type CodexTranscriptLoad = (
    Vec<ActivityChunk>,
    Vec<ProjectedTurnMetadata>,
    Vec<CodexTurnOffset>,
);

pub(super) fn parse_codex_app_from_path_with_mode<'a>(
    session_id: &'a str,
    path: &Path,
    mode: CodexTranscriptCollectionMode<'a>,
    start_offset: u64,
    initial_sequence: usize,
) -> Result<CodexTranscriptLoad, String> {
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    if start_offset > 0 {
        file.seek(SeekFrom::Start(start_offset)).map_err(|err| {
            format!(
                "Failed to seek Codex history {} to {start_offset}: {err}",
                path.display()
            )
        })?;
    }
    let mut reader = BufReader::new(file);

    let mut collector = CodexTranscriptCollector::new(session_id, mode);
    let mut pending_tool_calls: imported_history::PendingCallMap<Vec<ImportedToolCall>> =
        imported_history::PendingCallMap::new();
    let mut background_tool_calls: imported_history::PendingCallMap<PendingBackgroundToolCall> =
        imported_history::PendingCallMap::new();
    let mut pending_task_turn_id: Option<String> = None;
    let mut pending_task_turn_offset: Option<u64> = None;
    let mut active_task_turn_id: Option<String> = None;
    let mut sequence = initial_sequence;

    let mut line = String::new();
    let mut next_byte_offset = start_offset;
    loop {
        line.clear();
        let line_start_offset = next_byte_offset;
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        if bytes_read == 0 {
            break;
        }
        next_byte_offset = next_byte_offset.saturating_add(bytes_read as u64);
        strip_ignored_embedded_images(&mut line);
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
                pending_task_turn_offset = Some(line_start_offset);
            }
            "user_message" | "item_completed" => {
                if let Some(user_chunk) =
                    user_message_chunk_from_line(session_id, sequence, &created_at, &parsed)
                {
                    let user_sequence = sequence;
                    sequence += 1;
                    if collector.start_turn(user_chunk) {
                        break;
                    }
                    collector.record_turn_offset(
                        format!("codex-user-{user_sequence}"),
                        pending_task_turn_offset.take().unwrap_or(line_start_offset),
                        user_sequence,
                    );
                    if let Some(turn_id) = pending_task_turn_id.take() {
                        collector
                            .current
                            .push(imported_history::task_lifecycle_chunk(
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
                    collector
                        .current
                        .push(imported_history::assistant_message_chunk(
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
                        collector
                            .current
                            .push(imported_history::assistant_message_chunk(
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
                    collector.current.push(imported_history::thinking_chunk(
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
                    collector
                        .current
                        .push(codex_tool_call_chunk(session_id, sequence, &call, "", None));
                    sequence += 1;
                }
            }
            "sub_agent_activity" => {
                attach_subagent_activity_to_pending_call(&parsed.payload, &mut pending_tool_calls);
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = parsed.payload.get("call_id").and_then(Value::as_str);
                if let Some(call_id) = call_id {
                    if let Some((file_order, calls)) = pending_tool_calls.take(call_id) {
                        let output_value = parsed.payload.get("output");
                        let output = codex_tool_output_text(output_value);
                        if let Some(cell_id) = wait_cell_id(&calls) {
                            let cell_key = background_cell_key(cell_id);
                            if let Some((background_order, mut background)) =
                                background_tool_calls.take(&cell_key)
                            {
                                if let Some(next_cell_id) = background_cell_id(&output) {
                                    background.latest_output = output;
                                    background_tool_calls.reinsert(
                                        background_cell_key(&next_cell_id),
                                        background_order,
                                        background,
                                    );
                                } else {
                                    let final_output = if output.trim().is_empty() {
                                        background.latest_output
                                    } else {
                                        output
                                    };
                                    resolve_codex_tool_outputs(
                                        session_id,
                                        background.calls,
                                        background_order,
                                        output_value,
                                        &final_output,
                                        &mut collector.current,
                                        &mut sequence,
                                        &mut background_tool_calls,
                                    );
                                }
                                continue;
                            }
                        }
                        if let Some(cell_id) = background_cell_id(&output) {
                            background_tool_calls.reinsert(
                                background_cell_key(&cell_id),
                                file_order,
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
                            file_order,
                            output_value,
                            &output,
                            &mut collector.current,
                            &mut sequence,
                            &mut background_tool_calls,
                        );
                    }
                }
            }
            "task_complete" => {
                let task_error_message = codex_task_error_message(&parsed.payload);
                if let Some(error_message) = task_error_message.as_deref() {
                    let mut error_chunk = ActivityChunk::new(session_id, "error", "error");
                    error_chunk.chunk_id = format!("codex-error-{sequence}");
                    error_chunk.created_at = created_at.clone();
                    error_chunk.result = json!({
                        "error": error_message,
                        "observation": error_message,
                        "success": false,
                    });
                    collector.current.push(error_chunk);
                    sequence += 1;
                }
                if let Some(turn_id) =
                    lifecycle_turn_id(&parsed.payload, active_task_turn_id.as_deref())
                {
                    let lifecycle_action = if task_error_message.is_some() {
                        imported_history::ACTION_TYPE_TASK_FAILED
                    } else {
                        imported_history::ACTION_TYPE_TASK_COMPLETED
                    };
                    collector
                        .current
                        .push(imported_history::task_lifecycle_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            lifecycle_action,
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
                    collector
                        .current
                        .push(imported_history::task_lifecycle_chunk(
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

    for calls in pending_tool_calls.drain_in_file_order() {
        for call in calls {
            collector
                .current
                .push(codex_tool_call_chunk(session_id, sequence, &call, "", None));
            sequence += 1;
        }
    }
    for background in background_tool_calls.drain_in_file_order() {
        if background
            .calls
            .iter()
            .all(|call| call.canonical_name == imported_history::FUNCTION_AWAIT_OUTPUT)
        {
            continue;
        }
        let outputs = output_parts_for_tool_calls(&background.calls, &background.latest_output);
        for (call, output) in background.calls.iter().zip(outputs.iter()) {
            collector.current.push(codex_tool_call_chunk(
                session_id, sequence, call, output, None,
            ));
            sequence += 1;
        }
    }

    Ok(collector.finish())
}
