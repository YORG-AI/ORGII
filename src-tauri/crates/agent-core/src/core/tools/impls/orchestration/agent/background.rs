//! Background-mode subagent launch — register with the job registry,
//! spawn a `tokio::task` that runs the turn loop, and return the handle.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tracing::{info, warn};

use super::AgentTool;
use crate::definitions::AgentDefinition;
use crate::providers::traits::LLMProvider;
use crate::tools::impls::coding::exec::registry as job_registry;
use crate::tools::impls::orchestration::subagent_handler::{
    BroadcastingHandler, UnifiedSubagentHandler,
};
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;
use crate::turn_executor::{self, TurnConfig};
use core_types::workflow::LinkedSessionStatus;
use git;

/// Inputs for `spawn_background_subagent`. Bundled into a struct because
/// passing 13 individual params hits clippy's `too_many_arguments`.
pub(super) struct BackgroundSpawnArgs<'a> {
    pub agent: &'a AgentDefinition,
    pub messages: Vec<Value>,
    pub turn_config: TurnConfig,
    pub effective_policy: ResolvedToolPolicy,
    /// `Some(fresh)` means the subagent owns its own registry (Path B);
    /// `None` means inherit the parent's (Paths A/shadow).
    pub fresh_registry: Option<ToolRegistry>,
    pub parent_registry: Arc<ToolRegistry>,
    pub workspace: PathBuf,
    pub subagent_session_id: String,
    pub parent_session_id: String,
    pub subagent_type_label: String,
    pub model: String,
    pub provider: Arc<dyn LLMProvider>,
    pub work_item_id: Option<String>,
    pub parent_cancel_flag: Option<Arc<AtomicBool>>,
    pub handler: UnifiedSubagentHandler,
    /// When the subagent runs inside a worktree isolation, this is the repo
    /// root needed to call `remove_session_worktree` after the task exits.
    /// `None` for non-isolated subagents.
    pub worktree_workspace_root: Option<PathBuf>,
}

