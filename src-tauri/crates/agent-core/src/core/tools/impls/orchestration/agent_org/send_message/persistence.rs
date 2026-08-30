//! Recipient target type + the SQLite-backed persistence path for
//! ordinary (non plan-approval) org messages: run-status gating, the
//! plain-message-requires-a-task guidance check, archived-recipient
//! rejection, and the transactional inbox insert.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use crate::coordination::agent_inbox::{AgentInboxStore, AgentMessage, InsertInboxParams};
use crate::coordination::agent_org_runs::{
    AgentOrgParticipant, AgentOrgRunStore, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::coordination::agent_org_turn_contexts::{AgentOrgTurnContext, AgentOrgTurnKind};
use crate::coordination::agent_org_user_directed_work::{self, NewLinkedMemberDelivery};
use crate::core::session::SessionStatus;
use crate::definitions::orgs::{AgentOrgCapabilityIndex, AgentOrgLaunchSnapshot};
use crate::tools::traits::ToolError;

use super::super::tasks::task_dependencies_resolved;
use super::OrgSendMessageParams;

/// Tool instance. Holds the org run context so we can resolve recipients
/// and tag persisted rows with the run id without re-querying SQLite per
/// call.
///
/// **Snapshot semantics**: `org_context` is an immutable snapshot
/// captured at session-init time inside `tool_assembly::assemble_overlay`.
/// We assume the org's coordinator + member roster does not change
/// during a single run. If/when join/leave is added (likely with the
/// name registry), the tool must be re-registered or migrated to read
/// from a `RwLock<AgentOrgRunContext>` shared with the run controller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OrgRecipientTarget {
    pub(super) member_id: String,
    pub(super) agent_id: String,
}

#[derive(Debug)]
pub(super) enum OrdinaryMessagePersistOutcome {
    Guidance(String),
    Delivered { rows: Vec<(String, i64)> },
}

#[derive(Debug, Clone)]
pub(super) struct UserDirectedMessagePersistOutcome {
    pub recipient_member_id: String,
    pub recipient_session_id: String,
    pub turn_intent_id: String,
    pub inbox_id: i64,
    pub member_dispatch_sequence: Option<i64>,
    pub content: String,
    pub display_text: String,
}

/// Re-read the immutable launch snapshot inside the same transaction that
/// persists a linked Inbox child. The tool's in-memory snapshot shapes its
/// static schema, but it is not routing authority for the current call.
pub(super) fn user_directed_link_allowed_in_tx(
    conn: &Connection,
    run_id: &str,
    sender_member_id: &str,
    recipient_member_id: &str,
) -> Result<bool, ToolError> {
    if sender_member_id == recipient_member_id {
        return Ok(false);
    }
    if recipient_member_id == COORDINATOR_MEMBER_ID {
        return Ok(true);
    }
    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    let snapshot_json = snapshot_json.ok_or_else(|| {
        ToolError::ExecutionFailed(format!(
            "linked_inbox_stale_source: Agent Org run {run_id} has no frozen snapshot"
        ))
    })?;
    let snapshot: AgentOrgLaunchSnapshot = serde_json::from_str(&snapshot_json).map_err(|error| {
        ToolError::ExecutionFailed(format!(
            "linked_inbox_stale_source: Agent Org run {run_id} has an invalid frozen snapshot: {error}"
        ))
    })?;
    let sender_exists = snapshot
        .members
        .iter()
        .any(|member| member.member_id == sender_member_id);
    let recipient_exists = snapshot
        .members
        .iter()
        .any(|member| member.member_id == recipient_member_id);
    if !sender_exists || !recipient_exists {
        return Ok(false);
    }
    Ok(AgentOrgCapabilityIndex::from_snapshot(&snapshot)
        .members_can_communicate(sender_member_id, recipient_member_id))
}

