//! Pre-turn message-list compaction.
//!
//! Three layers, applied in order to the in-memory `messages` vec:
//!
//! 1. **Microcompact** — time-based clear of old large tool results once
//!    the prompt cache has expired. Often drops enough tokens to skip
//!    the expensive LLM compaction below entirely.
//! 2. **Aggregate budget** — hard cap (200K chars) of tool results per
//!    assistant message group. Uses sticky [`ReplacementState`] for
//!    cache stability across turns.
//! 3. **Context compaction** — only when the message list still exceeds
//!    the model's context window. Tries SM-compact first (zero API
//!    calls, requires session-memory state); falls back to LLM-driven
//!    [`ContextCompactor::compact`] otherwise. After compaction we run
//!    `post_compact_cleanup` and `reinject_files_after_compaction`, and
//!    for channel-attached sessions attempt a compact-fork that
//!    redirects the caller to a fresh session id.
//!
//! Returns `CompactionPhaseOutcome::ForkRedirect` when the compact-fork
//! short-circuits the turn; the caller (`process()`) then returns that
//! redirect to the dispatcher without executing the LLM turn at all.

use serde_json::Value;
use tracing::{info, warn};

use super::super::streaming::broadcast_agent_warning;
use super::UnifiedMessageProcessor;
use crate::core::session::prompt::cache::ORGII_SYSTEM_CACHE_SCOPE_KEY;
use crate::core::session::types::ProcessingResult;
use crate::model_context::compaction::{CompactionOutcome, ContextCompactor};
use crate::model_context::microcompact::ReplacementState;
use crate::model_context::session_memory;
use crate::model_context::session_memory::SessionMemoryState;
use crate::session::persistence as unified_persistence;

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn has_runtime_system_scope(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| part.get(ORGII_SYSTEM_CACHE_SCOPE_KEY).is_some())
}

fn leading_runtime_system_prefix_len(messages: &[Value]) -> usize {
    messages
        .iter()
        .take_while(|message| {
            message_role(message) == Some("system") && has_runtime_system_scope(message)
        })
        .count()
}

fn append_compacted_tail(prefix: &[Value], tail: Vec<Value>) -> Vec<Value> {
    let mut rebuilt = Vec::with_capacity(prefix.len() + tail.len());
    rebuilt.extend_from_slice(prefix);
    rebuilt.extend(tail);
    rebuilt
}

fn adjust_sm_state_for_compactable_tail(
    state: &SessionMemoryState,
    prefix_len: usize,
) -> SessionMemoryState {
    let mut adjusted = state.clone();
    adjusted.last_summarized_msg_idx = state
        .last_summarized_msg_idx
        .and_then(|idx| idx.checked_sub(prefix_len));
    adjusted
}

/// Outcome of [`UnifiedMessageProcessor::run_pre_turn_compaction`].
pub(super) enum CompactionPhaseOutcome {
    /// Continue with the current `messages` list — execute the LLM turn.
    Continue,
    /// Compact-fork was triggered for a channel-attached session. The
    /// caller should return this `ProcessingResult` to the dispatcher
    /// which will re-dispatch the original message against the new
    /// session id.
    ForkRedirect(ProcessingResult),
}

impl UnifiedMessageProcessor {
    async fn compaction_side_query_route(
        &self,
        session_id: &str,
    ) -> Result<
        (
            std::sync::Arc<dyn crate::providers::traits::LLMProvider>,
            String,
        ),
        String,
    > {
        self.side_query_provider(session_id, "compaction").await
    }

