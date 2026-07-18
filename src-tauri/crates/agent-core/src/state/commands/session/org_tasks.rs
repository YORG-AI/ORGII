use std::collections::HashMap;
use std::sync::atomic::Ordering;

use std::time::{Duration, Instant};

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::coordination::agent_inbox::{
    AgentInboxPreviewRecord, AgentInboxRecipientCounts, AgentInboxRecord, AgentInboxStore,
    AgentInboxUnreadRecipientCounts, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
    USER_SENDER_ID,
};
use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionRecord, AgentMemberInterventionStore,
    EnterMemberInterventionParams, DEFAULT_INTERVENTION_TTL_SECS,
};
use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanApproval, AgentOrgPlanApprovalStore, AgentOrgPlanApprovalSummary,
    AgentOrgPlanDecisionBy, AgentOrgPlanInboxDelivery,
};
use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunStatus, AgentOrgRunStore,
    WorkerSessionRuntime, COORDINATOR_MEMBER_ID,
};
#[cfg(test)]
use crate::coordination::agent_org_tasks::TaskStatus;
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, Task, TaskExecutionMode, TaskSummary,
};
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
    /// The frequently-polled Run View carries only a description preview.
    /// Fetch `task_get` when this flag is true and full task context is needed.
    pub description_truncated: bool,
    pub blocks_truncated: bool,
    pub blocked_by_truncated: bool,
    pub execution_mode: TaskExecutionMode,
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
pub struct AgentOrgGroupChatHistoryRow {
    pub inbox_id: i64,
    pub target_member_id: Option<String>,
    pub target_member_name: String,
    pub text: String,
    pub display_text: String,
    pub created_at: String,
    pub read_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupChatHistoryPage {
    pub rows: Vec<AgentOrgGroupChatHistoryRow>,
    pub has_more: bool,
    pub next_before_id: Option<i64>,
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

/// Lightweight inbox activity projected in the frequently-polled Run View.
/// The durable `payload_json` remains in `agent_inbox` and in direct command
/// responses, but is deliberately omitted here so a large message is not
/// copied over the Tauri bridge on every refresh.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgInboxPreviewRow {
    pub id: i64,
    pub recipient_agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_member_id: Option<String>,
    pub sender_agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_member_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_run_id: Option<String>,
    pub payload_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_resolution: Option<String>,
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
    pub task_overview: AgentOrgRunTaskOverview,
    pub inbox: Vec<AgentOrgInboxPreviewRow>,
    pub unread_inbox_count: usize,
    pub pending_plan_approvals: Vec<AgentOrgPlanApprovalSummary>,
}

/// Exact task totals plus the bounded window carried by the frequently-polled
/// Run View. Full task detail remains available through `task_get`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunTaskOverview {
    pub total: usize,
    pub pending: usize,
    pub in_progress: usize,
    pub completed: usize,
    pub corrupt: usize,
    pub visible: usize,
    pub truncated: bool,
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

/// The Run View is a live operational snapshot, not an inbox-history API.
/// Keep the bridge payload bounded; durable history remains available through
/// the explicitly paginated inbox/history surfaces.
const RUN_VIEW_INBOX_LIMIT: usize = 200;
const RUN_VIEW_TASK_LIMIT: usize = 200;
const GROUP_CHAT_HISTORY_PAGE_LIMIT: usize = 100;
const GROUP_CHAT_HISTORY_PAGE_MAX_BYTES: usize = 1024 * 1024;

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
    let Some(context) = read_context.context.as_ref() else {
        return Ok(None);
    };
    let current_member_id = require_session_member_id(&read_context, session_id)?;
    let context = context.clone();

    // Group Chat polls this command while it is visible. SQLite reads and
    // snapshot projection are synchronous, so keep them off the async/Tauri
    // executor. This remains a pure read: reconciliation belongs to the
    // watchdog or an explicit completion command.
    let view =
        tokio::task::spawn_blocking(move || build_agent_org_run_view(&context, current_member_id))
            .await
            .map_err(|err| format!("Agent Org Run View worker failed: {err}"))??;

    Ok(Some(view))
}

/// Read-only, cursor-paged source of truth for user messages sent through the
/// Agent Org Group Chat. Run View deliberately carries only previews; this
/// command is the durable reload/history surface and remains readable after a
/// run reaches a terminal state.
#[tauri::command]
pub async fn agent_org_group_chat_history_page(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    before_id: Option<i64>,
    limit: Option<usize>,
) -> Result<AgentOrgGroupChatHistoryPage, String> {
    agent_org_group_chat_history_page_impl(&state, &session_id, before_id, limit).await
}

pub async fn agent_org_group_chat_history_page_impl(
    state: &AgentAppState,
    session_id: &str,
    before_id: Option<i64>,
    limit: Option<usize>,
) -> Result<AgentOrgGroupChatHistoryPage, String> {
    if before_id.is_some_and(|id| id <= 0) {
        return Err("before_id must be a positive Inbox row id".to_string());
    }
    let Some(read_context) = session_org_read_context(state, session_id).await? else {
        return Err(format!(
            "Session {session_id} is not part of an Agent Org run"
        ));
    };
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let bounded_limit = limit
        .unwrap_or(GROUP_CHAT_HISTORY_PAGE_LIMIT)
        .clamp(1, GROUP_CHAT_HISTORY_PAGE_LIMIT);
    tokio::task::spawn_blocking(move || {
        load_group_chat_history_page(&context, before_id, bounded_limit)
    })
    .await
    .map_err(|error| format!("Agent Org Group Chat history worker failed: {error}"))?
}

