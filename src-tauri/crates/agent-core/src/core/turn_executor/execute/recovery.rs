use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use crate::model_context::microcompact;
use crate::providers::traits::{finish_reason as finish, LLMResponse, ProviderError};

use super::super::backoff::MAX_CONTEXT_RESCUE_ATTEMPTS;
use super::super::context_accounting::ContextUsageSnapshot;
use super::super::continuation::{ANTI_RUSH_MIN_PERCENT, ANTI_RUSH_MIN_WINDOW};
use super::super::helpers::add_assistant_message;
use super::super::stream_error_recovery::{handle_stream_error, StreamErrorOutcome};
use super::super::tool_execution::is_cancelled;
use super::super::types::{TurnConfig, TurnEventHandler};
use super::loop_state::{LoopControl, TurnLoopState};
use super::provider_iteration::PreparedRequest;

pub(super) fn handle_provider_error(
    error: ProviderError,
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    config: &TurnConfig,
    session_id: &str,
) -> Result<LoopControl, String> {
    match error {
        ProviderError::Cancelled => {
            info!(
                "[agent-core] Stream cancelled by user (session={})",
                session_id
            );
            if config.persist_cancel_marker {
                crate::core::session::persistence::mark_turn_cancelled(session_id);
            }
            state.final_content = None;
            Ok(LoopControl::Break)
        }
        error @ ProviderError::ContextTooLong(_)
            if state.context_rescue_attempts < MAX_CONTEXT_RESCUE_ATTEMPTS =>
        {
            // First force-clear old tool results; if that frees nothing,
            // fall back to head-preserving hard truncation.
            state.context_rescue_attempts += 1;
            warn!(
                "[agent-core] ContextTooLong (session={}), rescue attempt {}/{}: {}",
                session_id, state.context_rescue_attempts, MAX_CONTEXT_RESCUE_ATTEMPTS, error
            );
            let stats =
                microcompact::force_microcompact_messages(messages, &state.microcompact_config);
            if stats.chars_saved == 0 && stats.images_cleared == 0 {
                let window = crate::providers::model_capabilities::resolve_effective_context_window(
                    &config.model,
                    config.account_id.as_deref(),
                    config.context_window_override,
                );
                let mut budget = window.saturating_mul(3) / 4;
                // Calibrate the estimated-token budget against the provider's
                // actual rejected count so each rescue guarantees progress.
                let estimated =
                    crate::model_context::compaction::ContextCompactor::estimate_messages_tokens(
                        messages,
                    );
                if let Some(actual) = crate::model_context::compaction::ContextCompactor::parse_actual_tokens_from_error(
                    &error.to_string(),
                ) {
                    budget = crate::model_context::compaction::ContextCompactor::calibrate_budget(
                        budget, estimated, actual,
                    );
                }
                let mut truncated =
                    crate::model_context::compaction::ContextCompactor::simple_truncate(
                        messages, budget,
                    );
                while truncated.len() == messages.len() && budget > 10_000 {
                    budget /= 2;
                    truncated = crate::model_context::compaction::ContextCompactor::simple_truncate(
                        messages, budget,
                    );
                }
                warn!(
                    "[agent-core] Context rescue truncation: {} -> {} messages, budget ~{} est-tokens (session={})",
                    messages.len(),
                    truncated.len(),
                    budget,
                    session_id
                );
                *messages = truncated;
            }
            Ok(LoopControl::Continue)
        }
        error @ ProviderError::MaxTokensExceedContext(_) if !state.max_tokens_lowered => {
            // Prompt fits; lower only the output budget once before falling
            // through to the provider error path on another overflow.
            state.max_tokens_lowered = true;
            let lowered = (state.effective_max_tokens / 2).max(1024);
            warn!(
                "[agent-core] max_tokens + input exceeds context (session={}); lowering max_tokens {} -> {} and retrying: {}",
                session_id, state.effective_max_tokens, lowered, error
            );
            state.effective_max_tokens = lowered;
            Ok(LoopControl::Continue)
        }
        error @ ProviderError::MediaTooLarge(_) if !state.media_stripped => {
            state.media_stripped = true;
            let stripped = strip_historical_media_blocks(messages);
            warn!(
                "[agent-core] Media too large (session={}); stripped {} historical media block(s) and retrying: {}",
                session_id, stripped, error
            );
            if stripped == 0 {
                return Err(format!("LLM error: {}", error));
            }
            Ok(LoopControl::Continue)
        }
        error => Err(format!("LLM error: {}", error)),
    }
}

