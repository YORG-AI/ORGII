use super::*;
use std::collections::HashSet;

#[allow(
    clippy::too_many_arguments,
    reason = "KV hydration boundary keeps the pinned generation and turn range explicit"
)]
pub(in crate::sources::imported_history::replay) fn hydrate_kv_turn(
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

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct KvComposerOrder {
    full_conversation_headers_only: Vec<KvHeader>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct KvHeader {
    bubble_id: String,
    #[serde(rename = "type")]
    bubble_type: i64,
}

#[derive(Debug)]
struct KvBubbleOrderEntry {
    key: String,
    bubble_id: String,
    bubble_type: i64,
    ordinal: i64,
    turn_index: i64,
}

pub(super) fn kv_source_summary(
    conn: &Connection,
    composer_id: &str,
    composer_json: &str,
) -> Result<SqliteSourceSummary, String> {
    let mut order_hash = StableHash::new();
    let mut last_source_key = String::new();
    let mut row_count = 0_u64;
    stream_kv_bubble_order(conn, composer_id, composer_json, |entry| {
        order_hash.write(&(entry.bubble_id.len() as u64).to_le_bytes());
        order_hash.write(entry.bubble_id.as_bytes());
        order_hash.write(&entry.bubble_type.to_le_bytes());
        last_source_key = entry.key;
        row_count = row_count.saturating_add(1);
        Ok(true)
    })?;
    Ok(SqliteSourceSummary {
        row_count,
        max_time_created: 0,
        max_source_key: String::new(),
        source_signal: hash_parts(&[composer_json.as_bytes()]),
        last_source_key,
        order_signal: order_hash.finish_hex(),
    })
}

pub(super) fn kv_sync_plan(
    previous: &KvStoreReplayCursor,
    current: &SqliteSourceSummary,
) -> SyncPlan {
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

pub(super) fn kv_recent_turn_start(
    conn: &Connection,
    composer_id: &str,
    composer_json: &str,
) -> Result<u64, String> {
    let mut latest_start = 0_u64;
    let mut current_turn = None;
    stream_kv_bubble_order(conn, composer_id, composer_json, |entry| {
        if current_turn != Some(entry.turn_index) {
            latest_start = entry.ordinal.max(0) as u64;
            current_turn = Some(entry.turn_index);
        }
        Ok(true)
    })?;
    Ok(latest_start)
}

pub(super) fn replace_kv_turn_headers(
    tx: &Transaction<'_>,
    source_conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    composer_json: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_turns
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|err| format!("clear {} compact turn headers: {err}", source.as_str()))?;
    let mut pending = None;
    stream_kv_bubble_order(source_conn, source_session_id, composer_json, |entry| {
        if pending
            .as_ref()
            .is_some_and(|turn: &PendingKvTurn| turn.turn_index != entry.turn_index)
        {
            if let Some(turn) = pending.take() {
                publish_pending_kv_turn(tx, source, source_session_id, generation, turn)?;
            }
        }
        let turn = pending.get_or_insert_with(|| PendingKvTurn {
            turn_index: entry.turn_index,
            turn_id: if entry.bubble_type == 1 {
                entry.bubble_id.clone()
            } else {
                format!("{}-turn-{}", source.as_str(), entry.turn_index)
            },
            start_sequence: entry.ordinal,
            end_sequence: entry.ordinal,
            event_count: 0,
        });
        turn.end_sequence = entry.ordinal;
        turn.event_count = turn.event_count.saturating_add(1);
        Ok(true)
    })?;
    if let Some(turn) = pending {
        publish_pending_kv_turn(tx, source, source_session_id, generation, turn)?;
    }
    Ok(())
}

#[derive(Debug)]
struct PendingKvTurn {
    turn_index: i64,
    turn_id: String,
    start_sequence: i64,
    end_sequence: i64,
    event_count: u64,
}

fn publish_pending_kv_turn(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    turn: PendingKvTurn,
) -> Result<(), String> {
    insert_turn_header(
        tx,
        source,
        source_session_id,
        generation,
        turn.turn_index,
        (
            turn.turn_id,
            turn.start_sequence,
            turn.end_sequence,
            "1970-01-01T00:00:00Z".to_string(),
            "1970-01-01T00:00:00Z".to_string(),
            turn.event_count,
        ),
    )
}

pub(super) fn load_composer_json(conn: &Connection, composer_id: &str) -> Result<String, String> {
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

pub(super) fn stream_kv_bubbles(
    conn: &Connection,
    composer_id: &str,
    composer_json: &str,
    start_ordinal: u64,
    end_ordinal: Option<u64>,
    mut visit: impl FnMut(SourceRow) -> Result<(), String>,
) -> Result<(), String> {
    stream_kv_bubble_order(conn, composer_id, composer_json, |entry| {
        if (entry.ordinal as u64) < start_ordinal {
            return Ok(true);
        }
        if end_ordinal.is_some_and(|end| entry.ordinal as u64 > end) {
            return Ok(false);
        }
        let raw_json = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key=?1",
                [&entry.key],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|err| format!("read replay bubble {}: {err}", entry.bubble_id))?
            .unwrap_or_default();
        visit(SourceRow {
            key: entry.key,
            message_id: String::new(),
            role: String::new(),
            raw_json,
            time_created: 0,
            header_type: entry.bubble_type,
            ordinal: entry.ordinal,
            turn_index: entry.turn_index,
        })?;
        Ok(true)
    })?;
    Ok(())
}

fn stream_kv_bubble_order(
    conn: &Connection,
    composer_id: &str,
    composer_json: &str,
    mut visit: impl FnMut(KvBubbleOrderEntry) -> Result<bool, String>,
) -> Result<(), String> {
    let composer = serde_json::from_str::<KvComposerOrder>(composer_json)
        .map_err(|err| format!("parse replay composer {composer_id}: {err}"))?;
    let mut seen = HashSet::new();
    let mut ordinal = 0_i64;
    let mut turn_index = -1_i64;
    for header in composer.full_conversation_headers_only {
        if !is_valid_kv_bubble_id(&header.bubble_id) || !seen.insert(header.bubble_id.clone()) {
            continue;
        }
        let key = format!("bubbleId:{composer_id}:{}", header.bubble_id);
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cursorDiskKV WHERE key=?1)",
                [&key],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| format!("check replay bubble {}: {err}", header.bubble_id))?
            != 0;
        if !exists {
            continue;
        }
        if header.bubble_type == 1 || turn_index < 0 {
            turn_index += 1;
        }
        let entry = KvBubbleOrderEntry {
            key,
            bubble_id: header.bubble_id,
            bubble_type: header.bubble_type,
            ordinal,
            turn_index: turn_index.max(0),
        };
        ordinal += 1;
        if !visit(entry)? {
            return Ok(());
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
        let bubble_id = key.rsplit(':').next().unwrap_or_default().to_string();
        if !is_valid_kv_bubble_id(&bubble_id) || !seen.insert(bubble_id.clone()) {
            continue;
        }
        let bubble_type = row
            .get::<_, Option<i64>>(1)
            .map_err(|err| err.to_string())?
            .unwrap_or_default();
        if bubble_type == 1 || turn_index < 0 {
            turn_index += 1;
        }
        let entry = KvBubbleOrderEntry {
            key,
            bubble_id,
            bubble_type,
            ordinal,
            turn_index: turn_index.max(0),
        };
        ordinal += 1;
        if !visit(entry)? {
            return Ok(());
        }
    }
    Ok(())
}

fn is_valid_kv_bubble_id(bubble_id: &str) -> bool {
    !bubble_id.trim().is_empty() && bubble_id != "undefined"
}

pub(super) fn stage_and_clear_kv_order(
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

pub(super) fn kv_order_removals(
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

pub(super) fn remove_missing_rows(
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
