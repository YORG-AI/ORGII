use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::session::SessionStatus;
use database::db::{get_connection, with_sessions_writer};

use super::super::helpers::{insert_run, validate_entry_mode, validate_status};
use super::super::progress::ensure_progress_in_conn;
use super::super::{AgentOrgRunRecord, CreateAgentOrgRunParams};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    pub fn create(params: CreateAgentOrgRunParams) -> Result<AgentOrgRunRecord, String> {
        let entry_mode = validate_entry_mode(params.entry_mode.as_str())?;
        let status = validate_status(params.status.as_str())?;
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

    /// Apply failed-Turn recovery after crash cleanup has converted a stranded
    /// Member session to Abandoned. Recovery proceeds only when one persisted
    /// running TaskExecution identifies the exact Task; a missing or ambiguous
    /// binding fails closed instead of mutating every Task owned by the Member.
    pub fn requeue_abandoned_member_tasks_on_startup() -> Result<usize, String> {
        let mut changed = 0usize;
        for run in Self::list_running_runs(100)? {
            for worker in Self::list_descendant_worker_sessions(&run.id)? {
                if worker.status != SessionStatus::Abandoned {
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
}
