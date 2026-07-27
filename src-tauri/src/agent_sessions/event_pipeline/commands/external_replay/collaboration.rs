use super::*;

// -------------------------------------------------------------------------
// ORGII-owned collaboration snapshot bounded SQL driver.
// -------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(super) struct CollaborationSnapshotState {
    pub(super) generation: String,
    pub(super) revision: u64,
    pub(super) reset_revision: u64,
    pub(super) max_sequence: i64,
    pub(super) event_count: u64,
}

pub(super) fn validate_collaboration_snapshot_session_id(session_id: &str) -> Result<(), String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX)
        && session_id.len() > COLLABORATION_SNAPSHOT_SESSION_PREFIX.len()
        && !session_id.contains(['/', '\\'])
    {
        return Ok(());
    }
    Err(format!(
        "collaboration snapshot session id must start with {COLLABORATION_SNAPSHOT_SESSION_PREFIX}"
    ))
}

/// Install mutation accounting once, then seed a pre-existing imported copy.
/// INSERTs at the append frontier keep the generation and advance revision;
/// UPDATE/DELETE or out-of-order INSERTs force a generation reset. The
/// triggers observe writes made by the normal cache path without copying any
/// transcript body into a second store.
pub(super) fn ensure_collaboration_snapshot_state(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    validate_collaboration_snapshot_session_id(session_id)?;
    let state_table_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='collaboration_replay_state')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("inspect collaboration replay state schema: {error}"))?
        != 0;
    let trigger_count = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN(
               'collaboration_replay_events_insert',
               'collaboration_replay_events_delete',
               'collaboration_replay_events_update_old',
               'collaboration_replay_events_update_new'
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("inspect collaboration replay triggers: {error}"))?;
    let state_exists = state_table_exists
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_replay_state WHERE session_id=?1)",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("inspect collaboration replay session state: {error}"))?
            != 0;
    if trigger_count == 4 && state_exists {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collaboration_replay_state (
             session_id TEXT PRIMARY KEY,
             generation INTEGER NOT NULL DEFAULT 0,
             revision INTEGER NOT NULL DEFAULT 0,
             max_sequence INTEGER NOT NULL DEFAULT -1,
             event_count INTEGER NOT NULL DEFAULT 0
         );
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_insert
         AFTER INSERT ON events
         WHEN NEW.session_id GLOB 'imported-session-*'
         BEGIN
           INSERT INTO collaboration_replay_state(
             session_id,generation,revision,max_sequence,event_count
           ) VALUES(
             NEW.session_id,0,1,COALESCE(NEW.history_sequence,NEW.rowid),1
           )
           ON CONFLICT(session_id) DO UPDATE SET
             generation = collaboration_replay_state.generation +
               CASE WHEN collaboration_replay_state.max_sequence=-2 THEN 0
                    WHEN COALESCE(NEW.history_sequence,NEW.rowid) >
                              collaboration_replay_state.max_sequence
                    THEN 0 ELSE 1 END,
             revision = collaboration_replay_state.revision + 1,
             max_sequence = CASE
               WHEN collaboration_replay_state.max_sequence=-2 THEN -2
               ELSE MAX(
                 collaboration_replay_state.max_sequence,
                 COALESCE(NEW.history_sequence,NEW.rowid)
               ) END,
             event_count = collaboration_replay_state.event_count + 1;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_delete
         AFTER DELETE ON events
         WHEN OLD.session_id GLOB 'imported-session-*'
         BEGIN
           UPDATE collaboration_replay_state
           SET generation = generation + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               revision = revision + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               max_sequence = -2,
               event_count = MAX(event_count - 1,0)
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_update_old
         AFTER UPDATE ON events
         WHEN OLD.session_id GLOB 'imported-session-*'
         BEGIN
           UPDATE collaboration_replay_state
           SET generation = generation + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               revision = revision + CASE WHEN max_sequence=-2 THEN 0 ELSE 1 END,
               max_sequence = -2,
               event_count = MAX(
                 event_count - CASE WHEN NEW.session_id != OLD.session_id THEN 1 ELSE 0 END,
                 0
               )
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_replay_events_update_new
         AFTER UPDATE ON events
         WHEN NEW.session_id GLOB 'imported-session-*'
              AND NEW.session_id != OLD.session_id
         BEGIN
           INSERT INTO collaboration_replay_state(
             session_id,generation,revision,max_sequence,event_count
           )
           VALUES(
             NEW.session_id,0,1,COALESCE(NEW.history_sequence,NEW.rowid),1
           )
           ON CONFLICT(session_id) DO UPDATE SET
             generation = collaboration_replay_state.generation +
               CASE WHEN collaboration_replay_state.max_sequence=-2 THEN 0 ELSE 1 END,
             revision = collaboration_replay_state.revision +
               CASE WHEN collaboration_replay_state.max_sequence=-2 THEN 0 ELSE 1 END,
             max_sequence = -2,
             event_count = collaboration_replay_state.event_count + 1;
         END;",
    )
    .map_err(|error| format!("initialize collaboration replay state: {error}"))?;
    conn.execute(
        "INSERT INTO collaboration_replay_state(
           session_id,generation,revision,max_sequence,event_count
         )
         SELECT ?1,0,COUNT(*),
                COALESCE(MAX(COALESCE(history_sequence,rowid)),-1),COUNT(*)
         FROM events WHERE session_id=?1
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )
    .map_err(|error| format!("seed collaboration replay state: {error}"))?;
    Ok(())
}

