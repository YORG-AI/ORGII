//! Bounded replay adapters for structured SQLite stores.
//!
//! Cursor CLI stores an append-oriented message manifest backed by content
//! addressed blobs. Warp stores mutable protobuf task rows. They share the
//! ORGII compact replay tables, but deliberately do not share a fake rowid
//! cursor: their lineage and reconciliation rules are different.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use core_types::activity::ActivityChunk;
use prost_reflect::{DescriptorPool, DynamicMessage};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(test)]
thread_local! {
    static PAYLOAD_FALLBACK_DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

use crate::development_artifact::{
    attach_replay_git_artifacts, parse_git_artifacts_from_tool_payload,
};
use crate::sources::imported_history::{self, ImportedToolCall};

use crate::sources::imported_history::replay::index::ReplayIndexState;
use crate::sources::imported_history::replay::payload_artifact;
mod common;
mod cursor_cli;
mod warp;

pub(in crate::sources::imported_history::replay) use common::range_from_text;
use common::{
    camel_to_snake, chunk_field_text, field, field_str, hash_parts, head_preview, hex_decode,
    hex_encode, open_source_db, parse_warp_timestamp_ms, stable_event_id, timestamp_value_to_iso,
    value_at_path_mut, Hash64,
};
use cursor_cli::*;
use warp::*;

use crate::sources::imported_history::replay::{
    replay_payload_body_projection, ImportedHistorySourceId, ReplayPayloadBodyProjection,
    ReplayPayloadDescriptor, ReplayPayloadEncoding, ReplayPayloadKind, ReplayPayloadRange,
    ReplayStats, NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

const CURSOR_PROVIDER: &str = "cursorcli";
const WARP_PROVIDER: &str = "warp";
const WARP_TASK_PROTO_NAME: &str = "warp.multi_agent.v1.Task";
const WARP_FILE_DESCRIPTOR_SET: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../proto/warp_multi_agent_v1.descriptor.pb"
));

static WARP_DESCRIPTOR_POOL: LazyLock<Result<DescriptorPool, String>> = LazyLock::new(|| {
    DescriptorPool::decode(WARP_FILE_DESCRIPTOR_SET)
        .map_err(|err| format!("load Warp protobuf descriptor: {err}"))
});

