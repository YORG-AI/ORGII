//! Inbox Module
//!
//! Persists inbox messages (notifications, git events, promotions, work items)
//! in the shared SQLite database (`~/.orgii/sessions.db`).
//!
//! ## Components
//!
//! - `persistence` — SQLite CRUD for `inbox_messages` table
//! - `commands` — Tauri commands exposed to the frontend

pub mod commands;
pub mod persistence;

use rusqlite::{Connection, Result as SqliteResult};

/// Initialize inbox tables in the shared database.
///
/// Called from `session::cache::get_connection()` alongside other table inits.
pub fn init_inbox_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS inbox_messages (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            preview     TEXT NOT NULL DEFAULT '',
            content     TEXT NOT NULL DEFAULT '',
            category    TEXT NOT NULL DEFAULT 'git',
            priority    TEXT NOT NULL DEFAULT 'none',
            status      TEXT NOT NULL DEFAULT 'unread',
            sender_name TEXT,
            metadata    TEXT NOT NULL DEFAULT '{}',
            labels      TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status);
        CREATE INDEX IF NOT EXISTS idx_inbox_category ON inbox_messages(category);
        CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_inbox_tables_is_idempotent_and_creates_the_expected_schema() {
        let conn = Connection::open_in_memory().expect("in-memory database");

        init_inbox_tables(&conn).expect("initial schema creation");
        init_inbox_tables(&conn).expect("idempotent schema creation");

        let columns = conn
            .prepare("PRAGMA table_info(inbox_messages)")
            .expect("prepare columns query")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query columns")
            .collect::<SqliteResult<Vec<_>>>()
            .expect("collect columns");
        assert_eq!(
            columns,
            [
                "id",
                "title",
                "preview",
                "content",
                "category",
                "priority",
                "status",
                "sender_name",
                "metadata",
                "labels",
                "created_at",
                "updated_at",
            ]
        );

        let indexes = conn
            .prepare("PRAGMA index_list(inbox_messages)")
            .expect("prepare indexes query")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query indexes")
            .collect::<SqliteResult<Vec<_>>>()
            .expect("collect indexes");
        for expected in [
            "idx_inbox_status",
            "idx_inbox_category",
            "idx_inbox_created",
        ] {
            assert!(indexes.iter().any(|index| index == expected), "{expected}");
        }
    }
}
