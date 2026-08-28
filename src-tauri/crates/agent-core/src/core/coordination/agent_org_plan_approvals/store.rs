use std::path::PathBuf;

use rusqlite::{params, Connection, TransactionBehavior};

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, PlanDecisionOutcome,
    RequestId, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_payload_limits::{
    validate_required_text, PLAN_FEEDBACK_MAX_BYTES, PLAN_FEEDBACK_MAX_CHARS,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::definitions::orgs::PlanApprovalPolicy;

use super::artifact::{
    expected_plan_root_with_connection, finish_committed_artifact, install_staged_plan_artifact,
    list_distinct_plan_paths_after, plan_artifact_install_lock,
    repair_latest_plan_artifact_for_path, resolve_owned_plan_target,
    stage_plan_artifact_with_connection, sync_parent_directory,
    validate_owned_plan_path_with_connection, validate_plan_file_name,
};
use super::persistence::{query_record, row_to_record, row_to_summary, RECORD_SELECT};
use super::transitions::{
    approve_pending_in_tx, create_pending_in_tx, plan_approval_request_message, plan_decision_actor,
};
use super::validation::{authorize_decision, validate_create_params, validate_delivery};
use super::{
    AgentOrgPlanDecisionBy, AgentOrgPlanDecisionDelivery, AgentOrgPlanDecisionStatus,
    AgentOrgPlanRevision, AgentOrgPlanRevisionSummary, ApprovedAgentOrgPlanRevision,
    CreateAgentOrgPlanRevisionParams,
};

pub struct AgentOrgPlanRevisionStore;

/// Exact immutable PlanRevision identity plus the current decision writer.
///
/// Keeping these values together makes it harder for an in-transaction caller
/// to accidentally approve one revision with another revision's provenance.
pub(crate) struct ApprovePlanRevisionInTxParams<'a> {
    pub approval_id: &'a str,
    pub plan_revision_id: &'a str,
    pub source_task_id: &'a str,
    pub source_turn_intent_id: &'a str,
    pub decision_by: AgentOrgPlanDecisionBy,
    pub decision_source_session_id: &'a str,
    pub decision_source_turn_intent_id: Option<&'a str>,
}

pub(crate) struct RequestPlanChangesParams<'a> {
    pub approval_id: &'a str,
    pub plan_revision_id: &'a str,
    pub source_task_id: &'a str,
    pub source_turn_intent_id: &'a str,
    pub decision_by: AgentOrgPlanDecisionBy,
    pub decision_source_turn_intent_id: Option<&'a str>,
    pub feedback: &'a str,
    pub delivery: AgentOrgPlanDecisionDelivery,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentOrgPlanArtifactRepairReport {
    pub inspected: usize,
    pub repaired: usize,
    pub failed: usize,
}

