//! Durable Agent Org Pause/Resume commands and post-commit runtime handoff.

use std::sync::Arc;
use std::time::Duration;

use crate::coordination::agent_inbox::AgentInboxStore;
use crate::coordination::agent_org_pause::{
    ContinuationDispatch, PauseRunOutcome, ResumeRunOutcome,
};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::foundation::session_bridge::TurnIntentBridgeSource;
use crate::state::commands::session::identity::IdentityOverrides;
use crate::state::control_flow::CancelReason;
use crate::state::{AgentAppState, AgentSession};

use super::context::session_org_read_context;

const DRAIN_DEADLINE: Duration = Duration::from_secs(10);
const DRAIN_OBSERVATION_INTERVAL: Duration = Duration::from_millis(100);
const CONTINUATION_DISPATCH_LIMIT: usize = 256;

#[tauri::command]
pub async fn agent_org_pause_run(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
) -> Result<PauseRunOutcome, String> {
    crate::coordination::agent_org_runs::require_agent_org_redesign()?;
    let read_context = session_org_read_context(&state, &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} is not part of an Agent Org run"))?;
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let run_id = context.run_id.clone();
    let pause_run_id = run_id.clone();
    let commit = tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::pause_run_commit(&pause_run_id, &request_id)
    })
    .await
    .map_err(|error| format!("Agent Org Pause transaction worker failed: {error}"))??;
    let outcome = commit.outcome;

    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    if let Some(teardown_owner_id) = commit.teardown_owner_id {
        let teardown_state = state.inner().clone();
        let teardown_episode_id = outcome.episode_id.clone();
        let teardown_run_id = run_id;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = teardown_pause_episode(
                teardown_state,
                teardown_run_id.clone(),
                teardown_episode_id,
                teardown_owner_id,
            )
            .await
            {
                tracing::warn!(
                    run_id = %teardown_run_id,
                    error = %error,
                    "Agent Org Pause fence committed, but runtime drain owner failed"
                );
            }
        });
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn agent_org_resume_run(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
) -> Result<ResumeRunOutcome, String> {
    crate::coordination::agent_org_runs::require_agent_org_redesign()?;
    let read_context = session_org_read_context(&state, &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} is not part of an Agent Org run"))?;
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let run_id = context.run_id.clone();
    let resume_run_id = run_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::resume_run(&resume_run_id, &request_id)
    })
    .await
    .map_err(|error| format!("Agent Org Resume transaction worker failed: {error}"))??;

    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    schedule_ready_continuations(state.inner().clone());
    if let Some(app_handle) = state.app_handle.clone() {
        schedule_non_continuation_progress_wakes(app_handle, context, outcome.episode_id.clone());
    }
    Ok(outcome)
}

