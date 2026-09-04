//! Session model config and catalog RPC adapters for Mobile Remote.

use serde_json::{json, Value};
use std::collections::HashSet;

use crate::agent_sessions::cli::persistence as cli_persistence;
use crate::agent_sessions::session_directory::patch::{apply_session_patch, SessionPatch};
use agent_core::session::persistence as session_persistence;
use key_vault::key_store::{HealthStatus, ModelKey, ModelType, KEY_SERVICE};

use super::session::mobile_session_execution;
use super::session::MobileSessionExecution;
use crate::api::mobile_bridge::rpc::{RpcError, RpcErrorCode};

const MAX_MOBILE_MODEL_OPTIONS: usize = 256;

#[derive(Debug, Clone)]
struct MobileSessionModelState {
    model: Option<String>,
    account_id: Option<String>,
    key_source: String,
    cli_agent_type: Option<String>,
    model_editable: bool,
}

#[derive(Debug, Clone)]
struct MobileModelOption {
    id: String,
    account_id: String,
    account_label: String,
}

fn parse_session_id(params: &Value) -> Result<String, RpcError> {
    params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))
}

fn load_session_model_state(session_id: &str) -> Result<MobileSessionModelState, RpcError> {
    match mobile_session_execution(session_id) {
        MobileSessionExecution::ImportedHistory => Ok(MobileSessionModelState {
            model: None,
            account_id: None,
            key_source: "own_key".to_string(),
            cli_agent_type: None,
            model_editable: false,
        }),
        MobileSessionExecution::ManagedCli => {
            let session = cli_persistence::get_session(session_id)
                .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err.to_string()))?
                .ok_or_else(|| {
                    RpcError::new(
                        RpcErrorCode::SessionNotFound,
                        format!("session not found: {session_id}"),
                    )
                })?;
            Ok(MobileSessionModelState {
                model: session.model,
                account_id: session.account_id,
                key_source: session.key_source.as_ref().to_string(),
                cli_agent_type: session.cli_agent_type,
                model_editable: true,
            })
        }
        MobileSessionExecution::NativeAgent => {
            let session = session_persistence::get_session(session_id)
                .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err.to_string()))?
                .ok_or_else(|| {
                    RpcError::new(
                        RpcErrorCode::SessionNotFound,
                        format!("session not found: {session_id}"),
                    )
                })?;
            Ok(MobileSessionModelState {
                model: session.model,
                account_id: session.account_id,
                key_source: session.key_source.as_ref().to_string(),
                cli_agent_type: session.native_harness_type,
                model_editable: true,
            })
        }
    }
}

fn key_is_usable(entry: &ModelKey) -> bool {
    if !entry.enabled {
        return false;
    }
    matches!(
        entry.health_status,
        HealthStatus::Valid | HealthStatus::Degraded | HealthStatus::Unknown
    )
}

fn has_api_key(entry: &ModelKey) -> bool {
    match entry.model_type {
        ModelType::CursorCli => entry.api_key.as_deref().is_some_and(|api_key| {
            let trimmed = api_key.trim();
            trimmed.len() >= 20 && (trimmed.starts_with("key_") || trimmed.starts_with("crsr_"))
        }),
        _ => entry
            .api_key
            .as_deref()
            .is_some_and(|secret| !secret.trim().is_empty()),
    }
}

fn has_session_token(entry: &ModelKey) -> bool {
    entry
        .session_token
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty())
}

fn supports_rust_agents(entry: &ModelKey) -> bool {
    let has_api_key = has_api_key(entry);
    let has_session_token = has_session_token(entry);
    let can_use_native_harness =
        matches!(entry.model_type, ModelType::CursorCli) && has_session_token;
    if can_use_native_harness {
        return true;
    }
    let has_usable_key_material = has_api_key || has_session_token;
    match entry.model_type {
        ModelType::CursorCli | ModelType::OrgiiOrchestrator => false,
        ModelType::ClaudeCode
        | ModelType::Codex
        | ModelType::Copilot
        | ModelType::Kiro
        | ModelType::KimiCli
        | ModelType::OpenCode => has_usable_key_material,
        _ => has_api_key,
    }
}

fn models_for_key(entry: &ModelKey) -> Vec<String> {
    if !entry.enabled_models.is_empty() {
        return entry.enabled_models.clone();
    }
    if !entry.available_models.is_empty() {
        return entry.available_models.clone();
    }
    Vec::new()
}

fn account_label_for(entry: &ModelKey) -> String {
    entry
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| entry.model_type.as_str().to_string())
}

