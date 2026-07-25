//! Incremental SQLite replay drivers for imported history stores.
//!
//! Provider databases are opened read-only (including their WAL view). Rows
//! are folded one at a time into ORGII's compact replay index. A persistent
//! source-row hash table lets an unchanged poll avoid JSON parsing and event
//! upserts even when a WAL checkpoint changed the physical files.

use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::development_artifact::{
    attach_replay_git_artifacts, parse_git_artifacts_from_tool_payload,
};
use crate::sources::imported_history::{self, replay::ImportedHistorySourceId};

use crate::sources::imported_history::replay::drivers::common::{
    content_digest, rebuild_turns, ContentDigest,
};
use crate::sources::imported_history::replay::index::ReplayIndexState;
use crate::sources::imported_history::replay::payload_artifact;
mod common;
mod kv_store;
mod row_store;

use common::*;
pub(in crate::sources::imported_history::replay) use kv_store::hydrate_kv_turn;
use kv_store::*;
use row_store::*;

use crate::sources::imported_history::replay::{
    replay_payload_body_projection, ReplayPayloadBodyProjection, ReplayPayloadDescriptor,
    ReplayPayloadEncoding, ReplayPayloadKind, ReplayPayloadRange, ReplayStats,
    NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

#[derive(Debug, Clone)]
pub(in crate::sources::imported_history::replay) struct SqliteSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub total_events: u64,
    pub total_turns: u64,
    pub changed: bool,
    pub removed_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RowStoreReplayCursor {
    schema_version: i64,
    total_source_rows: u64,
    max_time_created: i64,
    max_source_key: String,
    source_signal: String,
    last_source_key: String,
    #[serde(default)]
    order_signal: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct KvStoreReplayCursor {
    schema_version: i64,
    total_source_rows: u64,
    max_time_created: i64,
    max_source_key: String,
    source_signal: String,
    last_source_key: String,
    #[serde(default)]
    order_signal: String,
}

#[derive(Debug, Deserialize)]
struct SqliteCursorVersion {
    schema_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncPlan {
    Skip,
    Append,
    Reconcile,
}

#[derive(Debug)]
struct SqliteSourceSummary {
    row_count: u64,
    max_time_created: i64,
    max_source_key: String,
    source_signal: String,
    last_source_key: String,
    order_signal: String,
}

#[derive(Debug)]
struct SourceRow {
    key: String,
    message_id: String,
    role: String,
    raw_json: String,
    time_created: i64,
    header_type: i64,
    ordinal: i64,
    turn_index: i64,
}

#[derive(Debug)]
struct DeferredPayloadBody {
    field_path: String,
    text: String,
}

pub(in crate::sources::imported_history::replay) fn cursor_schema_version(
    cursor_json: &str,
) -> Option<i64> {
    serde_json::from_str::<SqliteCursorVersion>(cursor_json)
        .ok()
        .map(|cursor| cursor.schema_version)
}

pub(in crate::sources::imported_history::replay) fn database_schema_version(
    path: &Path,
) -> Result<i64, String> {
    let conn = open_source_db(path)?;
    conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
        .map_err(|err| {
            format!(
                "read replay SQLite schema version {}: {err}",
                path.display()
            )
        })
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
) -> Result<SqliteSyncOutcome, String> {
    ensure_source_row_table(tx)?;
    let source_conn = open_source_db(source_path)?;
    validate_schema(&source_conn, source)?;
    let schema_version = source_conn
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("read {} schema version: {err}", source.as_str()))?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS imported_replay_seen_rows (
             source_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         DELETE FROM imported_replay_seen_rows;",
    )
    .map_err(|err| format!("prepare SQLite replay seen-row set: {err}"))?;

    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut removed_event_ids = Vec::new();
    let mut kv_order_rebuilt = false;
    let (summary, plan) = match source {
        ImportedHistorySourceId::OpenCode | ImportedHistorySourceId::MimoCode => {
            let previous_cursor = previous_row_store_cursor(previous_state, source)?;
            let summary = opencode_source_summary(&source_conn, source_session_id)?;
            let plan = opencode_sync_plan(&previous_cursor, &summary);
            if plan != SyncPlan::Skip {
                stream_opencode_family(
                    &source_conn,
                    source,
                    source_session_id,
                    (plan == SyncPlan::Append).then_some((
                        previous_cursor.max_time_created,
                        previous_cursor.max_source_key.as_str(),
                    )),
                    |row| {
                        fold_source_row(
                            tx,
                            source,
                            display_session_id,
                            source_session_id,
                            generation,
                            write_revision,
                            row,
                            &mut stats,
                            &mut changed,
                            &mut removed_event_ids,
                            &source_conn,
                            None,
                        )
                    },
                )?;
            }
            (summary, plan)
        }
        ImportedHistorySourceId::ZCode => {
            let previous_cursor = previous_row_store_cursor(previous_state, source)?;
            let summary = opencode_source_summary(&source_conn, source_session_id)?;
            let plan = opencode_sync_plan(&previous_cursor, &summary);
            if plan != SyncPlan::Skip {
                stream_opencode_family(
                    &source_conn,
                    source,
                    source_session_id,
                    (plan == SyncPlan::Append).then_some((
                        previous_cursor.max_time_created,
                        previous_cursor.max_source_key.as_str(),
                    )),
                    |row| {
                        fold_source_row(
                            tx,
                            source,
                            display_session_id,
                            source_session_id,
                            generation,
                            write_revision,
                            row,
                            &mut stats,
                            &mut changed,
                            &mut removed_event_ids,
                            &source_conn,
                            None,
                        )
                    },
                )?;
            }
            (summary, plan)
        }
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf => {
            let previous_cursor = previous_kv_store_cursor(previous_state, source)?;
            let composer_json = load_composer_json(&source_conn, source_session_id)?;
            let summary = kv_source_summary(&source_conn, source_session_id, &composer_json)?;
            let plan = kv_sync_plan(&previous_cursor, &summary);
            if plan != SyncPlan::Skip {
                let order_changed = plan == SyncPlan::Reconcile
                    && !previous_cursor.order_signal.is_empty()
                    && previous_cursor.order_signal != summary.order_signal;
                if order_changed {
                    stage_and_clear_kv_order(tx, source, source_session_id, generation)?;
                    kv_order_rebuilt = true;
                }
                let start_ordinal = if previous_cursor.source_signal.is_empty() {
                    kv_recent_turn_start(&source_conn, source_session_id, &composer_json)?
                } else if plan == SyncPlan::Append {
                    previous_cursor.total_source_rows
                } else {
                    0
                };
                stream_kv_bubbles(
                    &source_conn,
                    source_session_id,
                    &composer_json,
                    start_ordinal,
                    None,
                    |row| {
                        fold_source_row(
                            tx,
                            source,
                            display_session_id,
                            source_session_id,
                            generation,
                            write_revision,
                            row,
                            &mut stats,
                            &mut changed,
                            &mut removed_event_ids,
                            &source_conn,
                            Some(&composer_json),
                        )
                    },
                )?;
                replace_kv_turn_headers(
                    tx,
                    &source_conn,
                    source,
                    source_session_id,
                    generation,
                    &composer_json,
                )?;
            }
            (summary, plan)
        }
        _ => {
            return Err(format!(
                "{} is not a SQLite replay adapter",
                source.as_str()
            ))
        }
    };

    if kv_order_rebuilt {
        removed_event_ids.extend(kv_order_removals(
            tx,
            source,
            source_session_id,
            generation,
        )?);
    }
    if plan == SyncPlan::Reconcile {
        removed_event_ids.extend(remove_missing_rows(
            tx,
            source,
            source_session_id,
            generation,
            write_revision,
        )?);
    }
    if !removed_event_ids.is_empty() {
        stats.removed_events = removed_event_ids.len() as u64;
        changed = true;
    }
    if changed
        && !matches!(
            source,
            ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
        )
    {
        rebuild_turns(tx, source, source_session_id, generation)?;
    }
    if changed {
        delete_stale_payload_artifacts(tx, source, source_session_id, generation)?;
    }

    let total_events = if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        summary.row_count
    } else {
        count_index_rows(tx, source, source_session_id, generation)?
    };
    let total_turns = count_turns(tx, source, source_session_id, generation)?;
    let driver_cursor_json = if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        serde_json::to_string(&KvStoreReplayCursor {
            schema_version,
            total_source_rows: summary.row_count,
            max_time_created: summary.max_time_created,
            max_source_key: summary.max_source_key,
            source_signal: summary.source_signal,
            last_source_key: summary.last_source_key,
            order_signal: summary.order_signal,
        })
    } else {
        serde_json::to_string(&RowStoreReplayCursor {
            schema_version,
            total_source_rows: summary.row_count,
            max_time_created: summary.max_time_created,
            max_source_key: summary.max_source_key,
            source_signal: summary.source_signal,
            last_source_key: summary.last_source_key,
            order_signal: summary.order_signal,
        })
    }
    .map_err(|err| format!("encode {} replay cursor: {err}", source.as_str()))?;
    Ok(SqliteSyncOutcome {
        stats,
        driver_cursor_json,
        // This is a logical row watermark for SQLite, never a byte offset.
        total_events,
        total_turns,
        changed,
        removed_event_ids,
    })
}

