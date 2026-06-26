//! Provider factory: credential resolution + provider instantiation.

use super::anthropic_native::{AnthropicAuthMode, AnthropicClient, ClaudeOAuthRefreshConfig};
use super::codex_native::{
    CodexNativeClient, CodexOAuthRefreshConfig, CODEX_ACCOUNT_ID_HEADER, CODEX_ID_TOKEN_ENV_KEY,
};
use super::cursor_native::{CursorNativeProvider, CursorNativeWorkspaceContext};
use super::gemini_native::GeminiNativeClient;
use super::openai_adaptive::OpenAiAdaptiveClient;
use super::openai_compat::OpenAICompatClient;
use super::registry::{self, provider_id, ProviderSpec};
use super::reliable::ReliableProvider;
use super::traits::{LLMProvider, ProviderConfig, ProviderError};

use crate::config::ReliabilityConfig;
use crate::session::workspace::SessionWorkspace;
use core_types::providers::{
    NativeHarnessType, CODEX_REFRESH_TOKEN_ENV_KEY, KIMI_CODE_URL_FRAGMENT,
};
use key_vault::key_store::{ModelKey, ModelType, ProviderProtocol};
use key_vault::AuthMethod;

/// Create the appropriate LLM provider based on model name and credentials.
///
/// Selects between:
/// - `CodexNativeClient` for Codex OAuth credentials
/// - `AnthropicClient` for Anthropic/Claude models (uses native Messages API)
/// - `OpenAICompatClient` for all other providers (uses OpenAI chat/completions format)
///
/// Returns an error if the account is not found — no fallback to other keys.
pub fn create_provider(
    model: &str,
    account_id: Option<&str>,
) -> Result<Box<dyn LLMProvider>, ProviderError> {
    create_provider_with_reliability(model, account_id, &ReliabilityConfig::default())
}

/// Create a provider wrapped in [`ReliableProvider`] for retry + fallback.
///
/// The primary model is always tried first. If `reliability.fallback_models`
/// is non-empty, those are tried in order after the primary is exhausted.
pub fn create_provider_with_reliability(
    model: &str,
    account_id: Option<&str>,
    reliability: &ReliabilityConfig,
) -> Result<Box<dyn LLMProvider>, ProviderError> {
    create_provider_with_native_harness(model, account_id, reliability, None, None, None)
}

pub async fn create_provider_with_native_harness_preflight(
    model: &str,
    account_id: Option<&str>,
    reliability: &ReliabilityConfig,
    native_harness_type: Option<NativeHarnessType>,
    workspace: Option<SessionWorkspace>,
    code_assist_session_id: Option<&str>,
) -> Result<Box<dyn LLMProvider>, ProviderError> {
    ensure_account_key_fresh(account_id).await?;
    create_provider_with_native_harness(
        model,
        account_id,
        reliability,
        native_harness_type,
        workspace,
        code_assist_session_id,
    )
}

async fn ensure_account_key_fresh(account_id: Option<&str>) -> Result<(), ProviderError> {
    let Some(account_id) = account_id else {
        return Ok(());
    };

    let Some(key) = key_vault::key_store::KEY_SERVICE.get_key_by_id(account_id) else {
        tracing::debug!(
            "[factory] ensure_account_key_fresh: account {} not in key vault — \
             deferring to resolve_credentials for the loud error",
            account_id
        );
        return Ok(());
    };
    if key.auth_method != AuthMethod::Oauth {
        return Ok(());
    }

    match key.model_type {
        ModelType::ClaudeCode => {
            tracing::info!(
                "[factory] Claude Code OAuth preflight refresh check account={} name={:?} health={:?} failures={} enabled={}",
                account_id,
                key.name,
                key.health_status,
                key.oauth_refresh_failure_count,
                key.enabled
            );
            key_vault::key_store::KEY_SERVICE
                .ensure_claude_code_oauth_key_fresh(account_id)
                .await
                .map_err(ProviderError::AuthError)?;
            tracing::info!(
                "[factory] Claude Code OAuth preflight refresh check completed account={}",
                account_id
            );
        }
        ModelType::Codex => {
            key_vault::key_store::KEY_SERVICE
                .ensure_codex_oauth_key_fresh(account_id)
                .await
                .map_err(ProviderError::AuthError)?;
        }
        ModelType::GeminiCli => {
            key_vault::key_store::KEY_SERVICE
                .ensure_gemini_oauth_key_fresh(account_id)
                .await
                .map_err(ProviderError::AuthError)?;
        }
        other => {
            tracing::debug!(
                "[factory] ensure_account_key_fresh: no preflight refresher for \
                 OAuth model_type {:?} (account {}) — relying on lazy 401-retry",
                other,
                account_id
            );
        }
    }
    Ok(())
}

