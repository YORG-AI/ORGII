//! HTTP client for the Codex native Responses API.
//!
//! Sends requests to `chatgpt.com/backend-api/codex/responses` using
//! OAuth Bearer authentication. Enforces strict JSON schema on tool
//! definitions before sending to avoid backend validation errors.

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

use super::types::ResponsesRequest;
use super::types::{CHATGPT_CODEX_BASE, CODEX_USER_AGENT};
use crate::providers::responses_common::{convert_messages, convert_tools_with_choice};
use crate::providers::traits::{ProviderConfig, ProviderError};
use crate::utils::build_http_client;

const CODEX_FAST_SERVICE_TIER: &str = "priority";
const CODEX_PROVIDER_PREFIXES: &[&str] = &["openai/"];

#[derive(Debug, Clone)]
pub struct CodexOAuthRefreshConfig {
    pub key_id: String,
}

struct CodexAuthState {
    access_token: String,
    extra_headers: HashMap<String, String>,
}

/// LLM client for Codex OAuth sessions via the native Codex backend.
///
/// Translates between the internal Chat Completions message format
/// (used by the agent loop) and the Responses API format required
/// by the backend.
pub struct CodexNativeClient {
    pub(super) client: Client,
    pub(super) config: ProviderConfig,
    pub(super) default_model: String,
    pub(super) refresh_config: Option<CodexOAuthRefreshConfig>,
    auth_state: RwLock<CodexAuthState>,
}

impl CodexNativeClient {
    pub fn new(config: ProviderConfig, default_model: String) -> Self {
        Self::new_with_refresh(config, default_model, None)
    }

    pub fn new_with_refresh(
        config: ProviderConfig,
        default_model: String,
        refresh_config: Option<CodexOAuthRefreshConfig>,
    ) -> Self {
        let client = build_http_client(std::time::Duration::from_secs(300));
        let auth_state = RwLock::new(CodexAuthState {
            access_token: config.api_key.clone(),
            extra_headers: config.extra_headers.clone(),
        });

        Self {
            client,
            config,
            default_model,
            refresh_config,
            auth_state,
        }
    }

    /// Build the responses endpoint URL.
    pub(super) fn responses_url(&self) -> String {
        let base = self
            .config
            .api_base
            .as_deref()
            .unwrap_or(CHATGPT_CODEX_BASE);
        format!("{}/responses", base.trim_end_matches('/'))
    }

