//! Foreground-mode subagent execution — block until the turn loop returns,
//! persist the transcript, update LinkedSession, and surface the result back
//! to the parent's `agent` tool call.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use super::AgentTool;
use crate::definitions::AgentDefinition;
use crate::providers::traits::LLMProvider;
use crate::tools::impls::coding::exec::registry as job_registry;
use crate::tools::impls::orchestration::subagent_handler::UnifiedSubagentHandler;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::ToolError;
use crate::turn_executor::{self, TurnConfig};
use core_types::workflow::LinkedSessionStatus;

/// Inputs for `run_foreground_subagent`. Bundled to keep the call site
/// readable and avoid clippy `too_many_arguments`.
pub(super) struct ForegroundRunArgs<'a> {
    pub agent: &'a AgentDefinition,
    pub messages: Vec<Value>,
    pub turn_config: TurnConfig,
    pub effective_registry: &'a ToolRegistry,
    pub effective_policy: ResolvedToolPolicy,
    pub workspace: &'a Path,
    pub subagent_session_id: String,
    pub parent_session_id: String,
    pub subagent_type_label: String,
    pub handler: UnifiedSubagentHandler,
    pub instance_number: u32,
    pub model: String,
    /// Provider bound to the sub-agent's own primary model + reliability
    /// chain. See `helpers::resolve_subagent_model` for the precedence
    /// rules. Inherits from the parent only as a degraded fallback when
    /// the sub-agent definition has no model and no overrides.
    pub provider: Arc<dyn LLMProvider>,
}

impl AgentTool {
    /// Run the subagent's turn loop synchronously and return the assistant
    /// response (or a structured error) for inclusion in the parent's tool
    /// result.
    pub(super) async fn run_foreground_subagent(
        &self,
        args: ForegroundRunArgs<'_>,
    ) -> Result<String, ToolError> {
        let ForegroundRunArgs {
            agent,
            mut messages,
            turn_config,
            effective_registry,
            effective_policy,
            workspace,
            subagent_session_id,
            parent_session_id,
            subagent_type_label,
            handler,
            instance_number,
            model,
            provider,
        } = args;

        // Register in the job registry so the pin bar / kill chokepoint can
        // see and stop foreground workers too — previously only background
        // subagents were registered, which made foreground workers
        // un-killable from `kill_subagent` (the user's only per-worker stop
        // affordance). The job observes the SAME flag `execute_turn` watches:
        // the parent session's flag when wired, else a job-private flag.
        let fg_cancel_flag = self
            .config
            .parent_cancel_flag
            .clone()
            .unwrap_or_else(|| Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let _job_tx = job_registry::register_subagent_with_flag(
            subagent_session_id.clone(),
            subagent_type_label,
            agent.name.clone(),
            parent_session_id,
            Arc::clone(&fg_cancel_flag),
        );

        // Armed for the whole run. If the turn loop panics and unwinds past the
        // result `match` below, the guard's Drop emits a terminal Failed so the
        // registry/UI never get stuck on a ghost "running" row. Disarmed once
        // the real verdict is written.
        let mut finalize_guard = super::helpers::FinalizeGuard::new(subagent_session_id.clone());

        // 1. Execute turn
        let turn_result = turn_executor::execute_turn(
            &mut messages,
            provider.as_ref(),
            effective_registry,
            &effective_policy,
            &turn_config,
            &subagent_session_id,
            &handler,
            None,
            Some(&fg_cancel_flag),
            Some(workspace),
            None,
        )
        .await;

        // 2. Persist subagent messages for future resume
        {
            let sid = subagent_session_id.clone();
            let msgs = messages.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(err) = crate::session::persistence::save_subagent_transcript(&sid, &msgs)
                {
                    warn!("[agent] Failed to persist transcript for {}: {}", sid, err);
                }
            });
        }

