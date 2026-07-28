//! Image-aware deletion helpers for the `<prefix>_messages` table.
//!
//! Every public delete function here first walks the rows it is about
//! to remove and asks `images::delete_image_files` to drop the on-disk
//! payloads. Skipping the cleanup step would leak files in
//! `~/.orgii/...` because the DB row is the only reference back.

use rusqlite::{params, types::Type, Result as SqliteResult};

use crate::persistence::images;
use database::db::{get_connection, with_sessions_writer};
/// Collect image file paths from messages matching a WHERE clause, then delete
/// the corresponding files from disk. Called before deleting the DB rows.
pub(super) fn cleanup_image_files_for_query(
    prefix: &str,
    where_clause: &str,
    params: &[&dyn rusqlite::ToSql],
) -> SqliteResult<()> {
    let conn = get_connection()?;
    let sql =
        format!("SELECT images FROM {prefix}_messages WHERE {where_clause} AND images IS NOT NULL");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
    let mut paths = Vec::new();

    for row in rows {
        let json_str = row?;
        let image_paths: Vec<String> = serde_json::from_str(&json_str).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(err))
        })?;
        paths.extend(
            image_paths
                .into_iter()
                .filter(|path| !path.starts_with("data:")),
        );
    }

    if !paths.is_empty() {
        images::delete_image_files(&paths);
    }

    Ok(())
}

/// Delete all messages for a session.
/// Also cleans up any image files referenced by the deleted messages.
pub fn clear_messages(prefix: &str, session_id: &str) -> SqliteResult<i64> {
    cleanup_image_files_for_query(prefix, "session_id = ?1", &[&session_id])?;
    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if prefix == "agent" && table_exists(&tx, "agent_inbox_materializations")? {
            // Rewind/clear removes the durable transcript but intentionally
            // leaves the source Inbox row unread. Deleting its receipt lets
            // the next wake materialize the input again instead of pointing
            // forever at a transcript that no longer exists.
            tx.execute(
                "DELETE FROM agent_inbox_materializations WHERE session_id=?1",
                [session_id],
            )?;
        }
        let sql = format!("DELETE FROM {prefix}_messages WHERE session_id = ?1");
        let deleted = tx.execute(&sql, [session_id])?;
        tx.commit()?;
        Ok(deleted as i64)
    })
}

/// Delete messages at or after a specific sequence number.
/// Also cleans up any image files referenced by the deleted messages.
///
/// Sequence is the **only** truncation coordinate for `<prefix>_messages`:
/// it is assigned append-only and never rewritten, so `sequence >= ?`
/// always selects a suffix of the transcript. (`created_at` truncation
/// was removed after compaction-rewritten timestamps caused a full
/// transcript wipe — see `seed_session_with_messages` docs.)
pub fn truncate_messages_from_sequence(
    prefix: &str,
    session_id: &str,
    from_sequence: i64,
) -> SqliteResult<i64> {
    cleanup_image_files_for_query(
        prefix,
        "session_id = ?1 AND sequence >= ?2",
        &[&session_id as &dyn rusqlite::ToSql, &from_sequence],
    )?;
    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if prefix == "agent" && table_exists(&tx, "agent_inbox_materializations")? {
            tx.execute(
                "DELETE FROM agent_inbox_materializations
                 WHERE session_id=?1
                   AND transcript_message_id IN (
                       SELECT id FROM agent_messages
                       WHERE session_id=?1 AND sequence>=?2
                   )",
                params![session_id, from_sequence],
            )?;
        }
        let sql = format!("DELETE FROM {prefix}_messages WHERE session_id = ?1 AND sequence >= ?2");
        let deleted = tx.execute(&sql, params![session_id, from_sequence])?;
        tx.commit()?;
        Ok(deleted as i64)
    })
}

fn table_exists(conn: &rusqlite::Connection, table_name: &str) -> SqliteResult<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1
         )",
        [table_name],
        |row| row.get(0),
    )
}
