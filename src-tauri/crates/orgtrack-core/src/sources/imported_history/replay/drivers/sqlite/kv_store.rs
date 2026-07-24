use super::*;
use std::collections::HashMap;

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

pub(super) fn kv_source_summary(
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

pub(super) fn kv_recent_turn_start(composer_json: &str) -> Result<u64, String> {
    let composer = serde_json::from_str::<KvComposerOrder>(composer_json)
        .map_err(|err| format!("parse replay KV recent turn: {err}"))?;
    Ok(composer
        .full_conversation_headers_only
        .iter()
        .rposition(|header| header.bubble_type == 1)
        .unwrap_or(0) as u64)
}

pub(super) fn replace_kv_turn_headers(
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
