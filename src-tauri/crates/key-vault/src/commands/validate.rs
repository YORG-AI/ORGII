use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::types::{DiscoveredModel, ValidationResult};

use crate::commands::crud::{
    key_info_from_entry, oauth_model_metadata, DefaultVariantInfo, ModelVariantInfo,
};
use crate::key_store::{AuthMethod, HealthStatus, ModelType, KEY_SERVICE};
use crate::providers::anthropic::AnthropicValidator;
use crate::providers::azure_openai::AzureOpenAIValidator;
use crate::providers::claude_code::ClaudeCodeQuotaFetcher;
use crate::providers::codex::CodexValidator;
use crate::providers::copilot::CopilotValidator;
use crate::providers::cursor::CursorValidator;
use crate::providers::deepseek::DeepSeekQuotaFetcher;
use crate::providers::google::GoogleValidator;
use crate::providers::kimi::KimiCodeQuotaFetcher;
use crate::providers::kiro::KiroValidator;
use crate::providers::minimax::MiniMaxQuotaFetcher;
use crate::providers::openai::OpenAIValidator;
use crate::providers::opencode_go::{workspace_id_override_from_key, OpenCodeGoQuotaFetcher};
use crate::providers::openrouter::OpenRouterQuotaFetcher;
use crate::providers::qoder::QoderQuotaFetcher;
use crate::providers::zai_team::{
    has_partial_team_scope, team_scope_from_key, ZaiTeamQuotaFetcher,
    ORGANIZATION_METADATA_KEY as ZAI_TEAM_ORGANIZATION_METADATA_KEY,
    PROJECT_METADATA_KEY as ZAI_TEAM_PROJECT_METADATA_KEY,
};
use crate::providers::zhipu::ZhipuQuotaFetcher;
use crate::quota_runtime::{
    QuotaAttemptState, QuotaFreshness, QuotaRefreshCompletion, QuotaRefreshRuntime,
    QuotaRefreshStatus,
};
use crate::types::QuotaInfo;

#[derive(Debug, Serialize)]
pub struct TestModelResult {
    pub available: bool,
    pub message: String,
}

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

#[derive(Debug, Deserialize)]
struct OpenCodeModelsResponse {
    #[serde(default)]
    data: Vec<OpenCodeModelInfo>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeModelInfo {
    id: String,
}

use crate::provider_config::get_provider_config;

pub const OPENCODE_ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
pub const OPENCODE_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

static QUOTA_REFRESH_RUNTIME: LazyLock<QuotaRefreshRuntime<QuotaInfo>> =
    LazyLock::new(QuotaRefreshRuntime::default);

/// Get the default base URL for a provider (without /v1 suffix for OpenAI-compat validation).
/// Uses the unified provider_config module as the single source of truth.
fn default_base_url_for_provider(agent_type: &str) -> Option<String> {
    let config = get_provider_config(agent_type);
    config.default_base_url.map(|url| {
        // Strip /v1 suffix if present (validator appends /v1/models)
        url.trim_end_matches("/v1").to_string()
    })
}

/// Anthropic-protocol base URL to fall back on when the caller supplied none.
///
/// Anthropic itself is special-cased because its short aliases don't resolve
/// through `get_provider_config`. Every other provider declares its Anthropic
/// endpoint in the provider registry, so there is no second table to keep in
/// sync here.
fn default_anthropic_base_url_for_provider(agent_type: &str) -> Option<String> {
    match agent_type {
        "anthropic" | "anthropic_api" | "claude_code" => {
            Some("https://api.anthropic.com/v1".to_string())
        }
        other => get_provider_config(other).default_anthropic_base_url(),
    }
}

fn resolve_opencode_base_url(base_url: Option<&str>) -> &str {
    base_url.unwrap_or(OPENCODE_ZEN_BASE_URL)
}

/// Validate an OpenCode Zen/Go key by listing models without issuing a completion request.
pub async fn validate_opencode_key(api_key: &str, base_url: Option<&str>) -> ValidationResult {
    if api_key.is_empty() {
        return ValidationResult::failure("No API key provided");
    }

    match fetch_opencode_models(api_key, resolve_opencode_base_url(base_url)).await {
        Ok(models) => ValidationResult::success("API key valid").with_models(models),
        Err(err) => ValidationResult::failure(&err),
    }
}

async fn fetch_opencode_models(api_key: &str, base_url: &str) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/models", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(endpoint)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("Request failed: {err}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Invalid API key".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let models: OpenCodeModelsResponse = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse response: {err}"))?;
    Ok(models.data.into_iter().map(|model| model.id).collect())
}

