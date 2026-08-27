use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tracing::warn;

use crate::providers::traits::LLMResponse;
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use super::super::helpers::{add_assistant_message, add_tool_result};
use super::super::repeat_guard::RepeatVerdict;
use super::super::tool_execution::{execute_tool_calls, ToolBatchOutcome};
use super::super::types::{PermissionProvider, TurnConfig, TurnEventHandler};
use super::loop_state::{LoopControl, TurnLoopState};

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_tool_iteration(
    response: &LLMResponse,
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    tools: &ToolRegistry,
    policy: &ResolvedToolPolicy,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    permission_provider: Option<&dyn PermissionProvider>,
    cancel_flag: Option<&Arc<AtomicBool>>,
    policy_context_activator: Option<&SessionScopedContextActivator>,
) -> LoopControl {
    let current_signature = response
        .tool_calls
        .iter()
        .map(|call| format!("{}:{}", call.name, call.arguments))
        .collect::<Vec<_>>()
        .join("|");

    // Progress-aware tools can repeat identical arguments while the observed
    // job advances. A batch fingerprint exists when any call supplies one.
    let current_fingerprint = {
        let parts: Vec<Option<String>> = response
            .tool_calls
            .iter()
            .map(|call| {
                tools
                    .get(&call.name)
                    .and_then(|tool| tool.progress_fingerprint(&call.arguments))
            })
            .collect();
        if parts.iter().any(Option::is_some) {
            Some(
                parts
                    .into_iter()
                    .map(|part| part.unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("|"),
            )
        } else {
            None
        }
    };

    if let RepeatVerdict::Break {
        executed_attempts,
        progress_aware,
    } = state
        .repeat_guard
        .observe(current_signature.clone(), current_fingerprint)
    {
        let preview = crate::utils::safe_truncate_chars_to_string(&current_signature, 200);
        warn!(
            "[agent-core] Breaking loop after {} identical no-progress tool calls (progress_aware={}): {}",
            executed_attempts, progress_aware, preview
        );
        state.final_content = Some(if progress_aware {
            format!(
                "The last {} checks of the same background job(s) found no new output or \
                 status change, so I'm pausing this turn instead of continuing to poll. \
                 If a job is still running, the session resumes automatically when it \
                 completes; you can also send a message to continue sooner. The repeated \
                 tool call was: {}",
                executed_attempts, preview
            )
        } else {
            format!(
                "I called the same tool with identical arguments {} times in a row \
                 without new information, so I stopped before repeating it again to \
                 avoid an infinite loop. The last tool call was: {}",
                executed_attempts, preview
            )
        });
        return LoopControl::Break;
    }

    let tool_call_values: Vec<Value> = response
        .tool_calls
        .iter()
        .map(|call| {
            let mut object = serde_json::json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": call.arguments.to_string(),
                }
            });
            if let Some(signature) = &call.thought_signature {
                if signature.get("anthropic").is_some() {
                    object["extra_content"] = signature.clone();
                } else {
                    object["extra_content"] = serde_json::json!({
                        "google": { "thought_signature": signature }
                    });
                }
            }
            object
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

    if response
        .tool_calls
        .iter()
        .any(|call| call.name == crate::tools::names::MANAGE_TODO)
    {
        state.iterations_since_todo_use = 0;
    }

    let (_count, tool_execution_usage, outcome) = execute_tool_calls(
        messages,
        &response.tool_calls,
        tools,
        policy,
        session_id,
        &config.turn_intent_id,
        &config.projected_inbox_ids,
        handler,
        permission_provider,
        cancel_flag,
        &mut state.file_tracker,
        &mut state.consecutive_errors,
        policy_context_activator,
        config.max_tool_use_concurrency,
    )
    .await;
    state
        .usage_telemetry
        .record_tool_results(state.iteration as i64, tool_execution_usage);

    // Backfill every tool_use still missing a result after EarlyExit so the
    // next provider request retains valid assistant/tool pairing.
    let existing_ids: HashSet<String> = messages
        .iter()
        .filter_map(|message| {
            message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .collect();
    for call in &response.tool_calls {
        if !existing_ids.contains(&call.id) {
            add_tool_result(
                messages,
                &call.id,
                &call.name,
                "[cancelled — tool was not executed]",
                true,
            );
        }
    }

    match outcome {
        ToolBatchOutcome::Continue => LoopControl::Continue,
        ToolBatchOutcome::EndTurn(content) => {
            state.final_content = Some(content);
            LoopControl::Break
        }
        ToolBatchOutcome::Cancelled => {
            if config.persist_cancel_marker {
                crate::core::session::persistence::mark_turn_cancelled(session_id);
            }
            state.final_content = None;
            LoopControl::Break
        }
        ToolBatchOutcome::ErrorLoop(message) => {
            state.final_content = Some(message);
            LoopControl::Break
        }
    }
}