pub(super) fn collaboration_snapshot_state(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<CollaborationSnapshotState, String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_FORK_PREFIX) {
        return crate::agent_sessions::event_pipeline::commands::collaboration_snapshot_ingest::collaboration_snapshot_secondary_state(conn, session_id)?
        .map(|state| CollaborationSnapshotState {
            generation: state.generation,
            revision: state.revision,
            reset_revision: state.reset_revision,
            max_sequence: state.max_sequence,
            event_count: state.event_count,
        })
        .ok_or_else(|| {
            format!(
                "Native Agent session is not backed by an intact collaboration snapshot: {session_id}"
            )
        });
    }
    ensure_collaboration_snapshot_state(conn, session_id)?;
    let mut state = conn
        .query_row(
            "SELECT generation,revision,max_sequence,event_count
         FROM collaboration_replay_state WHERE session_id=?1",
            [session_id],
            |row| {
                let generation = row.get::<_, i64>(0)?.max(0);
                Ok(CollaborationSnapshotState {
                    generation: format!(
                        "collaboration-v{COLLABORATION_SNAPSHOT_DRIVER_VERSION}-{generation}"
                    ),
                    revision: row.get::<_, i64>(1)?.max(0) as u64,
                    reset_revision: 0,
                    max_sequence: row.get(2)?,
                    event_count: row.get::<_, i64>(3)?.max(0) as u64,
                })
            },
        )
        .map_err(|error| format!("read collaboration replay state: {error}"))?;
    if state.max_sequence == -2 {
        conn.execute(
            "UPDATE collaboration_replay_state
             SET max_sequence=COALESCE((
                   SELECT MAX(history_sequence) FROM events WHERE session_id=?1
                 ),-1),
                 event_count=(
                   SELECT COUNT(*) FROM events WHERE session_id=?1
                 )
             WHERE session_id=?1",
            [session_id],
        )
        .map_err(|error| format!("refresh dirty collaboration replay state: {error}"))?;
        let (max_sequence, event_count) = conn
            .query_row(
                "SELECT max_sequence,event_count FROM collaboration_replay_state
                 WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|error| format!("reload collaboration replay state: {error}"))?;
        state.max_sequence = max_sequence;
        state.event_count = event_count.max(0) as u64;
    }
    let has_unsequenced_rows = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM events
             WHERE session_id=?1 AND history_sequence IS NULL)",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("validate collaboration replay sequences: {error}"))?
        != 0;
    if has_unsequenced_rows {
        return Err(
            "Collaboration snapshot contains an event without history_sequence; retry the atomic import"
                .to_string(),
        );
    }
    Ok(state)
}

