use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use regex::Regex;

use crate::key_store::{
    AuthMethod, DefaultVariant, HealthStatus, ModelKey, ModelType, ModelVariant, ProviderProtocol,
    KEY_SERVICE,
};

const CURSOR_NATIVE_FALLBACK_MODELS: &[&str] = &["composer-2"];

/// Filter out model IDs containing dated snapshot suffixes (YYYY-MM-DD pattern).
/// These are point-in-time snapshots that shouldn't be persisted as enabled.
fn filter_dated_models(models: Vec<String>) -> Vec<String> {
    let date_pattern = Regex::new(r"\b\d{4}-\d{2}-\d{2}\b").unwrap();
    models
        .into_iter()
        .filter(|m| !date_pattern.is_match(m))
        .collect()
}

/// Serializable model alias for API responses
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ModelAliasInfo {
    #[serde(default)]
    pub display_name: String,
    pub alias: String,
    pub icon: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ModelVariantInfo {
    pub model: String,
    pub base_model: String,
    pub reasoning: Option<String>,
    pub fast: bool,
}

/// Serializable per-base-model default variant for API responses
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DefaultVariantInfo {
    pub base_model: String,
    pub model: String,
}

/// Response for key info (sensitive data masked)
#[derive(serde::Serialize)]
pub struct KeyInfo {
    pub id: String,
    pub name: Option<String>,
    pub agent_type: String,
    pub has_api_key: bool,
    pub has_session_token: bool,
    pub has_base_url: bool,
    pub api_key_preview: Option<String>,
    pub session_token_preview: Option<String>,
    pub base_url: Option<String>,
    pub protocol: Option<String>,
    pub env_vars: Vec<String>,
    pub env_vars_masked: HashMap<String, String>,
    pub available_models: Vec<String>,
    pub enabled_models: Vec<String>,
    pub model_aliases: Vec<ModelAliasInfo>,
    pub model_variants: Vec<ModelVariantInfo>,
    pub default_variants: Vec<DefaultVariantInfo>,
    pub quota_info: Option<serde_json::Value>,
    pub description: Option<String>,
    pub has_local_key: bool,
    pub is_listed: bool,
    pub auth_method: String,
    pub listing_id: Option<String>,
    pub health_status: String,
    pub last_validation_error: Option<String>,
    pub last_validated_at: Option<String>,
    pub oauth_refresh_failure_count: u32,
    pub last_oauth_refresh_failed_at: Option<String>,
    pub temporary_unavailable_until: Option<String>,
    pub temporary_unavailable_reason: Option<String>,
    pub last_upstream_status: Option<u16>,
    pub last_upstream_error_type: Option<String>,
    pub rate_limit_reset_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub enabled: bool,
    pub supports_rust_agents: bool,
    pub can_launch_cli: bool,
    pub can_use_native_harness: bool,
    pub native_harness_type: Option<String>,
}

fn native_harness_type_for_model(
    model_type: &ModelType,
    has_session_token: bool,
) -> Option<String> {
    match model_type {
        ModelType::CursorCli if has_session_token => {
            Some(core_types::providers::CURSOR_NATIVE_HARNESS_TYPE.to_string())
        }
        _ => None,
    }
}

fn has_non_empty_secret(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|secret| !secret.trim().is_empty())
}

fn has_cursor_api_key(entry: &ModelKey) -> bool {
    entry.api_key.as_deref().is_some_and(|api_key| {
        let trimmed = api_key.trim();
        trimmed.len() >= 20 && (trimmed.starts_with("key_") || trimmed.starts_with("crsr_"))
    })
}

fn has_api_key(entry: &ModelKey) -> bool {
    match entry.model_type {
        ModelType::CursorCli => has_cursor_api_key(entry),
        _ => has_non_empty_secret(&entry.api_key),
    }
}

fn can_launch_cli(entry: &ModelKey) -> bool {
    match entry.model_type {
        ModelType::CursorCli => has_cursor_api_key(entry),
        ModelType::ClaudeCode
        | ModelType::Codex
        | ModelType::GeminiCli
        | ModelType::Copilot
        | ModelType::Kiro
        | ModelType::KimiCli
        | ModelType::OpenCode => true,
        _ => false,
    }
}

