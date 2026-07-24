use super::*;

pub(super) fn managed_chunk_generation(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<String, String> {
    let epoch = conn
        .query_row(
            "SELECT epoch FROM code_session_history_mutations WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("read managed history generation: {err}"))?
        .unwrap_or(0);
    Ok(format!("chunks-{epoch}"))
}

pub(super) fn managed_chunk_stream_cursor(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<(String, i64), String> {
    let generation = managed_chunk_generation(conn, session_id)?;
    let max_sequence = conn
        .query_row(
            "SELECT COALESCE(MAX(sequence), -1) FROM code_session_chunks WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("read managed replay stream revision: {err}"))?;
    Ok((generation, max_sequence))
}

pub(super) fn validate_managed_chunk_stream_cursor(
    expected_generation: &str,
    expected_max_sequence: i64,
    current: &(String, i64),
    operation: &str,
) -> Result<(), String> {
    if current.0 == expected_generation && current.1 == expected_max_sequence {
        return Ok(());
    }
    Err(format!(
        "Managed replay changed while {operation}: expected {expected_generation}@{expected_max_sequence}, found {}@{}; retry from the new replay cursor",
        current.0, current.1
    ))
}

/// Shared readerless managed-CLI scan used by both streamed export and Cloud
/// spooling. Keeping the database cursor and the bounded payload reader on the
/// same connection makes it impossible for either consumer to reintroduce a
/// full args/result materialization behind a separate code path.
pub(super) fn stream_managed_chunk_replay_events_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    operation: &str,
    mut consume: impl FnMut(
        &SessionEvent,
        &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
    ) -> Result<(), String>,
) -> Result<String, String> {
    let (generation, max_sequence) = managed_chunk_stream_cursor(conn, session_id)?;
    let limits = ReplayLimits {
        max_turns: 10,
        max_events: STREAM_BATCH_MAX_EVENTS,
        max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
    };
    let mut after_sequence = -1_i64;
    loop {
        if managed_chunk_generation(conn, session_id)? != generation {
            return Err(format!(
                "Managed replay changed while {operation}; retry from the new generation"
            ));
        }
        let chunks = query_managed_chunks(
            conn,
            session_id,
            "sequence > ?2",
            after_sequence,
            Some(max_sequence),
            limits,
            false,
        )?;
        if chunks.is_empty() {
            break;
        }
        let next_sequence = chunks.last().map_or(after_sequence, |chunk| chunk.sequence);
        let (events, _) = normalize_indexed_chunks(
            chunks,
            session_id,
            MANAGED_CLI_REPLAY_TARGET_ID,
            &generation,
        );
        for event in &events {
            let mut read_payload = |payload_ref: &PayloadRef, offset: u64| {
                managed_chunk_payload_range_from_conn(
                    conn,
                    session_id,
                    payload_ref
                        .replay_source_event_id
                        .as_deref()
                        .unwrap_or(&payload_ref.event_id),
                    &payload_ref.field_path,
                    offset,
                    EXPORT_PAYLOAD_RANGE_BYTES,
                )
            };
            consume(event, &mut read_payload)?;
        }
        if next_sequence <= after_sequence {
            return Err(format!(
                "Managed replay cursor did not advance while {operation}"
            ));
        }
        after_sequence = next_sequence;
    }
    validate_managed_chunk_stream_cursor(
        &generation,
        max_sequence,
        &managed_chunk_stream_cursor(conn, session_id)?,
        operation,
    )?;
    Ok(generation)
}

pub(super) fn managed_chunk_open_window(
    session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    managed_chunk_read_window(session_id, None, None, None, limits)
}

pub(super) fn managed_chunk_read_window(
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let conn =
        database::db::get_connection().map_err(|err| format!("open managed chunks DB: {err}"))?;
    managed_chunk_read_window_from_conn(
        &conn,
        session_id,
        before_sequence,
        turn_id,
        turn_index,
        limits,
    )
}

pub(super) fn managed_chunk_read_window_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let limits = limits.bounded();
    let (generation, source_revision) = managed_chunk_stream_cursor(conn, session_id)?;
    let source_revision = source_revision.max(0) as u64;
    let (total_event_count, total_turn_count) = managed_chunk_total_counts(conn, session_id)?;
    if total_event_count == 0 {
        return Ok(ReplayChunkWindow {
            cursor: ReplayCursor {
                source_id: MANAGED_CLI_REPLAY_TARGET_ID.to_string(),
                session_id: session_id.to_string(),
                generation,
                revision: source_revision,
                through_sequence: -1,
            },
            chunks: Vec::new(),
            turn_headers: Vec::new(),
            total_turn_count: 0,
            total_event_count: 0,
            has_older: false,
            stats: ReplayStats::default(),
        });
    }

    let newest_turn_index = if let Some(turn_id) = turn_id {
        Some(managed_chunk_turn_index_for_id(
            conn,
            session_id,
            turn_id,
            total_turn_count,
        )?)
    } else if let Some(turn_index) = turn_index {
        if turn_index < 0 || turn_index >= total_turn_count as i64 {
            return Err(format!(
                "Managed replay turn index is no longer available: {turn_index}"
            ));
        }
        Some(turn_index)
    } else {
        managed_chunk_latest_turn_index_before(
            conn,
            session_id,
            before_sequence.unwrap_or(i64::MAX),
        )?
    };

    let Some(newest_turn_index) = newest_turn_index else {
        return Ok(ReplayChunkWindow {
            cursor: ReplayCursor {
                source_id: MANAGED_CLI_REPLAY_TARGET_ID.to_string(),
                session_id: session_id.to_string(),
                generation,
                revision: source_revision,
                through_sequence: -1,
            },
            chunks: Vec::new(),
            turn_headers: Vec::new(),
            total_turn_count,
            total_event_count,
            has_older: false,
            stats: ReplayStats::default(),
        });
    };
    let oldest_turn_index = newest_turn_index
        .saturating_sub(limits.max_turns.saturating_sub(1) as i64)
        .max(0);
    let mut turn_headers = Vec::with_capacity(
        newest_turn_index
            .saturating_sub(oldest_turn_index)
            .saturating_add(1) as usize,
    );
    for index in oldest_turn_index..=newest_turn_index {
        turn_headers.push(managed_chunk_turn_header_at_index(
            conn,
            session_id,
            index,
            total_turn_count,
        )?);
    }
    let start_sequence = turn_headers
        .first()
        .map(|header| header.start_sequence)
        .unwrap_or(0);
    let mut end_sequence = turn_headers
        .last()
        .and_then(|header| header.end_sequence)
        .unwrap_or(start_sequence);
    if let Some(before_sequence) = before_sequence {
        end_sequence = end_sequence.min(before_sequence.saturating_sub(1));
    }
    let mut chunks = query_managed_chunks(
        conn,
        session_id,
        "sequence >= ?2",
        start_sequence,
        Some(end_sequence),
        limits,
        true,
    )?;
    for chunk in &mut chunks {
        if let Some(header) = turn_headers.iter().find(|header| {
            chunk.sequence >= header.start_sequence
                && chunk.sequence <= header.end_sequence.unwrap_or(header.start_sequence)
        }) {
            chunk.turn_index = header.turn_index;
        }
    }
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let has_older = oldest_turn_index > 0
        || chunks
            .first()
            .is_some_and(|chunk| chunk.sequence > start_sequence);
    Ok(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: MANAGED_CLI_REPLAY_TARGET_ID.to_string(),
            session_id: session_id.to_string(),
            generation,
            // `revision` identifies the source snapshot, while
            // `through_sequence` identifies this page. Older pages from the
            // same snapshot must therefore keep one stable revision.
            revision: source_revision,
            through_sequence,
        },
        chunks,
        turn_headers,
        total_turn_count,
        total_event_count,
        has_older,
        stats: ReplayStats::default(),
    })
}

