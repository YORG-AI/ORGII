//! Durable Agent Org wake claiming and control-row mode resolution.
//!
//! A background wake is enqueued from a snapshot, so both halves here re-read
//! durable state at the moment it matters: the session row is claimed
//! atomically when the scheduler actually starts the turn, and the turn's exec
//! mode is re-resolved from the bounded inbox batch that same turn will drain.

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
        "WITH run_anchor(root_session_id) AS (
             SELECT root_session_id
             FROM agent_org_runs
             WHERE id=?4 AND status=?5 AND root_session_id IS NOT NULL
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
             CROSS JOIN run_anchor anchor
             WHERE session.session_id=anchor.root_session_id
                OR (session.parent_session_id=anchor.root_session_id
                    AND session.agent_definition_id IS NOT NULL
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
               FROM agent_member_interventions intervention
               WHERE intervention.org_run_id=?4
                 AND intervention.member_id=CASE
                     WHEN agent_sessions.session_id=(SELECT root_session_id FROM run_anchor)
                         THEN ?12
                     ELSE agent_sessions.org_member_id
                 END
                 AND intervention.cleared_at IS NULL
                 AND datetime(intervention.resume_after)>datetime(?13)
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
            &now,
        ],
    )
    .map_err(|error| error.to_string())
}

/// Resolve the execution mode for one background Agent Org wake from unread
/// control envelopes in durable inbox order.
///
/// Every applicable row updates the candidate, so the latest valid control
/// signal wins. TaskAssigned is only a doorbell: its mode is re-read from the
/// current durable task rather than trusted from a possibly stale payload.
/// Direct human turns never call this resolver.
pub(super) fn resolve_agent_org_wake_mode(
    session_id: &str,
    run_id: &str,
) -> Result<Option<crate::session::AgentExecMode>, String> {
    use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
    use crate::coordination::agent_org_tasks::TaskExecutionMode;
    use rusqlite::{params, OptionalExtension, TransactionBehavior};

    let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let member_id: String = tx
        .query_row(
            "SELECT org_member_id FROM agent_sessions
             WHERE session_id=?1 AND org_member_id IS NOT NULL",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Agent Org wake session {session_id} has no canonical member_id"))?;

    let mut stmt = tx
        .prepare(
            "WITH delivery_candidates AS (
                 SELECT id, payload_kind, payload_json, sender_member_id
                 FROM agent_inbox
                 WHERE org_run_id=?1
                   AND recipient_member_id=?2
                   AND read_at IS NULL
                 ORDER BY id ASC
                 LIMIT ?3
             ), delivery_window AS (
                 SELECT id, payload_kind, payload_json, sender_member_id,
                        ROW_NUMBER() OVER (ORDER BY id ASC) AS ordinal,
                        SUM(length(CAST(payload_json AS BLOB))) OVER (
                            ORDER BY id ASC ROWS UNBOUNDED PRECEDING
                        ) AS cumulative_payload_bytes
                 FROM delivery_candidates
             ), control AS (
                 SELECT id, payload_kind, payload_json, sender_member_id
                 FROM delivery_window
                 WHERE (ordinal=1 OR cumulative_payload_bytes<=?4)
                   AND payload_kind IN (
                       'task_assigned',
                       'plan_approval_response',
                       'exec_mode_set_request'
                   )
                   AND json_valid(payload_json)
             )
             SELECT control.payload_kind,
                    control.sender_member_id,
                    assigned.owner,
                    assigned.status,
                    CASE WHEN json_valid(assigned.metadata_json) THEN
                        CASE WHEN json_type(assigned.metadata_json, '$.execution_mode')='text'
                             THEN json_extract(assigned.metadata_json, '$.execution_mode')
                             ELSE 'build' END
                    ELSE 'build' END AS durable_task_mode,
                    approval.source_member_id,
                    approval_task.owner,
                    approval_task.status,
                    CASE WHEN json_type(control.payload_json, '$.accepted') IN ('true','false')
                         THEN json_extract(control.payload_json, '$.accepted')
                         ELSE NULL END,
                    CASE WHEN json_type(control.payload_json, '$.next_mode')='text'
                         THEN json_extract(control.payload_json, '$.next_mode')
                         ELSE NULL END,
                    CASE WHEN json_type(control.payload_json, '$.mode')='text'
                         THEN json_extract(control.payload_json, '$.mode')
                         ELSE NULL END,
                    EXISTS(
                        SELECT 1 FROM agent_org_tasks owned
                        WHERE owned.org_run_id=?1
                          AND owned.owner=?2
                          AND owned.status IN ('pending','in_progress')
                    ) AS has_open_owned_task
             FROM control
             LEFT JOIN agent_org_tasks assigned
               ON control.payload_kind='task_assigned'
              AND json_type(control.payload_json, '$.task_id')='text'
              AND assigned.org_run_id=?1
              AND assigned.id=json_extract(control.payload_json, '$.task_id')
             LEFT JOIN agent_org_plan_approvals approval
               ON control.payload_kind='plan_approval_response'
              AND json_type(control.payload_json, '$.request_id')='text'
              AND approval.org_run_id=?1
              AND approval.request_id=json_extract(control.payload_json, '$.request_id')
             LEFT JOIN agent_org_tasks approval_task
               ON approval_task.org_run_id=?1
              AND approval_task.id=approval.source_task_id
             ORDER BY control.id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![
                run_id,
                &member_id,
                crate::coordination::agent_inbox::MAX_INBOX_DRAIN_ROWS as i64,
                crate::coordination::agent_inbox::MAX_INBOX_DRAIN_PAYLOAD_BYTES as i64,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<bool>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, bool>(11)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let mut resolved = None;
    for row in rows {
        let (
            kind,
            sender_member_id,
            assigned_owner,
            assigned_status,
            durable_task_mode,
            approval_source_member,
            approval_task_owner,
            approval_task_status,
            accepted,
            next_mode,
            requested_mode,
            has_open_owned_task,
        ) = row.map_err(|error| error.to_string())?;
        let mode = match kind.as_str() {
            "task_assigned"
                if assigned_owner.as_deref() == Some(member_id.as_str())
                    && matches!(assigned_status.as_deref(), Some("pending" | "in_progress")) =>
            {
                durable_task_mode
                    .as_deref()
                    .and_then(|mode| TaskExecutionMode::from_wire(mode).ok())
                    .map(|mode| match mode {
                        TaskExecutionMode::Build => crate::session::AgentExecMode::Build,
                        TaskExecutionMode::Plan => crate::session::AgentExecMode::Plan,
                    })
            }
            "plan_approval_response"
                if sender_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID)
                    && approval_source_member.as_deref() == Some(member_id.as_str())
                    && approval_task_owner.as_deref() == Some(member_id.as_str())
                    && matches!(
                        approval_task_status.as_deref(),
                        Some("pending" | "in_progress")
                    ) =>
            {
                next_mode
                    .as_deref()
                    .and_then(crate::session::AgentExecMode::parse)
                    .or_else(|| {
                        accepted.map(|accepted| {
                            if accepted {
                                crate::session::AgentExecMode::Build
                            } else {
                                crate::session::AgentExecMode::Plan
                            }
                        })
                    })
            }
            "exec_mode_set_request"
                if sender_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID)
                    && has_open_owned_task =>
            {
                requested_mode
                    .as_deref()
                    .and_then(crate::session::AgentExecMode::parse)
            }
            _ => None,
        };
        if mode.is_some() {
            resolved = mode;
            break;
        }
    }
    drop(stmt);
    tx.commit().map_err(|error| error.to_string())?;
    Ok(resolved)
}
