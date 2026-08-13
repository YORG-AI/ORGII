//! Shared `agent_sessions` schema for tests that hit the global SQLite
//! connection.
//!
//! Test modules used to carry their own `CREATE TABLE IF NOT EXISTS
//! agent_sessions (...)` copies. Under a parallel test run the FIRST module
//! to touch the shared connection wins the CREATE, so any module whose copy
//! had drifted behind production made every LATER writer fail with
//! "table agent_sessions has no column named X" — flakily, depending on
//! test scheduling order. One authority, kept in lock-step with
//! `UPSERT_SESSION_SQL` / `UNIFIED_SESSION_SELECT`, removes the class.

/// Full production column set (34 columns) plus the usage telemetry tables
/// (`session_token_usage`, `session_llm_usage_spans`, `session_tool_usage`)
/// so the delete cascade in `crud::ops` can run against the test schema.
pub(crate) const AGENT_SESSIONS_TEST_DDL: &str = r#"
    CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        account_id TEXT,
        user_input TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_type TEXT NOT NULL DEFAULT 'agent',
        channel TEXT,
        chat_id TEXT,
        workspace_path TEXT,
        org_id TEXT,
        project_id TEXT,
        project_name TEXT,
        work_item_id TEXT,
        agent_role TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        base_branch TEXT,
        merge_status TEXT,
        project_slug TEXT,
        agent_definition_id TEXT,
        org_member_id TEXT,
        parent_session_id TEXT,
        parent_event_id TEXT,
        workspace_additional_json TEXT NOT NULL DEFAULT '{}',
        key_source TEXT NOT NULL DEFAULT 'own_key',
        agent_exec_mode TEXT,
        product_mode TEXT,
        native_harness_type TEXT,
        draft_text TEXT,
        reply_target_event_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        sm_content TEXT,
        sm_last_msg_idx INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_type TEXT NOT NULL DEFAULT 'sde',
        model TEXT,
        account_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        context_usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS session_llm_usage_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        iteration_index INTEGER NOT NULL,
        model TEXT,
        account_id TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        related_tool_call_ids_json TEXT,
        context_usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS session_tool_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        iteration_index INTEGER NOT NULL,
        decision_completion_tokens INTEGER NOT NULL DEFAULT 0,
        result_context_tokens INTEGER NOT NULL DEFAULT 0,
        followup_completion_tokens INTEGER NOT NULL DEFAULT 0,
        input_bytes INTEGER NOT NULL DEFAULT 0,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        attribution_method TEXT NOT NULL DEFAULT 'bytes_only',
        created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS orgtrack_core_session_usage (
        session_id          TEXT PRIMARY KEY,
        source              TEXT NOT NULL,
        model               TEXT,
        account_id          TEXT,
        key_source          TEXT,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
        total_tokens        INTEGER NOT NULL DEFAULT 0,
        context_tokens      INTEGER NOT NULL DEFAULT 0,
        recorded_cost_usd   REAL NOT NULL DEFAULT 0,
        estimated_cost_usd  REAL NOT NULL DEFAULT 0,
        cost_usd            REAL NOT NULL DEFAULT 0,
        tokens_source       TEXT NOT NULL DEFAULT 'none',
        computed_at         TEXT NOT NULL
    );
"#;

/// Idempotently install the shared schema on the global test connection.
/// Also repairs a table created earlier by a stale copy of the DDL: when
/// `agent_sessions` exists but misses production columns, they are added
/// in place so later full-column upserts cannot fail on scheduling order.
pub(crate) fn ensure_agent_sessions_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(AGENT_SESSIONS_TEST_DDL)
        .expect("agent_sessions test schema");

    let existing: std::collections::HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('agent_sessions')")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();

    for (column, decl) in [
        ("org_id", "org_id TEXT"),
        ("project_id", "project_id TEXT"),
        ("project_name", "project_name TEXT"),
        ("native_harness_type", "native_harness_type TEXT"),
        ("draft_text", "draft_text TEXT"),
        ("reply_target_event_id", "reply_target_event_id TEXT"),
        ("pinned", "pinned INTEGER NOT NULL DEFAULT 0"),
        ("agent_exec_mode", "agent_exec_mode TEXT"),
        ("product_mode", "product_mode TEXT"),
        (
            "workspace_additional_json",
            "workspace_additional_json TEXT NOT NULL DEFAULT '{}'",
        ),
        ("key_source", "key_source TEXT NOT NULL DEFAULT 'own_key'"),
        ("sm_content", "sm_content TEXT"),
        ("sm_last_msg_idx", "sm_last_msg_idx INTEGER"),
    ] {
        if !existing.contains(column) {
            let _ = conn.execute(&format!("ALTER TABLE agent_sessions ADD COLUMN {decl}"), []);
        }
    }
}
