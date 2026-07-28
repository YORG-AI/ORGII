//! Read-only status/history queries plus cancellation — `cli_agent_status`,
//! `cli_agent_history_mutation`, `cli_agent_cancel`, `cli_agent_list`.

use super::super::persistence::{self, CliHistoryMutation, CodeSession};
use super::super::session_runner;
use agent_core::state::control_flow::CancelReason;

/// Get session status.
#[tauri::command]
pub async fn cli_agent_status(session_id: String) -> Result<Option<CodeSession>, String> {
    tokio::task::spawn_blocking(move || {
        persistence::get_session(&session_id).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Get the last ORGII-side history mutation that invalidated native CLI resume state.
#[tauri::command]
pub async fn cli_agent_history_mutation(
    session_id: String,
) -> Result<Option<CliHistoryMutation>, String> {
    tokio::task::spawn_blocking(move || {
        persistence::get_history_mutation(&session_id).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Cancel a running session.
#[tauri::command]
pub async fn cli_agent_cancel(
    session_id: String,
    reason: Option<CancelReason>,
) -> Result<bool, String> {
    session_runner::cancel_session(&session_id, reason.unwrap_or_default()).await
}

/// List all code sessions.
#[tauri::command]
pub async fn cli_agent_list() -> Result<Vec<CodeSession>, String> {
    tokio::task::spawn_blocking(|| {
        persistence::list_sessions().map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