fn previous_row_store_cursor(
    previous_state: Option<&ReplayIndexState>,
    source: ImportedHistorySourceId,
) -> Result<RowStoreReplayCursor, String> {
    previous_state
        .map(|state| {
            serde_json::from_str(&state.driver_cursor_json)
                .map_err(|err| format!("decode {} replay cursor: {err}", source.as_str()))
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

fn previous_kv_store_cursor(
    previous_state: Option<&ReplayIndexState>,
    source: ImportedHistorySourceId,
) -> Result<KvStoreReplayCursor, String> {
    previous_state
        .map(|state| {
            serde_json::from_str(&state.driver_cursor_json)
                .map_err(|err| format!("decode {} replay cursor: {err}", source.as_str()))
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn delete_stale_payload_artifacts(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_payload_artifact_refs AS ref
         WHERE ref.source=?1 AND ref.source_session_id=?2 AND ref.generation=?3
           AND NOT EXISTS (
             SELECT 1 FROM imported_replay_events AS event
             WHERE event.source=ref.source
               AND event.source_session_id=ref.source_session_id
               AND event.generation=ref.generation
               AND event.event_id=ref.event_id
           )",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("delete stale SQLite replay payload refs: {err}"))?;
    payload_artifact::delete_orphans(tx, source, source_session_id, generation)
}

fn open_source_db(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("open replay SQLite source {}: {err}", path.display()))
}

fn validate_schema(conn: &Connection, source: ImportedHistorySourceId) -> Result<(), String> {
    let sql = match source {
        ImportedHistorySourceId::OpenCode
        | ImportedHistorySourceId::MimoCode
        | ImportedHistorySourceId::ZCode => {
            "SELECT p.id, p.message_id, p.session_id, p.time_created, p.data, m.data
             FROM part p JOIN message m ON m.id=p.message_id LIMIT 0"
        }
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf => {
            "SELECT key, value FROM cursorDiskKV LIMIT 0"
        }
        _ => return Err(format!("{} has no SQLite schema", source.as_str())),
    };
    conn.prepare(sql).map(|_| ()).map_err(|err| {
        format!(
            "Unsupported {} replay schema (bounded adapter will not fall back): {err}",
            source.as_str()
        )
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "SQLite row projection keeps provider identity, ordering, and compact payload inputs explicit"
)]
fn fold_source_row(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    row: SourceRow,
    stats: &mut ReplayStats,
    changed: &mut bool,
    removed_event_ids: &mut Vec<String>,
    source_conn: &Connection,
    composer_json: Option<&str>,
) -> Result<(), String> {
    if row.key.trim().is_empty() {
        return Err(format!(
            "{} replay row has no stable key; refusing rowid fallback",
            source.as_str()
        ));
    }
    let raw_hash = content_digest(&[
        row.key.as_bytes(),
        row.message_id.as_bytes(),
        row.role.as_bytes(),
        row.raw_json.as_bytes(),
        &row.time_created.to_le_bytes(),
        &row.header_type.to_le_bytes(),
    ]);
    tx.execute(
        "INSERT OR IGNORE INTO imported_replay_seen_rows(source_key) VALUES (?1)",
        [&row.key],
    )
    .map_err(|err| format!("mark SQLite replay row seen: {err}"))?;
    let previous = tx
        .query_row(
            "SELECT content_hash, event_id, sequence FROM imported_replay_source_rows
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
            params![source.as_str(), source_session_id, generation, row.key],
            |db_row| {
                Ok((
                    db_row.get::<_, String>(0)?,
                    db_row.get::<_, Option<String>>(1)?,
                    db_row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("read SQLite replay source-row hash: {err}"))?;
    if previous
        .as_ref()
        .is_some_and(|(hash, _, _)| hash == &raw_hash)
    {
        return Ok(());
    }

    stats.parsed_rows = stats.parsed_rows.saturating_add(1);
    stats.parsed_bytes = stats.parsed_bytes.saturating_add(row.raw_json.len() as u64);
    let sequence = if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        row.ordinal
    } else {
        match previous.as_ref().and_then(|(_, _, sequence)| *sequence) {
            Some(sequence) => sequence,
            None => next_sequence(tx, source, source_session_id, generation)?,
        }
    };
    let bubble_id = row.key.rsplit(':').next().unwrap_or(row.key.as_str());
    let normalized = match source {
        ImportedHistorySourceId::OpenCode => {
            crate::sources::opencode::history::replay_chunk_from_part_json(
                display_session_id,
                "opencode",
                sequence.max(0) as usize,
                row.key.clone(),
                row.message_id.clone(),
                row.role.clone(),
                &row.raw_json,
                row.time_created,
            )?
        }
        ImportedHistorySourceId::MimoCode => {
            crate::sources::opencode::history::replay_chunk_from_part_json(
                display_session_id,
                "mimo_code",
                sequence.max(0) as usize,
                row.key.clone(),
                row.message_id.clone(),
                row.role.clone(),
                &row.raw_json,
                row.time_created,
            )?
        }
        ImportedHistorySourceId::ZCode => {
            crate::sources::zcode::history::replay_chunk_from_part_json(
                display_session_id,
                sequence.max(0) as usize,
                row.key.clone(),
                row.message_id.clone(),
                row.role.clone(),
                &row.raw_json,
                row.time_created,
            )?
        }
        ImportedHistorySourceId::CursorIde => {
            crate::sources::cursor_ide::history::replay_chunk_from_bubble_json(
                source_conn,
                display_session_id,
                bubble_id,
                row.header_type,
                &row.raw_json,
                composer_json.unwrap_or("{}"),
            )?
        }
        ImportedHistorySourceId::Windsurf => {
            crate::sources::windsurf::history::replay_chunk_from_bubble_json(
                source_conn,
                display_session_id,
                sequence.max(0) as usize,
                bubble_id,
                row.header_type,
                &row.raw_json,
            )?
        }
        _ => None,
    };

    let old_event_id = previous
        .as_ref()
        .and_then(|(_, event_id, _)| event_id.clone());
    let mut event_id = None;
    if let Some(mut chunk) = normalized {
        chunk.chunk_id = stable_event_id(source, &row.key);
        payload_artifact::delete_event_refs(
            tx,
            source,
            source_session_id,
            generation,
            &chunk.chunk_id,
        )?;
        let (payloads, deferred_bodies) = compact_chunk_with_bodies(&mut chunk, &row.key);
        upsert_event(
            tx,
            source,
            source_session_id,
            generation,
            write_revision,
            sequence,
            row.turn_index,
            row.ordinal,
            &chunk,
            &payloads,
            &raw_hash,
        )?;
        for body in deferred_bodies {
            payload_artifact::store_text(
                tx,
                source,
                source_session_id,
                generation,
                &chunk.chunk_id,
                &body.field_path,
                &body.text,
            )?;
        }
        event_id = Some(chunk.chunk_id.clone());
        stats.normalized_events = stats.normalized_events.saturating_add(1);
        stats.upserted_events = stats.upserted_events.saturating_add(1);
        *changed = true;
    } else if let Some(old_event_id) = old_event_id {
        tx.execute(
            "DELETE FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![source.as_str(), source_session_id, generation, old_event_id],
        )
        .map_err(|err| format!("remove no-longer-renderable replay event: {err}"))?;
        stats.removed_events = stats.removed_events.saturating_add(1);
        removed_event_ids.push(old_event_id);
        *changed = true;
    }
    tx.execute(
        "INSERT INTO imported_replay_source_rows(
             source, source_session_id, generation, source_key, content_hash,
             event_id, sequence, source_order, seen_revision
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(source,source_session_id,generation,source_key) DO UPDATE SET
             content_hash=excluded.content_hash,event_id=excluded.event_id,
             sequence=excluded.sequence,source_order=excluded.source_order,
             seen_revision=excluded.seen_revision",
        params![
            source.as_str(),
            source_session_id,
            generation,
            row.key,
            raw_hash,
            event_id,
            sequence,
            row.ordinal,
            write_revision.min(i64::MAX as u64) as i64,
        ],
    )
    .map_err(|err| format!("publish SQLite replay source-row hash: {err}"))?;
    Ok(())
}

fn ensure_source_row_table(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS imported_replay_source_rows (
             source TEXT NOT NULL,
             source_session_id TEXT NOT NULL,
             generation TEXT NOT NULL,
             source_key TEXT NOT NULL,
             content_hash TEXT NOT NULL,
             event_id TEXT,
             sequence INTEGER,
             source_order INTEGER NOT NULL,
             seen_revision INTEGER NOT NULL,
             PRIMARY KEY(source, source_session_id, generation, source_key)
         );
         CREATE INDEX IF NOT EXISTS idx_imported_replay_source_rows_seen
             ON imported_replay_source_rows(
                 source, source_session_id, generation, seen_revision
             );",
    )
    .map_err(|err| format!("create SQLite replay source-row index: {err}"))
}

fn next_sequence(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<i64, String> {
    tx.query_row(
        "SELECT COALESCE(MAX(sequence), -1)+1 FROM imported_replay_source_rows
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
        |row| row.get(0),
    )
    .map_err(|err| format!("allocate SQLite replay sequence: {err}"))
}

/// Reordering stable KV keys can swap two occupied `sequence` primary keys.
/// Stage the previous ids in SQLite, then rebuild rows inside the same ORGII
/// transaction so no session-sized Rust vector or half-reordered index is
/// observable.
#[cfg(test)]
fn compact_chunk(chunk: &mut ActivityChunk, source_key: &str) -> Vec<ReplayPayloadDescriptor> {
    compact_chunk_with_bodies(chunk, source_key).0
}

fn compact_chunk_with_bodies(
    chunk: &mut ActivityChunk,
    source_key: &str,
) -> (Vec<ReplayPayloadDescriptor>, Vec<DeferredPayloadBody>) {
    let mut payloads = Vec::new();
    let mut deferred_bodies = Vec::new();
    let encoded_args = serde_json::to_string(&chunk.args).unwrap_or_else(|_| "null".to_string());
    let (git_artifacts, exact_result_body) =
        if chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE {
            let encoded_result =
                serde_json::to_string(&chunk.result).unwrap_or_else(|_| "null".to_string());
            let artifacts = parse_git_artifacts_from_tool_payload(&encoded_args, &encoded_result);
            let exact_result_body = (!artifacts.is_empty()).then_some(encoded_result);
            (artifacts, exact_result_body)
        } else {
            (Vec::new(), None)
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
    let result_fields: &[(&str, ReplayPayloadKind)] = match chunk.function.as_str() {
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
    for &(path, kind) in result_fields {
        if let Some(text) = value_at_path_mut(&mut chunk.result, path.trim_start_matches("result."))
        {
            if text.len() > result_limit {
                let total_bytes = text.len() as u64;
                *text = head_preview(text, result_limit);
                payloads.push(sqlite_payload_descriptor(
                    path,
                    kind,
                    ReplayPayloadEncoding::Utf8Text,
                    None,
                    source_key,
                    total_bytes,
                ));
            }
        }
    }
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
        let mut compact = serde_json::Map::new();
        compact.insert("_replayTruncated".to_string(), Value::Bool(true));
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
                    compact.insert(
                        key.to_string(),
                        Value::String(head_preview(&full_text, args_limit)),
                    );
                } else {
                    compact.insert(key.to_string(), Value::String(text.clone()));
                }
            } else if value.is_number() || value.is_boolean() || value.is_null() {
                compact.insert(key.to_string(), value.clone());
            }
        }
        if compact.len() == 1 {
            compact.insert(
                "_preview".to_string(),
                Value::String(head_preview(&encoded_args, args_limit)),
            );
        }
        chunk.args = Value::Object(compact);
        // The compact object keeps cheap semantic scalars, but it is not a
        // lossless copy of the normalized arguments. One root descriptor is
        // canonical so hydration cannot leave an omitted sibling or compact
        // marker behind after applying nested fields.
        payloads.retain(|payload| !field_path_is_under(&payload.field_path, "args"));
        payloads.push(sqlite_artifact_payload_descriptor(
            "args",
            ReplayPayloadKind::ToolArguments,
            args_body_projection,
            args_size as u64,
        ));
        deferred_bodies.push(DeferredPayloadBody {
            field_path: "args".to_string(),
            text: encoded_args,
        });
    }
    attach_replay_git_artifacts(&mut chunk.result, &git_artifacts);
    if let Some(exact_result_body) = exact_result_body.filter(|_| chunk.result.is_object()) {
        // `_replayGitArtifacts` is compact projection metadata. A canonical
        // root result keeps it available to metadata projection without
        // leaking it into a hydrated legacy transcript or export.
        payloads.retain(|payload| !field_path_is_under(&payload.field_path, "result"));
        payloads.push(sqlite_artifact_payload_descriptor(
            "result",
            ReplayPayloadKind::ToolOutput,
            result_body_projection,
            exact_result_body.len() as u64,
        ));
        deferred_bodies.retain(|body| !field_path_is_under(&body.field_path, "result"));
        deferred_bodies.push(DeferredPayloadBody {
            field_path: "result".to_string(),
            text: exact_result_body,
        });
    }
    (payloads, deferred_bodies)
}

fn sqlite_payload_descriptor(
    field_path: &str,
    kind: ReplayPayloadKind,
    encoding: ReplayPayloadEncoding,
    body_projection: Option<ReplayPayloadBodyProjection>,
    source_key: &str,
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
        source_key: Some(source_key.to_string()),
    }
}

fn sqlite_artifact_payload_descriptor(
    field_path: &str,
    kind: ReplayPayloadKind,
    body_projection: Option<ReplayPayloadBodyProjection>,
    total_bytes: u64,
) -> ReplayPayloadDescriptor {
    ReplayPayloadDescriptor {
        field_path: field_path.to_string(),
        kind,
        encoding: ReplayPayloadEncoding::JsonValue,
        body_projection,
        spans: Vec::new(),
        total_bytes,
        source_ordinal: None,
        // Provider normalization can wrap/rename raw SQLite JSON. The exact
        // root body therefore lives only in the generation-scoped artifact.
        source_key: None,
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn upsert_event(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    sequence: i64,
    turn_index: i64,
    source_order: i64,
    chunk: &ActivityChunk,
    payloads: &[ReplayPayloadDescriptor],
    content_hash: &str,
) -> Result<(), String> {
    let args = serde_json::to_string(&chunk.args).map_err(|err| err.to_string())?;
    let result = serde_json::to_string(&chunk.result).map_err(|err| err.to_string())?;
    let payloads = serde_json::to_string(payloads).map_err(|err| err.to_string())?;
    tx.execute(
        "INSERT INTO imported_replay_events(
             source,source_session_id,generation,sequence,event_id,turn_index,
             action_type,function_name,created_at,args_preview_json,result_preview_json,
             args_size_bytes,result_size_bytes,thread_id,process_id,source_start,
             source_end,payloads_json,content_hash,event_revision
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16,?17,?18,?19)
         ON CONFLICT(source,source_session_id,generation,event_id) DO UPDATE SET
             sequence=excluded.sequence,turn_index=excluded.turn_index,
             action_type=excluded.action_type,
             function_name=excluded.function_name,created_at=excluded.created_at,
             args_preview_json=excluded.args_preview_json,
             result_preview_json=excluded.result_preview_json,
             args_size_bytes=excluded.args_size_bytes,
             result_size_bytes=excluded.result_size_bytes,
             thread_id=excluded.thread_id,process_id=excluded.process_id,
             source_start=excluded.source_start,source_end=excluded.source_end,
             payloads_json=excluded.payloads_json,content_hash=excluded.content_hash,
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
            args,
            result,
            serde_json::to_vec(&chunk.args).map_or(0, |v| v.len()) as i64,
            serde_json::to_vec(&chunk.result).map_or(0, |v| v.len()) as i64,
            chunk.thread_id,
            chunk.process_id,
            source_order,
            payloads,
            content_hash,
            write_revision.min(i64::MAX as u64) as i64,
        ],
    )
    .map_err(|err| format!("upsert {} replay event: {err}", source.as_str()))?;
    Ok(())
}

fn insert_turn_header(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    turn_index: i64,
    header: (String, i64, i64, String, String, u64),
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO imported_replay_turns(source,source_session_id,generation,turn_index,
             turn_id,start_sequence,end_sequence,started_at,ended_at,event_count)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            source.as_str(),
            source_session_id,
            generation,
            turn_index,
            header.0,
            header.1,
            header.2,
            header.3,
            header.4,
            header.5 as i64
        ],
    )
    .map_err(|err| format!("insert {} replay turn header: {err}", source.as_str()))?;
    Ok(())
}

fn count_index_rows(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    session: &str,
    generation: &str,
) -> Result<u64, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM imported_replay_events WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), session, generation], |row| row.get::<_, i64>(0),
    ).map(|count| count.max(0) as u64).map_err(|err| err.to_string())
}

