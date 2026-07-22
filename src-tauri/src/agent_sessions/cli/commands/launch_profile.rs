//! CLI launch profile Tauri commands — get/update/reset per-agent overrides.

use super::super::launch_profile_store;
use super::super::session_runner::launch_profiles::{
    CliLaunchProfileUpdate, CliLaunchProfileView, CliPermissionMode,
};
use std::collections::HashMap;

#[tauri::command]
pub async fn cli_launch_profile_get(agent_name: String) -> Result<CliLaunchProfileView, String> {
    tokio::task::spawn_blocking(move || launch_profile_store::cli_launch_profile_get(agent_name))
        .await
        .map_err(|err| format!("Task error: {err}"))?
}

#[tauri::command]
pub async fn cli_launch_profile_update(
    agent_name: String,
    permission_mode: CliPermissionMode,
    command_override: Option<String>,
    args_override: Option<Vec<String>>,
    env_override: Option<HashMap<String, String>>,
) -> Result<CliLaunchProfileView, String> {
    tokio::task::spawn_blocking(move || {
        launch_profile_store::cli_launch_profile_update(CliLaunchProfileUpdate {
            agent_name,
            permission_mode,
            command_override,
            args_override,
            env_override,
            // Experimental app-server transport opt-in is not exposed in the
            // settings UI; `None` preserves whatever the store already holds.
            transport: None,
        })
    })
    .await
    .map_err(|err| format!("Task error: {err}"))?
}

#[tauri::command]
pub async fn cli_launch_profile_reset(agent_name: String) -> Result<CliLaunchProfileView, String> {
    tokio::task::spawn_blocking(move || launch_profile_store::cli_launch_profile_reset(agent_name))
        .await
        .map_err(|err| format!("Task error: {err}"))?
}
