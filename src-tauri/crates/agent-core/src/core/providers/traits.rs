//! Base LLM provider interface.
//!
//! Defines the trait and response types for LLM provider implementations.
//! The agent loop uses this trait to call any LLM provider uniformly.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

// ============================================
// Usage Key Constants
// ============================================
//
// Canonical HashMap keys for token-usage metrics returned in `LLMResponse.usage`.
// Every provider normalizes its native fields into these keys so consumers
// (turn_executor, analytics, etc.) can read them uniformly.
pub mod usage_key {
    pub const PROMPT_TOKENS: &str = "prompt_tokens";
    pub const COMPLETION_TOKENS: &str = "completion_tokens";
    pub const TOTAL_TOKENS: &str = "total_tokens";
    pub const CACHE_READ_TOKENS: &str = "cache_read_tokens";
    pub const CACHE_WRITE_TOKENS: &str = "cache_write_tokens";
}

// ============================================
// Finish Reason Constants
// ============================================
//
// The OpenAI/Anthropic LLM streaming protocols use string values to indicate
// why the LLM stopped generating. We keep these as string constants so callers
// never hardcode literals; `finish_reason` is kept as `String` for
// forward-compat with provider-specific values we don't yet model.
pub mod finish_reason {
    /// Normal completion — the LLM emitted a stop token.
    pub const STOP: &str = "stop";
    /// The LLM requested one or more tool calls.
    pub const TOOL_CALLS: &str = "tool_calls";
    /// Response was truncated because it hit the output length limit.
    pub const LENGTH: &str = "length";
    /// Response was flagged by content-safety filters.
    pub const CONTENT_FILTER: &str = "content_filter";
    /// Synthetic value — stream aborted mid-flight with an error.
    /// When this is set, [`LLMResponse::stream_error_kind`] carries the
    /// specific subtype so the retry layer can pick the right policy.
    pub const STREAM_ERROR: &str = "stream_error";
}

/// Sub-type for `finish_reason = stream_error`.
///
/// Different kinds of stream failures deserve different retry policies:
/// a stale connection can be retried immediately (new socket), while a
/// per-chunk idle timeout usually means the upstream provider is overloaded
/// and we should back off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamErrorKind {
    /// Per-chunk watchdog fired: no bytes arrived for `CHUNK_READ_TIMEOUT`.
    /// Usually upstream overload — back off aggressively.
    IdleTimeout,
    /// Upstream provider reported capacity exhaustion (HTTP 529, message
    /// body contains `"type":"overloaded_error"`, or `overloaded` token in
    /// the error frame). The retry layer applies a SHORTER budget
    /// (`MAX_OVERLOADED_RETRIES = 3`) because looping here is cache-thrashy
    /// and the upstream isn't going to recover in 500ms.
    Overloaded,
    /// Provider returned a non-overloaded error event / non-2xx status
    /// mid-stream (e.g., 500, 502, 503). Retry on the full budget.
    ProviderError,
    /// Transport-level failure (TCP reset, TLS error, socket hangup) before
    /// or during the stream body. Retry immediately on a fresh socket.
    ConnectionError,
    /// Fallback when we truly can't tell which bucket applies.
    Unknown,
}

impl StreamErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::IdleTimeout => "idle_timeout",
            Self::Overloaded => "overloaded",
            Self::ProviderError => "provider_error",
            Self::ConnectionError => "connection_error",
            Self::Unknown => "unknown",
        }
    }
}

// ============================================
// Tool Call Types
// ============================================

/// A tool call request from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    /// Unique ID for this tool call (used to match results).
    pub id: String,
    /// Tool name to invoke.
    pub name: String,
    /// Parsed arguments for the tool.
    pub arguments: Value,
    /// Opaque signature from Gemini thinking models.
    /// Must be echoed back in the assistant message for multi-turn tool calling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<Value>,
}

// ============================================
// Assistant Content Blocks
// ============================================