    /// Convert Chat Completions messages to Responses API input.
    /// Delegates to shared converter.
    ///
    /// MCP image sidecars on
    /// `role:"tool"` messages are *always* lifted into follow-up
    /// `user` items with `input_image` blocks. The Codex backend
    /// runs the same vision-capable GPT-5 family as the public
    /// Responses API, so unconditional expansion is safe and
    /// preferable to silent-drop on unknown model names.
    pub(super) fn convert_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
        convert_messages(messages)
    }

    pub(super) fn required_instructions(instructions: Option<String>) -> String {
        instructions
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "You are Codex, a coding agent running in ORGII.".to_string())
    }

    fn codex_reasoning_effort(
        level: Option<crate::providers::thinking_mode::ReasoningLevel>,
    ) -> Option<&'static str> {
        use crate::providers::thinking_mode::ReasoningLevel;

        Some(match level? {
            ReasoningLevel::Low => "low",
            ReasoningLevel::Medium => "medium",
            ReasoningLevel::High => "high",
            ReasoningLevel::ExtraHigh => "xhigh",
            ReasoningLevel::Max | ReasoningLevel::Ultracode => "max",
            ReasoningLevel::Baseline | ReasoningLevel::None => return None,
        })
    }

    fn codex_supports_fast_service_tier(model: &str) -> bool {
        matches!(
            model,
            "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.4"
        )
    }

    fn strip_codex_provider_prefix(model: &str) -> &str {
        for prefix in CODEX_PROVIDER_PREFIXES {
            if let Some(stripped) = model.strip_prefix(prefix) {
                return stripped;
            }
        }
        model
    }

    /// Build a request for the ChatGPT-backed Codex endpoint.
    ///
    /// ORGII exposes reasoning/speed variants as model ids (for example
    /// `gpt-5.5-medium-fast`), but the Codex backend only accepts the real
    /// base model slug. Keep the native request shape narrow: unlike the
    /// public Responses API client, this backend rejects several extra fields.
    pub(super) fn build_responses_request(
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        stream: bool,
    ) -> ResponsesRequest {
        let (instructions, input) = Self::convert_messages(messages);
        let (converted_tools, tool_choice) = convert_tools_with_choice(tools);
        let parsed = crate::providers::thinking_mode::parse_model_variant(
            Self::strip_codex_provider_prefix(model),
        );
        let reasoning = Self::codex_reasoning_effort(parsed.level)
            .map(|effort| serde_json::json!({ "effort": effort }));
        let service_tier = (parsed.fast
            && Self::codex_supports_fast_service_tier(&parsed.base_model))
        .then(|| CODEX_FAST_SERVICE_TIER.to_string());

        ResponsesRequest {
            model: parsed.base_model,
            input,
            instructions: Self::required_instructions(instructions),
            tools: converted_tools,
            tool_choice,
            reasoning,
            service_tier,
            store: false,
            stream,
        }
    }

    /// Build HTTP request with required Codex native backend headers.
    pub(super) fn build_request(
        &self,
        url: &str,
        body: &impl Serialize,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let auth_state = self.auth_state.read().map_err(|err| {
            ProviderError::RequestFailed(format!("Codex auth lock poisoned: {err}"))
        })?;
        let mut req = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header(
                "Authorization",
                format!("Bearer {}", auth_state.access_token),
            )
            .header("User-Agent", CODEX_USER_AGENT)
            .header("originator", "codex_cli_rs")
            .header("Accept", "*/*");

        for (key, value) in &auth_state.extra_headers {
            req = req.header(key.as_str(), value.as_str());
        }

        Ok(req.json(body))
    }

    fn current_access_token(&self) -> Result<String, ProviderError> {
        let auth_state = self.auth_state.read().map_err(|err| {
            ProviderError::RequestFailed(format!("Codex auth lock poisoned: {err}"))
        })?;
        Ok(auth_state.access_token.clone())
    }

    pub(super) async fn refresh_auth_after_unauthorized(&self) -> Result<(), ProviderError> {
        let Some(refresh_config) = &self.refresh_config else {
            return Err(ProviderError::AuthError(
                "Codex OAuth access token expired and no refresh token is configured".to_string(),
            ));
        };

        let rejected_access_token = self.current_access_token()?;
        let refreshed = key_vault::key_store::KEY_SERVICE
            .refresh_codex_oauth_key(&refresh_config.key_id, &rejected_access_token)
            .await
            .map_err(ProviderError::AuthError)?
            .into_key()
            .ok_or_else(|| {
                ProviderError::AuthError(format!(
                    "Key {} is not a native Codex OAuth account",
                    refresh_config.key_id
                ))
            })?;

        let access_token = refreshed
            .session_token
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::AuthError(format!(
                    "Codex OAuth refresh for key {} returned no access token",
                    refresh_config.key_id
                ))
            })?;

        let mut extra_headers = self.config.extra_headers.clone();
        if let Some(account_id) = super::extract_account_id_from_id_token(
            refreshed
                .env_vars
                .get(core_types::providers::CODEX_ID_TOKEN_ENV_KEY)
                .map(String::as_str)
                .unwrap_or_default(),
        ) {
            extra_headers.insert(super::CODEX_ACCOUNT_ID_HEADER.to_string(), account_id);
        }

        let mut auth_state = self.auth_state.write().map_err(|err| {
            ProviderError::RequestFailed(format!("Codex auth lock poisoned: {err}"))
        })?;
        auth_state.access_token = access_token;
        auth_state.extra_headers = extra_headers;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_responses_request_strips_reasoning_and_fast_variant_suffixes() {
        let messages = [json!({
            "role": "user",
            "content": "write tests"
        })];

        let req = CodexNativeClient::build_responses_request(
            &messages,
            None,
            "gpt-5.5-medium-fast",
            true,
        );

        assert_eq!(req.model, "gpt-5.5");
        assert!(req.stream);
        assert_eq!(req.reasoning.as_ref().unwrap()["effort"], "medium");
        assert_eq!(req.service_tier.as_deref(), Some("priority"));
        assert_eq!(
            req.instructions,
            "You are Codex, a coding agent running in ORGII."
        );
    }

    #[test]
    fn build_responses_request_keeps_provider_native_suffixes() {
        let req =
            CodexNativeClient::build_responses_request(&[], None, "gpt-5.4-mini-medium-fast", true);

        assert_eq!(req.model, "gpt-5.4-mini");
        assert_eq!(req.reasoning.as_ref().unwrap()["effort"], "medium");
        assert!(req.service_tier.is_none());
    }

    #[test]
    fn build_responses_request_strips_openai_provider_prefix_for_codex_backend() {
        let req =
            CodexNativeClient::build_responses_request(&[], None, "openai/gpt-5.4-mini", true);

        assert_eq!(req.model, "gpt-5.4-mini");
        assert!(req.reasoning.is_none());
        assert!(req.service_tier.is_none());
    }

    #[test]
    fn build_responses_request_strips_prefix_before_variant_parsing() {
        let req = CodexNativeClient::build_responses_request(
            &[],
            None,
            "openai/gpt-5.5-medium-fast",
            true,
        );

        assert_eq!(req.model, "gpt-5.5");
        assert_eq!(req.reasoning.as_ref().unwrap()["effort"], "medium");
        assert_eq!(req.service_tier.as_deref(), Some("priority"));
    }

    #[test]
    fn build_responses_request_serializes_reasoning_and_service_tier() {
        let req = CodexNativeClient::build_responses_request(&[], None, "gpt-5.5-xhigh-fast", true);

        let value = serde_json::to_value(req).expect("serialize request");
        assert_eq!(value["model"], "gpt-5.5");
        assert_eq!(value["reasoning"]["effort"], "xhigh");
        assert_eq!(value["service_tier"], "priority");
        assert!(value.get("max_output_tokens").is_none());
        assert!(value.get("temperature").is_none());
    }

    #[test]
    fn build_responses_request_maps_gpt_5_6_ultra_fast_to_native_fields() {
        let req =
            CodexNativeClient::build_responses_request(&[], None, "gpt-5.6-sol-ultra-fast", true);

        assert_eq!(req.model, "gpt-5.6-sol");
        assert_eq!(req.reasoning.as_ref().unwrap()["effort"], "max");
        assert_eq!(req.service_tier.as_deref(), Some("priority"));
    }
}
