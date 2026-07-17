//! Manual-compact orchestration.
//!
//! Ports `hermes-agent/gateway/run.py:_handle_compress_command`
//! (lines 6226-6321) to Orgii. Runs a real LLM-based context compaction
//! for a channel-attached session on user demand, then forks into a
//! fresh versioned session id (same semantics as idle reset), exactly
//! like what
//! the auto-compact path in `processor.rs:908-971` does when the
//! context-window trip-wire fires.
//!
//! Call flow:
//! 1. Look up the bound agent session by `session_id` (must exist in
//!    the in-memory pool — manual compact requires a live runtime so
//!    we have a provider + compaction config to work with).
//! 2. Load the persisted transcript via
//!    `persistence::load_llm_history(session_id)`.
//! 3. Bail early if the transcript is too short to meaningfully compress
//!    (< 4 messages, matching Hermes).
//! 4. Run `ContextCompactor::compact(...)` with the session's own
//!    runtime provider + model + compaction config + compaction state.
//! 5. Run `post_compact_cleanup` on the output (same cleanup the
//!    processor applies after auto-compact).
//! 6. Call `compact_fork::attempt_fork(compacted, old_sid)` to mint the
//!    new session, persist the compacted transcript there, archive the
//!    old, rebind the chat, queue the user-facing notice.
//! 7. Return a `ManualCompactSummary` so the slash handler can reply
//!    with the Hermes-style headline: message count before/after +
//!    token estimate before/after.
//!
//! # Divergences from Hermes
//!
//! - Hermes's `_handle_compress_command` spins up a throwaway
//!   `AIAgent` to run the compactor (because their compactor is an
//!   instance method); we reuse the existing session's runtime because
//!   `ContextCompactor::compact` is a free function. Net effect is the
//!   same — same provider, same model, same `protect_first_n` budget.
//! - Hermes accepts an optional `focus_topic` argument to guide the
//!   summariser. We do NOT accept one in MVP — Orgii's compactor has no
//!   matching hook yet. The slash parser drops any argument. Tracked
//!   as future work; see the MVP decision in the design doc.
//! - Hermes returns token estimates via
//!   `estimate_messages_tokens_rough`; we use
//!   `ContextCompactor::estimate_messages_tokens` (tokenizer-backed)
//!   because it's already a public helper and gives better numbers
//!   for the user reply line.

use tracing::{info, warn};

use crate::core::model_context::cleanup::post_compact_cleanup;
use crate::core::model_context::compaction::{CompactionOutcome, ContextCompactor};
use crate::integrations::gateway::ResetPolicy;
use crate::state::AgentAppState;

use super::super::persistence as unified_persistence;
use super::fork::{attempt_fork, ForkInputs, ForkOutcome};

/// Minimum transcript length for manual compact (mirrors Hermes
/// `_handle_compress_command` "need at least 4 messages" guard).
pub const MIN_HISTORY_FOR_MANUAL_COMPACT: usize = 4;

/// Outcome of `run_manual_compact`. Maps one-to-one to the three
/// message shapes the slash handler writes back to the user.
#[derive(Debug)]
pub enum ManualCompactResult {
    /// Compaction + fork both succeeded. Summary carries the numbers
    /// we need for the user-visible reply line.
    Forked(ManualCompactSummary),
    /// Transcript is above [`MIN_HISTORY_FOR_MANUAL_COMPACT`] but the
    /// compactor returned `CompactionOutcome::Skipped` — history still
    /// fits comfortably within the budget, so no summarization ran.
    /// We do NOT fork in this case: forking an unchanged transcript
    /// would waste a session id and confuse the user with
    /// "Compressed: 17 → 17 messages" in the reply.
    AlreadyCompact { message_count: usize, tokens: usize },
    /// The bound session is not channel-attached (e.g. an app-side
    /// session with no `gateway_bindings` row). Hermes has no
    /// equivalent — in Hermes every chat has a binding by definition.
    /// We surface it as a distinct variant so the slash handler can
    /// reply with a clear "this command only works in chat" message.
    NotChannelAttached,
    /// Transcript is shorter than
    /// [`MIN_HISTORY_FOR_MANUAL_COMPACT`] — nothing to compact yet.
    TooShort { message_count: usize },
    /// No live session runtime for `session_id`. Either the binding
    /// points at a session that hasn't booted yet, or the caller
    /// passed a stale id. The slash handler should advise the user
    /// to send a real message first so the runtime spins up.
    NoRuntime,
    /// Any downstream failure — compaction itself failed, fork failed,
    /// etc. `reason` is surfaced verbatim in the user-facing reply
    /// AND in logs, so keep it short + actionable.
    Failed(String),
}

/// Numbers the slash handler shows to the user on success. Fields are
/// public because the handler composes the reply string itself.
#[derive(Debug, Clone)]
pub struct ManualCompactSummary {
    pub old_session_id: String,
    pub new_session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
}

