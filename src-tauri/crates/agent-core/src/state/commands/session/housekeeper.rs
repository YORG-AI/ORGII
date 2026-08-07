use crate::session::housekeeper_compaction::{self, HousekeeperContextCompactionState};
use crate::state::AgentAppState;

#[tauri::command]
pub async fn housekeeper_context_compaction_status(
    session_id: String,
) -> Result<HousekeeperContextCompactionState, String> {
    tokio::task::spawn_blocking(move || housekeeper_compaction::status(&session_id))
        .await
        .map_err(|err| format!("MiniCPM status task failed: {err}"))?
}

#[tauri::command]
pub async fn housekeeper_context_compaction_set_enabled(
    session_id: String,
    enabled: bool,
) -> Result<HousekeeperContextCompactionState, String> {
    tokio::task::spawn_blocking(move || housekeeper_compaction::set_enabled(&session_id, enabled))
        .await
        .map_err(|err| format!("MiniCPM setting task failed: {err}"))?
}

#[tauri::command]
pub async fn housekeeper_context_compact_now(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<HousekeeperContextCompactionState, String> {
    Ok(housekeeper_compaction::compact_now(state.inner(), session_id).await)
}