pub fn create_provider_with_native_harness(
    model: &str,
    account_id: Option<&str>,
    reliability: &ReliabilityConfig,
    native_harness_type: Option<NativeHarnessType>,
    workspace: Option<SessionWorkspace>,
    code_assist_session_id: Option<&str>,
) -> Result<Box<dyn LLMProvider>, ProviderError> {
    #[cfg(debug_assertions)]
    if super::e2e_fake::is_e2e_fake_provider_model(model) {
        return Ok(Box::new(super::e2e_fake::E2eFakeProvider));
    }

    if let Some(harness_type) = native_harness_type {
        return create_native_harness_provider(harness_type, account_id, workspace);
    }

    let spec = resolve_spec_for_account(model, account_id)?;
    let resolved = resolve_credentials(spec, account_id)?;

    let primary = build_provider_from_resolved(&resolved, spec, model, code_assist_session_id);
    let primary_name = format!("{}/{}", spec.name, model);

    // Build fallback providers (best-effort — skip any that fail credential resolution)
    let mut providers: Vec<(String, Box<dyn LLMProvider>)> = vec![(primary_name, primary)];

    for fallback_model in &reliability.fallback_models {
        match create_fallback_provider(fallback_model, account_id) {
            Ok((name, provider)) => {
                tracing::info!("[reliable] Registered fallback provider: {}", name);
                providers.push((name, provider));
            }
            Err(err) => {
                tracing::warn!("[reliable] Skipping fallback '{}': {}", fallback_model, err);
            }
        }
    }

    // Wrap in ReliableProvider (even with a single provider, for retry behavior)
    Ok(Box::new(ReliableProvider::with_fallbacks(
        providers,
        reliability.max_retries,
        reliability.base_backoff_ms,
    )))
}

fn create_native_harness_provider(
    native_harness_type: NativeHarnessType,
    account_id: Option<&str>,
    workspace: Option<SessionWorkspace>,
) -> Result<Box<dyn LLMProvider>, ProviderError> {
    let account_id = account_id.ok_or_else(|| {
        ProviderError::AuthError("Native harness sessions require an account_id".to_string())
    })?;

    let key = {
        use key_vault::key_store::KEY_SERVICE;
        KEY_SERVICE.get_key_by_id(account_id).ok_or_else(|| {
            ProviderError::AuthError(format!("Account '{}' not found", account_id))
        })?
    };

    match native_harness_type {
        NativeHarnessType::CursorNative => {
            if key.model_type != ModelType::CursorCli {
                return Err(ProviderError::AuthError(format!(
                    "Cursor native harness requires a Cursor account, got {}",
                    key.model_type.as_str()
                )));
            }
            let session_token = key
                .session_token
                .as_deref()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| {
                    ProviderError::AuthError(format!(
                        "Cursor native harness requires account '{}' to have a session token",
                        account_id
                    ))
                })?;
            Ok(Box::new(
                CursorNativeProvider::from_session_token_with_workspace(
                    session_token,
                    workspace.as_ref().map(cursor_native_workspace_context),
                )?,
            ))
        }
    }
}

fn cursor_native_workspace_context(workspace: &SessionWorkspace) -> CursorNativeWorkspaceContext {
    let project_folder = workspace.working_dir().to_path_buf();
    let mut workspace_paths = Vec::with_capacity(1 + workspace.additional_directories.len());
    workspace_paths.push(project_folder.clone());
    workspace_paths.extend(workspace.additional_directories.keys().cloned());
    CursorNativeWorkspaceContext {
        project_folder,
        workspace_paths,
    }
}

/// Try to create a fallback provider for a given model name.
/// Uses the same account_id — if the credential doesn't match, it's skipped.
fn create_fallback_provider(
    model: &str,
    account_id: Option<&str>,
) -> Result<(String, Box<dyn LLMProvider>), ProviderError> {
    let spec = resolve_spec_for_account(model, account_id)?;
    let resolved = resolve_credentials(spec, account_id)?;

    let name = format!("{}/{}", spec.name, model);
    Ok((
        name,
        build_provider_from_resolved(&resolved, spec, model, None),
    ))
}

/// Guess the provider spec from a model-name hint.
///
/// This is only for account-less preflight/catalog paths. Runtime session
/// routing must use `resolve_spec_for_account`, which is account-first.
fn guess_spec_by_model(model: &str) -> Result<&'static ProviderSpec, ProviderError> {
    registry::guess_provider_by_model(model).ok_or_else(|| {
        ProviderError::ModelNotFound(format!(
            "No provider found for model: {}. Select an account/provider for custom model aliases.",
            model
        ))
    })
}

/// Resolve the provider spec for a selected account.
///
/// The selected account's `ModelType` is authoritative. Model-name guessing is
/// allowed only when no account has been supplied, which is limited to
/// account-less preflight/catalog callers.
fn resolve_spec_for_account(
    model: &str,
    account_id: Option<&str>,
) -> Result<&'static ProviderSpec, ProviderError> {
    let Some(acct_id) = account_id else {
        return guess_spec_by_model(model);
    };

    let cred = {
        use key_vault::key_store::KEY_SERVICE;
        KEY_SERVICE
            .get_key_by_id(acct_id)
            .ok_or_else(|| ProviderError::AuthError(format!("Account '{}' not found", acct_id)))?
    };

    spec_for_credential(&cred).ok_or_else(|| {
        ProviderError::ModelNotFound(format!(
            "Account '{}' (type={}) is not a native LLM provider account for Rust agent sessions.",
            acct_id,
            cred.model_type.as_str()
        ))
    })
}

