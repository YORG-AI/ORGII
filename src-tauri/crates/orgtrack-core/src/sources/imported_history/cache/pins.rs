use std::collections::HashSet;

use rusqlite::{params, Connection};

/// Set or clear ORGII pin state for one imported session.
///
/// Pins live in their own table rather than on the cache row: the cache is a
/// rebuildable projection whose rows a prune can legitimately delete, and a
/// pin is user intent that must outlive any rescan.
pub fn set_imported_session_pinned_from_conn(
    conn: &Connection,
    session_id: &str,
    pinned: bool,
    pinned_at: &str,
) -> Result<(), String> {
    let result = if pinned {
        conn.execute(
            "INSERT INTO imported_history_session_pin (session_id, pinned_at)
             VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET pinned_at = excluded.pinned_at",
            params![session_id, pinned_at],
        )
    } else {
        conn.execute(
            "DELETE FROM imported_history_session_pin WHERE session_id = ?1",
            params![session_id],
        )
    };
    result
        .map(|_| ())
        .map_err(|err| format!("Failed to persist imported session pin: {err}"))
}

/// The set of imported session ids the user has pinned.
pub fn pinned_imported_session_ids_from_conn(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = conn
        .prepare("SELECT session_id FROM imported_history_session_pin")
        .map_err(|err| format!("Failed to read imported session pins: {err}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("Failed to read imported session pins: {err}"))?;
    let mut ids = HashSet::new();
    for row in rows {
        ids.insert(row.map_err(|err| format!("Failed to read imported session pins: {err}"))?);
    }
    Ok(ids)
}
