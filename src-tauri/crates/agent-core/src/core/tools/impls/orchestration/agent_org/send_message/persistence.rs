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
use crate::core::session::SessionStatus;
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
    Delivered {
        rows: Vec<(String, i64)>,
        member_coordination_trigger_coalesced: Option<bool>,
    },
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

    let member_coordination_trigger_coalesced = if !sender.is_coordinator
        && matches!(message, AgentMessage::Plain { .. })
        && recipients.len() == 1
        && recipients[0].member_id == COORDINATOR_MEMBER_ID
    {
        Some(
            conn.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_runtime_run_progress
                     WHERE org_run_id=?1
                       AND coordinator_claimed_trigger_sequence
                           < coordinator_trigger_sequence
                 )",
                [run_id],
                |row| row.get(0),
            )
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?,
        )
    } else {
        None
    };

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
        delivered.push((recipient.member_id.clone(), record.id));
    }
    Ok(OrdinaryMessagePersistOutcome::Delivered {
        rows: delivered,
        member_coordination_trigger_coalesced,
    })
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