/// Validate a key for a given agent type (shared by Tauri and headless tools).
pub async fn run_validate_key(
    agent_type: String,
    api_key: String,
    base_url: Option<String>,
    session_token: Option<String>,
    test_model: Option<String>,
    protocol: Option<String>,
) -> Result<ValidationResult, String> {
    let agent_type_lower = agent_type.to_lowercase();
    let protocol_lower = protocol.as_deref().map(str::to_lowercase);

    match agent_type_lower.as_str() {
        // GitHub Copilot
        "copilot" | "github_copilot" => {
            let validator = CopilotValidator::new();
            Ok(validator.validate(&api_key).await)
        }

        // Cursor CLI
        "cursor_cli" | "cursor" => {
            let validator = CursorValidator::new();
            Ok(validator.validate(&api_key, session_token.as_deref()).await)
        }

        // OpenAI
        "openai" => {
            let validator = OpenAIValidator::new();
            Ok(validator.validate(&api_key, base_url.as_deref(), Some("openai_api"), test_model.as_deref()).await)
        }

        // Codex - supports both OAuth (session_token) and API key
        "codex" => {
            let validator = CodexValidator::new();
            Ok(validator
                .validate(&api_key, session_token.as_deref(), base_url.as_deref())
                .await)
        }

        // Anthropic / Claude Code
        "anthropic" | "claude_code" => {
            let validator = AnthropicValidator::new();
            Ok(validator
                .validate(&api_key, base_url.as_deref(), test_model.as_deref())
                .await)
        }

        // Google API
        "google" => {
            let validator = GoogleValidator::new();
            Ok(validator.validate(&api_key, base_url.as_deref(), test_model.as_deref()).await)
        }

        // Kiro CLI - OAuth token (JSON or access_token)
        "kiro" => {
            let validator = KiroValidator::new();
            Ok(validator.validate(&api_key).await)
        }

        "opencode" | "opencode_cli" => Ok(validate_opencode_key(&api_key, base_url.as_deref()).await),

        // Direct API key providers (matching _api suffix variants from frontend)
        "openai_api" => {
            let validator = OpenAIValidator::new();
            Ok(validator.validate(&api_key, base_url.as_deref(), Some("openai_api"), test_model.as_deref()).await)
        }

        "anthropic_api" => {
            let validator = AnthropicValidator::new();
            Ok(validator
                .validate(&api_key, base_url.as_deref(), test_model.as_deref())
                .await)
        }

        "gemini_api" => {
            let validator = GoogleValidator::new();
            Ok(validator.validate(&api_key, base_url.as_deref(), test_model.as_deref()).await)
        }

        // Azure OpenAI
        "azure_openai_api" => {
            let validator = AzureOpenAIValidator::new();
            Ok(validator.validate(&api_key, base_url.as_deref()).await)
        }

        // Azure-hosted Anthropic (Messages API compatible)
        "azure_anthropic_api" => {
            let validator = AnthropicValidator::new();
            Ok(validator
                .validate(&api_key, base_url.as_deref(), test_model.as_deref())
                .await)
        }

        // OpenAI-compatible API providers (use OpenAI validator with provider's base URL).
        // Providers that also speak the Anthropic protocol declare an Anthropic
        // endpoint in the provider registry and route through it below.
        "atlascloud_api" | "deepseek_api" | "groq_api" | "xai_api" | "zhipu_api" | "dashscope_api"
        | "moonshot_api" | "minimax_api" | "longcat_api" | "openrouter_api" | "zenmux_api"
        | "siliconflow_api" | "modelscope_api" | "aihubmix_api" | "cherryin_api"
        | "bedrock_api" | "custom_api" | "vllm_api" | "orgii_orchestrator" | "orgii" => {
            if protocol_lower.as_deref() == Some("anthropic") {
                let effective_url = base_url
                    .clone()
                    .or_else(|| default_anthropic_base_url_for_provider(&agent_type_lower));
                if effective_url.is_none() {
                    return Err(format!(
                        "Provider '{}' has no default Anthropic endpoint. Set a custom base URL.",
                        agent_type_lower
                    ));
                }
                let validator = AnthropicValidator::new();
                Ok(validator
                    .validate(&api_key, effective_url.as_deref(), test_model.as_deref())
                    .await)
            } else {
                let validator = OpenAIValidator::new();
                let effective_url = base_url
                    .clone()
                    .or_else(|| default_base_url_for_provider(&agent_type_lower));
                Ok(validator.validate(&api_key, effective_url.as_deref(), Some(&agent_type_lower), test_model.as_deref()).await)
            }
        }

        _ => Err(format!(
            "Unknown agent type: {}. Supported: copilot, cursor_cli, openai, anthropic, google, codex, claude_code, kiro, opencode, openai_api, atlascloud_api, anthropic_api, gemini_api, deepseek_api, groq_api, xai_api, zhipu_api, dashscope_api, moonshot_api, minimax_api, longcat_api, openrouter_api, zenmux_api, siliconflow_api, modelscope_api, aihubmix_api, cherryin_api, bedrock_api, custom_api, vllm_api, azure_openai_api, azure_anthropic_api",
            agent_type
        )),
    }
}

/// Validate a key for a given agent type
#[tauri::command]
pub async fn validate_key(
    agent_type: String,
    api_key: String,
    base_url: Option<String>,
    session_token: Option<String>,
    test_model: Option<String>,
    protocol: Option<String>,
) -> Result<ValidationResult, String> {
    run_validate_key(
        agent_type,
        api_key,
        base_url,
        session_token,
        test_model,
        protocol,
    )
    .await
}

/// Test whether a specific model is available on an endpoint.
#[tauri::command]
pub async fn test_model_availability(
    api_key: String,
    base_url: String,
    model: String,
    agent_type: String,
) -> Result<TestModelResult, String> {
    use log::info;
    info!(
        "[test_model] Testing model={} on base_url={} (agent_type={})",
        model, base_url, agent_type
    );

    let agent_type_lower = agent_type.to_lowercase();

    let result = if agent_type_lower.contains("anthropic") || agent_type_lower == "claude_code" {
        let validator = AnthropicValidator::new();
        validator
            .test_messages(&api_key, Some(&base_url), &model)
            .await
    } else {
        let validator = OpenAIValidator::new();
        validator.test_completion(&api_key, &base_url, &model).await
    };

    match result {
        Ok(()) => {
            info!("[test_model] Model {} is available", model);
            Ok(TestModelResult {
                available: true,
                message: "Model is available".to_string(),
            })
        }
        Err(e) if e == "Invalid API key" => {
            info!("[test_model] Model {} — auth failed", model);
            Ok(TestModelResult {
                available: false,
                message: "Invalid API key".to_string(),
            })
        }
        Err(e) => {
            info!("[test_model] Model {} — error: {}", model, e);
            Ok(TestModelResult {
                available: false,
                message: format!("Model not available: {}", e),
            })
        }
    }
}

