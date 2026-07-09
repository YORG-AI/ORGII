//! Side query: lightweight, non-streaming LLM call for auxiliary tasks.
//!
//! Used when the agent needs an LLM answer outside the main turn loop
//! (classification, summarization, labeling, etc.). Separate from the
//! conversation context — no tool execution, no streaming, tokens are
//! not counted toward the session cost.
//!
//! Three layers of defense against thinking-only / empty-text responses:
//!
//! 1. **Structured output**: forced tool call guarantees a `tool_use` block
//!    regardless of how much thinking the model emits (cf. claude_code
//!    `tool_choice: {type:'tool'}`).
//! 2. **Thinking directive**: for `PlainText` mode, sends `thinking: disabled`
//!    on Optional models, pads `max_tokens` on AlwaysOn models.
//! 3. **`primary_text()` fallback**: when text is empty but
//!    `reasoning_content` exists, uses reasoning as last-resort content.
//!
//! Ref: claude_code/utils/sideQuery.ts

use serde_json::Value;
use tracing::{info, warn};

use crate::providers::model_capabilities;
use crate::providers::traits::{finish_reason, LLMProvider, LLMResponse, ProviderError};

/// Configuration for a side query call.
pub struct SideQueryConfig {
    /// Model to use. `None` = use the caller-supplied default.
    pub model: Option<String>,
    /// Maximum tokens in the response (default: 1024).
    pub max_tokens: u32,
    /// Sampling temperature (default: 0.0 for deterministic output).
    pub temperature: f32,
    /// Optional system prompt prepended as a system message.
    pub system_prompt: Option<String>,
    /// Structured output: when set, the LLM is forced to call a tool with
    /// the given name and JSON schema. The response is extracted from the
    /// tool call arguments instead of text content — empty text is
    /// irrelevant because `tool_use` blocks are always emitted.
    pub structured: Option<StructuredOutput>,
    /// KeyVault account ID for capability resolution + behavioral writeback.
    pub account_id: Option<String>,
    /// Suppress prompt-cache write breakpoints for this call. Set for
    /// one-shot requests whose prefix is never sent again (compaction
    /// summarization) — see [`ChatOptions::skip_cache_write`].
    pub skip_cache_write: bool,
    /// Use the provider's streaming path (`chat_streaming` with a no-op
    /// delta sink). Large prompts (e.g. compaction summarization over a
    /// near-full context window) can exceed non-streaming read timeouts on
    /// gateways/proxies; streaming keeps bytes flowing so the connection
    /// stays alive. Defaults to `false` (existing behavior).
    pub stream: bool,
}

/// Forced tool call for structured output.
pub struct StructuredOutput {
    /// Tool name the LLM must call (e.g. `"emit_summary"`).
    pub tool_name: String,
    /// JSON Schema for the tool's input. Must be a valid JSON Schema object.
    pub schema: Value,
}

impl Default for SideQueryConfig {
    fn default() -> Self {
        Self {
            model: None,
            max_tokens: 1024,
            temperature: 0.0,
            system_prompt: None,
            structured: None,
            account_id: None,
            skip_cache_write: false,
            stream: false,
        }
    }
}

/// Result of a side query call.
#[derive(Debug)]
pub struct SideQueryResult {
    /// The text content returned by the LLM. For structured output calls,
    /// this is empty (use `structured` instead).
    pub content: String,
    /// Prompt tokens used by this call.
    pub prompt_tokens: i64,
    /// Completion tokens used by this call.
    pub completion_tokens: i64,
    /// Structured output extracted from a forced tool call. `None` when
    /// `SideQueryConfig::structured` was not set.
    pub structured: Option<Value>,
    /// Provider-reported finish reason (see [`finish_reason`] constants).
    /// Callers that persist the output durably (e.g. compaction summaries)
    /// must reject `finish_reason::LENGTH` — it means the output was cut
    /// off at `max_tokens`.
    pub finish_reason: String,
}

#[derive(Debug)]
pub enum SideQueryError {
    Provider(ProviderError),
    /// The model hit its output token limit. Never accept this for side queries:
    /// summaries / classifiers may be syntactically parseable but semantically truncated.
    IncompleteOutput { finish_reason: String },
    EmptyContent,
}

impl std::fmt::Display for SideQueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Provider(err) => write!(formatter, "Side query failed: {err}"),
            Self::IncompleteOutput { finish_reason } => write!(
                formatter,
                "Side query returned incomplete output: finish_reason={finish_reason}"
            ),
            Self::EmptyContent => write!(formatter, "Side query returned empty content"),
        }
    }
}

