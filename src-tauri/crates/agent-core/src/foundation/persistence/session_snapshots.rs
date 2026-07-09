//! Agent session persistence layer
//!
//! Manages `agent_sessions`, `agent_snapshots`, `agent_todos`, and
//! `agent_file_resolutions` tables in the shared `sessions.db` SQLite database.
//!
//! Message CRUD lives in `agent_core::session::persistence` (shared across all agent types).
//! Session CRUD is local because the schema includes `workspace_path`.

use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::persistence::db_helpers as shared;
use crate::tools::names as tool_names;
use database::db::{begin_immediate, get_connection, with_sessions_writer};

/// Run a schema migration, tolerating "column already exists" errors and logging anything else.
fn try_migrate(conn: &Connection, sql: &str) {
    if let Err(err) = conn.execute(sql, []) {
        let msg = err.to_string();
        let tolerated = msg.contains("duplicate column name") || msg.contains("already exists");
        if !tolerated {
            warn!("session_snapshots migration failed for `{}`: {}", sql, err);
        }
    }
}

/// Drop a column if it exists, tolerating "no such column" on subsequent runs.
/// Requires SQLite 3.35+ (bundled in rusqlite's vendored build).
fn try_drop_column(conn: &Connection, table: &str, column: &str) {
    let sql = format!("ALTER TABLE {} DROP COLUMN {}", table, column);
    if let Err(err) = conn.execute(&sql, []) {
        let msg = err.to_string();
        let tolerated = msg.contains("no such column")
            || msg.contains("no such table")
            || msg.contains("does not exist");
        if !tolerated {
            warn!(
                "session_snapshots drop-column failed for `{}`: {}",
                sql, err
            );
        }
    }
}

// ============================================
// Schema Init
// ============================================

/// Production entry point: opens the shared connection (which goes
/// through the `database::db::SCHEMA_INIT` `Once` guard) and runs the
/// full create-and-migrate sequence on it.
///
/// Tests that need to seed this schema on a sandboxed `sessions.db`
/// should call [`ensure_tables_with`] directly with a `Connection`
/// they already opened — the `Once` guard fires only on the first
/// process-global `get_connection()` and so is not safe to rely on
/// from a per-test sandbox.
pub fn ensure_tables() -> SqliteResult<()> {
    let conn = get_connection()?;
    ensure_tables_with(&conn)
}