fn spec_for_model_type(model_type: &ModelType) -> Option<&'static ProviderSpec> {
    let provider_name = match model_type {
        ModelType::AnthropicApi | ModelType::AzureAnthropicApi => provider_id::ANTHROPIC,
        ModelType::Codex | ModelType::OpenaiApi => provider_id::OPENAI,
        ModelType::GeminiApi | ModelType::GeminiCli => provider_id::GEMINI,
        ModelType::MoonshotApi => provider_id::MOONSHOT,
        ModelType::DeepseekApi => provider_id::DEEPSEEK,
        ModelType::GroqApi => provider_id::GROQ,
        ModelType::XaiApi => provider_id::XAI,
        ModelType::ZhipuApi => provider_id::ZHIPU,
        ModelType::DashscopeApi => provider_id::DASHSCOPE,
        ModelType::MinimaxApi => provider_id::MINIMAX,
        ModelType::OpenrouterApi => provider_id::OPENROUTER,
        ModelType::ZenmuxApi => provider_id::ZENMUX,
        ModelType::VllmApi => provider_id::VLLM,
        ModelType::AzureOpenaiApi => provider_id::AZURE_OPENAI,
        ModelType::CursorCli
        | ModelType::ClaudeCode
        | ModelType::Copilot
        | ModelType::Kiro
        | ModelType::KimiCli
        | ModelType::OpenCode
        | ModelType::OrgiiOrchestrator => return None,
    };
    registry::find_by_name(provider_name)
}

fn spec_for_credential(cred: &ModelKey) -> Option<&'static ProviderSpec> {
    if is_claude_oauth_key(cred) {
        return registry::find_by_name(provider_id::ANTHROPIC);
    }
    spec_for_model_type(&cred.model_type)
}

/// API-key + endpoint + auth-method bundle resolved from the user's key
/// vault, used as the input to [`build_provider_from_resolved`]. Local to
/// this file — the `KeyInfo` from `key_vault` is the wire-level shape;
/// this struct is the post-resolution view (Codex OAuth flag set, headers
/// merged, Azure-proxy detection done).
struct ResolvedProviderKey {
    account_id: String,
    token: String,
    protocol: ProviderProtocol,
    api_base: Option<String>,
    custom_base_url: Option<String>,
    is_codex_oauth: bool,
    is_gemini_oauth: bool,
    gemini_project_id: Option<String>,
    codex_refresh_config: Option<CodexOAuthRefreshConfig>,
    claude_oauth_refresh_config: Option<ClaudeOAuthRefreshConfig>,
    extra_headers: std::collections::HashMap<String, String>,
    anthropic_auth_mode: AnthropicAuthMode,
    /// True when an Azure OpenAI credential is used with a non-Azure provider
    /// (e.g., Azure account + Anthropic model). Forces OpenAICompatClient with Azure auth.
    is_azure_proxy: bool,
}