pub(super) fn snapshot_user_predicate() -> &'static str {
    "(event_type IN ('user','user_message')
       OR function_name IN ('user','user_message')
       OR CASE WHEN json_valid(meta_json)
               THEN json_extract(meta_json,'$.source')='user'
               ELSE 0 END)"
}

pub(super) fn collaboration_snapshot_turn_count(
    conn: &rusqlite::Connection,
    session_id: &str,
    event_count: u64,
) -> Result<u64, String> {
    let sql = format!(
        "SELECT COUNT(*) FROM events WHERE session_id=?1 AND {}",
        snapshot_user_predicate()
    );
    let user_count = conn
        .query_row(&sql, [session_id], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("count collaboration replay turns: {error}"))?
        .max(0) as u64;
    Ok(if user_count == 0 && event_count > 0 {
        1
    } else {
        user_count
    })
}

pub(super) fn collaboration_snapshot_turn_sequence(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_index: i64,
) -> Result<Option<i64>, String> {
    if turn_index < 0 {
        return Ok(None);
    }
    let sql = format!(
        "SELECT history_sequence FROM events
         WHERE session_id=?1 AND {}
           AND history_sequence IS NOT NULL
         ORDER BY history_sequence ASC,id ASC
         LIMIT 1 OFFSET ?2",
        snapshot_user_predicate()
    );
    conn.query_row(&sql, rusqlite::params![session_id, turn_index], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|error| format!("resolve collaboration replay turn index: {error}"))
}

pub(super) fn collaboration_snapshot_turn_id_sequence(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT history_sequence FROM events
         WHERE session_id=?1 AND id=?2 AND history_sequence IS NOT NULL",
        rusqlite::params![session_id, turn_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("resolve collaboration replay turn id: {error}"))
}

pub(super) fn collaboration_snapshot_latest_turn_start(
    conn: &rusqlite::Connection,
    session_id: &str,
    max_turns: usize,
) -> Result<Option<i64>, String> {
    let sql = format!(
        "SELECT history_sequence FROM events
         WHERE session_id=?1 AND {}
           AND history_sequence IS NOT NULL
         ORDER BY history_sequence DESC,id DESC
         LIMIT 1 OFFSET ?2",
        snapshot_user_predicate()
    );
    conn.query_row(
        &sql,
        rusqlite::params![session_id, max_turns.saturating_sub(1) as i64],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("resolve latest collaboration replay turn: {error}"))
}

pub(super) fn snapshot_root_preview(raw_prefix: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "_replayTruncated": true,
        "_preview": raw_prefix.unwrap_or_else(|| "[payload truncated]".to_string()),
    })
}

pub(super) fn snapshot_payload_ref(
    event_id: &str,
    field_path: &str,
    preview: String,
    full_size_bytes: i64,
    generation: &str,
    encoding: PayloadRefEncoding,
) -> PayloadRef {
    PayloadRef {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        preview,
        full_size_bytes: full_size_bytes.max(0) as usize,
        truncated: true,
        replay_encoding: Some(encoding),
        replay_source_id: Some(COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID.to_string()),
        replay_generation: Some(generation.to_string()),
        replay_source_event_id: Some(event_id.to_string()),
    }
}

