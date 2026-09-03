//! State-machine coordinator for one agentic turn.
//!
//! Each phase remains ordered exactly as the original loop: iteration input,
//! provider request/recovery, usage and stream recovery, tool execution or
//! completion, then the terminal result projection.

mod completion;
mod iteration_input;
mod loop_state;
mod provider_iteration;
mod recovery;
mod tool_iteration;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;

use crate::providers::traits::LLMProvider;
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use self::loop_state::{finish_turn, LoopControl, TurnLoopState};
use super::tool_execution::is_cancelled;
use super::types::{PermissionProvider, TurnConfig, TurnEventHandler, TurnResult};

/// Execute one agent turn: messages → (LLM + tools)* → final response.
///
/// This is the generic agentic loop shared by all agent sessions. The public
/// signature and TurnResult contract are intentionally stable; private
/// phases expose the loop transition order without creating new runtime
/// owners.
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
    policy_context_activator: Option<&SessionScopedContextActivator>,
) -> Result<TurnResult, String> {
    let mut state = TurnLoopState::new(config, messages);

    // Stamp shared tool instances with the child/current session before the
    // first iteration, preserving the single pre-loop initialization point.
    tools.set_session_key(session_id).await;

    loop {
        match iteration_input::prepare_iteration_input(
            &mut state,
            messages,
            config,
            session_id,
            handler,
            cancel_flag,
        )
        .await
        {
            LoopControl::Proceed => {}
            LoopControl::Continue => continue,
            LoopControl::Break => break,
        }

        let request = provider_iteration::prepare_request(
            &mut state, messages, tools, policy, config, session_id,
        );
        let response = match provider_iteration::call_provider(
            &state,
            &request,
            provider,
            config,
            session_id,
            handler,
            cancel_flag,
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                match recovery::handle_provider_error(
                    error, &mut state, messages, config, session_id,
                ) {
                    Ok(LoopControl::Continue) => continue,
                    Ok(LoopControl::Break) => break,
                    Ok(LoopControl::Proceed) => continue,
                    Err(error) => {
                        state.terminal_error = Some(error);
                        break;
                    }
                }
            }
        };

        if let LoopControl::Break = recovery::handle_post_stream_cancellation(
            &response,
            &mut state,
            messages,
            config,
            session_id,
            handler,
            cancel_flag,
        ) {
            break;
        }

        recovery::record_usage(&response, &request, &mut state, config, session_id, handler);

        match recovery::handle_stream_recovery(
            &response,
            &mut state,
            messages,
            cancel_flag,
            session_id,
            handler,
        )
        .await
        {
            LoopControl::Proceed => {}
            LoopControl::Continue => continue,
            LoopControl::Break => break,
        }

        // Only a non-stream-error iteration resets both retry categories.
        state.retry_budgets.reset_after_success(session_id);

        let control = if response.has_tool_calls() {
            tool_iteration::execute_tool_iteration(
                &response,
                &mut state,
                messages,
                tools,
                policy,
                config,
                session_id,
                handler,
                permission_provider,
                cancel_flag,
                policy_context_activator,
            )
            .await
        } else {
            completion::complete_non_tool_iteration(
                response,
                &mut state,
                messages,
                config,
                session_id,
                handler,
                cancel_flag,
            )
            .await
        };

        match control {
            LoopControl::Proceed | LoopControl::Continue => continue,
            LoopControl::Break => break,
        }
    }

    if config
        .turn_process_control
        .as_ref()
        .is_some_and(|control| control.require_owned_job_finality)
    {
        let control = config
            .turn_process_control
            .as_ref()
            .ok_or_else(|| "Agent Org Turn finality requires an exact runtime owner".to_string())?;
        if !crate::tools::impls::coding::exec::registry::list_jobs_for_owner(&control.owner)
            .is_empty()
        {
            crate::tools::impls::coding::exec::registry::cancel_and_await_jobs_for_owner(
                &control.owner,
                std::time::Duration::from_secs(12),
            )
            .await
            .map_err(|error| format!("Agent Org Turn background-work teardown failed: {error}"))?;
            if !is_cancelled(cancel_flag) && state.terminal_error.is_none() {
                return Err("Agent Org Turn ended before its background work converged".to_string());
            }
        }
    }
    if let Some(error) = state.terminal_error.take() {
        return Err(error);
    }

    Ok(finish_turn(state, messages, config, session_id, handler))
}