/// Build the appropriate provider client from resolved credentials.
fn build_provider_from_resolved(
    resolved: &ResolvedProviderKey,
    spec: &'static ProviderSpec,
    model: &str,
    code_assist_session_id: Option<&str>,
) -> Box<dyn LLMProvider> {
    if resolved.is_gemini_oauth {
        let project_id = resolved.gemini_project_id.clone().unwrap_or_default();
        tracing::info!(
            "[provider] Using GeminiNativeClient for model={}, project_id_present={}",
            model,
            !project_id.trim().is_empty()
        );
        return Box::new(GeminiNativeClient::new(
            resolved.account_id.clone(),
            project_id,
            model.to_string(),
            code_assist_session_id.map(ToString::to_string),
        ));
    }

    if resolved.is_codex_oauth {
        tracing::info!(
            "[provider] Using CodexNativeClient (Responses API) for model={}",
            model
        );
        let config = ProviderConfig {
            api_key: resolved.token.clone(),
            api_base: None,
            extra_headers: resolved.extra_headers.clone(),
            is_azure: false,
        };
        return Box::new(CodexNativeClient::new_with_refresh(
            config,
            model.to_string(),
            resolved.codex_refresh_config.clone(),
        ));
    }

    let config = ProviderConfig {
        api_key: resolved.token.clone(),
        api_base: resolved.api_base.clone(),
        extra_headers: resolved.extra_headers.clone(),
        is_azure: resolved.is_azure_proxy,
    };

    // Azure proxy with Anthropic model: use AnthropicClient with Azure-routed base URL.
    // Azure AI Foundry serves Anthropic models at /anthropic/v1/messages using the
    // native Anthropic Messages API format with Bearer auth (not api-key header).
    if resolved.is_azure_proxy && spec.name == provider_id::ANTHROPIC {
        let base = resolved
            .custom_base_url
            .as_deref()
            .unwrap_or("")
            .trim_end_matches('/');

        let azure_anthropic_base = format!("{}/anthropic/v1", base);

        tracing::info!(
            "[provider] Using AnthropicClient (Azure proxy) for model={}, base={}",
            model,
            azure_anthropic_base
        );

        let azure_config = ProviderConfig {
            api_key: resolved.token.clone(),
            api_base: Some(azure_anthropic_base),
            extra_headers: resolved.extra_headers.clone(),
            is_azure: true,
        };
        return Box::new(AnthropicClient::new_with_auth_mode(
            azure_config,
            spec,
            model.to_string(),
            AnthropicAuthMode::AzureBearer,
        ));
    }

    // Azure proxy with non-Anthropic model: OpenAI-compatible client with Azure auth/URL.
    if resolved.is_azure_proxy {
        tracing::info!(
            "[provider] Using OpenAICompatClient (Azure proxy) for model={}, original_provider={}",
            model,
            spec.name
        );
        return Box::new(OpenAICompatClient::new(config, spec, model.to_string()));
    }

    // Kimi Code endpoint speaks Anthropic Messages API, not OpenAI Chat Completions.
    let is_kimi_code_endpoint = resolved
        .custom_base_url
        .as_deref()
        .is_some_and(|url| url.contains(KIMI_CODE_URL_FRAGMENT));

    if resolved.protocol == ProviderProtocol::Anthropic || is_kimi_code_endpoint {
        tracing::info!(
            "[provider] Using AnthropicClient (native Messages API) for model={}, provider={}, protocol={}",
            model,
            spec.name,
            resolved.protocol.as_str()
        );
        return Box::new(AnthropicClient::new_with_auth_mode_and_refresh(
            config,
            spec,
            model.to_string(),
            resolved.anthropic_auth_mode,
            resolved.claude_oauth_refresh_config.clone(),
        ));
    }

    if spec.name == provider_id::OPENAI {
        tracing::info!(
            "[provider] Using OpenAiAdaptiveClient for model={}, custom_base={}",
            model,
            resolved.custom_base_url.is_some()
        );
        return Box::new(OpenAiAdaptiveClient::new(
            config,
            spec,
            model.to_string(),
            Some(resolved.account_id.clone()),
            resolved.custom_base_url.clone(),
        ));
    }

    // All other cases: use OpenAI-compatible Chat Completions API.
    // This includes: DeepSeek, Groq, Gemini, Azure, OpenRouter, vLLM,
    // and older OpenAI-compatible providers.
    Box::new(OpenAICompatClient::new(config, spec, model.to_string()))
}

fn resolve_protocol(spec: &ProviderSpec, cred: &ModelKey) -> ProviderProtocol {
    cred.protocol.unwrap_or_else(|| {
        if spec.name == provider_id::ANTHROPIC || cred.model_type == ModelType::AzureAnthropicApi {
            ProviderProtocol::Anthropic
        } else {
            ProviderProtocol::OpenAi
        }
    })
}

fn resolve_provider_endpoint(
    spec: &ProviderSpec,
    custom_base_url: Option<&String>,
    protocol: ProviderProtocol,
) -> Result<Option<String>, ProviderError> {
    if let Some(base_url) = custom_base_url {
        return Ok(Some(base_url.clone()));
    }

    match protocol {
        ProviderProtocol::OpenAi => Ok(spec.default_api_base.map(str::to_string)),
        ProviderProtocol::Anthropic => spec
            .default_anthropic_api_base
            .or_else(|| (spec.name == provider_id::ANTHROPIC).then_some("https://api.anthropic.com/v1"))
            .map(str::to_string)
            .map(Some)
            .ok_or_else(|| {
                ProviderError::AuthError(format!(
                    "Provider '{}' has no default Anthropic endpoint. Set a custom base_url for protocol=anthropic.",
                    spec.name
                ))
            }),
    }
}