pub(super) fn query_collaboration_snapshot_events(
    conn: &rusqlite::Connection,
    session_id: &str,
    generation: &str,
    lower_exclusive: i64,
    upper_exclusive: i64,
    limits: ReplayLimits,
    newest_first: bool,
) -> Result<Vec<(i64, SessionEvent)>, String> {
    let limits = limits.bounded();
    let order = if newest_first { "DESC" } else { "ASC" };
    // args are never loaded past the normal preview boundary; result allows
    // the Shell preview boundary. Oversized roots are reconstructed only by
    // `read_payload_range`, never by the ordinary window query.
    let sql = format!(
        "SELECT id,session_id,event_type,function_name,thread_id,
                CASE WHEN length(CAST(args_json AS BLOB))<=?4
                     THEN args_json ELSE '{{}}' END,
                CASE WHEN length(CAST(result_json AS BLOB))<=?5
                     THEN result_json ELSE '{{}}' END,
                created_at,
                CASE WHEN json_valid(meta_json) THEN
                  CASE WHEN length(CAST(json_extract(meta_json,'$.displayText') AS BLOB))>?4
                       THEN json_set(meta_json,'$.displayText',
                            substr(json_extract(meta_json,'$.displayText'),1,2048))
                       ELSE meta_json END
                ELSE meta_json END,
                history_sequence,
                length(CAST(args_json AS BLOB)),
                length(CAST(result_json AS BLOB)),
                CASE WHEN length(CAST(args_json AS BLOB))>?4
                     THEN substr(args_json,1,2048) END,
                CASE WHEN length(CAST(result_json AS BLOB))>?5
                     THEN substr(result_json,1,8192) END,
                CASE WHEN json_valid(meta_json)
                     THEN length(CAST(json_extract(meta_json,'$.displayText') AS BLOB))
                     ELSE 0 END
         FROM events
         WHERE session_id=?1
           AND history_sequence>?2
           AND history_sequence<?3
         ORDER BY history_sequence {order},id {order}
         LIMIT {}",
        limits.max_events
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| format!("prepare bounded collaboration replay: {error}"))?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            lower_exclusive,
            upper_exclusive,
            replay::NORMAL_PAYLOAD_PREVIEW_BYTES as i64,
            replay::SHELL_PAYLOAD_PREVIEW_BYTES as i64,
        ])
        .map_err(|error| format!("query bounded collaboration replay: {error}"))?;
    let mut indexed = Vec::new();
    let mut wire_bytes = 0_usize;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read bounded collaboration replay: {error}"))?
    {
        let sequence: i64 = row.get(9).map_err(|error| error.to_string())?;
        let args_size: i64 = row
            .get::<_, Option<i64>>(10)
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let result_size: i64 = row
            .get::<_, Option<i64>>(11)
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let args_prefix: Option<String> = row.get(12).map_err(|error| error.to_string())?;
        let result_prefix: Option<String> = row.get(13).map_err(|error| error.to_string())?;
        let display_size: i64 = row
            .get::<_, Option<i64>>(14)
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let cached = session_persistence::CachedEvent {
            id: row.get(0).map_err(|error| error.to_string())?,
            session_id: row.get(1).map_err(|error| error.to_string())?,
            event_type: row.get(2).map_err(|error| error.to_string())?,
            function_name: row.get(3).map_err(|error| error.to_string())?,
            thread_id: row.get(4).map_err(|error| error.to_string())?,
            args_json: row.get(5).map_err(|error| error.to_string())?,
            result_json: row.get(6).map_err(|error| error.to_string())?,
            content: String::new(),
            created_at: row.get(7).map_err(|error| error.to_string())?,
            meta_json: row.get(8).map_err(|error| error.to_string())?,
            history_sequence: Some(sequence),
        };
        let mut event = cached_event_to_session_event(&cached);
        event.payload_refs.clear();
        if args_size as usize > replay::NORMAL_PAYLOAD_PREVIEW_BYTES {
            event.args = snapshot_root_preview(args_prefix);
            event.payload_refs.push(snapshot_payload_ref(
                &event.id,
                "args",
                json_field_preview(&event, "args"),
                args_size,
                generation,
                PayloadRefEncoding::JsonValue,
            ));
        }
        let result_limit = if event.ui_canonical == core_types::tool_names::RUN_SHELL {
            replay::SHELL_PAYLOAD_PREVIEW_BYTES
        } else {
            replay::NORMAL_PAYLOAD_PREVIEW_BYTES
        };
        if result_size as usize > result_limit {
            event.result = snapshot_root_preview(result_prefix);
            event.payload_refs.push(snapshot_payload_ref(
                &event.id,
                "result",
                json_field_preview(&event, "result"),
                result_size,
                generation,
                PayloadRefEncoding::JsonValue,
            ));
        }
        if display_size as usize > replay::NORMAL_PAYLOAD_PREVIEW_BYTES {
            event.payload_refs.push(snapshot_payload_ref(
                &event.id,
                "displayText",
                event.display_text.clone(),
                display_size,
                generation,
                PayloadRefEncoding::Utf8Text,
            ));
        }
        // Extraction must see compact values. This prevents a deferred root
        // from being copied into a second large rendering envelope.
        event.extracted = None;
        event.recompute_extracted();
        let next_bytes = serde_json::to_vec(&event)
            .map_err(|error| format!("measure collaboration replay event: {error}"))?
            .len();
        if !indexed.is_empty() && wire_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            break;
        }
        if indexed.is_empty() && next_bytes > limits.max_ipc_bytes {
            return Err(format!(
                "Collaboration replay event {} exceeds the {} byte compact window budget",
                event.id, limits.max_ipc_bytes
            ));
        }
        wire_bytes = wire_bytes.saturating_add(next_bytes);
        indexed.push((sequence, event));
    }
    if newest_first {
        indexed.reverse();
    }
    Ok(indexed)
}