/// Run a manual compact for `session_id`.
///
/// `reset_policy` controls whether the user-facing notice is queued on
/// the pending-reset bus — the same setting as idle reset.
pub async fn run_manual_compact(
    state: &AgentAppState,
    session_id: &str,
    reset_policy: &ResetPolicy,
) -> ManualCompactResult {
    // 1. Look up live session. If there's no runtime we can't compact.
    let session = match state.get_session(session_id).await {
        Some(s) => s,
        None => {
            warn!(
                "[manual_compact] no live session {} — user must send a message first",
                session_id
            );
            return ManualCompactResult::NoRuntime;
        }
    };
    let runtime = {
        let guard = session.runtime.read().await;
        match guard.clone() {
            Some(r) => r,
            None => {
                warn!(
                    "[manual_compact] session {} has no runtime yet — user must send a message first",
                    session_id
                );
                return ManualCompactResult::NoRuntime;
            }
        }
    };

    // 2. Load the persisted transcript in LLM wire format.
    let sid_for_load = session_id.to_string();
    let history: Vec<serde_json::Value> = match tokio::task::spawn_blocking(move || {
        unified_persistence::load_llm_history(&sid_for_load)
    })
    .await
    {
        Ok(Ok(history)) => history,
        Ok(Err(err)) => {
            let reason = format!("load_llm_history failed: {}", err);
            warn!("[manual_compact] {}", reason);
            return ManualCompactResult::Failed(reason);
        }
        Err(err) => {
            let reason = format!("load_llm_history join error: {}", err);
            warn!("[manual_compact] {}", reason);
            return ManualCompactResult::Failed(reason);
        }
    };

    let messages_before = history.len();
    if messages_before < MIN_HISTORY_FOR_MANUAL_COMPACT {
        return ManualCompactResult::TooShort {
            message_count: messages_before,
        };
    }

    let tokens_before = ContextCompactor::estimate_messages_tokens(&history);

    // 3. Run real LLM compaction. We reuse the session's own
    //    compaction state so the cumulative failure counter is
    //    honoured (and so back-to-back manual compacts don't thrash
    //    the provider).
    let context_window = crate::providers::model_capabilities::resolve_effective_context_window(
        &runtime.model,
        runtime.account_id.as_deref(),
        runtime
            .resolved
            .context_window_configured
            .then_some(runtime.resolved.context_window),
    );
    // PreCompaction hook — awaited so backup hooks run against the
    // pre-compaction transcript. Trigger "manual" mirrors the reference
    // harness's manual-/compact distinction.
    let hook_executor = std::sync::Arc::new(
        crate::specialization::hooks::HookExecutor::load_with_workspace_scope(
            runtime.workspace_state.read().working_dir(),
            runtime.resolved.load_workspace_resources,
        ),
    );
    crate::specialization::hooks::dispatch::fire_pre_compaction(
        Some(&hook_executor),
        session_id,
        "manual",
        messages_before,
    )
    .await;

    let (compacted, outcome) = {
        let mut compaction_state = session.compaction.lock().await;
        ContextCompactor::compact(
            &history,
            context_window,
            &runtime.resolved.compaction,
            &mut compaction_state,
            runtime.provider.as_ref(),
            &runtime.model,
        )
        .await
    };

    // Summarization failed → the history is unchanged; forking it would
    // waste a session id without freeing any context. Surface the error.
    if let CompactionOutcome::Failed { reason } = outcome {
        warn!(
            "[manual_compact] {}: compaction failed — {}",
            session_id, reason
        );
        return ManualCompactResult::Failed(format!("compaction failed: {}", reason));
    }

    // History still fits the model budget. Nothing meaningful to fork:
    // the transcript is unchanged, so we short-circuit with a dedicated
    // result instead of producing a misleading "17 → 17 messages" reply
    // (dogfood bug: users thought compact silently failed).
    if matches!(outcome, CompactionOutcome::Skipped) {
        return ManualCompactResult::AlreadyCompact {
            message_count: messages_before,
            tokens: tokens_before,
        };
    }

    // 4. Post-compact cleanup (drop orphan tool_calls, etc.). Same
    //    helper the auto-compact path calls at processor.rs:885.
    let compacted = post_compact_cleanup(compacted);

    let messages_after = compacted.len();
    let tokens_after = ContextCompactor::estimate_messages_tokens(&compacted);

    crate::specialization::hooks::dispatch::fire_post_compaction(
        Some(&hook_executor),
        session_id,
        "manual",
        messages_before,
        messages_after,
    );

    // 5. Fork: persist to new session id + rebind + archive old.
    let fork_outcome = attempt_fork(ForkInputs {
        state,
        compacted_messages: &compacted,
        old_session_id: session_id,
        reset_policy,
    })
    .await;

    match fork_outcome {
        ForkOutcome::Forked { new_session_id } => {
            info!(
                "[manual_compact] {} → {}: {} msgs ({} tokens) → {} msgs ({} tokens)",
                session_id,
                new_session_id,
                messages_before,
                tokens_before,
                messages_after,
                tokens_after,
            );
            ManualCompactResult::Forked(ManualCompactSummary {
                old_session_id: session_id.to_string(),
                new_session_id,
                messages_before,
                messages_after,
                tokens_before,
                tokens_after,
            })
        }
        ForkOutcome::NotChannelAttached => ManualCompactResult::NotChannelAttached,
        ForkOutcome::Failed(reason) => ManualCompactResult::Failed(reason),
    }
}
