//! CLI Agent Module
//!
//! Manages CLI agent sessions (Cursor, Claude Code, Codex, Gemini, Kiro, Copilot).
//!
//! SQLite table names: `cli_agent_sessions` and `cli_agent_chunks`.
//!
//! ## Components
//!
//! - `parsers` — Stdout parsers for each CLI agent (Cursor, Claude Code, Codex, Gemini, etc.)
//! - `persistence` — SQLite CRUD for `cli_agent_sessions` + `cli_agent_chunks` tables
//! - `session_runner` — Spawns CLI agent subprocess, pipes stdout through parser, broadcasts events
//! - `commands` — Tauri commands exposed to the frontend

pub mod agent_core_bridge;
pub mod commands;
pub mod hook_approvals;
pub mod launch_profile_store;
pub mod native_transcript;
pub mod parsers;
pub mod persistence;
pub mod platform_adapters;
pub mod session_runner;
pub mod skill_sync;
pub mod tui_bridge;
pub mod types;

use rusqlite::{Connection, Result as SqliteResult};

/// Initialize CLI agent tables in the shared database.
///
/// Called from `session::cache::get_connection()` alongside other table inits.
pub fn init_cli_agent_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS code_sessions (
            session_id     TEXT PRIMARY KEY,
            name           TEXT NOT NULL DEFAULT 'Code Session',
            status         TEXT NOT NULL DEFAULT 'pending',
            flow           TEXT NOT NULL DEFAULT 'quick',
            runner         TEXT NOT NULL DEFAULT 'local',
            billing_mode   TEXT NOT NULL DEFAULT 'local',
            platform       TEXT,
            cli_agent_type TEXT,
            model          TEXT,
            tier           TEXT,
            account_id     TEXT,
            repo_path      TEXT,
            branch         TEXT,
            user_input     TEXT,
            proxy_token    TEXT,
            proxy_url      TEXT,
            proxy_port     INTEGER,
            error_message  TEXT,
            token_usage    TEXT,
            pid            INTEGER,
            cli_session_id TEXT,
            parent_session_id TEXT,
            org_member_id TEXT,
            org_id TEXT NOT NULL DEFAULT 'personal-org',
            project_id TEXT,
            project_name TEXT,
            project_slug TEXT,
            work_item_id TEXT,
            agent_role TEXT,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS code_session_chunks (
            chunk_id       TEXT PRIMARY KEY,
            session_id     TEXT NOT NULL REFERENCES code_sessions(session_id) ON DELETE CASCADE,
            action_type    TEXT NOT NULL,
            function       TEXT NOT NULL,
            args_json      TEXT NOT NULL DEFAULT '{}',
            result_json    TEXT NOT NULL DEFAULT '{}',
            thread_id      TEXT,
            process_id     TEXT,
            sequence       INTEGER NOT NULL,
            created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_code_chunks_session
            ON code_session_chunks(session_id, sequence);

        CREATE TABLE IF NOT EXISTS code_session_cli_resume_state (
            session_id     TEXT NOT NULL REFERENCES code_sessions(session_id) ON DELETE CASCADE,
            profile_key    TEXT NOT NULL,
            cli_session_id TEXT NOT NULL,
            updated_at     TEXT NOT NULL,
            PRIMARY KEY (session_id, profile_key)
        );

        CREATE TABLE IF NOT EXISTS code_session_history_mutations (
            session_id TEXT PRIMARY KEY REFERENCES code_sessions(session_id) ON DELETE CASCADE,
            epoch      INTEGER NOT NULL DEFAULT 0,
            reason     TEXT NOT NULL,
            mutated_at TEXT NOT NULL
        );
        ",
    )?;

    conn.execute("ALTER TABLE code_session_chunks DROP COLUMN stage_name", [])
        .ok();

    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN parent_session_id TEXT",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN org_member_id TEXT",
        [],
    )
    .ok();
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_code_sessions_parent_org_member
            ON code_sessions(parent_session_id, org_member_id)",
        [],
    )?;
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'personal-org'",
        [],
    )
    .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN project_id TEXT", [])
        .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN project_name TEXT", [])
        .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN project_slug TEXT", [])
        .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN work_item_id TEXT", [])
        .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN agent_role TEXT", [])
        .ok();
    // Product-mode axis (orgtrack/v1 §5.2) for CLI sessions: parity with
    // agent_sessions so external CLIs can enter Project mode.
    conn.execute("ALTER TABLE code_sessions ADD COLUMN product_mode TEXT", [])
        .ok();
    conn.execute(
        "UPDATE code_sessions
         SET product_mode = CASE
             WHEN work_item_id IS NOT NULL THEN 'project'
             ELSE 'build'
         END
         WHERE product_mode IS NULL
            OR product_mode NOT IN ('build', 'plan', 'ask', 'project')
            OR (work_item_id IS NOT NULL AND product_mode != 'project')",
        [],
    )?;

    // Schema update: add hosted_token column for proxy token release on session cleanup
    conn.execute("ALTER TABLE code_sessions ADD COLUMN hosted_token TEXT", [])
        .ok();

    // Migration: add cli_session_id column for existing databases
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN cli_session_id TEXT",
        [],
    )
    .ok();
    // Migration: add proxy_port column for per-session MITM proxy ports
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN proxy_port INTEGER",
        [],
    )
    .ok();
    // Migration: add proxy_session_id column for billing context cleanup on release
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN proxy_session_id TEXT",
        [],
    )
    .ok();

    // Migration: add worktree isolation columns for parallel agent sessions
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN worktree_path TEXT",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN worktree_branch TEXT",
        [],
    )
    .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN base_branch TEXT", [])
        .ok();
    conn.execute("ALTER TABLE code_sessions ADD COLUMN merge_status TEXT", [])
        .ok();

    // Migration: add background flag for "fire and forget" sessions
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN background INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();

    // Migration: add key_source column for credential source tracking (own_key vs hosted_key)
    // Defaults to "own_key" for existing sessions (backward compatible)
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN key_source TEXT NOT NULL DEFAULT 'own_key'",
        [],
    )
    .ok();

    // Migration: rename platform → cli_agent_type.
    // SQLite cannot rename columns directly, so we add the new column and copy data.
    // The old `platform` column is retained for historical reads; all new writes use cli_agent_type.
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN cli_agent_type TEXT",
        [],
    )
    .ok();
    conn.execute(
        "UPDATE code_sessions SET cli_agent_type = platform WHERE cli_agent_type IS NULL AND platform IS NOT NULL",
        [],
    )
    .ok();

    // Migration: strip <ide_context>...</ide_context> from historical user_input and chunks.
    // Before this fix, inject_ide_context_into_prompt() output was stored verbatim.
    migrate_strip_ide_context(conn);

    // Per-session execution mode. Mirrors `agent_sessions.agent_exec_mode`
    // so CLI sessions can use the same ModePill/Plan approval semantics.
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN agent_exec_mode TEXT",
        [],
    )
    .ok();
    conn.execute(
        "UPDATE code_sessions
         SET agent_exec_mode = 'build'
         WHERE agent_exec_mode IS NULL
            OR TRIM(agent_exec_mode) = ''
            OR agent_exec_mode NOT IN ('build', 'ask', 'plan', 'debug', 'review', 'wingman')
            OR product_mode = 'project'",
        [],
    )?;

    // P3 — per-session composer state (draft text + reply target).
    // Mirrors the same two columns added to `agent_sessions`; the
    // shared `session_patch` Tauri command writes to whichever table
    // owns the session. NULL means "no draft" / "no reply target".
    conn.execute("ALTER TABLE code_sessions ADD COLUMN draft_text TEXT", [])
        .ok();
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN reply_target_event_id TEXT",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_code_sessions_sidebar
            ON code_sessions(
                pinned, parent_session_id, updated_at DESC, session_id DESC
            )",
        [],
    )?;

    // Multi-root extra workspace folders. JSON array of absolute paths,
    // forwarded as `--add-dir <path>` for `claude_code` / `codex` and
    // ignored for CLI agents that don't accept the flag.
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN additional_directories TEXT",
        [],
    )
    .ok();

    // Where this session's transcript of record lives: 'chunks' (legacy,
    // code_session_chunks) or 'native' (the CLI's own store, read back
    // through the imported-history loaders). Decided at creation time and
    // frozen so legacy replays never re-route after a capability flip.
    conn.execute(
        "ALTER TABLE code_sessions ADD COLUMN transcript_source TEXT NOT NULL DEFAULT 'chunks'",
        [],
    )
    .ok();

    // Append-only ledger of every CLI-native session id ever bound to a
    // managed session. `code_sessions.cli_session_id` is overwritten on
    // account switch and cleared on message edit, but sidebar dedup and
    // native-transcript replay must keep recognizing superseded forks.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS code_session_native_transcript_ids (
            session_id        TEXT NOT NULL,
            source            TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            bound_at          TEXT NOT NULL,
            PRIMARY KEY (session_id, source, source_session_id)
        )",
        [],
    )
    .ok();

    Ok(())
}

