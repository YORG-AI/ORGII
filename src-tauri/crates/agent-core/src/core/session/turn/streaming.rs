//! Event streaming helpers — broadcast functions and file-modification checks.
//!
//! Includes `StreamingError` for structured error reporting during agent execution.

use serde::{Deserialize, Serialize};

use crate::bus::broadcast_event;
use crate::providers::traits::ProviderError;
use crate::turn_executor::file_tracker::is_file_write_tool;

// ============================================
// Streaming Error Types
// ============================================

/// Structured error for agent streaming.
///
/// Mirrors Onyx's `StreamingError` for consistent frontend error handling.
/// Contains metadata for retry logic, error categorization, and debugging.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingError {
    /// Human-readable error message.
    pub error: String,
    /// Error code for programmatic handling.
    pub error_code: StreamingErrorCode,
    /// Whether this error is retryable.
    pub is_retryable: bool,
    /// Additional error details (tool name, file path, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// Error codes for streaming errors.
///
/// Enables frontend to display appropriate UI and retry logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StreamingErrorCode {
    /// LLM provider authentication failed.
    AuthError,
    /// LLM provider rate limited the request.
    RateLimited,
    /// LLM provider is overloaded.
    ProviderOverloaded,
    /// Model not found or unavailable.
    ModelNotFound,
    /// Network/connection error.
    NetworkError,
    /// Stream was interrupted mid-response.
    StreamInterrupted,
    /// Tool execution failed.
    ToolError,
    /// Context window exceeded.
    ContextOverflow,
    /// User cancelled the request.
    Cancelled,
    /// Permission denied for a tool operation.
    PermissionDenied,
    /// Session not found or expired.
    SessionNotFound,
    /// Internal server error.
    InternalError,
    /// Unknown/unclassified error.
    Unknown,
}

impl StreamingError {
    /// Create a new streaming error.
    pub fn new(error: impl Into<String>, code: StreamingErrorCode) -> Self {
        Self {
            error: error.into(),
            error_code: code,
            is_retryable: code.is_retryable(),
            details: None,
        }
    }

    /// Add details to the error.
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Create an error from a simple string (`From<&str>` / `From<String>`).
    fn from_string(error: impl Into<String>) -> Self {
        Self::new(error, StreamingErrorCode::Unknown)
    }
}

impl StreamingErrorCode {
    /// Whether this error type is generally retryable.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            StreamingErrorCode::RateLimited
                | StreamingErrorCode::ProviderOverloaded
                | StreamingErrorCode::NetworkError
                | StreamingErrorCode::StreamInterrupted
        )
    }

    pub fn wire_value(&self) -> &'static str {
        match self {
            StreamingErrorCode::AuthError => "AUTH_ERROR",
            StreamingErrorCode::RateLimited => "RATE_LIMITED",
            StreamingErrorCode::ProviderOverloaded => "PROVIDER_OVERLOADED",
            StreamingErrorCode::ModelNotFound => "MODEL_NOT_FOUND",
            StreamingErrorCode::NetworkError => "NETWORK_ERROR",
            StreamingErrorCode::StreamInterrupted => "STREAM_INTERRUPTED",
            StreamingErrorCode::ToolError => "TOOL_ERROR",
            StreamingErrorCode::ContextOverflow => "CONTEXT_OVERFLOW",
            StreamingErrorCode::Cancelled => "CANCELLED",
            StreamingErrorCode::PermissionDenied => "PERMISSION_DENIED",
            StreamingErrorCode::SessionNotFound => "SESSION_NOT_FOUND",
            StreamingErrorCode::InternalError => "INTERNAL_ERROR",
            StreamingErrorCode::Unknown => "UNKNOWN",
        }
    }
}

pub fn classify_streaming_error_message(message: &str) -> StreamingErrorCode {
    let lower = message.to_ascii_lowercase();
    if lower.contains("auth") || lower.contains("api key") || lower.contains("unauthorized") {
        StreamingErrorCode::AuthError
    } else if lower.contains("rate limit") || lower.contains("429") {
        StreamingErrorCode::RateLimited
    } else if lower.contains("overload") || lower.contains("529") || lower.contains("capacity") {
        StreamingErrorCode::ProviderOverloaded
    } else if lower.contains("model not found") || lower.contains("model_not_found") {
        StreamingErrorCode::ModelNotFound
    } else if lower.contains("network") || lower.contains("connection") || lower.contains("timeout")
    {
        StreamingErrorCode::NetworkError
    } else if lower.contains("stream") && lower.contains("interrupt") {
        StreamingErrorCode::StreamInterrupted
    } else if lower.contains("context") && (lower.contains("window") || lower.contains("exceed")) {
        StreamingErrorCode::ContextOverflow
    } else if lower.contains("cancel") {
        StreamingErrorCode::Cancelled
    } else if lower.contains("permission") || lower.contains("denied") {
        StreamingErrorCode::PermissionDenied
    } else if lower.contains("session") && lower.contains("not found") {
        StreamingErrorCode::SessionNotFound
    } else if lower.contains("tool") {
        StreamingErrorCode::ToolError
    } else {
        StreamingErrorCode::Unknown
    }
}