fn supports_rust_agents(
    entry: &ModelKey,
    has_api_key: bool,
    has_session_token: bool,
    can_use_native_harness: bool,
) -> bool {
    if can_use_native_harness {
        return true;
    }

    let has_usable_key_material = has_api_key || has_session_token;
    match entry.model_type {
        ModelType::CursorCli | ModelType::OrgiiOrchestrator => false,
        ModelType::ClaudeCode
        | ModelType::Codex
        | ModelType::GeminiCli
        | ModelType::Copilot
        | ModelType::Kiro
        | ModelType::KimiCli
        | ModelType::OpenCode => has_usable_key_material,
        _ => has_api_key,
    }
}

fn cursor_native_model_ids() -> Result<Vec<String>, String> {
    let models = cursor_bridge_app::vscdb_models::read_models_from_disk()?;
    Ok(models.into_iter().map(|model| model.name).collect())
}

fn merge_unique_models(target: &mut Vec<String>, models: impl IntoIterator<Item = String>) {
    for model in models {
        if !target.contains(&model) {
            target.push(model);
        }
    }
}

fn enrich_cursor_native_models(info: &mut KeyInfo) -> Result<(), String> {
    if info.agent_type != ModelType::CursorCli.as_str() || !info.has_session_token {
        return Ok(());
    }

    if info.available_models.is_empty() {
        merge_unique_models(
            &mut info.available_models,
            CURSOR_NATIVE_FALLBACK_MODELS
                .iter()
                .map(|model| model.to_string()),
        );
    }

    if let Ok(models) = cursor_native_model_ids() {
        merge_unique_models(&mut info.available_models, models);
    }

    if info.enabled_models.is_empty() {
        for model in CURSOR_NATIVE_FALLBACK_MODELS {
            if info
                .available_models
                .iter()
                .any(|available| available == model)
            {
                info.enabled_models.push(model.to_string());
            }
        }
    }

    Ok(())
}

fn key_info_from_entry(entry: ModelKey) -> Result<KeyInfo, String> {
    let mut info = KeyInfo::from(entry);
    enrich_cursor_native_models(&mut info)?;
    Ok(info)
}

fn is_cursor_web_session_token(token: &str) -> bool {
    let jwt = token.split("%3A%3A").nth(1).unwrap_or(token);
    let payload = match jwt.split('.').nth(1) {
        Some(payload) => payload,
        None => return false,
    };
    let decoded = match URL_SAFE_NO_PAD.decode(payload) {
        Ok(decoded) => decoded,
        Err(_) => return false,
    };
    let value = match serde_json::from_slice::<serde_json::Value>(&decoded) {
        Ok(value) => value,
        Err(_) => return false,
    };

    value.get("type").and_then(|value| value.as_str()) == Some("web")
}

