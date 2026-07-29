//! Lineage Module — Chat Session Impact Graph
//!
//! Tracks which files, functions, and commits were influenced by an AI chat
//! session. Two-phase design:
//!
//! 1. **Provenance** (write-time): when an AI session edits a file, AST nodes
//!    in the edited range are extracted via tree-sitter and stored with the
//!    session ID in `node_provenance`.
//!
//! 2. **Commit tracking** (commit-time): when a git commit is created, its
//!    diff hunks are matched against provenance entries by line-range overlap,
//!    and matches are recorded in `commit_lineage`.
//!
//! 3. **Analytics**: `get_session_impact()` queries both tables to produce a
//!    summary of files touched, functions created, and commits influenced.

pub mod analytics;
pub mod commit_tracker;
pub mod event_hook;
pub mod git_bridge;
pub mod hashing;
pub mod provenance;
pub mod schema;

use database::db::get_connection;
use rusqlite::{Connection, Result as SqliteResult};

/// Drop every lineage row tied to `session_id`.
///
/// `commit_lineage` is keyed by `provenance_id`, not `session_id`, so the
/// generic per-session cascade in `delete_session_cascade` cannot reach it.
/// This helper deletes `commit_lineage` rows whose backing provenance belongs
/// to the session first, then removes the `node_provenance` rows themselves.
/// Called from session deletion so we don't leak per-session AST or commit
/// rows after the owning session is gone.
pub fn delete_session_lineage(session_id: &str) -> SqliteResult<()> {
    let conn = get_connection()?;
    delete_session_lineage_with_connection(&conn, session_id)
}

/// Transaction-aware form of [`delete_session_lineage`].
///
/// Agent Org hierarchy deletion uses this to keep lineage removal inside the
/// same SQLite transaction as the owning Rust sessions and run state.
pub fn delete_session_lineage_with_connection(
    conn: &Connection,
    session_id: &str,
) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM commit_lineage
         WHERE provenance_id IN (
             SELECT id FROM node_provenance WHERE session_id = ?1
         )",
        [session_id],
    )?;
    conn.execute(
        "DELETE FROM node_provenance WHERE session_id = ?1",
        [session_id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_session_impact(session_id: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        analytics::get_session_impact(&session_id)
            .map(|impact| serde_json::to_value(impact).unwrap_or_default())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn get_provenance_session_ids() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(analytics::get_provenance_session_ids)
        .await
        .map_err(|err| err.to_string())?
}
