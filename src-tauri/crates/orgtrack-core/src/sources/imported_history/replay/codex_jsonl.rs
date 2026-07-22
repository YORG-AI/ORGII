//! Incremental Codex JSONL replay driver.
//!
//! Complete newline-terminated records are folded directly into SQLite.  The
//! driver keeps only unresolved tool calls/background handles in its cursor;
//! it never constructs a transcript-sized `Vec<ActivityChunk>` and never
//! retains a complete background output string.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use core_types::activity::ActivityChunk;
use core_types::extracted::ExtractedGitArtifactData;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
thread_local! {
    static PAYLOAD_FALLBACK_DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

use crate::development_artifact::{
    attach_replay_git_artifacts, parse_git_artifacts, GitArtifactParseInput,
};
use crate::sources::codex::app::{
    desktop_exec::codex_tool_output_text,
    transcript::{
        background_cell_id, background_cell_key, background_session_key, codex_tool_call_chunk,
        content_text_from_payload, pending_custom_tool_calls_from_payload,
        pending_tool_calls_from_payload, reasoning_text_from_payload, record_stdin_event,
        user_message_from_payload, wait_cell_id, web_search_call_from_payload,
    },
    CodexJsonlLine,
};
use crate::sources::imported_history::{self, ImportedToolCall};

use super::index::ReplayIndexState;
use super::jsonl_driver;
use super::payload_artifact;
use super::{
    ReplayPayloadDescriptor, ReplayPayloadKind, ReplayPayloadRange, ReplaySourceSpan, ReplayStats,
    NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

#[derive(Debug, Clone)]
pub(super) struct CodexSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub indexed_size_bytes: u64,
    pub total_events: u64,
    pub total_turns: u64,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AssignedToolCall {
    call: ImportedToolCall,
    sequence: i64,
    turn_index: i64,
    #[serde(default)]
    args_payload: Option<ReplayPayloadDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingToolGroup {
    calls: Vec<AssignedToolCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingBackgroundGroup {
    calls: Vec<AssignedToolCall>,
    spans: Vec<ReplaySourceSpan>,
    output_preview: String,
    output_bytes: u64,
    #[serde(default)]
    git_artifacts: Vec<ExtractedGitArtifactData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexDriverCursor {
    byte_offset: u64,
    next_sequence: i64,
    current_turn_index: i64,
    pending_tool_calls: HashMap<String, PendingToolGroup>,
    background_tool_calls: HashMap<String, PendingBackgroundGroup>,
    pending_task_turn_id: Option<String>,
    active_task_turn_id: Option<String>,
    /// Bounded fingerprint of the already-consumed prefix.  File identity and
    /// size alone cannot distinguish an append from a same-inode rewrite that
    /// happens to grow past the previous cursor.
    #[serde(default)]
    boundary_fingerprint: String,
    sample_fingerprint: String,
    #[serde(default)]
    catalog: super::super::catalog::ReplayCatalogProjection,
}

impl Default for CodexDriverCursor {
    fn default() -> Self {
        Self {
            byte_offset: 0,
            next_sequence: 0,
            current_turn_index: -1,
            pending_tool_calls: HashMap::new(),
            background_tool_calls: HashMap::new(),
            pending_task_turn_id: None,
            active_task_turn_id: None,
            boundary_fingerprint: String::new(),
            sample_fingerprint: String::new(),
            catalog: super::super::catalog::ReplayCatalogProjection::default(),
        }
    }
}

pub(super) fn cursor_fingerprint(cursor_json: &str) -> Option<String> {
    serde_json::from_str::<CodexDriverCursor>(cursor_json)
        .ok()
        .map(|cursor| cursor.sample_fingerprint)
}

pub(super) fn cursor_matches_source(path: &Path, cursor_json: &str) -> bool {
    let Ok(cursor) = serde_json::from_str::<CodexDriverCursor>(cursor_json) else {
        return false;
    };
    if cursor.byte_offset == 0 {
        return true;
    }
    jsonl_driver::boundary_fingerprint(path, cursor.byte_offset)
        .is_ok_and(|value| value == cursor.boundary_fingerprint)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    previous_state: Option<&ReplayIndexState>,
    sample_fingerprint: &str,
) -> Result<CodexSyncOutcome, String> {
    let mut cursor = match previous_state {
        Some(state) => serde_json::from_str::<CodexDriverCursor>(&state.driver_cursor_json)
            .map_err(|err| format!("decode Codex replay cursor: {err}"))?,
        None => CodexDriverCursor::default(),
    };
    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut file = fs::File::open(source_path)
        .map_err(|err| format!("open Codex replay {}: {err}", source_path.display()))?;
    file.seek(SeekFrom::Start(cursor.byte_offset))
        .map_err(|err| format!("seek Codex replay cursor: {err}"))?;
    let mut reader = BufReader::new(file);

    loop {
        let line_start = cursor.byte_offset;
        let mut bytes = Vec::new();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|err| format!("read Codex replay line: {err}"))?;
        if read == 0 {
            break;
        }
        // A writer may be in the middle of appending a JSON object.  Keep the
        // cursor before that record so the next poll retries it verbatim.
        if bytes.last() != Some(&b'\n') {
            break;
        }
        cursor.byte_offset = cursor.byte_offset.saturating_add(read as u64);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(read as u64);
        let trimmed = trim_jsonl_line(&bytes);
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_slice(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        cursor.catalog.observe_codex(
            &parsed.line_type,
            parsed.timestamp.as_deref(),
            &parsed.payload,
            source_session_id,
        );
        let span = ReplaySourceSpan {
            start: line_start,
            end: cursor.byte_offset,
        };
        changed |= fold_line(
            tx,
            display_session_id,
            source_session_id,
            generation,
            write_revision,
            source_path,
            parsed,
            span,
            &mut cursor,
            &mut stats,
        )?;
    }

    cursor.boundary_fingerprint =
        jsonl_driver::boundary_fingerprint(source_path, cursor.byte_offset)?;
    cursor.sample_fingerprint = sample_fingerprint.to_string();
    let total_events = tx
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_events
             WHERE source='codex_app' AND source_session_id=?1 AND generation=?2",
            params![source_session_id, generation],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count Codex replay events: {err}"))?
        .max(0) as u64;
    let total_turns = tx
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_turns
             WHERE source='codex_app' AND source_session_id=?1 AND generation=?2",
            params![source_session_id, generation],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count Codex replay turns: {err}"))?
        .max(0) as u64;
    Ok(CodexSyncOutcome {
        stats,
        driver_cursor_json: serde_json::to_string(&cursor)
            .map_err(|err| format!("encode Codex replay cursor: {err}"))?,
        indexed_size_bytes: cursor.byte_offset,
        total_events,
        total_turns,
        changed,
    })
}

#[allow(clippy::too_many_arguments)]
fn fold_line(
    tx: &Transaction<'_>,
    session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    source_path: &Path,
    parsed: CodexJsonlLine,
    span: ReplaySourceSpan,
    cursor: &mut CodexDriverCursor,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    let created_at = parsed
        .timestamp
        .as_deref()
        .map(imported_history::normalize_created_at)
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
    let Some(payload_type) = parsed.payload.get("type").and_then(Value::as_str) else {
        return Ok(false);
    };
    let mut changed = false;
    match payload_type {
        "task_started" => {
            cursor.pending_task_turn_id = parsed
                .payload
                .get("turn_id")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        "user_message" => {
            if let Some(message) = user_message_from_payload(&parsed.payload) {
                start_turn(tx, source_session_id, generation, cursor, &created_at)?;
                let (preview, truncated) = head_preview(&message, NORMAL_PAYLOAD_PREVIEW_BYTES);
                let chunk = imported_history::user_message_chunk(
                    session_id,
                    "codex",
                    cursor.next_sequence as usize,
                    &created_at,
                    &preview,
                );
                let payloads = payload_descriptor(
                    "result.message.content",
                    ReplayPayloadKind::UserMessage,
                    span,
                    message.len(),
                    truncated,
                );
                changed |= insert_chunk(
                    tx,
                    source_session_id,
                    generation,
                    write_revision,
                    cursor.current_turn_index,
                    cursor.next_sequence,
                    &chunk,
                    &payloads,
                    span,
                    stats,
                )?;
                if truncated {
                    payload_artifact::store_text(
                        tx,
                        super::ImportedHistorySourceId::CodexApp,
                        source_session_id,
                        generation,
                        &chunk.chunk_id,
                        "result.message.content",
                        &message,
                    )?;
                }
                cursor.next_sequence += 1;
                if let Some(turn_id) = cursor.pending_task_turn_id.take() {
                    let lifecycle = imported_history::task_lifecycle_chunk(
                        session_id,
                        "codex",
                        cursor.next_sequence as usize,
                        &created_at,
                        imported_history::ACTION_TYPE_TASK_START,
                        &turn_id,
                    );
                    changed |= insert_chunk(
                        tx,
                        source_session_id,
                        generation,
                        write_revision,
                        cursor.current_turn_index,
                        cursor.next_sequence,
                        &lifecycle,
                        &[],
                        span,
                        stats,
                    )?;
                    cursor.next_sequence += 1;
                    cursor.active_task_turn_id = Some(turn_id);
                }
            }
        }
        "agent_message" => {
            if let Some(message) = parsed.payload.get("message").and_then(Value::as_str) {
                changed |= emit_text_chunk(
                    tx,
                    session_id,
                    source_session_id,
                    generation,
                    write_revision,
                    cursor,
                    stats,
                    &created_at,
                    span,
                    message,
                    ReplayPayloadKind::AgentMessage,
                    false,
                )?;
            }
        }
        "message" if parsed.payload.get("role").and_then(Value::as_str) == Some("assistant") => {
            if let Some(message) = content_text_from_payload(&parsed.payload) {
                changed |= emit_text_chunk(
                    tx,
                    session_id,
                    source_session_id,
                    generation,
                    write_revision,
                    cursor,
                    stats,
                    &created_at,
                    span,
                    &message,
                    ReplayPayloadKind::AssistantContent,
                    false,
                )?;
            }
        }
        "reasoning" | "agent_reasoning" => {
            if let Some(thought) = reasoning_text_from_payload(&parsed.payload) {
                changed |= emit_text_chunk(
                    tx,
                    session_id,
                    source_session_id,
                    generation,
                    write_revision,
                    cursor,
                    stats,
                    &created_at,
                    span,
                    &thought,
                    ReplayPayloadKind::Reasoning,
                    true,
                )?;
            }
        }
        "function_call" | "custom_tool_call" => {
            let group = if payload_type == "function_call" {
                pending_tool_calls_from_payload(&parsed.payload, &created_at)
            } else {
                pending_custom_tool_calls_from_payload(&parsed.payload, &created_at)
            };
            if let Some((call_id, calls)) = group {
                ensure_turn(tx, source_session_id, generation, cursor, &created_at)?;
                let mut assigned = Vec::with_capacity(calls.len());
                for (call_ordinal, mut call) in calls.into_iter().enumerate() {
                    let compacted_args = compact_codex_tool_args(
                        &mut call,
                        span,
                        call_ordinal.min(u32::MAX as usize) as u32,
                    );
                    let args_payload = compacted_args
                        .as_ref()
                        .map(|(descriptor, _)| descriptor.clone());
                    let sequence = cursor.next_sequence;
                    let chunk =
                        codex_tool_call_chunk(session_id, sequence as usize, &call, "", None);
                    let payloads = args_payload.iter().cloned().collect::<Vec<_>>();
                    changed |= insert_chunk(
                        tx,
                        source_session_id,
                        generation,
                        write_revision,
                        cursor.current_turn_index,
                        sequence,
                        &chunk,
                        &payloads,
                        span,
                        stats,
                    )?;
                    if let Some((descriptor, full_args)) = compacted_args {
                        payload_artifact::store_text(
                            tx,
                            super::ImportedHistorySourceId::CodexApp,
                            source_session_id,
                            generation,
                            &chunk.chunk_id,
                            &descriptor.field_path,
                            &full_args,
                        )?;
                    }
                    assigned.push(AssignedToolCall {
                        call,
                        sequence,
                        turn_index: cursor.current_turn_index,
                        args_payload,
                    });
                    cursor.next_sequence += 1;
                }
                cursor
                    .pending_tool_calls
                    .insert(call_id, PendingToolGroup { calls: assigned });
            }
        }
        "web_search_call" => {
            if let Some(mut call) = web_search_call_from_payload(&parsed.payload, &created_at) {
                ensure_turn(tx, source_session_id, generation, cursor, &created_at)?;
                let compacted_args = compact_codex_tool_args(&mut call, span, 0);
                let args_payload = compacted_args
                    .as_ref()
                    .map(|(descriptor, _)| descriptor.clone());
                let chunk = codex_tool_call_chunk(
                    session_id,
                    cursor.next_sequence as usize,
                    &call,
                    "",
                    None,
                );
                changed |= insert_chunk(
                    tx,
                    source_session_id,
                    generation,
                    write_revision,
                    cursor.current_turn_index,
                    cursor.next_sequence,
                    &chunk,
                    &args_payload.into_iter().collect::<Vec<_>>(),
                    span,
                    stats,
                )?;
                if let Some((descriptor, full_args)) = compacted_args {
                    payload_artifact::store_text(
                        tx,
                        super::ImportedHistorySourceId::CodexApp,
                        source_session_id,
                        generation,
                        &chunk.chunk_id,
                        &descriptor.field_path,
                        &full_args,
                    )?;
                }
                cursor.next_sequence += 1;
            }
        }
        "function_call_output" | "custom_tool_call_output" => {
            if let Some(call_id) = parsed.payload.get("call_id").and_then(Value::as_str) {
                if let Some(group) = cursor.pending_tool_calls.remove(call_id) {
                    let output = codex_tool_output_text(parsed.payload.get("output"));
                    changed |= resolve_tool_output(
                        tx,
                        session_id,
                        source_session_id,
                        generation,
                        write_revision,
                        source_path,
                        group,
                        &output,
                        span,
                        cursor,
                        stats,
                    )?;
                }
            }
        }
        "task_complete" | "turn_aborted" => {
            let action_type = if payload_type == "task_complete" {
                imported_history::ACTION_TYPE_TASK_COMPLETED
            } else {
                imported_history::ACTION_TYPE_TASK_FAILED
            };
            if let Some(turn_id) = parsed
                .payload
                .get("turn_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| cursor.active_task_turn_id.clone())
            {
                ensure_turn(tx, source_session_id, generation, cursor, &created_at)?;
                let chunk = imported_history::task_lifecycle_chunk(
                    session_id,
                    "codex",
                    cursor.next_sequence as usize,
                    &created_at,
                    action_type,
                    &turn_id,
                );
                changed |= insert_chunk(
                    tx,
                    source_session_id,
                    generation,
                    write_revision,
                    cursor.current_turn_index,
                    cursor.next_sequence,
                    &chunk,
                    &[],
                    span,
                    stats,
                )?;
                cursor.next_sequence += 1;
                cursor.active_task_turn_id = None;
                close_turn(
                    tx,
                    source_session_id,
                    generation,
                    cursor.current_turn_index,
                    cursor.next_sequence.saturating_sub(1),
                    &created_at,
                )?;
            }
        }
        _ => {}
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
fn emit_text_chunk(
    tx: &Transaction<'_>,
    session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    cursor: &mut CodexDriverCursor,
    stats: &mut ReplayStats,
    created_at: &str,
    span: ReplaySourceSpan,
    text: &str,
    kind: ReplayPayloadKind,
    thinking: bool,
) -> Result<bool, String> {
    ensure_turn(tx, source_session_id, generation, cursor, created_at)?;
    // Compatibility chunks duplicate assistant/thinking text across several
    // fields, and JSON escaping can expand Unicode. Keep the source-backed
    // display preview comfortably below the per-field 8 KiB ceiling.
    let (preview, truncated) = head_preview(text, 1024);
    let chunk = if thinking {
        imported_history::thinking_chunk(
            session_id,
            "codex",
            cursor.next_sequence as usize,
            created_at,
            &preview,
        )
    } else {
        imported_history::assistant_message_chunk(
            session_id,
            "codex",
            cursor.next_sequence as usize,
            created_at,
            &preview,
        )
    };
    let payloads = payload_descriptor("result.content", kind, span, text.len(), truncated);
    let changed = insert_chunk(
        tx,
        source_session_id,
        generation,
        write_revision,
        cursor.current_turn_index,
        cursor.next_sequence,
        &chunk,
        &payloads,
        span,
        stats,
    )?;
    if truncated {
        payload_artifact::store_text(
            tx,
            super::ImportedHistorySourceId::CodexApp,
            source_session_id,
            generation,
            &chunk.chunk_id,
            "result.content",
            text,
        )?;
    }
    cursor.next_sequence += 1;
    Ok(changed)
}

fn compact_codex_tool_args(
    call: &mut ImportedToolCall,
    span: ReplaySourceSpan,
    source_ordinal: u32,
) -> Option<(ReplayPayloadDescriptor, String)> {
    let encoded = serde_json::to_string(&call.args).ok()?;
    let limit = if call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    if encoded.len() <= limit {
        return None;
    }
    call.args = jsonl_driver::compact_tool_args(&call.args, &call.canonical_name);
    Some((
        ReplayPayloadDescriptor {
            field_path: "args".to_string(),
            kind: ReplayPayloadKind::ToolArguments,
            spans: vec![span],
            total_bytes: encoded.len() as u64,
            source_ordinal: Some(source_ordinal),
            source_key: None,
        },
        encoded,
    ))
}

#[allow(clippy::too_many_arguments)]
fn resolve_tool_output(
    tx: &Transaction<'_>,
    session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    source_path: &Path,
    group: PendingToolGroup,
    output: &str,
    span: ReplaySourceSpan,
    cursor: &mut CodexDriverCursor,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    if let Some(wait_key) = wait_key(&group.calls) {
        if let Some(mut background) = cursor.background_tool_calls.remove(&wait_key) {
            if let Some(continuation) = group.calls.first() {
                let mut original_calls = background
                    .calls
                    .iter()
                    .map(|assigned| assigned.call.clone())
                    .collect::<Vec<_>>();
                record_stdin_event(&mut original_calls, &continuation.call);
                for (assigned, call) in background.calls.iter_mut().zip(original_calls) {
                    assigned.call = call;
                }
            }
            append_background_output(&mut background, output, span);
            if let Some(next_key) = background_key_from_output(output) {
                cursor.background_tool_calls.insert(next_key, background);
                return Ok(false);
            }
            return finalize_tool_group(
                tx,
                session_id,
                source_session_id,
                generation,
                write_revision,
                source_path,
                &background.calls,
                &background.output_preview,
                &background.spans,
                background.output_bytes,
                &background.git_artifacts,
                stats,
            );
        }
    }

    if let Some(key) = background_key_from_output(output) {
        let mut background = PendingBackgroundGroup {
            calls: group.calls,
            spans: Vec::new(),
            output_preview: String::new(),
            output_bytes: 0,
            git_artifacts: Vec::new(),
        };
        append_background_output(&mut background, output, span);
        cursor.background_tool_calls.insert(key, background);
        return Ok(false);
    }
    finalize_tool_group(
        tx,
        session_id,
        source_session_id,
        generation,
        write_revision,
        source_path,
        &group.calls,
        output,
        &[span],
        output.len() as u64,
        &[],
        stats,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_tool_group(
    tx: &Transaction<'_>,
    session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    source_path: &Path,
    calls: &[AssignedToolCall],
    output: &str,
    spans: &[ReplaySourceSpan],
    output_bytes: u64,
    precomputed_git_artifacts: &[ExtractedGitArtifactData],
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    let mut changed = false;
    let mut output_artifact_hash: Option<String> = None;
    for assigned in calls {
        let preview_limit =
            if assigned.call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
                SHELL_PAYLOAD_PREVIEW_BYTES
            } else {
                NORMAL_PAYLOAD_PREVIEW_BYTES
            };
        let (preview, preview_truncated) = tail_preview(output, preview_limit);
        let truncated = preview_truncated || output_bytes > output.len() as u64;
        let mut chunk = codex_tool_call_chunk(
            session_id,
            assigned.sequence as usize,
            &assigned.call,
            &preview,
            None,
        );
        let successful = chunk.result.get("success").and_then(Value::as_bool) != Some(false);
        let command = assigned
            .call
            .args
            .get("command")
            .or_else(|| assigned.call.args.get("cmd"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut git_artifacts = if successful {
            parse_git_artifacts(GitArtifactParseInput {
                command,
                output: Some(output),
                exit_code: None,
            })
        } else {
            Vec::new()
        };
        for artifact in precomputed_git_artifacts {
            let key = serde_json::to_string(artifact).unwrap_or_default();
            if !git_artifacts
                .iter()
                .any(|existing| serde_json::to_string(existing).unwrap_or_default() == key)
            {
                git_artifacts.push(artifact.clone());
            }
        }
        attach_replay_git_artifacts(&mut chunk.result, &git_artifacts);
        let mut payloads = assigned.args_payload.iter().cloned().collect::<Vec<_>>();
        if truncated {
            payloads.push(ReplayPayloadDescriptor {
                field_path: "result.output".to_string(),
                kind: ReplayPayloadKind::ToolOutput,
                spans: spans.to_vec(),
                total_bytes: output_bytes,
                source_ordinal: None,
                source_key: None,
            });
        }
        let source_span = spans
            .last()
            .copied()
            .unwrap_or(ReplaySourceSpan { start: 0, end: 0 });
        changed |= insert_chunk(
            tx,
            source_session_id,
            generation,
            write_revision,
            assigned.turn_index,
            assigned.sequence,
            &chunk,
            &payloads,
            source_span,
            stats,
        )?;
        if truncated {
            let content_hash = if let Some(content_hash) = output_artifact_hash.as_ref() {
                payload_artifact::reference(
                    tx,
                    super::ImportedHistorySourceId::CodexApp,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    "result.output",
                    content_hash,
                )?;
                content_hash.clone()
            } else if output.len() as u64 == output_bytes {
                payload_artifact::store_text(
                    tx,
                    super::ImportedHistorySourceId::CodexApp,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    "result.output",
                    output,
                )?
            } else {
                stream_codex_output_artifact(
                    tx,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    source_path,
                    spans,
                    output_bytes,
                )?
            };
            output_artifact_hash = Some(content_hash);
        }
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
fn stream_codex_output_artifact(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    source_path: &Path,
    spans: &[ReplaySourceSpan],
    output_bytes: u64,
) -> Result<String, String> {
    let mut file = fs::File::open(source_path).map_err(|error| {
        format!(
            "open Codex replay artifact source {}: {error}",
            source_path.display()
        )
    })?;
    payload_artifact::store_streamed(
        tx,
        super::ImportedHistorySourceId::CodexApp,
        source_session_id,
        generation,
        event_id,
        "result.output",
        output_bytes,
        |writer| {
            for span in spans {
                file.seek(SeekFrom::Start(span.start))
                    .map_err(|error| format!("seek Codex replay artifact source: {error}"))?;
                let length = usize::try_from(span.end.saturating_sub(span.start))
                    .map_err(|_| "Codex replay source span exceeds address space".to_string())?;
                let mut bytes = vec![0_u8; length];
                file.read_exact(&mut bytes)
                    .map_err(|error| format!("read Codex replay artifact source: {error}"))?;
                let parsed: CodexJsonlLine = serde_json::from_slice(trim_jsonl_line(&bytes))
                    .map_err(|error| format!("decode Codex replay artifact line: {error}"))?;
                let text = codex_tool_output_text(parsed.payload.get("output"));
                writer
                    .write_all(text.as_bytes())
                    .map_err(|error| format!("write Codex replay artifact: {error}"))?;
            }
            Ok(())
        },
    )
}

fn append_background_output(
    background: &mut PendingBackgroundGroup,
    output: &str,
    span: ReplaySourceSpan,
) {
    for assigned in &background.calls {
        let command = assigned
            .call
            .args
            .get("command")
            .or_else(|| assigned.call.args.get("cmd"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        for artifact in parse_git_artifacts(GitArtifactParseInput {
            command,
            output: Some(output),
            exit_code: None,
        }) {
            let key = serde_json::to_string(&artifact).unwrap_or_default();
            if !background
                .git_artifacts
                .iter()
                .any(|existing| serde_json::to_string(existing).unwrap_or_default() == key)
            {
                background.git_artifacts.push(artifact);
            }
        }
    }
    background.spans.push(span);
    background.output_bytes = background.output_bytes.saturating_add(output.len() as u64);
    background.output_preview.push_str(output);
    if background.output_preview.len() > SHELL_PAYLOAD_PREVIEW_BYTES {
        background.output_preview =
            utf8_tail(&background.output_preview, SHELL_PAYLOAD_PREVIEW_BYTES).to_string();
    }
}

fn wait_key(calls: &[AssignedToolCall]) -> Option<String> {
    let raw = calls
        .iter()
        .map(|call| call.call.clone())
        .collect::<Vec<_>>();
    if let Some(cell_id) = wait_cell_id(&raw) {
        return Some(background_cell_key(cell_id));
    }
    let call = raw.first()?;
    if call.canonical_name == imported_history::FUNCTION_AWAIT_OUTPUT {
        return call
            .args
            .get("session_id")
            .or_else(|| call.args.get("handle"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(background_session_key);
    }
    None
}

fn background_key_from_output(output: &str) -> Option<String> {
    if let Some(cell_id) = background_cell_id(output) {
        return Some(background_cell_key(&cell_id));
    }
    let value: Value = serde_json::from_str(output.trim()).ok()?;
    let session_id = value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })?;
    Some(background_session_key(&session_id))
}

fn start_turn(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    cursor: &mut CodexDriverCursor,
    created_at: &str,
) -> Result<(), String> {
    if cursor.current_turn_index >= 0 {
        close_turn(
            tx,
            source_session_id,
            generation,
            cursor.current_turn_index,
            cursor.next_sequence.saturating_sub(1),
            created_at,
        )?;
    }
    cursor.current_turn_index += 1;
    insert_turn(
        tx,
        source_session_id,
        generation,
        cursor.current_turn_index,
        cursor.next_sequence,
        created_at,
    )
}

fn ensure_turn(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    cursor: &mut CodexDriverCursor,
    created_at: &str,
) -> Result<(), String> {
    if cursor.current_turn_index < 0 {
        cursor.current_turn_index = 0;
        insert_turn(
            tx,
            source_session_id,
            generation,
            0,
            cursor.next_sequence,
            created_at,
        )?;
    }
    Ok(())
}

fn insert_turn(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    turn_index: i64,
    start_sequence: i64,
    started_at: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO imported_replay_turns (
            source, source_session_id, generation, turn_index, turn_id,
            start_sequence, started_at, event_count
         ) VALUES ('codex_app', ?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![
            source_session_id,
            generation,
            turn_index,
            format!("codex-turn-{turn_index}"),
            start_sequence,
            started_at,
        ],
    )
    .map_err(|err| format!("insert Codex replay turn: {err}"))?;
    Ok(())
}

fn close_turn(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    turn_index: i64,
    end_sequence: i64,
    ended_at: &str,
) -> Result<(), String> {
    tx.execute(
        "UPDATE imported_replay_turns SET end_sequence=?1, ended_at=?2
         WHERE source='codex_app' AND source_session_id=?3
           AND generation=?4 AND turn_index=?5",
        params![
            end_sequence,
            ended_at,
            source_session_id,
            generation,
            turn_index
        ],
    )
    .map_err(|err| format!("close Codex replay turn: {err}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_chunk(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    turn_index: i64,
    sequence: i64,
    chunk: &ActivityChunk,
    payloads: &[ReplayPayloadDescriptor],
    span: ReplaySourceSpan,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    let args_json = serde_json::to_string(&chunk.args)
        .map_err(|err| format!("encode Codex replay args: {err}"))?;
    let result_json = serde_json::to_string(&chunk.result)
        .map_err(|err| format!("encode Codex replay result: {err}"))?;
    let payloads_json = serde_json::to_string(payloads)
        .map_err(|err| format!("encode Codex replay payload locators: {err}"))?;
    let content_hash = content_hash(&[
        chunk.action_type.as_bytes(),
        chunk.function.as_bytes(),
        args_json.as_bytes(),
        result_json.as_bytes(),
        payloads_json.as_bytes(),
    ]);
    let existing = tx
        .query_row(
            "SELECT content_hash FROM imported_replay_events
             WHERE source='codex_app' AND source_session_id=?1
               AND generation=?2 AND sequence=?3",
            params![source_session_id, generation, sequence],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read Codex replay content hash: {err}"))?;
    if existing.as_deref() == Some(content_hash.as_str()) {
        return Ok(false);
    }
    let inserted = existing.is_none();
    tx.execute(
        "INSERT INTO imported_replay_events (
            source, source_session_id, generation, sequence, event_id,
            turn_index, action_type, function_name, created_at,
            args_preview_json, result_preview_json, args_size_bytes,
            result_size_bytes, thread_id, process_id, source_start, source_end,
            payloads_json, content_hash, event_revision
         ) VALUES (
            'codex_app', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
         ) ON CONFLICT(source, source_session_id, generation, sequence) DO UPDATE SET
            event_id=excluded.event_id,
            turn_index=excluded.turn_index,
            action_type=excluded.action_type,
            function_name=excluded.function_name,
            created_at=excluded.created_at,
            args_preview_json=excluded.args_preview_json,
            result_preview_json=excluded.result_preview_json,
            args_size_bytes=excluded.args_size_bytes,
            result_size_bytes=excluded.result_size_bytes,
            thread_id=excluded.thread_id,
            process_id=excluded.process_id,
            source_start=excluded.source_start,
            source_end=excluded.source_end,
            payloads_json=excluded.payloads_json,
            content_hash=excluded.content_hash,
            event_revision=excluded.event_revision",
        params![
            source_session_id,
            generation,
            sequence,
            chunk.chunk_id,
            turn_index,
            chunk.action_type,
            chunk.function,
            chunk.created_at,
            args_json,
            result_json,
            serde_json::to_vec(&chunk.args).map_or(0, |bytes| bytes.len()) as i64,
            serde_json::to_vec(&chunk.result).map_or(0, |bytes| bytes.len()) as i64,
            chunk.thread_id,
            chunk.process_id,
            span.start as i64,
            span.end as i64,
            payloads_json,
            content_hash,
            write_revision.min(i64::MAX as u64) as i64,
        ],
    )
    .map_err(|err| format!("upsert Codex replay event: {err}"))?;
    if inserted {
        tx.execute(
            "UPDATE imported_replay_turns SET event_count=event_count+1
             WHERE source='codex_app' AND source_session_id=?1
               AND generation=?2 AND turn_index=?3",
            params![source_session_id, generation, turn_index],
        )
        .map_err(|err| format!("increment Codex replay turn count: {err}"))?;
    }
    stats.normalized_events = stats.normalized_events.saturating_add(1);
    stats.upserted_events = stats.upserted_events.saturating_add(1);
    Ok(true)
}

fn payload_descriptor(
    field_path: &str,
    kind: ReplayPayloadKind,
    span: ReplaySourceSpan,
    total_bytes: usize,
    truncated: bool,
) -> Vec<ReplayPayloadDescriptor> {
    if !truncated {
        return Vec::new();
    }
    vec![ReplayPayloadDescriptor {
        field_path: field_path.to_string(),
        kind,
        spans: vec![span],
        total_bytes: total_bytes as u64,
        source_ordinal: None,
        source_key: None,
    }]
}

pub(super) fn read_payload(
    source_path: &Path,
    payloads_json: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    #[cfg(test)]
    PAYLOAD_FALLBACK_DECODES.with(|count| count.set(count.get().saturating_add(1)));
    let payloads: Vec<ReplayPayloadDescriptor> = serde_json::from_str(payloads_json)
        .map_err(|err| format!("decode Codex replay payload locator: {err}"))?;
    let descriptor = payloads
        .into_iter()
        .find(|payload| payload.field_path == field_path)
        .ok_or_else(|| format!("No deferred replay payload for {field_path}"))?;
    let requested_start = offset.min(descriptor.total_bytes);
    let requested_end = requested_start
        .saturating_add(max_bytes as u64)
        .min(descriptor.total_bytes);
    let mut range_text = String::with_capacity(max_bytes);
    let mut decoded_offset = 0_u64;
    let mut file = fs::File::open(source_path)
        .map_err(|err| format!("open Codex replay payload {}: {err}", source_path.display()))?;
    for span in &descriptor.spans {
        file.seek(SeekFrom::Start(span.start))
            .map_err(|err| format!("seek Codex replay payload: {err}"))?;
        let len = span.end.saturating_sub(span.start) as usize;
        let mut bytes = vec![0_u8; len];
        file.read_exact(&mut bytes)
            .map_err(|err| format!("read Codex replay payload: {err}"))?;
        let parsed: CodexJsonlLine = serde_json::from_slice(trim_jsonl_line(&bytes))
            .map_err(|err| format!("decode Codex replay payload line: {err}"))?;
        if let Some(part) = payload_text(&descriptor, &parsed) {
            let part_start = decoded_offset;
            let part_end = part_start.saturating_add(part.len() as u64);
            let overlap_start = requested_start.max(part_start);
            let overlap_end = requested_end.min(part_end);
            if overlap_start < overlap_end {
                let local_start = utf8_boundary_at_or_after(
                    &part,
                    overlap_start.saturating_sub(part_start) as usize,
                );
                let local_end = utf8_boundary_at_or_before(
                    &part,
                    overlap_end.saturating_sub(part_start) as usize,
                );
                if local_start < local_end {
                    range_text.push_str(&part[local_start..local_end]);
                }
            }
            decoded_offset = part_end;
            if decoded_offset >= requested_end {
                break;
            }
        }
    }
    let next_offset = requested_start.saturating_add(range_text.len() as u64);
    Ok(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: requested_start,
        next_offset,
        eof: next_offset >= descriptor.total_bytes,
        total_bytes: descriptor.total_bytes,
        text: range_text,
    })
}

#[cfg(test)]
pub(super) fn reset_payload_fallback_decodes() {
    PAYLOAD_FALLBACK_DECODES.with(|count| count.set(0));
}

#[cfg(test)]
pub(super) fn payload_fallback_decodes() -> usize {
    PAYLOAD_FALLBACK_DECODES.with(std::cell::Cell::get)
}

fn payload_text(descriptor: &ReplayPayloadDescriptor, parsed: &CodexJsonlLine) -> Option<String> {
    let payload = &parsed.payload;
    match descriptor.kind {
        ReplayPayloadKind::UserMessage => user_message_from_payload(payload),
        ReplayPayloadKind::AgentMessage => payload
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
        ReplayPayloadKind::AssistantContent => content_text_from_payload(payload),
        ReplayPayloadKind::Reasoning => reasoning_text_from_payload(payload),
        ReplayPayloadKind::ToolOutput => Some(codex_tool_output_text(payload.get("output"))),
        ReplayPayloadKind::ToolArguments => {
            let payload_type = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let calls = match payload_type {
                "function_call" => {
                    pending_tool_calls_from_payload(payload, "").map(|(_, calls)| calls)
                }
                "custom_tool_call" => {
                    pending_custom_tool_calls_from_payload(payload, "").map(|(_, calls)| calls)
                }
                "web_search_call" => {
                    web_search_call_from_payload(payload, "").map(|call| vec![call])
                }
                _ => None,
            }?;
            let ordinal = descriptor.source_ordinal.unwrap_or(0) as usize;
            calls
                .get(ordinal)
                .and_then(|call| serde_json::to_string(&call.args).ok())
        }
        ReplayPayloadKind::ToolDiff => None,
    }
}

fn trim_jsonl_line(mut bytes: &[u8]) -> &[u8] {
    while bytes
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

fn head_preview(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let end = utf8_boundary_at_or_before(text, max_bytes);
    (format!("{}\n… [payload truncated]", &text[..end]), true)
}

fn tail_preview(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    (
        format!("[payload truncated] …\n{}", utf8_tail(text, max_bytes)),
        true,
    )
}

fn utf8_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn utf8_boundary_at_or_before(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn utf8_boundary_at_or_after(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while offset < text.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

fn content_hash(parts: &[&[u8]]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteRecordStore;

    #[test]
    fn previews_respect_utf8_boundaries() {
        let text = "你".repeat(10_000);
        let (head, head_truncated) = head_preview(&text, 8 * 1024);
        let (tail, tail_truncated) = tail_preview(&text, 8 * 1024);
        assert!(head_truncated && tail_truncated);
        assert!(head.is_char_boundary(head.len()));
        assert!(tail.is_char_boundary(tail.len()));
    }

    #[test]
    fn pending_cursor_never_contains_complete_large_output() {
        let mut background = PendingBackgroundGroup {
            calls: Vec::new(),
            spans: Vec::new(),
            output_preview: String::new(),
            output_bytes: 0,
            git_artifacts: Vec::new(),
        };
        append_background_output(
            &mut background,
            &"x".repeat(1024 * 1024),
            ReplaySourceSpan { start: 0, end: 1 },
        );
        assert!(background.output_preview.len() <= SHELL_PAYLOAD_PREVIEW_BYTES);
        assert_eq!(background.output_bytes, 1024 * 1024);
    }

    #[test]
    fn ten_mib_tool_args_stay_out_of_index_and_cursor_but_reconstruct_exactly() {
        let command = format!("printf start {} end", "中🙂x".repeat(1_250_000));
        let arguments = serde_json::json!({
            "command": command,
            "workdir": "/tmp/project",
            "path": "src/lib.rs"
        });
        let line: CodexJsonlLine = serde_json::from_value(serde_json::json!({
            "timestamp": "2026-07-22T00:00:00Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "shell_command",
                "arguments": serde_json::to_string(&arguments).unwrap(),
                "call_id": "call-large-args"
            }
        }))
        .expect("Codex tool line");
        let (_, mut calls) =
            pending_tool_calls_from_payload(&line.payload, "").expect("normalized Codex call");
        assert_eq!(calls.len(), 1);
        let full_args = serde_json::to_string(&calls[0].args).expect("full normalized args");
        assert!(full_args.len() > 10 * 1024 * 1024);
        let (descriptor, encoded) =
            compact_codex_tool_args(&mut calls[0], ReplaySourceSpan { start: 0, end: 1 }, 0)
                .expect("large args descriptor");
        let assigned = AssignedToolCall {
            call: calls.remove(0),
            sequence: 0,
            turn_index: 0,
            args_payload: Some(descriptor.clone()),
        };
        let compact_args_bytes = serde_json::to_vec(&assigned.call.args).unwrap().len();
        assert!(
            compact_args_bytes < 80 * 1024,
            "compact args unexpectedly use {compact_args_bytes} bytes"
        );
        assert!(serde_json::to_vec(&assigned).unwrap().len() < 96 * 1024);
        assert_eq!(descriptor.total_bytes, full_args.len() as u64);
        assert_eq!(encoded, full_args);
        assert_eq!(
            payload_text(&descriptor, &line).as_deref(),
            Some(full_args.as_str())
        );
    }

    #[test]
    fn cross_record_output_is_streamed_into_one_artifact_without_concatenation() {
        let path = std::env::temp_dir().join(format!(
            "orgii-codex-cross-record-artifact-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let lines = ["first-你", "second-🙂"]
            .into_iter()
            .map(|output| {
                serde_json::json!({
                    "timestamp":"2026-07-22T00:00:00Z",
                    "type":"response_item",
                    "payload":{
                        "type":"function_call_output",
                        "call_id":"background-call",
                        "output":output
                    }
                })
                .to_string()
            })
            .collect::<Vec<_>>();
        let mut source = String::new();
        let mut spans = Vec::new();
        for line in &lines {
            let start = source.len() as u64;
            source.push_str(line);
            source.push('\n');
            spans.push(ReplaySourceSpan {
                start,
                end: source.len() as u64,
            });
        }
        fs::write(&path, source).expect("cross-record source");

        let mut conn = rusqlite::Connection::open_in_memory().expect("artifact DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("artifact schema");
        let tx = conn.transaction().expect("artifact transaction");
        let expected = "first-你second-🙂";
        stream_codex_output_artifact(
            &tx,
            "session",
            "generation",
            "event",
            &path,
            &spans,
            expected.len() as u64,
        )
        .expect("stream cross-record artifact");
        let payload = tx
            .query_row(
                "SELECT artifact.payload
                 FROM imported_replay_payload_artifact_refs AS ref
                 JOIN imported_replay_payload_artifacts AS artifact
                   ON artifact.source=ref.source
                  AND artifact.source_session_id=ref.source_session_id
                  AND artifact.generation=ref.generation
                  AND artifact.content_hash=ref.content_hash
                 WHERE ref.event_id='event' AND ref.field_path='result.output'",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .expect("read streamed artifact");
        assert_eq!(payload, expected.as_bytes());
        let _ = fs::remove_file(path);
    }
}