pub(super) fn managed_chunk_total_counts(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<(u64, u64), String> {
    let (event_count, user_turn_count) = conn
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN function='user_message' THEN 1 ELSE 0 END)
             FROM code_session_chunks WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map_err(|err| format!("count managed replay turns: {err}"))?;
    let event_count = event_count.max(0) as u64;
    let turn_count = if event_count == 0 {
        0
    } else {
        user_turn_count.unwrap_or(0).max(1) as u64
    };
    Ok((event_count, turn_count))
}

pub(super) fn managed_chunk_user_turn_anchor_at_index(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_index: i64,
) -> Result<Option<(i64, String, String)>, String> {
    conn.query_row(
        "SELECT sequence,chunk_id,created_at
         FROM code_session_chunks
         WHERE session_id=?1 AND function='user_message'
         ORDER BY sequence ASC LIMIT 1 OFFSET ?2",
        rusqlite::params![session_id, turn_index],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(|err| format!("query managed replay turn {turn_index}: {err}"))
}

pub(super) fn managed_chunk_turn_header_at_index(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_index: i64,
    total_turn_count: u64,
) -> Result<ReplayTurnHeader, String> {
    if turn_index < 0 || turn_index >= total_turn_count as i64 {
        return Err(format!(
            "Managed replay turn index is no longer available: {turn_index}"
        ));
    }
    let anchor = managed_chunk_user_turn_anchor_at_index(conn, session_id, turn_index)?;
    let (start_sequence, turn_id, started_at) = match anchor {
        Some(anchor) => anchor,
        None if turn_index == 0 && total_turn_count == 1 => conn
            .query_row(
                "SELECT sequence,chunk_id,created_at FROM code_session_chunks
                 WHERE session_id=?1 ORDER BY sequence ASC LIMIT 1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|err| format!("query managed replay fallback turn: {err}"))?,
        None => {
            return Err(format!(
                "Managed replay turn index is no longer available: {turn_index}"
            ))
        }
    };
    let next_start = managed_chunk_user_turn_anchor_at_index(conn, session_id, turn_index + 1)?
        .map(|anchor| anchor.0);
    let (end_sequence, ended_at, event_count) = conn
        .query_row(
            "SELECT MAX(sequence),
                    (SELECT tail.created_at FROM code_session_chunks AS tail
                     WHERE tail.session_id=?1 AND tail.sequence>=?2
                       AND (?3 IS NULL OR tail.sequence<?3)
                     ORDER BY tail.sequence DESC LIMIT 1),
                    COUNT(*)
             FROM code_session_chunks
             WHERE session_id=?1 AND sequence>=?2
               AND (?3 IS NULL OR sequence<?3)",
            rusqlite::params![session_id, start_sequence, next_start],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|err| format!("summarize managed replay turn {turn_index}: {err}"))?;
    Ok(ReplayTurnHeader {
        turn_id,
        turn_index,
        start_sequence,
        end_sequence,
        started_at,
        ended_at,
        event_count: event_count.max(0) as u64,
    })
}

pub(super) fn managed_chunk_turn_index_for_id(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_id: &str,
    total_turn_count: u64,
) -> Result<i64, String> {
    let row = conn
        .query_row(
            "SELECT sequence,function FROM code_session_chunks
             WHERE session_id=?1 AND chunk_id=?2",
            rusqlite::params![session_id, turn_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("query managed replay turn id {turn_id}: {err}"))?
        .ok_or_else(|| format!("Managed replay turn is no longer available: {turn_id}"))?;
    if row.1 != "user_message" && total_turn_count != 1 {
        return Err(format!(
            "Managed replay turn is no longer available: {turn_id}"
        ));
    }
    conn.query_row(
        "SELECT COUNT(*) FROM code_session_chunks
         WHERE session_id=?1 AND function='user_message' AND sequence<?2",
        rusqlite::params![session_id, row.0],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|err| format!("resolve managed replay turn id {turn_id}: {err}"))
}

pub(super) fn managed_chunk_latest_turn_index_before(
    conn: &rusqlite::Connection,
    session_id: &str,
    ceiling: i64,
) -> Result<Option<i64>, String> {
    let latest_user_sequence = conn
        .query_row(
            "SELECT sequence FROM code_session_chunks
             WHERE session_id=?1 AND function='user_message' AND sequence<?2
             ORDER BY sequence DESC LIMIT 1",
            rusqlite::params![session_id, ceiling],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("resolve managed replay window turn: {err}"))?;
    if let Some(sequence) = latest_user_sequence {
        let preceding_users = conn
            .query_row(
                "SELECT COUNT(*) FROM code_session_chunks
                 WHERE session_id=?1 AND function='user_message' AND sequence<?2",
                rusqlite::params![session_id, sequence],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| format!("index managed replay window turn: {err}"))?;
        return Ok(Some(preceding_users.max(0)));
    }
    let has_rows = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM code_session_chunks
             WHERE session_id=?1 AND sequence<?2)",
            rusqlite::params![session_id, ceiling],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query managed replay fallback window: {err}"))?
        != 0;
    Ok(has_rows.then_some(0))
}

pub(super) fn managed_chunk_poll_delta(
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
) -> Result<ReplayChunkDelta, String> {
    let limits = limits.bounded();
    let conn =
        database::db::get_connection().map_err(|err| format!("open managed chunks DB: {err}"))?;
    let generation = managed_chunk_generation(&conn, session_id)?;
    if generation != cursor.generation {
        return Ok(ReplayChunkDelta {
            cursor: ReplayCursor {
                source_id: MANAGED_CLI_REPLAY_TARGET_ID.to_string(),
                session_id: session_id.to_string(),
                generation,
                revision: 0,
                through_sequence: -1,
            },
            chunks: Vec::new(),
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: ReplayStats::default(),
        });
    }
    let chunks = query_managed_chunks(
        &conn,
        session_id,
        "sequence > ?2",
        cursor.through_sequence,
        None,
        limits,
        false,
    )?;
    let through_sequence = chunks
        .last()
        .map_or(cursor.through_sequence, |chunk| chunk.sequence);
    Ok(ReplayChunkDelta {
        cursor: ReplayCursor {
            source_id: MANAGED_CLI_REPLAY_TARGET_ID.to_string(),
            session_id: session_id.to_string(),
            generation,
            revision: through_sequence.max(0) as u64,
            through_sequence,
        },
        chunks,
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats::default(),
    })
}

pub(super) fn query_managed_chunks(
    conn: &rusqlite::Connection,
    session_id: &str,
    predicate: &str,
    sequence: i64,
    through_sequence: Option<i64>,
    limits: ReplayLimits,
    newest_first: bool,
) -> Result<Vec<ReplayIndexedChunk>, String> {
    let order = if newest_first { "DESC" } else { "ASC" };
    let upper_bound = through_sequence
        .map(|_| " AND sequence <= ?3")
        .unwrap_or_default();
    let normal_preview_read =
        replay::NORMAL_PAYLOAD_PREVIEW_BYTES.saturating_add(MANAGED_CHUNK_UTF8_BOUNDARY_BYTES);
    let shell_preview_read =
        replay::SHELL_PAYLOAD_PREVIEW_BYTES.saturating_add(MANAGED_CHUNK_UTF8_BOUNDARY_BYTES);
    let sql = format!(
        "SELECT sequence, chunk_id, action_type, function,
                length(CAST(args_json AS BLOB)), json_valid(args_json),
                CASE WHEN length(CAST(args_json AS BLOB)) <= {MANAGED_CHUNK_INLINE_JSON_MAX_BYTES}
                     THEN args_json END,
                CASE WHEN length(CAST(args_json AS BLOB)) > {MANAGED_CHUNK_INLINE_JSON_MAX_BYTES}
                     THEN substr(
                         CAST(args_json AS BLOB),
                         1,
                         CASE WHEN function IN ('run_command_line', 'shell')
                              THEN {shell_preview_read} ELSE {normal_preview_read} END
                     ) END,
                length(CAST(result_json AS BLOB)), json_valid(result_json),
                CASE WHEN length(CAST(result_json AS BLOB)) <= {MANAGED_CHUNK_INLINE_JSON_MAX_BYTES}
                     THEN result_json END,
                CASE WHEN length(CAST(result_json AS BLOB)) > {MANAGED_CHUNK_INLINE_JSON_MAX_BYTES}
                     THEN CASE WHEN function IN ('run_command_line', 'shell')
                         THEN substr(
                             CAST(result_json AS BLOB),
                             MAX(1, length(CAST(result_json AS BLOB)) - {shell_preview_read} + 1),
                             {shell_preview_read}
                         )
                         ELSE substr(CAST(result_json AS BLOB), 1, {normal_preview_read})
                     END END,
                thread_id, process_id, created_at
         FROM code_session_chunks WHERE session_id=?1 AND {predicate}{upper_bound}
         ORDER BY sequence {order} LIMIT {}",
        limits.max_events
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare bounded managed chunks: {err}"))?;
    let mut rows = match through_sequence {
        Some(through_sequence) => {
            stmt.query(rusqlite::params![session_id, sequence, through_sequence])
        }
        None => stmt.query(rusqlite::params![session_id, sequence]),
    }
    .map_err(|err| format!("query bounded managed chunks: {err}"))?;
    let mut chunks = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read bounded managed chunk: {err}"))?
    {
        let chunk_id: String = row.get(1).map_err(|err| err.to_string())?;
        let function: String = row.get(3).map_err(|err| err.to_string())?;
        let args_inline: Option<String> = row.get(6).map_err(|err| err.to_string())?;
        let args_root_preview: Option<Vec<u8>> = row.get(7).map_err(|err| err.to_string())?;
        let result_inline: Option<String> = row.get(10).map_err(|err| err.to_string())?;
        let result_root_preview: Option<Vec<u8>> = row.get(11).map_err(|err| err.to_string())?;
        for field_bytes in [
            args_inline.as_ref().map(String::len),
            args_root_preview.as_ref().map(Vec::len),
            result_inline.as_ref().map(String::len),
            result_root_preview.as_ref().map(Vec::len),
        ]
        .into_iter()
        .flatten()
        {
            observe_managed_chunk_db_json_field(field_bytes);
        }
        let shell = function == "run_command_line" || function == "shell";
        let preview_limit = if shell {
            replay::SHELL_PAYLOAD_PREVIEW_BYTES
        } else {
            replay::NORMAL_PAYLOAD_PREVIEW_BYTES
        };
        let (args, mut payloads) = load_managed_chunk_json_field(
            conn,
            session_id,
            &chunk_id,
            ManagedChunkJsonColumn::Args,
            row.get::<_, i64>(4).map_err(|err| err.to_string())?,
            row.get::<_, i64>(5).map_err(|err| err.to_string())? != 0,
            args_inline,
            args_root_preview,
            preview_limit,
            false,
            &function,
        )?;
        let (result, result_payloads) = load_managed_chunk_json_field(
            conn,
            session_id,
            &chunk_id,
            ManagedChunkJsonColumn::Result,
            row.get::<_, i64>(8).map_err(|err| err.to_string())?,
            row.get::<_, i64>(9).map_err(|err| err.to_string())? != 0,
            result_inline,
            result_root_preview,
            preview_limit,
            shell,
            &function,
        )?;
        payloads.extend(result_payloads);
        let chunk = ActivityChunk {
            chunk_id,
            session_id: session_id.to_string(),
            action_type: row.get(2).map_err(|err| err.to_string())?,
            function,
            args,
            result,
            thread_id: row.get(12).map_err(|err| err.to_string())?,
            process_id: row.get(13).map_err(|err| err.to_string())?,
            created_at: row.get(14).map_err(|err| err.to_string())?,
            broadcast_only: false,
        };
        let indexed = ReplayIndexedChunk {
            sequence: row.get(0).map_err(|err| err.to_string())?,
            turn_index: 0,
            chunk,
            payloads,
        };
        let next_bytes = serde_json::to_vec(&indexed.chunk)
            .map_or(0, |bytes| bytes.len())
            .saturating_add(serde_json::to_vec(&indexed.payloads).map_or(0, |bytes| bytes.len()));
        if !chunks.is_empty() && bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            break;
        }
        if chunks.is_empty() && next_bytes > limits.max_ipc_bytes {
            return Err(format!(
                "Managed replay event {} exceeds the {} byte compact window budget",
                indexed.chunk.chunk_id, limits.max_ipc_bytes
            ));
        }
        bytes = bytes.saturating_add(next_bytes);
        chunks.push(indexed);
    }
    if newest_first {
        chunks.reverse();
    }
    Ok(chunks)
}

#[derive(Clone, Copy)]
pub(super) enum ManagedChunkJsonColumn {
    Args,
    Result,
}

impl ManagedChunkJsonColumn {
    fn column_name(self) -> &'static str {
        match self {
            Self::Args => "args_json",
            Self::Result => "result_json",
        }
    }

    fn root(self) -> &'static str {
        match self {
            Self::Args => "args",
            Self::Result => "result",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum ManagedChunkJsonContainer {
    Object,
    Array,
}

#[derive(Clone)]
pub(super) enum ManagedChunkJsonPathSegment {
    Key(String),
    Index(usize),
}

#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub(super) fn load_managed_chunk_json_field(
    conn: &rusqlite::Connection,
    session_id: &str,
    chunk_id: &str,
    column: ManagedChunkJsonColumn,
    total_bytes: i64,
    valid_json: bool,
    inline: Option<String>,
    root_preview: Option<Vec<u8>>,
    preview_limit: usize,
    tail: bool,
    function_name: &str,
) -> Result<(serde_json::Value, Vec<ReplayPayloadDescriptor>), String> {
    let root = column.root();
    let total_bytes = total_bytes.max(0) as u64;
    if let Some(inline) = inline {
        let mut value = serde_json::from_str(&inline)
            .map_err(|err| format!("decode managed chunk {root}: {err}"))?;
        let mut payloads = Vec::new();
        compact_managed_chunk_json_value(
            &mut value,
            root,
            true,
            preview_limit,
            tail,
            chunk_id,
            managed_chunk_payload_kind(function_name, root),
            &mut payloads,
        );
        return Ok((value, payloads));
    }
    if !valid_json {
        return Err(format!(
            "decode managed chunk {root}: invalid JSON in oversized {root} payload"
        ));
    }

    if let Some(projected) = project_managed_chunk_json_field(
        conn,
        session_id,
        chunk_id,
        column,
        total_bytes,
        preview_limit,
        tail,
        function_name,
    )? {
        return Ok(projected);
    }

    let root_preview = root_preview
        .ok_or_else(|| format!("bounded managed chunk {root} preview is missing for {chunk_id}"))?;
    let preview = if tail {
        utf8_tail_preview_bytes(&root_preview, preview_limit)?
    } else {
        utf8_head_preview_bytes(&root_preview, preview_limit)?
    };
    Ok((
        serde_json::Value::String(preview.clone()),
        vec![ReplayPayloadDescriptor {
            field_path: root.to_string(),
            kind: managed_chunk_payload_kind(function_name, root),
            encoding: ReplayPayloadEncoding::JsonValue,
            body_projection: Some(ReplayPayloadBodyProjection {
                field_path: root.to_string(),
                text: preview.clone(),
                truncated: true,
            }),
            spans: Vec::new(),
            total_bytes,
            source_ordinal: None,
            source_key: Some(chunk_id.to_string()),
        }],
    ))
}

#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub(super) fn project_managed_chunk_json_field(
    conn: &rusqlite::Connection,
    session_id: &str,
    chunk_id: &str,
    column: ManagedChunkJsonColumn,
    root_total_bytes: u64,
    preview_limit: usize,
    tail: bool,
    function_name: &str,
) -> Result<Option<(serde_json::Value, Vec<ReplayPayloadDescriptor>)>, String> {
    let column_name = column.column_name();
    let read_bytes = preview_limit
        .saturating_add(MANAGED_CHUNK_UTF8_BOUNDARY_BYTES)
        .min(i64::MAX as usize) as i64;
    let sql = format!(
        "SELECT tree.id, tree.parent,
                length(CAST(tree.key AS BLOB)),
                substr(CAST(tree.key AS BLOB), 1, {}),
                tree.type,
                CASE WHEN tree.atom IS NULL THEN 0
                     ELSE length(CAST(tree.atom AS BLOB)) END,
                CASE WHEN tree.atom IS NULL THEN NULL
                     WHEN tree.type='text' AND ?3<>0 THEN substr(
                         CAST(tree.atom AS BLOB),
                         MAX(1, length(CAST(tree.atom AS BLOB)) - ?4 + 1),
                         ?4
                     )
                     ELSE substr(CAST(tree.atom AS BLOB), 1, ?4) END
           FROM code_session_chunks AS chunks,
                json_tree(chunks.{column_name}) AS tree
          WHERE chunks.session_id=?1 AND chunks.chunk_id=?2
          ORDER BY tree.id
          LIMIT {}",
        MANAGED_CHUNK_JSON_KEY_MAX_BYTES.saturating_add(MANAGED_CHUNK_UTF8_BOUNDARY_BYTES),
        MANAGED_CHUNK_JSON_PROJECTION_MAX_NODES.saturating_add(1)
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare managed {column_name} projection: {err}"))?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            chunk_id,
            if tail { 1_i64 } else { 0_i64 },
            read_bytes
        ])
        .map_err(|err| format!("query managed {column_name} projection: {err}"))?;
    let mut root_value: Option<serde_json::Value> = None;
    let mut containers =
        HashMap::<i64, (Vec<ManagedChunkJsonPathSegment>, ManagedChunkJsonContainer)>::new();
    let mut payloads = Vec::new();
    let mut projected_bytes = 0_usize;
    let mut node_count = 0_usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read managed {column_name} projection: {err}"))?
    {
        node_count = node_count.saturating_add(1);
        if node_count > MANAGED_CHUNK_JSON_PROJECTION_MAX_NODES {
            return Ok(None);
        }
        let id: i64 = row.get(0).map_err(|err| err.to_string())?;
        let parent: Option<i64> = row.get(1).map_err(|err| err.to_string())?;
        let key_bytes_total = row
            .get::<_, Option<i64>>(2)
            .map_err(|err| err.to_string())?
            .unwrap_or_default()
            .max(0) as usize;
        let key_bytes: Option<Vec<u8>> = row.get(3).map_err(|err| err.to_string())?;
        let node_type: String = row.get(4).map_err(|err| err.to_string())?;
        let atom_total = row.get::<_, i64>(5).map_err(|err| err.to_string())?.max(0) as u64;
        let atom_bytes: Option<Vec<u8>> = row.get(6).map_err(|err| err.to_string())?;
        if let Some(key_bytes) = &key_bytes {
            observe_managed_chunk_db_json_field(key_bytes.len());
            projected_bytes = projected_bytes.saturating_add(key_bytes.len());
        }
        if let Some(atom_bytes) = &atom_bytes {
            observe_managed_chunk_db_json_field(atom_bytes.len());
            projected_bytes = projected_bytes.saturating_add(atom_bytes.len());
        }
        if projected_bytes > MANAGED_CHUNK_JSON_PROJECTION_MAX_BYTES
            || key_bytes_total > MANAGED_CHUNK_JSON_KEY_MAX_BYTES
        {
            return Ok(None);
        }

        let path = if let Some(parent) = parent {
            let Some((parent_path, parent_kind)) = containers.get(&parent) else {
                return Ok(None);
            };
            let key_bytes = key_bytes.as_deref().unwrap_or_default();
            let key = std::str::from_utf8(key_bytes).ok();
            let segment = match parent_kind {
                ManagedChunkJsonContainer::Object => {
                    let Some(key) = key else {
                        return Ok(None);
                    };
                    if key.is_empty()
                        || key.contains('.')
                        || key.bytes().all(|byte| byte.is_ascii_digit())
                    {
                        return Ok(None);
                    }
                    ManagedChunkJsonPathSegment::Key(key.to_string())
                }
                ManagedChunkJsonContainer::Array => {
                    let Some(index) = key.and_then(|key| key.parse::<usize>().ok()) else {
                        return Ok(None);
                    };
                    ManagedChunkJsonPathSegment::Index(index)
                }
            };
            let mut path = parent_path.clone();
            path.push(segment);
            path
        } else {
            if root_value.is_some() {
                return Ok(None);
            }
            Vec::new()
        };
        let field_path = managed_chunk_field_path(column.root(), &path);
        let kind = if field_path.to_ascii_lowercase().contains("diff") {
            ReplayPayloadKind::ToolDiff
        } else {
            managed_chunk_payload_kind(function_name, column.root())
        };
        let (value, container) = match node_type.as_str() {
            "object" => (
                serde_json::Value::Object(serde_json::Map::new()),
                Some(ManagedChunkJsonContainer::Object),
            ),
            "array" => (
                serde_json::Value::Array(Vec::new()),
                Some(ManagedChunkJsonContainer::Array),
            ),
            "text" => {
                let Some(atom_bytes) = atom_bytes.as_deref() else {
                    return Ok(None);
                };
                let text = if atom_total > preview_limit as u64 {
                    let preview = if tail {
                        utf8_tail_preview_bytes(atom_bytes, preview_limit)?
                    } else {
                        utf8_head_preview_bytes(atom_bytes, preview_limit)?
                    };
                    payloads.push(ReplayPayloadDescriptor {
                        field_path: field_path.clone(),
                        kind,
                        encoding: if path.is_empty() {
                            ReplayPayloadEncoding::JsonValue
                        } else {
                            ReplayPayloadEncoding::Utf8Text
                        },
                        body_projection: path.is_empty().then(|| ReplayPayloadBodyProjection {
                            field_path: field_path.clone(),
                            text: preview.clone(),
                            truncated: true,
                        }),
                        spans: Vec::new(),
                        total_bytes: if path.is_empty() {
                            root_total_bytes
                        } else {
                            atom_total
                        },
                        source_ordinal: None,
                        source_key: Some(chunk_id.to_string()),
                    });
                    preview
                } else {
                    String::from_utf8(atom_bytes.to_vec())
                        .map_err(|err| format!("decode managed {field_path}: {err}"))?
                };
                (serde_json::Value::String(text), None)
            }
            "integer" | "real" => {
                let Some(atom_bytes) = atom_bytes.as_deref() else {
                    return Ok(None);
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(atom_bytes) else {
                    return Ok(None);
                };
                (value, None)
            }
            "true" => (serde_json::Value::Bool(true), None),
            "false" => (serde_json::Value::Bool(false), None),
            "null" => (serde_json::Value::Null, None),
            _ => return Ok(None),
        };
        if path.is_empty() {
            root_value = Some(value);
        } else {
            let Some(root) = root_value.as_mut() else {
                return Ok(None);
            };
            if !insert_managed_chunk_json_node(root, &path, value) {
                return Ok(None);
            }
        }
        if let Some(container) = container {
            containers.insert(id, (path, container));
        }
    }
    Ok(root_value.map(|value| (value, payloads)))
}

