use std::collections::HashMap;

use super::save::filter_dated_models;
use super::{key_info_from_entry, FullKeyResponse, KeyInfo};
use crate::commands::validate::invalidate_key_quota_runtime;
use crate::key_store::{HealthStatus, ModelType, KEY_SERVICE};

/// List all stored keys (masked)
#[tauri::command]
pub async fn list_keys() -> Result<Vec<KeyInfo>, String> {
    tokio::task::spawn_blocking(|| {
        KEY_SERVICE
            .list_keys_checked()?
            .into_iter()
            .map(key_info_from_entry)
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get key by agent type (masked)
#[tauri::command]
pub async fn get_key(
    agent_type: String,
    key_id: Option<String>,
) -> Result<Option<KeyInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let agent = ModelType::from_str(&agent_type)
            .ok_or_else(|| format!("Unknown agent_type: {agent_type:?}"))?;
        KEY_SERVICE
            .get_key_checked(&agent, key_id.as_deref())?
            .map(key_info_from_entry)
            .transpose()
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get key by ID only (masked)
#[tauri::command]
pub async fn get_key_by_id(key_id: String) -> Result<Option<KeyInfo>, String> {
    tokio::task::spawn_blocking(move || {
        KEY_SERVICE
            .get_key_by_id_checked(&key_id)?
            .map(key_info_from_entry)
            .transpose()
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get full key (unmasked) - for internal use like market listing
#[tauri::command]
pub async fn get_full_key(
    agent_type: String,
    key_id: Option<String>,
) -> Result<Option<FullKeyResponse>, String> {
    tokio::task::spawn_blocking(move || {
        let agent = ModelType::from_str(&agent_type)
            .ok_or_else(|| format!("Unknown agent_type: {agent_type:?}"))?;
        Ok(KEY_SERVICE
            .get_key_checked(&agent, key_id.as_deref())?
            .map(FullKeyResponse::from))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Delete a key by agent type and optional ID
#[tauri::command]
pub async fn delete_key(agent_type: String, key_id: Option<String>) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let agent = ModelType::from_str(&agent_type).ok_or("Unknown agent type".to_string())?;
        let deleted_id = KEY_SERVICE
            .get_key_checked(&agent, key_id.as_deref())?
            .map(|key| key.id);
        let deleted = KEY_SERVICE.delete_key(&agent, key_id.as_deref())?;
        if deleted {
            if let Some(deleted_id) = deleted_id {
                invalidate_key_quota_runtime(&deleted_id);
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Delete a key by ID only
#[tauri::command]
pub async fn delete_key_by_id(key_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let deleted = KEY_SERVICE.delete_key_by_id(&key_id)?;
        if deleted {
            invalidate_key_quota_runtime(&key_id);
        }
        Ok(deleted)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Update key health status after validation
#[tauri::command]
pub async fn update_key_health(
    key_id: String,
    health_status: String,
    error_message: Option<String>,
    available_models: Option<Vec<String>>,
    enabled_models: Option<Vec<String>>,
    quota_info: Option<serde_json::Value>,
    model_context_lengths: Option<HashMap<String, u64>>,
) -> Result<Option<KeyInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let status = match health_status.as_str() {
            "valid" => HealthStatus::Valid,
            "degraded" => HealthStatus::Degraded,
            "invalid" => HealthStatus::Invalid,
            _ => HealthStatus::Unknown,
        };

        // Filter out dated snapshot models from enabled_models
        let filtered_enabled = enabled_models.map(filter_dated_models);

        KEY_SERVICE
            .update_key_health(
                &key_id,
                status,
                error_message,
                available_models,
                filtered_enabled,
                quota_info,
                model_context_lengths.as_ref(),
            )
            .and_then(|opt| opt.map(key_info_from_entry).transpose())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get environment variables for running an agent
#[tauri::command]
pub async fn get_env_for_agent(
    agent_type: String,
    key_id: Option<String>,
) -> Result<HashMap<String, String>, String> {
    tokio::task::spawn_blocking(move || {
        let agent = ModelType::from_str(&agent_type)
            .ok_or_else(|| format!("Unknown agent_type: {agent_type:?}"))?;
        Ok(KEY_SERVICE.get_env_for_agent(&agent, key_id.as_deref()))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get all keys for an agent type (masked)
#[tauri::command]
pub async fn get_all_keys_for_agent(agent_type: String) -> Result<Vec<KeyInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let agent = ModelType::from_str(&agent_type)
            .ok_or_else(|| format!("Unknown agent_type: {agent_type:?}"))?;
        KEY_SERVICE
            .get_all_keys_for_agent(&agent)
            .into_iter()
            .map(key_info_from_entry)
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}
