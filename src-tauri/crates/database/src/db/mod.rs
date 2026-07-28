//! Database Connection Pools
//!
//! Two physical SQLite files share this module:
//!
//! - `~/.orgii/sessions.db` — the broad shared DB used by:
//!   - Session events & metadata (`session::cache`)
//!   - Unified agent sessions (`agent_core::session::persistence`)
//!   - SDE Agent snapshots/todos/files (`agent_core::sde_agent::persistence`)
//!   - CLI agent sessions & chunks (`cli_session`)
//!   - Repository tracking (`git::repos::repo_db`)
//!   - Orgtrack sessions and source history caches (`orgtrack_core`)
//!   - Lineage tracking (`lineage`)
//!   - Orchestrator runtime state (`project_management::orchestrator`)
//!   - Inbox messages (`inbox`)
//!
//!   Entry point: [`get_connection`].
//!
//! - `~/.orgii/projects/projects.db` — the centralized project store:
//!   projects, work items, labels, milestones, members. Kept separate so
//!   cross-device sync (Linear / GitHub / ORGII Cloud) and manual
//!   export/import operate on a self-contained file.
//!   Entry point: [`get_projects_connection`].
//!
//! ## Features
//! - SQLite with WAL mode for concurrent reads
//! - Automatic schema initialization on first connection (per physical path)
//! - Per-connection PRAGMA optimization
//!
//! ## Usage
//! ```ignore
//! use database::db::{get_connection, get_projects_connection};
//!
//! let conn = get_connection()?;            // sessions.db
//! conn.execute("SELECT ...", [])?;
//!
//! let proj = get_projects_connection()?;   // projects.db
//! proj.execute("SELECT * FROM projects", [])?;
//! ```

mod connection;
mod shell_replay_schema;
mod writer;

pub use connection::{
    configure_connection, get_connection, get_db_path, get_projects_connection,
    register_projects_init, register_sessions_init,
};
pub use shell_replay_schema::init_shell_replay_tables;
pub use writer::{
    begin_immediate, sessions_writer_guard, with_sessions_writer, SessionsWriterGuard,
};