#[derive(Debug, Clone)]
pub(in crate::sources::imported_history::replay) struct StructuredSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub total_events: u64,
    pub total_turns: u64,
    pub changed: bool,
    pub removed_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct CursorCliReplayCursor {
    schema_version: i64,
    driver: String,
    root_blob_id: String,
    message_count: u64,
    manifest_prefix_hash: String,
    cursor_turn_index: i64,
    last_user_text: Option<String>,
    pending_cursor_calls: HashMap<String, PendingCursorCall>,
    // Warp logical row summary.
    source_row_count: u64,
    source_signal: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct WarpReplayCursor {
    schema_version: i64,
    driver: String,
    root_blob_id: String,
    message_count: u64,
    manifest_prefix_hash: String,
    cursor_turn_index: i64,
    last_user_text: Option<String>,
    pending_cursor_calls: HashMap<String, PendingCursorCall>,
    source_row_count: u64,
    source_signal: String,
}

#[derive(Debug, Deserialize)]
struct StructuredCursorVersion {
    schema_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingCursorCall {
    call_blob_id: String,
    item_index: usize,
    manifest_ordinal: u64,
    event_id: String,
    turn_index: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CursorMeta {
    latest_root_blob_id: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "driver", rename_all = "snake_case")]
enum StructuredPayloadLocator {
    Cursor {
        call_blob_id: String,
        result_blob_id: Option<String>,
        item_index: usize,
        result_item_index: Option<usize>,
        event_kind: CursorEventKind,
        segment_index: usize,
    },
    Warp {
        task_row_id: String,
        task_id: String,
        local_event_index: usize,
        fallback_ms: i64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CursorEventKind {
    User,
    AssistantVisible,
    Thinking,
    Tool,
}

#[derive(Debug)]
struct EmittedChunk {
    event_key: String,
    turn_index: i64,
    chunk: ActivityChunk,
    locator: StructuredPayloadLocator,
}

#[derive(Debug)]
struct DeferredPayloadBody {
    field_path: String,
    text: String,
}

#[derive(Debug)]
struct WarpSummary {
    row_count: u64,
    signal: String,
    fallback_ms: i64,
}

pub(in crate::sources::imported_history::replay) fn cursor_schema_version(
    cursor_json: &str,
) -> Option<i64> {
    serde_json::from_str::<StructuredCursorVersion>(cursor_json)
        .ok()
        .map(|cursor| cursor.schema_version)
}

pub(in crate::sources::imported_history::replay) fn database_schema_version(
    path: &Path,
) -> Result<i64, String> {
    let conn = open_source_db(path)?;
    conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
        .map_err(|err| format!("read structured replay schema version: {err}"))
}

/// Cursor roots are immutable content-addressed blobs. A new root is an
/// append only when every previously indexed message id remains an identical
/// prefix. Forks, reordered roots and root replacement return `false`, which
/// makes the replay coordinator publish a new generation atomically.
pub(in crate::sources::imported_history::replay) fn cursor_lineage_matches(
    path: &Path,
    cursor_json: &str,
) -> Result<bool, String> {
    let cursor = serde_json::from_str::<CursorCliReplayCursor>(cursor_json)
        .map_err(|err| format!("decode Cursor CLI replay cursor: {err}"))?;
    if cursor.driver != "cursor_cli" || cursor.message_count == 0 {
        return Ok(true);
    }
    let conn = open_source_db(path)?;
    let meta = read_cursor_meta(&conn)?;
    if meta.latest_root_blob_id == cursor.root_blob_id {
        return Ok(true);
    }
    let root = read_blob(&conn, &meta.latest_root_blob_id)?
        .ok_or_else(|| "Cursor CLI root blob is missing".to_string())?;
    let (count, prefix_hash) = manifest_prefix_hash(&root, cursor.message_count)?;
    Ok(count >= cursor.message_count && prefix_hash == cursor.manifest_prefix_hash)
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
    previous_state: Option<&ReplayIndexState>,
) -> Result<StructuredSyncOutcome, String> {
    ensure_structured_tables(tx)?;
    match source {
        ImportedHistorySourceId::CursorCli => sync_cursor_cli(
            tx,
            display_session_id,
            source_session_id,
            source_path,
            generation,
            write_revision,
            previous_state,
        ),
        ImportedHistorySourceId::Warp => sync_warp(
            tx,
            display_session_id,
            source_session_id,
            source_path,
            generation,
            write_revision,
            previous_state,
        ),
        _ => Err(format!(
            "{} is not a structured replay adapter",
            source.as_str()
        )),
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn reconcile_structured_row(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    row_id: &str,
    task_id: &str,
    chunks: Vec<ActivityChunk>,
    fallback_ms: i64,
    stats: &mut ReplayStats,
    removed_event_ids: &mut Vec<String>,
) -> Result<(), String> {
    let mut previous = HashMap::<String, (String, i64)>::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT local_key,event_id,sequence FROM imported_replay_structured_events
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
            )
            .map_err(|err| format!("prepare prior Warp replay events: {err}"))?;
        let mut rows = stmt
            .query(params![
                source.as_str(),
                source_session_id,
                generation,
                row_id
            ])
            .map_err(|err| format!("query prior Warp replay events: {err}"))?;
        while let Some(row) = rows.next().map_err(|err| err.to_string())? {
            previous.insert(
                row.get::<_, String>(0).map_err(|err| err.to_string())?,
                (
                    row.get::<_, String>(1).map_err(|err| err.to_string())?,
                    row.get::<_, i64>(2).map_err(|err| err.to_string())?,
                ),
            );
        }
    }
    let mut seen = HashSet::new();
    for (local_event_index, chunk) in chunks.into_iter().enumerate() {
        let local_key = format!("event:{local_event_index}");
        seen.insert(local_key.clone());
        let sequence = previous
            .get(&local_key)
            .map(|(_, sequence)| *sequence)
            .unwrap_or(next_sequence(tx, source, source_session_id, generation)?);
        let event_id = stable_event_id(
            source,
            source_session_id,
            &format!("task-row:{row_id}:{local_key}"),
        );
        if let Some((old_event_id, _)) = previous.get(&local_key) {
            if old_event_id != &event_id {
                delete_event(tx, source, source_session_id, generation, old_event_id)?;
                removed_event_ids.push(old_event_id.clone());
            }
        }
        let emitted = EmittedChunk {
            event_key: format!("task-row:{row_id}:{local_key}"),
            turn_index: 0,
            chunk,
            locator: StructuredPayloadLocator::Warp {
                task_row_id: row_id.to_string(),
                task_id: task_id.to_string(),
                local_event_index,
                fallback_ms,
            },
        };
        upsert_emitted_at_sequence(
            tx,
            source,
            source_session_id,
            generation,
            write_revision,
            sequence,
            event_id.clone(),
            emitted,
            stats,
        )?;
        tx.execute(
            "INSERT INTO imported_replay_structured_events(
                 source,source_session_id,generation,source_key,local_key,event_id,sequence
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(source,source_session_id,generation,source_key,local_key) DO UPDATE SET
                 event_id=excluded.event_id,sequence=excluded.sequence",
            params![
                source.as_str(),
                source_session_id,
                generation,
                row_id,
                local_key,
                event_id,
                sequence
            ],
        )
        .map_err(|err| format!("publish Warp replay event mapping: {err}"))?;
    }
    for (local_key, (event_id, _)) in previous {
        if seen.contains(&local_key) {
            continue;
        }
        delete_event(tx, source, source_session_id, generation, &event_id)?;
        tx.execute(
            "DELETE FROM imported_replay_structured_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND source_key=?4 AND local_key=?5",
            params![
                source.as_str(),
                source_session_id,
                generation,
                row_id,
                local_key
            ],
        )
        .map_err(|err| format!("delete stale Warp event mapping: {err}"))?;
        removed_event_ids.push(event_id);
    }
    Ok(())
}

fn remove_missing_structured_rows(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    removed_event_ids: &mut Vec<String>,
) -> Result<bool, String> {
    let mut missing = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT source_key FROM imported_replay_structured_rows r
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3
                   AND NOT EXISTS (
                     SELECT 1 FROM imported_structured_seen_rows s WHERE s.source_key=r.source_key
                   )",
            )
            .map_err(|err| format!("prepare deleted structured rows: {err}"))?;
        let mut rows = stmt
            .query(params![source.as_str(), source_session_id, generation])
            .map_err(|err| format!("query deleted structured rows: {err}"))?;
        while let Some(row) = rows.next().map_err(|err| err.to_string())? {
            missing.push(row.get::<_, String>(0).map_err(|err| err.to_string())?);
        }
    }
    for source_key in &missing {
        let mut event_ids = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT event_id FROM imported_replay_structured_events
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
                )
                .map_err(|err| format!("prepare deleted structured events: {err}"))?;
            let mut rows = stmt
                .query(params![
                    source.as_str(),
                    source_session_id,
                    generation,
                    source_key
                ])
                .map_err(|err| format!("query deleted structured events: {err}"))?;
            while let Some(row) = rows.next().map_err(|err| err.to_string())? {
                event_ids.push(row.get::<_, String>(0).map_err(|err| err.to_string())?);
            }
        }
        for event_id in event_ids {
            delete_event(tx, source, source_session_id, generation, &event_id)?;
            removed_event_ids.push(event_id);
        }
        tx.execute(
            "DELETE FROM imported_replay_structured_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
            params![source.as_str(), source_session_id, generation, source_key],
        )
        .map_err(|err| format!("delete structured event mappings: {err}"))?;
        tx.execute(
            "DELETE FROM imported_replay_structured_rows
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
            params![source.as_str(), source_session_id, generation, source_key],
        )
        .map_err(|err| format!("delete structured row hash: {err}"))?;
    }
    Ok(!missing.is_empty())
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
        .map_err(|err| format!("decode structured payload locators: {err}"))?;
    let payload = payloads
        .iter()
        .find(|payload| payload.field_path == field_path)
        .ok_or_else(|| "Replay payload field is not range-backed".to_string())?;
    let locator: StructuredPayloadLocator = serde_json::from_str(
        payload
            .source_key
            .as_deref()
            .ok_or_else(|| "Structured replay payload has no locator".to_string())?,
    )
    .map_err(|err| format!("decode structured replay locator: {err}"))?;
    let conn = open_source_db(source_path)?;
    let chunk = match (&locator, source) {
        (StructuredPayloadLocator::Cursor { .. }, ImportedHistorySourceId::CursorCli) => {
            reconstruct_cursor_chunk(&conn, event_id, &locator)?
        }
        (
            StructuredPayloadLocator::Warp {
                task_row_id,
                task_id,
                local_event_index,
                fallback_ms,
            },
            ImportedHistorySourceId::Warp,
        ) => {
            let blob = conn
                .query_row(
                    "SELECT task FROM agent_tasks
                     WHERE CAST(id AS TEXT)=?1 AND task_id=?2 LIMIT 1",
                    params![task_row_id, task_id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()
                .map_err(|err| format!("read Warp payload task: {err}"))?
                .ok_or_else(|| "Warp payload task no longer exists".to_string())?;
            normalize_warp_task("warpapp-payload", &blob, *fallback_ms)?
                .into_iter()
                .nth(*local_event_index)
                .ok_or_else(|| "Warp payload event no longer exists".to_string())?
        }
        _ => return Err("Structured replay payload/source mismatch".to_string()),
    };
    let text = chunk_field_text(&chunk, field_path)?;
    range_from_text(event_id, field_path, &text, offset, max_bytes)
}

#[cfg(test)]
pub(in crate::sources::imported_history::replay) fn reset_payload_fallback_decodes() {
    PAYLOAD_FALLBACK_DECODES.with(|count| count.set(0));
}

#[cfg(test)]
pub(in crate::sources::imported_history::replay) fn payload_fallback_decodes() -> usize {
    PAYLOAD_FALLBACK_DECODES.with(std::cell::Cell::get)
}

fn upsert_emitted(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    emitted: EmittedChunk,
    stats: &mut ReplayStats,
) -> Result<(), String> {
    let event_id = if emitted.chunk.chunk_id.trim().is_empty() {
        stable_event_id(source, source_session_id, &emitted.event_key)
    } else {
        // Imported chunk builders create ids from transient ordinals. Only a
        // previously persisted tool-call id is authoritative here.
        let expected = stable_event_id(source, source_session_id, &emitted.event_key);
        if emitted.chunk.chunk_id.starts_with("replay-") {
            emitted.chunk.chunk_id.clone()
        } else {
            expected
        }
    };
    let sequence = tx
        .query_row(
            "SELECT sequence FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![source.as_str(), source_session_id, generation, event_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("resolve structured replay sequence: {err}"))?
        .unwrap_or(next_sequence(tx, source, source_session_id, generation)?);
    upsert_emitted_at_sequence(
        tx,
        source,
        source_session_id,
        generation,
        write_revision,
        sequence,
        event_id,
        emitted,
        stats,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn upsert_emitted_at_sequence(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    sequence: i64,
    event_id: String,
    mut emitted: EmittedChunk,
    stats: &mut ReplayStats,
) -> Result<(), String> {
    emitted.chunk.chunk_id = event_id.clone();
    let content_hash = hash_parts(&[serde_json::to_string(&emitted.chunk)
        .unwrap_or_default()
        .as_bytes()]);
    let previous_hash = tx
        .query_row(
            "SELECT content_hash FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![source.as_str(), source_session_id, generation, event_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read structured replay event hash: {err}"))?;
    if previous_hash.as_deref() == Some(content_hash.as_str()) {
        return Ok(());
    }
    let locator_json = serde_json::to_string(&emitted.locator)
        .map_err(|err| format!("encode structured payload locator: {err}"))?;
    payload_artifact::delete_event_refs(tx, source, source_session_id, generation, &event_id)?;
    let (payloads, deferred_bodies) = compact_chunk_with_bodies(&mut emitted.chunk, &locator_json);
    let args_json = serde_json::to_string(&emitted.chunk.args)
        .map_err(|err| format!("encode structured replay args: {err}"))?;
    let result_json = serde_json::to_string(&emitted.chunk.result)
        .map_err(|err| format!("encode structured replay result: {err}"))?;
    let payloads_json = serde_json::to_string(&payloads)
        .map_err(|err| format!("encode structured payload descriptors: {err}"))?;
    tx.execute(
        "INSERT INTO imported_replay_events(
             source,source_session_id,generation,sequence,event_id,turn_index,
             action_type,function_name,created_at,args_preview_json,result_preview_json,
             args_size_bytes,result_size_bytes,thread_id,process_id,source_start,source_end,
             payloads_json,content_hash,event_revision
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,0,0,?16,?17,?18)
         ON CONFLICT(source,source_session_id,generation,event_id) DO UPDATE SET
             turn_index=excluded.turn_index,action_type=excluded.action_type,
             function_name=excluded.function_name,created_at=excluded.created_at,
             args_preview_json=excluded.args_preview_json,result_preview_json=excluded.result_preview_json,
             args_size_bytes=excluded.args_size_bytes,result_size_bytes=excluded.result_size_bytes,
             thread_id=excluded.thread_id,process_id=excluded.process_id,
             payloads_json=excluded.payloads_json,content_hash=excluded.content_hash,
             event_revision=excluded.event_revision",
        params![
            source.as_str(),
            source_session_id,
            generation,
            sequence,
            event_id,
            emitted.turn_index,
            emitted.chunk.action_type,
            emitted.chunk.function,
            emitted.chunk.created_at,
            args_json,
            result_json,
            emitted.chunk.args.to_string().len() as i64,
            emitted.chunk.result.to_string().len() as i64,
            emitted.chunk.thread_id,
            emitted.chunk.process_id,
            payloads_json,
            content_hash,
            write_revision.min(i64::MAX as u64) as i64,
        ],
    )
    .map_err(|err| format!("upsert structured replay event: {err}"))?;
    for body in deferred_bodies {
        payload_artifact::store_text(
            tx,
            source,
            source_session_id,
            generation,
            &event_id,
            &body.field_path,
            &body.text,
        )?;
    }
    stats.normalized_events = stats.normalized_events.saturating_add(1);
    stats.upserted_events = stats.upserted_events.saturating_add(1);
    Ok(())
}

pub(in crate::sources::imported_history::replay) fn compact_chunk(
    chunk: &mut ActivityChunk,
    locator_json: &str,
) -> Vec<ReplayPayloadDescriptor> {
    compact_chunk_with_bodies(chunk, locator_json).0
}

fn compact_chunk_with_bodies(
    chunk: &mut ActivityChunk,
    locator_json: &str,
) -> (Vec<ReplayPayloadDescriptor>, Vec<DeferredPayloadBody>) {
    let mut payloads = Vec::new();
    let mut deferred_bodies = Vec::new();
    // Metadata projection runs over the compact rows, not the source-backed
    // payload. Preserve the cheap scalar edit summary and extract Git data
    // before any large args/result field is replaced by a preview.
    let edit_summary_will_change = compact_edit_line_summary_will_change(chunk);
    let mut exact_result_body = edit_summary_will_change
        .then(|| serde_json::to_string(&chunk.result).unwrap_or_else(|_| "null".to_string()));
    attach_compact_edit_line_summary(chunk);
    let git_artifacts = if chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE {
        let args = serde_json::to_string(&chunk.args).unwrap_or_else(|_| "null".to_string());
        let result = serde_json::to_string(&chunk.result).unwrap_or_else(|_| "null".to_string());
        let artifacts = parse_git_artifacts_from_tool_payload(&args, &result);
        if !artifacts.is_empty() {
            exact_result_body = Some(result);
        }
        artifacts
    } else {
        Vec::new()
    };
    let result_limit = if chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    let result_body_projection = exact_result_body.as_deref().and_then(|encoded| {
        replay_payload_body_projection(
            "result",
            &chunk.result,
            Some(encoded),
            result_limit,
            chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE,
        )
    });
    let fields: &[(&str, ReplayPayloadKind)] = match chunk.function.as_str() {
        imported_history::FUNCTION_USER_MESSAGE => {
            &[("result.message.content", ReplayPayloadKind::UserMessage)]
        }
        imported_history::FUNCTION_ASSISTANT => &[
            ("result.content", ReplayPayloadKind::AssistantContent),
            ("result.observation", ReplayPayloadKind::AssistantContent),
        ],
        imported_history::FUNCTION_THINKING => &[
            ("result.thought", ReplayPayloadKind::Reasoning),
            ("result.content", ReplayPayloadKind::Reasoning),
            ("result.observation", ReplayPayloadKind::Reasoning),
        ],
        _ => &[
            ("result.output", ReplayPayloadKind::ToolOutput),
            ("result.observation", ReplayPayloadKind::ToolOutput),
            ("result.old_content", ReplayPayloadKind::ToolDiff),
            ("result.new_content", ReplayPayloadKind::ToolDiff),
        ],
    };
    for &(path, kind) in fields {
        let Some(text) = value_at_path_mut(&mut chunk.result, path.trim_start_matches("result."))
        else {
            continue;
        };
        if text.len() > result_limit {
            let total_bytes = text.len() as u64;
            let full_text = std::mem::take(text);
            *text = head_preview(&full_text, result_limit);
            payloads.push(payload_descriptor(
                path,
                kind,
                ReplayPayloadEncoding::Utf8Text,
                None,
                locator_json,
                total_bytes,
            ));
            deferred_bodies.push(DeferredPayloadBody {
                field_path: path.to_string(),
                text: full_text,
            });
        }
    }
    let encoded_args = serde_json::to_string(&chunk.args).unwrap_or_default();
    let args_size = encoded_args.len();
    let args_limit = if chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    if args_size > args_limit {
        let args_body_projection = replay_payload_body_projection(
            "args",
            &chunk.args,
            Some(&encoded_args),
            args_limit,
            false,
        );
        let mut original = std::mem::take(&mut chunk.args);
        let mut preview = serde_json::Map::new();
        preview.insert("_replayTruncated".to_string(), Value::Bool(true));
        for key in [
            "command",
            "cmd",
            "path",
            "file_path",
            "filePath",
            "action",
            "query",
            "pattern",
            "linesAdded",
            "linesRemoved",
            "operation",
        ] {
            let Some(value) = original.get_mut(key) else {
                continue;
            };
            if let Value::String(text) = value {
                if text.len() > args_limit {
                    let full_text = std::mem::take(text);
                    preview.insert(
                        key.to_string(),
                        Value::String(head_preview(&full_text, args_limit)),
                    );
                } else {
                    preview.insert(key.to_string(), Value::String(text.clone()));
                }
            } else if value.is_number() || value.is_boolean() || value.is_null() {
                preview.insert(key.to_string(), value.clone());
            }
        }
        if preview.len() == 1 {
            preview.insert(
                "_preview".to_string(),
                Value::String(head_preview(&encoded_args, args_limit)),
            );
        }
        chunk.args = Value::Object(preview);
        // A semantic preview is necessarily incomplete even when it retained
        // one or more recognized scalars (for example `path`). Use one root
        // body so hydration/export atomically restores every omitted sibling
        // and removes compact-only markers. Nested descriptors would conflict
        // with that root replacement and are deliberately discarded.
        payloads.retain(|payload| !field_path_is_under(&payload.field_path, "args"));
        deferred_bodies.retain(|body| !field_path_is_under(&body.field_path, "args"));
        payloads.push(payload_descriptor(
            "args",
            ReplayPayloadKind::ToolArguments,
            ReplayPayloadEncoding::JsonValue,
            args_body_projection,
            locator_json,
            args_size as u64,
        ));
        deferred_bodies.push(DeferredPayloadBody {
            field_path: "args".to_string(),
            text: encoded_args,
        });
    }
    attach_replay_git_artifacts(&mut chunk.result, &git_artifacts);
    if let Some(exact_result_body) = exact_result_body {
        // Derived edit counts and `_replayGitArtifacts` stay in the compact
        // row for metadata projection, but were never provider result fields.
        // A canonical root result makes compatibility hydration/export exact.
        payloads.retain(|payload| !field_path_is_under(&payload.field_path, "result"));
        deferred_bodies.retain(|body| !field_path_is_under(&body.field_path, "result"));
        payloads.push(payload_descriptor(
            "result",
            ReplayPayloadKind::ToolOutput,
            ReplayPayloadEncoding::JsonValue,
            result_body_projection,
            locator_json,
            exact_result_body.len() as u64,
        ));
        deferred_bodies.push(DeferredPayloadBody {
            field_path: "result".to_string(),
            text: exact_result_body,
        });
    }
    (payloads, deferred_bodies)
}

fn field_path_is_under(field_path: &str, root: &str) -> bool {
    field_path == root
        || field_path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn compact_edit_line_summary_will_change(chunk: &ActivityChunk) -> bool {
    if chunk.function != imported_history::FUNCTION_EDIT_FILE {
        return false;
    }
    let Some(result) = chunk.result.as_object() else {
        return false;
    };
    let scalar = |key: &str| chunk.args.get(key).and_then(Value::as_u64);
    let line_count = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| chunk.args.get(*key).and_then(Value::as_str))
            .map(|text| {
                if text.is_empty() {
                    0
                } else {
                    text.lines().count() as u64
                }
            })
    };
    let additions = scalar("linesAdded")
        .or_else(|| line_count(&["new_string", "content", "insert_text", "file_text"]));
    let removals = scalar("linesRemoved").or_else(|| line_count(&["old_string", "old_str"]));
    (additions.is_some() && !result.contains_key("linesAdded"))
        || (removals.is_some() && !result.contains_key("linesRemoved"))
}

fn attach_compact_edit_line_summary(chunk: &mut ActivityChunk) {
    if chunk.function != imported_history::FUNCTION_EDIT_FILE {
        return;
    }
    let scalar = |key: &str| chunk.args.get(key).and_then(Value::as_u64);
    let line_count = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| chunk.args.get(*key).and_then(Value::as_str))
            .map(|text| {
                if text.is_empty() {
                    0
                } else {
                    text.lines().count() as u64
                }
            })
    };
    let additions = scalar("linesAdded")
        .or_else(|| line_count(&["new_string", "content", "insert_text", "file_text"]));
    let removals = scalar("linesRemoved").or_else(|| line_count(&["old_string", "old_str"]));
    let Some(result) = chunk.result.as_object_mut() else {
        return;
    };
    if let Some(additions) = additions {
        result
            .entry("linesAdded".to_string())
            .or_insert_with(|| json!(additions));
    }
    if let Some(removals) = removals {
        result
            .entry("linesRemoved".to_string())
            .or_insert_with(|| json!(removals));
    }
}