/// Connection-scoped variant of [`ensure_tables`]. Identical SQL, but
/// runs against a caller-supplied `Connection` so that test sandboxes
/// (which open their own `Connection` to a tempdir-backed
/// `sessions.db`) get the same schema as production without depending
/// on the global `SCHEMA_INIT` `Once`.
pub fn ensure_tables_with(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_sessions (
            session_id  TEXT PRIMARY KEY,
            name        TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'idle',
            model       TEXT,
            account_id  TEXT,
            workspace_path TEXT,
            user_input  TEXT,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_messages (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '',
            tool_name   TEXT,
            tool_call_id TEXT,
            tool_input  TEXT,
            tool_output TEXT,
            model       TEXT,
            sequence    INTEGER NOT NULL,
            created_at  TEXT NOT NULL,
            -- Compact boundary pointer: NULL for ordinary rows. A non-NULL
            -- value marks this row as a compaction summary whose visible
            -- tail starts at that sequence. Rows are never rewritten or
            -- deleted by compaction (immutable transcript invariant).
            compact_from_sequence INTEGER,
            -- Boundary display metadata: estimated context tokens before /
            -- after the compaction. NULL on ordinary rows and on boundaries
            -- persisted before these columns existed.
            compact_tokens_before INTEGER,
            compact_tokens_after INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_am_session
            ON agent_messages(session_id, sequence);
        -- agent_snapshots: legacy column name `hash` now holds a per-session
        -- file_history snapshot ID (UUID). The actual file backups live under
        -- ~/.orgii/file-history/<session_id>/snapshots/<snapshot_id>.json.
        -- Schema kept stable; `hash` retained for migration-free repointing.
        CREATE TABLE IF NOT EXISTS agent_snapshots (
            id           TEXT PRIMARY KEY,
            session_id   TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            hash         TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_as_session
            ON agent_snapshots(session_id, created_at);
        CREATE TABLE IF NOT EXISTS agent_todos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL,
            content     TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            priority    TEXT NOT NULL DEFAULT 'medium',
            position    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_at_session
            ON agent_todos(session_id, position);
        CREATE TABLE IF NOT EXISTS agent_file_resolutions (
            session_id  TEXT NOT NULL,
            file_path   TEXT NOT NULL,
            resolution  TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            PRIMARY KEY (session_id, file_path)
        );",
    )?;

    try_migrate(conn, "ALTER TABLE agent_messages ADD COLUMN images TEXT");
    try_migrate(
        conn,
        "ALTER TABLE agent_messages ADD COLUMN compact_from_sequence INTEGER",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_messages ADD COLUMN compact_tokens_before INTEGER",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_messages ADD COLUMN compact_tokens_after INTEGER",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN workspace_path TEXT",
    );

    try_migrate(conn, "ALTER TABLE agent_sessions ADD COLUMN org_id TEXT");
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN project_id TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN project_name TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN work_item_id TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN agent_role TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN worktree_branch TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN base_branch TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN merge_status TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN project_slug TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN agent_definition_id TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN org_member_id TEXT",
    );

    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN key_source TEXT NOT NULL DEFAULT 'own_key'",
    );

    // Session Memory persistence columns
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN sm_content TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN sm_last_msg_idx INTEGER",
    );

    // L3 rebuild: the per-session learning toggle was replaced by a per-agent
    // `learnings.enabled` flag on `AgentDefinition`
    // (see docs/agent/l3-memory-rebuild--0421.md §6.4).
    // Drop the legacy column if it survives from an older install.
    try_drop_column(conn, "agent_sessions", "learning_enabled");

    // `active_form` holds the present-continuous spinner label for an
    // in-progress todo (e.g. "Running tests"). Nullable because rows written
    // before this column was added read back as None; the UI then falls back
    // to the `content` field for the spinner label.
    try_migrate(conn, "ALTER TABLE agent_todos ADD COLUMN active_form TEXT");

    // Task DAG: `blocked_by` stores a JSON array of position indices (integers)
    // of tasks that must be completed before this one can start. Empty array
    // means no blockers. Stored as TEXT (JSON) to avoid a join table for what
    // are typically short, session-scoped lists.
    try_migrate(
        conn,
        "ALTER TABLE agent_todos ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'",
    );

    // Cancel-interrupt: when a turn is cancelled by the user, the next
    // turn's processor injects an in-memory-only "[Request interrupted
    // by user]" user message so the LLM knows what happened. This flag
    // persists across session object lifetimes (the processor is
    // re-constructed every turn). Defaults to 0 (no cancel).
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN last_turn_cancelled INTEGER NOT NULL DEFAULT 0",
    );

    // Per-session execution mode (build / ask / plan / debug / review /
    // wingman). NULL means the user has never explicitly chosen one for this
    // session — frontend falls back to the global `creatorDefaultExecModeAtom`
    // until the first explicit patch. CLI sessions never write here (they have
    // no mode concept); this column is `agent_sessions`-only on purpose.
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN agent_exec_mode TEXT",
    );

    // Per-session composer state (P3): unsent draft text + the message id
    // the user has currently selected as their reply target. Both are
    // optional and cleared on send / banner-dismiss respectively. The
    // frontend `useSessionDraftField` / `useSessionReplyField` hooks
    // patch them via `session_patch` (debounced for the draft so we
    // don't write on every keystroke). Stored on `agent_sessions` only
    // because the same `session_patch` command tunnels through both
    // CLI and rust-agent rows; CLI rows simply never get written here.
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN draft_text TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN reply_target_event_id TEXT",
    );

    Ok(())
}

// ============================================
// Snapshot Persistence
// ============================================

pub fn get_snapshots(session_id: &str) -> SqliteResult<Vec<(String, String, String)>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT tool_call_id, hash, created_at
         FROM agent_snapshots
         WHERE session_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

pub fn truncate_snapshots_after(session_id: &str, created_at: &str) -> SqliteResult<i64> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let deleted = conn.execute(
            "DELETE FROM agent_snapshots WHERE session_id = ?1 AND created_at >= ?2",
            params![session_id, created_at],
        )?;
        Ok(deleted as i64)
    })
}

