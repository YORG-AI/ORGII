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

use super::index::ReplayIndexState;
use super::payload_artifact;
use super::{
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
pub(super) struct StructuredSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub total_events: u64,
    pub total_turns: u64,
    pub changed: bool,
    pub removed_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct StructuredCursor {
    schema_version: i64,
    driver: String,
    // Cursor CLI manifest lineage.
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

pub(super) fn cursor_schema_version(cursor_json: &str) -> Option<i64> {
    serde_json::from_str::<StructuredCursor>(cursor_json)
        .ok()
        .map(|cursor| cursor.schema_version)
}

pub(super) fn database_schema_version(path: &Path) -> Result<i64, String> {
    let conn = open_source_db(path)?;
    conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
        .map_err(|err| format!("read structured replay schema version: {err}"))
}

/// Cursor roots are immutable content-addressed blobs. A new root is an
/// append only when every previously indexed message id remains an identical
/// prefix. Forks, reordered roots and root replacement return `false`, which
/// makes the replay coordinator publish a new generation atomically.
pub(super) fn cursor_lineage_matches(path: &Path, cursor_json: &str) -> Result<bool, String> {
    let cursor = serde_json::from_str::<StructuredCursor>(cursor_json)
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

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
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

#[allow(clippy::too_many_arguments)]
fn sync_cursor_cli(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    previous_state: Option<&ReplayIndexState>,
) -> Result<StructuredSyncOutcome, String> {
    let source = ImportedHistorySourceId::CursorCli;
    let source_conn = open_source_db(source_path)?;
    validate_cursor_schema(&source_conn)?;
    let schema_version = source_conn
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("read Cursor CLI schema version: {err}"))?;
    let meta = read_cursor_meta(&source_conn)?;
    let mut cursor = previous_state
        .map(|state| serde_json::from_str::<StructuredCursor>(&state.driver_cursor_json))
        .transpose()
        .map_err(|err| format!("decode Cursor CLI replay cursor: {err}"))?
        .filter(|cursor| cursor.driver == "cursor_cli")
        .unwrap_or_else(|| StructuredCursor {
            schema_version,
            driver: "cursor_cli".to_string(),
            cursor_turn_index: -1,
            ..StructuredCursor::default()
        });

    // Content-addressed roots never mutate. This remains a true zero-parse,
    // zero-upsert poll even after the coordinator's 60 second integrity tick.
    if cursor.root_blob_id == meta.latest_root_blob_id && previous_state.is_some() {
        return unchanged_outcome(tx, source, source_session_id, generation, cursor);
    }

    let root = read_blob(&source_conn, &meta.latest_root_blob_id)?
        .ok_or_else(|| "Cursor CLI root blob is missing".to_string())?;
    if previous_state.is_some()
        && cursor.message_count > 0
        && cursor.root_blob_id != meta.latest_root_blob_id
    {
        let (current_count, current_prefix_hash) =
            manifest_prefix_hash(&root, cursor.message_count)?;
        if current_count < cursor.message_count
            || current_prefix_hash != cursor.manifest_prefix_hash
        {
            // The coordinator checked lineage before opening this source
            // snapshot. A concurrent fork/reorder must roll the ORGII index
            // transaction back and retry as a new generation, never append
            // the new suffix onto the old conversation.
            return Err("Cursor CLI replay lineage changed during synchronization".to_string());
        }
    }
    let created_at = imported_history::epoch_ms_to_iso(meta.created_at);
    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut message_count = 0_u64;
    let mut prefix_hash = Hash64::default();
    visit_manifest_message_ids(&root, |blob_id| {
        prefix_hash.update(blob_id.as_bytes());
        let ordinal = message_count;
        message_count = message_count.saturating_add(1);
        if ordinal < cursor.message_count {
            return Ok(());
        }
        let Some(data) = read_blob(&source_conn, blob_id)? else {
            return Ok(());
        };
        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(data.len() as u64);
        let Ok(message) = serde_json::from_slice::<Value>(&data) else {
            return Ok(());
        };
        let emitted = fold_cursor_message(
            display_session_id,
            source_session_id,
            blob_id,
            ordinal,
            &message,
            &created_at,
            &source_conn,
            &mut cursor,
        )?;
        for emitted in emitted {
            upsert_emitted(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                emitted,
                &mut stats,
            )?;
            changed = true;
        }
        Ok(())
    })?;

    cursor.schema_version = schema_version;
    cursor.driver = "cursor_cli".to_string();
    cursor.root_blob_id = meta.latest_root_blob_id;
    cursor.message_count = message_count;
    cursor.manifest_prefix_hash = prefix_hash.finish_hex();
    if changed {
        payload_artifact::delete_orphans(tx, source, source_session_id, generation)?;
        rebuild_turns(tx, source, source_session_id, generation)?;
    }
    finish_outcome(
        tx,
        source,
        source_session_id,
        generation,
        cursor,
        stats,
        changed,
        Vec::new(),
    )
}

#[allow(clippy::too_many_arguments)]
fn fold_cursor_message(
    display_session_id: &str,
    source_session_id: &str,
    blob_id: &str,
    manifest_ordinal: u64,
    message: &Value,
    created_at: &str,
    source_conn: &Connection,
    cursor: &mut StructuredCursor,
) -> Result<Vec<EmittedChunk>, String> {
    let mut emitted = Vec::new();
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            let text = cursor_message_text(message.get("content"));
            let Some(text) = clean_cursor_user_text(&text) else {
                return Ok(emitted);
            };
            if cursor.last_user_text.as_deref() == Some(text.as_str()) {
                return Ok(emitted);
            }
            cursor.last_user_text = Some(text.clone());
            cursor.cursor_turn_index = cursor.cursor_turn_index.saturating_add(1).max(0);
            let chunk = imported_history::user_message_chunk(
                display_session_id,
                CURSOR_PROVIDER,
                manifest_ordinal as usize,
                created_at,
                &text,
            );
            emitted.push(EmittedChunk {
                event_key: format!("message:{manifest_ordinal}:user"),
                turn_index: cursor.cursor_turn_index,
                chunk,
                locator: StructuredPayloadLocator::Cursor {
                    call_blob_id: blob_id.to_string(),
                    result_blob_id: None,
                    item_index: 0,
                    result_item_index: None,
                    event_kind: CursorEventKind::User,
                    segment_index: 0,
                },
            });
        }
        Some("assistant") => {
            for (item_index, item) in cursor_message_items(message.get("content")).enumerate() {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                        let (thoughts, visible) = split_think_blocks(text);
                        for (segment_index, thought) in thoughts.into_iter().enumerate() {
                            let chunk = imported_history::thinking_chunk(
                                display_session_id,
                                CURSOR_PROVIDER,
                                manifest_ordinal as usize,
                                created_at,
                                &thought,
                            );
                            emitted.push(EmittedChunk {
                                event_key: format!(
                                    "message:{manifest_ordinal}:item:{item_index}:thought:{segment_index}"
                                ),
                                turn_index: cursor.cursor_turn_index.max(0),
                                chunk,
                                locator: StructuredPayloadLocator::Cursor {
                                    call_blob_id: blob_id.to_string(),
                                    result_blob_id: None,
                                    item_index,
                                    result_item_index: None,
                                    event_kind: CursorEventKind::Thinking,
                                    segment_index,
                                },
                            });
                        }
                        let visible = visible.trim();
                        if !visible.is_empty() {
                            let chunk = imported_history::assistant_message_chunk(
                                display_session_id,
                                CURSOR_PROVIDER,
                                manifest_ordinal as usize,
                                created_at,
                                visible,
                            );
                            emitted.push(EmittedChunk {
                                event_key: format!(
                                    "message:{manifest_ordinal}:item:{item_index}:assistant"
                                ),
                                turn_index: cursor.cursor_turn_index.max(0),
                                chunk,
                                locator: StructuredPayloadLocator::Cursor {
                                    call_blob_id: blob_id.to_string(),
                                    result_blob_id: None,
                                    item_index,
                                    result_item_index: None,
                                    event_kind: CursorEventKind::AssistantVisible,
                                    segment_index: 0,
                                },
                            });
                        }
                    }
                    Some("tool-call") => {
                        let Some(call) = cursor_tool_call(item, created_at) else {
                            continue;
                        };
                        let event_id = stable_event_id(
                            ImportedHistorySourceId::CursorCli,
                            source_session_id,
                            &format!("call:{manifest_ordinal}:{}", call.call_id),
                        );
                        let chunk = imported_history::tool_call_chunk(
                            display_session_id,
                            CURSOR_PROVIDER,
                            manifest_ordinal as usize,
                            &call,
                            "",
                        );
                        emitted.push(EmittedChunk {
                            event_key: format!("call:{manifest_ordinal}:{}", call.call_id),
                            turn_index: cursor.cursor_turn_index.max(0),
                            chunk,
                            locator: StructuredPayloadLocator::Cursor {
                                call_blob_id: blob_id.to_string(),
                                result_blob_id: None,
                                item_index,
                                result_item_index: None,
                                event_kind: CursorEventKind::Tool,
                                segment_index: 0,
                            },
                        });
                        cursor.pending_cursor_calls.insert(
                            call.call_id.clone(),
                            PendingCursorCall {
                                call_blob_id: blob_id.to_string(),
                                item_index,
                                manifest_ordinal,
                                event_id,
                                turn_index: cursor.cursor_turn_index.max(0),
                            },
                        );
                    }
                    _ => {}
                }
            }
        }
        Some("tool") => {
            for (result_item_index, item) in
                cursor_message_items(message.get("content")).enumerate()
            {
                if item.get("type").and_then(Value::as_str) != Some("tool-result") {
                    continue;
                }
                let Some(call_id) = item.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(pending) = cursor.pending_cursor_calls.remove(call_id) else {
                    continue;
                };
                let Some(call_blob) = read_blob(source_conn, &pending.call_blob_id)? else {
                    continue;
                };
                let Ok(call_message) = serde_json::from_slice::<Value>(&call_blob) else {
                    continue;
                };
                let Some(call_item) =
                    cursor_message_items(call_message.get("content")).nth(pending.item_index)
                else {
                    continue;
                };
                let Some(call) = cursor_tool_call(call_item, created_at) else {
                    continue;
                };
                let output = cursor_tool_result_text(item.get("result"));
                let mut chunk = imported_history::tool_call_chunk(
                    display_session_id,
                    CURSOR_PROVIDER,
                    pending.manifest_ordinal as usize,
                    &call,
                    &output,
                );
                chunk.chunk_id = pending.event_id;
                emitted.push(EmittedChunk {
                    event_key: format!("call:{}:{call_id}", pending.manifest_ordinal),
                    turn_index: pending.turn_index,
                    chunk,
                    locator: StructuredPayloadLocator::Cursor {
                        call_blob_id: pending.call_blob_id,
                        result_blob_id: Some(blob_id.to_string()),
                        item_index: pending.item_index,
                        result_item_index: Some(result_item_index),
                        event_kind: CursorEventKind::Tool,
                        segment_index: 0,
                    },
                });
            }
        }
        _ => {}
    }
    Ok(emitted)
}

