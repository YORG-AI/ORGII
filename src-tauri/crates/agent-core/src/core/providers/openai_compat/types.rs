//! OpenAI-compatible chat completions API types
//!
//! Covers: `ChatRequest`, `ChatMessage`, `ToolDefinition`, `ToolCallResponse`,
//! streaming delta types, and `ApiErrorResponse`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::providers::traits::usage_key;

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
    #[serde(default, alias = "promptTokens")]
    pub prompt_tokens: i64,
    #[serde(default, alias = "completionTokens")]
    pub completion_tokens: i64,
    #[serde(default, alias = "totalTokens")]
    pub total_tokens: i64,
    /// Standard OpenAI-compatible prompt-token details. OpenAI, Zhipu,
    /// DashScope, Groq, xAI, MiniMax, and aggregators such as OpenRouter use
    /// this shape for cache reads; OpenRouter can also report cache writes.
    #[serde(default, alias = "promptTokensDetails")]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
    /// DeepSeek legacy prompt-cache hit counter. DeepSeek's docs describe a
    /// top-level hit/miss split (`prompt_tokens == hit + miss`), but DeepSeek
    /// V4+ actually reports cache hits via the standard nested
    /// `prompt_tokens_details.cached_tokens` shape, handled above. This field
    /// remains for relays that still forward the legacy split and for older
    /// DeepSeek deployments.
    #[serde(default, alias = "promptCacheHitTokens")]
    pub prompt_cache_hit_tokens: Option<i64>,
    /// DeepSeek legacy uncached prompt counter (companion to
    /// `prompt_cache_hit_tokens`); a miss is regular prompt input, not a
    /// cache write. See that field's doc for the V4 nested-shape note.
    #[serde(default, alias = "promptCacheMissTokens")]
    pub prompt_cache_miss_tokens: Option<i64>,
    /// Normalized top-level cache counters emitted by some relays. These
    /// relays already report `prompt_tokens` excluding the cache counters.
    #[serde(default, alias = "cacheReadTokens")]
    pub cache_read_tokens: i64,
    #[serde(default, alias = "cacheWriteTokens")]
    pub cache_write_tokens: i64,
}

#[derive(Debug, Deserialize)]
pub(super) struct PromptTokensDetails {
    #[serde(default, alias = "cachedTokens")]
    pub cached_tokens: Option<i64>,
    #[serde(default, alias = "cacheWriteTokens")]
    pub cache_write_tokens: Option<i64>,
}

#[derive(Debug, Default)]
struct NormalizedPromptUsage {
    prompt_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
}

impl Usage {
    /// Convert provider usage into ORGII's normalized accounting contract:
    /// `prompt_tokens` contains uncached input, while cache reads and writes
    /// live in their own counters.
    ///
    /// OpenAI-style nested counters are included in the provider's
    /// `prompt_tokens`, so they are subtracted exactly once. DeepSeek reports
    /// the same inclusive total plus an explicit hit/miss split; its miss
    /// counter becomes normalized prompt input. Already-normalized relay
    /// counters remain separate and therefore are not subtracted.
    pub(super) fn to_usage_map(&self) -> HashMap<String, i64> {
        let prompt = self.normalized_prompt_usage();

        let mut usage = HashMap::new();
        usage.insert(usage_key::PROMPT_TOKENS.to_string(), prompt.prompt_tokens);
        usage.insert(
            usage_key::COMPLETION_TOKENS.to_string(),
            self.completion_tokens,
        );
        usage.insert(usage_key::TOTAL_TOKENS.to_string(), self.total_tokens);
        if prompt.cache_read_tokens > 0 {
            usage.insert(
                usage_key::CACHE_READ_TOKENS.to_string(),
                prompt.cache_read_tokens,
            );
        }
        if prompt.cache_write_tokens > 0 {
            usage.insert(
                usage_key::CACHE_WRITE_TOKENS.to_string(),
                prompt.cache_write_tokens,
            );
        }
        usage
    }

    fn normalized_prompt_usage(&self) -> NormalizedPromptUsage {
        let raw_prompt = self.prompt_tokens.max(0);
        let has_deepseek_split =
            self.prompt_cache_hit_tokens.is_some() || self.prompt_cache_miss_tokens.is_some();

        // Standard OpenAI Chat Completions shape. Option-valued detail fields
        // let an empty `{}` fall through instead of shadowing a vendor shape.
        // Some relays emit both shapes but leave nested `cached_tokens` at
        // zero; in that case a non-empty DeepSeek split is authoritative.
        if let Some(details) = self.prompt_tokens_details.as_ref().filter(|details| {
            let has_nested_fields =
                details.cached_tokens.is_some() || details.cache_write_tokens.is_some();
            let has_nested_cache = details.cached_tokens.unwrap_or(0) > 0
                || details.cache_write_tokens.unwrap_or(0) > 0;
            has_nested_fields && (!has_deepseek_split || has_nested_cache)
        }) {
            let cache_read = details.cached_tokens.unwrap_or(0).max(0);
            let cache_write = details.cache_write_tokens.unwrap_or(0).max(0);
            return NormalizedPromptUsage {
                prompt_tokens: raw_prompt
                    .saturating_sub(cache_read)
                    .saturating_sub(cache_write)
                    .max(0),
                cache_read_tokens: cache_read,
                cache_write_tokens: cache_write,
            };
        }

        // DeepSeek exposes a top-level hit/miss split. Derive a missing half
        // from the inclusive prompt total for compatibility with relays that
        // forward only one of the two vendor fields.
        if has_deepseek_split {
            let cache_read = self
                .prompt_cache_hit_tokens
                .map(|value| value.max(0))
                .unwrap_or_else(|| {
                    raw_prompt.saturating_sub(self.prompt_cache_miss_tokens.unwrap_or(0).max(0))
                });
            let uncached_prompt = self
                .prompt_cache_miss_tokens
                .map(|value| value.max(0))
                .unwrap_or_else(|| raw_prompt.saturating_sub(cache_read));
            return NormalizedPromptUsage {
                prompt_tokens: uncached_prompt,
                cache_read_tokens: cache_read,
                cache_write_tokens: 0,
            };
        }

        NormalizedPromptUsage {
            prompt_tokens: raw_prompt,
            cache_read_tokens: self.cache_read_tokens.max(0),
            cache_write_tokens: self.cache_write_tokens.max(0),
        }
    }
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

