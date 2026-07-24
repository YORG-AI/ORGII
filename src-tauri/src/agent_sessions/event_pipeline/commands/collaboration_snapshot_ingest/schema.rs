use super::staging::*;
use super::wire::sha256_hex;
use super::*;

pub(super) fn ensure_destination_schema(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS collaboration_snapshot_ingest_state (
           session_id TEXT PRIMARY KEY,
           epoch INTEGER NOT NULL,
           frozen_seq INTEGER NOT NULL,
           event_count INTEGER NOT NULL,
           frozen_event_count INTEGER NOT NULL,
           tail_hash TEXT,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS collaboration_snapshot_event_map (
           session_id TEXT NOT NULL,
           event_id TEXT NOT NULL,
           original_id TEXT NOT NULL,
           physical_seq INTEGER NOT NULL,
           event_index INTEGER NOT NULL,
           logical_index INTEGER NOT NULL,
           is_tail INTEGER NOT NULL,
           PRIMARY KEY(session_id,event_id)
         );
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_events_insert_invalidate
         AFTER INSERT ON events
         WHEN NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=NEW.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_events_delete_invalidate
         AFTER DELETE ON events
         WHEN OLD.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_events_update_invalidate
         AFTER UPDATE ON events
         WHEN OLD.session_id GLOB 'imported-session-*'
           OR NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id IN (OLD.session_id,NEW.session_id);
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_map_insert_invalidate
         AFTER INSERT ON collaboration_snapshot_event_map
         WHEN NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=NEW.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_map_delete_invalidate
         AFTER DELETE ON collaboration_snapshot_event_map
         WHEN OLD.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id=OLD.session_id;
         END;
         CREATE TRIGGER IF NOT EXISTS collaboration_snapshot_map_update_invalidate
         AFTER UPDATE ON collaboration_snapshot_event_map
         WHEN OLD.session_id GLOB 'imported-session-*'
           OR NEW.session_id GLOB 'imported-session-*' BEGIN
           DELETE FROM collaboration_snapshot_ingest_state
           WHERE session_id IN (OLD.session_id,NEW.session_id);
         END;",
    )
    .map_err(|error| format!("initialize collaboration snapshot destination schema: {error}"))?;
    ensure_secondary_mutation_triggers(tx)
}

pub(super) fn ensure_secondary_mutation_triggers(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SECONDARY_MUTATION_TRIGGERS_SQL)
        .map_err(|error| format!("initialize native fork snapshot mutation tracking: {error}"))
}

pub(super) fn drop_secondary_mutation_triggers(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(DROP_SECONDARY_MUTATION_TRIGGERS_SQL)
        .map_err(|error| format!("suspend native fork snapshot mutation tracking: {error}"))
}

pub(super) fn create_destination_indexes(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_collaboration_snapshot_event_order
           ON collaboration_snapshot_event_map(session_id,logical_index);
         CREATE INDEX IF NOT EXISTS idx_collaboration_snapshot_event_tail
           ON collaboration_snapshot_event_map(session_id,is_tail,event_id);",
    )
    .map_err(|error| format!("initialize collaboration snapshot destination indexes: {error}"))
}

#[cfg(test)]
pub(in crate::agent_sessions::event_pipeline::commands) fn install_snapshot_schema_for_test(
    conn: &mut Connection,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("begin collaboration snapshot test schema: {error}"))?;
    ensure_destination_schema(&tx)?;
    create_destination_indexes(&tx)?;
    tx.commit()
        .map_err(|error| format!("commit collaboration snapshot test schema: {error}"))
}

pub(super) fn destination_indexes_are_installed(conn: &Connection) -> Result<bool, String> {
    let installed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
               'idx_collaboration_snapshot_event_order',
               'idx_collaboration_snapshot_event_tail'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect collaboration snapshot indexes: {error}"))?;
    Ok(installed == SNAPSHOT_INDEX_COUNT)
}