#[allow(clippy::too_many_arguments)]
fn sync_warp(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    previous_state: Option<&ReplayIndexState>,
) -> Result<StructuredSyncOutcome, String> {
    let source = ImportedHistorySourceId::Warp;
    let source_conn = open_source_db(source_path)?;
    validate_warp_schema(&source_conn)?;
    let schema_version = source_conn
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("read Warp schema version: {err}"))?;
    let summary = warp_summary(&source_conn, source_session_id, source_path)?;
    let previous_cursor = previous_state
        .map(|state| serde_json::from_str::<StructuredCursor>(&state.driver_cursor_json))
        .transpose()
        .map_err(|err| format!("decode Warp replay cursor: {err}"))?
        .filter(|cursor| cursor.driver == "warp")
        .unwrap_or_default();
    if previous_state.is_some()
        && previous_cursor.source_row_count == summary.row_count
        && previous_cursor.source_signal == summary.signal
    {
        return unchanged_outcome(tx, source, source_session_id, generation, previous_cursor);
    }

    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS imported_structured_seen_rows(
             source_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         DELETE FROM imported_structured_seen_rows;",
    )
    .map_err(|err| format!("prepare Warp replay seen rows: {err}"))?;

    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut removed_event_ids = Vec::new();
    let mut stmt = source_conn
        .prepare(
            "SELECT CAST(id AS TEXT), COALESCE(task_id, CAST(id AS TEXT)), task
             FROM agent_tasks WHERE conversation_id=?1 ORDER BY id ASC",
        )
        .map_err(|err| format!("prepare Warp task replay stream: {err}"))?;
    let mut rows = stmt
        .query([source_session_id])
        .map_err(|err| format!("query Warp task replay stream: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("stream Warp task replay row: {err}"))?
    {
        let row_id: String = row.get(0).map_err(|err| err.to_string())?;
        let task_id: String = row.get(1).map_err(|err| err.to_string())?;
        let blob: Vec<u8> = row.get(2).map_err(|err| err.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO imported_structured_seen_rows(source_key) VALUES (?1)",
            [&row_id],
        )
        .map_err(|err| format!("mark Warp replay row seen: {err}"))?;
        let content_hash = hash_parts(&[task_id.as_bytes(), &blob]);
        let previous_hash = tx
            .query_row(
                "SELECT content_hash FROM imported_replay_structured_rows
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
                params![source.as_str(), source_session_id, generation, row_id],
                |db_row| db_row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("read Warp replay row hash: {err}"))?;
        if previous_hash.as_deref() == Some(content_hash.as_str()) {
            continue;
        }

        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(blob.len() as u64);
        let chunks = normalize_warp_task(display_session_id, &blob, summary.fallback_ms)?;
        let upserts_before = stats.upserted_events;
        let removals_before = removed_event_ids.len();
        reconcile_structured_row(
            tx,
            source,
            source_session_id,
            generation,
            write_revision,
            &row_id,
            &task_id,
            chunks,
            summary.fallback_ms,
            &mut stats,
            &mut removed_event_ids,
        )?;
        tx.execute(
            "INSERT INTO imported_replay_structured_rows(
                 source,source_session_id,generation,source_key,content_hash,seen_revision
             ) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(source,source_session_id,generation,source_key) DO UPDATE SET
                 content_hash=excluded.content_hash,seen_revision=excluded.seen_revision",
            params![
                source.as_str(),
                source_session_id,
                generation,
                row_id,
                content_hash,
                write_revision.min(i64::MAX as u64) as i64
            ],
        )
        .map_err(|err| format!("publish Warp replay row hash: {err}"))?;
        changed |=
            stats.upserted_events > upserts_before || removed_event_ids.len() > removals_before;
    }

    let deleted = remove_missing_structured_rows(
        tx,
        source,
        source_session_id,
        generation,
        &mut removed_event_ids,
    )?;
    changed |= deleted;
    if changed {
        payload_artifact::delete_orphans(tx, source, source_session_id, generation)?;
        rebuild_turns(tx, source, source_session_id, generation)?;
    }
    stats.removed_events = removed_event_ids.len() as u64;
    let cursor = StructuredCursor {
        schema_version,
        driver: "warp".to_string(),
        source_row_count: summary.row_count,
        source_signal: summary.signal,
        ..StructuredCursor::default()
    };
    finish_outcome(
        tx,
        source,
        source_session_id,
        generation,
        cursor,
        stats,
        changed,
        removed_event_ids,
    )
}

#[allow(clippy::too_many_arguments)]
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

