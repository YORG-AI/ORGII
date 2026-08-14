//! Foreground-mode subagent execution — wait for the turn loop with a
//! transition deadline: if the worker is still running after
//! `FG_TO_BG_TRANSITION_SECS` the wait converts into a background handle
//! (the worker keeps running; its result arrives via the Background Jobs
//! reminder / wake hook), otherwise the result is returned inline.

use std::sync::Arc;
use std::time::Duration;

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

/// How long a foreground delegate blocks the parent's tool call before the
/// wait converts into a background handle (mirrors the reference harness's
/// foreground→background auto-transition). Workers are independent sessions,
/// so the conversion is purely a change in how the parent consumes the
/// result.
const FG_TO_BG_TRANSITION_SECS: u64 = 120;

/// Inputs for `run_foreground_subagent`. Bundled to keep the call site
/// readable and avoid clippy `too_many_arguments`.
pub(super) struct ForegroundRunArgs {
    pub agent: AgentDefinition,
    pub messages: Vec<Value>,
    pub turn_config: TurnConfig,
    pub effective_registry: Arc<ToolRegistry>,
    pub effective_policy: ResolvedToolPolicy,
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
    /// When the subagent runs inside a worktree isolation, the repo root
    /// needed to remove the worktree after the run — owned by the worker
    /// task now that it can outlive the parent's tool call.
    pub worktree_workspace_root: Option<std::path::PathBuf>,
}