fn count_turns(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    session: &str,
    generation: &str,
) -> Result<u64, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM imported_replay_turns WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), session, generation], |row| row.get::<_, i64>(0),
    ).map(|count| count.max(0) as u64).map_err(|err| err.to_string())
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
    let payloads: Vec<ReplayPayloadDescriptor> = serde_json::from_str(payloads_json)
        .map_err(|err| format!("decode {} payload locator: {err}", source.as_str()))?;
    let descriptor = payloads
        .into_iter()
        .find(|payload| payload.field_path == field_path)
        .ok_or_else(|| format!("No deferred replay payload for {field_path}"))?;
    let source_key = descriptor
        .source_key
        .ok_or_else(|| "SQLite replay payload has no stable source key".to_string())?;
    let conn = open_source_db(source_path)?;
    let (table, key_column, expression) =
        payload_sql(source, descriptor.kind, &descriptor.field_path)?;
    let sql = format!(
        "SELECT length(CAST(({expression}) AS BLOB)),
                substr(CAST(({expression}) AS BLOB), ?2, ?3)
         FROM {table} AS source_row WHERE source_row.{key_column}=?1"
    );
    let requested = offset.min(descriptor.total_bytes);
    let (total, bytes): (i64, Vec<u8>) = conn
        .query_row(
            &sql,
            params![
                source_key,
                requested.saturating_add(1) as i64,
                max_bytes as i64 + 4
            ],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<Vec<u8>>>(1)?.unwrap_or_default(),
                ))
            },
        )
        .map_err(|err| format!("read {} replay payload range: {err}", source.as_str()))?;
    let mut leading = 0_usize;
    while leading < bytes.len() && (bytes[leading] & 0b1100_0000) == 0b1000_0000 {
        leading += 1;
    }
    let actual_offset = requested.saturating_add(leading as u64);
    let available = &bytes[leading..];
    let mut usable = available.len().min(max_bytes);
    while usable > 0 && std::str::from_utf8(&available[..usable]).is_err() {
        usable -= 1;
    }
    let text = String::from_utf8(available[..usable].to_vec())
        .map_err(|err| format!("decode SQLite replay payload UTF-8: {err}"))?;
    let total_bytes = total.max(0) as u64;
    let next_offset = actual_offset.saturating_add(usable as u64).min(total_bytes);
    Ok(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: actual_offset,
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    })
}

