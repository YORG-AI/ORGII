//! Session Work Item relation updates kept outside the CRUD facade.

use rusqlite::Result as SqliteResult;

use database::db::{get_connection, with_sessions_writer};

/// Remove only the Work Item portion of a session's canonical project
/// relation. Project metadata remains available after the unlink.
pub fn clear_work_item_link(session_id: &str) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let updated = conn.execute(
            "UPDATE agent_sessions SET work_item_id = NULL WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(updated > 0)
    })
}