pub(super) fn collaboration_snapshot_turn_headers(
    conn: &rusqlite::Connection,
    session_id: &str,
    events: &[(i64, SessionEvent)],
) -> Result<Vec<ReplayTurnHeader>, String> {
    if events.is_empty() {
        return Ok(Vec::new());
    }
    let mut starts = events
        .iter()
        .enumerate()
        .filter(|(_, (_, event))| event.source == EventSource::User)
        .map(|(offset, (sequence, event))| (offset, *sequence, event))
        .collect::<Vec<_>>();
    if starts.is_empty() {
        starts.push((0, events[0].0, &events[0].1));
    }
    let mut headers = Vec::with_capacity(starts.len());
    for (position, (offset, start_sequence, event)) in starts.iter().enumerate() {
        let next_offset = starts
            .get(position + 1)
            .map_or(events.len(), |(next, _, _)| *next);
        let end = events.get(next_offset.saturating_sub(1));
        let sql = format!(
            "SELECT COUNT(*) FROM events WHERE session_id=?1
             AND history_sequence<?2 AND {}",
            snapshot_user_predicate()
        );
        let turn_index = conn
            .query_row(&sql, rusqlite::params![session_id, start_sequence], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| format!("index collaboration replay turn: {error}"))?;
        headers.push(ReplayTurnHeader {
            turn_id: event.id.clone(),
            turn_index,
            start_sequence: *start_sequence,
            end_sequence: end.map(|(sequence, _)| *sequence),
            started_at: event.created_at.clone(),
            ended_at: end.map(|(_, event)| event.created_at.clone()),
            event_count: next_offset.saturating_sub(*offset) as u64,
        });
    }
    Ok(headers)
}

