use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_member_interventions::AgentMemberInterventionStore;
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, TaskStatus};
use crate::definitions::orgs::AgentOrgsStore;
use crate::session::SessionStatus;
use database::db::{get_connection, with_sessions_writer};

use super::helpers::{
    context_for_run_record, insert_run, load_by_id, load_by_root_session, parent_session_id_of,
    row_to_run, validate_entry_mode, validate_status,
};
use super::worker::{WorkerSessionInfo, WorkerSessionRuntime};
use super::{
    AgentOrgCompletionSnapshot, AgentOrgRunContext, AgentOrgRunRecord, AgentOrgRunStatus,
    CreateAgentOrgRunParams, COORDINATOR_MEMBER_ID,
};

fn session_is_quiescent_for_completed_run(status: SessionStatus) -> bool {
    match status {
        SessionStatus::Idle
        | SessionStatus::Completed
        | SessionStatus::Failed
        | SessionStatus::Cancelled
        | SessionStatus::Abandoned
        | SessionStatus::Timeout
        | SessionStatus::Archived => true,
        SessionStatus::Pending
        | SessionStatus::Running
        | SessionStatus::WaitingForUser
        | SessionStatus::WaitingForFunds
        | SessionStatus::Paused => false,
    }
}

fn timestamp_at_or_after(candidate: &str, baseline: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(candidate),
        chrono::DateTime::parse_from_rfc3339(baseline),
    ) {
        (Ok(candidate), Ok(baseline)) => candidate >= baseline,
        _ => false,
    }
}

