use std::collections::HashMap;
use std::sync::atomic::Ordering;

use std::time::{Duration, Instant};

use database::db::get_connection;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
    USER_SENDER_ID,
};
use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionRecord, AgentMemberInterventionStore,
    EnterMemberInterventionParams, DEFAULT_INTERVENTION_TTL_SECS,
};
use crate::coordination::agent_org_plan_approvals::{
    enqueue_post_approval_messages, AgentOrgPlanApproval, AgentOrgPlanApprovalStore,
    AgentOrgPlanDecisionBy, AgentOrgPlanInboxDelivery,
};
use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunStatus, AgentOrgRunStore,
    WorkerSessionRuntime, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};
use crate::definitions::orgs::AgentOrgsStore;
use crate::persistence::AgentResponse;
use crate::session::persistence;
use crate::state::commands::session::identity::IdentityOverrides;
use crate::state::commands::session::message::{send_message_impl, send_message_impl_for_org_wake};
use crate::state::control_flow::CancelReason;
use crate::state::AgentAppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgTaskRuntime {
    #[serde(flatten)]
    pub task: Task,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_member: Option<AgentOrgContextMember>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_runtime: Option<WorkerSessionRuntime>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgSessionInterventionState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intervention: Option<AgentMemberInterventionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgDirectMemberMessageResponse {
    pub member_session_id: String,
    pub response: AgentResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupChatMessageResponse {
    pub target_member_id: String,
    pub target_member_name: String,
    pub inbox_row: AgentOrgInboxRuntimeRow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunMemberView {
    pub member_id: String,
    pub name: String,
    pub role: String,
    pub agent_id: String,
    pub parent_member_id: Option<String>,
    pub is_coordinator: bool,
    pub session_runtime: Option<WorkerSessionRuntime>,
    pub unread_inbox_count: usize,
    pub inbox_activity_count: usize,
    pub active_task_count: usize,
    pub pending_task_count: usize,
    pub in_progress_task_count: usize,
    pub completed_task_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intervention: Option<AgentMemberInterventionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgInboxRuntimeRow {
    #[serde(flatten)]
    pub row: AgentInboxRecord,
    pub recipient_name: String,
    pub sender_name: String,
    pub display_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunView {
    pub context: AgentOrgRunContext,
    pub run_status: String,
    pub run_phase: AgentOrgRunPhase,
    pub current_member_id: Option<String>,
    pub members: Vec<AgentOrgRunMemberView>,
    pub tasks: Vec<AgentOrgTaskRuntime>,
    pub inbox: Vec<AgentOrgInboxRuntimeRow>,
    pub pending_plan_approvals: Vec<AgentOrgPlanApproval>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgRunPhase {
    Coordinating,
    Dispatching,
    MembersWorking,
    Waiting,
    AwaitingPlanApproval,
    Finalizing,
    Paused,
    Completed,
    Failed,
    Cancelled,
    Abandoned,
}

struct SessionOrgReadContext {
    context: Option<AgentOrgRunContext>,
    member_id: Option<String>,
}

#[tauri::command]
pub async fn agent_org_session_run_view(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<Option<AgentOrgRunView>, String> {
    agent_org_session_run_view_impl(&state, &session_id).await
}

pub async fn agent_org_session_run_view_impl(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Option<AgentOrgRunView>, String> {
    let Some(read_context) = session_org_read_context(state, session_id).await? else {
        return Ok(None);
    };
    let Some(ref context) = read_context.context else {
        return Ok(None);
    };
    AgentOrgRunStore::reconcile_run_finality(&context.run_id)?;

    let run_status_value =
        AgentOrgRunStore::get_run_status(&context.run_id)?.unwrap_or(AgentOrgRunStatus::Running);
    let run_status = run_status_value.as_str().to_string();

    let tasks = tasks_for_context(context)?;
    let inbox_records = AgentInboxStore::list_by_run(&context.run_id)?;
    let member_ids: Vec<String> = context
        .members
        .iter()
        .map(|member| member.member_id.clone())
        .collect();
    let member_runtimes: HashMap<String, WorkerSessionRuntime> =
        AgentOrgRunStore::list_worker_sessions_by_member_ids(&context.run_id, &member_ids)?
            .into_iter()
            .filter_map(|session| {
                session
                    .member_id
                    .clone()
                    .map(|member_id| (member_id, session))
            })
            .collect();

    let coordinator_intervention =
        AgentMemberInterventionStore::active_for_member(&context.run_id, COORDINATOR_MEMBER_ID)?;
    let coordinator_runtime = AgentOrgRunStore::find_coordinator_session_by_member_id(
        &context.run_id,
        COORDINATOR_MEMBER_ID,
    )?
    .map(|session| WorkerSessionRuntime {
        agent_definition_id: Some(context.coordinator_agent_id.clone()),
        cli_agent_type: None,
        member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        session_id: session.session_id,
        parent_session_id: None,
        status: session.status,
        updated_at: session.updated_at,
        intervention: coordinator_intervention,
    });

    let mut members = Vec::with_capacity(context.members.len() + 1);
    members.push(coordinator_member_view(
        context,
        coordinator_runtime,
        &tasks,
        &inbox_records,
    )?);
    for member in &context.members {
        members.push(member_view(
            context,
            member,
            member_runtimes.get(&member.member_id).cloned(),
            &tasks,
            &inbox_records,
        )?);
    }

    let inbox = enrich_inbox_rows(context, inbox_records);
    let pending_plan_approvals = AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)?;

    let run_phase = project_run_phase(
        run_status_value,
        &members,
        &tasks,
        &inbox,
        &pending_plan_approvals,
    );

    let current_member_id = require_session_member_id(&read_context, session_id)?;

    Ok(Some(AgentOrgRunView {
        current_member_id: Some(current_member_id),
        context: context.clone(),
        run_status,
        run_phase,
        members,
        tasks,
        inbox,
        pending_plan_approvals,
    }))
}

fn project_run_phase(
    run_status: AgentOrgRunStatus,
    members: &[AgentOrgRunMemberView],
    tasks: &[AgentOrgTaskRuntime],
    inbox: &[AgentOrgInboxRuntimeRow],
    pending_plan_approvals: &[AgentOrgPlanApproval],
) -> AgentOrgRunPhase {
    match run_status {
        AgentOrgRunStatus::Paused => AgentOrgRunPhase::Paused,
        AgentOrgRunStatus::Completed => AgentOrgRunPhase::Completed,
        AgentOrgRunStatus::Failed => AgentOrgRunPhase::Failed,
        AgentOrgRunStatus::Cancelled => AgentOrgRunPhase::Cancelled,
        AgentOrgRunStatus::Abandoned => AgentOrgRunPhase::Abandoned,
        AgentOrgRunStatus::Running => {
            let all_tasks_completed =
                !tasks.is_empty() && tasks.iter().all(|task| task.task.status.is_resolved());
            if all_tasks_completed {
                return AgentOrgRunPhase::Finalizing;
            }
            let any_member_working = members.iter().any(|member| {
                member.session_runtime.as_ref().is_some_and(|runtime| {
                    matches!(
                        runtime.status,
                        crate::session::SessionStatus::Running
                            | crate::session::SessionStatus::WaitingForUser
                            | crate::session::SessionStatus::WaitingForFunds
                    )
                })
            });
            if any_member_working {
                return AgentOrgRunPhase::MembersWorking;
            }
            if !pending_plan_approvals.is_empty() {
                return AgentOrgRunPhase::AwaitingPlanApproval;
            }
            let has_unread = inbox.iter().any(|row| row.row.read_at.is_none());
            if has_unread {
                return AgentOrgRunPhase::Dispatching;
            }
            if tasks.iter().any(|task| !task.task.status.is_resolved()) {
                AgentOrgRunPhase::Waiting
            } else {
                AgentOrgRunPhase::Coordinating
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgPlanApprovalDecision {
    Approve,
    ApproveWithEdits,
    RequestChanges,
}

#[tauri::command]
// Tauri exposes command arguments as a flat invoke payload. Keeping these
// fields explicit preserves the stable frontend wire shape.
#[allow(clippy::too_many_arguments)]
pub async fn agent_org_plan_approval_respond(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    approval_id: String,
    plan_revision_id: String,
    decision: AgentOrgPlanApprovalDecision,
    edited_content: Option<String>,
    feedback: Option<String>,
) -> Result<AgentOrgPlanApproval, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Err(format!(
            "Session {session_id} is not part of an Agent Org run"
        ));
    };
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let approval = AgentOrgPlanApprovalStore::get(&approval_id)?
        .ok_or_else(|| format!("Agent Org plan approval {approval_id} was not found"))?;
    if approval.org_run_id != context.run_id {
        return Err("Agent Org plan approval does not belong to this run".to_string());
    }

    match decision {
        AgentOrgPlanApprovalDecision::Approve | AgentOrgPlanApprovalDecision::ApproveWithEdits => {
            let edited_content = match decision {
                AgentOrgPlanApprovalDecision::ApproveWithEdits => Some(
                    edited_content
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| {
                            "approve_with_edits requires non-empty edited_content".to_string()
                        })?,
                ),
                _ => None,
            };
            let approved = AgentOrgPlanApprovalStore::approve(
                &approval_id,
                &plan_revision_id,
                AgentOrgPlanDecisionBy::User,
                edited_content,
            )?;
            let wake_member_ids = enqueue_post_approval_messages(&context, &approved)?;
            for member_id in wake_member_ids {
                wake_agent_org_member(app_handle.clone(), &member_id, &context.run_id);
            }
            AgentOrgRunStore::reconcile_run_finality(&context.run_id)?;
            Ok(approved.approval)
        }
        AgentOrgPlanApprovalDecision::RequestChanges => {
            let feedback = feedback
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "request_changes requires non-empty feedback".to_string())?;
            let recipient_agent_id = context
                .participant_agent_id(&approval.source_member_id)
                .ok_or_else(|| {
                    format!(
                        "Agent Org plan source member {} is not in the run roster",
                        approval.source_member_id
                    )
                })?;
            let (changed, _) = AgentOrgPlanApprovalStore::request_changes(
                &approval_id,
                &plan_revision_id,
                AgentOrgPlanDecisionBy::User,
                feedback,
                AgentOrgPlanInboxDelivery {
                    recipient_agent_id,
                    sender_agent_id: USER_SENDER_ID.to_string(),
                    sender_member_id: None,
                },
            )?;
            wake_agent_org_member(app_handle, &changed.source_member_id, &context.run_id);
            Ok(changed)
        }
    }
}

#[tauri::command]
pub async fn agent_org_session_enter_intervention(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;
    if !can_enter_member_intervention(&member_id) {
        tracing::debug!(
            org_run_id = %context.run_id,
            session_id = %session_id,
            "ordinary coordinator message does not enter member intervention"
        );
        return Ok(false);
    }
    let agent_id = context.require_participant_agent_id(&member_id)?;

    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id,
        agent_id,
        session_id,
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: DEFAULT_INTERVENTION_TTL_SECS,
    })?;
    Ok(true)
}

#[tauri::command]
pub async fn agent_org_session_intervention_state(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<AgentOrgSessionInterventionState, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(AgentOrgSessionInterventionState { intervention: None });
    };
    let Some(ref context) = read_context.context else {
        return Ok(AgentOrgSessionInterventionState { intervention: None });
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;

    Ok(AgentOrgSessionInterventionState {
        intervention: AgentMemberInterventionStore::active_for_member(&context.run_id, &member_id)?,
    })
}

const RETURN_TO_WORK_INBOX_ACK_TIMEOUT: Duration = Duration::from_secs(90);
const RETURN_TO_WORK_INBOX_ACK_POLL_INTERVAL: Duration = Duration::from_millis(500);

async fn wait_for_member_inbox_rows_read(
    run_id: &str,
    member_id: &str,
    expected_row_ids: &[i64],
) -> Result<(), String> {
    if expected_row_ids.is_empty() {
        return Ok(());
    }

    let started_at = Instant::now();
    loop {
        let unread = AgentInboxStore::list_unread_for_member(member_id, run_id)?;
        let pending_ids: Vec<i64> = unread
            .iter()
            .map(|row| row.id)
            .filter(|id| expected_row_ids.contains(id))
            .collect();
        if pending_ids.is_empty() {
            return Ok(());
        }
        if started_at.elapsed() >= RETURN_TO_WORK_INBOX_ACK_TIMEOUT {
            return Err(format!(
                "Agent Org return-to-work wake did not drain inbox rows for member {member_id}: {pending_ids:?}"
            ));
        }
        tokio::time::sleep(RETURN_TO_WORK_INBOX_ACK_POLL_INTERVAL).await;
    }
}

#[tauri::command]
pub async fn agent_org_session_return_to_work(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;

    let changed = AgentMemberInterventionStore::clear(&context.run_id, &member_id)?;
    let pending_inbox = AgentInboxStore::list_unread_for_member(&member_id, &context.run_id)?;
    let pending_inbox_ids: Vec<i64> = pending_inbox.iter().map(|row| row.id).collect();
    if changed || !pending_inbox_ids.is_empty() {
        send_message_impl_for_org_wake(&state, session_id, &context.run_id, &member_id).await?;
        wait_for_member_inbox_rows_read(&context.run_id, &member_id, &pending_inbox_ids).await?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn agent_org_send_user_message_to_member(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    member_id: String,
    content: String,
) -> Result<AgentOrgDirectMemberMessageResponse, String> {
    agent_org_send_user_message_to_member_impl(&state, session_id, member_id, content).await
}

#[tauri::command]
pub async fn agent_org_send_group_chat_message(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    target_member_id: Option<String>,
    content: String,
) -> Result<AgentOrgGroupChatMessageResponse, String> {
    agent_org_send_group_chat_message_impl(
        app_handle,
        &state,
        session_id,
        target_member_id,
        content,
    )
    .await
}

pub async fn agent_org_send_group_chat_message_impl(
    app_handle: tauri::AppHandle,
    state: &AgentAppState,
    session_id: String,
    target_member_id: Option<String>,
    content: String,
) -> Result<AgentOrgGroupChatMessageResponse, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Agent Org group chat message content is required".to_string());
    }

    let view = agent_org_session_run_view_impl(state, &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} is not part of an Agent Org run"))?;
    let target_member_id = target_member_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(COORDINATOR_MEMBER_ID);
    let target = view
        .members
        .iter()
        .find(|candidate| candidate.member_id == target_member_id)
        .ok_or_else(|| {
            format!("Agent Org member {target_member_id} was not found for session {session_id}")
        })?;

    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: target.agent_id.clone(),
        recipient_member_id: Some(target.member_id.clone()),
        sender_agent_id: USER_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some(view.context.run_id.clone()),
        message: AgentMessage::Plain {
            summary: "User group chat message".to_string(),
            text: content.to_string(),
        },
    })?;

    clear_group_chat_target_intervention(&view.context, &target.member_id)?;

    let resumed = resume_agent_org_context(&view.context, false)?;
    if resumed {
        clear_active_org_cancel_flags(state, &view.context).await?;
        schedule_run_progress_wakes(app_handle.clone(), &view.context);
    } else {
        wake_agent_org_member(app_handle, &target.member_id, &view.context.run_id);
    }

    let mut enriched = enrich_inbox_rows(&view.context, vec![row]);
    let inbox_row = enriched
        .pop()
        .ok_or_else(|| "Agent Org group chat message did not produce an inbox row".to_string())?;

    Ok(AgentOrgGroupChatMessageResponse {
        target_member_id: target.member_id.clone(),
        target_member_name: target.name.clone(),
        inbox_row,
    })
}

pub async fn agent_org_send_user_message_to_member_impl(
    state: &AgentAppState,
    session_id: String,
    member_id: String,
    content: String,
) -> Result<AgentOrgDirectMemberMessageResponse, String> {
    let member_id = member_id.trim();
    if member_id.is_empty() {
        return Err("Agent Org member id is required".to_string());
    }
    if content.trim().is_empty() {
        return Err("Agent Org member message content is required".to_string());
    }

    let view = agent_org_session_run_view_impl(state, &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} is not part of an Agent Org run"))?;
    let member = view
        .members
        .into_iter()
        .find(|candidate| candidate.member_id == member_id)
        .ok_or_else(|| {
            format!("Agent Org member {member_id} was not found for session {session_id}")
        })?;
    let runtime = member.session_runtime.ok_or_else(|| {
        format!(
            "Agent Org member {} does not have a materialized session",
            member.member_id
        )
    })?;
    let member_session_id = runtime.session_id;

    let response = send_message_impl(
        state,
        member_session_id.clone(),
        content,
        None,
        IdentityOverrides::default(),
        None,
        None,
        None,
        false,
        true,
        None,
        None,
        None,
        crate::foundation::session_bridge::TurnIntentBridgeSource::AgentOrg,
    )
    .await?;

    Ok(AgentOrgDirectMemberMessageResponse {
        member_session_id,
        response,
    })
}

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
    let transitioned = AgentOrgRunStore::mark_paused(&context.run_id)?;
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
    let resumed = resume_agent_org_context(context, true)?;
    clear_active_org_cancel_flags(&state, context).await?;
    if resumed {
        schedule_run_progress_wakes(app_handle, context);
    }
    Ok(resumed)
}

async fn clear_active_org_cancel_flags(
    state: &AgentAppState,
    context: &AgentOrgRunContext,
) -> Result<(), String> {
    let session_ids = org_session_ids(context)?;
    for session_id in session_ids {
        if let Some(session) = state.get_session(&session_id).await {
            session.cancel_flag.store(false, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn org_session_ids(context: &AgentOrgRunContext) -> Result<Vec<String>, String> {
    let mut session_ids = Vec::new();
    if let Some(root_session_id) = context.root_session_id.clone() {
        session_ids.push(root_session_id);
    }
    session_ids.extend(
        AgentOrgRunStore::list_descendant_worker_sessions(&context.run_id)?
            .into_iter()
            .map(|session| session.session_id),
    );
    Ok(session_ids)
}

async fn cancel_active_org_turns(
    state: &AgentAppState,
    context: &AgentOrgRunContext,
) -> Result<(), String> {
    let session_ids = org_session_ids(context)?;

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
    let resumed = resume_agent_org_context(context, false)?;
    clear_active_org_cancel_flags(state, context).await?;
    if resumed {
        schedule_run_progress_wakes(app_handle, context);
    }
    Ok(resumed)
}

fn resume_agent_org_context(
    context: &AgentOrgRunContext,
    seed_coordinator_resume_turn: bool,
) -> Result<bool, String> {
    let transitioned = AgentOrgRunStore::mark_resumed(&context.run_id)?;
    if transitioned && seed_coordinator_resume_turn {
        seed_coordinator_resume_inbox(context)?;
    }
    Ok(transitioned)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentOrgWakeReason {
    UnreadInbox,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentOrgWakeTarget {
    member_id: String,
    reason: AgentOrgWakeReason,
}

fn should_wake_member_for_progress(has_unread: bool) -> Option<AgentOrgWakeReason> {
    if has_unread {
        return Some(AgentOrgWakeReason::UnreadInbox);
    }
    None
}

fn collect_run_progress_wake_targets(
    run_id: &str,
    member_ids: &[String],
) -> Result<Vec<AgentOrgWakeTarget>, String> {
    let mut targets = Vec::new();
    for member_id in member_ids {
        let has_unread = !AgentInboxStore::list_unread_for_member(member_id, run_id)?.is_empty();
        if let Some(reason) = should_wake_member_for_progress(has_unread) {
            targets.push(AgentOrgWakeTarget {
                member_id: member_id.clone(),
                reason,
            });
        }
    }
    Ok(targets)
}

fn org_progress_member_ids(context: &AgentOrgRunContext) -> Vec<String> {
    std::iter::once(COORDINATOR_MEMBER_ID.to_string())
        .chain(
            context
                .members
                .iter()
                .map(|member| member.member_id.clone()),
        )
        .collect()
}

fn wake_agent_org_member(app_handle: tauri::AppHandle, member_id: &str, run_id: &str) {
    use crate::core::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
    use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;
    AppHandleInboxWakeHook::new(app_handle).wake_member(member_id, run_id);
}

fn schedule_run_progress_wakes(app_handle: tauri::AppHandle, context: &AgentOrgRunContext) {
    let run_id = context.run_id.clone();
    let member_ids = org_progress_member_ids(context);

    tokio::spawn(async move {
        let targets = match collect_run_progress_wake_targets(&run_id, &member_ids) {
            Ok(targets) => targets,
            Err(err) => {
                tracing::warn!(
                    run_id = %run_id,
                    error = %err,
                    "[agent_org_progress] failed to collect wake targets after run progress transition"
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

fn clear_group_chat_target_intervention(
    context: &AgentOrgRunContext,
    target_member_id: &str,
) -> Result<bool, String> {
    AgentMemberInterventionStore::clear(&context.run_id, target_member_id)
}

fn seed_coordinator_resume_inbox(context: &AgentOrgRunContext) -> Result<(), String> {
    let coordinator_member_id = COORDINATOR_MEMBER_ID;
    if !AgentInboxStore::list_unread_for_member(coordinator_member_id, &context.run_id)?.is_empty()
    {
        return Ok(());
    }

    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: context.coordinator_agent_id.clone(),
        recipient_member_id: Some(coordinator_member_id.to_string()),
        sender_agent_id: SYSTEM_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some(context.run_id.clone()),
        message: AgentMessage::Plain {
            summary: "Agent Org run resumed".to_string(),
            text: "The Agent Org run was resumed by the user. Continue coordinating the current work from the persisted task and member state. If all assigned work is already complete, summarize the current status instead of waiting idly.".to_string(),
        },
    })?;
    Ok(())
}

fn tasks_for_context(context: &AgentOrgRunContext) -> Result<Vec<AgentOrgTaskRuntime>, String> {
    let tasks = AgentOrgTaskStore::list(&context.run_id)?;
    let owner_member_ids: Vec<String> =
        tasks.iter().filter_map(|task| task.owner.clone()).collect();
    let owner_runtimes: HashMap<String, WorkerSessionRuntime> =
        AgentOrgRunStore::list_worker_sessions_by_member_ids(&context.run_id, &owner_member_ids)?
            .into_iter()
            .filter_map(|session| {
                session
                    .member_id
                    .clone()
                    .map(|member_id| (member_id, session))
            })
            .collect();

    let members_by_id: HashMap<String, AgentOrgContextMember> = context
        .members
        .iter()
        .cloned()
        .map(|member| (member.member_id.clone(), member))
        .collect();

    Ok(tasks
        .into_iter()
        .map(|task| AgentOrgTaskRuntime {
            owner_member: task
                .owner
                .as_ref()
                .and_then(|owner| members_by_id.get(owner).cloned()),
            owner_runtime: task
                .owner
                .as_ref()
                .and_then(|owner| owner_runtimes.get(owner).cloned()),
            task,
        })
        .collect())
}

fn inbox_display_name(
    context: &AgentOrgRunContext,
    member_id: Option<&str>,
    system_fallback: &str,
) -> String {
    match member_id {
        Some(member_id) => context
            .participant_display_name(member_id)
            .unwrap_or_else(|| member_id.to_string()),
        None => system_fallback.to_string(),
    }
}

fn plain_payload_text(row: &AgentInboxRecord) -> String {
    match serde_json::from_str::<AgentMessage>(&row.payload_json) {
        Ok(AgentMessage::Plain { text, .. }) => text.trim().to_string(),
        _ => String::new(),
    }
}

fn inbox_display_text(row: &AgentInboxRecord, recipient_name: &str) -> String {
    let text = plain_payload_text(row);
    if row.sender_agent_id != USER_SENDER_ID || row.payload_kind != "plain" {
        return text;
    }
    if row.recipient_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID) || text.starts_with('@') {
        return text;
    }
    format!("@{} {}", recipient_name.trim(), text)
        .trim()
        .to_string()
}

fn enrich_inbox_rows(
    context: &AgentOrgRunContext,
    rows: Vec<AgentInboxRecord>,
) -> Vec<AgentOrgInboxRuntimeRow> {
    rows.into_iter()
        .map(|row| {
            let recipient_name = inbox_display_name(
                context,
                row.recipient_member_id.as_deref(),
                &row.recipient_agent_id,
            );
            let sender_fallback = if row.sender_agent_id == SYSTEM_SENDER_ID {
                "system"
            } else if row.sender_agent_id == USER_SENDER_ID {
                "User"
            } else {
                row.sender_agent_id.as_str()
            };
            let sender_name =
                inbox_display_name(context, row.sender_member_id.as_deref(), sender_fallback);
            let display_text = inbox_display_text(&row, &recipient_name);
            AgentOrgInboxRuntimeRow {
                recipient_name,
                sender_name,
                display_text,
                row,
            }
        })
        .collect()
}

fn coordinator_member_view(
    context: &AgentOrgRunContext,
    runtime: Option<WorkerSessionRuntime>,
    tasks: &[AgentOrgTaskRuntime],
    inbox: &[AgentInboxRecord],
) -> Result<AgentOrgRunMemberView, String> {
    member_view_from_parts(
        context,
        AgentOrgMemberViewIdentity {
            member_id: COORDINATOR_MEMBER_ID.to_string(),
            name: context.coordinator_name.clone(),
            role: context.coordinator_role.clone(),
            agent_id: context.coordinator_agent_id.clone(),
            parent_member_id: None,
            is_coordinator: true,
        },
        runtime,
        tasks,
        inbox,
    )
}

fn member_view(
    context: &AgentOrgRunContext,
    member: &AgentOrgContextMember,
    runtime: Option<WorkerSessionRuntime>,
    tasks: &[AgentOrgTaskRuntime],
    inbox: &[AgentInboxRecord],
) -> Result<AgentOrgRunMemberView, String> {
    member_view_from_parts(
        context,
        AgentOrgMemberViewIdentity {
            member_id: member.member_id.clone(),
            name: member.name.clone(),
            role: member.role.clone(),
            agent_id: member.agent_id.clone(),
            parent_member_id: member.parent_member_id.clone(),
            is_coordinator: false,
        },
        runtime,
        tasks,
        inbox,
    )
}

struct AgentOrgMemberViewIdentity {
    member_id: String,
    name: String,
    role: String,
    agent_id: String,
    parent_member_id: Option<String>,
    is_coordinator: bool,
}

fn member_view_from_parts(
    context: &AgentOrgRunContext,
    identity: AgentOrgMemberViewIdentity,
    session_runtime: Option<WorkerSessionRuntime>,
    tasks: &[AgentOrgTaskRuntime],
    inbox: &[AgentInboxRecord],
) -> Result<AgentOrgRunMemberView, String> {
    let AgentOrgMemberViewIdentity {
        member_id,
        name,
        role,
        agent_id,
        parent_member_id,
        is_coordinator,
    } = identity;
    let inbox_activity_count = inbox
        .iter()
        .filter(|row| {
            if is_coordinator {
                row.recipient_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID)
            } else {
                row.recipient_member_id.as_deref() == Some(member_id.as_str())
            }
        })
        .count();
    let unread_inbox_count = inbox
        .iter()
        .filter(|row| {
            row.read_at.is_none()
                && if is_coordinator {
                    row.recipient_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID)
                } else {
                    row.recipient_member_id.as_deref() == Some(member_id.as_str())
                }
        })
        .count();
    let task_owner_id = if is_coordinator {
        COORDINATOR_MEMBER_ID
    } else {
        member_id.as_str()
    };
    let pending_task_count = tasks
        .iter()
        .filter(|item| {
            item.task.owner.as_deref() == Some(task_owner_id)
                && item.task.status == TaskStatus::Pending
        })
        .count();
    let in_progress_task_count = tasks
        .iter()
        .filter(|item| {
            item.task.owner.as_deref() == Some(task_owner_id)
                && item.task.status == TaskStatus::InProgress
        })
        .count();
    let active_task_count = pending_task_count + in_progress_task_count;
    let completed_task_count = tasks
        .iter()
        .filter(|item| {
            item.task.owner.as_deref() == Some(task_owner_id)
                && item.task.status == TaskStatus::Completed
        })
        .count();
    let intervention = match session_runtime
        .as_ref()
        .and_then(|runtime| runtime.intervention.clone())
    {
        Some(record) => Some(record),
        None => AgentMemberInterventionStore::active_for_member(&context.run_id, &member_id)?,
    };

    Ok(AgentOrgRunMemberView {
        member_id,
        name,
        role,
        agent_id,
        parent_member_id,
        is_coordinator,
        session_runtime,
        unread_inbox_count,
        inbox_activity_count,
        active_task_count,
        pending_task_count,
        in_progress_task_count,
        completed_task_count,
        intervention,
    })
}

async fn session_org_read_context(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Option<SessionOrgReadContext>, String> {
    if let Some(session) = state.get_session(session_id).await {
        if let Some(runtime) = session.runtime.read().await.clone() {
            let context = agent_org_context_for_session(
                state,
                session_id,
                runtime.agent_org_context.as_ref(),
            )?;
            let member_id = persistence::get_session(session_id)
                .map_err(|err| err.to_string())?
                .and_then(|record| record.org_member_id);
            return Ok(Some(SessionOrgReadContext { context, member_id }));
        }
    }

    let persisted = persistence::get_session(session_id).map_err(|err| err.to_string())?;
    if let Some(record) = persisted {
        let context = agent_org_context_for_session(state, session_id, None)?;
        return Ok(Some(SessionOrgReadContext {
            context,
            member_id: record.org_member_id,
        }));
    }

    let Some(member_id) = cli_member_id_for_session(session_id)? else {
        return Ok(None);
    };
    let context = agent_org_context_for_session(state, session_id, None)?;
    Ok(Some(SessionOrgReadContext { context, member_id }))
}

fn cli_member_id_for_session(session_id: &str) -> Result<Option<Option<String>>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    conn.query_row(
        "SELECT org_member_id FROM code_sessions WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn agent_org_context_for_session(
    state: &AgentAppState,
    session_id: &str,
    runtime_context: Option<&AgentOrgRunContext>,
) -> Result<Option<AgentOrgRunContext>, String> {
    if let Some(context) = runtime_context {
        return Ok(Some(context.clone()));
    }

    let Some(handle) = state.app_handle.as_ref() else {
        return Ok(None);
    };

    use tauri::Manager;
    let org_store = handle.state::<std::sync::Arc<AgentOrgsStore>>();
    AgentOrgRunStore::context_for_session_with_parent_walk(session_id, org_store.inner())
}

fn require_session_member_id(
    read_context: &SessionOrgReadContext,
    session_id: &str,
) -> Result<String, String> {
    read_context
        .member_id
        .clone()
        .ok_or_else(|| format!("Agent Org session {session_id} has no canonical member_id"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_inbox::AgentMessage;
    use crate::definitions::orgs::HierarchyMode;

    fn context_with_shared_member_agent_id() -> AgentOrgRunContext {
        AgentOrgRunContext {
            run_id: "run-shared-agent".to_string(),
            org_id: "org-shared-agent".to_string(),
            org_name: "Shared Agent Org".to_string(),
            org_role: "Coordinate shared backend members".to_string(),
            coordinator_agent_id: "builtin:sde".to_string(),
            coordinator_name: "Coordinator".to_string(),
            coordinator_role: "Lead".to_string(),
            members: vec![
                AgentOrgContextMember {
                    member_id: "member-planner".to_string(),
                    name: "Planner".to_string(),
                    role: "Plan work".to_string(),
                    agent_id: "builtin:sde".to_string(),
                    parent_member_id: None,
                },
                AgentOrgContextMember {
                    member_id: "member-builder".to_string(),
                    name: "Builder".to_string(),
                    role: "Build work".to_string(),
                    agent_id: "builtin:sde".to_string(),
                    parent_member_id: Some("member-planner".to_string()),
                },
            ],
            hierarchy_mode: HierarchyMode::Strict,
            plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
            root_session_id: Some("root-shared-agent".to_string()),
        }
    }

    fn inbox_record(
        sender_member_id: Option<&str>,
        recipient_member_id: Option<&str>,
    ) -> AgentInboxRecord {
        AgentInboxRecord {
            id: 7,
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: recipient_member_id.map(str::to_string),
            sender_agent_id: "builtin:sde".to_string(),
            sender_member_id: sender_member_id.map(str::to_string),
            org_run_id: Some("run-shared-agent".to_string()),
            payload_kind: "plain".to_string(),
            payload_json: serde_json::to_string(&AgentMessage::Plain {
                summary: "Ready".to_string(),
                text: "Ready for review".to_string(),
            })
            .expect("serialize payload"),
            request_id: None,
            created_at: "2026-05-28T00:00:00Z".to_string(),
            read_at: None,
        }
    }

    #[test]
    fn inbox_row_names_prefer_member_ids_when_agents_share_backend() {
        let context = context_with_shared_member_agent_id();
        let rows = enrich_inbox_rows(
            &context,
            vec![inbox_record(Some("member-builder"), Some("member-planner"))],
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sender_name, "Builder");
        assert_eq!(rows[0].recipient_name, "Planner");
    }

    #[test]
    fn inbox_row_names_resolve_coordinator_member_id_before_agent_id() {
        let context = context_with_shared_member_agent_id();
        let rows = enrich_inbox_rows(
            &context,
            vec![inbox_record(
                Some(COORDINATOR_MEMBER_ID),
                Some("member-builder"),
            )],
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sender_name, "Coordinator");
        assert_eq!(rows[0].recipient_name, "Builder");
    }

    fn task_for_resume(owner: Option<&str>, status: TaskStatus) -> Task {
        Task {
            id: "resume-task".to_string(),
            org_run_id: "run-shared-agent".to_string(),
            subject: "Resume work".to_string(),
            description: "Continue after pause".to_string(),
            active_form: None,
            owner: owner.map(str::to_string),
            status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
            created_at: "2026-05-28T00:00:00Z".to_string(),
            updated_at: "2026-05-28T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn run_phase_projects_all_completed_running_board_as_finalizing() {
        let task = AgentOrgTaskRuntime {
            task: task_for_resume(Some("member-builder"), TaskStatus::Completed),
            owner_member: None,
            owner_runtime: None,
        };
        assert_eq!(
            project_run_phase(AgentOrgRunStatus::Running, &[], &[task], &[], &[]),
            AgentOrgRunPhase::Finalizing
        );
        assert_eq!(
            project_run_phase(AgentOrgRunStatus::Completed, &[], &[], &[], &[]),
            AgentOrgRunPhase::Completed
        );
    }

    #[test]
    fn run_phase_projects_quiet_user_plan_gate_as_awaiting_approval() {
        let task = AgentOrgTaskRuntime {
            task: task_for_resume(Some("member-planner"), TaskStatus::InProgress),
            owner_member: None,
            owner_runtime: None,
        };
        let approval = AgentOrgPlanApproval {
            approval_id: "approval-1".to_string(),
            plan_revision_id: "revision-1".to_string(),
            request_id: "request-1".to_string(),
            org_run_id: "run-shared-agent".to_string(),
            source_task_id: task.task.id.clone(),
            source_member_id: "member-planner".to_string(),
            source_session_id: "planner-session".to_string(),
            root_session_id: "root-shared-agent".to_string(),
            policy: crate::definitions::orgs::PlanApprovalPolicy::User,
            status:
                crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStatus::Pending,
            plan_title: "Plan".to_string(),
            plan_path: "/tmp/plan.md".to_string(),
            plan_content: "# Plan".to_string(),
            decision_by: None,
            feedback: None,
            created_at: "2026-05-28T00:00:00Z".to_string(),
            resolved_at: None,
        };
        assert_eq!(
            project_run_phase(AgentOrgRunStatus::Running, &[], &[task], &[], &[approval]),
            AgentOrgRunPhase::AwaitingPlanApproval
        );
    }

    #[test]
    fn resume_wake_requires_unread_inbox() {
        assert_eq!(should_wake_member_for_progress(false), None);
        assert_eq!(
            should_wake_member_for_progress(true),
            Some(AgentOrgWakeReason::UnreadInbox)
        );
    }

    #[test]
    fn group_chat_target_clear_exits_direct_intervention() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db connection");
        crate::coordination::agent_member_interventions::init_schema(&conn)
            .expect("intervention schema");
        let context = context_with_shared_member_agent_id();

        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: context.run_id.clone(),
            member_id: "member-planner".to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "planner-session".to_string(),
            reason: Some("direct_user_chat".to_string()),
            ttl_secs: 60,
        })
        .expect("enter intervention");
        assert!(
            AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
                .expect("active before clear")
                .is_some()
        );

        let cleared = clear_group_chat_target_intervention(&context, "member-planner")
            .expect("clear group chat target intervention");

        assert!(cleared);
        assert!(
            AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
                .expect("active after clear")
                .is_none()
        );
    }
}
