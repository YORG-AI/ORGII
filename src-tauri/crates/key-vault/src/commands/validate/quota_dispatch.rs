use crate::key_store::{AuthMethod, ModelType};
use crate::providers::claude_code::ClaudeCodeQuotaFetcher;
use crate::providers::codex::CodexValidator;
use crate::providers::copilot::CopilotValidator;
use crate::providers::cursor::CursorValidator;
use crate::providers::deepseek::DeepSeekQuotaFetcher;
use crate::providers::kimi::KimiCodeQuotaFetcher;
use crate::providers::minimax::MiniMaxQuotaFetcher;
use crate::providers::opencode_go::{workspace_id_override_from_key, OpenCodeGoQuotaFetcher};
use crate::providers::openrouter::OpenRouterQuotaFetcher;
use crate::providers::qoder::QoderQuotaFetcher;
use crate::providers::zai_team::{
    has_partial_team_scope, team_scope_from_key, ZaiTeamQuotaFetcher,
    ORGANIZATION_METADATA_KEY as ZAI_TEAM_ORGANIZATION_METADATA_KEY,
    PROJECT_METADATA_KEY as ZAI_TEAM_PROJECT_METADATA_KEY,
};
use crate::providers::zhipu::ZhipuQuotaFetcher;

// Exercised by the moved `direct_quota_dispatch_tests` module below.
#[cfg(test)]
use super::quota_refresh::quota_credential_revision;

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

pub(super) async fn fetch_quota_for_key(
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

pub(super) fn quota_refresh_uses_strict_request_count(key: &crate::key_store::ModelKey) -> bool {
    matches!(key.model_type, ModelType::QoderCli)
        || (key.model_type == ModelType::ZhipuApi && team_scope_from_key(key).is_some())
        || (key.model_type == ModelType::MoonshotApi
            && crate::providers::kimi::has_supported_base_url(key.base_url.as_deref()))
}

pub(in crate::commands) fn key_can_refresh_quota(key: &crate::key_store::ModelKey) -> bool {
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
#[path = "../tests/direct_quota_dispatch_tests.rs"]
mod direct_quota_dispatch_tests;
