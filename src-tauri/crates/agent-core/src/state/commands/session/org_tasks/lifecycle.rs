//! Agent Org run lifecycle: pause, resume, cancel, and progress wakes.
//!
//! This module owns the pause/resume commands and the shared machinery that
//! keeps a resumed run making progress: clearing stale per-session cancel
//! flags, seeding a coordinator resume turn, and re-waking members that hold
//! unread inbox rows. The group-chat send path reuses the resume/wake helpers,
//! so they are visible to sibling modules.

use std::sync::atomic::Ordering;

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_runs::{
    AgentOrgRunContext, AgentOrgRunStore, COORDINATOR_MEMBER_ID,
};
use crate::state::control_flow::CancelReason;
use crate::state::AgentAppState;

use super::context::session_org_read_context;

/// Pause the Agent Org run that the given session belongs to. Transitions
/// `running → paused`; already non-running runs return `Ok(false)` (idempotent).
/// The run remains queryable while paused — polling and member switching are
/// unaffected. The coordinator and members stop receiving dispatch until resumed.
#[tauri::command]
pub async fn agent_org_pause_run(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let run_id = context.run_id.clone();
    let transitioned = tokio::task::spawn_blocking(move || AgentOrgRunStore::mark_paused(&run_id))
        .await
        .map_err(|err| format!("Agent Org pause worker failed: {err}"))??;
    cancel_active_org_turns(&state, context).await?;
    Ok(transitioned)
}

/// Resume a paused Agent Org run. Transitions `paused → running`; already
/// non-paused runs return `Ok(false)` (idempotent).
///
/// After marking the run as resumed and clearing pause cancel flags, re-wakes
/// members that have unread inbox rows. The coordinator also receives one
/// durable resume event. Owned or ownerless task state by
/// itself is not new input and must never cause an empty model turn. Without
/// this step the run's DB status becomes `running` but
/// no sessions start processing because `InboxWakeHook` only fires when new
/// rows are written, not when a run is un-paused.
#[tauri::command]
pub async fn agent_org_resume_run(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let outcome = resume_agent_org_context(context, true).await?;
    if outcome.run_is_running {
        if let Err(err) = clear_active_org_cancel_flags(&state, context).await {
            tracing::warn!(
                run_id = %context.run_id,
                error = %err,
                "Agent Org resume committed, but clearing stale cancel flags failed"
            );
        }
        // Explicit Resume is also an idempotent repair signal. Even if a
        // previous call already transitioned the Run, rescan durable unread
        // inbox rows so a post-commit process crash cannot leave it Running
        // with no scheduled consumer.
        schedule_run_progress_wakes(app_handle, context);
    }
    Ok(outcome.transitioned)
}

pub(super) async fn clear_active_org_cancel_flags(
    state: &AgentAppState,
    context: &AgentOrgRunContext,
) -> Result<(), String> {
    let session_ids = org_session_ids(context).await?;
    for session_id in session_ids {
        if let Some(session) = state.get_session(&session_id).await {
            session.cancel_flag.store(false, Ordering::SeqCst);
        }
    }
    Ok(())
}

async fn org_session_ids(context: &AgentOrgRunContext) -> Result<Vec<String>, String> {
    let context = context.clone();
    tokio::task::spawn_blocking(move || {
        let mut session_ids = Vec::new();
        if let Some(root_session_id) = context.root_session_id {
            session_ids.push(root_session_id);
        }
        session_ids.extend(
            AgentOrgRunStore::list_descendant_worker_sessions(&context.run_id)?
                .into_iter()
                .map(|session| session.session_id),
        );
        Ok(session_ids)
    })
    .await
    .map_err(|err| format!("Agent Org session-list worker failed: {err}"))?
}

async fn cancel_active_org_turns(
    state: &AgentAppState,
    context: &AgentOrgRunContext,
) -> Result<(), String> {
    let session_ids = org_session_ids(context).await?;

    for session_id in session_ids {
        state
            .cancel_session(&session_id, CancelReason::OrgPause)
            .await;
    }

    Ok(())
}