/// Resolve credentials for a provider.
///
/// If `account_id` is provided, looks up that specific key. Returns an error
/// if the key is not found — no fallback to other keys.
///
/// For Codex OAuth keys, extracts the account id from the stored `id_token` JWT.
fn resolve_credentials(
    spec: &'static ProviderSpec,
    account_id: Option<&str>,
) -> Result<ResolvedProviderKey, ProviderError> {
    use key_vault::key_store::KEY_SERVICE;

    let cred = match account_id {
        Some(id) => KEY_SERVICE.get_key_by_id(id).ok_or_else(|| {
            let all_keys = KEY_SERVICE.list_keys();
            let available: Vec<String> = all_keys
                .iter()
                .map(|k| format!("{}({})", k.id, k.model_type.as_str()))
                .collect();
            tracing::error!(
                "[resolve_credentials] Account '{}' not found. Available keys: [{}]",
                id,
                available.join(", ")
            );
            ProviderError::AuthError(format!(
                "Account '{}' not found in key vault (have {} keys: {}). \
                 Please select a valid account.",
                id,
                available.len(),
                available.join(", ")
            ))
        })?,
        None => {
            // No account specified — this is an error for Rust agent sessions.
            // CLI sessions resolve keys differently (via platform + env vars).
            return Err(ProviderError::AuthError(
                "No account selected. Please select a Code Account.".to_string(),
            ));
        }
    };

    let acct_id = &cred.id;
    let agent_type = cred.model_type.as_str();
    let provider_name = spec.name;

    if cred.auth_method == AuthMethod::Oauth
        && cred.model_type == ModelType::ClaudeCode
        && KEY_SERVICE.is_key_temporarily_unavailable(&cred)
    {
        let message = KEY_SERVICE
            .temporary_unavailable_message(&cred)
            .unwrap_or_else(|| {
                format!(
                    "Claude Code OAuth account '{}' is temporarily unavailable",
                    acct_id
                )
            });
        return Err(ProviderError::RateLimited {
            message,
            retry_after_secs: cred.temporary_unavailable_until.and_then(|until| {
                let seconds = (until - chrono::Utc::now()).num_seconds();
                (seconds > 0).then_some(seconds as u64)
            }),
        });
    }

    let is_codex_oauth = is_codex_oauth_key(&cred);
    let is_claude_oauth = is_claude_oauth_key(&cred);
    let is_gemini_oauth = is_gemini_oauth_key(&cred);

    // auth_method is authoritative. Rust-native HTTP sessions support OAuth
    // only for providers with an explicit native auth mode. Do not substitute
    // OAuth tokens into generic provider API-key clients.
    let token = if cred.auth_method == AuthMethod::Oauth {
        if !is_codex_oauth && !is_claude_oauth && !is_gemini_oauth {
            return Err(ProviderError::AuthError(format!(
                "Account '{}' uses OAuth (type={}), which is not supported for Rust-native provider sessions.",
                acct_id,
                cred.model_type.as_str()
            )));
        }

        cred.session_token
            .as_deref()
            .filter(|token_value| !token_value.is_empty())
            .ok_or_else(|| {
                ProviderError::AuthError(format!(
                    "Account '{}' is tagged auth_method:\"oauth\" but has no session_token.",
                    acct_id
                ))
            })?
            .to_string()
    } else {
        cred.api_key
            .as_deref()
            .filter(|key_value| !key_value.is_empty())
            .ok_or_else(|| {
                ProviderError::AuthError(format!("Account '{}' has no API key.", acct_id))
            })?
            .to_string()
    };

    let codex_refresh_config = if is_codex_oauth
        && cred
            .env_vars
            .get(CODEX_REFRESH_TOKEN_ENV_KEY)
            .is_some_and(|token| !token.trim().is_empty())
    {
        Some(CodexOAuthRefreshConfig {
            key_id: acct_id.to_string(),
        })
    } else {
        None
    };
    let claude_oauth_refresh_config = if is_claude_oauth {
        Some(ClaudeOAuthRefreshConfig {
            key_id: acct_id.to_string(),
        })
    } else {
        None
    };

    let mut extra_headers = std::collections::HashMap::new();

    if is_codex_oauth {
        if let Some(account_id_value) = extract_codex_account_id(&cred) {
            tracing::info!(
                "[provider] Codex OAuth: extracted account id={}",
                &account_id_value[..account_id_value.len().min(8)]
            );
            extra_headers.insert(CODEX_ACCOUNT_ID_HEADER.to_string(), account_id_value);
        } else {
            tracing::warn!(
                "[provider] Codex OAuth: no account id found in id_token — requests may fail with 403"
            );
        }
    }

    let is_azure_proxy = (agent_type == ModelType::AzureOpenaiApi.as_str()
        && provider_name != provider_id::AZURE_OPENAI)
        || agent_type == ModelType::AzureAnthropicApi.as_str();
    let anthropic_auth_mode = if is_claude_oauth {
        AnthropicAuthMode::ClaudeOauth
    } else if is_azure_proxy {
        AnthropicAuthMode::AzureBearer
    } else {
        AnthropicAuthMode::ApiKey
    };
    let protocol = resolve_protocol(spec, &cred);
    let api_base = resolve_provider_endpoint(spec, cred.base_url.as_ref(), protocol)?;

    tracing::info!(
        "[provider] Using credential '{}' (type={}, auth={:?}, provider={}, protocol={}, codex_oauth={}, claude_oauth={}, azure_proxy={}, api_base={:?})",
        acct_id,
        agent_type,
        cred.auth_method,
        provider_name,
        protocol.as_str(),
        is_codex_oauth,
        is_claude_oauth,
        is_azure_proxy,
        &api_base,
    );

    Ok(ResolvedProviderKey {
        account_id: acct_id.to_string(),
        token,
        protocol,
        api_base,
        custom_base_url: cred.base_url.clone(),
        is_codex_oauth,
        is_gemini_oauth,
        gemini_project_id: gemini_project_id(&cred),
        codex_refresh_config,
        claude_oauth_refresh_config,
        extra_headers,
        anthropic_auth_mode,
        is_azure_proxy,
    })
}

/// True iff `cred` is a Codex OAuth credential.
/// `auth_method` is authoritative; the session_token check rules out
/// half-completed OAuth saves where the wizard never received the token.
fn is_codex_oauth_key(cred: &ModelKey) -> bool {
    oauth_key_has_session_token(cred, ModelType::Codex)
}

/// True iff `cred` is a Claude Code OAuth credential that can authenticate
/// against the native Anthropic Messages API.
fn is_claude_oauth_key(cred: &ModelKey) -> bool {
    oauth_key_has_session_token(cred, ModelType::ClaudeCode)
}