async fn teardown_pause_episode(
    state: AgentAppState,
    run_id: String,
    episode_id: String,
    teardown_owner_id: String,
) -> Result<(), String> {
    let deadline_at = tokio::time::Instant::now() + DRAIN_DEADLINE;
    let read_episode_id = episode_id.clone();
    let handoffs = tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::list_running_handoffs(
            &read_episode_id,
            &teardown_owner_id,
        )
    })
    .await
    .map_err(|error| format!("Pause handoff reader failed: {error}"))??;

    let mut signals = tokio::task::JoinSet::new();
    for handoff in handoffs {
        let child_state = state.clone();
        signals.spawn(async move { request_exact_handoff_yield(&child_state, handoff).await });
    }
    let mut signal_deadline_elapsed = false;
    loop {
        let result = match tokio::time::timeout_at(deadline_at, signals.join_next()).await {
            Ok(Some(result)) => result,
            Ok(None) => break,
            Err(_) => {
                signal_deadline_elapsed = true;
                signals.abort_all();
                break;
            }
        };
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(
                run_id = %run_id,
                error = %error,
                "failed to signal one captured Agent Org runtime"
            ),
            Err(error) => tracing::warn!(
                run_id = %run_id,
                error = %error,
                "captured Agent Org runtime signal task failed"
            ),
        }
    }

    let observed_episode_id = episode_id.clone();
    let observer_run_id = run_id.clone();
    let drained = tokio::time::timeout_at(deadline_at, async move {
        loop {
            let summary_episode_id = observed_episode_id.clone();
            let summary_run_id = observer_run_id.clone();
            let summary = tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_pause::pause_summary_for_run(&summary_run_id)
            })
            .await
            .map_err(|error| format!("Pause drain observer failed: {error}"))??;
            match summary {
                Some(summary)
                    if summary.episode_id == summary_episode_id && summary.draining_count == 0 =>
                {
                    return Ok::<(), String>(());
                }
                Some(summary) if summary.episode_id != summary_episode_id => return Ok(()),
                None => return Ok(()),
                _ => tokio::time::sleep(DRAIN_OBSERVATION_INTERVAL).await,
            }
        }
    })
    .await;

    if signal_deadline_elapsed || drained.is_err() {
        let timeout_episode_id = episode_id.clone();
        tokio::task::spawn_blocking(move || {
            crate::coordination::agent_org_pause::mark_unresolved_timed_out(&timeout_episode_id)
        })
        .await
        .map_err(|error| format!("Pause timeout writer failed: {error}"))??;
    } else if let Ok(Err(error)) = drained {
        return Err(error);
    }
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    Ok(())
}

async fn request_exact_handoff_yield(
    state: &AgentAppState,
    handoff: crate::coordination::agent_org_pause::RunningPauseHandoff,
) -> Result<(), String> {
    let Some(session) = state.get_session(&handoff.session_id).await else {
        return persist_runtime_absent(handoff).await;
    };
    let Some(identity) = session.runtime_turn_identity().await else {
        // The durable Turn may have been promoted to Running just before
        // Pause, while `begin_turn_with_intent` has not installed its
        // in-memory identity yet. Preserve a pre-turn cancellation marker so
        // that narrow provider-start window still yields. This is safe only
        // for the identity-absent case; a mismatching active identity may be
        // future UserDirectedWork and is deliberately not cancelled here.
        session.cancel_active_turn(CancelReason::OrgPause).await;
        return persist_runtime_absent(handoff).await;
    };
    if identity.turn_intent_id.as_deref() != Some(handoff.turn_intent_id.as_str()) {
        return persist_runtime_absent(handoff).await;
    }

    let bind = handoff.clone();
    let runtime_lease_id = identity.runtime_lease_id.clone();
    let dialog_turn_generation = identity.dialog_turn_generation.clone();
    let bound = tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::bind_runtime_and_request_yield(
            &bind.episode_id,
            &bind.session_id,
            &bind.turn_intent_id,
            &runtime_lease_id,
            &dialog_turn_generation,
        )
    })
    .await
    .map_err(|error| format!("Pause runtime binding worker failed: {error}"))??;
    if bound {
        session.cancel_active_turn(CancelReason::OrgPause).await;
    }
    Ok(())
}

async fn persist_runtime_absent(
    handoff: crate::coordination::agent_org_pause::RunningPauseHandoff,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::mark_runtime_absent(
            &handoff.episode_id,
            &handoff.session_id,
            &handoff.turn_intent_id,
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| format!("Pause runtime-absent worker failed: {error}"))?
}