/// An ordered segment of assistant output produced within a single LLM turn.
///
/// Protocols that support multi-block output (Anthropic Messages, OpenAI
/// Responses, Codex native) populate `LLMResponse.blocks` with one entry per
/// block in the order the model emitted them. This preserves the
/// "text → tool → text → tool" interleave that chat-completions flattens away.
///
/// Protocols that cannot interleave (OpenAI chat-completions and its
/// compatibles) leave `blocks` empty; consumers should use
/// [`LLMResponse::iter_blocks`] which synthesizes a canonical
/// `[Text?, ToolCall × N]` sequence from the flat fields so downstream code
/// has a single uniform shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssistantBlock {
    /// Plain text segment.
    Text { text: String },
    /// Reasoning/thinking segment (Anthropic extended thinking, DeepSeek-R1,
    /// GPT-5 reasoning, Kimi k1.5).
    Reasoning { text: String },
    /// Tool call request.
    ToolCall(ToolCallRequest),
}

// ============================================
// LLM Response
// ============================================

/// Response from an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMResponse {
    /// Flat concatenation of all text blocks. `None` if the response has no
    /// text output (tool-only turn). Order-insensitive consumers such as
    /// side-queries, summarization, and reflection read this directly.
    pub content: Option<String>,
    /// Flat list of tool calls requested by the LLM, in the order they
    /// appeared. Order-insensitive consumers (message persistence, repeat
    /// detection) read this directly.
    #[serde(default)]
    pub tool_calls: Vec<ToolCallRequest>,
    /// Why the LLM stopped generating (e.g., "stop", "tool_calls").
    #[serde(default = "default_finish_reason")]
    pub finish_reason: String,
    /// Token usage statistics.
    #[serde(default)]
    pub usage: HashMap<String, i64>,
    /// Flat reasoning content. See [`AssistantBlock::Reasoning`] for the
    /// ordered equivalent.
    pub reasoning_content: Option<String>,
    /// Ordered block sequence. Empty when the provider cannot express
    /// interleaved output (chat-completions-compatible backends); populated in
    /// source order by Anthropic Messages / OpenAI Responses / Codex native.
    /// Order-sensitive consumers (the turn executor) must iterate via
    /// [`LLMResponse::iter_blocks`], which falls back to a synthesized
    /// `[Text?, ToolCall × N]` sequence when `blocks` is empty.
    #[serde(default)]
    pub blocks: Vec<AssistantBlock>,
    /// Sub-classification when `finish_reason == STREAM_ERROR`. `None` for all
    /// successful completions and for paths that
    /// haven't been taught to produce a kind yet (they fall back to
    /// `StreamErrorKind::Unknown` in the retry layer). See [`StreamErrorKind`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_error_kind: Option<StreamErrorKind>,
    /// Provider-supplied retry floor in milliseconds, parsed from either an
    /// HTTP `Retry-After` response header or a `retry_after` / `retry_after_ms`
    /// field inside an SSE error frame (`data: {"error": {"retry_after": 30}}`).
    /// When present, `turn_executor` uses `max(retry_after_ms, stream_backoff_ms)`
    /// as the actual backoff, so a server directive of 60s is honored instead
    /// of being capped at our 32s exponential ceiling.
    ///
    /// Only meaningful when `finish_reason == STREAM_ERROR`. Mirrors the
    /// `getRetryAfter()` + `getRetryDelay(…, retryAfter)` path in claude_code
    /// `services/api/withRetry.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

fn default_finish_reason() -> String {
    finish_reason::STOP.to_string()
}

impl LLMResponse {
    /// Check if the response contains tool calls.
    pub fn has_tool_calls(&self) -> bool {
        !self.tool_calls.is_empty()
    }