        // 3. Handle result + update LinkedSession.
        // If the subagent's terminal iteration produced no text (pure
        // tool_use turn), backtrack through the turn's message history to
        // find the most recent assistant narration so the parent agent
        // never receives an empty subagent result. This is the right layer
        // to do it — this function is the seam where the subagent's
        // transcript is collapsed into a single response for the caller.
        //
        // A cooperative cancel (kill_subagent / parent-Stop) makes
        // `execute_turn` return Ok with no content — classify as Cancelled,
        // not Completed (same rule as the background path). The registry
        // status is already `Killed` (sticky in mark_exited).
        let was_cancelled = fg_cancel_flag.load(std::sync::atomic::Ordering::SeqCst);
        let (final_status, tokens, response) = match turn_result {
            Ok(result) => {
                let resp = result.content.or_else(|| {
                    turn_executor::last_assistant_text(&result.messages).inspect(|recovered| {
                        info!(
                            "[agent] '{}' terminal iteration had no text; recovered {} chars from earlier turn",
                            agent.name,
                            recovered.len()
                        );
                    })
                }).unwrap_or_else(|| {
                    if was_cancelled {
                        format!("Agent '{}' was cancelled before completing.", agent.name)
                    } else {
                        format!(
                            "Agent '{}' completed but produced no text response.",
                            agent.name
                        )
                    }
                });
                handler.broadcast_complete();
                job_registry::mark_exited(&subagent_session_id, job_registry::JobStatus::Completed);
                // The result is returned inline as the parent's tool result —
                // suppress the unread-output system reminder that background
                // jobs rely on.
                job_registry::acknowledge_output(&subagent_session_id);
                (
                    if was_cancelled {
                        LinkedSessionStatus::Cancelled
                    } else {
                        LinkedSessionStatus::Completed
                    },
                    result.total_tokens,
                    Ok(resp),
                )
            }
            Err(err) => {
                // A failed turn must still surface whatever the subagent
                // produced before dying — `messages` was mutated in place by
                // `execute_turn`, so the partial transcript is right here.
                // Losing a 35-minute run to a terminal `ContextTooLong` and
                // returning only the bare error is exactly the incident this
                // guards against.
                let mut msg = format!("Agent '{}' failed: {}", agent.name, err);
                if let Some(partial) = turn_executor::last_assistant_text(&messages) {
                    info!(
                        "[agent] '{}' failed but recovered {} chars of partial progress",
                        agent.name,
                        partial.len()
                    );
                    msg.push_str(&format!(
                        "\n\nPartial progress before failure:\n{}",
                        partial
                    ));
                }
                msg.push_str(&format!(
                    "\n\nThe partial transcript was saved. You may retry with \
                     resume_session_id=\"{}\" to continue from it.",
                    subagent_session_id
                ));
                handler.broadcast_error();
                job_registry::mark_exited(&subagent_session_id, job_registry::JobStatus::Failed);
                job_registry::acknowledge_output(&subagent_session_id);
                (
                    LinkedSessionStatus::Failed,
                    0i64,
                    Err(ToolError::ExecutionFailed(msg)),
                )
            }
        };

        // Authoritative status (Completed/Failed) has been written above.
        // Disarm so the guard's Drop does not overwrite it with Failed.
        finalize_guard.disarm();

        let result_preview: String = match &response {
            Ok(resp) => crate::utils::safe_truncate_chars_to_string(&resp, 2000),
            Err(err) => format!("{}", err),
        };
        self.update_linked_session(&subagent_session_id, final_status, tokens, &result_preview)
            .await;

        // Same registry grace period as the background path so a Killed/
        // Completed verdict stays readable briefly, then the row is GC'd.
        {
            let gc_handle = subagent_session_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                job_registry::remove(&gc_handle);
            });
        }

        match &response {
            Ok(_) => {
                info!(
                    "[agent] '{}' #{} done (model={}): {} tokens",
                    agent.name, instance_number, model, tokens
                );
            }
            Err(err) => {
                warn!(
                    "[agent] '{}' #{} failed: {}",
                    agent.name, instance_number, err
                );
            }
        }

        response
    }
}
