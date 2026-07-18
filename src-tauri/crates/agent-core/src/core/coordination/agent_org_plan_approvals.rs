//! Durable approval state for plans produced by Agent Org planning tasks.
//!
//! This is intentionally separate from `interaction::plan_approval`: the
//! latter belongs to one top-level session and its Build button starts a new
//! turn in that same session. An Agent Org approval instead completes a
//! planning task and unlocks the run's dynamic dependency graph.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, RequestId, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_payload_limits::{
    validate_required_text, PLAN_CONTENT_MAX_BYTES, PLAN_CONTENT_MAX_CHARS,
    PLAN_FEEDBACK_MAX_BYTES, PLAN_FEEDBACK_MAX_CHARS, PLAN_PATH_MAX_BYTES, PLAN_PATH_MAX_CHARS,
    PLAN_TITLE_MAX_BYTES, PLAN_TITLE_MAX_CHARS,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, TaskExecutionMode, TaskMutationOutcome, TaskOutput, TaskStatus,
    TASK_METADATA_EXECUTION_MODE,
};
use crate::definitions::orgs::{OrgDefinition, OrgMember, PlanApprovalPolicy};

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

/// Lightweight projection used by the frequently-polled Agent Org Run View.
///
/// `plan_revision_id` is the immutable cache key for fetching the full detail.
/// Keeping the Markdown and local path out of this DTO prevents every Run View
/// refresh from copying the complete plan across SQLite, Rust, and Tauri IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgPlanApprovalSummary {
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
    pub plan_content_bytes: u64,
    pub created_at: String,
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
    /// Durable inbox rows are committed in the same transaction as the
    /// approval and planning-task completion. Only these best-effort wake
    /// signals remain for callers to dispatch after commit.
    pub wake_member_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentOrgPlanInboxDelivery {
    pub recipient_agent_id: String,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentOrgPlanArtifactRepairReport {
    pub inspected: usize,
    pub repaired: usize,
    pub failed: usize,
}

impl AgentOrgPlanApprovalStore {
    /// Resolve a filename under the exact Plan root owned by a persisted
    /// source session. Callers use this when they need a fresh path after a
    /// historical revision points outside the session's managed root.
    pub fn managed_plan_path_for_session(
        source_session_id: &str,
        file_name: &str,
    ) -> Result<PathBuf, String> {
        validate_plan_file_name(file_name)?;
        let conn = get_connection().map_err(|err| err.to_string())?;
        let (root, _) = expected_plan_root_with_connection(&conn, source_session_id)?;
        Ok(root.join(file_name))
    }

    /// Best-effort cleanup for a derived artifact. Historical rows may contain
    /// arbitrary paths; those are deliberately retained on disk and only
    /// logged. No filesystem operation occurs until session-root ownership and
    /// symlink/canonical containment have both been proven.
    pub fn remove_managed_plan_artifact(
        source_session_id: &str,
        plan_path: &str,
    ) -> Result<bool, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let owned =
            match validate_owned_plan_path_with_connection(&conn, source_session_id, plan_path) {
                Ok(owned) => owned,
                Err(err) => {
                    tracing::warn!(
                        source_session_id,
                        plan_path,
                        error = %err,
                        "skipping unmanaged Agent Org plan artifact deletion"
                    );
                    return Ok(false);
                }
            };
        let target = match resolve_owned_plan_target(&owned, false) {
            Ok(Some(target)) => target,
            Ok(None) => return Ok(false),
            Err(err) => {
                tracing::warn!(
                    source_session_id,
                    plan_path,
                    error = %err,
                    "skipping unsafe Agent Org plan artifact deletion"
                );
                return Ok(false);
            }
        };
        let _artifact_guard = plan_artifact_install_lock().lock();
        match std::fs::remove_file(&target) {
            Ok(()) => {
                sync_parent_directory(&target)?;
                Ok(true)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(format!(
                "failed to remove managed Agent Org plan artifact {}: {err}",
                target.display()
            )),
        }
    }

    pub fn create_pending(
        params: CreateAgentOrgPlanApprovalParams,
    ) -> Result<AgentOrgPlanApproval, String> {
        validate_create_params(&params)?;
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let staged_artifact = Some(stage_plan_artifact_with_connection(
            &conn,
            &params.source_session_id,
            &params.plan_path,
            &params.plan_content,
        )?);
        let _artifact_guard = plan_artifact_install_lock().lock();
        let result = with_sessions_writer(|| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = create_pending_in_tx(&tx, params)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approval)
        });
        let result = result.map(|approval| {
            let artifact_error = install_staged_plan_artifact(staged_artifact.as_ref()).err();
            (approval, artifact_error)
        });
        let approval = finish_committed_artifact(result, staged_artifact.as_ref())?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &approval.org_run_id,
        );
        Ok(approval)
    }

    pub fn create_pending_with_request(
        params: CreateAgentOrgPlanApprovalParams,
        delivery: AgentOrgPlanInboxDelivery,
    ) -> Result<AgentOrgPlanApproval, String> {
        if params.policy != PlanApprovalPolicy::Coordinator {
            return Err("plan approval request delivery requires coordinator policy".to_string());
        }
        validate_delivery(&delivery)?;
        validate_create_params(&params)?;
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let staged_artifact = Some(stage_plan_artifact_with_connection(
            &conn,
            &params.source_session_id,
            &params.plan_path,
            &params.plan_content,
        )?);
        let _artifact_guard = plan_artifact_install_lock().lock();
        let result = with_sessions_writer(|| {
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
        });
        let result = result.map(|approval| {
            let artifact_error = install_staged_plan_artifact(staged_artifact.as_ref()).err();
            (approval, artifact_error)
        });
        let approval = finish_committed_artifact(result, staged_artifact.as_ref())?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &approval.org_run_id,
        );
        Ok(approval)
    }

    pub fn create_and_approve_automatic(
        params: CreateAgentOrgPlanApprovalParams,
    ) -> Result<ApprovedAgentOrgPlan, String> {
        if params.policy != PlanApprovalPolicy::Automatic {
            return Err("automatic plan approval requires automatic policy".to_string());
        }
        validate_create_params(&params)?;
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let staged_artifact = Some(stage_plan_artifact_with_connection(
            &conn,
            &params.source_session_id,
            &params.plan_path,
            &params.plan_content,
        )?);
        let _artifact_guard = plan_artifact_install_lock().lock();
        let result = with_sessions_writer(|| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let approval = create_pending_in_tx(&tx, params)?;
            let plan_content = approval.plan_content.clone();
            let approved =
                approve_pending_in_tx(&tx, approval, AgentOrgPlanDecisionBy::System, plan_content)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approved)
        });
        let result = result.map(|approved| {
            let artifact_error = install_staged_plan_artifact(staged_artifact.as_ref()).err();
            (approved, artifact_error)
        });
        let approved = finish_committed_artifact(result, staged_artifact.as_ref())?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &approved.approval.org_run_id,
        );
        Ok(approved)
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

    /// Lightweight watchdog projection. Plan Markdown can be hundreds of KB;
    /// recovery only needs to know which task ids are waiting for approval.
    pub fn pending_source_task_ids_by_run(run_id: &str) -> Result<Vec<String>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT source_task_id FROM agent_org_plan_approvals
                 WHERE org_run_id=?1 AND status=?2
                 ORDER BY created_at ASC, approval_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![run_id, AgentOrgPlanApprovalStatus::Pending.as_wire()],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    pub fn list_pending_summaries_by_run(
        run_id: &str,
    ) -> Result<Vec<AgentOrgPlanApprovalSummary>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_pending_summaries_by_run_with_connection(&conn, run_id)
    }

    /// Lightweight approval projection on a caller-owned read snapshot.
    pub(crate) fn list_pending_summaries_by_run_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentOrgPlanApprovalSummary>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT approval_id, plan_revision_id, request_id, org_run_id,
                        source_task_id, source_member_id, source_session_id,
                        root_session_id, policy, status, plan_title,
                        length(CAST(plan_content AS BLOB)), created_at
                 FROM agent_org_plan_approvals
                 WHERE org_run_id=?1 AND status=?2
                 ORDER BY created_at ASC, approval_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![run_id, AgentOrgPlanApprovalStatus::Pending.as_wire()],
                row_to_summary,
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

    /// Resolve a durable approval correlation regardless of its current
    /// decision state. Pre-turn inbox control uses this to authenticate a
    /// changes-requested response against its source member/task; requiring
    /// `pending` would reject the response precisely because requesting
    /// changes transitions the record to `changes_requested` atomically with
    /// delivery.
    pub fn get_by_request_id(
        run_id: &str,
        request_id: &str,
    ) -> Result<Option<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        query_record(
            &conn,
            "WHERE org_run_id=?1 AND request_id=?2",
            params![run_id, request_id],
        )
    }

    pub fn approve(
        approval_id: &str,
        plan_revision_id: &str,
        decision_by: AgentOrgPlanDecisionBy,
        edited_content: Option<String>,
    ) -> Result<ApprovedAgentOrgPlan, String> {
        if let Some(edited_content) = edited_content.as_deref() {
            validate_required_text(
                "plan approval edited content",
                edited_content,
                PLAN_CONTENT_MAX_CHARS,
                PLAN_CONTENT_MAX_BYTES,
            )?;
        }
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let current = query_record(&conn, "WHERE approval_id=?1", params![approval_id])?
            .ok_or_else(|| format!("agent_org_plan_approval_not_found: {approval_id}"))?;
        authorize_decision(current.policy, decision_by)?;
        if current.plan_revision_id != plan_revision_id
            || current.status != AgentOrgPlanApprovalStatus::Pending
        {
            return Err("agent_org_plan_approval_stale_revision".to_string());
        }
        // SQLite is the durable source of truth. Prepare and fsync the slow
        // file bytes before taking the sessions writer, commit SQLite first,
        // then perform only the same-directory rename while writes remain
        // serialized. A process crash in the tiny commit -> rename window is
        // healed from `plan_content` on startup or the next detail read.
        let canonical_content = edited_content
            .clone()
            .unwrap_or_else(|| current.plan_content.clone());
        // Always stage a fresh copy for a DB mutation. Merely observing that
        // the current artifact already matches is not enough: another plan
        // revision can commit between this preflight and our writer turn.
        // The staged copy ensures install order always follows commit order.
        let staged_artifact = stage_plan_artifact_for_existing_revision_with_connection(
            &conn,
            &current.source_session_id,
            &current.plan_path,
            &canonical_content,
        )?;
        // Serialize only plan-artifact commit order. The slower rename and
        // directory fsync happen after releasing the shared sessions writer,
        // so unrelated Task/Session/Inbox mutations keep flowing.
        let _artifact_guard = plan_artifact_install_lock().lock();
        let result = with_sessions_writer(|| {
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
            let install_artifact = if staged_artifact.is_some() {
                match validate_owned_plan_path_with_connection(
                    &tx,
                    &approval.source_session_id,
                    &approval.plan_path,
                ) {
                    Ok(_) => true,
                    Err(err) => {
                        tracing::warn!(
                            source_session_id = %approval.source_session_id,
                            plan_path = %approval.plan_path,
                            error = %err,
                            "skipping Agent Org plan artifact install after ownership changed"
                        );
                        false
                    }
                }
            } else {
                false
            };
            let plan_content = edited_content
                .clone()
                .unwrap_or_else(|| approval.plan_content.clone());
            let approved = approve_pending_in_tx(&tx, approval, decision_by, plan_content)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok((approved, install_artifact))
        });
        let result = result.map(|(approved, install_artifact)| {
            let artifact_error = install_artifact
                .then(|| install_staged_plan_artifact(staged_artifact.as_ref()).err())
                .flatten();
            (approved, artifact_error)
        });
        let approved = finish_committed_artifact(result, staged_artifact.as_ref())?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &current.org_run_id,
        );
        Ok(approved)
    }

    pub fn request_changes(
        approval_id: &str,
        plan_revision_id: &str,
        decision_by: AgentOrgPlanDecisionBy,
        feedback: &str,
        delivery: AgentOrgPlanInboxDelivery,
    ) -> Result<(AgentOrgPlanApproval, AgentInboxRecord), String> {
        let feedback = feedback.trim();
        validate_required_text(
            "plan approval feedback",
            feedback,
            PLAN_FEEDBACK_MAX_CHARS,
            PLAN_FEEDBACK_MAX_BYTES,
        )?;
        validate_delivery(&delivery)?;
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
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &result.0.org_run_id,
        );
        Ok(result)
    }

    pub fn get(approval_id: &str) -> Result<Option<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        query_record(&conn, "WHERE approval_id=?1", params![approval_id])
    }

    /// Read one immutable plan revision and best-effort reconcile the shared
    /// plan artifact to the latest revision stored for that path.
    ///
    /// Historical rows remain immutable and are returned exactly as stored;
    /// only the derived filesystem artifact is repaired. A repair failure is
    /// logged rather than turning an otherwise valid detail read into a false
    /// user-visible failure.
    pub fn get_revision(
        approval_id: &str,
        plan_revision_id: &str,
    ) -> Result<Option<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let record = query_record(
            &conn,
            "WHERE approval_id=?1 AND plan_revision_id=?2",
            params![approval_id, plan_revision_id],
        )?;
        drop(conn);
        if let Some(record) = record.as_ref() {
            if let Err(err) = repair_latest_plan_artifact_for_path(&record.plan_path) {
                tracing::warn!(
                    approval_id,
                    plan_revision_id,
                    plan_path = %record.plan_path,
                    error = %err,
                    "failed to reconcile Agent Org plan artifact during detail read"
                );
            }
        }
        Ok(record)
    }

    /// Run-scoped detail lookup for user-facing/API callers. The ownership
    /// predicate is part of the SQLite query, so an approval from another Run
    /// cannot trigger even the best-effort filesystem repair performed after
    /// an authorized detail read.
    pub fn get_revision_for_run(
        org_run_id: &str,
        approval_id: &str,
        plan_revision_id: &str,
    ) -> Result<Option<AgentOrgPlanApproval>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let record = query_record(
            &conn,
            "WHERE org_run_id=?1 AND approval_id=?2 AND plan_revision_id=?3",
            params![org_run_id, approval_id, plan_revision_id],
        )?;
        drop(conn);
        if let Some(record) = record.as_ref() {
            if let Err(err) = repair_latest_plan_artifact_for_path(&record.plan_path) {
                tracing::warn!(
                    org_run_id,
                    approval_id,
                    plan_revision_id,
                    plan_path = %record.plan_path,
                    error = %err,
                    "failed to reconcile Agent Org plan artifact during run-scoped detail read"
                );
            }
        }
        Ok(record)
    }

    /// Reconcile every physical plan artifact from the latest durable SQLite
    /// revision for its path. The query is paged so retained approval history
    /// cannot create one unbounded allocation. Individual corrupt/unwritable
    /// paths are isolated and reported without preventing other plans from
    /// being repaired.
    pub fn repair_latest_plan_artifacts() -> Result<AgentOrgPlanArtifactRepairReport, String> {
        const PAGE_SIZE: usize = 64;

        let mut report = AgentOrgPlanArtifactRepairReport::default();
        let mut after_path: Option<String> = None;
        loop {
            let paths = list_distinct_plan_paths_after(after_path.as_deref(), PAGE_SIZE)?;
            if paths.is_empty() {
                break;
            }
            for path in &paths {
                report.inspected += 1;
                match repair_latest_plan_artifact_for_path(path) {
                    Ok(true) => report.repaired += 1,
                    Ok(false) => {}
                    Err(err) => {
                        report.failed += 1;
                        tracing::warn!(
                            plan_path = %path,
                            error = %err,
                            "failed to reconcile one Agent Org plan artifact"
                        );
                    }
                }
            }
            after_path = paths.last().cloned();
            if paths.len() < PAGE_SIZE {
                break;
            }
        }
        Ok(report)
    }

    /// Cancel approvals whose parent run is gone or terminal. A paused run is
    /// resumable and must keep its pending approval intact.
    pub fn cancel_pending_for_terminal_or_missing_runs() -> Result<usize, String> {
        let (changed, run_ids) =
            with_sessions_writer(|| -> Result<(usize, Vec<String>), String> {
                let conn = get_connection().map_err(|err| err.to_string())?;
                let run_ids = {
                    let mut stmt = conn
                        .prepare(
                            "SELECT DISTINCT approval.org_run_id
                         FROM agent_org_plan_approvals approval
                         WHERE approval.status=?1
                           AND (
                             NOT EXISTS (
                               SELECT 1 FROM agent_org_runs run
                               WHERE run.id=approval.org_run_id
                             )
                             OR EXISTS (
                               SELECT 1 FROM agent_org_runs run
                               WHERE run.id=approval.org_run_id
                                 AND run.status IN ('completed','failed','cancelled','abandoned')
                             )
                           )",
                        )
                        .map_err(|err| err.to_string())?;
                    let rows = stmt
                        .query_map(
                            params![AgentOrgPlanApprovalStatus::Pending.as_wire()],
                            |row| row.get::<_, String>(0),
                        )
                        .map_err(|err| err.to_string())?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|err| err.to_string())?
                };
                let changed = conn
                    .execute(
                        "UPDATE agent_org_plan_approvals
                 SET status=?1, decision_by='system', resolved_at=?2
                 WHERE status=?3
                   AND (
                     NOT EXISTS (
                       SELECT 1 FROM agent_org_runs run
                       WHERE run.id=agent_org_plan_approvals.org_run_id
                     )
                     OR EXISTS (
                       SELECT 1 FROM agent_org_runs run
                       WHERE run.id=agent_org_plan_approvals.org_run_id
                         AND run.status IN ('completed','failed','cancelled','abandoned')
                     )
                   )",
                        params![
                            AgentOrgPlanApprovalStatus::Cancelled.as_wire(),
                            chrono::Utc::now().to_rfc3339(),
                            AgentOrgPlanApprovalStatus::Pending.as_wire(),
                        ],
                    )
                    .map_err(|err| err.to_string())?;
                Ok((changed, run_ids))
            })?;
        for run_id in run_ids {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        }
        Ok(changed)
    }
}

