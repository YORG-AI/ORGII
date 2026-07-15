//! Durable approval state for plans produced by Agent Org planning tasks.
//!
//! This is intentionally separate from `interaction::plan_approval`: the
//! latter belongs to one top-level session and its Build button starts a new
//! turn in that same session. An Agent Org approval instead completes a
//! planning task and unlocks the run's dynamic dependency graph.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, RequestId, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    enqueue_task_assigned_to, AgentOrgTaskStore, TaskExecutionMode, TaskMutationOutcome,
    TaskOutput, TaskStatus, TASK_METADATA_EXECUTION_MODE,
};
use crate::definitions::orgs::PlanApprovalPolicy;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgPlanApprovalStatus {
    Pending,
    Approved,
    ChangesRequested,
    Superseded,
    Cancelled,
}

impl AgentOrgPlanApprovalStatus {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::ChangesRequested => "changes_requested",
            Self::Superseded => "superseded",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_wire(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "changes_requested" => Ok(Self::ChangesRequested),
            "superseded" => Ok(Self::Superseded),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(format!("unknown Agent Org plan approval status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentOrgPlanDecisionBy {
    User,
    Coordinator,
    System,
}

impl AgentOrgPlanDecisionBy {
    fn as_wire(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Coordinator => "coordinator",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgPlanApproval {
    pub approval_id: String,
    pub plan_revision_id: String,
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub status: AgentOrgPlanApprovalStatus,
    pub plan_title: String,
    pub plan_path: String,
    pub plan_content: String,
    pub decision_by: Option<String>,
    pub feedback: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateAgentOrgPlanApprovalParams {
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub plan_title: String,
    pub plan_path: String,
    pub plan_content: String,
}

#[derive(Debug, Clone)]
pub struct ApprovedAgentOrgPlan {
    pub approval: AgentOrgPlanApproval,
    pub task_outcome: TaskMutationOutcome,
}

#[derive(Debug, Clone)]
pub struct AgentOrgPlanInboxDelivery {
    pub recipient_agent_id: String,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
}

/// Persist the task-graph messages unlocked by an approved planning task.
/// The returned member ids are the only sessions the caller needs to wake.
pub fn enqueue_post_approval_messages(
    context: &AgentOrgRunContext,
    approved: &ApprovedAgentOrgPlan,
) -> Result<Vec<String>, String> {
    let tasks = AgentOrgTaskStore::list(&context.run_id)?;
    let completed_task_id = &approved.task_outcome.current.id;
    let mut wake_member_ids = Vec::new();
    for task in &tasks {
        if task.status != TaskStatus::Pending
            || !task
                .blocked_by
                .iter()
                .any(|blocker_id| blocker_id == completed_task_id)
            || task.blocked_by.iter().any(|blocker_id| {
                tasks
                    .iter()
                    .find(|candidate| &candidate.id == blocker_id)
                    .is_none_or(|candidate| !candidate.status.is_resolved())
            })
        {
            continue;
        }
        let Some(owner_member_id) = task.owner.as_deref() else {
            continue;
        };
        let Some(recipient_agent_id) = context.participant_agent_id(owner_member_id) else {
            continue;
        };
        enqueue_task_assigned_to(
            task,
            &recipient_agent_id,
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

    let remaining_open_task_count = tasks
        .iter()
        .filter(|task| !task.status.is_resolved())
        .count();
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: context.coordinator_agent_id.clone(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        sender_agent_id: SYSTEM_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some(context.run_id.clone()),
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
    })?;
    if !wake_member_ids
        .iter()
        .any(|member_id| member_id == COORDINATOR_MEMBER_ID)
    {
        wake_member_ids.push(COORDINATOR_MEMBER_ID.to_string());
    }
    Ok(wake_member_ids)
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_plan_approvals (
            approval_id TEXT PRIMARY KEY,
            plan_revision_id TEXT NOT NULL UNIQUE,
            request_id TEXT NOT NULL UNIQUE,
            org_run_id TEXT NOT NULL,
            source_task_id TEXT NOT NULL,
            source_member_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            root_session_id TEXT NOT NULL,
            policy TEXT NOT NULL,
            status TEXT NOT NULL,
            plan_title TEXT NOT NULL,
            plan_path TEXT NOT NULL,
            plan_content TEXT NOT NULL,
            decision_by TEXT,
            feedback TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_plan_approvals_run_status
            ON agent_org_plan_approvals(org_run_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_org_plan_approvals_task
            ON agent_org_plan_approvals(org_run_id, source_task_id, created_at);",
    )?;
    Ok(())
}

pub struct AgentOrgPlanApprovalStore;

impl AgentOrgPlanApprovalStore {
    pub fn create_pending(
        params: CreateAgentOrgPlanApprovalParams,
    ) -> Result<AgentOrgPlanApproval, String> {
        with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = create_pending_in_tx(&tx, params)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approval)
        })
    }

    pub fn create_pending_with_request(
        params: CreateAgentOrgPlanApprovalParams,
        delivery: AgentOrgPlanInboxDelivery,
    ) -> Result<AgentOrgPlanApproval, String> {
        if params.policy != PlanApprovalPolicy::Coordinator {
            return Err("plan approval request delivery requires coordinator policy".to_string());
        }
        validate_delivery(&delivery)?;
        with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = create_pending_in_tx(&tx, params)?;
            AgentInboxStore::insert_in_tx(
                &tx,
                InsertInboxParams {
                    recipient_agent_id: delivery.recipient_agent_id,
                    recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                    sender_agent_id: delivery.sender_agent_id,
                    sender_member_id: delivery.sender_member_id,
                    org_run_id: Some(approval.org_run_id.clone()),
                    message: plan_approval_request_message(&approval),
                },
            )?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approval)
        })
    }

    pub fn create_and_approve_automatic(
        params: CreateAgentOrgPlanApprovalParams,
    ) -> Result<ApprovedAgentOrgPlan, String> {
        if params.policy != PlanApprovalPolicy::Automatic {
            return Err("automatic plan approval requires automatic policy".to_string());
        }
        with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = create_pending_in_tx(&tx, params)?;
            let plan_content = approval.plan_content.clone();
            let approved =
                approve_pending_in_tx(&tx, approval, AgentOrgPlanDecisionBy::System, plan_content)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approved)
        })
    }

    pub fn list_pending_by_run(run_id: &str) -> Result<Vec<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT approval_id, plan_revision_id, request_id, org_run_id,
                        source_task_id, source_member_id, source_session_id,
                        root_session_id, policy, status, plan_title, plan_path,
                        plan_content, decision_by, feedback, created_at, resolved_at
                 FROM agent_org_plan_approvals
                 WHERE org_run_id=?1 AND status=?2
                 ORDER BY created_at ASC, approval_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![run_id, AgentOrgPlanApprovalStatus::Pending.as_wire()],
                row_to_record,
            )
            .map_err(|err| err.to_string())?;
        rows.map(|row| row.map_err(|err| err.to_string())).collect()
    }

    pub fn get_pending_by_request_id(
        run_id: &str,
        request_id: &str,
    ) -> Result<Option<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        query_record(
            &conn,
            "WHERE org_run_id=?1 AND request_id=?2 AND status='pending'",
            params![run_id, request_id],
        )
    }

    pub fn approve(
        approval_id: &str,
        plan_revision_id: &str,
        decision_by: AgentOrgPlanDecisionBy,
        edited_content: Option<String>,
    ) -> Result<ApprovedAgentOrgPlan, String> {
        let current = Self::get(approval_id)?
            .ok_or_else(|| format!("agent_org_plan_approval_not_found: {approval_id}"))?;
        authorize_decision(current.policy, decision_by)?;
        if current.plan_revision_id != plan_revision_id
            || current.status != AgentOrgPlanApprovalStatus::Pending
        {
            return Err("agent_org_plan_approval_stale_revision".to_string());
        }
        let mut wrote_edited_file = false;
        let result = with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = query_record(
                &tx,
                "WHERE approval_id=?1 AND plan_revision_id=?2 AND status='pending'",
                params![approval_id, plan_revision_id],
            )?
            .ok_or_else(|| "agent_org_plan_approval_stale_revision".to_string())?;
            authorize_decision(approval.policy, decision_by)?;
            let plan_content = edited_content
                .clone()
                .unwrap_or_else(|| approval.plan_content.clone());
            if edited_content.is_some() {
                std::fs::write(&approval.plan_path, plan_content.as_bytes())
                    .map_err(|err| format!("failed to write edited Agent Org plan: {err}"))?;
                wrote_edited_file = true;
            }
            let approved = approve_pending_in_tx(&tx, approval, decision_by, plan_content)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approved)
        });
        if result.is_err() && wrote_edited_file {
            if let Err(err) = std::fs::write(&current.plan_path, current.plan_content.as_bytes()) {
                tracing::error!(
                    approval_id,
                    error = %err,
                    "failed to restore Agent Org plan file after approval transaction rollback"
                );
            }
        }
        result
    }

    pub fn request_changes(
        approval_id: &str,
        plan_revision_id: &str,
        decision_by: AgentOrgPlanDecisionBy,
        feedback: &str,
        delivery: AgentOrgPlanInboxDelivery,
    ) -> Result<(AgentOrgPlanApproval, AgentInboxRecord), String> {
        let feedback = feedback.trim();
        if feedback.is_empty() {
            return Err("request_changes requires non-empty feedback".to_string());
        }
        validate_delivery(&delivery)?;
        with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = query_record(
                &tx,
                "WHERE approval_id=?1 AND plan_revision_id=?2 AND status='pending'",
                params![approval_id, plan_revision_id],
            )?
            .ok_or_else(|| "agent_org_plan_approval_stale_revision".to_string())?;
            authorize_decision(approval.policy, decision_by)?;
            let run_status: String = tx
                .query_row(
                    "SELECT status FROM agent_org_runs WHERE id=?1",
                    params![&approval.org_run_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            if run_status != "running" {
                return Err(format!(
                    "agent_org_run_not_mutable: run {} is {run_status}",
                    approval.org_run_id
                ));
            }
            let resolved_at = chrono::Utc::now().to_rfc3339();
            let changed = tx
                .execute(
                    "UPDATE agent_org_plan_approvals
                 SET status=?1, decision_by=?2, feedback=?3, resolved_at=?4
                 WHERE approval_id=?5 AND plan_revision_id=?6 AND status=?7",
                    params![
                        AgentOrgPlanApprovalStatus::ChangesRequested.as_wire(),
                        decision_by.as_wire(),
                        feedback,
                        &resolved_at,
                        approval_id,
                        plan_revision_id,
                        AgentOrgPlanApprovalStatus::Pending.as_wire(),
                    ],
                )
                .map_err(|err| err.to_string())?;
            if changed != 1 {
                return Err("agent_org_plan_approval_stale_revision".to_string());
            }
            let inbox_record = AgentInboxStore::insert_in_tx(
                &tx,
                InsertInboxParams {
                    recipient_agent_id: delivery.recipient_agent_id,
                    recipient_member_id: Some(approval.source_member_id.clone()),
                    sender_agent_id: delivery.sender_agent_id,
                    sender_member_id: delivery.sender_member_id,
                    org_run_id: Some(approval.org_run_id.clone()),
                    message: AgentMessage::PlanApprovalResponse {
                        request_id: RequestId(approval.request_id.clone()),
                        accepted: false,
                        feedback: Some(feedback.to_string()),
                        next_mode: Some(crate::session::AgentExecMode::Plan),
                    },
                },
            )?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok((
                AgentOrgPlanApproval {
                    status: AgentOrgPlanApprovalStatus::ChangesRequested,
                    decision_by: Some(decision_by.as_wire().to_string()),
                    feedback: Some(feedback.to_string()),
                    resolved_at: Some(resolved_at),
                    ..approval
                },
                inbox_record,
            ))
        })
    }

    pub fn get(approval_id: &str) -> Result<Option<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        query_record(&conn, "WHERE approval_id=?1", params![approval_id])
    }

    pub fn cancel_pending_for_non_running_runs() -> Result<usize, String> {
        with_sessions_writer(|| {
            let conn = get_connection().map_err(|err| err.to_string())?;
            conn.execute(
                "UPDATE agent_org_plan_approvals
                 SET status=?1, resolved_at=?2
                 WHERE status=?3 AND NOT EXISTS (
                    SELECT 1 FROM agent_org_runs run
                    WHERE run.id=agent_org_plan_approvals.org_run_id
                      AND run.status='running'
                 )",
                params![
                    AgentOrgPlanApprovalStatus::Cancelled.as_wire(),
                    chrono::Utc::now().to_rfc3339(),
                    AgentOrgPlanApprovalStatus::Pending.as_wire(),
                ],
            )
            .map_err(|err| err.to_string())
        })
    }
}

