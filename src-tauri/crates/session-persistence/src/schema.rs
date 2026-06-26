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
/// - Session events and FTS index
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
            source            TEXT NOT NULL,
            status            TEXT NOT NULL,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL,
            PRIMARY KEY (session_id, turn_intent_id)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_turn_intents_session_status
         ON session_turn_intents(session_id, status)",
        [],
    )?;

    // Create FTS5 virtual table for full-text search
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
            id,
            content,
            function_name,
            args_json,
            content='events',
            content_rowid='rowid',
            tokenize='porter unicode61'
        )",
        [],
    )?;

    // Create triggers to keep FTS index in sync
    conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
            INSERT INTO events_fts(rowid, id, content, function_name, args_json)
            VALUES (NEW.rowid, NEW.id, NEW.content, NEW.function_name, NEW.args_json);
        END;

        CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
            INSERT INTO events_fts(events_fts, rowid, id, content, function_name, args_json)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.function_name, OLD.args_json);
        END;

        CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
            INSERT INTO events_fts(events_fts, rowid, id, content, function_name, args_json)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.function_name, OLD.args_json);
            INSERT INTO events_fts(rowid, id, content, function_name, args_json)
            VALUES (NEW.rowid, NEW.id, NEW.content, NEW.function_name, NEW.args_json);
        END;",
    )?;

    // Create sessions metadata table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            event_count INTEGER NOT NULL DEFAULT 0,
            cached_at INTEGER NOT NULL,
            time_range_start TEXT,
            time_range_end TEXT,
            specs_json TEXT
        )",
        [],
    )?;

    // Migration: add specs_json column for existing DBs
    conn.execute("ALTER TABLE sessions ADD COLUMN specs_json TEXT", [])
        .ok();

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
