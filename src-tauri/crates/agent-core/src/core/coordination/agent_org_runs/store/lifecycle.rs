use rusqlite::{params, Connection};

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
            work_item_id: params.work_item_id,
            project_slug: params.project_slug,
            routine_fire_id: params.routine_fire_id,
            summary: None,
            last_error: None,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
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

    /// Called once at app startup to pause every org run that was `running`
    /// when the previous process exited. The member sessions will have been
    /// marked `abandoned` by `mark_stale_running_sessions_abandoned`, but the
    /// org run itself should remain accessible and resumable — not auto-terminated
    /// by `reconcile_run_finality`. Transitioning to `paused` achieves this:
    /// `reconcile_run_finality` is a no-op for non-`running` runs, and the
    /// frontend's `TERMINAL_RUN_STATUSES` set excludes `paused`, so the overview
    /// panel, member switcher, and task board stay visible.
    ///
    /// Returns the number of runs transitioned.
    pub fn mark_all_running_as_paused_on_startup() -> Result<usize, String> {
        let paused = validate_status(AgentOrgRunStatus::Paused.as_str())?;
        let running = validate_status(AgentOrgRunStatus::Running.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        with_sessions_writer(|| -> Result<usize, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let rows_changed = conn
                .execute(
                    "UPDATE agent_org_runs
                     SET status = ?1,
                         updated_at = ?2
                     WHERE status = ?3",
                    params![paused.as_str(), now, running.as_str()],
                )
                .map_err(|err| err.to_string())?;
            Ok(rows_changed)
        })
    }

    /// Apply the normal failed-member task disposition after crash recovery
    /// has converted stranded Running sessions to Abandoned, but before the
    /// parent runs are paused. Tasks with an eligible peer return to the pool;
    /// sole-member work stays owned and pending for an explicit retry.
    pub fn requeue_abandoned_member_tasks_on_startup() -> Result<usize, String> {
        let mut changed = 0usize;
        for run in Self::list_running_runs(usize::MAX)? {
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

    /// Complete already-resolved runs before the generic startup pause sweep.
    ///
    /// A previous process may have left a run `running` only because an
    /// orphaned turn intent incorrectly looked queued. Startup reconciliation
    /// closes those intents. Run the canonical atomic finality check for every
    /// Running run, including an empty board with an explicit completion
    /// intent; only runs that still have blockers fall through to
    /// `mark_all_running_as_paused_on_startup`.
    pub fn reconcile_resolved_running_runs_on_startup() -> Result<usize, String> {
        let mut completed = 0usize;
        for run in Self::list_running_runs(usize::MAX)? {
            if Self::reconcile_run_finality(&run.id)? == Some(AgentOrgRunStatus::Completed) {
                completed += 1;
            }
        }
        Ok(completed)
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

    /// Establish the durable fence for a user-requested hierarchy deletion.
    ///
    /// `paused` remains resumable, so deletion must not use it as the final
    /// stop signal. Moving a live run to `cancelled` prevents resume and wake
    /// paths from starting new work while the caller drains Rust runtimes.
    pub(crate) fn cancel_for_delete_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<bool, String> {
        let now = chrono::Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE agent_org_runs
                 SET status='cancelled',
                     updated_at=?2,
                     completed_at=COALESCE(completed_at, ?2)
                 WHERE id=?1
                   AND status IN ('running', 'paused')",
                params![run_id, &now],
            )
            .map_err(|err| err.to_string())?
            > 0;
        conn.execute(
            "UPDATE agent_org_plan_approvals
             SET status='cancelled', decision_by='system', resolved_at=?2
             WHERE org_run_id=?1 AND status='pending'",
            params![run_id, &now],
        )
        .map_err(|err| err.to_string())?;
        Ok(changed)
    }

    pub fn mark_failed(run_id: &str, error_message: &str) -> Result<(), String> {
        let status = validate_status(AgentOrgRunStatus::Failed.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        with_sessions_writer(|| -> Result<(), String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            tx.execute(
                "UPDATE agent_org_runs
                 SET status = ?1,
                     last_error = ?2,
                     updated_at = ?3,
                     completed_at = ?3
                 WHERE id = ?4",
                params![status.as_str(), error_message, now, run_id],
            )
            .map_err(|err| err.to_string())?;
            tx.execute(
                "UPDATE agent_org_plan_approvals
                 SET status='cancelled', decision_by='system', resolved_at=?2
                 WHERE org_run_id=?1 AND status='pending'",
                params![run_id, &now],
            )
            .map_err(|err| err.to_string())?;
            tx.commit().map_err(|err| err.to_string())
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        Ok(())
    }
}
