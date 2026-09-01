use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::types::DiscoveredModel;

use crate::commands::crud::{oauth_model_metadata, DefaultVariantInfo, ModelVariantInfo};
use crate::providers::anthropic::AnthropicValidator;
use crate::providers::codex::CodexValidator;

#[derive(Debug, Deserialize)]
pub struct OAuthModelCatalogRequest {
    pub agent_type: String,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OAuthModelCatalogResponse {
    pub models: Vec<String>,
    pub default_enabled_models: Vec<String>,
    pub model_context_lengths: HashMap<String, u64>,
    pub model_variants: Vec<ModelVariantInfo>,
    pub default_variants: Vec<DefaultVariantInfo>,
    pub source: OAuthModelCatalogSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthModelCatalogSource {
    /// Credential-backed discovery succeeded. Codex responses may also contain
    /// ORGII's built-in bases when the local CLI returned a version-limited list.
    Live,
    /// Credential-backed discovery was unavailable and the static catalog was used.
    Fallback,
}

fn oauth_static_catalog(
    agent_type: &str,
) -> Option<(&'static [&'static str], &'static [&'static str])> {
    match agent_type {
        "claude_code" => Some((
            crate::commands::crud::CLAUDE_CODE_OAUTH_MODELS,
            crate::commands::crud::CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS,
        )),
        "codex" => Some((
            crate::commands::crud::CODEX_OAUTH_MODELS,
            crate::commands::crud::CODEX_OAUTH_DEFAULT_ENABLED_MODELS,
        )),
        _ => None,
    }
}

fn fallback_discovered_models(agent_type: &str) -> Result<Vec<DiscoveredModel>, String> {
    let (models, _) = oauth_static_catalog(agent_type)
        .ok_or_else(|| format!("Unsupported OAuth model catalog agent type: {agent_type}"))?;
    Ok(models
        .iter()
        .map(|model| DiscoveredModel {
            id: (*model).to_string(),
            ..DiscoveredModel::default()
        })
        .collect())
}

pub(in crate::commands) fn resolved_oauth_catalog(
    agent_type: &str,
    mut discovered: Vec<DiscoveredModel>,
    source: OAuthModelCatalogSource,
) -> Result<OAuthModelCatalogResponse, String> {
    let (static_models, fallback_defaults) = oauth_static_catalog(agent_type)
        .ok_or_else(|| format!("Unsupported OAuth model catalog agent type: {agent_type}"))?;

    // Codex model discovery is version-gated by the installed CLI and by the
    // client_version sent to the compatibility endpoint. ORGII supports these
    // model families independently of that local discovery version, so retain
    // live metadata for every returned model and append any missing built-in
    // Codex bases. Claude Code remains strictly account-visible.
    if agent_type == "codex" {
        for model in static_models {
            if discovered
                .iter()
                .any(|discovered_model| discovered_model.id == *model)
            {
                continue;
            }
            discovered.push(DiscoveredModel {
                id: (*model).to_string(),
                ..DiscoveredModel::default()
            });
        }
    }

    let models: Vec<String> = discovered.iter().map(|model| model.id.clone()).collect();
    let mut default_enabled_models: Vec<String> = discovered
        .iter()
        .filter(|model| model.is_default)
        .map(|model| model.id.clone())
        .collect();
    // All built-in GPT-5.6 Codex families are product defaults even when an
    // older live catalog names a different default. Preserve that live default
    // and append the built-ins so rescans never turn a user's existing default
    // off while making Sol, Terra, and Luna immediately runnable.
    if agent_type == "codex" || default_enabled_models.is_empty() {
        for model in fallback_defaults {
            if !models.iter().any(|available| available.as_str() == *model)
                || default_enabled_models
                    .iter()
                    .any(|enabled| enabled == *model)
            {
                continue;
            }
            default_enabled_models.push((*model).to_string());
        }
    }
    if default_enabled_models.is_empty() {
        default_enabled_models.extend(models.first().cloned());
    }

    let model_context_lengths = discovered
        .iter()
        .filter_map(|model| {
            model
                .context_window
                .filter(|context| *context > 0)
                .map(|context| (model.id.clone(), context))
        })
        .collect();
    let (model_variants, default_variants) = oauth_model_metadata(agent_type, &discovered);

    Ok(OAuthModelCatalogResponse {
        models,
        default_enabled_models,
        model_context_lengths,
        model_variants,
        default_variants,
        source,
    })
}

