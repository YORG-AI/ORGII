//! HTTP client for the Anthropic Messages API (`/v1/messages`)
//!
//! Builds requests from a `ProviderSpec` and sends them to the Anthropic
//! endpoint (or a compatible proxy). The actual request shape and error
//! parsing live in this module's siblings:
//!
//! - `messages::*` — OpenAI → Anthropic message format conversion
//! - `tools::convert_tools` — OpenAI → Anthropic tool format
//! - `thinking::*` — extended-thinking parameter shaping
//! - `errors::parse_error` — typed `ProviderError` from HTTP bodies
//!
//! `client.rs` itself only owns the struct, its constructor, and the
//! `messages_url()` helper — it stays small and easy to scan.

use reqwest::Client;
use std::sync::RwLock;

use crate::providers::registry::ProviderSpec;
use crate::providers::traits::{ProviderConfig, ProviderError};
use crate::utils::build_http_client;

#[derive(Debug, Clone)]
pub struct ClaudeOAuthRefreshConfig {
    pub key_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ClaudeOAuthRefreshEligibility {
    Eligible,
    NotExpired,
    NotClaudeOauth,
}

struct AnthropicAuthState {
    access_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnthropicAuthMode {
    ApiKey,
    AzureBearer,
    ClaudeOauth,
}

/// LLM client that speaks the native Anthropic Messages API.
pub struct AnthropicClient {
    pub(super) client: Client,
    pub(super) config: ProviderConfig,
    pub(super) provider_spec: &'static ProviderSpec,
    pub(super) default_model: String,
    pub(super) auth_mode: AnthropicAuthMode,
    pub(super) refresh_config: Option<ClaudeOAuthRefreshConfig>,
    /// Stable per-client session id for Claude OAuth request metadata. The
    /// reference harness sends one session id per session — a fresh random id
    /// on every request is an anomaly signal to server-side heuristics.
    /// Clients are constructed per session, so instance scope fits.
    pub(super) oauth_session_id: String,
    auth_state: RwLock<AnthropicAuthState>,
}

impl AnthropicClient {
    /// Create a new Anthropic client.
    pub fn new(
        config: ProviderConfig,
        provider_spec: &'static ProviderSpec,
        default_model: String,
    ) -> Self {
        let auth_mode = if config.is_azure {
            AnthropicAuthMode::AzureBearer
        } else {
            AnthropicAuthMode::ApiKey
        };
        Self::new_with_auth_mode(config, provider_spec, default_model, auth_mode)
    }

    pub fn new_with_auth_mode(
        config: ProviderConfig,
        provider_spec: &'static ProviderSpec,
        default_model: String,
        auth_mode: AnthropicAuthMode,
    ) -> Self {
        Self::new_with_auth_mode_and_refresh(config, provider_spec, default_model, auth_mode, None)
    }

    pub fn new_with_auth_mode_and_refresh(
        config: ProviderConfig,
        provider_spec: &'static ProviderSpec,
        default_model: String,
        auth_mode: AnthropicAuthMode,
        refresh_config: Option<ClaudeOAuthRefreshConfig>,
    ) -> Self {
        let client = build_http_client(std::time::Duration::from_secs(300));
        let auth_state = RwLock::new(AnthropicAuthState {
            access_token: config.api_key.clone(),
        });

        Self {
            client,
            config,
            provider_spec,
            default_model,
            auth_mode,
            refresh_config,
            oauth_session_id: uuid::Uuid::new_v4().to_string(),
            auth_state,
        }
    }

    pub(super) fn current_access_token(&self) -> Result<String, ProviderError> {
        let auth_state = self.auth_state.read().map_err(|err| {
            ProviderError::RequestFailed(format!("Anthropic auth lock poisoned: {err}"))
        })?;
        Ok(auth_state.access_token.clone())
    }