pub(super) fn persist_user_directed_member_message_in_tx(
    conn: &Connection,
    run_id: &str,
    sender: &AgentOrgParticipant,
    context: &AgentOrgTurnContext,
    params: &OrgSendMessageParams,
    message: &AgentMessage,
    recipient: &OrgRecipientTarget,
) -> Result<UserDirectedMessagePersistOutcome, ToolError> {
    if context.turn_kind != AgentOrgTurnKind::UserDirectedWork
        || context.participant_id != sender.member_id
        || sender.is_coordinator
    {
        return Err(ToolError::PermissionDenied(
            "linked Inbox requires the sender's exact Member UserDirectedWork Turn".to_string(),
        ));
    }
    if recipient.member_id == COORDINATOR_MEMBER_ID {
        return Err(ToolError::InvalidParams(
            "linked_coordinator_route_requires_root_binding: Coordinator side quests use the Root queue"
                .to_string(),
        ));
    }
    if !matches!(message, AgentMessage::Plain { .. }) {
        return Err(ToolError::InvalidParams(
            "UserDirectedWork may send only kind=plain".to_string(),
        ));
    }
    if params.related_task_id.is_some() || params.purpose.is_some() {
        return Err(ToolError::InvalidParams(
            "UserDirectedWork messages do not accept related_task_id or purpose".to_string(),
        ));
    }
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    match status.as_deref() {
        Some("running" | "idle" | "paused") => {}
        Some("archived") => {
            return Err(ToolError::ExecutionFailed(
                crate::coordination::agent_org_runs::mutation_blocked_error(run_id, "archived"),
            ));
        }
        Some(other) => {
            return Err(ToolError::InvalidParams(format!(
                "team_unavailable: linked Inbox cannot enter Team status {other}"
            )));
        }
        None => {
            return Err(ToolError::InvalidParams(format!(
                "team_unavailable: Agent Org run {run_id} is missing"
            )));
        }
    }

    let runtime = AgentOrgRunStore::list_worker_sessions_by_member_ids_with_connection(
        conn,
        run_id,
        std::slice::from_ref(&recipient.member_id),
    )
    .map_err(ToolError::ExecutionFailed)?
    .into_iter()
    .find(|runtime| runtime.member_id.as_deref() == Some(recipient.member_id.as_str()))
    .ok_or_else(|| {
        ToolError::InvalidParams(format!(
            "linked_inbox_target_unavailable: Member {} has no canonical runtime",
            recipient.member_id
        ))
    })?;
    if runtime.status == SessionStatus::Archived {
        return Err(ToolError::InvalidParams(format!(
            "linked_inbox_target_removed: Member {} is archived",
            recipient.member_id
        )));
    }
    let (content, summary) = match message {
        AgentMessage::Plain { summary, text } => (text.trim(), summary.trim()),
        _ => unreachable!("validated plain message"),
    };
    let record = AgentInboxStore::insert_in_tx_without_formal_trigger(
        conn,
        InsertInboxParams {
            recipient_agent_id: recipient.agent_id.clone(),
            recipient_member_id: Some(recipient.member_id.clone()),
            sender_agent_id: sender.agent_id.clone(),
            sender_member_id: Some(sender.member_id.clone()),
            org_run_id: Some(run_id.to_string()),
            message: message.clone(),
        },
    )
    .map_err(ToolError::ExecutionFailed)?;
    let display_text = if summary.is_empty() {
        content.to_string()
    } else {
        format!("{summary}\n\n{content}")
    };
    conn.execute(
        "UPDATE agent_org_runtime_inbox
         SET delivery_class='user_directed',display_text=?2
         WHERE id=?1 AND delivery_class='formal_work'",
        params![record.id, &display_text],
    )
    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;

    let child_turn_intent_id = uuid::Uuid::new_v4().to_string();
    let child = agent_org_user_directed_work::insert_linked_member_delivery_with_connection(
        conn,
        &NewLinkedMemberDelivery {
            org_run_id: run_id,
            source_session_id: &context.session_id,
            source_turn_intent_id: &context.turn_intent_id,
            recipient_session_id: &runtime.session_id,
            recipient_member_id: &recipient.member_id,
            child_turn_intent_id: &child_turn_intent_id,
            source_inbox_id: record.id,
            dispatch_content: content,
            display_content: &display_text,
            images: None,
        },
    )
    .map_err(ToolError::InvalidParams)?;
    Ok(UserDirectedMessagePersistOutcome {
        recipient_member_id: recipient.member_id.clone(),
        recipient_session_id: runtime.session_id,
        turn_intent_id: child_turn_intent_id,
        inbox_id: record.id,
        member_dispatch_sequence: Some(child.member_dispatch_sequence),
        content: content.to_string(),
        display_text,
    })
}

