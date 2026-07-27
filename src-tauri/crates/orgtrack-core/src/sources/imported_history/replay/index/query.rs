use super::source_identity::*;
use super::sync::publish_change_log;
use super::*;

pub(in crate::sources::imported_history::replay) fn read_recent_window(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    read_window_before(conn, source, session_id, None, limits)
}

pub(in crate::sources::imported_history::replay) fn read_window_before(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    before_sequence: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let ceiling = before_sequence.unwrap_or(i64::MAX);
    let newest_turn = conn
        .query_row(
            "SELECT MAX(turn_index) FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND sequence < ?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                ceiling
            ],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| format!("resolve replay window turn: {err}"))?
        .unwrap_or(0);
    let oldest_turn = newest_turn.saturating_sub(limits.max_turns.saturating_sub(1) as i64);
    let mut chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "turn_index >= ?4 AND turn_index <= ?5 AND sequence < ?6",
        &[oldest_turn, newest_turn, ceiling],
        limits,
        QueryDirection::NewestFirst,
    )?;
    chunks.reverse();
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let min_sequence = chunks.first().map_or(-1, |chunk| chunk.sequence);
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let has_older = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND sequence < ?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                min_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query older replay events: {err}"))?
        != 0;
    let turn_headers = read_turn_headers(
        conn,
        source,
        &resolved.source_session_id,
        &state.generation,
        oldest_turn,
        newest_turn,
    )?;
    Ok(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        window_start_sequence: chunks.first().map(|chunk| chunk.sequence),
        chunks,
        turn_headers,
        total_turn_count: state.total_turns,
        total_event_count: state.total_events,
        has_older,
        stats: ReplayStats {
            ipc_bytes: ipc_bytes as u64,
            ..ReplayStats::default()
        },
    })
}

pub(in crate::sources::imported_history::replay) fn read_window_for_turn(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    turn_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let turn_index = conn
        .query_row(
            "SELECT turn_index FROM imported_replay_turns
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND turn_id=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                turn_id
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("query replay turn {turn_id}: {err}"))?
        .ok_or_else(|| format!("Replay turn is no longer available: {turn_id}"))?;
    read_window_for_turn_index(conn, source, session_id, turn_index, limits)
}

