//! SSE parser for the Anthropic streaming Messages protocol.
//!
//! The stream is a sequence of `event: ...\ndata: {...}\n\n` records. We
//! only consume `data:` lines (events are inferred from the JSON `type`
//! tag), accumulate per-block content into `BlockAcc`, and emit
//! per-delta callbacks plus the running flat aggregates that
//! `LLMResponse` requires.
//!
//! Block ordering is preserved by indexing every accumulator with the
//! Anthropic-supplied `index` field — a sort at finalization time
//! reconstructs the original text → tool → text interleave.

use std::collections::HashMap;

use serde_json::Value;
use tracing::warn;

use super::types::StreamEvent;
use super::usage;
use crate::providers::traits::{
    finish_reason as finish, AssistantBlock, ProviderError, StreamDelta, StreamErrorKind,
    ToolCallDelta, ToolCallRequest,
};

// Anthropic API protocol `stop_reason` values. Mapped to the unified
// `finish_reason` values from `traits` at end-of-stream.
const ANTHROPIC_STOP_END_TURN: &str = "end_turn";
const ANTHROPIC_STOP_TOOL_USE: &str = "tool_use";
// Output hit `max_tokens` — MUST map to `finish::LENGTH` or the turn
// executor's truncation recovery (Tier-1 escalation / auto-continue)
// never fires and a mid-thought cut is treated as a normal completion,
// ending the turn (and flushing any queued messages) prematurely.
const ANTHROPIC_STOP_MAX_TOKENS: &str = "max_tokens";
// Response was truncated because it hit the model's context window — the
// same "cut off mid-thought" situation as `max_tokens`, so it maps to
// `finish::LENGTH` and rides the same truncation recovery. Without this
// mapping the unknown reason falls through verbatim and the turn ends as
// if the model finished normally, silently losing the tail of the work.
const ANTHROPIC_STOP_CONTEXT_WINDOW_EXCEEDED: &str = "model_context_window_exceeded";
// Model declined to respond (content-safety / refusal stop). Anthropic
// returns an empty content body with this reason. Map to the unified
// `finish::CONTENT_FILTER` value so the turn executor's empty-response
// fail-safe surfaces a user-visible notice instead of ending the turn
// silently (which leaves the UI spinner running forever).
const ANTHROPIC_STOP_REFUSAL: &str = "refusal";

/// Per-index accumulator for Anthropic streaming content blocks.
///
/// Each top-level content block in Anthropic's Messages streaming protocol
/// has a stable `index`; deltas for that block always carry the same index.
/// We keep state per index (not one global text/reasoning buffer) so the
/// final response can emit `AssistantBlock`s in source order with accurate
/// boundaries between segments.
pub(super) enum BlockAcc {
    Text(String),
    Thinking {
        text: String,
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        args: String,
    },
}

/// Mutable state threaded through every iteration of the SSE read loop.
///
/// Bundled so the per-event handlers can take a single `&mut StreamState`
/// instead of nine independent borrows. Default is the start-of-stream
/// state (empty buffers, finish_reason = STOP).
pub(super) struct StreamState {
    pub accumulated_content: String,
    pub accumulated_reasoning: String,
    pub block_accumulators: HashMap<usize, BlockAcc>,
    pub finish_reason: String,
    pub stream_error_kind: Option<StreamErrorKind>,
    /// Retry floor parsed from an SSE error frame (`retry_after` /
    /// `retry_after_ms`), surfaced on `LLMResponse.retry_after_ms` so the
    /// in-stream retry loop waits the server-requested delay instead of
    /// its generic exponential schedule.
    pub retry_after_ms: Option<u64>,
    pub usage: HashMap<String, i64>,
    pub unknown_frame_count: usize,
}

impl Default for StreamState {
    fn default() -> Self {
        Self {
            accumulated_content: String::new(),
            accumulated_reasoning: String::new(),
            block_accumulators: HashMap::new(),
            finish_reason: finish::STOP.to_string(),
            stream_error_kind: None,
            retry_after_ms: None,
            usage: HashMap::new(),
            unknown_frame_count: 0,
        }
    }
}

impl StreamState {
    /// Returns true when *any* segment of the response has been received.
    /// Used by the read loop to decide whether a connection error should
    /// degrade to `STREAM_ERROR` (preserving partial output) or surface as
    /// a hard provider error (no recoverable state).
    pub fn has_partial_data(&self) -> bool {
        !self.accumulated_content.is_empty()
            || !self.accumulated_reasoning.is_empty()
            || !self.block_accumulators.is_empty()
    }