/// A fully-written, fsynced artifact waiting for its short atomic install.
///
/// The temporary file lives beside the target so `rename` never crosses a
/// filesystem boundary. Dropping an uninstalled stage cleans up failed DB
/// attempts without touching the previously committed artifact.
#[derive(Clone)]
struct OwnedPlanPath {
    logical_path: PathBuf,
    root: PathBuf,
    anchor: PathBuf,
    file_name: String,
}

struct StagedPlanArtifact {
    owned: OwnedPlanPath,
    temp_path: PathBuf,
    target_path: PathBuf,
}

/// Plan artifacts are a derived filesystem projection of SQLite state. A
/// dedicated lock preserves commit/install order without holding the global
/// sessions writer across rename or directory fsync.
fn plan_artifact_install_lock() -> &'static parking_lot::Mutex<()> {
    static LOCK: OnceLock<parking_lot::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| parking_lot::Mutex::new(()))
}

impl Drop for StagedPlanArtifact {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_file(&self.temp_path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %self.temp_path.display(),
                    error = %err,
                    "failed to remove staged Agent Org plan artifact"
                );
            }
        }
    }
}

fn validate_plan_file_name(file_name: &str) -> Result<(), String> {
    let path = Path::new(file_name);
    let mut components = path.components();
    let single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !single_normal_component
        || !file_name.ends_with(".plan.md")
        || file_name.trim_end_matches(".plan.md").is_empty()
    {
        return Err(format!(
            "Agent Org plan artifact must be one *.plan.md filename, got '{file_name}'"
        ));
    }
    Ok(())
}