fn collect_model_options_for_session(
    session_id: &str,
    state: &MobileSessionModelState,
) -> Result<Vec<MobileModelOption>, RpcError> {
    let keys = KEY_SERVICE
        .list_keys_checked()
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;

    let mut options = Vec::new();
    let mut seen = HashSet::new();
    let execution = mobile_session_execution(session_id);

    for entry in keys.iter().filter(|entry| key_is_usable(entry)) {
        let include = match execution {
            MobileSessionExecution::ManagedCli => state
                .cli_agent_type
                .as_deref()
                .and_then(ModelType::from_str)
                .is_some_and(|agent| agent == entry.model_type),
            MobileSessionExecution::NativeAgent => supports_rust_agents(entry),
            MobileSessionExecution::ImportedHistory => false,
        };
        if !include {
            continue;
        }

        let account_label = account_label_for(entry);
        for model_id in models_for_key(entry) {
            let dedupe_key = format!("{}::{}", entry.id, model_id);
            if !seen.insert(dedupe_key) {
                continue;
            }
            options.push(MobileModelOption {
                id: model_id,
                account_id: entry.id.clone(),
                account_label: account_label.clone(),
            });
            if options.len() >= MAX_MOBILE_MODEL_OPTIONS {
                break;
            }
        }
        if options.len() >= MAX_MOBILE_MODEL_OPTIONS {
            break;
        }
    }

    if let Some(current_model) = state.model.as_deref() {
        let current_account = state.account_id.as_deref().unwrap_or("");
        let dedupe_key = format!("{current_account}::{current_model}");
        if seen.insert(dedupe_key) {
            let account_label = keys
                .iter()
                .find(|entry| entry.id == current_account)
                .map(account_label_for)
                .unwrap_or_else(|| "Current".to_string());
            options.insert(
                0,
                MobileModelOption {
                    id: current_model.to_string(),
                    account_id: current_account.to_string(),
                    account_label,
                },
            );
        }
    }

    Ok(options)
}

/// Return the session's current model configuration for the mobile picker.
pub async fn session_config(params: &Value) -> Result<Value, RpcError> {
    let session_id = parse_session_id(params)?;
    let state = load_session_model_state(&session_id)?;

    Ok(json!({
        "sessionId": session_id,
        "model": state.model,
        "accountId": state.account_id,
        "keySource": state.key_source,
        "cliAgentType": state.cli_agent_type,
        "modelEditable": state.model_editable,
    }))
}

/// Apply a model patch from mobile (mirrors desktop `session_patch`).
pub async fn session_patch(params: &Value) -> Result<Value, RpcError> {
    let session_id = parse_session_id(params)?;
    let patch_value = params
        .get("patch")
        .ok_or_else(|| RpcError::invalid_params("patch is required"))?;

    let model = patch_value
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params("patch.model is required"))?;

    let account_id = patch_value
        .get("accountId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let state = load_session_model_state(&session_id)?;
    if !state.model_editable {
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "session model cannot be changed from mobile",
        ));
    }

    apply_session_patch(
        &session_id,
        &SessionPatch {
            model: Some(model.clone()),
            account_id,
            ..Default::default()
        },
    )
    .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;

    Ok(json!({
        "sessionId": session_id,
        "model": model,
    }))
}

/// List selectable models for a session, sourced from the desktop KeyVault.
pub async fn models_list(params: &Value) -> Result<Value, RpcError> {
    let session_id = parse_session_id(params)?;
    let state = load_session_model_state(&session_id)?;
    if !state.model_editable {
        return Ok(json!({ "models": [] }));
    }

    let options = collect_model_options_for_session(&session_id, &state)?;
    let models = options
        .into_iter()
        .map(|option| {
            json!({
                "id": option.id,
                "accountId": option.account_id,
                "accountLabel": option.account_label,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "models": models }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_session_id_rejects_empty() {
        let err = parse_session_id(&json!({ "sessionId": "  " })).unwrap_err();
        assert_eq!(err.code, RpcErrorCode::InvalidParams);
    }

    #[test]
    fn supports_rust_agents_allows_byok_api_keys() {
        let mut entry = ModelKey::new(ModelType::AnthropicApi);
        entry.api_key = Some("sk-ant-test-key-1234567890".to_string());
        assert!(supports_rust_agents(&entry));
    }

    #[test]
    fn models_for_key_prefers_enabled_models() {
        let mut entry = ModelKey::new(ModelType::AnthropicApi);
        entry.enabled_models = vec!["claude-sonnet-4-5".to_string()];
        entry.available_models = vec!["claude-opus-4-5".to_string()];
        assert_eq!(
            models_for_key(&entry),
            vec!["claude-sonnet-4-5".to_string()]
        );
    }
}
