//! Incremental SQLite replay drivers for imported history stores.
//!
//! Provider databases are opened read-only (including their WAL view). Rows
//! are folded one at a time into ORGII's compact replay index. A persistent
//! source-row hash table lets an unchanged poll avoid JSON parsing and event
//! upserts even when a WAL checkpoint changed the physical files.

use std::collections::HashMap;
use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::development_artifact::{
    attach_replay_git_artifacts, parse_git_artifacts_from_tool_payload,
};
use crate::sources::imported_history::{self, replay::ImportedHistorySourceId};

use super::index::ReplayIndexState;
use super::payload_artifact;
use super::{
    replay_payload_body_projection, ReplayPayloadBodyProjection, ReplayPayloadDescriptor,
    ReplayPayloadEncoding, ReplayPayloadKind, ReplayPayloadRange, ReplayStats,
    NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

#[derive(Debug, Clone)]
pub(super) struct SqliteSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub total_events: u64,
    pub total_turns: u64,
    pub changed: bool,
    pub removed_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SqliteDriverCursor {
    schema_version: i64,
    total_source_rows: u64,
    max_time_created: i64,
    max_source_key: String,
    source_signal: String,
    last_source_key: String,
    #[serde(default)]
    order_signal: String,
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

pub(super) fn cursor_schema_version(cursor_json: &str) -> Option<i64> {
    serde_json::from_str::<SqliteDriverCursor>(cursor_json)
        .ok()
        .map(|cursor| cursor.schema_version)
}

pub(super) fn database_schema_version(path: &Path) -> Result<i64, String> {
    let conn = open_source_db(path)?;
    conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
        .map_err(|err| {
            format!(
                "read replay SQLite schema version {}: {err}",
                path.display()
            )
        })
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
) -> Result<SqliteSyncOutcome, String> {
    ensure_source_row_table(tx)?;
    let source_conn = open_source_db(source_path)?;
    validate_schema(&source_conn, source)?;
    let schema_version = source_conn
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("read {} schema version: {err}", source.as_str()))?;
    let previous_cursor = previous_state
        .map(|state| {
            serde_json::from_str::<SqliteDriverCursor>(&state.driver_cursor_json)
                .map_err(|err| format!("decode {} replay cursor: {err}", source.as_str()))
        })
        .transpose()?
        .unwrap_or_default();

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
                    kv_recent_turn_start(&composer_json)?
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
                replace_kv_turn_headers(tx, source, source_session_id, generation, &composer_json)?;
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
    let cursor = SqliteDriverCursor {
        schema_version,
        total_source_rows: summary.row_count,
        max_time_created: summary.max_time_created,
        max_source_key: summary.max_source_key,
        source_signal: summary.source_signal,
        last_source_key: summary.last_source_key,
        order_signal: summary.order_signal,
    };
    Ok(SqliteSyncOutcome {
        stats,
        driver_cursor_json: serde_json::to_string(&cursor)
            .map_err(|err| format!("encode {} replay cursor: {err}", source.as_str()))?,
        // This is a logical row watermark for SQLite, never a byte offset.
        total_events,
        total_turns,
        changed,
        removed_event_ids,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn hydrate_kv_turn(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    start_sequence: i64,
    end_sequence: i64,
) -> Result<ReplayStats, String> {
    if !matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return Err(format!(
            "{} is not a SQLite/KV replay source",
            source.as_str()
        ));
    }
    ensure_source_row_table(tx)?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS imported_replay_seen_rows(
             source_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         DELETE FROM imported_replay_seen_rows;",
    )
    .map_err(|err| format!("prepare lazy KV replay row set: {err}"))?;
    let source_conn = open_source_db(source_path)?;
    validate_schema(&source_conn, source)?;
    let composer_json = load_composer_json(&source_conn, source_session_id)?;
    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut removed = Vec::new();
    stream_kv_bubbles(
        &source_conn,
        source_session_id,
        &composer_json,
        start_sequence.max(0) as u64,
        Some(end_sequence.max(start_sequence).max(0) as u64),
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
                &mut removed,
                &source_conn,
                Some(&composer_json),
            )
        },
    )?;
    if changed {
        delete_stale_payload_artifacts(tx, source, source_session_id, generation)?;
    }
    Ok(stats)
}

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

fn opencode_source_summary(
    conn: &Connection,
    source_session_id: &str,
) -> Result<SqliteSourceSummary, String> {
    let row_count = conn
        .query_row(
            "SELECT COUNT(*) FROM part WHERE session_id=?1",
            [source_session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count SQLite replay parts: {err}"))?
        .max(0) as u64;
    let (max_time_created, max_source_key) = conn
        .query_row(
            "SELECT COALESCE(time_created,0), COALESCE(id,'') FROM part
             WHERE session_id=?1 ORDER BY time_created DESC,id DESC LIMIT 1",
            [source_session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("read SQLite replay part watermark: {err}"))?
        .unwrap_or_default();
    let session_signal = conn
        .query_row(
            "SELECT COALESCE(time_updated, time_created, 0) FROM session WHERE id=?1",
            [source_session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("read SQLite replay session signal: {err}"))?
        .unwrap_or_default()
        .to_string();
    Ok(SqliteSourceSummary {
        row_count,
        max_time_created,
        max_source_key: max_source_key.clone(),
        source_signal: session_signal,
        last_source_key: max_source_key,
        order_signal: String::new(),
    })
}

fn opencode_sync_plan(previous: &SqliteDriverCursor, current: &SqliteSourceSummary) -> SyncPlan {
    if previous.source_signal.is_empty() {
        return SyncPlan::Reconcile;
    }
    if current.row_count == previous.total_source_rows
        && current.max_time_created == previous.max_time_created
        && current.max_source_key == previous.max_source_key
        && current.source_signal == previous.source_signal
    {
        return SyncPlan::Skip;
    }
    let watermark_advanced = (current.max_time_created, current.max_source_key.as_str())
        > (previous.max_time_created, previous.max_source_key.as_str());
    if current.row_count > previous.total_source_rows && watermark_advanced {
        SyncPlan::Append
    } else {
        SyncPlan::Reconcile
    }
}

fn stream_opencode_family(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    after: Option<(i64, &str)>,
    mut visit: impl FnMut(SourceRow) -> Result<(), String>,
) -> Result<(), String> {
    let (after_time, after_key) = after.unwrap_or((i64::MIN, ""));
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.message_id, COALESCE(json_extract(m.data, '$.role'), ''),
                    p.data, COALESCE(p.time_created, 0)
             FROM part p JOIN message m ON m.id=p.message_id
             WHERE p.session_id=?1
               AND (p.time_created>?2 OR (p.time_created=?2 AND p.id>?3))
             ORDER BY p.time_created ASC, p.id ASC",
        )
        .map_err(|err| format!("prepare {} replay row stream: {err}", source.as_str()))?;
    let mut rows = stmt
        .query(params![source_session_id, after_time, after_key])
        .map_err(|err| format!("query {} replay rows: {err}", source.as_str()))?;
    let mut ordinal = 0_i64;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("stream {} replay row: {err}", source.as_str()))?
    {
        let Some(raw_json) = row
            .get::<_, Option<String>>(3)
            .map_err(|err| format!("read {} replay JSON: {err}", source.as_str()))?
        else {
            continue;
        };
        visit(SourceRow {
            key: row
                .get::<_, Option<String>>(0)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            message_id: row
                .get::<_, Option<String>>(1)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            role: row
                .get::<_, Option<String>>(2)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            raw_json,
            time_created: row
                .get::<_, Option<i64>>(4)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            header_type: 0,
            ordinal,
            turn_index: 0,
        })?;
        ordinal += 1;
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct KvComposerOrder {
    full_conversation_headers_only: Vec<KvHeader>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct KvHeader {
    bubble_id: String,
    #[serde(rename = "type")]
    bubble_type: i64,
}

fn kv_source_summary(
    conn: &Connection,
    composer_id: &str,
    composer_json: &str,
) -> Result<SqliteSourceSummary, String> {
    let prefix = format!("bubbleId:{composer_id}:");
    let upper = format!("bubbleId:{composer_id};");
    let row_count = conn
        .query_row(
            "SELECT COUNT(*) FROM cursorDiskKV WHERE key>=?1 AND key<?2",
            params![prefix, upper],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count replay KV bubbles: {err}"))?
        .max(0) as u64;
    let composer = serde_json::from_str::<KvComposerOrder>(composer_json)
        .map_err(|err| format!("parse replay KV composer summary: {err}"))?;
    let last_source_key = composer
        .full_conversation_headers_only
        .iter()
        .rev()
        .find(|header| !header.bubble_id.trim().is_empty())
        .map(|header| format!("bubbleId:{composer_id}:{}", header.bubble_id))
        .unwrap_or_default();
    let mut order_hash = StableHash::new();
    for header in &composer.full_conversation_headers_only {
        order_hash.write(&(header.bubble_id.len() as u64).to_le_bytes());
        order_hash.write(header.bubble_id.as_bytes());
        order_hash.write(&header.bubble_type.to_le_bytes());
    }
    Ok(SqliteSourceSummary {
        row_count,
        max_time_created: 0,
        max_source_key: String::new(),
        source_signal: hash_parts(&[composer_json.as_bytes()]),
        last_source_key,
        order_signal: order_hash.finish_hex(),
    })
}

fn kv_sync_plan(previous: &SqliteDriverCursor, current: &SqliteSourceSummary) -> SyncPlan {
    if previous.source_signal.is_empty() {
        return SyncPlan::Reconcile;
    }
    if current.row_count == previous.total_source_rows
        && current.source_signal == previous.source_signal
    {
        return SyncPlan::Skip;
    }
    if current.row_count > previous.total_source_rows
        && (previous.total_source_rows == 0
            || (!previous.last_source_key.is_empty()
                && previous.last_source_key != current.last_source_key))
    {
        SyncPlan::Append
    } else {
        SyncPlan::Reconcile
    }
}

fn kv_recent_turn_start(composer_json: &str) -> Result<u64, String> {
    let composer = serde_json::from_str::<KvComposerOrder>(composer_json)
        .map_err(|err| format!("parse replay KV recent turn: {err}"))?;
    Ok(composer
        .full_conversation_headers_only
        .iter()
        .rposition(|header| header.bubble_type == 1)
        .unwrap_or(0) as u64)
}

fn replace_kv_turn_headers(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    composer_json: &str,
) -> Result<(), String> {
    let composer = serde_json::from_str::<KvComposerOrder>(composer_json)
        .map_err(|err| format!("parse {} compact turn headers: {err}", source.as_str()))?;
    tx.execute(
        "DELETE FROM imported_replay_turns
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("clear {} compact turn headers: {err}", source.as_str()))?;
    let headers = composer.full_conversation_headers_only;
    let user_starts = headers
        .iter()
        .enumerate()
        .filter(|(_, header)| header.bubble_type == 1)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if user_starts.is_empty() && !headers.is_empty() {
        insert_turn_header(
            tx,
            source,
            source_session_id,
            generation,
            0,
            (
                format!("{}-turn-0", source.as_str()),
                0,
                headers.len().saturating_sub(1) as i64,
                "1970-01-01T00:00:00Z".to_string(),
                "1970-01-01T00:00:00Z".to_string(),
                headers.len() as u64,
            ),
        )?;
        return Ok(());
    }
    for (turn_index, start) in user_starts.iter().copied().enumerate() {
        let end = user_starts
            .get(turn_index + 1)
            .copied()
            .unwrap_or(headers.len())
            .saturating_sub(1);
        let turn_id = headers[start].bubble_id.clone();
        insert_turn_header(
            tx,
            source,
            source_session_id,
            generation,
            turn_index as i64,
            (
                turn_id,
                start as i64,
                end as i64,
                "1970-01-01T00:00:00Z".to_string(),
                "1970-01-01T00:00:00Z".to_string(),
                end.saturating_sub(start).saturating_add(1) as u64,
            ),
        )?;
    }
    Ok(())
}

fn load_composer_json(conn: &Connection, composer_id: &str) -> Result<String, String> {
    let key = format!("composerData:{composer_id}");
    conn.query_row(
        "SELECT value FROM cursorDiskKV WHERE key=?1",
        [key],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|err| format!("read replay composer {composer_id}: {err}"))?
    .flatten()
    .ok_or_else(|| format!("Replay composer {composer_id} is missing"))
}

fn stream_kv_bubbles(
    conn: &Connection,
    composer_id: &str,
    composer_json: &str,
    start_ordinal: u64,
    end_ordinal: Option<u64>,
    mut visit: impl FnMut(SourceRow) -> Result<(), String>,
) -> Result<(), String> {
    let composer = serde_json::from_str::<KvComposerOrder>(composer_json)
        .map_err(|err| format!("parse replay composer {composer_id}: {err}"))?;
    let mut seen = HashMap::new();
    let mut ordinal = 0_i64;
    let mut turn_index = -1_i64;
    for header in composer.full_conversation_headers_only {
        if header.bubble_id.trim().is_empty() || seen.contains_key(&header.bubble_id) {
            continue;
        }
        let key = format!("bubbleId:{composer_id}:{}", header.bubble_id);
        if header.bubble_type == 1 || turn_index < 0 {
            turn_index += 1;
        }
        seen.insert(header.bubble_id.clone(), ());
        if (ordinal as u64) < start_ordinal {
            ordinal += 1;
            continue;
        }
        if end_ordinal.is_some_and(|end| ordinal as u64 > end) {
            break;
        }
        let value = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key=?1",
                [&key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| format!("read replay bubble {}: {err}", header.bubble_id))?
            .flatten();
        if let Some(raw_json) = value {
            visit(SourceRow {
                key,
                message_id: String::new(),
                role: String::new(),
                raw_json,
                time_created: 0,
                header_type: header.bubble_type,
                ordinal,
                turn_index: turn_index.max(0),
            })?;
            ordinal += 1;
        }
    }

    // Cursor can persist bubbles before updating composerData. Preserve the
    // existing reader's fallback by streaming those rows after header entries.
    let prefix = format!("bubbleId:{composer_id}:");
    let upper = format!("bubbleId:{composer_id};");
    let mut stmt = conn
        .prepare(
            "SELECT key, COALESCE(json_extract(value, '$.type'), 0)
             FROM cursorDiskKV WHERE key>=?1 AND key<?2 ORDER BY
             COALESCE(json_extract(value, '$.createdAt'), ''), key",
        )
        .map_err(|err| format!("prepare replay KV fallback: {err}"))?;
    let mut rows = stmt
        .query([prefix.as_str(), upper.as_str()])
        .map_err(|err| format!("query replay KV fallback: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("stream replay KV fallback: {err}"))?
    {
        let key: String = row.get(0).map_err(|err| err.to_string())?;
        let bubble_id = key.rsplit(':').next().unwrap_or_default();
        if bubble_id.is_empty() || bubble_id == "undefined" || seen.contains_key(bubble_id) {
            continue;
        }
        if (ordinal as u64) < start_ordinal {
            ordinal += 1;
            continue;
        }
        if end_ordinal.is_some_and(|end| ordinal as u64 > end) {
            break;
        }
        let raw_json = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key=?1",
                [&key],
                |value_row| value_row.get::<_, Option<String>>(0),
            )
            .map_err(|err| format!("read fallback replay KV bubble {key}: {err}"))?
            .unwrap_or_default();
        visit(SourceRow {
            key,
            message_id: String::new(),
            role: String::new(),
            raw_json,
            time_created: 0,
            header_type: row
                .get::<_, Option<i64>>(1)
                .map_err(|err| err.to_string())?
                .unwrap_or_default(),
            ordinal,
            turn_index: turn_index.max(0),
        })?;
        ordinal += 1;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
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
    let raw_hash = hash_parts(&[
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
fn stage_and_clear_kv_order(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS imported_replay_previous_kv_events(
             event_id TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         DELETE FROM imported_replay_previous_kv_events;",
    )
    .map_err(|err| format!("prepare reordered KV replay staging: {err}"))?;
    tx.execute(
        "INSERT OR IGNORE INTO imported_replay_previous_kv_events(event_id)
         SELECT event_id FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("stage reordered KV replay ids: {err}"))?;
    tx.execute(
        "DELETE FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("clear reordered KV replay events: {err}"))?;
    tx.execute(
        "DELETE FROM imported_replay_source_rows
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("clear reordered KV replay row hashes: {err}"))?;
    Ok(())
}

fn kv_order_removals(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT previous.event_id
             FROM imported_replay_previous_kv_events AS previous
             WHERE NOT EXISTS (
                 SELECT 1 FROM imported_replay_events AS current
                 WHERE current.source=?1 AND current.source_session_id=?2
                   AND current.generation=?3 AND current.event_id=previous.event_id
             ) ORDER BY previous.event_id",
        )
        .map_err(|err| format!("prepare reordered KV replay removals: {err}"))?;
    let mut rows = stmt
        .query(params![source.as_str(), source_session_id, generation])
        .map_err(|err| format!("query reordered KV replay removals: {err}"))?;
    let mut removed = Vec::new();
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        removed.push(row.get::<_, String>(0).map_err(|err| err.to_string())?);
    }
    Ok(removed)
}

fn remove_missing_rows(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    _write_revision: u64,
) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT event_id FROM imported_replay_source_rows r
                 WHERE r.source=?1 AND r.source_session_id=?2 AND r.generation=?3
                   AND NOT EXISTS (
                     SELECT 1 FROM imported_replay_seen_rows s
                     WHERE s.source_key=r.source_key
                   ) AND event_id IS NOT NULL",
            )
            .map_err(|err| format!("prepare removed SQLite replay rows: {err}"))?;
        let mut rows = stmt
            .query(params![source.as_str(), source_session_id, generation])
            .map_err(|err| format!("query removed SQLite replay rows: {err}"))?;
        while let Some(row) = rows.next().map_err(|err| err.to_string())? {
            removed.push(row.get::<_, String>(0).map_err(|err| err.to_string())?);
        }
    }
    for event_id in &removed {
        tx.execute(
            "DELETE FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![source.as_str(), source_session_id, generation, event_id],
        )
        .map_err(|err| format!("delete removed SQLite replay event: {err}"))?;
    }
    tx.execute(
        "DELETE FROM imported_replay_source_rows AS r
         WHERE r.source=?1 AND r.source_session_id=?2 AND r.generation=?3
           AND NOT EXISTS (
             SELECT 1 FROM imported_replay_seen_rows s WHERE s.source_key=r.source_key
           )",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("delete removed SQLite source rows: {err}"))?;
    Ok(removed)
}

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

fn field_path_is_under(field_path: &str, root: &str) -> bool {
    field_path == root
        || field_path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('.'))
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

fn value_at_path_mut<'a>(value: &'a mut Value, path: &str) -> Option<&'a mut String> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object_mut()?.get_mut(segment)?;
    }
    current.as_str()?;
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

#[allow(clippy::too_many_arguments)]
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

fn rebuild_turns(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_turns WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("clear {} replay turn headers: {err}", source.as_str()))?;
    let mut stmt = tx
        .prepare(
            "SELECT sequence,event_id,function_name,created_at FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 ORDER BY sequence",
        )
        .map_err(|err| format!("prepare {} turn rebuild: {err}", source.as_str()))?;
    let mut rows = stmt
        .query(params![source.as_str(), source_session_id, generation])
        .map_err(|err| format!("query {} turn rebuild: {err}", source.as_str()))?;
    let mut turn_index = -1_i64;
    let mut current: Option<(String, i64, i64, String, String, u64)> = None;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let sequence: i64 = row.get(0).map_err(|err| err.to_string())?;
        let event_id: String = row.get(1).map_err(|err| err.to_string())?;
        let function: String = row.get(2).map_err(|err| err.to_string())?;
        let created_at: String = row.get(3).map_err(|err| err.to_string())?;
        if function == imported_history::FUNCTION_USER_MESSAGE || current.is_none() {
            if let Some(header) = current.take() {
                insert_turn_header(
                    tx,
                    source,
                    source_session_id,
                    generation,
                    turn_index,
                    header,
                )?;
            }
            turn_index += 1;
            current = Some((
                event_id,
                sequence,
                sequence,
                created_at.clone(),
                created_at,
                1,
            ));
        } else if let Some(header) = current.as_mut() {
            header.2 = sequence;
            header.4 = created_at;
            header.5 += 1;
        }
        tx.execute(
            "UPDATE imported_replay_events SET turn_index=?1 WHERE source=?2 AND source_session_id=?3 AND generation=?4 AND sequence=?5",
            params![turn_index, source.as_str(), source_session_id, generation, sequence],
        )
        .map_err(|err| format!("assign {} replay turn: {err}", source.as_str()))?;
    }
    drop(rows);
    drop(stmt);
    if let Some(header) = current {
        insert_turn_header(
            tx,
            source,
            source_session_id,
            generation,
            turn_index,
            header,
        )?;
    }
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

pub(super) fn read_payload(
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

fn stable_event_id(source: ImportedHistorySourceId, source_key: &str) -> String {
    format!(
        "{}-sqlite-{}",
        source.as_str(),
        hash_parts(&[source_key.as_bytes()])
    )
}

fn hash_parts(parts: &[&[u8]]) -> String {
    let mut hash = StableHash::new();
    for part in parts {
        hash.write(part);
    }
    hash.finish_hex()
}

struct StableHash(u64);

impl StableHash {
    fn new() -> Self {
        Self(0xcbf29ce484222325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
    fn finish_hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projectors::turn_metadata::TurnMetadataAccumulator;
    use crate::sources::imported_history::replay::{
        materialize_payload_artifact, open_window, poll_delta, prepare_pinned_scan,
        read_payload_range, scan_window_after, scan_window_after_generation, ReplayLimits,
    };
    use crate::store::sqlite::SqliteRecordStore;

    fn hash_text(text: &str) -> u64 {
        text.as_bytes()
            .iter()
            .fold(0xcbf29ce484222325_u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
            })
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
            let range = read_payload_range(
                cache,
                source,
                session_id,
                generation,
                event_id,
                field_path,
                offset,
                Some(256 * 1024),
            )
            .expect("SQLite replay payload range");
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

    fn temp_db(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "orgii-replay-{label}-{}-{}.sqlite",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn cache_conn(
        source: ImportedHistorySourceId,
        source_session_id: &str,
        path: &Path,
    ) -> (Connection, String) {
        let conn = Connection::open_in_memory().expect("cache DB");
        SqliteRecordStore::init_tables(&conn).expect("replay tables");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache");
        let session_id = format!(
            "{}{}",
            source.descriptor().session_prefix,
            source_session_id
        );
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path
             ) VALUES(?1,?2,?3,?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                path.to_string_lossy()
            ],
        )
        .expect("cache source path");
        (conn, session_id)
    }

    fn create_part_db(path: &Path, session_id: &str) -> Connection {
        let conn = Connection::open(path).expect("source DB");
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE session(
               id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER
             );
             CREATE TABLE message(
               id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT
             );
             CREATE TABLE part(
               id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,
               time_created INTEGER,data TEXT
             );",
        )
        .expect("part schema");
        conn.execute("INSERT INTO session VALUES(?1,1,1)", [session_id])
            .expect("session row");
        conn
    }

    fn insert_part(conn: &Connection, session_id: &str, ordinal: usize, role: &str, part: Value) {
        let message_id = format!("message-{ordinal:06}");
        let part_id = format!("part-{ordinal:06}");
        let timestamp = ordinal as i64 + 1;
        conn.execute(
            "INSERT INTO message(id,session_id,time_created,data) VALUES(?1,?2,?3,?4)",
            params![
                message_id,
                session_id,
                timestamp,
                serde_json::json!({"role":role}).to_string()
            ],
        )
        .expect("message row");
        conn.execute(
            "INSERT INTO part(id,message_id,session_id,time_created,data)
             VALUES(?1,?2,?3,?4,?5)",
            params![part_id, message_id, session_id, timestamp, part.to_string()],
        )
        .expect("part row");
    }

    fn create_kv_db(path: &Path, composer_id: &str) -> Connection {
        let conn = Connection::open(path).expect("KV source DB");
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
        )
        .expect("KV schema");
        write_kv_transcript(&conn, composer_id, &[1, 2]);
        conn
    }

    fn write_kv_transcript(conn: &Connection, composer_id: &str, bubble_types: &[i64]) {
        let headers = bubble_types
            .iter()
            .enumerate()
            .map(|(index, bubble_type)| {
                serde_json::json!({"bubbleId":format!("b{index}"),"type":bubble_type})
            })
            .collect::<Vec<_>>();
        let composer = serde_json::json!({
            "composerId":composer_id,
            "createdAt":1,
            "lastUpdatedAt":bubble_types.len() as i64,
            "fullConversationHeadersOnly":headers,
        });
        conn.execute(
            "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![format!("composerData:{composer_id}"), composer.to_string()],
        )
        .expect("composer row");
        for (index, bubble_type) in bubble_types.iter().copied().enumerate() {
            let bubble = serde_json::json!({
                "bubbleId":format!("b{index}"),
                "type":bubble_type,
                "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
                "text":if bubble_type == 1 { format!("user {index}") } else { format!("assistant {index}") },
            });
            conn.execute(
                "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![
                    format!("bubbleId:{composer_id}:b{index}"),
                    bubble.to_string()
                ],
            )
            .expect("bubble row");
        }
    }

    #[test]
    fn preview_is_utf8_safe_and_bounded() {
        let preview = head_preview(&"你".repeat(10_000), NORMAL_PAYLOAD_PREVIEW_BYTES);
        assert!(preview.is_char_boundary(preview.len()));
        assert!(preview.len() < NORMAL_PAYLOAD_PREVIEW_BYTES + 64);
    }

    #[test]
    fn compact_sqlite_rows_keep_line_stats_and_full_output_git_summary() {
        let mut edit = ActivityChunk::new("opencodeapp-s1", "tool_call", "edit_file");
        edit.args = serde_json::json!({
            "file_path":"src/large.rs",
            "content":"line\n".repeat(4_000)
        });
        edit.result = serde_json::json!({
            "linesAdded":7,
            "linesRemoved":3,
            "output":"x".repeat(16 * 1024)
        });
        compact_chunk(&mut edit, "part-edit");
        let mut edit_metadata = TurnMetadataAccumulator::new();
        edit_metadata.add_event_values_at(
            Some(&edit.function),
            &edit.args,
            &edit.result,
            "2026-07-22T00:00:00Z",
        );
        assert_eq!(edit_metadata.modified_files()[0].path, "src/large.rs");
        assert_eq!(edit_metadata.modified_files()[0].additions, 7);
        assert_eq!(edit_metadata.modified_files()[0].deletions, 3);

        let mut shell = ActivityChunk::new(
            "opencodeapp-s1",
            "tool_call",
            imported_history::FUNCTION_RUN_COMMAND_LINE,
        );
        shell.args = serde_json::json!({"command":"git commit -m metadata"});
        shell.result = serde_json::json!({
            "output":format!(
                "[feature abc1234] metadata\n{}\nhttps://github.com/acme/repo/pull/42",
                "middle".repeat(10 * 1024)
            )
        });
        compact_chunk(&mut shell, "part-shell");
        let mut shell_metadata = TurnMetadataAccumulator::new();
        shell_metadata.add_event_values_at(
            Some(&shell.function),
            &shell.args,
            &shell.result,
            "2026-07-22T00:00:01Z",
        );
        assert!(shell_metadata
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
        assert!(shell_metadata
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.pr_number == Some(42)));
    }

    #[test]
    fn stable_id_ignores_rowid_and_uses_provider_key() {
        let first = stable_event_id(ImportedHistorySourceId::OpenCode, "part-1");
        let second = stable_event_id(ImportedHistorySourceId::OpenCode, "part-1");
        assert_eq!(first, second);
    }

    #[test]
    fn all_five_sqlite_sources_open_bounded_and_poll_unchanged_without_parsing() {
        for source in [
            ImportedHistorySourceId::OpenCode,
            ImportedHistorySourceId::MimoCode,
            ImportedHistorySourceId::ZCode,
        ] {
            let path = temp_db(source.as_str());
            let writer = create_part_db(&path, "s1");
            insert_part(
                &writer,
                "s1",
                0,
                "user",
                serde_json::json!({"type":"text","text":"hello"}),
            );
            insert_part(
                &writer,
                "s1",
                1,
                "assistant",
                serde_json::json!({"type":"text","text":"world"}),
            );
            let (mut cache, session_id) = cache_conn(source, "s1", &path);
            let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
                .expect("open part replay");
            assert_eq!(opened.chunks.len(), 2, "{}", source.as_str());
            let unchanged = poll_delta(
                &mut cache,
                source,
                &session_id,
                &opened.cursor,
                ReplayLimits::default(),
            )
            .expect("unchanged part poll");
            assert_eq!(unchanged.stats, ReplayStats::default());
            drop(writer);
            let _ = std::fs::remove_file(path);
        }

        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let path = temp_db(source.as_str());
            let writer = create_kv_db(&path, "c1");
            let (mut cache, session_id) = cache_conn(source, "c1", &path);
            let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
                .expect("open KV replay");
            assert_eq!(opened.chunks.len(), 2, "{}", source.as_str());
            let unchanged = poll_delta(
                &mut cache,
                source,
                &session_id,
                &opened.cursor,
                ReplayLimits::default(),
            )
            .expect("unchanged KV poll");
            assert_eq!(unchanged.stats, ReplayStats::default());
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn opencode_append_update_delete_and_checkpoint_are_incremental() {
        let path = temp_db("opencode-delta");
        let writer = create_part_db(&path, "s1");
        insert_part(
            &writer,
            "s1",
            0,
            "user",
            serde_json::json!({"type":"text","text":"hello"}),
        );
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
        let opened = open_window(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open replay");

        let tx = writer.unchecked_transaction().expect("append transaction");
        for ordinal in 1..=1_000 {
            insert_part(
                &tx,
                "s1",
                ordinal,
                "assistant",
                serde_json::json!({"type":"text","text":format!("answer {ordinal}")}),
            );
        }
        tx.execute("UPDATE session SET time_updated=2 WHERE id='s1'", [])
            .unwrap();
        tx.commit().unwrap();
        let mut appended = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("append delta");
        assert!(appended.stats.parsed_rows <= 1_010);
        assert_eq!(appended.stats.parsed_rows, 1_000);
        assert_eq!(appended.stats.upserted_events, 1_000);
        let mut append_ids = std::collections::HashSet::new();
        loop {
            for chunk in &appended.chunks {
                assert!(
                    append_ids.insert(chunk.chunk.chunk_id.clone()),
                    "append delta repeated an event"
                );
            }
            if append_ids.len() == 1_000 {
                break;
            }
            assert!(!appended.chunks.is_empty(), "append continuation stalled");
            appended = poll_delta(
                &mut cache,
                ImportedHistorySourceId::OpenCode,
                &session_id,
                &appended.cursor,
                ReplayLimits::default(),
            )
            .expect("continued append delta");
            assert_eq!(appended.stats.parsed_rows, 0);
            assert_eq!(appended.stats.upserted_events, 0);
        }
        assert_eq!(append_ids.len(), 1_000);

        writer
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
            .unwrap();
        let checkpoint = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &appended.cursor,
            ReplayLimits::default(),
        )
        .expect("checkpoint poll");
        assert_eq!(checkpoint.stats, ReplayStats::default());

        writer
            .execute(
                "UPDATE part SET data=?1 WHERE id='part-000000'",
                [serde_json::json!({"type":"text","text":"edited"}).to_string()],
            )
            .unwrap();
        writer
            .execute("UPDATE session SET time_updated=3 WHERE id='s1'", [])
            .unwrap();
        let updated = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &checkpoint.cursor,
            ReplayLimits::default(),
        )
        .expect("update delta");
        assert_eq!(updated.stats.parsed_rows, 1);
        assert_eq!(updated.chunks.len(), 1);

        writer
            .execute("DELETE FROM part WHERE id='part-000000'", [])
            .unwrap();
        writer
            .execute("UPDATE session SET time_updated=4 WHERE id='s1'", [])
            .unwrap();
        let deleted = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &updated.cursor,
            ReplayLimits::default(),
        )
        .expect("delete delta");
        assert_eq!(deleted.removed_event_ids.len(), 1);
        assert_eq!(deleted.stats.removed_events, 1);

        writer
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .unwrap();
        let vacuumed = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &deleted.cursor,
            ReplayLimits::default(),
        )
        .expect("VACUUM reset");
        assert!(vacuumed.reset_required);
        assert_ne!(vacuumed.cursor.generation, deleted.cursor.generation);
        drop(writer);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cursor_and_windsurf_kv_updates_and_deletes_are_deltas() {
        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let path = temp_db(&format!("{}-delta", source.as_str()));
            let writer = create_kv_db(&path, "c1");
            let (mut cache, session_id) = cache_conn(source, "c1", &path);
            let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
                .expect("open KV delta fixture");

            let updated_bubble = serde_json::json!({
                "bubbleId":"b1","type":2,"createdAt":"2026-07-22T00:00:01Z",
                "text":"assistant edited"
            });
            writer
                .execute(
                    "UPDATE cursorDiskKV SET value=?1 WHERE key='bubbleId:c1:b1'",
                    [updated_bubble.to_string()],
                )
                .unwrap();
            let composer = serde_json::json!({
                "composerId":"c1","createdAt":1,"lastUpdatedAt":99,
                "fullConversationHeadersOnly":[
                    {"bubbleId":"b0","type":1},{"bubbleId":"b1","type":2}
                ]
            });
            writer
                .execute(
                    "UPDATE cursorDiskKV SET value=?1 WHERE key='composerData:c1'",
                    [composer.to_string()],
                )
                .unwrap();
            let updated = poll_delta(
                &mut cache,
                source,
                &session_id,
                &opened.cursor,
                ReplayLimits::default(),
            )
            .expect("KV update delta");
            assert_eq!(updated.stats.parsed_rows, 1, "{}", source.as_str());
            assert_eq!(updated.chunks.len(), 1, "{}", source.as_str());

            writer
                .execute("DELETE FROM cursorDiskKV WHERE key='bubbleId:c1:b0'", [])
                .unwrap();
            let composer = serde_json::json!({
                "composerId":"c1","createdAt":1,"lastUpdatedAt":100,
                "fullConversationHeadersOnly":[{"bubbleId":"b1","type":2}]
            });
            writer
                .execute(
                    "UPDATE cursorDiskKV SET value=?1 WHERE key='composerData:c1'",
                    [composer.to_string()],
                )
                .unwrap();
            let deleted = poll_delta(
                &mut cache,
                source,
                &session_id,
                &updated.cursor,
                ReplayLimits::default(),
            )
            .expect("KV delete delta");
            assert_eq!(deleted.removed_event_ids.len(), 1, "{}", source.as_str());
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn kv_cold_open_reads_only_latest_turn_and_older_turn_hydrates_by_index() {
        let path = temp_db("cursor-lazy-turn");
        let writer = create_kv_db(&path, "c1");
        write_kv_transcript(&writer, "c1", &[1, 2, 1, 2]);
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::CursorIde, "c1", &path);
        let opened = open_window(
            &mut cache,
            ImportedHistorySourceId::CursorIde,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("cold bounded KV replay");
        assert_eq!(opened.stats.parsed_rows, 2);
        assert_eq!(opened.chunks.len(), 2);
        assert_eq!(opened.total_turn_count, 2);
        assert_eq!(opened.total_event_count, 4);

        let older = crate::sources::imported_history::replay::read_turn_window_at_index(
            &mut cache,
            ImportedHistorySourceId::CursorIde,
            &session_id,
            0,
            ReplayLimits::default(),
        )
        .expect("hydrate older KV turn");
        assert_eq!(older.chunks.len(), 2);
        assert_eq!(older.turn_headers[0].turn_index, 0);
        drop(writer);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn kv_cold_forward_scan_hydrates_turns_in_order_without_gaps() {
        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let path = temp_db(&format!("{}-forward-scan", source.as_str()));
            let writer = create_kv_db(&path, "c1");
            write_kv_transcript(&writer, "c1", &[1, 2, 1, 2, 1, 2]);
            let (mut cache, session_id) = cache_conn(source, "c1", &path);
            let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
                .expect("cold bounded KV replay");
            assert_eq!(opened.stats.parsed_rows, 2, "{}", source.as_str());

            let limits = ReplayLimits {
                max_turns: 1,
                max_events: 1,
                max_ipc_bytes: 4 * 1024 * 1024,
            };
            let mut after_sequence = -1;
            let mut sequences = Vec::new();
            for _ in 0..10 {
                let scan =
                    scan_window_after(&mut cache, source, &session_id, after_sequence, limits)
                        .expect("bounded forward KV scan");
                sequences.extend(scan.chunks.iter().map(|chunk| chunk.sequence));
                assert!(scan.cursor.through_sequence > after_sequence || !scan.has_more);
                after_sequence = scan.cursor.through_sequence;
                if !scan.has_more {
                    break;
                }
            }
            assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn kv_prepare_then_strict_scan_crosses_three_lazy_turns() {
        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let path = temp_db(&format!("{}-cursor-continuation", source.as_str()));
            let writer = create_kv_db(&path, "c1");
            write_kv_transcript(&writer, "c1", &[1, 2, 1, 2, 1, 2]);
            let (mut cache, session_id) = cache_conn(source, "c1", &path);
            open_window(&mut cache, source, &session_id, ReplayLimits::default())
                .expect("cold bounded KV replay");

            let limits = ReplayLimits {
                max_turns: 1,
                max_events: 1,
                max_ipc_bytes: 4 * 1024 * 1024,
            };
            let prepared = prepare_pinned_scan(&mut cache, source, &session_id, limits)
                .expect("prepare stable lazy KV scan");
            let pinned_generation = prepared.generation.clone();
            let pinned_revision = prepared.revision;
            let mut after_sequence = -1;
            let mut sequences = Vec::new();
            for _ in 0..10 {
                let scan = scan_window_after_generation(
                    &mut cache,
                    source,
                    &session_id,
                    &pinned_generation,
                    pinned_revision,
                    after_sequence,
                    limits,
                )
                .expect("strict scan across prepared KV turns");
                sequences.extend(scan.chunks.iter().map(|chunk| chunk.sequence));
                assert_eq!(scan.cursor.generation, pinned_generation);
                assert_eq!(scan.cursor.revision, pinned_revision);
                assert!(scan.cursor.through_sequence > after_sequence || !scan.has_more);
                after_sequence = scan.cursor.through_sequence;
                if !scan.has_more {
                    break;
                }
            }
            assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn kv_reorder_rebuilds_stable_events_without_sequence_collisions() {
        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let path = temp_db(&format!("{}-reorder", source.as_str()));
            let writer = create_kv_db(&path, "c1");
            write_kv_transcript(&writer, "c1", &[1, 2, 2]);
            let (mut cache, session_id) = cache_conn(source, "c1", &path);
            let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
                .expect("open KV reorder fixture");

            let reordered = serde_json::json!({
                "composerId":"c1","createdAt":1,"lastUpdatedAt":99,
                "fullConversationHeadersOnly":[
                    {"bubbleId":"b0","type":1},
                    {"bubbleId":"b2","type":2},
                    {"bubbleId":"b1","type":2}
                ]
            });
            writer
                .execute(
                    "UPDATE cursorDiskKV SET value=?1 WHERE key='composerData:c1'",
                    [reordered.to_string()],
                )
                .unwrap();
            let delta = poll_delta(
                &mut cache,
                source,
                &session_id,
                &opened.cursor,
                ReplayLimits::default(),
            )
            .expect("reordered KV delta");
            assert!(!delta.reset_required, "{}", source.as_str());
            assert_eq!(delta.removed_event_ids.len(), 0, "{}", source.as_str());

            let reordered_window =
                crate::sources::imported_history::replay::read_turn_window_at_index(
                    &mut cache,
                    source,
                    &session_id,
                    0,
                    ReplayLimits::default(),
                )
                .expect("read reordered KV turn");
            let actual = reordered_window
                .chunks
                .iter()
                .map(|chunk| (chunk.sequence, chunk.chunk.chunk_id.clone()))
                .collect::<Vec<_>>();
            let expected = vec![
                (0, stable_event_id(source, "bubbleId:c1:b0")),
                (1, stable_event_id(source, "bubbleId:c1:b2")),
                (2, stable_event_id(source, "bubbleId:c1:b1")),
            ];
            assert_eq!(actual, expected, "{}", source.as_str());
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn unknown_sqlite_schema_is_explicit_and_never_falls_back() {
        let path = temp_db("unknown-schema");
        let source_conn = Connection::open(&path).unwrap();
        source_conn
            .execute_batch("CREATE TABLE unrelated(id INTEGER PRIMARY KEY,value TEXT);")
            .unwrap();
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
        let error = open_window(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            ReplayLimits::default(),
        )
        .unwrap_err();
        assert!(error.contains("Unsupported opencode replay schema"));
        assert!(error.contains("will not fall back"));
        drop(source_conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_wal_path_plus_ten_mib_content_uses_exact_root_args_artifact() {
        let path = temp_db("opencode-root-args");
        let writer = create_part_db(&path, "s1");
        let original_args = serde_json::json!({
            "path":"src/huge.txt",
            "content":format!("BEGIN{}END", "你".repeat((10 * 1024 * 1024) / 3)),
        });
        let expected_json = serde_json::to_string(&original_args).expect("expected args JSON");
        let source_part = serde_json::json!({
            "type":"tool",
            "tool":"custom_tool",
            "callID":"call-root-args",
            "state":{
                "status":"completed",
                "input":original_args,
                "output":"ok"
            }
        });
        insert_part(&writer, "s1", 0, "assistant", source_part);
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
        let opened = open_window(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open SQLite root args fixture");
        let indexed = opened.chunks.first().expect("custom tool event");
        assert_eq!(indexed.chunk.args["path"], "src/huge.txt");
        assert_eq!(indexed.chunk.args["_replayTruncated"], true);
        assert!(indexed.chunk.args.get("content").is_none());
        assert_eq!(indexed.payloads.len(), 1);
        assert_eq!(indexed.payloads[0].field_path, "args");
        assert!(indexed.payloads[0].source_key.is_none());

        let generation = opened.cursor.generation.clone();
        let event_id = indexed.chunk.chunk_id.clone();
        let restored = read_full_payload(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &generation,
            &event_id,
            "args",
        );
        assert_eq!(restored.len(), expected_json.len());
        assert_eq!(hash_text(&restored), hash_text(&expected_json));
        assert_eq!(
            serde_json::from_str::<Value>(&restored).expect("restored args JSON"),
            serde_json::from_str::<Value>(&expected_json).expect("baseline args JSON")
        );
        assert!(!restored.contains("_replayTruncated"));
        assert!(!restored.contains("[payload truncated]"));
        let artifact_count = cache
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs
                 WHERE source='opencode' AND generation=?1 AND event_id=?2 AND field_path='args'",
                params![generation, event_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("root args artifact ref");
        assert_eq!(artifact_count, 1);
        drop(writer);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn same_length_sqlite_row_update_replaces_materialized_payload_hash() {
        let path = temp_db("opencode-same-length-shell-update");
        let writer = create_part_db(&path, "s1");
        let first_output = format!("BEGIN{}END", "A".repeat(96 * 1024));
        let second_output = format!("BEGIN{}END", "B".repeat(96 * 1024));
        assert_eq!(first_output.len(), second_output.len());
        let part = |output: &str| {
            serde_json::json!({
                "type":"tool",
                "tool":"bash",
                "callID":"call-same-length",
                "state":{
                    "status":"completed",
                    "input":{"command":"emit same length"},
                    "output":output
                }
            })
        };
        insert_part(&writer, "s1", 0, "assistant", part(&first_output));
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
        let opened = open_window(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open same-length SQLite Shell fixture");
        let indexed = opened.chunks.first().expect("SQLite Shell event");
        let event_id = indexed.chunk.chunk_id.clone();
        assert!(indexed
            .payloads
            .iter()
            .any(|payload| payload.field_path == "result.output"));
        let first_hash = {
            let tx = cache.transaction().expect("first payload artifact");
            let locator = materialize_payload_artifact(
                &tx,
                ImportedHistorySourceId::OpenCode,
                &session_id,
                &opened.cursor.generation,
                &event_id,
                "result.output",
            )
            .expect("materialize first SQLite Shell payload");
            tx.commit().expect("commit first payload artifact");
            locator.content_hash
        };

        writer
            .execute(
                "UPDATE part SET data=?1 WHERE id='part-000000'",
                [part(&second_output).to_string()],
            )
            .expect("same-length SQLite row update");
        writer
            .execute("UPDATE session SET time_updated=2 WHERE id='s1'", [])
            .expect("advance SQLite session clock");
        let updated = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("poll same-length SQLite update");
        assert!(!updated.reset_required);
        assert_eq!(updated.cursor.generation, opened.cursor.generation);
        assert_eq!(updated.stats.parsed_rows, 1);

        let second_hash = {
            let tx = cache.transaction().expect("updated payload artifact");
            let locator = materialize_payload_artifact(
                &tx,
                ImportedHistorySourceId::OpenCode,
                &session_id,
                &updated.cursor.generation,
                &event_id,
                "result.output",
            )
            .expect("materialize changed SQLite Shell payload");
            tx.commit().expect("commit changed payload artifact");
            locator.content_hash
        };
        assert_ne!(first_hash, second_hash, "content, not length, is identity");
        let restored = read_full_payload(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &updated.cursor.generation,
            &event_id,
            "result.output",
        );
        assert_eq!(restored, second_output);
        assert_eq!(
            cache
                .query_row(
                    "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                     WHERE source='opencode' AND generation=?1",
                    [&updated.cursor.generation],
                    |row| row.get::<_, i64>(0),
                )
                .expect("live same-length artifact count"),
            1
        );
        drop(writer);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_git_projection_metadata_does_not_leak_from_exact_result() {
        let path = temp_db("opencode-git-root-result");
        let writer = create_part_db(&path, "s1");
        let output = format!(
            "[feature abc1234] exact\n{}\nhttps://github.com/acme/repo/pull/42",
            "middle".repeat(8 * 1024)
        );
        let source_part = serde_json::json!({
            "type":"tool",
            "tool":"bash",
            "callID":"call-git",
            "state":{
                "status":"completed",
                "input":{"command":"git commit -m exact"},
                "output":output
            }
        });
        let expected = crate::sources::opencode::history::replay_chunk_from_part_json(
            "opencodeapp-s1",
            "opencode",
            0,
            "part-000000".to_string(),
            "message-000000".to_string(),
            "assistant".to_string(),
            &source_part.to_string(),
            1,
        )
        .expect("normalize old full result")
        .expect("old full tool event");
        insert_part(&writer, "s1", 0, "assistant", source_part);
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
        let opened = open_window(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open SQLite Git fixture");
        let indexed = opened.chunks.first().expect("Git shell event");
        assert!(indexed.chunk.result.get("_replayGitArtifacts").is_some());
        assert_eq!(
            indexed
                .payloads
                .iter()
                .map(|payload| payload.field_path.as_str())
                .collect::<Vec<_>>(),
            vec!["result"]
        );
        let restored = read_full_payload(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &opened.cursor.generation,
            &indexed.chunk.chunk_id,
            "result",
        );
        let restored: Value = serde_json::from_str(&restored).expect("restored exact result");
        assert_eq!(restored, expected.result);
        assert!(restored.get("_replayGitArtifacts").is_none());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ten_megabyte_command_keeps_semantic_preview_and_round_trips_by_range() {
        let path = temp_db("opencode-large-args");
        let writer = create_part_db(&path, "s1");
        let command = format!("BEGIN{}END", "你".repeat((10 * 1024 * 1024) / 3));
        insert_part(
            &writer,
            "s1",
            0,
            "assistant",
            serde_json::json!({
                "type":"tool",
                "tool":"bash",
                "callID":"call-1",
                "state":{"status":"completed","input":{"command":command},"output":"ok"}
            }),
        );
        let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
        let opened = open_window(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            ReplayLimits::default(),
        )
        .expect("open large args");
        let event = opened.chunks.first().expect("tool event");
        let preview = event
            .chunk
            .args
            .get("command")
            .and_then(Value::as_str)
            .expect("semantic command preview");
        assert!(preview.len() < SHELL_PAYLOAD_PREVIEW_BYTES + 64);
        let payload = event
            .payloads
            .iter()
            .find(|payload| payload.field_path == "args")
            .expect("root args payload");
        assert_eq!(payload.encoding, ReplayPayloadEncoding::JsonValue);
        let projection = payload
            .body_projection
            .as_ref()
            .expect("bounded root body projection");
        assert_eq!(projection.field_path, "args.cmd");
        assert!(projection.truncated);
        assert!(projection.text.len() <= SHELL_PAYLOAD_PREVIEW_BYTES);

        let reconstructed = read_full_payload(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &opened.cursor.generation,
            &event.chunk.chunk_id,
            "args",
        );
        let reconstructed: Value =
            serde_json::from_str(&reconstructed).expect("complete normalized args JSON");
        assert_eq!(reconstructed["command"], command);
        assert_eq!(reconstructed["cmd"], command);
        assert_eq!(reconstructed["payload"]["command"], command);
        assert!(reconstructed.get("_replayTruncated").is_none());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
}
