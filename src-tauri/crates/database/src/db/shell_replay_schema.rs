//! Canonical schema for append-only shell replay artifacts.
//!
//! The replay writer lives in `agent_core`, while Session/EventStore startup
//! lives above it. Keeping the DDL in this leaf crate gives both production
//! startup and isolated writer tests one source of truth without introducing
//! a dependency cycle.

use rusqlite::{Connection, Result as SqliteResult};

/// Create the manifest, range index, and durable cleanup queue used by shell
/// replay storage. Production calls this through the registered sessions
/// schema initializer; focused lower-layer tests may call it explicitly.
pub fn init_shell_replay_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shell_replays (
            session_id TEXT NOT NULL,
            call_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            status TEXT NOT NULL,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            last_sequence INTEGER NOT NULL DEFAULT 0,
            terminal_preview TEXT NOT NULL DEFAULT '',
            error TEXT,
            completed_at TEXT,
            format_version INTEGER NOT NULL DEFAULT 1,
            command TEXT NOT NULL DEFAULT '',
            cwd TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, call_id)
        );
        CREATE INDEX IF NOT EXISTS idx_shell_replays_session
            ON shell_replays(session_id);

        CREATE TABLE IF NOT EXISTS shell_replay_pages (
            session_id TEXT NOT NULL,
            call_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            file_offset INTEGER NOT NULL,
            output_byte_start INTEGER NOT NULL,
            first_sequence INTEGER NOT NULL,
            last_sequence INTEGER NOT NULL DEFAULT 0,
            line_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, call_id, page_index)
        );
        CREATE INDEX IF NOT EXISTS idx_shell_replay_pages_lookup
            ON shell_replay_pages(session_id, call_id, output_byte_start);

        CREATE TABLE IF NOT EXISTS shell_replay_cleanup_jobs (
            session_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_shell_replay_cleanup_session
            ON shell_replay_cleanup_jobs(session_id);",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_initializer_creates_manifest_index_and_cleanup_queue() {
        let conn = Connection::open_in_memory().expect("in-memory database");

        init_shell_replay_tables(&conn).expect("initialize shell replay schema");
        // The initializer is deliberately idempotent because both a new app
        // database and a test/recovery path may call it.
        init_shell_replay_tables(&conn).expect("reinitialize shell replay schema");

        for table in [
            "shell_replays",
            "shell_replay_pages",
            "shell_replay_cleanup_jobs",
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )
                .expect("query schema");
            assert!(exists, "missing canonical shell replay table: {table}");
        }
    }
}