pub(in crate::sources::imported_history::replay) fn read_window_for_turn_index(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    requested_turn_index: i64,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let turn = conn
        .query_row(
            "SELECT turn_id,turn_index,start_sequence,end_sequence,started_at,ended_at,event_count
             FROM imported_replay_turns WHERE source=?1 AND source_session_id=?2
               AND generation=?3 AND turn_index=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                requested_turn_index
            ],
            |row| {
                Ok(ReplayTurnHeader {
                    turn_id: row.get(0)?,
                    turn_index: row.get(1)?,
                    start_sequence: row.get(2)?,
                    end_sequence: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    event_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .optional()
        .map_err(|err| format!("query replay turn index {requested_turn_index}: {err}"))?
        .ok_or_else(|| {
            format!("Replay turn index is no longer available: {requested_turn_index}")
        })?;
    let hydrate_stats = hydrate_turn_if_needed(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state,
        &turn,
    )?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after turn hydration".to_string())?;
    let (chunks, window_start_sequence) = read_anchored_turn_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        turn.turn_index,
        limits,
    )?;
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let has_older = if let Some(continuation_sequence) = window_start_sequence {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND sequence<?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                continuation_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query events before replay turn slice: {err}"))?
            != 0
    } else {
        turn.turn_index > 0
    };
    Ok(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        window_start_sequence,
        chunks,
        turn_headers: vec![turn],
        total_turn_count: state.total_turns,
        total_event_count: state.total_events,
        has_older,
        stats: ReplayStats {
            ipc_bytes: ipc_bytes as u64,
            ..hydrate_stats
        },
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn read_anchored_turn_chunks(
    conn: &Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    turn_index: i64,
    limits: ReplayLimits,
) -> Result<(Vec<ReplayIndexedChunk>, Option<i64>), String> {
    let anchor_limits = ReplayLimits {
        max_turns: 1,
        max_events: 1,
        max_ipc_bytes: limits.max_ipc_bytes,
    };
    let mut chunks = read_chunks(
        conn,
        source,
        display_session_id,
        source_session_id,
        generation,
        "turn_index=?4",
        &[turn_index],
        anchor_limits,
        QueryDirection::OldestFirst,
    )?;
    let Some(anchor_sequence) = chunks.first().map(|anchor| anchor.sequence) else {
        return Ok((chunks, None));
    };
    let anchor_bytes = chunks
        .first()
        .map(serialized_indexed_chunk_bytes)
        .unwrap_or_default();
    let Some(tail_limits) = limits.after_exact_turn_anchor(anchor_bytes) else {
        return Ok((chunks, Some(anchor_sequence)));
    };
    let mut tail = read_chunks(
        conn,
        source,
        display_session_id,
        source_session_id,
        generation,
        "turn_index=?4 AND sequence>?5",
        &[turn_index, anchor_sequence],
        tail_limits,
        QueryDirection::NewestFirst,
    )?;
    tail.reverse();
    let tail_start_sequence = tail.first().map(|chunk| chunk.sequence);
    let has_gap = if let Some(tail_start_sequence) = tail_start_sequence {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND turn_index=?4 AND sequence>?5 AND sequence<?6
             )",
            params![
                source.as_str(),
                source_session_id,
                generation,
                turn_index,
                anchor_sequence,
                tail_start_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query exact replay turn gap: {err}"))?
            != 0
    } else {
        false
    };
    let window_start_sequence = if has_gap {
        tail_start_sequence
    } else {
        Some(anchor_sequence)
    };
    chunks.extend(tail);
    Ok((chunks, window_start_sequence))
}

pub(in crate::sources::imported_history::replay) fn hydrate_turn_if_needed(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    state: &ReplayIndexState,
    turn: &ReplayTurnHeader,
) -> Result<ReplayStats, String> {
    if !matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return Ok(ReplayStats::default());
    }
    let indexed_count = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_source_rows WHERE source=?1
               AND source_session_id=?2 AND generation=?3
               AND source_order>=?4 AND source_order<=?5",
            params![
                source.as_str(),
                source_session_id,
                state.generation,
                turn.start_sequence,
                turn.end_sequence.unwrap_or(turn.start_sequence)
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count indexed replay turn: {err}"))?
        .max(0) as u64;
    if indexed_count >= turn.event_count {
        return Ok(ReplayStats::default());
    }
    let resolved = resolve_source(conn, source, display_session_id)?;
    let write_revision = state.revision.saturating_add(1);
    let tx = begin_replay_write_transaction(conn, "lazy replay turn")?;
    let stats = sqlite_driver::hydrate_kv_turn(
        &tx,
        source,
        display_session_id,
        source_session_id,
        &resolved.path,
        &state.generation,
        write_revision,
        turn.start_sequence,
        turn.end_sequence.unwrap_or(turn.start_sequence),
    )?;
    if stats.upserted_events > 0 {
        let revision = publish_change_log(
            &tx,
            source,
            source_session_id,
            &state.generation,
            state.revision,
            write_revision,
            &[],
        )?;
        tx.execute(
            "UPDATE imported_replay_state SET revision=?1,updated_at=?2
             WHERE source=?3 AND source_session_id=?4 AND generation=?5",
            params![
                revision.min(i64::MAX as u64) as i64,
                Utc::now().to_rfc3339(),
                source.as_str(),
                source_session_id,
                state.generation
            ],
        )
        .map_err(|err| format!("publish lazy replay turn revision: {err}"))?;
    }
    tx.commit()
        .map_err(|err| format!("commit lazy replay turn: {err}"))?;
    Ok(stats)
}

pub(in crate::sources::imported_history::replay) fn read_scan_after(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    after_sequence: i64,
    limits: ReplayLimits,
    sync: ReplaySyncResult,
) -> Result<ReplayChunkScan, String> {
    if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return read_lazy_kv_scan_after(conn, source, session_id, after_sequence, limits, sync);
    }
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "sequence > ?4",
        &[after_sequence],
        limits,
        QueryDirection::OldestFirst,
    )?;
    let through_sequence = chunks.last().map_or(after_sequence, |chunk| chunk.sequence);
    let has_more = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND sequence > ?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                through_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query remaining replay events: {err}"))?
        != 0;
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let mut stats = sync.stats;
    stats.ipc_bytes = ipc_bytes as u64;
    Ok(ReplayChunkScan {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        chunks,
        has_more,
        stats,
    })
}

/// Cursor/Windsurf cold indexes intentionally materialize only the newest
/// turn body. A source-neutral forward scan must therefore hydrate exactly the
/// next logical turn before reading it; querying all indexed events directly
/// would jump across the unmaterialized prefix and silently truncate exports.
pub(super) fn read_lazy_kv_scan_after(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    after_sequence: i64,
    limits: ReplayLimits,
    sync: ReplaySyncResult,
) -> Result<ReplayChunkScan, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let turn = conn
        .query_row(
            "SELECT turn_id,turn_index,start_sequence,end_sequence,started_at,ended_at,event_count
             FROM imported_replay_turns
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND COALESCE(end_sequence,start_sequence)>?4
             ORDER BY turn_index ASC LIMIT 1",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                after_sequence
            ],
            |row| {
                Ok(ReplayTurnHeader {
                    turn_id: row.get(0)?,
                    turn_index: row.get(1)?,
                    start_sequence: row.get(2)?,
                    end_sequence: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    event_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .optional()
        .map_err(|err| format!("resolve next lazy replay scan turn: {err}"))?;

    let Some(turn) = turn else {
        return Ok(ReplayChunkScan {
            cursor: ReplayCursor {
                source_id: source.as_str().to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: after_sequence,
            },
            chunks: Vec::new(),
            has_more: false,
            stats: sync.stats,
        });
    };

    let hydrate_stats = hydrate_turn_if_needed(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state,
        &turn,
    )?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after scan hydration".to_string())?;
    let chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "turn_index=?4 AND sequence>?5",
        &[turn.turn_index, after_sequence],
        limits,
        QueryDirection::OldestFirst,
    )?;
    let last_chunk_sequence = chunks.last().map(|chunk| chunk.sequence);
    let mut through_sequence = last_chunk_sequence.unwrap_or(after_sequence);
    let has_indexed_more_in_turn = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND turn_index=?4 AND sequence>?5
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                turn.turn_index,
                through_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query remaining lazy replay turn events: {err}"))?
        != 0;
    // A source row may intentionally normalize to no visible event. Once all
    // indexed events in this turn are consumed, advance over those positions
    // so the next call can reach the following turn without looping.
    if !has_indexed_more_in_turn {
        through_sequence = through_sequence.max(
            turn.end_sequence
                .unwrap_or(turn.start_sequence)
                .max(turn.start_sequence),
        );
    }
    let has_later_turn = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_turns
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND turn_index>?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                turn.turn_index
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query later lazy replay turns: {err}"))?
        != 0;
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let mut stats = sync.stats;
    merge_stats(&mut stats, hydrate_stats);
    stats.ipc_bytes = ipc_bytes as u64;
    Ok(ReplayChunkScan {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        chunks,
        has_more: has_indexed_more_in_turn || has_later_turn,
        stats,
    })
}

pub(super) fn merge_stats(target: &mut ReplayStats, extra: ReplayStats) {
    target.parsed_bytes = target.parsed_bytes.saturating_add(extra.parsed_bytes);
    target.parsed_rows = target.parsed_rows.saturating_add(extra.parsed_rows);
    target.normalized_events = target
        .normalized_events
        .saturating_add(extra.normalized_events);
    target.upserted_events = target.upserted_events.saturating_add(extra.upserted_events);
    target.removed_events = target.removed_events.saturating_add(extra.removed_events);
    target.ipc_bytes = target.ipc_bytes.saturating_add(extra.ipc_bytes);
    target.not_ready |= extra.not_ready;
}

pub(in crate::sources::imported_history::replay) fn read_delta(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
    sync: ReplaySyncResult,
) -> Result<ReplayChunkDelta, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    if cursor.generation != state.generation {
        let mut replacement = read_recent_window(conn, source, session_id, limits)?;
        replacement.stats.parsed_bytes = sync.stats.parsed_bytes;
        replacement.stats.parsed_rows = sync.stats.parsed_rows;
        replacement.stats.normalized_events = sync.stats.normalized_events;
        replacement.stats.upserted_events = sync.stats.upserted_events;
        return Ok(ReplayChunkDelta {
            cursor: replacement.cursor,
            chunks: replacement.chunks,
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: replacement.stats,
        });
    }
    let (chunks, removed_event_ids, through_revision) = read_changes(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        limits,
        cursor.revision,
    )?;
    let through_sequence = chunks
        .iter()
        .map(|chunk| chunk.sequence)
        .max()
        .map_or(cursor.through_sequence, |sequence| {
            cursor.through_sequence.max(sequence)
        });
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>()
        .saturating_add(
            removed_event_ids
                .iter()
                .map(|event_id| serde_json::to_vec(event_id).map_or(0, |bytes| bytes.len()))
                .sum::<usize>(),
        );
    let mut stats = sync.stats;
    stats.ipc_bytes = ipc_bytes as u64;
    Ok(ReplayChunkDelta {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: through_revision,
            through_sequence,
        },
        chunks,
        removed_event_ids,
        reset_required: sync.generation_changed,
        stats,
    })
}

pub(super) fn read_changes(
    conn: &Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    limits: ReplayLimits,
    after_revision: u64,
) -> Result<(Vec<ReplayIndexedChunk>, Vec<String>, u64), String> {
    let mut stmt = conn
        .prepare(
            "SELECT event.sequence,event.event_id,event.turn_index,event.action_type,
                    event.function_name,event.created_at,event.args_preview_json,
                    event.result_preview_json,event.thread_id,event.process_id,
                    event.payloads_json,change.change_revision,change.change_kind,
                    change.event_id
             FROM imported_replay_changes AS change
             LEFT JOIN imported_replay_events AS event
               ON event.source=change.source
              AND event.source_session_id=change.source_session_id
              AND event.generation=change.generation
              AND event.event_id=change.event_id
             WHERE change.source=?1 AND change.source_session_id=?2
               AND change.generation=?3 AND change.change_revision>?4
             ORDER BY change.change_revision ASC LIMIT ?5",
        )
        .map_err(|err| format!("prepare replay change batch: {err}"))?;
    let mut rows = stmt
        .query(params![
            source.as_str(),
            source_session_id,
            generation,
            after_revision.min(i64::MAX as u64) as i64,
            limits.max_events as i64
        ])
        .map_err(|err| format!("query replay change batch: {err}"))?;
    let mut chunks = Vec::new();
    let mut removed = Vec::new();
    let mut ipc_bytes = 0_usize;
    let mut through_revision = after_revision;
    let mut included_turns = HashSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read replay change row: {err}"))?
    {
        let revision = row.get::<_, i64>(11).map_err(|err| err.to_string())?.max(0) as u64;
        let kind: String = row.get(12).map_err(|err| err.to_string())?;
        if kind == "remove" {
            let event_id = row.get::<_, String>(13).map_err(|err| err.to_string())?;
            let next_bytes = serde_json::to_vec(&event_id).map_or(0, |bytes| bytes.len());
            if ipc_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
                if removed.is_empty() && chunks.is_empty() {
                    return Err(format!(
                        "Replay removal {event_id} exceeds the {} byte compact delta budget",
                        limits.max_ipc_bytes
                    ));
                }
                break;
            }
            ipc_bytes = ipc_bytes.saturating_add(next_bytes);
            removed.push(event_id);
            through_revision = revision;
            continue;
        }
        // A lagging consumer may encounter an upsert whose event was removed
        // by a later, not-yet-consumed change. The later tombstone is the
        // authoritative final state; advance past this obsolete snapshot.
        if row
            .get::<_, Option<i64>>(0)
            .map_err(|err| err.to_string())?
            .is_none()
        {
            through_revision = revision;
            continue;
        }
        let turn_index = row.get::<_, i64>(2).map_err(|err| err.to_string())?;
        if !included_turns.contains(&turn_index) && included_turns.len() >= limits.max_turns {
            break;
        }
        let chunk = decode_indexed_chunk(row, display_session_id)?;
        let next_bytes = serialized_indexed_chunk_bytes(&chunk);
        if ipc_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            if removed.is_empty() && chunks.is_empty() {
                return Err(format!(
                    "Replay event {} exceeds the {} byte compact delta budget",
                    chunk.chunk.chunk_id, limits.max_ipc_bytes
                ));
            }
            break;
        }
        ipc_bytes = ipc_bytes.saturating_add(next_bytes);
        included_turns.insert(turn_index);
        chunks.push(chunk);
        through_revision = revision;
    }
    Ok((chunks, removed, through_revision))
}

