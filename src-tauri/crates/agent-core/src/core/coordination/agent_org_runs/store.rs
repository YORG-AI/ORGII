use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_member_interventions::AgentMemberInterventionStore;
use crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore;
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};
use crate::definitions::orgs::AgentOrgsStore;
use crate::session::SessionStatus;
use database::db::{get_connection, with_sessions_writer};

use super::finality::load_and_assess;
use super::helpers::{
    context_for_run_record, flatten_members, insert_run, load_by_id, load_by_root_session,
    parent_session_id_of, row_to_run, validate_entry_mode, validate_status,
};
use super::progress::{
    ensure_progress_in_conn, load_progress_with_conn, mark_coordinator_observed_revision_with_conn,
    record_completion_request_in_tx, stage_coordinator_presented_with_conn,
};
use super::worker::{WorkerSessionInfo, WorkerSessionRuntime};
use super::{
    AgentOrgCompletionRequestOutcome, AgentOrgFinalityAssessment, AgentOrgRunContext,
    AgentOrgRunProgress, AgentOrgRunRecord, AgentOrgRunStatus, CreateAgentOrgRunParams,
    COORDINATOR_MEMBER_ID,
};

pub struct AgentOrgRunStore;

pub(crate) struct AgentOrgRunDeleteOutcome {
    plan_artifacts: Vec<(String, String)>,
    deleted: bool,
}

impl AgentOrgRunDeleteOutcome {
    pub(crate) fn deleted(&self) -> bool {
        self.deleted
    }
}

impl AgentOrgRunStore {
    /// Load Agent Org run metadata only for roots in the current page.
    ///
    /// Results are newest-first so callers can deterministically choose the
    /// first record if legacy data contains several runs for one root.
    pub fn list_runs_for_root_session_ids(
        root_session_ids: &[String],
    ) -> Result<Vec<AgentOrgRunRecord>, String> {
        if root_session_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = get_connection().map_err(|err| err.to_string())?;
        let placeholders = (1..=root_session_ids.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id,
                    org_id,
                    coordinator_agent_id,
                    root_session_id,
                    org_snapshot_json,
                    entry_mode,
                    status,
                    work_item_id,
                    project_slug,
                    routine_fire_id,
                    summary,
                    last_error,
                    created_at,
                    updated_at,
                    completed_at
             FROM agent_org_runs
             WHERE root_session_id IN ({placeholders})
             ORDER BY updated_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(root_session_ids.iter()),
                row_to_run,
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

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

    pub fn assess_run_finality(run_id: &str) -> Result<super::AgentOrgFinalityAssessment, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|err| err.to_string())?;
        let assessment = load_and_assess(&tx, run_id)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(assessment)
    }