impl From<ModelKey> for KeyInfo {
    fn from(entry: ModelKey) -> Self {
        let env_vars_masked: HashMap<String, String> = entry
            .env_vars
            .iter()
            .map(|(k, v)| {
                let masked = if v.len() <= 8 {
                    "*".repeat(v.len())
                } else {
                    format!("{}...{}", &v[..4], &v[v.len() - 4..])
                };
                (k.clone(), masked)
            })
            .collect();

        let has_session_token = has_non_empty_secret(&entry.session_token);
        let has_api_key = has_api_key(&entry);
        let native_harness_type =
            native_harness_type_for_model(&entry.model_type, has_session_token);
        let can_use_native_harness = native_harness_type.is_some();
        let supports_rust_agents = supports_rust_agents(
            &entry,
            has_api_key,
            has_session_token,
            can_use_native_harness,
        );
        let can_launch_cli = can_launch_cli(&entry);

        KeyInfo {
            id: entry.id.clone(),
            name: entry.name.clone(),
            description: entry.description.clone(),
            agent_type: entry.model_type.as_str().to_string(),
            has_api_key,
            has_session_token,
            has_base_url: entry.base_url.is_some(),
            api_key_preview: entry.mask_api_key(),
            session_token_preview: entry.mask_session_token(),
            base_url: entry.base_url.clone(),
            protocol: entry.protocol.map(|protocol| protocol.as_str().to_string()),
            env_vars: entry.env_vars.keys().cloned().collect(),
            env_vars_masked,
            available_models: entry.available_models.clone(),
            enabled_models: entry.enabled_models.clone(),
            model_aliases: entry
                .model_aliases
                .iter()
                .map(|a| ModelAliasInfo {
                    display_name: a.display_name.clone(),
                    alias: a.alias.clone(),
                    icon: a.icon.clone(),
                })
                .collect(),
            model_variants: entry
                .model_variants
                .iter()
                .map(|variant| ModelVariantInfo {
                    model: variant.model.clone(),
                    base_model: variant.base_model.clone(),
                    reasoning: variant.reasoning.clone(),
                    fast: variant.fast,
                })
                .collect(),
            default_variants: entry
                .default_variants
                .iter()
                .map(|variant| DefaultVariantInfo {
                    base_model: variant.base_model.clone(),
                    model: variant.model.clone(),
                })
                .collect(),
            quota_info: entry.quota_info.clone(),
            has_local_key: entry.has_local_key,
            is_listed: entry.is_listed,
            auth_method: match entry.auth_method {
                AuthMethod::ApiKey => "api_key",
                AuthMethod::Oauth => "oauth",
            }
            .to_string(),
            listing_id: entry.listing_id.clone(),
            health_status: match entry.health_status {
                HealthStatus::Valid => "valid",
                HealthStatus::Degraded => "degraded",
                HealthStatus::Invalid => "invalid",
                HealthStatus::Unknown => "unknown",
            }
            .to_string(),
            last_validation_error: entry.last_validation_error.clone(),
            last_validated_at: entry.last_validated_at.map(|t| t.to_rfc3339()),
            oauth_refresh_failure_count: entry.oauth_refresh_failure_count,
            last_oauth_refresh_failed_at: entry
                .last_oauth_refresh_failed_at
                .map(|t| t.to_rfc3339()),
            temporary_unavailable_until: entry.temporary_unavailable_until.map(|t| t.to_rfc3339()),
            temporary_unavailable_reason: entry.temporary_unavailable_reason.clone(),
            last_upstream_status: entry.last_upstream_status,
            last_upstream_error_type: entry.last_upstream_error_type.clone(),
            rate_limit_reset_at: entry.rate_limit_reset_at.map(|t| t.to_rfc3339()),
            created_at: entry.created_at.to_rfc3339(),
            updated_at: entry.updated_at.to_rfc3339(),
            enabled: entry.enabled,
            supports_rust_agents,
            can_launch_cli,
            can_use_native_harness,
            native_harness_type,
        }
    }
}

/// Request to save a key
#[derive(serde::Deserialize)]
pub struct SaveKeyRequest {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub agent_type: String,
    pub api_key: Option<String>,
    pub session_token: Option<String>,
    pub base_url: Option<String>,
    pub protocol: Option<String>,
    pub env_vars: Option<HashMap<String, String>>,
    pub available_models: Option<Vec<String>>,
    pub enabled_models: Option<Vec<String>>,
    pub model_aliases: Option<Vec<ModelAliasInfo>>,
    pub model_variants: Option<Vec<ModelVariantInfo>>,
    pub default_variants: Option<Vec<DefaultVariantInfo>>,
    pub quota_info: Option<serde_json::Value>,
    pub has_local_key: Option<bool>,
    pub is_listed: Option<bool>,
    pub auth_method: Option<String>,
    pub listing_id: Option<String>,
    pub enabled: Option<bool>,
}

/// Full key response (unmasked, for internal use)
#[derive(serde::Serialize)]
pub struct FullKeyResponse {
    pub id: String,
    pub name: Option<String>,
    pub agent_type: String,
    pub api_key: Option<String>,
    pub session_token: Option<String>,
    pub base_url: Option<String>,
    pub protocol: Option<String>,
    pub env_vars: HashMap<String, String>,
    pub available_models: Vec<String>,
    pub model_aliases: Vec<ModelAliasInfo>,
    pub model_variants: Vec<ModelVariantInfo>,
    pub default_variants: Vec<DefaultVariantInfo>,
    pub auth_method: String,
}