    #[test]
    fn standard_prompt_cache_details_are_normalized() {
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_tokens_details":{"cached_tokens":800}}"#,
        )
        .expect("standard OpenAI-compatible usage shape should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(usage[usage_key::COMPLETION_TOKENS], 300);
        assert_eq!(usage[usage_key::TOTAL_TOKENS], 1500);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 800);
        assert!(!usage.contains_key(usage_key::CACHE_WRITE_TOKENS));
    }

    #[test]
    fn deepseek_prompt_cache_hit_and_miss_are_normalized() {
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":400}"#,
        )
        .expect("DeepSeek usage shape should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(usage[usage_key::COMPLETION_TOKENS], 300);
        assert_eq!(usage[usage_key::TOTAL_TOKENS], 1500);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 800);
        assert!(!usage.contains_key(usage_key::CACHE_WRITE_TOKENS));
    }

    #[test]
    fn deepseek_split_wins_when_relay_emits_empty_nested_details() {
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_tokens_details":{"cached_tokens":0},"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":400}"#,
        )
        .expect("dual-shape relay usage should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 800);
    }

    #[test]
    fn deepseek_split_derives_missing_miss_from_prompt_total() {
        // A relay forwards only the hit counter; the miss half is derived as
        // `prompt_tokens - hit`, so the normalized billable prompt is non-zero.
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_cache_hit_tokens":800}"#,
        )
        .expect("DeepSeek hit-only usage should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 800);
        assert!(!usage.contains_key(usage_key::CACHE_WRITE_TOKENS));
    }

    #[test]
    fn deepseek_split_derives_missing_hit_from_prompt_total() {
        // A relay forwards only the miss counter; the hit half is derived as
        // `prompt_tokens - miss`.
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_cache_miss_tokens":400}"#,
        )
        .expect("DeepSeek miss-only usage should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 800);
        assert!(!usage.contains_key(usage_key::CACHE_WRITE_TOKENS));
    }

    #[test]
    fn nested_cache_write_tokens_are_normalized() {
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":800}}"#,
        )
        .expect("OpenRouter cache-write usage shape should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert!(!usage.contains_key(usage_key::CACHE_READ_TOKENS));
        assert_eq!(usage[usage_key::CACHE_WRITE_TOKENS], 800);
    }

    #[test]
    fn camel_case_openai_compat_usage_is_normalized() {
        let u: Usage = serde_json::from_str(
            r#"{"promptTokens":1200,"completionTokens":300,"totalTokens":1500,"promptTokensDetails":{"cachedTokens":800}}"#,
        )
        .expect("camelCase OpenAI-compatible usage shape should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(usage[usage_key::COMPLETION_TOKENS], 300);
        assert_eq!(usage[usage_key::TOTAL_TOKENS], 1500);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 800);
    }

    #[test]
    fn usage_without_cache_fields_defaults_to_zero() {
        let u: Usage =
            serde_json::from_str(r#"{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}"#)
                .expect("plain OpenAI usage should still parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 10);
        assert_eq!(usage[usage_key::COMPLETION_TOKENS], 5);
        assert_eq!(usage[usage_key::TOTAL_TOKENS], 15);
        assert!(!usage.contains_key(usage_key::CACHE_READ_TOKENS));
        assert!(!usage.contains_key(usage_key::CACHE_WRITE_TOKENS));
    }

    #[test]
    fn normalized_top_level_cache_counters_remain_supported() {
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":200,"completion_tokens":50,"total_tokens":350,"cache_read_tokens":100,"cache_write_tokens":25}"#,
        )
        .expect("normalized relay usage should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 200);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 100);
        assert_eq!(usage[usage_key::CACHE_WRITE_TOKENS], 25);
    }

    #[test]
    fn malformed_nested_cache_count_cannot_make_prompt_negative() {
        let u: Usage = serde_json::from_str(
            r#"{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":150}}"#,
        )
        .expect("usage should parse");
        let usage = u.to_usage_map();

        assert_eq!(usage[usage_key::PROMPT_TOKENS], 0);
        assert_eq!(usage[usage_key::CACHE_READ_TOKENS], 150);
    }
}
