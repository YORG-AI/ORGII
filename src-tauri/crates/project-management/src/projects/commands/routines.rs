//! Routine commands: definitions, fire history, and materialization.

use super::super::io;
use super::super::types::{RoutineDefinition, RoutineFire, RoutineFireResult};

#[tauri::command]
pub async fn project_list_routines() -> Result<Vec<RoutineDefinition>, String> {
    tokio::task::spawn_blocking(|| {
        io::list_routines()?
            .into_iter()
            .map(crate::routine_service::legacy_bridge::overlay_definition)
            .collect()
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_read_routine(id: String) -> Result<RoutineDefinition, String> {
    tokio::task::spawn_blocking(move || {
        crate::routine_service::legacy_bridge::overlay_definition(io::read_routine(&id)?)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_upsert_routine(
    routine: RoutineDefinition,
) -> Result<RoutineDefinition, String> {
    tokio::task::spawn_blocking(move || {
        let saved = crate::routine_service::legacy_bridge::upsert_definition(routine)?;
        crate::routine_service::legacy_bridge::overlay_definition(io::read_routine(&saved.id)?)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_delete_routine(id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        crate::routine_service::legacy_bridge::delete_definition(&id)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_list_routine_fires(routine_id: String) -> Result<Vec<RoutineFire>, String> {
    tokio::task::spawn_blocking(move || {
        crate::routine_service::legacy_bridge::list_fires(&routine_id)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Fire Now uses the same portable graph invocation and concurrency boundary
/// as schedule/webhook/CLI execution while retaining the legacy UI response.
#[tauri::command]
pub async fn project_fire_routine(routine_id: String) -> Result<RoutineFireResult, String> {
    tokio::task::spawn_blocking(move || crate::routine_service::legacy_bridge::fire(&routine_id))
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

/// Idempotently terminate a portable RoutineRun. This is a durable control
/// command and works even when the frontend that started the run is gone.
#[tauri::command]
pub async fn project_cancel_routine_run(
    run_id: String,
) -> Result<crate::routine_service::CancelledRoutineRun, String> {
    tokio::task::spawn_blocking(move || crate::routine_service::cancel_run(&run_id, None))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}