fn is_gemini_oauth_key(cred: &ModelKey) -> bool {
    oauth_key_has_session_token(cred, ModelType::GeminiCli)
}

fn gemini_project_id(cred: &ModelKey) -> Option<String> {
    ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"]
        .iter()
        .find_map(|key| cred.env_vars.get(*key))
        .map(|project_id| project_id.trim().to_string())
        .filter(|project_id| !project_id.is_empty())
}

fn oauth_key_has_session_token(cred: &ModelKey, model_type: ModelType) -> bool {
    if cred.model_type != model_type {
        return false;
    }
    if cred.auth_method != AuthMethod::Oauth {
        return false;
    }
    cred.session_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .is_some()
}

/// Extract the account id from a Codex credential's stored id_token.
///
/// The id_token is stored in `env_vars[CODEX_ID_TOKEN_ENV_KEY]` during auto-detection.
fn extract_codex_account_id(cred: &ModelKey) -> Option<String> {
    use crate::providers::codex_native::extract_account_id_from_id_token;

    let id_token = cred.env_vars.get(CODEX_ID_TOKEN_ENV_KEY)?;
    extract_account_id_from_id_token(id_token)
}

/// Probe whether ANY credential is available for a given model.
///
/// This is used only by `agent_check_keys` to test if the user has
/// a working credential for a provider — before any session or account selection.
/// Unlike `resolve_credentials`, this intentionally scans all credentials.
///
/// The returned provider is wrapped in [`ReliableProvider`] for retry on
/// transient errors (rate limits, network).
pub fn check_credentials_available(
    model: &str,
) -> Result<(&'static ProviderSpec, Box<dyn LLMProvider>), ProviderError> {
    use key_vault::key_store::KEY_SERVICE;

    let creds = KEY_SERVICE.list_keys();

    // Try standard provider-keyword matching first, then fall back to
    // scanning each credential's available_models list. This handles custom
    // proxy models like "claude-high" that live in an openai_api credential
    // but contain provider keywords that would route to the wrong provider.
    let (spec, api_key, api_base, protocol) = match guess_spec_by_model(model).and_then(|spec| {
        find_api_key_for_provider(spec, &creds)
            .map(|(key, base, protocol)| (spec, key, base, protocol))
    }) {
        Ok(result) => result,
        Err(primary_err) => {
            find_credential_by_available_model(model, &creds)?.ok_or(primary_err)?
        }
    };

    let config = ProviderConfig {
        api_key,
        api_base,
        extra_headers: std::collections::HashMap::new(),
        is_azure: false,
    };

    let provider_name = format!("{}/{}", spec.name, model);
    let raw: Box<dyn LLMProvider> = match protocol {
        ProviderProtocol::Anthropic => {
            Box::new(AnthropicClient::new(config, spec, model.to_string()))
        }
        ProviderProtocol::OpenAi => {
            Box::new(OpenAICompatClient::new(config, spec, model.to_string()))
        }
    };

    let defaults = ReliabilityConfig::default();
    Ok((
        spec,
        Box::new(ReliableProvider::single(
            provider_name,
            raw,
            defaults.max_retries,
            defaults.base_backoff_ms,
        )),
    ))
}

/// Scan all credentials for one whose `available_models` or `enabled_models`
/// contains the requested model. Returns the resolved provider spec, API key,
/// and optional base URL so the caller can build a provider.
///
/// This handles proxy/custom-endpoint credentials that advertise non-standard
/// model names (e.g. "claude-high", "gpt-medium") which don't match any
/// built-in provider keyword.
fn find_api_key_for_provider(
    spec: &ProviderSpec,
    creds: &[ModelKey],
) -> Result<(String, Option<String>, ProviderProtocol), ProviderError> {
    let api_key_type = match spec.name {
        provider_id::ANTHROPIC => Some(ModelType::AnthropicApi),
        provider_id::OPENAI => Some(ModelType::OpenaiApi),
        provider_id::DEEPSEEK => Some(ModelType::DeepseekApi),
        provider_id::GEMINI => Some(ModelType::GeminiApi),
        provider_id::GROQ => Some(ModelType::GroqApi),
        provider_id::XAI => Some(ModelType::XaiApi),
        provider_id::ZHIPU => Some(ModelType::ZhipuApi),
        provider_id::DASHSCOPE => Some(ModelType::DashscopeApi),
        provider_id::MINIMAX => Some(ModelType::MinimaxApi),
        provider_id::MOONSHOT => Some(ModelType::MoonshotApi),
        provider_id::OPENROUTER => Some(ModelType::OpenrouterApi),
        provider_id::ZENMUX => Some(ModelType::ZenmuxApi),
        provider_id::VLLM => Some(ModelType::VllmApi),
        provider_id::AZURE_OPENAI => Some(ModelType::AzureOpenaiApi),
        _ => None,
    };

    if let Some(ref target_type) = api_key_type {
        for cred in creds {
            if cred.model_type == *target_type {
                if let Some(ref key) = cred.api_key {
                    if !key.is_empty() {
                        tracing::info!(
                            "[provider] Using API key credential '{}' for provider '{}'",
                            cred.model_type.as_str(),
                            spec.display_name
                        );
                        let protocol = resolve_protocol(spec, cred);
                        let api_base =
                            resolve_provider_endpoint(spec, cred.base_url.as_ref(), protocol)?;
                        return Ok((key.clone(), api_base, protocol));
                    }
                }
            }
        }
    }

    if let Some(env_key) = spec.env_key {
        for cred in creds {
            if let Some(val) = cred.env_vars.get(env_key) {
                if !val.is_empty() {
                    let protocol = resolve_protocol(spec, cred);
                    let api_base =
                        resolve_provider_endpoint(spec, cred.base_url.as_ref(), protocol)?;
                    return Ok((val.clone(), api_base, protocol));
                }
            }
        }
    }

    if let Some(env_key) = spec.env_key {
        if let Ok(val) = std::env::var(env_key) {
            if !val.is_empty() {
                let protocol = if spec.name == provider_id::ANTHROPIC {
                    ProviderProtocol::Anthropic
                } else {
                    ProviderProtocol::OpenAi
                };
                let api_base = resolve_provider_endpoint(spec, None, protocol)?;
                return Ok((val, api_base, protocol));
            }
        }
    }

    Err(ProviderError::AuthError(format!(
        "No API key found for provider '{}'. Add one via Settings > Code Accounts or set the {} environment variable.",
        spec.display_name,
        spec.env_key.unwrap_or("API_KEY"),
    )))
}

