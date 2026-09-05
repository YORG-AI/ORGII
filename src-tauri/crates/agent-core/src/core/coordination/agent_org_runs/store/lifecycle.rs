use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::session::SessionStatus;
use database::db::{get_connection, with_sessions_writer};

use super::super::helpers::{insert_run, validate_entry_mode, validate_status};
use super::super::progress::ensure_progress_in_conn;
use super::super::{
    AgentOrgRunRecord, AgentOrgRunStatus, CreateAgentOrgRunParams, COORDINATOR_MEMBER_ID,
};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    pub fn create(params: CreateAgentOrgRunParams) -> Result<AgentOrgRunRecord, String> {
        let entry_mode = validate_entry_mode(params.entry_mode.as_str())?;
        let status = validate_status(params.status.as_str())?;
        if status == AgentOrgRunStatus::Archived {
            return Err(
                "team_archived_requires_receipt: create the Team in a live state and use Archive"
                    .to_string(),
            );
        }
        let org_snapshot_json = super::serialize_launch_snapshot(&params.org_snapshot)?;
        let now = chrono::Utc::now().to_rfc3339();
        let run = AgentOrgRunRecord {
            id: format!("agent-org-run-{}", uuid::Uuid::new_v4()),
            org_id: params.org_id,
            coordinator_agent_id: params.coordinator_agent_id,
            root_session_id: params.root_session_id,
            org_snapshot_json: Some(org_snapshot_json),
            entry_mode,
            status,
            activation_generation: 1,
            has_initial_work: false,
            work_item_id: params.work_item_id,
            project_slug: params.project_slug,
            routine_fire_id: params.routine_fire_id,
            summary: None,
            last_error: None,
            failure_json: None,
            last_activity_outcome: None,
            created_at: now.clone(),
            updated_at: now,
            idled_at: None,
            archived_at: None,
            archive_receipt_id: None,
        };

        with_sessions_writer(|| -> Result<(), String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            insert_run(&tx, &run).map_err(|err| err.to_string())?;
            ensure_progress_in_conn(&tx, &run.id)?;
            tx.commit().map_err(|err| err.to_string())
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run.id);
        Ok(run)
    }

    /// Apply failed-Turn recovery after crash cleanup has made a stranded
    /// Member session terminal. Recovery proceeds only when one persisted
    /// running TaskExecution identifies the exact Task; a missing or ambiguous
    /// binding fails closed instead of mutating every Task owned by the Member.
    pub fn requeue_abandoned_member_tasks_on_startup() -> Result<usize, String> {
        let mut changed = 0usize;
        for run in Self::list_running_runs(100)? {
            for worker in Self::list_descendant_worker_sessions(&run.id)? {
                if !worker.status.is_terminal() || worker.status == SessionStatus::Archived {
                    continue;
                }
                let Some(member_id) = worker.member_id.as_deref() else {
                    continue;
                };
                let failed_turn_intent_id = {
                    let conn = get_connection().map_err(|error| error.to_string())?;
                    crate::coordination::agent_org_turn_contexts::unique_running_task_execution_turn_for_recovery(
                        &conn,
                        &run.id,
                        &worker.session_id,
                        member_id,
                    )?
                };
                let Some(failed_turn_intent_id) = failed_turn_intent_id else {
                    tracing::warn!(
                        run_id = %run.id,
                        session_id = %worker.session_id,
                        member_id,
                        "abandoned Agent Org Member has no unique persisted TaskExecution; refusing Task recovery"
                    );
                    continue;
                };
                changed += AgentOrgTaskStore::recover_task_execution_failure(
                    &worker.session_id,
                    &failed_turn_intent_id,
                )?
                .len();
            }
        }
        Ok(changed)
    }

    /// Promote the canonical Root Coordinator's current Idle Turn only when
    /// that same transaction is about to commit new formal Task graph work.
    /// The caller owns the transaction, so any later Task/history/outbox or
    /// receipt failure rolls this generation change back as well.
    pub(crate) fn activate_idle_for_task_graph_in_tx(
        conn: &Connection,
        run_id: &str,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<bool, String> {
        let run: Option<(String, i64, Option<String>)> = conn
            .query_row(
                "SELECT status,activation_generation,org_snapshot_json
                 FROM agent_org_runtime_runs WHERE id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((status_raw, generation, snapshot_json)) = run else {
            return Err(format!("agent_org_run_not_found: {run_id}"));
        };
        let status = AgentOrgRunStatus::parse(&status_raw)
            .ok_or_else(|| format!("unknown Agent Org run status: {status_raw}"))?;
        match status {
            AgentOrgRunStatus::Running => return Ok(false),
            AgentOrgRunStatus::Paused => {
                return Err(format!(
                    "team_paused_resume_required: Agent Org run {run_id} must be resumed before creating formal work"
                ));
            }
            AgentOrgRunStatus::Archived => {
                return Err(format!(
                    "team_archived: Agent Org run {run_id} is read-only"
                ));
            }
            AgentOrgRunStatus::Starting | AgentOrgRunStatus::Failed => {
                return Err(super::super::mutation_blocked_error(
                    run_id,
                    status.as_str(),
                ));
            }
            AgentOrgRunStatus::Idle => {}
        }

        let context =
            crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
                conn,
                session_id,
                turn_intent_id,
            )?;
        if context.org_run_id != run_id {
            return Err("task_graph_writer_idle_activation_context_mismatch".to_string());
        }
        let is_coordinator = context.participant_id == COORDINATOR_MEMBER_ID
            && context.turn_kind
                == crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
            && context.source_kind.is_coordinator_root();
        let is_user_directed_coordinator = context.participant_id == COORDINATOR_MEMBER_ID
            && context.turn_kind
                == crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
            && context.source_kind
                == crate::coordination::agent_org_turn_contexts::AgentOrgTurnSourceKind::MemberInbox
            && context.activation_generation.is_none();
        let is_user_directed_member_writer = if context.turn_kind
            == crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::UserDirectedWork
            && context.participant_id != COORDINATOR_MEMBER_ID
            && context.dispatch_member_id.as_deref() == Some(context.participant_id.as_str())
            && context.activation_generation.is_none()
        {
            let snapshot_json = snapshot_json
                .as_deref()
                .ok_or_else(|| "task_graph_writer_idle_activation_snapshot_missing".to_string())?;
            let snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot =
                serde_json::from_str(snapshot_json).map_err(|error| {
                    format!("task_graph_writer_idle_activation_snapshot_invalid: {error}")
                })?;
            crate::definitions::orgs::validate_launch_snapshot(&snapshot).map_err(|error| {
                format!("task_graph_writer_idle_activation_snapshot_invalid: {error}")
            })?;
            snapshot
                .additional_task_graph_writer_member_ids
                .iter()
                .any(|member_id| member_id == &context.participant_id)
        } else {
            false
        };
        if !is_coordinator && !is_user_directed_coordinator && !is_user_directed_member_writer {
            return Err(
                "task_graph_writer_idle_activation_requires_canonical_writer_turn".to_string(),
            );
        }
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| format!("Agent Org run {run_id} generation overflow"))?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_runs
                 SET status='running',activation_generation=?2,updated_at=?3,
                     idled_at=NULL,last_activity_outcome=NULL
                 WHERE id=?1 AND status='idle' AND activation_generation=?4",
                params![run_id, next_generation, &now, generation],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!(
                "agent_org_idle_activation_conflict: run {run_id} changed before commit"
            ));
        }
        if is_coordinator {
            let marked = conn
                .execute(
                    "UPDATE agent_org_runtime_turn_contexts
                     SET activation_generation=?4
                     WHERE session_id=?1 AND turn_intent_id=?2 AND org_run_id=?3
                       AND participant_id='coordinator' AND turn_kind='coordinator'
                       AND source_kind IN ('root_turn','group_root')
                       AND activation_generation=?5",
                    params![
                        session_id,
                        turn_intent_id,
                        run_id,
                        next_generation,
                        generation
                    ],
                )
                .map_err(|error| error.to_string())?;
            if marked != 1 {
                return Err("task_graph_writer_idle_activation_turn_marker_conflict".to_string());
            }
        }
        Ok(true)
    }
}