    /// Best-effort primary text: `content` when non-empty, otherwise
    /// `reasoning_content` (thinking-only responses — some models put the
    /// entire answer in the reasoning channel; falling back is strictly
    /// better than treating the response as empty). Returns `None` only
    /// when both are empty.
    ///
    /// Callers that need clean prose (summarization, extraction) should
    /// prefer structured output (forced tool call) and use this as the
    /// last-resort fallback; the reasoning channel is draft-quality text.
    pub fn primary_text(&self) -> Option<&str> {
        if let Some(ref text) = self.content {
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
        if let Some(ref reasoning) = self.reasoning_content {
            if !reasoning.trim().is_empty() {
                tracing::warn!(
                    "[llm-response] No text content; falling back to reasoning_content ({} chars)",
                    reasoning.len()
                );
                return Some(reasoning);
            }
        }
        None
    }

    /// Iterate assistant output blocks in the order the model produced them.
    ///
    /// When the provider populated [`LLMResponse::blocks`] (Anthropic / OpenAI
    /// Responses / Codex), yields those as-is. When `blocks` is empty
    /// (chat-completions-compatible backends), synthesizes the canonical
    /// `[Text?, ToolCall × N]` shape from the flat `content` and `tool_calls`
    /// fields. Downstream consumers can therefore write a single block-driven
    /// loop without branching on provider capability.
    ///
    /// `reasoning_content` is NOT synthesized into the fallback sequence —
    /// reasoning has no canonical ordering relative to text/tools for
    /// non-interleaved providers and is surfaced separately via
    /// `reasoning_content`.
    pub fn iter_blocks(&self) -> Vec<AssistantBlock> {
        if !self.blocks.is_empty() {
            return self.blocks.clone();
        }
        let mut synthesized = Vec::with_capacity(1 + self.tool_calls.len());
        if let Some(ref text) = self.content {
            if !text.is_empty() {
                synthesized.push(AssistantBlock::Text { text: text.clone() });
            }
        }
        for tool_call in &self.tool_calls {
            synthesized.push(AssistantBlock::ToolCall(tool_call.clone()));
        }
        synthesized
    }

    /// Create a simple text response with no tool calls.
    pub fn text(content: &str) -> Self {
        Self {
            content: Some(content.to_string()),
            tool_calls: Vec::new(),
            finish_reason: finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        }
    }

    /// Create an error response.
    pub fn error(message: &str) -> Self {
        Self::text(&format!("Error: {}", message))
    }
}

// ============================================
// Streaming Types
// ============================================

/// A delta from a streaming LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamDelta {
    /// Partial text content.
    pub content: Option<String>,
    /// Partial thinking/reasoning content (extended thinking).
    pub reasoning: Option<String>,
    /// Partial tool call (accumulated incrementally).
    pub tool_call_delta: Option<ToolCallDelta>,
    /// Finish reason (only set on the final delta).
    pub finish_reason: Option<String>,
    /// Usage stats (only set on the final delta).
    pub usage: Option<HashMap<String, i64>>,
}

