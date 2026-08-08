//! Session History & Statistics Commands
//!
//! Query session history, group sessions, compute statistics, and
//! subagent/parent session queries.

use crate::agent_sessions::event_pipeline::history::{
    self, HistoryQuery, HistoryResult, SessionGroup, SessionRecord,
};
use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::statistics::{self, SessionStatistics};
use agent_core::session::persistence::{session_type, UnifiedSessionRecord};
use agent_core::session::SessionStatus;
use database::db::get_connection;
use serde::Serialize;

/// Query session history with filtering, sorting, and pagination.
#[tauri::command]
pub async fn es_query_session_history(
    sessions: Vec<SessionRecord>,
    query: HistoryQuery,
) -> Result<HistoryResult, String> {
    Ok(history::query_sessions(&sessions, &query))
}

/// Get the N most recently updated sessions.
#[tauri::command]
pub async fn es_get_recent_sessions(
    sessions: Vec<SessionRecord>,
    limit: usize,
) -> Result<Vec<SessionRecord>, String> {
    Ok(history::get_recent_sessions(&sessions, limit))
}

/// Group sessions by a field (status, type, repo, date).
#[tauri::command]
pub async fn es_group_sessions(
    sessions: Vec<SessionRecord>,
    group_by: String,
) -> Result<Vec<SessionGroup>, String> {
    Ok(history::group_sessions(&sessions, &group_by))
}

/// Compute aggregate statistics across session records.
#[tauri::command]
pub async fn es_compute_session_statistics(
    sessions: Vec<SessionRecord>,
) -> Result<SessionStatistics, String> {
    Ok(statistics::compute_session_statistics(&sessions))
}

// ============================================================================
// Subagent / Parent Session Queries
// ============================================================================

/// `UnifiedSessionRecord` + authoritative clip-window fields for the
/// subagent monitor. The frontend must NOT re-derive terminal-ness from
/// the raw `status` string — this is the single status→terminal
/// translation point (see `SessionStatus::is_terminal`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildSessionView {
    #[serde(flatten)]
    pub record: UnifiedSessionRecord,
    /// True when the session reached a terminal state (completed, failed,
    /// cancelled, abandoned, timeout, archived). Unknown status strings are
    /// reported as non-terminal; the frontend applies a zombie-row fuse.
    pub is_terminal: bool,
    /// Clip right edge: last event timestamp for terminal sessions
    /// (fallback `updated_at`), `None` while the session is still open.
    pub ended_at: Option<String>,
}

/// Compute the clip-window fields for a child session row.
///
/// `last_event_at` is the session's `MAX(events.created_at)` when known —
/// preferred over `updated_at` because any later metadata write (rename,
/// args patch) moves `updated_at` and would drift the clip's right edge.
fn clip_fields(
    status: &str,
    last_event_at: Option<String>,
    updated_at: &str,
) -> (bool, Option<String>) {
    let is_terminal = SessionStatus::parse(status)
        .map(|s| s.is_terminal())
        .unwrap_or(false);
    let ended_at = if is_terminal {
        Some(last_event_at.unwrap_or_else(|| updated_at.to_string()))
    } else {
        None
    };
    (is_terminal, ended_at)
}

/// Get all child sessions for a given parent session.
#[tauri::command]
pub async fn es_get_child_sessions(
    parent_session_id: String,
) -> Result<Vec<ChildSessionView>, String> {
    let mut records = agent_core::session::persistence::get_child_sessions(&parent_session_id)
        .map_err(|e| format!("Failed to get child sessions: {}", e))?;
    records.extend(cli_child_session_records(&parent_session_id)?);
    records.extend(imported_child_session_records(&parent_session_id)?);
    for imported_parent_session_id in
        session_providers::imported_parent_session_ids(&parent_session_id)?
    {
        records.extend(imported_child_session_records(&imported_parent_session_id)?);
    }

    let mut seen = std::collections::HashSet::new();
    records.retain(|record| seen.insert(record.session_id.clone()));

    Ok(records
        .into_iter()
        .map(|record| {
            let last_event_at = session_persistence::get_session_metadata(&record.session_id)
                .ok()
                .flatten()
                .and_then(|meta| meta.time_range_end);
            let (is_terminal, ended_at) =
                clip_fields(&record.status, last_event_at, &record.updated_at);
            ChildSessionView {
                record,
                is_terminal,
                ended_at,
            }
        })
        .collect())
}