    /// Mark the stream as failed with the given error kind, preserving any
    /// partial output for the turn executor's recovery path.
    pub fn mark_stream_error(&mut self, kind: StreamErrorKind) {
        self.finish_reason = finish::STREAM_ERROR.to_string();
        self.stream_error_kind = Some(kind);
    }
}

/// Outcome of dispatching a single SSE event.
pub(super) enum EventOutcome {
    /// Continue reading the stream.
    Continue,
    /// Stream is done — drain any remaining events and exit the read loop.
    StreamDone,
    /// Hard error — the connection is fine but Anthropic told us we have
    /// no recoverable state. Carries a typed `ProviderError` so the caller
    /// preserves the error class (rate-limit / overloaded vs generic) all
    /// the way to `reliable.rs`, where rate-limit cooldowns are keyed off
    /// `ProviderError::RateLimited`. A bare string here would collapse a
    /// `rate_limit_error` frame into an opaque `RequestFailed`, defeating
    /// the shared cross-session cooldown.
    HardError(ProviderError),
}

/// Dispatch a single parsed `StreamEvent`, mutating `state` and emitting
/// per-delta callbacks for the streaming consumer.
pub(super) fn handle_event(
    event: StreamEvent,
    state: &mut StreamState,
    on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
    resolved_model: &str,
) -> EventOutcome {
    match event {
        StreamEvent::ContentBlockStart {
            index,
            content_block,
        } => handle_block_start(state, on_delta, index, &content_block),
        StreamEvent::ContentBlockDelta { index, delta } => {
            handle_block_delta(state, on_delta, index, &delta)
        }
        StreamEvent::MessageDelta { delta, usage: u } => {
            if let Some(reason) = delta.get("stop_reason").and_then(|r| r.as_str()) {
                state.finish_reason = match reason {
                    ANTHROPIC_STOP_END_TURN => finish::STOP.to_string(),
                    ANTHROPIC_STOP_TOOL_USE => finish::TOOL_CALLS.to_string(),
                    ANTHROPIC_STOP_MAX_TOKENS => finish::LENGTH.to_string(),
                    ANTHROPIC_STOP_CONTEXT_WINDOW_EXCEEDED => finish::LENGTH.to_string(),
                    ANTHROPIC_STOP_REFUSAL => finish::CONTENT_FILTER.to_string(),
                    other => other.to_string(),
                };
            }
            usage::merge_message_delta_output(&mut state.usage, u.as_ref());
            EventOutcome::Continue
        }
        StreamEvent::MessageStart { message } => {
            usage::merge_message_start(&mut state.usage, message.as_ref());
            EventOutcome::Continue
        }
        StreamEvent::Error { error } => handle_error_event(state, &error, resolved_model),
        _ => EventOutcome::Continue,
    }
}

fn handle_block_start(
    state: &mut StreamState,
    on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
    index: usize,
    content_block: &Value,
) -> EventOutcome {
    match content_block.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            state
                .block_accumulators
                .insert(index, BlockAcc::Text(String::new()));
        }
        Some("thinking") => {
            state.block_accumulators.insert(
                index,
                BlockAcc::Thinking {
                    text: String::new(),
                    signature: None,
                },
            );
        }
        Some("tool_use") => {
            let id = content_block
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            let name = content_block
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            state.block_accumulators.insert(
                index,
                BlockAcc::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    args: String::new(),
                },
            );
            on_delta(StreamDelta {
                content: None,
                reasoning: None,
                tool_call_delta: Some(ToolCallDelta {
                    index,
                    id: Some(id),
                    name: Some(name),
                    arguments_delta: None,
                }),
                finish_reason: None,
                usage: None,
            });
        }
        Some(other) => {
            state.unknown_frame_count += 1;
            warn!(
                block_type = other,
                sample = %bounded_value_sample(content_block),
                "Anthropic stream emitted unknown content block type"
            );
        }
        None => {
            state.unknown_frame_count += 1;
            warn!(
                sample = %bounded_value_sample(content_block),
                "Anthropic stream emitted content block without type"
            );
        }
    }
    EventOutcome::Continue
}