#[derive(Clone, Copy)]
pub(super) enum QueryDirection {
    NewestFirst,
    OldestFirst,
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn read_chunks(
    conn: &Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    predicate: &str,
    extra_values: &[i64],
    limits: ReplayLimits,
    direction: QueryDirection,
) -> Result<Vec<ReplayIndexedChunk>, String> {
    let order = match direction {
        QueryDirection::NewestFirst => "DESC",
        QueryDirection::OldestFirst => "ASC",
    };
    let sql = format!(
        "SELECT sequence, event_id, turn_index, action_type, function_name,
                created_at, args_preview_json, result_preview_json,
                thread_id, process_id, payloads_json
         FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND {predicate}
         ORDER BY sequence {order} LIMIT {}",
        limits.max_events
    );
    let mut values = vec![
        rusqlite::types::Value::Text(source.as_str().to_string()),
        rusqlite::types::Value::Text(source_session_id.to_string()),
        rusqlite::types::Value::Text(generation.to_string()),
    ];
    values.extend(
        extra_values
            .iter()
            .copied()
            .map(rusqlite::types::Value::Integer),
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare bounded replay query: {err}"))?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(values))
        .map_err(|err| format!("query bounded replay rows: {err}"))?;
    let mut chunks = Vec::new();
    let mut ipc_bytes = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read bounded replay row: {err}"))?
    {
        let chunk = decode_indexed_chunk(row, display_session_id)?;
        let next_bytes = serialized_indexed_chunk_bytes(&chunk);
        if ipc_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            if chunks.is_empty() {
                return Err(format!(
                    "Replay event {} exceeds the {} byte compact window budget",
                    chunk.chunk.chunk_id, limits.max_ipc_bytes
                ));
            }
            break;
        }
        ipc_bytes = ipc_bytes.saturating_add(next_bytes);
        chunks.push(chunk);
    }
    Ok(chunks)
}

pub(super) fn decode_indexed_chunk(
    row: &Row<'_>,
    display_session_id: &str,
) -> Result<ReplayIndexedChunk, String> {
    let args_json: String = row.get(6).map_err(|err| err.to_string())?;
    let result_json: String = row.get(7).map_err(|err| err.to_string())?;
    let payloads_json: String = row.get(10).map_err(|err| err.to_string())?;
    Ok(ReplayIndexedChunk {
        sequence: row.get(0).map_err(|err| err.to_string())?,
        turn_index: row.get(2).map_err(|err| err.to_string())?,
        chunk: ActivityChunk {
            chunk_id: row.get(1).map_err(|err| err.to_string())?,
            session_id: display_session_id.to_string(),
            action_type: row.get(3).map_err(|err| err.to_string())?,
            function: row.get(4).map_err(|err| err.to_string())?,
            args: serde_json::from_str(&args_json)
                .map_err(|err| format!("decode replay args preview: {err}"))?,
            result: serde_json::from_str(&result_json)
                .map_err(|err| format!("decode replay result preview: {err}"))?,
            created_at: row.get(5).map_err(|err| err.to_string())?,
            thread_id: row.get(8).map_err(|err| err.to_string())?,
            process_id: row.get(9).map_err(|err| err.to_string())?,
            broadcast_only: false,
        },
        payloads: serde_json::from_str::<Vec<ReplayPayloadDescriptor>>(&payloads_json)
            .map_err(|err| format!("decode replay payload locators: {err}"))?,
    })
}

pub(super) fn read_turn_headers(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    oldest_turn: i64,
    newest_turn: i64,
) -> Result<Vec<ReplayTurnHeader>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT turn_id, turn_index, start_sequence, end_sequence,
                    started_at, ended_at, event_count
             FROM imported_replay_turns
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND turn_index BETWEEN ?4 AND ?5
             ORDER BY turn_index ASC",
        )
        .map_err(|err| format!("prepare replay turn headers: {err}"))?;
    let rows = stmt
        .query_map(
            params![
                source.as_str(),
                source_session_id,
                generation,
                oldest_turn,
                newest_turn
            ],
            |row| {
                Ok(ReplayTurnHeader {
                    turn_id: row.get(0)?,
                    turn_index: row.get(1)?,
                    start_sequence: row.get(2)?,
                    end_sequence: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    event_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .map_err(|err| format!("query replay turn headers: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read replay turn header: {err}"))
}

pub(super) fn serialized_indexed_chunk_bytes(chunk: &ReplayIndexedChunk) -> usize {
    // Payload descriptors cross the Rust/JS boundary after normalization too;
    // omitting them here let descriptor-heavy events bypass maxIpcBytes.
    serde_json::to_vec(&chunk.chunk)
        .map_or(0, |bytes| bytes.len())
        .saturating_add(serde_json::to_vec(&chunk.payloads).map_or(0, |bytes| bytes.len()))
}