fn expected_plan_root_with_connection(
    conn: &Connection,
    source_session_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let session: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT workspace_path, agent_definition_id
             FROM agent_sessions WHERE session_id=?1",
            params![source_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((workspace_path, agent_definition_id)) = session else {
        return Err(format!(
            "Agent Org plan source session does not exist: {source_session_id}"
        ));
    };

    if let Some(workspace_path) = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let anchor = PathBuf::from(workspace_path);
        if !anchor.is_absolute()
            || anchor
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(format!(
                "Agent Org plan source session has an unsafe workspace_path: {workspace_path}"
            ));
        }
        return Ok((anchor.join(".orgii").join("plans"), anchor));
    }

    let agent_id = agent_definition_id.as_deref().unwrap_or("default");
    validate_plan_file_name_component("agent_definition_id", agent_id)?;
    let root = crate::session::plan_mode::paths::plans_directory(None, agent_id)
        .ok_or_else(|| "could not resolve Agent Org fallback Plan root".to_string())?;
    let anchor = root
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("invalid Agent Org fallback Plan root: {}", root.display()))?;
    Ok((root, anchor))
}

fn validate_plan_file_name_component(field: &str, value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    if value.trim().is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!(
            "Agent Org plan {field} must be one safe path component"
        ));
    }
    Ok(())
}