pub(super) fn persist_user_directed_coordinator_message_in_tx(
    conn: &Connection,
    run_id: &str,
    sender: &AgentOrgParticipant,
    context: &AgentOrgTurnContext,
    params: &OrgSendMessageParams,
    message: &AgentMessage,
    recipient: &OrgRecipientTarget,
) -> Result<UserDirectedMessagePersistOutcome, ToolError> {
    if context.turn_kind != AgentOrgTurnKind::UserDirectedWork
        || context.participant_id != sender.member_id
        || sender.is_coordinator
        || recipient.member_id != COORDINATOR_MEMBER_ID
    {
        return Err(ToolError::PermissionDenied(
            "Coordinator side quest requires an exact Member UserDirectedWork caller".to_string(),
        ));
    }
    if !matches!(message, AgentMessage::Plain { .. }) {
        return Err(ToolError::InvalidParams(
            "UserDirectedWork may send only kind=plain".to_string(),
        ));
    }
    if params.related_task_id.is_some() || params.purpose.is_some() {
        return Err(ToolError::InvalidParams(
            "UserDirectedWork messages do not accept related_task_id or purpose".to_string(),
        ));
    }
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    match status.as_deref() {
        Some("running" | "idle" | "paused") => {}
        Some("archived") => {
            return Err(ToolError::ExecutionFailed(
                crate::coordination::agent_org_runs::mutation_blocked_error(run_id, "archived"),
            ));
        }
        Some(other) => {
            return Err(ToolError::InvalidParams(format!(
                "team_unavailable: Coordinator side quest cannot enter Team status {other}"
            )));
        }
        None => {
            return Err(ToolError::InvalidParams(format!(
                "team_unavailable: Agent Org run {run_id} is missing"
            )));
        }
    }
    let runtime = AgentOrgRunStore::find_coordinator_session_by_member_id_with_connection(
        conn,
        run_id,
        COORDINATOR_MEMBER_ID,
    )
    .map_err(ToolError::ExecutionFailed)?
    .ok_or_else(|| {
        ToolError::InvalidParams(
            "linked_inbox_target_unavailable: canonical Coordinator runtime is missing".to_string(),
        )
    })?;
    if runtime.status == SessionStatus::Archived {
        return Err(ToolError::InvalidParams(
            "linked_inbox_target_removed: Coordinator session is archived".to_string(),
        ));
    }
    let (content, summary) = match message {
        AgentMessage::Plain { summary, text } => (text.trim(), summary.trim()),
        _ => unreachable!("validated plain message"),
    };
    let record = AgentInboxStore::insert_in_tx_without_formal_trigger(
        conn,
        InsertInboxParams {
            recipient_agent_id: recipient.agent_id.clone(),
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            sender_agent_id: sender.agent_id.clone(),
            sender_member_id: Some(sender.member_id.clone()),
            org_run_id: Some(run_id.to_string()),
            message: message.clone(),
        },
    )
    .map_err(ToolError::ExecutionFailed)?;
    let display_text = if summary.is_empty() {
        content.to_string()
    } else {
        format!("{summary}\n\n{content}")
    };
    conn.execute(
        "UPDATE agent_org_runtime_inbox
         SET delivery_class='user_directed',display_text=?2
         WHERE id=?1 AND delivery_class='formal_work'",
        params![record.id, &display_text],
    )
    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    let child_turn_intent_id = uuid::Uuid::new_v4().to_string();
    agent_org_user_directed_work::insert_linked_coordinator_delivery_with_connection(
        conn,
        &crate::coordination::agent_org_user_directed_work::NewLinkedCoordinatorDelivery {
            org_run_id: run_id,
            source_session_id: &context.session_id,
            source_turn_intent_id: &context.turn_intent_id,
            coordinator_session_id: &runtime.session_id,
            child_turn_intent_id: &child_turn_intent_id,
            source_inbox_id: record.id,
            dispatch_content: content,
            display_content: &display_text,
        },
    )
    .map_err(ToolError::InvalidParams)?;
    Ok(UserDirectedMessagePersistOutcome {
        recipient_member_id: COORDINATOR_MEMBER_ID.to_string(),
        recipient_session_id: runtime.session_id,
        turn_intent_id: child_turn_intent_id,
        inbox_id: record.id,
        member_dispatch_sequence: None,
        content: content.to_string(),
        display_text,
    })
}