impl std::error::Error for SideQueryError {}

// ─── Metadata key for tool_choice override ──────────────────────────
//
// The `LLMProvider::chat` signature does not carry `tool_choice` (it is
// set per-provider in request builders). To thread forced tool_choice for
// structured output without changing the trait, we inject a sentinel
// element at the end of the tools array. Provider request builders
// detect and strip it.
//
// ### Contract: every provider's tools entry-point MUST strip this sentinel
//
// The sentinel element has NO `"function"` key. A provider that forwards it
// verbatim to the wire leaks a `type`-less object into the request's `tools`
// array, which the OpenAI Responses backend rejects with
// `HTTP 400: Unsupported tool type: None`. Because `reliable.rs` historically
// treated that 400 as transient, the failure surfaced as a ~68s retry storm
// that delayed the user's first turn (see the side-query decoupling in
// `session/launch/mod.rs`).
//
// Each provider must remove the sentinel before serializing tools. Current
// handling, for reference when adding a new provider:
//   - `openai_compat`   → `extract_tool_choice_override` (chat.rs / sse_stream.rs)
//   - `anthropic_native`→ `extract_tool_choice_override` (request.rs)
//   - `openai_responses`→ `convert_tools_with_choice` (responses_common)
//   - `codex_native`    → `convert_tools_with_choice` (responses_common)
//   - `gemini_native`   → implicitly safe: `convert_tools` `filter_map`
//                         drops any element lacking a `name` key.
// A new provider that builds a `tools` payload without one of the above is a
// latent `Unsupported tool type` bug — wire it through the shared helper.

/// JSON key on a tools-array element that marks it as a tool_choice
/// override rather than a real tool definition.
pub const TOOL_CHOICE_OVERRIDE_KEY: &str = "_orgii_tool_choice_override";

/// Build a sentinel tools-array element that providers will extract as
/// the `tool_choice` request parameter.
fn tool_choice_override_element(tool_choice: Value) -> Value {
    serde_json::json!({ TOOL_CHOICE_OVERRIDE_KEY: tool_choice })
}

/// Extract the tool_choice override from a tools slice, returning the
/// override value and the cleaned tools slice (without the sentinel).
pub fn extract_tool_choice_override(tools: &[Value]) -> (Option<Value>, Vec<Value>) {
    let mut cleaned = Vec::with_capacity(tools.len());
    let mut override_val = None;
    for tool in tools {
        if tool.get(TOOL_CHOICE_OVERRIDE_KEY).is_some() {
            override_val = tool.get(TOOL_CHOICE_OVERRIDE_KEY).cloned();
        } else {
            cleaned.push(tool.clone());
        }
    }
    (override_val, cleaned)
}

/// Execute a one-shot, non-streaming LLM call outside the main turn loop.
///
/// - No tool definitions are sent (unless `config.structured` is set).
/// - Tokens are NOT counted toward the session's running total.
/// - Uses `provider.chat()` (non-streaming) for simplicity and speed.
///
/// # Three-layer degradation chain
///
/// 1. Structured output (forced tool call) → extract from tool_calls[0]
/// 2. Disabled thinking / padded max_tokens → extract from content
/// 3. `primary_text()` fallback → reasoning_content as last resort
///
/// When layer 1 or 2 gets an empty response or a 400 from thinking
/// disabled, a single retry with adjusted parameters is attempted.
pub async fn side_query(
    provider: &dyn LLMProvider,
    user_messages: &[Value],
    config: &SideQueryConfig,
    default_model: &str,
) -> Result<SideQueryResult, String> {
    side_query_typed(provider, user_messages, config, default_model)
        .await
        .map_err(|err| err.to_string())
}