fn validate_owned_plan_path_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
) -> Result<OwnedPlanPath, String> {
    let logical_path = PathBuf::from(plan_path);
    let file_name = logical_path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .ok_or_else(|| format!("Agent Org plan path has no UTF-8 filename: {plan_path}"))?
        .to_string();
    validate_plan_file_name(&file_name)?;
    let (root, anchor) = expected_plan_root_with_connection(conn, source_session_id)?;
    if !logical_path.is_absolute()
        || logical_path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        || logical_path.parent() != Some(root.as_path())
    {
        return Err(format!(
            "Agent Org plan path is outside source session {source_session_id}'s managed root {}: {}",
            root.display(),
            logical_path.display()
        ));
    }
    Ok(OwnedPlanPath {
        logical_path,
        root,
        anchor,
        file_name,
    })
}

/// Resolve the session-owned lexical root one component at a time. Existing
/// symlinks are rejected before canonicalization, and every canonical
/// component must remain under the session's canonical workspace/home anchor.
fn resolve_owned_plan_target(
    owned: &OwnedPlanPath,
    create_directories: bool,
) -> Result<Option<PathBuf>, String> {
    let relative_root = owned.root.strip_prefix(&owned.anchor).map_err(|_| {
        format!(
            "Agent Org Plan root {} is outside anchor {}",
            owned.root.display(),
            owned.anchor.display()
        )
    })?;
    let canonical_anchor = std::fs::canonicalize(&owned.anchor).map_err(|err| {
        format!(
            "failed to canonicalize Agent Org Plan anchor {}: {err}",
            owned.anchor.display()
        )
    })?;
    let mut current = canonical_anchor.clone();
    for component in relative_root.components() {
        let Component::Normal(component) = component else {
            return Err(format!(
                "Agent Org Plan root contains an unsafe component: {}",
                owned.root.display()
            ));
        };
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Agent Org Plan root contains a symlink: {}",
                    current.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "Agent Org Plan root component is not a directory: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound && create_directories => {
                std::fs::create_dir(&current).map_err(|create_err| {
                    format!(
                        "failed to create Agent Org Plan directory {}: {create_err}",
                        current.display()
                    )
                })?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(format!(
                    "failed to inspect Agent Org Plan directory {}: {err}",
                    current.display()
                ));
            }
        }
        let canonical_current = std::fs::canonicalize(&current).map_err(|err| {
            format!(
                "failed to canonicalize Agent Org Plan directory {}: {err}",
                current.display()
            )
        })?;
        if !canonical_current.starts_with(&canonical_anchor) {
            return Err(format!(
                "Agent Org Plan directory escaped its canonical anchor: {}",
                canonical_current.display()
            ));
        }
        current = canonical_current;
    }

    let target = current.join(&owned.file_name);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Agent Org plan artifact is a symlink: {}",
            target.display()
        )),
        Ok(metadata) if !metadata.is_file() => Err(format!(
            "Agent Org plan artifact is not a regular file: {}",
            target.display()
        )),
        Ok(_) => Ok(Some(target)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Some(target)),
        Err(err) => Err(format!(
            "failed to inspect Agent Org plan artifact {}: {err}",
            target.display()
        )),
    }
}

fn stage_plan_artifact_if_needed(
    source_session_id: &str,
    plan_path: &str,
    canonical_content: &str,
) -> Result<Option<StagedPlanArtifact>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let Some(owned) =
        owned_plan_path_for_existing_revision_with_connection(&conn, source_session_id, plan_path)?
    else {
        return Ok(None);
    };
    let target_path = match resolve_owned_plan_target(&owned, true) {
        Ok(Some(target)) => target,
        Ok(None) => return Ok(None),
        Err(err) => {
            tracing::warn!(
                source_session_id,
                plan_path,
                error = %err,
                "skipping unsafe Agent Org plan artifact repair"
            );
            return Ok(None);
        }
    };
    match std::fs::read(&target_path) {
        Ok(existing) if existing == canonical_content.as_bytes() => return Ok(None),
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "failed to inspect Agent Org plan artifact {}: {err}",
                target_path.display()
            ))
        }
    }
    stage_owned_plan_artifact(owned, target_path, canonical_content).map(Some)
}

fn stage_plan_artifact_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
    canonical_content: &str,
) -> Result<StagedPlanArtifact, String> {
    let owned = validate_owned_plan_path_with_connection(conn, source_session_id, plan_path)?;
    let target_path = resolve_owned_plan_target(&owned, true)?.ok_or_else(|| {
        format!(
            "could not materialize managed Agent Org plan root for {}",
            owned.logical_path.display()
        )
    })?;
    stage_owned_plan_artifact(owned, target_path, canonical_content)
}