/// Validate token format without making API calls (fast check).
/// Not exposed as a Tauri command — only used internally.
pub fn validate_token_format(agent_type: String, token: String) -> Result<(bool, String), String> {
    let agent_type_lower = agent_type.to_lowercase();

    match agent_type_lower.as_str() {
        "copilot" | "github_copilot" => {
            let validator = CopilotValidator::new();
            Ok(validator.validate_format(&token))
        }
        "cursor_cli" | "cursor" => {
            let validator = CursorValidator::new();
            Ok(validator.validate_format(&token))
        }
        "openai" => {
            let validator = OpenAIValidator::new();
            Ok(validator.validate_format(&token))
        }
        "codex" => {
            let validator = CodexValidator::new();
            Ok(validator.validate_format(&token))
        }
        "anthropic" | "claude_code" => {
            let validator = AnthropicValidator::new();
            Ok(validator.validate_format(&token))
        }
        "google" => {
            let validator = GoogleValidator::new();
            Ok(validator.validate_format(&token))
        }
        "kiro" => {
            let validator = KiroValidator::new();
            Ok(validator.validate_format(&token))
        }
        "opencode" | "opencode_cli" => {
            if token.is_empty() {
                Ok((false, "API key is required".to_string()))
            } else if token.len() < 8 {
                Ok((false, "API key is too short".to_string()))
            } else {
                Ok((true, "Format OK".to_string()))
            }
        }

        // Direct API key providers (_api suffix variants)
        "openai_api" => {
            let validator = OpenAIValidator::new();
            Ok(validator.validate_format(&token))
        }
        "anthropic_api" => {
            let validator = AnthropicValidator::new();
            Ok(validator.validate_format(&token))
        }
        "gemini_api" => {
            let validator = GoogleValidator::new();
            Ok(validator.validate_format(&token))
        }

        // Azure OpenAI
        "azure_openai_api" => {
            let validator = AzureOpenAIValidator::new();
            Ok(validator.validate_format(&token))
        }

        "azure_anthropic_api" => {
            let validator = AnthropicValidator::new();
            Ok(validator.validate_format(&token))
        }

        // OpenAI-compatible providers: just verify non-empty and reasonable length
        "atlascloud_api" | "deepseek_api" | "groq_api" | "xai_api" | "zhipu_api"
        | "dashscope_api" | "moonshot_api" | "minimax_api" | "longcat_api" | "openrouter_api"
        | "zenmux_api" | "vllm_api" | "orgii_orchestrator" | "orgii" => {
            if token.is_empty() {
                Ok((false, "API key is required".to_string()))
            } else if token.len() < 8 {
                Ok((false, "API key is too short".to_string()))
            } else {
                Ok((true, "Format OK".to_string()))
            }
        }

        _ => Err(format!("Unknown agent type: {}", agent_type)),
    }
}

/// Fetch quota for a validated key
#[tauri::command]
pub async fn fetch_key_quota(
    agent_type: String,
    api_key: String,
) -> Result<crate::types::QuotaInfo, String> {
    let agent_type_lower = agent_type.to_lowercase();

    match agent_type_lower.as_str() {
        // Copilot - api_key is the GitHub PAT
        "copilot" | "github_copilot" => {
            let validator = CopilotValidator::new();
            validator.fetch_quota(&api_key).await
        }
        // Cursor - api_key is the session token for quota fetching
        "cursor_cli" | "cursor" => {
            let validator = CursorValidator::new();
            validator.fetch_quota(&api_key).await
        }
        "opencode" | "opencode_cli" => {
            OpenCodeGoQuotaFetcher::new()
                .fetch_quota(&api_key, None)
                .await
        }
        // Zhipu (BigModel / Z.ai) GLM Coding Plan. Base URL is not available on
        // this validation-time path, so the fetcher defaults to the China host.
        "zhipu_api" | "zhipu" => ZhipuQuotaFetcher::new().fetch_quota(&api_key, None).await,
        "deepseek_api" | "deepseek" => DeepSeekQuotaFetcher::new().fetch_quota(&api_key).await,
        "openrouter_api" | "openrouter" => {
            OpenRouterQuotaFetcher::new().fetch_quota(&api_key).await
        }
        // This legacy validation-time command has no base_url argument, so it
        // can only use MiniMax's default international region. Stored-account
        // refreshes below use the saved base_url and stay region-locked.
        "minimax_api" | "minimax" => MiniMaxQuotaFetcher::new().fetch_quota(&api_key, None).await,
        // Other providers don't have public quota APIs
        "openai"
        | "anthropic"
        | "claude_code"
        | "google"
        | "codex"
        | "kiro"
        | "openai_api"
        | "anthropic_api"
        | "atlascloud_api"
        | "gemini_api"
        | "groq_api"
        | "xai_api"
        | "dashscope_api"
        | "moonshot_api"
        | "longcat_api"
        | "zenmux_api"
        | "vllm_api"
        | "azure_openai_api"
        | "azure_anthropic_api"
        | "orgii_orchestrator"
        | "orgii" => Err(format!("{} does not have a public quota API", agent_type)),
        _ => Err(format!("Unknown agent type: {}", agent_type)),
    }
}

/// Refresh quota for a stored key without exposing its token to the frontend.
#[tauri::command]
pub async fn refresh_key_quota(
    key_id: String,
    force: Option<bool>,
) -> Result<Option<crate::commands::KeyInfo>, String> {
    let lookup_id = key_id.clone();
    let key = tokio::task::spawn_blocking(move || {
        KEY_SERVICE
            .get_key_by_id_checked(&lookup_id)?
            .ok_or_else(|| format!("Key not found: {lookup_id}"))
    })
    .await
    .map_err(|err| format!("Quota key lookup worker failed: {err}"))??;
    let credential_revision = quota_credential_revision(&key);
    let strict_request_count = quota_refresh_uses_strict_request_count(&key);
    let operation_key = key.clone();
    let operation_revision = credential_revision.clone();
    let operation = move || {
        let key = operation_key.clone();
        let revision = operation_revision.clone();
        async move { refresh_and_store_key_quota(key, revision).await }
    };

    if strict_request_count {
        QUOTA_REFRESH_RUNTIME
            .refresh_without_transient_retry(
                key_id.clone(),
                credential_revision,
                force.unwrap_or(false),
                operation,
            )
            .await?;
    } else {
        QUOTA_REFRESH_RUNTIME
            .refresh(
                key_id.clone(),
                credential_revision,
                force.unwrap_or(false),
                operation,
            )
            .await?;
    }

    tokio::task::spawn_blocking(move || {
        KEY_SERVICE
            .get_key_by_id_checked(&key_id)?
            .map(key_info_from_entry)
            .transpose()
    })
    .await
    .map_err(|err| format!("Quota result lookup worker failed: {err}"))?
}

/// Evict the runtime state retained for a deleted or signed-out account.
pub fn invalidate_key_quota_runtime(key_id: &str) {
    QUOTA_REFRESH_RUNTIME.invalidate(key_id);
}

