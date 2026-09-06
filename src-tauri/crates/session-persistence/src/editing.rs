//! Session event log editing — truncation and replay
//!
//! Provides `truncate_after_event` which removes the target event and every
//! event that came after it in the linear history. Used by the edit-and-
//! resend flow in `useEditUserMessage`.

use rusqlite::{params, OptionalExtension, Result as SqliteResult};

use super::connection::{begin_immediate, get_connection, with_sessions_writer};
use super::crud::{normalize_session_sequences, update_session_metadata};
use super::sequence::reset_sequence;
use super::types::{CachedEvent, TruncateResult};

/// Truncate history starting at a specific event ID.
///
/// Removes the target event and every event with a higher `history_sequence`
/// (or, when no sequence is stamped, every event with a later `created_at`).
/// This is the hard-delete model used by the edit-and-resend flow.
pub fn truncate_after_event(session_id: &str, event_id: &str) -> SqliteResult<TruncateResult> {
    with_sessions_writer(|| truncate_after_event_inner(session_id, event_id))
}

fn truncate_after_event_inner(session_id: &str, event_id: &str) -> SqliteResult<TruncateResult> {
    let conn = get_connection()?;
    normalize_session_sequences(&conn, session_id)?;

    // `.optional()` distinguishes "no row" (legitimate — the event may
    // already have been truncated by a concurrent edit) from a real DB
    // error like a lock or schema mismatch. The outer `Option` tells us
    // whether the row existed; the inner `Option` tells us whether the
    // row had a history_sequence stamp.
    let row: Option<Option<i64>> = conn
        .query_row(
            "SELECT history_sequence FROM events
             WHERE session_id = ?1 AND id = ?2",
            params![session_id, event_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?;

    let target_seq_opt = match row {
        Some(seq) => seq,
        None => {
            return Ok(TruncateResult {
                deleted_count: 0,
                deleted_ids: vec![],
                deleted_sequences: vec![],
            });
        }
    };

    let target_seq = match target_seq_opt {
        Some(seq) => seq,
        None => {
            // No sequence stamp — fall back to created_at ordering.
            let created_at: Option<String> = conn
                .query_row(
                    "SELECT created_at FROM events WHERE session_id = ?1 AND id = ?2",
                    params![session_id, event_id],
                    |row| row.get(0),
                )
                .optional()?;

            let ts = match created_at {
                Some(ts) => ts,
                None => {
                    return Ok(TruncateResult {
                        deleted_count: 0,
                        deleted_ids: vec![],
                        deleted_sequences: vec![],
                    });
                }
            };

            let to_delete = select_ids_by_ts(&conn, session_id, &ts)?;
            let deleted_ids: Vec<String> = to_delete.iter().map(|(id, _)| id.clone()).collect();
            let deleted_sequences: Vec<i64> =
                to_delete.iter().filter_map(|(_, seq)| *seq).collect();
            let deleted_count = deleted_ids.len() as i64;
            delete_by_ts(&conn, session_id, &ts)?;

            // `MAX(...)` always produces exactly one row, even when the
            // table is empty (the value is then SQL NULL → `Option::None`).
            // A real DB error here (lock / schema mismatch) must surface
            // — silently treating it as "table is empty" would reset the
            // sequence counter to 0 and let later inserts collide with
            // events that the bulk delete failed to remove.
            let max_remaining: Option<i64> = conn.query_row(
                "SELECT MAX(history_sequence) FROM events WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )?;
            reset_sequence(session_id, max_remaining.unwrap_or(-1) + 1);
            update_session_metadata(&conn, session_id)?;
            super::turn_index::rebuild_turn_index(session_id)?;

            return Ok(TruncateResult {
                deleted_count,
                deleted_ids,
                deleted_sequences,
            });
        }
    };

    // Primary path: sequence-based truncation across the linear history.
    let to_delete = select_ids_by_seq(&conn, session_id, target_seq)?;
    let deleted_ids: Vec<String> = to_delete.iter().map(|(id, _)| id.clone()).collect();
    let deleted_sequences: Vec<i64> = to_delete.iter().filter_map(|(_, seq)| *seq).collect();
    let deleted_count = deleted_ids.len() as i64;
    delete_by_seq(&conn, session_id, target_seq)?;

    reset_sequence(session_id, target_seq);
    update_session_metadata(&conn, session_id)?;
    super::turn_index::rebuild_turn_index(session_id)?;

    Ok(TruncateResult {
        deleted_count,
        deleted_ids,
        deleted_sequences,
    })
}

// ============================================================================
// Private helpers — linear SELECT / DELETE
// ============================================================================

/// Collect (id, history_sequence) for events at or after `seq`.
fn select_ids_by_seq(
    conn: &rusqlite::Connection,
    session_id: &str,
    seq: i64,
) -> SqliteResult<Vec<(String, Option<i64>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, history_sequence FROM events
         WHERE session_id = ?1 AND history_sequence >= ?2",
    )?;
    let rows: SqliteResult<Vec<_>> = stmt
        .query_map(params![session_id, seq], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })?
        .collect();
    rows
}

/// Delete events at or after `seq`.
fn delete_by_seq(conn: &rusqlite::Connection, session_id: &str, seq: i64) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM events
         WHERE session_id = ?1 AND history_sequence >= ?2",
        params![session_id, seq],
    )?;
    Ok(())
}

