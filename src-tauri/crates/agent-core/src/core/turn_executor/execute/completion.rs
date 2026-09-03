use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use crate::providers::traits::{finish_reason as finish, LLMResponse};

use super::super::continuation::{should_auto_continue, MAX_AUTO_CONTINUATIONS};
use super::super::length_recovery::{maybe_recover_from_length, LengthRecoveryOutcome};
use super::super::tool_execution::is_cancelled;
use super::super::types::{TurnConfig, TurnEventHandler};
use super::iteration_input::drain_steering_queue;
use super::loop_state::{LoopControl, TurnLoopState};

const MAX_STOP_HOOK_BLOCKS: u32 = 3;
const MAX_OWNED_JOB_FINALITY_BLOCKS: u32 = 3;

pub(super) async fn complete_non_tool_iteration(
    response: LLMResponse,
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> LoopControl {
    if response.finish_reason == finish::LENGTH {
        return match maybe_recover_from_length(
            &response,
            messages,
            &mut state.tier1_escalated,
            state.effective_max_tokens,
            config.max_tokens,
            &mut state.output_recovery_count,
            session_id,
            &config.model,
            handler,
        ) {
            LengthRecoveryOutcome::Continue {
                effective_max_tokens,
            } => {
                state.effective_max_tokens = effective_max_tokens;
                LoopControl::Continue
            }
            LengthRecoveryOutcome::Terminal => {
                state.final_content = response.content;
                LoopControl::Break
            }
        };
    }

    // A message arriving during the final provider call must not be silently
    // deferred to a turn that may never come. Persist the assistant text,
    // place the steering message after it, and iterate again.
    if !is_cancelled(cancel_flag)
        && drain_steering_queue(&config.steering_queue, session_id, messages, handler).await
    {
        if let Some(ref text) = response.content {
            if !text.trim().is_empty() {
                handler.on_assistant_iteration_complete(
                    session_id,
                    Some(text.as_str()),
                    false,
                    &config.model,
                );
                let steering_message = messages.pop();
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": text,
                }));
                if let Some(steering_message) = steering_message {
                    messages.push(steering_message);
                }
            }
        }
        return LoopControl::Continue;
    }

    if config
        .turn_process_control
        .as_ref()
        .is_some_and(|control| control.require_owned_job_finality)
        && !is_cancelled(cancel_flag)
    {
        let Some(control) = config.turn_process_control.as_ref() else {
            state.terminal_error =
                Some("Agent Org Turn finality requires an exact runtime owner".to_string());
            return LoopControl::Break;
        };
        let jobs = crate::tools::impls::coding::exec::registry::list_jobs_for_owner(&control.owner);
        if !jobs.is_empty() {
            let at_iteration_limit = config
                .max_iterations
                .is_some_and(|max| state.iteration >= max);
            if state.owned_job_finality_blocks >= MAX_OWNED_JOB_FINALITY_BLOCKS
                || at_iteration_limit
            {
                state.terminal_error = Some(
                    match crate::tools::impls::coding::exec::registry::cancel_and_await_jobs_for_owner(
                        &control.owner,
                        std::time::Duration::from_secs(12),
                    )
                    .await
                    {
                        Ok(()) => {
                            "Agent Org Turn tried to finish before its background work converged"
                                .to_string()
                        }
                        Err(error) => format!(
                            "Agent Org Turn could not stop unconverged background work: {error}"
                        ),
                    },
                );
                return LoopControl::Break;
            }
            state.owned_job_finality_blocks += 1;

            if let Some(ref text) = response.content {
                if !text.trim().is_empty() {
                    handler.on_assistant_iteration_complete(
                        session_id,
                        Some(text.as_str()),
                        false,
                        &config.model,
                    );
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": text,
                    }));
                }
            }

            let completed: Vec<_> = jobs
                .iter()
                .filter(|job| job.has_unread_output)
                .cloned()
                .collect();
            let note = if completed.is_empty() {
                format!(
                    "<system-reminder>\nThis Agent Org Turn still owns {} running background job(s). The Turn cannot finish while they are active. Await their result or kill them, consume the terminal output in this same Turn, and only then provide the final answer.\n</system-reminder>",
                    jobs.len()
                )
            } else {
                use crate::core::session::turn::background_reminder;
                let note = background_reminder::build_completion_notification(&completed);
                crate::tools::impls::coding::exec::registry::acknowledge_outputs_for_owner(
                    &control.owner,
                    &background_reminder::inlined_result_handles(&completed),
                );
                note
            };
            messages.push(serde_json::json!({
                "role": "user",
                "content": note,
            }));
            return LoopControl::Continue;
        }
    }

    // User-defined Stop hooks may block completion, but only up to the same
    // hard cap as before so a permanently blocking hook cannot spin forever.
    if state.stop_hook_blocks < MAX_STOP_HOOK_BLOCKS && !is_cancelled(cancel_flag) {
        if let Some(feedback) = handler.on_turn_stop_check(session_id).await {
            state.stop_hook_blocks += 1;
            warn!(
                "[agent-core] Stop hook blocked turn completion ({}/{}) for session {}: {}",
                state.stop_hook_blocks,
                MAX_STOP_HOOK_BLOCKS,
                session_id,
                &feedback[..feedback.len().min(200)]
            );
            if let Some(ref text) = response.content {
                if !text.trim().is_empty() {
                    handler.on_assistant_iteration_complete(
                        session_id,
                        Some(text.as_str()),
                        false,
                        &config.model,
                    );
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": text,
                    }));
                }
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!(
                    "<system-reminder>\nA Stop hook blocked this completion:\n{}\nAddress the feedback and continue; do not stop until it is resolved.\n</system-reminder>",
                    feedback
                ),
            }));
            return LoopControl::Continue;
        }
    }

    // Feature-gated auto-continuation follows the stop-hook check and retains
    // the per-turn cap plus diminishing-returns baseline.
    if !is_cancelled(cancel_flag) {
        let context_percent = state
            .context_usage_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.percent_used);
        let last_progress_tokens = state
            .auto_continue_completion_baseline
            .map(|baseline| state.usage.completion - baseline);
        if should_auto_continue(
            config.auto_continue,
            state.auto_continuations,
            last_progress_tokens,
            context_percent,
        ) {
            state.auto_continuations += 1;
            state.auto_continue_completion_baseline = Some(state.usage.completion);
            let pct = context_percent.unwrap_or(0.0).round() as i64;
            info!(
                "[agent-core] Auto-continue {}/{} injected (context {}% used, session={})",
                state.auto_continuations, MAX_AUTO_CONTINUATIONS, pct, session_id
            );
            if let Some(ref text) = response.content {
                if !text.trim().is_empty() {
                    handler.on_assistant_iteration_complete(
                        session_id,
                        Some(text.as_str()),
                        false,
                        &config.model,
                    );
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": text,
                    }));
                }
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!(
                    "<system-reminder>\nContext window is only {pct}% used. Do not wrap up, summarize, or hand off — continue working on the task directly.\n</system-reminder>"
                ),
            }));
            return LoopControl::Continue;
        }
    }

    // Some terminal reasons (notably Anthropic refusal/content_filter) carry
    // no body. Substitute the existing user-visible notice so the turn closes.
    let is_empty = response
        .content
        .as_ref()
        .map(|content| content.trim().is_empty())
        .unwrap_or(true);
    state.final_content = if is_empty {
        let notice = if response.finish_reason == finish::CONTENT_FILTER {
            "The model declined to respond to this turn (no output was \
             produced). This is usually triggered by the content of the \
             request — try rephrasing, splitting a large paste into \
             smaller parts, or resending."
        } else {
            "The model ended this turn without producing any output. \
             You can send a follow-up message to continue."
        };
        Some(notice.to_string())
    } else {
        response.content
    };
    LoopControl::Break
}