fn cli_child_session_records(parent_session_id: &str) -> Result<Vec<UnifiedSessionRecord>, String> {
    let conn = get_connection().map_err(|err| format!("Failed to open CLI session DB: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT cs.session_id, cs.name, cs.status, cs.model, cs.user_input, cs.created_at, cs.updated_at, cs.repo_path, cs.branch, \
             COALESCE((SELECT total_tokens FROM orgtrack_core_session_usage WHERE session_id = cs.session_id), 0) AS total_tokens \
             FROM code_sessions cs \
             WHERE cs.parent_session_id = ?1 \
             ORDER BY cs.updated_at DESC, cs.created_at DESC, cs.session_id ASC",
        )
        .map_err(|err| format!("Failed to prepare CLI child session query: {err}"))?;
    let rows = stmt
        .query_map([parent_session_id], |row| {
            let session_id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let status: String = row.get(2)?;
            let model: Option<String> = row.get(3)?;
            let user_input: Option<String> = row.get(4)?;
            let created_at: String = row.get(5)?;
            let updated_at: String = row.get(6)?;
            let repo_path: Option<String> = row.get(7)?;
            let branch: Option<String> = row.get(8)?;
            let total_tokens: i64 = row.get::<_, Option<i64>>(9)?.unwrap_or_default();
            Ok(UnifiedSessionRecord {
                session_id,
                name,
                status,
                model,
                user_input,
                total_tokens,
                created_at,
                updated_at,
                session_type: session_type::SUBAGENT.to_string(),
                workspace_path: repo_path,
                worktree_branch: branch,
                parent_session_id: Some(parent_session_id.to_string()),
                ..Default::default()
            })
        })
        .map_err(|err| format!("Failed to query CLI child sessions: {err}"))?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row.map_err(|err| format!("Failed to read CLI child session row: {err}"))?);
    }
    Ok(records)
}