fn create_pending_in_tx(
    tx: &rusqlite::Transaction<'_>,
    params: CreateAgentOrgPlanApprovalParams,
) -> Result<AgentOrgPlanApproval, String> {
    validate_create_params(&params)?;
    let run_status: Option<String> = tx
        .query_row(
            "SELECT status FROM agent_org_runs WHERE id=?1",
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

    let task: Option<(Option<String>, String, Option<String>)> = tx
        .query_row(
            "SELECT owner, status, metadata_json FROM agent_org_tasks
             WHERE org_run_id=?1 AND id=?2",
            params![&params.org_run_id, &params.source_task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((owner, status, metadata_json)) = task else {
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
    let execution_mode = metadata_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|metadata| {
            metadata
                .get(TASK_METADATA_EXECUTION_MODE)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .and_then(|value| TaskExecutionMode::from_wire(&value).ok())
        .unwrap_or(TaskExecutionMode::Build);
    if execution_mode != TaskExecutionMode::Plan {
        return Err(format!(
            "plan_task_execution_mode_mismatch: task {} is not a plan task",
            params.source_task_id
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "UPDATE agent_org_plan_approvals
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

fn approve_pending_in_tx(
    tx: &rusqlite::Transaction<'_>,
    approval: AgentOrgPlanApproval,
    decision_by: AgentOrgPlanDecisionBy,
    plan_content: String,
) -> Result<ApprovedAgentOrgPlan, String> {
    authorize_decision(approval.policy, decision_by)?;
    let plan_char_count = plan_content.chars().count();
    let mut inline_plan_content =
        crate::utils::safe_truncate_chars_to_string(&plan_content, 18_000);
    if plan_char_count > 18_000 {
        inline_plan_content.push_str(&format!(
            "\n\n[Plan truncated for task handoff; full {}-character plan is stored at {}]",
            plan_char_count, approval.plan_path
        ));
    }
    let output = TaskOutput {
        summary: crate::utils::safe_truncate_chars_to_string(
            &format!("Approved plan: {}", approval.plan_title),
            500,
        ),
        content: Some(inline_plan_content),
        artifact_ids: vec![approval.plan_path.clone()],
        produced_by_member_id: approval.source_member_id.clone(),
        produced_at: chrono::Utc::now().to_rfc3339(),
    };
    let task_outcome = AgentOrgTaskStore::complete_planning_task_in_tx(
        tx,
        &approval.org_run_id,
        &approval.source_task_id,
        &approval.source_member_id,
        output,
    )?;
    let resolved_at = chrono::Utc::now().to_rfc3339();
    let changed = tx
        .execute(
            "UPDATE agent_org_plan_approvals
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
    Ok(ApprovedAgentOrgPlan {
        approval: AgentOrgPlanApproval {
            status: AgentOrgPlanApprovalStatus::Approved,
            decision_by: Some(decision_by.as_wire().to_string()),
            plan_content,
            resolved_at: Some(resolved_at),
            ..approval
        },
        task_outcome,
    })
}

fn plan_approval_request_message(approval: &AgentOrgPlanApproval) -> AgentMessage {
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

fn validate_delivery(delivery: &AgentOrgPlanInboxDelivery) -> Result<(), String> {
    if delivery.recipient_agent_id.trim().is_empty() || delivery.sender_agent_id.trim().is_empty() {
        Err("plan approval delivery requires non-empty agent ids".to_string())
    } else {
        Ok(())
    }
}

fn validate_create_params(params: &CreateAgentOrgPlanApprovalParams) -> Result<(), String> {
    if params.request_id.trim().is_empty()
        || params.org_run_id.trim().is_empty()
        || params.source_task_id.trim().is_empty()
        || params.source_member_id.trim().is_empty()
        || params.source_session_id.trim().is_empty()
        || params.root_session_id.trim().is_empty()
    {
        return Err("plan approval identifiers must not be empty".to_string());
    }
    if params.plan_title.trim().is_empty() {
        return Err("plan approval title must not be empty".to_string());
    }
    if params.plan_path.trim().is_empty() {
        return Err("plan approval path must not be empty".to_string());
    }
    if params.plan_content.trim().is_empty() {
        return Err("plan approval content must not be empty".to_string());
    }
    Ok(())
}

fn authorize_decision(
    policy: PlanApprovalPolicy,
    decision_by: AgentOrgPlanDecisionBy,
) -> Result<(), String> {
    let authorized = matches!(
        (policy, decision_by),
        (PlanApprovalPolicy::User, AgentOrgPlanDecisionBy::User)
            | (
                PlanApprovalPolicy::Coordinator,
                AgentOrgPlanDecisionBy::Coordinator
            )
            | (
                PlanApprovalPolicy::Automatic,
                AgentOrgPlanDecisionBy::System
            )
    );
    if authorized {
        Ok(())
    } else {
        Err(format!(
            "agent_org_plan_approval_unauthorized: policy={} decision_by={}",
            policy.as_wire(),
            decision_by.as_wire()
        ))
    }
}

fn insert_record(conn: &Connection, approval: &AgentOrgPlanApproval) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_org_plan_approvals (
            approval_id, plan_revision_id, request_id, org_run_id,
            source_task_id, source_member_id, source_session_id, root_session_id,
            policy, status, plan_title, plan_path, plan_content, decision_by,
            feedback, created_at, resolved_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![
            &approval.approval_id,
            &approval.plan_revision_id,
            &approval.request_id,
            &approval.org_run_id,
            &approval.source_task_id,
            &approval.source_member_id,
            &approval.source_session_id,
            &approval.root_session_id,
            approval.policy.as_wire(),
            approval.status.as_wire(),
            &approval.plan_title,
            &approval.plan_path,
            &approval.plan_content,
            approval.decision_by.as_deref(),
            approval.feedback.as_deref(),
            &approval.created_at,
            approval.resolved_at.as_deref(),
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn query_record<P: rusqlite::Params>(
    conn: &Connection,
    where_clause: &str,
    params: P,
) -> Result<Option<AgentOrgPlanApproval>, String> {
    let sql = format!(
        "SELECT approval_id, plan_revision_id, request_id, org_run_id,
                source_task_id, source_member_id, source_session_id,
                root_session_id, policy, status, plan_title, plan_path,
                plan_content, decision_by, feedback, created_at, resolved_at
         FROM agent_org_plan_approvals {where_clause} LIMIT 1"
    );
    conn.query_row(&sql, params, row_to_record)
        .optional()
        .map_err(|err| err.to_string())
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgPlanApproval> {
    let policy_raw: String = row.get(8)?;
    let status_raw: String = row.get(9)?;
    let policy = match policy_raw.as_str() {
        "coordinator" => PlanApprovalPolicy::Coordinator,
        "user" => PlanApprovalPolicy::User,
        "automatic" => PlanApprovalPolicy::Automatic,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                format!("unknown plan approval policy: {policy_raw}").into(),
            ))
        }
    };
    let status = AgentOrgPlanApprovalStatus::from_wire(&status_raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, err.into())
    })?;
    Ok(AgentOrgPlanApproval {
        approval_id: row.get(0)?,
        plan_revision_id: row.get(1)?,
        request_id: row.get(2)?,
        org_run_id: row.get(3)?,
        source_task_id: row.get(4)?,
        source_member_id: row.get(5)?,
        source_session_id: row.get(6)?,
        root_session_id: row.get(7)?,
        policy,
        status,
        plan_title: row.get(10)?,
        plan_path: row.get(11)?,
        plan_content: row.get(12)?,
        decision_by: row.get(13)?,
        feedback: row.get(14)?,
        created_at: row.get(15)?,
        resolved_at: row.get(16)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_org_runs::{
        AgentOrgContextMember, AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore,
        CreateAgentOrgRunParams,
    };
    use crate::coordination::agent_org_tasks::{CreateTaskParams, TaskStatus};
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember};

    fn setup(
        policy: PlanApprovalPolicy,
    ) -> (test_helpers::test_env::SandboxGuard, AgentOrgRunContext) {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("test db");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("inbox schema");
        init_schema(&conn).expect("approval schema");

        let org = OrgDefinition {
            id: "org-plan-approval".into(),
            name: "Plan Approval Org".into(),
            role: "lead".into(),
            agent_id: "coord-agent".into(),
            description: None,
            instructions: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: policy,
            children: vec![
                OrgMember {
                    id: "planner".into(),
                    name: "Planner".into(),
                    role: "plan".into(),
                    agent_id: "planner-agent".into(),
                    instructions: None,
                    runtime_config: None,
                    children: Vec::new(),
                },
                OrgMember {
                    id: "builder".into(),
                    name: "Builder".into(),
                    role: "build".into(),
                    agent_id: "builder-agent".into(),
                    instructions: None,
                    runtime_config: None,
                    children: Vec::new(),
                },
            ],
        };
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: org.id.clone(),
            coordinator_agent_id: org.agent_id.clone(),
            root_session_id: Some("root-plan-approval".into()),
            org_snapshot: org,
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create run");
        let context = AgentOrgRunContext {
            run_id: run.id,
            org_id: "org-plan-approval".into(),
            org_name: "Plan Approval Org".into(),
            org_role: "lead".into(),
            coordinator_agent_id: "coord-agent".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "lead".into(),
            coordinator_instructions: None,
            members: vec![
                AgentOrgContextMember {
                    member_id: "planner".into(),
                    name: "Planner".into(),
                    role: "plan".into(),
                    agent_id: "planner-agent".into(),
                    instructions: None,
                    parent_member_id: None,
                },
                AgentOrgContextMember {
                    member_id: "builder".into(),
                    name: "Builder".into(),
                    role: "build".into(),
                    agent_id: "builder-agent".into(),
                    instructions: None,
                    parent_member_id: None,
                },
            ],
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: policy,
            root_session_id: Some("root-plan-approval".into()),
        };
        (sandbox, context)
    }

    fn create_plan_task(context: &AgentOrgRunContext) {
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "plan-task".into(),
            org_run_id: context.run_id.clone(),
            subject: "Plan the work".into(),
            description: "Produce a plan".into(),
            active_form: None,
            owner: Some("planner".into()),
            status: TaskStatus::InProgress,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "plan" })),
        })
        .expect("create plan task");
    }

    fn approval_params(context: &AgentOrgRunContext) -> CreateAgentOrgPlanApprovalParams {
        CreateAgentOrgPlanApprovalParams {
            request_id: "request-plan".into(),
            org_run_id: context.run_id.clone(),
            source_task_id: "plan-task".into(),
            source_member_id: "planner".into(),
            source_session_id: "planner-session".into(),
            root_session_id: "root-plan-approval".into(),
            policy: context.plan_approval_policy,
            plan_title: "Implementation plan".into(),
            plan_path: std::env::temp_dir()
                .join(format!("{}.md", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
            plan_content: "# Plan\n\n1. Build it.".into(),
        }
    }

    fn create_pending_approval(context: &AgentOrgRunContext) -> AgentOrgPlanApproval {
        AgentOrgPlanApprovalStore::create_pending(approval_params(context))
            .expect("create approval")
    }

    fn planner_changes_delivery() -> AgentOrgPlanInboxDelivery {
        AgentOrgPlanInboxDelivery {
            recipient_agent_id: "planner-agent".into(),
            sender_agent_id: "coord-agent".into(),
            sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        }
    }

    fn coordinator_request_delivery() -> AgentOrgPlanInboxDelivery {
        AgentOrgPlanInboxDelivery {
            recipient_agent_id: "coord-agent".into(),
            sender_agent_id: "planner-agent".into(),
            sender_member_id: Some("planner".into()),
        }
    }

    #[test]
    fn approval_completes_source_task_and_dispatches_unblocked_work() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "build-task".into(),
            org_run_id: context.run_id.clone(),
            subject: "Build the plan".into(),
            description: "Use the approved plan".into(),
            active_form: None,
            owner: Some("builder".into()),
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: vec!["plan-task".into()],
            metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "build" })),
        })
        .expect("create dependent task");
        let pending = create_pending_approval(&context);

        let approved = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            None,
        )
        .expect("approve");
        assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
        let output =
            crate::coordination::agent_org_tasks::task_output(&approved.task_outcome.current)
                .expect("plan output");
        assert!(output
            .content
            .as_deref()
            .is_some_and(|value| value.contains("Build it")));

        let wake_members = enqueue_post_approval_messages(&context, &approved)
            .expect("dispatch dependency messages");
        assert!(wake_members.contains(&"builder".to_string()));
        assert!(wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
        let builder_inbox =
            AgentInboxStore::list_unread_for_member("builder", &context.run_id).unwrap();
        assert!(builder_inbox
            .iter()
            .any(|row| row.payload_kind == "task_assigned"));
    }

    #[test]
    fn approval_policy_rejects_the_wrong_decision_actor() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        let error = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            None,
        )
        .expect_err("coordinator cannot bypass user policy");
        assert!(error.contains("unauthorized"));
        assert_eq!(
            AgentOrgTaskStore::get(&context.run_id, "plan-task")
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::InProgress
        );
    }

    #[test]
    fn coordinator_request_and_pending_approval_commit_together() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);

        let approval = AgentOrgPlanApprovalStore::create_pending_with_request(
            approval_params(&context),
            coordinator_request_delivery(),
        )
        .expect("create approval and coordinator request");

        assert_eq!(approval.status, AgentOrgPlanApprovalStatus::Pending);
        let coordinator_inbox =
            AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, &context.run_id)
                .unwrap();
        assert!(coordinator_inbox.iter().any(|row| {
            row.payload_kind == "plan_approval_request"
                && row.request_id.as_deref() == Some(approval.request_id.as_str())
        }));
    }

    #[test]
    fn coordinator_request_insert_failure_rolls_back_pending_creation() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        get_connection()
            .expect("test db")
            .execute("DROP TABLE agent_inbox", [])
            .expect("remove inbox to force request delivery failure");

        AgentOrgPlanApprovalStore::create_pending_with_request(
            approval_params(&context),
            coordinator_request_delivery(),
        )
        .expect_err("request delivery failure must reject approval creation");

        assert!(
            AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            AgentOrgTaskStore::get(&context.run_id, "plan-task")
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::InProgress
        );
    }

    #[test]
    fn automatic_creation_approves_plan_task_in_one_transaction() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Automatic);
        create_plan_task(&context);

        let approved =
            AgentOrgPlanApprovalStore::create_and_approve_automatic(approval_params(&context))
                .expect("create and automatically approve");

        assert_eq!(
            approved.approval.status,
            AgentOrgPlanApprovalStatus::Approved
        );
        assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
        assert!(
            AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn approval_leaves_newly_ready_ownerless_task_for_coordinator_assignment() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "claim-after-plan".into(),
            org_run_id: context.run_id.clone(),
            subject: "Claim approved work".into(),
            description: String::new(),
            active_form: None,
            owner: None,
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: vec!["plan-task".into()],
            metadata: Some(serde_json::json!({
                crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
                TASK_METADATA_EXECUTION_MODE: "build",
            })),
        })
        .expect("create ownerless dependent task");
        let pending = create_pending_approval(&context);
        let approved = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            None,
        )
        .expect("approve");

        let wake_members = enqueue_post_approval_messages(&context, &approved)
            .expect("calculate post-approval wakes");
        assert!(!wake_members.contains(&"builder".to_string()));
        assert!(wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
        assert!(
            AgentInboxStore::list_unread_for_member("builder", &context.run_id)
                .unwrap()
                .is_empty(),
            "ownerless work must not forge TaskAssigned or wake a candidate"
        );
        let task = AgentOrgTaskStore::get(&context.run_id, "claim-after-plan")
            .unwrap()
            .unwrap();
        assert_eq!(task.owner, None);
        assert_eq!(task.status, TaskStatus::Pending);
    }

    #[test]
    fn user_edit_is_persisted_to_file_task_output_and_approval() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        std::fs::write(&pending.plan_path, &pending.plan_content).expect("seed plan file");

        let edited = "# Revised plan\n\n1. Validate.\n2. Build.".to_string();
        let approved = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::User,
            Some(edited.clone()),
        )
        .expect("approve edits");

        assert_eq!(approved.approval.plan_content, edited);
        assert_eq!(
            std::fs::read_to_string(&pending.plan_path).expect("read revised plan"),
            edited
        );
        assert_eq!(
            crate::coordination::agent_org_tasks::task_output(&approved.task_outcome.current)
                .and_then(|output| output.content),
            Some(edited)
        );
    }

    #[test]
    fn stale_revision_cannot_complete_a_plan_twice() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            None,
        )
        .expect("first approval");

        let error = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            None,
        )
        .expect_err("same revision must be one-shot");
        assert!(error.contains("stale_revision"));
    }

    #[test]
    fn changes_requested_and_feedback_delivery_commit_together() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);

        let (changed, inbox_record) = AgentOrgPlanApprovalStore::request_changes(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            "Add rollback coverage.",
            planner_changes_delivery(),
        )
        .expect("request plan changes");

        assert_eq!(changed.status, AgentOrgPlanApprovalStatus::ChangesRequested);
        assert_eq!(inbox_record.recipient_member_id.as_deref(), Some("planner"));
        assert_eq!(inbox_record.payload_kind, "plan_approval_response");
        assert_eq!(
            AgentOrgTaskStore::get(&context.run_id, "plan-task")
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::InProgress
        );
    }

    #[test]
    fn feedback_insert_failure_rolls_back_changes_requested_status() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        get_connection()
            .expect("test db")
            .execute("DROP TABLE agent_inbox", [])
            .expect("remove inbox to force delivery failure");

        AgentOrgPlanApprovalStore::request_changes(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            "This feedback cannot be delivered.",
            planner_changes_delivery(),
        )
        .expect_err("delivery failure must reject the whole transition");

        assert_eq!(
            AgentOrgPlanApprovalStore::get(&pending.approval_id)
                .unwrap()
                .unwrap()
                .status,
            AgentOrgPlanApprovalStatus::Pending
        );
        assert_eq!(
            AgentOrgTaskStore::get(&context.run_id, "plan-task")
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::InProgress
        );
    }

    #[test]
    fn paused_run_rejects_plan_decisions_without_mutating_task() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        AgentOrgRunStore::mark_paused(&context.run_id).expect("pause run");

        let error = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::User,
            None,
        )
        .expect_err("paused run must reject approval");
        assert!(error.contains("not_mutable"));
        assert_eq!(
            AgentOrgTaskStore::get(&context.run_id, "plan-task")
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::InProgress
        );
    }
}