pub(super) fn collaboration_snapshot_read_window_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ExternalReplayWindow, String> {
    let limits = limits.bounded();
    let exact_turn = turn_id.is_some() || turn_index.is_some();
    let state = collaboration_snapshot_state(conn, session_id)?;
    let (lower_exclusive, upper_exclusive) = if let Some(turn_id) = turn_id {
        let start = collaboration_snapshot_turn_id_sequence(conn, session_id, turn_id)?
            .ok_or_else(|| format!("Collaboration replay turn is unavailable: {turn_id}"))?;
        let next = conn
            .query_row(
                &format!(
                    "SELECT history_sequence FROM events
                     WHERE session_id=?1 AND history_sequence>?2 AND {}
                     ORDER BY history_sequence ASC,id ASC LIMIT 1",
                    snapshot_user_predicate()
                ),
                rusqlite::params![session_id, start],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("resolve next collaboration replay turn: {error}"))?
            .unwrap_or(i64::MAX);
        (start.saturating_sub(1), next)
    } else if let Some(turn_index) = turn_index {
        let start = collaboration_snapshot_turn_sequence(conn, session_id, turn_index)?
            .ok_or_else(|| {
                format!("Collaboration replay turn index is unavailable: {turn_index}")
            })?;
        let next = collaboration_snapshot_turn_sequence(conn, session_id, turn_index + 1)?
            .unwrap_or(i64::MAX);
        (start.saturating_sub(1), next)
    } else if let Some(before_sequence) = before_sequence {
        (-1, before_sequence)
    } else {
        let start = collaboration_snapshot_latest_turn_start(conn, session_id, limits.max_turns)?
            .unwrap_or(-1);
        (start.saturating_sub(1), i64::MAX)
    };
    let (indexed, window_start_sequence) = if exact_turn {
        read_collaboration_exact_turn_events(
            conn,
            session_id,
            &state.generation,
            lower_exclusive,
            upper_exclusive,
            limits,
        )?
    } else {
        let indexed = query_collaboration_snapshot_events(
            conn,
            session_id,
            &state.generation,
            lower_exclusive,
            upper_exclusive,
            limits,
            true,
        )?;
        let window_start_sequence = indexed.first().map(|(sequence, _)| *sequence);
        (indexed, window_start_sequence)
    };
    let through_sequence = indexed.last().map_or(-1, |(sequence, _)| *sequence);
    let has_older = if let Some(continuation_sequence) = window_start_sequence {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM events
                 WHERE session_id=?1 AND history_sequence<?2)",
            rusqlite::params![session_id, continuation_sequence],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("query older collaboration replay events: {error}"))?
            != 0
    } else {
        false
    };
    let turn_headers = if exact_turn {
        collaboration_snapshot_exact_turn_header(
            conn,
            session_id,
            lower_exclusive.saturating_add(1),
            upper_exclusive,
        )?
        .into_iter()
        .collect()
    } else {
        collaboration_snapshot_turn_headers(conn, session_id, &indexed)?
    };
    let total_turn_count = collaboration_snapshot_turn_count(conn, session_id, state.event_count)?;
    let parsed_rows = indexed.len() as u64;
    let events = indexed
        .into_iter()
        .map(|(_, event)| event)
        .collect::<Vec<_>>();
    let ipc_bytes = serde_json::to_vec(&events).map_or(0, |bytes| bytes.len()) as u64;
    let current = collaboration_snapshot_state(conn, session_id)?;
    validate_query_apply_version(
        &state.generation,
        state.revision,
        &current.generation,
        current.revision,
    )?;
    Ok(ExternalReplayWindow {
        cursor: ReplayCursor {
            source_id: COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID.to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        events,
        window_start_sequence,
        turn_headers,
        total_turn_count,
        total_event_count: state.event_count,
        has_older,
        stats: ReplayStats {
            parsed_rows,
            normalized_events: parsed_rows,
            ipc_bytes,
            ..ReplayStats::default()
        },
        watcher_available: false,
    })
}