impl StreamDelta {
    pub fn into_provider_stream_event(self) -> ProviderStreamEvent {
        if let Some(delta) = self.tool_call_delta {
            return ProviderStreamEvent::ToolCallDelta { delta };
        }
        if let Some(text) = self.content {
            return ProviderStreamEvent::MessageDelta { text };
        }
        if let Some(text) = self.reasoning {
            return ProviderStreamEvent::ThinkingDelta { text };
        }
        if let Some(finish_reason) = self.finish_reason {
            return ProviderStreamEvent::Complete {
                finish_reason,
                usage: self.usage,
            };
        }
        ProviderStreamEvent::FlushSegment {
            reason: ProviderFlushReason::TurnEnd,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFlushReason {
    BeforeTool,
    TurnEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderStreamEvent {
    MessageDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ToolCallDelta {
        delta: ToolCallDelta,
    },
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    ToolCallReady {
        index: usize,
        id: String,
        name: String,
        arguments: String,
    },
    FlushSegment {
        reason: ProviderFlushReason,
    },
    Complete {
        finish_reason: String,
        usage: Option<HashMap<String, i64>>,
    },
    UnknownFrame {
        provider: String,
        event_type: String,
        sample: String,
    },
}

impl From<StreamDelta> for ProviderStreamEvent {
    fn from(delta: StreamDelta) -> Self {
        delta.into_provider_stream_event()
    }
}

/// Incremental tool call data from streaming.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallDelta {
    /// Index of the tool call (for parallel tool calls).
    pub index: usize,
    /// Tool call ID (only set on first delta for this index).
    pub id: Option<String>,
    /// Function name (only set on first delta for this index).
    pub name: Option<String>,
    /// Partial arguments string (accumulated across deltas).
    pub arguments_delta: Option<String>,
}

// ============================================
// Provider Configuration
// ============================================

/// Configuration for an LLM provider connection.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// API key for authentication.
    pub api_key: String,
    /// Base URL for the API (e.g., "https://api.openai.com/v1").
    pub api_base: Option<String>,
    /// Extra headers to include in requests.
    pub extra_headers: HashMap<String, String>,
    /// When true, use Azure OpenAI auth and URL format regardless of the provider spec.
    /// Set when an Azure OpenAI account is used as a gateway for a non-Azure model.
    pub is_azure: bool,
}

// ============================================
// LLM Provider Trait
// ============================================

/// How callers should run provider-backed side queries such as skill and memory prefetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideQueryExecution {
    /// The main session provider can run side queries without affecting future turns.
    SharedSession,
    /// Side queries must use a freshly-created provider with an isolated session context.
    IsolatedSession,
}

impl SideQueryExecution {
    pub fn uses_shared_session(self) -> bool {
        matches!(self, Self::SharedSession)
    }

    pub fn requires_isolated_session(self) -> bool {
        matches!(self, Self::IsolatedSession)
    }
}

/// Per-call options for [`LLMProvider::chat_with_options`].
///
/// Extends the fixed `chat` signature without breaking the nine existing
/// implementors: providers that don't care simply inherit the default
/// method, which drops the options and delegates to `chat`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ChatOptions {
    /// Suppress prompt-cache write breakpoints (Anthropic `cache_control`)
    /// for this request. Set for one-shot side queries (e.g. compaction
    /// summarization) whose prefix is never sent again — writing it to the
    /// provider cache costs the cache-write premium with zero future reads.
    pub skip_cache_write: bool,
}

/// Abstract trait for LLM providers.
///
/// Implementations handle the specifics of each provider's API
/// while maintaining a consistent interface for the agent loop.
#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait LLMProvider: Send + Sync {
    /// Send a chat completion request.
    ///
    /// # Arguments
    /// * `messages` - List of message objects with "role" and "content" fields.
    /// * `tools` - Optional tool definitions in OpenAI function calling format.
    /// * `model` - Model identifier (provider-specific).
    /// * `max_tokens` - Maximum tokens in response.
    /// * `temperature` - Sampling temperature (0.0 - 2.0).
    ///
    /// # Returns
    /// An `LLMResponse` with content and/or tool calls.
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<LLMResponse, ProviderError>;

    /// Send a streaming chat completion request.
    ///
    /// Calls `on_delta` for each streaming chunk. Returns the final
    /// assembled `LLMResponse` when the stream completes.
    ///
    /// When `cancel_flag` is `Some` and becomes `true`, implementations
    /// should drop the HTTP stream immediately and return `ProviderError::Cancelled`.
    ///
    /// Default implementation falls back to non-streaming `chat()`.
    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        _on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        _cancel_flag: Option<&AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        // Default: fall back to non-streaming
        self.chat(messages, tools, model, max_tokens, temperature)
            .await
    }

    /// Like [`Self::chat`], with per-call [`ChatOptions`].
    ///
    /// Default implementation ignores the options and delegates to `chat`
    /// — only providers with option-sensitive request builders (currently
    /// `anthropic_native` for `skip_cache_write`) and pass-through wrappers
    /// (`ReliableProvider`, which must forward rather than swallow the
    /// options) need to override this.
    async fn chat_with_options(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        _options: ChatOptions,
    ) -> Result<LLMResponse, ProviderError> {
        self.chat(messages, tools, model, max_tokens, temperature)
            .await
    }

    /// Get the default model for this provider.
    fn default_model(&self) -> &str;

    /// Get the provider name (e.g., "openai", "anthropic").
    fn provider_name(&self) -> &str;

    /// Set the session ID for retry warning broadcasts.
    ///
    /// Called before each LLM request so providers with retry logic
    /// (e.g., `ReliableProvider`) can notify the frontend during retries.
    /// Default implementation is a no-op.
    fn set_session_context(&self, _session_id: &str) {}

    /// Called at every logical yorg turn boundary before provider execution.
    /// Providers with same-stream continuation state must invalidate any pending
    /// continuation that does not belong to this turn.
    fn begin_logical_turn(&self, _session_id: &str, _turn_id: &str) {}

    /// Declares whether provider-backed side queries can share this provider's
    /// conversation state or must use an isolated fork provider.
    fn side_query_execution(&self) -> SideQueryExecution {
        SideQueryExecution::SharedSession
    }
}

