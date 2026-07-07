//! OpenAI-compatible chat completions API types
//!
//! Covers: `ChatRequest`, `ChatMessage`, `ToolDefinition`, `ToolCallResponse`,
//! streaming delta types, and `ApiErrorResponse`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Request body for OpenAI-compatible chat completions.
#[derive(Debug, Serialize)]
pub(super) struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    /// Chat Completions token-limit parameter used by most providers and older OpenAI models.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Required by OpenAI GPT-5+, o1, o3, o4 models (replaces max_tokens).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stream: bool,
    /// Required for OpenAI-compatible streaming to include usage in the final chunk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<Value>,
    /// OpenAI reasoning effort (gpt-5+/o-series). Top-level Chat Completions
    /// parameter; sending it to a non-reasoning model returns HTTP 400.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Zhipu GLM thinking toggle `{type: enabled|disabled}`. Distinct from
    /// OpenAI `reasoning_effort` — only one applies per request, decided by
    /// `thinking_mode::resolve_thinking_mode`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
}

/// Initial Chat Completions token-limit field hint from the model alias.
///
/// This is not authoritative. Custom relays can name models arbitrarily, so
/// `openai_policy` can override this hint after structured protocol errors.
pub(crate) fn chat_token_limit_field_hint(
    model: &str,
) -> crate::providers::openai_policy::ChatTokenLimitField {
    let model_lower = model.to_lowercase();
    if model_lower.starts_with("gpt-5")
        || model_lower.starts_with("o1")
        || model_lower.starts_with("o3")
        || model_lower.starts_with("o4")
        || model_lower.starts_with("o5")
    {
        crate::providers::openai_policy::ChatTokenLimitField::MaxCompletionTokens
    } else {
        crate::providers::openai_policy::ChatTokenLimitField::MaxTokens
    }
}