/// Read-only process diagnostics for quota-refresh status and timestamps.
pub fn key_quota_refresh_status(key_id: &str) -> Option<QuotaRefreshStatus<QuotaInfo>> {
    QUOTA_REFRESH_RUNTIME.status(key_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyQuotaRefreshAttemptInfo {
    pub generation: u64,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyQuotaRefreshStatusInfo {
    pub key_id: String,
    pub generation: u64,
    pub freshness: String,
    pub cache_expires_at: Option<String>,
    pub last_good: Option<QuotaInfo>,
    pub last_good_at: Option<String>,
    pub last_attempt: Option<KeyQuotaRefreshAttemptInfo>,
}

/// Return freshness and attempt diagnostics without triggering provider work.
#[tauri::command]
pub fn get_key_quota_refresh_status(key_id: String) -> Option<KeyQuotaRefreshStatusInfo> {
    let status = key_quota_refresh_status(&key_id)?;
    let (last_good, last_good_at) = match status.last_good {
        Some(last_good) => (
            Some(last_good.value),
            Some(format_system_time(last_good.captured_at)),
        ),
        None => (None, None),
    };
    let last_attempt = status
        .last_attempt
        .map(|attempt| KeyQuotaRefreshAttemptInfo {
            generation: attempt.generation,
            status: match attempt.state {
                QuotaAttemptState::Running => "running",
                QuotaAttemptState::Succeeded => "succeeded",
                QuotaAttemptState::Failed => "failed",
                QuotaAttemptState::Superseded => "superseded",
            }
            .to_string(),
            started_at: format_system_time(attempt.started_at),
            finished_at: attempt.finished_at.map(format_system_time),
            error: attempt.error,
        });

    Some(KeyQuotaRefreshStatusInfo {
        key_id,
        generation: status.generation,
        freshness: match status.freshness {
            QuotaFreshness::Empty => "empty",
            QuotaFreshness::FreshSuccess => "fresh_success",
            QuotaFreshness::FreshFailure => "fresh_failure",
            QuotaFreshness::Expired => "expired",
            QuotaFreshness::Refreshing => "refreshing",
        }
        .to_string(),
        cache_expires_at: status.cache_expires_at.map(format_system_time),
        last_good,
        last_good_at,
        last_attempt,
    })
}

fn format_system_time(value: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339()
}

async fn refresh_and_store_key_quota(
    key: crate::key_store::ModelKey,
    requested_revision: String,
) -> Result<QuotaRefreshCompletion<QuotaInfo>, String> {
    let key_id = key.id.clone();
    let mut effective_key = key;
    let mut account_metadata = HashMap::new();

    let quota = if effective_key.model_type == ModelType::ClaudeCode
        && effective_key.auth_method == AuthMethod::Oauth
    {
        let token = effective_key
            .session_token
            .as_deref()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| "Claude Code OAuth account has no access token".to_string())?;

        let refresh = match ClaudeCodeQuotaFetcher::new()
            .fetch_quota_refresh(token)
            .await
        {
            Ok(refresh) => refresh,
            Err(first_err) if is_unauthorized_quota_error(&first_err) => {
                effective_key = refresh_oauth_key_for_quota(&effective_key).await?;
                let retry_token = effective_key
                    .session_token
                    .as_deref()
                    .filter(|retry_token| !retry_token.trim().is_empty())
                    .ok_or_else(|| {
                        "Claude Code OAuth account has no access token after refresh".to_string()
                    })?;
                ClaudeCodeQuotaFetcher::new()
                    .fetch_quota_refresh(retry_token)
                    .await?
            }
            Err(first_err) => return Err(first_err),
        };

        account_metadata = refresh.account_metadata;
        refresh.quota
    } else {
        match fetch_quota_for_key(&effective_key).await {
            Ok(quota) => quota,
            Err(first_err)
                if effective_key.auth_method == AuthMethod::Oauth
                    && is_unauthorized_quota_error(&first_err) =>
            {
                effective_key = refresh_oauth_key_for_quota(&effective_key).await?;
                fetch_quota_for_key(&effective_key).await?
            }
            Err(first_err) => return Err(first_err),
        }
    };

    let committed_revision = quota_credential_revision(&effective_key);
    let quota_value = serde_json::to_value(&quota)
        .map_err(|err| format!("Failed to serialize quota info: {err}"))?;
    let commit_key_id = key_id.clone();
    let revision_for_commit = committed_revision.clone();

    tokio::task::spawn_blocking(move || {
        let current = KEY_SERVICE
            .get_key_by_id_checked(&commit_key_id)?
            .ok_or_else(|| format!("Key not found: {commit_key_id}"))?;
        if quota_credential_revision(&current) != revision_for_commit {
            return Err(
                "Quota refresh was superseded before its result could be stored".to_string(),
            );
        }

        if !account_metadata.is_empty() {
            KEY_SERVICE.merge_key_account_metadata(&commit_key_id, account_metadata)?;
        }

        KEY_SERVICE
            .update_key_health(
                &commit_key_id,
                HealthStatus::Valid,
                None,
                None,
                None,
                Some(quota_value),
                None,
            )?
            .ok_or_else(|| format!("Key not found: {commit_key_id}"))?;
        Ok(())
    })
    .await
    .map_err(|err| format!("Quota persistence worker failed: {err}"))??;

    if committed_revision == requested_revision {
        Ok(QuotaRefreshCompletion::unchanged(quota))
    } else {
        Ok(QuotaRefreshCompletion::with_credential_revision(
            quota,
            committed_revision,
        ))
    }
}

pub(super) fn quota_credential_revision(key: &crate::key_store::ModelKey) -> String {
    fn hash_field(hasher: &mut Sha256, name: &str, value: Option<&str>) {
        hasher.update(name.len().to_le_bytes());
        hasher.update(name.as_bytes());
        match value {
            Some(value) => {
                hasher.update([1]);
                hasher.update(value.len().to_le_bytes());
                hasher.update(value.as_bytes());
            }
            None => hasher.update([0]),
        }
    }

    let mut hasher = Sha256::new();
    hash_field(&mut hasher, "model_type", Some(key.model_type.as_str()));
    hash_field(
        &mut hasher,
        "auth_method",
        Some(match key.auth_method {
            AuthMethod::ApiKey => "api_key",
            AuthMethod::Oauth => "oauth",
        }),
    );
    hash_field(&mut hasher, "api_key", key.api_key.as_deref());
    hash_field(&mut hasher, "session_token", key.session_token.as_deref());
    hash_field(&mut hasher, "base_url", key.base_url.as_deref());
    hash_field(
        &mut hasher,
        "protocol",
        key.protocol.map(|protocol| protocol.as_str()),
    );

    let mut env_vars = key.env_vars.iter().collect::<Vec<_>>();
    env_vars.sort_unstable_by(|left, right| left.0.cmp(right.0));
    for (name, value) in env_vars {
        hash_field(&mut hasher, name, Some(value));
    }
    hash_field(
        &mut hasher,
        "opencode_workspace",
        workspace_id_override_from_key(key),
    );
    hash_field(
        &mut hasher,
        ZAI_TEAM_ORGANIZATION_METADATA_KEY,
        key.account_metadata
            .get(ZAI_TEAM_ORGANIZATION_METADATA_KEY)
            .map(String::as_str),
    );
    hash_field(
        &mut hasher,
        ZAI_TEAM_PROJECT_METADATA_KEY,
        key.account_metadata
            .get(ZAI_TEAM_PROJECT_METADATA_KEY)
            .map(String::as_str),
    );

    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod quota_credential_revision_tests {
    use super::*;

    #[test]
    fn revision_is_stable_across_map_insertion_order() {
        let mut first = crate::key_store::ModelKey::new(ModelType::Codex);
        first.env_vars.insert("B".into(), "two".into());
        first.env_vars.insert("A".into(), "one".into());
        let mut second = first.clone();
        second.env_vars.clear();
        second.env_vars.insert("A".into(), "one".into());
        second.env_vars.insert("B".into(), "two".into());

        assert_eq!(
            quota_credential_revision(&first),
            quota_credential_revision(&second)
        );
    }

    #[test]
    fn revision_changes_for_secrets_endpoint_and_quota_scope() {
        let mut key = crate::key_store::ModelKey::new(ModelType::OpenCode);
        key.session_token = Some("cookie-a".into());
        let initial = quota_credential_revision(&key);

        key.session_token = Some("cookie-b".into());
        let changed_secret = quota_credential_revision(&key);
        assert_ne!(initial, changed_secret);

        key.base_url = Some("https://example.test".into());
        let changed_endpoint = quota_credential_revision(&key);
        assert_ne!(changed_secret, changed_endpoint);

        key.account_metadata
            .insert("opencode_workspace_id".into(), "wrk_account".into());
        assert_ne!(changed_endpoint, quota_credential_revision(&key));
    }

    #[test]
    fn revision_ignores_display_only_account_metadata() {
        let mut key = crate::key_store::ModelKey::new(ModelType::ClaudeCode);
        key.session_token = Some("token".into());
        let initial = quota_credential_revision(&key);

        key.name = Some("Renamed account".into());
        key.account_metadata
            .insert("rate_limit_tier".into(), "pro".into());
        assert_eq!(initial, quota_credential_revision(&key));
    }

    #[test]
    fn quota_status_wire_shape_uses_frontend_camel_case() {
        let status = KeyQuotaRefreshStatusInfo {
            key_id: "account".into(),
            generation: 3,
            freshness: "fresh_success".into(),
            cache_expires_at: Some("2026-07-31T00:00:00Z".into()),
            last_good: Some(QuotaInfo::default()),
            last_good_at: Some("2026-07-31T00:00:00Z".into()),
            last_attempt: Some(KeyQuotaRefreshAttemptInfo {
                generation: 3,
                status: "succeeded".into(),
                started_at: "2026-07-31T00:00:00Z".into(),
                finished_at: Some("2026-07-31T00:00:01Z".into()),
                error: None,
            }),
        };
        let wire = serde_json::to_value(status).unwrap();

        assert_eq!(wire["keyId"], "account");
        assert!(wire.get("cacheExpiresAt").is_some());
        assert!(wire.get("lastGoodAt").is_some());
        assert!(wire["lastAttempt"].get("startedAt").is_some());
        assert!(wire.get("key_id").is_none());
    }
}

async fn fetch_quota_for_key(
    key: &crate::key_store::ModelKey,
) -> Result<crate::types::QuotaInfo, String> {
    match key.model_type {
        ModelType::CursorCli => {
            let token = key
                .session_token
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "Cursor account has no session token".to_string())?;
            CursorValidator::new().fetch_quota(token).await
        }
        ModelType::Copilot => {
            let token = key
                .api_key
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "Copilot account has no API key".to_string())?;
            CopilotValidator::new().fetch_quota(token).await
        }
        ModelType::ClaudeCode if key.auth_method == AuthMethod::Oauth => {
            let token = key
                .session_token
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "Claude Code OAuth account has no access token".to_string())?;
            ClaudeCodeQuotaFetcher::new().fetch_quota(token).await
        }
        ModelType::Codex if key.auth_method == AuthMethod::Oauth => {
            let token = key
                .session_token
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "Codex OAuth account has no access token".to_string())?;
            let refresh_token = key
                .env_vars
                .get(core_types::providers::CODEX_REFRESH_TOKEN_ENV_KEY)
                .map(String::as_str);
            let id_token = key
                .env_vars
                .get(core_types::providers::CODEX_ID_TOKEN_ENV_KEY)
                .map(String::as_str);
            CodexValidator::new()
                .fetch_oauth_quota(token, refresh_token, id_token)
                .await
        }
        ModelType::OpenCode => {
            let cookie =
                first_non_empty_secret(key.session_token.as_deref(), key.api_key.as_deref())
                    .ok_or_else(|| "OpenCode account has no session cookie".to_string())?;
            OpenCodeGoQuotaFetcher::new()
                .fetch_quota(cookie, workspace_id_override_from_key(key))
                .await
        }
        ModelType::ZhipuApi => {
            let token = key
                .api_key
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "Zhipu account has no API key".to_string())?;
            if let Some(scope) = team_scope_from_key(key) {
                ZaiTeamQuotaFetcher::new().fetch_quota(token, scope).await
            } else if has_partial_team_scope(key) {
                Err(format!(
                    "ZAI Team quota requires both {ZAI_TEAM_ORGANIZATION_METADATA_KEY} \
                     and {ZAI_TEAM_PROJECT_METADATA_KEY}"
                ))
            } else {
                ZhipuQuotaFetcher::new()
                    .fetch_quota(token, key.base_url.as_deref())
                    .await
            }
        }
        ModelType::DeepseekApi => {
            let token = key
                .api_key
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "DeepSeek account has no API key".to_string())?;
            DeepSeekQuotaFetcher::new().fetch_quota(token).await
        }
        ModelType::OpenrouterApi => {
            let token = key
                .api_key
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "OpenRouter account has no API key".to_string())?;
            OpenRouterQuotaFetcher::new().fetch_quota(token).await
        }
        ModelType::MinimaxApi => {
            let token = key
                .api_key
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "MiniMax account has no API key".to_string())?;
            MiniMaxQuotaFetcher::new()
                .fetch_quota(token, key.base_url.as_deref())
                .await
        }
        ModelType::MoonshotApi => {
            let token = key
                .api_key
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| "Kimi Code account has no API key".to_string())?;
            KimiCodeQuotaFetcher::new()
                .fetch_quota(token, key.base_url.as_deref())
                .await
        }
        ModelType::QoderCli => {
            let cookie =
                first_non_empty_secret(key.session_token.as_deref(), key.api_key.as_deref())
                    .ok_or_else(|| "Qoder account has no saved cookie or token".to_string())?;
            QoderQuotaFetcher::new()
                .fetch_quota(cookie, key.base_url.as_deref())
                .await
        }
        ref other => Err(format!(
            "{} does not have a quota refresh API",
            other.as_str()
        )),
    }
}