fn payload_sql(
    source: ImportedHistorySourceId,
    kind: ReplayPayloadKind,
    field_path: &str,
) -> Result<(&'static str, &'static str, &'static str), String> {
    let expression = match (source, kind) {
        (ImportedHistorySourceId::OpenCode | ImportedHistorySourceId::MimoCode | ImportedHistorySourceId::ZCode, ReplayPayloadKind::UserMessage | ReplayPayloadKind::AgentMessage | ReplayPayloadKind::AssistantContent | ReplayPayloadKind::Reasoning) => "COALESCE(json_extract(data, '$.text'), '')",
        (ImportedHistorySourceId::OpenCode | ImportedHistorySourceId::MimoCode | ImportedHistorySourceId::ZCode, ReplayPayloadKind::ToolOutput) => "COALESCE(NULLIF(json_extract(data, '$.state.output'), ''), json_extract(data, '$.state.metadata.output'), '')",
        (ImportedHistorySourceId::OpenCode | ImportedHistorySourceId::MimoCode | ImportedHistorySourceId::ZCode, ReplayPayloadKind::ToolArguments) => match field_path.rsplit('.').next().unwrap_or_default() {
            "command" | "cmd" => "COALESCE(json_extract(data, '$.state.input.command'), json_extract(data, '$.state.input.cmd'), '')",
            "path" => "COALESCE(json_extract(data, '$.state.input.path'), '')",
            "file_path" | "filePath" => "COALESCE(json_extract(data, '$.state.input.file_path'), json_extract(data, '$.state.input.filePath'), json_extract(data, '$.state.input.path'), '')",
            "action" => "COALESCE(json_extract(data, '$.state.input.action'), '')",
            "query" => "COALESCE(json_extract(data, '$.state.input.query'), '')",
            "pattern" => "COALESCE(json_extract(data, '$.state.input.pattern'), '')",
            _ => "COALESCE(json_extract(data, '$.state.input'), '{}')",
        },
        (ImportedHistorySourceId::OpenCode | ImportedHistorySourceId::MimoCode | ImportedHistorySourceId::ZCode, ReplayPayloadKind::ToolDiff) if field_path.ends_with("old_content") => "COALESCE(json_extract(data, '$.state.metadata.old_content'), json_extract(data, '$.state.metadata.before'), '')",
        (ImportedHistorySourceId::OpenCode | ImportedHistorySourceId::MimoCode | ImportedHistorySourceId::ZCode, ReplayPayloadKind::ToolDiff) => "COALESCE(json_extract(data, '$.state.metadata.new_content'), json_extract(data, '$.state.metadata.after'), '')",
        (ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf, ReplayPayloadKind::UserMessage | ReplayPayloadKind::AgentMessage | ReplayPayloadKind::AssistantContent | ReplayPayloadKind::Reasoning) => "COALESCE(json_extract(value, '$.text'), '')",
        (ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf, ReplayPayloadKind::ToolOutput) => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.result')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.result'), '$.output'), json_extract(json_extract(value, '$.toolFormerData.result'), '$.observation'), json_extract(json_extract(value, '$.toolFormerData.result'), '$.content'), json_extract(value, '$.toolFormerData.result'), '') ELSE COALESCE(json_extract(value, '$.toolFormerData.result'), '') END",
        (ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf, ReplayPayloadKind::ToolArguments) => match field_path.rsplit('.').next().unwrap_or_default() {
            "command" | "cmd" => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.params')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.params'), '$.command'), json_extract(json_extract(value, '$.toolFormerData.params'), '$.cmd'), '') ELSE '' END",
            "path" => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.params')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.params'), '$.path'), '') ELSE '' END",
            "file_path" | "filePath" => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.params')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.params'), '$.file_path'), json_extract(json_extract(value, '$.toolFormerData.params'), '$.filePath'), json_extract(json_extract(value, '$.toolFormerData.params'), '$.targetFile'), '') ELSE '' END",
            "action" => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.params')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.params'), '$.action'), '') ELSE '' END",
            "query" => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.params')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.params'), '$.query'), '') ELSE '' END",
            "pattern" => "CASE WHEN json_valid(json_extract(value, '$.toolFormerData.params')) THEN COALESCE(json_extract(json_extract(value, '$.toolFormerData.params'), '$.pattern'), json_extract(json_extract(value, '$.toolFormerData.params'), '$.globPattern'), '') ELSE '' END",
            _ => "COALESCE(json_extract(value, '$.toolFormerData.params'), '{}')",
        },
        (ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf, ReplayPayloadKind::ToolDiff) if field_path.ends_with("old_content") => "CASE WHEN json_valid(json_extract(source_row.value, '$.toolFormerData.result')) THEN COALESCE((SELECT blob.value FROM cursorDiskKV AS blob WHERE blob.key=json_extract(json_extract(source_row.value, '$.toolFormerData.result'), '$.beforeContentId')), json_extract(json_extract(source_row.value, '$.toolFormerData.result'), '$.old_content'), '') ELSE '' END",
        (ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf, ReplayPayloadKind::ToolDiff) => "CASE WHEN json_valid(json_extract(source_row.value, '$.toolFormerData.result')) THEN COALESCE((SELECT blob.value FROM cursorDiskKV AS blob WHERE blob.key=json_extract(json_extract(source_row.value, '$.toolFormerData.result'), '$.afterContentId')), json_extract(json_extract(source_row.value, '$.toolFormerData.result'), '$.new_content'), '') ELSE '' END",
        _ => return Err(format!("Unsupported {} SQLite payload kind", source.as_str())),
    };
    Ok(match source {
        ImportedHistorySourceId::OpenCode
        | ImportedHistorySourceId::MimoCode
        | ImportedHistorySourceId::ZCode => ("part", "id", expression),
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf => {
            ("cursorDiskKV", "key", expression)
        }
        _ => {
            return Err(format!(
                "{} is not a SQLite payload source",
                source.as_str()
            ))
        }
    })
}

#[cfg(test)]
#[path = "../../tests/sqlite_driver.rs"]
mod tests;