pub(super) fn managed_chunk_field_path(root: &str, path: &[ManagedChunkJsonPathSegment]) -> String {
    let mut output = root.to_string();
    for segment in path {
        output.push('.');
        match segment {
            ManagedChunkJsonPathSegment::Key(key) => output.push_str(key),
            ManagedChunkJsonPathSegment::Index(index) => output.push_str(&index.to_string()),
        }
    }
    output
}

pub(super) fn insert_managed_chunk_json_node(
    root: &mut serde_json::Value,
    path: &[ManagedChunkJsonPathSegment],
    value: serde_json::Value,
) -> bool {
    let Some((last, parents)) = path.split_last() else {
        *root = value;
        return true;
    };
    let mut current = root;
    for segment in parents {
        current = match (current, segment) {
            (serde_json::Value::Object(object), ManagedChunkJsonPathSegment::Key(key)) => {
                let Some(next) = object.get_mut(key) else {
                    return false;
                };
                next
            }
            (serde_json::Value::Array(array), ManagedChunkJsonPathSegment::Index(index)) => {
                let Some(next) = array.get_mut(*index) else {
                    return false;
                };
                next
            }
            _ => return false,
        };
    }
    match (current, last) {
        (serde_json::Value::Object(object), ManagedChunkJsonPathSegment::Key(key)) => {
            object.insert(key.clone(), value);
            true
        }
        (serde_json::Value::Array(array), ManagedChunkJsonPathSegment::Index(index)) => {
            if *index > array.len() {
                return false;
            }
            if *index == array.len() {
                array.push(value);
            } else {
                array[*index] = value;
            }
            true
        }
        _ => false,
    }
}