fn load_group_chat_history_page(
    context: &AgentOrgRunContext,
    before_id: Option<i64>,
    limit: usize,
) -> Result<AgentOrgGroupChatHistoryPage, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT inbox.id,
                    CASE WHEN inbox.recipient_member_id IS NULL THEN NULL
                         WHEN length(CAST(inbox.recipient_member_id AS BLOB))<=?7
                         THEN substr(inbox.recipient_member_id, 1, ?8)
                         ELSE NULL END AS recipient_member_id,
                    CASE
                      WHEN length(CAST(inbox.payload_json AS BLOB))<=?4
                       AND json_valid(inbox.payload_json)
                       AND json_extract(inbox.payload_json, '$.kind')='plain'
                       AND json_type(inbox.payload_json, '$.text')='text'
                      THEN substr(json_extract(inbox.payload_json, '$.text'), 1, ?5)
                      ELSE NULL
                    END AS message_text,
                    CASE WHEN inbox.display_text IS NOT NULL
                                   AND length(CAST(inbox.display_text AS BLOB))<=?6
                         THEN substr(inbox.display_text, 1, ?5)
                         ELSE NULL END AS display_text,
                    substr(inbox.created_at, 1, 64),
                    CASE WHEN inbox.read_at IS NULL THEN NULL ELSE substr(inbox.read_at, 1, 64) END,
                    resolution.resolution_kind
             FROM agent_inbox inbox
             LEFT JOIN agent_inbox_delivery_resolutions resolution
               ON resolution.inbox_id=inbox.id
             WHERE inbox.org_run_id=?1
               AND inbox.sender_agent_id=?2
               AND inbox.payload_kind='plain'
               AND (?3 IS NULL OR inbox.id<?3)
             ORDER BY inbox.id DESC
             LIMIT ?9",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                &context.run_id,
                USER_SENDER_ID,
                before_id,
                crate::coordination::agent_org_payload_limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
                (crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_CHARS + 1) as i64,
                crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_BYTES as i64,
                crate::coordination::agent_org_payload_limits::MESSAGE_IDENTIFIER_MAX_BYTES as i64,
                (crate::coordination::agent_org_payload_limits::MESSAGE_IDENTIFIER_MAX_CHARS + 1)
                    as i64,
                (limit + 1) as i64,
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;

    let mut newest_first = Vec::new();
    let mut serialized_bytes = 2usize;
    let mut has_more = false;
    for row in rows {
        let (
            inbox_id,
            target_member_id,
            text,
            stored_display_text,
            created_at,
            read_at,
            delivery_resolution,
        ) = row.map_err(|err| err.to_string())?;
        if newest_first.len() == limit {
            has_more = true;
            break;
        }
        let target_member_id = target_member_id.filter(|value| {
            crate::coordination::agent_org_payload_limits::validate_message_identifier(
                "group_chat_history.target_member_id",
                value,
            )
            .is_ok()
        });
        let target_member_name = target_member_id
            .as_deref()
            .and_then(|member_id| context.participant_display_name(member_id))
            .or_else(|| target_member_id.clone())
            .filter(|value| {
                crate::coordination::agent_org_payload_limits::validate_text_len(
                    "group_chat_history.target_member_name",
                    value,
                    crate::coordination::agent_org_payload_limits::MEMBER_DISPLAY_NAME_MAX_CHARS,
                    crate::coordination::agent_org_payload_limits::MEMBER_DISPLAY_NAME_MAX_BYTES,
                )
                .is_ok()
            })
            .unwrap_or_else(|| "Unknown recipient".to_string());
        let text = text
            .filter(|value| {
                crate::coordination::agent_org_payload_limits::validate_text_len(
                    "group_chat_history.text",
                    value,
                    crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_CHARS,
                    crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_BYTES,
                )
                .is_ok()
            })
            .unwrap_or_else(|| {
                format!(
                    "[Inbox row {inbox_id} contains an unreadable or oversized historical Group Chat message]"
                )
            });
        let display_text = stored_display_text.unwrap_or_else(|| {
            if target_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID) {
                text.clone()
            } else {
                format!("@{target_member_name} {text}")
            }
        });
        let history_row = AgentOrgGroupChatHistoryRow {
            inbox_id,
            target_member_id,
            target_member_name,
            text,
            display_text,
            created_at,
            read_at,
            delivery_resolution,
        };
        let row_bytes = serde_json::to_vec(&history_row)
            .map_err(|err| format!("serialize Group Chat history row failed: {err}"))?
            .len();
        let separator = usize::from(!newest_first.is_empty());
        if serialized_bytes
            .saturating_add(separator)
            .saturating_add(row_bytes)
            > GROUP_CHAT_HISTORY_PAGE_MAX_BYTES
        {
            has_more = true;
            break;
        }
        serialized_bytes = serialized_bytes
            .saturating_add(separator)
            .saturating_add(row_bytes);
        newest_first.push(history_row);
    }
    newest_first.reverse();
    let next_before_id = has_more
        .then(|| newest_first.first().map(|row| row.inbox_id))
        .flatten();
    Ok(AgentOrgGroupChatHistoryPage {
        rows: newest_first,
        has_more,
        next_before_id,
    })
}

fn build_agent_org_run_view(
    context: &AgentOrgRunContext,
    current_member_id: String,
) -> Result<AgentOrgRunView, String> {
    let mut conn = get_connection().map_err(|err| err.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
        .map_err(|err| err.to_string())?;
    let finality = AgentOrgRunStore::finality_assessment_with_connection(&tx, &context.run_id)?;
    let run_status_value = finality
        .facts
        .run_status
        .ok_or_else(|| format!("Agent Org run {} no longer exists", context.run_id))?;
    let run_status = run_status_value.as_str().to_string();

    let task_page = AgentOrgTaskStore::list_summary_page_with_connection(
        &tx,
        &context.run_id,
        None,
        None,
        None,
        RUN_VIEW_TASK_LIMIT,
    )?;
    let task_overview = AgentOrgRunTaskOverview {
        total: finality.facts.task_count,
        pending: finality.facts.pending_task_count,
        in_progress: finality.facts.in_progress_task_count,
        completed: finality.facts.completed_task_count,
        corrupt: finality.facts.corrupt_task_count,
        visible: task_page.tasks.len(),
        truncated: task_page.has_more,
    };
    let member_task_counts = task_counts_by_owner_with_connection(&tx, &context.run_id)?;
    let inbox_records = AgentInboxStore::list_recent_previews_by_run_with_connection(
        &tx,
        &context.run_id,
        RUN_VIEW_INBOX_LIMIT,
    )?;
    let unread_inbox_counts =
        AgentInboxStore::unread_counts_by_recipient_with_connection(&tx, &context.run_id)?;
    let inbox_counts = bounded_run_view_inbox_counts(&inbox_records, &unread_inbox_counts);
    let member_ids: Vec<String> = context
        .members
        .iter()
        .map(|member| member.member_id.clone())
        .collect();
    let member_runtimes: HashMap<String, WorkerSessionRuntime> =
        AgentOrgRunStore::list_worker_sessions_by_member_ids_with_connection(
            &tx,
            &context.run_id,
            &member_ids,
        )?
        .into_iter()
        .filter_map(|session| {
            session
                .member_id
                .clone()
                .map(|member_id| (member_id, session))
        })
        .collect();
    let active_interventions: HashMap<String, AgentMemberInterventionRecord> =
        AgentMemberInterventionStore::list_active_with_connection(&tx, &context.run_id)?
            .into_iter()
            .map(|record| (record.member_id.clone(), record))
            .collect();

    let coordinator_runtime =
        AgentOrgRunStore::find_coordinator_session_by_member_id_with_connection(
            &tx,
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
            intervention: None,
        });

    let tasks = tasks_for_context(context, task_page.tasks, &member_runtimes);

    let mut members = Vec::with_capacity(context.members.len() + 1);
    members.push(coordinator_member_view(
        context,
        coordinator_runtime,
        &member_task_counts,
        &inbox_counts,
        &active_interventions,
    )?);
    for member in &context.members {
        members.push(member_view(
            member,
            member_runtimes.get(&member.member_id).cloned(),
            &member_task_counts,
            &inbox_counts,
            &active_interventions,
        )?);
    }

    let inbox = enrich_inbox_preview_rows(context, inbox_records);
    let pending_plan_approvals =
        AgentOrgPlanApprovalStore::list_pending_summaries_by_run_with_connection(
            &tx,
            &context.run_id,
        )?;

    let run_phase = project_run_phase(
        run_status_value,
        &members,
        &task_overview,
        finality.facts.unread_inbox_count,
        &pending_plan_approvals,
    );

    tx.commit().map_err(|err| err.to_string())?;

    Ok(AgentOrgRunView {
        current_member_id: Some(current_member_id),
        context: context.clone(),
        run_status,
        run_phase,
        members,
        tasks,
        task_overview,
        inbox,
        unread_inbox_count: finality.facts.unread_inbox_count,
        pending_plan_approvals,
    })
}