fn warp_summary(
    conn: &Connection,
    source_session_id: &str,
    source_path: &Path,
) -> Result<WarpSummary, String> {
    let (row_count, total_bytes, max_id, max_modified) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(task)),0),
                    COALESCE(MAX(id),0), COALESCE(MAX(CAST(last_modified_at AS TEXT)),'')
             FROM agent_tasks WHERE conversation_id=?1",
            [source_session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u64,
                    row.get::<_, i64>(1)?.max(0),
                    row.get::<_, i64>(2)?.max(0),
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|err| format!("summarize Warp task rows: {err}"))?;
    let conversation_modified = conn
        .query_row(
            "SELECT COALESCE(CAST(last_modified_at AS TEXT),'') FROM agent_conversations
             WHERE conversation_id=?1",
            [source_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read Warp conversation watermark: {err}"))?
        .unwrap_or_default();
    let fallback_ms = parse_warp_timestamp_ms(&conversation_modified).unwrap_or_default();
    let physical_signal = sqlite_physical_signal(source_path)?;
    Ok(WarpSummary {
        row_count,
        signal: format!(
            "{row_count}:{total_bytes}:{max_id}:{max_modified}:{conversation_modified}:{physical_signal}"
        ),
        fallback_ms,
    })
}

fn sqlite_physical_signal(path: &Path) -> Result<String, String> {
    let mut hash = Hash64::default();
    for candidate in [
        path.to_path_buf(),
        std::path::PathBuf::from(format!("{}-wal", path.to_string_lossy())),
    ] {
        hash.update(candidate.to_string_lossy().as_bytes());
        match std::fs::metadata(&candidate) {
            Ok(metadata) => {
                hash.update(&metadata.len().to_le_bytes());
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| {
                        duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64
                    })
                    .unwrap_or_default();
                hash.update(&modified.to_le_bytes());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => hash.update(b"missing"),
            Err(error) => {
                return Err(format!(
                    "stat Warp replay source {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    Ok(hash.finish_hex())
}

fn normalize_warp_task(
    session_id: &str,
    blob: &[u8],
    fallback_ms: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let task = decode_warp_task(blob)?;
    let fallback_created_at = imported_history::epoch_ms_to_iso(fallback_ms);
    let messages = field(&task, &["messages"])
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut tool_results = HashMap::new();
    for message in messages {
        let Some(result) = field(message, &["toolCallResult", "tool_call_result"]) else {
            continue;
        };
        if let Some(call_id) = field_str(result, &["toolCallId", "tool_call_id"]) {
            tool_results.insert(call_id.to_string(), result);
        }
    }
    let mut chunks = Vec::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let created_at = field(message, &["timestamp"])
            .and_then(timestamp_value_to_iso)
            .unwrap_or_else(|| fallback_created_at.clone());
        if let Some(user_query) = field(message, &["userQuery", "user_query"]) {
            if let Some(query) =
                field_str(user_query, &["query"]).filter(|text| !text.trim().is_empty())
            {
                chunks.push(imported_history::user_message_chunk(
                    session_id,
                    WARP_PROVIDER,
                    ordinal,
                    &created_at,
                    query.trim(),
                ));
            }
            continue;
        }
        if let Some(agent_output) = field(message, &["agentOutput", "agent_output"]) {
            if let Some(text) =
                field_str(agent_output, &["text"]).filter(|text| !text.trim().is_empty())
            {
                chunks.push(imported_history::assistant_message_chunk(
                    session_id,
                    WARP_PROVIDER,
                    ordinal,
                    &created_at,
                    text.trim(),
                ));
            }
            continue;
        }
        if let Some(reasoning) = field(message, &["agentReasoning", "agent_reasoning"]) {
            if let Some(text) =
                field_str(reasoning, &["reasoning"]).filter(|text| !text.trim().is_empty())
            {
                chunks.push(imported_history::thinking_chunk(
                    session_id,
                    WARP_PROVIDER,
                    ordinal,
                    &created_at,
                    text.trim(),
                ));
            }
            continue;
        }
        let Some(tool_call) = field(message, &["toolCall", "tool_call"]) else {
            continue;
        };
        let Some((raw_name, payload)) = warp_tool_variant(tool_call) else {
            continue;
        };
        let call_id = field_str(tool_call, &["toolCallId", "tool_call_id"])
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("warp-{ordinal}"));
        let (canonical_name, args) = normalize_warp_tool_call(raw_name, payload.clone());
        let output = tool_results
            .get(&call_id)
            .map(|result| warp_tool_result_text(result))
            .unwrap_or_default();
        let call = ImportedToolCall {
            call_id,
            raw_name: camel_to_snake(raw_name),
            canonical_name,
            args,
            created_at: created_at.clone(),
        };
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            WARP_PROVIDER,
            ordinal,
            &call,
            &output,
        ));
    }
    Ok(chunks)
}

fn decode_warp_task(blob: &[u8]) -> Result<Value, String> {
    let pool = WARP_DESCRIPTOR_POOL.as_ref().map_err(Clone::clone)?;
    let descriptor = pool
        .get_message_by_name(WARP_TASK_PROTO_NAME)
        .ok_or_else(|| format!("missing Warp descriptor {WARP_TASK_PROTO_NAME}"))?;
    let message = DynamicMessage::decode(descriptor, blob)
        .map_err(|err| format!("decode Warp task protobuf: {err}"))?;
    serde_json::to_value(message).map_err(|err| format!("project Warp task JSON: {err}"))
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
pub(super) fn reset_payload_fallback_decodes() {
    PAYLOAD_FALLBACK_DECODES.with(|count| count.set(0));
}

#[cfg(test)]
pub(super) fn payload_fallback_decodes() -> usize {
    PAYLOAD_FALLBACK_DECODES.with(std::cell::Cell::get)
}

fn reconstruct_cursor_chunk(
    conn: &Connection,
    event_id: &str,
    locator: &StructuredPayloadLocator,
) -> Result<ActivityChunk, String> {
    let StructuredPayloadLocator::Cursor {
        call_blob_id,
        result_blob_id,
        item_index,
        result_item_index,
        event_kind,
        segment_index,
    } = locator
    else {
        return Err("not a Cursor replay locator".to_string());
    };
    let data = read_blob(conn, call_blob_id)?
        .ok_or_else(|| "Cursor replay payload blob no longer exists".to_string())?;
    let message: Value = serde_json::from_slice(&data)
        .map_err(|err| format!("decode Cursor replay payload message: {err}"))?;
    let created_at = String::new();
    let mut chunk = match event_kind {
        CursorEventKind::User => {
            let text = clean_cursor_user_text(&cursor_message_text(message.get("content")))
                .unwrap_or_default();
            imported_history::user_message_chunk(
                "cursorcliapp-payload",
                CURSOR_PROVIDER,
                0,
                &created_at,
                &text,
            )
        }
        CursorEventKind::AssistantVisible | CursorEventKind::Thinking => {
            let item = cursor_message_items(message.get("content"))
                .nth(*item_index)
                .ok_or_else(|| "Cursor replay text item no longer exists".to_string())?;
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            let (thoughts, visible) = split_think_blocks(text);
            if matches!(event_kind, CursorEventKind::Thinking) {
                let thought = thoughts.get(*segment_index).cloned().unwrap_or_default();
                imported_history::thinking_chunk(
                    "cursorcliapp-payload",
                    CURSOR_PROVIDER,
                    0,
                    &created_at,
                    &thought,
                )
            } else {
                imported_history::assistant_message_chunk(
                    "cursorcliapp-payload",
                    CURSOR_PROVIDER,
                    0,
                    &created_at,
                    visible.trim(),
                )
            }
        }
        CursorEventKind::Tool => {
            let item = cursor_message_items(message.get("content"))
                .nth(*item_index)
                .ok_or_else(|| "Cursor replay tool call no longer exists".to_string())?;
            let call = cursor_tool_call(item, &created_at)
                .ok_or_else(|| "Cursor replay tool call is invalid".to_string())?;
            let output = match (result_blob_id, result_item_index) {
                (Some(result_blob_id), Some(result_item_index)) => {
                    let result_data = read_blob(conn, result_blob_id)?
                        .ok_or_else(|| "Cursor replay result blob no longer exists".to_string())?;
                    let result_message: Value = serde_json::from_slice(&result_data)
                        .map_err(|err| format!("decode Cursor replay result: {err}"))?;
                    let output = cursor_message_items(result_message.get("content"))
                        .nth(*result_item_index)
                        .map(|item| cursor_tool_result_text(item.get("result")))
                        .unwrap_or_default();
                    output
                }
                _ => String::new(),
            };
            imported_history::tool_call_chunk(
                "cursorcliapp-payload",
                CURSOR_PROVIDER,
                0,
                &call,
                &output,
            )
        }
    };
    chunk.chunk_id = event_id.to_string();
    Ok(chunk)
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

#[allow(clippy::too_many_arguments)]
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

pub(super) fn compact_chunk(
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

pub(super) fn rebuild_turns(
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

fn unchanged_outcome(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    cursor: StructuredCursor,
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

#[allow(clippy::too_many_arguments)]
fn finish_outcome(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    cursor: StructuredCursor,
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

fn open_source_db(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("open structured replay source {}: {err}", path.display()))
}

fn validate_cursor_schema(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT value FROM meta WHERE key='0' LIMIT 0")
        .and_then(|_| conn.prepare("SELECT id,data FROM blobs LIMIT 0"))
        .map(|_| ())
        .map_err(|err| format!("unsupported Cursor CLI replay schema: {err}"))
}

fn validate_warp_schema(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT id,task_id,task,last_modified_at FROM agent_tasks
         WHERE conversation_id='' LIMIT 0",
    )
    .and_then(|_| {
        conn.prepare("SELECT conversation_id,last_modified_at FROM agent_conversations LIMIT 0")
    })
    .map(|_| ())
    .map_err(|err| format!("unsupported Warp replay schema: {err}"))
}

fn read_cursor_meta(conn: &Connection) -> Result<CursorMeta, String> {
    let raw = conn
        .query_row("SELECT value FROM meta WHERE key='0'", [], |row| {
            row.get::<_, rusqlite::types::Value>(0)
        })
        .optional()
        .map_err(|err| format!("read Cursor CLI replay meta: {err}"))?
        .ok_or_else(|| "Cursor CLI replay meta is missing".to_string())?;
    let bytes = match raw {
        rusqlite::types::Value::Text(text) => text.into_bytes(),
        rusqlite::types::Value::Blob(bytes) => bytes,
        _ => return Err("Cursor CLI replay meta has unsupported type".to_string()),
    };
    let decoded = if bytes.first() == Some(&b'{') {
        bytes
    } else {
        hex_decode(std::str::from_utf8(&bytes).unwrap_or_default())
            .ok_or_else(|| "Cursor CLI replay meta is not valid hex JSON".to_string())?
    };
    serde_json::from_slice(&decoded).map_err(|err| format!("decode Cursor CLI replay meta: {err}"))
}

fn read_blob(conn: &Connection, blob_id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row("SELECT data FROM blobs WHERE id=?1", [blob_id], |row| {
        row.get::<_, Vec<u8>>(0)
    })
    .optional()
    .map_err(|err| format!("read structured replay blob {blob_id}: {err}"))
}

fn visit_manifest_message_ids(
    data: &[u8],
    mut visit: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < data.len() {
        let (tag, next) = read_varint(data, offset)
            .ok_or_else(|| "Cursor CLI manifest has a truncated tag".to_string())?;
        offset = next;
        match tag & 7 {
            0 => {
                offset = read_varint(data, offset)
                    .ok_or_else(|| "Cursor CLI manifest has a truncated varint".to_string())?
                    .1;
            }
            1 => offset = offset.saturating_add(8),
            2 => {
                let (length, next) = read_varint(data, offset)
                    .ok_or_else(|| "Cursor CLI manifest has a truncated length".to_string())?;
                offset = next;
                let end = offset
                    .checked_add(length as usize)
                    .filter(|end| *end <= data.len())
                    .ok_or_else(|| "Cursor CLI manifest field exceeds root blob".to_string())?;
                if tag >> 3 == 1 && length == 32 {
                    let id = hex_encode(&data[offset..end]);
                    visit(&id)?;
                }
                offset = end;
            }
            5 => offset = offset.saturating_add(4),
            _ => return Err("Cursor CLI manifest uses an unsupported wire type".to_string()),
        }
        if offset > data.len() {
            return Err("Cursor CLI manifest is truncated".to_string());
        }
    }
    Ok(())
}

fn manifest_prefix_hash(data: &[u8], prefix_count: u64) -> Result<(u64, String), String> {
    let mut count = 0_u64;
    let mut hash = Hash64::default();
    visit_manifest_message_ids(data, |id| {
        if count < prefix_count {
            hash.update(id.as_bytes());
        }
        count = count.saturating_add(1);
        Ok(())
    })?;
    Ok((count, hash.finish_hex()))
}

fn read_varint(data: &[u8], mut offset: usize) -> Option<(u64, usize)> {
    let mut value = 0_u64;
    let mut shift = 0_u32;
    loop {
        let byte = *data.get(offset)?;
        offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, offset));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

fn cursor_message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn cursor_message_items(content: Option<&Value>) -> impl Iterator<Item = &Value> {
    content.and_then(Value::as_array).into_iter().flatten()
}

fn clean_cursor_user_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("<user_info>") {
        return None;
    }
    let inner = if let Some(start) = trimmed.find("<user_query>") {
        let rest = &trimmed[start + "<user_query>".len()..];
        rest.split_once("</user_query>")
            .map_or(rest, |(inner, _)| inner)
    } else {
        trimmed
    };
    let mut clean = trim_cursor_edges(inner);
    if let Some(request) = clean.strip_prefix("USER REQUEST:") {
        let cut = [request.find("\n---"), request.find("\\n---")]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(request.len());
        clean = trim_cursor_edges(&request[..cut]);
    }
    (!clean.is_empty()).then(|| clean.to_string())
}

fn trim_cursor_edges(mut text: &str) -> &str {
    loop {
        let before = text;
        text = text.trim();
        text = text.strip_prefix("\\n").unwrap_or(text);
        text = text.strip_suffix("\\n").unwrap_or(text);
        if before == text {
            return text;
        }
    }
}

fn split_think_blocks(text: &str) -> (Vec<String>, String) {
    let mut thoughts = Vec::new();
    let mut visible = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        visible.push_str(&rest[..start]);
        let after = &rest[start + "<think>".len()..];
        if let Some(end) = after.find("</think>") {
            let thought = after[..end].trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = &after[end + "</think>".len()..];
        } else {
            let thought = after.trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = "";
        }
    }
    visible.push_str(rest);
    (thoughts, visible)
}

fn cursor_tool_call(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("toolCallId")?.as_str()?.to_string();
    let raw_name = item.get("toolName")?.as_str()?.to_string();
    let args = item.get("args").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_cursor_tool(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn normalize_cursor_tool(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "shell" | "bash" | "run_terminal_cmd" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| args.get("cmd").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({"command":command,"cmd":command,"payload":args}),
            )
        }
        "search_replace" | "edit_file" | "write" | "write_file" | "create_file" | "multi_edit"
        | "MultiEdit" | "apply_patch" => {
            let file_path = args
                .get("file_path")
                .and_then(Value::as_str)
                .or_else(|| args.get("filePath").and_then(Value::as_str))
                .or_else(|| args.get("target_file").and_then(Value::as_str))
                .or_else(|| args.get("path").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({"action":raw_name,"file_path":file_path,"payload":args}),
            )
        }
        _ => (raw_name.to_string(), args),
    }
}

fn cursor_tool_result_text(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn warp_tool_variant(tool_call: &Value) -> Option<(&str, &Value)> {
    tool_call.as_object()?.iter().find_map(|(key, value)| {
        (!matches!(key.as_str(), "toolCallId" | "tool_call_id")).then_some((key.as_str(), value))
    })
}

fn normalize_warp_tool_call(raw_name: &str, payload: Value) -> (String, Value) {
    match raw_name {
        "runShellCommand" | "run_shell_command" => {
            let command = field_str(&payload, &["command"]).unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({"command":command,"cmd":command,"payload":payload}),
            )
        }
        "readFiles" | "read_files" => (imported_history::FUNCTION_READ_FILE.to_string(), payload),
        "applyFileDiffs" | "apply_file_diffs" | "editDocuments" | "edit_documents"
        | "createDocuments" | "create_documents" => {
            let file_path = first_warp_edited_file_path(&payload).unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({
                    "action":camel_to_snake(raw_name),
                    "file_path":file_path,
                    "payload":payload,
                }),
            )
        }
        "grep" | "searchCodebase" | "search_codebase" => {
            (imported_history::FUNCTION_CODE_SEARCH.to_string(), payload)
        }
        "fileGlob" | "file_glob" | "fileGlobV2" | "file_glob_v2" => (
            imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
            payload,
        ),
        _ => (camel_to_snake(raw_name), payload),
    }
}

fn first_warp_edited_file_path(payload: &Value) -> Option<String> {
    [
        "diffs",
        "newFiles",
        "new_files",
        "deletedFiles",
        "deleted_files",
        "v4aUpdates",
        "v4a_updates",
    ]
    .iter()
    .find_map(|key| {
        field(payload, &[*key])
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| field_str(row, &["filePath", "file_path", "documentId", "document_id"]))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    })
}

fn warp_tool_result_text(result: &Value) -> String {
    let payload = result
        .as_object()
        .and_then(|object| {
            object.iter().find_map(|(key, value)| {
                (!matches!(key.as_str(), "toolCallId" | "tool_call_id")).then_some(value)
            })
        })
        .unwrap_or(result);
    if let Some(output) = find_warp_output_text(payload) {
        return output.to_string();
    }
    serde_json::to_string(payload).unwrap_or_default()
}

fn find_warp_output_text(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    for key in [
        "output",
        "stdout",
        "interleavedOutput",
        "interleaved_output",
    ] {
        if let Some(output) = object.get(key).and_then(Value::as_str) {
            return Some(output);
        }
    }
    object.values().find_map(find_warp_output_text)
}

fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    let object = value.as_object()?;
    names.iter().find_map(|name| object.get(*name))
}

