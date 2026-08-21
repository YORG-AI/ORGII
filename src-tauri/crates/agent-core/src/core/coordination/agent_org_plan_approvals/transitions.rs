use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, RequestId, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_payload_limits::{
    validate_required_text, PLAN_CONTENT_MAX_BYTES, PLAN_CONTENT_MAX_CHARS,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, TaskExecutionMode, TaskOutputInput, TaskOwnerExecution, TaskStatus,
};
use crate::definitions::orgs::AgentOrgLaunchSnapshot;

use super::artifact::validate_owned_plan_path_with_connection;
use super::persistence::insert_record;
use super::validation::{authorize_decision, validate_create_params};
use super::{
    AgentOrgPlanApproval, AgentOrgPlanApprovalStatus, AgentOrgPlanDecisionBy, ApprovedAgentOrgPlan,
    CreateAgentOrgPlanApprovalParams,
};

pub(super) fn create_pending_in_tx(
    tx: &rusqlite::Transaction<'_>,
    params: CreateAgentOrgPlanApprovalParams,
) -> Result<AgentOrgPlanApproval, String> {
    validate_create_params(&params)?;
    validate_owned_plan_path_with_connection(tx, &params.source_session_id, &params.plan_path)?;
    let run_status: Option<String> = tx
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            params![&params.org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if run_status.as_deref() != Some("running") {
        return Err(format!(
            "agent_org_run_not_mutable: run {} is {}",
            params.org_run_id,
            run_status.as_deref().unwrap_or("missing")
        ));
    }
    let owner_actor = TaskOwnerExecution::new(
        params.source_session_id.clone(),
        params.source_turn_intent_id.clone(),
    )?;
    let owner_audit = owner_actor.validate(tx, &params.org_run_id, &params.source_task_id)?;
    if owner_audit.participant_id != params.source_member_id {
        return Err("plan_task_owner_context_mismatch".to_string());
    }

    let task: Option<(Option<String>, String, String)> = tx
        .query_row(
            "SELECT owner, status, execution_mode FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND id=?2",
            params![&params.org_run_id, &params.source_task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((owner, status, execution_mode_raw)) = task else {
        return Err(format!("plan_task_not_found: {}", params.source_task_id));
    };
    if owner.as_deref() != Some(params.source_member_id.as_str()) {
        return Err(format!(
            "plan_task_owner_mismatch: task {} is owned by {:?}",
            params.source_task_id, owner
        ));
    }
    if status != TaskStatus::InProgress.as_wire() {
        return Err(format!(
            "plan_task_not_in_progress: task {} is {status}",
            params.source_task_id
        ));
    }
    let execution_mode = TaskExecutionMode::from_wire(&execution_mode_raw)?;
    if execution_mode != TaskExecutionMode::Plan {
        return Err(format!(
            "plan_task_execution_mode_mismatch: task {} is not a plan task",
            params.source_task_id
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "UPDATE agent_org_runtime_plan_approvals
         SET status=?1, resolved_at=?2
         WHERE org_run_id=?3 AND source_task_id=?4 AND status=?5",
        params![
            AgentOrgPlanApprovalStatus::Superseded.as_wire(),
            &now,
            &params.org_run_id,
            &params.source_task_id,
            AgentOrgPlanApprovalStatus::Pending.as_wire(),
        ],
    )
    .map_err(|err| err.to_string())?;

    let approval = AgentOrgPlanApproval {
        approval_id: format!("agent-org-plan-{}", uuid::Uuid::new_v4()),
        plan_revision_id: format!("agent-org-plan-revision-{}", uuid::Uuid::new_v4()),
        request_id: params.request_id,
        org_run_id: params.org_run_id,
        source_task_id: params.source_task_id,
        source_member_id: params.source_member_id,
        source_session_id: params.source_session_id,
        source_turn_intent_id: params.source_turn_intent_id,
        root_session_id: params.root_session_id,
        policy: params.policy,
        status: AgentOrgPlanApprovalStatus::Pending,
        plan_title: params.plan_title,
        plan_path: params.plan_path,
        plan_content: params.plan_content,
        decision_by: None,
        feedback: None,
        created_at: now,
        resolved_at: None,
    };
    insert_record(tx, &approval)?;
    Ok(approval)
}

pub(super) fn approve_pending_in_tx(
    tx: &rusqlite::Transaction<'_>,
    approval: AgentOrgPlanApproval,
    decision_by: AgentOrgPlanDecisionBy,
    plan_content: String,
) -> Result<ApprovedAgentOrgPlan, String> {
    authorize_decision(approval.policy, decision_by)?;
    validate_required_text(
        "plan approval content",
        &plan_content,
        PLAN_CONTENT_MAX_CHARS,
        PLAN_CONTENT_MAX_BYTES,
    )?;
    let plan_char_count = plan_content.chars().count();
    let mut inline_plan_content =
        crate::utils::safe_truncate_chars_to_string(&plan_content, 18_000);
    if plan_char_count > 18_000 {
        inline_plan_content.push_str(&format!(
            "\n\n[Plan truncated for task handoff; full {}-character plan is stored at {}]",
            plan_char_count, approval.plan_path
        ));
    }
    let output = TaskOutputInput {
        summary: crate::utils::safe_truncate_chars_to_string(
            &format!("Approved plan: {}", approval.plan_title),
            500,
        ),
        content: Some(inline_plan_content),
        artifact_ids: vec![approval.plan_path.clone()],
    };
    let owner_actor = TaskOwnerExecution::new(
        approval.source_session_id.clone(),
        approval.source_turn_intent_id.clone(),
    )?;
    let task_outcome = AgentOrgTaskStore::complete_planning_task_in_tx(
        tx,
        owner_actor,
        &approval.org_run_id,
        &approval.source_task_id,
        output,
    )?;
    let resolved_at = chrono::Utc::now().to_rfc3339();
    let changed = tx
        .execute(
            "UPDATE agent_org_runtime_plan_approvals
             SET status=?1, decision_by=?2, plan_content=?3, resolved_at=?4
             WHERE approval_id=?5 AND plan_revision_id=?6 AND status=?7",
            params![
                AgentOrgPlanApprovalStatus::Approved.as_wire(),
                decision_by.as_wire(),
                &plan_content,
                &resolved_at,
                &approval.approval_id,
                &approval.plan_revision_id,
                AgentOrgPlanApprovalStatus::Pending.as_wire(),
            ],
        )
        .map_err(|err| err.to_string())?;
    if changed != 1 {
        return Err("agent_org_plan_approval_stale_revision".to_string());
    }
    let mut approved = ApprovedAgentOrgPlan {
        approval: AgentOrgPlanApproval {
            status: AgentOrgPlanApprovalStatus::Approved,
            decision_by: Some(decision_by.as_wire().to_string()),
            plan_content,
            resolved_at: Some(resolved_at),
            ..approval
        },
        task_outcome,
        wake_member_ids: Vec::new(),
    };
    approved.wake_member_ids = enqueue_post_approval_messages_in_tx(tx, &approved)?;
    Ok(approved)
}

/// Insert every durable consequence of approval before the approval
/// transaction commits. A wake is merely a best-effort doorbell; the inbox
/// rows remain the source of truth across queue failure, pause, or restart.
fn enqueue_post_approval_messages_in_tx(
    tx: &rusqlite::Transaction<'_>,
    approved: &ApprovedAgentOrgPlan,
) -> Result<Vec<String>, String> {
    let tasks = AgentOrgTaskStore::list_with_connection(tx, &approved.approval.org_run_id)?;
    let graph = crate::coordination::agent_org_tasks::TaskGraphIndex::new(&tasks);
    let (coordinator_agent_id, participant_agent_ids) =
        participant_agent_ids_in_tx(tx, &approved.approval.org_run_id)?;
    let completed_task_id = &approved.task_outcome.current.id;
    let mut wake_member_ids = Vec::new();

    for task in &tasks {
        if task.status != TaskStatus::Pending
            || !graph
                .blocked_by(&task.id)
                .iter()
                .any(|blocker_id| blocker_id == completed_task_id)
            || !graph.is_ready(task)
        {
            continue;
        }
        let Some(owner_member_id) = task.owner.as_deref() else {
            continue;
        };
        let Some(recipient_agent_id) = participant_agent_ids.get(owner_member_id) else {
            tracing::warn!(
                run_id = %approved.approval.org_run_id,
                task_id = %task.id,
                owner_member_id,
                "approved plan unlocked a task whose owner is absent from the run snapshot; watchdog will escalate it"
            );
            continue;
        };
        crate::coordination::agent_org_tasks::enqueue_task_assigned_to_with_tasks_in_tx(
            tx,
            task,
            &tasks,
            recipient_agent_id,
            owner_member_id,
            SYSTEM_SENDER_ID,
            None,
            "Agent Org task graph",
        )?;
        if !wake_member_ids
            .iter()
            .any(|existing| existing == owner_member_id)
        {
            wake_member_ids.push(owner_member_id.to_string());
        }
    }

    let remaining_open_task_count = tasks.iter().filter(|task| task.status.is_open()).count();
    AgentInboxStore::insert_in_tx(
        tx,
        InsertInboxParams {
            recipient_agent_id: coordinator_agent_id,
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(approved.approval.org_run_id.clone()),
            message: AgentMessage::TaskCompleted {
                task_id: approved.task_outcome.current.id.clone(),
                subject: approved.task_outcome.current.subject.clone(),
                completed_by_member_id: approved.approval.source_member_id.clone(),
                output_summary: Some(crate::utils::safe_truncate_chars_to_string(
                    &format!("Approved plan: {}", approved.approval.plan_title),
                    500,
                )),
                remaining_open_task_count,
            },
        },
    )?;
    if !wake_member_ids
        .iter()
        .any(|member_id| member_id == COORDINATOR_MEMBER_ID)
    {
        wake_member_ids.push(COORDINATOR_MEMBER_ID.to_string());
    }
    Ok(wake_member_ids)
}

fn participant_agent_ids_in_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
) -> Result<(String, HashMap<String, String>), String> {
    let (coordinator_agent_id, snapshot_json): (String, Option<String>) = tx
        .query_row(
            "SELECT coordinator_agent_id, org_snapshot_json
             FROM agent_org_runtime_runs WHERE id=?1 AND status='running'",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| format!("agent_org_run_not_mutable: {run_id}: {err}"))?;
    let mut participants = HashMap::new();
    if let Some(snapshot_json) = snapshot_json {
        let snapshot: AgentOrgLaunchSnapshot =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("failed to parse Agent Org launch snapshot for run {run_id}: {err}")
            })?;
        crate::definitions::orgs::validate_launch_snapshot(&snapshot)
            .map_err(|err| format!("invalid Agent Org launch snapshot for run {run_id}: {err}"))?;
        for member in snapshot.members {
            participants.insert(member.member_id, member.agent_id);
        }
    }
    Ok((coordinator_agent_id, participants))
}

pub(super) fn plan_approval_request_message(approval: &AgentOrgPlanApproval) -> AgentMessage {
    let plan_char_count = approval.plan_content.chars().count();
    let mut inline_plan_content =
        crate::utils::safe_truncate_chars_to_string(&approval.plan_content, 18_000);
    if plan_char_count > 18_000 {
        inline_plan_content.push_str(&format!(
            "\n\n[Plan excerpt truncated; read the full {}-character plan at {}]",
            plan_char_count, approval.plan_path
        ));
    }
    AgentMessage::PlanApprovalRequest {
        request_id: RequestId(approval.request_id.clone()),
        approval_id: approval.approval_id.clone(),
        plan_revision_id: approval.plan_revision_id.clone(),
        source_task_id: approval.source_task_id.clone(),
        plan_title: approval.plan_title.clone(),
        plan_path: approval.plan_path.clone(),
        plan_content: inline_plan_content,
    }
}