fn project_run_phase(
    run_status: AgentOrgRunStatus,
    members: &[AgentOrgRunMemberView],
    task_overview: &AgentOrgRunTaskOverview,
    unread_inbox_count: usize,
    pending_plan_approvals: &[AgentOrgPlanApprovalSummary],
) -> AgentOrgRunPhase {
    match run_status {
        AgentOrgRunStatus::Paused => AgentOrgRunPhase::Paused,
        AgentOrgRunStatus::Completed => AgentOrgRunPhase::Completed,
        AgentOrgRunStatus::Failed => AgentOrgRunPhase::Failed,
        AgentOrgRunStatus::Cancelled => AgentOrgRunPhase::Cancelled,
        AgentOrgRunStatus::Abandoned => AgentOrgRunPhase::Abandoned,
        AgentOrgRunStatus::Running => {
            let all_tasks_completed = task_overview.total > 0
                && task_overview.pending == 0
                && task_overview.in_progress == 0
                && task_overview.corrupt == 0;
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
            if unread_inbox_count > 0 {
                return AgentOrgRunPhase::Dispatching;
            }
            if task_overview.pending > 0
                || task_overview.in_progress > 0
                || task_overview.corrupt > 0
            {
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
pub async fn agent_org_plan_approval_detail(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    approval_id: String,
    plan_revision_id: String,
) -> Result<AgentOrgPlanApproval, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Err(format!(
            "Session {session_id} is not part of an Agent Org run"
        ));
    };
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let lookup_approval_id = approval_id.clone();
    let lookup_revision_id = plan_revision_id.clone();
    let lookup_run_id = context.run_id.clone();
    let approval = tokio::task::spawn_blocking(move || {
        AgentOrgPlanApprovalStore::get_revision_for_run(
            &lookup_run_id,
            &lookup_approval_id,
            &lookup_revision_id,
        )
    })
    .await
    .map_err(|err| format!("Agent Org plan approval detail worker failed: {err}"))??
    .ok_or_else(|| {
        format!("Agent Org plan approval revision was not found: {approval_id}/{plan_revision_id}")
    })?;
    Ok(approval)
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
    let feedback = match decision {
        AgentOrgPlanApprovalDecision::RequestChanges => Some(
            feedback
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "request_changes requires non-empty feedback".to_string())?
                .to_string(),
        ),
        _ => None,
    };
    let run_id = context.run_id.clone();
    let blocking_run_id = run_id.clone();
    let blocking_approval_id = approval_id.clone();
    let blocking_revision_id = plan_revision_id.clone();
    let blocking_context = context.clone();

    // Approval edits can touch SQLite and the plan artifact. Execute the
    // complete durable decision off Tokio's async executor; only dispatch
    // wake signals after the store transaction has committed.
    let (resolved, wake_member_ids, should_reconcile) = tokio::task::spawn_blocking(
        move || -> Result<(AgentOrgPlanApproval, Vec<String>, bool), String> {
            let approval =
                AgentOrgPlanApprovalStore::get(&blocking_approval_id)?.ok_or_else(|| {
                    format!("Agent Org plan approval {blocking_approval_id} was not found")
                })?;
            if approval.org_run_id != blocking_run_id {
                return Err("Agent Org plan approval does not belong to this run".to_string());
            }

            match decision {
                AgentOrgPlanApprovalDecision::Approve
                | AgentOrgPlanApprovalDecision::ApproveWithEdits => {
                    let approved = AgentOrgPlanApprovalStore::approve(
                        &blocking_approval_id,
                        &blocking_revision_id,
                        AgentOrgPlanDecisionBy::User,
                        edited_content,
                    )?;
                    Ok((approved.approval, approved.wake_member_ids, true))
                }
                AgentOrgPlanApprovalDecision::RequestChanges => {
                    let feedback = feedback.as_deref().ok_or_else(|| {
                        "request_changes feedback disappeared before commit".to_string()
                    })?;
                    let recipient_agent_id = blocking_context
                        .participant_agent_id(&approval.source_member_id)
                        .ok_or_else(|| {
                            format!(
                                "Agent Org plan source member {} is not in the run roster",
                                approval.source_member_id
                            )
                        })?;
                    let (changed, _) = AgentOrgPlanApprovalStore::request_changes(
                        &blocking_approval_id,
                        &blocking_revision_id,
                        AgentOrgPlanDecisionBy::User,
                        feedback,
                        AgentOrgPlanInboxDelivery {
                            recipient_agent_id,
                            sender_agent_id: USER_SENDER_ID.to_string(),
                            sender_member_id: None,
                        },
                    )?;
                    let source_member_id = changed.source_member_id.clone();
                    Ok((changed, vec![source_member_id], false))
                }
            }
        },
    )
    .await
    .map_err(|err| format!("Agent Org plan approval worker failed: {err}"))??;

    for member_id in wake_member_ids {
        wake_agent_org_member(app_handle.clone(), &member_id, &run_id);
    }
    if should_reconcile {
        let reconcile_run_id = run_id.clone();
        tokio::spawn(async move {
            match tokio::task::spawn_blocking(move || {
                AgentOrgRunStore::reconcile_run_finality(&reconcile_run_id)
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(err)) => tracing::warn!(
                    run_id,
                    error = %err,
                    "plan approval committed, but follow-up run reconciliation failed"
                ),
                Err(err) => tracing::warn!(
                    run_id,
                    error = %err,
                    "plan approval committed, but reconciliation worker failed"
                ),
            }
        });
    }
    Ok(resolved)
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
    boundary_id: Option<i64>,
) -> Result<(), String> {
    let Some(boundary_id) = boundary_id else {
        return Ok(());
    };

    let started_at = Instant::now();
    loop {
        let poll_run_id = run_id.to_string();
        let poll_member_id = member_id.to_string();
        let pending_count = tokio::task::spawn_blocking(move || {
            AgentInboxStore::unread_count_through_boundary(
                &poll_member_id,
                &poll_run_id,
                boundary_id,
            )
        })
        .await
        .map_err(|error| format!("Agent Org inbox acknowledgement poll failed: {error}"))??;
        if pending_count == 0 {
            return Ok(());
        }
        if started_at.elapsed() >= RETURN_TO_WORK_INBOX_ACK_TIMEOUT {
            return Err(format!(
                "Agent Org return-to-work wake did not drain {pending_count} inbox rows for member {member_id} through row {boundary_id}"
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
    agent_org_session_return_to_work_impl(&state, session_id).await
}

/// Production return-to-work implementation shared by the Tauri command and
/// the debug HTTP caller-path E2E bridge.
///
/// Keeping the implementation here (rather than recreating it in the test
/// API) is deliberate: both callers clear the same intervention state, enqueue
/// through [`send_message_impl_for_org_wake`], run the real session scheduler,
/// and wait for the production inbox drain to acknowledge exactly the rows
/// that were pending when the wake was requested.
pub async fn agent_org_session_return_to_work_impl(
    state: &AgentAppState,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;

    let pending_member_id = member_id.clone();
    let pending_run_id = context.run_id.clone();
    let (changed, pending_inbox_boundary) = tokio::task::spawn_blocking(move || {
        AgentMemberInterventionStore::clear_and_capture_unread_boundary(
            &pending_run_id,
            &pending_member_id,
        )
    })
    .await
    .map_err(|error| format!("Agent Org return-to-work state worker failed: {error}"))??;
    if changed || pending_inbox_boundary.is_some() {
        send_message_impl_for_org_wake(state, session_id, &context.run_id, &member_id).await?;
        wait_for_member_inbox_rows_read(&context.run_id, &member_id, pending_inbox_boundary)
            .await?;
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
    display_text: Option<String>,
) -> Result<AgentOrgGroupChatMessageResponse, String> {
    agent_org_send_group_chat_message_impl_with_display(
        app_handle,
        &state,
        session_id,
        target_member_id,
        content,
        display_text,
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
    agent_org_send_group_chat_message_impl_with_display(
        app_handle,
        state,
        session_id,
        target_member_id,
        content,
        None,
    )
    .await
}

async fn agent_org_send_group_chat_message_impl_with_display(
    app_handle: tauri::AppHandle,
    state: &AgentAppState,
    session_id: String,
    target_member_id: Option<String>,
    content: String,
    display_text: Option<String>,
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

    let durable_context = view.context.clone();
    let durable_target_agent_id = target.agent_id.clone();
    let durable_target_member_id = target.member_id.clone();
    let durable_content = content.to_string();
    let durable_display_text = display_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if let Some(display_text) = durable_display_text.as_deref() {
        crate::coordination::agent_org_payload_limits::validate_required_text(
            "display_text",
            display_text,
            crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_BYTES,
        )?;
    }
    let row = tokio::task::spawn_blocking(move || {
        persist_group_chat_message(
            &durable_context,
            &durable_target_agent_id,
            &durable_target_member_id,
            &durable_content,
            durable_display_text.as_deref(),
        )
    })
    .await
    .map_err(|err| format!("Agent Org group message worker failed: {err}"))??;

    // The inbox row is already committed. Everything below is an acceleration
    // hint; reporting a post-commit wake/resume error as "message failed"
    // encourages callers to retry and duplicate the user's durable message.
    match resume_agent_org_context(&view.context, false).await {
        Ok(outcome) if outcome.transitioned => {
            if let Err(err) = clear_active_org_cancel_flags(state, &view.context).await {
                tracing::warn!(
                    run_id = %view.context.run_id,
                    error = %err,
                    "group message committed, but clearing stale cancel flags failed"
                );
            }
            schedule_run_progress_wakes(app_handle.clone(), &view.context);
        }
        Ok(outcome) if outcome.run_is_running => {
            wake_agent_org_member(app_handle, &target.member_id, &view.context.run_id);
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(
                run_id = %view.context.run_id,
                error = %err,
                "group message committed, but automatic run resume failed"
            );
            wake_agent_org_member(app_handle, &target.member_id, &view.context.run_id);
        }
    }

    let inbox_row = enrich_inbox_row(&view.context, row);

    Ok(AgentOrgGroupChatMessageResponse {
        target_member_id: target.member_id.clone(),
        target_member_name: target.name.clone(),
        inbox_row,
    })
}

/// Persist the user's Group Chat message and clear the target member's direct
/// intervention as one state transition. The Run status is re-read inside the
/// same IMMEDIATE transaction so a stale Run View can never write into a Run
/// that became terminal before submission.
fn persist_group_chat_message(
    context: &AgentOrgRunContext,
    target_agent_id: &str,
    target_member_id: &str,
    content: &str,
    display_text: Option<&str>,
) -> Result<AgentInboxRecord, String> {
    with_sessions_writer(|| -> Result<AgentInboxRecord, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let run_status: Option<String> = tx
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id=?1",
                params![&context.run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        match run_status.as_deref() {
            Some("running" | "paused") => {}
            Some(status) => {
                return Err(format!(
                    "Agent Org run {} is {status}; terminal runs do not accept new group messages",
                    context.run_id
                ));
            }
            None => {
                return Err(format!("Agent Org run {} no longer exists", context.run_id));
            }
        }

        let row = AgentInboxStore::insert_in_tx(
            &tx,
            InsertInboxParams {
                recipient_agent_id: target_agent_id.to_string(),
                recipient_member_id: Some(target_member_id.to_string()),
                sender_agent_id: USER_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(context.run_id.clone()),
                message: AgentMessage::Plain {
                    summary: "User group chat message".to_string(),
                    text: content.to_string(),
                },
            },
        )?;
        if let Some(display_text) = display_text {
            tx.execute(
                "UPDATE agent_inbox SET display_text=?1 WHERE id=?2",
                params![display_text, row.id],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.execute(
            "UPDATE agent_member_interventions
             SET cleared_at=?3
             WHERE org_run_id=?1 AND member_id=?2 AND cleared_at IS NULL",
            params![
                &context.run_id,
                target_member_id,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(row)
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
    let org_run_id = view.context.run_id.clone();
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
        Some(org_run_id),
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

async fn clear_active_org_cancel_flags(
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
struct AgentOrgResumeOutcome {
    transitioned: bool,
    run_is_running: bool,
}

async fn resume_agent_org_context(
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

fn resume_agent_org_context_sync(
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

#[cfg(test)]
fn clear_group_chat_target_intervention(
    context: &AgentOrgRunContext,
    target_member_id: &str,
) -> Result<bool, String> {
    AgentMemberInterventionStore::clear(&context.run_id, target_member_id)
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
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
                   )
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

fn tasks_for_context(
    context: &AgentOrgRunContext,
    tasks: Vec<TaskSummary>,
    owner_runtimes: &HashMap<String, WorkerSessionRuntime>,
) -> Vec<AgentOrgTaskRuntime> {
    let members_by_id: HashMap<String, AgentOrgContextMember> = context
        .members
        .iter()
        .cloned()
        .map(|member| (member.member_id.clone(), member))
        .collect();

    tasks
        .into_iter()
        .map(|summary| {
            let owner_member = summary
                .owner
                .as_ref()
                .and_then(|owner| members_by_id.get(owner).cloned());
            let owner_runtime = summary
                .owner
                .as_ref()
                .and_then(|owner| owner_runtimes.get(owner).cloned());
            let execution_mode = summary.execution_mode;
            let task = Task {
                id: summary.id,
                org_run_id: context.run_id.clone(),
                subject: summary.subject,
                description: summary.description,
                active_form: summary.active_form,
                owner: summary.owner,
                status: summary.status,
                blocks: summary.blocks,
                blocked_by: summary.blocked_by,
                // Eligibility, role and output summaries are available from
                // `task_list`; full metadata/output content is intentionally
                // detail-only and never crosses the polling bridge.
                metadata: None,
                created_at: summary.created_at,
                updated_at: summary.updated_at,
            };

            AgentOrgTaskRuntime {
                task,
                description_truncated: summary.description_truncated,
                blocks_truncated: summary.blocks_truncated,
                blocked_by_truncated: summary.blocked_by_truncated,
                execution_mode,
                owner_member,
                owner_runtime,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default)]
struct MemberTaskCounts {
    pending: usize,
    in_progress: usize,
    completed: usize,
}

fn task_counts_by_owner_with_connection(
    conn: &rusqlite::Connection,
    org_run_id: &str,
) -> Result<HashMap<String, MemberTaskCounts>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT owner,
                    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0)
             FROM agent_org_tasks
             WHERE org_run_id=?1 AND owner IS NOT NULL
             GROUP BY owner",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![org_run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                MemberTaskCounts {
                    pending: row.get::<_, i64>(1)?.max(0) as usize,
                    in_progress: row.get::<_, i64>(2)?.max(0) as usize,
                    completed: row.get::<_, i64>(3)?.max(0) as usize,
                },
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.map(|row| row.map_err(|err| err.to_string())).collect()
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

#[cfg(test)]
fn enrich_inbox_rows(
    context: &AgentOrgRunContext,
    rows: Vec<AgentInboxRecord>,
) -> Vec<AgentOrgInboxRuntimeRow> {
    rows.into_iter()
        .map(|row| enrich_inbox_row(context, row))
        .collect()
}

fn enrich_inbox_row(
    context: &AgentOrgRunContext,
    row: AgentInboxRecord,
) -> AgentOrgInboxRuntimeRow {
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
    let sender_name = inbox_display_name(context, row.sender_member_id.as_deref(), sender_fallback);
    let display_text = inbox_display_text(&row, &recipient_name);
    AgentOrgInboxRuntimeRow {
        recipient_name,
        sender_name,
        display_text,
        row,
    }
}

fn enrich_inbox_preview_rows(
    context: &AgentOrgRunContext,
    rows: Vec<AgentInboxPreviewRecord>,
) -> Vec<AgentOrgInboxPreviewRow> {
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
            let mut display_text = row.display_preview.unwrap_or_default().trim().to_string();
            if row.sender_agent_id == USER_SENDER_ID
                && row.payload_kind == "plain"
                && row.recipient_member_id.as_deref() != Some(COORDINATOR_MEMBER_ID)
                && !display_text.starts_with('@')
            {
                display_text = format!("@{} {}", recipient_name.trim(), display_text)
                    .trim()
                    .to_string();
            }
            AgentOrgInboxPreviewRow {
                id: row.id,
                recipient_agent_id: row.recipient_agent_id,
                recipient_member_id: row.recipient_member_id,
                sender_agent_id: row.sender_agent_id,
                sender_member_id: row.sender_member_id,
                org_run_id: row.org_run_id,
                payload_kind: row.payload_kind,
                request_id: row.request_id,
                created_at: row.created_at,
                read_at: row.read_at,
                delivery_resolution: row.delivery_resolution,
                recipient_name,
                sender_name,
                display_text,
            }
        })
        .collect()
}

fn coordinator_member_view(
    context: &AgentOrgRunContext,
    runtime: Option<WorkerSessionRuntime>,
    task_counts: &HashMap<String, MemberTaskCounts>,
    inbox_counts: &[AgentInboxRecipientCounts],
    active_interventions: &HashMap<String, AgentMemberInterventionRecord>,
) -> Result<AgentOrgRunMemberView, String> {
    member_view_from_parts(
        AgentOrgMemberViewIdentity {
            member_id: COORDINATOR_MEMBER_ID.to_string(),
            name: context.coordinator_name.clone(),
            role: context.coordinator_role.clone(),
            agent_id: context.coordinator_agent_id.clone(),
            parent_member_id: None,
            is_coordinator: true,
        },
        runtime,
        task_counts,
        inbox_counts,
        active_interventions,
    )
}

fn member_view(
    member: &AgentOrgContextMember,
    runtime: Option<WorkerSessionRuntime>,
    task_counts: &HashMap<String, MemberTaskCounts>,
    inbox_counts: &[AgentInboxRecipientCounts],
    active_interventions: &HashMap<String, AgentMemberInterventionRecord>,
) -> Result<AgentOrgRunMemberView, String> {
    member_view_from_parts(
        AgentOrgMemberViewIdentity {
            member_id: member.member_id.clone(),
            name: member.name.clone(),
            role: member.role.clone(),
            agent_id: member.agent_id.clone(),
            parent_member_id: member.parent_member_id.clone(),
            is_coordinator: false,
        },
        runtime,
        task_counts,
        inbox_counts,
        active_interventions,
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
    identity: AgentOrgMemberViewIdentity,
    session_runtime: Option<WorkerSessionRuntime>,
    task_counts: &HashMap<String, MemberTaskCounts>,
    inbox_counts: &[AgentInboxRecipientCounts],
    active_interventions: &HashMap<String, AgentMemberInterventionRecord>,
) -> Result<AgentOrgRunMemberView, String> {
    let AgentOrgMemberViewIdentity {
        member_id,
        name,
        role,
        agent_id,
        parent_member_id,
        is_coordinator,
    } = identity;
    let (inbox_activity_count, unread_inbox_count) = inbox_counts
        .iter()
        // member_id is the only canonical Agent Org identity. A legacy row
        // without it remains visible in the bounded Run Inbox, but is not
        // copied onto every roster member that happens to share agent_id.
        .filter(|counts| counts.recipient_member_id.as_deref() == Some(member_id.as_str()))
        .fold((0usize, 0usize), |(activity, unread), counts| {
            (
                activity.saturating_add(counts.activity_count),
                unread.saturating_add(counts.unread_count),
            )
        });
    let task_owner_id = if is_coordinator {
        COORDINATOR_MEMBER_ID
    } else {
        member_id.as_str()
    };
    let counts = task_counts.get(task_owner_id).copied().unwrap_or_default();
    let pending_task_count = counts.pending;
    let in_progress_task_count = counts.in_progress;
    let active_task_count = pending_task_count + in_progress_task_count;
    let completed_task_count = counts.completed;
    let intervention = match session_runtime
        .as_ref()
        .and_then(|runtime| runtime.intervention.clone())
    {
        Some(record) => Some(record),
        None => active_interventions.get(&member_id).cloned(),
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

fn bounded_run_view_inbox_counts(
    recent_rows: &[AgentInboxPreviewRecord],
    unread_counts: &[AgentInboxUnreadRecipientCounts],
) -> Vec<AgentInboxRecipientCounts> {
    let mut counts_by_recipient: HashMap<(String, Option<String>), AgentInboxRecipientCounts> =
        HashMap::new();

    // Activity is intentionally the bounded Run View window, not an
    // unbounded lifetime total. Full history belongs to the paginated Inbox
    // surface; this projection is polled every few seconds.
    for row in recent_rows {
        let key = (
            row.recipient_agent_id.clone(),
            row.recipient_member_id.clone(),
        );
        let counts = counts_by_recipient
            .entry(key)
            .or_insert_with(|| AgentInboxRecipientCounts {
                recipient_agent_id: row.recipient_agent_id.clone(),
                recipient_member_id: row.recipient_member_id.clone(),
                activity_count: 0,
                unread_count: 0,
            });
        counts.activity_count = counts.activity_count.saturating_add(1);
    }

    // Unread totals must remain exact even when an old unread row falls
    // outside the recent activity window, so merge the unread-only index
    // query separately.
    for unread in unread_counts {
        let key = (
            unread.recipient_agent_id.clone(),
            unread.recipient_member_id.clone(),
        );
        let counts = counts_by_recipient
            .entry(key)
            .or_insert_with(|| AgentInboxRecipientCounts {
                recipient_agent_id: unread.recipient_agent_id.clone(),
                recipient_member_id: unread.recipient_member_id.clone(),
                activity_count: 0,
                unread_count: 0,
            });
        counts.unread_count = unread.unread_count;
    }

    let mut counts = counts_by_recipient.into_values().collect::<Vec<_>>();
    counts.sort_by(|left, right| {
        left.recipient_member_id
            .cmp(&right.recipient_member_id)
            .then_with(|| left.recipient_agent_id.cmp(&right.recipient_agent_id))
    });
    counts
}

async fn session_org_read_context(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Option<SessionOrgReadContext>, String> {
    let runtime_context = match state.get_session(session_id).await {
        Some(session) => session
            .runtime
            .read()
            .await
            .as_ref()
            .and_then(|runtime| runtime.agent_org_context.clone()),
        None => None,
    };
    let org_store = state.app_handle.as_ref().map(|handle| {
        use tauri::Manager;
        handle
            .state::<std::sync::Arc<AgentOrgsStore>>()
            .inner()
            .clone()
    });
    let session_id = session_id.to_string();

    // This helper is shared by every Agent Org Tauri command. Session and
    // parent-walk lookups are synchronous SQLite work, so resolve the whole
    // durable identity in one blocking job instead of stalling Tokio's async
    // executor at every call site.
    tokio::task::spawn_blocking(move || -> Result<Option<SessionOrgReadContext>, String> {
        let persisted = persistence::get_session(&session_id).map_err(|err| err.to_string())?;
        let member_id = match persisted.as_ref() {
            Some(record) => Some(record.org_member_id.clone()),
            None => {
                let conn = get_connection().map_err(|err| err.to_string())?;
                conn.query_row(
                    "SELECT org_member_id FROM code_sessions WHERE session_id = ?1",
                    params![&session_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?
            }
        };
        if persisted.is_none() && member_id.is_none() && runtime_context.is_none() {
            return Ok(None);
        }

        let context = match runtime_context {
            Some(context) => Some(context),
            None => match org_store {
                Some(store) => AgentOrgRunStore::context_for_session_with_parent_walk(
                    &session_id,
                    store.as_ref(),
                )?,
                None => None,
            },
        };
        Ok(Some(SessionOrgReadContext {
            context,
            member_id: member_id.flatten(),
        }))
    })
    .await
    .map_err(|err| format!("Agent Org session context worker failed: {err}"))?
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

    fn prepare_command_run(status: &str) -> AgentOrgRunContext {
        let context = context_with_shared_member_agent_id();
        let conn = get_connection().expect("db connection");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("inbox schema");
        crate::coordination::agent_member_interventions::init_schema(&conn)
            .expect("intervention schema");
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 org_snapshot_json, entry_mode, status, work_item_id,
                 project_slug, routine_fire_id, summary, last_error,
                 created_at, updated_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, 'standalone_session', ?5,
                       NULL, NULL, NULL, NULL, NULL, ?6, ?6, NULL)",
            params![
                &context.run_id,
                &context.org_id,
                &context.coordinator_agent_id,
                context.root_session_id.as_deref(),
                status,
                &now,
            ],
        )
        .expect("insert command test run");
        context
    }

    fn inbox_count_for_member(context: &AgentOrgRunContext, member_id: &str) -> usize {
        let conn = get_connection().expect("db connection");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_inbox
                 WHERE org_run_id=?1 AND recipient_member_id=?2",
                params![&context.run_id, member_id],
                |row| row.get(0),
            )
            .expect("count member inbox rows");
        usize::try_from(count).expect("non-negative inbox count")
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
        let overview = AgentOrgRunTaskOverview {
            total: 1,
            pending: 0,
            in_progress: 0,
            completed: 1,
            corrupt: 0,
            visible: 1,
            truncated: false,
        };
        assert_eq!(
            project_run_phase(AgentOrgRunStatus::Running, &[], &overview, 0, &[]),
            AgentOrgRunPhase::Finalizing
        );
        assert_eq!(
            project_run_phase(
                AgentOrgRunStatus::Completed,
                &[],
                &AgentOrgRunTaskOverview {
                    total: 0,
                    pending: 0,
                    in_progress: 0,
                    completed: 0,
                    corrupt: 0,
                    visible: 0,
                    truncated: false,
                },
                0,
                &[],
            ),
            AgentOrgRunPhase::Completed
        );
    }

    #[test]
    fn task_runtime_projects_execution_mode_on_the_wire() {
        let task = AgentOrgTaskRuntime {
            task: task_for_resume(Some("member-planner"), TaskStatus::Pending),
            description_truncated: false,
            blocks_truncated: false,
            blocked_by_truncated: false,
            execution_mode: TaskExecutionMode::Plan,
            owner_member: None,
            owner_runtime: None,
        };

        let value = serde_json::to_value(task).expect("serialize task runtime");
        assert_eq!(value["executionMode"], "plan");
    }

    #[test]
    fn run_view_task_omits_durable_metadata_and_output() {
        let context = context_with_shared_member_agent_id();
        let projected = tasks_for_context(
            &context,
            vec![TaskSummary {
                id: "resume-task".to_string(),
                subject: "Resume work".to_string(),
                description: "bounded description".to_string(),
                description_truncated: true,
                active_form: None,
                owner: Some("member-builder".to_string()),
                status: TaskStatus::Completed,
                blocks: Vec::new(),
                blocks_truncated: false,
                blocked_by: Vec::new(),
                blocked_by_truncated: false,
                eligible_member_ids: vec!["member-builder".to_string()],
                eligible_member_ids_truncated: false,
                required_role: None,
                execution_mode: TaskExecutionMode::Build,
                output: None,
                created_at: "2026-05-28T00:00:00Z".to_string(),
                updated_at: "2026-05-28T00:00:00Z".to_string(),
            }],
            &HashMap::new(),
        );
        assert_eq!(projected.len(), 1);
        assert!(projected[0].task.metadata.is_none());
        assert_eq!(projected[0].task.description, "bounded description");
        assert!(projected[0].description_truncated);
    }

    #[test]
    fn run_view_inbox_preview_omits_durable_payload_json() {
        let row = AgentOrgInboxPreviewRow {
            id: 7,
            recipient_agent_id: "agent-a".to_string(),
            recipient_member_id: Some("member-a".to_string()),
            sender_agent_id: USER_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some("run-a".to_string()),
            payload_kind: "plain".to_string(),
            request_id: None,
            created_at: "2026-05-28T00:00:00Z".to_string(),
            read_at: None,
            delivery_resolution: None,
            recipient_name: "Alice".to_string(),
            sender_name: "User".to_string(),
            display_text: "hello".to_string(),
        };

        let value = serde_json::to_value(row).expect("serialize inbox preview");
        assert!(value.get("payloadJson").is_none());
        assert_eq!(value["displayText"], "hello");
    }

    #[test]
    fn run_view_does_not_copy_legacy_agent_only_inbox_counts_to_shared_members() {
        let recent_rows = vec![
            AgentInboxPreviewRecord {
                id: 1,
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: None,
                sender_agent_id: USER_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some("run-shared-agent".to_string()),
                payload_kind: "plain".to_string(),
                request_id: None,
                created_at: "2026-05-28T00:00:00Z".to_string(),
                read_at: None,
                display_preview: Some("legacy".to_string()),
                delivery_resolution: None,
            },
            AgentInboxPreviewRecord {
                id: 2,
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: Some("member-planner".to_string()),
                sender_agent_id: USER_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some("run-shared-agent".to_string()),
                payload_kind: "plain".to_string(),
                request_id: None,
                created_at: "2026-05-28T00:00:01Z".to_string(),
                read_at: None,
                display_preview: Some("canonical".to_string()),
                delivery_resolution: None,
            },
        ];
        let unread_counts = vec![
            AgentInboxUnreadRecipientCounts {
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: None,
                unread_count: 7,
                max_unread_id: 7,
            },
            AgentInboxUnreadRecipientCounts {
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: Some("member-planner".to_string()),
                unread_count: 2,
                max_unread_id: 9,
            },
        ];
        let inbox_counts = bounded_run_view_inbox_counts(&recent_rows, &unread_counts);
        let task_counts = HashMap::new();
        let interventions = HashMap::new();

        let planner = member_view_from_parts(
            AgentOrgMemberViewIdentity {
                member_id: "member-planner".to_string(),
                name: "Planner".to_string(),
                role: "Plan".to_string(),
                agent_id: "builtin:sde".to_string(),
                parent_member_id: None,
                is_coordinator: false,
            },
            None,
            &task_counts,
            &inbox_counts,
            &interventions,
        )
        .expect("project planner");
        let builder = member_view_from_parts(
            AgentOrgMemberViewIdentity {
                member_id: "member-builder".to_string(),
                name: "Builder".to_string(),
                role: "Build".to_string(),
                agent_id: "builtin:sde".to_string(),
                parent_member_id: None,
                is_coordinator: false,
            },
            None,
            &task_counts,
            &inbox_counts,
            &interventions,
        )
        .expect("project builder");

        assert_eq!(planner.inbox_activity_count, 1);
        assert_eq!(planner.unread_inbox_count, 2);
        assert_eq!(builder.inbox_activity_count, 0);
        assert_eq!(builder.unread_inbox_count, 0);
        assert!(
            inbox_counts
                .iter()
                .any(|count| count.recipient_member_id.is_none()
                    && count.activity_count == 1
                    && count.unread_count == 7),
            "legacy rows remain visible at run level without being guessed onto a member"
        );

        let old_unread_counts = bounded_run_view_inbox_counts(
            &[],
            &[AgentInboxUnreadRecipientCounts {
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: Some("member-planner".to_string()),
                unread_count: 1,
                max_unread_id: 10,
            }],
        );
        let planner_with_old_unread = member_view_from_parts(
            AgentOrgMemberViewIdentity {
                member_id: "member-planner".to_string(),
                name: "Planner".to_string(),
                role: "Plan".to_string(),
                agent_id: "builtin:sde".to_string(),
                parent_member_id: None,
                is_coordinator: false,
            },
            None,
            &task_counts,
            &old_unread_counts,
            &interventions,
        )
        .expect("project old unread");
        assert_eq!(planner_with_old_unread.inbox_activity_count, 0);
        assert_eq!(planner_with_old_unread.unread_inbox_count, 1);
    }

    #[test]
    fn run_phase_projects_quiet_user_plan_gate_as_awaiting_approval() {
        let task = AgentOrgTaskRuntime {
            task: task_for_resume(Some("member-planner"), TaskStatus::InProgress),
            description_truncated: false,
            blocks_truncated: false,
            blocked_by_truncated: false,
            execution_mode: TaskExecutionMode::Plan,
            owner_member: None,
            owner_runtime: None,
        };
        let overview = AgentOrgRunTaskOverview {
            total: 1,
            pending: 0,
            in_progress: 1,
            completed: 0,
            corrupt: 0,
            visible: 1,
            truncated: false,
        };
        let approval = AgentOrgPlanApprovalSummary {
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
            plan_content_bytes: 6,
            created_at: "2026-05-28T00:00:00Z".to_string(),
        };
        assert_eq!(
            project_run_phase(AgentOrgRunStatus::Running, &[], &overview, 0, &[approval]),
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
    fn terminal_group_message_writes_neither_inbox_nor_intervention_clear() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("completed");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: context.run_id.clone(),
            member_id: "member-planner".to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "planner-session".to_string(),
            reason: Some("direct_user_chat".to_string()),
            ttl_secs: 60,
        })
        .expect("enter intervention");

        let error = persist_group_chat_message(
            &context,
            "builtin:sde",
            "member-planner",
            "This must not enter a terminal run",
            None,
        )
        .expect_err("terminal run rejects group message");

        assert!(error.contains("terminal runs do not accept"));
        assert_eq!(inbox_count_for_member(&context, "member-planner"), 0);
        assert!(
            AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
                .expect("load intervention")
                .is_some(),
            "a rejected terminal message must not partially clear intervention state"
        );
    }

    #[test]
    fn group_message_and_intervention_clear_commit_atomically() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("running");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: context.run_id.clone(),
            member_id: "member-planner".to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "planner-session".to_string(),
            reason: Some("direct_user_chat".to_string()),
            ttl_secs: 60,
        })
        .expect("enter intervention");
        let conn = get_connection().expect("db connection");
        conn.execute_batch(
            "CREATE TRIGGER reject_intervention_clear
             BEFORE UPDATE OF cleared_at ON agent_member_interventions
             BEGIN
                 SELECT RAISE(ABORT, 'injected intervention clear failure');
             END;",
        )
        .expect("install failure trigger");
        drop(conn);

        let error = persist_group_chat_message(
            &context,
            "builtin:sde",
            "member-planner",
            "Both writes must commit together",
            None,
        )
        .expect_err("intervention-clear failure rolls back inbox insert");

        assert!(error.contains("injected intervention clear failure"));
        assert_eq!(inbox_count_for_member(&context, "member-planner"), 0);
        assert!(
            AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
                .expect("load intervention")
                .is_some(),
            "the inbox insert must roll back if intervention clear cannot commit"
        );
    }

    #[test]
    fn group_chat_history_pages_all_rows_and_preserves_long_display_text_after_reload() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("running");
        let long_body = "长".repeat(900);
        let long_display = format!("@Planner {long_body}");
        for index in 0..205 {
            let (body, display) = if index == 204 {
                (long_body.as_str(), long_display.as_str())
            } else {
                (
                    "historical group message",
                    "@Planner historical group message",
                )
            };
            persist_group_chat_message(
                &context,
                "builtin:sde",
                "member-planner",
                body,
                Some(display),
            )
            .expect("persist history row");
        }

        let first =
            load_group_chat_history_page(&context, None, 100).expect("load newest history page");
        assert_eq!(first.rows.len(), 100);
        assert!(first.has_more);
        assert_eq!(
            first.rows.last().expect("newest row").display_text,
            long_display
        );
        assert_eq!(first.rows.last().expect("newest row").text, long_body);

        let mut all_ids = first
            .rows
            .iter()
            .map(|row| row.inbox_id)
            .collect::<Vec<_>>();
        let mut before = first.next_before_id;
        while let Some(cursor) = before {
            let page = load_group_chat_history_page(&context, Some(cursor), 100)
                .expect("load older history page");
            all_ids.extend(page.rows.iter().map(|row| row.inbox_id));
            before = page.next_before_id;
            if !page.has_more {
                break;
            }
        }
        all_ids.sort_unstable();
        all_ids.dedup();
        assert_eq!(
            all_ids.len(),
            205,
            "cursor pages must have no gaps or duplicates"
        );

        let conn = get_connection().expect("db connection");
        conn.execute(
            "UPDATE agent_org_runs SET status='completed' WHERE id=?1",
            params![&context.run_id],
        )
        .expect("terminalize run");
        assert_eq!(
            load_group_chat_history_page(&context, None, 100)
                .expect("terminal history stays readable")
                .rows
                .len(),
            100
        );

        conn.execute(
            "UPDATE agent_inbox
             SET recipient_member_id=?1
             WHERE id=(SELECT MAX(id) FROM agent_inbox WHERE org_run_id=?2)",
            params!["x".repeat(2 * 1024 * 1024), &context.run_id],
        )
        .expect("seed oversized historical recipient identity");
        let corrupt_page = load_group_chat_history_page(&context, None, 100)
            .expect("oversized historical identity is bounded, not loaded into the response");
        let latest = corrupt_page.rows.last().expect("latest history row");
        assert!(latest.target_member_id.is_none());
        assert_eq!(latest.target_member_name, "Unknown recipient");
        assert!(
            serde_json::to_vec(&corrupt_page).unwrap().len() <= GROUP_CHAT_HISTORY_PAGE_MAX_BYTES,
            "one corrupt recipient identity must not make the page exceed its payload cap"
        );
    }

    #[test]
    fn paused_resume_and_coordinator_seed_commit_or_rollback_together() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("paused");
        let conn = get_connection().expect("db connection");
        conn.execute_batch(
            "CREATE TRIGGER reject_resume_seed
             BEFORE INSERT ON agent_inbox
             BEGIN
                 SELECT RAISE(ABORT, 'injected resume seed failure');
             END;",
        )
        .expect("install failure trigger");
        drop(conn);

        let error = resume_agent_org_context_sync(&context, true)
            .expect_err("seed failure rolls back resume transition");
        assert!(error.contains("injected resume seed failure"));
        let conn = get_connection().expect("db connection");
        let status: String = conn
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id=?1",
                params![&context.run_id],
                |row| row.get(0),
            )
            .expect("load rolled-back run status");
        assert_eq!(status, "paused");
        assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 0);
        conn.execute_batch("DROP TRIGGER reject_resume_seed;")
            .expect("drop failure trigger");
        drop(conn);

        let outcome = resume_agent_org_context_sync(&context, true).expect("resume run");
        assert_eq!(
            outcome,
            AgentOrgResumeOutcome {
                transitioned: true,
                run_is_running: true,
            }
        );
        let conn = get_connection().expect("db connection");
        let status: String = conn
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id=?1",
                params![&context.run_id],
                |row| row.get(0),
            )
            .expect("load resumed run status");
        assert_eq!(status, "running");
        assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 1);
    }

    #[test]
    fn explicit_resume_of_running_run_repairs_unread_without_duplicate_seed() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("running");

        for _ in 0..2 {
            let outcome =
                resume_agent_org_context_sync(&context, true).expect("idempotent explicit resume");
            assert_eq!(
                outcome,
                AgentOrgResumeOutcome {
                    transitioned: false,
                    run_is_running: true,
                }
            );
        }

        assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 1);
        let targets =
            collect_run_progress_wake_targets(&context.run_id, &org_progress_member_ids(&context))
                .expect("rescan unread inbox rows");
        assert_eq!(
            targets,
            vec![AgentOrgWakeTarget {
                member_id: COORDINATOR_MEMBER_ID.to_string(),
                reason: AgentOrgWakeReason::UnreadInbox,
            }]
        );
    }

    #[test]
    fn return_to_work_boundary_is_not_extended_by_later_mail() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("running");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: context.run_id.clone(),
            member_id: "member-planner".to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "planner-session".to_string(),
            reason: Some("direct_user_chat".to_string()),
            ttl_secs: 60,
        })
        .expect("enter intervention");
        let insert = |summary: &str| {
            AgentInboxStore::insert(InsertInboxParams {
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: Some("member-planner".to_string()),
                sender_agent_id: context.coordinator_agent_id.clone(),
                sender_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                org_run_id: Some(context.run_id.clone()),
                message: AgentMessage::Plain {
                    summary: summary.to_string(),
                    text: summary.to_string(),
                },
            })
            .expect("insert inbox row")
        };
        let first = insert("pending at return-to-work");
        let (changed, boundary) = AgentMemberInterventionStore::clear_and_capture_unread_boundary(
            &context.run_id,
            "member-planner",
        )
        .expect("clear and capture boundary");
        assert!(changed);
        let boundary = boundary.expect("boundary row");
        assert_eq!(boundary, first.id);

        let later = insert("arrived after return-to-work began");
        assert!(later.id > boundary);
        AgentInboxStore::mark_many_read(&[first.id]).expect("ack original boundary row");

        assert_eq!(
            AgentInboxStore::unread_count_through_boundary(
                "member-planner",
                &context.run_id,
                boundary,
            )
            .expect("count original boundary"),
            0,
            "the acknowledgement wait must finish after its original rows drain"
        );
        assert!(
            AgentInboxStore::has_unread_for_member("member-planner", &context.run_id)
                .expect("later unread remains"),
            "later mail remains unread for the next bounded drain instead of extending this wait"
        );
    }

    #[test]
    fn return_to_work_rolls_back_intervention_clear_when_boundary_capture_fails() {
        let _sandbox = test_helpers::test_env::sandbox();
        let context = prepare_command_run("running");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: context.run_id.clone(),
            member_id: "member-planner".to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "planner-session".to_string(),
            reason: Some("direct_user_chat".to_string()),
            ttl_secs: 60,
        })
        .expect("enter intervention");
        let conn = get_connection().expect("db connection");
        conn.execute("DROP TABLE agent_inbox", [])
            .expect("inject boundary query failure");
        drop(conn);

        let error = AgentMemberInterventionStore::clear_and_capture_unread_boundary(
            &context.run_id,
            "member-planner",
        )
        .expect_err("boundary failure must abort return-to-work transaction");
        assert!(error.contains("agent_inbox"));
        assert!(
            AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
                .expect("load intervention after rollback")
                .is_some(),
            "failed boundary capture must not partially clear intervention state"
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