/// One-time migration: remove `<ide_context>...</ide_context>` blocks from stored
/// user input and user_message chunks so they don't appear in chat history UI.
fn migrate_strip_ide_context(conn: &Connection) {
    const MARKER: &str = "ide_context_stripped";

    // Check if already done via a lightweight sentinel table
    let already_done: bool = conn
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .unwrap_or(0)
        > 0
        && conn
            .prepare("SELECT COUNT(*) FROM _migrations WHERE name = ?1")
            .and_then(|mut s| s.query_row(rusqlite::params![MARKER], |r| r.get::<_, i64>(0)))
            .unwrap_or(0)
            > 0;

    if already_done {
        return;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .ok();

    // 1. Clean code_sessions.user_input
    let cleaned_sessions = conn
        .execute(
            "UPDATE code_sessions
         SET user_input = SUBSTR(user_input,
             INSTR(user_input, '</ide_context>') + LENGTH('</ide_context>') + 2)
         WHERE user_input LIKE '%<ide_context>%</ide_context>%'",
            [],
        )
        .unwrap_or(0);

    // 2. Clean code_session_chunks user_message content
    let cleaned_chunks = conn.execute(
        "UPDATE code_session_chunks
         SET result_json = REPLACE(
             result_json,
             SUBSTR(result_json,
                 INSTR(result_json, '<ide_context>'),
                 INSTR(result_json, '</ide_context>') + LENGTH('</ide_context>') + 4 - INSTR(result_json, '<ide_context>')
             ),
             ''
         )
         WHERE function = 'user_message'
           AND result_json LIKE '%<ide_context>%</ide_context>%'",
        [],
    ).unwrap_or(0);

    if cleaned_sessions > 0 || cleaned_chunks > 0 {
        tracing::info!(
            "[Migration] Stripped <ide_context> from {} sessions, {} chunks",
            cleaned_sessions,
            cleaned_chunks
        );
    }

    conn.execute(
        "INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?1, ?2)",
        rusqlite::params![MARKER, chrono::Utc::now().to_rfc3339()],
    )
    .ok();
}
