use std::path::PathBuf;

use rusqlite::{params, Connection, TransactionBehavior};

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, RequestId,
};
use crate::coordination::agent_org_payload_limits::{
    validate_required_text, PLAN_CONTENT_MAX_BYTES, PLAN_CONTENT_MAX_CHARS,
    PLAN_FEEDBACK_MAX_BYTES, PLAN_FEEDBACK_MAX_CHARS,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::definitions::orgs::PlanApprovalPolicy;

use super::artifact::{
    expected_plan_root_with_connection, finish_committed_artifact, install_staged_plan_artifact,
    list_distinct_plan_paths_after, plan_artifact_install_lock,
    repair_latest_plan_artifact_for_path, resolve_owned_plan_target,
    stage_plan_artifact_for_existing_revision_with_connection, stage_plan_artifact_with_connection,
    sync_parent_directory, validate_owned_plan_path_with_connection, validate_plan_file_name,
};
use super::persistence::{query_record, row_to_record, row_to_summary};
use super::transitions::{
    approve_pending_in_tx, create_pending_in_tx, plan_approval_request_message,
};
use super::validation::{authorize_decision, validate_create_params, validate_delivery};
use super::{
    AgentOrgPlanApproval, AgentOrgPlanApprovalStatus, AgentOrgPlanApprovalSummary,
    AgentOrgPlanDecisionBy, AgentOrgPlanInboxDelivery, ApprovedAgentOrgPlan,
    CreateAgentOrgPlanApprovalParams,
};

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