pub(super) fn read_destination_cursor(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    let raw = conn
        .query_row(
            "SELECT epoch,frozen_seq,event_count,frozen_event_count,tail_hash
             FROM collaboration_snapshot_ingest_state WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read current collaboration snapshot cursor: {error}"))?;
    let Some((epoch, frozen_seq, count, frozen_count, tail_hash)) = raw else {
        return Ok(None);
    };
    if epoch < 0 || frozen_seq < 0 || count < 0 || frozen_count < 0 {
        return Err("current collaboration snapshot cursor contains negative values".to_string());
    }
    Ok(Some(CollaborationSnapshotCursor {
        epoch,
        frozen_seq: frozen_seq as u64,
        count: count as u64,
        frozen_count: frozen_count as u64,
        tail_hash,
    }))
}

pub(super) fn destination_snapshot_has_sentinels(
    conn: &Connection,
    session_id: &str,
    event_count: u64,
) -> Result<bool, String> {
    if event_count == 0 {
        return Ok(true);
    }
    let last_index = i64::try_from(event_count - 1)
        .map_err(|_| "collaboration snapshot event count is too large".to_string())?;
    let (has_first, has_last): (i64, i64) = conn
        .query_row(
            CURSOR_SENTINEL_SQL,
            params![session_id, last_index],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("validate collaboration snapshot sentinels: {error}"))?;
    Ok(has_first == 1 && has_last == 1)
}

pub(super) fn destination_snapshot_constant_time_metadata(
    conn: &Connection,
    session_id: &str,
    cursor: &CollaborationSnapshotCursor,
) -> Result<Option<CollaborationSnapshotSessionMetadata>, String> {
    let session_metadata = conn
        .query_row(
            "SELECT event_count,time_range_start,time_range_end
             FROM sessions WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read collaboration snapshot session metadata: {error}"))?;
    let Some((session_event_count, time_range_start, time_range_end)) = session_metadata else {
        return Ok(None);
    };
    if session_event_count < 0 || session_event_count as u64 != cursor.count {
        return Ok(None);
    }
    if !destination_snapshot_has_sentinels(conn, session_id, cursor.count)? {
        return Ok(None);
    }
    Ok(Some(CollaborationSnapshotSessionMetadata {
        time_range_start,
        time_range_end,
    }))
}

pub(super) fn get_cursor_from_connection(
    conn: &Connection,
    local_session_id: &str,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    validate_session_id(local_session_id)?;
    if !is_imported_snapshot_session(local_session_id) {
        return Err(
            "only imported-session collaboration snapshots expose an ingest cursor".to_string(),
        );
    }
    let (required_tables, required_triggers, required_indexes): (i64, i64, i64) = conn
        .query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN type='table' AND name IN (
                 'collaboration_snapshot_ingest_state',
                 'collaboration_snapshot_event_map',
                 'events',
                 'sessions'
               ) THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN type='trigger' AND name IN (
                 'collaboration_snapshot_events_insert_invalidate',
                 'collaboration_snapshot_events_delete_invalidate',
                 'collaboration_snapshot_events_update_invalidate',
                 'collaboration_snapshot_map_insert_invalidate',
                 'collaboration_snapshot_map_delete_invalidate',
                 'collaboration_snapshot_map_update_invalidate'
               ) THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN type='index' AND name IN (
                 'idx_collaboration_snapshot_event_order',
                 'idx_collaboration_snapshot_event_tail'
               ) THEN 1 ELSE 0 END),0)
             FROM sqlite_master",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("inspect collaboration snapshot cursor schema: {error}"))?;
    if required_tables != 4
        || required_triggers != SNAPSHOT_INVALIDATION_TRIGGER_COUNT
        || required_indexes != SNAPSHOT_INDEX_COUNT
    {
        return Ok(None);
    }
    let cursor = match read_destination_cursor(conn, local_session_id) {
        Ok(Some(cursor)) => cursor,
        Ok(None) => return Ok(None),
        Err(_) => return Ok(None),
    };
    if cursor.epoch < 0
        || cursor.frozen_count > cursor.count
        || cursor
            .tail_hash
            .as_deref()
            .is_some_and(|hash| validate_hash("tailHash", hash).is_err())
    {
        return Ok(None);
    }
    match destination_snapshot_constant_time_metadata(conn, local_session_id, &cursor) {
        Ok(Some(_)) => Ok(Some(cursor)),
        Ok(None) | Err(_) => Ok(None),
    }
}