pub async fn side_query_typed(
    provider: &dyn LLMProvider,
    user_messages: &[Value],
    config: &SideQueryConfig,
    default_model: &str,
) -> Result<SideQueryResult, SideQueryError> {
    let model = config.model.as_deref().unwrap_or(default_model);

    // Build messages with optional system prompt
    let mut messages: Vec<Value> = Vec::with_capacity(user_messages.len() + 1);
    if let Some(ref system) = config.system_prompt {
        messages.push(serde_json::json!({
            "role": "system",
            "content": system,
        }));
    }
    messages.extend_from_slice(user_messages);

    // Structured output: build tool definitions with forced tool_choice
    let (tools, expecting_structured) = if let Some(ref structured) = config.structured {
        let tool_def = serde_json::json!({
            "type": "function",
            "function": {
                "name": structured.tool_name,
                "description": "Emit structured output",
                "parameters": structured.schema,
            }
        });
        let tool_choice = tool_choice_override_element(serde_json::json!({
            "type": "tool",
            "name": structured.tool_name,
        }));
        (Some(vec![tool_def, tool_choice]), true)
    } else {
        (None, false)
    };
    let tools_ref: Option<&[Value]> = tools.as_deref();

    info!(
        "[side-query] model={}, max_tokens={}, temp={}, messages={}, structured={}",
        model,
        config.max_tokens,
        config.temperature,
        messages.len(),
        expecting_structured,
    );

    let chat_options = crate::providers::traits::ChatOptions {
        skip_cache_write: config.skip_cache_write,
    };

    // First attempt
    let response = side_query_chat(
        provider,
        &messages,
        tools_ref,
        model,
        config.max_tokens,
        config.temperature,
        config.stream,
        chat_options,
    )
    .await;

    let result = match response {
        Ok(resp) if is_output_truncated(&resp) => {
            warn!(
                "[side-query] incomplete output finish_reason={} — retrying with padded max_tokens",
                resp.finish_reason
            );
            None
        }
        Ok(resp) => try_extract_result(&resp, expecting_structured, model, config),
        Err(ProviderError::RequestFailed(ref msg))
            if msg.to_lowercase().contains("http 400")
                && msg.to_lowercase().contains("thinking") =>
        {
            // Thinking disabled rejected → model is AlwaysOn. Record and retry.
            observe_always_on_thinking(config, model);
            warn!("[side-query] thinking:disabled rejected (400), retrying with padded max_tokens");
            None
        }
        Err(err) => return Err(SideQueryError::Provider(err)),
    };

    if let Some(ok) = result {
        return ok;
    }

    // Retry: pad max_tokens, drop tool_choice override (some proxies reject it)
    let retry_max_tokens = config.max_tokens.saturating_add(2048);
    info!(
        "[side-query] Retry: max_tokens={} → {}, no tool_choice override",
        config.max_tokens, retry_max_tokens
    );

    // For retry, use tools without the forced tool_choice sentinel
    let retry_tools: Option<Vec<Value>> = tools.as_ref().map(|t| {
        t.iter()
            .filter(|v| v.get(TOOL_CHOICE_OVERRIDE_KEY).is_none())
            .cloned()
            .collect()
    });
    let retry_tools_ref: Option<&[Value]> = retry_tools.as_deref();

    let retry_response = side_query_chat(
        provider,
        &messages,
        retry_tools_ref,
        model,
        retry_max_tokens,
        config.temperature,
        config.stream,
        chat_options,
    )
    .await
    .map_err(SideQueryError::Provider)?;

    if is_output_truncated(&retry_response) {
        return Err(SideQueryError::IncompleteOutput {
            finish_reason: retry_response.finish_reason.clone(),
        });
    }

    // On retry, try structured first, then fall back to primary_text
    if expecting_structured {
        if let Some(structured_val) = extract_structured_from_response(&retry_response, config) {
            return Ok(build_structured_result(&retry_response, structured_val));
        }
    }

    // Last resort: primary_text()
    match retry_response.primary_text() {
        Some(text) => {
            let content = text.to_string();
            Ok(build_text_result(&retry_response, content))
        }
        None => {
            observe_thinking_model(config, model, &retry_response);
            Err(SideQueryError::EmptyContent)
        }
    }
}

fn is_output_truncated(response: &LLMResponse) -> bool {
    response.finish_reason == finish_reason::LENGTH
}

/// Issue the underlying chat call, honoring the `stream` flag.
///
/// Streaming uses a no-op delta sink: we only need the final assembled
/// `LLMResponse`, but keeping the HTTP stream flowing avoids gateway
/// read-timeouts on very large side-query prompts (compaction summaries).
#[allow(clippy::too_many_arguments)]
async fn side_query_chat(
    provider: &dyn LLMProvider,
    messages: &[Value],
    tools: Option<&[Value]>,
    model: &str,
    max_tokens: u32,
    temperature: f32,
    stream: bool,
    chat_options: crate::providers::traits::ChatOptions,
) -> Result<LLMResponse, ProviderError> {
    if stream {
        provider
            .chat_streaming(messages, tools, model, max_tokens, temperature, &|_| {}, None)
            .await
    } else {
        provider
            .chat_with_options(messages, tools, model, max_tokens, temperature, chat_options)
            .await
    }
}

