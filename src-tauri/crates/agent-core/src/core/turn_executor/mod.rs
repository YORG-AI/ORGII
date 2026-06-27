//! Reusable agentic turn processor.
//!
//! Provides a generic LLM loop that any agent type can call with its own
//! event handlers and persistence strategies.

mod backoff;
pub(crate) mod context_accounting;
pub(crate) mod file_tracker;
pub mod helpers;
mod length_recovery;
#[cfg(debug_assertions)]
pub mod provider_request_capture;
mod screenshot;
mod stream_error_recovery;
pub(crate) mod stream_normalizer;
pub(crate) mod tool_execution;
pub(crate) mod tool_result_storage;
mod types;
mod usage_accumulator;

// Items kept at the `turn_executor::` surface — checked one by one
// against real call sites. The accessor / structured-key set
// (`msg_content_str`, `msg_tool_calls`, `STRUCTURED_*`,
// `add_tool_result_with_timestamp`, `add_tool_result_rich_with_timestamp`)
// is reached only through the deeper `helpers::` segment, so flattening
// them here would just be dead surface.
pub use file_tracker::FileTimeTracker;
pub use helpers::{
    add_assistant_message, add_tool_result, last_assistant_text, msg_role, safe_truncate_end,
    truncate_output,
};
pub use types::{
    PermissionProvider, PermissionVerdict, ToolHookIntervention, TurnConfig, TurnEventHandler,
    TurnIterationHook, TurnResult,
};

// `MAX_TOOL_OUTPUT_CHARS` is consumed by `helpers::*` and a couple of test
// modules via `use crate::core::turn_executor::MAX_TOOL_OUTPUT_CHARS`.
// `set_test_backoff_override_ms` is consumed by the retry-tests module the
// same way. Re-export both so the public surface stays unchanged.
#[cfg(test)]
pub(crate) use backoff::set_test_backoff_override_ms;
pub(crate) use backoff::MAX_TOOL_OUTPUT_CHARS;

use backoff::{MAX_CONSECUTIVE_ERRORS, MAX_CONTEXT_RESCUE_ATTEMPTS, MAX_REPEAT_STREAK};
pub(crate) use context_accounting::ContextUsageSnapshot;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use crate::providers::traits::{finish_reason as finish, LLMProvider, StreamDelta};
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use stream_normalizer::{NormalizedStreamEvent, TurnStreamNormalizer};

use crate::model_context::microcompact;

use length_recovery::{maybe_recover_from_length, LengthRecoveryOutcome};
use screenshot::resolve_screenshot_markers;
use stream_error_recovery::{handle_stream_error, RetryBudgets, StreamErrorOutcome};
use tool_execution::{execute_tool_calls, ToolBatchOutcome};
use usage_accumulator::UsageTotals;

#[cfg(test)]
#[path = "../../tests/processor_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/turn_executor_retry_tests.rs"]
mod retry_tests;