fn stage_plan_artifact_for_existing_revision_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
    canonical_content: &str,
) -> Result<Option<StagedPlanArtifact>, String> {
    let Some(owned) =
        owned_plan_path_for_existing_revision_with_connection(conn, source_session_id, plan_path)?
    else {
        return Ok(None);
    };
    let target_path = resolve_owned_plan_target(&owned, true)?.ok_or_else(|| {
        format!(
            "could not materialize managed Agent Org plan root for {}",
            owned.logical_path.display()
        )
    })?;
    stage_owned_plan_artifact(owned, target_path, canonical_content).map(Some)
}

fn owned_plan_path_for_existing_revision_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
) -> Result<Option<OwnedPlanPath>, String> {
    match validate_owned_plan_path_with_connection(conn, source_session_id, plan_path) {
        Ok(owned) => Ok(Some(owned)),
        Err(err) => {
            tracing::warn!(
                source_session_id,
                plan_path,
                error = %err,
                "skipping unmanaged historical Agent Org plan artifact"
            );
            Ok(None)
        }
    }
}

fn stage_owned_plan_artifact(
    owned: OwnedPlanPath,
    target_path: PathBuf,
    canonical_content: &str,
) -> Result<StagedPlanArtifact, String> {
    let parent = target_path.parent().ok_or_else(|| {
        format!(
            "Agent Org plan path has no parent: {}",
            target_path.display()
        )
    })?;
    let temp_path = parent.join(format!(
        ".{}.approval-{}.tmp",
        owned.file_name,
        uuid::Uuid::new_v4()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|err| {
            format!(
                "failed to stage Agent Org plan artifact {}: {err}",
                temp_path.display()
            )
        })?;
    if let Err(err) = file
        .write_all(canonical_content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "failed to persist staged Agent Org plan artifact {}: {err}",
            temp_path.display()
        ));
    }
    Ok(StagedPlanArtifact {
        owned,
        temp_path,
        target_path,
    })
}

/// Install only the already-fsynced bytes. Callers invoke this after SQLite
/// commits while holding the dedicated artifact lock so two revisions cannot
/// install out of commit order and unrelated database writes are not blocked.
fn install_staged_plan_artifact(staged: Option<&StagedPlanArtifact>) -> Result<(), String> {
    let Some(staged) = staged else {
        return Ok(());
    };
    let current_target = resolve_owned_plan_target(&staged.owned, true)?
        .ok_or_else(|| "managed Agent Org Plan root disappeared before install".to_string())?;
    if current_target != staged.target_path {
        return Err(format!(
            "managed Agent Org plan target changed before install: {} -> {}",
            staged.target_path.display(),
            current_target.display()
        ));
    }
    std::fs::rename(&staged.temp_path, &staged.target_path).map_err(|err| {
        format!(
            "failed to atomically install Agent Org plan artifact {}: {err}",
            staged.target_path.display()
        )
    })?;
    sync_parent_directory(&staged.target_path)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Agent Org plan path has no parent: {}", path.display()))?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| {
            format!(
                "failed to sync Agent Org plan directory {}: {err}",
                parent.display()
            )
        })
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// A committed DB mutation must never be surfaced as failed merely because
/// its derived artifact could not be installed. SQLite remains authoritative;
/// startup/detail reconciliation will retry the projection.
fn finish_committed_artifact<T>(
    result: Result<(T, Option<String>), String>,
    staged: Option<&StagedPlanArtifact>,
) -> Result<T, String> {
    match result {
        Ok((value, artifact_error)) => {
            if let Some(err) = artifact_error {
                tracing::warn!(
                    plan_path = staged
                        .map(|artifact| artifact.target_path.display().to_string())
                        .unwrap_or_default(),
                    error = %err,
                    "Agent Org plan DB commit succeeded but artifact installation needs repair"
                );
            }
            Ok(value)
        }
        Err(err) => Err(err),
    }
}

fn list_distinct_plan_paths_after(
    after_path: Option<&str>,
    limit: usize,
) -> Result<Vec<String>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT plan_path
             FROM agent_org_plan_approvals
             WHERE (?1 IS NULL OR plan_path > ?1)
             ORDER BY plan_path ASC
             LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![after_path, limit as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn latest_plan_revision_for_path_with_connection(
    conn: &Connection,
    plan_path: &str,
) -> Result<Option<AgentOrgPlanApproval>, String> {
    query_record(
        conn,
        "WHERE plan_path=?1 ORDER BY created_at DESC, rowid DESC",
        params![plan_path],
    )
}

fn latest_plan_revision_for_path(plan_path: &str) -> Result<Option<AgentOrgPlanApproval>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    latest_plan_revision_for_path_with_connection(&conn, plan_path)
}

fn repair_latest_plan_artifact_for_path(plan_path: &str) -> Result<bool, String> {
    const MAX_REPAIR_RACES: usize = 4;

    for _ in 0..MAX_REPAIR_RACES {
        let Some(canonical) = latest_plan_revision_for_path(plan_path)? else {
            return Ok(false);
        };
        let staged = stage_plan_artifact_if_needed(
            &canonical.source_session_id,
            plan_path,
            &canonical.plan_content,
        )?;
        if staged.is_none() {
            // Confirm that the row did not advance between the first DB read
            // and the artifact comparison. If it did, loop and compare the
            // new durable revision instead of declaring success too early.
            let latest = latest_plan_revision_for_path(plan_path)?;
            if latest.as_ref().is_some_and(|record| {
                record.approval_id == canonical.approval_id
                    && record.plan_revision_id == canonical.plan_revision_id
                    && record.plan_content == canonical.plan_content
            }) {
                return Ok(false);
            }
            continue;
        }

        let _artifact_guard = plan_artifact_install_lock().lock();
        let should_install = with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let latest = latest_plan_revision_for_path_with_connection(&conn, plan_path)?;
            let still_current = latest.as_ref().is_some_and(|record| {
                record.approval_id == canonical.approval_id
                    && record.plan_revision_id == canonical.plan_revision_id
                    && record.plan_content == canonical.plan_content
            });
            if !still_current {
                return Ok(false);
            }
            let Some(latest) = latest.as_ref() else {
                return Ok(false);
            };
            if let Err(err) = validate_owned_plan_path_with_connection(
                &conn,
                &latest.source_session_id,
                &latest.plan_path,
            ) {
                tracing::warn!(
                    source_session_id = %latest.source_session_id,
                    plan_path = %latest.plan_path,
                    error = %err,
                    "skipping Agent Org plan artifact repair after ownership changed"
                );
                return Ok(false);
            }
            Ok(true)
        })?;
        if should_install {
            install_staged_plan_artifact(staged.as_ref())?;
            return Ok(true);
        }
    }
    Err(format!(
        "Agent Org plan artifact kept changing while being repaired: {plan_path}"
    ))
}