impl From<ProviderError> for StreamingError {
    fn from(err: ProviderError) -> Self {
        match err {
            ProviderError::AuthError(msg) => Self::new(msg, StreamingErrorCode::AuthError),
            ProviderError::UsageLimitReached(msg) => {
                Self::new(msg, StreamingErrorCode::RateLimited).with_details(serde_json::json!({
                    "reason": "usage_limit_reached",
                    "retryable": false
                }))
            }
            ProviderError::RateLimited {
                message,
                retry_after_secs,
            } => {
                let mut error = Self::new(message, StreamingErrorCode::RateLimited);
                if let Some(secs) = retry_after_secs {
                    error = error.with_details(serde_json::json!({
                        "retryAfterSecs": secs
                    }));
                }
                error
            }
            ProviderError::Overloaded {
                message,
                retry_after_secs,
            } => {
                let mut error = Self::new(message, StreamingErrorCode::ProviderOverloaded);
                if let Some(secs) = retry_after_secs {
                    error = error.with_details(serde_json::json!({
                        "retryAfterSecs": secs
                    }));
                }
                error
            }
            ProviderError::ModelNotFound(msg) => Self::new(msg, StreamingErrorCode::ModelNotFound),
            ProviderError::RequestFailed(msg) => {
                let code = if msg.contains("Stream error") {
                    StreamingErrorCode::StreamInterrupted
                } else {
                    StreamingErrorCode::NetworkError
                };
                Self::new(msg, code)
            }
            ProviderError::ParseError(msg) => Self::new(msg, StreamingErrorCode::InternalError),
            ProviderError::ContextTooLong(msg) => {
                Self::new(msg, StreamingErrorCode::ContextOverflow)
            }
            // Both are normally recovered inside the turn loop; reaching
            // the frontend means the rescue arm was already burned.
            ProviderError::MaxTokensExceedContext(msg) => {
                Self::new(msg, StreamingErrorCode::ContextOverflow)
            }
            ProviderError::MediaTooLarge(msg) => Self::new(msg, StreamingErrorCode::ToolError),
            ProviderError::Cancelled => Self::new(
                "Cancelled by user".to_string(),
                StreamingErrorCode::Cancelled,
            ),
            ProviderError::Other(msg) => Self::new(msg, StreamingErrorCode::Unknown),
        }
    }
}

impl From<&str> for StreamingError {
    fn from(err: &str) -> Self {
        Self::from_string(err)
    }
}

impl From<String> for StreamingError {
    fn from(err: String) -> Self {
        Self::from_string(err)
    }
}

// ============================================
// File Modification Helpers
// ============================================

/// Tools that modify files and should trigger a snapshot before execution.
pub(super) fn is_file_modifying_tool(tool_name: &str) -> bool {
    is_file_write_tool(tool_name)
}

// ============================================
// Broadcast Functions
// ============================================

use crate::core::turn_executor::context_accounting::ContextUsageSnapshot;

/// Parameters for broadcasting an agent completion event.
pub struct AgentCompleteParams<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub content: &'a str,
    pub model: &'a str,
    pub is_stream_error: bool,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub context_tokens: i64,
    pub context_usage_snapshot: Option<&'a ContextUsageSnapshot>,
}

/// Broadcast an agent complete event.
pub fn broadcast_agent_complete(params: &AgentCompleteParams<'_>) {
    broadcast_event(
        "agent:complete",
        serde_json::json!({
            "sessionId": params.session_id,
            "turnId": params.turn_id,
            "content": params.content,
            "model": params.model,
            "isStreamError": params.is_stream_error,
            "promptTokens": params.prompt_tokens,
            "completionTokens": params.completion_tokens,
            "totalTokens": params.total_tokens,
            "contextTokens": params.context_tokens,
            "contextUsage": params.context_usage_snapshot,
        }),
    );
}

/// Broadcast a structured agent error event to the frontend.
///
/// Sends the full `StreamingError` structure for rich frontend error handling.
pub fn broadcast_agent_error_structured(session_id: &str, error: &StreamingError) {
    broadcast_event(
        "agent:error",
        serde_json::json!({
            "sessionId": session_id,
            "error": error.error,
            "errorCode": error.error_code,
            "isRetryable": error.is_retryable,
            "details": error.details,
        }),
    );
}

/// Broadcast a non-fatal warning from a background subsystem.
///
/// The session continues normally; the frontend may show a transient indicator.
/// `source` identifies the subsystem (e.g. "session_memory", "compaction").
pub fn broadcast_agent_warning(session_id: &str, warning: &str, source: &str) {
    broadcast_event(
        "agent:warning",
        serde_json::json!({
            "sessionId": session_id,
            "warning": warning,
            "source": source,
        }),
    );
}
