use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, PlanDecisionActor, PlanDecisionOutcome,
    RequestId, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_payload_limits::{
    validate_required_text, PLAN_CONTENT_MAX_BYTES, PLAN_CONTENT_MAX_CHARS,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, PlanDecisionTaskAuthority, TaskExecutionMode, TaskOutputInput,
    TaskOwnerExecution, TaskStatus,
};
use crate::definitions::orgs::AgentOrgLaunchSnapshot;

use super::artifact::validate_owned_plan_path_with_connection;
use super::persistence::insert_record;
use super::validation::{authorize_decision, validate_create_params};
use super::{
    AgentOrgPlanDecisionBy, AgentOrgPlanDecisionStatus, AgentOrgPlanRevision,
    ApprovedAgentOrgPlanRevision, CreateAgentOrgPlanRevisionParams,
};

pub(super) fn create_pending_in_tx(
    tx: &Connection,
    params: CreateAgentOrgPlanRevisionParams,
) -> Result<AgentOrgPlanRevision, String> {
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
        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
            &params.org_run_id,
            run_status.as_deref().unwrap_or("missing"),
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

    let previous: Option<(String, i64)> = tx
        .query_row(
            "SELECT revision.plan_revision_id,revision.revision_number
             FROM agent_org_runtime_plan_revisions revision
             JOIN agent_org_runtime_plan_decisions decision
               ON decision.plan_revision_id=revision.plan_revision_id
             WHERE revision.org_run_id=?1 AND revision.source_task_id=?2
             ORDER BY revision.revision_number DESC LIMIT 1",
            params![&params.org_run_id, &params.source_task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let revision_number = next_revision_number(previous.as_ref().map(|(_, number)| *number))?;
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "UPDATE agent_org_runtime_plan_decisions
         SET status=?1, decision_by='automatic', resolved_at=?2
         WHERE status=?3 AND plan_revision_id IN (
             SELECT plan_revision_id FROM agent_org_runtime_plan_revisions
             WHERE org_run_id=?4 AND source_task_id=?5
         )",
        params![
            AgentOrgPlanDecisionStatus::Superseded.as_wire(),
            &now,
            AgentOrgPlanDecisionStatus::Pending.as_wire(),
            &params.org_run_id,
            &params.source_task_id,
        ],
    )
    .map_err(|err| err.to_string())?;

    let revision = AgentOrgPlanRevision {
        approval_id: format!("agent-org-plan-{}", uuid::Uuid::new_v4()),
        plan_revision_id: format!("agent-org-plan-revision-{}", uuid::Uuid::new_v4()),
        revision_number: u64::try_from(revision_number)
            .map_err(|_| "agent_org_plan_revision_number_overflow".to_string())?,
        previous_plan_revision_id: previous.map(|(id, _)| id),
        request_id: params.request_id,
        org_run_id: params.org_run_id,
        source_task_id: params.source_task_id,
        source_member_id: params.source_member_id,
        source_session_id: params.source_session_id,
        source_turn_intent_id: params.source_turn_intent_id,
        root_session_id: params.root_session_id,
        policy: params.policy,
        status: AgentOrgPlanDecisionStatus::Pending,
        plan_title: params.plan_title,
        plan_path: params.plan_path,
        content_digest: format!("{:x}", Sha256::digest(params.plan_content.as_bytes())),
        plan_content: params.plan_content,
        decision_by: None,
        feedback: None,
        task_output: None,
        created_at: now,
        resolved_at: None,
    };
    insert_record(tx, &revision)?;
    Ok(revision)
}

pub(super) fn next_revision_number(previous: Option<i64>) -> Result<i64, String> {
    match previous {
        Some(number) => number
            .checked_add(1)
            .ok_or_else(|| "agent_org_plan_revision_number_overflow".to_string()),
        None => Ok(1),
    }
}

pub(super) fn approve_pending_in_tx(
    tx: &Connection,
    revision: AgentOrgPlanRevision,
    decision_by: AgentOrgPlanDecisionBy,
    decision_source_session_id: &str,
    decision_source_turn_intent_id: Option<&str>,
) -> Result<ApprovedAgentOrgPlanRevision, String> {
    authorize_decision(revision.policy, decision_by)?;
    validate_required_text(
        "plan approval content",
        &revision.plan_content,
        PLAN_CONTENT_MAX_CHARS,
        PLAN_CONTENT_MAX_BYTES,
    )?;
    let recomputed_digest = format!("{:x}", Sha256::digest(revision.plan_content.as_bytes()));
    if recomputed_digest != revision.content_digest {
        return Err("agent_org_plan_revision_digest_conflict".to_string());
    }
    let plan_char_count = revision.plan_content.chars().count();
    let mut inline_plan_content =
        crate::utils::safe_truncate_chars_to_string(&revision.plan_content, 18_000);
    if plan_char_count > 18_000 {
        inline_plan_content.push_str(&format!(
            "\n\n[Plan truncated for task handoff; full {}-character plan is stored at {}]",
            plan_char_count, revision.plan_path
        ));
    }
    let output = TaskOutputInput {
        summary: crate::utils::safe_truncate_chars_to_string(
            &format!("Approved plan: {}", revision.plan_title),
            500,
        ),
        content: Some(inline_plan_content),
        artifact_ids: vec![revision.plan_path.clone()],
    };
    let authority = match decision_by {
        AgentOrgPlanDecisionBy::User => {
            if decision_source_turn_intent_id.is_some() {
                return Err("user plan decision must not borrow a model Turn".to_string());
            }
            PlanDecisionTaskAuthority::user(decision_source_session_id)?
        }
        AgentOrgPlanDecisionBy::Coordinator => PlanDecisionTaskAuthority::coordinator(
            decision_source_session_id,
            decision_source_turn_intent_id
                .ok_or_else(|| "coordinator plan decision requires current Turn".to_string())?,
        )?,
        AgentOrgPlanDecisionBy::Automatic => PlanDecisionTaskAuthority::automatic(
            decision_source_session_id,
            decision_source_turn_intent_id
                .ok_or_else(|| "automatic plan decision requires source Turn".to_string())?,
        )?,
    };
    let task_outcome = AgentOrgTaskStore::complete_planning_task_for_decision_in_tx(
        tx,
        authority,
        &revision.org_run_id,
        &revision.source_task_id,
        &revision.source_member_id,
        &revision.source_session_id,
        &revision.source_turn_intent_id,
        &revision.plan_revision_id,
        output,
    )?;
    let resolved_at = chrono::Utc::now().to_rfc3339();
    let changed = tx
        .execute(
            "UPDATE agent_org_runtime_plan_decisions
             SET status=?1, decision_by=?2, resolved_at=?3
             WHERE approval_id=?4 AND plan_revision_id=?5 AND status=?6",
            params![
                AgentOrgPlanDecisionStatus::Approved.as_wire(),
                decision_by.as_wire(),
                &resolved_at,
                &revision.approval_id,
                &revision.plan_revision_id,
                AgentOrgPlanDecisionStatus::Pending.as_wire(),
            ],
        )
        .map_err(|err| err.to_string())?;
    if changed != 1 {
        return Err("agent_org_plan_approval_stale_revision".to_string());
    }
    let mut approved = ApprovedAgentOrgPlanRevision {
        revision: AgentOrgPlanRevision {
            status: AgentOrgPlanDecisionStatus::Approved,
            decision_by: Some(decision_by.as_wire().to_string()),
            task_output: Some(super::AgentOrgPlanTaskOutputRef {
                task_id: revision.source_task_id.clone(),
                plan_revision_id: revision.plan_revision_id.clone(),
                produced_by_member_id: revision.source_member_id.clone(),
                produced_at: task_outcome
                    .current
                    .output
                    .as_ref()
                    .map(|output| output.produced_at.clone())
                    .ok_or_else(|| "approved planning task output missing".to_string())?,
            }),
            resolved_at: Some(resolved_at),
            ..revision
        },
        task_outcome,
        wake_member_ids: Vec::new(),
    };
    approved.wake_member_ids = enqueue_post_approval_messages_in_tx(
        tx,
        &approved,
        decision_by,
        decision_source_turn_intent_id,
    )?;
    Ok(approved)
}

/// Insert every durable consequence of approval before the approval
/// transaction commits. A wake is merely a best-effort doorbell; the inbox
/// rows remain the source of truth across queue failure, pause, or restart.
fn enqueue_post_approval_messages_in_tx(
    tx: &Connection,
    approved: &ApprovedAgentOrgPlanRevision,
    decision_by: AgentOrgPlanDecisionBy,
    decision_source_turn_intent_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let tasks = AgentOrgTaskStore::list_with_connection(tx, &approved.revision.org_run_id)?;
    let graph = crate::coordination::agent_org_tasks::TaskGraphIndex::new(&tasks);
    let (coordinator_agent_id, participant_agent_ids) =
        participant_agent_ids_in_tx(tx, &approved.revision.org_run_id)?;
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
                run_id = %approved.revision.org_run_id,
                task_id = %task.id,
                owner_member_id,
                "approved plan unlocked a task whose owner is absent from the run snapshot; watchdog will escalate it"
            );
            continue;
        };
        let coordinator_decision = decision_by == AgentOrgPlanDecisionBy::Coordinator;
        crate::coordination::agent_org_tasks::enqueue_task_assigned_to_with_tasks_in_tx(
            tx,
            task,
            &tasks,
            recipient_agent_id,
            owner_member_id,
            if coordinator_decision {
                &coordinator_agent_id
            } else {
                SYSTEM_SENDER_ID
            },
            coordinator_decision.then_some(COORDINATOR_MEMBER_ID),
            "Agent Org task graph",
            if coordinator_decision {
                decision_source_turn_intent_id
            } else {
                Some(&approved.revision.source_turn_intent_id)
            },
        )?;
        if !wake_member_ids
            .iter()
            .any(|existing| existing == owner_member_id)
        {
            wake_member_ids.push(owner_member_id.to_string());
        }
    }

    let remaining_open_task_count = tasks.iter().filter(|task| task.status.is_open()).count();
    let task_output = approved
        .task_outcome
        .current
        .output
        .as_ref()
        .ok_or_else(|| {
            "approved planning TaskOutput disappeared before notification".to_string()
        })?;
    let task_output_digest = crate::coordination::agent_org_tasks::task_output_digest(task_output)?;
    let suppress_self_wake = decision_by == AgentOrgPlanDecisionBy::Coordinator
        && decision_source_turn_intent_id.is_some();
    let decision_record = AgentInboxStore::insert_in_tx_without_formal_trigger(
        tx,
        InsertInboxParams {
            recipient_agent_id: coordinator_agent_id,
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: (decision_by == AgentOrgPlanDecisionBy::Coordinator)
                .then(|| COORDINATOR_MEMBER_ID.to_string()),
            org_run_id: Some(approved.revision.org_run_id.clone()),
            message: AgentMessage::PlanDecisionCommitted {
                approval_id: approved.revision.approval_id.clone(),
                plan_revision_id: approved.revision.plan_revision_id.clone(),
                source_task_id: approved.revision.source_task_id.clone(),
                outcome: PlanDecisionOutcome::Approved,
                decided_by: plan_decision_actor(decision_by),
                feedback: None,
                task_output_digest: Some(task_output_digest.clone()),
                remaining_open_task_count,
            },
        },
    )?;
    crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
        tx,
        &approved.revision.org_run_id,
        decision_record.id,
        crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
            source_kind: "plan_decision",
            task_id: Some(&approved.revision.source_task_id),
            owner_member_id: Some(&approved.revision.source_member_id),
            source_turn_intent_id: decision_source_turn_intent_id,
            task_output_digest: Some(&task_output_digest),
            plan_revision_id: Some(&approved.revision.plan_revision_id),
            suppress_self_wake,
        },
    )?;
    if suppress_self_wake {
        tx.execute(
            "UPDATE agent_org_runtime_inbox SET read_at=?2 WHERE id=?1 AND read_at IS NULL",
            params![decision_record.id, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    }
    if !suppress_self_wake
        && !wake_member_ids
            .iter()
            .any(|member_id| member_id == COORDINATOR_MEMBER_ID)
    {
        wake_member_ids.push(COORDINATOR_MEMBER_ID.to_string());
    }
    Ok(wake_member_ids)
}

pub(super) fn plan_decision_actor(decision_by: AgentOrgPlanDecisionBy) -> PlanDecisionActor {
    match decision_by {
        AgentOrgPlanDecisionBy::User => PlanDecisionActor::User,
        AgentOrgPlanDecisionBy::Coordinator => PlanDecisionActor::Coordinator,
        AgentOrgPlanDecisionBy::Automatic => PlanDecisionActor::Automatic,
    }
}

fn participant_agent_ids_in_tx(
    tx: &Connection,
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

pub(super) fn plan_approval_request_message(revision: &AgentOrgPlanRevision) -> AgentMessage {
    let plan_char_count = revision.plan_content.chars().count();
    let mut inline_plan_content =
        crate::utils::safe_truncate_chars_to_string(&revision.plan_content, 18_000);
    if plan_char_count > 18_000 {
        inline_plan_content.push_str(&format!(
            "\n\n[Plan excerpt truncated; read the full {}-character plan at {}]",
            plan_char_count, revision.plan_path
        ));
    }
    AgentMessage::PlanApprovalRequest {
        request_id: RequestId(revision.request_id.clone()),
        approval_id: revision.approval_id.clone(),
        plan_revision_id: revision.plan_revision_id.clone(),
        source_task_id: revision.source_task_id.clone(),
        plan_title: revision.plan_title.clone(),
        plan_path: revision.plan_path.clone(),
        plan_content: inline_plan_content,
    }
}