fn create_pending_in_tx(
    tx: &rusqlite::Transaction<'_>,
    params: CreateAgentOrgPlanApprovalParams,
) -> Result<AgentOrgPlanApproval, String> {
    validate_create_params(&params)?;
    validate_owned_plan_path_with_connection(tx, &params.source_session_id, &params.plan_path)?;
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

    let remaining_open_task_count = tasks
        .iter()
        .filter(|task| !task.status.is_resolved())
        .count();
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
             FROM agent_org_runs WHERE id=?1 AND status='running'",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| format!("agent_org_run_not_mutable: {run_id}: {err}"))?;
    let mut participants = HashMap::new();
    if let Some(snapshot_json) = snapshot_json {
        let snapshot: OrgDefinition = serde_json::from_str(&snapshot_json).map_err(|err| {
            format!("failed to parse Agent Org launch snapshot for run {run_id}: {err}")
        })?;
        collect_participant_agent_ids(&snapshot.children, &mut participants);
    }
    Ok((coordinator_agent_id, participants))
}

fn collect_participant_agent_ids(
    members: &[OrgMember],
    participants: &mut HashMap<String, String>,
) {
    for member in members {
        participants.insert(member.id.clone(), member.agent_id.clone());
        collect_participant_agent_ids(&member.children, participants);
    }
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
    validate_required_text(
        "plan approval title",
        &params.plan_title,
        PLAN_TITLE_MAX_CHARS,
        PLAN_TITLE_MAX_BYTES,
    )?;
    validate_required_text(
        "plan approval path",
        &params.plan_path,
        PLAN_PATH_MAX_CHARS,
        PLAN_PATH_MAX_BYTES,
    )?;
    validate_required_text(
        "plan approval content",
        &params.plan_content,
        PLAN_CONTENT_MAX_CHARS,
        PLAN_CONTENT_MAX_BYTES,
    )
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
    let policy = parse_policy(8, &policy_raw)?;
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

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgPlanApprovalSummary> {
    let policy_raw: String = row.get(8)?;
    let status_raw: String = row.get(9)?;
    let plan_content_bytes_raw: i64 = row.get(11)?;
    let plan_content_bytes = u64::try_from(plan_content_bytes_raw)
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(11, plan_content_bytes_raw))?;
    Ok(AgentOrgPlanApprovalSummary {
        approval_id: row.get(0)?,
        plan_revision_id: row.get(1)?,
        request_id: row.get(2)?,
        org_run_id: row.get(3)?,
        source_task_id: row.get(4)?,
        source_member_id: row.get(5)?,
        source_session_id: row.get(6)?,
        root_session_id: row.get(7)?,
        policy: parse_policy(8, &policy_raw)?,
        status: AgentOrgPlanApprovalStatus::from_wire(&status_raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, err.into())
        })?,
        plan_title: row.get(10)?,
        plan_content_bytes,
        created_at: row.get(12)?,
    })
}