fn handle_block_delta(
    state: &mut StreamState,
    on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
    index: usize,
    delta: &Value,
) -> EventOutcome {
    let delta_type = delta.get("type").and_then(|t| t.as_str());
    match delta_type {
        Some("text_delta") => {
            if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                state.accumulated_content.push_str(text);
                if let Some(BlockAcc::Text(buf)) = state.block_accumulators.get_mut(&index) {
                    buf.push_str(text);
                }
                on_delta(StreamDelta {
                    content: Some(text.to_string()),
                    reasoning: None,
                    tool_call_delta: None,
                    finish_reason: None,
                    usage: None,
                });
            }
        }
        Some("input_json_delta") => {
            if let Some(partial) = delta.get("partial_json").and_then(|p| p.as_str()) {
                if let Some(BlockAcc::ToolUse { args, .. }) =
                    state.block_accumulators.get_mut(&index)
                {
                    args.push_str(partial);
                }
                on_delta(StreamDelta {
                    content: None,
                    reasoning: None,
                    tool_call_delta: Some(ToolCallDelta {
                        index,
                        id: None,
                        name: None,
                        arguments_delta: Some(partial.to_string()),
                    }),
                    finish_reason: None,
                    usage: None,
                });
            }
        }
        Some("thinking_delta") => {
            if let Some(thinking) = delta.get("thinking").and_then(|t| t.as_str()) {
                state.accumulated_reasoning.push_str(thinking);
                if let Some(BlockAcc::Thinking { text, .. }) =
                    state.block_accumulators.get_mut(&index)
                {
                    text.push_str(thinking);
                }
                on_delta(StreamDelta {
                    content: None,
                    reasoning: Some(thinking.to_string()),
                    tool_call_delta: None,
                    finish_reason: None,
                    usage: None,
                });
            }
        }
        Some("signature_delta") => {
            if let Some(signature) = delta.get("signature").and_then(|value| value.as_str()) {
                if let Some(BlockAcc::Thinking {
                    signature: saved, ..
                }) = state.block_accumulators.get_mut(&index)
                {
                    *saved = Some(signature.to_string());
                }
            }
        }
        Some(other) => {
            state.unknown_frame_count += 1;
            warn!(
                delta_type = other,
                sample = %bounded_value_sample(delta),
                "Anthropic stream emitted unknown content block delta type"
            );
        }
        None => {
            state.unknown_frame_count += 1;
            warn!(
                sample = %bounded_value_sample(delta),
                "Anthropic stream emitted content block delta without type"
            );
        }
    }
    EventOutcome::Continue
}

fn bounded_value_sample(value: &Value) -> String {
    crate::utils::safe_truncate_chars_to_string(&value.to_string(), 500)
}

/// Parse a server-supplied retry hint from an SSE error frame's JSON.
///
/// Accepts `retry_after_ms` (already milliseconds) or `retry_after`
/// (seconds), as a number or numeric string — the same field set the
/// openai_compat parser honors. Returns milliseconds.
fn parse_error_retry_after_ms(error: &Value) -> Option<u64> {
    fn as_ms(value: &Value, scale: f64) -> Option<u64> {
        let num = value
            .as_f64()
            .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
        (num.is_finite() && num > 0.0).then_some((num * scale) as u64)
    }
    for key in ["retry_after_ms", "retryAfterMs"] {
        if let Some(ms) = error.get(key).and_then(|value| as_ms(value, 1.0)) {
            return Some(ms);
        }
    }
    for key in ["retry_after", "retryAfter"] {
        if let Some(ms) = error.get(key).and_then(|value| as_ms(value, 1000.0)) {
            return Some(ms);
        }
    }
    None
}

fn handle_error_event(
    state: &mut StreamState,
    error: &Value,
    resolved_model: &str,
) -> EventOutcome {
    let msg = error
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown streaming error");
    let error_type = error.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let retry_after_ms = parse_error_retry_after_ms(error);
    warn!(
        "Anthropic stream error event (model={}, type={}, retry_after_ms={:?}): {}",
        resolved_model, error_type, retry_after_ms, msg
    );

    let lower_msg = msg.to_lowercase();
    let is_overloaded = error_type == "overloaded_error" || lower_msg.contains("overloaded");
    // `rate_limit_error` frames MUST stay classified as rate-limit all the
    // way to `reliable.rs` so the shared `RATE_LIMIT_COOLDOWNS` map kicks in
    // — that is what makes one session's 429 throttle the OTHER concurrent
    // sessions hammering the same account, instead of each retrying blindly.
    let is_rate_limited = error_type == "rate_limit_error" || lower_msg.contains("rate limit");

    if state.has_partial_data() {
        // Partial output already streamed: we can't surface a typed
        // ProviderError without discarding it, so mark a recoverable stream
        // error and let the turn executor's retry loop take over. Rate-limit
        // and overload both map to the short Overloaded budget here.
        let kind = if is_overloaded || is_rate_limited {
            StreamErrorKind::Overloaded
        } else {
            StreamErrorKind::ProviderError
        };
        state.retry_after_ms = retry_after_ms;
        state.mark_stream_error(kind);
        return EventOutcome::StreamDone;
    }

    // No partial output: surface a typed error so the retry/cooldown layer
    // can branch on the exact class.
    let retry_after_secs = retry_after_ms.map(|ms| ms.div_ceil(1000));
    if is_rate_limited {
        return EventOutcome::HardError(ProviderError::RateLimited {
            message: msg.to_string(),
            retry_after_secs,
        });
    }
    if is_overloaded {
        return EventOutcome::HardError(ProviderError::Overloaded {
            message: msg.to_string(),
            retry_after_secs,
        });
    }
    EventOutcome::HardError(ProviderError::RequestFailed(msg.to_string()))
}

