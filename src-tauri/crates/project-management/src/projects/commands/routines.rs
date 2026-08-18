//! Routine commands: definitions, fire history, and materialization.

use super::super::io;
use super::super::types::{RoutineDefinition, RoutineFire};

#[tauri::command]
pub async fn project_list_routines() -> Result<Vec<RoutineDefinition>, String> {
    tokio::task::spawn_blocking(io::list_routines)
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_read_routine(id: String) -> Result<RoutineDefinition, String> {
    tokio::task::spawn_blocking(move || io::read_routine(&id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_upsert_routine(
    routine: RoutineDefinition,
) -> Result<RoutineDefinition, String> {
    tokio::task::spawn_blocking(move || io::upsert_routine(routine))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_delete_routine(id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || io::delete_routine(&id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_list_routine_fires(routine_id: String) -> Result<Vec<RoutineFire>, String> {
    tokio::task::spawn_blocking(move || io::list_routine_fires(&routine_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// List portable routines (`pm_routines`) by name. Backs the Webhooks
/// management surface; per-routine webhook state comes from
/// [`project_routine_webhook_status`].
#[tauri::command]
pub async fn project_list_portable_routines() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(crate::routine_service::list_routines)
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// List portable routine runs (`pm_routine_runs`), newest first. Backs
/// the Runs navigation surface; per-run detail comes from
/// [`project_routine_run_status`].
#[tauri::command]
pub async fn project_list_routine_runs(
    scope_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        crate::routine_service::list_runs(scope_id.as_deref(), limit.unwrap_or(100))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Durable run-status projection for one routine run: the run row plus
/// each generated WorkItem's portable state (orgtrack/v1 §11 ordered
/// decision procedure).
#[tauri::command]
pub async fn project_routine_run_status(run_id: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || crate::routine_service::run_status(&run_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}