impl From<ModelKey> for FullKeyResponse {
    fn from(entry: ModelKey) -> Self {
        FullKeyResponse {
            id: entry.id,
            name: entry.name,
            agent_type: entry.model_type.as_str().to_string(),
            api_key: entry.api_key,
            session_token: entry.session_token,
            base_url: entry.base_url,
            protocol: entry.protocol.map(|protocol| protocol.as_str().to_string()),
            env_vars: entry.env_vars,
            available_models: entry.available_models,
            model_aliases: entry
                .model_aliases
                .into_iter()
                .map(|a| ModelAliasInfo {
                    display_name: a.display_name,
                    alias: a.alias,
                    icon: a.icon,
                })
                .collect(),
            model_variants: entry
                .model_variants
                .into_iter()
                .map(|variant| ModelVariantInfo {
                    model: variant.model,
                    base_model: variant.base_model,
                    reasoning: variant.reasoning,
                    fast: variant.fast,
                })
                .collect(),
            default_variants: entry
                .default_variants
                .into_iter()
                .map(|variant| DefaultVariantInfo {
                    base_model: variant.base_model,
                    model: variant.model,
                })
                .collect(),
            auth_method: match entry.auth_method {
                AuthMethod::ApiKey => "api_key",
                AuthMethod::Oauth => "oauth",
            }
            .to_string(),
        }
    }
}

