use rusqlite::params;

use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::session::SessionStatus;
use database::db::{get_connection, with_sessions_writer};

use super::super::helpers::{insert_run, validate_entry_mode, validate_status};
use super::super::progress::ensure_progress_in_conn;
use super::super::{AgentOrgRunRecord, AgentOrgRunStatus, CreateAgentOrgRunParams};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    pub fn create(params: CreateAgentOrgRunParams) -> Result<AgentOrgRunRecord, String> {
        let entry_mode = validate_entry_mode(params.entry_mode.as_str())?;
        let status = validate_status(params.status.as_str())?;
        let org_snapshot_json = serde_json::to_string(&params.org_snapshot)
            .map_err(|err| format!("failed to serialize Agent Org launch snapshot: {err}"))?;
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

    /// Pause a running run. Only transitions `running → paused`; already
    /// non-running runs are left unchanged and return `Ok(false)` (idempotent).
    pub fn mark_paused(run_id: &str) -> Result<bool, String> {
        let paused = validate_status(AgentOrgRunStatus::Paused.as_str())?;
        let running = validate_status(AgentOrgRunStatus::Running.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let rows_changed = conn
                .execute(
                    "UPDATE agent_org_runs
                     SET status = ?1,
                         updated_at = ?2
                     WHERE id = ?3
                       AND status = ?4",
                    params![paused.as_str(), now, run_id, running.as_str()],
                )
                .map_err(|err| err.to_string())?;
            Ok(rows_changed > 0)
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(changed)
    }

    /// Apply the normal failed-member task disposition after crash recovery
    /// has converted stranded Running sessions to Abandoned. Tasks with an
    /// eligible peer return to the pool; sole-member work stays owned and
    /// pending for an explicit retry. The Team remains Running and is then
    /// reconciled from its Quiescence facts.
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
                changed +=
                    AgentOrgTaskStore::requeue_in_progress_for_owner(&run.id, member_id)?.len();
            }
        }
        Ok(changed)
    }

    /// Resume a paused run. Only transitions `paused → running`; already
    /// non-paused runs are left unchanged and return `Ok(false)` (idempotent).
    pub fn mark_resumed(run_id: &str) -> Result<bool, String> {
        let running = validate_status(AgentOrgRunStatus::Running.as_str())?;
        let paused = validate_status(AgentOrgRunStatus::Paused.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let rows_changed = conn
                .execute(
                    "UPDATE agent_org_runs
                     SET status = ?1,
                         updated_at = ?2
                     WHERE id = ?3
                       AND status = ?4",
                    params![running.as_str(), now, run_id, paused.as_str()],
                )
                .map_err(|err| err.to_string())?;
            Ok(rows_changed > 0)
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(changed)
    }
}