    /// Reactive (mid-turn) compaction used by the ContextTooLong retry
    /// path. Mirrors the pre-turn pipeline — runtime system prefix is
    /// protected, SM-compact is tried first (zero API calls), the LLM
    /// compactor is the fallback, and file re-injection runs afterwards —
    /// instead of the old bare `ContextCompactor::compact` over the whole
    /// message list. No durable boundary is persisted here: mid-turn
    /// history can hold half-open tool exchanges, so the durable transcript
    /// is only compacted on the pre-turn path.
    pub(super) async fn run_reactive_compaction(
        &self,
        session_id: &str,
        messages: &mut Vec<Value>,
        provider_error: Option<&str>,
    ) -> CompactionOutcome {
        let context_window = crate::providers::model_capabilities::resolve_effective_context_window(
            &self.runtime.model,
            self.runtime.account_id.as_deref(),
            self.runtime
                .resolved
                .context_window_configured
                .then_some(self.runtime.resolved.context_window),
        );
        // Budget in ESTIMATED tokens: start from the effective budget (NOT
        // the raw window — passing the raw window made `compact` skip as a
        // silent no-op whenever the estimate was under 100% of the window,
        // even though the provider had just rejected the actual prompt),
        // then calibrate by the provider-reported actual token count from
        // the error, correcting the estimator's systematic undercount.
        let mut budget_tokens = self
            .runtime
            .resolved
            .compaction
            .effective_budget(context_window);
        if let Some(actual) =
            provider_error.and_then(ContextCompactor::parse_actual_tokens_from_error)
        {
            let estimated = ContextCompactor::estimate_messages_tokens(messages);
            let calibrated = ContextCompactor::calibrate_budget(budget_tokens, estimated, actual);
            if calibrated != budget_tokens {
                info!(
                    "[unified_processor] Reactive compaction budget calibrated {} -> {} (estimated={}, provider-actual={}, session={})",
                    budget_tokens, calibrated, estimated, actual, session_id
                );
                budget_tokens = calibrated;
            }
        }
        let prefix_len = leading_runtime_system_prefix_len(messages);
        let prefix = messages[..prefix_len].to_vec();
        let compactable_tail = messages[prefix_len..].to_vec();
        let pre_compact_messages = messages.clone();

        // PreCompaction hook — awaited so backup hooks finish before the
        // message list is rewritten below.
        crate::specialization::hooks::dispatch::fire_pre_compaction(
            self.event_handler_config.hook_executor.as_ref(),
            session_id,
            "auto",
            pre_compact_messages.len(),
        )
        .await;

        // SM-compact first (zero API calls).
        let sm_compacted = {
            let sm_state = self.sm_state.lock().await;
            if self.sm_config.enabled {
                let adjusted_sm_state = adjust_sm_state_for_compactable_tail(&sm_state, prefix_len);
                session_memory::try_sm_compact(
                    &compactable_tail,
                    &adjusted_sm_state,
                    &self.sm_compact_config,
                    context_window,
                )
            } else {
                None
            }
        };
        info!(
            "[unified_processor] Reactive compaction for session {} (prefix={}, tail={}, sm_hit={})",
            session_id,
            prefix_len,
            compactable_tail.len(),
            sm_compacted.is_some(),
        );

        let (compaction_provider, compaction_model) =
            match self.compaction_side_query_route(session_id).await {
                Ok(route) => route,
                Err(err) => {
                    warn!("[unified_processor] {err}");
                    return CompactionOutcome::Skipped;
                }
            };
        let outcome;
        if let Some(compacted) = sm_compacted {
            let cleaned_tail = crate::model_context::cleanup::post_compact_cleanup(compacted);
            if crate::model_context::compaction::ContextCompactor::needs_compaction_with_budget(
                &cleaned_tail,
                budget_tokens,
                &self.runtime.resolved.compaction,
            ) {
                // SM-compact not enough — fall through to LLM compaction on
                // the SM-compacted tail.
                let mut state = self.compaction_state.lock().await;
                let (compacted, llm_outcome) = ContextCompactor::compact(
                    &cleaned_tail,
                    budget_tokens,
                    &self.runtime.resolved.compaction,
                    &mut state,
                    compaction_provider.as_ref(),
                    &compaction_model,
                )
                .await;
                let cleaned = crate::model_context::cleanup::post_compact_cleanup(compacted);
                *messages = append_compacted_tail(&prefix, cleaned);
                outcome = llm_outcome;
            } else {
                let kept = cleaned_tail.len();
                *messages = append_compacted_tail(&prefix, cleaned_tail);
                outcome = CompactionOutcome::Compacted {
                    messages_dropped: pre_compact_messages
                        .len()
                        .saturating_sub(prefix_len)
                        .saturating_sub(kept),
                    messages_kept: kept,
                };
            }
            let mut sm_state = self.sm_state.lock().await;
            sm_state.last_summarized_msg_idx = None;
        } else {
            let mut state = self.compaction_state.lock().await;
            let (compacted, llm_outcome) = ContextCompactor::compact(
                &compactable_tail,
                budget_tokens,
                &self.runtime.resolved.compaction,
                &mut state,
                compaction_provider.as_ref(),
                &compaction_model,
            )
            .await;
            let cleaned = crate::model_context::cleanup::post_compact_cleanup(compacted);
            *messages = append_compacted_tail(&prefix, cleaned);
            outcome = llm_outcome;
            let mut sm_state = self.sm_state.lock().await;
            sm_state.last_summarized_msg_idx = None;
        }

        crate::model_context::file_reinjection::reinject_files_after_compaction(
            &pre_compact_messages,
            messages,
        );
        crate::model_context::plan_preservation::reinject_plan_after_compaction(
            &pre_compact_messages,
            messages,
        );

        // The provider-reported fill referred to the pre-compaction history;
        // clear it so the next pre-turn trigger doesn't act on a stale value.
        self.session
            .last_context_tokens
            .store(0, std::sync::atomic::Ordering::SeqCst);

        crate::specialization::hooks::dispatch::fire_post_compaction(
            self.event_handler_config.hook_executor.as_ref(),
            session_id,
            "auto",
            pre_compact_messages.len(),
            messages.len(),
        );

        outcome
    }