pub(super) fn is_oauth_discovery_auth_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("invalid credential")
        || lower.contains("invalid token")
        || lower.contains("access denied")
        || lower.contains("token expired")
}

/// Resolve one authoritative OAuth catalog for every wizard and refresh entry
/// point. Codex keeps live capability metadata while completing the response
/// with ORGII's built-in model bases; other OAuth providers remain strictly
/// account-visible. The full static catalog remains the discovery fallback.
#[tauri::command]
pub async fn oauth_model_catalog(
    request: OAuthModelCatalogRequest,
) -> Result<OAuthModelCatalogResponse, String> {
    let fallback = fallback_discovered_models(&request.agent_type)?;
    let Some(access_token) = request
        .access_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    else {
        return resolved_oauth_catalog(
            &request.agent_type,
            fallback,
            OAuthModelCatalogSource::Fallback,
        );
    };

    let discovered = match request.agent_type.as_str() {
        "claude_code" => {
            AnthropicValidator::new()
                .get_oauth_model_catalog(access_token)
                .await
        }
        "codex" => {
            CodexValidator::new()
                .discover_models(
                    access_token,
                    request.refresh_token.as_deref(),
                    request.id_token.as_deref(),
                )
                .await
        }
        other => {
            return Err(format!(
                "Unsupported OAuth model catalog agent type: {other}"
            ))
        }
    };

    match discovered {
        Ok(models) if !models.is_empty() => {
            resolved_oauth_catalog(&request.agent_type, models, OAuthModelCatalogSource::Live)
        }
        Ok(_) => {
            log::warn!(
                "[oauth_model_catalog] {} returned an empty catalog; using fallback",
                request.agent_type
            );
            resolved_oauth_catalog(
                &request.agent_type,
                fallback,
                OAuthModelCatalogSource::Fallback,
            )
        }
        Err(err) if is_oauth_discovery_auth_error(&err) => Err(err),
        Err(err) => {
            log::warn!(
                "[oauth_model_catalog] {} discovery failed ({}); using fallback",
                request.agent_type,
                err
            );
            resolved_oauth_catalog(
                &request.agent_type,
                fallback,
                OAuthModelCatalogSource::Fallback,
            )
        }
    }
}

/// Force-refresh an OAuth account's access token after the frontend observed a
/// rejection (e.g. 401 from a list-models call). Dispatches by the key's
/// model_type and routes through the existing per-provider refresh helpers,
/// which take per-key locks so concurrent invocations don't double-fire.
#[tauri::command]
pub async fn refresh_oauth_token(key_id: String) -> Result<(), String> {
    use crate::key_store::KEY_SERVICE;
    use crate::{AuthMethod, ModelType};
    use log::info;

    let key = KEY_SERVICE
        .get_key_by_id(&key_id)
        .ok_or_else(|| format!("Key not found: {}", key_id))?;

    if key.auth_method != AuthMethod::Oauth {
        return Err(format!("Key {} is not an OAuth account", key_id));
    }

    let rejected_access_token = key.session_token.clone().unwrap_or_default();

    info!(
        "[refresh_oauth_token] Forcing refresh for key {} ({:?})",
        key_id, key.model_type
    );

    match key.model_type {
        ModelType::ClaudeCode => {
            KEY_SERVICE
                .refresh_claude_code_oauth_key(&key_id, &rejected_access_token)
                .await?;
        }
        ModelType::Codex => {
            KEY_SERVICE
                .refresh_codex_oauth_key(&key_id, &rejected_access_token)
                .await?;
        }
        other => {
            return Err(format!(
                "OAuth refresh not supported for model type {:?}",
                other
            ));
        }
    }

    Ok(())
}