fn parse_policy(column: usize, policy_raw: &str) -> rusqlite::Result<PlanApprovalPolicy> {
    Ok(match policy_raw {
        "coordinator" => PlanApprovalPolicy::Coordinator,
        "user" => PlanApprovalPolicy::User,
        "automatic" => PlanApprovalPolicy::Automatic,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                format!("unknown plan approval policy: {policy_raw}").into(),
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_org_runs::{
        AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunEntryMode, AgentOrgRunStatus,
        AgentOrgRunStore, CreateAgentOrgRunParams,
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
        let workspace = sandbox.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("create planner workspace");
        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: "planner-session".into(),
                name: "Planner".into(),
                status: crate::session::SessionStatus::Idle.as_str().into(),
                created_at: now.clone(),
                updated_at: now,
                session_type: crate::session::persistence::session_type::ORG_MEMBER.into(),
                workspace_path: Some(workspace.to_string_lossy().into_owned()),
                agent_definition_id: Some("planner-agent".into()),
                org_member_id: Some("planner".into()),
                parent_session_id: Some("root-plan-approval".into()),
                ..Default::default()
            },
        )
        .expect("upsert planner session");

        let org = OrgDefinition {
            id: "org-plan-approval".into(),
            name: "Plan Approval Org".into(),
            role: "lead".into(),
            agent_id: "coord-agent".into(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: policy,
            children: vec![
                OrgMember {
                    id: "planner".into(),
                    name: "Planner".into(),
                    role: "plan".into(),
                    agent_id: "planner-agent".into(),
                    runtime_config: None,
                    children: Vec::new(),
                },
                OrgMember {
                    id: "builder".into(),
                    name: "Builder".into(),
                    role: "build".into(),
                    agent_id: "builder-agent".into(),
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
            members: vec![
                AgentOrgContextMember {
                    member_id: "planner".into(),
                    name: "Planner".into(),
                    role: "plan".into(),
                    agent_id: "planner-agent".into(),
                    parent_member_id: None,
                },
                AgentOrgContextMember {
                    member_id: "builder".into(),
                    name: "Builder".into(),
                    role: "build".into(),
                    agent_id: "builder-agent".into(),
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
            plan_path: AgentOrgPlanApprovalStore::managed_plan_path_for_session(
                "planner-session",
                &format!("{}.plan.md", uuid::Uuid::new_v4()),
            )
            .expect("managed planner plan path")
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

        let wake_members = approved.wake_member_ids.clone();
        assert!(wake_members.contains(&"builder".to_string()));
        assert!(wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
        let builder_inbox =
            AgentInboxStore::list_unread_for_member("builder", &context.run_id).unwrap();
        assert!(builder_inbox
            .iter()
            .any(|row| row.payload_kind == "task_assigned"));
    }

    #[test]
    fn approval_dispatches_task_from_legacy_blocks_only_edge() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "legacy-build-task".into(),
            org_run_id: context.run_id.clone(),
            subject: "Build the approved legacy plan".into(),
            description: String::new(),
            active_form: None,
            owner: Some("builder".into()),
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "build" })),
        })
        .expect("create legacy dependent task");

        let conn = get_connection().expect("test sqlite connection");
        conn.execute(
            "UPDATE agent_org_tasks SET blocks_json='[\"legacy-build-task\"]'
             WHERE org_run_id=?1 AND id='plan-task'",
            params![&context.run_id],
        )
        .expect("seed legacy upstream blocks edge");
        conn.execute(
            "UPDATE agent_org_tasks SET blocked_by_json='[]'
             WHERE org_run_id=?1 AND id='legacy-build-task'",
            params![&context.run_id],
        )
        .expect("preserve legacy blocks-only representation");
        conn.execute("DELETE FROM agent_inbox", [])
            .expect("remove create-time assignment noise");

        let pending = create_pending_approval(&context);
        let approved = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::Coordinator,
            None,
        )
        .expect("approve legacy graph");

        assert!(approved.wake_member_ids.contains(&"builder".to_string()));
        let assignments = AgentInboxStore::list_unread_for_member("builder", &context.run_id)
            .expect("list builder inbox")
            .into_iter()
            .filter(|row| {
                matches!(
                    row.decode_payload(),
                    Ok(AgentMessage::TaskAssigned { ref task_id, .. })
                        if task_id == "legacy-build-task"
                )
            })
            .count();
        assert_eq!(assignments, 1);
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
    fn pending_summary_omits_markdown_and_exact_revision_loads_detail() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);

        let summaries = AgentOrgPlanApprovalStore::list_pending_summaries_by_run(&context.run_id)
            .expect("list pending summaries");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].approval_id, pending.approval_id);
        assert_eq!(
            summaries[0].plan_content_bytes,
            u64::try_from(pending.plan_content.len()).expect("content length")
        );
        let serialized = serde_json::to_value(&summaries[0]).expect("serialize summary");
        assert!(serialized.get("planContent").is_none());
        assert!(serialized.get("planPath").is_none());

        let detail = AgentOrgPlanApprovalStore::get_revision(
            &pending.approval_id,
            &pending.plan_revision_id,
        )
        .expect("load exact revision")
        .expect("detail exists");
        assert_eq!(detail.plan_content, pending.plan_content);
        assert!(AgentOrgPlanApprovalStore::get_revision(
            &pending.approval_id,
            "different-revision"
        )
        .expect("load mismatched revision")
        .is_none());
    }

    #[test]
    fn run_scoped_revision_lookup_rejects_cross_run_before_artifact_repair() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        std::fs::write(&pending.plan_path, "cross-run sentinel")
            .expect("replace derived artifact with a repair sentinel");

        let cross_run = AgentOrgPlanApprovalStore::get_revision_for_run(
            "different-run",
            &pending.approval_id,
            &pending.plan_revision_id,
        )
        .expect("cross-run lookup should be a normal miss");
        assert!(cross_run.is_none());
        assert_eq!(
            std::fs::read_to_string(&pending.plan_path).expect("read unrepaired sentinel"),
            "cross-run sentinel",
            "an unauthorized Run must not trigger filesystem repair"
        );

        let detail = AgentOrgPlanApprovalStore::get_revision_for_run(
            &context.run_id,
            &pending.approval_id,
            &pending.plan_revision_id,
        )
        .expect("authorized lookup")
        .expect("authorized revision exists");
        assert_eq!(detail.plan_content, pending.plan_content);
        assert_eq!(
            std::fs::read_to_string(&pending.plan_path).expect("read repaired artifact"),
            pending.plan_content
        );
    }

    #[test]
    fn historical_external_notes_path_is_never_repaired() {
        let (sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        let external_dir = sandbox.path().join("external");
        std::fs::create_dir_all(&external_dir).expect("create external directory");
        let external_notes = external_dir.join("notes.md");
        std::fs::write(&external_notes, "user-owned notes").expect("seed external notes");
        get_connection()
            .expect("test db")
            .execute(
                "UPDATE agent_org_plan_approvals SET plan_path=?1 WHERE approval_id=?2",
                params![
                    external_notes.to_string_lossy().as_ref(),
                    &pending.approval_id
                ],
            )
            .expect("seed historical unmanaged plan path");

        let detail = AgentOrgPlanApprovalStore::get_revision_for_run(
            &context.run_id,
            &pending.approval_id,
            &pending.plan_revision_id,
        )
        .expect("read historical revision")
        .expect("historical revision exists");
        assert_eq!(detail.plan_path, external_notes.to_string_lossy());
        let report = AgentOrgPlanApprovalStore::repair_latest_plan_artifacts()
            .expect("scan historical artifacts");
        assert_eq!(report.inspected, 1);
        assert_eq!(report.repaired, 0);
        assert_eq!(report.failed, 0);
        assert_eq!(
            std::fs::read_to_string(&external_notes).expect("read external notes"),
            "user-owned notes",
            "historical arbitrary files must never be overwritten by repair"
        );
    }

    #[test]
    fn new_approval_rejects_external_non_plan_path() {
        let (sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let external_notes = sandbox.path().join("notes.md");
        std::fs::write(&external_notes, "user-owned notes").expect("seed external notes");
        let mut params = approval_params(&context);
        params.plan_path = external_notes.to_string_lossy().into_owned();

        let error = AgentOrgPlanApprovalStore::create_pending(params)
            .expect_err("an external notes path must be rejected");
        assert!(error.contains("*.plan.md") || error.contains("managed root"));
        assert_eq!(
            std::fs::read_to_string(&external_notes).expect("read external notes"),
            "user-owned notes"
        );
        assert!(
            AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
                .expect("list approvals")
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn repair_does_not_follow_managed_artifact_symlink() {
        use std::os::unix::fs::symlink;

        let (sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        let external_notes = sandbox.path().join("external-notes.md");
        std::fs::write(&external_notes, "user-owned notes").expect("seed external notes");
        std::fs::remove_file(&pending.plan_path).expect("remove managed artifact");
        symlink(&external_notes, &pending.plan_path).expect("replace artifact with symlink");

        AgentOrgPlanApprovalStore::get_revision_for_run(
            &context.run_id,
            &pending.approval_id,
            &pending.plan_revision_id,
        )
        .expect("read revision")
        .expect("revision exists");

        assert_eq!(
            std::fs::read_to_string(&external_notes).expect("read external notes"),
            "user-owned notes"
        );
        assert!(
            std::fs::symlink_metadata(&pending.plan_path)
                .expect("inspect managed symlink")
                .file_type()
                .is_symlink(),
            "repair must leave an unsafe symlink untouched"
        );
    }

    #[test]
    fn watchdog_pending_task_projection_never_materializes_plan_markdown() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        // An invalid UTF-8 TEXT payload would fail `row.get::<_, String>` if
        // the watchdog accidentally selected plan_content. Selecting only the
        // source id remains valid and proves the hot path does not decode it.
        get_connection()
            .unwrap()
            .execute(
                "UPDATE agent_org_plan_approvals
                 SET plan_content=CAST(X'80' AS TEXT)
                 WHERE approval_id=?1",
                params![&pending.approval_id],
            )
            .unwrap();

        assert_eq!(
            AgentOrgPlanApprovalStore::pending_source_task_ids_by_run(&context.run_id).unwrap(),
            vec!["plan-task".to_string()]
        );
    }

    #[test]
    fn coordinator_request_insert_failure_rolls_back_pending_creation() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
        create_plan_task(&context);
        get_connection()
            .expect("test db")
            .execute("DROP TABLE agent_inbox", [])
            .expect("remove inbox to force request delivery failure");

        let params = approval_params(&context);
        let plan_path = PathBuf::from(&params.plan_path);
        let file_name = plan_path.file_name().unwrap().to_string_lossy();
        let staged_prefix = format!(".{file_name}.approval-");

        AgentOrgPlanApprovalStore::create_pending_with_request(
            params,
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
        assert!(
            !plan_path.exists(),
            "a failed DB transaction must not install the derived plan artifact"
        );
        let leaked_stages = std::fs::read_dir(plan_path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(&staged_prefix) && name.ends_with(".tmp")
            })
            .count();
        assert_eq!(
            leaked_stages, 0,
            "a failed DB transaction must clean its pre-staged artifact"
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

        let wake_members = approved.wake_member_ids.clone();
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
    fn invalid_artifact_target_rejects_before_approval_mutation() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        std::fs::remove_file(&pending.plan_path).expect("remove materialized artifact");
        std::fs::create_dir(&pending.plan_path).expect("replace artifact with directory");

        let error = AgentOrgPlanApprovalStore::approve(
            &pending.approval_id,
            &pending.plan_revision_id,
            AgentOrgPlanDecisionBy::User,
            Some("# Edited".to_string()),
        )
        .expect_err("a file cannot atomically replace the target directory");
        assert!(error.contains("plan artifact is not a regular file"));
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
        std::fs::remove_dir(&pending.plan_path).expect("remove target directory");
    }

    #[test]
    fn startup_repair_restores_db_content_after_precommit_artifact_crash() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);

        // Simulate the old crash window: the edited artifact was renamed into
        // place, then the process exited before SQLite committed that edit.
        std::fs::write(&pending.plan_path, "# Uncommitted edit").expect("seed crash residue");
        assert_ne!(
            std::fs::read_to_string(&pending.plan_path).unwrap(),
            pending.plan_content
        );

        let report = AgentOrgPlanApprovalStore::repair_latest_plan_artifacts()
            .expect("repair startup artifacts");
        assert_eq!(report.inspected, 1);
        assert_eq!(report.repaired, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(
            std::fs::read_to_string(&pending.plan_path).unwrap(),
            pending.plan_content
        );
        assert_eq!(
            AgentOrgPlanApprovalStore::get(&pending.approval_id)
                .unwrap()
                .unwrap()
                .plan_content,
            pending.plan_content
        );
    }

    #[test]
    fn detail_read_repairs_artifact_after_postcommit_install_crash() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        let committed_content = "# Durable DB revision\n\n1. Recover artifact.";

        // Simulate the new, safe crash window: SQLite committed first, but
        // the process exited before the staged file was installed.
        get_connection()
            .unwrap()
            .execute(
                "UPDATE agent_org_plan_approvals SET plan_content=?1
                 WHERE approval_id=?2",
                params![committed_content, &pending.approval_id],
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&pending.plan_path).unwrap(),
            pending.plan_content
        );

        let detail = AgentOrgPlanApprovalStore::get_revision(
            &pending.approval_id,
            &pending.plan_revision_id,
        )
        .expect("read revision")
        .expect("revision exists");
        assert_eq!(detail.plan_content, committed_content);
        assert_eq!(
            std::fs::read_to_string(&pending.plan_path).unwrap(),
            committed_content
        );
    }

    #[test]
    fn historical_detail_repairs_shared_path_to_latest_revision() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let original = create_pending_approval(&context);
        let mut revised_params = approval_params(&context);
        revised_params.request_id = "request-plan-revised".into();
        revised_params.plan_path = original.plan_path.clone();
        revised_params.plan_content = "# Latest plan\n\nUse the latest revision.".into();
        let latest = AgentOrgPlanApprovalStore::create_pending(revised_params)
            .expect("create latest revision");

        std::fs::write(&latest.plan_path, &original.plan_content)
            .expect("simulate stale historical artifact");
        let historical = AgentOrgPlanApprovalStore::get_revision(
            &original.approval_id,
            &original.plan_revision_id,
        )
        .expect("read historical detail")
        .expect("historical revision exists");

        assert_eq!(historical.plan_content, original.plan_content);
        assert_eq!(
            std::fs::read_to_string(&latest.plan_path).unwrap(),
            latest.plan_content,
            "a historical detail read must never project old content over the latest shared artifact"
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

    #[test]
    fn startup_cleanup_preserves_pending_approval_for_paused_run() {
        let (_sandbox, context) = setup(PlanApprovalPolicy::User);
        create_plan_task(&context);
        let pending = create_pending_approval(&context);
        AgentOrgRunStore::mark_paused(&context.run_id).expect("pause run");

        let cancelled = AgentOrgPlanApprovalStore::cancel_pending_for_terminal_or_missing_runs()
            .expect("run startup approval cleanup");

        assert_eq!(cancelled, 0, "paused runs are resumable, not terminal");
        let reloaded = AgentOrgPlanApprovalStore::get(&pending.approval_id)
            .expect("load approval after startup cleanup")
            .expect("approval still exists");
        assert_eq!(reloaded.status, AgentOrgPlanApprovalStatus::Pending);
        assert_eq!(reloaded.resolved_at, None);
        assert_eq!(
            AgentOrgTaskStore::get(&context.run_id, "plan-task")
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::InProgress
        );
    }
}