/// SSE streaming chunk from OpenAI-compatible APIs.
#[derive(Debug, Deserialize)]
pub(super) struct StreamChunk {
    pub choices: Vec<StreamChoice>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
pub(super) struct StreamChoice {
    pub delta: StreamDeltaResponse,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct StreamDeltaResponse {
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<StreamToolCallDelta>>,
    /// Reasoning channel — aliases cover the four field names seen in the wild:
    /// `reasoning_content` (DeepSeek-R1, Kimi K1.5, Mistral Magistral),
    /// `reasoning` (OpenRouter, some vLLM builds),
    /// `thinking` / `thinking_content` (LiteLLM proxies, some forks).
    /// Models that inline reasoning inside `delta.content` with `<think>…</think>`
    /// tags are split out by `ThinkTagSplitter` in `sse_stream`.
    #[serde(alias = "reasoning", alias = "thinking", alias = "thinking_content")]
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct StreamToolCallDelta {
    pub index: Option<usize>,
    pub id: Option<String>,
    pub function: Option<StreamFunctionDelta>,
    /// Gemini returns thought_signature inside extra_content.google.thought_signature
    pub extra_content: Option<ExtraContent>,
}

/// Gemini-specific extra content on tool calls (OpenAI-compat format).
#[derive(Debug, Deserialize)]
pub(super) struct ExtraContent {
    google: Option<GoogleExtra>,
}

#[derive(Debug, Deserialize)]
struct GoogleExtra {
    thought_signature: Option<Value>,
}

impl ExtraContent {
    pub fn thought_signature(&self) -> Option<&Value> {
        self.google.as_ref()?.thought_signature.as_ref()
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct StreamFunctionDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// Response from OpenAI-compatible chat completions.
#[derive(Debug, Deserialize)]
pub(super) struct ChatCompletionResponse {
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Choice {
    pub message: MessageResponse,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct MessageResponse {
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallResponse>>,
    /// Reasoning/thinking content. Aliases cover the same flavors as
    /// `StreamDeltaResponse::reasoning_content` (see there for the list).
    /// Non-streaming responses with inline `<think>…</think>` in `content`
    /// are split by the same `ThinkTagSplitter` invoked from `chat::run_chat`.
    #[serde(alias = "reasoning", alias = "thinking", alias = "thinking_content")]
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ToolCallResponse {
    pub id: String,
    #[serde(rename = "type")]
    pub _type: Option<String>,
    pub function: FunctionCallResponse,
    pub extra_content: Option<ExtraContent>,
}

#[derive(Debug, Deserialize)]
pub(super) struct FunctionCallResponse {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct Usage {
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
    /// OpenAI prompt caching: `prompt_tokens_details.cached_tokens` reports
    /// how many prompt tokens were served from the provider prompt cache.
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

/// `usage.prompt_tokens_details` from OpenAI-compatible responses.
#[derive(Debug, Deserialize)]
pub(super) struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: i64,
}

/// Error response from the API.
/// Handles both OpenAI format (`{ "error": { "message": "..." } }`)
/// and Google Gemini format (`{ "error": { "message": "...", "status": "RESOURCE_EXHAUSTED", "code": 429 } }`).
///
/// Distinct from `super::super::anthropic_native::types::ApiErrorResponse`,
/// which decodes the Anthropic Messages API error envelope (`{type,
/// message}`). Both stay `pub(super)` so the names cannot collide in
/// downstream call sites.
#[derive(Debug, Deserialize)]
pub(super) struct ApiErrorResponse {
    pub error: Option<ApiError>,
}

/// OpenAI/Gemini-shaped error body — `{message, status, code}`.
///
/// See `super::super::anthropic_native::types::ApiError` for the
/// Anthropic variant which carries `type` + `message` only.
#[derive(Debug, Deserialize)]
pub(super) struct ApiError {
    pub message: Option<String>,
    /// OpenAI-style machine-readable error type (for example
    /// `usage_limit_reached` or `invalid_request_error`).
    #[serde(rename = "type")]
    pub error_type: Option<String>,
    /// Google-style status string (e.g. "RESOURCE_EXHAUSTED", "NOT_FOUND")
    pub status: Option<String>,
    /// Google-style numeric error code
    pub code: Option<i32>,
}

impl ApiError {
    /// Extract the best available error message, falling back to status/code.
    pub fn best_message(&self) -> String {
        if let Some(ref msg) = self.message {
            if !msg.is_empty() {
                return msg.clone();
            }
        }
        if let Some(ref status) = self.status {
            if let Some(code) = self.code {
                return format!("{} (code {})", status, code);
            }
            return status.clone();
        }
        if let Some(code) = self.code {
            return format!("Error code {}", code);
        }
        "Unknown error".to_string()
    }
}

/// Helper trait extension for reqwest to add bearer token auth.
pub(super) trait RequestBuilderExt {
    fn bearer_token(self, token: &str) -> Self;
}

impl RequestBuilderExt for reqwest::RequestBuilder {
    fn bearer_token(self, token: &str) -> Self {
        self.header("Authorization", format!("Bearer {}", token))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_delta(s: &str) -> StreamDeltaResponse {
        serde_json::from_str(s).expect("delta should parse")
    }

    #[test]
    fn reasoning_content_field_is_recognised() {
        let d = parse_delta(r#"{"reasoning_content":"r1 trace"}"#);
        assert_eq!(d.reasoning_content.as_deref(), Some("r1 trace"));
    }

    #[test]
    fn reasoning_alias_openrouter_shape() {
        let d = parse_delta(r#"{"reasoning":"openrouter trace"}"#);
        assert_eq!(d.reasoning_content.as_deref(), Some("openrouter trace"));
    }

    #[test]
    fn thinking_alias_litellm_shape() {
        let d = parse_delta(r#"{"thinking":"litellm trace"}"#);
        assert_eq!(d.reasoning_content.as_deref(), Some("litellm trace"));
    }

    #[test]
    fn thinking_content_alias() {
        let d = parse_delta(r#"{"thinking_content":"alt trace"}"#);
        assert_eq!(d.reasoning_content.as_deref(), Some("alt trace"));
    }

    #[test]
    fn content_and_reasoning_can_coexist() {
        let d = parse_delta(r#"{"content":"out","reasoning":"in"}"#);
        assert_eq!(d.content.as_deref(), Some("out"));
        assert_eq!(d.reasoning_content.as_deref(), Some("in"));
    }

    #[test]
    fn message_response_supports_aliases() {
        let m: MessageResponse =
            serde_json::from_str(r#"{"content":"x","reasoning":"trace"}"#).unwrap();
        assert_eq!(m.content.as_deref(), Some("x"));
        assert_eq!(m.reasoning_content.as_deref(), Some("trace"));
    }
}
