use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use regex::Regex;

use crate::key_store::{
    AuthMethod, DefaultVariant, HealthStatus, ModelKey, ModelType, ModelVariant, ProviderProtocol,
    KEY_SERVICE,
};
// Re-exported here so consumers keep the established
// `key_vault::commands::` path (matching `model_supports_output_config_effort`).
pub use crate::key_store::{is_claude_official_oauth_token, is_official_anthropic_endpoint};

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
    /// Context window reported by the provider's `/v1/models` endpoint.
    /// Round-tripped so a subsequent `save_key` carrying `model_variants`
    /// doesn't erase the value written by `update_key_health`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

impl From<ModelVariantInfo> for ModelVariant {
    fn from(v: ModelVariantInfo) -> Self {
        ModelVariant {
            model: v.model,
            base_model: v.base_model,
            reasoning: v.reasoning,
            fast: v.fast,
            context_window: v.context_window.filter(|ctx| *ctx > 0),
        }
    }
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
    pub account_metadata: HashMap<String, String>,
    pub available_models: Vec<String>,
    pub enabled_models: Vec<String>,
    pub side_query_model: Option<String>,
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
        ModelType::CursorCli | ModelType::OrgiiOrchestrator | ModelType::EmbeddingApi => false,
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

pub(super) fn key_info_from_entry(entry: ModelKey) -> Result<KeyInfo, String> {
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

/// Drop stale relay routing from a ClaudeCode row that carries official
/// Anthropic OAuth material.
///
/// Re-detecting Claude Code OAuth on top of an account row that was earlier
/// configured for a third-party relay leaves the relay's `base_url` (and a
/// possible `protocol: openai`) on the row, because `save_key` only
/// overwrites fields present in the request. The Rust agent then sends the
/// `sk-ant-oat…` bearer token to the relay, which 401s (issue #276). Official
/// OAuth tokens have exactly one valid endpoint, so the relay routing state
/// is unambiguously stale. Relay ClaudeCode accounts (non-`sk-ant-oat`
/// tokens) are left untouched.
fn normalize_claude_official_oauth_routing(entry: &mut ModelKey) {
    if entry.model_type != ModelType::ClaudeCode
        || entry.auth_method != AuthMethod::Oauth
        || !entry
            .session_token
            .as_deref()
            .is_some_and(is_claude_official_oauth_token)
    {
        return;
    }

    if !is_official_anthropic_endpoint(entry.base_url.as_deref()) {
        entry.base_url = None;
    }
    entry.protocol = None;
}

fn account_uses_anthropic_native_messages(entry: &ModelKey) -> bool {
    match entry.model_type {
        // Azure-hosted Anthropic gateway: the Azure base URL is mandatory and
        // first-party, not a relay.
        ModelType::AzureAnthropicApi => true,
        ModelType::AnthropicApi => is_official_anthropic_endpoint(entry.base_url.as_deref()),
        ModelType::ClaudeCode => {
            entry.auth_method == AuthMethod::Oauth
                && has_non_empty_secret(&entry.session_token)
                && is_official_anthropic_endpoint(entry.base_url.as_deref())
        }
        // Third-party providers that merely speak the Anthropic protocol
        // (relays, Anthropic-compatible vendors) never get synthesized effort
        // variants — effort support is only guaranteed on official endpoints.
        _ => false,
    }
}

pub const CLAUDE_CODE_OAUTH_MODELS: &[&str] = &[
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
];

pub const CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS: &[&str] = &[
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
];

pub const CODEX_OAUTH_MODELS: &[&str] = &[
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
    "codex-auto-review",
];

pub const CODEX_OAUTH_DEFAULT_ENABLED_MODELS: &[&str] = &["gpt-5.5"];

/// Claude models whose Messages requests carry `output_config.effort`.
pub fn model_supports_output_config_effort(model: &str) -> bool {
    let lower = model.to_lowercase();
    if !lower.starts_with("claude-") || lower.contains("haiku") {
        return false;
    }
    lower.contains("fable-5")
        || lower.contains("opus-4-8")
        || lower.contains("opus-4-7")
        || lower.contains("opus-4-6")
        || lower.contains("sonnet-5")
        || lower.contains("sonnet-4-6")
}

fn claude_model_has_thinking_toggle(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("opus-4-8") || lower.contains("sonnet-")
}

/// A "real" selectable effort rung, as opposed to a bare record row
/// (`model == base_model` with no recognized reasoning level) produced by the
/// context-window / observed-reasoning writebacks in `key_store::service`.
fn is_actionable_variant(variant: &ModelVariant) -> bool {
    variant.model != variant.base_model
        || variant.fast
        || matches!(
            variant.reasoning.as_deref(),
            Some(
                "baseline"
                    | "low"
                    | "medium"
                    | "high"
                    | "extra_high"
                    | "xhigh"
                    | "max"
                    | "ultracode",
            )
        )
}

const ANTHROPIC_EFFORT_RUNGS: &[(&str, &str)] = &[
    ("low", "low"),
    ("medium", "medium"),
    ("high", "high"),
    ("xhigh", "extra_high"),
    ("max", "max"),
];

const FABLE_EFFORT_RUNGS: &[(&str, &str)] = &[
    ("low", "low"),
    ("medium", "medium"),
    ("high", "high"),
    ("xhigh", "extra_high"),
    ("max", "max"),
    ("ultracode", "ultracode"),
];

fn effort_variants_for_base_model(
    base_model: &str,
    context_window: Option<u64>,
) -> Vec<ModelVariantInfo> {
    let mut variants = Vec::new();
    let has_thinking_toggle = claude_model_has_thinking_toggle(base_model);
    let lower = base_model.to_lowercase();
    let rungs = if lower.contains("fable-5") {
        FABLE_EFFORT_RUNGS
    } else {
        ANTHROPIC_EFFORT_RUNGS
    };
    for (suffix, reasoning) in rungs {
        variants.push(ModelVariantInfo {
            model: format!("{base_model}-{suffix}"),
            base_model: base_model.to_string(),
            reasoning: Some((*reasoning).to_string()),
            fast: false,
            context_window,
        });
        if has_thinking_toggle {
            variants.push(ModelVariantInfo {
                model: format!("{base_model}-thinking-{suffix}"),
                base_model: base_model.to_string(),
                reasoning: Some((*reasoning).to_string()),
                fast: false,
                context_window,
            });
        }
    }
    variants
}

fn codex_model_supports_variants(model: &str) -> bool {
    CODEX_OAUTH_MODELS.contains(&model) && model != "codex-auto-review"
}

fn codex_model_supports_fast_tier(model: &str) -> bool {
    matches!(model, "gpt-5.5" | "gpt-5.4")
}

fn codex_effort_variants_for_base_model(base_model: &str) -> Vec<ModelVariantInfo> {
    let mut out = Vec::new();
    let supports_fast = codex_model_supports_fast_tier(base_model);
    for effort in ["low", "medium", "high", "xhigh"] {
        out.push(ModelVariantInfo {
            model: format!("{base_model}-{effort}"),
            base_model: base_model.to_string(),
            reasoning: Some(effort.to_string()),
            fast: false,
            context_window: None,
        });
        if supports_fast {
            out.push(ModelVariantInfo {
                model: format!("{base_model}-{effort}-fast"),
                base_model: base_model.to_string(),
                reasoning: Some(effort.to_string()),
                fast: true,
                context_window: None,
            });
        }
    }
    out
}

fn append_missing_variants(out: &mut Vec<ModelVariantInfo>, variants: Vec<ModelVariantInfo>) {
    for synthesized in variants {
        if out.iter().any(|variant| variant.model == synthesized.model) {
            continue;
        }
        out.push(synthesized);
    }
}

fn default_variants_for_key(entry: &ModelKey) -> Vec<DefaultVariantInfo> {
    let mut out: Vec<DefaultVariantInfo> = entry
        .default_variants
        .iter()
        .map(|variant| DefaultVariantInfo {
            base_model: variant.base_model.clone(),
            model: variant.model.clone(),
        })
        .collect();

    if matches!(entry.model_type, ModelType::Codex) {
        for model in entry
            .available_models
            .iter()
            .filter(|model| codex_model_supports_variants(model))
        {
            if out.iter().any(|variant| variant.base_model == *model) {
                continue;
            }
            out.push(DefaultVariantInfo {
                base_model: model.clone(),
                model: format!("{model}-medium"),
            });
        }
    }

    if account_uses_anthropic_native_messages(entry) {
        for model in entry
            .available_models
            .iter()
            .filter(|model| model_supports_output_config_effort(model))
        {
            if out.iter().any(|variant| variant.base_model == *model) {
                continue;
            }
            out.push(DefaultVariantInfo {
                base_model: model.clone(),
                model: format!("{model}-high"),
            });
        }
    }

    out
}

fn model_variants_for_key(entry: &ModelKey) -> Vec<ModelVariantInfo> {
    // Every stored variant passes through untouched, for every account type:
    // bare record rows (`model == base_model`) carry provider-reported
    // context windows that the frontend context-usage display reads.
    let mut out: Vec<ModelVariantInfo> = entry
        .model_variants
        .iter()
        .map(|variant| ModelVariantInfo {
            model: variant.model.clone(),
            base_model: variant.base_model.clone(),
            reasoning: variant.reasoning.clone(),
            fast: variant.fast,
            context_window: variant.context_window.filter(|ctx| *ctx > 0),
        })
        .collect();

    if matches!(entry.model_type, ModelType::Codex) {
        for model in entry
            .available_models
            .iter()
            .filter(|model| codex_model_supports_variants(model))
        {
            append_missing_variants(&mut out, codex_effort_variants_for_base_model(model));
        }
    }

    if !account_uses_anthropic_native_messages(entry) {
        return out;
    }

    for model in entry
        .available_models
        .iter()
        .filter(|model| model_supports_output_config_effort(model))
    {
        // A real effort ladder already exists (user- or sync-created) —
        // don't synthesize a duplicate. Bare record rows don't count.
        if entry
            .model_variants
            .iter()
            .any(|variant| variant.base_model == *model && is_actionable_variant(variant))
        {
            continue;
        }
        let context_window = entry
            .model_variants
            .iter()
            .find(|variant| variant.base_model == *model || variant.model == *model)
            .and_then(|variant| variant.context_window)
            .filter(|ctx| *ctx > 0);
        append_missing_variants(
            &mut out,
            effort_variants_for_base_model(model, context_window),
        );
    }
    out
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
            account_metadata: entry.account_metadata.clone(),
            available_models: entry.available_models.clone(),
            enabled_models: entry.enabled_models.clone(),
            side_query_model: entry.side_query_model.clone(),
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
    pub account_metadata: Option<HashMap<String, String>>,
    pub available_models: Option<Vec<String>>,
    pub enabled_models: Option<Vec<String>>,
    pub side_query_model: Option<String>,
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
    pub account_metadata: HashMap<String, String>,
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
        if let Some(metadata) = request.account_metadata {
            entry.account_metadata = metadata;
        }
        if let Some(models) = request.available_models {
            entry.available_models = models;
        }
        if let Some(enabled) = request.enabled_models {
            // Filter out dated snapshot models (containing YYYY-MM-DD pattern)
            entry.enabled_models = filter_dated_models(enabled);
        }
        if let Some(model) = request.side_query_model {
            let model = model.trim();
            entry.side_query_model = if model.is_empty() {
                None
            } else {
                Some(model.to_string())
            };
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
            entry.model_variants = variants.into_iter().map(ModelVariant::from).collect();
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

        normalize_claude_official_oauth_routing(&mut entry);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_anthropic_endpoint_accepts_empty_and_official_urls() {
        assert!(is_official_anthropic_endpoint(None));
        assert!(is_official_anthropic_endpoint(Some("")));
        assert!(is_official_anthropic_endpoint(Some("  ")));
        assert!(is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com"
        )));
        assert!(is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com/v1"
        )));
        assert!(is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com:443/v1"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://relay.example.com/v1"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "http://api.anthropic.com"
        )));
        // Lookalike hosts must not pass the boundary check.
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com.evil.example/v1"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.community"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com@evil.example/"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com:pass@evil.example/"
        )));
    }

    #[test]
    fn official_claude_oauth_token_requires_oat_prefix() {
        assert!(is_claude_official_oauth_token("sk-ant-oat01-abc"));
        assert!(is_claude_official_oauth_token("  sk-ant-oat01-abc  "));
        assert!(!is_claude_official_oauth_token("sk-ant-api03-abc"));
        assert!(!is_claude_official_oauth_token("sk-relay-key"));
        assert!(!is_claude_official_oauth_token(""));
    }

    fn claude_oauth_entry(token: &str) -> ModelKey {
        let mut entry = ModelKey::new(ModelType::ClaudeCode);
        entry.auth_method = AuthMethod::Oauth;
        entry.session_token = Some(token.to_string());
        entry
    }

    #[test]
    fn official_oauth_save_drops_stale_relay_routing() {
        let mut entry = claude_oauth_entry("sk-ant-oat01-abc");
        entry.base_url = Some("https://relay.example.com/v1".to_string());
        entry.protocol = Some(ProviderProtocol::OpenAi);

        normalize_claude_official_oauth_routing(&mut entry);

        assert_eq!(entry.base_url, None);
        assert_eq!(entry.protocol, None);
    }

    #[test]
    fn official_oauth_save_keeps_explicit_official_base_url() {
        let mut entry = claude_oauth_entry("sk-ant-oat01-abc");
        entry.base_url = Some("https://api.anthropic.com/v1".to_string());

        normalize_claude_official_oauth_routing(&mut entry);

        assert_eq!(
            entry.base_url.as_deref(),
            Some("https://api.anthropic.com/v1")
        );
    }

    #[test]
    fn relay_claude_oauth_save_keeps_relay_routing_untouched() {
        let mut entry = claude_oauth_entry("sk-relay-issued-token");
        entry.base_url = Some("https://relay.example.com/v1".to_string());
        entry.protocol = Some(ProviderProtocol::OpenAi);

        normalize_claude_official_oauth_routing(&mut entry);

        assert_eq!(
            entry.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );
        assert_eq!(entry.protocol, Some(ProviderProtocol::OpenAi));
    }

    #[test]
    fn non_claude_and_api_key_rows_are_never_normalized() {
        let mut api_key_entry = ModelKey::new(ModelType::ClaudeCode);
        api_key_entry.api_key = Some("sk-ant-oat01-misfiled".to_string());
        api_key_entry.base_url = Some("https://relay.example.com/v1".to_string());
        normalize_claude_official_oauth_routing(&mut api_key_entry);
        assert_eq!(
            api_key_entry.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );

        let mut anthropic_entry = ModelKey::new(ModelType::AnthropicApi);
        anthropic_entry.auth_method = AuthMethod::Oauth;
        anthropic_entry.session_token = Some("sk-ant-oat01-abc".to_string());
        anthropic_entry.base_url = Some("https://relay.example.com/v1".to_string());
        normalize_claude_official_oauth_routing(&mut anthropic_entry);
        assert_eq!(
            anthropic_entry.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );
    }
}