/// Execute one agent turn: messages → (LLM + tools)* → final response.
///
/// This is the generic agentic loop shared by all agent sessions.
/// The caller provides:
/// - `messages`: the full message history (system + user + prior turns)
/// - `provider`: the LLM provider to call
/// - `tools`: the tool registry for execution
/// - `policy`: resolved tool policy for this session
/// - `config`: turn parameters (model, iterations, tokens, temperature)
/// - `session_id`: session identifier for event correlation
/// - `handler`: event handler for streaming, tool events, and persistence
///
/// Returns a `TurnResult` with the final content and accumulated token usage.
#[allow(clippy::too_many_arguments)]
pub async fn execute_turn(
    messages: &mut Vec<Value>,
    provider: &dyn LLMProvider,
    tools: &ToolRegistry,
    policy: &ResolvedToolPolicy,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    permission_provider: Option<&dyn PermissionProvider>,
    cancel_flag: Option<&Arc<AtomicBool>>,
    workspace_path: Option<&std::path::Path>,
    policy_context_activator: Option<&SessionScopedContextActivator>,
) -> Result<TurnResult, String> {
    let mut iteration = 0u32;
    let mut final_content: Option<String> = None;
    // Set to true when the turn exits due to exhausted stream-error retries.
    // Prevents the error text from being persisted into the conversation
    // history (see TurnResult::is_stream_error).
    let mut final_is_stream_error = false;

    let mut usage = UsageTotals::default();
    let mut context_usage_snapshot: Option<ContextUsageSnapshot> = None;

    let mut last_tool_signature: Option<String> = None;
    let mut repeat_count: u32 = 0;
    let mut consecutive_errors: u32 = 0;
    let mut output_recovery_count: u32 = 0;
    // True once we've burned the one silent Tier-1 escalation (max_tokens →
    // ESCALATED_MAX_TOKENS). After that, subsequent truncations fall through
    // to Tier 2 (user-visible auto-continue messages).
    let mut tier1_escalated: bool = false;
    // The effective max_tokens for the current LLM call; may be bumped once
    // to ESCALATED_MAX_TOKENS on Tier-1 escalation.
    let mut effective_max_tokens: u32 = config.max_tokens;
    // Stream-error retry budgets (split across generic vs overloaded — see
    // `stream_error_recovery` module for the full policy).
    let mut retry_budgets = RetryBudgets::default();
    // In-turn ContextTooLong rescue attempts already burned (see the
    // `ContextTooLong` arm below).
    let mut context_rescue_attempts = 0u32;

    let mut file_tracker = file_tracker::FileTimeTracker::new();
    let mc_config = microcompact::MicrocompactConfig::default();
    let iteration_hook = config.iteration_hook.as_deref();

    // Stamp all tools with this session's id so tools that carry internal
    // session context (TodoTool, ExecTool, etc.) resolve to the correct
    // session. Critical for subagents that inherit the parent's ToolRegistry
    // — without this, shared tool instances still point at the parent id.
    tools.set_session_key(session_id).await;

    loop {
        if let Some(max) = config.max_iterations {
            if iteration >= max {
                break;
            }
        }
        if cancel_flag
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
        {
            info!("[agent-core] Cancelled by user (session={})", session_id);
            if config.persist_cancel_marker {
                crate::core::session::persistence::mark_turn_cancelled(session_id);
            }
            final_content = None;
            break;
        }
        iteration += 1;
        if let Some(hook) = iteration_hook {
            hook.before_llm_iteration(session_id, iteration, messages)
                .await;
        }
        let limit_display = config
            .max_iterations
            .map_or("∞".to_string(), |m| m.to_string());
        info!(
            "[agent-core] iteration {}/{} (session={})",
            iteration, limit_display, session_id
        );

        // Microcompact: clear old tool results when the prompt cache has expired
        microcompact::microcompact_messages(messages, &mc_config);

        // Cap recent tool-result screenshots (desktop-control, read_file on
        // images, etc). Runs every turn — images inflate the wire payload
        // faster than tokens, and the 1-hour time trigger above is too
        // coarse for a fast agentic loop doing dozens of clicks in minutes.
        microcompact::cap_recent_tool_images(messages);

        let session_id_for_stream = session_id.to_string();
        info!(
            "[agent-core] collecting tool definitions (session={})",
            session_id
        );
        let tool_defs = tools.get_definitions_budgeted(policy);
        info!(
            "[agent-core] collected {} tool definitions (session={})",
            tool_defs.len(),
            session_id
        );

        // Build LLM messages: resolve screenshots, then strip internal metadata
        let mut llm_messages: Vec<Value> = if let Some(ref store) = config.screenshot_store {
            resolve_screenshot_markers(messages, store, &config.model)
        } else {
            messages.clone()
        };
        microcompact::strip_timestamp_metadata(&mut llm_messages);
        info!(
            "[agent-core] built {} LLM messages for provider (session={})",
            llm_messages.len(),
            session_id
        );

        let stream_normalizer = Arc::new(std::sync::Mutex::new(TurnStreamNormalizer::new()));
        let stream_normalizer_for_cb = stream_normalizer.clone();

        provider.set_session_context(session_id);

        #[cfg(debug_assertions)]
        provider_request_capture::capture(
            session_id,
            iteration,
            &config.model,
            effective_max_tokens,
            config.temperature,
            &llm_messages,
            &tool_defs,
        );

        let cancel_for_stream = cancel_flag.cloned();
        let cancel_ref = cancel_flag.as_ref().map(|f| f.as_ref());
        let stream_result = provider
            .chat_streaming(
                &llm_messages,
                Some(&tool_defs),
                &config.model,
                effective_max_tokens,
                config.temperature,
                &move |delta: StreamDelta| {
                    if let Some(ref flag) = cancel_for_stream {
                        if flag.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                    let normalized_events = match stream_normalizer_for_cb.lock() {
                        Ok(mut normalizer) => normalizer.ingest_delta(delta),
                        Err(_) => {
                            warn!("[agent-core] stream normalizer lock poisoned; dropping delta");
                            return;
                        }
                    };
                    for event in normalized_events {
                        match event {
                            NormalizedStreamEvent::MessageDelta(content) => {
                                handler.on_message_delta(&session_id_for_stream, &content);
                            }
                            NormalizedStreamEvent::ThinkingDelta(reasoning) => {
                                handler.on_thinking_delta(&session_id_for_stream, &reasoning);
                            }
                            NormalizedStreamEvent::ToolCallDelta(tc_delta) => {
                                handler.on_tool_call_delta(
                                    &session_id_for_stream,
                                    tc_delta.index,
                                    tc_delta.id.as_deref(),
                                    tc_delta.name.as_deref(),
                                    tc_delta.arguments_delta.as_deref(),
                                );
                            }
                            NormalizedStreamEvent::UnknownFrame {
                                provider,
                                event_type,
                                sample,
                            } => {
                                warn!(
                                    provider,
                                    event_type,
                                    sample,
                                    "[agent-core] provider stream emitted unknown frame"
                                );
                            }
                            NormalizedStreamEvent::Finish { .. }
                            | NormalizedStreamEvent::FlushSegment(_) => {}
                        }
                    }
                },
                cancel_ref,
            )
            .await;

        let response = match stream_result {
            Ok(resp) => resp,
            Err(crate::providers::traits::ProviderError::Cancelled) => {
                info!(
                    "[agent-core] Stream cancelled by user (session={})",
                    session_id
                );
                if config.persist_cancel_marker {
                    crate::core::session::persistence::mark_turn_cancelled(session_id);
                }
                final_content = None;
                break;
            }
            Err(err @ crate::providers::traits::ProviderError::ContextTooLong(_))
                if context_rescue_attempts < MAX_CONTEXT_RESCUE_ATTEMPTS =>
            {
                // Self-rescue instead of aborting the whole turn (which
                // discards every finding the agent accumulated — a 35-minute
                // subagent run once died this way). First force-clear old
                // tool results (cheap, no LLM); if that freed nothing, fall
                // back to head-preserving hard truncation. Bounded by
                // MAX_CONTEXT_RESCUE_ATTEMPTS.
                context_rescue_attempts += 1;
                warn!(
                    "[agent-core] ContextTooLong (session={}), rescue attempt {}/{}: {}",
                    session_id, context_rescue_attempts, MAX_CONTEXT_RESCUE_ATTEMPTS, err
                );
                let stats = microcompact::force_microcompact_messages(messages, &mc_config);
                if stats.chars_saved == 0 && stats.images_cleared == 0 {
                    // Nothing left to clear — hard-truncate the history while
                    // keeping the head (system prompt + task statement).
                    let window = crate::providers::model_hints::context_window_hint(&config.model);
                    let budget = window.saturating_mul(3) / 4;
                    let truncated =
                        crate::model_context::compaction::ContextCompactor::simple_truncate(
                            messages, budget,
                        );
                    warn!(
                        "[agent-core] Context rescue truncation: {} -> {} messages (session={})",
                        messages.len(),
                        truncated.len(),
                        session_id
                    );
                    *messages = truncated;
                }
                continue;
            }
            Err(err) => return Err(format!("LLM error: {}", err)),
        };

        if cancel_flag
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
        {
            info!(
                "[agent-core] Cancelled after streaming (session={})",
                session_id
            );
            if config.persist_cancel_marker {
                crate::core::session::persistence::mark_turn_cancelled(session_id);
            }
            final_content = None;
            break;
        }

        if !response.usage.is_empty() {
            usage.accumulate(&response.usage, session_id);
            // Authoritative context window: the FAMILY_RULES resolver knows the
            // model's real window (e.g. opus-4.x = 1M), so the frontend gauge no
            // longer divides by a stale 200K and falsely shows "red / full".
            // account_id is irrelevant here — KeyVault only upgrades thinking
            // support, never the context window.
            let context_window =
                crate::core::providers::model_capabilities::resolve(&config.model, None)
                    .context_window as i64;
            let snapshot = ContextUsageSnapshot::from_payload(
                &llm_messages,
                &tool_defs,
                usage.last_prompt,
                usage.cache_read,
                usage.cache_write,
                Some(context_window),
            );
            handler.on_context_usage(session_id, &snapshot);
            context_usage_snapshot = Some(snapshot);
        }

        // Handle stream interruption.
        //
        // Stream errors happen when the upstream provider drops the connection
        // mid-response (per-chunk read timeout, transport-level socket drop,
        // provider 5xx error frame, HTTP 529 overload, etc.). The transport
        // layer surfaces this as `finish_reason = stream_error` with a subtype
        // in `stream_error_kind`, and we retry the whole iteration with an
        // exponential backoff.
        //
        // Two independent budgets:
        //   - `Overloaded` (HTTP 529 / `overloaded_error`): short budget of
        //     `MAX_OVERLOADED_RETRIES = 3`. Capacity cascades recover slowly
        //     and hammering makes them worse.
        //   - Everything else: `MAX_STREAM_ERROR_RETRIES = 10`. Network flaps
        //     and transient 5xx usually recover within a few retries.
        //
        // Exceeding either budget surfaces a user-visible error via
        // `on_stream_error_exhausted` and breaks out of the loop with a
        // final assistant message in `final_content`.
        //
        // Broadcast rule (intermediate attempts): NOTHING about the retry is
        // visible as a chat bubble. Handlers get a low-key `on_stream_retry`
        // callback for footer/status indicators only.
        //
        // Broadcast rule (final failure): the handler gets both a
        // `on_stream_error_exhausted` callback (for the error footer) AND we
        // persist a clean user-visible assistant message so the turn history
        // reflects what the user saw.
        //
        // LLM message-history hygiene: we only add synthetic assistant +
        // tool_result rows when tool calls were emitted before the failure,
        // so the next API call stays OpenAI-compliant (assistant with
        // `tool_calls` must be followed by matching `tool` rows). Partial
        // text without tool_calls is discarded — the retry regenerates it.
        if response.finish_reason == finish::STREAM_ERROR {
            match handle_stream_error(
                &response,
                &mut retry_budgets,
                messages,
                cancel_flag,
                session_id,
                handler,
            )
            .await
            {
                StreamErrorOutcome::BudgetExhausted { user_message } => {
                    final_content = Some(user_message);
                    final_is_stream_error = true;
                    break;
                }
                StreamErrorOutcome::CancelledDuringBackoff => {
                    final_content = None;
                    break;
                }
                StreamErrorOutcome::Retry => continue,
            }
        }

        // Successful iteration — reset both stream-error retry budgets. A
        // single bad round doesn't carry a penalty forward into later
        // iterations. We reset independently because an overload recovery
        // shouldn't forgive a flapping connection from earlier in the turn.
        retry_budgets.reset_after_success(session_id);

        // Handle tool calls
        if response.has_tool_calls() {
            let current_signature: String = response
                .tool_calls
                .iter()
                .map(|tc| format!("{}:{}", tc.name, tc.arguments))
                .collect::<Vec<_>>()
                .join("|");

            if Some(&current_signature) == last_tool_signature.as_ref() {
                repeat_count += 1;
                if repeat_count >= MAX_REPEAT_STREAK {
                    let preview: String =
                        crate::utils::safe_truncate_chars_to_string(&current_signature, 200);
                    warn!(
                        "[agent-core] Detected {} repeated identical tool calls, breaking loop: {}",
                        repeat_count, preview
                    );
                    final_content = Some(format!(
                        "I attempted the same action {} times without progress and stopped to avoid an infinite loop. \
                         The last tool call was: {}",
                        repeat_count + 1,
                        preview
                    ));
                    break;
                }
            } else {
                repeat_count = 0;
            }
            last_tool_signature = Some(current_signature);

            let tool_call_values: Vec<Value> = response
                .tool_calls
                .iter()
                .map(|tc| {
                    let mut obj = serde_json::json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": tc.arguments.to_string(),
                        }
                    });
                    if let Some(sig) = &tc.thought_signature {
                        if sig.get("anthropic").is_some() {
                            obj["extra_content"] = sig.clone();
                        } else {
                            obj["extra_content"] = serde_json::json!({
                                "google": { "thought_signature": sig }
                            });
                        }
                    }
                    obj
                })
                .collect();

            add_assistant_message(
                messages,
                response.content.as_deref(),
                Some(&tool_call_values),
                response.reasoning_content.as_deref(),
            );
            handler.on_assistant_iteration_complete(
                session_id,
                response.content.as_deref(),
                true,
                &config.model,
            );

            let (_count, outcome) = execute_tool_calls(
                messages,
                &response.tool_calls,
                tools,
                policy,
                session_id,
                handler,
                permission_provider,
                cancel_flag,
                &mut file_tracker,
                &mut consecutive_errors,
                workspace_path,
                policy_context_activator,
                config.max_tool_use_concurrency,
            )
            .await;

            // Backfill dummy results for any tool calls that don't have a
            // result yet after EarlyExit.
            let existing_ids: std::collections::HashSet<String> = messages
                .iter()
                .filter_map(|m| {
                    m.get("tool_call_id")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .collect();
            for tc in &response.tool_calls {
                if !existing_ids.contains(&tc.id) {
                    // Backfill so the assistant tool_use has a matching
                    // tool_result (Anthropic wire requires the pair).
                    // Marked `is_error: true` so the model treats this
                    // as a failed call rather than a successful no-op
                    // — silent "" results have caused models to
                    // hallucinate that the cancelled tool succeeded.
                    add_tool_result(
                        messages,
                        &tc.id,
                        &tc.name,
                        "[cancelled — tool was not executed]",
                        true,
                    );
                }
            }

            match outcome {
                ToolBatchOutcome::Continue => {}
                ToolBatchOutcome::EndTurn(content) => {
                    final_content = Some(content);
                    break;
                }
                ToolBatchOutcome::Cancelled => {
                    if config.persist_cancel_marker {
                        crate::core::session::persistence::mark_turn_cancelled(session_id);
                    }
                    final_content = None;
                    break;
                }
                ToolBatchOutcome::ErrorLoop(msg) => {
                    final_content = Some(msg);
                    break;
                }
            }
        } else if response.finish_reason == finish::LENGTH {
            match maybe_recover_from_length(
                &response,
                messages,
                &mut tier1_escalated,
                effective_max_tokens,
                config.max_tokens,
                &mut output_recovery_count,
                session_id,
                &config.model,
                handler,
            ) {
                LengthRecoveryOutcome::Continue {
                    effective_max_tokens: new_max,
                } => {
                    effective_max_tokens = new_max;
                    continue;
                }
                LengthRecoveryOutcome::Terminal => {
                    final_content = response.content;
                    break;
                }
            }
        } else {
            // Terminal non-tool, non-length, non-stream-error iteration.
            // Normally `response.content` carries the model's final text.
            // But some stop reasons end the turn with an EMPTY body — most
            // notably Anthropic `stop_reason=refusal` (mapped to
            // CONTENT_FILTER), which returns zero content and zero tool calls.
            // Without a fail-safe here the turn breaks with `final_content =
            // None`, nothing is persisted, no assistant row is written, and
            // the UI spinner runs forever. Substitute a user-visible notice so
            // the turn terminates cleanly and the user knows to retry.
            let is_empty = response
                .content
                .as_ref()
                .map(|c| c.trim().is_empty())
                .unwrap_or(true);
            if is_empty {
                let notice = if response.finish_reason == finish::CONTENT_FILTER {
                    "The model declined to respond to this turn (no output was \
                     produced). This is usually triggered by the content of the \
                     request — try rephrasing, splitting a large paste into \
                     smaller parts, or resending."
                } else {
                    "The model ended this turn without producing any output. \
                     You can send a follow-up message to continue."
                };
                final_content = Some(notice.to_string());
            } else {
                final_content = response.content;
            }
            break;
        }
    }

    if let Some(max) = config.max_iterations {
        if final_content.is_none() && iteration >= max {
            warn!(
                "[agent-core] Hit max iterations ({}) for session {}",
                max, session_id
            );
            final_content = Some(format!(
                "I reached the maximum number of iterations ({}) for this turn. \
                 The task may not be fully complete — you can send a follow-up message to continue.",
                max
            ));
        }
    }

    usage.finalize();

    // Persist the terminal assistant content exactly once. Cases:
    //   1. The loop broke with `final_content = response.content` (pure-text
    //      final iteration at the `else { ... break; }` arm) — this content
    //      was NOT passed through `add_assistant_message`, so no earlier
    //      `on_assistant_iteration_complete` hook captured it. We persist it
    //      now so `load_llm_history` can replay the last thing the model said.
    //   2. `final_content` is a semantic closure string (repeat-loop break,
    //      max-iterations notice). These are synthetic but carry LLM-relevant
    //      context: the model needs to know why the previous turn ended so it
    //      can continue correctly. Persist them.
    //   3. `final_content` is a stream-error exhausted message (is_stream_error
    //      = true). This is a user-facing error notice with no LLM semantic
    //      value — skip persistence (no-silent-error persistence). The text is surfaced via
    //      on_stream_error_exhausted + agent:error / agent:complete events.
    //
    // The processor previously did this in `save_assistant_msg(response_text)`
    // at its turn epilogue; that call is removed now that the hook owns the
    // lifecycle end-to-end.
    if let Some(ref text) = final_content {
        if !text.is_empty() && !final_is_stream_error {
            // Do NOT persist stream-error messages into conversation history.
            // Error assistant messages are shown to the user but filtered
            // from the API message list so they don't pollute the LLM's
            // context on the next call. When is_stream_error = true the text
            // was already surfaced via on_stream_error_exhausted +
            // agent:error / agent:complete events.
            handler.on_assistant_iteration_complete(
                session_id,
                Some(text.as_str()),
                false,
                &config.model,
            );
        }
    }

    Ok(TurnResult {
        content: final_content,
        messages: messages.clone(),
        is_stream_error: final_is_stream_error,
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.total,
        context_tokens: usage.last_prompt,
        context_usage_snapshot,
        cache_read_tokens: usage.cache_read,
        cache_write_tokens: usage.cache_write,
    })
}