fn payload_descriptor(
    field_path: &str,
    kind: ReplayPayloadKind,
    encoding: ReplayPayloadEncoding,
    body_projection: Option<ReplayPayloadBodyProjection>,
    locator_json: &str,
    total_bytes: u64,
) -> ReplayPayloadDescriptor {
    ReplayPayloadDescriptor {
        field_path: field_path.to_string(),
        kind,
        encoding,
        body_projection,
        spans: Vec::new(),
        total_bytes,
        source_ordinal: None,
        source_key: Some(locator_json.to_string()),
    }
}

pub(in crate::sources::imported_history::replay) fn rebuild_turns(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_turns
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("clear structured replay turns: {err}"))?;
    let mut stmt = tx
        .prepare(
            "SELECT sequence,event_id,function_name,created_at FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 ORDER BY sequence ASC",
        )
        .map_err(|err| format!("prepare structured replay turn fold: {err}"))?;
    let mut rows = stmt
        .query(params![source.as_str(), source_session_id, generation])
        .map_err(|err| format!("query structured replay turn fold: {err}"))?;
    let mut turn_index = -1_i64;
    let mut current: Option<(String, i64, i64, String, String, u64)> = None;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let sequence: i64 = row.get(0).map_err(|err| err.to_string())?;
        let event_id: String = row.get(1).map_err(|err| err.to_string())?;
        let function: String = row.get(2).map_err(|err| err.to_string())?;
        let created_at: String = row.get(3).map_err(|err| err.to_string())?;
        if function == imported_history::FUNCTION_USER_MESSAGE || current.is_none() {
            if let Some(turn) = current.take() {
                insert_turn(tx, source, source_session_id, generation, turn_index, turn)?;
            }
            turn_index = turn_index.saturating_add(1).max(0);
            current = Some((
                event_id,
                sequence,
                sequence,
                created_at.clone(),
                created_at,
                1,
            ));
        } else if let Some(turn) = current.as_mut() {
            turn.2 = sequence;
            turn.4 = created_at;
            turn.5 = turn.5.saturating_add(1);
        }
        tx.execute(
            "UPDATE imported_replay_events SET turn_index=?1
             WHERE source=?2 AND source_session_id=?3 AND generation=?4 AND sequence=?5",
            params![
                turn_index.max(0),
                source.as_str(),
                source_session_id,
                generation,
                sequence
            ],
        )
        .map_err(|err| format!("assign structured replay turn: {err}"))?;
    }
    drop(rows);
    drop(stmt);
    if let Some(turn) = current {
        insert_turn(
            tx,
            source,
            source_session_id,
            generation,
            turn_index.max(0),
            turn,
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
    turn: (String, i64, i64, String, String, u64),
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO imported_replay_turns(
             source,source_session_id,generation,turn_index,turn_id,start_sequence,end_sequence,
             started_at,ended_at,event_count
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            source.as_str(),
            source_session_id,
            generation,
            turn_index,
            turn.0,
            turn.1,
            turn.2,
            turn.3,
            turn.4,
            turn.5 as i64
        ],
    )
    .map(|_| ())
    .map_err(|err| format!("insert structured replay turn: {err}"))
}

