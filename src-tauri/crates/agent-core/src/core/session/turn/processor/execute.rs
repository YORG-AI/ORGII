//! LLM turn execution with reactive ContextTooLong recovery.
//!
//! Wraps `turn_executor::execute_turn` with:
//!
//! - Per-mode policy overlay (Plan/Ask deny writes; Explore/Debug/Review
//!   narrow allow-lists). The base policy comes from `runtime.policy`.
//! - Tool-registry context propagation (session key, permission
//!   provider, channel/chat_id, IDE repo, parent messages snapshot for
//!   AgentTool subagent forks).
//! - Reactive ContextTooLong handling: up to 2 retries that re-run
//!   [`ContextCompactor::compact`] then retry the turn.
//!
//! All inputs are read off `&self` (no per-call config struct) since
//! every field is a session-level value already held by
//! `UnifiedMessageProcessor`.

use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use super::UnifiedMessageProcessor;
use crate::model_context::compaction::CompactionOutcome;
use crate::turn_executor::{self, PermissionProvider, TurnConfig, TurnIterationHook, TurnResult};

use super::super::event_handler::UnifiedEventHandler;
use super::super::streaming::broadcast_agent_warning;

impl UnifiedMessageProcessor {
    /// Executes one LLM turn, transparently re-compacting up to twice if
    /// the provider returns `ContextTooLong`.
    ///
    /// Returns the final `TurnResult` plus the [`UnifiedEventHandler`]
    /// that observed the turn — the caller reads `tool_call_count()`,
    /// `todo_was_called()`, and `flush_streaming()` off the handler.
    pub(super) async fn execute_turn_with_reactive_retry(
        &self,
        session_id: &str,
        turn_id: &str,
        messages: &mut Vec<Value>,
        reasoning_trigger: Option<crate::providers::thinking_mode::ReasoningLevel>,
    ) -> Result<(TurnResult, UnifiedEventHandler), String> {
        let effective_policy = self.effective_tool_policy();

        self.runtime
            .provider
            .begin_logical_turn(session_id, turn_id);

        // Reasoning trigger words ("think hard", "ultrathink") escalate the
        // model's reasoning level FOR THIS TURN ONLY by re-encoding the
        // variant suffix; an explicit user-selected level is never lowered.
        let turn_model = match reasoning_trigger {
            Some(level) => {
                let escalated = crate::providers::thinking_mode::escalate_model_reasoning(
                    &self.runtime.model,
                    level,
                );
                if escalated != self.runtime.model {
                    tracing::info!(
                        "[unified_processor] Reasoning trigger escalated model {} -> {} (session={})",
                        self.runtime.model,
                        escalated,
                        session_id
                    );
                }
                escalated
            }
            None => self.runtime.model.clone(),
        };

        let turn_config = TurnConfig {
            model: turn_model,
            account_id: self.runtime.account_id.clone(),
            context_window_override: self
                .runtime
                .resolved
                .context_window_configured
                .then_some(self.runtime.resolved.context_window),
            max_iterations: self.effective_max_iterations(),
            max_tokens: self.runtime.resolved.max_tokens as u32,
            temperature: self.runtime.resolved.temperature as f32,
            max_tool_use_concurrency: self.runtime.resolved.max_tool_use_concurrency as usize,
            screenshot_store: Some(Arc::clone(&self.screenshot_store)),
            iteration_hook: self
                .turn_prefetch_hook
                .lock()
                .await
                .as_ref()
                .map(|hook| Arc::clone(hook) as Arc<dyn TurnIterationHook>),
            persist_cancel_marker: self
                .session
                .persist_next_cancel_marker
                .load(std::sync::atomic::Ordering::SeqCst),
            steering_queue: Some(Arc::clone(&self.session.steering_queue)),
            auto_continue: self.runtime.resolved.auto_continue,
        };

        let mut event_handler_config = self.event_handler_config.clone();
        event_handler_config.turn_id = Some(turn_id.to_string());
        let handler = UnifiedEventHandler::new(event_handler_config);

        // Set per-turn context for streaming/cancellable tools.
        self.runtime.tool_registry.set_session_key(session_id).await;
        self.runtime
            .tool_registry
            .set_cancel_flag(Arc::clone(&self.session.cancel_flag))
            .await;

        // Propagate permission provider to tools (ExecTool uses it for command-level confirmation)
        self.runtime
            .tool_registry
            .set_permission_provider(
                Arc::clone(&self.session.permission_manager) as Arc<dyn PermissionProvider>
            )
            .await;

        // Set tool contexts for OS sessions (channel, chat_id; sender_id is only available
        // in Gateway sessions where it is propagated by GatewayInboundHandler).
        if let (Some(ref channel), Some(ref chat_id)) = (&self.channel, &self.chat_id) {
            self.runtime
                .tool_registry
                .set_all_contexts(channel, chat_id, "")
                .await;
        }

        // Set active repo from IDE context (repo_path is set by OS sessions)
        if let Some(ref ide_ctx) = self.ide_context {
            if let Some(ref repo_path) = ide_ctx.repo_path {
                self.runtime.tool_registry.set_active_repo(repo_path).await;
                info!("[unified_processor] Active IDE repo set: {}", repo_path);
            }
        }

        // Snapshot parent messages for fork-path subagents (AgentTool)
        self.runtime
            .tool_registry
            .set_parent_messages(messages)
            .await;

        // Build permission provider reference
        let perm_provider: Option<&dyn PermissionProvider> =
            Some(&*self.session.permission_manager as &dyn PermissionProvider);

        let cache_probe_system_blocks =
            crate::session::prompt::cache::rendered_system_blocks_from_messages(messages);
        let cache_probe_tools = self
            .runtime
            .tool_registry
            .get_definitions_budgeted(effective_policy.as_ref());
        let result: TurnResult = match turn_executor::execute_turn(
            messages,
            self.runtime.provider.as_ref(),
            self.runtime.tool_registry.as_ref(),
            effective_policy.as_ref(),
            &turn_config,
            session_id,
            &handler,
            perm_provider,
            Some(&self.session.cancel_flag),
            self.runtime.policy_context_activator.as_deref(),
        )
        .await
        {
            Ok(turn_result) => turn_result,
            Err(err)
                if err.contains("ContextTooLong") && self.runtime.resolved.compaction.enabled =>
            {
                self.execute_with_reactive_compact(
                    session_id,
                    messages,
                    err,
                    &turn_config,
                    effective_policy.as_ref(),
                    &handler,
                    perm_provider,
                )
                .await?
            }
            Err(err) => return Err(err),
        };

        let cache_sample = self.session.prompt_cache_break_tracker.lock().await.record(
            &cache_probe_system_blocks,
            Some(&cache_probe_tools),
            &self.runtime.model,
            result.prompt_tokens,
            result.cache_read_tokens,
            result.cache_write_tokens,
        );
        if cache_sample.broke_cache {
            // A break with byte-identical system/tools/model means the miss
            // came from elsewhere (TTL expiry, history edit, server-side) —
            // exactly the regression class that must not stay invisible.
            warn!(
                "[unified_processor] Prompt cache break: unchanged system/tools/model prefix missed the cache (session={}, prompt_tokens={}, cache_read=0, cache_write={})",
                session_id, cache_sample.prompt_tokens, cache_sample.cache_write_tokens
            );
        }

        // Record the provider-reported context fill so the next pre-turn
        // compaction check can correct the local token estimate (which
        // systematically undercounts — images, tokenizer mismatch).
        if result.context_tokens > 0 {
            self.session
                .last_context_tokens
                .store(result.context_tokens, std::sync::atomic::Ordering::SeqCst);
        }

        Ok((result, handler))
    }