fn first_non_empty_secret<'a>(
    preferred: Option<&'a str>,
    fallback: Option<&'a str>,
) -> Option<&'a str> {
    preferred
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| fallback.map(str::trim).filter(|value| !value.is_empty()))
}

fn quota_refresh_uses_strict_request_count(key: &crate::key_store::ModelKey) -> bool {
    matches!(key.model_type, ModelType::QoderCli)
        || (key.model_type == ModelType::ZhipuApi && team_scope_from_key(key).is_some())
        || (key.model_type == ModelType::MoonshotApi
            && crate::providers::kimi::has_supported_base_url(key.base_url.as_deref()))
}

pub(super) fn key_can_refresh_quota(key: &crate::key_store::ModelKey) -> bool {
    let has_api_key = key
        .api_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let has_session_token = key
        .session_token
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    match key.model_type {
        ModelType::CursorCli => has_session_token,
        ModelType::Copilot
        | ModelType::DeepseekApi
        | ModelType::OpenrouterApi
        | ModelType::MinimaxApi => has_api_key,
        ModelType::MoonshotApi => {
            has_api_key && crate::providers::kimi::has_supported_base_url(key.base_url.as_deref())
        }
        ModelType::ZhipuApi => has_api_key && !has_partial_team_scope(key),
        ModelType::QoderCli => {
            (has_session_token || has_api_key)
                && crate::providers::qoder::has_supported_region(key.base_url.as_deref())
        }
        ModelType::OpenCode => has_session_token || has_api_key,
        ModelType::ClaudeCode | ModelType::Codex => {
            key.auth_method == AuthMethod::Oauth && has_session_token
        }
        _ => false,
    }
}

