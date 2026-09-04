use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};
use database::db::{get_connection, with_sessions_writer};

use super::super::progress::{
    load_progress_with_conn, mark_coordinator_observed_revision_with_conn,
    record_completion_request_in_tx, stage_coordinator_presented_with_conn,
};
use super::super::{AgentOrgCompletionRequestOutcome, AgentOrgRunProgress, AgentOrgRunStatus};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    pub fn progress(run_id: &str) -> Result<Option<AgentOrgRunProgress>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        load_progress_with_conn(&conn, run_id)
    }

    /// Record which durable work revision is embedded in the coordinator's
    /// next prompt. A later successful coordinator turn promotes this staged
    /// revision to `observed`; newer concurrent task mutations remain newer.
    pub fn stage_coordinator_work_revision(run_id: &str) -> Result<Option<i64>, String> {
        let revision = with_sessions_writer(|| {
            let conn = get_connection().map_err(|err| err.to_string())?;
            stage_coordinator_presented_with_conn(&conn, run_id)
        })?;
        if revision.is_some() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(revision)
    }

    /// Stage the coordinator's presented work revision and read the task
    /// board from the same SQLite snapshot. Prompt construction uses this so
    /// the revision certificate can never describe a newer board than the
    /// task snapshot actually rendered to the provider.
    pub fn stage_coordinator_work_revision_and_load_tasks(
        run_id: &str,
    ) -> Result<(Option<i64>, Vec<Task>), String> {
        let (revision, tasks) =
            with_sessions_writer(|| -> Result<(Option<i64>, Vec<Task>), String> {
                let mut conn = get_connection().map_err(|err| err.to_string())?;
                let tx = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|err| err.to_string())?;
                let revision = stage_coordinator_presented_with_conn(&tx, run_id)?;
                let tasks = AgentOrgTaskStore::list_operational_with_connection(&tx, run_id)?;
                tx.commit().map_err(|err| err.to_string())?;
                Ok((revision, tasks))
            })?;
        if revision.is_some() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok((revision, tasks))
    }

    pub fn mark_coordinator_observed_work_revision(
        run_id: &str,
        presented_work_revision: i64,
    ) -> Result<Option<i64>, String> {
        let observed_revision = with_sessions_writer(|| {
            let conn = get_connection().map_err(|err| err.to_string())?;
            mark_coordinator_observed_revision_with_conn(&conn, run_id, presented_work_revision)
        })?;
        if observed_revision.is_some() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(observed_revision)
    }

    /// Persist a coordinator-only completion request without forcing the run
    /// terminal. Finality still waits for delivery, approvals, interventions,
    /// sessions, and work-observation invariants to become safe.
    pub fn request_completion(
        run_id: &str,
        summary: &str,
    ) -> Result<AgentOrgCompletionRequestOutcome, String> {
        let outcome = with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let status: Option<String> = tx
                .query_row(
                    "SELECT status FROM agent_org_runs WHERE id=?1",
                    params![run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(status) = status else {
                return Err(format!("agent_org_run_not_found: {run_id}"));
            };
            if status != AgentOrgRunStatus::Running.as_str() {
                return Err(format!(
                    "agent_org_run_not_mutable: run {run_id} is {status}"
                ));
            }

            let unresolved_task_ids = {
                let mut stmt = tx
                    .prepare(
                        "SELECT id FROM agent_org_tasks
                         WHERE org_run_id=?1 AND status<>?2
                         ORDER BY created_at ASC, id ASC",
                    )
                    .map_err(|err| err.to_string())?;
                let rows = stmt
                    .query_map(params![run_id, TaskStatus::Completed.as_wire()], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|err| err.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())?
            };
            if !unresolved_task_ids.is_empty() {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(AgentOrgCompletionRequestOutcome::OpenTasks {
                    unresolved_task_ids,
                });
            }
            let progress = record_completion_request_in_tx(&tx, run_id, summary)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(AgentOrgCompletionRequestOutcome::Recorded { progress })
        })?;
        if matches!(&outcome, AgentOrgCompletionRequestOutcome::Recorded { .. }) {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(outcome)
    }
}