/// Attempt to extract a result from a response. Returns `None` to signal
/// "retry needed", `Some(Ok(..))` on success, `Some(Err(..))` on hard failure.
fn try_extract_result(
    response: &LLMResponse,
    expecting_structured: bool,
    model: &str,
    config: &SideQueryConfig,
) -> Option<Result<SideQueryResult, SideQueryError>> {
    // Structured path: tool_calls[0].arguments
    if expecting_structured {
        if let Some(structured_val) = extract_structured_from_response(response, config) {
            return Some(Ok(build_structured_result(response, structured_val)));
        }
        // Structured failed but maybe text is available for a degraded result
    }

    // Text path
    if let Some(text) = response.primary_text() {
        if !text.trim().is_empty() {
            return Some(Ok(build_text_result(response, text.to_string())));
        }
    }

    // Empty response — signal retry
    observe_thinking_model(config, model, response);
    None
}

fn extract_structured_from_response(
    response: &LLMResponse,
    config: &SideQueryConfig,
) -> Option<Value> {
    let structured_cfg = config.structured.as_ref()?;
    let tool_call = response
        .tool_calls
        .iter()
        .find(|tc| tc.name == structured_cfg.tool_name)?;
    Some(tool_call.arguments.clone())
}

fn build_structured_result(response: &LLMResponse, structured: Value) -> SideQueryResult {
    let (prompt_tokens, completion_tokens) = extract_usage(response);
    info!(
        "[side-query] Done (structured): prompt={}, completion={}",
        prompt_tokens, completion_tokens
    );
    SideQueryResult {
        content: String::new(),
        prompt_tokens,
        completion_tokens,
        structured: Some(structured),
        finish_reason: response.finish_reason.clone(),
    }
}

fn build_text_result(response: &LLMResponse, content: String) -> SideQueryResult {
    let (prompt_tokens, completion_tokens) = extract_usage(response);
    info!(
        "[side-query] Done: {} chars, prompt={}, completion={}",
        content.len(),
        prompt_tokens,
        completion_tokens
    );
    SideQueryResult {
        content,
        prompt_tokens,
        completion_tokens,
        structured: None,
        finish_reason: response.finish_reason.clone(),
    }
}

fn extract_usage(response: &LLMResponse) -> (i64, i64) {
    let prompt_tokens = response.usage.get("prompt_tokens").copied().unwrap_or(0);
    let completion_tokens = response
        .usage
        .get("completion_tokens")
        .copied()
        .unwrap_or(0);
    (prompt_tokens, completion_tokens)
}

/// When a thinking-only response is observed, record the model's reasoning
/// capability in KeyVault for future resolution. Idempotent / best-effort.
fn observe_thinking_model(config: &SideQueryConfig, model: &str, response: &LLMResponse) {
    let has_reasoning = response
        .reasoning_content
        .as_ref()
        .is_some_and(|r| !r.trim().is_empty());
    let has_content = response
        .content
        .as_ref()
        .is_some_and(|c| !c.trim().is_empty());

    if has_reasoning && !has_content {
        if let Some(ref account_id) = config.account_id {
            let reasoning_val = model_capabilities::OBSERVED_ALWAYS_ON_REASONING;
            if let Err(err) = key_vault::key_store::KEY_SERVICE.record_observed_reasoning(
                account_id,
                model,
                reasoning_val,
            ) {
                warn!("[side-query] Failed to record observed reasoning for {model}: {err}");
            } else {
                info!("[side-query] Recorded observed always-on reasoning for {model}");
            }
        }
    }
}

/// When thinking:disabled is rejected with a 400, record the model as
/// AlwaysOn in KeyVault.
fn observe_always_on_thinking(config: &SideQueryConfig, model: &str) {
    if let Some(ref account_id) = config.account_id {
        let reasoning_val = model_capabilities::OBSERVED_ALWAYS_ON_REASONING;
        if let Err(err) = key_vault::key_store::KEY_SERVICE.record_observed_reasoning(
            account_id,
            model,
            reasoning_val,
        ) {
            warn!("[side-query] Failed to record always-on thinking for {model}: {err}");
        } else {
            info!("[side-query] Recorded always-on thinking for {model} (400 on disabled)");
        }
    }
}

#[cfg(test)]
#[path = "tests/side_query_tests.rs"]
mod tests;