/// Collect (id, history_sequence) for events at or after `ts`.
fn select_ids_by_ts(
    conn: &rusqlite::Connection,
    session_id: &str,
    ts: &str,
) -> SqliteResult<Vec<(String, Option<i64>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, history_sequence FROM events
         WHERE session_id = ?1 AND created_at >= ?2",
    )?;
    let rows: SqliteResult<Vec<_>> = stmt
        .query_map(params![session_id, ts], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })?
        .collect();
    rows
}

/// Delete events at or after `ts`.
fn delete_by_ts(conn: &rusqlite::Connection, session_id: &str, ts: &str) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM events
         WHERE session_id = ?1 AND created_at >= ?2",
        params![session_id, ts],
    )?;
    Ok(())
}

// ============================================================================

/// Delete a single event by ID
/// Preserves the rest of the history
pub fn delete_event(session_id: &str, event_id: &str) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;

        let deleted = tx.execute(
            "DELETE FROM events WHERE session_id = ?1 AND id = ?2",
            params![session_id, event_id],
        )?;

        if deleted > 0 {
            update_session_metadata(&conn, session_id)?;
        }
        tx.commit()?;

        Ok(deleted > 0)
    })
}

/// Delete an exact event set in one transaction.
///
/// Callers that mirror a prefix removal in memory first resolve that prefix to
/// stable IDs, then use this operation so a mid-batch SQLite failure cannot
/// leave only part of the durable set deleted.
pub fn delete_events_by_ids(session_id: &str, event_ids: &[String]) -> SqliteResult<usize> {
    if event_ids.is_empty() {
        return Ok(0);
    }
    let deleted = with_sessions_writer(|| {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        let deleted = {
            let mut statement =
                tx.prepare_cached("DELETE FROM events WHERE session_id = ?1 AND id = ?2")?;
            let mut deleted = 0usize;
            for event_id in event_ids {
                deleted += statement.execute(params![session_id, event_id])?;
            }
            deleted
        };
        if deleted > 0 {
            update_session_metadata(&conn, session_id)?;
        }
        tx.commit()?;
        Ok::<usize, rusqlite::Error>(deleted)
    })?;
    if deleted > 0 {
        super::turn_index_debounce::schedule(session_id);
    }
    Ok(deleted)
}

/// Update an existing event by ID
pub fn update_event(session_id: &str, event: &CachedEvent) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;

        let updated = conn.execute(
            "UPDATE events SET
                event_type = ?3,
                function_name = ?4,
                thread_id = ?5,
                args_json = ?6,
                result_json = ?7,
                content = ?8,
                meta_json = ?9
             WHERE session_id = ?1 AND id = ?2",
            params![
                session_id,
                event.id,
                event.event_type,
                event.function_name,
                event.thread_id,
                event.args_json,
                event.result_json,
                event.content,
                event.meta_json,
            ],
        )?;

        Ok(updated > 0)
    })
}

