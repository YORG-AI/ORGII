//! Re-export shim: the canonical sandbox guard now lives in the
//! `test_helpers` workspace crate. This file remains so in-tree test code
//! that still imports via `crate::test_utils::test_env` keeps compiling,
//! and so the multi-table schema-prime hook (which reaches into
//! `crate::agent_core` / `crate::agent_sessions` / `crate::project_management`
//! and therefore cannot live in the leaf `test_helpers` crate) is registered
//! exactly once per test binary, before any test calls `sandbox()`.
//!
//! See `test_helpers::test_env` for the sandbox semantics.

use std::path::Path;

use rusqlite::Connection;

pub use test_helpers::test_env::{lock_home, register_after_env_hook, sandbox, SandboxGuard};

/// Eagerly register `prime_schema` as the `test_helpers::test_env`
/// after-env hook before any test runs. `#[ctor::ctor]` runs the function
/// before `main` (and therefore before any `#[test]`), so call sites that
/// import directly from `test_helpers` — bypassing this shim — still get
/// the full multi-table schema prime under the sandbox `ORGII_HOME`.
#[ctor::ctor]
fn install_schema_primer() {
    register_after_env_hook(prime_schema);
}

/// DB schema prime for the current `ORGII_HOME`.
///
/// The real `database::db::get_connection()` uses a global
/// `Once::call_once` guard (intended for production where the schema is
/// only ever initialized once). In tests where every sandbox points
/// `sessions.db` at a fresh tempdir, that `Once` never fires on the new
/// file. `prime_schema()` runs the module init functions directly on a
/// one-off connection so each sandbox has a freshly migrated DB
/// regardless of what happened before.
///
/// Legacy/non-Agent-Org setup remains best-effort for pure environment tests.
/// Agent Org schema initialization is deliberately fail-loud: otherwise a
/// sandbox can silently omit a newly added recovery table while production
/// initializes it correctly, yielding false-green lifecycle tests.
fn prime_schema(_sandbox_root: &Path) {
    let Ok(conn) = raw_connection() else { return };

    let _ = database::db::configure_connection(&conn);
    let _ = session_persistence::init_session_tables(&conn);
    let _ = crate::agent_sessions::cli::init_cli_agent_tables(&conn);
    let _ = inbox::init_inbox_tables(&conn);
    let _ = orgtrack_core::store::sqlite::SqliteRecordStore::init_tables(&conn);
    let _ = orgtrack_core::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn);
    let _ = project_management::lineage::schema::init_lineage_tables(&conn);
    // `agent_core::session::persistence::init` only ALTERs the existing
    // `agent_sessions` table; the table itself is owned by
    // `session_snapshots::ensure_tables_with`, which must run first so
    // its CREATE statements exist before the ALTERs fire.
    let _ = agent_core::foundation::persistence::session_snapshots::ensure_tables_with(&conn);
    let _ = agent_core::session::persistence::init(&conn);
    let _ = agent_core::interaction::plan_approval::persistence::init_schema(&conn);
    agent_core::coordination::init_agent_org_schemas(&conn)
        .expect("initialize complete Agent Org schema in test sandbox");
}

fn raw_connection() -> rusqlite::Result<Connection> {
    let db_path = database::db::get_db_path();
    Connection::open(db_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema_object_exists(conn: &Connection, object_type: &str, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2
             )",
            rusqlite::params![object_type, name],
            |row| row.get(0),
        )
        .expect("inspect sandbox schema object")
    }

    fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table_info");
        let exists = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .any(|name| name.expect("read column name") == column);
        exists
    }

    #[test]
    fn sandbox_agent_org_schema_matches_shared_initializer() {
        let _sandbox = sandbox();
        let conn = raw_connection().expect("open sandbox database");

        assert!(schema_object_exists(
            &conn,
            "table",
            "agent_org_run_progress"
        ));
        assert!(column_exists(
            &conn,
            "agent_org_run_progress",
            "work_revision"
        ));
        assert!(schema_object_exists(
            &conn,
            "table",
            "agent_org_recovery_attempts"
        ));
        assert!(column_exists(&conn, "agent_inbox", "causation_inbox_id"));
        assert!(schema_object_exists(
            &conn,
            "index",
            "idx_agent_inbox_causation_recipient_once"
        ));
    }
}
