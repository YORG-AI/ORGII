//! LLM provider module.
//!
//! Defines the [`LLMProvider`] trait and provider registry for
//! connecting to multiple LLM backends (OpenAI, Anthropic, etc.).
//!
//! Four client implementations:
//! - `OpenAICompatClient`: OpenAI chat completions format (works with most providers)
//! - `OpenAIResponsesClient`: OpenAI Responses API format for GPT-5.4+ models
//! - `AnthropicClient`: Native Anthropic Messages API format (for direct Anthropic API access)
//! - `CodexNativeClient`: OpenAI Responses API format for Codex OAuth

pub mod anthropic_native;
pub mod codex_native;
pub mod cursor_native;
#[cfg(debug_assertions)]
pub mod e2e_fake;
pub mod factory;
pub mod http_error_body;
pub mod model_capabilities;
pub mod model_hints;
pub mod openai_adaptive;
pub mod openai_compat;
pub mod openai_policy;
pub mod openai_responses;
pub mod registry;
pub mod reliable;
pub mod responses_common;
pub mod safe_truncate;
pub mod thinking_mode;
pub mod traits;
pub mod wire_sanitize;

#[cfg(test)]
mod tests;

// Items kept at the `providers::` surface — `LLMResponse`,
// `ProviderConfig`, `ProviderError`, `StreamDelta`, `ToolCallRequest`
// were re-exported but never imported as `providers::<name>`; they're
// always reached via `providers::traits::<name>`.
pub use factory::{check_credentials_available, create_provider};
pub use traits::{finish_reason, usage_key, LLMProvider};
