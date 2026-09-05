//! Durable, single-owner authority for TaskExecution admission and release.

use rusqlite::{params, OptionalExtension};

use super::*;
use crate::coordination::agent_org_turn_contexts::{AgentOrgTurnContext, AgentOrgTurnKind};

pub(crate) fn claim_task_execution_in_tx(
    conn: &Connection,
    context: &AgentOrgTurnContext,
    source: &TaskExecutionAuthoritySource,
) -> Result<(), AgentOrgTurnFailure> {
    if context.turn_kind != AgentOrgTurnKind::TaskExecution {
        return Ok(());
    }
    let task_id = context.task_id.as_deref().ok_or_else(|| {
        AgentOrgTurnFailure::new(
            AgentOrgTurnFailureKind::CorruptState,
            "task_execution_context_missing_task",
            "TaskExecution context has no Task identity",
        )
    })?;
    let owner_member_id = context.owner_member_id.as_deref().ok_or_else(|| {
        AgentOrgTurnFailure::new(
            AgentOrgTurnFailureKind::CorruptState,
            "task_execution_context_missing_owner",
            "TaskExecution context has no owner identity",
        )
    })?;
    let generation = context.activation_generation.ok_or_else(|| {
        AgentOrgTurnFailure::new(
            AgentOrgTurnFailureKind::StaleGeneration,
            "task_execution_generation_missing",
            "TaskExecution context has no activation generation",
        )
    })?;
    let episode_id: String = conn
        .query_row(
            "SELECT work_episode_id FROM agent_org_runtime_work_episode_tasks
             WHERE org_run_id=?1 AND task_id=?2",
            params![&context.org_run_id, task_id],
            |row| row.get(0),
        )
        .map_err(|error| {
            AgentOrgTurnFailure::new(
                AgentOrgTurnFailureKind::CorruptState,
                "task_execution_episode_missing",
                error.to_string(),
            )
        })?;

    if let Some((lease_id, session_id, turn_intent_id, base_status)) = conn
        .query_row(
            "SELECT lease.lease_id,lease.session_id,lease.turn_intent_id,
                    COALESCE(intent.status,'missing')
             FROM agent_org_task_execution_leases lease
             LEFT JOIN session_turn_intents intent
               ON intent.session_id=lease.session_id
              AND intent.turn_intent_id=lease.turn_intent_id
             WHERE lease.org_run_id=?1 AND lease.work_episode_id=?2
               AND lease.task_id=?3 AND lease.activation_generation=?4
               AND lease.state='active'",
            params![&context.org_run_id, &episode_id, task_id, generation],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            AgentOrgTurnFailure::from_storage_error("task_execution_lease_read_failed", error)
        })?
    {
        if session_id == context.session_id && turn_intent_id == context.turn_intent_id {
            return Ok(());
        }
        if matches!(
            base_status.as_str(),
            "completed" | "failed" | "cancelled" | "stale" | "coalesced" | "rejected"
        ) {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE agent_org_task_execution_leases
                 SET state='released',terminal_reason_code='terminal_intent_reconciled',terminal_at=?2
                 WHERE lease_id=?1 AND state='active'",
                params![lease_id, now],
            )
            .map_err(|error| {
                AgentOrgTurnFailure::from_storage_error(
                    "task_execution_lease_reconcile_failed",
                    error,
                )
            })?;
        } else {
            return Err(AgentOrgTurnFailure::new(
                AgentOrgTurnFailureKind::AuthorityConflict,
                TASK_EXECUTION_ALREADY_ACTIVE,
                format!(
                    "Task {task_id} already has live execution Turn {turn_intent_id} in Session {session_id}"
                ),
            ));
        }
    }

    let prior: Option<(String, i64)> = conn
        .query_row(
            "SELECT lease_id,execution_epoch
             FROM agent_org_task_execution_leases
             WHERE org_run_id=?1 AND work_episode_id=?2 AND task_id=?3
             ORDER BY execution_epoch DESC LIMIT 1",
            params![&context.org_run_id, &episode_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| {
            AgentOrgTurnFailure::from_storage_error("task_execution_epoch_read_failed", error)
        })?;
    let execution_epoch = prior
        .as_ref()
        .map(|(_, epoch)| {
            epoch.checked_add(1).ok_or_else(|| {
                AgentOrgTurnFailure::new(
                    AgentOrgTurnFailureKind::CorruptState,
                    "task_execution_epoch_overflow",
                    format!("Task {task_id} execution epoch overflowed"),
                )
            })
        })
        .transpose()?
        .unwrap_or(1);
    let lease_id = format!("task-execution-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_task_execution_leases (
            lease_id,org_run_id,work_episode_id,task_id,activation_generation,
            execution_epoch,owner_member_id,session_id,turn_intent_id,source_kind,
            continuation_receipt_id,source_inbox_id,prior_lease_id,state,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'active',?14)",
        params![
            lease_id,
            &context.org_run_id,
            episode_id,
            task_id,
            generation,
            execution_epoch,
            owner_member_id,
            &context.session_id,
            &context.turn_intent_id,
            source.kind.as_str(),
            &source.receipt_id,
            source.source_inbox_id,
            prior.as_ref().map(|(lease_id, _)| lease_id.as_str()),
            now,
        ],
    )
    .map_err(|error| {
        let unique_conflict = matches!(
            &error,
            rusqlite::Error::SqliteFailure(code, _)
                if matches!(
                    code.extended_code,
                    rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                        | rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                )
        );
        if unique_conflict {
            AgentOrgTurnFailure::new(
                AgentOrgTurnFailureKind::AuthorityConflict,
                TASK_EXECUTION_ALREADY_ACTIVE,
                error.to_string(),
            )
        } else {
            AgentOrgTurnFailure::from_storage_error("task_execution_lease_write_failed", error)
        }
    })?;
    Ok(())
}

pub(crate) fn release_turn_lease_in_tx(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
    state: &str,
    reason_code: &str,
) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_org_task_execution_leases
         SET state=?3,terminal_reason_code=?4,terminal_at=?5
         WHERE session_id=?1 AND turn_intent_id=?2 AND state='active'",
        params![session_id, turn_intent_id, state, reason_code, now],
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn release_task_leases_in_tx(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    state: &str,
    reason_code: &str,
) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_org_task_execution_leases
         SET state=?3,terminal_reason_code=?4,terminal_at=?5
         WHERE org_run_id=?1 AND task_id=?2 AND state='active'",
        params![org_run_id, task_id, state, reason_code, now],
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn freeze_run_generation_leases_in_tx(
    conn: &Connection,
    org_run_id: &str,
    activation_generation: i64,
    reason_code: &str,
) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_org_task_execution_leases
         SET state='frozen',terminal_reason_code=?3,terminal_at=?4
         WHERE org_run_id=?1 AND activation_generation=?2 AND state='active'",
        params![org_run_id, activation_generation, reason_code, now],
    )
    .map_err(|error| error.to_string())
}