    pub fn reconcile_run_finality(run_id: &str) -> Result<Option<AgentOrgRunStatus>, String> {
        // Finality and every task mutation share the sessions writer lock. The
        // canonical typed facts are re-read inside this IMMEDIATE transaction;
        // no analyzer snapshot is trusted across the lock boundary.
        let (status, changed) =
            with_sessions_writer(|| -> Result<(Option<AgentOrgRunStatus>, bool), String> {
                let mut conn = get_connection().map_err(|err| err.to_string())?;
                let tx = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|err| err.to_string())?;
                let assessment = load_and_assess(&tx, run_id)?;
                let Some(current_status) = assessment.facts.run_status else {
                    tx.commit().map_err(|err| err.to_string())?;
                    return Ok((None, false));
                };
                let next_status = match assessment.decision {
                    super::AgentOrgFinalityDecision::Complete => AgentOrgRunStatus::Completed,
                    super::AgentOrgFinalityDecision::Abandon => AgentOrgRunStatus::Abandoned,
                    super::AgentOrgFinalityDecision::KeepRunning => {
                        tx.commit().map_err(|err| err.to_string())?;
                        return Ok((Some(current_status), false));
                    }
                };
                let now = chrono::Utc::now().to_rfc3339();
                let completion_summary = assessment
                    .facts
                    .progress
                    .as_ref()
                    .and_then(|progress| progress.completion_summary.as_deref());
                let changed = tx
                    .execute(
                        "UPDATE agent_org_runs
                     SET status=?1,
                         summary=COALESCE(?2, summary),
                         updated_at=?3,
                         completed_at=?3
                     WHERE id=?4 AND status=?5",
                        params![
                            next_status.as_str(),
                            completion_summary,
                            &now,
                            run_id,
                            AgentOrgRunStatus::Running.as_str(),
                        ],
                    )
                    .map_err(|err| err.to_string())?;
                if changed != 1 {
                    tx.commit().map_err(|err| err.to_string())?;
                    return Ok((Self::get_run_status(run_id)?, false));
                }
                // Terminal status and cancellation of an otherwise stranded plan
                // approval are one atomic state transition.
                tx.execute(
                    "UPDATE agent_org_plan_approvals
                 SET status='cancelled', decision_by='system', resolved_at=?2
                 WHERE org_run_id=?1 AND status='pending'",
                    params![run_id, &now],
                )
                .map_err(|err| err.to_string())?;
                tx.commit().map_err(|err| err.to_string())?;
                Ok((Some(next_status), true))
            })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(status)
    }

    /// Resolve the org-run context for an arbitrary session — works for
    /// both the root (coordinator) session and materialized member sessions
    /// linked to the same Agent Org run.
    ///
    /// Strategy: try the direct `root_session_id` lookup first; if that
    /// misses, walk the persisted `agent_sessions.parent_session_id`
    /// chain upward (using the existing `idx_agent_sessions_parent`
    /// index) and retry the lookup at each ancestor. The first ancestor
    /// that anchors an `agent_org_runs` row wins.
    ///
    /// The persisted parent chain serves as the reverse-resolution
    /// path. `root_session_id` remains the **single anchor** for an org
    /// run — no per-subagent rows are added (avoids a second source of
    /// truth and the corresponding unify-then-reshuffle reshape).
    ///
    /// Bounded to `MAX_PARENT_WALK_DEPTH` hops so a corrupt or cyclic
    /// parent chain can't cause an unbounded scan during session init.
    pub fn context_for_run(
        run_id: &str,
        org_store: &AgentOrgsStore,
    ) -> Result<Option<AgentOrgRunContext>, String> {
        let Some(run) = load_by_id(run_id).map_err(|err| err.to_string())? else {
            return Ok(None);
        };
        Ok(Some(context_for_run_record(&run, org_store)?))
    }

    pub fn context_for_session_with_parent_walk(
        session_id: &str,
        org_store: &AgentOrgsStore,
    ) -> Result<Option<AgentOrgRunContext>, String> {
        let Some(run) = Self::run_for_session_with_parent_walk(session_id)? else {
            return Ok(None);
        };
        Ok(Some(context_for_run_record(&run, org_store)?))
    }

    pub fn root_session_id_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<String>, String> {
        Ok(Self::run_for_session_with_parent_walk(session_id)?.and_then(|run| run.root_session_id))
    }

    pub fn run_id_for_session_with_parent_walk(session_id: &str) -> Result<Option<String>, String> {
        Ok(Self::run_for_session_with_parent_walk(session_id)?.map(|run| run.id))
    }

    pub fn is_root_session(org_run_id: &str, session_id: &str) -> Result<bool, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        Ok(root_session_id.as_deref() == Some(session_id))
    }

    fn run_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<AgentOrgRunRecord>, String> {
        const MAX_PARENT_WALK_DEPTH: usize = 16;

        let mut current_id = session_id.to_string();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        for hop in 0..=MAX_PARENT_WALK_DEPTH {
            if !visited.insert(current_id.clone()) {
                tracing::warn!(
                    session_id = %session_id,
                    cycle_at = %current_id,
                    "[agent_org_runs] parent_session_id chain has a cycle; aborting walk"
                );
                return Ok(None);
            }
            if let Some(run) = load_by_root_session(&current_id).map_err(|err| err.to_string())? {
                return Ok(Some(run));
            }
            if hop == MAX_PARENT_WALK_DEPTH {
                tracing::warn!(
                    session_id = %session_id,
                    last_visited = %current_id,
                    "[agent_org_runs] parent_session_id walk exceeded max depth ({}); giving up",
                    MAX_PARENT_WALK_DEPTH
                );
                return Ok(None);
            }
            match parent_session_id_of(&current_id).map_err(|err| err.to_string())? {
                Some(parent) => current_id = parent,
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    /// List every persisted run that has anchored a coordinator session,
    /// across all orgs, ordered by `updated_at DESC`. Used by the Inbox
    /// page to render its flat list of chats — each row is one run.
    ///
    /// Runs whose `root_session_id` is still `NULL` (created but the
    /// coordinator session row has not landed yet) are excluded; the
    /// Inbox renders those as transient client-side draft rows until the
    /// anchor exists.
    pub fn list_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        org_id,
                        coordinator_agent_id,
                        root_session_id,
                        org_snapshot_json,
                        entry_mode,
                        status,
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        created_at,
                        updated_at,
                        completed_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_run)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// List runs currently in `running` status, newest-updated first.
    /// SQL-side status filter avoids loading terminal runs. Callers that must
    /// inspect every running run (the watchdog) pass `usize::MAX`, which is
    /// safely clamped to SQLite's `i64` limit.
    pub fn list_running_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        org_id,
                        coordinator_agent_id,
                        root_session_id,
                        org_snapshot_json,
                        entry_mode,
                        status,
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        created_at,
                        updated_at,
                        completed_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                   AND status = ?1
                 ORDER BY updated_at DESC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    AgentOrgRunStatus::Running.as_str(),
                    i64::try_from(limit).unwrap_or(i64::MAX)
                ],
                row_to_run,
            )
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return the current status of the run without fetching the full record.
    pub fn get_run_status(run_id: &str) -> Result<Option<AgentOrgRunStatus>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::get_run_status_with_connection(&conn, run_id)
    }

    pub(crate) fn get_run_status_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Option<AgentOrgRunStatus>, String> {
        let status_raw: Option<String> = conn
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id = ?1 LIMIT 1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        Ok(status_raw.as_deref().and_then(AgentOrgRunStatus::parse))
    }

    /// Read the canonical finality facts and decision from an existing
    /// connection or read transaction. Run View and task-list projections use
    /// this to keep all of their independently-shaped rows on one SQLite
    /// snapshot instead of opening a fresh connection for each block.
    pub(crate) fn finality_assessment_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<AgentOrgFinalityAssessment, String> {
        load_and_assess(conn, run_id)
    }

    pub fn delete_by_id(run_id: &str) -> Result<(), String> {
        let outcome = with_sessions_writer(|| -> Result<AgentOrgRunDeleteOutcome, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let outcome = Self::delete_by_id_with_connection(&tx, run_id)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(outcome)
        })?;

        Self::finish_delete(run_id, outcome);
        Ok(())
    }

    pub(crate) fn delete_by_id_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<AgentOrgRunDeleteOutcome, String> {
        let plan_artifacts = {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT approval.source_session_id, approval.plan_path
                     FROM agent_org_plan_approvals approval
                     WHERE approval.org_run_id=?1
                       AND NOT EXISTS (
                         SELECT 1 FROM agent_org_plan_approvals other
                         WHERE other.plan_path=approval.plan_path
                           AND other.org_run_id<>?1
                       )",
                )
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![run_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|err| err.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
        };

        // Intent ownership is explicit. The hierarchy delete caller rejects
        // nested run roots before reaching this helper; standalone run cleanup
        // still deletes only rows owned by the requested run.
        conn.execute(
            "DELETE FROM session_turn_intents WHERE org_run_id=?1",
            params![run_id],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_inbox_materializations
             WHERE inbox_id IN (
                 SELECT id FROM agent_inbox WHERE org_run_id=?1
             )",
            params![run_id],
        )
        .map_err(|err| {
            format!("failed to delete agent_inbox_materializations rows for {run_id}: {err}")
        })?;
        for table in [
            "agent_org_plan_approvals",
            "agent_org_recovery_attempts",
            "agent_org_task_events",
            "agent_org_tasks",
            "agent_inbox_delivery_resolutions",
            "agent_inbox",
            "agent_member_interventions",
            "agent_org_run_progress",
            "agent_org_task_run_schema_migrations",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE org_run_id=?1"),
                params![run_id],
            )
            .map_err(|err| format!("failed to delete {table} rows for {run_id}: {err}"))?;
        }
        let deleted = conn
            .execute("DELETE FROM agent_org_runs WHERE id=?1", params![run_id])
            .map_err(|err| err.to_string())?
            > 0;
        Ok(AgentOrgRunDeleteOutcome {
            plan_artifacts,
            deleted,
        })
    }

    pub(crate) fn finish_delete(run_id: &str, outcome: AgentOrgRunDeleteOutcome) {
        // SQLite is the source of truth. Files are derived artifacts, so they
        // are cleaned only after the transaction commits and failures are
        // logged without resurrecting already-deleted durable state.
        for (source_session_id, plan_path) in outcome.plan_artifacts {
            if let Err(err) = AgentOrgPlanApprovalStore::remove_managed_plan_artifact(
                &source_session_id,
                &plan_path,
            ) {
                tracing::warn!(
                    run_id,
                    source_session_id,
                    plan_path,
                    error = %err,
                    "failed to remove managed Agent Org plan artifact after run deletion"
                );
            }
        }
        if outcome.deleted {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
    }

    /// Find the freshest materialized worker session for a canonical roster
    /// `member_id` inside `org_run_id`.
    pub fn find_worker_session_by_member_id(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        let mut sessions =
            Self::list_worker_sessions_by_member_ids(org_run_id, &[member_id.to_string()])?;
        Ok(sessions.pop().map(|session| WorkerSessionInfo {
            session_id: session.session_id,
            status: session.status,
            updated_at: session.updated_at,
        }))
    }

    pub fn find_coordinator_session_by_member_id(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::find_coordinator_session_by_member_id_with_connection(&conn, org_run_id, member_id)
    }

    pub(crate) fn find_coordinator_session_by_member_id_with_connection(
        conn: &Connection,
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        if member_id != COORDINATOR_MEMBER_ID {
            return Ok(None);
        }
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT s.session_id,
                        s.status,
                        s.updated_at
                 FROM agent_org_runs r
                 JOIN agent_sessions s ON s.session_id = r.root_session_id
                 WHERE r.id = ?1
                 LIMIT 1",
                params![org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;

        let Some((session_id, status_raw, updated_at)) = row else {
            return Ok(None);
        };
        let status = crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
            format!("unknown coordinator session status for {session_id}: {status_raw:?}")
        })?;
        Ok(Some(WorkerSessionInfo {
            session_id,
            status,
            updated_at,
        }))
    }

    /// Return the freshest descendant session for each requested roster
    /// `member_id`. UI read models use this instead of `agent_definition_id`
    /// because multiple roster members may run the same AgentDefinition.
    pub fn list_worker_sessions_by_member_ids(
        org_run_id: &str,
        member_ids: &[String],
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_worker_sessions_by_member_ids_with_connection(&conn, org_run_id, member_ids)
    }

    pub(crate) fn list_worker_sessions_by_member_ids_with_connection(
        conn: &Connection,
        org_run_id: &str,
        member_ids: &[String],
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let requested: HashSet<&str> = member_ids
            .iter()
            .map(String::as_str)
            .filter(|member_id| !member_id.is_empty())
            .collect();
        if requested.is_empty() {
            return Ok(Vec::new());
        }

        let sessions = Self::list_descendant_worker_sessions_with_connection(conn, org_run_id)?;
        let mut seen = HashSet::new();
        Ok(sessions
            .into_iter()
            .filter(|session| {
                session
                    .member_id
                    .as_deref()
                    .is_some_and(|member_id| requested.contains(member_id))
            })
            .filter(|session| seen.insert(session.member_id.clone()))
            .collect())
    }

    /// Canonical member ids captured in the immutable launch snapshot.
    ///
    /// Recovery must not consult the user's current Agent Org definition: a
    /// team can be edited while an older run is still alive. `None` is kept
    /// for historical rows that predate launch snapshots; callers may still
    /// classify a materialized session, but must not invent roster membership.
    pub(crate) fn snapshot_member_ids_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Option<HashSet<String>>, String> {
        let snapshot_json: Option<String> = conn
            .query_row(
                "SELECT org_snapshot_json FROM agent_org_runs WHERE id=?1",
                params![org_run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let Some(snapshot_json) = snapshot_json else {
            return Ok(None);
        };
        let snapshot: crate::definitions::orgs::OrgDefinition =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("failed to parse Agent Org launch snapshot for run {org_run_id}: {err}")
            })?;
        Ok(Some(
            flatten_members(&snapshot.children, None)
                .into_iter()
                .map(|member| member.member_id)
                .collect(),
        ))
    }

    pub fn list_descendant_worker_sessions(
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_descendant_worker_sessions_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_descendant_worker_sessions_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let Some(root) = root_session_id else {
            return Ok(Vec::new());
        };
        let interventions =
            AgentMemberInterventionStore::list_active_with_connection(conn, org_run_id)?
                .into_iter()
                .map(|record| (record.member_id.clone(), record))
                .collect::<HashMap<_, _>>();

        let mut stmt = conn
            .prepare(
                "WITH RECURSIVE descendants(session_id) AS (
                     SELECT session_id
                     FROM agent_sessions child
                     WHERE child.parent_session_id = ?1
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_org_runs nested
                           WHERE nested.id <> ?2
                             AND nested.root_session_id = child.session_id
                       )
                     UNION
                     SELECT s.session_id
                     FROM agent_sessions s
                     JOIN descendants d ON s.parent_session_id = d.session_id
                     WHERE NOT EXISTS (
                         SELECT 1 FROM agent_org_runs nested
                         WHERE nested.id <> ?2
                           AND nested.root_session_id = s.session_id
                     )
                 ), ranked AS (
                     SELECT s.agent_definition_id,
                            s.org_member_id,
                            s.session_id,
                            s.status,
                            s.updated_at,
                            ROW_NUMBER() OVER (
                                PARTITION BY CASE
                                    WHEN s.org_member_id IS NOT NULL
                                        THEN 'member:' || s.org_member_id
                                    ELSE 'session:' || s.session_id
                                END
                                ORDER BY s.updated_at DESC, s.session_id DESC
                            ) AS rank
                     FROM agent_sessions s
                     JOIN descendants d USING (session_id)
                     WHERE s.agent_definition_id IS NOT NULL
                 )
                 SELECT agent_definition_id, org_member_id, session_id, status, updated_at
                 FROM ranked
                 WHERE rank = 1
                 ORDER BY updated_at DESC, session_id DESC",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![root.clone(), org_run_id], |row| {
                let status_raw: String = row.get(3)?;
                let status =
                    crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("unknown SessionStatus value: {status_raw:?}").into(),
                        )
                    })?;
                let agent_definition_id: String = row.get(0)?;
                let org_member_id: Option<String> = row.get(1)?;
                let intervention = org_member_id
                    .as_deref()
                    .and_then(|member_id| interventions.get(member_id).cloned());
                Ok(WorkerSessionRuntime {
                    intervention,
                    agent_definition_id: Some(agent_definition_id),
                    cli_agent_type: None,
                    member_id: org_member_id,
                    session_id: row.get(2)?,
                    parent_session_id: Some(root.clone()),
                    status,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }

        let mut cli_stmt = conn
            .prepare(
                "SELECT cli_agent_type, org_member_id, session_id, status, updated_at
                 FROM code_sessions
                 WHERE parent_session_id = ?1
                   AND org_member_id IS NOT NULL
                   AND cli_agent_type IS NOT NULL
                 ORDER BY updated_at DESC, session_id DESC",
            )
            .map_err(|err| err.to_string())?;
        let cli_rows = cli_stmt
            .query_map(params![root.clone()], |row| {
                let status_raw: String = row.get(3)?;
                let status =
                    crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("unknown CLI SessionStatus value: {status_raw:?}").into(),
                        )
                    })?;
                let cli_agent_type: String = row.get(0)?;
                let org_member_id: Option<String> = row.get(1)?;
                let intervention = org_member_id
                    .as_deref()
                    .and_then(|member_id| interventions.get(member_id).cloned());
                Ok(WorkerSessionRuntime {
                    intervention,
                    agent_definition_id: None,
                    cli_agent_type: Some(cli_agent_type),
                    member_id: org_member_id,
                    session_id: row.get(2)?,
                    parent_session_id: Some(root.clone()),
                    status,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;
        for row in cli_rows {
            out.push(row.map_err(|err| err.to_string())?);
        }

        out.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                // Historical databases can contain both a Rust and a CLI
                // session for one member at the same timestamp. Rust is the
                // only supported Agent Org transport, so it wins an exact tie.
                .then_with(|| {
                    left.cli_agent_type
                        .is_some()
                        .cmp(&right.cli_agent_type.is_some())
                })
                .then_with(|| right.session_id.cmp(&left.session_id))
        });

        // Rust and CLI sessions live in different tables, so neither table's
        // window function can suppress an older duplicate from the other
        // transport.  Apply the canonical-member rule once more after the
        // combined freshness sort.  Historical rows without a member id are
        // distinct sessions; do not guess that they belong to one member.
        let mut seen_canonical_workers = HashSet::new();
        out.retain(|session| {
            let key = session
                .member_id
                .as_ref()
                .map(|member_id| format!("member:{member_id}"))
                .unwrap_or_else(|| format!("session:{}", session.session_id));
            seen_canonical_workers.insert(key)
        });
        Ok(out)
    }
}