fn read_collaboration_exact_turn_events(
    conn: &rusqlite::Connection,
    session_id: &str,
    generation: &str,
    lower_exclusive: i64,
    upper_exclusive: i64,
    limits: ReplayLimits,
) -> Result<(Vec<(i64, SessionEvent)>, Option<i64>), String> {
    let anchor_limits = ReplayLimits {
        max_turns: 1,
        max_events: 1,
        max_ipc_bytes: limits.max_ipc_bytes,
    };
    let mut indexed = query_collaboration_snapshot_events(
        conn,
        session_id,
        generation,
        lower_exclusive,
        upper_exclusive,
        anchor_limits,
        false,
    )?;
    let Some(anchor_sequence) = indexed.first().map(|(sequence, _)| *sequence) else {
        return Ok((indexed, None));
    };
    let anchor_bytes = indexed
        .first()
        .and_then(|(_, event)| serde_json::to_vec(event).ok())
        .map_or(0, |bytes| bytes.len());
    let Some(tail_limits) = limits.after_exact_turn_anchor(anchor_bytes) else {
        return Ok((indexed, Some(anchor_sequence)));
    };
    let mut tail = query_collaboration_snapshot_events(
        conn,
        session_id,
        generation,
        anchor_sequence,
        upper_exclusive,
        tail_limits,
        true,
    )?;
    let tail_start_sequence = tail.first().map(|(sequence, _)| *sequence);
    let has_gap = if let Some(tail_start_sequence) = tail_start_sequence {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM events
                WHERE session_id=?1 AND history_sequence>?2 AND history_sequence<?3
             )",
            rusqlite::params![session_id, anchor_sequence, tail_start_sequence],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("query exact collaboration replay turn gap: {error}"))?
            != 0
    } else {
        false
    };
    let window_start_sequence = if has_gap {
        tail_start_sequence
    } else {
        Some(anchor_sequence)
    };
    indexed.append(&mut tail);
    Ok((indexed, window_start_sequence))
}

fn collaboration_snapshot_exact_turn_header(
    conn: &rusqlite::Connection,
    session_id: &str,
    start_sequence: i64,
    upper_exclusive: i64,
) -> Result<Option<ReplayTurnHeader>, String> {
    let anchor = conn
        .query_row(
            "SELECT id,created_at FROM events
             WHERE session_id=?1 AND history_sequence=?2
             ORDER BY id ASC LIMIT 1",
            rusqlite::params![session_id, start_sequence],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("query collaboration replay turn anchor: {error}"))?;
    let Some((turn_id, started_at)) = anchor else {
        return Ok(None);
    };
    let turn_index = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM events WHERE session_id=?1
                 AND history_sequence<?2 AND {}",
                snapshot_user_predicate()
            ),
            rusqlite::params![session_id, start_sequence],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("index collaboration replay exact turn: {error}"))?;
    let (end_sequence, ended_at, event_count) = conn
        .query_row(
            "SELECT MAX(history_sequence),
                    (SELECT tail.created_at FROM events AS tail
                     WHERE tail.session_id=?1 AND tail.history_sequence>=?2
                       AND tail.history_sequence<?3
                     ORDER BY tail.history_sequence DESC,tail.id DESC LIMIT 1),
                    COUNT(*)
             FROM events
             WHERE session_id=?1 AND history_sequence>=?2 AND history_sequence<?3",
            rusqlite::params![session_id, start_sequence, upper_exclusive],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|error| format!("summarize collaboration replay exact turn: {error}"))?;
    Ok(Some(ReplayTurnHeader {
        turn_id,
        turn_index,
        start_sequence,
        end_sequence,
        started_at,
        ended_at,
        event_count: event_count.max(0) as u64,
    }))
}