    pub(super) async fn claude_oauth_refresh_eligibility(
        &self,
    ) -> Result<ClaudeOAuthRefreshEligibility, ProviderError> {
        let Some(refresh_config) = &self.refresh_config else {
            return Ok(ClaudeOAuthRefreshEligibility::NotClaudeOauth);
        };
        if self.auth_mode != AnthropicAuthMode::ClaudeOauth {
            return Ok(ClaudeOAuthRefreshEligibility::NotClaudeOauth);
        }
        let key = key_vault::key_store::KEY_SERVICE
            .get_key_by_id(&refresh_config.key_id)
            .ok_or_else(|| {
                ProviderError::AuthError(format!("Key not found: {}", refresh_config.key_id))
            })?;
        if key_vault::key_store::KEY_SERVICE.claude_code_oauth_key_needs_refresh(&key) {
            Ok(ClaudeOAuthRefreshEligibility::Eligible)
        } else {
            Ok(ClaudeOAuthRefreshEligibility::NotExpired)
        }
    }

    pub(super) async fn refresh_auth_after_local_expiry(&self) -> Result<(), ProviderError> {
        let Some(refresh_config) = &self.refresh_config else {
            return Err(ProviderError::AuthError(
                "Claude Code OAuth access token was rejected and no refresh token is configured"
                    .to_string(),
            ));
        };

        let rejected_access_token = self.current_access_token()?;
        tracing::info!(
            "[anthropic] Claude Code OAuth lazy refresh start key={} reason=local_expiry_after_rejection access_len={}",
            refresh_config.key_id,
            rejected_access_token.len()
        );
        let refreshed = key_vault::key_store::KEY_SERVICE
            .refresh_claude_code_oauth_key(&refresh_config.key_id, &rejected_access_token)
            .await
            .map_err(ProviderError::AuthError)?
            .into_key()
            .ok_or_else(|| {
                ProviderError::AuthError(format!(
                    "Key {} is not a native Claude OAuth account",
                    refresh_config.key_id
                ))
            })?;

        let access_token = refreshed
            .session_token
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::AuthError(format!(
                    "Claude Code OAuth refresh for key {} returned no access token",
                    refresh_config.key_id
                ))
            })?;

        let mut auth_state = self.auth_state.write().map_err(|err| {
            ProviderError::RequestFailed(format!("Anthropic auth lock poisoned: {err}"))
        })?;
        auth_state.access_token = access_token;
        tracing::info!(
            "[anthropic] Claude Code OAuth lazy refresh completed key={}",
            refresh_config.key_id
        );
        Ok(())
    }

    pub(super) fn mark_claude_oauth_upstream_health(
        &self,
        status: u16,
        error_type: &str,
        message: Option<&str>,
        retry_after_secs: Option<u64>,
    ) {
        if let Some(refresh_config) = &self.refresh_config {
            if self.auth_mode == AnthropicAuthMode::ClaudeOauth {
                let _ = key_vault::key_store::KEY_SERVICE.mark_claude_oauth_upstream_health(
                    &refresh_config.key_id,
                    status,
                    error_type,
                    message,
                    retry_after_secs,
                );
            }
        }
    }

    pub(super) fn clear_claude_oauth_upstream_health(&self) {
        if let Some(refresh_config) = &self.refresh_config {
            if self.auth_mode == AnthropicAuthMode::ClaudeOauth {
                let _ = key_vault::key_store::KEY_SERVICE
                    .clear_claude_oauth_upstream_health(&refresh_config.key_id);
            }
        }
    }

    /// Build the Messages API URL.
    ///
    /// For Azure AI Foundry (`config.is_azure`), the base URL already includes
    /// the deployment path (`{endpoint}/anthropic/deployments/{model}`), and the
    /// API version query parameter is required.
    pub(super) fn messages_url(&self) -> String {
        let base = self
            .config
            .api_base
            .as_deref()
            .or(self.provider_spec.default_api_base)
            .unwrap_or("https://api.anthropic.com/v1");

        let base = base.trim_end_matches('/');

        let path = if base.ends_with("/v1") {
            format!("{}/messages", base)
        } else {
            format!("{}/v1/messages", base)
        };

        if self.config.is_azure {
            format!("{}?api-version=2024-12-01-preview", path)
        } else {
            path
        }
    }
}