/// Collapse per-index accumulators into ordered `(blocks, tool_calls)`.
///
/// The block list preserves the source-order interleave Anthropic emitted;
/// `tool_calls` is the order-insensitive flat copy used by message-history
/// consumers. Empty text/thinking segments and malformed tool calls
/// (missing id/name from stream interruption) are dropped — they carry
/// no information and would only pollute the UI.
pub(super) fn finalize_blocks(
    state: &mut StreamState,
) -> (Vec<AssistantBlock>, Vec<ToolCallRequest>) {
    let mut tool_calls: Vec<ToolCallRequest> = Vec::new();
    let mut blocks: Vec<AssistantBlock> = Vec::with_capacity(state.block_accumulators.len());
    let mut indices: Vec<usize> = state.block_accumulators.keys().cloned().collect();
    indices.sort();
    let mut pending_anthropic_thinking: Option<Value> = None;
    for index in indices {
        let Some(acc) = state.block_accumulators.remove(&index) else {
            continue;
        };
        match acc {
            BlockAcc::Text(text) => {
                if !text.is_empty() {
                    blocks.push(AssistantBlock::Text { text });
                }
            }
            BlockAcc::Thinking { text, signature } => {
                if !text.is_empty() {
                    if let Some(sig) = signature {
                        pending_anthropic_thinking = Some(serde_json::json!({
                            "anthropic": {
                                "thinking": text,
                                "signature": sig,
                            }
                        }));
                    }
                    blocks.push(AssistantBlock::Reasoning { text });
                }
            }
            BlockAcc::ToolUse { id, name, args } => {
                if id.is_empty() || name.is_empty() {
                    warn!(
                        "Discarding incomplete tool call at index {} (missing id/name)",
                        index
                    );
                    continue;
                }
                // Surface JSON parse failures as a stream error instead of
                // silently falling back to `{}` — an empty-args tool call
                // (e.g. `write_file` with no `path`) would execute and fail
                // in a confusing way. Mark the state and break so the turn
                // executor's retry layer can handle it.
                let arguments: Value = match serde_json::from_str(&args) {
                    Ok(v) => v,
                    Err(parse_err) => {
                        warn!(
                            "Anthropic tool '{}' (id={}) accumulated invalid JSON args \
                             (len={}, err={}); marking as stream error for retry",
                            name,
                            id,
                            args.len(),
                            parse_err
                        );
                        state.mark_stream_error(StreamErrorKind::ProviderError);
                        // Use empty object so the block list stays consistent
                        // but the stream error will prevent turn continuation.
                        Value::Object(serde_json::Map::new())
                    }
                };
                let tool_call = ToolCallRequest {
                    id,
                    name,
                    arguments,
                    thought_signature: pending_anthropic_thinking.take(),
                };
                tool_calls.push(tool_call.clone());
                blocks.push(AssistantBlock::ToolCall(tool_call));
            }
        }
    }
    (blocks, tool_calls)
}

