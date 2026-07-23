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

use super::index::ReplayIndexState;
use super::payload_artifact;
use super::{
    replay_payload_body_projection, ImportedHistorySourceId, ReplayPayloadBodyProjection,
    ReplayPayloadDescriptor, ReplayPayloadEncoding, ReplayPayloadKind, ReplayPayloadRange,
    ReplaySourceSpan, ReplayStats, NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

const CURSOR_VERSION: u32 = 1;
const BOUNDARY_BYTES: u64 = 4 * 1024;
/// Qoder's text transcript omits its tool trajectory. Reserve a wide, stable
/// sequence gap between transcript records so timestamp-ordered sidecar cards
/// can arrive later without renumbering transcript events.
pub(super) const QODER_PRIMARY_SEQUENCE_STEP: i64 = 1_000_000_000_000_000;

#[derive(Debug, Clone)]
pub(super) struct JsonlSyncOutcome {
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
    qoder_sidecar: super::qoder_sidecar::QoderSidecarCursor,
    #[serde(default)]
    catalog: super::super::catalog::ReplayCatalogProjection,
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
            qoder_sidecar: super::qoder_sidecar::QoderSidecarCursor::default(),
            catalog: super::super::catalog::ReplayCatalogProjection::default(),
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

pub(super) fn cursor_fingerprint(cursor_json: &str) -> Option<String> {
    serde_json::from_str::<JsonlCursor>(cursor_json)
        .ok()
        .map(|cursor| cursor.sample_fingerprint)
}

/// Detect a same-inode rewrite that grew instead of truncating.  Metadata and
/// whole-file samples cannot distinguish that from append; the compact cursor
/// therefore remembers bounded samples from the already-indexed prefix.  The
/// offsets are based on the old complete-line cursor, so an ordinary append
/// preserves the fingerprint while a growing in-place rewrite resets.
pub(super) fn cursor_matches_source(path: &Path, cursor_json: &str) -> bool {
    let Ok(cursor) = serde_json::from_str::<JsonlCursor>(cursor_json) else {
        return false;
    };
    if cursor.byte_offset == 0 {
        return true;
    }
    boundary_fingerprint(path, cursor.byte_offset)
        .is_ok_and(|value| value == cursor.boundary_fingerprint)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
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
        let sidecar = super::qoder_sidecar::sync(
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

#[allow(clippy::too_many_arguments)]
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

#[allow(clippy::too_many_arguments)]
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

#[allow(clippy::too_many_arguments)]
pub(super) fn upsert_chunk(
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

fn normalize_line(source: ImportedHistorySourceId, raw: &Value) -> Vec<NormalizedEvent> {
    if source == ImportedHistorySourceId::Trae {
        return normalize_trae(raw);
    }
    let created_at = normalized_timestamp(raw.get("timestamp").or_else(|| raw.get("createdAt")));
    let mut events = Vec::new();

    // WorkBuddy also writes top-level function_call/result records.
    if source == ImportedHistorySourceId::WorkBuddy {
        if let Some(call) = workbuddy_top_level_call(raw, &created_at) {
            events.push(NormalizedEvent {
                created_at: created_at.clone(),
                starts_turn: false,
                kind: NormalizedKind::ToolUse(call),
            });
        }
        if let Some((call_id, output, failed)) = workbuddy_top_level_result(raw) {
            events.push(NormalizedEvent {
                created_at: created_at.clone(),
                starts_turn: false,
                kind: NormalizedKind::ToolResult {
                    call_id,
                    output,
                    failed,
                    diff: None,
                },
            });
        }
        if raw.get("type").and_then(Value::as_str) == Some("reasoning") {
            if let Some(text) = first_text(raw.get("content").or_else(|| raw.get("rawContent"))) {
                events.push(NormalizedEvent {
                    created_at: created_at.clone(),
                    starts_turn: false,
                    kind: NormalizedKind::AssistantText(text),
                });
            }
        }
    }

    let message = raw
        .get("message")
        .filter(|message| message.is_object())
        .or_else(|| {
            (raw.get("type").and_then(Value::as_str) == Some("message")
                && raw.get("role").is_some())
            .then_some(raw)
        });
    let Some(message) = message else {
        return events;
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| raw.get("role").and_then(Value::as_str))
        .or_else(|| raw.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    let content = message.get("content").unwrap_or(&Value::Null);
    let claude_diff = (source == ImportedHistorySourceId::ClaudeCode)
        .then(|| raw.get("toolUseResult").and_then(claude_structured_diff))
        .flatten();
    normalize_content(
        source,
        role,
        content,
        &created_at,
        claude_diff.as_deref(),
        &mut events,
    );
    events
}

fn normalize_content(
    source: ImportedHistorySourceId,
    role: &str,
    content: &Value,
    created_at: &str,
    tool_diff: Option<&str>,
    events: &mut Vec<NormalizedEvent>,
) {
    let items: Vec<&Value> = match content {
        Value::Array(items) => items.iter().collect(),
        Value::String(_) => vec![content],
        _ => Vec::new(),
    };
    let mut user_text_seen = false;
    for item in items {
        if let Some(text) = item.as_str() {
            let text = normalize_user_text(source, role, text);
            if text.is_empty() {
                continue;
            }
            let is_user = role == "user";
            events.push(NormalizedEvent {
                created_at: created_at.to_string(),
                starts_turn: is_user && !user_text_seen,
                kind: if is_user {
                    NormalizedKind::UserText(text)
                } else {
                    NormalizedKind::AssistantText(text)
                },
            });
            user_text_seen |= is_user;
            continue;
        }
        match item.get("type").and_then(Value::as_str).unwrap_or("text") {
            "text" => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                let text = normalize_user_text(source, role, text);
                if text.is_empty() {
                    continue;
                }
                let is_user = role == "user";
                events.push(NormalizedEvent {
                    created_at: created_at.to_string(),
                    starts_turn: is_user && !user_text_seen,
                    kind: if is_user {
                        NormalizedKind::UserText(text)
                    } else {
                        NormalizedKind::AssistantText(text)
                    },
                });
                user_text_seen |= is_user;
            }
            "thinking" | "reasoning" => {
                let text = item
                    .get("thinking")
                    .or_else(|| item.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if !text.is_empty() {
                    events.push(NormalizedEvent {
                        created_at: created_at.to_string(),
                        starts_turn: false,
                        kind: NormalizedKind::Thinking(text.to_string()),
                    });
                }
            }
            "tool_use" | "function_call" => {
                if let Some(call) = block_tool_call(source, item, created_at) {
                    events.push(NormalizedEvent {
                        created_at: created_at.to_string(),
                        starts_turn: false,
                        kind: NormalizedKind::ToolUse(call),
                    });
                }
            }
            "tool_result" | "function_call_result" => {
                if let Some(call_id) = item
                    .get("tool_use_id")
                    .or_else(|| item.get("callId"))
                    .or_else(|| item.get("call_id"))
                    .and_then(Value::as_str)
                {
                    let output = value_to_text(item.get("content").or_else(|| item.get("output")));
                    let failed = item.get("is_error").and_then(Value::as_bool) == Some(true);
                    events.push(NormalizedEvent {
                        created_at: created_at.to_string(),
                        starts_turn: false,
                        kind: NormalizedKind::ToolResult {
                            call_id: call_id.to_string(),
                            output,
                            failed,
                            diff: tool_diff.map(str::to_string),
                        },
                    });
                }
            }
            _ => {}
        }
    }
}

fn normalize_trae(raw: &Value) -> Vec<NormalizedEvent> {
    let created_at = raw
        .get("message_summary_time")
        .and_then(Value::as_str)
        .and_then(trae_timestamp)
        .unwrap_or_default();
    let mut events = Vec::new();
    let intent = raw
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !intent.is_empty() {
        events.push(NormalizedEvent {
            created_at: created_at.clone(),
            starts_turn: true,
            kind: NormalizedKind::UserText(intent.to_string()),
        });
    }
    let mut body = String::new();
    if let Some(outcome) = raw
        .get("outcome")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        body.push_str(outcome);
    }
    append_summary_list(&mut body, "Actions:", raw.get("actions"));
    append_summary_list(&mut body, "Learned:", raw.get("learned"));
    if !body.is_empty() {
        events.push(NormalizedEvent {
            created_at,
            starts_turn: intent.is_empty(),
            kind: NormalizedKind::AssistantText(body),
        });
    }
    events
}

fn append_summary_list(output: &mut String, heading: &str, value: Option<&Value>) {
    let Some(items) = value
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    else {
        return;
    };
    if !output.is_empty() {
        output.push_str("\n\n");
    }
    output.push_str(heading);
    for item in items.iter().filter_map(Value::as_str) {
        output.push_str("\n- ");
        output.push_str(item.trim());
    }
}

fn block_tool_call(
    source: ImportedHistorySourceId,
    item: &Value,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = item
        .get("id")
        .or_else(|| item.get("callId"))
        .or_else(|| item.get("call_id"))
        .and_then(Value::as_str)?
        .to_string();
    let raw_name = item
        .get("name")
        .or_else(|| item.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let args = item
        .get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_tool_call(source, &raw_name, parse_argument_value(args));
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn workbuddy_top_level_call(raw: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call = raw.get("functionCall").or_else(|| {
        (raw.get("type").and_then(Value::as_str) == Some("function_call")).then_some(raw)
    })?;
    block_tool_call(ImportedHistorySourceId::WorkBuddy, call, created_at)
}

fn workbuddy_top_level_result(raw: &Value) -> Option<(String, String, bool)> {
    let result = raw.get("functionCallResult").or_else(|| {
        (raw.get("type").and_then(Value::as_str) == Some("function_call_result")).then_some(raw)
    })?;
    let call_id = result
        .get("callId")
        .or_else(|| result.get("call_id"))
        .or_else(|| result.get("id"))
        .and_then(Value::as_str)?
        .to_string();
    let value = result
        .get("output")
        .or_else(|| result.get("result"))
        .or_else(|| result.get("content"));
    let output = value_to_text(value);
    let failed = result
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "failed" | "error"));
    Some((call_id, output, failed))
}

fn normalize_tool_call(
    source: ImportedHistorySourceId,
    raw_name: &str,
    args: Value,
) -> (String, Value) {
    let lower = raw_name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "bash" | "shell" | "execute" | "run_command" | "terminal" | "terminal_command"
    ) {
        let command = args
            .get("command")
            .or_else(|| args.get("cmd"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            json!({ "command": command, "cmd": command }),
        );
    }
    if source != ImportedHistorySourceId::Qoder
        && matches!(
            lower.as_str(),
            "edit"
                | "multiedit"
                | "write"
                | "edit_file"
                | "edit_file_v2"
                | "write_file"
                | "patch"
                | "apply_patch"
                | "str_replace"
        )
    {
        let file_path = args
            .get("file_path")
            .or_else(|| args.get("filePath"))
            .or_else(|| args.get("path"))
            .or_else(|| args.get("targetFile"))
            .or_else(|| args.get("relativeWorkspacePath"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            json!({ "action": raw_name, "file_path": file_path, "payload": args }),
        );
    }
    (raw_name.to_string(), args)
}

fn parse_argument_value(value: Value) -> Value {
    match value {
        Value::String(text) => imported_history::parse_inner_json(&text),
        other => other,
    }
}

fn normalize_user_text(source: ImportedHistorySourceId, role: &str, text: &str) -> String {
    if role != "user" {
        return text.trim().to_string();
    }
    let stripped = imported_history::strip_internal_context_blocks(text);
    if source == ImportedHistorySourceId::Qoder {
        if let Some(start) = stripped.find("<user_query>") {
            let rest = &stripped[start + "<user_query>".len()..];
            return rest
                .split("</user_query>")
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
        }
        return strip_tag_blocks(stripped, "system-reminder");
    }
    stripped.trim().to_string()
}

fn strip_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        output.push_str(&rest[..start]);
        let Some(end) = rest[start + open.len()..].find(&close) else {
            break;
        };
        rest = &rest[start + open.len() + end + close.len()..];
    }
    output.push_str(rest);
    output.trim().to_string()
}

fn first_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn value_to_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| value_to_text(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("content"))
            .map(|value| value_to_text(Some(value)))
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn claude_structured_diff(result: &Value) -> Option<String> {
    let hunks = result.get("structuredPatch").and_then(Value::as_array)?;
    if hunks.is_empty() {
        return None;
    }
    let path = result
        .get("filePath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut diff = format!("--- {path}\n+++ {path}\n");
    for hunk in hunks {
        let old_start = hunk
            .get("oldStart")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let old_lines = hunk
            .get("oldLines")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let new_start = hunk
            .get("newStart")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let new_lines = hunk
            .get("newLines")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        diff.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        for line in hunk
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            diff.push_str(line);
            diff.push('\n');
        }
    }
    Some(diff)
}

fn count_diff_lines(diff: &str) -> (i64, i64) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

fn normalized_timestamp(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) if !raw.trim().is_empty() => {
            imported_history::normalize_created_at(raw)
        }
        Some(Value::Number(number)) => number
            .as_i64()
            .map(|value| {
                if value < 10_000_000_000 {
                    value.saturating_mul(1_000)
                } else {
                    value
                }
            })
            .map(imported_history::epoch_ms_to_iso)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn trae_timestamp(raw: &str) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(raw.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|naive| naive.and_local_timezone(chrono::Local).earliest())
        .map(|timestamp| timestamp.to_rfc3339())
}

fn provider_slug(source: ImportedHistorySourceId) -> &'static str {
    match source {
        ImportedHistorySourceId::ClaudeCode => "claudecode",
        ImportedHistorySourceId::WorkBuddy => "workbuddy",
        ImportedHistorySourceId::Trae => "trae",
        ImportedHistorySourceId::Qoder => "qoder",
        ImportedHistorySourceId::Omp => "omp",
        ImportedHistorySourceId::QoderCli => "qoder_cli",
        _ => source.as_str(),
    }
}

fn primary_sequence_step(source: ImportedHistorySourceId) -> i64 {
    if source == ImportedHistorySourceId::Qoder {
        QODER_PRIMARY_SEQUENCE_STEP
    } else {
        1
    }
}

pub(super) fn compact_tool_args(args: &Value, function: &str) -> Value {
    let limit = if function == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    let Ok(encoded) = serde_json::to_string(args) else {
        return json!({});
    };
    if encoded.len() <= limit {
        return args.clone();
    }
    let preview_budget = (limit / 2).max(256);
    let (preview, _) = head_preview(&encoded, preview_budget);
    let mut compact = json!({ "payloadPreview": preview, "payloadTruncated": true });
    if let (Some(target), Some(source)) = (compact.as_object_mut(), args.as_object()) {
        let semantic_keys = [
            "command",
            "cmd",
            "file_path",
            "filePath",
            "path",
            "action",
            "query",
            "pattern",
            "linesAdded",
            "linesRemoved",
            "operation",
            "agentType",
            "description",
            "cell_id",
            "session_id",
            "chars",
            "limit",
            "offset",
        ];
        let selected = semantic_keys
            .into_iter()
            .filter_map(|key| source.get(key).map(|value| (key, value)))
            .collect::<Vec<_>>();
        let per_value_budget = (limit / 2)
            .checked_div(selected.len().max(1))
            .unwrap_or(256)
            .max(128);
        for (key, value) in selected {
            target.insert(
                key.to_string(),
                compact_semantic_arg_value(value, per_value_budget),
            );
        }
    }
    compact
}

fn compact_semantic_arg_value(value: &Value, max_bytes: usize) -> Value {
    let encoded = serde_json::to_string(value).unwrap_or_default();
    if encoded.len() <= max_bytes {
        return value.clone();
    }
    if let Some(text) = value.as_str() {
        return Value::String(head_preview(text, max_bytes).0);
    }
    Value::String(head_preview(&encoded, max_bytes).0)
}

struct PayloadDescriptorInput<'a> {
    field_path: &'a str,
    kind: ReplayPayloadKind,
    encoding: ReplayPayloadEncoding,
    span: ReplaySourceSpan,
    source_ordinal: u32,
    total_bytes: usize,
    truncated: bool,
    body_projection: Option<ReplayPayloadBodyProjection>,
}

fn payload_descriptor(input: PayloadDescriptorInput<'_>) -> Vec<ReplayPayloadDescriptor> {
    if !input.truncated {
        return Vec::new();
    }
    vec![ReplayPayloadDescriptor {
        field_path: input.field_path.to_string(),
        kind: input.kind,
        encoding: input.encoding,
        body_projection: input.body_projection,
        spans: vec![input.span],
        total_bytes: input.total_bytes as u64,
        source_ordinal: Some(input.source_ordinal),
        source_key: None,
    }]
}

pub(super) fn read_payload(
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
pub(super) fn reset_payload_fallback_decodes() {
    PAYLOAD_FALLBACK_DECODES.with(|count| count.set(0));
}

#[cfg(test)]
pub(super) fn payload_fallback_decodes() -> usize {
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

pub(super) fn boundary_fingerprint(path: &Path, offset: u64) -> Result<String, String> {
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

pub(super) fn head_preview(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let end = utf8_boundary_at_or_before(text, max_bytes);
    (format!("{}\n… [payload truncated]", &text[..end]), true)
}

pub(super) fn tail_preview(text: &str, max_bytes: usize) -> (String, bool) {
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

pub(super) fn content_hash(parts: &[&[u8]]) -> String {
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
    use std::io::Write;

    use crate::store::sqlite::SqliteRecordStore;

    #[test]
    fn qoder_wrapped_user_text_is_preserved_without_internal_context() {
        let events = normalize_line(
            ImportedHistorySourceId::Qoder,
            &json!({
                "role":"user", "message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder><user_query>hello</user_query>"}]}
            }),
        );
        assert!(matches!(&events[0].kind, NormalizedKind::UserText(text) if text == "hello"));
    }

    #[test]
    fn anthropic_tool_use_and_result_normalize_without_full_transcript() {
        let call = normalize_line(
            ImportedHistorySourceId::Omp,
            &json!({
                "type":"assistant", "message":{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"bash","input":{"command":"pwd"}}]}
            }),
        );
        let result = normalize_line(
            ImportedHistorySourceId::Omp,
            &json!({
                "type":"user", "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"/repo"}]}
            }),
        );
        assert!(matches!(&call[0].kind, NormalizedKind::ToolUse(tool) if tool.call_id == "c1"));
        assert!(
            matches!(&result[0].kind, NormalizedKind::ToolResult { output, .. } if output == "/repo")
        );
    }

    #[test]
    fn trae_line_stays_one_turn() {
        let events = normalize_line(
            ImportedHistorySourceId::Trae,
            &json!({
                "intent":"fix it", "outcome":"done", "actions":["edit"], "learned":[]
            }),
        );
        assert_eq!(events.len(), 2);
        assert!(events[0].starts_turn);
        assert!(!events[1].starts_turn);
    }

    fn fixture_lines(source: ImportedHistorySourceId) -> (String, String) {
        match source {
            ImportedHistorySourceId::ClaudeCode => (
                json!({"type":"user","timestamp":"2026-07-22T00:00:00Z","message":{"role":"user","content":"hello"}}).to_string(),
                json!({"type":"assistant","timestamp":"2026-07-22T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}).to_string(),
            ),
            ImportedHistorySourceId::WorkBuddy => (
                json!({"type":"message","timestamp":"2026-07-22T00:00:00Z","role":"user","content":"hello"}).to_string(),
                json!({"type":"message","timestamp":"2026-07-22T00:00:01Z","role":"assistant","content":"world"}).to_string(),
            ),
            ImportedHistorySourceId::Trae => (
                json!({"intent":"hello","outcome":"ok","actions":[],"learned":[],"message_summary_time":"2026-07-22 08:00:00"}).to_string(),
                json!({"intent":"again","outcome":"done","actions":[],"learned":[],"message_summary_time":"2026-07-22 08:00:01"}).to_string(),
            ),
            ImportedHistorySourceId::Qoder => (
                json!({"role":"user","message":{"content":[{"type":"text","text":"<user_query>hello</user_query>"}]}}).to_string(),
                json!({"role":"assistant","message":{"content":[{"type":"text","text":"world"}]}}).to_string(),
            ),
            ImportedHistorySourceId::Omp | ImportedHistorySourceId::QoderCli => (
                json!({"type":"user","timestamp":1_753_152_000_000_i64,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}).to_string(),
                json!({"type":"assistant","timestamp":1_753_152_001_000_i64,"message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}).to_string(),
            ),
            _ => unreachable!("JSONL conformance source"),
        }
    }

    fn state_from(outcome: &JsonlSyncOutcome, source: ImportedHistorySourceId) -> ReplayIndexState {
        ReplayIndexState {
            generation: "generation-1".to_string(),
            revision: 1,
            parser_version: 1,
            source_identity: source.as_str().to_string(),
            driver_cursor_json: outcome.driver_cursor_json.clone(),
            indexed_size_bytes: outcome.indexed_size_bytes,
            indexed_mtime_ns: 0,
            total_events: outcome.total_events,
            total_turns: outcome.total_turns,
            state_updated_at_ms: 0,
        }
    }

    #[test]
    fn every_jsonl_adapter_obeys_incremental_and_partial_tail_contract() {
        let sources = [
            ImportedHistorySourceId::ClaudeCode,
            ImportedHistorySourceId::WorkBuddy,
            ImportedHistorySourceId::Trae,
            ImportedHistorySourceId::Qoder,
            ImportedHistorySourceId::Omp,
            ImportedHistorySourceId::QoderCli,
        ];
        for source in sources {
            let (first, second) = fixture_lines(source);
            let path = std::env::temp_dir().join(format!(
                "orgii-{}-jsonl-replay-{}-{}.jsonl",
                source.as_str(),
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ));
            fs::write(&path, format!("{first}\n")).expect("write cold fixture");
            let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
            SqliteRecordStore::init_tables(&conn).expect("replay schema");
            SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache replay schema");

            let cold = {
                let tx = conn.transaction().expect("cold transaction");
                let outcome = sync(
                    &tx,
                    source,
                    &format!("{}fixture", source.descriptor().session_prefix),
                    "fixture",
                    &path,
                    "generation-1",
                    1,
                    None,
                    "sample-1",
                )
                .expect("cold sync");
                tx.commit().expect("commit cold sync");
                outcome
            };
            assert!(cold.stats.parsed_rows >= 1, "{} cold", source.as_str());
            assert!(cold.total_events >= 1, "{} cold events", source.as_str());
            let cold_state = state_from(&cold, source);

            let unchanged = {
                let tx = conn.transaction().expect("unchanged transaction");
                let outcome = sync(
                    &tx,
                    source,
                    &format!("{}fixture", source.descriptor().session_prefix),
                    "fixture",
                    &path,
                    "generation-1",
                    2,
                    Some(&cold_state),
                    "sample-1",
                )
                .expect("unchanged sync");
                tx.commit().expect("commit unchanged sync");
                outcome
            };
            assert_eq!(
                unchanged.stats.parsed_rows,
                0,
                "{} unchanged",
                source.as_str()
            );
            assert_eq!(
                unchanged.stats.parsed_bytes,
                0,
                "{} unchanged bytes",
                source.as_str()
            );

            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("append fixture");
            file.write_all(second.as_bytes()).expect("write torn tail");
            file.flush().expect("flush torn tail");
            let partial = {
                let tx = conn.transaction().expect("partial transaction");
                let outcome = sync(
                    &tx,
                    source,
                    &format!("{}fixture", source.descriptor().session_prefix),
                    "fixture",
                    &path,
                    "generation-1",
                    2,
                    Some(&cold_state),
                    "sample-2",
                )
                .expect("partial sync");
                tx.commit().expect("commit partial sync");
                outcome
            };
            assert_eq!(partial.stats.parsed_rows, 0, "{} partial", source.as_str());
            assert_eq!(partial.indexed_size_bytes, cold.indexed_size_bytes);

            file.write_all(b"\n").expect("complete tail");
            file.flush().expect("flush complete tail");
            drop(file);
            let completed = {
                let tx = conn.transaction().expect("append transaction");
                let outcome = sync(
                    &tx,
                    source,
                    &format!("{}fixture", source.descriptor().session_prefix),
                    "fixture",
                    &path,
                    "generation-1",
                    2,
                    Some(&cold_state),
                    "sample-2",
                )
                .expect("append sync");
                tx.commit().expect("commit append sync");
                outcome
            };
            assert_eq!(completed.stats.parsed_rows, 1, "{} append", source.as_str());
            assert!(completed.indexed_size_bytes > cold.indexed_size_bytes);

            fs::write(
                &path,
                format!("{}\n{}\n", second, "x".repeat(first.len() + 32)),
            )
            .expect("replace fixture");
            assert!(!cursor_matches_source(&path, &completed.driver_cursor_json));
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn every_jsonl_adapter_conforms_through_public_open_poll_and_reset() {
        let sources = [
            ImportedHistorySourceId::ClaudeCode,
            ImportedHistorySourceId::WorkBuddy,
            ImportedHistorySourceId::Trae,
            ImportedHistorySourceId::Qoder,
            ImportedHistorySourceId::Omp,
            ImportedHistorySourceId::QoderCli,
        ];
        for source in sources {
            let (first, second) = fixture_lines(source);
            let source_session_id = format!("public-{}", source.as_str());
            let session_id = format!(
                "{}{}",
                source.descriptor().session_prefix,
                source_session_id
            );
            let path = std::env::temp_dir().join(format!(
                "orgii-public-{}-{}-{}.jsonl",
                source.as_str(),
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ));
            fs::write(&path, format!("{first}\n")).expect("write public fixture");
            let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
            SqliteRecordStore::init_tables(&conn).expect("base schema");
            SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
            conn.execute(
                "INSERT INTO imported_history_session_cache (
                    source, source_session_id, session_id, source_path
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    source.as_str(),
                    source_session_id,
                    session_id,
                    path.to_string_lossy()
                ],
            )
            .expect("cache public source");

            let opened = super::super::open_window(
                &mut conn,
                source,
                &session_id,
                super::super::ReplayLimits::default(),
            )
            .expect("public cold open");
            assert!(!opened.chunks.is_empty(), "{} cold window", source.as_str());
            assert!(
                opened.stats.parsed_rows >= 1,
                "{} cold telemetry",
                source.as_str()
            );
            let unchanged = super::super::poll_delta(
                &mut conn,
                source,
                &session_id,
                &opened.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("public unchanged poll");
            assert_eq!(
                unchanged.stats.parsed_rows,
                0,
                "{} unchanged",
                source.as_str()
            );
            assert!(unchanged.chunks.is_empty());

            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("append public");
            file.write_all(second.as_bytes())
                .expect("write public partial");
            file.flush().expect("flush public partial");
            let partial = super::super::poll_delta(
                &mut conn,
                source,
                &session_id,
                &opened.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("public partial poll");
            assert_eq!(partial.stats.parsed_rows, 0, "{} partial", source.as_str());
            assert_eq!(partial.cursor.revision, opened.cursor.revision);

            file.write_all(b"\n").expect("complete public tail");
            file.flush().expect("flush public complete");
            drop(file);
            let completed = super::super::poll_delta(
                &mut conn,
                source,
                &session_id,
                &opened.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("public append poll");
            assert!(
                !completed.chunks.is_empty(),
                "{} append delta",
                source.as_str()
            );
            assert_eq!(completed.stats.parsed_rows, 1);

            // Truncation publishes a new generation atomically and asks the
            // caller to replace its bounded window.
            fs::write(&path, format!("{first}\n")).expect("truncate public fixture");
            let reset = super::super::poll_delta(
                &mut conn,
                source,
                &session_id,
                &completed.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("public reset poll");
            assert!(reset.reset_required, "{} truncate reset", source.as_str());
            assert_ne!(reset.cursor.generation, completed.cursor.generation);
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn shared_jsonl_open_window_and_range_are_end_to_end_bounded() {
        let source = ImportedHistorySourceId::ClaudeCode;
        let session_id = "claudecodeapp-range-fixture";
        let source_session_id = "range-fixture";
        let large = format!("BEGIN-{}-END", "你".repeat(10_000));
        let user = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:00Z",
            "message":{"role":"user","content":"hello"}
        });
        let assistant = json!({
            "type":"assistant", "timestamp":"2026-07-22T00:00:01Z",
            "message":{"role":"assistant","content":[{"type":"text","text":large}]}
        });
        let path = std::env::temp_dir().join(format!(
            "orgii-claude-range-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(&path, format!("{user}\n{assistant}\n")).expect("range fixture");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                path.to_string_lossy()
            ],
        )
        .expect("cache source path");

        let opened = super::super::open_window(
            &mut conn,
            source,
            session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open bounded Claude replay");
        let assistant = opened
            .chunks
            .iter()
            .find(|chunk| chunk.chunk.function == imported_history::FUNCTION_ASSISTANT)
            .expect("assistant preview");
        // The canonical assistant result intentionally mirrors the preview in
        // `content` and `observation`; each field remains under the 8 KiB
        // preview cap even though the serialized compatibility shape is ~16 KiB.
        assert!(serde_json::to_vec(&assistant.chunk).unwrap().len() < 20 * 1024);
        assert_eq!(assistant.payloads.len(), 1);

        let mut reconstructed = String::new();
        let mut offset = 0;
        loop {
            let range = super::super::read_payload_range(
                &mut conn,
                source,
                session_id,
                &opened.cursor.generation,
                &assistant.chunk.chunk_id,
                "result.content",
                offset,
                Some(1024),
            )
            .expect("range read");
            assert!(range.text.len() <= 1024);
            reconstructed.push_str(&range.text);
            offset = range.next_offset;
            if range.eof {
                break;
            }
        }
        assert_eq!(reconstructed, large);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn shared_jsonl_ten_mib_shell_ranges_never_reparse_the_source_row() {
        fn update_hash(mut hash: u64, text: &str) -> u64 {
            for byte in text.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x100000001b3);
            }
            hash
        }

        let source = ImportedHistorySourceId::ClaudeCode;
        let session_id = "claudecodeapp-large-shell-artifact";
        let source_session_id = "large-shell-artifact";
        let output = format!("BEGIN:{}:END", "x".repeat(10 * 1024 * 1024));
        let user = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:00Z",
            "message":{"role":"user","content":"run a large command"}
        });
        let call = json!({
            "type":"assistant", "timestamp":"2026-07-22T00:00:01Z",
            "message":{"role":"assistant","content":[{
                "type":"tool_use", "id":"shell-large", "name":"Bash",
                "input":{"command":"printf payload"}
            }]}
        });
        let result = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:02Z",
            "message":{"role":"user","content":[{
                "type":"tool_result", "tool_use_id":"shell-large", "content":output.clone()
            }]}
        });
        let path = std::env::temp_dir().join(format!(
            "orgii-claude-large-shell-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(&path, format!("{user}\n{call}\n{result}\n")).expect("large Claude JSONL");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                path.to_string_lossy()
            ],
        )
        .expect("cache source path");

        let opened = super::super::open_window(
            &mut conn,
            source,
            session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("index large Claude Shell output");
        assert_eq!(opened.stats.parsed_rows, 3);
        let shell = opened
            .chunks
            .iter()
            .find(|chunk| chunk.chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
            .expect("Claude Shell event");
        let artifact_count = conn
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source=?1 AND generation=?2",
                params![source.as_str(), &opened.cursor.generation],
                |row| row.get::<_, i64>(0),
            )
            .expect("Claude artifact count");
        assert_eq!(artifact_count, 1);

        reset_payload_fallback_decodes();
        let mut actual_hash = 0xcbf29ce484222325_u64;
        let mut actual_bytes = 0_usize;
        let mut offset = 0_u64;
        loop {
            let range = super::super::read_payload_range(
                &mut conn,
                source,
                session_id,
                &opened.cursor.generation,
                &shell.chunk.chunk_id,
                "result.output",
                offset,
                Some(super::super::HARD_MAX_PAYLOAD_RANGE_BYTES),
            )
            .expect("read Claude artifact page");
            assert!(range.text.len() <= super::super::HARD_MAX_PAYLOAD_RANGE_BYTES);
            assert!(range.next_offset > offset || range.eof);
            actual_hash = update_hash(actual_hash, &range.text);
            actual_bytes = actual_bytes.saturating_add(range.text.len());
            offset = range.next_offset;
            if range.eof {
                break;
            }
        }
        assert_eq!(actual_bytes, output.len());
        assert_eq!(actual_hash, update_hash(0xcbf29ce484222325, &output));
        assert_eq!(payload_fallback_decodes(), 0);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn large_real_driver_rows_keep_edit_and_git_metadata_projection() {
        let source = ImportedHistorySourceId::ClaudeCode;
        let session_id = "claudecodeapp-metadata-fixture";
        let source_session_id = "metadata-fixture";
        let user = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:00Z",
            "message":{"role":"user","content":"edit and commit"}
        });
        let edit_call = json!({
            "type":"assistant", "timestamp":"2026-07-22T00:00:01Z",
            "message":{"role":"assistant","content":[{
                "type":"tool_use", "id":"edit-1", "name":"Edit",
                "input":{
                    "file_path":"src/large.rs",
                    "old_string":"old\n".repeat(3_000),
                    "new_string":"new\n".repeat(3_000)
                }
            }]}
        });
        let edit_result = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:02Z",
            "message":{"role":"user","content":[{
                "type":"tool_result", "tool_use_id":"edit-1", "content":"updated"
            }]},
            "toolUseResult":{
                "filePath":"src/large.rs",
                "structuredPatch":[{
                    "oldStart":1,"oldLines":1,"newStart":1,"newLines":2,
                    "lines":["-old","+new","+another"]
                }]
            }
        });
        let git_command = format!("git commit -m metadata # {}", "x".repeat(40 * 1024));
        let git_call = json!({
            "type":"assistant", "timestamp":"2026-07-22T00:00:03Z",
            "message":{"role":"assistant","content":[{
                "type":"tool_use", "id":"git-1", "name":"Bash",
                "input":{"command":git_command}
            }]}
        });
        let git_output = format!(
            "[feature abc1234] metadata\n{}\nhttps://github.com/acme/repo/pull/42\n{}",
            "middle".repeat(8 * 1024),
            "tail".repeat(12 * 1024)
        );
        let git_result = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:04Z",
            "message":{"role":"user","content":[{
                "type":"tool_result", "tool_use_id":"git-1", "content":git_output
            }]}
        });
        let path = std::env::temp_dir().join(format!(
            "orgii-claude-metadata-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(
            &path,
            format!("{user}\n{edit_call}\n{edit_result}\n{git_call}\n{git_result}\n"),
        )
        .expect("metadata fixture");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                path.to_string_lossy()
            ],
        )
        .expect("cache metadata source");

        let opened = super::super::open_window(
            &mut conn,
            source,
            session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("index metadata fixture");
        let turn_id = opened.turn_headers[0].turn_id.clone();
        let projected = super::super::project_turn_metadata(
            &mut conn,
            source,
            session_id,
            Some(std::slice::from_ref(&turn_id)),
        )
        .expect("project compact driver rows");

        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].modified_files.len(), 1);
        assert_eq!(projected[0].modified_files[0].path, "src/large.rs");
        assert_eq!(projected[0].modified_files[0].additions, 2);
        assert_eq!(projected[0].modified_files[0].deletions, 1);
        assert!(projected[0]
            .git_artifacts
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
        assert!(projected[0]
            .git_artifacts
            .iter()
            .any(|artifact| artifact.pr_number == Some(42)));

        let (edit_args, git_args, git_result): (String, String, String) = conn
            .query_row(
                "SELECT
                    MAX(CASE WHEN function_name LIKE 'edit%' THEN args_preview_json END),
                    MAX(CASE WHEN function_name='run_command_line' THEN args_preview_json END),
                    MAX(CASE WHEN function_name='run_command_line' THEN result_preview_json END)
                 FROM imported_replay_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("compact metadata rows");
        assert!(edit_args.len() < 20 * 1024);
        assert!(edit_args.contains("src/large.rs"));
        assert!(git_args.len() < 100 * 1024);
        assert!(git_result.contains("_replayGitArtifacts"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cross_line_tool_result_updates_the_stable_call_without_cursor_payload() {
        let source = ImportedHistorySourceId::Omp;
        let call = json!({
            "type":"assistant", "timestamp":"2026-07-22T00:00:00Z",
            "message":{"role":"assistant","content":[{
                "type":"tool_use","id":"call-1","name":"bash","input":{"command":"pwd"}
            }]}
        });
        let result = json!({
            "type":"user", "timestamp":"2026-07-22T00:00:01Z",
            "message":{"role":"user","content":[{
                "type":"tool_result","tool_use_id":"call-1","content":"/repo"
            }]}
        });
        let path = std::env::temp_dir().join(format!(
            "orgii-omp-tool-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(&path, format!("{call}\n")).expect("tool call fixture");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        let cold = {
            let tx = conn.transaction().expect("cold transaction");
            let outcome = sync(
                &tx,
                source,
                "ompapp-tool-fixture",
                "tool-fixture",
                &path,
                "generation-1",
                1,
                None,
                "sample-1",
            )
            .expect("index tool call");
            tx.commit().expect("commit tool call");
            outcome
        };
        let event_before: (String, String) = conn
            .query_row(
                "SELECT event_id, result_preview_json FROM imported_replay_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("pending tool event");
        assert!(!event_before.1.contains("/repo"));

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append result");
        writeln!(file, "{result}").expect("write tool result");
        drop(file);
        let state = state_from(&cold, source);
        let completed = {
            let tx = conn.transaction().expect("result transaction");
            let outcome = sync(
                &tx,
                source,
                "ompapp-tool-fixture",
                "tool-fixture",
                &path,
                "generation-1",
                2,
                Some(&state),
                "sample-2",
            )
            .expect("index tool result");
            tx.commit().expect("commit tool result");
            outcome
        };
        let event_after: (String, String) = conn
            .query_row(
                "SELECT event_id, result_preview_json FROM imported_replay_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("completed tool event");
        assert_eq!(event_after.0, event_before.0);
        assert!(event_after.1.contains("/repo"));
        assert_eq!(completed.total_events, 1);
        assert!(!completed.driver_cursor_json.contains("/repo"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ten_mib_single_line_keeps_only_preview_locator_and_compact_cursor() {
        let source = ImportedHistorySourceId::ClaudeCode;
        let session_id = "claudecodeapp-ten-mib-fixture";
        let source_session_id = "ten-mib-fixture";
        let body = "x".repeat(10 * 1024 * 1024);
        let line = json!({
            "type":"assistant", "timestamp":"2026-07-22T00:00:00Z",
            "message":{"role":"assistant","content":[{"type":"text","text":body}]}
        });
        let path = std::env::temp_dir().join(format!(
            "orgii-claude-ten-mib-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(&path, format!("{line}\n")).expect("10 MiB fixture");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                path.to_string_lossy()
            ],
        )
        .expect("cache 10 MiB source");

        let opened = super::super::open_window(
            &mut conn,
            source,
            session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open 10 MiB bounded replay");
        assert_eq!(opened.chunks.len(), 1);
        assert!(opened.stats.parsed_bytes >= 10 * 1024 * 1024);
        assert!(serde_json::to_vec(&opened.chunks[0].chunk).unwrap().len() < 20 * 1024);
        assert_eq!(opened.chunks[0].payloads[0].total_bytes, 10 * 1024 * 1024);
        let cursor_json: String = conn
            .query_row(
                "SELECT driver_cursor_json FROM imported_replay_state
                 WHERE source=?1 AND source_session_id=?2",
                params![source.as_str(), source_session_id],
                |row| row.get(0),
            )
            .expect("compact cursor");
        assert!(cursor_json.len() < 64 * 1024);
        assert!(!cursor_json.contains(&"x".repeat(1024)));

        let unchanged = super::super::poll_delta(
            &mut conn,
            source,
            session_id,
            &opened.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("unchanged 10 MiB poll");
        assert_eq!(unchanged.stats.parsed_bytes, 0);
        assert_eq!(unchanged.stats.parsed_rows, 0);
        assert!(unchanged.chunks.is_empty());
        let _ = fs::remove_file(path);
    }
}