    /// Reactive ContextTooLong recovery: up to 2 retries each preceded
    /// by a fresh `ContextCompactor::compact`. Used only when the
    /// initial `execute_turn` returned `ContextTooLong` and compaction
    /// is enabled.
    #[allow(clippy::too_many_arguments)]
    async fn execute_with_reactive_compact(
        &self,
        session_id: &str,
        messages: &mut Vec<Value>,
        first_err: String,
        turn_config: &TurnConfig,
        effective_policy: &crate::tools::policy::ResolvedToolPolicy,
        handler: &UnifiedEventHandler,
        perm_provider: Option<&dyn PermissionProvider>,
    ) -> Result<TurnResult, String> {
        const MAX_REACTIVE_RETRIES: usize = 2;
        let mut last_err = first_err;
        let mut reactive_result: Option<TurnResult> = None;

        for attempt in 1..=MAX_REACTIVE_RETRIES {
            warn!(
                "[unified_processor] ContextTooLong hit for session {} — reactive compact attempt {}/{}",
                session_id, attempt, MAX_REACTIVE_RETRIES,
            );
            // Full rebuild pipeline (prefix protection + SM-compact first +
            // file re-injection), mirroring the pre-turn path. The error
            // string carries the provider-reported actual token count, used
            // to calibrate the estimate-denominated budget.
            let reactive_outcome = self
                .run_reactive_compaction(session_id, messages, Some(&last_err))
                .await;
            self.session
                .invalidate_prompt_cache(
                    crate::session::prompt::cache::PromptCacheInvalidationReason::Compaction,
                )
                .await;

            if let CompactionOutcome::Failed { ref reason } = reactive_outcome {
                // Reaching Failed here means the normal compactor AND the
                // manual-force rescue both failed (see
                // reactive_llm_compact_with_rescue) — typically a provider
                // outage. The history is unchanged, so a retry would fail
                // identically; surface the error instead of spinning.
                warn!(
                    "[unified_processor] Reactive compaction (incl. rescue) FAILED for session {} (attempt {}) — surfacing ContextTooLong: {}",
                    session_id, attempt, reason
                );
                broadcast_agent_warning(
                    session_id,
                    &format!(
                        "Context compaction failed ({}); the conversation exceeds the model's context window",
                        reason
                    ),
                    "compaction",
                );
                return Err(last_err);
            } else if reactive_outcome == CompactionOutcome::Skipped {
                // The provider just rejected the prompt as too long, yet the
                // compactor's estimate judged the history within budget — the
                // retry is doomed to fail identically. Surface it instead of
                // spinning silently.
                warn!(
                    "[unified_processor] Reactive compaction SKIPPED for session {} despite ContextTooLong (attempt {}) — estimator undercount",
                    session_id, attempt
                );
                broadcast_agent_warning(
                    session_id,
                    &format!(
                        "Reactive compaction skipped (estimate under budget despite provider rejection, attempt {})",
                        attempt
                    ),
                    "compaction",
                );
            }

            info!(
                "[unified_processor] Reactive compaction done, retrying turn (session={}, messages={}, attempt={})",
                session_id,
                messages.len(),
                attempt,
            );

            match turn_executor::execute_turn(
                messages,
                self.runtime.provider.as_ref(),
                self.runtime.tool_registry.as_ref(),
                effective_policy,
                turn_config,
                session_id,
                handler,
                perm_provider,
                Some(&self.session.cancel_flag),
                self.runtime.policy_context_activator.as_deref(),
            )
            .await
            {
                Ok(turn_result) => {
                    reactive_result = Some(turn_result);
                    break;
                }
                Err(retry_err)
                    if retry_err.contains("ContextTooLong") && attempt < MAX_REACTIVE_RETRIES =>
                {
                    last_err = retry_err;
                    continue;
                }
                Err(retry_err) => return Err(retry_err),
            }
        }

        reactive_result.ok_or(last_err)
    }
}

