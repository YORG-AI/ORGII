//! Shared incremental driver for imported JSONL histories other than Codex.
//!
//! Storage mechanics live here (complete-line byte cursor, lineage checking,
//! compact pending tool state and atomic SQLite folding).  Provider schemas are
//! normalized per source so sharing the driver does not erase replay semantics.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(test)]
thread_local! {
    static PAYLOAD_FALLBACK_DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

use crate::development_artifact::{
    attach_replay_git_artifacts, parse_git_artifacts, GitArtifactParseInput,
};
use crate::sources::imported_history::{self, ImportedToolCall};

use crate::sources::imported_history::replay::index::ReplayIndexState;
use crate::sources::imported_history::replay::payload_artifact;
pub(in crate::sources::imported_history::replay) mod codex;
mod normalize;
pub(in crate::sources::imported_history::replay) mod qoder_sidecar;

pub(in crate::sources::imported_history::replay) use normalize::compact_tool_args;
use normalize::*;

use crate::sources::imported_history::replay::{
    replay_payload_body_projection, ImportedHistorySourceId, ReplayPayloadBodyProjection,
    ReplayPayloadDescriptor, ReplayPayloadEncoding, ReplayPayloadKind, ReplayPayloadRange,
    ReplaySourceSpan, ReplayStats, NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

const CURSOR_VERSION: u32 = 1;
const BOUNDARY_BYTES: u64 = 4 * 1024;
/// Qoder's text transcript omits its tool trajectory. Reserve a wide, stable
/// sequence gap between transcript records so timestamp-ordered sidecar cards
/// can arrive later without renumbering transcript events.
pub(in crate::sources::imported_history::replay) const QODER_PRIMARY_SEQUENCE_STEP: i64 =
    1_000_000_000_000_000;

#[derive(Debug, Clone)]
pub(in crate::sources::imported_history::replay) struct JsonlSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub indexed_size_bytes: u64,
    pub total_events: u64,
    pub total_turns: u64,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingCall {
    call: ImportedToolCall,
    sequence: i64,
    turn_index: i64,
    call_span: ReplaySourceSpan,
    payload_ordinal: u32,
    args_size_bytes: usize,
    args_truncated: bool,
    #[serde(default)]
    args_body_projection: Option<ReplayPayloadBodyProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsonlCursor {
    version: u32,
    byte_offset: u64,
    next_sequence: i64,
    current_turn_index: i64,
    #[serde(default)]
    pending_calls: HashMap<String, PendingCall>,
    #[serde(default)]
    boundary_fingerprint: String,
    #[serde(default)]
    sample_fingerprint: String,
    #[serde(default)]
    qoder_sidecar: qoder_sidecar::QoderSidecarCursor,
    #[serde(default)]
    catalog: crate::sources::imported_history::catalog::ReplayCatalogProjection,
}

impl Default for JsonlCursor {
    fn default() -> Self {
        Self {
            version: CURSOR_VERSION,
            byte_offset: 0,
            next_sequence: 0,
            current_turn_index: -1,
            pending_calls: HashMap::new(),
            boundary_fingerprint: String::new(),
            sample_fingerprint: String::new(),
            qoder_sidecar: qoder_sidecar::QoderSidecarCursor::default(),
            catalog: crate::sources::imported_history::catalog::ReplayCatalogProjection::default(),
        }
    }
}

#[derive(Debug, Clone)]
enum NormalizedKind {
    UserText(String),
    AssistantText(String),
    Thinking(String),
    ToolUse(ImportedToolCall),
    ToolResult {
        call_id: String,
        output: String,
        failed: bool,
        diff: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct NormalizedEvent {
    created_at: String,
    starts_turn: bool,
    kind: NormalizedKind,
}

pub(in crate::sources::imported_history::replay) fn cursor_fingerprint(
    cursor_json: &str,
) -> Option<String> {
    serde_json::from_str::<JsonlCursor>(cursor_json)
        .ok()
        .map(|cursor| cursor.sample_fingerprint)
}

/// Detect a same-inode rewrite that grew instead of truncating.  Metadata and
/// whole-file samples cannot distinguish that from append; the compact cursor
/// therefore remembers bounded samples from the already-indexed prefix.  The
/// offsets are based on the old complete-line cursor, so an ordinary append
/// preserves the fingerprint while a growing in-place rewrite resets.
pub(in crate::sources::imported_history::replay) fn cursor_matches_source(
    path: &Path,
    cursor_json: &str,
) -> bool {
    let Ok(cursor) = serde_json::from_str::<JsonlCursor>(cursor_json) else {
        return false;
    };
    if cursor.byte_offset == 0 {
        return true;
    }
    boundary_fingerprint(path, cursor.byte_offset)
        .is_ok_and(|value| value == cursor.boundary_fingerprint)
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(in crate::sources::imported_history::replay) fn sync(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    previous: Option<&ReplayIndexState>,
    sample_fingerprint: &str,
) -> Result<JsonlSyncOutcome, String> {
    let mut cursor = previous
        .and_then(|state| serde_json::from_str::<JsonlCursor>(&state.driver_cursor_json).ok())
        .filter(|cursor| cursor.version == CURSOR_VERSION)
        .unwrap_or_default();
    let mut file = fs::File::open(source_path).map_err(|err| {
        format!(
            "open {} replay {}: {err}",
            source.as_str(),
            source_path.display()
        )
    })?;
    file.seek(SeekFrom::Start(cursor.byte_offset))
        .map_err(|err| format!("seek {} replay cursor: {err}", source.as_str()))?;
    let mut reader = BufReader::new(file);
    let mut stats = ReplayStats::default();
    let mut changed = false;

    loop {
        let line_start = cursor.byte_offset;
        let mut bytes = Vec::new();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|err| format!("read {} replay line: {err}", source.as_str()))?;
        if read == 0 {
            break;
        }
        // Never acknowledge a torn tail. The next poll retries the same bytes.
        if bytes.last() != Some(&b'\n') {
            break;
        }
        cursor.byte_offset = cursor.byte_offset.saturating_add(read as u64);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(read as u64);
        let trimmed = trim_jsonl_line(&bytes);
        if trimmed.is_empty() {
            continue;
        }
        let raw: Value = match serde_json::from_slice(trimmed) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        cursor
            .catalog
            .observe_jsonl(source, &raw, source_session_id);
        let span = ReplaySourceSpan {
            start: line_start,
            end: cursor.byte_offset,
        };
        let events = normalize_line(source, &raw);
        for (ordinal, event) in events.into_iter().enumerate() {
            changed |= fold_event(
                tx,
                source,
                display_session_id,
                source_session_id,
                generation,
                write_revision,
                span,
                ordinal as u32,
                event,
                &mut cursor,
                &mut stats,
            )?;
        }
    }

    if source == ImportedHistorySourceId::Qoder {
        let primary_changed = changed;
        let sidecar = qoder_sidecar::sync(
            tx,
            display_session_id,
            source_session_id,
            generation,
            write_revision,
            &cursor.qoder_sidecar,
            primary_changed,
            &mut stats,
        )?;
        cursor.qoder_sidecar = sidecar.cursor;
        changed |= sidecar.changed;
    }
    cursor.boundary_fingerprint = boundary_fingerprint(source_path, cursor.byte_offset)?;
    cursor.sample_fingerprint = sample_fingerprint.to_string();
    let total_events = count_rows(
        tx,
        "imported_replay_events",
        source,
        source_session_id,
        generation,
    )?;
    let total_turns = count_rows(
        tx,
        "imported_replay_turns",
        source,
        source_session_id,
        generation,
    )?;
    Ok(JsonlSyncOutcome {
        stats,
        driver_cursor_json: serde_json::to_string(&cursor)
            .map_err(|err| format!("encode {} replay cursor: {err}", source.as_str()))?,
        indexed_size_bytes: cursor.byte_offset,
        total_events,
        total_turns,
        changed,
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn fold_event(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    span: ReplaySourceSpan,
    payload_ordinal: u32,
    event: NormalizedEvent,
    cursor: &mut JsonlCursor,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    let created_at = event.created_at.as_str();
    if event.starts_turn {
        start_turn(
            tx,
            source,
            source_session_id,
            generation,
            cursor,
            created_at,
        )?;
    } else {
        ensure_turn(
            tx,
            source,
            source_session_id,
            generation,
            cursor,
            created_at,
        )?;
    }
    let provider = provider_slug(source);
    match event.kind {
        NormalizedKind::UserText(text) => {
            let (preview, truncated) = head_preview(&text, NORMAL_PAYLOAD_PREVIEW_BYTES);
            let chunk = imported_history::user_message_chunk(
                session_id,
                provider,
                cursor.next_sequence as usize,
                created_at,
                &preview,
            );
            let payloads = payload_descriptor(PayloadDescriptorInput {
                field_path: "result.message.content",
                kind: ReplayPayloadKind::UserMessage,
                encoding: ReplayPayloadEncoding::Utf8Text,
                span,
                source_ordinal: payload_ordinal,
                total_bytes: text.len(),
                truncated,
                body_projection: None,
            });
            let changed = insert_new_chunk(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                cursor,
                &chunk,
                &payloads,
                span,
                stats,
            )?;
            if truncated {
                payload_artifact::store_text(
                    tx,
                    source,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    "result.message.content",
                    &text,
                )?;
            }
            Ok(changed)
        }
        NormalizedKind::AssistantText(text) => {
            let (preview, truncated) = head_preview(&text, NORMAL_PAYLOAD_PREVIEW_BYTES);
            let chunk = imported_history::assistant_message_chunk(
                session_id,
                provider,
                cursor.next_sequence as usize,
                created_at,
                &preview,
            );
            let payloads = payload_descriptor(PayloadDescriptorInput {
                field_path: "result.content",
                kind: ReplayPayloadKind::AssistantContent,
                encoding: ReplayPayloadEncoding::Utf8Text,
                span,
                source_ordinal: payload_ordinal,
                total_bytes: text.len(),
                truncated,
                body_projection: None,
            });
            let changed = insert_new_chunk(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                cursor,
                &chunk,
                &payloads,
                span,
                stats,
            )?;
            if truncated {
                payload_artifact::store_text(
                    tx,
                    source,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    "result.content",
                    &text,
                )?;
            }
            Ok(changed)
        }
        NormalizedKind::Thinking(text) => {
            let (preview, truncated) = head_preview(&text, NORMAL_PAYLOAD_PREVIEW_BYTES);
            let chunk = imported_history::thinking_chunk(
                session_id,
                provider,
                cursor.next_sequence as usize,
                created_at,
                &preview,
            );
            let payloads = payload_descriptor(PayloadDescriptorInput {
                field_path: "result.content",
                kind: ReplayPayloadKind::Reasoning,
                encoding: ReplayPayloadEncoding::Utf8Text,
                span,
                source_ordinal: payload_ordinal,
                total_bytes: text.len(),
                truncated,
                body_projection: None,
            });
            let changed = insert_new_chunk(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                cursor,
                &chunk,
                &payloads,
                span,
                stats,
            )?;
            if truncated {
                payload_artifact::store_text(
                    tx,
                    source,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    "result.content",
                    &text,
                )?;
            }
            Ok(changed)
        }
        NormalizedKind::ToolUse(mut call) => {
            let full_args = serde_json::to_string(&call.args).unwrap_or_default();
            let args_size_bytes = full_args.len();
            let args_limit = if call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
                SHELL_PAYLOAD_PREVIEW_BYTES
            } else {
                NORMAL_PAYLOAD_PREVIEW_BYTES
            };
            let args_truncated = args_size_bytes > args_limit;
            let args_body_projection = args_truncated
                .then(|| {
                    replay_payload_body_projection(
                        "args",
                        &call.args,
                        Some(&full_args),
                        args_limit,
                        false,
                    )
                })
                .flatten();
            call.args = compact_tool_args(&call.args, &call.canonical_name);
            let sequence = cursor.next_sequence;
            let chunk = imported_history::tool_call_chunk(
                session_id,
                provider,
                sequence as usize,
                &call,
                "",
            );
            let payloads = payload_descriptor(PayloadDescriptorInput {
                field_path: "args",
                kind: ReplayPayloadKind::ToolArguments,
                encoding: ReplayPayloadEncoding::JsonValue,
                span,
                source_ordinal: payload_ordinal,
                total_bytes: args_size_bytes,
                truncated: args_truncated,
                body_projection: args_body_projection.clone(),
            });
            let changed = insert_new_chunk(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                cursor,
                &chunk,
                &payloads,
                span,
                stats,
            )?;
            if args_truncated {
                payload_artifact::store_text(
                    tx,
                    source,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    "args",
                    &full_args,
                )?;
            }
            cursor.pending_calls.insert(
                call.call_id.clone(),
                PendingCall {
                    call,
                    sequence,
                    turn_index: cursor.current_turn_index,
                    call_span: span,
                    payload_ordinal,
                    args_size_bytes,
                    args_truncated,
                    args_body_projection,
                },
            );
            Ok(changed)
        }
        NormalizedKind::ToolResult {
            call_id,
            output,
            failed,
            diff,
        } => {
            let Some(pending) = cursor.pending_calls.remove(&call_id) else {
                return Ok(false);
            };
            let limit =
                if pending.call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
                    SHELL_PAYLOAD_PREVIEW_BYTES
                } else {
                    NORMAL_PAYLOAD_PREVIEW_BYTES
                };
            let (preview, truncated) = tail_preview(&output, limit);
            let mut chunk = imported_history::tool_call_chunk(
                session_id,
                provider,
                pending.sequence as usize,
                &pending.call,
                &preview,
            );
            let git_artifacts = if failed {
                Vec::new()
            } else {
                let command = pending
                    .call
                    .args
                    .get("command")
                    .or_else(|| pending.call.args.get("cmd"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                parse_git_artifacts(GitArtifactParseInput {
                    command,
                    output: Some(&output),
                    exit_code: None,
                })
            };
            attach_replay_git_artifacts(&mut chunk.result, &git_artifacts);
            if failed {
                if let Some(result) = chunk.result.as_object_mut() {
                    result.insert("success".to_string(), Value::Bool(false));
                    result.insert("status".to_string(), Value::String("failed".to_string()));
                }
            }
            let mut deferred_bodies = Vec::new();
            let mut payloads = payload_descriptor(PayloadDescriptorInput {
                field_path: "result.output",
                kind: ReplayPayloadKind::ToolOutput,
                encoding: ReplayPayloadEncoding::Utf8Text,
                span,
                source_ordinal: payload_ordinal,
                total_bytes: output.len(),
                truncated,
                body_projection: None,
            });
            if truncated {
                deferred_bodies.push(("result.output".to_string(), output));
            }
            payloads.extend(payload_descriptor(PayloadDescriptorInput {
                field_path: "args",
                kind: ReplayPayloadKind::ToolArguments,
                encoding: ReplayPayloadEncoding::JsonValue,
                span: pending.call_span,
                source_ordinal: pending.payload_ordinal,
                total_bytes: pending.args_size_bytes,
                truncated: pending.args_truncated,
                body_projection: pending.args_body_projection,
            }));
            if let Some(diff) = diff {
                let (diff_preview, diff_truncated) =
                    head_preview(&diff, NORMAL_PAYLOAD_PREVIEW_BYTES);
                if let Some(result) = chunk.result.as_object_mut() {
                    result.insert("diff".to_string(), Value::String(diff_preview));
                    let (added, removed) = count_diff_lines(&diff);
                    result.insert("linesAdded".to_string(), json!(added));
                    result.insert("linesRemoved".to_string(), json!(removed));
                }
                payloads.extend(payload_descriptor(PayloadDescriptorInput {
                    field_path: "result.diff",
                    kind: ReplayPayloadKind::ToolDiff,
                    encoding: ReplayPayloadEncoding::Utf8Text,
                    span,
                    source_ordinal: payload_ordinal,
                    total_bytes: diff.len(),
                    truncated: diff_truncated,
                    body_projection: None,
                }));
                if diff_truncated {
                    deferred_bodies.push(("result.diff".to_string(), diff));
                }
            }
            let changed = upsert_chunk(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                pending.turn_index,
                pending.sequence,
                &chunk,
                &payloads,
                ReplaySourceSpan {
                    start: pending.call_span.start,
                    end: span.end,
                },
                stats,
            )?;
            for (field_path, body) in deferred_bodies {
                payload_artifact::store_text(
                    tx,
                    source,
                    source_session_id,
                    generation,
                    &chunk.chunk_id,
                    &field_path,
                    &body,
                )?;
            }
            Ok(changed)
        }
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn insert_new_chunk(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    cursor: &mut JsonlCursor,
    chunk: &ActivityChunk,
    payloads: &[ReplayPayloadDescriptor],
    span: ReplaySourceSpan,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    let changed = upsert_chunk(
        tx,
        source,
        source_session_id,
        generation,
        write_revision,
        cursor.current_turn_index,
        cursor.next_sequence,
        chunk,
        payloads,
        span,
        stats,
    )?;
    cursor.next_sequence = cursor
        .next_sequence
        .saturating_add(primary_sequence_step(source));
    Ok(changed)
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(in crate::sources::imported_history::replay) fn upsert_chunk(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
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
    let args_json =
        serde_json::to_string(&chunk.args).map_err(|err| format!("encode replay args: {err}"))?;
    let result_json = serde_json::to_string(&chunk.result)
        .map_err(|err| format!("encode replay result: {err}"))?;
    let payloads_json =
        serde_json::to_string(payloads).map_err(|err| format!("encode replay payloads: {err}"))?;
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
         WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND sequence=?4",
            params![source.as_str(), source_session_id, generation, sequence],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read replay content hash: {err}"))?;
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
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   ?14, ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(source, source_session_id, generation, sequence) DO UPDATE SET
            event_id=excluded.event_id, turn_index=excluded.turn_index,
            action_type=excluded.action_type, function_name=excluded.function_name,
            created_at=excluded.created_at, args_preview_json=excluded.args_preview_json,
            result_preview_json=excluded.result_preview_json,
            args_size_bytes=excluded.args_size_bytes, result_size_bytes=excluded.result_size_bytes,
            thread_id=excluded.thread_id, process_id=excluded.process_id,
            source_start=excluded.source_start, source_end=excluded.source_end,
            payloads_json=excluded.payloads_json, content_hash=excluded.content_hash,
            event_revision=excluded.event_revision",
        params![
            source.as_str(),
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
    .map_err(|err| format!("upsert {} replay event: {err}", source.as_str()))?;
    if inserted {
        tx.execute(
            "UPDATE imported_replay_turns SET event_count=event_count+1
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND turn_index=?4",
            params![source.as_str(), source_session_id, generation, turn_index],
        )
        .map_err(|err| format!("increment replay turn count: {err}"))?;
    }
    stats.normalized_events = stats.normalized_events.saturating_add(1);
    stats.upserted_events = stats.upserted_events.saturating_add(1);
    Ok(true)
}

fn start_turn(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    cursor: &mut JsonlCursor,
    created_at: &str,
) -> Result<(), String> {
    // Tool results belong to the turn that issued them. Calls still unresolved
    // when a new authored user turn starts remain visible with an empty result,
    // but no longer need cursor state; retaining them forever would make the
    // compact cursor grow with session history.
    cursor.pending_calls.clear();
    if cursor.current_turn_index >= 0 {
        tx.execute(
            "UPDATE imported_replay_turns SET end_sequence=?1, ended_at=?2
             WHERE source=?3 AND source_session_id=?4 AND generation=?5 AND turn_index=?6",
            params![
                cursor.next_sequence.saturating_sub(1),
                created_at,
                source.as_str(),
                source_session_id,
                generation,
                cursor.current_turn_index
            ],
        )
        .map_err(|err| format!("close replay turn: {err}"))?;
    }
    cursor.current_turn_index = cursor.current_turn_index.saturating_add(1);
    insert_turn(
        tx,
        source,
        source_session_id,
        generation,
        cursor.current_turn_index,
        cursor.next_sequence,
        created_at,
    )
}

fn ensure_turn(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    cursor: &mut JsonlCursor,
    created_at: &str,
) -> Result<(), String> {
    if cursor.current_turn_index < 0 {
        cursor.current_turn_index = 0;
        insert_turn(
            tx,
            source,
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
    source: ImportedHistorySourceId,
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
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![
            source.as_str(),
            source_session_id,
            generation,
            turn_index,
            format!("{}-turn-{turn_index}", source.as_str()),
            start_sequence,
            started_at
        ],
    )
    .map_err(|err| format!("insert replay turn: {err}"))?;
    Ok(())
}

fn count_rows(
    tx: &Transaction<'_>,
    table: &str,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<u64, String> {
    let sql = format!(
        "SELECT COUNT(*) FROM {table} WHERE source=?1 AND source_session_id=?2 AND generation=?3"
    );
    tx.query_row(
        &sql,
        params![source.as_str(), source_session_id, generation],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as u64)
    .map_err(|err| format!("count {} replay rows: {err}", source.as_str()))
}

pub(in crate::sources::imported_history::replay) fn read_payload(
    source: ImportedHistorySourceId,
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
        .map_err(|err| format!("decode replay payload locator: {err}"))?;
    let descriptor = payloads
        .into_iter()
        .find(|payload| payload.field_path == field_path)
        .ok_or_else(|| format!("No deferred replay payload for {field_path}"))?;
    let requested_start = offset.min(descriptor.total_bytes);
    let requested_end = requested_start
        .saturating_add(max_bytes as u64)
        .min(descriptor.total_bytes);
    let mut text = String::new();
    let mut decoded_offset = 0_u64;
    let mut file = fs::File::open(source_path)
        .map_err(|err| format!("open replay payload {}: {err}", source_path.display()))?;
    for span in descriptor.spans {
        file.seek(SeekFrom::Start(span.start))
            .map_err(|err| format!("seek replay payload: {err}"))?;
        let mut bytes = vec![0; span.end.saturating_sub(span.start) as usize];
        file.read_exact(&mut bytes)
            .map_err(|err| format!("read replay payload: {err}"))?;
        let raw: Value = serde_json::from_slice(trim_jsonl_line(&bytes))
            .map_err(|err| format!("decode replay payload line: {err}"))?;
        let events = normalize_line(source, &raw);
        let ordinal = descriptor.source_ordinal.unwrap_or_default() as usize;
        let Some(part) = events
            .get(ordinal)
            .and_then(|event| normalized_payload_text(event, descriptor.kind))
        else {
            continue;
        };
        let part_start = decoded_offset;
        let part_end = part_start.saturating_add(part.len() as u64);
        let overlap_start = requested_start.max(part_start);
        let overlap_end = requested_end.min(part_end);
        if overlap_start < overlap_end {
            let start =
                utf8_boundary_at_or_after(&part, overlap_start.saturating_sub(part_start) as usize);
            let end =
                utf8_boundary_at_or_before(&part, overlap_end.saturating_sub(part_start) as usize);
            if start < end {
                text.push_str(&part[start..end]);
            }
        }
        decoded_offset = part_end;
        if decoded_offset >= requested_end {
            break;
        }
    }
    let next_offset = requested_start.saturating_add(text.len() as u64);
    Ok(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: requested_start,
        next_offset,
        eof: next_offset >= descriptor.total_bytes,
        total_bytes: descriptor.total_bytes,
        text,
    })
}

#[cfg(test)]
pub(in crate::sources::imported_history::replay) fn reset_payload_fallback_decodes() {
    PAYLOAD_FALLBACK_DECODES.with(|count| count.set(0));
}

#[cfg(test)]
pub(in crate::sources::imported_history::replay) fn payload_fallback_decodes() -> usize {
    PAYLOAD_FALLBACK_DECODES.with(std::cell::Cell::get)
}

fn normalized_payload_text(event: &NormalizedEvent, kind: ReplayPayloadKind) -> Option<String> {
    match (&event.kind, kind) {
        (NormalizedKind::ToolResult { diff, .. }, ReplayPayloadKind::ToolDiff) => diff.clone(),
        (NormalizedKind::ToolUse(call), ReplayPayloadKind::ToolArguments) => {
            serde_json::to_string(&call.args).ok()
        }
        (NormalizedKind::ToolResult { output, .. }, ReplayPayloadKind::ToolOutput) => {
            Some(output.clone())
        }
        (NormalizedKind::UserText(text), ReplayPayloadKind::UserMessage)
        | (NormalizedKind::AssistantText(text), ReplayPayloadKind::AssistantContent)
        | (NormalizedKind::Thinking(text), ReplayPayloadKind::Reasoning) => Some(text.clone()),
        _ => None,
    }
}

pub(in crate::sources::imported_history::replay) fn boundary_fingerprint(
    path: &Path,
    offset: u64,
) -> Result<String, String> {
    if offset == 0 {
        return Ok(String::new());
    }
    let mut file = fs::File::open(path).map_err(|err| format!("open JSONL boundary: {err}"))?;
    let sample_bytes = BOUNDARY_BYTES.min(offset);
    let starts = [
        0,
        offset.saturating_sub(sample_bytes) / 2,
        offset.saturating_sub(sample_bytes),
    ];
    let mut hash = 0xcbf29ce484222325_u64;
    for start in starts {
        file.seek(SeekFrom::Start(start))
            .map_err(|err| format!("seek JSONL lineage sample: {err}"))?;
        let len = sample_bytes.min(offset.saturating_sub(start)) as usize;
        let mut bytes = vec![0; len];
        file.read_exact(&mut bytes)
            .map_err(|err| format!("read JSONL lineage sample: {err}"))?;
        for byte in start.to_le_bytes().iter().chain(bytes.iter()) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("{hash:016x}"))
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

pub(in crate::sources::imported_history::replay) fn head_preview(
    text: &str,
    max_bytes: usize,
) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let end = utf8_boundary_at_or_before(text, max_bytes);
    (format!("{}\n… [payload truncated]", &text[..end]), true)
}

pub(in crate::sources::imported_history::replay) fn tail_preview(
    text: &str,
    max_bytes: usize,
) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (format!("[payload truncated] …\n{}", &text[start..]), true)
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

pub(in crate::sources::imported_history::replay) fn content_hash(parts: &[&[u8]]) -> String {
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
#[path = "../../tests/jsonl_driver.rs"]
mod tests;
