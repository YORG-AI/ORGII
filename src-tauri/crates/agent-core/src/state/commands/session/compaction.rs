use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::core::model_context::cleanup::post_compact_cleanup;
use crate::core::model_context::compaction::{CompactionOutcome, ContextCompactor};
use crate::core::session::compaction::manual::MIN_HISTORY_FOR_MANUAL_COMPACT;
use crate::core::session::compaction::persist;
use crate::core::session::scheduler::{ScheduledKind, ScheduledMessage};
use crate::core::turn_executor::context_accounting::ContextUsageSnapshot;
use crate::model_context::session_memory;
use crate::session::persistence as unified_persistence;
use crate::state::{AgentAppState, AgentSession};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualCompactStatus {
    Compacted,
    TooShort,
    AlreadyCompact,
    Busy,
    NoRuntime,
    ChannelAttached,
    Failed,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCompactBoundary {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCompactCommandResult {
    pub status: ManualCompactStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_before: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_after: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<usize>,
    /// Set on `Compacted`: the persisted boundary row, so the frontend can
    /// append the chat marker in place instead of evicting + reloading the
    /// whole session (which flashes the history).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<ManualCompactBoundary>,
}

impl ManualCompactCommandResult {
    fn status(status: ManualCompactStatus) -> Self {
        Self {
            status,
            message: None,
            messages_before: None,
            messages_after: None,
            tokens_before: None,
            tokens_after: None,
            boundary: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            status: ManualCompactStatus::Failed,
            message: Some(message.into()),
            messages_before: None,
            messages_after: None,
            tokens_before: None,
            tokens_after: None,
            boundary: None,
        }
    }
}

/// Desktop-only manual compaction. Unlike gateway `/compact`, this rewrites the
/// visible durable transcript in-place by appending a compact boundary and does
/// not fork the session.
///
/// The pipeline runs on the session's dialog scheduler, so it is serialized
/// with turns by the same FIFO worker that executes them: a turn that starts
/// while the summarization call is in flight would append rows and shift the
/// boundary cutoff onto messages that were neither summarized nor kept
/// (silent context loss). The `is_processing`/`pending_count` check below is
/// only a fast-path courtesy reply — mutual exclusion comes from the worker,
/// not from the check.
#[tauri::command]
pub async fn agent_session_manual_compact(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    instructions: Option<String>,
) -> Result<ManualCompactCommandResult, String> {
    // Channel-attached sessions compact by forking (gateway `/compact`); an
    // in-place boundary would silently diverge the Hermes-side transcript
    // from what the channel participants see.
    if state
        .gateway_bindings
        .find_by_target(&session_id)
        .await
        .is_some()
    {
        return Ok(ManualCompactCommandResult::status(
            ManualCompactStatus::ChannelAttached,
        ));
    }

    // Lazy runtime init — an old session opened after an app restart is not
    // even registered in memory (and a registered one may have no runtime)
    // until its first message, but compaction only needs the provider +
    // resolved config. Initialize on demand exactly like `agent_send_message`
    // does (idempotent fast-path when already live) instead of bouncing the
    // user with "send a message first".
    let needs_init = match state.get_session(&session_id).await {
        Some(session) => session.get_runtime().await.is_none(),
        None => true,
    };
    if needs_init {
        let identity = match super::identity::resolve_session_identity(
            state.inner(),
            &session_id,
            super::identity::IdentityOverrides::default(),
        )
        .await
        {
            Ok(identity) => identity,
            Err(err) => {
                return Ok(ManualCompactCommandResult::failed(format!(
                    "session runtime init failed: {}",
                    err
                )));
            }
        };
        let launch_spec = match crate::init::launch_spec::AgentLaunchSpec::from_session_sources(
            state.inner(),
            &session_id,
            identity.workspace_root,
            identity.account_id,
            Some(identity.model),
            identity.native_harness_type,
        )
        .await
        {
            Ok(spec) => spec,
            Err(err) => {
                return Ok(ManualCompactCommandResult::failed(format!(
                    "session runtime init failed: {}",
                    err
                )));
            }
        };
        if let Err(err) = crate::init::init_session(state.inner(), launch_spec).await {
            return Ok(ManualCompactCommandResult::failed(format!(
                "session runtime init failed: {}",
                err
            )));
        }
    }

    let Some(session) = state.get_session(&session_id).await else {
        return Ok(ManualCompactCommandResult::status(
            ManualCompactStatus::NoRuntime,
        ));
    };

    // Always enqueue maintenance, even while a turn is running. The scheduler
    // serializes it behind the active turn; rejecting here as Busy made both
    // UI entry points silently do nothing exactly when users most need to
    // compact a long-running session.
    let (result_tx, result_rx) = oneshot::channel();
    let exec_session = Arc::clone(&session);
    let exec_session_id = session_id.clone();

    let enqueued = session
        .scheduler
        .enqueue(ScheduledMessage {
            // Maintenance, not a turn: the worker must not advertise a
            // running turn (the frontend would strand the session in
            // `running`) and must not route a concurrent user message into
            // the steering queue (no turn loop would drain it).
            kind: ScheduledKind::Maintenance,
            message_id: format!("manual-compact-{}", uuid::Uuid::new_v4()),
            generation: 0,
            client_message_id: None,
            // Empty intent id keeps the worker's turn-lifecycle writes
            // no-ops — compaction is not a turn and must not appear in the
            // turn indexer.
            turn_intent_id: String::new(),
            org_run_id: None,
            content: "[manual compact]".to_string(),
            execute: Box::new(move || {
                Box::pin(async move {
                    use futures::FutureExt;
                    let result = std::panic::AssertUnwindSafe(run_manual_compact_exclusive(
                        exec_session,
                        exec_session_id,
                        instructions,
                    ))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|payload| {
                        ManualCompactCommandResult::failed(format!(
                            "compaction panicked: {}",
                            crate::core::session::scheduler::panic_payload_to_string(
                                payload.as_ref()
                            )
                        ))
                    });
                    let _ = result_tx.send(result);
                    // Always Ok: failures (including panics) travel through
                    // the oneshot as a structured status; an Err here would
                    // make the worker broadcast a spurious `agent:error`
                    // chat bubble.
                    Ok(String::new())
                })
            }),
        })
        .await;

    if let Err(err) = enqueued {
        warn!(
            "[manual_compact_desktop] enqueue failed for session {}: {}",
            session_id, err
        );
        return Ok(ManualCompactCommandResult::failed(err));
    }

    match result_rx.await {
        Ok(result) => Ok(result),
        // Sender dropped without a result: the queued job was invalidated
        // (stop/rewind) before it ran. Ask the user to retry.
        Err(_) => Ok(ManualCompactCommandResult::status(
            ManualCompactStatus::Busy,
        )),
    }
}

/// Compaction pipeline body. Runs on the session's scheduler worker, so no
/// turn can interleave between the history snapshot and the boundary persist.
async fn run_manual_compact_exclusive(
    session: Arc<AgentSession>,
    session_id: String,
    instructions: Option<String>,
) -> ManualCompactCommandResult {
    let runtime = {
        let guard = session.runtime.read().await;
        match guard.clone() {
            Some(runtime) => runtime,
            None => {
                return ManualCompactCommandResult::status(ManualCompactStatus::NoRuntime);
            }
        }
    };

    let sid_for_load = session_id.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        let history =
            unified_persistence::load_llm_history(&sid_for_load).map_err(|err| err.to_string())?;
        let sm_state = unified_persistence::load_session_memory_state(&sid_for_load)
            .map_err(|err| err.to_string())?;
        let start_seqs = unified_persistence::load_llm_history_start_sequences(&sid_for_load)
            .map_err(|err| err.to_string())?;
        Ok::<_, String>((history, sm_state, start_seqs))
    })
    .await;

    let (history, sm_persisted, sm_start_seqs) = match loaded {
        Ok(Ok(pair)) => pair,
        Ok(Err(err)) => {
            let reason = format!("load session state failed: {}", err);
            warn!("[manual_compact_desktop] {}", reason);
            return ManualCompactCommandResult::failed(reason);
        }
        Err(err) => {
            let reason = format!("load session state join error: {}", err);
            warn!("[manual_compact_desktop] {}", reason);
            return ManualCompactCommandResult::failed(reason);
        }
    };

    let messages_before = history.len();
    if messages_before < MIN_HISTORY_FOR_MANUAL_COMPACT {
        let mut result = ManualCompactCommandResult::status(ManualCompactStatus::TooShort);
        result.messages_before = Some(messages_before);
        return result;
    }

    let tokens_before = ContextCompactor::estimate_messages_tokens(&history);

    if persist::is_recently_compacted_without_new_tail(&history) {
        return already_compact_result(messages_before, tokens_before, None);
    }

    let budget_tokens = tokens_before.max(1);
    let custom_instructions = instructions
        .as_deref()
        .map(str::trim)
        .filter(|instructions| !instructions.is_empty());

    let hook_executor = Arc::new(
        crate::specialization::hooks::HookExecutor::load_with_workspace_scope(
            runtime.workspace_state.read().working_dir(),
            runtime.resolved.load_workspace_resources,
        ),
    );

    crate::specialization::hooks::dispatch::fire_pre_compaction(
        Some(&hook_executor),
        &session_id,
        "manual",
        messages_before,
    )
    .await;

    // Zero-cost fast path first: reuse the pre-built session-memory summary
    // (mirrors the auto path and claude_code's session-memory-compact-first
    // order). Skipped when the user supplied focus instructions — SM content
    // is pre-extracted and cannot honor them.
    let mut compacted: Option<Vec<Value>> = None;
    if custom_instructions.is_none() {
        // `history` is `load_llm_history` output — the same visible durable
        // frame `sm_start_seqs` describes, so the anchor resolves exactly.
        let anchor_idx =
            session_memory::resolve_summarized_boundary_idx(sm_persisted.last_seq, &sm_start_seqs);
        if let Some(sm_view) = session_memory::try_sm_compact(
            &history,
            sm_persisted.content.as_deref(),
            anchor_idx,
            &session_memory::SessionMemoryCompactConfig::default(),
        ) {
            let candidate = finalize_compacted_view(&history, sm_view);
            if ContextCompactor::estimate_messages_tokens(&candidate) < tokens_before {
                info!(
                    "[manual_compact_desktop] {}: session-memory fast path succeeded (no LLM call)",
                    session_id
                );
                compacted = Some(candidate);
            }
            // Not reducing → fall through to LLM summarization below.
        }
    }

    let compacted = match compacted {
        Some(compacted) => compacted,
        None => {
            let attempt = {
                let mut compaction_state = session.compaction.lock().await;
                ContextCompactor::compact_manual_force(
                    &history,
                    budget_tokens,
                    &runtime.resolved.compaction,
                    &mut compaction_state,
                    runtime.provider.as_ref(),
                    &runtime.model,
                    custom_instructions,
                )
                .await
            };

            match attempt {
                Ok((_, CompactionOutcome::Skipped)) => {
                    return already_compact_result(
                        messages_before,
                        tokens_before,
                        Some("no compactable segment produced".to_string()),
                    );
                }
                Ok((compacted_view, _)) => {
                    let candidate = finalize_compacted_view(&history, compacted_view);
                    if ContextCompactor::estimate_messages_tokens(&candidate) >= tokens_before {
                        return already_compact_result(
                            messages_before,
                            tokens_before,
                            Some("compaction did not reduce tokens".to_string()),
                        );
                    }
                    candidate
                }
                Err(err) => {
                    let reason = format!("summarization failed: {}", err);
                    warn!("[manual_compact_desktop] {}: {}", session_id, reason);
                    return ManualCompactCommandResult::failed(reason);
                }
            }
        }
    };

    let candidate_messages_after = compacted.len();
    let candidate_tokens_after = ContextCompactor::estimate_messages_tokens(&compacted);

    crate::specialization::hooks::dispatch::fire_post_compaction(
        Some(&hook_executor),
        &session_id,
        "manual",
        messages_before,
        candidate_messages_after,
    );

    let context_window =
        crate::core::providers::model_capabilities::resolve_effective_context_window(
            &runtime.model,
            runtime.account_id.as_deref(),
            runtime
                .resolved
                .context_window_configured
                .then_some(runtime.resolved.context_window),
        ) as i64;
    let persist_result = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        let compacted = compacted.clone();
        let model = runtime.model.clone();
        let account_id = runtime.account_id.clone();
        move || -> Result<(persist::AppendedCompactBoundary, usize, usize, ContextUsageSnapshot), String> {
            // Snapshot invariant: the scheduler serializes this job against
            // turns, but channel-attached turns bypass the DialogScheduler,
            // and the upfront binding guard is check-then-enqueue. Re-verify
            // that the durable transcript still matches the snapshot the
            // compaction was computed from before making the cut durable.
            let current_len = unified_persistence::load_llm_history(&sid)
                .map_err(|err| err.to_string())?
                .len();
            if current_len != messages_before {
                return Err(format!(
                    "transcript changed during compaction ({} -> {} messages) — aborting boundary",
                    messages_before, current_len
                ));
            }

            // The boundary row is the compaction — its failure is fatal.
            let mut boundary = persist::append_in_place_compact_boundary(
                &sid,
                &compacted,
                Some((tokens_before, candidate_tokens_after)),
            )?;
            let durable_messages = boundary
                .durable_messages
                .take()
                .unwrap_or_else(|| compacted.clone());
            let tokens_after = boundary
                .durable_tokens_after
                .unwrap_or_else(|| ContextCompactor::estimate_messages_tokens(&durable_messages));
            let messages_after = durable_messages.len();
            let snapshot = ContextUsageSnapshot::from_payload(
                &durable_messages,
                &[],
                tokens_after as i64,
                0,
                0,
                Some(context_window),
            );
            let snapshot_json = serde_json::to_string(&snapshot).ok();

            // Everything below is bookkeeping: log-and-continue so a
            // secondary failure cannot report `Failed` for a compaction
            // that is already durable (the UI would then skip its reload
            // and desync from disk).
            if let Err(err) = persist::persist_session_memory_after_compact(&sid) {
                warn!(
                    "[manual_compact_desktop] session-memory index reset failed for {}: {}",
                    sid, err
                );
            }

            // Fresh token-usage record so the context ring shows
            // `tokens_after` after the frontend's post-compact reload
            // (postLoad reads the LAST record). `total_tokens` stays 0:
            // consumers SUM it as lifetime billed usage, and this row is
            // bookkeeping, not a billed round — only `context_tokens` and
            // the snapshot drive the ring.
            let record = crate::foundation::session_bridge::record_token_usage(
                crate::foundation::session_bridge::TokenUsageRow {
                    session_id: &sid,
                    session_type: crate::session::persistence::session_type::GENERIC,
                    model: Some(&model),
                    account_id: account_id.as_deref(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    total_tokens: 0,
                    context_tokens: tokens_after as i64,
                    context_usage_json: snapshot_json,
                },
            );
            if let Err(err) = record {
                warn!(
                    "[manual_compact_desktop] token-usage record failed for {}: {}",
                    sid, err
                );
            }

            Ok((boundary, messages_after, tokens_after, snapshot))
        }
    })
    .await;

    let (boundary, messages_after, tokens_after, snapshot) = match persist_result {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            warn!(
                "[manual_compact_desktop] failed to persist compact boundary for session {}: {}",
                session_id, err
            );
            return ManualCompactCommandResult::failed(err);
        }
        Err(err) => {
            let reason = format!("compact boundary persistence join error: {}", err);
            warn!("[manual_compact_desktop] {}", reason);
            return ManualCompactCommandResult::failed(reason);
        }
    };

    session.last_context_tokens.store(0, Ordering::SeqCst);

    // Instant ring/panel refresh, ahead of the frontend's full reload.
    crate::bus::broadcast_event(
        "agent:context_usage",
        serde_json::json!({
            "sessionId": session_id,
            "turnId": Option::<&str>::None,
            "contextTokens": tokens_after,
            "contextUsage": &snapshot,
            "warningLevel": snapshot.warning_level(),
        }),
    );

    info!(
        "[manual_compact_desktop] {}: {} messages ({} tokens) -> {} messages ({} tokens)",
        session_id, messages_before, tokens_before, messages_after, tokens_after
    );

    ManualCompactCommandResult {
        status: ManualCompactStatus::Compacted,
        message: None,
        messages_before: Some(messages_before),
        messages_after: Some(messages_after),
        tokens_before: Some(tokens_before),
        tokens_after: Some(tokens_after),
        boundary: Some(ManualCompactBoundary {
            id: boundary.id,
            content: boundary.summary,
            created_at: boundary.created_at,
        }),
    }
}

/// Post-compaction pipeline shared by the SM fast path and the LLM path:
/// drop orphaned tool results, then re-inject recently-read files and any
/// approved plan so the model does not lose working state.
fn finalize_compacted_view(history: &[Value], compacted_view: Vec<Value>) -> Vec<Value> {
    let mut compacted = post_compact_cleanup(compacted_view);
    crate::model_context::file_reinjection::reinject_files_after_compaction(
        history,
        &mut compacted,
    );
    crate::model_context::plan_preservation::reinject_plan_after_compaction(
        history,
        &mut compacted,
    );
    compacted
}

fn already_compact_result(
    messages_before: usize,
    tokens_before: usize,
    message: Option<String>,
) -> ManualCompactCommandResult {
    ManualCompactCommandResult {
        status: ManualCompactStatus::AlreadyCompact,
        message,
        messages_before: Some(messages_before),
        messages_after: Some(messages_before),
        tokens_before: Some(tokens_before),
        tokens_after: Some(tokens_before),
        boundary: None,
    }
}