/// List all stored keys (masked)
#[tauri::command]
pub async fn list_keys() -> Result<Vec<KeyInfo>, String> {
    tokio::task::spawn_blocking(|| {
        KEY_SERVICE
            .list_keys()
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
            .get_key(&agent, key_id.as_deref())
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
            .get_key_by_id(&key_id)
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
            .get_key(&agent, key_id.as_deref())
            .map(FullKeyResponse::from))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Save or update a key
#[tauri::command]
pub async fn save_key(request: SaveKeyRequest) -> Result<KeyInfo, String> {
    tokio::task::spawn_blocking(move || {
        let agent_type =
            ModelType::from_str(&request.agent_type).ok_or("Unknown agent type".to_string())?;

        // Load existing key if updating
        let existing = request
            .id
            .as_ref()
            .and_then(|id| KEY_SERVICE.get_key_by_id(id));

        let mut entry = if let Some(existing) = existing {
            existing
        } else {
            ModelKey::new(agent_type.clone())
        };
        let mut received_oauth_material = false;

        // Update fields
        if let Some(id) = request.id {
            entry.id = id;
        }
        if let Some(name) = request.name {
            entry.name = Some(name);
        }
        if let Some(desc) = request.description {
            entry.description = if desc.is_empty() { None } else { Some(desc) };
        }
        entry.model_type = agent_type;
        if let Some(key) = request.api_key {
            let key = key.trim().to_string();
            entry.api_key = if key.is_empty() { None } else { Some(key) };
        }
        if let Some(token) = request.session_token {
            let token = token.trim().to_string();
            received_oauth_material = !token.is_empty();
            entry.session_token = if token.is_empty() { None } else { Some(token) };
        }
        if let Some(url) = request.base_url {
            entry.base_url = Some(url);
        }
        if let Some(protocol) = request.protocol {
            entry.protocol = match protocol.as_str() {
                "openai" => Some(ProviderProtocol::OpenAi),
                "anthropic" => Some(ProviderProtocol::Anthropic),
                _ => return Err(format!("Unknown provider protocol: {}", protocol)),
            };
        }
        if let Some(env) = request.env_vars {
            received_oauth_material =
                received_oauth_material || env.values().any(|value| !value.trim().is_empty());
            entry.env_vars = env;
        }
        if let Some(models) = request.available_models {
            entry.available_models = models;
        }
        if let Some(enabled) = request.enabled_models {
            // Filter out dated snapshot models (containing YYYY-MM-DD pattern)
            entry.enabled_models = filter_dated_models(enabled);
        }
        if let Some(aliases) = request.model_aliases {
            entry.model_aliases = aliases
                .into_iter()
                .map(|a| crate::key_store::ModelAlias {
                    display_name: a.display_name,
                    alias: a.alias,
                    icon: a.icon,
                })
                .collect();
        }
        if let Some(variants) = request.model_variants {
            entry.model_variants = variants
                .into_iter()
                .map(|variant| ModelVariant {
                    model: variant.model,
                    base_model: variant.base_model,
                    reasoning: variant.reasoning,
                    fast: variant.fast,
                })
                .collect();
        }
        if let Some(default_variants) = request.default_variants {
            entry.default_variants = default_variants
                .into_iter()
                .map(|variant| DefaultVariant {
                    base_model: variant.base_model,
                    model: variant.model,
                })
                .collect();
        }
        if let Some(quota) = request.quota_info {
            entry.quota_info = Some(quota);
        }
        if let Some(local) = request.has_local_key {
            entry.has_local_key = local;
        }
        if let Some(listed) = request.is_listed {
            entry.is_listed = listed;
        }
        if let Some(auth) = request.auth_method {
            entry.auth_method = match auth.as_str() {
                "oauth" => AuthMethod::Oauth,
                _ => AuthMethod::ApiKey,
            };
        }
        if let Some(listing) = request.listing_id {
            entry.listing_id = if listing.is_empty() {
                None
            } else {
                Some(listing)
            };
        }
        if let Some(enabled) = request.enabled {
            entry.enabled = enabled;
            if enabled && entry.auth_method == AuthMethod::Oauth {
                entry.oauth_refresh_failure_count = 0;
                entry.last_oauth_refresh_failed_at = None;
                entry.last_validation_error = None;
                entry.temporary_unavailable_until = None;
                entry.temporary_unavailable_reason = None;
                entry.last_upstream_status = None;
                entry.last_upstream_error_type = None;
                entry.rate_limit_reset_at = None;
                if entry.health_status == HealthStatus::Invalid {
                    entry.health_status = HealthStatus::Unknown;
                }
            }
        }

        // Normalize OAuth keys: only keep session_token, clear api_key.
        // Cursor is the exception: we persist both credentials and let each
        // runtime entry point choose the one it needs.
        if entry.auth_method == AuthMethod::Oauth && entry.model_type != ModelType::CursorCli {
            if entry.api_key.is_some() && entry.session_token.is_none() {
                entry.session_token = entry.api_key.take();
            }
            entry.api_key = None;
        }

        if entry.auth_method == AuthMethod::Oauth && received_oauth_material {
            entry.oauth_refresh_failure_count = 0;
            entry.last_oauth_refresh_failed_at = None;
            entry.last_validation_error = None;
            entry.temporary_unavailable_until = None;
            entry.temporary_unavailable_reason = None;
            entry.last_upstream_status = None;
            entry.last_upstream_error_type = None;
            entry.rate_limit_reset_at = None;
        }

        if entry.model_type == ModelType::CursorCli {
            if let Some(api_key) = entry.api_key.as_deref() {
                if !(api_key.starts_with("key_") || api_key.starts_with("crsr_"))
                    || api_key.len() <= 20
                {
                    return Err("Cursor API key should start with 'key_' or 'crsr_'".to_string());
                }
            }
            let session_token = entry.session_token.as_deref().unwrap_or_default();
            if session_token.is_empty() {
                return Err("Cursor requires a session token before saving".to_string());
            }
            if is_cursor_web_session_token(session_token) {
                return Err(
                    "Cursor web login tokens cannot be used for native chat; please sign in again"
                        .to_string(),
                );
            }
        }

        let saved = KEY_SERVICE.save_key(entry)?;
        key_info_from_entry(saved)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Delete a key by agent type and optional ID
#[tauri::command]
pub async fn delete_key(agent_type: String, key_id: Option<String>) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let agent = ModelType::from_str(&agent_type).ok_or("Unknown agent type".to_string())?;
        KEY_SERVICE.delete_key(&agent, key_id.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Delete a key by ID only
#[tauri::command]
pub async fn delete_key_by_id(key_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || KEY_SERVICE.delete_key_by_id(&key_id))
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

/// Write text to the system clipboard via arboard.
/// Used by the frontend when `navigator.clipboard.writeText` fails (e.g.
/// after an async RPC call where the user-gesture token has expired).
#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|err| format!("Clipboard access failed: {}", err))?;
        clipboard
            .set_text(&text)
            .map_err(|err| format!("Clipboard write failed: {}", err))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}
