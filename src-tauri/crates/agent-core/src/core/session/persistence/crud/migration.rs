//! Schema migration for the unified `agent_sessions` table.
//!
//! Adds new columns / indexes if they don't exist. Safe to call multiple
//! times (idempotent). Tolerates "duplicate column name" / "already
//! exists" errors so re-running on an up-to-date DB is a no-op; any other
//! error is logged at warn level so unexpected schema drift is visible.

use rusqlite::{Connection, Result as SqliteResult};
use tracing::warn;

/// Run a schema migration statement, tolerating "column already exists" / "index already exists"
/// but logging any other error.
fn try_migrate(conn: &Connection, sql: &str) {
    if let Err(err) = conn.execute(sql, []) {
        let msg = err.to_string();
        let tolerated = msg.contains("duplicate column name") || msg.contains("already exists");
        if !tolerated {
            warn!("Schema migration failed for `{}`: {}", sql, err);
        }
    }
}

/// Ensure the unified session schema is ready.
///
/// Adds new columns to `agent_sessions` if they don't exist.
/// Safe to call multiple times (idempotent).
///
/// Accepts a `&Connection` to avoid re-entering `get_connection()` during
/// `SCHEMA_INIT.call_once()` (which would deadlock on the `Once` guard).
///
/// ## SQL string defaults vs. Rust constants
///
/// The `DEFAULT '...'` clauses below intentionally hard-code the wire
/// strings rather than format them in from constants. This is a one-time
/// DDL — the column default is baked into SQLite at column-creation time;
/// changing the constant later does not (and *should* not) rewrite the
/// stored default. The string here must therefore stay byte-equal to:
///
/// - `session_type::GENERIC` → `'agent'`
///   (see [`super::record::session_type`])
/// - `KeySource::OwnKey.as_ref()` → `'own_key'`
///   (see `core_types::key_source::KeySource`)
///
/// The `migration_defaults_match_constants` test below pins this down.
pub fn ensure_unified_schema(conn: &Connection) -> SqliteResult<()> {
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'agent'",
    );
    try_migrate(conn, "ALTER TABLE agent_sessions ADD COLUMN channel TEXT");
    try_migrate(conn, "ALTER TABLE agent_sessions ADD COLUMN chat_id TEXT");
    try_migrate(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_type ON agent_sessions(session_type)",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN parent_event_id TEXT",
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
        "ALTER TABLE agent_sessions ADD COLUMN org_member_id TEXT",
    );
    try_migrate(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions(parent_session_id)",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN key_source TEXT NOT NULL DEFAULT 'own_key'",
    );
    // JSON-encoded BTreeMap<PathBuf, AdditionalDirectory>. Empty map
    // (not NULL) is the default so `serde_json::from_str` always
    // succeeds on rows created before this column existed.
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN workspace_additional_json TEXT NOT NULL DEFAULT '{}'",
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
        "ALTER TABLE agent_sessions ADD COLUMN native_harness_type TEXT",
    );
    // Whether the session is pinned to the top of the sidebar (0 = no, 1 = yes).
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    );
    try_migrate(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_sidebar
         ON agent_sessions(
             pinned, session_type, parent_session_id,
             updated_at DESC, session_id DESC
         )",
    );

    // Durable marker for the latest backend-observed terminal turn. This is
    // intentionally on `agent_sessions`, not only in transient websocket
    // traffic, so stale `running` rows can be audited/repaired after a missed
    // frontend signal or process restart.
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN last_terminal_turn_id TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN last_terminal_turn_status TEXT",
    );
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN last_terminal_turn_at TEXT",
    );

    // Orgtrack product mode (orgtrack/v1 §5.2): build|plan|ask|project.
    // NULL = never resolved = build. The only source of truth for
    // persistent WorkItem/Routine mutation intent.
    try_migrate(
        conn,
        "ALTER TABLE agent_sessions ADD COLUMN product_mode TEXT",
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::record::session_type;
    use core_types::key_source::KeySource;

    /// Pin the wire strings used as SQL `DEFAULT` clauses against the typed
    /// constants on the read side. If anyone renames the enum variant or
    /// shifts a constant, this test fails before silent DB drift can ship.
    #[test]
    fn migration_defaults_match_constants() {
        assert_eq!(
            session_type::GENERIC,
            "agent",
            "ensure_unified_schema hard-codes DEFAULT 'agent' for session_type"
        );
        assert_eq!(
            KeySource::OwnKey.as_ref(),
            "own_key",
            "ensure_unified_schema hard-codes DEFAULT 'own_key' for key_source"
        );
    }
}
