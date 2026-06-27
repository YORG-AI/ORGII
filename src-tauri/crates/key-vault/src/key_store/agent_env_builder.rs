use std::collections::HashMap;

use super::service::KeyService;
use super::types::{AuthMethod, ModelType};
use core_types::providers::KIMI_CODE_URL_FRAGMENT;

const ZENMUX_OPENAI_BASE_URL: &str = "https://zenmux.ai/api/v1";
const ZENMUX_ANTHROPIC_BASE_URL: &str = "https://zenmux.ai/api/anthropic";

impl KeyService {
    /// Get environment variables for running an agent
    pub fn get_env_for_agent(
        &self,
        agent_type: &ModelType,
        key_id: Option<&str>,
    ) -> HashMap<String, String> {
        let entry = match self.get_key(agent_type, key_id) {
            Some(e) => e,
            None => match key_id.and_then(|id| self.get_key_by_id(id)) {
                Some(e) => e,
                None => return HashMap::new(),
            },
        };

        // Honour the master enable switch: a disabled account must not
        // contribute env vars even if the caller targets it explicitly.
        // Mirrors the gate already enforced in
        // `find_credential_by_available_model` so the two routing paths
        // agree on what "disabled" means.
        if !entry.enabled {
            tracing::debug!(
                "[agent_env_builder] Skipping disabled key id={} agent_type={}",
                entry.id,
                entry.model_type.as_str()
            );
            return HashMap::new();
        }

        let is_cross_type = &entry.model_type != agent_type;
        let mut env = entry.env_vars.clone();

        // Add agent-specific env vars
        match agent_type {
            ModelType::CursorCli => match (entry.api_key.as_ref(), entry.session_token.as_ref()) {
                (Some(key), Some(token)) => {
                    env.insert("CURSOR_API_KEY".to_string(), key.clone());
                    env.insert("CURSOR_SESSION_TOKEN".to_string(), token.clone());
                }
                (Some(key), None) => {
                    env.insert("CURSOR_API_KEY".to_string(), key.clone());
                    tracing::warn!(
                        "[agent_env_builder] Cursor key {} has no session_token; quota tracking will be unavailable",
                        entry.id
                    );
                }
                (None, Some(token)) => {
                    env.insert("CURSOR_SESSION_TOKEN".to_string(), token.clone());
                    tracing::info!(
                        "[agent_env_builder] Cursor key {} uses session_token without CURSOR_API_KEY",
                        entry.id
                    );
                }
                (None, None) => {
                    tracing::error!(
                        "[agent_env_builder] Cursor key {} has neither api_key nor session_token",
                        entry.id
                    );
                }
            },
            ModelType::ClaudeCode => {
                if entry.auth_method == AuthMethod::Oauth {
                    if let Some(token) = entry
                        .session_token
                        .as_deref()
                        .filter(|token| !token.is_empty())
                    {
                        env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), token.to_string());
                    }
                } else if let Some(ref key) = entry.api_key {
                    env.insert("ANTHROPIC_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = entry.base_url {
                    env.insert("ANTHROPIC_BASE_URL".to_string(), url.clone());
                } else if entry.model_type == ModelType::ZenmuxApi {
                    env.insert(
                        "ANTHROPIC_BASE_URL".to_string(),
                        ZENMUX_ANTHROPIC_BASE_URL.to_string(),
                    );
                }
                // When using a compatible provider key (e.g. moonshot_api), Claude Code's
                // model validation rejects provider-specific model names like "kimi-for-coding".
                // Override all pinned model slots so the CLI uses the provider's model name
                // directly, and disable beta headers that the provider's endpoint may reject.
                //
                // Precedence for the override model:
                //   1. `enabled_models[0]` — the user's curated choice from the KeyVault UI.
                //      A key's probe may return a long list of models the proxy advertises
                //      but the user only marks a subset as "enabled" via the toggle list.
                //      Honour that selection so a disabled-but-still-listed legacy model
                //      (e.g. `claude-3-5-sonnet-20240620`) cannot be silently picked.
                //   2. `available_models[0]` — fallback for keys that have not been
                //      curated yet (every model is implicitly available).
                //   3. base_url inference — last-resort for proxies that don't expose
                //      `/v1/models` at all (e.g. Kimi Code).
                if is_cross_type {
                    let override_model = entry
                        .enabled_models
                        .first()
                        .cloned()
                        .or_else(|| entry.available_models.first().cloned())
                        .or_else(|| {
                            // Infer default model from base_url for known Anthropic-compatible providers.
                            // Kimi Code endpoint: https://api.kimi.com/coding/ → kimi-for-coding
                            entry.base_url.as_deref().and_then(|url| {
                                if url.contains(KIMI_CODE_URL_FRAGMENT) {
                                    Some("kimi-for-coding".to_string())
                                } else {
                                    None
                                }
                            })
                        });
                    if let Some(model_id) = override_model {
                        env.insert(
                            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
                            model_id.clone(),
                        );
                        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), model_id.clone());
                        env.insert(
                            "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
                            model_id.clone(),
                        );
                        env.insert("ANTHROPIC_MODEL".to_string(), model_id);
                    }
                    env.insert(
                        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string(),
                        "1".to_string(),
                    );
                    env.insert("DISABLE_INTERLEAVED_THINKING".to_string(), "1".to_string());
                }
            }
            ModelType::Codex => {
                // Token sources (in priority order):
                // 1. entry.api_key — explicit API key or market-publish path.
                // 2. entry.session_token — OAuth Sign-In wizard (access token
                //    captured by CodexSetup and stored as oauth_session_token).
                // The refresh/id tokens are stored in env_vars (OPENAI_REFRESH_TOKEN,
                // OPENAI_ID_TOKEN, OPENAI_EXPIRES_IN) and passed through automatically.
                let token = entry
                    .api_key
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        entry
                            .session_token
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    });
                if let Some(key) = token {
                    env.insert("OPENAI_API_KEY".to_string(), key);
                }
                if let Some(ref url) = entry.base_url {
                    env.insert("OPENAI_BASE_URL".to_string(), url.clone());
                } else if entry.model_type == ModelType::ZenmuxApi {
                    env.insert(
                        "OPENAI_BASE_URL".to_string(),
                        ZENMUX_OPENAI_BASE_URL.to_string(),
                    );
                }
            }
            ModelType::GeminiCli => {
                if entry.auth_method == AuthMethod::Oauth {
                    if let Some(token) = entry
                        .session_token
                        .as_deref()
                        .filter(|token| !token.trim().is_empty())
                    {
                        env.insert("GEMINI_ACCESS_TOKEN".to_string(), token.to_string());
                    }
                } else if let Some(ref key) = entry.api_key {
                    env.insert("GEMINI_API_KEY".to_string(), key.clone());
                    env.insert("GOOGLE_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = entry.base_url {
                    env.insert("GEMINI_BASE_URL".to_string(), url.clone());
                }
            }
            ModelType::Copilot => {
                // Token sources (in priority order):
                // 1. entry.api_key — legacy market-publish path.
                // 2. entry.session_token — OAuth Sign-In wizard (crud
                //    normaliser moves the captured token here when
                //    auth_method=oauth).
                // 3. env_vars[GITHUB_TOKEN] — explicit env-var mirror set
                //    by the wizard on capture.
                let token = entry
                    .api_key
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        entry
                            .session_token
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    })
                    .or_else(|| env.get("GITHUB_TOKEN").cloned());
                if let Some(token) = token {
                    env.insert("GITHUB_TOKEN".to_string(), token.clone());
                    env.insert("GH_TOKEN".to_string(), token);
                }
            }
            ModelType::Kiro => {
                if let Some(token) = entry
                    .session_token
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    if token.trim_start().starts_with('{') {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(token) {
                            if let Some(access_token) = parsed
                                .get("access_token")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert(
                                    "KIRO_ACCESS_TOKEN".to_string(),
                                    access_token.to_string(),
                                );
                            }
                            if let Some(refresh_token) = parsed
                                .get("refresh_token")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert(
                                    "KIRO_REFRESH_TOKEN".to_string(),
                                    refresh_token.to_string(),
                                );
                            }
                            if let Some(expires_at) = parsed
                                .get("expires_at")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert("KIRO_EXPIRES_AT".to_string(), expires_at.to_string());
                            }
                            if let Some(region) = parsed
                                .get("region")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert("KIRO_REGION".to_string(), region.to_string());
                            }
                            if let Some(start_url) = parsed
                                .get("start_url")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert("KIRO_START_URL".to_string(), start_url.to_string());
                            }
                            if let Some(client_id) = parsed
                                .get("client_id")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert("KIRO_CLIENT_ID".to_string(), client_id.to_string());
                            }
                            if let Some(client_secret) = parsed
                                .get("client_secret")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.is_empty())
                            {
                                env.insert(
                                    "KIRO_CLIENT_SECRET".to_string(),
                                    client_secret.to_string(),
                                );
                            }
                        }
                    } else {
                        env.insert("KIRO_ACCESS_TOKEN".to_string(), token.to_string());
                    }
                }
                if let Some(api_key) = entry.api_key.as_deref().filter(|value| !value.is_empty()) {
                    if entry.auth_method == AuthMethod::Oauth {
                        env.insert("KIRO_REFRESH_TOKEN".to_string(), api_key.to_string());
                    } else {
                        env.insert("KIRO_API_KEY".to_string(), api_key.to_string());
                    }
                }
            }
            ModelType::KimiCli => {
                if let Some(ref key) = entry.api_key {
                    env.insert("MOONSHOT_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = entry.base_url {
                    env.insert("MOONSHOT_BASE_URL".to_string(), url.clone());
                }
            }
            ModelType::OpenCode => {
                if let Some(ref key) = entry.api_key {
                    env.insert("OPENCODE_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = entry.base_url {
                    env.insert("OPENCODE_BASE_URL".to_string(), url.clone());
                }
            }
            // API key providers: store api_key under the provider's env var name
            ModelType::AnthropicApi
            | ModelType::OpenaiApi
            | ModelType::DeepseekApi
            | ModelType::GeminiApi
            | ModelType::GroqApi
            | ModelType::XaiApi
            | ModelType::ZhipuApi
            | ModelType::DashscopeApi
            | ModelType::MoonshotApi
            | ModelType::MinimaxApi
            | ModelType::OpenrouterApi
            | ModelType::ZenmuxApi
            | ModelType::VllmApi
            | ModelType::AzureOpenaiApi
            | ModelType::AzureAnthropicApi
            | ModelType::OrgiiOrchestrator => {
                // The outer match already pinned `agent_type` to one of
                // the API-provider variants below, so the inner match
                // is exhaustive in practice. Use `unreachable!` for the
                // catch-all so a future API-provider variant added to
                // the outer arm without a matching env-var name fails
                // the build / panics in tests instead of silently
                // exporting the wrong env var (`API_KEY`) and breaking
                // every CLI agent that consumes the key.
                let env_key = match agent_type {
                    ModelType::AnthropicApi => "ANTHROPIC_API_KEY",
                    ModelType::OpenaiApi => "OPENAI_API_KEY",
                    ModelType::DeepseekApi => "DEEPSEEK_API_KEY",
                    ModelType::GeminiApi => "GEMINI_API_KEY",
                    ModelType::GroqApi => "GROQ_API_KEY",
                    ModelType::XaiApi => "XAI_API_KEY",
                    ModelType::ZhipuApi => "ZHIPU_API_KEY",
                    ModelType::DashscopeApi => "DASHSCOPE_API_KEY",
                    ModelType::MoonshotApi => "MOONSHOT_API_KEY",
                    ModelType::MinimaxApi => "MINIMAX_API_KEY",
                    ModelType::OpenrouterApi => "OPENROUTER_API_KEY",
                    ModelType::ZenmuxApi => "ZENMUX_API_KEY",
                    ModelType::VllmApi => "VLLM_API_KEY",
                    ModelType::AzureOpenaiApi => "AZURE_OPENAI_API_KEY",
                    ModelType::AzureAnthropicApi => "AZURE_ANTHROPIC_API_KEY",
                    ModelType::OrgiiOrchestrator => "ORGII_API_KEY",
                    other => unreachable!(
                        "agent_env_builder inner match must cover every API-provider variant; \
                         got {:?}",
                        other
                    ),
                };
                if let Some(ref key) = entry.api_key {
                    env.insert(env_key.to_string(), key.clone());
                }
                if let Some(ref url) = entry.base_url {
                    env.insert(
                        format!("{}_BASE_URL", env_key.trim_end_matches("_API_KEY")),
                        url.clone(),
                    );
                }
            }
        }

        env
    }

    /// Build environment variables for running a CLI agent through the ORGII proxy.
    ///
    /// Uses the proxy token as the API key and proxy URL as the base URL.
    /// Matches the env var patterns from the market worker's
    /// `_get_proxy_credentials()` in `session_worker.py`.
    pub fn get_proxy_env_for_agent(
        agent_type: &ModelType,
        proxy_token: &str,
        proxy_url: &str,
    ) -> HashMap<String, String> {
        let mut env = HashMap::new();

        // Common proxy env vars
        env.insert("ORGII_PROXY_TOKEN".to_string(), proxy_token.to_string());
        env.insert("ORGII_PROXY_URL".to_string(), proxy_url.to_string());
        env.insert("CI".to_string(), "true".to_string());
        env.insert("ORGII_NON_INTERACTIVE".to_string(), "true".to_string());

        match agent_type {
            ModelType::CursorCli => {
                env.insert("CURSOR_API_KEY".to_string(), proxy_token.to_string());
            }
            ModelType::ClaudeCode => {
                env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), proxy_token.to_string());
                env.insert("ANTHROPIC_BASE_URL".to_string(), proxy_url.to_string());
            }
            ModelType::Codex => {
                env.insert("OPENAI_API_KEY".to_string(), proxy_token.to_string());
                env.insert("PROXY_TOKEN".to_string(), proxy_token.to_string());
                // Note: OPENAI_BASE_URL is NOT set for proxy mode.
                // The base URL is configured in ~/.codex/config.toml under
                // [model_providers.proxy], and selected via `-c model_provider="proxy"`.
                // This matches the market-worker's approach.
            }
            ModelType::GeminiCli => {
                env.insert("GEMINI_API_KEY".to_string(), proxy_token.to_string());
                env.insert("GOOGLE_API_KEY".to_string(), proxy_token.to_string());
                env.insert(
                    "GEMINI_BASE_URL".to_string(),
                    format!("{}/orgii", proxy_url),
                );
            }
            ModelType::Copilot => {
                // IMPORTANT: Only set COPILOT_GITHUB_TOKEN for proxy mode.
                // Copilot CLI v0.0.409+ validates GH_TOKEN/GITHUB_TOKEN against
                // GitHub's real API. When those contain a proxy token (not a real
                // PAT), the validation fails and the CLI reports "no auth" —
                // without falling back to COPILOT_GITHUB_TOKEN. So we must NOT
                // set GH_TOKEN or GITHUB_TOKEN to the proxy token.
                env.insert("COPILOT_GITHUB_TOKEN".to_string(), proxy_token.to_string());
                // HTTPS_PROXY set separately by the MITM proxy module
            }
            ModelType::Kiro => {
                env.insert("KIRO_ACCESS_TOKEN".to_string(), proxy_token.to_string());
                env.insert(
                    "KIRO_REFRESH_TOKEN".to_string(),
                    "proxy_managed".to_string(),
                );
                // HTTPS_PROXY set separately by the MITM proxy module
            }
            ModelType::KimiCli => {
                env.insert("MOONSHOT_API_KEY".to_string(), proxy_token.to_string());
                env.insert(
                    "MOONSHOT_BASE_URL".to_string(),
                    format!("{}/orgii", proxy_url),
                );
            }
            ModelType::OpenCode => {
                // OpenCode uses its own config for provider credentials.
                // Proxy token is available via ORGII_PROXY_TOKEN (set above).
            }
            // API key providers — must mirror the list in get_env_for_agent
            ModelType::AnthropicApi
            | ModelType::OpenaiApi
            | ModelType::DeepseekApi
            | ModelType::GeminiApi
            | ModelType::GroqApi
            | ModelType::XaiApi
            | ModelType::ZhipuApi
            | ModelType::DashscopeApi
            | ModelType::MoonshotApi
            | ModelType::MinimaxApi
            | ModelType::OpenrouterApi
            | ModelType::ZenmuxApi
            | ModelType::VllmApi
            | ModelType::AzureOpenaiApi
            | ModelType::AzureAnthropicApi
            | ModelType::OrgiiOrchestrator => {
                // Same fail-loud principle as the non-proxy builder above:
                // the outer match pins `agent_type` to API-provider
                // variants, so the inner match is exhaustive. Use
                // `unreachable!` for the catch-all so a future variant
                // added to the outer arm without a matching env-var
                // name panics in tests instead of silently routing the
                // proxy token to the wrong env var.
                let env_key = match agent_type {
                    ModelType::AnthropicApi => "ANTHROPIC_API_KEY",
                    ModelType::OpenaiApi => "OPENAI_API_KEY",
                    ModelType::DeepseekApi => "DEEPSEEK_API_KEY",
                    ModelType::GeminiApi => "GEMINI_API_KEY",
                    ModelType::GroqApi => "GROQ_API_KEY",
                    ModelType::XaiApi => "XAI_API_KEY",
                    ModelType::ZhipuApi => "ZHIPU_API_KEY",
                    ModelType::DashscopeApi => "DASHSCOPE_API_KEY",
                    ModelType::MoonshotApi => "MOONSHOT_API_KEY",
                    ModelType::MinimaxApi => "MINIMAX_API_KEY",
                    ModelType::OpenrouterApi => "OPENROUTER_API_KEY",
                    ModelType::ZenmuxApi => "ZENMUX_API_KEY",
                    ModelType::VllmApi => "VLLM_API_KEY",
                    ModelType::AzureOpenaiApi => "AZURE_OPENAI_API_KEY",
                    ModelType::AzureAnthropicApi => "AZURE_ANTHROPIC_API_KEY",
                    ModelType::OrgiiOrchestrator => "ORGII_API_KEY",
                    other => unreachable!(
                        "agent_env_builder proxy inner match must cover every API-provider variant; \
                         got {:?}",
                        other
                    ),
                };
                env.insert(env_key.to_string(), proxy_token.to_string());
                let base_key = format!("{}_BASE_URL", env_key.trim_end_matches("_API_KEY"));
                env.insert(base_key, proxy_url.to_string());
            }
        }

        env
    }
}
