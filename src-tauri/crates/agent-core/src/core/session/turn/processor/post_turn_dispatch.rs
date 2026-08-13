//! Post-turn dispatch: broadcasts, hooks, locks, fire-and-forget jobs.
//!
//! Runs after `turn_executor::execute_turn` returns. Order matters:
//!
//! 1. **`agent:complete` broadcast** — first, so the user sees "done"
//!    before any background work fires.
//! 2. **Computer Use lock release** — best-effort, no-op if not held.
//! 3. **Session memory extraction** — fire-and-forget, 60s timeout.
//! 4. **Extract memories** — forked extractor agent, fire-and-forget.
//! 5. **Auto-dream** — periodic memory consolidation, fire-and-forget.
//!
//! (`HookEvent::Stop` no longer fires here — it runs *inside* the turn
//! loop as a blocking gate; see `on_turn_stop_check`.)
//!
//! Post-turn background work uses [`should_run_post_turn_work`] to skip the
//! work for cancelled turns (the user explicitly stopped).

use tracing::info;

use super::{should_run_post_turn_work, UnifiedMessageProcessor};
use crate::core::session::types::DialogTurnState;
use crate::turn_executor::TurnResult;

use super::super::post_turn as post_turn_jobs;
use super::super::streaming::{broadcast_agent_complete, AgentCompleteParams};

/// Inputs for [`UnifiedMessageProcessor::dispatch_post_turn_work`].
///
/// Bundled into a struct so the call site stays a single line. The
/// processor reads everything it needs off `&self`; this carries only
/// per-turn outputs (the result, the in-memory message list,
/// metrics, the cancel-derived turn state).
pub(super) struct PostTurnInputs<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub response_text: &'a str,
    pub messages: &'a [serde_json::Value],
    pub result: &'a TurnResult,
    pub tool_calls_count: u32,
    pub final_turn_state: DialogTurnState,
    pub turn_started_at_ms: i64,
}

impl UnifiedMessageProcessor {
    /// Runs every post-turn step (broadcast, Stop hook, CU lock release,
    /// four fire-and-forget spawns) in order.
    pub(super) async fn dispatch_post_turn_work(&self, inputs: PostTurnInputs<'_>) {
        let PostTurnInputs {
            session_id,
            turn_id,
            response_text,
            messages,
            result,
            tool_calls_count,
            final_turn_state,
            turn_started_at_ms,
        } = inputs;

        // 9. Broadcast completion FIRST — user sees "done" immediately.
        broadcast_agent_complete(&AgentCompleteParams {
            session_id,
            turn_id,
            content: response_text,
            model: &self.runtime.model,
            is_stream_error: result.is_stream_error,
            prompt_tokens: result.prompt_tokens,
            completion_tokens: result.completion_tokens,
            total_tokens: result.total_tokens,
            context_tokens: result.context_tokens,
            context_usage_snapshot: result.context_usage_snapshot.as_ref(),
        });

        // 9a. `HookEvent::Stop` now runs INSIDE the turn loop
        // (`turn_executor::execute_turn` terminal arm via
        // `on_turn_stop_check`), where blocking feedback can still pull the
        // model back. No post-turn re-fire — that would double-invoke the
        // user's Stop hooks.

        // 9a½. Release Computer Use lock if held (zero-syscall check for non-CU turns).
        if integrations::computer_use_lock::is_held_locally() {
            let released = integrations::computer_use_lock::release(session_id);
            if released {
                info!(
                    "[unified_processor] Computer use lock released for session {}",
                    session_id
                );
                crate::bus::broadcast_event(
                    "agent:computer_use_exited",
                    serde_json::json!({ "sessionId": session_id }),
                );
            }
        }

        let fork_provider = post_turn_jobs::ForkProviderSpec {
            model: self.runtime.model.clone(),
            account_id: self.runtime.account_id.clone(),
            reliability: self.runtime.resolved.reliability.clone(),
            native_harness_type: self.runtime.native_harness_type,
            workspace: self.runtime.workspace_state.read().clone(),
        };

        // 9b. Session memory extraction (fire-and-forget, 60s timeout).
        if should_run_post_turn_work(self.sm_config.enabled, final_turn_state) {
            post_turn_jobs::spawn_session_memory_extraction(
                post_turn_jobs::SessionMemoryExtractionInput {
                    session_id,
                    messages,
                    prompt_tokens: result.prompt_tokens,
                    tool_calls_count,
                    sm_state: self.sm_state.clone(),
                    sm_config: self.sm_config.clone(),
                    fork_provider: fork_provider.clone(),
                },
            )
            .await;
        }

        // 9c. Extract memories — forked extractor agent (fire-and-forget).
        // Subagents bypass this branch structurally (they don't go through
        // UnifiedMessageProcessor), so no explicit agent_id check is needed.
        if should_run_post_turn_work(
            self.runtime.resolved.learnings.extract_memories_enabled,
            final_turn_state,
        ) && !result.is_stream_error
        {
            if let Some(ws_path) = self.workspace_root() {
                post_turn_jobs::spawn_extract_memories(post_turn_jobs::ExtractMemoriesInput {
                    session_id,
                    ws_path,
                    messages,
                    final_text: result.content.as_deref(),
                    em_state: self.session.em_state.clone(),
                    fork_provider: fork_provider.clone(),
                    tool_registry: self.runtime.tool_registry.clone(),
                })
                .await;
            }
        }

        // 9d. Auto-dream — periodic memory consolidation (fire-and-forget).
        if should_run_post_turn_work(
            self.runtime.resolved.learnings.auto_dream_enabled,
            final_turn_state,
        ) {
            if let Some(ws_path) = self.workspace_root() {
                post_turn_jobs::spawn_auto_dream(post_turn_jobs::AutoDreamInput {
                    session_id,
                    ws_path,
                    messages: messages.to_vec(),
                    ad_state: self.session.ad_state.clone(),
                    fork_provider: fork_provider.clone(),
                    tool_registry: self.runtime.tool_registry.clone(),
                })
                .await;
            }
        }

        // 9d½. Work Item receipt fallback — when a linked-item turn ends
        // with no `work.note` from this agent, synthesize the Discussion
        // receipt from the final output (fire-and-forget; gating on the
        // session record happens inside the spawned task).
        if final_turn_state == DialogTurnState::Completed && !result.is_stream_error {
            self.spawn_work_item_receipt_fallback(session_id, response_text, turn_started_at_ms);
        }

        // 9e. Goal continuation loop (Ralph loop) — judge the completed
        // turn against the standing goal and enqueue a continuation when
        // the presence policy enables it (Invisible / custom autonomous
        // modes). Fire-and-forget; skipped for cancelled turns (the user
        // explicitly stopped — auto-continuing would fight the Stop).
        if final_turn_state != DialogTurnState::Cancelled && !result.is_stream_error {
            crate::session::goal_loop::spawn_turn_end_evaluation(
                crate::session::goal_loop::GoalLoopTurnEnd {
                    session_id: session_id.to_string(),
                    response_text: response_text.to_string(),
                    model: self.runtime.model.clone(),
                    account_id: self.runtime.account_id.clone(),
                    reliability: self.runtime.resolved.reliability.clone(),
                    native_harness_type: self.runtime.native_harness_type,
                    workspace: self.runtime.workspace_state.read().clone(),
                    app_handle: self.app_handle.clone(),
                },
            );
        }
    }
}
