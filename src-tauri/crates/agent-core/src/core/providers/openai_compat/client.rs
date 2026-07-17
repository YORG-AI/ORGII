//! HTTP client for OpenAI-compatible chat completions API
//!
//! Builds and sends `/v1/chat/completions` requests. Works with any provider
//! that speaks the OpenAI format (OpenAI, DeepSeek, Groq, OpenRouter, etc.).
//! Parses `ApiErrorResponse` on non-2xx responses.

use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use tracing::{debug, warn};

use super::types::{ApiErrorResponse, StreamChunk, ToolCallResponse};
use crate::providers::openai_policy::{resolve_openai_chat_wire_policy, OpenAiChatWirePolicy};
use crate::providers::registry::{provider_id, ProviderSpec};
use crate::providers::traits::{
    finish_reason as finish, usage_key, LLMResponse, ProviderConfig, ProviderError, ToolCallRequest,
};
use crate::utils::build_http_client;

/// An LLM client that speaks the OpenAI chat completions API format.
///
/// Works with OpenAI, Anthropic (via OpenRouter/proxy), DeepSeek, Groq,
/// OpenRouter, Moonshot, DashScope, Gemini, and any
/// OpenAI-compatible server.
pub struct OpenAICompatClient {
    /// HTTP client (reused for connection pooling).
    pub(super) client: Client,
    /// Provider configuration (API key, base URL, etc.).
    pub(super) config: ProviderConfig,
    /// Provider spec from the registry.
    pub(super) provider_spec: &'static ProviderSpec,
    /// Default model name.
    pub(super) default_model: String,
    /// Selected account id, when this client was created for a session account.
    pub(super) account_id: Option<String>,
}

impl OpenAICompatClient {
    /// Create a new client for a specific provider.
    pub fn new(
        config: ProviderConfig,
        provider_spec: &'static ProviderSpec,
        default_model: String,
    ) -> Self {
        Self::new_with_account(config, provider_spec, default_model, None)
    }

    pub(crate) fn new_with_account(
        config: ProviderConfig,
        provider_spec: &'static ProviderSpec,
        default_model: String,
        account_id: Option<String>,
    ) -> Self {
        let client = build_http_client(std::time::Duration::from_secs(300));

        Self {
            client,
            config,
            provider_spec,
            default_model,
            account_id,
        }
    }

    pub(super) fn chat_wire_policy(&self, model: &str) -> OpenAiChatWirePolicy {
        resolve_openai_chat_wire_policy(
            self.provider_spec,
            self.account_id.as_deref(),
            self.config.api_base.as_deref(),
            model,
        )
    }

    pub(super) fn is_azure(&self) -> bool {
        self.provider_spec.name == provider_id::AZURE_OPENAI || self.config.is_azure
    }

    /// Strip the provider spec's known prefixes from a model name to get the bare name.
    /// Used for Azure proxy mode where the endpoint expects the deployment/model name
    /// without litellm-style provider prefixes (e.g., "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5").
    pub(super) fn strip_provider_prefix(&self, model: &str) -> String {
        for prefix in self.provider_spec.skip_prefixes {
            if let Some(rest) = model.strip_prefix(prefix) {
                return rest.to_string();
            }
        }
        model.to_string()
    }

    /// Build the API URL for the chat completions endpoint.
    ///
    /// For Azure (both traditional and proxy mode), the URL requires:
    /// - `/openai/deployments/{model}/chat/completions?api-version=...` (standard)
    /// - OR `{base}/chat/completions?api-version=...` if base already contains deployment path
    ///
    /// `model` is the resolved model name (provider prefix already stripped).
    pub(super) fn chat_url(&self, model: &str) -> String {
        let base = self
            .config
            .api_base
            .as_deref()
            .or(self.provider_spec.default_api_base)
            .unwrap_or("https://api.openai.com/v1");

        let base = base.trim_end_matches('/');
        if self.is_azure() {
            if base.contains("/openai/deployments/") {
                // User already configured a deployment-specific base_url
                format!("{}/chat/completions?api-version=2024-12-01-preview", base)
            } else if base.ends_with("/v1") {
                // LiteLLM-style proxy: base_url includes /openai/v1 or /v1
                format!("{}/chat/completions?api-version=2024-12-01-preview", base)
            } else {
                // Bare Azure endpoint — build deployment URL from model name.
                // This handles both traditional Azure and Azure proxy mode where
                // the credential's base_url is just the resource endpoint.
                format!(
                    "{}/openai/deployments/{}/chat/completions?api-version=2024-12-01-preview",
                    base, model
                )
            }
        } else {
            format!("{}/chat/completions", base)
        }
    }

    /// Parse tool calls from the API response.
    pub(super) fn parse_tool_calls(tool_calls: &[ToolCallResponse]) -> Vec<ToolCallRequest> {
        tool_calls
            .iter()
            .map(|tc| {
                let arguments: Value =
                    serde_json::from_str(&tc.function.arguments).unwrap_or_else(|err| {
                        warn!(
                            "Failed to parse tool call arguments for '{}': {}",
                            tc.function.name, err
                        );
                        Value::Object(serde_json::Map::new())
                    });

                ToolCallRequest {
                    id: tc.id.clone(),
                    name: tc.function.name.clone(),
                    arguments,
                    thought_signature: tc
                        .extra_content
                        .as_ref()
                        .and_then(|ec| ec.thought_signature().cloned()),
                }
            })
            .collect()
    }

