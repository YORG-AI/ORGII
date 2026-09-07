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
    content_text_from_payload, injected_user_message_chunk_from_response_message,
    reasoning_text_from_payload, strip_ignored_embedded_images,
    user_image_data_urls_from_response_message, user_message_chunk_from_line,
};
use super::tool_calls::{
    attach_subagent_activity_to_pending_call, background_cell_id, background_cell_key,
    codex_task_error_message, codex_tool_call_chunk, lifecycle_turn_id,
    output_parts_for_tool_calls, pending_custom_tool_calls_from_payload,
    pending_tool_calls_from_payload, resolve_codex_tool_outputs, wait_cell_id,
    web_search_call_from_payload, PendingBackgroundToolCall,
};
use super::{CODEX_PROVIDER_SLUG, NATIVE_SOURCE_EVENT_ID_ARG, NATIVE_SOURCE_EVENT_ID_PREFIX};

type CodexTranscriptLoad = (
    Vec<ActivityChunk>,
    Vec<ProjectedTurnMetadata>,
    Vec<CodexTurnOffset>,
);

#[derive(Debug)]
struct PendingCompactionMirror {
    window_id: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AssistantMirrorKind {
    EventMessage,
    ResponseItem,
}

struct PendingAssistantMirror {
    kind: AssistantMirrorKind,
    message: String,
}

fn attach_native_source_event_id(chunk: &mut ActivityChunk, payload: &Value) {
    let Some(source_event_id) = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(args) = chunk.args.as_object_mut() else {
        return;
    };
    args.insert(
        NATIVE_SOURCE_EVENT_ID_ARG.to_string(),
        Value::String(source_event_id.to_string()),
    );
}

fn compacted_window_id(payload: &Value) -> Option<String> {
    payload
        .get("window_id")
        .or_else(|| payload.get("first_window_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn compacted_extends_pending_window(pending: &PendingCompactionMirror, payload: &Value) -> bool {
    let Some(previous_window_id) = payload
        .get("previous_window_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    pending.window_id.as_deref() == Some(previous_window_id)
}

fn should_emit_assistant_mirror(
    pending: &mut Option<PendingAssistantMirror>,
    kind: AssistantMirrorKind,
    message: &str,
) -> bool {
    let is_mirror = pending
        .as_ref()
        .is_some_and(|previous| previous.kind != kind && previous.message == message);
    if is_mirror {
        *pending = None;
        return false;
    }
    *pending = Some(PendingAssistantMirror {
        kind,
        message: message.to_string(),
    });
    true
}

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
    // Current Codex rollouts write one or more chained top-level `compacted`
    // window checkpoints followed immediately by an `event_msg/context_compacted`
    // UI mirror. Track that provider-owned window chain instead of guessing
    // identity from timestamps: two real compactions may legitimately happen
    // within a few seconds of each other.
    let mut pending_compacted_mirror: Option<PendingCompactionMirror> = None;
    // Codex writes one assistant message twice: once as model-context
    // `response_item/message` and once as visible `event_msg/agent_message`.
    // Either representation can be first and their timestamps can differ by
    // a millisecond, so pair only consecutive cross-representation records.
    let mut pending_assistant_mirror: Option<PendingAssistantMirror> = None;
    // The model-context response item carries portable image data, while the
    // following UI projection may carry only a source-machine local path.
    // Pair them without emitting the response item as a duplicate user turn.
    let mut pending_user_image_data_urls: Vec<String> = Vec::new();
    // `thread/start` may persist user-role provider bootstrap (for example
    // plugin/runtime context) before the first native `turn_context`. It is
    // model setup, not a conversational user turn. ORG2 app-server injection
    // is the one exception: its globally scoped item id is canonical history
    // even when an older provider writes it before `turn_context`.
    // A non-zero window starts after an already-catalogued native boundary;
    // never classify its first row as thread bootstrap merely because the
    // preceding `turn_context` lives outside this bounded read.
    let mut before_first_turn_context = start_offset == 0;

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
            Err(_) => {
                pending_compacted_mirror = None;
                pending_assistant_mirror = None;
                continue;
            }
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        if parsed.line_type == "turn_context" {
            before_first_turn_context = false;
        }
        if parsed.line_type == "compacted" {
            pending_assistant_mirror = None;
            let marker_id = parsed
                .payload
                .get("window_id")
                .or_else(|| parsed.payload.get("first_window_id"))
                .and_then(Value::as_str)
                .unwrap_or("checkpoint");
            let summary = parsed
                .payload
                .get("message")
                .and_then(Value::as_str)
                .filter(|summary| !summary.trim().is_empty());
            let belongs_to_open_window_batch = pending_compacted_mirror
                .as_ref()
                .is_some_and(|pending| compacted_extends_pending_window(pending, &parsed.payload));
            if belongs_to_open_window_batch {
                if let Some(existing) = collector
                    .current
                    .last_mut()
                    .filter(|chunk| chunk.function == "context_compacted")
                {
                    // A single Codex compaction can persist several adjacent
                    // window checkpoints before its event_msg UI mirror. They
                    // are one logical boundary, not repeated compactions.
                    *existing = codex_context_compacted_chunk(
                        session_id,
                        sequence.saturating_sub(1),
                        marker_id,
                        &created_at,
                        summary,
                    );
                }
            } else {
                collector.current.push(codex_context_compacted_chunk(
                    session_id,
                    sequence,
                    marker_id,
                    &created_at,
                    summary,
                ));
                sequence += 1;
            }
            pending_compacted_mirror = Some(PendingCompactionMirror {
                window_id: compacted_window_id(&parsed.payload),
            });
            continue;
        }
        let Some(payload_type) = parsed.payload.get("type").and_then(Value::as_str) else {
            pending_compacted_mirror = None;
            pending_assistant_mirror = None;
            continue;
        };

        let is_assistant_mirror_record = payload_type == "agent_message"
            || (payload_type == "message"
                && parsed.payload.get("role").and_then(Value::as_str) == Some("assistant"));
        if !is_assistant_mirror_record {
            pending_assistant_mirror = None;
        }

        if payload_type == "context_compacted" {
            if pending_compacted_mirror.take().is_some() {
                continue;
            }
            collector.current.push(codex_context_compacted_chunk(
                session_id,
                sequence,
                "event",
                &created_at,
                parsed
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|summary| !summary.trim().is_empty()),
            ));
            sequence += 1;
            continue;
        }

        // `token_count` is the only provider-owned padding observed between a
        // compact checkpoint and its UI mirror. Any conversational/lifecycle
        // record closes the batch, so a later nearby compaction remains a
        // distinct canonical boundary.
        if payload_type != "token_count" {
            pending_compacted_mirror = None;
        }

        if payload_type == "context_compaction" {
            let marker_id = parsed
                .payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("context-compaction");
            collector.current.push(codex_context_compacted_chunk(
                session_id,
                sequence,
                marker_id,
                &created_at,
                None,
            ));
            sequence += 1;
            continue;
        }

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
                if let Some(mut user_chunk) =
                    user_message_chunk_from_line(session_id, sequence, &created_at, &parsed)
                {
                    if !pending_user_image_data_urls.is_empty() {
                        user_chunk.result["images"] =
                            json!(std::mem::take(&mut pending_user_image_data_urls));
                    }
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
                    // Synthesized/native Codex rollouts carry both the
                    // response_item (model context) and event_msg (visible
                    // thread mirror). They describe one assistant message,
                    // not two conversation turns. Either representation can
                    // be written first, so both branches use the same mirror
                    // predicate.
                    if should_emit_assistant_mirror(
                        &mut pending_assistant_mirror,
                        AssistantMirrorKind::EventMessage,
                        message,
                    ) {
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
            }
            "message" => {
                let role = parsed.payload.get("role").and_then(Value::as_str);
                if role == Some("user") {
                    let is_orgii_injected = parsed
                        .payload
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.starts_with(NATIVE_SOURCE_EVENT_ID_PREFIX));
                    let has_portable_user_images =
                        !user_image_data_urls_from_response_message(&parsed.payload).is_empty();
                    if before_first_turn_context && !is_orgii_injected && !has_portable_user_images
                    {
                        continue;
                    }
                    if let Some(mut user_chunk) = injected_user_message_chunk_from_response_message(
                        session_id,
                        sequence,
                        &created_at,
                        &parsed.payload,
                    ) {
                        attach_native_source_event_id(&mut user_chunk, &parsed.payload);
                        let user_sequence = sequence;
                        sequence += 1;
                        if collector.start_turn(user_chunk) {
                            break;
                        }
                        collector.record_turn_offset(
                            format!("codex-user-{user_sequence}"),
                            line_start_offset,
                            user_sequence,
                        );
                    } else {
                        pending_user_image_data_urls =
                            user_image_data_urls_from_response_message(&parsed.payload);
                    }
                } else if role == Some("assistant") {
                    if let Some(text) = content_text_from_payload(&parsed.payload) {
                        if should_emit_assistant_mirror(
                            &mut pending_assistant_mirror,
                            AssistantMirrorKind::ResponseItem,
                            &text,
                        ) {
                            let mut chunk = imported_history::assistant_message_chunk(
                                session_id,
                                CODEX_PROVIDER_SLUG,
                                sequence,
                                &created_at,
                                &text,
                            );
                            attach_native_source_event_id(&mut chunk, &parsed.payload);
                            collector.current.push(chunk);
                            sequence += 1;
                        }
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
                .push(imported_history::unresolved_tool_call_chunk(
                    session_id,
                    CODEX_PROVIDER_SLUG,
                    sequence,
                    &call,
                ));
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
            let mut interrupted = imported_history::unresolved_tool_call_chunk(
                session_id,
                CODEX_PROVIDER_SLUG,
                sequence,
                call,
            );
            interrupted.result["output"] = Value::String(output.clone());
            interrupted.result["observation"] = Value::String(output.clone());
            if !output.is_empty() {
                // This is no longer a grammar-dangling call: Codex exposed
                // durable stdout before the process was interrupted. Pair it
                // with an explicit interrupted result during cross-runtime
                // materialization instead of dropping already-visible work.
                interrupted.result["status"] = Value::String("interrupted".to_string());
            }
            collector.current.push(interrupted);
            sequence += 1;
        }
    }

    Ok(collector.finish())
}

fn codex_context_compacted_chunk(
    session_id: &str,
    sequence: usize,
    marker_id: &str,
    created_at: &str,
    summary: Option<&str>,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, "context_compacted", "context_compacted");
    chunk.chunk_id = format!("codex-context-compacted-{marker_id}-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "success": true,
        "native": true,
        "provider": "codex",
        "header": "Context compacted",
        "observation": summary.unwrap_or(""),
    });
    chunk
}