// ============================================
// Provider Error
// ============================================

/// Error type for LLM provider operations.
#[derive(Debug)]
pub enum ProviderError {
    /// HTTP request failed.
    RequestFailed(String),
    /// Response parsing failed.
    ParseError(String),
    /// Authentication failed (invalid API key).
    AuthError(String),
    /// Provider account or subscription usage quota is exhausted. Unlike a
    /// transient 429 rate limit, retrying the same request cannot recover.
    UsageLimitReached(String),
    /// Rate limited by the provider (429).
    RateLimited {
        message: String,
        retry_after_secs: Option<u64>,
    },
    /// Provider is overloaded (529). Should retry with longer backoff.
    Overloaded {
        message: String,
        retry_after_secs: Option<u64>,
    },
    /// Model not found or not available.
    ModelNotFound(String),
    /// Context/prompt too long for the model's context window.
    ContextTooLong(String),
    /// `input tokens + max_tokens` exceeds the context window while the
    /// prompt itself still fits — recoverable by lowering `max_tokens`
    /// instead of compacting history.
    MaxTokensExceedContext(String),
    /// Request rejected because embedded media (base64 images / PDFs) is
    /// too large — recoverable by stripping historical media blocks.
    MediaTooLarge(String),
    /// Streaming was cancelled by the user.
    Cancelled,
    /// Generic provider error.
    Other(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::RequestFailed(msg) => write!(formatter, "Request failed: {}", msg),
            ProviderError::ParseError(msg) => write!(formatter, "Parse error: {}", msg),
            ProviderError::AuthError(msg) => write!(formatter, "Auth error: {}", msg),
            ProviderError::UsageLimitReached(msg) => {
                write!(formatter, "Usage limit reached: {}", msg)
            }
            ProviderError::RateLimited {
                message,
                retry_after_secs,
            } => {
                write!(formatter, "Rate limited: {}", message)?;
                if let Some(secs) = retry_after_secs {
                    write!(formatter, " (retry after {}s)", secs)?;
                }
                Ok(())
            }
            ProviderError::Overloaded {
                message,
                retry_after_secs,
            } => {
                write!(formatter, "Overloaded: {}", message)?;
                if let Some(secs) = retry_after_secs {
                    write!(formatter, " (retry after {}s)", secs)?;
                }
                Ok(())
            }
            ProviderError::ModelNotFound(msg) => write!(formatter, "Model not found: {}", msg),
            ProviderError::ContextTooLong(msg) => {
                write!(formatter, "ContextTooLong: {}", msg)
            }
            ProviderError::MaxTokensExceedContext(msg) => {
                write!(formatter, "MaxTokensExceedContext: {}", msg)
            }
            ProviderError::MediaTooLarge(msg) => {
                write!(formatter, "MediaTooLarge: {}", msg)
            }
            ProviderError::Cancelled => write!(formatter, "Cancelled"),
            ProviderError::Other(msg) => write!(formatter, "Provider error: {}", msg),
        }
    }
}