impl AgentTool {
    /// Spawn the subagent's turn loop on a background tokio task and return a
    /// handle string the LLM can poll via `await_output`.
    ///
    /// Lifetime: the spawned task owns all data needed for the loop, persists
    /// the transcript, updates the LinkedSession, and stays in the registry
    /// for a 120s grace period after termination so `await_output` can still
    /// read the final result.
    pub(super) fn spawn_background_subagent(args: BackgroundSpawnArgs<'_>) -> String {
        let BackgroundSpawnArgs {
            agent,
            mut messages,
            turn_config,
            effective_policy,
            fresh_registry,
            parent_registry,
            workspace,
            subagent_session_id,
            parent_session_id,
            subagent_type_label,
            model,
            provider,
            work_item_id,
            parent_cancel_flag,
            handler,
            worktree_workspace_root,
        } = args;

        let bg_session_id = subagent_session_id.clone();
        let bg_agent_name = agent.name.clone();
        let bg_model = model;
        let bg_provider = provider;
        let bg_registry: Arc<ToolRegistry> = if let Some(fresh) = fresh_registry {
            Arc::new(fresh)
        } else {
            parent_registry
        };
        let bg_policy = effective_policy;
        let bg_turn_config = turn_config;
        let bg_workspace = workspace;
        let bg_work_item_id = work_item_id;
        let bg_cancel_flag = parent_cancel_flag;

        // Register in job registry so AwaitTool can monitor. The job owns its
        // own cancel flag — `kill_subagent` and the parent-Stop fan-out in
        // `AgentSession::cancel_active_turn` set THAT flag, not the parent
        // session's. Two reasons:
        // - the parent flag is pulsed back to `false` at the parent's turn
        //   boundary, so a slow worker could miss the pulse entirely;
        // - ForceSend (Send Now) pulses the parent flag but must NOT stop
        //   background workers (`boundary_effect().cancel_background_workers
        //   == false`), which a shared flag cannot express.
        let (broadcast_tx, job_cancel_flag) = job_registry::register_subagent(
            bg_session_id.clone(),
            subagent_type_label,
            bg_agent_name.clone(),
            parent_session_id.clone(),
        );
        // Parent flag is delivered via the explicit fan-out above, not by
        // sharing the Arc. Drop it here so nobody reintroduces the pulse race.
        drop(bg_cancel_flag);

        // Wrap handler with BroadcastingHandler to feed the registry channel
        let broadcasting_handler = BroadcastingHandler::new(handler, broadcast_tx);

        let registry_handle = bg_session_id.clone();
        let turn_cancel_flag = Arc::clone(&job_cancel_flag);
        let join_handle = tokio::spawn(async move {
            // Armed for the whole task body. If the turn loop panics and
            // unwinds past the result `match` below, the guard's Drop emits a
            // terminal Failed so the registry/UI never get stuck on a ghost
            // "running" row. Disarmed once the real verdict is written.
            let mut finalize_guard = super::helpers::FinalizeGuard::new(bg_session_id.clone());

            let turn_result = turn_executor::execute_turn(
                &mut messages,
                bg_provider.as_ref(),
                bg_registry.as_ref(),
                &bg_policy,
                &bg_turn_config,
                &bg_session_id,
                &broadcasting_handler,
                None,
                Some(&turn_cancel_flag),
                Some(bg_workspace.as_path()),
                None,
            )
            .await;

            // Persist transcript. Inner closure already logs IO errors via
            // `warn!`; the only thing the discarded `Result` here can carry is
            // a `JoinError` (the spawn_blocking thread panicked). Surface that
            // explicitly so a panic in the persistence layer doesn't vanish
            // into "no transcript and no log line".
            {
                let sid = bg_session_id.clone();
                let msgs = messages.clone();
                let join_result = tokio::task::spawn_blocking(move || {
                    if let Err(err) =
                        crate::session::persistence::save_subagent_transcript(&sid, &msgs)
                    {
                        warn!(
                            "[agent:bg] Failed to persist transcript for {}: {}",
                            sid, err
                        );
                    }
                })
                .await;
                if let Err(join_err) = join_result {
                    warn!(
                        "[agent:bg] save_subagent_transcript task for {} did not complete cleanly: {}; transcript may be missing",
                        bg_session_id, join_err
                    );
                }
            }

            // Handle result + update registry.
            // Same finalizeAgentTool parity as the foreground path: backtrack
            // through message history when the terminal iteration was pure tool_use.
            //
            // A cooperative cancel (kill_subagent / parent-Stop fan-out) makes
            // `execute_turn` return Ok with no content — classify that as
            // Cancelled, not Completed, for the LinkedSession write-back.
            // The registry status is already `Killed` (sticky in mark_exited).
            let was_cancelled = turn_cancel_flag.load(std::sync::atomic::Ordering::SeqCst);
            match turn_result {
                Ok(result) => {
                    let resp = result.content.or_else(|| {
                        turn_executor::last_assistant_text(&result.messages).inspect(|recovered| {
                            info!(
                                "[agent:bg] '{}' terminal iteration had no text; recovered {} chars from earlier turn",
                                bg_agent_name,
                                recovered.len()
                            );
                        })
                    }).unwrap_or_else(|| {
                        if was_cancelled {
                            format!("Agent '{}' was cancelled before completing.", bg_agent_name)
                        } else {
                            format!(
                                "Agent '{}' completed but produced no text response.",
                                bg_agent_name
                            )
                        }
                    });
                    broadcasting_handler.broadcast_complete();
                    job_registry::set_final_result(&bg_session_id, resp.clone());
                    job_registry::mark_exited(&bg_session_id, job_registry::JobStatus::Completed);
                    info!(
                        "[agent:bg] '{}' done (model={}, cancelled={}): {} tokens",
                        bg_agent_name, bg_model, was_cancelled, result.total_tokens
                    );

                    if let Some(ref wid) = bg_work_item_id {
                        let preview: String =
                            crate::utils::safe_truncate_chars_to_string(&resp, 2000);
                        AgentTool::update_linked_session_sync(
                            wid,
                            &bg_session_id,
                            if was_cancelled {
                                LinkedSessionStatus::Cancelled
                            } else {
                                LinkedSessionStatus::Completed
                            },
                            result.total_tokens,
                            &preview,
                        );
                    }
                }
                Err(err) => {
                    // Same partial-progress contract as the foreground path:
                    // a failed run must not discard what the subagent already
                    // found. `messages` holds the in-place transcript.
                    let mut msg = format!("Agent '{}' failed: {}", bg_agent_name, err);
                    if let Some(partial) = turn_executor::last_assistant_text(&messages) {
                        info!(
                            "[agent:bg] '{}' failed but recovered {} chars of partial progress",
                            bg_agent_name,
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
                        bg_session_id
                    ));
                    broadcasting_handler.broadcast_error();
                    job_registry::set_final_result(&bg_session_id, msg.clone());
                    job_registry::mark_exited(&bg_session_id, job_registry::JobStatus::Failed);
                    warn!("[agent:bg] '{}' failed: {}", bg_agent_name, err);

                    if let Some(ref wid) = bg_work_item_id {
                        AgentTool::update_linked_session_sync(
                            wid,
                            &bg_session_id,
                            LinkedSessionStatus::Failed,
                            0,
                            &msg,
                        );
                    }
                }
            }

            // Authoritative status (Completed/Failed) has been written above.
            // Disarm so the guard's Drop does not overwrite it with Failed.
            finalize_guard.disarm();

            // Clean up worktree isolation after the task completes.
            // Runs before the grace-period sleep so `await_output` callers
            // see the result before the disk is cleaned up, and the worktree
            // does not accumulate across sessions.
            if let Some(workspace_root) = worktree_workspace_root {
                let wt_session_id = bg_session_id.clone();
                let wt_result = tokio::task::spawn_blocking(move || {
                    git::worktree::remove_session_worktree(&workspace_root, &wt_session_id, true)
                })
                .await;
                if let Ok(Err(err)) = wt_result {
                    warn!(
                        "[agent:bg] failed to remove isolation worktree for '{}' after task completion: {}",
                        bg_session_id, err
                    );
                }
            }

            // Remove from registry after grace period
            tokio::time::sleep(Duration::from_secs(120)).await;
            job_registry::remove(&bg_session_id);
        });

        // Store JoinHandle so registry::kill_subagent can abort it
        job_registry::set_join_handle(&registry_handle, join_handle);

        super::helpers::background_launch_message(&agent.name, &subagent_session_id)
    }
}