fn member_coordination_guidance(
    conn: &Connection,
    run_id: &str,
    sender: &AgentOrgParticipant,
    context: &AgentOrgTurnContext,
    params: &OrgSendMessageParams,
    message: &AgentMessage,
    recipients: &[OrgRecipientTarget],
) -> Result<Option<String>, ToolError> {
    let is_member_to_coordinator_plain = !sender.is_coordinator
        && matches!(message, AgentMessage::Plain { .. })
        && recipients.len() == 1
        && recipients[0].member_id == COORDINATOR_MEMBER_ID;

    if !is_member_to_coordinator_plain {
        if params.purpose.is_some() {
            return Err(ToolError::InvalidParams(
                "purpose is valid only for a TaskExecution member's plain message to the Coordinator"
                    .to_string(),
            ));
        }
        return Ok(None);
    }

    if context.turn_kind != AgentOrgTurnKind::TaskExecution
        || context.participant_id != sender.member_id
        || context.owner_member_id.as_deref() != Some(sender.member_id.as_str())
    {
        return Err(ToolError::PermissionDenied(
            "Member coordination messages require the sender's exact persisted TaskExecution Turn"
                .to_string(),
        ));
    }

    let related_task_id = params
        .related_task_id
        .as_deref()
        .map(str::trim)
        .filter(|task_id| !task_id.is_empty());
    let exact_task_id = context.task_id.as_deref().ok_or_else(|| {
        ToolError::PermissionDenied(
            "TaskExecution coordination context has no exact task_id".to_string(),
        )
    })?;
    let Some(related_task_id) = related_task_id else {
        return serde_json::to_string(&json!({
            "delivered": false,
            "requires_task": true,
            "requires_purpose": true,
            "reason": "member_coordination_requires_related_task",
            "guidance": "Routine progress is not a Coordinator message. If the Coordinator must act, retry once with the exact current related_task_id and purpose=blocker|decision_required|material_change|risk|requested_reply. Use Task state for progress and TaskOutput for completion.",
        }))
        .map(Some)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()));
    };
    if related_task_id != exact_task_id {
        return serde_json::to_string(&json!({
            "delivered": false,
            "requires_task": true,
            "reason": "member_coordination_task_mismatch",
            "related_task_id": related_task_id,
            "guidance": "Use the exact task_id bound to this persisted TaskExecution Turn. A member cannot report another Task or a stale/reassigned Task.",
        }))
        .map(Some)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()));
    }
    if params.purpose.is_none() {
        return serde_json::to_string(&json!({
            "delivered": false,
            "requires_purpose": true,
            "reason": "member_coordination_requires_purpose",
            "related_task_id": related_task_id,
            "allowed_purposes": ["blocker", "decision_required", "material_change", "risk", "requested_reply"],
            "guidance": "Send only when the Coordinator must act. Routine progress, next-step narration, self-resolved problems, and duplicate completion messages are not valid purposes.",
        }))
        .map(Some)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()));
    }

    let exact_task_is_active: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND id=?2 AND owner=?3
                   AND status='in_progress'
             )",
            params![run_id, related_task_id, &sender.member_id],
            |row| row.get(0),
        )
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    if !exact_task_is_active {
        return Err(ToolError::PermissionDenied(format!(
            "Member coordination task '{related_task_id}' is no longer the sender's in-progress TaskExecution"
        )));
    }

    Ok(None)
}