#[cfg(test)]
mod error_event_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rate_limit_frame_without_partial_maps_to_rate_limited() {
        let mut state = StreamState::default();
        let err = json!({ "type": "rate_limit_error", "message": "Rate limited" });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::HardError(ProviderError::RateLimited { .. }) => {}
            other => panic!("expected RateLimited, got {:?}", debug_outcome(&other)),
        }
    }

    #[test]
    fn overloaded_frame_without_partial_maps_to_overloaded() {
        let mut state = StreamState::default();
        let err = json!({ "type": "overloaded_error", "message": "Overloaded" });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::HardError(ProviderError::Overloaded { .. }) => {}
            other => panic!("expected Overloaded, got {:?}", debug_outcome(&other)),
        }
    }

    #[test]
    fn generic_frame_without_partial_maps_to_request_failed() {
        let mut state = StreamState::default();
        let err = json!({ "type": "api_error", "message": "boom" });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::HardError(ProviderError::RequestFailed(_)) => {}
            other => panic!("expected RequestFailed, got {:?}", debug_outcome(&other)),
        }
    }

    #[test]
    fn rate_limit_frame_with_partial_becomes_recoverable_stream_error() {
        let mut state = StreamState::default();
        state.accumulated_content.push_str("partial answer");
        let err = json!({ "type": "rate_limit_error", "message": "Rate limited" });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::StreamDone => {
                assert_eq!(state.finish_reason, finish::STREAM_ERROR);
                assert_eq!(state.stream_error_kind, Some(StreamErrorKind::Overloaded));
            }
            other => panic!("expected StreamDone, got {:?}", debug_outcome(&other)),
        }
    }

    #[test]
    fn error_frame_retry_after_populates_typed_error() {
        let mut state = StreamState::default();
        let err =
            json!({ "type": "rate_limit_error", "message": "Rate limited", "retry_after": 30 });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::HardError(ProviderError::RateLimited {
                retry_after_secs, ..
            }) => assert_eq!(retry_after_secs, Some(30)),
            other => panic!("expected RateLimited, got {:?}", debug_outcome(&other)),
        }

        let mut state = StreamState::default();
        let err =
            json!({ "type": "overloaded_error", "message": "Overloaded", "retry_after_ms": 4500 });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::HardError(ProviderError::Overloaded {
                retry_after_secs, ..
            }) => assert_eq!(retry_after_secs, Some(5)),
            other => panic!("expected Overloaded, got {:?}", debug_outcome(&other)),
        }
    }

    #[test]
    fn error_frame_retry_after_with_partial_lands_on_stream_state() {
        let mut state = StreamState::default();
        state.accumulated_content.push_str("partial answer");
        let err =
            json!({ "type": "overloaded_error", "message": "Overloaded", "retry_after": "12" });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::StreamDone => {
                assert_eq!(state.retry_after_ms, Some(12_000));
            }
            other => panic!("expected StreamDone, got {:?}", debug_outcome(&other)),
        }
    }

    #[test]
    fn error_frame_without_retry_hint_has_none() {
        let mut state = StreamState::default();
        let err = json!({ "type": "rate_limit_error", "message": "Rate limited" });
        match handle_error_event(&mut state, &err, "claude-opus-4-8") {
            EventOutcome::HardError(ProviderError::RateLimited {
                retry_after_secs, ..
            }) => assert_eq!(retry_after_secs, None),
            other => panic!("expected RateLimited, got {:?}", debug_outcome(&other)),
        }
    }

    fn debug_outcome(outcome: &EventOutcome) -> &'static str {
        match outcome {
            EventOutcome::Continue => "Continue",
            EventOutcome::StreamDone => "StreamDone",
            EventOutcome::HardError(_) => "HardError",
        }
    }

    #[test]
    fn refusal_stop_reason_maps_to_content_filter() {
        let mut state = StreamState::default();
        let noop = |_: StreamDelta| {};
        let event = StreamEvent::MessageDelta {
            delta: json!({ "stop_reason": "refusal" }),
            usage: None,
        };
        let _ = handle_event(event, &mut state, &noop, "claude-opus-4-8");
        assert_eq!(state.finish_reason, finish::CONTENT_FILTER);
    }

    #[test]
    fn context_window_exceeded_stop_reason_maps_to_length() {
        let mut state = StreamState::default();
        let noop = |_: StreamDelta| {};
        let event = StreamEvent::MessageDelta {
            delta: json!({ "stop_reason": "model_context_window_exceeded" }),
            usage: None,
        };
        let _ = handle_event(event, &mut state, &noop, "claude-opus-4-8");
        assert_eq!(state.finish_reason, finish::LENGTH);
    }

    #[test]
    fn end_turn_stop_reason_maps_to_stop() {
        let mut state = StreamState::default();
        let noop = |_: StreamDelta| {};
        let event = StreamEvent::MessageDelta {
            delta: json!({ "stop_reason": "end_turn" }),
            usage: None,
        };
        let _ = handle_event(event, &mut state, &noop, "claude-opus-4-8");
        assert_eq!(state.finish_reason, finish::STOP);
    }
}