pub(crate) async fn resume_paused_run_for_user_message(
    state: &AgentAppState,
    session_id: &str,
) -> Result<bool, String> {
    let Some(app_handle) = state.app_handle.clone() else {
        return Ok(false);
    };
    let Some(read_context) = session_org_read_context(state, session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let outcome = resume_agent_org_context(context, false).await?;
    if outcome.run_is_running {
        if let Err(err) = clear_active_org_cancel_flags(state, context).await {
            tracing::warn!(
                run_id = %context.run_id,
                error = %err,
                "user-message resume committed, but clearing stale cancel flags failed"
            );
        }
        schedule_run_progress_wakes(app_handle, context);
    }
    Ok(outcome.transitioned)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AgentOrgResumeOutcome {
    pub(super) transitioned: bool,
    pub(super) run_is_running: bool,
}

pub(super) async fn resume_agent_org_context(
    context: &AgentOrgRunContext,
    seed_coordinator_resume_turn: bool,
) -> Result<AgentOrgResumeOutcome, String> {
    let context = context.clone();
    tokio::task::spawn_blocking(move || {
        resume_agent_org_context_sync(&context, seed_coordinator_resume_turn)
    })
    .await
    .map_err(|err| format!("Agent Org resume worker failed: {err}"))?
}

pub(super) fn resume_agent_org_context_sync(
    context: &AgentOrgRunContext,
    seed_coordinator_resume_turn: bool,
) -> Result<AgentOrgResumeOutcome, String> {
    with_sessions_writer(|| -> Result<AgentOrgResumeOutcome, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id=?1",
                params![&context.run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let transitioned = status.as_deref() == Some("paused");
        let run_is_running = transitioned || status.as_deref() == Some("running");
        if transitioned {
            tx.execute(
                "UPDATE agent_org_runs
                 SET status='running', updated_at=?2
                 WHERE id=?1 AND status='paused'",
                params![&context.run_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|err| err.to_string())?;
        }
        if run_is_running && seed_coordinator_resume_turn {
            seed_coordinator_resume_inbox_in_tx(&tx, context)?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(AgentOrgResumeOutcome {
            transitioned,
            run_is_running,
        })
    })
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
    if has_unread {
        return Some(AgentOrgWakeReason::UnreadInbox);
    }
    None
}

pub(super) fn collect_run_progress_wake_targets(
    run_id: &str,
    member_ids: &[String],
) -> Result<Vec<AgentOrgWakeTarget>, String> {
    let mut targets = Vec::new();
    for member_id in member_ids {
        let has_unread = AgentInboxStore::has_unread_for_member(member_id, run_id)?;
        if let Some(reason) = should_wake_member_for_progress(has_unread) {
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

pub(super) fn schedule_run_progress_wakes(
    app_handle: tauri::AppHandle,
    context: &AgentOrgRunContext,
) {
    let run_id = context.run_id.clone();
    let member_ids = org_progress_member_ids(context);

    tokio::spawn(async move {
        let target_run_id = run_id.clone();
        let targets = match tokio::task::spawn_blocking(move || {
            collect_run_progress_wake_targets(&target_run_id, &member_ids)
        })
        .await
        {
            Ok(Ok(targets)) => targets,
            Ok(Err(err)) => {
                tracing::warn!(
                    run_id = %run_id,
                    error = %err,
                    "[agent_org_progress] failed to collect wake targets after run progress transition"
                );
                return;
            }
            Err(err) => {
                tracing::warn!(
                    run_id = %run_id,
                    error = %err,
                    "[agent_org_progress] wake-target worker failed"
                );
                return;
            }
        };
        for target in targets {
            tracing::info!(
                run_id = %run_id,
                member_id = %target.member_id,
                reason = ?target.reason,
                "[agent_org_progress] waking member for runnable Agent Org work"
            );
            wake_agent_org_member(app_handle.clone(), &target.member_id, &run_id);
        }
    });
}

fn seed_coordinator_resume_inbox_in_tx(
    tx: &rusqlite::Transaction<'_>,
    context: &AgentOrgRunContext,
) -> Result<(), String> {
    let coordinator_member_id = COORDINATOR_MEMBER_ID;
    let has_unread: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_inbox
                 WHERE recipient_member_id=?1
                   AND org_run_id=?2
                   AND read_at IS NULL
             )",
            params![coordinator_member_id, &context.run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if has_unread {
        return Ok(());
    }

    AgentInboxStore::insert_in_tx(
        tx,
        InsertInboxParams {
            recipient_agent_id: context.coordinator_agent_id.clone(),
            recipient_member_id: Some(coordinator_member_id.to_string()),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(context.run_id.clone()),
            message: AgentMessage::Plain {
                summary: "Agent Org run resumed".to_string(),
                text: "The Agent Org run was resumed by the user. Continue coordinating the current work from the persisted task and member state. If all assigned work is already complete, summarize the current status instead of waiting idly.".to_string(),
            },
        },
    )?;
    Ok(())
}
