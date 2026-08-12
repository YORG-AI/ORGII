//! Session Cache Schema
//!
//! Schema definitions for session-specific tables (events, sessions, OS Agent,
//! repos, token_usage). The `database` workspace crate owns connection-level
//! plumbing (`get_db_path`, `configure_connection`); this module owns the
//! domain table DDL and is registered with the database crate's schema
//! dispatcher at app startup.

use rusqlite::{Connection, Result as SqliteResult};

/// Initialize session-related tables.
///
/// Called once per process by `database::db::init_all_schemas()`.
/// Creates tables for:
/// - Session events
/// - Session metadata
/// - OS Agent sessions and messages
/// - Token usage tracking
/// - Repository tracking
pub fn init_session_tables(conn: &Connection) -> SqliteResult<()> {
    // Create events table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            function_name TEXT,
            thread_id TEXT,
            args_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT NOT NULL DEFAULT '{}',
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            meta_json TEXT,
            history_sequence INTEGER,
            UNIQUE(id, session_id)
        )",
        [],
    )?;

    // Add meta_json column if it doesn't exist (migration for existing DBs)
    conn.execute("ALTER TABLE events ADD COLUMN meta_json TEXT", [])
        .ok();

    // Add history_sequence column if it doesn't exist (migration for existing DBs)
    conn.execute("ALTER TABLE events ADD COLUMN history_sequence INTEGER", [])
        .ok();

    // Drop legacy stage_name column (SQLite 3.35+)
    conn.execute("ALTER TABLE events DROP COLUMN stage_name", [])
        .ok();

    // Create indexes for fast lookups
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_session_created ON events(session_id, created_at)",
        [],
    )?;
    // Index for history_sequence queries (truncate, delete by sequence)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, history_sequence)",
        [],
    )?;

    // Complete shell transcripts live in append-only artifacts. The leaf
    // database crate owns this cross-layer storage schema so the app startup
    // path and lower-level replay tests use the exact same DDL.
    database::init_shell_replay_tables(conn)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_turns (
            session_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            start_sequence INTEGER NOT NULL,
            end_sequence INTEGER,
            next_turn_id TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER,
            user_event_ids_json TEXT NOT NULL DEFAULT '[]',
            user_preview TEXT NOT NULL DEFAULT '',
            event_count INTEGER NOT NULL DEFAULT 0,
            body_event_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            interrupted INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            modified_files_json TEXT NOT NULL DEFAULT '[]',
            resource_interactions_json TEXT NOT NULL DEFAULT '[]',
            git_artifacts_json TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (session_id, turn_id)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_turns_session_sequence
         ON session_turns(session_id, start_sequence)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_turns_started_at
         ON session_turns(started_at)",
        [],
    )?;
    // Per-round modified-file list, materialized by the turn indexer so the
    // frontend never aggregates file changes itself. JSON array of
    // `{ path, fileName, status, additions, deletions }`.
    conn.execute(
        "ALTER TABLE session_turns ADD COLUMN modified_files_json TEXT NOT NULL DEFAULT '[]'",
        [],
    )
    .ok();
    // Provider-neutral per-round resource observations. Only normalized path,
    // action, outcome, timestamps, and count are stored; raw tool payloads are
    // deliberately excluded.
    conn.execute(
        "ALTER TABLE session_turns ADD COLUMN resource_interactions_json TEXT NOT NULL DEFAULT '[]'",
        [],
    )
    .ok();
    // Per-round commits and pull requests, parsed from successful git/gh
    // shell results by the same parser as the live event pipeline.
    conn.execute(
        "ALTER TABLE session_turns ADD COLUMN git_artifacts_json TEXT NOT NULL DEFAULT '[]'",
        [],
    )
    .ok();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_turn_index_state (
            session_id TEXT PRIMARY KEY,
            indexed_event_count INTEGER NOT NULL,
            indexed_max_sequence INTEGER,
            rebuilt_at TEXT NOT NULL,
            index_version INTEGER NOT NULL DEFAULT 1
        )",
        [],
    )?;
    conn.execute(
        "ALTER TABLE session_turn_index_state ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1",
        [],
    )
    .ok();

    // ============================================
    // Canonical user-intent lifecycle (turnIntentId)
    // ============================================
    //
    // One row per logical user intent. Created when a user submission first
    // crosses any wire boundary (frontend dispatch → agent_send_message →
    // scheduler enqueue) and updated as it transitions through queued →
    // running → completed/failed/cancelled, or through stale if Stop or
    // rewind retires it before it ever runs. This is the out-of-band
    // source of truth that lets the turn indexer collapse synthetic +
    // backend user_message rows that share an id, and that lets round
    // status be derived from lifecycle state instead of event-count
    // heuristics.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_turn_intents (
            session_id        TEXT NOT NULL,
            turn_intent_id    TEXT NOT NULL,
            client_message_id TEXT,
            org_run_id        TEXT,
            source            TEXT NOT NULL,
            status            TEXT NOT NULL,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL,
            PRIMARY KEY (session_id, turn_intent_id)
        )",
        [],
    )?;
    // Existing databases predate explicit Agent Org ownership. The column is
    // nullable because ordinary session turns do not belong to an Org run.
    // In-flight legacy rows are reconciled to terminal state on restart, so
    // no unsafe session-tree backfill is attempted here.
    conn.execute(
        "ALTER TABLE session_turn_intents ADD COLUMN org_run_id TEXT",
        [],
    )
    .ok();
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_turn_intents_session_status
         ON session_turn_intents(session_id, status)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_turn_intents_org_run_status
         ON session_turn_intents(org_run_id, status)
         WHERE org_run_id IS NOT NULL",
        [],
    )?;

    drop_events_fts(conn);

    // Create sessions metadata table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            event_count INTEGER NOT NULL DEFAULT 0,
            cached_at INTEGER NOT NULL,
            content_revision INTEGER NOT NULL DEFAULT 0,
            time_range_start TEXT,
            time_range_end TEXT,
            specs_json TEXT
        )",
        [],
    )?;

    // Migration: add specs_json column for existing DBs
    conn.execute("ALTER TABLE sessions ADD COLUMN specs_json TEXT", [])
        .ok();
    conn.execute(
        "ALTER TABLE sessions ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();

    // ============================================
    // Human session note entries
    // ============================================

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS human_session_entries (
            id         TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
            body       TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_human_session_entries_session
            ON human_session_entries(session_id, created_at);",
    )?;

    // ============================================
    // Per-round token usage tracking
    // ============================================

    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_token_usage (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id         TEXT NOT NULL,
            session_type       TEXT NOT NULL,
            model              TEXT,
            account_id         TEXT,
            input_tokens       INTEGER NOT NULL DEFAULT 0,
            output_tokens      INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens       INTEGER NOT NULL DEFAULT 0,
            context_tokens     INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            created_at         TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stu_session_id ON session_token_usage(session_id)",
        [],
    )?;
    // Usage dashboard windows first scope by session/source, then by time.
    // `IF NOT EXISTS` makes this a non-destructive migration for existing DBs;
    // one composite index keeps the new read path cheap without duplicating
    // another full-table index on this write-heavy event table.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stu_session_created_at_id
         ON session_token_usage(session_id, created_at, id)",
        [],
    )?;

    // Migration: add context_tokens column (last LLM call's prompt tokens = context fill level)
    conn.execute(
        "ALTER TABLE session_token_usage ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();

    conn.execute(
        "ALTER TABLE session_token_usage ADD COLUMN context_usage_json TEXT",
        [],
    )
    .ok();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_llm_usage_spans (
            id                         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id                 TEXT NOT NULL,
            turn_id                    TEXT NOT NULL,
            iteration_index            INTEGER NOT NULL,
            model                      TEXT,
            account_id                 TEXT,
            prompt_tokens              INTEGER NOT NULL DEFAULT 0,
            completion_tokens          INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens          INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens         INTEGER NOT NULL DEFAULT 0,
            total_tokens               INTEGER NOT NULL DEFAULT 0,
            context_tokens             INTEGER NOT NULL DEFAULT 0,
            related_tool_call_ids_json TEXT,
            context_usage_json         TEXT,
            created_at                 TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_slus_session_turn ON session_llm_usage_spans(session_id, turn_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_slus_session_iteration ON session_llm_usage_spans(session_id, iteration_index)",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_tool_usage (
            id                         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id                 TEXT NOT NULL,
            turn_id                    TEXT NOT NULL,
            event_id                   TEXT NOT NULL,
            tool_call_id               TEXT NOT NULL,
            tool_name                  TEXT NOT NULL,
            iteration_index            INTEGER NOT NULL,
            decision_completion_tokens INTEGER NOT NULL DEFAULT 0,
            result_context_tokens      INTEGER NOT NULL DEFAULT 0,
            followup_completion_tokens INTEGER NOT NULL DEFAULT 0,
            input_bytes                INTEGER NOT NULL DEFAULT 0,
            output_bytes               INTEGER NOT NULL DEFAULT 0,
            attribution_method         TEXT NOT NULL,
            created_at                 TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stool_session_turn ON session_tool_usage(session_id, turn_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stool_session_call ON session_tool_usage(session_id, tool_call_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stool_session_iteration ON session_tool_usage(session_id, iteration_index)",
        [],
    )?;

    // ============================================
    // Repository tracking table
    // ============================================

    conn.execute(
        "CREATE TABLE IF NOT EXISTS repos (
            repo_id    TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            path       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_path ON repos(path)",
        [],
    )?;

    // Migration: add visibility column for public/private classification
    conn.execute("ALTER TABLE repos ADD COLUMN visibility TEXT", [])
        .ok();

    // Migration: add kind column to distinguish git repos from plain work folders
    conn.execute("ALTER TABLE repos ADD COLUMN kind TEXT DEFAULT 'git'", [])
        .ok();

    // ============================================
    // Workspace presets table
    // ============================================

    conn.execute(
        "CREATE TABLE IF NOT EXISTS workspaces (
            workspace_id    TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            primary_repo_id TEXT,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS workspace_folders (
            workspace_id TEXT NOT NULL,
            folder_path  TEXT NOT NULL,
            folder_name  TEXT NOT NULL,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            is_primary   INTEGER NOT NULL DEFAULT 0,
            repo_id      TEXT,
            kind         TEXT DEFAULT 'git',
            PRIMARY KEY (workspace_id, folder_path),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
        )",
        [],
    )?;

    // ============================================
    // Learnings table (memory/learnings.rs)
    // ============================================
    agent_core::memory::learnings::init_learnings_table(conn)?;

    // ============================================
    // One-shot cleanup: drop legacy message-branching artifacts
    // ============================================
    //
    // The fork-on-edit branching system was retired in favor of a linear
    // hard-delete model. Existing DBs may still carry the `session_branches`
    // table, the `events.branch_id` column, and the `idx_events_branch_id`
    // index. Drop the auxiliary table and index — the orphan column on
    // `events` stays untouched (SQLite tolerates extra unused columns and
    // dropping a column on every startup is wasted I/O).
    conn.execute("DROP TABLE IF EXISTS session_branches", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_events_branch_id", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_sb_session_id", [])?;

    // ============================================
    // One-shot cleanup: purge TS-side per-delta placeholders
    // ============================================
    //
    // `stream-msg-ts-*` / `stream-think-ts-*` rows are live-only display
    // artifacts that slipped into SQLite before the write path was gated
    // (see `cache_bridge::is_ts_placeholder_id`). Leaving them in the events
    // table causes the frontend dedup pass to collapse them against the Rust
    // authoritative segments, which on reload drops entire say/do/say
    // narrative from session history.
    //
    // Running this on every startup is cheap — once the DB is clean, the
    // DELETE matches zero rows. Kept here (vs a versioned migration) so the
    // same app can recover any session that was created under the old
    // broken write path without operator intervention.
    let _ = conn.execute(
        "DELETE FROM events WHERE id LIKE 'stream-msg-ts-%' OR id LIKE 'stream-think-ts-%'",
        [],
    );

    Ok(())
}

/// Drop the events FTS5 index and its sync triggers.
///
/// The index cost far more than it was worth: `save_events` churn (frontend
/// re-submissions cycling delete + insert through the triggers) with no
/// compaction left the shadow tables ~70x their live size (594 MB indexing
/// ~9 MB of text, 98% orphaned entries), and the only UI consumer of FTS
/// search is not mounted. Event search now runs LIKE scans over `events`
/// directly (`crud::search_events` / `crud::search_all_sessions`).
///
/// Triggers must go in the same batch: an insert into `events` with a
/// surviving trigger referencing the dropped vtable would fail. `DROP TABLE`
/// on an FTS5 vtable removes all of its shadow tables. Marker-gated so the
/// batch runs once (a failed attempt retries next startup); best-effort —
/// schema init must never fail over cleanup.
fn drop_events_fts(conn: &Connection) {
    const MARKER: &str = "events_fts_dropped_2026_07";

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .ok();
    let already_dropped = conn
        .prepare("SELECT COUNT(*) FROM _migrations WHERE name = ?1")
        .and_then(|mut stmt| stmt.query_row([MARKER], |row| row.get::<_, i64>(0)))
        .unwrap_or(0)
        > 0;
    if already_dropped {
        return;
    }

    let started = std::time::Instant::now();
    match conn.execute_batch(
        "DROP TRIGGER IF EXISTS events_ai;
         DROP TRIGGER IF EXISTS events_ad;
         DROP TRIGGER IF EXISTS events_au;
         DROP TABLE IF EXISTS events_fts;",
    ) {
        Ok(()) => {
            // Freed pages land on the freelist and are reclaimed lazily
            // (page reuse + `incremental_vacuum` in `clear_old_sessions`);
            // log the expectation so the one-time win is visible.
            let freelist_pages: i64 = conn
                .query_row("PRAGMA freelist_count", [], |row| row.get(0))
                .unwrap_or(0);
            tracing::info!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                freelist_pages,
                "[schema] events_fts index and triggers dropped; freelist pages are reclaimable"
            );
            conn.execute(
                "INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?1, ?2)",
                rusqlite::params![MARKER, chrono::Utc::now().to_rfc3339()],
            )
            .ok();
        }
        Err(err) => {
            tracing::warn!(error = %err, "[schema] events_fts drop failed; will retry next startup");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_exists(conn: &Connection, index_name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
            [index_name],
            |row| row.get::<_, bool>(0),
        )
        .expect("query index existence")
    }

    fn table_exists(conn: &Connection, table_name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table_name],
            |row| row.get::<_, bool>(0),
        )
        .expect("query table existence")
    }

    fn column_exists(conn: &Connection, table_name: &str, column_name: &str) -> bool {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table_name})"))
            .expect("prepare table info");
        let exists = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .filter_map(Result::ok)
            .any(|name| name == column_name);
        exists
    }

    #[test]
    fn init_session_tables_creates_usage_telemetry_tables_and_indexes() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        init_session_tables(&conn).expect("init session schema");

        assert!(table_exists(&conn, "session_llm_usage_spans"));
        assert!(table_exists(&conn, "session_tool_usage"));
        assert!(index_exists(&conn, "idx_slus_session_turn"));
        assert!(index_exists(&conn, "idx_slus_session_iteration"));
        assert!(index_exists(&conn, "idx_stool_session_turn"));
        assert!(index_exists(&conn, "idx_stool_session_call"));
        assert!(index_exists(&conn, "idx_stool_session_iteration"));
        assert!(index_exists(&conn, "idx_stu_session_created_at_id"));
        assert!(column_exists(&conn, "session_turn_intents", "org_run_id"));
        assert!(index_exists(
            &conn,
            "idx_session_turn_intents_org_run_status"
        ));
    }

    #[test]
    fn init_session_tables_adds_org_run_id_to_existing_turn_intents() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE session_turn_intents (
                 session_id TEXT NOT NULL,
                 turn_intent_id TEXT NOT NULL,
                 client_message_id TEXT,
                 source TEXT NOT NULL,
                 status TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY (session_id, turn_intent_id)
             );
             INSERT INTO session_turn_intents (
                 session_id, turn_intent_id, source, status, created_at, updated_at
             ) VALUES ('legacy-session', 'legacy-intent', 'agent_org', 'queued',
                       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .expect("seed legacy turn-intent schema");

        init_session_tables(&conn).expect("upgrade session schema");

        assert!(column_exists(&conn, "session_turn_intents", "org_run_id"));
        let legacy_owner: Option<String> = conn
            .query_row(
                "SELECT org_run_id FROM session_turn_intents
                 WHERE session_id='legacy-session' AND turn_intent_id='legacy-intent'",
                [],
                |row| row.get(0),
            )
            .expect("legacy row remains readable");
        assert_eq!(legacy_owner, None, "legacy ownership must not be guessed");
    }

    #[test]
    fn init_session_tables_creates_human_session_entry_schema() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);",
        )
        .expect("create canonical session parent");
        init_session_tables(&conn).expect("init session schema");

        assert!(table_exists(&conn, "human_session_entries"));
        assert!(index_exists(&conn, "idx_human_session_entries_session"));

        conn.execute("INSERT INTO agent_sessions VALUES ('humansession-1')", [])
            .expect("insert Human session parent");
        conn.execute(
            "INSERT INTO human_session_entries
             (id, session_id, body, created_at)
             VALUES ('entry-1', 'humansession-1', 'done', 'now')",
            [],
        )
        .expect("insert Human entry");

        conn.execute(
            "DELETE FROM agent_sessions WHERE session_id='humansession-1'",
            [],
        )
        .expect("delete Human session parent");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM human_session_entries", [], |row| {
                row.get(0)
            })
            .expect("count cascaded rows");
        assert_eq!(count, 0, "entries should cascade with their Human session");
    }

    fn trigger_exists(conn: &Connection, trigger_name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?1)",
            [trigger_name],
            |row| row.get::<_, bool>(0),
        )
        .expect("query trigger existence")
    }

    #[test]
    fn init_session_tables_drops_legacy_events_fts_and_records_marker() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");

        // Recreate the legacy state: events table + FTS vtable + sync triggers.
        conn.execute(
            "CREATE TABLE events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                function_name TEXT,
                thread_id TEXT,
                args_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                meta_json TEXT,
                history_sequence INTEGER,
                UNIQUE(id, session_id)
            )",
            [],
        )
        .expect("create legacy events table");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE events_fts USING fts5(
                id, content, function_name, args_json,
                content='events', content_rowid='rowid'
            );
            CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
                INSERT INTO events_fts(rowid, id, content, function_name, args_json)
                VALUES (NEW.rowid, NEW.id, NEW.content, NEW.function_name, NEW.args_json);
            END;
            CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
                INSERT INTO events_fts(events_fts, rowid, id, content, function_name, args_json)
                VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.function_name, OLD.args_json);
            END;
            CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
                INSERT INTO events_fts(events_fts, rowid, id, content, function_name, args_json)
                VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.function_name, OLD.args_json);
                INSERT INTO events_fts(rowid, id, content, function_name, args_json)
                VALUES (NEW.rowid, NEW.id, NEW.content, NEW.function_name, NEW.args_json);
            END;",
        )
        .expect("create legacy FTS vtable and triggers");

        init_session_tables(&conn).expect("init session schema");

        assert!(!table_exists(&conn, "events_fts"));
        assert!(!trigger_exists(&conn, "events_ai"));
        assert!(!trigger_exists(&conn, "events_ad"));
        assert!(!trigger_exists(&conn, "events_au"));
        // Shadow tables go with the vtable.
        assert!(!table_exists(&conn, "events_fts_data"));
        assert!(!table_exists(&conn, "events_fts_docsize"));

        let marker_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _migrations WHERE name = 'events_fts_dropped_2026_07'",
                [],
                |row| row.get(0),
            )
            .expect("query migration marker");
        assert_eq!(marker_count, 1);

        // Second init is a no-op (marker-gated) and must not fail.
        init_session_tables(&conn).expect("re-init session schema");
    }
}