pub(super) fn observe_managed_chunk_db_json_field(_bytes: usize) {
    #[cfg(test)]
    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.fetch_max(_bytes, Ordering::Relaxed);
}

pub(super) fn utf8_head_preview_bytes(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    let mut end = bytes.len().min(max_bytes);
    while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
        end -= 1;
    }
    let text = std::str::from_utf8(&bytes[..end])
        .map_err(|err| format!("decode managed payload preview: {err}"))?;
    Ok(format!("{text}\n… [payload truncated]"))
}

pub(super) fn utf8_tail_preview_bytes(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    let mut start = bytes.len().saturating_sub(max_bytes);
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start = start.saturating_add(1);
    }
    let text = std::str::from_utf8(&bytes[start..])
        .map_err(|err| format!("decode managed payload preview: {err}"))?;
    Ok(format!("[payload truncated] …\n{text}"))
}

#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub(super) fn compact_managed_chunk_json_value(
    value: &mut serde_json::Value,
    field_path: &str,
    is_root: bool,
    limit: usize,
    tail: bool,
    source_key: &str,
    kind: ReplayPayloadKind,
    payloads: &mut Vec<ReplayPayloadDescriptor>,
) {
    match value {
        serde_json::Value::String(text) if text.len() > limit => {
            let total_bytes = if is_root {
                serde_json::to_string(text).map_or(text.len(), |encoded| encoded.len())
            } else {
                text.len()
            } as u64;
            let preview = if tail {
                utf8_tail_preview(text, limit)
            } else {
                utf8_head_preview(text, limit)
            };
            *text = preview.clone();
            payloads.push(ReplayPayloadDescriptor {
                field_path: field_path.to_string(),
                kind,
                encoding: if is_root {
                    ReplayPayloadEncoding::JsonValue
                } else {
                    ReplayPayloadEncoding::Utf8Text
                },
                body_projection: is_root.then(|| ReplayPayloadBodyProjection {
                    field_path: field_path.to_string(),
                    text: preview.clone(),
                    truncated: true,
                }),
                spans: Vec::new(),
                total_bytes,
                source_ordinal: None,
                source_key: Some(source_key.to_string()),
            });
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                compact_managed_chunk_json_value(
                    item,
                    &format!("{field_path}.{index}"),
                    false,
                    limit,
                    tail,
                    source_key,
                    kind,
                    payloads,
                );
            }
        }
        serde_json::Value::Object(object) => {
            for (key, item) in object {
                // Dot-separated paths mirror the existing PayloadRef wire
                // contract. Provider payload keys containing dots are rare;
                // keep such values inline rather than publish an ambiguous
                // range locator.
                if key.contains('.') {
                    continue;
                }
                let child_path = format!("{field_path}.{key}");
                let child_kind = if child_path.to_ascii_lowercase().contains("diff") {
                    ReplayPayloadKind::ToolDiff
                } else {
                    kind
                };
                compact_managed_chunk_json_value(
                    item,
                    &child_path,
                    false,
                    limit,
                    tail,
                    source_key,
                    child_kind,
                    payloads,
                );
            }
        }
        _ => {}
    }
}