    /// Parse an API error response.
    /// Handles both OpenAI and Google Gemini error formats.
    pub(super) fn parse_error_response(
        status: u16,
        body: &str,
        retry_after_secs: Option<u64>,
    ) -> ProviderError {
        use crate::providers::safe_truncate::safe_truncate_utf8;
        tracing::warn!(
            "[provider] API error HTTP {}: {}",
            status,
            safe_truncate_utf8(body, 500)
        );

        if let Ok(err_resp) = serde_json::from_str::<ApiErrorResponse>(body) {
            if let Some(err) = err_resp.error {
                let message = err.best_message();
                let lower = message.to_lowercase();

                if err.error_type.as_deref() == Some("usage_limit_reached")
                    || lower.contains("usage limit has been reached")
                {
                    return ProviderError::UsageLimitReached(message);
                }

                if lower.contains("context_length_exceeded")
                    || lower.contains("maximum context length")
                    || lower.contains("prompt is too long")
                    || lower.contains("max_tokens` exceed context limit")
                {
                    return ProviderError::ContextTooLong(message);
                }

                return match status {
                    401 => ProviderError::AuthError(message),
                    429 => ProviderError::RateLimited {
                        message,
                        retry_after_secs,
                    },
                    529 => ProviderError::Overloaded {
                        message,
                        retry_after_secs,
                    },
                    404 => ProviderError::ModelNotFound(message),
                    _ => ProviderError::RequestFailed(format!("HTTP {}: {}", status, message)),
                };
            }
        }

        ProviderError::RequestFailed(format!(
            "HTTP {}: {}",
            status,
            crate::providers::http_error_body::clean_error_message(status, body)
        ))
    }

    /// Reassemble an SSE-streamed body (sent by providers that ignore `stream:false`)
    /// into a single `LLMResponse`.
    pub(super) fn reassemble_sse_to_response(body: &str) -> Result<LLMResponse, ProviderError> {
        let mut content = String::new();
        let mut usage: HashMap<String, i64> = HashMap::new();

        for line in body.lines() {
            let line = line.trim();
            if line == "data: [DONE]" || line.is_empty() {
                continue;
            }
            let json_str = line.strip_prefix("data: ").unwrap_or(line);
            let chunk: StreamChunk = match serde_json::from_str(json_str) {
                Ok(chunk) => chunk,
                Err(err) => {
                    // Provider may emit non-OpenAI keepalives or vendor
                    // events; skip silently in production but log at
                    // debug so streaming-format drift is observable.
                    debug!(
                        "[openai_compat] reassemble_sse: skipping unparseable chunk: {} \
                         (head: {:?})",
                        err,
                        crate::utils::safe_truncate_chars_to_string(&json_str, 120),
                    );
                    continue;
                }
            };
            for choice in &chunk.choices {
                if let Some(ref text) = choice.delta.content {
                    content.push_str(text);
                }
            }
            if let Some(ref api_usage) = chunk.usage {
                usage.insert(
                    usage_key::PROMPT_TOKENS.to_string(),
                    api_usage.prompt_tokens,
                );
                usage.insert(
                    usage_key::COMPLETION_TOKENS.to_string(),
                    api_usage.completion_tokens,
                );
                usage.insert(usage_key::TOTAL_TOKENS.to_string(), api_usage.total_tokens);
                if let Some(ref details) = api_usage.prompt_tokens_details {
                    if details.cached_tokens > 0 {
                        usage.insert(
                            usage_key::CACHE_READ_TOKENS.to_string(),
                            details.cached_tokens,
                        );
                    }
                }
            }
        }

        if content.is_empty() {
            return Err(ProviderError::ParseError(
                "SSE reassembly produced empty content".to_string(),
            ));
        }

        Ok(LLMResponse {
            content: Some(content),
            tool_calls: Vec::new(),
            finish_reason: finish::STOP.to_string(),
            usage,
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::OpenAICompatClient;
    use crate::providers::traits::ProviderError;

    #[test]
    fn usage_limit_http_429_is_typed_and_non_transient() {
        let error = OpenAICompatClient::parse_error_response(
            429,
            r#"{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}"#,
            None,
        );

        assert!(matches!(
            error,
            ProviderError::UsageLimitReached(message)
                if message == "The usage limit has been reached"
        ));
    }

    #[test]
    fn ordinary_http_429_remains_retryable_rate_limit() {
        let error = OpenAICompatClient::parse_error_response(
            429,
            r#"{"error":{"type":"rate_limit_error","message":"Slow down"}}"#,
            Some(2),
        );

        assert!(matches!(
            error,
            ProviderError::RateLimited {
                message,
                retry_after_secs: Some(2)
            } if message == "Slow down"
        ));
    }
}