impl AgentOrgPlanRevisionStore {
    pub(crate) fn submit_agent_org_plan_in_tx(
        conn: &Connection,
        params: CreateAgentOrgPlanRevisionParams,
        delivery: Option<AgentOrgPlanDecisionDelivery>,
    ) -> Result<Vec<String>, String> {
        match params.policy {
            PlanApprovalPolicy::Coordinator => {
                let delivery = delivery.ok_or_else(|| {
                    "coordinator plan approval requires Inbox delivery".to_string()
                })?;
                validate_delivery(&delivery)?;
                let revision = create_pending_in_tx(conn, params)?;
                insert_plan_request_in_tx(conn, &revision, delivery)?;
                Ok(vec![COORDINATOR_MEMBER_ID.to_string()])
            }
            PlanApprovalPolicy::User => {
                if delivery.is_some() {
                    return Err("user plan approval does not accept Inbox delivery".to_string());
                }
                create_pending_in_tx(conn, params)?;
                Ok(Vec::new())
            }
            PlanApprovalPolicy::Automatic => {
                if delivery.is_some() {
                    return Err(
                        "automatic plan approval does not accept Inbox delivery".to_string()
                    );
                }
                let revision = create_pending_in_tx(conn, params)?;
                let decision_source_session_id = revision.source_session_id.clone();
                let decision_source_turn_intent_id = revision.source_turn_intent_id.clone();
                let approved = approve_pending_in_tx(
                    conn,
                    revision,
                    AgentOrgPlanDecisionBy::Automatic,
                    &decision_source_session_id,
                    Some(&decision_source_turn_intent_id),
                )?;
                Ok(approved.wake_member_ids)
            }
        }
    }

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
        params: CreateAgentOrgPlanRevisionParams,
    ) -> Result<AgentOrgPlanRevision, String> {
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
        params: CreateAgentOrgPlanRevisionParams,
        delivery: AgentOrgPlanDecisionDelivery,
    ) -> Result<AgentOrgPlanRevision, String> {
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
            let revision = create_pending_in_tx(&tx, params)?;
            insert_plan_request_in_tx(&tx, &revision, delivery)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(revision)
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
        params: CreateAgentOrgPlanRevisionParams,
    ) -> Result<ApprovedAgentOrgPlanRevision, String> {
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
            let revision = create_pending_in_tx(&tx, params)?;
            let decision_source_session_id = revision.source_session_id.clone();
            let decision_source_turn_intent_id = revision.source_turn_intent_id.clone();
            let approved = approve_pending_in_tx(
                &tx,
                revision,
                AgentOrgPlanDecisionBy::Automatic,
                &decision_source_session_id,
                Some(&decision_source_turn_intent_id),
            )?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(approved)
        });
        let result = result.map(|approved| {
            let artifact_error = install_staged_plan_artifact(staged_artifact.as_ref()).err();
            (approved, artifact_error)
        });
        let approved = finish_committed_artifact(result, staged_artifact.as_ref())?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &approved.revision.org_run_id,
        );
        Ok(approved)
    }

    pub fn list_pending_by_run(run_id: &str) -> Result<Vec<AgentOrgPlanRevision>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let sql = format!(
            "SELECT {RECORD_SELECT}
             FROM agent_org_runtime_plan_revisions revision
             JOIN agent_org_runtime_plan_decisions decision
               ON decision.plan_revision_id=revision.plan_revision_id
             LEFT JOIN agent_org_runtime_tasks task
               ON task.org_run_id=revision.org_run_id AND task.id=revision.source_task_id
             WHERE revision.org_run_id=?1 AND decision.status=?2
             ORDER BY revision.revision_number ASC,revision.plan_revision_id ASC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![run_id, AgentOrgPlanDecisionStatus::Pending.as_wire()],
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
                "SELECT revision.source_task_id
                 FROM agent_org_runtime_plan_revisions revision
                 JOIN agent_org_runtime_plan_decisions decision
                   ON decision.plan_revision_id=revision.plan_revision_id
                 WHERE revision.org_run_id=?1 AND decision.status=?2
                 ORDER BY revision.revision_number ASC,revision.plan_revision_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![run_id, AgentOrgPlanDecisionStatus::Pending.as_wire()],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    pub fn list_pending_summaries_by_run(
        run_id: &str,
    ) -> Result<Vec<AgentOrgPlanRevisionSummary>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_pending_summaries_by_run_with_connection(&conn, run_id)
    }

    /// Lightweight approval projection on a caller-owned read snapshot.
    pub(crate) fn list_pending_summaries_by_run_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentOrgPlanRevisionSummary>, String> {
        Self::list_summaries_with_connection(conn, run_id, true, 100)
    }

    /// Bounded immutable revision history for Run View. Detail Markdown stays
    /// behind the exact revision command; this projection carries decisions,
    /// digest and TaskOutput binding only.
    pub(crate) fn list_revision_summaries_by_run_with_connection(
        conn: &Connection,
        run_id: &str,
        limit: usize,
    ) -> Result<Vec<AgentOrgPlanRevisionSummary>, String> {
        Self::list_summaries_with_connection(conn, run_id, false, limit)
    }

    fn list_summaries_with_connection(
        conn: &Connection,
        run_id: &str,
        pending_only: bool,
        limit: usize,
    ) -> Result<Vec<AgentOrgPlanRevisionSummary>, String> {
        let limit = limit.clamp(1, 100);
        let pending_filter = if pending_only {
            "AND decision.status='pending'"
        } else {
            ""
        };
        let sql = format!(
            "SELECT decision.approval_id,revision.plan_revision_id,
                    revision.revision_number,revision.previous_plan_revision_id,
                    decision.request_id,revision.org_run_id,revision.source_task_id,
                    revision.source_member_id,revision.source_session_id,
                    revision.source_turn_intent_id,revision.root_session_id,
                    decision.policy,decision.status,revision.plan_title,
                    length(CAST(revision.plan_content AS BLOB)),revision.content_digest,
                    decision.decision_by,decision.feedback,revision.created_at,
                    decision.resolved_at,task.output_json
             FROM agent_org_runtime_plan_revisions revision
             JOIN agent_org_runtime_plan_decisions decision
               ON decision.plan_revision_id=revision.plan_revision_id
             LEFT JOIN agent_org_runtime_tasks task
               ON task.org_run_id=revision.org_run_id AND task.id=revision.source_task_id
             WHERE revision.org_run_id=?1 {pending_filter}
             ORDER BY (decision.status='pending') DESC,
                      revision.revision_number DESC,revision.plan_revision_id DESC
             LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![run_id, limit], row_to_summary)
            .map_err(|err| err.to_string())?;
        rows.map(|row| row.map_err(|err| err.to_string())).collect()
    }

    pub fn get_pending_by_request_id(
        run_id: &str,
        request_id: &str,
    ) -> Result<Option<AgentOrgPlanRevision>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::get_pending_by_request_id_with_connection(&conn, run_id, request_id)
    }

    pub(crate) fn get_pending_by_request_id_with_connection(
        conn: &Connection,
        run_id: &str,
        request_id: &str,
    ) -> Result<Option<AgentOrgPlanRevision>, String> {
        query_record(
            conn,
            "WHERE revision.org_run_id=?1 AND decision.request_id=?2
               AND decision.status='pending'",
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
    ) -> Result<Option<AgentOrgPlanRevision>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        query_record(
            &conn,
            "WHERE revision.org_run_id=?1 AND decision.request_id=?2",
            params![run_id, request_id],
        )
    }

    pub fn approve(
        approval_id: &str,
        plan_revision_id: &str,
        source_task_id: &str,
        source_turn_intent_id: &str,
        decision_by: AgentOrgPlanDecisionBy,
        decision_source_session_id: &str,
        decision_source_turn_intent_id: Option<&str>,
    ) -> Result<ApprovedAgentOrgPlanRevision, String> {
        let current_conn = get_connection().map_err(|err| err.to_string())?;
        let current = query_record(
            &current_conn,
            "WHERE decision.approval_id=?1",
            params![approval_id],
        )?
        .ok_or_else(|| format!("agent_org_plan_approval_not_found: {approval_id}"))?;
        authorize_decision(current.policy, decision_by)?;
        if current.plan_revision_id != plan_revision_id
            || current.source_task_id != source_task_id
            || current.source_turn_intent_id != source_turn_intent_id
            || current.status != AgentOrgPlanDecisionStatus::Pending
        {
            return Err("agent_org_plan_approval_stale_revision".to_string());
        }
        let approved = with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let revision = query_record(
                &tx,
                "WHERE decision.approval_id=?1
                   AND revision.plan_revision_id=?2
                   AND revision.source_task_id=?3
                   AND revision.source_turn_intent_id=?4
                   AND decision.status='pending'",
                params![
                    approval_id,
                    plan_revision_id,
                    source_task_id,
                    source_turn_intent_id
                ],
            )?
            .ok_or_else(|| "agent_org_plan_approval_stale_revision".to_string())?;
            authorize_decision(revision.policy, decision_by)?;
            let approved = approve_pending_in_tx(
                &tx,
                revision,
                decision_by,
                decision_source_session_id,
                decision_source_turn_intent_id,
            )?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok::<_, String>(approved)
        })?;
        if let Err(error) = repair_latest_plan_artifact_for_path(&approved.revision.plan_path) {
            tracing::warn!(
                plan_revision_id,
                plan_path = %approved.revision.plan_path,
                %error,
                "approved immutable PlanRevision but failed to repair its derived artifact"
            );
        }
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &current.org_run_id,
        );
        Ok(approved)
    }

    pub(crate) fn approve_in_tx(
        conn: &Connection,
        params: ApprovePlanRevisionInTxParams<'_>,
    ) -> Result<ApprovedAgentOrgPlanRevision, String> {
        let revision = query_record(
            conn,
            "WHERE decision.approval_id=?1
               AND revision.plan_revision_id=?2
               AND revision.source_task_id=?3
               AND revision.source_turn_intent_id=?4
               AND decision.status='pending'",
            params![
                params.approval_id,
                params.plan_revision_id,
                params.source_task_id,
                params.source_turn_intent_id
            ],
        )?
        .ok_or_else(|| "agent_org_plan_approval_stale_revision".to_string())?;
        authorize_decision(revision.policy, params.decision_by)?;
        approve_pending_in_tx(
            conn,
            revision,
            params.decision_by,
            params.decision_source_session_id,
            params.decision_source_turn_intent_id,
        )
    }

    pub fn request_changes(
        approval_id: &str,
        plan_revision_id: &str,
        source_task_id: &str,
        source_turn_intent_id: &str,
        decision_by: AgentOrgPlanDecisionBy,
        feedback: &str,
        delivery: AgentOrgPlanDecisionDelivery,
    ) -> Result<(AgentOrgPlanRevision, AgentInboxRecord), String> {
        let result = with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let result = Self::request_changes_in_tx(
                &tx,
                RequestPlanChangesParams {
                    approval_id,
                    plan_revision_id,
                    source_task_id,
                    source_turn_intent_id,
                    decision_by,
                    decision_source_turn_intent_id: None,
                    feedback,
                    delivery,
                },
            )?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok::<_, String>(result)
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &result.0.org_run_id,
        );
        Ok(result)
    }

    pub(crate) fn request_changes_in_tx(
        conn: &Connection,
        params: RequestPlanChangesParams<'_>,
    ) -> Result<(AgentOrgPlanRevision, AgentInboxRecord), String> {
        let RequestPlanChangesParams {
            approval_id,
            plan_revision_id,
            source_task_id,
            source_turn_intent_id,
            decision_by,
            decision_source_turn_intent_id,
            feedback,
            delivery,
        } = params;
        let feedback = feedback.trim();
        validate_required_text(
            "plan approval feedback",
            feedback,
            PLAN_FEEDBACK_MAX_CHARS,
            PLAN_FEEDBACK_MAX_BYTES,
        )?;
        validate_delivery(&delivery)?;
        let revision = query_record(
            conn,
            "WHERE decision.approval_id=?1
               AND revision.plan_revision_id=?2
               AND revision.source_task_id=?3
               AND revision.source_turn_intent_id=?4
               AND decision.status='pending'",
            params![
                approval_id,
                plan_revision_id,
                source_task_id,
                source_turn_intent_id
            ],
        )?
        .ok_or_else(|| "agent_org_plan_approval_stale_revision".to_string())?;
        authorize_decision(revision.policy, decision_by)?;
        let (run_status, coordinator_agent_id): (String, String) = conn
            .query_row(
                "SELECT status,coordinator_agent_id FROM agent_org_runtime_runs WHERE id=?1",
                params![&revision.org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| err.to_string())?;
        if run_status != "running" {
            return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
                &revision.org_run_id,
                &run_status,
            ));
        }
        let resolved_at = chrono::Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_plan_decisions
                 SET status=?1, decision_by=?2, feedback=?3, resolved_at=?4
                 WHERE approval_id=?5 AND plan_revision_id=?6 AND status=?7",
                params![
                    AgentOrgPlanDecisionStatus::ChangesRequested.as_wire(),
                    decision_by.as_wire(),
                    feedback,
                    &resolved_at,
                    approval_id,
                    plan_revision_id,
                    AgentOrgPlanDecisionStatus::Pending.as_wire(),
                ],
            )
            .map_err(|err| err.to_string())?;
        if changed != 1 {
            return Err("agent_org_plan_approval_stale_revision".to_string());
        }
        let inbox_record = AgentInboxStore::insert_in_tx(
            conn,
            InsertInboxParams {
                recipient_agent_id: delivery.recipient_agent_id,
                recipient_member_id: Some(revision.source_member_id.clone()),
                sender_agent_id: delivery.sender_agent_id,
                sender_member_id: delivery.sender_member_id,
                org_run_id: Some(revision.org_run_id.clone()),
                message: AgentMessage::PlanApprovalResponse {
                    request_id: RequestId(revision.request_id.clone()),
                    accepted: false,
                    feedback: Some(feedback.to_string()),
                    next_mode: Some(crate::session::AgentExecMode::Plan),
                },
            },
        )?;
        let suppress_self_wake = decision_by == AgentOrgPlanDecisionBy::Coordinator
            && decision_source_turn_intent_id.is_some();
        let remaining_open_task_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND status IN ('pending','in_progress')",
                [&revision.org_run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let remaining_open_task_count = usize::try_from(remaining_open_task_count)
            .map_err(|_| "plan decision open Task count overflow".to_string())?;
        let coordinator_record = AgentInboxStore::insert_in_tx_without_formal_trigger(
            conn,
            InsertInboxParams {
                recipient_agent_id: coordinator_agent_id,
                recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: (decision_by == AgentOrgPlanDecisionBy::Coordinator)
                    .then(|| COORDINATOR_MEMBER_ID.to_string()),
                org_run_id: Some(revision.org_run_id.clone()),
                message: AgentMessage::PlanDecisionCommitted {
                    approval_id: revision.approval_id.clone(),
                    plan_revision_id: revision.plan_revision_id.clone(),
                    source_task_id: revision.source_task_id.clone(),
                    outcome: PlanDecisionOutcome::ChangesRequested,
                    decided_by: plan_decision_actor(decision_by),
                    feedback: Some(feedback.to_string()),
                    task_output_digest: None,
                    remaining_open_task_count,
                },
            },
        )?;
        crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
            conn,
            &revision.org_run_id,
            coordinator_record.id,
            crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
                source_kind: "plan_decision",
                task_id: Some(&revision.source_task_id),
                owner_member_id: Some(&revision.source_member_id),
                source_turn_intent_id: decision_source_turn_intent_id,
                task_output_digest: None,
                plan_revision_id: Some(&revision.plan_revision_id),
                suppress_self_wake,
            },
        )?;
        if suppress_self_wake {
            conn.execute(
                "UPDATE agent_org_runtime_inbox SET read_at=?2 WHERE id=?1 AND read_at IS NULL",
                params![coordinator_record.id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok((
            AgentOrgPlanRevision {
                status: AgentOrgPlanDecisionStatus::ChangesRequested,
                decision_by: Some(decision_by.as_wire().to_string()),
                feedback: Some(feedback.to_string()),
                resolved_at: Some(resolved_at),
                ..revision
            },
            inbox_record,
        ))
    }

    pub fn get(approval_id: &str) -> Result<Option<AgentOrgPlanRevision>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        query_record(&conn, "WHERE decision.approval_id=?1", params![approval_id])
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
    ) -> Result<Option<AgentOrgPlanRevision>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let record = query_record(
            &conn,
            "WHERE decision.approval_id=?1 AND revision.plan_revision_id=?2",
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
    ) -> Result<Option<AgentOrgPlanRevision>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let record = query_record(
            &conn,
            "WHERE revision.org_run_id=?1 AND decision.approval_id=?2
               AND revision.plan_revision_id=?3",
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

    /// Cancel approvals whose parent run is gone or failed. Archive owns its
    /// cancellation atomically with the irreversible fence; this reconciler
    /// must never mutate an already-Archived Team.
    pub fn cancel_pending_for_terminal_or_missing_runs() -> Result<usize, String> {
        let (changed, run_ids) =
            with_sessions_writer(|| -> Result<(usize, Vec<String>), String> {
                let conn = get_connection().map_err(|err| err.to_string())?;
                let run_ids = {
                    let mut stmt = conn
                        .prepare(
                            "SELECT DISTINCT revision.org_run_id
                         FROM agent_org_runtime_plan_revisions revision
                         JOIN agent_org_runtime_plan_decisions decision
                           ON decision.plan_revision_id=revision.plan_revision_id
                         WHERE decision.status=?1
                           AND (
                             NOT EXISTS (
                               SELECT 1 FROM agent_org_runtime_runs run
                               WHERE run.id=revision.org_run_id
                             )
                             OR EXISTS (
                               SELECT 1 FROM agent_org_runtime_runs run
                               WHERE run.id=revision.org_run_id
                                 AND run.status='failed'
                             )
                           )",
                        )
                        .map_err(|err| err.to_string())?;
                    let rows = stmt
                        .query_map(
                            params![AgentOrgPlanDecisionStatus::Pending.as_wire()],
                            |row| row.get::<_, String>(0),
                        )
                        .map_err(|err| err.to_string())?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|err| err.to_string())?
                };
                let changed = conn
                    .execute(
                        "UPDATE agent_org_runtime_plan_decisions
                 SET status=?1, decision_by='automatic', resolved_at=?2
                 WHERE status=?3
                   AND plan_revision_id IN (
                     SELECT revision.plan_revision_id
                     FROM agent_org_runtime_plan_revisions revision
                     WHERE
                     NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_runs run
                       WHERE run.id=revision.org_run_id
                     )
                     OR EXISTS (
                       SELECT 1 FROM agent_org_runtime_runs run
                       WHERE run.id=revision.org_run_id
                         AND run.status='failed'
                     )
                   )",
                        params![
                            AgentOrgPlanDecisionStatus::Cancelled.as_wire(),
                            chrono::Utc::now().to_rfc3339(),
                            AgentOrgPlanDecisionStatus::Pending.as_wire(),
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

fn insert_plan_request_in_tx(
    conn: &Connection,
    revision: &AgentOrgPlanRevision,
    delivery: AgentOrgPlanDecisionDelivery,
) -> Result<AgentInboxRecord, String> {
    let record = AgentInboxStore::insert_in_tx_without_formal_trigger(
        conn,
        InsertInboxParams {
            recipient_agent_id: delivery.recipient_agent_id,
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            sender_agent_id: delivery.sender_agent_id,
            sender_member_id: delivery.sender_member_id,
            org_run_id: Some(revision.org_run_id.clone()),
            message: plan_approval_request_message(revision),
        },
    )?;
    crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
        conn,
        &revision.org_run_id,
        record.id,
        crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
            source_kind: "plan_request",
            task_id: Some(&revision.source_task_id),
            owner_member_id: Some(&revision.source_member_id),
            source_turn_intent_id: Some(&revision.source_turn_intent_id),
            task_output_digest: None,
            plan_revision_id: Some(&revision.plan_revision_id),
            suppress_self_wake: false,
        },
    )?;
    Ok(record)
}