/// Clear all events for a session.
///
/// Returns the list of deleted event IDs and sequences. The SELECT runs
/// outside the writer lock (concurrent under WAL); the DELETE / sequence
/// reset / metadata update run inside one `BEGIN IMMEDIATE` so the
/// caller-visible state is atomic.
pub fn clear_session_history(session_id: &str) -> SqliteResult<TruncateResult> {
    let to_delete: Vec<(String, Option<i64>)> = {
        let conn = get_connection()?;
        // If we silently drop a row here (`filter_map(|r| r.ok())`), the
        // returned `TruncateResult.deleted_ids` would lie about which
        // rows the bulk `DELETE` below actually removed, so the
        // frontend's optimistic event-list invalidation could miss the
        // deleted row. Surface the error instead.
        let mut stmt =
            conn.prepare("SELECT id, history_sequence FROM events WHERE session_id = ?1")?;
        let rows = stmt
            .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<SqliteResult<Vec<(String, Option<i64>)>>>()?;
        rows
    };

    let deleted_ids: Vec<String> = to_delete.iter().map(|(id, _)| id.clone()).collect();
    let deleted_sequences: Vec<i64> = to_delete.iter().filter_map(|(_, seq)| *seq).collect();
    let deleted_count = deleted_ids.len() as i64;

    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        tx.execute("DELETE FROM events WHERE session_id = ?1", [session_id])?;
        reset_sequence(session_id, 0);
        update_session_metadata(&conn, session_id)?;
        tx.commit()?;
        Ok(())
    })?;

    Ok(TruncateResult {
        deleted_count,
        deleted_ids,
        deleted_sequences,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::{get_session_metadata, init_session_tables, load_events, save_events, CachedEvent};

    fn cached_event(session_id: &str, id: &str) -> CachedEvent {
        CachedEvent {
            id: id.to_string(),
            session_id: session_id.to_string(),
            event_type: "raw".to_string(),
            function_name: Some("user_message".to_string()),
            thread_id: None,
            args_json: "{}".to_string(),
            result_json: "{}".to_string(),
            content: id.to_string(),
            created_at: "2026-09-05T00:00:00Z".to_string(),
            meta_json: None,
            history_sequence: None,
        }
    }

    #[test]
    fn batch_delete_rolls_back_every_id_when_one_delete_fails() {
        let _guard = crate::ORGII_HOME_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_home = std::env::var_os("ORGII_HOME");
        let root = std::env::temp_dir().join(format!(
            "orgii-session-delete-batch-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test home");
        std::env::set_var("ORGII_HOME", &root);

        let session_id = "atomic-prefix-delete";
        let ids = vec!["prefix-a".to_string(), "prefix-b".to_string()];
        let conn = get_connection().expect("open session database");
        init_session_tables(&conn).expect("initialize session schema");
        drop(conn);
        save_events(
            session_id,
            &[
                cached_event(session_id, &ids[0]),
                cached_event(session_id, &ids[1]),
                cached_event(session_id, "keep"),
            ],
        )
        .expect("seed events");
        let conn = get_connection().expect("reopen session database");
        conn.execute_batch(
            "CREATE TRIGGER abort_second_batch_delete
             BEFORE DELETE ON events WHEN OLD.id = 'prefix-b'
             BEGIN SELECT RAISE(ABORT, 'blocked delete'); END;",
        )
        .expect("install aborting delete trigger");
        drop(conn);

        assert!(delete_events_by_ids(session_id, &ids).is_err());
        let remaining = load_events(session_id).expect("reload rolled-back events");
        assert!(remaining.iter().any(|event| event.id == "prefix-a"));
        assert!(remaining.iter().any(|event| event.id == "prefix-b"));
        assert!(remaining.iter().any(|event| event.id == "keep"));

        let conn = get_connection().expect("reopen session database after rollback");
        conn.execute_batch("DROP TRIGGER abort_second_batch_delete")
            .expect("remove aborting delete trigger");
        drop(conn);
        assert_eq!(
            delete_events_by_ids(session_id, &ids).expect("retry atomic batch delete"),
            2
        );
        let remaining = load_events(session_id).expect("reload successfully deleted events");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "keep");
        assert_eq!(
            get_session_metadata(session_id)
                .expect("load session metadata")
                .expect("session metadata exists")
                .event_count,
            1
        );

        match previous_home {
            Some(value) => std::env::set_var("ORGII_HOME", value),
            None => std::env::remove_var("ORGII_HOME"),
        }
        let _ = fs::remove_dir_all(root);
    }
}