impl AgentTool {
    /// Run the subagent's turn loop and return the assistant response (or a
    /// structured error) for inclusion in the parent's tool result. If the
    /// worker outlives the transition deadline, returns a background-style
    /// launch message instead and lets the worker finish in background.
    pub(super) async fn run_foreground_subagent(
        &self,
        args: ForegroundRunArgs,
    ) -> Result<String, ToolError> {
        let ForegroundRunArgs {
            agent,
            mut messages,
            turn_config,
            effective_registry,
            effective_policy,
            subagent_session_id,
            parent_session_id,
            subagent_type_label,
            handler,
            instance_number,
            model,
            provider,
            worktree_workspace_root,
        } = args;

        // Register in the job registry so the pin bar / kill chokepoint can
        // see and stop foreground workers too. The job owns a PRIVATE cancel
        // flag (same design as the background path): `kill_subagent` sets it
        // directly. While the parent is actively WAITING we mirror the
        // parent session's flag into it, so parent-Stop still cancels the
        // worker; after a fg→bg transition the mirroring stops and the
        // worker survives parent-turn boundaries (matching background
        // semantics, where ForceSend must NOT kill workers).
        let (_job_tx, job_cancel_flag) = job_registry::register_subagent(
            subagent_session_id.clone(),
            subagent_type_label,
            agent.name.clone(),
            parent_session_id.clone(),
        );
        let parent_cancel_flag = self.config.parent_cancel_flag.clone();

        let agent_name = agent.name.clone();
        let agent_id = agent.id.clone();
        let work_item_id = self.config.work_item_id.clone();

        // The worker task owns everything it needs so it can outlive this
        // tool call after a transition. It always writes the terminal
        // verdict (registry + LinkedSession + worktree cleanup) itself —
        // whether the parent is still waiting only changes how the RESULT
        // is consumed, never who finalizes.
        let task_session_id = subagent_session_id.clone();
        let task_parent_session_id = parent_session_id.clone();
        let task_cancel_flag = Arc::clone(&job_cancel_flag);
        let (result_tx, mut result_rx) =
            tokio::sync::oneshot::channel::<Result<String, ToolError>>();

        let join_handle = tokio::spawn(async move {
            // Armed for the whole run. If the turn loop panics and unwinds
            // past the result `match` below, the guard's Drop emits a
            // terminal Failed so the registry/UI never get stuck on a ghost
            // "running" row. Disarmed once the real verdict is written.
            let mut finalize_guard = super::helpers::FinalizeGuard::new(task_session_id.clone());

            let turn_result = turn_executor::execute_turn(
                &mut messages,
                provider.as_ref(),
                effective_registry.as_ref(),
                &effective_policy,
                &turn_config,
                &task_session_id,
                &handler,
                None,
                Some(&task_cancel_flag),
                None,
            )
            .await;

            // Persist subagent messages for future resume
            {
                let sid = task_session_id.clone();
                let msgs = messages.clone();
                tokio::task::spawn_blocking(move || {
                    if let Err(err) =
                        crate::session::persistence::save_subagent_transcript(&sid, &msgs)
                    {
                        warn!("[agent] Failed to persist transcript for {}: {}", sid, err);
                    }
                });
            }

            // Handle result + update LinkedSession.
            // If the subagent's terminal iteration produced no text (pure
            // tool_use turn), backtrack through the turn's message history
            // to find the most recent assistant narration so the parent
            // never receives an empty subagent result.
            //
            // A cooperative cancel (kill_subagent / parent-Stop) makes
            // `execute_turn` return Ok with no content — classify as
            // Cancelled, not Completed (same rule as the background path).
            let was_cancelled = task_cancel_flag.load(std::sync::atomic::Ordering::SeqCst);

            // Worktree disposition BEFORE result assembly, so a kept
            // worktree's location rides inside the final result text (and
            // survives the Background Jobs reminder's head-truncation).
            // Owned by the task so it also runs after a fg→bg transition.
            let kept_worktree = match worktree_workspace_root {
                Some(workspace_root) => {
                    let base_branch = crate::session::persistence::get_session(&task_session_id)
                        .ok()
                        .flatten()
                        .and_then(|record| record.base_branch);
                    super::helpers::dispose_worktree_after_run(
                        super::helpers::WorktreeCleanup {
                            workspace_root,
                            base_branch,
                        },
                        &task_session_id,
                        "agent",
                    )
                    .await
                }
                None => None,
            };

            let (final_status, tokens, response) = match turn_result {
                Ok(result) => {
                    let resp = result.content.or_else(|| {
                        turn_executor::last_assistant_text(&result.messages).inspect(|recovered| {
                            info!(
                                "[agent] '{}' terminal iteration had no text; recovered {} chars from earlier turn",
                                agent_name,
                                recovered.len()
                            );
                        })
                    }).unwrap_or_else(|| {
                        if was_cancelled {
                            format!("Agent '{}' was cancelled before completing.", agent_name)
                        } else {
                            format!(
                                "Agent '{}' completed but produced no text response.",
                                agent_name
                            )
                        }
                    });
                    // Soft-stop labelling: a run that hit the iteration cap
                    // is a partial result, not a completed one.
                    let resp = if result.hit_max_iterations {
                        format!("[worker hit iteration limit; partial result]\n{}", resp)
                    } else {
                        resp
                    };
                    // Usage/resume trailer: parent learns the cost and how
                    // to continue this agent. One-shot agents (Explore)
                    // skip it.
                    let resp = super::helpers::append_result_trailer(
                        resp,
                        &agent_id,
                        &task_session_id,
                        result.total_tokens,
                        super::helpers::count_tool_uses(&result.messages),
                    );
                    let resp = super::helpers::with_full_result_pointer(
                        &task_session_id,
                        super::helpers::prepend_worktree_note(resp, kept_worktree.as_ref()),
                    );
                    handler.broadcast_complete();
                    // broadcast_complete stamps the child row `completed`;
                    // a cooperative kill must read `cancelled` instead, or
                    // the monitoring UI shows a killed worker as succeeded.
                    if was_cancelled {
                        if let Err(err) = crate::session::persistence::update_status(
                            &task_session_id,
                            crate::session::SessionStatus::Cancelled,
                        ) {
                            warn!(
                                "[agent] failed to mark killed child session '{}' cancelled: {}",
                                task_session_id, err
                            );
                        }
                    }
                    // completed-first invariant (gh-20236 class): terminal
                    // status is written BEFORE final-result storage, wake,
                    // and LinkedSession writes, so anything blocking on
                    // "is it still running?" can never deadlock against
                    // slow post-processing.
                    job_registry::mark_exited(&task_session_id, job_registry::JobStatus::Completed);
                    // Store the final result so a transitioned parent reads
                    // it from the Background Jobs reminder exactly like a
                    // native background worker.
                    job_registry::set_final_result(&task_session_id, resp.clone());
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
                    // produced before dying — `messages` was mutated in place
                    // by `execute_turn`, so the partial transcript is right
                    // here. Losing a 35-minute run to a terminal
                    // `ContextTooLong` and returning only the bare error is
                    // exactly the incident this guards against.
                    let mut msg = format!("Agent '{}' failed: {}", agent_name, err);
                    if let Some(partial) = turn_executor::last_assistant_text(&messages) {
                        info!(
                            "[agent] '{}' failed but recovered {} chars of partial progress",
                            agent_name,
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
                        task_session_id
                    ));
                    let msg = super::helpers::prepend_worktree_note(msg, kept_worktree.as_ref());
                    handler.broadcast_error();
                    job_registry::mark_exited(&task_session_id, job_registry::JobStatus::Failed);
                    job_registry::set_final_result(&task_session_id, msg.clone());
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
                Ok(resp) => crate::utils::safe_truncate_chars_to_string(resp, 2000),
                Err(err) => format!("{}", err),
            };
            if let Some(ref wid) = work_item_id {
                AgentTool::update_linked_session_sync(
                    wid,
                    &task_session_id,
                    final_status,
                    tokens,
                    &result_preview,
                );
            }

            match &response {
                Ok(_) => info!(
                    "[agent] '{}' #{} done (model={}): {} tokens",
                    agent_name, instance_number, model, tokens
                ),
                Err(err) => warn!(
                    "[agent] '{}' #{} failed: {}",
                    agent_name, instance_number, err
                ),
            }

            // Hand the result to the waiting parent. If the parent already
            // transitioned to background (receiver dropped), fall back to
            // the background delivery path: acknowledge stays UNSET so the
            // Background Jobs reminder inlines the final result, and the
            // wake hook nudges an idle parent.
            match result_tx.send(response) {
                Ok(()) => {}
                Err(_) => {
                    info!(
                        "[agent] '{}' finished after fg→bg transition; delivering via background path",
                        task_session_id
                    );
                    crate::tools::impls::orchestration::job_wake::current_job_completion_wake_hook(
                    )
                    .wake_owner(&task_parent_session_id);
                    // Registry retention: same ack-polling GC as the native
                    // background path so the result survives until consumed.
                    job_registry::retain_until_acknowledged_then_remove(
                        &task_session_id,
                        Duration::from_secs(30 * 60),
                        "agent",
                    )
                    .await;
                }
            }
        });
        job_registry::set_join_handle(&subagent_session_id, join_handle);

        // ── Wait phase ────────────────────────────────────────────────
        // Poll-select: mirror parent-Stop into the job flag while waiting,
        // deliver the result inline when it arrives before the deadline,
        // otherwise convert to a background handle.
        let deadline = std::time::Instant::now() + Duration::from_secs(FG_TO_BG_TRANSITION_SECS);
        const PARENT_FLAG_MIRROR_INTERVAL: Duration = Duration::from_millis(200);
        loop {
            match result_rx.try_recv() {
                Ok(response) => {
                    // Inline delivery — suppress the unread-output reminder
                    // that background jobs rely on.
                    job_registry::acknowledge_output(&subagent_session_id);
                    // Registry grace period so the verdict stays readable
                    // briefly, then the row is GC'd.
                    let gc_handle = subagent_session_id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(120)).await;
                        job_registry::remove(&gc_handle);
                    });
                    return response;
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    // Worker task died without sending (panic — FinalizeGuard
                    // already wrote Failed). Surface a structured error.
                    return Err(ToolError::ExecutionFailed(format!(
                        "Agent '{}' worker task terminated unexpectedly; the registry \
                         status carries the failure verdict.",
                        agent.name
                    )));
                }
            }

            // Parent-Stop propagation while the parent is actively waiting.
            if parent_cancel_flag
                .as_ref()
                .is_some_and(|f| f.load(std::sync::atomic::Ordering::SeqCst))
            {
                job_cancel_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }

            if std::time::Instant::now() >= deadline {
                // ── fg→bg transition ──────────────────────────────────
                // Drop the receiver so the worker task detects the
                // transition and delivers via the background path.
                drop(result_rx);
                info!(
                    "[agent] '{}' still running after {}s; converting foreground wait into background handle",
                    subagent_session_id, FG_TO_BG_TRANSITION_SECS
                );
                return Ok(format!(
                    "Subagent '{}' is taking longer than {}s — it CONTINUES RUNNING in the background.\n{}",
                    agent.name,
                    FG_TO_BG_TRANSITION_SECS,
                    super::helpers::background_launch_message(&agent.name, &subagent_session_id)
                ));
            }

            tokio::time::sleep(PARENT_FLAG_MIRROR_INTERVAL).await;
        }
    }
}