fn field_str<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    field(value, names).and_then(Value::as_str)
}

fn timestamp_value_to_iso(value: &Value) -> Option<String> {
    if let Some(raw) = value.as_str() {
        return Some(imported_history::normalize_created_at(raw));
    }
    let seconds = field(value, &["seconds"])?;
    let seconds = seconds
        .as_i64()
        .or_else(|| seconds.as_str().and_then(|raw| raw.parse().ok()))?;
    let nanos = field(value, &["nanos"])
        .and_then(Value::as_i64)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp(seconds, nanos.max(0) as u32).map(|dt| dt.to_rfc3339())
}

fn parse_warp_timestamp_ms(value: &str) -> Option<i64> {
    imported_history::parse_iso_to_epoch_ms_opt(value).or_else(|| {
        ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"]
            .iter()
            .find_map(|format| chrono::NaiveDateTime::parse_from_str(value, format).ok())
            .map(|timestamp| timestamp.and_utc().timestamp_millis())
    })
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 4);
    for (index, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                output.push('_');
            }
            output.push(ch.to_ascii_lowercase());
        } else {
            output.push(ch);
        }
    }
    output
}

fn chunk_field_text(chunk: &ActivityChunk, field_path: &str) -> Result<String, String> {
    let (root, path) = field_path
        .split_once('.')
        .map_or((field_path, ""), |parts| parts);
    let value = match root {
        "args" => &chunk.args,
        "result" => &chunk.result,
        _ => return Err("Replay payload field must be under args or result".to_string()),
    };
    let target = if path.is_empty() {
        value
    } else {
        path.split('.')
            .try_fold(value, |current, key| current.get(key))
            .ok_or_else(|| "Replay payload field no longer exists".to_string())?
    };
    Ok(target
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| target.to_string()))
}