pub struct AgentOrgRunStore;

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
            let conn = get_connection().map_err(|err| err.to_string())?;
            insert_run(&conn, &run).map_err(|err| err.to_string())?;
            Ok(())
        })?;
        Ok(run)
    }

    /// Pause a running run. Only transitions `running → paused`; already
    /// non-running runs are left unchanged and return `Ok(false)` (idempotent).
    pub fn mark_paused(run_id: &str) -> Result<bool, String> {
        let paused = validate_status(AgentOrgRunStatus::Paused.as_str())?;
        let running = validate_status(AgentOrgRunStatus::Running.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        with_sessions_writer(|| -> Result<bool, String> {
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
        })
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
    /// closes those intents. If every task is already resolved, run the normal
    /// atomic finality check now; only runs that still need work should fall
    /// through to `mark_all_running_as_paused_on_startup`.
    pub fn reconcile_resolved_running_runs_on_startup() -> Result<usize, String> {
        let mut completed = 0usize;
        for run in Self::list_running_runs(usize::MAX)? {
            let tasks = AgentOrgTaskStore::list(&run.id)?;
            if tasks.is_empty() || tasks.iter().any(|task| !task.status.is_resolved()) {
                continue;
            }
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
        with_sessions_writer(|| -> Result<bool, String> {
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
        })
    }

    pub fn mark_failed(run_id: &str, error_message: &str) -> Result<(), String> {
        let status = validate_status(AgentOrgRunStatus::Failed.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        with_sessions_writer(|| -> Result<(), String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            conn.execute(
                "UPDATE agent_org_runs
                 SET status = ?1,
                     last_error = ?2,
                     updated_at = ?3,
                     completed_at = ?3
                 WHERE id = ?4",
                params![status.as_str(), error_message, now, run_id],
            )
            .map_err(|err| err.to_string())?;
            Ok(())
        })
    }

    pub fn reconcile_run_finality(run_id: &str) -> Result<Option<AgentOrgRunStatus>, String> {
        // Finality and every task/session mutation share the sessions writer
        // lock. The root session, latest member sessions, task board and run
        // status are all read inside one IMMEDIATE transaction so no stale
        // pre-lock snapshot can close a run while a worker is active.
        with_sessions_writer(|| -> Result<Option<AgentOrgRunStatus>, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let run_row: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT status, root_session_id FROM agent_org_runs WHERE id=?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some((current_status, root_session_id)) = run_row else {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(None);
            };
            let current_status = AgentOrgRunStatus::parse(&current_status)
                .ok_or_else(|| format!("unknown Agent Org run status: {current_status}"))?;
            if current_status != AgentOrgRunStatus::Running {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(Some(current_status));
            }
            let Some(root_session_id) = root_session_id else {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(Some(current_status));
            };

            let root_row: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT status, last_terminal_turn_at
                     FROM agent_sessions WHERE session_id=?1",
                    params![&root_session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some((root_status, root_last_terminal_turn_at)) = root_row else {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(Some(current_status));
            };
            let root_status = SessionStatus::parse(&root_status).ok_or_else(|| {
                format!("unknown root session status for {root_session_id}: {root_status:?}")
            })?;

            let rust_worker_statuses_raw: Vec<String> = {
                let mut stmt = tx
                    .prepare(
                        "WITH RECURSIVE descendants(session_id) AS (
                             SELECT session_id FROM agent_sessions WHERE parent_session_id=?1
                             UNION ALL
                             SELECT child.session_id FROM agent_sessions child
                             JOIN descendants parent ON child.parent_session_id=parent.session_id
                         ), ranked AS (
                             SELECT session.status,
                                    ROW_NUMBER() OVER (
                                        PARTITION BY COALESCE(session.org_member_id, session.agent_definition_id)
                                        ORDER BY session.updated_at DESC
                                    ) AS rank
                             FROM agent_sessions session
                             JOIN descendants USING (session_id)
                             WHERE session.agent_definition_id IS NOT NULL
                         )
                         SELECT status FROM ranked WHERE rank=1",
                    )
                    .map_err(|err| err.to_string())?;
                let rows = stmt
                    .query_map(params![&root_session_id], |row| row.get(0))
                    .map_err(|err| err.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())?
            };
            let rust_worker_statuses = rust_worker_statuses_raw
                .into_iter()
                .map(|raw| {
                    SessionStatus::parse(&raw)
                        .ok_or_else(|| format!("unknown worker session status: {raw:?}"))
                })
                .collect::<Result<Vec<_>, String>>()?;

            let cli_worker_statuses_raw: Vec<String> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT status FROM code_sessions
                         WHERE parent_session_id=?1
                           AND org_member_id IS NOT NULL
                           AND cli_agent_type IS NOT NULL",
                    )
                    .map_err(|err| err.to_string())?;
                let rows = stmt
                    .query_map(params![&root_session_id], |row| row.get(0))
                    .map_err(|err| err.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())?
            };
            let cli_worker_statuses = cli_worker_statuses_raw
                .into_iter()
                .map(|raw| {
                    SessionStatus::parse(&raw)
                        .ok_or_else(|| format!("unknown CLI worker session status: {raw:?}"))
                })
                .collect::<Result<Vec<_>, String>>()?;

            let (task_count, incomplete_tasks, latest_task_updated_at): (i64, i64, Option<String>) =
                tx.query_row(
                    "SELECT COUNT(*),
                            SUM(CASE WHEN status != ?2 THEN 1 ELSE 0 END),
                            MAX(updated_at)
                     FROM agent_org_tasks
                     WHERE org_run_id=?1",
                    params![run_id, TaskStatus::Completed.as_wire()],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            row.get(2)?,
                        ))
                    },
                )
                .map_err(|err| err.to_string())?;
            let coordinator_observed_latest_tasks = match (
                root_last_terminal_turn_at.as_deref(),
                latest_task_updated_at.as_deref(),
            ) {
                (Some(root_turn_at), Some(task_updated_at)) => {
                    timestamp_at_or_after(root_turn_at, task_updated_at)
                }
                _ => false,
            };
            let all_workers_terminal = rust_worker_statuses
                .iter()
                .chain(cli_worker_statuses.iter())
                .all(|status| status.is_terminal());
            let all_sessions_quiescent = session_is_quiescent_for_completed_run(root_status)
                && rust_worker_statuses
                    .iter()
                    .chain(cli_worker_statuses.iter())
                    .all(|status| session_is_quiescent_for_completed_run(*status));

            let has_unread_inbox: bool = tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM agent_inbox
                         WHERE org_run_id=?1 AND read_at IS NULL
                     )",
                    params![run_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            // Older builds could persist a coordinator intervention from an
            // ordinary root message. Coordinator is the normal control
            // surface, so repair that invalid row inside the same finality
            // transaction before deciding whether an intervention blocks the
            // run from closing.
            tx.execute(
                "UPDATE agent_member_interventions
                 SET cleared_at=?3
                 WHERE org_run_id=?1
                   AND member_id=?2
                   AND cleared_at IS NULL",
                params![run_id, COORDINATOR_MEMBER_ID, &now],
            )
            .map_err(|err| err.to_string())?;
            let has_active_intervention: bool = tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM agent_member_interventions
                         WHERE org_run_id=?1
                           AND cleared_at IS NULL
                           AND resume_after > ?2
                     )",
                    params![run_id, &now],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            let has_pending_turn_intent: bool = tx
                .query_row(
                    "WITH RECURSIVE org_sessions(session_id) AS (
                         SELECT ?1
                         UNION ALL
                         SELECT child.session_id
                         FROM agent_sessions child
                         JOIN org_sessions parent
                           ON child.parent_session_id = parent.session_id
                     )
                     SELECT EXISTS(
                         SELECT 1
                         FROM session_turn_intents intent
                         JOIN org_sessions USING(session_id)
                         WHERE intent.status IN ('optimistic', 'queued', 'running')
                     )",
                    params![&root_session_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;

            let next_status = if task_count > 0
                && incomplete_tasks == 0
                && all_sessions_quiescent
                && !has_unread_inbox
                && !has_active_intervention
                && !has_pending_turn_intent
                && coordinator_observed_latest_tasks
            {
                Some(AgentOrgRunStatus::Completed)
            } else if incomplete_tasks > 0 && root_status.is_terminal() && all_workers_terminal {
                Some(AgentOrgRunStatus::Abandoned)
            } else {
                None
            };
            let Some(next_status) = next_status else {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(Some(current_status));
            };
            tx.execute(
                "UPDATE agent_org_runs
                 SET status = ?1,
                     updated_at = ?2,
                     completed_at = ?2
                 WHERE id = ?3 AND status = ?4",
                params![
                    next_status.as_str(),
                    now,
                    run_id,
                    AgentOrgRunStatus::Running.as_str(),
                ],
            )
            .map_err(|err| err.to_string())?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(Some(next_status))
        })
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

    /// Read the completion certificate inputs under the same writer lock and
    /// SQLite IMMEDIATE transaction used by task/run mutations. This prevents
    /// a mixed snapshot such as "tasks before a new assignment" plus
    /// "sessions after it was queued" from being reported as complete.
    pub fn completion_snapshot(run_id: &str) -> Result<AgentOrgCompletionSnapshot, String> {
        with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let run_row: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT status, root_session_id FROM agent_org_runs WHERE id=?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let (run_status, root_session_id) = match run_row {
                Some((status, root_session_id)) => (
                    Some(AgentOrgRunStatus::parse(&status).ok_or_else(|| {
                        format!("unknown Agent Org run status for {run_id}: {status:?}")
                    })?),
                    root_session_id,
                ),
                None => (None, None),
            };

            let tasks = AgentOrgTaskStore::list_with_connection(&tx, run_id)?;

            let mut active_member_ids = Vec::new();
            let mut pending_worker_turn_intent_count = 0usize;
            if let Some(root_session_id) = root_session_id.as_deref() {
                let mut stmt = tx
                    .prepare(
                        "WITH RECURSIVE descendants(session_id) AS (
                             SELECT session_id FROM agent_sessions WHERE parent_session_id=?1
                             UNION ALL
                             SELECT child.session_id FROM agent_sessions child
                             JOIN descendants parent ON child.parent_session_id=parent.session_id
                         ), ranked AS (
                             SELECT COALESCE(session.org_member_id, session.session_id) AS member_id,
                                    session.status,
                                    ROW_NUMBER() OVER (
                                        PARTITION BY COALESCE(session.org_member_id, session.agent_definition_id)
                                        ORDER BY session.updated_at DESC
                                    ) AS rank
                             FROM agent_sessions session
                             JOIN descendants USING(session_id)
                             WHERE session.agent_definition_id IS NOT NULL
                         )
                         SELECT member_id, status FROM ranked WHERE rank=1",
                    )
                    .map_err(|err| err.to_string())?;
                let rows = stmt
                    .query_map(params![root_session_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    let (member_id, status) = row.map_err(|err| err.to_string())?;
                    let status = SessionStatus::parse(&status).ok_or_else(|| {
                        format!("unknown worker session status for {member_id}: {status:?}")
                    })?;
                    if !session_is_quiescent_for_completed_run(status) {
                        active_member_ids.push(member_id);
                    }
                }

                let mut cli_stmt = tx
                    .prepare(
                        "SELECT org_member_id, status FROM code_sessions
                         WHERE parent_session_id=?1
                           AND org_member_id IS NOT NULL
                           AND cli_agent_type IS NOT NULL",
                    )
                    .map_err(|err| err.to_string())?;
                let cli_rows = cli_stmt
                    .query_map(params![root_session_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|err| err.to_string())?;
                for row in cli_rows {
                    let (member_id, status) = row.map_err(|err| err.to_string())?;
                    let status = SessionStatus::parse(&status).ok_or_else(|| {
                        format!("unknown CLI worker session status for {member_id}: {status:?}")
                    })?;
                    if !session_is_quiescent_for_completed_run(status) {
                        active_member_ids.push(member_id);
                    }
                }

                let count: i64 = tx
                    .query_row(
                        "WITH RECURSIVE worker_sessions(session_id) AS (
                             SELECT session_id FROM agent_sessions WHERE parent_session_id=?1
                             UNION ALL
                             SELECT child.session_id FROM agent_sessions child
                             JOIN worker_sessions parent
                               ON child.parent_session_id=parent.session_id
                         )
                         SELECT COUNT(*) FROM session_turn_intents intent
                         JOIN worker_sessions USING(session_id)
                         WHERE intent.status IN ('optimistic', 'queued', 'running')",
                        params![root_session_id],
                        |row| row.get(0),
                    )
                    .map_err(|err| err.to_string())?;
                pending_worker_turn_intent_count = usize::try_from(count)
                    .map_err(|_| format!("invalid pending turn intent count: {count}"))?;
            }

            active_member_ids.sort();
            active_member_ids.dedup();
            let now = chrono::Utc::now().to_rfc3339();
            let active_intervention_member_ids = {
                let mut stmt = tx
                    .prepare(
                        "SELECT DISTINCT member_id FROM agent_member_interventions
                         WHERE org_run_id=?1 AND cleared_at IS NULL AND resume_after>?2
                         ORDER BY member_id ASC",
                    )
                    .map_err(|err| err.to_string())?;
                let rows = stmt
                    .query_map(params![run_id, now], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())?
            };
            let unread_inbox_count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM agent_inbox WHERE org_run_id=?1 AND read_at IS NULL",
                    params![run_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            let pending_plan_approval_count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM agent_org_plan_approvals
                     WHERE org_run_id=?1 AND status='pending'",
                    params![run_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            let unread_inbox_count = usize::try_from(unread_inbox_count)
                .map_err(|_| "invalid unread inbox count".to_string())?;
            let pending_plan_approval_count = usize::try_from(pending_plan_approval_count)
                .map_err(|_| "invalid pending plan approval count".to_string())?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(AgentOrgCompletionSnapshot {
                run_status,
                tasks,
                active_member_ids,
                active_intervention_member_ids,
                pending_worker_turn_intent_count,
                unread_inbox_count,
                pending_plan_approval_count,
            })
        })
    }

    pub fn delete_by_id(run_id: &str) -> Result<(), String> {
        with_sessions_writer(|| -> Result<(), String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            conn.execute("DELETE FROM agent_org_runs WHERE id = ?1", params![run_id])
                .map_err(|err| err.to_string())?;
            Ok(())
        })
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
        if member_id != COORDINATOR_MEMBER_ID {
            return Ok(None);
        }
        let conn = get_connection().map_err(|err| err.to_string())?;
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
        let requested: HashSet<&str> = member_ids
            .iter()
            .map(String::as_str)
            .filter(|member_id| !member_id.is_empty())
            .collect();
        if requested.is_empty() {
            return Ok(Vec::new());
        }

        let sessions = Self::list_descendant_worker_sessions(org_run_id)?;
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

    pub fn list_descendant_worker_sessions(
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
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
        let Some(root) = root_session_id else {
            return Ok(Vec::new());
        };

        let mut stmt = conn
            .prepare(
                "WITH RECURSIVE descendants(session_id) AS (
                     SELECT session_id FROM agent_sessions WHERE parent_session_id = ?1
                     UNION ALL
                     SELECT s.session_id
                     FROM agent_sessions s
                     JOIN descendants d ON s.parent_session_id = d.session_id
                 ), ranked AS (
                     SELECT s.agent_definition_id,
                            s.org_member_id,
                            s.session_id,
                            s.status,
                            s.updated_at,
                            ROW_NUMBER() OVER (
                                PARTITION BY COALESCE(s.org_member_id, s.agent_definition_id)
                                ORDER BY s.updated_at DESC
                            ) AS rank
                     FROM agent_sessions s
                     JOIN descendants d USING (session_id)
                     WHERE s.agent_definition_id IS NOT NULL
                 )
                 SELECT agent_definition_id, org_member_id, session_id, status, updated_at
                 FROM ranked
                 WHERE rank = 1
                 ORDER BY updated_at DESC",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![root.clone()], |row| {
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
                let intervention = match org_member_id.as_deref() {
                    Some(member_id) => {
                        AgentMemberInterventionStore::active_for_member(org_run_id, member_id)
                            .map_err(|err| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    1,
                                    rusqlite::types::Type::Text,
                                    err.into(),
                                )
                            })?
                    }
                    None => None,
                };
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
                 ORDER BY updated_at DESC",
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
                let intervention = match org_member_id.as_deref() {
                    Some(member_id) => {
                        AgentMemberInterventionStore::active_for_member(org_run_id, member_id)
                            .map_err(|err| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    1,
                                    rusqlite::types::Type::Text,
                                    err.into(),
                                )
                            })?
                    }
                    None => None,
                };
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

        out.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(out)
    }
}