impl std::error::Error for ProviderError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// When `blocks` is populated (order-preserving provider), `iter_blocks`
    /// returns it unchanged — clones included so the caller can consume it.
    #[test]
    fn iter_blocks_returns_populated_blocks_in_order() {
        let tool_call = ToolCallRequest {
            id: "call_1".to_string(),
            name: "search".to_string(),
            arguments: json!({"q": "cats"}),
            thought_signature: None,
        };
        let response = LLMResponse {
            content: Some("Ignored for this test.".to_string()),
            tool_calls: vec![tool_call.clone()],
            finish_reason: "tool_calls".to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: vec![
                AssistantBlock::Text {
                    text: "Looking it up.".to_string(),
                },
                AssistantBlock::ToolCall(tool_call.clone()),
                AssistantBlock::Text {
                    text: "Done.".to_string(),
                },
            ],
            stream_error_kind: None,
            retry_after_ms: None,
        };

        let iter = response.iter_blocks();
        assert_eq!(iter.len(), 3);
        match &iter[0] {
            AssistantBlock::Text { text } => assert_eq!(text, "Looking it up."),
            _ => panic!("expected Text"),
        }
        match &iter[1] {
            AssistantBlock::ToolCall(tc) => assert_eq!(tc.id, "call_1"),
            _ => panic!("expected ToolCall"),
        }
        match &iter[2] {
            AssistantBlock::Text { text } => assert_eq!(text, "Done."),
            _ => panic!("expected Text"),
        }
    }

    /// For providers that cannot report block order (OpenAI Chat Completions
    /// via `openai_compat`), `blocks` stays empty and `iter_blocks` must
    /// synthesize a `[Text?, ToolCall ...]` sequence from the flat fields.
    #[test]
    fn iter_blocks_falls_back_from_flat_fields_when_blocks_empty() {
        let tool_a = ToolCallRequest {
            id: "a".to_string(),
            name: "ls".to_string(),
            arguments: json!({}),
            thought_signature: None,
        };
        let tool_b = ToolCallRequest {
            id: "b".to_string(),
            name: "cat".to_string(),
            arguments: json!({"path": "/tmp/x"}),
            thought_signature: None,
        };
        let response = LLMResponse {
            content: Some("I'll run these.".to_string()),
            tool_calls: vec![tool_a.clone(), tool_b.clone()],
            finish_reason: "tool_calls".to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        };

        let iter = response.iter_blocks();
        assert_eq!(iter.len(), 3);
        match &iter[0] {
            AssistantBlock::Text { text } => assert_eq!(text, "I'll run these."),
            _ => panic!("fallback must put Text first"),
        }
        match &iter[1] {
            AssistantBlock::ToolCall(tc) => assert_eq!(tc.id, "a"),
            _ => panic!("expected first ToolCall"),
        }
        match &iter[2] {
            AssistantBlock::ToolCall(tc) => assert_eq!(tc.id, "b"),
            _ => panic!("expected second ToolCall"),
        }
    }

    /// Empty text must not synthesize an empty Text block (parity with
    /// order-preserving providers, which also skip empty segments).
    #[test]
    fn iter_blocks_fallback_skips_empty_text() {
        let response = LLMResponse {
            content: Some(String::new()),
            tool_calls: vec![ToolCallRequest {
                id: "x".to_string(),
                name: "noop".to_string(),
                arguments: json!({}),
                thought_signature: None,
            }],
            finish_reason: "tool_calls".to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        };

        let iter = response.iter_blocks();
        assert_eq!(iter.len(), 1);
        assert!(matches!(iter[0], AssistantBlock::ToolCall(_)));
    }
}