fn plain_work_context_guidance(
    params: &OrgSendMessageParams,
    message: &AgentMessage,
    recipients: &[OrgRecipientTarget],
    all_tasks: &[crate::coordination::agent_org_tasks::Task],
) -> Result<Option<String>, ToolError> {
    if !matches!(message, AgentMessage::Plain { .. })
        || recipients
            .iter()
            .all(|recipient| recipient.member_id == COORDINATOR_MEMBER_ID)
    {
        return Ok(None);
    }

    let related_task_id = params
        .related_task_id
        .as_deref()
        .map(str::trim)
        .filter(|task_id| !task_id.is_empty());
    let Some(related_task_id) = related_task_id else {
        return serde_json::to_string(&json!({
            "delivered": false,
            "requires_task": true,
            "reason": "plain_worker_message_requires_related_task",
            "guidance": "Create or assign an unresolved durable task first, then retry org_send_message with related_task_id. A plain message cannot create invisible worker work.",
            "recipient_member_ids": recipients.iter().map(|recipient| recipient.member_id.clone()).collect::<Vec<_>>(),
        }))
        .map(Some)
        .map_err(|err| ToolError::ExecutionFailed(err.to_string()));
    };

    let task = all_tasks.iter().find(|task| task.id == related_task_id);
    let invalid_reason = match task {
        None => Some("related_task_not_found"),
        Some(task) if task.status.is_terminal() => Some("related_task_already_terminal"),
        Some(task) if !task_dependencies_resolved(all_tasks, task) => {
            Some("related_task_dependencies_unresolved")
        }
        Some(task)
            if recipients
                .iter()
                .any(|recipient| task.owner.as_deref() != Some(recipient.member_id.as_str())) =>
        {
            Some("related_task_not_owned_by_recipient")
        }
        Some(_) => None,
    };
    let Some(reason) = invalid_reason else {
        return Ok(None);
    };

    serde_json::to_string(&json!({
        "delivered": false,
        "requires_task": true,
        "reason": reason,
        "related_task_id": related_task_id,
        "guidance": "Use an unresolved, dependency-ready task already owned by the recipient. If it is ownerless, the coordinator must explicitly set owner_member_id first; eligibility alone is not assignment.",
        "recipient_member_ids": recipients.iter().map(|recipient| recipient.member_id.clone()).collect::<Vec<_>>(),
    }))
    .map(Some)
    .map_err(|err| ToolError::ExecutionFailed(err.to_string()))
}