/// Return all snapshot hashes (now: per-session `file_history` snapshot IDs)
/// captured at or after `created_at`, ordered ASC by `created_at`. Used by
/// `file_history::rewind_to_message` to walk and undo every tool-call edit
/// since the target message.
pub fn get_snapshots_after(session_id: &str, created_at: &str) -> SqliteResult<Vec<String>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT hash FROM agent_snapshots
         WHERE session_id = ?1 AND created_at >= ?2 AND tool_call_id != ?3
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(
            params![
                session_id,
                created_at,
                crate::tools::file_history::REDO_SNAPSHOT_TOOL_CALL_ID
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_latest_snapshot_before_by_tool_call_id(
    session_id: &str,
    tool_call_id: &str,
    created_at: &str,
) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    shared::query_optional(conn.query_row(
        "SELECT hash FROM agent_snapshots
         WHERE session_id = ?1 AND tool_call_id = ?2 AND created_at <= ?3
         ORDER BY created_at DESC
         LIMIT 1",
        params![session_id, tool_call_id, created_at],
        |row| row.get(0),
    ))
}

pub fn get_snapshot_created_at_by_hash(
    session_id: &str,
    snapshot_hash: &str,
) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    shared::query_optional(conn.query_row(
        "SELECT created_at FROM agent_snapshots
         WHERE session_id = ?1 AND hash = ?2
         ORDER BY created_at DESC
         LIMIT 1",
        params![session_id, snapshot_hash],
        |row| row.get(0),
    ))
}

pub fn clear_review_snapshots(session_id: &str) -> SqliteResult<i64> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let deleted = conn.execute(
            "DELETE FROM agent_snapshots WHERE session_id = ?1 AND tool_call_id != ?2",
            params![
                session_id,
                crate::tools::file_history::REDO_SNAPSHOT_TOOL_CALL_ID
            ],
        )?;
        Ok(deleted as i64)
    })
}

/// Count `agent_snapshots` rows for a given session. Used by the file-history
/// per-session cap (evict oldest once count exceeds the limit).
pub fn count_snapshots_for_session(session_id: &str) -> SqliteResult<i64> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT COUNT(*) FROM agent_snapshots WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )
}

/// Return the `hash` (snapshot_id) of the oldest `limit` rows for a session,
/// ordered ascending by `created_at`. Used to evict the oldest manifests once
/// the per-session cap is exceeded.
pub fn get_oldest_snapshot_ids(session_id: &str, limit: i64) -> SqliteResult<Vec<String>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT hash FROM agent_snapshots
         WHERE session_id = ?1
         ORDER BY created_at ASC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![session_id, limit], |row| row.get::<_, String>(0))?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

/// Delete a set of `agent_snapshots` rows for a session by their `hash`
/// (snapshot_id) column. Returns the number of rows actually removed.
pub fn delete_snapshots_by_ids(session_id: &str, snapshot_ids: &[String]) -> SqliteResult<i64> {
    if snapshot_ids.is_empty() {
        return Ok(0);
    }
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        let mut total: i64 = 0;
        {
            let mut stmt =
                tx.prepare("DELETE FROM agent_snapshots WHERE session_id = ?1 AND hash = ?2")?;
            for id in snapshot_ids {
                total += stmt.execute(params![session_id, id])? as i64;
            }
        }
        tx.commit()?;
        Ok(total)
    })
}

pub fn get_snapshot_ids_by_tool_call_id(
    session_id: &str,
    tool_call_id: &str,
) -> SqliteResult<Vec<String>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT hash FROM agent_snapshots
         WHERE session_id = ?1 AND tool_call_id = ?2
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![session_id, tool_call_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

/// Return all session IDs that currently have at least one row in
/// `agent_snapshots`. Used by blob-GC and mtime-based file-history pruning
/// to cross-reference which sessions are represented on disk vs. in the DB.
pub fn list_sessions_with_snapshots() -> SqliteResult<Vec<String>> {
    let conn = get_connection()?;
    let mut stmt =
        conn.prepare("SELECT DISTINCT session_id FROM agent_snapshots ORDER BY session_id ASC")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

/// Delete all `agent_snapshots` rows for a session. Used when mtime-based
/// TTL pruning wipes an entire session's file-history directory.
pub fn delete_all_snapshots_for_session(session_id: &str) -> SqliteResult<i64> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let deleted = conn.execute(
            "DELETE FROM agent_snapshots WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(deleted as i64)
    })
}