/// Completion callback for every real Turn. Ordinary SDE turns do one indexed
/// read and return; only a runtime identity already bound to a Pause receipt
/// can clear the runtime slot.
pub(crate) async fn settle_pause_handoff_after_turn(
    state: &AgentAppState,
    session: &Arc<AgentSession>,
    run_id: Option<&str>,
    turn_intent_id: &str,
) {
    let Some(identity) = session.runtime_turn_identity().await else {
        return;
    };
    if identity.turn_intent_id.as_deref() != Some(turn_intent_id) {
        return;
    }
    let lookup_session_id = session.id.clone();
    let lookup_intent_id = turn_intent_id.to_string();
    let lookup_lease = identity.runtime_lease_id.clone();
    let lookup_generation = identity.dialog_turn_generation.clone();
    let episode = match tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::bound_episode_for_runtime(
            &lookup_session_id,
            &lookup_intent_id,
            &lookup_lease,
            &lookup_generation,
        )
    })
    .await
    {
        Ok(Ok(episode)) => episode,
        Ok(Err(error)) => {
            tracing::warn!(session_id = %session.id, error = %error, "failed to read Pause handoff receipt");
            return;
        }
        Err(error) => {
            tracing::warn!(session_id = %session.id, error = %error, "Pause handoff receipt worker failed");
            return;
        }
    };
    if episode.is_none() {
        return;
    }
    let process_owner = crate::tools::call_context::TurnProcessOwner {
        session_id: session.id.clone(),
        turn_intent_id: turn_intent_id.to_string(),
        runtime_lease_id: identity.runtime_lease_id.clone(),
        dialog_turn_generation: identity.dialog_turn_generation.clone(),
    };
    if let Err(error) =
        crate::tools::impls::coding::exec::registry::await_shells_terminated_for_owner(
            &process_owner,
            DRAIN_DEADLINE,
        )
        .await
    {
        tracing::warn!(
            session_id = %session.id,
            runtime_lease_id = %identity.runtime_lease_id,
            error = %error,
            "Pause handoff remains draining because owned shell processes are not terminal"
        );
        return;
    }
    let released_current_slot = session
        .release_runtime_if_current(&identity.runtime_lease_id, &identity.dialog_turn_generation)
        .await;
    if !released_current_slot {
        tracing::debug!(
            session_id = %session.id,
            runtime_lease_id = %identity.runtime_lease_id,
            "Pause completion observed a replaced runtime lease; preserving the current slot"
        );
        return;
    }
    let release_session_id = session.id.clone();
    let release_intent_id = turn_intent_id.to_string();
    let release_lease = identity.runtime_lease_id;
    let release_generation = identity.dialog_turn_generation;
    match tokio::task::spawn_blocking(move || {
        crate::coordination::agent_org_pause::mark_released(
            &release_session_id,
            &release_intent_id,
            &release_lease,
            &release_generation,
        )
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            tracing::warn!(session_id = %session.id, error = %error, "failed to persist Pause release receipt");
            return;
        }
        Err(error) => {
            tracing::warn!(session_id = %session.id, error = %error, "Pause release receipt worker failed");
            return;
        }
    }
    if let Some(run_id) = run_id {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
    }
    schedule_ready_continuations(state.clone());
}

pub(crate) fn schedule_ready_continuations(state: AgentAppState) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = dispatch_ready_continuations(&state).await {
            tracing::warn!(error = %error, "Agent Org continuation dispatcher failed");
        }
    });
}

pub(crate) async fn dispatch_ready_continuations(state: &AgentAppState) -> Result<usize, String> {
    let dispatches = tokio::task::spawn_blocking(|| {
        crate::coordination::agent_org_pause::list_dispatchable_continuations(
            CONTINUATION_DISPATCH_LIMIT,
        )
    })
    .await
    .map_err(|error| format!("continuation reader failed: {error}"))??;
    let mut dispatched = 0usize;
    for dispatch in dispatches {
        let episode_id = dispatch.episode_id.clone();
        let turn_intent_id = dispatch.turn_intent_id.clone();
        let claimed = tokio::task::spawn_blocking(move || {
            crate::coordination::agent_org_pause::claim_continuation_dispatch(
                &episode_id,
                &turn_intent_id,
            )
        })
        .await
        .map_err(|error| format!("continuation receipt worker failed: {error}"))??;
        if !claimed {
            continue;
        }
        if let Err(error) = dispatch_one_continuation(state, &dispatch).await {
            let episode_id = dispatch.episode_id.clone();
            let turn_intent_id = dispatch.turn_intent_id.clone();
            if let Err(requeue_error) = tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_pause::requeue_continuation_dispatch(
                    &episode_id,
                    &turn_intent_id,
                )
            })
            .await
            .map_err(|join_error| join_error.to_string())
            .and_then(|result| result.map_err(|persist_error| persist_error.to_string()))
            {
                tracing::warn!(error = %requeue_error, "failed to requeue continuation after dispatch error");
            }
            return Err(error);
        }
        dispatched += 1;
    }
    Ok(dispatched)
}