pub(super) async fn collaboration_snapshot_ingest_get_cursor_impl(
    request: CollaborationSnapshotIngestGetCursorRequest,
) -> Result<Option<CollaborationSnapshotCursor>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection()
            .map_err(|error| format!("open sessions.db for snapshot cursor: {error}"))?;
        get_cursor_from_connection(&conn, &request.local_session_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn has_snapshot_backed_native_fork(
    conn: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(false);
    }
    validate_session_id(session_id)?;
    if !destination_indexes_are_installed(conn)? {
        return Ok(false);
    }
    let Some(cursor) = read_destination_cursor(conn, session_id)? else {
        return Ok(false);
    };
    if cursor.frozen_count > cursor.count
        || cursor
            .tail_hash
            .as_deref()
            .is_some_and(|hash| validate_hash("tailHash", hash).is_err())
    {
        return Ok(false);
    }
    let session_event_count = conn
        .query_row(
            "SELECT event_count FROM sessions WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("read snapshot-backed fork metadata: {error}"))?;
    let Some(session_event_count) = session_event_count else {
        return Ok(false);
    };
    if session_event_count < 0 || (session_event_count as u64) < cursor.count {
        return Ok(false);
    }
    destination_snapshot_has_sentinels(conn, session_id, cursor.count)
}

pub(super) fn has_native_snapshot_marker(
    conn: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(false);
    }
    validate_session_id(session_id)?;
    let state_table_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='collaboration_snapshot_ingest_state')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("inspect native fork snapshot marker schema: {error}"))?
        != 0;
    if !state_table_exists {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM collaboration_snapshot_ingest_state
         WHERE session_id=?1)",
        [session_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|error| format!("read native fork snapshot marker: {error}"))
}

/// Cheap crate-local origin check for background/native consumers.
///
/// The prefix guard avoids opening SQLite for OS/SDE ids that can never be a
/// Cloud-created Agent fork. This deliberately checks the persisted snapshot
/// marker, not full sentinel integrity: a damaged inherited prefix must still
/// fail closed instead of triggering a history-sized native turn rebuild.
pub(crate) fn is_snapshot_backed_native_fork(session_id: &str) -> Result<bool, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(false);
    }
    let conn = database::db::get_connection()
        .map_err(|error| format!("open sessions.db for native fork snapshot probe: {error}"))?;
    has_native_snapshot_marker(&conn, session_id)
}