#[cfg(test)]
mod tests {
    use crate::core::session::turn::turn_max_iterations_from_session_model;

    #[test]
    fn turn_max_iterations_uses_resolved_session_model_value() {
        assert_eq!(turn_max_iterations_from_session_model(5), Some(5));
        assert_eq!(turn_max_iterations_from_session_model(30), Some(30));
        assert_eq!(turn_max_iterations_from_session_model(500), Some(500));
    }

    // Tests for effective_max_iterations() — the min(session_cap, mode_cap) logic.
    // We exercise the logic directly since we cannot construct UnifiedMessageProcessor
    // in unit tests without a full runtime. The mode cap values are:
    //   Plan / Ask / Review => 30
    //   Build / Debug / Wingman / None => no mode cap
    #[test]
    fn effective_max_iterations_plan_caps_at_30() {
        use crate::session::AgentExecMode;
        // session model has 500; Plan mode cap is 30 → effective is 30
        let session_cap = turn_max_iterations_from_session_model(500);
        let mode_cap: Option<u32> = match Some(AgentExecMode::Plan) {
            Some(AgentExecMode::Plan) => Some(30),
            Some(AgentExecMode::Ask) => Some(30),
            Some(AgentExecMode::Review) => Some(30),
            _ => None,
        };
        let effective = match (session_cap, mode_cap) {
            (Some(sc), Some(mc)) => Some(sc.min(mc)),
            (sc, mc) => sc.or(mc),
        };
        assert_eq!(effective, Some(30));
    }

    #[test]
    fn effective_max_iterations_session_model_wins_if_lower() {
        use crate::session::AgentExecMode;
        // session model has 10; Ask mode cap is 30 → effective is 10
        let session_cap = turn_max_iterations_from_session_model(10);
        let mode_cap: Option<u32> = match Some(AgentExecMode::Ask) {
            Some(AgentExecMode::Plan) => Some(30),
            Some(AgentExecMode::Ask) => Some(30),
            Some(AgentExecMode::Review) => Some(30),
            _ => None,
        };
        let effective = match (session_cap, mode_cap) {
            (Some(sc), Some(mc)) => Some(sc.min(mc)),
            (sc, mc) => sc.or(mc),
        };
        assert_eq!(effective, Some(10));
    }

    #[test]
    fn effective_max_iterations_build_mode_has_no_mode_cap() {
        use crate::session::AgentExecMode;
        // Build mode has no mode cap; session model cap governs alone
        let session_cap = turn_max_iterations_from_session_model(500);
        let mode_cap: Option<u32> = match Some(AgentExecMode::Build) {
            Some(AgentExecMode::Plan) => Some(30),
            Some(AgentExecMode::Ask) => Some(30),
            Some(AgentExecMode::Review) => Some(30),
            _ => None,
        };
        let effective = match (session_cap, mode_cap) {
            (Some(sc), Some(mc)) => Some(sc.min(mc)),
            (sc, mc) => sc.or(mc),
        };
        assert_eq!(effective, Some(500));
    }
}