async fn dispatch_one_continuation(
    state: &AgentAppState,
    dispatch: &ContinuationDispatch,
) -> Result<(), String> {
    let mode = if dispatch.turn_kind == "task_execution" {
        super::super::message::resolve_agent_org_wake_mode(
            &dispatch.session_id,
            &dispatch.run_id,
            &dispatch.turn_intent_id,
        )?
        .map(|value| value.as_str().to_string())
    } else {
        None
    };
    // Resume continues the captured formal Turn; it is not a new user
    // submission. Empty content prevents a synthetic transcript row. The
    // processor derives a transient provider nudge from the durable receipt.
    let content = String::new();
    super::super::message::send_message_impl(
        state,
        dispatch.session_id.clone(),
        content,
        None,
        IdentityOverrides::default(),
        mode,
        None,
        None,
        true,
        false,
        Some(dispatch.turn_intent_id.clone()),
        Some(dispatch.turn_intent_id.clone()),
        None,
        None,
        Some(dispatch.run_id.clone()),
        TurnIntentBridgeSource::Resume,
    )
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AgentOrgWakeReason {
    UnreadInbox,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AgentOrgWakeTarget {
    pub(super) member_id: String,
    pub(super) reason: AgentOrgWakeReason,
}

pub(super) fn should_wake_member_for_progress(has_unread: bool) -> Option<AgentOrgWakeReason> {
    has_unread.then_some(AgentOrgWakeReason::UnreadInbox)
}

pub(super) fn collect_run_progress_wake_targets(
    run_id: &str,
    member_ids: &[String],
) -> Result<Vec<AgentOrgWakeTarget>, String> {
    let mut targets = Vec::new();
    for member_id in member_ids {
        if let Some(reason) = should_wake_member_for_progress(
            AgentInboxStore::has_unread_for_member(member_id, run_id)?,
        ) {
            targets.push(AgentOrgWakeTarget {
                member_id: member_id.clone(),
                reason,
            });
        }
    }
    Ok(targets)
}

pub(super) fn org_progress_member_ids(context: &AgentOrgRunContext) -> Vec<String> {
    std::iter::once(COORDINATOR_MEMBER_ID.to_string())
        .chain(
            context
                .members
                .iter()
                .map(|member| member.member_id.clone()),
        )
        .collect()
}

pub(super) fn wake_agent_org_member(app_handle: tauri::AppHandle, member_id: &str, run_id: &str) {
    use crate::core::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
    use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;
    AppHandleInboxWakeHook::new(app_handle).wake_member(member_id, run_id);
}

fn schedule_non_continuation_progress_wakes(
    app_handle: tauri::AppHandle,
    context: AgentOrgRunContext,
    episode_id: String,
) {
    tauri::async_runtime::spawn(async move {
        let run_id = context.run_id.clone();
        let member_ids = org_progress_member_ids(&context);
        let query_run_id = run_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            let continued =
                crate::coordination::agent_org_pause::continuation_participant_ids(&episode_id)?
                    .into_iter()
                    .collect::<std::collections::HashSet<_>>();
            let candidates = member_ids
                .into_iter()
                .filter(|member_id| !continued.contains(member_id))
                .collect::<Vec<_>>();
            collect_run_progress_wake_targets(&query_run_id, &candidates)
        })
        .await;
        match result {
            Ok(Ok(targets)) => {
                for target in targets {
                    wake_agent_org_member(app_handle.clone(), &target.member_id, &run_id);
                }
            }
            Ok(Err(error)) => {
                tracing::warn!(run_id = %run_id, error = %error, "failed to collect Resume wake targets")
            }
            Err(error) => {
                tracing::warn!(run_id = %run_id, error = %error, "Resume wake-target worker failed")
            }
        }
    });
}