/// Resolve a snapshot-backed native fork without scanning or materializing
/// its inherited history. The `events` table remains the canonical view, so
/// `event_count` and `max_sequence` include native events appended after the
/// inherited map frontier. Append advances only the wire revision; destructive
/// mutations advance `reset_revision`; a newly published inherited snapshot
/// advances the generation.
pub(in crate::agent_sessions::event_pipeline::commands) fn collaboration_snapshot_secondary_state(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<CollaborationSnapshotSecondaryState>, String> {
    if !session_id.starts_with(AGENT_SESSION_PREFIX)
        || session_id.len() <= AGENT_SESSION_PREFIX.len()
    {
        return Ok(None);
    }
    validate_session_id(session_id)?;
    ensure_secondary_mutation_triggers(conn)?;
    if !has_snapshot_backed_native_fork(conn, session_id)? {
        return Ok(None);
    }
    let cursor = read_destination_cursor(conn, session_id)?.ok_or_else(|| {
        "snapshot-backed native fork lost its ingest cursor after validation".to_string()
    })?;
    let session_event_count = conn
        .query_row(
            "SELECT event_count FROM sessions WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("read native fork secondary replay state: {error}"))?;
    if session_event_count < 0 {
        return Err("native fork secondary replay state contains negative values".to_string());
    }
    let mut mutation_state = conn
        .query_row(
            "SELECT generation,revision,reset_revision,max_sequence,event_count
             FROM collaboration_snapshot_secondary_state WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read native fork mutation cursor: {error}"))?;
    if mutation_state.is_none() {
        let max_sequence = conn
            .query_row(
                "SELECT history_sequence FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("seed native fork replay frontier: {error}"))?
            .unwrap_or(-1);
        conn.execute(
            "INSERT INTO collaboration_snapshot_secondary_state(
               session_id,generation,revision,reset_revision,max_sequence,event_count
             ) VALUES(?1,0,0,0,?2,?3)
             ON CONFLICT(session_id) DO NOTHING",
            params![session_id, max_sequence, session_event_count],
        )
        .map_err(|error| format!("seed native fork mutation cursor: {error}"))?;
        mutation_state = conn
            .query_row(
                "SELECT generation,revision,reset_revision,max_sequence,event_count
                 FROM collaboration_snapshot_secondary_state WHERE session_id=?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("reload native fork mutation cursor: {error}"))?;
    }
    let (
        mut secondary_generation,
        mut mutation_revision,
        mut reset_revision,
        mut max_sequence,
        tracked_event_count,
    ) = mutation_state.ok_or_else(|| "native fork mutation cursor is unavailable".to_string())?;
    if secondary_generation < 0
        || mutation_revision < 0
        || reset_revision < 0
        || tracked_event_count < 0
    {
        return Err("native fork mutation cursor contains negative values".to_string());
    }
    if tracked_event_count != session_event_count {
        max_sequence = conn
            .query_row(
                "SELECT history_sequence FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("repair native fork replay frontier: {error}"))?
            .unwrap_or(-1);
        secondary_generation = secondary_generation.saturating_add(1);
        mutation_revision = mutation_revision.saturating_add(1);
        reset_revision = mutation_revision;
        conn.execute(
            "UPDATE collaboration_snapshot_secondary_state
             SET generation=?2,revision=?3,reset_revision=?3,
                 max_sequence=?4,event_count=?5
             WHERE session_id=?1",
            params![
                session_id,
                secondary_generation,
                mutation_revision,
                max_sequence,
                session_event_count,
            ],
        )
        .map_err(|error| format!("repair native fork mutation cursor: {error}"))?;
    }
    let has_unsequenced = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM events
             WHERE session_id=?1 AND history_sequence IS NULL)",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("validate native fork replay sequences: {error}"))?
        != 0;
    if has_unsequenced {
        return Err("snapshot-backed native fork contains an unsequenced event".to_string());
    }
    let generation_material = format!(
        "v2|{}|{}|{}|{}|{}|{}",
        cursor.epoch,
        cursor.frozen_seq,
        cursor.count,
        cursor.frozen_count,
        cursor.tail_hash.as_deref().unwrap_or("-"),
        secondary_generation,
    );
    Ok(Some(CollaborationSnapshotSecondaryState {
        generation: format!(
            "collaboration-fork-v2-{}",
            sha256_hex(generation_material.as_bytes())
        ),
        revision: mutation_revision as u64,
        reset_revision: reset_revision as u64,
        max_sequence,
        event_count: session_event_count as u64,
    }))
}

/// Secondary-consumer capability probe for a Cloud-created native fork.
///
/// This does not opt the session into external replay for execution or the
/// SessionCore open path. It only proves that the immutable inherited prefix
/// still has its atomically published snapshot state and indexed sentinels.
pub(super) async fn collaboration_snapshot_secondary_probe_impl(
    request: CollaborationSnapshotSecondaryProbeRequest,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection()
            .map_err(|error| format!("open sessions.db for fork snapshot probe: {error}"))?;
        has_snapshot_backed_native_fork(&conn, &request.session_id)
    })
    .await
    .map_err(|error| error.to_string())?
}