#[cfg(test)]
mod direct_quota_dispatch_tests {
    use super::*;

    #[tokio::test]
    async fn direct_provider_variants_reach_their_stored_key_dispatch_arms() {
        for (model_type, expected_provider, expected_secret) in [
            (ModelType::DeepseekApi, "DeepSeek", "no API key"),
            (ModelType::OpenrouterApi, "OpenRouter", "no API key"),
            (ModelType::MinimaxApi, "MiniMax", "no API key"),
            (ModelType::MoonshotApi, "Kimi Code", "no API key"),
            (ModelType::QoderCli, "Qoder", "no saved cookie or token"),
        ] {
            let key = crate::key_store::ModelKey::new(model_type);
            let error = fetch_quota_for_key(&key).await.unwrap_err();
            assert!(
                error.contains(expected_provider) && error.contains(expected_secret),
                "unexpected dispatch error: {error}"
            );
        }
    }

    #[tokio::test]
    async fn wave_two_providers_reach_validation_time_dispatch_arms() {
        for (agent_type, expected_provider) in [
            ("deepseek_api", "DeepSeek"),
            ("openrouter_api", "OpenRouter"),
            ("minimax_api", "MiniMax"),
        ] {
            let error = fetch_key_quota(agent_type.to_string(), " ".to_string())
                .await
                .unwrap_err();
            assert!(
                error.contains(expected_provider) && error.contains("no API key"),
                "unexpected dispatch error: {error}"
            );
        }
    }

    #[test]
    fn quota_refresh_capability_matches_supported_dispatches() {
        for model_type in [
            ModelType::CursorCli,
            ModelType::Copilot,
            ModelType::OpenCode,
            ModelType::ZhipuApi,
            ModelType::DeepseekApi,
            ModelType::OpenrouterApi,
            ModelType::MinimaxApi,
            ModelType::MoonshotApi,
            ModelType::QoderCli,
        ] {
            let is_kimi_code = model_type == ModelType::MoonshotApi;
            let mut key = crate::key_store::ModelKey::new(model_type);
            key.api_key = Some("api-key".to_string());
            key.session_token = Some("session-token".to_string());
            if is_kimi_code {
                key.base_url = Some("https://api.kimi.com/coding".to_string());
            }
            assert!(key_can_refresh_quota(&key));
        }

        let mut oauth_key = crate::key_store::ModelKey::new(ModelType::ClaudeCode);
        assert!(!key_can_refresh_quota(&oauth_key));
        oauth_key.auth_method = AuthMethod::Oauth;
        assert!(!key_can_refresh_quota(&oauth_key));
        oauth_key.session_token = Some("access-token".to_string());
        assert!(key_can_refresh_quota(&oauth_key));

        assert!(!key_can_refresh_quota(&crate::key_store::ModelKey::new(
            ModelType::AnthropicApi
        )));
    }

    #[test]
    fn zai_team_capability_requires_complete_scope_and_revision_tracks_it() {
        let mut key = crate::key_store::ModelKey::new(ModelType::ZhipuApi);
        key.api_key = Some("api-key".to_string());
        assert!(key_can_refresh_quota(&key));
        assert!(!quota_refresh_uses_strict_request_count(&key));
        let personal_revision = quota_credential_revision(&key);

        key.account_metadata
            .insert(ZAI_TEAM_ORGANIZATION_METADATA_KEY.into(), "org-1".into());
        assert!(!key_can_refresh_quota(&key));
        let partial_revision = quota_credential_revision(&key);
        assert_ne!(personal_revision, partial_revision);

        key.account_metadata
            .insert(ZAI_TEAM_PROJECT_METADATA_KEY.into(), "project-1".into());
        assert!(key_can_refresh_quota(&key));
        assert!(quota_refresh_uses_strict_request_count(&key));
        assert_ne!(partial_revision, quota_credential_revision(&key));
    }

    #[test]
    fn qoder_capability_requires_an_explicit_saved_secret() {
        let mut key = crate::key_store::ModelKey::new(ModelType::QoderCli);
        assert!(!key_can_refresh_quota(&key));
        key.session_token = Some("session=qoder".into());
        assert!(key_can_refresh_quota(&key));
        assert!(quota_refresh_uses_strict_request_count(&key));
        key.base_url = Some("https://example.com".into());
        assert!(!key_can_refresh_quota(&key));
    }

