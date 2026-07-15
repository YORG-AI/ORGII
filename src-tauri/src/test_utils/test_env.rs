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

/// Best-effort DB schema prime for the current `ORGII_HOME`.
///
/// The real `database::db::get_connection()` uses a global
/// `Once::call_once` guard (intended for production where the schema is
/// only ever initialized once). In tests where every sandbox points
/// `sessions.db` at a fresh tempdir, that `Once` never fires on the new
/// file. `prime_schema()` runs the module init functions directly on a
/// one-off connection so each sandbox has a freshly migrated DB
/// regardless of what happened before.
///
/// All errors are swallowed — a test that doesn't touch the DB (e.g.
/// pure env-var tests) should not pay for its init.
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
    let _ = agent_core::coordination::agent_org_runs::init_schema(&conn);
    let _ = agent_core::coordination::agent_inbox::init_schema(&conn);
    let _ = agent_core::coordination::agent_org_tasks::init_schema(&conn);
    let _ = agent_core::coordination::agent_org_plan_approvals::init_schema(&conn);
    let _ = agent_core::coordination::agent_member_interventions::init_schema(&conn);
}

fn raw_connection() -> rusqlite::Result<Connection> {
    let db_path = database::db::get_db_path();
    Connection::open(db_path)
}
