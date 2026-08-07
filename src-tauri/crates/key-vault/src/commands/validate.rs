use serde::{Deserialize, Serialize};

use crate::types::ValidationResult;

use crate::commands::crud::key_info_from_entry;
use crate::key_store::{AuthMethod, HealthStatus, ModelType, KEY_SERVICE};
use crate::providers::anthropic::AnthropicValidator;
use crate::providers::azure_openai::AzureOpenAIValidator;
use crate::providers::claude_code::ClaudeCodeQuotaFetcher;
use crate::providers::codex::CodexValidator;
use crate::providers::copilot::CopilotValidator;
use crate::providers::cursor::CursorValidator;
use crate::providers::google::GoogleValidator;
use crate::providers::kiro::KiroValidator;
use crate::providers::openai::OpenAIValidator;
use crate::providers::opencode_go::{workspace_id_override_from_key, OpenCodeGoQuotaFetcher};
use crate::providers::zhipu::ZhipuQuotaFetcher;

#[derive(Debug, Serialize)]
pub struct TestModelResult {
    pub available: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthModelsResponse {
    #[serde(default)]
    data: Vec<ClaudeCodeOauthModelInfo>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthModelInfo {
    id: String,
}

#[derive(Debug, Deserialize)]
pub struct CodexOauthListModelsRequest {
    pub access_token: String,
    pub id_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OAuthModelCatalogRequest {
    pub agent_type: String,
}

#[derive(Debug, Serialize)]
pub struct OAuthModelCatalogResponse {
    pub models: Vec<String>,
    pub default_enabled_models: Vec<String>,
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

const CLAUDE_CODE_OAUTH_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const CLAUDE_CODE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_CODE_OAUTH_USER_AGENT: &str = "claude-cli/2.1.78 (orgii, cli)";
pub const OPENCODE_ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
pub const OPENCODE_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

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
        "deepseek_api" | "groq_api" | "xai_api" | "zhipu_api" | "dashscope_api"
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
            "Unknown agent type: {}. Supported: copilot, cursor_cli, openai, anthropic, google, codex, claude_code, kiro, opencode, openai_api, anthropic_api, gemini_api, deepseek_api, groq_api, xai_api, zhipu_api, dashscope_api, moonshot_api, minimax_api, longcat_api, openrouter_api, zenmux_api, siliconflow_api, modelscope_api, aihubmix_api, cherryin_api, bedrock_api, custom_api, vllm_api, azure_openai_api, azure_anthropic_api",
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
        "deepseek_api" | "groq_api" | "xai_api" | "zhipu_api" | "dashscope_api"
        | "moonshot_api" | "minimax_api" | "longcat_api" | "openrouter_api" | "zenmux_api"
        | "vllm_api" | "orgii_orchestrator" | "orgii" => {
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
        // Other providers don't have public quota APIs
        "openai"
        | "anthropic"
        | "claude_code"
        | "google"
        | "codex"
        | "kiro"
        | "openai_api"
        | "anthropic_api"
        | "gemini_api"
        | "deepseek_api"
        | "groq_api"
        | "xai_api"
        | "dashscope_api"
        | "moonshot_api"
        | "minimax_api"
        | "longcat_api"
        | "openrouter_api"
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
pub async fn refresh_key_quota(key_id: String) -> Result<Option<crate::commands::KeyInfo>, String> {
    let key = KEY_SERVICE
        .get_key_by_id(&key_id)
        .ok_or_else(|| format!("Key not found: {}", key_id))?;

    let quota = if key.model_type == ModelType::ClaudeCode && key.auth_method == AuthMethod::Oauth {
        let token = key
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
                let refreshed = refresh_oauth_key_for_quota(&key).await?;
                let retry_token = refreshed
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

        if !refresh.account_metadata.is_empty() {
            KEY_SERVICE.merge_key_account_metadata(&key_id, refresh.account_metadata)?;
        }

        refresh.quota
    } else {
        match fetch_quota_for_key(&key).await {
            Ok(quota) => quota,
            Err(first_err)
                if key.auth_method == AuthMethod::Oauth
                    && is_unauthorized_quota_error(&first_err) =>
            {
                let refreshed = refresh_oauth_key_for_quota(&key).await?;
                fetch_quota_for_key(&refreshed).await?
            }
            Err(first_err) => return Err(first_err),
        }
    };

    let quota_value = serde_json::to_value(quota)
        .map_err(|err| format!("Failed to serialize quota info: {err}"))?;

    let updated = KEY_SERVICE.update_key_health(
        &key_id,
        HealthStatus::Valid,
        None,
        None,
        None,
        Some(quota_value),
        None,
    )?;

    updated.map(key_info_from_entry).transpose()
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
            let cookie = key
                .session_token
                .as_deref()
                .or(key.api_key.as_deref())
                .filter(|token| !token.trim().is_empty())
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
            ZhipuQuotaFetcher::new()
                .fetch_quota(token, key.base_url.as_deref())
                .await
        }
        ref other => Err(format!(
            "{} does not have a quota refresh API",
            other.as_str()
        )),
    }
}

async fn refresh_oauth_key_for_quota(
    key: &crate::key_store::ModelKey,
) -> Result<crate::key_store::ModelKey, String> {
    let rejected_access_token = key.session_token.clone().unwrap_or_default();
    match key.model_type {
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
    }
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

async fn claude_code_oauth_list_models_from_url(
    access_token: &str,
    models_url: &str,
) -> Result<Vec<String>, String> {
    let token = access_token.trim();
    if token.is_empty() {
        return Err("Claude Code OAuth access token is empty".to_string());
    }

    let response = reqwest::Client::new()
        .get(models_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", CLAUDE_CODE_OAUTH_BETA)
        .header("User-Agent", CLAUDE_CODE_OAUTH_USER_AGENT)
        .header("x-app", "cli")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("Claude Code OAuth model discovery request failed: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Claude Code OAuth model discovery body read failed: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "Claude Code OAuth model discovery failed: HTTP {}: {}",
            status.as_u16(),
            body
        ));
    }

    parse_claude_code_oauth_models_response(&body)
}

fn merge_default_catalog(mut models: Vec<String>, defaults: &[&str]) -> Vec<String> {
    for model in defaults {
        let model = (*model).to_string();
        if !models.contains(&model) {
            models.push(model);
        }
    }
    models
}

fn parse_claude_code_oauth_models_response(body: &str) -> Result<Vec<String>, String> {
    let parsed: ClaudeCodeOauthModelsResponse = serde_json::from_str(body)
        .map_err(|err| format!("Claude Code OAuth model discovery parse failed: {err}"))?;
    let mut models = Vec::new();
    for model in parsed.data {
        if !model.id.is_empty() && !models.contains(&model.id) {
            models.push(model.id);
        }
    }
    Ok(models)
}

#[tauri::command]
pub fn oauth_model_catalog(
    request: OAuthModelCatalogRequest,
) -> Result<OAuthModelCatalogResponse, String> {
    match request.agent_type.as_str() {
        "claude_code" => Ok(OAuthModelCatalogResponse {
            models: super::crud::CLAUDE_CODE_OAUTH_MODELS
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
            default_enabled_models: super::crud::CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
        }),
        "codex" => Ok(OAuthModelCatalogResponse {
            models: super::crud::CODEX_OAUTH_MODELS
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
            default_enabled_models: super::crud::CODEX_OAUTH_DEFAULT_ENABLED_MODELS
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
        }),
        other => Err(format!(
            "Unsupported OAuth model catalog agent type: {other}"
        )),
    }
}

#[tauri::command]
pub async fn claude_code_oauth_list_models(access_token: String) -> Result<Vec<String>, String> {
    use log::info;
    info!("[claude_code_oauth_list_models] Fetching models via Anthropic OAuth...");
    let models = merge_default_catalog(
        claude_code_oauth_list_models_from_url(&access_token, CLAUDE_CODE_OAUTH_MODELS_URL).await?,
        super::crud::CLAUDE_CODE_OAUTH_MODELS,
    );
    info!(
        "[claude_code_oauth_list_models] Got {} models from Anthropic OAuth",
        models.len()
    );
    Ok(models)
}

#[tauri::command]
pub async fn codex_oauth_list_models(
    request: CodexOauthListModelsRequest,
) -> Result<Vec<String>, String> {
    use log::info;
    info!("[codex_oauth_list_models] Fetching models via Codex native backend...");
    let validator = CodexValidator::new();
    let models = merge_default_catalog(
        validator
            .list_models(&request.access_token, request.id_token.as_deref())
            .await?,
        super::crud::CODEX_OAUTH_MODELS,
    );
    info!(
        "[codex_oauth_list_models] Got {} models from Codex native backend",
        models.len()
    );
    Ok(models)
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
    fn claude_code_oauth_models_response_parses_and_deduplicates_ids() {
        let models = parse_claude_code_oauth_models_response(
            r#"{
                "data": [
                    { "id": "claude-sonnet-4-6", "type": "model" },
                    { "id": "claude-opus-4-7", "type": "model" },
                    { "id": "claude-sonnet-4-6", "type": "model" },
                    { "id": "", "type": "model" }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(
            models,
            vec![
                "claude-sonnet-4-6".to_string(),
                "claude-opus-4-7".to_string()
            ]
        );
    }

    #[test]
    fn claude_code_oauth_models_response_rejects_invalid_json() {
        let err = parse_claude_code_oauth_models_response("not json").unwrap_err();
        assert!(err.contains("parse failed"));
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