pub(super) fn handle_post_stream_cancellation(
    response: &LLMResponse,
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> LoopControl {
    if !is_cancelled(cancel_flag) {
        return LoopControl::Proceed;
    }

    info!(
        "[agent-core] Cancelled after streaming (session={})",
        session_id
    );
    // Keep fully assembled partial text so the next turn sees what the user
    // already saw before cancellation.
    if let Some(partial) = response
        .content
        .as_deref()
        .filter(|text| !text.trim().is_empty())
    {
        add_assistant_message(
            messages,
            Some(partial),
            None,
            response.reasoning_content.as_deref(),
        );
        handler.on_assistant_iteration_complete(session_id, Some(partial), false, &config.model);
    }
    if config.persist_cancel_marker {
        crate::core::session::persistence::mark_turn_cancelled(session_id);
    }
    state.final_content = None;
    LoopControl::Break
}

pub(super) fn record_usage(
    response: &LLMResponse,
    request: &PreparedRequest,
    state: &mut TurnLoopState,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
) {
    if response.usage.is_empty() {
        return;
    }

    state.usage.accumulate(&response.usage, session_id);
    let context_window =
        crate::core::providers::model_capabilities::resolve_effective_context_window(
            &config.model,
            config.account_id.as_deref(),
            config.context_window_override,
        ) as i64;
    let snapshot = ContextUsageSnapshot::from_payload(
        &request.messages,
        &request.tool_definitions,
        state.usage.last_prompt,
        state.usage.cache_read,
        state.usage.cache_write,
        Some(context_window),
    );
    handler.on_context_usage(session_id, &snapshot);
    state.usage_telemetry.record_llm_span(
        state.iteration as i64,
        &response.usage,
        state.usage.last_prompt,
        &response.tool_calls,
        Some(&snapshot),
    );

    // Queue one model-side budget nudge for the next safe injection point.
    if !state.budget_nudge_sent {
        if let Some(level @ ("error" | "blocking")) = snapshot.warning_level() {
            state.budget_nudge_sent = true;
            let percent = snapshot.percent_used.unwrap_or(0.0);
            state.pending_budget_nudge = Some(format!(
                "<system-reminder>\nContext window is {percent:.0}% full ({level}). Prioritize finishing the current task with the remaining budget: prefer targeted reads over broad exploration, avoid re-reading large files, and summarize instead of quoting long output. The system will compact older history automatically on the next turn.\n</system-reminder>"
            ));
            info!(
                "[agent-core] Queued context-budget nudge ({level}, {percent:.1}% used, session={session_id})"
            );
        }
    }

    // Large-window anti-rush reassurance is once-per-turn and subordinate to
    // the error-tier budget nudge.
    if !state.anti_rush_sent
        && !state.budget_nudge_sent
        && context_window >= ANTI_RUSH_MIN_WINDOW
        && snapshot.percent_used.unwrap_or(0.0) >= ANTI_RUSH_MIN_PERCENT
    {
        state.anti_rush_sent = true;
        state.pending_budget_nudge = Some(
            "<system-reminder>\nNote: automatic compaction is enabled — older messages will be summarized when the context window fills, so the conversation is not limited by it. There is no need to rush or wrap up early; continue working at full quality.\n</system-reminder>".to_string(),
        );
    }

    state.context_usage_snapshot = Some(snapshot);
}

pub(super) async fn handle_stream_recovery(
    response: &LLMResponse,
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    cancel_flag: Option<&Arc<AtomicBool>>,
    session_id: &str,
    handler: &dyn TurnEventHandler,
) -> LoopControl {
    if response.finish_reason != finish::STREAM_ERROR {
        return LoopControl::Proceed;
    }

    match handle_stream_error(
        response,
        &mut state.retry_budgets,
        messages,
        cancel_flag,
        session_id,
        handler,
    )
    .await
    {
        StreamErrorOutcome::BudgetExhausted { user_message } => {
            state.final_content = Some(user_message);
            state.final_is_stream_error = true;
            LoopControl::Break
        }
        StreamErrorOutcome::CancelledDuringBackoff => {
            state.final_content = None;
            LoopControl::Break
        }
        StreamErrorOutcome::Retry => LoopControl::Continue,
    }
}

/// Replace media in historical messages while retaining the latest user
/// message media, which is usually the input the current turn is about.
fn strip_historical_media_blocks(messages: &mut [Value]) -> usize {
    let last_user_idx = messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"));

    let mut stripped = 0usize;
    for (index, message) in messages.iter_mut().enumerate() {
        if Some(index) == last_user_idx {
            continue;
        }
        let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for block in blocks.iter_mut() {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(block_type, "image_url" | "image" | "document") {
                *block = serde_json::json!({
                    "type": "text",
                    "text": "[media removed: this image/document was too large to keep re-sending. Re-read the source file if you need it again.]",
                });
                stripped += 1;
            }
        }
    }
    stripped
}

#[cfg(test)]
mod tests {
    use super::strip_historical_media_blocks;
    use serde_json::json;

    #[test]
    fn strips_old_media_keeps_last_user_media() {
        let mut messages = vec![
            json!({"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,OLD"}},
                {"type": "text", "text": "old screenshot"},
            ]}),
            json!({"role": "assistant", "content": "looked at it"}),
            json!({"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,NEW"}},
                {"type": "text", "text": "new screenshot"},
            ]}),
        ];
        let stripped = strip_historical_media_blocks(&mut messages);
        assert_eq!(stripped, 1);
        assert_eq!(messages[0]["content"][0]["type"], "text");
        assert_eq!(messages[2]["content"][0]["type"], "image_url");
    }

    #[test]
    fn no_media_returns_zero() {
        let mut messages = vec![json!({"role": "user", "content": "plain text"})];
        assert_eq!(strip_historical_media_blocks(&mut messages), 0);
    }
}