fn ensure_structured_tables(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS imported_replay_structured_rows(
             source TEXT NOT NULL,source_session_id TEXT NOT NULL,generation TEXT NOT NULL,
             source_key TEXT NOT NULL,content_hash TEXT NOT NULL,seen_revision INTEGER NOT NULL,
             PRIMARY KEY(source,source_session_id,generation,source_key)
         );
         CREATE TABLE IF NOT EXISTS imported_replay_structured_events(
             source TEXT NOT NULL,source_session_id TEXT NOT NULL,generation TEXT NOT NULL,
             source_key TEXT NOT NULL,local_key TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,
             PRIMARY KEY(source,source_session_id,generation,source_key,local_key)
         );",
    )
    .map_err(|err| format!("create structured replay tables: {err}"))
}

fn unchanged_outcome<C: Serialize>(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    cursor: C,
) -> Result<StructuredSyncOutcome, String> {
    finish_outcome(
        tx,
        source,
        source_session_id,
        generation,
        cursor,
        ReplayStats::default(),
        false,
        Vec::new(),
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn finish_outcome<C: Serialize>(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    cursor: C,
    stats: ReplayStats,
    changed: bool,
    removed_event_ids: Vec<String>,
) -> Result<StructuredSyncOutcome, String> {
    Ok(StructuredSyncOutcome {
        driver_cursor_json: serde_json::to_string(&cursor)
            .map_err(|err| format!("encode structured replay cursor: {err}"))?,
        total_events: count_rows(
            tx,
            "imported_replay_events",
            source,
            source_session_id,
            generation,
        )?,
        total_turns: count_rows(
            tx,
            "imported_replay_turns",
            source,
            source_session_id,
            generation,
        )?,
        stats,
        changed,
        removed_event_ids,
    })
}

fn count_rows(
    tx: &Transaction<'_>,
    table: &str,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<u64, String> {
    tx.query_row(
        &format!(
            "SELECT COUNT(*) FROM {table} WHERE source=?1 AND source_session_id=?2 AND generation=?3"
        ),
        params![source.as_str(), source_session_id, generation],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as u64)
    .map_err(|err| format!("count structured replay {table}: {err}"))
}

fn next_sequence(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<i64, String> {
    tx.query_row(
        "SELECT COALESCE(MAX(sequence),-1)+1 FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
        |row| row.get(0),
    )
    .map_err(|err| format!("allocate structured replay sequence: {err}"))
}

fn delete_event(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
) -> Result<(), String> {
    payload_artifact::delete_event_refs(tx, source, source_session_id, generation, event_id)?;
    tx.execute(
        "DELETE FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
        params![source.as_str(), source_session_id, generation, event_id],
    )
    .map(|_| ())
    .map_err(|err| format!("delete structured replay event: {err}"))
}

#[cfg(test)]
#[path = "../../tests/structured_driver.rs"]
mod tests;