    /// Runs all three pre-turn compaction layers (microcompact →
    /// aggregate budget → context compaction). Mutates `messages` in
    /// place.
    pub(super) async fn run_pre_turn_compaction(
        &self,
        session_id: &str,
        messages: &mut Vec<Value>,
    ) -> CompactionPhaseOutcome {
        // 5. Pre-compaction microcompact — time-based clear of old large tool
        // results once the prompt cache has expired. Often drops enough tokens
        // to skip the expensive LLM compaction below entirely.
        {
            use crate::model_context::microcompact::{self, MicrocompactConfig};
            let mc_config = MicrocompactConfig::default();
            let stats = microcompact::microcompact_messages(messages, &mc_config);
            if stats.trimmed_count > 0 {
                info!(
                    "[unified_processor] Pre-compaction microcompact: cleared {} result(s), saved ~{} chars (session={})",
                    stats.trimmed_count, stats.chars_saved, session_id
                );
            }
        }

        // 5b. Aggregate budget — hard cap of 200K chars of tool results per
        // assistant message group. Uses sticky ReplacementState for cache stability.
        {
            use crate::model_context::microcompact;
            let mut rs: tokio::sync::MutexGuard<'_, ReplacementState> =
                self.replacement_state.lock().await;
            let budget_cleared = microcompact::enforce_aggregate_budget(messages, &mut rs);
            if budget_cleared > 0 {
                info!(
                    "[unified_processor] Aggregate budget: cleared {} result(s) (session={})",
                    budget_cleared, session_id
                );
            }
        }

        // 6. Context compaction
        let context_window = crate::providers::model_capabilities::resolve_effective_context_window(
            &self.runtime.model,
            self.runtime.account_id.as_deref(),
            self.runtime
                .resolved
                .context_window_configured
                .then_some(self.runtime.resolved.context_window),
        );
        let prefix_len = leading_runtime_system_prefix_len(messages);
        let prefix = messages[..prefix_len].to_vec();
        let mut compactable_tail = messages[prefix_len..].to_vec();

        // Provider-reported real context fill from the previous turn — the
        // trigger must not rely on the local estimate alone (it undercounts:
        // images = 0 tokens, tokenizer mismatch, sampling), or the session
        // sails past the window until the provider rejects it.
        let observed_tokens = self
            .session
            .last_context_tokens
            .load(std::sync::atomic::Ordering::SeqCst)
            .max(0) as usize;

        if !(self.runtime.resolved.compaction.enabled
            && ContextCompactor::needs_compaction_observed(
                &compactable_tail,
                context_window,
                &self.runtime.resolved.compaction,
                observed_tokens,
            ))
        {
            return CompactionPhaseOutcome::Continue;
        }

        // Budget in ESTIMATED tokens for the compactors below: effective
        // budget (NOT the raw window, which made `compact` skip as a silent
        // no-op in the estimated 80%-100% band), calibrated down by the
        // observed undercount so that hitting the calibrated budget lands
        // the REAL prompt within the real one.
        let budget_tokens = {
            let base = self
                .runtime
                .resolved
                .compaction
                .effective_budget(context_window);
            let estimated = ContextCompactor::estimate_messages_tokens(&compactable_tail);
            ContextCompactor::calibrate_budget(base, estimated, observed_tokens)
        };

        info!(
            "[unified_processor] Compacting context for session {} (prefix={}, tail={}, window={})",
            session_id,
            prefix_len,
            compactable_tail.len(),
            context_window
        );

        let pre_compact_messages = messages.clone();

        // PreCompaction hook — awaited so backup hooks finish before the
        // message list is rewritten below.
        crate::specialization::hooks::dispatch::fire_pre_compaction(
            self.event_handler_config.hook_executor.as_ref(),
            session_id,
            "auto",
            pre_compact_messages.len(),
        )
        .await;

        // Try SM-compact first (zero API calls)
        let sm_compacted = {
            let sm_state = self.sm_state.lock().await;
            if self.sm_config.enabled {
                let adjusted_sm_state = adjust_sm_state_for_compactable_tail(&sm_state, prefix_len);
                session_memory::try_sm_compact(
                    &compactable_tail,
                    &adjusted_sm_state,
                    &self.sm_compact_config,
                    context_window,
                )
            } else {
                None
            }
        };

        let mut need_llm_compact = true;

        if let Some(compacted) = sm_compacted {
            let cleaned_tail = crate::model_context::cleanup::post_compact_cleanup(compacted);
            let rebuilt = append_compacted_tail(&prefix, cleaned_tail.clone());

            if ContextCompactor::needs_compaction_with_budget(
                &cleaned_tail,
                budget_tokens,
                &self.runtime.resolved.compaction,
            ) {
                warn!(
                    "[unified_processor] SM-compact still over budget for session {} ({} tail messages, ~{} tokens), falling back to LLM compaction",
                    session_id,
                    cleaned_tail.len(),
                    ContextCompactor::estimate_messages_tokens(&cleaned_tail),
                );
                *messages = rebuilt;
                compactable_tail = cleaned_tail;
            } else {
                info!(
                    "[unified_processor] SM-compact succeeded for session {} (tail {} → {}, prefix={})",
                    session_id,
                    messages.len().saturating_sub(prefix_len),
                    cleaned_tail.len(),
                    prefix_len
                );
                *messages = rebuilt;
                need_llm_compact = false;

                let mut sm_state = self.sm_state.lock().await;
                sm_state.last_summarized_msg_idx = None;
            }
        }

        if need_llm_compact {
            let (compaction_provider, compaction_model) =
                match self.compaction_side_query_route(session_id).await {
                    Ok(route) => route,
                    Err(err) => {
                        warn!("[unified_processor] {err}");
                        return CompactionPhaseOutcome::Continue;
                    }
                };
            let mut state = self.compaction_state.lock().await;
            let (compacted, outcome) = ContextCompactor::compact(
                &compactable_tail,
                budget_tokens,
                &self.runtime.resolved.compaction,
                &mut state,
                compaction_provider.as_ref(),
                &compaction_model,
            )
            .await;
            let cleaned_tail = crate::model_context::cleanup::post_compact_cleanup(compacted);
            *messages = append_compacted_tail(&prefix, cleaned_tail);

            if let CompactionOutcome::Truncated { messages_dropped } = outcome {
                broadcast_agent_warning(
                    session_id,
                    &format!(
                        "Context compaction fell back to truncation ({} conversation messages dropped without summary)",
                        messages_dropped
                    ),
                    "compaction",
                );
            }

            let mut sm_state = self.sm_state.lock().await;
            sm_state.last_summarized_msg_idx = None;
        }

        // Post-compact file re-injection
        crate::model_context::file_reinjection::reinject_files_after_compaction(
            &pre_compact_messages,
            messages,
        );
        // Approved-plan preservation: the plan must survive compaction
        // verbatim, or long Build sessions silently stop following it.
        crate::model_context::plan_preservation::reinject_plan_after_compaction(
            &pre_compact_messages,
            messages,
        );

        // The provider-reported fill referred to the pre-compaction history;
        // clear it so the next trigger doesn't act on a stale value.
        self.session
            .last_context_tokens
            .store(0, std::sync::atomic::Ordering::SeqCst);

        // Fired before the compact-fork branch: the compaction itself is
        // done regardless of whether the session id gets redirected below.
        crate::specialization::hooks::dispatch::fire_post_compaction(
            self.event_handler_config.hook_executor.as_ref(),
            session_id,
            "auto",
            pre_compact_messages.len(),
            messages.len(),
        );

        let durable_compacted_messages = messages[prefix_len.min(messages.len())..].to_vec();

        // 6b. Compact-fork — for channel-attached sessions only, persist the
        // compacted transcript as a new session id and return `fork_redirect`
        // so the caller re-dispatches the original message against it.
        // App-side sessions (no gateway binding) fall through to in-place execution.
        if let Some(handle) = self.app_handle.as_ref() {
            use tauri::Manager;
            let state = handle.state::<crate::state::AgentAppState>();
            let reset_policy = state
                .integrations
                .snapshot()
                .channels
                .gateway
                .reset_policy
                .clone();
            let outcome = super::super::super::compaction::fork::attempt_fork(
                super::super::super::compaction::fork::ForkInputs {
                    state: state.inner(),
                    compacted_messages: &durable_compacted_messages,
                    old_session_id: session_id,
                    reset_policy: &reset_policy,
                },
            )
            .await;
            match outcome {
                super::super::super::compaction::fork::ForkOutcome::Forked { new_session_id } => {
                    if let Err(err) = unified_persistence::clear_session_memory_state(session_id) {
                        warn!(
                            "[unified_processor] Failed to clear old SM state after compact-fork for session {}: {}",
                            session_id, err
                        );
                    }
                    info!(
                        "[unified_processor] Compact-fork: redirecting session {} → {}",
                        session_id, new_session_id
                    );
                    return CompactionPhaseOutcome::ForkRedirect(ProcessingResult {
                        turn_id: String::new(),
                        content: String::new(),
                        total_tokens: 0,
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        context_tokens: 0,
                        stable_prefix_tokens: 0,
                        volatile_context_tokens: 0,
                        imported_context_count: 0,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                        tool_calls_count: 0,
                        truncated: false,
                        turn_summary: None,
                        fork_redirect: Some(new_session_id),
                    });
                }
                super::super::super::compaction::fork::ForkOutcome::NotChannelAttached => {
                    // App-side session — fall through to in-place turn execution.
                }
                super::super::super::compaction::fork::ForkOutcome::Failed(reason) => {
                    warn!(
                        "[unified_processor] Compact-fork failed for session {} ({}) — \
                         continuing in-place",
                        session_id, reason
                    );
                }
            }
        }

        // Durable persistence: append a compact boundary row instead of
        // rewriting the transcript. The durable view is `[summary] +
        // rows >= cutoff`; prior rows are never touched, so sequence and
        // created_at coordinates stay valid for truncation/replay.
        let compacted_for_persist = durable_compacted_messages.clone();
        // Boundary display metadata: estimated context tokens either side of
        // the compaction, shown in the chat marker's subtitle.
        let boundary_token_delta = Some((
            ContextCompactor::estimate_messages_tokens(&pre_compact_messages),
            ContextCompactor::estimate_messages_tokens(messages),
        ));
        let persist_result = tokio::task::spawn_blocking({
            let sid = session_id.to_string();
            move || -> Result<(), String> {
                super::super::super::compaction::persist::append_in_place_compact_boundary(
                    &sid,
                    &compacted_for_persist,
                    boundary_token_delta,
                )
                .map(|_| ())
            }
        })
        .await;
        match persist_result {
            Ok(Ok(())) => {
                // Keep SM content (memory quality survives compaction; the next
                // SM-compact can still use it) but reset the message-index
                // pointer — indices refer to the pre-compact message list and
                // would be dangling against the rebuilt one.
                let mut sm_state = self.sm_state.lock().await;
                sm_state.last_summarized_msg_idx = None;
                let persist_outcome = match sm_state.content.as_deref() {
                    Some(content) if !content.trim().is_empty() => {
                        unified_persistence::save_session_memory_state(session_id, content, None)
                    }
                    _ => unified_persistence::clear_session_memory_state(session_id),
                };
                if let Err(err) = persist_outcome {
                    warn!(
                        "[unified_processor] Failed to persist SM state after compact for session {}: {}",
                        session_id, err
                    );
                }
                info!(
                    "[unified_processor] Appended compact boundary for session {} ({} durable messages visible)",
                    session_id,
                    durable_compacted_messages.len()
                );
            }
            Ok(Err(err)) => warn!(
                "[unified_processor] Failed to persist compact boundary for session {}: {}",
                session_id, err
            ),
            Err(err) => warn!(
                "[unified_processor] Failed to join compact boundary persistence for session {}: {}",
                session_id, err
            ),
        }

        CompactionPhaseOutcome::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn leading_runtime_system_prefix_counts_only_scoped_front_system_messages() {
        let messages = vec![
            json!({"role": "system", "content": [{"type": "text", "text": "stable", ORGII_SYSTEM_CACHE_SCOPE_KEY: "session"}]}),
            json!({"role": "system", "content": [{"type": "text", "text": "dynamic", ORGII_SYSTEM_CACHE_SCOPE_KEY: "volatile"}]}),
            json!({"role": "system", "content": "persisted compact summary"}),
            json!({"role": "user", "content": "hello"}),
        ];

        assert_eq!(leading_runtime_system_prefix_len(&messages), 2);
    }

    #[test]
    fn persisted_compact_summary_is_part_of_compactable_tail() {
        let messages = vec![
            json!({"role": "system", "content": "persisted compact summary"}),
            json!({"role": "user", "content": "recent"}),
        ];

        assert_eq!(leading_runtime_system_prefix_len(&messages), 0);
    }

    #[test]
    fn append_compacted_tail_preserves_system_prefix_order() {
        let prefix = vec![
            json!({"role": "system", "content": "stable"}),
            json!({"role": "system", "content": "dynamic"}),
        ];
        let tail = vec![
            json!({"role": "system", "content": "summary"}),
            json!({"role": "user", "content": "recent"}),
        ];

        let rebuilt = append_compacted_tail(&prefix, tail);

        assert_eq!(rebuilt.len(), 4);
        assert_eq!(rebuilt[0]["content"], "stable");
        assert_eq!(rebuilt[1]["content"], "dynamic");
        assert_eq!(rebuilt[2]["content"], "summary");
        assert_eq!(rebuilt[3]["content"], "recent");
    }

    #[test]
    fn sm_boundary_is_shifted_from_provider_messages_to_tail_messages() {
        let state = SessionMemoryState {
            content: Some("summary".to_string()),
            last_summarized_msg_idx: Some(7),
            ..SessionMemoryState::default()
        };

        let adjusted = adjust_sm_state_for_compactable_tail(&state, 2);

        assert_eq!(adjusted.last_summarized_msg_idx, Some(5));
        assert_eq!(adjusted.content.as_deref(), Some("summary"));
    }

    #[test]
    fn sm_boundary_before_system_prefix_is_not_reused_for_tail() {
        let state = SessionMemoryState {
            content: Some("summary".to_string()),
            last_summarized_msg_idx: Some(1),
            ..SessionMemoryState::default()
        };

        let adjusted = adjust_sm_state_for_compactable_tail(&state, 2);

        assert_eq!(adjusted.last_summarized_msg_idx, None);
    }
}
