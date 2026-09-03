//! Durable Agent Org wake claiming and task-bound mode resolution.
//!
//! A background wake is enqueued from a snapshot, so both halves here re-read
//! durable state at the moment it matters: the session row is claimed
//! atomically when the scheduler actually starts the turn, and a
//! TaskExecution turn's exec mode is read from the first-class column on the
//! exact Task bound by its persisted Turn context.

/// Atomically claim a queued Agent Org Wake at the moment the scheduler
/// actually starts it. A pre-enqueue status check is only a snapshot: the Run
/// or member can be paused, archived, replaced, or put under direct user
/// intervention while the Wake waits in the queue.
pub(super) fn promote_agent_org_wake_session_to_running(
    conn: &rusqlite::Connection,
    run_id: &str,
    session_id: &str,
) -> Result<usize, String> {
    use crate::coordination::agent_org_runs::{AgentOrgRunStatus, COORDINATOR_MEMBER_ID};
    use crate::session::SessionStatus;

    let wakeable = SessionStatus::AGENT_ORG_WAKEABLE;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "WITH RECURSIVE
         run_anchor(root_session_id) AS (
             SELECT root_session_id
             FROM agent_org_runtime_runs
             WHERE id=?4 AND status=?5 AND root_session_id IS NOT NULL
         ),
         descendants(session_id) AS (
             SELECT root_session_id FROM run_anchor
             UNION
             SELECT child.session_id
             FROM agent_sessions child
             JOIN descendants parent ON child.parent_session_id=parent.session_id
             WHERE NOT EXISTS (
                 SELECT 1 FROM agent_org_runtime_runs nested
                 WHERE nested.id<>?4
                   AND nested.root_session_id=child.session_id
             )
         ),
         ranked(session_id, member_rank) AS (
             SELECT session.session_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY CASE
                            WHEN session.session_id=anchor.root_session_id
                                THEN 'coordinator'
                            ELSE 'member:' || session.org_member_id
                        END
                        ORDER BY session.updated_at DESC, session.session_id DESC
                    )
             FROM agent_sessions session
             JOIN descendants USING (session_id)
             CROSS JOIN run_anchor anchor
             WHERE session.session_id=anchor.root_session_id
                OR (session.agent_definition_id IS NOT NULL
                    AND session.org_member_id IS NOT NULL)
         )
         UPDATE agent_sessions
         SET status=?1, updated_at=?2
         WHERE session_id=?3
           AND status IN (?6, ?7, ?8, ?9, ?10, ?11)
           AND session_id IN (
               SELECT session_id FROM ranked WHERE member_rank=1
           )
           AND NOT EXISTS (
               SELECT 1
               FROM agent_org_runtime_member_interventions intervention
               WHERE intervention.org_run_id=?4
                 AND intervention.member_id=CASE
                     WHEN agent_sessions.session_id=(SELECT root_session_id FROM run_anchor)
                         THEN ?12
                     ELSE agent_sessions.org_member_id
                 END
                 AND intervention.status IN ('yield_requested','active','return_requested')
           )",
        rusqlite::params![
            SessionStatus::Running.as_str(),
            &now,
            session_id,
            run_id,
            AgentOrgRunStatus::Running.as_str(),
            wakeable[0].as_str(),
            wakeable[1].as_str(),
            wakeable[2].as_str(),
            wakeable[3].as_str(),
            wakeable[4].as_str(),
            wakeable[5].as_str(),
            COORDINATOR_MEMBER_ID,
        ],
    )
    .map_err(|error| error.to_string())
}

/// Promote an exact, already-admitted UserDirectedWork Turn while its Team is
/// Running, Idle, or Paused. This changes only the recipient Session runtime;
/// it never activates or resumes the formal Team lifecycle.
///
/// Submit preflight is only a snapshot, so this claim re-checks both Run state
/// and persisted Turn identity atomically immediately before Provider work.
pub(super) fn promote_agent_org_user_directed_session_to_running(
    conn: &rusqlite::Connection,
    run_id: &str,
    session_id: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE agent_sessions
         SET status=?1, updated_at=?2
         WHERE session_id=?3
           AND EXISTS (
               SELECT 1
               FROM agent_org_runtime_runs run
               WHERE run.id=?4
                 AND run.status IN (?5,?6,?7)
           )",
        rusqlite::params![
            crate::session::SessionStatus::Running.as_str(),
            chrono::Utc::now().to_rfc3339(),
            session_id,
            run_id,
            crate::coordination::agent_org_runs::AgentOrgRunStatus::Running.as_str(),
            crate::coordination::agent_org_runs::AgentOrgRunStatus::Idle.as_str(),
            crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused.as_str(),
        ],
    )
    .map_err(|error| error.to_string())
}

/// Resolve the execution mode for one admitted background Agent Org wake.
/// `TaskAssigned` is only a doorbell: the persisted Task context identifies
/// the one authoritative row, and unknown/corrupt mode values fail closed
/// instead of falling back to Build. Coordinator wakes have no Task mode.
pub(crate) fn resolve_agent_org_wake_mode(
    session_id: &str,
    run_id: &str,
    turn_intent_id: &str,
) -> Result<Option<crate::session::AgentExecMode>, String> {
    use crate::coordination::agent_org_tasks::TaskExecutionMode;
    use crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind;
    use rusqlite::{params, OptionalExtension, TransactionBehavior};

    let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let context = crate::coordination::agent_org_turn_contexts::require_context_with_connection(
        &tx,
        session_id,
        turn_intent_id,
    )?;
    if context.org_run_id != run_id {
        return Err(format!(
            "Agent Org wake context run mismatch: expected {run_id}, found {}",
            context.org_run_id
        ));
    }

    let resolved = match context.turn_kind {
        AgentOrgTurnKind::Coordinator => None,
        AgentOrgTurnKind::TaskExecution => {
            let task_id = context
                .task_id
                .as_deref()
                .ok_or_else(|| "TaskExecution wake context has no canonical task_id".to_string())?;
            let owner_member_id = context.owner_member_id.as_deref().ok_or_else(|| {
                "TaskExecution wake context has no canonical owner_member_id".to_string()
            })?;
            let row: Option<(String, String)> = tx
                .query_row(
                    "SELECT execution_mode, status
                     FROM agent_org_runtime_tasks
                     WHERE org_run_id=?1 AND id=?2 AND owner=?3",
                    params![run_id, task_id, owner_member_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some((execution_mode, status)) = row else {
                return Err(format!(
                    "TaskExecution wake target {task_id} is missing or no longer owned by {owner_member_id}"
                ));
            };
            if !matches!(status.as_str(), "pending" | "in_progress") {
                return Err(format!(
                    "TaskExecution wake target {task_id} is no longer open ({status})"
                ));
            }
            Some(match TaskExecutionMode::from_wire(&execution_mode)? {
                TaskExecutionMode::Build => crate::session::AgentExecMode::Build,
                TaskExecutionMode::Plan => crate::session::AgentExecMode::Plan,
            })
        }
        AgentOrgTurnKind::UserDirectedWork => None,
    };
    tx.commit().map_err(|error| error.to_string())?;
    Ok(resolved)
}