pub(super) fn managed_chunk_payload_kind(function_name: &str, root: &str) -> ReplayPayloadKind {
    match function_name {
        "user" | "user_message" => ReplayPayloadKind::UserMessage,
        "assistant" | "assistant_message" | "agent_message" => ReplayPayloadKind::AssistantContent,
        "thinking" | "reasoning" => ReplayPayloadKind::Reasoning,
        _ if root == "args" => ReplayPayloadKind::ToolArguments,
        _ => ReplayPayloadKind::ToolOutput,
    }
}

pub(super) fn utf8_head_preview(text: &str, max_bytes: usize) -> String {
    let mut end = text.len().min(max_bytes);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [payload truncated]", &text[..end])
}

pub(super) fn utf8_tail_preview(text: &str, max_bytes: usize) -> String {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[payload truncated] …\n{}", &text[start..])
}

pub(super) fn managed_chunk_payload_range(
    session_id: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<ReplayPayloadRange, String> {
    let max_bytes = max_bytes
        .unwrap_or(replay::DEFAULT_PAYLOAD_RANGE_BYTES)
        .clamp(1, replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
    let conn =
        database::db::get_connection().map_err(|err| format!("open managed chunks DB: {err}"))?;
    managed_chunk_payload_range_from_conn(
        &conn, session_id, event_id, field_path, offset, max_bytes,
    )
}

pub(super) fn managed_chunk_payload_range_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let (root, path) = field_path.split_once('.').unwrap_or((field_path, ""));
    let column = match root {
        "args" => "args_json",
        "result" => "result_json",
        _ => return Err("fieldPath must start with args or result".to_string()),
    };
    let start = offset.min(i64::MAX as u64) as i64;
    let read_bytes = max_bytes.saturating_add(4).min(i64::MAX as usize) as i64;
    let (total_bytes, bytes): (Option<i64>, Option<Vec<u8>>) = if path.is_empty() {
        let sql = format!(
            "SELECT length(CAST({column} AS BLOB)),
                    substr(CAST({column} AS BLOB), ?3, ?4)
               FROM code_session_chunks WHERE session_id=?1 AND chunk_id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![session_id, event_id, start.saturating_add(1), read_bytes],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    } else {
        let json_path = replay_sqlite_json_path(path)?;
        let sql = format!(
            "SELECT length(CAST(json_extract({column}, ?3) AS BLOB)),
                    substr(CAST(json_extract({column}, ?3) AS BLOB), ?4, ?5)
               FROM code_session_chunks WHERE session_id=?1 AND chunk_id=?2"
        );
        conn.query_row(
            &sql,
            rusqlite::params![
                session_id,
                event_id,
                json_path,
                start.saturating_add(1),
                read_bytes
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }
    .map_err(|err| format!("load managed payload range: {err}"))?;
    let total_bytes = total_bytes
        .ok_or_else(|| format!("managed payload field not found: {field_path}"))?
        .max(0) as u64;
    let bytes = bytes.unwrap_or_default();
    observe_managed_chunk_db_json_field(bytes.len());
    let mut take = max_bytes.min(bytes.len());
    while take > 0 && std::str::from_utf8(&bytes[..take]).is_err() {
        take -= 1;
    }
    if take == 0 && !bytes.is_empty() {
        return Err(format!(
            "managed payload range starts inside invalid UTF-8: {field_path} at {offset}"
        ));
    }
    let text = String::from_utf8(bytes[..take].to_vec())
        .map_err(|err| format!("decode managed payload range: {err}"))?;
    let next_offset = offset.saturating_add(take as u64).min(total_bytes);
    Ok(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: offset.min(total_bytes),
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    })
}

pub(super) fn replay_sqlite_json_path(path: &str) -> Result<String, String> {
    let mut output = "$".to_string();
    for segment in path.split('.') {
        if segment.is_empty() {
            return Err("managed payload path contains an empty segment".to_string());
        }
        if segment.bytes().all(|byte| byte.is_ascii_digit()) {
            output.push('[');
            output.push_str(segment);
            output.push(']');
        } else {
            output.push_str(".\"");
            for character in segment.chars() {
                match character {
                    '\\' => output.push_str("\\\\"),
                    '"' => output.push_str("\\\""),
                    _ => output.push(character),
                }
            }
            output.push('"');
        }
    }
    Ok(output)
}