/// Return the `hash` (snapshot_id) of the most-recent snapshot whose
/// `tool_call_id` starts with the given prefix, or `None` if no such row
/// exists. Used by `manage_file_history` redo to find the redo snapshot.
pub fn get_latest_snapshot_by_tool_call_prefix(
    session_id: &str,
    tool_call_id_prefix: &str,
) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    let pattern = format!("{}%", tool_call_id_prefix);
    let result = conn.query_row(
        "SELECT hash FROM agent_snapshots
         WHERE session_id = ?1 AND tool_call_id LIKE ?2
         ORDER BY created_at DESC
         LIMIT 1",
        params![session_id, pattern],
        |row| row.get(0),
    );
    match result {
        Ok(hash) => Ok(Some(hash)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn get_session_workspace_path(session_id: &str) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    let path: Option<String> = shared::query_optional(conn.query_row(
        "SELECT workspace_path FROM agent_sessions WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    ))?;
    if path.is_some() {
        return Ok(path);
    }
    // Fallback: CLI code sessions store the path as repo_path in code_sessions
    shared::query_optional(conn.query_row(
        "SELECT repo_path FROM code_sessions WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    ))
}

/// Return distinct workspace paths recently touched by agent
/// sessions, newest first. Used by `list_known_workspaces` so the OS agent
/// can match a user mention like "yoyo-evolve" to a real workspace.
///
/// Two filter layers apply so the OS agent only sees workspaces the
/// user would actually call "projects":
///
/// 1. **Temporary scratch directories** — `/var/folders/...` (macOS per-user
///    temp), `/tmp`, `/private/tmp`, `/private/var/folders/...`, plus the
///    runtime `$TMPDIR`. These get seeded by the e2e test suite and
///    otherwise dominate the recent-session list for a dev install.
/// 2. **ORGII internal workspaces** — `~/.orgii` and the user's home root
///    itself. Paths like `~/.orgii/personal/workspace` or `~/.orgii/osagent/workspace`
///    are the built-in agents' own scratch dirs; the end-user's mental
///    model of "my projects" never includes them.
///
/// Matching uses `path LIKE prefix || '%'`, so a project legitimately named
/// e.g. `.orgii-demo` under `$HOME` is only excluded when it lives *inside*
/// the excluded directory (not when the path merely contains the substring).
pub fn list_known_workspace_paths(limit: usize) -> SqliteResult<Vec<String>> {
    let conn = get_connection()?;

    // Build the exclusion prefix list. Fixed prefixes are string-interpolated
    // (they are compile-time constants, no injection risk); variable
    // prefixes (HOME, TMPDIR) are bound as parameters.
    let mut conditions: Vec<String> = vec![
        "path NOT LIKE '/var/folders/%'".to_string(),
        "path NOT LIKE '/tmp/%'".to_string(),
        "path NOT LIKE '/private/tmp/%'".to_string(),
        "path NOT LIKE '/private/var/folders/%'".to_string(),
    ];
    let mut dynamic_params: Vec<String> = Vec::new();

    // Runtime TMPDIR — may already be covered by the fixed prefixes above,
    // but CI / container environments sometimes point it elsewhere.
    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let trimmed = tmpdir.trim_end_matches('/');
        if !trimmed.is_empty() {
            dynamic_params.push(format!("{}/%", trimmed));
            conditions.push(format!("path NOT LIKE ?{}", dynamic_params.len() + 1));
        }
    }

    // $HOME itself ("/Users/vinceorz") — a session whose workspace is
    // literally the home dir is always the catch-all fallback, never a
    // real project. Match the directory exactly, not as a prefix.
    if let Ok(home) = std::env::var("HOME") {
        let trimmed = home.trim_end_matches('/');
        if !trimmed.is_empty() {
            // Built-in agent workspaces live under `~/.orgii/...`.
            dynamic_params.push(format!("{}/.orgii%", trimmed));
            conditions.push(format!("path NOT LIKE ?{}", dynamic_params.len() + 1));
            // Exact-home match (not prefix — otherwise we'd exclude
            // everything under $HOME, including real projects).
            dynamic_params.push(trimmed.to_string());
            conditions.push(format!("path <> ?{}", dynamic_params.len() + 1));
        }
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT path FROM (
            SELECT workspace_path AS path, updated_at AS ts FROM agent_sessions
                WHERE workspace_path IS NOT NULL AND workspace_path != ''
            UNION ALL
            SELECT repo_path AS path, created_at AS ts FROM code_sessions
                WHERE repo_path IS NOT NULL AND repo_path != ''
         )
         WHERE {}
         GROUP BY path
         ORDER BY MAX(ts) DESC
         LIMIT ?1",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;

    // Bind: ?1 = limit, ?2..?N = dynamic_params in order.
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(dynamic_params.len() + 1);
    bound.push(Box::new(limit as i64));
    for p in &dynamic_params {
        bound.push(Box::new(p.clone()));
    }
    let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(refs.as_slice(), |row| row.get::<_, String>(0))?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

// ============================================
// File Resolution Persistence
// ============================================

pub fn save_file_resolution(
    session_id: &str,
    file_path: &str,
    resolution: &str,
) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        conn.execute(
            "INSERT INTO agent_file_resolutions (session_id, file_path, resolution, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, file_path) DO UPDATE SET
               resolution = excluded.resolution,
               created_at = excluded.created_at",
            params![
                session_id,
                file_path,
                resolution,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    })
}

pub fn get_file_resolutions(session_id: &str) -> SqliteResult<Vec<(String, String)>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT file_path, resolution
         FROM agent_file_resolutions
         WHERE session_id = ?1",
    )?;
    let rows = stmt
        .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

pub fn clear_file_resolutions(session_id: &str) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        conn.execute(
            "DELETE FROM agent_file_resolutions WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(())
    })
}

// ============================================
// Tauri Commands
// ============================================

/// File modification record extracted from tool call history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileChange {
    pub path: String,
    pub tool: String,
    pub count: u32,
}

const SESSION_FILE_MODIFY_TOOLS: &[&str] = &[
    tool_names::EDIT_FILE,
    tool_names::APPLY_PATCH,
    tool_names::STORAGE_WRITE_FILE,
    tool_names::STORAGE_CREATE_FILE,
    tool_names::STORAGE_EDIT_FILE_BY_REPLACE,
    tool_names::STORAGE_APPEND_FILE,
    tool_names::STORAGE_FILE_RANGE_EDIT,
    tool_names::STORAGE_INSERT_CONTENT_AT_LINE,
    tool_names::CLI_DISPLAY_EDIT,
    tool_names::CLI_DISPLAY_WRITE,
    tool_names::CLI_DISPLAY_CREATE,
    tool_names::CLI_DISPLAY_PATCH,
];

type SessionFileToolRow = (String, String, Option<String>);

fn table_exists(conn: &Connection, table_name: &str) -> SqliteResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table_name],
        |row| row.get::<_, bool>(0),
    )
}

