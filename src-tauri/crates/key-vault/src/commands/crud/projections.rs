use std::collections::HashMap;

use super::models::{default_variants_for_key, model_variants_for_key};
use super::{DefaultVariantInfo, FullKeyResponse, KeyInfo, ModelAliasInfo, ModelVariantInfo};
use crate::commands::validate::key_can_refresh_quota;
use crate::key_store::{AuthMethod, HealthStatus, ModelKey, ModelType};

const CURSOR_NATIVE_FALLBACK_MODELS: &[&str] = &["composer-2"];

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
        | ModelType::Copilot
        | ModelType::Kiro
        | ModelType::KimiCli
        | ModelType::OpenCode => has_usable_key_material,
        _ => has_api_key,
    }
}

fn cursor_native_model_ids() -> Result<Vec<String>, String> {
    orgtrack_core::sources::cursor_ide::disk_reads::cursor_model_names_from_disk()
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

pub(in crate::commands) fn key_info_from_entry(entry: ModelKey) -> Result<KeyInfo, String> {
    let mut info = KeyInfo::from(entry);
    enrich_cursor_native_models(&mut info)?;
    Ok(info)
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
        let can_refresh_quota = key_can_refresh_quota(&entry);

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
            account_metadata: entry.account_metadata.clone(),
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
            model_variants: model_variants_for_key(&entry),
            default_variants: default_variants_for_key(&entry),
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
            can_refresh_quota,
            supports_rust_agents,
            can_launch_cli,
            can_use_native_harness,
            native_harness_type,
        }
    }
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
            account_metadata: entry.account_metadata,
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
                    context_window: variant.context_window.filter(|ctx| *ctx > 0),
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
