use serde::Serialize;

use crate::types::ValidationResult;

use crate::provider_config::get_provider_config;
use crate::providers::anthropic::AnthropicValidator;
use crate::providers::azure_openai::AzureOpenAIValidator;
use crate::providers::codex::CodexValidator;
use crate::providers::copilot::CopilotValidator;
use crate::providers::cursor::CursorValidator;
use crate::providers::google::GoogleValidator;
use crate::providers::kiro::KiroValidator;
use crate::providers::openai::OpenAIValidator;

use super::opencode::validate_opencode_key;

#[derive(Debug, Serialize)]
pub struct TestModelResult {
    pub available: bool,
    pub message: String,
}

/// Get the default base URL for a provider (without /v1 suffix for OpenAI-compat validation).
/// Uses the unified provider_config module as the single source of truth.
pub(super) fn default_base_url_for_provider(agent_type: &str) -> Option<String> {
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
