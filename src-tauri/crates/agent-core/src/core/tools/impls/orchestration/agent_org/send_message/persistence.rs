//! Recipient target type + the SQLite-backed persistence path for
//! ordinary (non plan-approval) org messages: run-status gating, the
//! plain-message-requires-a-task guidance check, archived-recipient
//! rejection, and the transactional inbox insert.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};
use serde_json::json;

use crate::coordination::agent_inbox::{AgentInboxStore, AgentMessage, InsertInboxParams};
use crate::coordination::agent_org_runs::{AgentOrgParticipant, AgentOrgRunStore, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
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
    Delivered(Vec<(String, i64)>),
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
        Some(task) if task.status.is_resolved() => Some("related_task_already_completed"),
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

pub(super) fn persist_ordinary_message_if_running(
    run_id: &str,
    sender: &AgentOrgParticipant,
    params: &OrgSendMessageParams,
    message: &AgentMessage,
    recipients: &[OrgRecipientTarget],
) -> Result<OrdinaryMessagePersistOutcome, ToolError> {
    with_sessions_writer(|| {
        let mut conn =
            get_connection().map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        let run_status: Option<String> = tx
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id=?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        if run_status.as_deref() != Some("running") {
            let guidance = serde_json::to_string(&json!({
                "delivered": false,
                "reason": "run_not_running",
                "org_run_id": run_id,
                "run_status": run_status,
                "guidance": "The Agent Org run is paused or terminal, so this message was not persisted. Resume a paused run before sending new work; terminal runs cannot be reopened.",
            }))
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
            tx.commit()
                .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
            return Ok(OrdinaryMessagePersistOutcome::Guidance(guidance));
        }

        let all_tasks = AgentOrgTaskStore::list_with_connection(&tx, run_id)
            .map_err(ToolError::ExecutionFailed)?;
        if let Some(guidance) =
            plain_work_context_guidance(params, message, recipients, &all_tasks)?
        {
            tx.commit()
                .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
            return Ok(OrdinaryMessagePersistOutcome::Guidance(guidance));
        }

        let member_ids = recipients
            .iter()
            .filter(|recipient| recipient.member_id != COORDINATOR_MEMBER_ID)
            .map(|recipient| recipient.member_id.clone())
            .collect::<Vec<_>>();
        let runtimes = AgentOrgRunStore::list_worker_sessions_by_member_ids_with_connection(
            &tx,
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
                &tx,
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
        tx.commit()
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        Ok(OrdinaryMessagePersistOutcome::Delivered(delivered))
    })
}

pub(super) fn ensure_recipients_deliverable(
    run_id: &str,
    recipients: &[OrgRecipientTarget],
) -> Result<(), ToolError> {
    let member_ids = recipients
        .iter()
        .filter(|recipient| recipient.member_id != COORDINATOR_MEMBER_ID)
        .map(|recipient| recipient.member_id.clone())
        .collect::<Vec<_>>();
    let runtimes = AgentOrgRunStore::list_worker_sessions_by_member_ids(run_id, &member_ids)
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