pub(super) fn collaboration_snapshot_poll_delta_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
) -> Result<ExternalReplayDelta, String> {
    let state = collaboration_snapshot_state(conn, session_id)?;
    if state.generation != cursor.generation {
        return Ok(ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID.to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: -1,
            },
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    if state.reset_revision > cursor.revision {
        return Ok(ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID.to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: -1,
            },
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    if state.revision == cursor.revision && cursor.through_sequence >= state.max_sequence {
        return Ok(ExternalReplayDelta {
            cursor: cursor.clone(),
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: false,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    let indexed = query_collaboration_snapshot_events(
        conn,
        session_id,
        &state.generation,
        cursor.through_sequence,
        state.max_sequence.saturating_add(1),
        limits,
        false,
    )?;
    if indexed.is_empty() && state.revision != cursor.revision {
        return Ok(ExternalReplayDelta {
            cursor: ReplayCursor {
                source_id: COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID.to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: -1,
            },
            events: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
            watcher_available: false,
        });
    }
    let through_sequence = indexed
        .last()
        .map_or(cursor.through_sequence, |(sequence, _)| *sequence);
    let parsed_rows = indexed.len() as u64;
    let events = indexed
        .into_iter()
        .map(|(_, event)| event)
        .collect::<Vec<_>>();
    let ipc_bytes = serde_json::to_vec(&events).map_or(0, |bytes| bytes.len()) as u64;
    let current = collaboration_snapshot_state(conn, session_id)?;
    validate_query_apply_version(
        &state.generation,
        state.revision,
        &current.generation,
        current.revision,
    )?;
    Ok(ExternalReplayDelta {
        cursor: ReplayCursor {
            source_id: COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID.to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        events,
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats {
            parsed_rows,
            normalized_events: parsed_rows,
            ipc_bytes,
            ..ReplayStats::default()
        },
        watcher_available: false,
    })
}

pub(super) fn collaboration_snapshot_payload_range_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let state = collaboration_snapshot_state(conn, session_id)?;
    if state.generation != generation {
        return Err(format!(
            "Collaboration replay generation changed: requested {generation}, current {}",
            state.generation
        ));
    }
    let (root, path) = field_path.split_once('.').unwrap_or((field_path, ""));
    let (column, json_path) = match root {
        "args" => (
            "args_json",
            (!path.is_empty()).then(|| replay_sqlite_json_path(path)),
        ),
        "result" => (
            "result_json",
            (!path.is_empty()).then(|| replay_sqlite_json_path(path)),
        ),
        "displayText" if path.is_empty() => (
            "meta_json",
            Some(Ok::<String, String>("$.displayText".to_string())),
        ),
        _ => return Err("fieldPath must start with args, result or displayText".to_string()),
    };
    let start = offset.min(i64::MAX as u64) as i64;
    let read_bytes = max_bytes.saturating_add(4).min(i64::MAX as usize) as i64;
    let (total_bytes, bytes): (Option<i64>, Option<Vec<u8>>) = if let Some(path) = json_path {
        let path = path?;
        let sql = format!(
            "SELECT length(CAST(json_extract({column},?3) AS BLOB)),
                    substr(CAST(json_extract({column},?3) AS BLOB),?4,?5)
             FROM events WHERE session_id=?1 AND id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![
                session_id,
                event_id,
                path,
                start.saturating_add(1),
                read_bytes
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    } else {
        let sql = format!(
            "SELECT length(CAST({column} AS BLOB)),
                    substr(CAST({column} AS BLOB),?3,?4)
             FROM events WHERE session_id=?1 AND id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![session_id, event_id, start.saturating_add(1), read_bytes],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }
    .map_err(|error| format!("load collaboration replay payload range: {error}"))?;
    let total_bytes = total_bytes
        .ok_or_else(|| format!("collaboration replay payload field not found: {field_path}"))?
        .max(0) as u64;
    let bytes = bytes.unwrap_or_default();
    let mut take = max_bytes.min(bytes.len());
    while take > 0 && std::str::from_utf8(&bytes[..take]).is_err() {
        take -= 1;
    }
    if take == 0 && !bytes.is_empty() {
        return Err(format!(
            "collaboration replay range starts inside invalid UTF-8: {field_path} at {offset}"
        ));
    }
    let text = String::from_utf8(bytes[..take].to_vec())
        .map_err(|error| format!("decode collaboration replay payload range: {error}"))?;
    let next_offset = offset.saturating_add(take as u64).min(total_bytes);
    let range = ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: offset.min(total_bytes),
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    };
    let current = collaboration_snapshot_state(conn, session_id)?;
    if current.generation != generation {
        return Err(format!(
            "Collaboration replay generation changed during payload read: requested {generation}, current {}",
            current.generation
        ));
    }
    Ok(range)
}

// -------------------------------------------------------------------------
// Readerless managed CLI bounded SQL driver.
// -------------------------------------------------------------------------
