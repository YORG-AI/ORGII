//! HTTP client for the OpenAI Responses API (public API).
//!
//! Sends requests to `api.openai.com/v1/responses` using standard Bearer
//! authentication. Supports `max_output_tokens` but NOT `temperature` for
//! reasoning models (GPT-5.4+, o1, o3, o4).

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::providers::responses_common::{
    convert_messages, convert_tools_with_choice, ResponsesRequest,
};
use crate::providers::traits::{ProviderConfig, ProviderError};
use crate::utils::build_http_client;

const DEFAULT_API_BASE: &str = "https://api.openai.com/v1";

/// LLM client for OpenAI Responses API (GPT-5.4+ models).
///
/// Translates between the internal Chat Completions message format
/// (used by the agent loop) and the Responses API format.
pub struct OpenAIResponsesClient {
    pub(super) client: Client,
    pub(super) config: ProviderConfig,
    pub(super) default_model: String,
}

impl OpenAIResponsesClient {
    pub fn new(config: ProviderConfig, default_model: String) -> Self {
        let client = build_http_client(std::time::Duration::from_secs(300));

        Self {
            client,
            config,
            default_model,
        }
    }

    /// Build the responses endpoint URL.
    pub(super) fn responses_url(&self) -> String {
        let base = self.config.api_base.as_deref().unwrap_or(DEFAULT_API_BASE);
        format!("{}/responses", base.trim_end_matches('/'))
    }

    /// Build HTTP request with required headers.
    pub(super) fn build_request(
        &self,
        url: &str,
        body: &impl Serialize,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let mut req = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.config.api_key));

        for (key, value) in &self.config.extra_headers {
            req = req.header(key.as_str(), value.as_str());
        }

        Ok(req.json(body))
    }

    /// Build a ResponsesRequest from Chat Completions format inputs.
    ///
    /// MCP image sidecars on
    /// `role:"tool"` messages are *always* lifted into follow-up
    /// `user` items with `input_image` blocks. The Responses API
    /// family (GPT-5, GPT-5.4-*, o1/o3/o4) is uniformly vision-capable,
    /// and non-vision models returning 400 is strictly better than
    /// silently dropping image evidence.
    pub(crate) fn build_responses_request(
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        _temperature: f32,
        stream: bool,
    ) -> ResponsesRequest {
        let (instructions, input) = convert_messages(messages);
        let (converted_tools, tool_choice) = convert_tools_with_choice(tools);

        // Strip the reasoning-level suffix ORG2 encodes into variant ids and
        // map the level to the Responses API `reasoning.effort` parameter.
        // The Responses API rejects the suffixed alias; sending reasoning to
        // a non-reasoning model returns HTTP 400, so only OpenAiEffort modes
        // set it.
        let parsed = crate::providers::thinking_mode::parse_model_variant(model);
        let mode = crate::providers::thinking_mode::resolve_thinking_mode(
            &parsed.base_model,
            crate::providers::registry::provider_id::OPENAI,
        );
        let reasoning = if mode == crate::providers::thinking_mode::ThinkingMode::OpenAiEffort {
            crate::providers::thinking_mode::openai_effort(parsed.level)
                .map(|effort| serde_json::json!({ "effort": effort }))
        } else {
            None
        };

        ResponsesRequest {
            model: parsed.base_model,
            input,
            instructions,
            tools: converted_tools,
            tool_choice,
            max_output_tokens: Some(max_tokens),
            temperature: None,
            reasoning,
            store: false,
            stream,
        }
    }

    /// Parse HTTP error response into ProviderError.
    pub(super) fn parse_error(status: u16, body: &str, retry_after: Option<u64>) -> ProviderError {
        let message = crate::providers::http_error_body::clean_error_message(status, body);
        match status {
            401 => ProviderError::AuthError(message),
            429 => ProviderError::RateLimited {
                message,
                retry_after_secs: retry_after,
            },
            404 => ProviderError::ModelNotFound(message),
            _ => ProviderError::RequestFailed(format!("HTTP {}: {}", status, message)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_responses_request_strips_suffix_and_sets_reasoning() {
        let req = OpenAIResponsesClient::build_responses_request(
            &[],
            None,
            "gpt-5.5-high",
            1024,
            0.0,
            false,
        );
        assert_eq!(req.model, "gpt-5.5");
        assert_eq!(req.reasoning.as_ref().unwrap()["effort"], "high");
    }

    #[test]
    fn build_responses_request_default_omits_reasoning() {
        let req =
            OpenAIResponsesClient::build_responses_request(&[], None, "gpt-5.5", 1024, 0.0, false);
        assert_eq!(req.model, "gpt-5.5");
        assert!(req.reasoning.is_none());
    }

    #[test]
    fn build_responses_request_preserves_upper_efforts_on_the_wire() {
        for (base, efforts) in [
            ("gpt-5.4", &["xhigh"][..]),
            ("gpt-5.5", &["xhigh"][..]),
            ("gpt-5.6-sol", &["xhigh", "max"][..]),
            ("gpt-5.6-terra", &["xhigh", "max"][..]),
            ("gpt-5.6-luna", &["xhigh", "max"][..]),
        ] {
            for effort in efforts {
                for stream in [false, true] {
                    let req = OpenAIResponsesClient::build_responses_request(
                        &[],
                        None,
                        &format!("{base}-{effort}"),
                        4096,
                        0.0,
                        stream,
                    );
                    let body = serde_json::to_value(req).unwrap();
                    assert_eq!(body["model"], base);
                    assert_eq!(body["reasoning"]["effort"], *effort);
                    assert_eq!(body["stream"], stream);
                }
            }
        }
    }

    #[test]
    fn build_responses_request_non_reasoning_omits_reasoning() {
        let req =
            OpenAIResponsesClient::build_responses_request(&[], None, "gpt-4o", 1024, 0.0, false);
        assert_eq!(req.model, "gpt-4o");
        assert!(req.reasoning.is_none());
    }
}