fn column_exists(conn: &Connection, table_name: &str, column_name: &str) -> SqliteResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column_name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn query_session_file_tool_rows(
    conn: &Connection,
    table_name: &str,
    tool_column: &str,
    input_column: &str,
    output_column: &str,
    order_by: &str,
    session_id: &str,
    tool_names: &[&str],
    created_at_or_after: Option<&str>,
) -> SqliteResult<Vec<SessionFileToolRow>> {
    if tool_names.is_empty() || !table_exists(conn, table_name)? {
        return Ok(Vec::new());
    }
    let can_filter_created_at =
        created_at_or_after.is_some() && column_exists(conn, table_name, "created_at")?;

    let placeholders = (0..tool_names.len())
        .map(|idx| format!("?{}", idx + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let created_at_filter = if can_filter_created_at {
        format!(" AND created_at >= ?{}", tool_names.len() + 2)
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT {tool_column}, {input_column}, {output_column}
         FROM {table_name}
         WHERE session_id = ?1
           AND {tool_column} IN ({placeholders})
           AND {input_column} IS NOT NULL{created_at_filter}
         ORDER BY {order_by}",
    );

    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(tool_names.len() + 2);
    bound.push(Box::new(session_id.to_string()));
    for tool_name in tool_names {
        bound.push(Box::new((*tool_name).to_string()));
    }
    if can_filter_created_at {
        if let Some(created_at) = created_at_or_after {
            bound.push(Box::new(created_at.to_string()));
        }
    }
    let params_ref: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|value| value.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_ref.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

fn accumulate_session_file_change(
    file_map: &mut std::collections::HashMap<String, (String, u32)>,
    tool_name: &str,
    tool_input: &str,
    tool_output: Option<&str>,
) {
    if tool_output.is_some_and(|output| output.starts_with("Error")) {
        return;
    }

    for path in extract_paths_from_tool_input(tool_name, tool_input) {
        let entry = file_map
            .entry(path)
            .or_insert_with(|| (tool_name.to_string(), 0));
        entry.1 += 1;
    }
}

/// Extract the deduplicated list of files modified by a session, derived from
/// tool call arguments stored in Rust-native `agent_messages` and CLI
/// `code_session_chunks`.
pub fn get_session_modified_files(session_id: &str) -> SqliteResult<Vec<SessionFileChange>> {
    get_session_modified_files_since(session_id, None)
}

pub fn get_session_modified_files_after(
    session_id: &str,
    created_at: &str,
) -> SqliteResult<Vec<SessionFileChange>> {
    get_session_modified_files_since(session_id, Some(created_at))
}

fn get_session_modified_files_since(
    session_id: &str,
    created_at_or_after: Option<&str>,
) -> SqliteResult<Vec<SessionFileChange>> {
    let conn = get_connection()?;

    let mut file_map: std::collections::HashMap<String, (String, u32)> =
        std::collections::HashMap::new();

    let agent_message_rows = query_session_file_tool_rows(
        &conn,
        "agent_messages",
        "tool_name",
        "tool_input",
        "tool_output",
        "sequence ASC",
        session_id,
        SESSION_FILE_MODIFY_TOOLS,
        created_at_or_after,
    )?;
    for (tool_name, tool_input, tool_output) in agent_message_rows {
        accumulate_session_file_change(
            &mut file_map,
            &tool_name,
            &tool_input,
            tool_output.as_deref(),
        );
    }

    let cli_chunk_rows = query_session_file_tool_rows(
        &conn,
        "code_session_chunks",
        "function",
        "args_json",
        "result_json",
        "sequence ASC",
        session_id,
        SESSION_FILE_MODIFY_TOOLS,
        created_at_or_after,
    )?;
    for (tool_name, tool_input, tool_output) in cli_chunk_rows {
        accumulate_session_file_change(
            &mut file_map,
            &tool_name,
            &tool_input,
            tool_output.as_deref(),
        );
    }

    let mut result: Vec<SessionFileChange> = file_map
        .into_iter()
        .map(|(path, (tool, count))| SessionFileChange { path, tool, count })
        .collect();
    result.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(result)
}

fn extract_paths_from_patch_text(patch_text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch_text.lines() {
        let trimmed = line.trim();
        let path = trimmed
            .strip_prefix("*** Add File:")
            .or_else(|| trimmed.strip_prefix("*** Update File:"))
            .or_else(|| trimmed.strip_prefix("*** Delete File:"))
            .or_else(|| trimmed.strip_prefix("+++ b/"))
            .or_else(|| trimmed.strip_prefix("--- a/"));
        if let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) {
            if path != "/dev/null" {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

/// Extract files written by a single tool call from the persisted JSON
/// argument payload used by Rust-native `agent_messages` and CLI
/// `code_session_chunks`.
///
/// Only canonical file-edit tool names and CLI display aliases contribute
/// paths; read-only tools deliberately produce no snapshot entries.
///
/// Corrupt JSON in `tool_input` is treated as "no extractable paths"
/// rather than a hard error so a single malformed historical row
/// can't block the whole session-files panel — but we surface a
/// `tracing::warn!` so the broken row is visible in logs.
pub(crate) fn extract_paths_from_tool_input(tool_name: &str, tool_input: &str) -> Vec<String> {
    let parsed: serde_json::Value = match serde_json::from_str(tool_input) {
        Ok(val) => val,
        Err(err) => {
            warn!(
                "[session_snapshots] tool_input JSON parse failed for {tool_name}: {err}; \
                 skipping this row in the file-change snapshot",
            );
            return Vec::new();
        }
    };

    let mut paths = match tool_name {
        tool_names::EDIT_FILE
        | tool_names::DELETE_FILE
        | tool_names::STORAGE_WRITE_FILE
        | tool_names::STORAGE_CREATE_FILE
        | tool_names::STORAGE_EDIT_FILE_BY_REPLACE
        | tool_names::STORAGE_APPEND_FILE
        | tool_names::STORAGE_FILE_RANGE_EDIT
        | tool_names::STORAGE_INSERT_CONTENT_AT_LINE
        | tool_names::CLI_DISPLAY_EDIT
        | tool_names::CLI_DISPLAY_WRITE
        | tool_names::CLI_DISPLAY_CREATE => parsed
            .get("file_path")
            .or_else(|| parsed.get("file_name"))
            .or_else(|| parsed.get("path"))
            .and_then(|value| value.as_str())
            .map(|path| vec![path.to_string()])
            .unwrap_or_default(),
        tool_names::APPLY_PATCH | tool_names::CLI_DISPLAY_PATCH => parsed
            .get("patch_text")
            .or_else(|| parsed.get("patch"))
            .and_then(|value| value.as_str())
            .map(extract_paths_from_patch_text)
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(test)]
#[path = "tests/session_snapshots_tests.rs"]
mod snapshot_tests;