    #[test]
    fn kimi_code_capability_is_fixed_route_and_strict_one_attempt() {
        let mut key = crate::key_store::ModelKey::new(ModelType::MoonshotApi);
        key.api_key = Some("kimi-code-key".into());
        assert!(!key_can_refresh_quota(&key));
        assert!(!quota_refresh_uses_strict_request_count(&key));

        key.base_url = Some("https://api.moonshot.ai/v1".into());
        assert!(!key_can_refresh_quota(&key));
        assert!(!quota_refresh_uses_strict_request_count(&key));

        let ordinary_revision = quota_credential_revision(&key);
        key.base_url = Some("https://api.kimi.com/coding/".into());
        assert!(key_can_refresh_quota(&key));
        assert!(quota_refresh_uses_strict_request_count(&key));
        assert_ne!(ordinary_revision, quota_credential_revision(&key));
    }

    #[test]
    fn stored_cookie_resolution_skips_blank_preferred_values() {
        assert_eq!(
            first_non_empty_secret(Some("  "), Some(" fallback-cookie ")),
            Some("fallback-cookie")
        );
        assert_eq!(
            first_non_empty_secret(Some(" preferred-cookie "), Some("fallback-cookie")),
            Some("preferred-cookie")
        );
        assert_eq!(first_non_empty_secret(Some(" "), None), None);
    }
}

async fn refresh_oauth_key_for_quota(
    key: &crate::key_store::ModelKey,
) -> Result<crate::key_store::ModelKey, String> {
    let rejected_access_token = key.session_token.clone().unwrap_or_default();
    let outcome = match key.model_type {
        ModelType::ClaudeCode => {
            KEY_SERVICE
                .refresh_claude_code_oauth_key(&key.id, &rejected_access_token)
                .await
        }
        ModelType::Codex => {
            KEY_SERVICE
                .refresh_codex_oauth_key(&key.id, &rejected_access_token)
                .await
        }
        ref other => Err(format!(
            "OAuth quota refresh is not supported for {}",
            other.as_str()
        )),
    }?;
    outcome
        .into_key()
        .ok_or_else(|| format!("Key {} is not a native OAuth account", key.id))
}

fn is_unauthorized_quota_error(error_message: &str) -> bool {
    let lower = error_message.to_lowercase();
    lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("expired")
}

/// Auto-detect keys from local config files and environment variables
#[tauri::command]
pub async fn auto_detect_key(
    agent_type: String,
) -> Result<crate::auto_detect::AutoDetectResult, String> {
    Ok(crate::auto_detect::auto_detect_key(&agent_type).await)
}

/// Extract API key and base URL from raw text input using regex.
#[tauri::command]
pub fn extract_keys_from_text(
    input: String,
    agent_type: Option<String>,
) -> crate::key_extractor::ExtractionResult {
    crate::key_extractor::extract_keys(&input, agent_type.as_deref())
}

/// Get available models for Cursor CLI via local CLI command.
/// This calls `cursor agent --list-models` to get the actual models available
/// for the given API key. Used when listing on market to get real model list.
#[tauri::command]
pub async fn get_cursor_cli_models(api_key: String) -> Result<Vec<String>, String> {
    use log::info;
    info!("[get_cursor_cli_models] Fetching models via CLI...");

    let validator = CursorValidator::new();
    let models = validator.get_available_models(&api_key).await?;

    info!(
        "[get_cursor_cli_models] Got {} models from CLI",
        models.len()
    );
    Ok(models)
}

/// Get available models by calling Cursor's native API directly.
///
/// Hits `api2.cursor.sh/aiserver.v1.AiService/GetUsableModels` with the
/// account's session JWT as bearer. Does NOT require the local `cursor` CLI
/// to be installed. Returns the full model catalog the account can see
/// (subscription filtering happens at chat time, not discovery time).
///
/// Preferred over `get_cursor_cli_models` when a session token is available.
#[tauri::command]
pub async fn cursor_list_models_native(
    session_token: String,
) -> Result<Vec<crate::providers::cursor::CursorNativeModel>, String> {
    use log::info;
    info!("[cursor_list_models_native] Fetching models via api2.cursor.sh...");

    let validator = CursorValidator::new();
    let models = validator.get_native_models(&session_token).await?;

    info!(
        "[cursor_list_models_native] Got {} models from native API",
        models.len()
    );
    Ok(models)
}