fn imported_child_session_records(
    parent_session_id: &str,
) -> Result<Vec<UnifiedSessionRecord>, String> {
    let conn =
        get_connection().map_err(|err| format!("Failed to open imported history DB: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id, name, created_at_ms, updated_at_ms, model, input_tokens, output_tokens, repo_path \
             FROM imported_history_session_cache \
             WHERE parent_session_id = ?1 \
             ORDER BY updated_at_ms DESC, created_at_ms DESC, source_session_id ASC",
        )
        .map_err(|err| format!("Failed to prepare imported child session query: {err}"))?;
    let rows = stmt
        .query_map([parent_session_id], |row| {
            let session_id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let created_at_ms: i64 = row.get(2)?;
            let updated_at_ms: i64 = row.get(3)?;
            let model: String = row.get(4)?;
            let input_tokens: i64 = row.get(5)?;
            let output_tokens: i64 = row.get(6)?;
            let repo_path: String = row.get(7)?;
            Ok(UnifiedSessionRecord {
                session_id,
                name,
                status: SessionStatus::Completed.as_str().to_string(),
                model: (!model.trim().is_empty()).then_some(model),
                total_tokens: input_tokens + output_tokens,
                created_at: imported_epoch_ms_to_iso(created_at_ms),
                updated_at: imported_epoch_ms_to_iso(updated_at_ms),
                session_type: session_type::SUBAGENT.to_string(),
                workspace_path: (!repo_path.trim().is_empty()).then_some(repo_path),
                parent_session_id: Some(parent_session_id.to_string()),
                ..Default::default()
            })
        })
        .map_err(|err| format!("Failed to query imported child sessions: {err}"))?;

    let mut records = Vec::new();
    for row in rows {
        records
            .push(row.map_err(|err| format!("Failed to read imported child session row: {err}"))?);
    }
    Ok(records)
}

fn imported_epoch_ms_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// Get the parent session for a given child session.
#[tauri::command]
pub async fn es_get_parent_session(
    session_id: String,
) -> Result<Option<UnifiedSessionRecord>, String> {
    agent_core::session::persistence::get_parent_session(&session_id)
        .map_err(|e| format!("Failed to get parent session: {}", e))
}

/// Debug-only: seed a child `agent_sessions` row for WDIO subagent-monitor
/// specs. Drives the production `upsert_session` with
/// `session_type=subagent`, so the row is shaped exactly like what the
/// `agent` tool persists — `es_get_child_sessions` then computes the same
/// authoritative `isTerminal`/`endedAt` clip fields the live path uses.
#[tauri::command]
pub async fn debug_seed_child_session(
    parent_session_id: String,
    session_id: String,
    name: String,
    status: String,
    created_at: String,
    updated_at: String,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_child_session is only available in debug builds".into());
    }
    let record = UnifiedSessionRecord {
        session_id,
        name,
        status,
        created_at,
        updated_at,
        session_type: agent_core::session::persistence::session_type::SUBAGENT.to_string(),
        parent_session_id: Some(parent_session_id),
        ..Default::default()
    };
    tokio::task::spawn_blocking(move || agent_core::session::persistence::upsert_session(&record))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Debug-only: seed one top-level coding session for rendered sidebar
/// pagination specs. The command uses the production upsert path; tests only
/// establish durable preconditions and still click the real rendered pager.
#[tauri::command]
pub async fn debug_seed_sidebar_coding_session(
    session_id: String,
    name: String,
    status: String,
    created_at: String,
    updated_at: String,
    pinned: Option<bool>,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_sidebar_coding_session is only available in debug builds".into());
    }
    let record = UnifiedSessionRecord {
        session_id,
        name,
        status,
        created_at,
        updated_at,
        session_type: agent_core::session::persistence::session_type::CODING.to_string(),
        pinned: pinned.unwrap_or(false),
        ..Default::default()
    };
    tokio::task::spawn_blocking(move || agent_core::session::persistence::upsert_session(&record))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::clip_fields;

    #[test]
    fn completed_row_closes_clip_at_last_event() {
        let (is_terminal, ended_at) = clip_fields(
            "completed",
            Some("2026-06-12T10:00:00Z".into()),
            "2026-06-12T11:30:00Z",
        );
        assert!(is_terminal);
        // last event wins over updated_at (metadata writes drift updated_at)
        assert_eq!(ended_at.as_deref(), Some("2026-06-12T10:00:00Z"));
    }

    #[test]
    fn cancelled_row_is_terminal() {
        // Regression: the old frontend mapStatus collapsed "cancelled" to
        // pending → clip never closed → cells accumulated forever.
        let (is_terminal, ended_at) = clip_fields("cancelled", None, "2026-06-12T11:30:00Z");
        assert!(is_terminal);
        assert_eq!(ended_at.as_deref(), Some("2026-06-12T11:30:00Z"));
    }

    #[test]
    fn failed_timeout_abandoned_archived_are_terminal() {
        for status in ["failed", "timeout", "abandoned", "archived"] {
            let (is_terminal, ended_at) = clip_fields(status, None, "2026-06-12T11:30:00Z");
            assert!(is_terminal, "{status} must be terminal");
            assert!(ended_at.is_some(), "{status} must close the clip");
        }
    }

    #[test]
    fn running_row_keeps_clip_open() {
        for status in ["running", "pending", "idle", "waiting_for_user", "paused"] {
            let (is_terminal, ended_at) = clip_fields(
                status,
                Some("2026-06-12T10:00:00Z".into()),
                "2026-06-12T11:30:00Z",
            );
            assert!(!is_terminal, "{status} must not be terminal");
            assert!(ended_at.is_none(), "{status} clip must stay open");
        }
    }

    #[test]
    fn unknown_status_is_non_terminal() {
        // Fail-open here; the frontend's zombie-row fuse closes stale rows.
        let (is_terminal, ended_at) = clip_fields("garbage", None, "2026-06-12T11:30:00Z");
        assert!(!is_terminal);
        assert!(ended_at.is_none());
    }
}