pub(super) fn range_from_text(
    event_id: &str,
    field_path: &str,
    text: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(text.len());
    let mut start_boundary = start;
    while start_boundary < text.len() && !text.is_char_boundary(start_boundary) {
        start_boundary += 1;
    }
    let mut end = start_boundary.saturating_add(max_bytes).min(text.len());
    while end > start_boundary && !text.is_char_boundary(end) {
        end -= 1;
    }
    // A caller may request fewer bytes than the next UTF-8 scalar occupies.
    // Returning an empty, non-EOF page would leave the cursor stuck forever,
    // so make bounded forward progress by returning that one scalar.
    if end == start_boundary && start_boundary < text.len() && max_bytes > 0 {
        end = text[start_boundary..]
            .char_indices()
            .nth(1)
            .map_or(text.len(), |(next, _)| start_boundary + next);
    }
    Ok(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: start_boundary as u64,
        next_offset: end as u64,
        eof: end >= text.len(),
        total_bytes: text.len() as u64,
        text: text[start_boundary..end].to_string(),
    })
}

fn value_at_path_mut<'a>(value: &'a mut Value, path: &str) -> Option<&'a mut String> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object_mut()?.get_mut(segment)?;
    }
    match current {
        Value::String(text) => Some(text),
        _ => None,
    }
}

fn head_preview(text: &str, max_bytes: usize) -> String {
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [payload truncated]", &text[..end])
}

fn stable_event_id(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    event_key: &str,
) -> String {
    format!(
        "replay-{}-{}",
        source.as_str(),
        hash_parts(&[source_session_id.as_bytes(), event_key.as_bytes()])
    )
}

fn hash_parts(parts: &[&[u8]]) -> String {
    let mut hash = Hash64::default();
    for part in parts {
        hash.update(part);
        hash.update(&[0xff]);
    }
    hash.finish_hex()
}

#[derive(Default)]
struct Hash64(u64);