fn oauth_static_catalog(
    agent_type: &str,
) -> Option<(&'static [&'static str], &'static [&'static str])> {
    match agent_type {
        "claude_code" => Some((
            super::crud::CLAUDE_CODE_OAUTH_MODELS,
            super::crud::CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS,
        )),
        "codex" => Some((
            super::crud::CODEX_OAUTH_MODELS,
            super::crud::CODEX_OAUTH_DEFAULT_ENABLED_MODELS,
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

pub(super) fn resolved_oauth_catalog(
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

fn is_oauth_discovery_auth_error(error: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::install_crypto_provider_for_tests;

    // ── default_base_url_for_provider ─────────────────────────────────
    //
    // Regression guard: the helper must strip a trailing `/v1` segment
    // because `OpenAIValidator::validate` re-appends `/v1/models` itself.
    // A pass-through here would silently produce `…/v1/v1/models`.

    #[test]
    fn default_base_url_strips_trailing_v1() {
        assert_eq!(
            default_base_url_for_provider("openai_api"),
            Some("https://api.openai.com".to_string())
        );
        assert_eq!(
            default_base_url_for_provider("anthropic_api"),
            Some("https://api.anthropic.com".to_string())
        );
        assert_eq!(
            default_base_url_for_provider("groq_api"),
            Some("https://api.groq.com/openai".to_string())
        );
        assert_eq!(
            default_base_url_for_provider("xai_api"),
            Some("https://api.x.ai".to_string())
        );
        assert_eq!(
            default_base_url_for_provider("atlascloud_api"),
            Some("https://api.atlascloud.ai".to_string())
        );
    }

    #[test]
    fn default_base_url_keeps_url_without_v1_suffix() {
        // deepseek_api's default base URL is "https://api.deepseek.com" — no /v1 to strip.
        assert_eq!(
            default_base_url_for_provider("deepseek_api"),
            Some("https://api.deepseek.com".to_string())
        );
    }

    #[test]
    fn default_base_url_returns_none_for_no_default() {
        // Azure providers have no default — user must supply their endpoint.
        assert_eq!(default_base_url_for_provider("azure_openai_api"), None);
        assert_eq!(default_base_url_for_provider("azure_anthropic_api"), None);
        // CLI agents also return no default (config has default_base_url: None).
        assert_eq!(default_base_url_for_provider("cursor_cli"), None);
        assert_eq!(default_base_url_for_provider("claude_code"), None);
    }

    #[test]
    fn default_base_url_unknown_provider_returns_none() {
        assert_eq!(default_base_url_for_provider("not_a_real_provider"), None);
    }

    #[test]
    fn oauth_auth_failures_are_not_hidden_by_the_fallback_catalog() {
        for error in [
            "HTTP 401",
            "HTTP 403",
            "unauthorized",
            "forbidden",
            "invalid credential",
            "invalid token",
            "access denied",
            "token expired",
        ] {
            assert!(is_oauth_discovery_auth_error(error), "{error}");
        }
        assert!(!is_oauth_discovery_auth_error("request timed out"));
    }

    #[test]
    fn opencode_base_url_defaults_to_zen_and_respects_selection() {
        assert_eq!(resolve_opencode_base_url(None), OPENCODE_ZEN_BASE_URL);
        assert_eq!(
            resolve_opencode_base_url(Some(OPENCODE_ZEN_BASE_URL)),
            OPENCODE_ZEN_BASE_URL
        );
        assert_eq!(
            resolve_opencode_base_url(Some(OPENCODE_GO_BASE_URL)),
            OPENCODE_GO_BASE_URL
        );
    }

    // ── validate_token_format dispatch ────────────────────────────────
    //
    // Pure dispatch — no network, no `reqwest::Client` constructed.
    // Walks every accepted agent_type to ensure the match arms keep
    // routing to *some* validator (not the unknown-type error path).

    fn ok_format(agent_type: &str, token: &str) -> (bool, String) {
        validate_token_format(agent_type.to_string(), token.to_string())
            .unwrap_or_else(|err| panic!("validate_token_format({agent_type}) errored: {err}"))
    }

    #[test]
    fn validate_token_format_routes_canonical_cli_agents() {
        // Every CLI-agent arm constructs a `<Validator>::new()` (which
        // builds a `reqwest::Client`), so a crypto provider must be set
        // even though we never make a network call.
        install_crypto_provider_for_tests();
        for agent in [
            "copilot",
            "cursor_cli",
            "openai",
            "codex",
            "anthropic",
            "claude_code",
            "google",
            "kiro",
            "opencode",
        ] {
            let _ = ok_format(agent, "some-token-1234567890");
        }
    }

    #[test]
    fn validate_token_format_routes_aliases() {
        install_crypto_provider_for_tests();
        // Each alias must accept the same input as its canonical name.
        // Just asserting "no error" — actual format rules are validator-specific.
        let _ = ok_format("github_copilot", "ghp_xxxxxxxxxx");
        let _ = ok_format("cursor", "key_xxxxxxxxxxxxxxxxxxxx");
    }

    #[test]
    fn validate_token_format_routes_api_suffix_providers() {
        install_crypto_provider_for_tests();
        for agent in [
            "openai_api",
            "anthropic_api",
            "gemini_api",
            "azure_openai_api",
            "azure_anthropic_api",
        ] {
            let _ = ok_format(agent, "sk-xxxxxxxxxxxxxxxxxxxx");
        }
    }

    #[test]
    fn validate_token_format_openai_compat_cluster_rejects_empty() {
        // The OpenAI-compat cluster shares one length-only check.
        for agent in [
            "deepseek_api",
            "groq_api",
            "xai_api",
            "atlascloud_api",
            "zhipu_api",
            "dashscope_api",
            "moonshot_api",
            "minimax_api",
            "longcat_api",
            "openrouter_api",
            "zenmux_api",
            "vllm_api",
            "orgii_orchestrator",
            "orgii",
        ] {
            let (valid, msg) = ok_format(agent, "");
            assert!(!valid, "{agent} accepted empty token");
            assert!(msg.contains("required"), "{agent} message: {msg}");
        }
    }

    #[test]
    fn validate_token_format_openai_compat_cluster_rejects_short() {
        for agent in [
            "deepseek_api",
            "groq_api",
            "xai_api",
            "atlascloud_api",
            "zhipu_api",
            "dashscope_api",
            "moonshot_api",
            "minimax_api",
            "longcat_api",
            "openrouter_api",
            "zenmux_api",
            "vllm_api",
            "orgii_orchestrator",
            "orgii",
        ] {
            // 7 chars is below the 8-char minimum.
            let (valid, msg) = ok_format(agent, "abc1234");
            assert!(!valid, "{agent} accepted 7-char token");
            assert!(msg.contains("short"), "{agent} message: {msg}");
        }
    }

    #[test]
    fn validate_token_format_openai_compat_cluster_accepts_long_enough() {
        for agent in [
            "deepseek_api",
            "groq_api",
            "xai_api",
            "atlascloud_api",
            "longcat_api",
            "orgii_orchestrator",
            "orgii",
        ] {
            // 8+ chars passes the length-only check.
            let (valid, msg) = ok_format(agent, "abcd1234efgh");
            assert!(valid, "{agent} rejected long-enough token (msg: {msg})");
        }
    }

    #[test]
    fn validate_token_format_unknown_returns_err() {
        let res = validate_token_format("totally_made_up".into(), "tok".into());
        let err = res.expect_err("unknown agent type must Err");
        assert!(err.contains("totally_made_up"), "err was: {err}");
    }

    // ── run_validate_key dispatch (unknown-type only) ─────────────────
    //
    // The known-type arms each construct a `reqwest::Client` (so they
    // need the crypto-provider bootstrap and live network), but the
    // unknown-type error path is pure string formatting — keep it here
    // as a cheap regression guard for the Err message contract.

    #[tokio::test]
    async fn run_validate_key_unknown_agent_type_errs_with_listing() {
        let err = run_validate_key(
            "definitely_not_real".into(),
            "sk-xxx".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("unknown agent_type must Err");

        assert!(err.contains("definitely_not_real"), "err was: {err}");
        // The error message also enumerates supported types — guard the
        // most stable canonical names against accidental drops.
        assert!(err.contains("openai_api"), "missing openai_api: {err}");
        assert!(
            err.contains("anthropic_api"),
            "missing anthropic_api: {err}"
        );
        assert!(err.contains("cursor_cli"), "missing cursor_cli: {err}");
    }
}