fn find_credential_by_available_model(
    model: &str,
    creds: &[ModelKey],
) -> Result<
    Option<(
        &'static ProviderSpec,
        String,
        Option<String>,
        ProviderProtocol,
    )>,
    ProviderError,
> {
    let model_lower = model.to_lowercase();
    for cred in creds {
        if !cred.enabled {
            continue;
        }
        let has_model = cred
            .available_models
            .iter()
            .chain(cred.enabled_models.iter())
            .any(|m| m.to_lowercase() == model_lower);
        if !has_model {
            continue;
        }
        if cred.auth_method != AuthMethod::ApiKey {
            continue;
        }

        let api_key = cred
            .api_key
            .as_deref()
            .filter(|key_value| !key_value.is_empty());
        let Some(key) = api_key else { continue };

        let Some(spec) = spec_for_model_type(&cred.model_type) else {
            continue;
        };

        tracing::info!(
            "[provider] Matched model '{}' via available_models in credential '{}' (provider={})",
            model,
            cred.name.as_deref().unwrap_or(&cred.id),
            spec.display_name
        );
        let protocol = resolve_protocol(spec, cred);
        let api_base = resolve_provider_endpoint(spec, cred.base_url.as_ref(), protocol)?;
        return Ok(Some((spec, key.to_string(), api_base, protocol)));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::registry::{provider_id, PROVIDERS};

    const ALL_PROVIDER_IDS: &[&str] = &[
        provider_id::OPENROUTER,
        provider_id::ZENMUX,
        provider_id::ANTHROPIC,
        provider_id::OPENAI,
        provider_id::DEEPSEEK,
        provider_id::GEMINI,
        provider_id::GROQ,
        provider_id::XAI,
        provider_id::ZHIPU,
        provider_id::DASHSCOPE,
        provider_id::MINIMAX,
        provider_id::MOONSHOT,
        provider_id::AZURE_OPENAI,
        provider_id::VLLM,
    ];

    #[test]
    fn every_provider_id_is_registered_in_static_table() {
        for provider_id_value in ALL_PROVIDER_IDS {
            assert!(
                PROVIDERS.iter().any(|spec| spec.name == *provider_id_value),
                "provider_id::{provider_id_value} listed in keymap test but missing from PROVIDERS table"
            );
        }
    }

    #[test]
    fn provider_keymap_covers_all_provider_ids() {
        const KEYMAP_COVERED: &[&str] = &[
            provider_id::ANTHROPIC,
            provider_id::OPENAI,
            provider_id::DEEPSEEK,
            provider_id::GEMINI,
            provider_id::GROQ,
            provider_id::XAI,
            provider_id::ZHIPU,
            provider_id::DASHSCOPE,
            provider_id::MINIMAX,
            provider_id::MOONSHOT,
            provider_id::OPENROUTER,
            provider_id::ZENMUX,
            provider_id::VLLM,
            provider_id::AZURE_OPENAI,
        ];

        for provider_id_value in ALL_PROVIDER_IDS {
            assert!(
                KEYMAP_COVERED.contains(provider_id_value),
                "provider_id::{provider_id_value} is registered but has no ModelType mapping in provider credential lookup"
            );
        }
    }

    #[test]
    fn rust_provider_spec_allows_native_cli_providers_only() {
        assert!(spec_for_model_type(&ModelType::ClaudeCode).is_none());
        assert!(spec_for_model_type(&ModelType::KimiCli).is_none());
        assert!(spec_for_model_type(&ModelType::Codex).is_some());
        assert_eq!(
            spec_for_model_type(&ModelType::GeminiCli)
                .expect("Gemini CLI can power Rust-native sessions")
                .name,
            provider_id::GEMINI
        );
    }

    #[test]
    fn claude_code_oauth_credential_resolves_to_anthropic_spec() {
        let mut key = ModelKey::new(ModelType::ClaudeCode);
        key.auth_method = AuthMethod::Oauth;
        key.session_token = Some("session-token".to_string());

        let spec = spec_for_credential(&key).expect("Claude OAuth should map to Anthropic");
        assert_eq!(spec.name, provider_id::ANTHROPIC);
    }

    #[test]
    fn claude_code_api_key_credential_stays_cli_only() {
        let mut key = ModelKey::new(ModelType::ClaudeCode);
        key.api_key = Some("sk-ant-cli".to_string());

        assert!(spec_for_credential(&key).is_none());
    }

    #[test]
    fn claude_oauth_key_requires_session_token() {
        let mut key = ModelKey::new(ModelType::ClaudeCode);
        key.auth_method = AuthMethod::Oauth;

        assert!(!is_claude_oauth_key(&key));
    }

    #[test]
    fn gemini_oauth_credential_resolves_to_gemini_spec_and_project_id() {
        let mut key = ModelKey::new(ModelType::GeminiCli);
        key.auth_method = AuthMethod::Oauth;
        key.session_token = Some("access-token".to_string());
        key.env_vars.insert(
            "GOOGLE_CLOUD_PROJECT".to_string(),
            "project-from-load-code-assist".to_string(),
        );

        let spec = spec_for_credential(&key).expect("Gemini OAuth should map to Gemini");
        assert_eq!(spec.name, provider_id::GEMINI);
        assert!(is_gemini_oauth_key(&key));
        assert_eq!(
            gemini_project_id(&key).as_deref(),
            Some("project-from-load-code-assist")
        );
    }

    #[test]
    fn gemini_oauth_key_requires_session_token() {
        let mut key = ModelKey::new(ModelType::GeminiCli);
        key.auth_method = AuthMethod::Oauth;

        assert!(!is_gemini_oauth_key(&key));
    }

    #[test]
    fn available_model_scan_ignores_oauth_tokens() {
        let mut key = ModelKey::new(ModelType::OpenaiApi);
        key.auth_method = AuthMethod::Oauth;
        key.session_token = Some("session-token".to_string());
        key.available_models.push("custom-model".to_string());

        assert!(find_credential_by_available_model("custom-model", &[key])
            .expect("scan should not error")
            .is_none());
    }

    #[test]
    fn zenmux_defaults_to_openai_protocol_endpoint() {
        let spec = registry::find_by_name(provider_id::ZENMUX).expect("ZenMux provider registered");
        let key = ModelKey::new(ModelType::ZenmuxApi);

        let protocol = resolve_protocol(spec, &key);
        let api_base = resolve_provider_endpoint(spec, key.base_url.as_ref(), protocol)
            .expect("ZenMux OpenAI endpoint should resolve");

        assert_eq!(protocol, ProviderProtocol::OpenAi);
        assert_eq!(api_base.as_deref(), Some("https://zenmux.ai/api/v1"));
    }

    #[test]
    fn zenmux_anthropic_protocol_uses_anthropic_endpoint() {
        let spec = registry::find_by_name(provider_id::ZENMUX).expect("ZenMux provider registered");
        let mut key = ModelKey::new(ModelType::ZenmuxApi);
        key.protocol = Some(ProviderProtocol::Anthropic);

        let protocol = resolve_protocol(spec, &key);
        let api_base = resolve_provider_endpoint(spec, key.base_url.as_ref(), protocol)
            .expect("ZenMux Anthropic endpoint should resolve");

        assert_eq!(protocol, ProviderProtocol::Anthropic);
        assert_eq!(api_base.as_deref(), Some("https://zenmux.ai/api/anthropic"));
    }

    #[test]
    fn custom_anthropic_base_url_takes_precedence() {
        let spec = registry::find_by_name(provider_id::ZHIPU).expect("Zhipu provider registered");
        let mut key = ModelKey::new(ModelType::ZhipuApi);
        key.protocol = Some(ProviderProtocol::Anthropic);
        key.base_url = Some("https://proxy.example.com/anthropic".to_string());

        let protocol = resolve_protocol(spec, &key);
        let api_base = resolve_provider_endpoint(spec, key.base_url.as_ref(), protocol)
            .expect("custom Anthropic endpoint should resolve");

        assert_eq!(protocol, ProviderProtocol::Anthropic);
        assert_eq!(
            api_base.as_deref(),
            Some("https://proxy.example.com/anthropic")
        );
    }

    #[test]
    fn anthropic_protocol_without_endpoint_or_custom_base_errors() {
        let spec = registry::find_by_name(provider_id::ZHIPU).expect("Zhipu provider registered");
        let mut key = ModelKey::new(ModelType::ZhipuApi);
        key.protocol = Some(ProviderProtocol::Anthropic);

        let protocol = resolve_protocol(spec, &key);
        let err = resolve_provider_endpoint(spec, key.base_url.as_ref(), protocol)
            .expect_err("Zhipu Anthropic endpoint requires custom base URL");

        assert!(err.to_string().contains("no default Anthropic endpoint"));
    }
}