pub(super) fn persist_ordinary_message_in_tx(
    conn: &Connection,
    run_id: &str,
    sender: &AgentOrgParticipant,
    context: &AgentOrgTurnContext,
    params: &OrgSendMessageParams,
    message: &AgentMessage,
    recipients: &[OrgRecipientTarget],
) -> Result<OrdinaryMessagePersistOutcome, ToolError> {
    let run_status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
    if run_status.as_deref() == Some("archived") {
        return Err(ToolError::ExecutionFailed(
            crate::coordination::agent_org_runs::mutation_blocked_error(run_id, "archived"),
        ));
    }
    if run_status.as_deref() != Some("running") {
        let guidance = serde_json::to_string(&json!({
                "delivered": false,
                "reason": "run_not_running",
                "org_run_id": run_id,
                "run_status": run_status,
                "guidance": "The Agent Org Team is not Running, so this formal peer message was not persisted. Starting, Paused, Idle, and Failed Teams do not accept this mutation.",
            }))
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        return Ok(OrdinaryMessagePersistOutcome::Guidance(guidance));
    }

    if matches!(message, AgentMessage::ShutdownRequest { .. }) {
        let mut blocked_members = Vec::new();
        for recipient in recipients
            .iter()
            .filter(|recipient| recipient.member_id != COORDINATOR_MEMBER_ID)
        {
            let open_task_count = conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_org_runtime_tasks
                     WHERE org_run_id=?1 AND owner=?2
                       AND status IN ('pending','in_progress')",
                    params![run_id, &recipient.member_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
            if open_task_count > 0 {
                blocked_members.push((recipient.member_id.clone(), open_task_count));
            }
        }
        if !blocked_members.is_empty() {
            let guidance = serde_json::to_string(&json!({
                "delivered": false,
                "reason": "shutdown_blocked_by_open_tasks",
                "blocked_members": blocked_members.iter().map(|(member_id, open_task_count)| json!({
                    "member_id": member_id,
                    "open_task_count": open_task_count,
                })).collect::<Vec<_>>(),
                "guidance": "Do not shut down a Member that still owns pending or in-progress work. Complete, fail, cancel, or reassign those Tasks first, then retry the shutdown request.",
            }))
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
            return Ok(OrdinaryMessagePersistOutcome::Guidance(guidance));
        }
    }

    if let Some(guidance) =
        member_coordination_guidance(conn, run_id, sender, context, params, message, recipients)?
    {
        return Ok(OrdinaryMessagePersistOutcome::Guidance(guidance));
    }

    if matches!(message, AgentMessage::Plain { .. })
        && recipients
            .iter()
            .any(|recipient| recipient.member_id != COORDINATOR_MEMBER_ID)
    {
        let all_tasks = AgentOrgTaskStore::list_with_connection(conn, run_id)
            .map_err(ToolError::ExecutionFailed)?;
        if let Some(guidance) =
            plain_work_context_guidance(params, message, recipients, &all_tasks)?
        {
            return Ok(OrdinaryMessagePersistOutcome::Guidance(guidance));
        }
    }

    let member_ids = recipients
        .iter()
        .filter(|recipient| recipient.member_id != COORDINATOR_MEMBER_ID)
        .map(|recipient| recipient.member_id.clone())
        .collect::<Vec<_>>();
    let runtimes = AgentOrgRunStore::list_worker_sessions_by_member_ids_with_connection(
        conn,
        run_id,
        &member_ids,
    )
    .map_err(ToolError::ExecutionFailed)?;
    for recipient in recipients {
        if let Some(runtime) = runtimes
            .iter()
            .find(|runtime| runtime.member_id.as_deref() == Some(recipient.member_id.as_str()))
        {
            if runtime.status == SessionStatus::Archived {
                return Err(ToolError::InvalidParams(format!(
                        "delivery_blocked: recipient_member_id '{}' is archived/closed (session_id='{}'); reopen the member session or start a new Agent Org run before sending",
                        recipient.member_id, runtime.session_id
                    )));
            }
        }
    }

    let mut delivered = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        let record = AgentInboxStore::insert_in_tx(
            conn,
            InsertInboxParams {
                recipient_agent_id: recipient.agent_id.clone(),
                recipient_member_id: Some(recipient.member_id.clone()),
                sender_agent_id: sender.agent_id.clone(),
                sender_member_id: Some(sender.member_id.clone()),
                org_run_id: Some(run_id.to_string()),
                message: message.clone(),
            },
        )
        .map_err(ToolError::ExecutionFailed)?;
        if sender.is_coordinator
            && matches!(message, AgentMessage::Plain { .. })
            && recipient.member_id != COORDINATOR_MEMBER_ID
        {
            let task_id = params
                .related_task_id
                .as_deref()
                .map(str::trim)
                .filter(|task_id| !task_id.is_empty())
                .ok_or_else(|| {
                    ToolError::ExecutionFailed(
                        "validated Coordinator task message lost related_task_id".to_string(),
                    )
                })?;
            AgentInboxStore::bind_task_message_in_tx(
                conn,
                run_id,
                record.id,
                task_id,
                &recipient.member_id,
                &context.turn_intent_id,
            )
            .map_err(ToolError::ExecutionFailed)?;
        }
        if !sender.is_coordinator
            && matches!(message, AgentMessage::Plain { .. })
            && recipient.member_id == COORDINATOR_MEMBER_ID
        {
            let purpose = params.purpose.ok_or_else(|| {
                ToolError::ExecutionFailed(
                    "validated member coordination lost its formal purpose".to_string(),
                )
            })?;
            crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
                conn,
                run_id,
                record.id,
                crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
                    source_kind: purpose.as_str(),
                    task_id: params.related_task_id.as_deref().map(str::trim),
                    owner_member_id: Some(sender.member_id.as_str()),
                    source_turn_intent_id: Some(context.turn_intent_id.as_str()),
                    task_output_digest: None,
                    plan_revision_id: None,
                    suppress_self_wake: false,
                },
            )
            .map_err(ToolError::ExecutionFailed)?;
        }
        delivered.push((recipient.member_id.clone(), record.id));
    }
    Ok(OrdinaryMessagePersistOutcome::Delivered { rows: delivered })
}

pub(super) fn ensure_recipients_deliverable_in_tx(
    conn: &Connection,
    run_id: &str,
    recipients: &[OrgRecipientTarget],
) -> Result<(), ToolError> {
    let member_ids = recipients
        .iter()
        .filter(|recipient| recipient.member_id != COORDINATOR_MEMBER_ID)
        .map(|recipient| recipient.member_id.clone())
        .collect::<Vec<_>>();
    let runtimes = AgentOrgRunStore::list_worker_sessions_by_member_ids_with_connection(
        conn,
        run_id,
        &member_ids,
    )
    .map_err(ToolError::ExecutionFailed)?;
    for recipient in recipients {
        if let Some(runtime) = runtimes
            .iter()
            .find(|runtime| runtime.member_id.as_deref() == Some(recipient.member_id.as_str()))
        {
            if runtime.status == SessionStatus::Archived {
                return Err(ToolError::InvalidParams(format!(
                    "delivery_blocked: recipient_member_id '{}' is archived/closed (session_id='{}'); reopen the member session or start a new Agent Org run before sending",
                    recipient.member_id, runtime.session_id
                )));
            }
        }
    }
    Ok(())
}