impl Hash64 {
    fn update(&mut self, bytes: &[u8]) {
        if self.0 == 0 {
            self.0 = 0xcbf29ce484222325;
        }
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish_hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.is_empty() || text.len() % 2 != 0 {
        return None;
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(pair, 16).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use prost_reflect::prost::Message as _;

    use super::*;
    use crate::projectors::turn_metadata::TurnMetadataAccumulator;

    fn temp_db(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "orgii-structured-replay-{name}-{}-{}.db",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn update_test_hash(mut hash: u64, text: &str) -> u64 {
        for byte in text.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    fn read_full_payload(
        cache: &mut Connection,
        source: ImportedHistorySourceId,
        session_id: &str,
        generation: &str,
        event_id: &str,
        field_path: &str,
    ) -> String {
        let mut restored = String::new();
        let mut offset = 0_u64;
        loop {
            let range = super::super::read_payload_range(
                cache,
                source,
                session_id,
                generation,
                event_id,
                field_path,
                offset,
                Some(super::super::HARD_MAX_PAYLOAD_RANGE_BYTES),
            )
            .expect("structured replay payload range");
            assert_eq!(range.offset, offset);
            assert!(range.next_offset > offset || range.eof);
            restored.push_str(&range.text);
            offset = range.next_offset;
            if range.eof {
                assert_eq!(offset, range.total_bytes);
                break;
            }
        }
        restored
    }

    fn cache_for(
        source: ImportedHistorySourceId,
        source_session_id: &str,
        source_path: &Path,
    ) -> (Connection, String) {
        use crate::store::sqlite::SqliteRecordStore;

        let cache = Connection::open_in_memory().expect("replay cache");
        SqliteRecordStore::init_tables(&cache).expect("replay tables");
        SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
        let session_id = format!(
            "{}{}",
            source.descriptor().session_prefix,
            source_session_id
        );
        cache
            .execute(
                "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES(?1,?2,?3,?4)",
                params![
                    source.as_str(),
                    source_session_id,
                    session_id,
                    source_path.to_string_lossy()
                ],
            )
            .expect("cache source binding");
        (cache, session_id)
    }

    fn cursor_manifest(ids: &[String]) -> Vec<u8> {
        let mut manifest = Vec::new();
        for id in ids {
            manifest.extend_from_slice(&[0x0a, 32]);
            manifest.extend_from_slice(&hex_decode(id).expect("blob id"));
        }
        manifest
    }

    fn put_cursor_blob(conn: &Connection, byte: u8, data: &[u8]) -> String {
        let id = hex_encode(&[byte; 32]);
        conn.execute(
            "INSERT OR REPLACE INTO blobs(id,data) VALUES(?1,?2)",
            params![id, data],
        )
        .expect("insert Cursor blob");
        id
    }

    fn publish_cursor_root(conn: &Connection, root_byte: u8, ids: &[String]) {
        let root_id = put_cursor_blob(conn, root_byte, &cursor_manifest(ids));
        let meta = json!({
            "agentId":"cursor-1",
            "latestRootBlobId":root_id,
            "createdAt":1_700_000_000_000_i64,
        })
        .to_string();
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('0',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [hex_encode(meta.as_bytes())],
        )
        .expect("publish Cursor root");
    }

    fn encode_warp_fixture(value: Value) -> Vec<u8> {
        let pool = match &*WARP_DESCRIPTOR_POOL {
            Ok(pool) => pool,
            Err(error) => panic!("Warp descriptor: {error}"),
        };
        let descriptor = pool
            .get_message_by_name(WARP_TASK_PROTO_NAME)
            .expect("Warp task descriptor");
        let encoded = value.to_string();
        let mut deserializer = serde_json::Deserializer::from_str(&encoded);
        DynamicMessage::deserialize(descriptor, &mut deserializer)
            .expect("Warp task JSON")
            .encode_to_vec()
    }

    fn metadata_from_chunks(chunks: &[ActivityChunk]) -> TurnMetadataAccumulator {
        let mut metadata = TurnMetadataAccumulator::new();
        for chunk in chunks {
            metadata.add_event_values_at(
                Some(&chunk.function),
                &chunk.args,
                &chunk.result,
                &chunk.created_at,
            );
        }
        metadata
    }

    fn assert_projected_metadata_matches(
        cache: &mut Connection,
        source: ImportedHistorySourceId,
        session_id: &str,
        expected: &TurnMetadataAccumulator,
    ) {
        let projected = super::super::project_turn_metadata(cache, source, session_id, None)
            .expect("project compact replay metadata");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].modified_files, expected.modified_files());
        assert_eq!(
            serde_json::to_value(&projected[0].resource_interactions).unwrap(),
            serde_json::to_value(expected.resource_interactions()).unwrap()
        );
        let mut actual_artifacts = projected[0]
            .git_artifacts
            .iter()
            .map(|artifact| serde_json::to_string(artifact).unwrap())
            .collect::<Vec<_>>();
        let mut expected_artifacts = expected
            .git_artifacts()
            .iter()
            .map(|artifact| serde_json::to_string(artifact).unwrap())
            .collect::<Vec<_>>();
        actual_artifacts.sort();
        expected_artifacts.sort();
        assert_eq!(actual_artifacts, expected_artifacts);
    }

    #[test]
    fn cursor_manifest_prefix_hash_detects_reorder() {
        fn manifest(ids: &[[u8; 32]]) -> Vec<u8> {
            let mut out = Vec::new();
            for id in ids {
                out.extend_from_slice(&[0x0a, 32]);
                out.extend_from_slice(id);
            }
            out
        }
        let first = manifest(&[[1; 32], [2; 32]]);
        let appended = manifest(&[[1; 32], [2; 32], [3; 32]]);
        let reordered = manifest(&[[2; 32], [1; 32], [3; 32]]);
        let (_, expected) = manifest_prefix_hash(&first, 2).expect("prefix");
        assert_eq!(manifest_prefix_hash(&appended, 2).unwrap().1, expected);
        assert_ne!(manifest_prefix_hash(&reordered, 2).unwrap().1, expected);
    }

    #[test]
    fn range_reader_preserves_utf8_boundaries() {
        let text = "你".repeat(100);
        let range = range_from_text("event", "result.output", &text, 1, 17).expect("range");
        assert!(range.text.is_char_boundary(range.text.len()));
        assert!(range.next_offset > range.offset);

        let one_byte = range_from_text("event", "result.output", &text, 0, 1).expect("small range");
        assert_eq!(one_byte.text, "你");
        assert_eq!(one_byte.next_offset, 3);
    }

    #[test]
    fn structured_compaction_keeps_edit_scalars_and_full_git_summary() {
        let mut edit = ActivityChunk::new(
            "structured",
            "tool_call",
            imported_history::FUNCTION_EDIT_FILE,
        );
        edit.args = json!({
            "file_path":"src/large.rs",
            "action":"replace",
            "operation":"update",
            "linesAdded":17,
            "linesRemoved":9,
            "content":"line\n".repeat(4_000),
        });
        edit.result = json!({"output":"updated"});
        compact_chunk(&mut edit, "edit-locator");
        assert_eq!(edit.args["linesAdded"], 17);
        assert_eq!(edit.args["linesRemoved"], 9);
        assert_eq!(edit.args["operation"], "update");
        assert_eq!(edit.result["linesAdded"], 17);
        assert_eq!(edit.result["linesRemoved"], 9);

        let mut shell = ActivityChunk::new(
            "structured",
            "tool_call",
            imported_history::FUNCTION_RUN_COMMAND_LINE,
        );
        shell.args = json!({"command":"git commit -m metadata"});
        shell.result = json!({
            "output":format!(
                "[feature abc1234] metadata\n{}\nhttps://github.com/acme/repo/pull/42",
                "middle".repeat(14 * 1024)
            )
        });
        assert!(shell.result["output"].as_str().unwrap().len() > 80 * 1024);
        compact_chunk(&mut shell, "shell-locator");
        let metadata = metadata_from_chunks(&[edit, shell]);
        assert_eq!(metadata.modified_files()[0].additions, 17);
        assert_eq!(metadata.modified_files()[0].deletions, 9);
        assert!(metadata
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
        assert!(metadata
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.pr_number == Some(42)));
    }

    #[test]
    fn structured_path_plus_ten_mib_content_round_trips_exact_root_args() {
        let path = temp_db("cursor-root-args");
        let source = Connection::open(&path).expect("Cursor root-args source");
        source
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
            )
            .expect("Cursor root-args schema");
        let user = put_cursor_blob(
            &source,
            71,
            br#"{"role":"user","content":"<user_query>large args</user_query>"}"#,
        );
        let original_args = json!({
            "path":"src/structured-huge.txt",
            "content":format!("BEGIN{}END", "你".repeat((10 * 1024 * 1024) / 3)),
        });
        let expected_json = serde_json::to_string(&original_args).expect("baseline args JSON");
        let tool_call = put_cursor_blob(
            &source,
            72,
            json!({
                "role":"assistant",
                "content":[{
                    "type":"tool-call",
                    "toolCallId":"large-args-call",
                    "toolName":"custom_tool",
                    "args":original_args
                }]
            })
            .to_string()
            .as_bytes(),
        );
        let tool_result = put_cursor_blob(
            &source,
            73,
            br#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"large-args-call","result":"ok"}]}"#,
        );
        publish_cursor_root(&source, 74, &[user, tool_call, tool_result]);
        drop(source);

        let (mut cache, session_id) =
            cache_for(ImportedHistorySourceId::CursorCli, "cursor-1", &path);
        let legacy = crate::sources::cursor_cli::history::load_cursor_cli_history_for_session(
            &cache,
            &session_id,
        )
        .expect("old full Cursor history baseline");
        let expected_args = legacy
            .iter()
            .find(|chunk| chunk.function == "custom_tool")
            .expect("legacy custom tool")
            .args
            .clone();
        assert_eq!(
            expected_args,
            serde_json::from_str::<Value>(&expected_json).unwrap()
        );

        let opened = super::super::open_window(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open structured root args fixture");
        let indexed = opened
            .chunks
            .iter()
            .find(|event| event.chunk.function == "custom_tool")
            .expect("bounded custom tool event");
        assert_eq!(indexed.chunk.args["path"], "src/structured-huge.txt");
        assert_eq!(indexed.chunk.args["_replayTruncated"], true);
        assert!(indexed.chunk.args.get("content").is_none());
        assert_eq!(indexed.payloads.len(), 1);
        assert_eq!(indexed.payloads[0].field_path, "args");

        reset_payload_fallback_decodes();
        let restored = read_full_payload(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &opened.cursor.generation,
            &indexed.chunk.chunk_id,
            "args",
        );
        assert_eq!(restored.len(), expected_json.len());
        assert_eq!(
            update_test_hash(0xcbf29ce484222325, &restored),
            update_test_hash(0xcbf29ce484222325, &expected_json)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&restored).expect("restored structured args"),
            expected_args
        );
        assert!(!restored.contains("_replayTruncated"));
        assert!(!restored.contains("[payload truncated]"));
        assert_eq!(payload_fallback_decodes(), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cursor_cli_public_replay_is_bounded_incremental_and_resets_on_reorder() {
        let path = temp_db("cursor");
        let source = Connection::open(&path).expect("Cursor source");
        source
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
            )
            .expect("Cursor schema");
        let user = put_cursor_blob(
            &source,
            1,
            br#"{"role":"user","content":"<user_query>hello</user_query>"}"#,
        );
        let large_text = "cursor-large-".repeat(900_000);
        let assistant = put_cursor_blob(
            &source,
            2,
            json!({"role":"assistant","content":[{"type":"text","text":large_text}]})
                .to_string()
                .as_bytes(),
        );
        let tool_call = put_cursor_blob(
            &source,
            4,
            br#"{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","toolName":"shell","args":{"command":"pwd"}}]}"#,
        );
        publish_cursor_root(
            &source,
            20,
            &[user.clone(), assistant.clone(), tool_call.clone()],
        );
        drop(source);

        let (mut cache, session_id) =
            cache_for(ImportedHistorySourceId::CursorCli, "cursor-1", &path);
        let opened = super::super::open_window(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open Cursor bounded replay");
        assert_eq!(opened.chunks.len(), 3);
        assert!(opened.stats.parsed_bytes > 0);
        let assistant_event = opened
            .chunks
            .iter()
            .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
            .expect("assistant event");
        assert!(
            assistant_event.chunk.result["content"]
                .as_str()
                .unwrap_or_default()
                .len()
                < NORMAL_PAYLOAD_PREVIEW_BYTES + 64
        );
        let artifact_count = cache
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source='cursor_cli' AND generation=?1",
                [&opened.cursor.generation],
                |row| row.get::<_, i64>(0),
            )
            .expect("Cursor payload artifact count");
        assert_eq!(artifact_count, 1);
        reset_payload_fallback_decodes();
        let mut cursor_payload_hash = 0xcbf29ce484222325_u64;
        let mut cursor_payload_bytes = 0_usize;
        let mut payload_offset = 0_u64;
        loop {
            let range = super::super::read_payload_range(
                &mut cache,
                ImportedHistorySourceId::CursorCli,
                &session_id,
                &opened.cursor.generation,
                &assistant_event.chunk.chunk_id,
                "result.content",
                payload_offset,
                Some(super::super::HARD_MAX_PAYLOAD_RANGE_BYTES),
            )
            .expect("Cursor payload artifact page");
            assert!(range.text.len() <= super::super::HARD_MAX_PAYLOAD_RANGE_BYTES);
            assert!(range.next_offset > payload_offset || range.eof);
            cursor_payload_hash = update_test_hash(cursor_payload_hash, &range.text);
            cursor_payload_bytes = cursor_payload_bytes.saturating_add(range.text.len());
            payload_offset = range.next_offset;
            if range.eof {
                break;
            }
        }
        assert_eq!(cursor_payload_bytes, large_text.len());
        assert_eq!(
            cursor_payload_hash,
            update_test_hash(0xcbf29ce484222325, &large_text)
        );
        assert_eq!(payload_fallback_decodes(), 0);
        let pending_tool_id = opened
            .chunks
            .iter()
            .find(|event| event.chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
            .expect("pending Cursor tool")
            .chunk
            .chunk_id
            .clone();

        let unchanged = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &opened.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("unchanged Cursor poll");
        assert_eq!(unchanged.stats.parsed_rows, 0);
        assert_eq!(unchanged.stats.upserted_events, 0);

        let source = Connection::open(&path).expect("reopen Cursor source");
        let second_user = put_cursor_blob(
            &source,
            3,
            br#"{"role":"user","content":"<user_query>second</user_query>"}"#,
        );
        publish_cursor_root(
            &source,
            21,
            &[
                user.clone(),
                assistant.clone(),
                tool_call.clone(),
                second_user.clone(),
            ],
        );
        drop(source);
        let appended = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &opened.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Cursor append delta");
        assert!(!appended.reset_required);
        assert_eq!(appended.chunks.len(), 1);
        assert_eq!(appended.stats.parsed_rows, 1);

        let source = Connection::open(&path).expect("reopen Cursor result source");
        let tool_result = put_cursor_blob(
            &source,
            5,
            br#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1","result":"/repo"}]}"#,
        );
        publish_cursor_root(
            &source,
            22,
            &[
                user.clone(),
                assistant.clone(),
                tool_call.clone(),
                second_user.clone(),
                tool_result.clone(),
            ],
        );
        drop(source);
        let completed_tool = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &appended.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Cursor cross-root tool result delta");
        assert!(!completed_tool.reset_required);
        assert_eq!(completed_tool.chunks.len(), 1);
        assert_eq!(completed_tool.chunks[0].chunk.chunk_id, pending_tool_id);
        assert!(completed_tool.chunks[0]
            .chunk
            .result
            .to_string()
            .contains("/repo"));

        let source = Connection::open(&path).expect("reopen Cursor source for fork");
        publish_cursor_root(
            &source,
            23,
            &[second_user, user, assistant, tool_call, tool_result],
        );
        drop(source);
        let reset = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &completed_tool.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Cursor reorder reset");
        assert!(reset.reset_required);
        assert_ne!(reset.cursor.generation, completed_tool.cursor.generation);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cursor_cli_compact_projection_matches_full_large_edit_and_git_output() {
        let path = temp_db("cursor-metadata");
        let source = Connection::open(&path).expect("Cursor metadata source");
        source
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
            )
            .expect("Cursor metadata schema");
        let user = put_cursor_blob(
            &source,
            31,
            br#"{"role":"user","content":"<user_query>metadata</user_query>"}"#,
        );
        let edit_args = json!({
            "file_path":"src/cursor-large.rs",
            "old_string":"old\nvalue",
            "new_string":"new line\n".repeat(2_000),
            "operation":"replace",
        });
        assert!(edit_args.to_string().len() > NORMAL_PAYLOAD_PREVIEW_BYTES);
        let edit_call = put_cursor_blob(
            &source,
            32,
            json!({
                "role":"assistant",
                "content":[{
                    "type":"tool-call","toolCallId":"edit-1",
                    "toolName":"search_replace","args":edit_args
                }]
            })
            .to_string()
            .as_bytes(),
        );
        let edit_result = put_cursor_blob(
            &source,
            33,
            br#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"edit-1","result":"done"}]}"#,
        );
        let shell_call = put_cursor_blob(
            &source,
            34,
            br#"{"role":"assistant","content":[{"type":"tool-call","toolCallId":"git-1","toolName":"shell","args":{"command":"git commit -m metadata"}}]}"#,
        );
        let git_output = format!(
            "[feature abc1234] metadata\n{}\nhttps://github.com/acme/cursor/pull/77",
            "middle".repeat(14 * 1024)
        );
        assert!(git_output.len() > 80 * 1024);
        let shell_result = put_cursor_blob(
            &source,
            35,
            json!({
                "role":"tool",
                "content":[{"type":"tool-result","toolCallId":"git-1","result":git_output}]
            })
            .to_string()
            .as_bytes(),
        );
        publish_cursor_root(
            &source,
            36,
            &[user, edit_call, edit_result, shell_call, shell_result],
        );
        drop(source);

        let (mut cache, session_id) =
            cache_for(ImportedHistorySourceId::CursorCli, "cursor-1", &path);
        let legacy = crate::sources::cursor_cli::history::load_cursor_cli_history_for_session(
            &cache,
            &session_id,
        )
        .expect("load full Cursor metadata baseline");
        let expected_shell_result = legacy
            .iter()
            .find(|chunk| chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
            .expect("legacy Cursor shell")
            .result
            .clone();
        let expected = metadata_from_chunks(&legacy);
        assert!(expected
            .modified_files()
            .iter()
            .any(|file| file.path == "src/cursor-large.rs"));
        assert!(expected
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
        assert!(expected
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.pr_number == Some(77)));
        assert_projected_metadata_matches(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &expected,
        );
        let opened = super::super::open_window(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open compact Cursor metadata replay");
        let compact_shell = opened
            .chunks
            .iter()
            .find(|event| event.chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
            .expect("compact Cursor shell");
        assert!(compact_shell
            .chunk
            .result
            .get("_replayGitArtifacts")
            .is_some());
        assert!(compact_shell
            .payloads
            .iter()
            .any(|payload| payload.field_path == "result"));
        assert!(!compact_shell
            .payloads
            .iter()
            .any(|payload| payload.field_path.starts_with("result.")));
        let restored_result = read_full_payload(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &opened.cursor.generation,
            &compact_shell.chunk.chunk_id,
            "result",
        );
        let restored_result: Value =
            serde_json::from_str(&restored_result).expect("exact Cursor shell result");
        assert_eq!(restored_result, expected_shell_result);
        assert!(restored_result.get("_replayGitArtifacts").is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn warp_task_rows_reconcile_insert_delete_rowid_reuse_and_schema_reset() {
        let path = temp_db("warp");
        let source = Connection::open(&path).expect("Warp source");
        source
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE agent_conversations(
                     id INTEGER PRIMARY KEY,conversation_id TEXT,conversation_data TEXT,
                     last_modified_at TEXT,summary TEXT
                 );
                 CREATE TABLE agent_tasks(
                     id INTEGER PRIMARY KEY,conversation_id TEXT,task_id TEXT,
                     task BLOB,last_modified_at TEXT
                 );",
            )
            .expect("Warp schema");
        source
            .execute(
                "INSERT INTO agent_conversations(
                     id,conversation_id,conversation_data,last_modified_at,summary
                 ) VALUES(1,'conversation-1','{}','2026-07-14 01:00:06','{}')",
                [],
            )
            .expect("Warp conversation");
        let mut fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/warp_task.json"))
                .expect("Warp fixture JSON");
        fixture["messages"][2]["toolCall"]["runShellCommand"]["command"] =
            Value::String("git commit -m metadata".to_string());
        let git_output = format!(
            "[feature def5678] metadata\n{}\nhttps://github.com/acme/warp/pull/88",
            "middle".repeat(14 * 1024)
        );
        assert!(git_output.len() > 80 * 1024);
        fixture["messages"][3]["toolCallResult"]["runShellCommand"]["commandFinished"]["output"] =
            Value::String(git_output);
        fixture["messages"][4]["toolCall"]["applyFileDiffs"]["diffs"][0]["replace"] =
            Value::String("new line\n".repeat(2_000));
        assert!(
            fixture["messages"][4]["toolCall"]["applyFileDiffs"]
                .to_string()
                .len()
                > NORMAL_PAYLOAD_PREVIEW_BYTES
        );
        let large_text = "warp-large-".repeat(900_000);
        fixture["messages"][6]["agentOutput"]["text"] = Value::String(large_text.clone());
        let blob = encode_warp_fixture(fixture.clone());
        let legacy_chunks = normalize_warp_task("warpapp-conversation-1", &blob, 0)
            .expect("normalize full Warp metadata baseline");
        let legacy_edit = legacy_chunks
            .iter()
            .find(|chunk| chunk.function == imported_history::FUNCTION_EDIT_FILE)
            .expect("Warp edit chunk");
        assert_eq!(legacy_edit.args["file_path"], "src/importer.rs");
        let expected = metadata_from_chunks(&legacy_chunks);
        assert!(expected
            .modified_files()
            .iter()
            .any(|file| file.path == "src/importer.rs"));
        assert!(expected
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("def5678")));
        assert!(expected
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.pr_number == Some(88)));
        source
            .execute(
                "INSERT INTO agent_tasks(
                     id,conversation_id,task_id,task,last_modified_at
                 ) VALUES(1,'conversation-1','task-root',?1,'2026-07-14 01:00:06')",
                [&blob],
            )
            .expect("Warp task");
        drop(source);

        let (mut cache, session_id) =
            cache_for(ImportedHistorySourceId::Warp, "conversation-1", &path);
        let opened = super::super::open_window(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open Warp bounded replay");
        assert_eq!(opened.chunks.len(), 5);
        assert_projected_metadata_matches(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &expected,
        );
        let assistant_event = opened
            .chunks
            .iter()
            .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
            .expect("Warp assistant");
        let assistant_artifacts = cache
            .query_row(
                "SELECT COUNT(DISTINCT content_hash) FROM imported_replay_payload_artifact_refs
                 WHERE source='warp' AND generation=?1 AND event_id=?2",
                params![&opened.cursor.generation, &assistant_event.chunk.chunk_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("Warp payload artifact ref count");
        assert_eq!(
            assistant_artifacts, 1,
            "duplicate compatibility fields share one body"
        );
        reset_payload_fallback_decodes();
        let mut warp_payload_hash = 0xcbf29ce484222325_u64;
        let mut warp_payload_bytes = 0_usize;
        let mut payload_offset = 0_u64;
        loop {
            let range = super::super::read_payload_range(
                &mut cache,
                ImportedHistorySourceId::Warp,
                &session_id,
                &opened.cursor.generation,
                &assistant_event.chunk.chunk_id,
                "result.content",
                payload_offset,
                Some(super::super::HARD_MAX_PAYLOAD_RANGE_BYTES),
            )
            .expect("Warp payload artifact page");
            assert!(range.text.len() <= super::super::HARD_MAX_PAYLOAD_RANGE_BYTES);
            assert!(range.next_offset > payload_offset || range.eof);
            warp_payload_hash = update_test_hash(warp_payload_hash, &range.text);
            warp_payload_bytes = warp_payload_bytes.saturating_add(range.text.len());
            payload_offset = range.next_offset;
            if range.eof {
                break;
            }
        }
        assert_eq!(warp_payload_bytes, large_text.len());
        assert_eq!(
            warp_payload_hash,
            update_test_hash(0xcbf29ce484222325, &large_text)
        );
        assert_eq!(payload_fallback_decodes(), 0);

        let unchanged = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &opened.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("unchanged Warp poll");
        assert_eq!(unchanged.stats.parsed_rows, 0);
        assert_eq!(unchanged.stats.upserted_events, 0);

        let source = Connection::open(&path).expect("reopen Warp source");
        source
            .execute(
                "UPDATE agent_tasks SET last_modified_at='2026-07-14 01:00:06.5' WHERE id=1",
                [],
            )
            .expect("update Warp row metadata");
        drop(source);
        let metadata_only = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &unchanged.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Warp metadata-only poll");
        assert_eq!(metadata_only.stats.parsed_rows, 0);
        assert_eq!(metadata_only.stats.upserted_events, 0);
        assert_eq!(metadata_only.cursor.revision, unchanged.cursor.revision);

        let source = Connection::open(&path).expect("reopen Warp source");
        fixture["messages"][6]["agentOutput"]["text"] =
            Value::String(format!("{large_text}-changed"));
        let updated_blob = encode_warp_fixture(fixture);
        source
            .execute(
                "UPDATE agent_tasks SET task=?1,last_modified_at='2026-07-14 01:00:07' WHERE id=1",
                [&updated_blob],
            )
            .expect("update one Warp event inside task BLOB");
        drop(source);
        let updated = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &metadata_only.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Warp task update delta");
        assert_eq!(updated.stats.parsed_rows, 1);
        assert_eq!(updated.stats.upserted_events, 1);
        assert_eq!(updated.chunks.len(), 1);
        let updated_assistant = updated
            .chunks
            .iter()
            .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
            .expect("updated Warp assistant");
        let updated_tail = super::super::read_payload_range(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &updated.cursor.generation,
            &updated_assistant.chunk.chunk_id,
            "result.content",
            large_text.len() as u64,
            Some(32),
        )
        .expect("updated Warp artifact tail");
        assert_eq!(updated_tail.text, "-changed");
        assert_eq!(payload_fallback_decodes(), 0);

        let source = Connection::open(&path).expect("reopen Warp source");
        source
            .execute("DELETE FROM agent_tasks WHERE id=1", [])
            .expect("delete Warp task");
        drop(source);
        let deleted = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &updated.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Warp delete delta");
        assert_eq!(deleted.removed_event_ids.len(), 5);

        let source = Connection::open(&path).expect("reopen Warp rowid source");
        source
            .execute(
                "INSERT INTO agent_tasks(
                     id,conversation_id,task_id,task,last_modified_at
                 ) VALUES(1,'conversation-1','task-root',?1,'2026-07-14 01:00:07')",
                [&blob],
            )
            .expect("reuse Warp rowid");
        drop(source);
        let reinserted = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &deleted.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Warp rowid reuse delta");
        assert_eq!(reinserted.chunks.len(), 5);

        let source = Connection::open(&path).expect("reopen Warp schema source");
        source
            .execute("ALTER TABLE agent_tasks ADD COLUMN extra TEXT", [])
            .expect("change Warp schema");
        drop(source);
        let reset = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &reinserted.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("Warp schema reset");
        assert!(reset.reset_required);
        let _ = std::fs::remove_file(path);
    }
}
