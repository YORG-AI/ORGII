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
        let context_window = if self.runtime.resolved.context_window > 0 {
            self.runtime.resolved.context_window as usize
        } else {
            crate::providers::model_hints::context_window_hint(&self.runtime.model)
        };
        let prefix_len = leading_runtime_system_prefix_len(messages);
        let prefix = messages[..prefix_len].to_vec();
        let mut compactable_tail = messages[prefix_len..].to_vec();

        if !(self.runtime.resolved.compaction.enabled
            && ContextCompactor::needs_compaction(
                &compactable_tail,
                context_window,
                &self.runtime.resolved.compaction,
            ))
        {
            return CompactionPhaseOutcome::Continue;
        }

        info!(
            "[unified_processor] Compacting context for session {} (prefix={}, tail={}, window={})",
            session_id,
            prefix_len,
            compactable_tail.len(),
            context_window
        );

        let pre_compact_messages = messages.clone();

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

            if ContextCompactor::needs_compaction(
                &cleaned_tail,
                context_window,
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
            let mut state = self.compaction_state.lock().await;
            let (compacted, outcome) = ContextCompactor::compact(
                &compactable_tail,
                context_window,
                &self.runtime.resolved.compaction,
                &mut state,
                self.runtime.provider.as_ref(),
                &self.runtime.model,
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
        let (summary_text, tail_len) = split_summary_and_tail(&durable_compacted_messages);
        let persist_result = tokio::task::spawn_blocking({
            let sid = session_id.to_string();
            move || -> Result<(), String> {
                let cutoff = unified_persistence::compact_cutoff_sequence(&sid, tail_len)
                    .map_err(|err| err.to_string())?;
                unified_persistence::append_compact_boundary(&sid, &summary_text, cutoff)
                    .map_err(|err| err.to_string())?;
                Ok(())
            }
        })
        .await;
        match persist_result {
            Ok(Ok(())) => {
                if let Err(err) = unified_persistence::clear_session_memory_state(session_id) {
                    warn!(
                        "[unified_processor] Failed to clear persisted SM state after compact for session {}: {}",
                        session_id, err
                    );
                }
                let mut sm_state = self.sm_state.lock().await;
                sm_state.content = None;
                sm_state.last_summarized_msg_idx = None;
                sm_state.initialized = false;
                sm_state.tokens_at_last_extraction = 0;
                sm_state.tool_calls_since_extraction = 0;
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

/// Split the compacted in-memory view into the boundary summary text and
/// the number of preserved tail messages. The compactors emit
/// `[system summary] + tail`; if the leading summary is missing (e.g.
/// truncation fallback dropped messages without summarizing), a generic
/// marker is used and every message counts as tail.
fn split_summary_and_tail(durable_compacted_messages: &[Value]) -> (String, usize) {
    match durable_compacted_messages.first() {
        Some(first) if message_role(first) == Some("system") => {
            let text = match first.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            (text, durable_compacted_messages.len().saturating_sub(1))
        }
        _ => (
            "[Conversation summary — earlier messages compacted without summary]".to_string(),
            durable_compacted_messages.len(),
        ),
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
