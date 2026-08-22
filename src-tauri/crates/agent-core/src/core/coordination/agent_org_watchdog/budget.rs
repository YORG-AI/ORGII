//! Recovery-attempt budget: durable per-`(run, action, target)` rewake and
//! coordinator-notice backoff, plus the fingerprint helpers that key it.
//!
//! [`super`] consumes this to decide when a repeated recovery action must
//! back off instead of firing on every watchdog tick.

use super::*;

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    create_schema(conn)
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_recovery_attempts (
            org_run_id TEXT NOT NULL,
            action_kind TEXT NOT NULL,
            target_key TEXT NOT NULL,
            reason_fingerprint TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_allowed_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            reservation_token TEXT,
            PRIMARY KEY (org_run_id, action_kind, target_key)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_recovery_attempts_run
            ON agent_org_runtime_recovery_attempts(org_run_id);",
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BudgetDisposition {
    Allowed,
    Backoff,
    Exhausted,
}

#[cfg(test)]
pub(super) fn budget_disposition(
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<BudgetDisposition, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    budget_disposition_with_connection(&conn, run_id, action_kind, target_key, fingerprint)
}

pub(super) fn budget_disposition_with_connection(
    conn: &Connection,
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<BudgetDisposition, String> {
    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT reason_fingerprint, attempts, next_allowed_at
             FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
            params![run_id, action_kind, target_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((stored_fingerprint, attempts, next_allowed_at)) = row else {
        return Ok(BudgetDisposition::Allowed);
    };
    if stored_fingerprint != fingerprint {
        return Ok(BudgetDisposition::Allowed);
    }
    let next_allowed_at = match DateTime::parse_from_rfc3339(&next_allowed_at) {
        Ok(parsed) => parsed.with_timezone(&Utc),
        Err(err) => {
            // A corrupt persisted deadline must not suppress recovery forever.
            // Fail open for this tick; an accepted action rewrites the row with
            // a valid UTC timestamp through `record_attempt`.
            tracing::warn!(
                run_id,
                action_kind,
                target_key,
                value = %next_allowed_at,
                error = %err,
                "[agent_org_watchdog] invalid recovery deadline; allowing retry"
            );
            return Ok(BudgetDisposition::Allowed);
        }
    };
    if Utc::now() < next_allowed_at {
        // Every accepted attempt owns its full 1/5/15 minute cooling-off
        // window.  In particular, the third attempt is not "exhausted"
        // immediately after dispatch; it becomes exhausted only after its
        // 15-minute deadline passes without recovery.
        return Ok(BudgetDisposition::Backoff);
    }
    Ok(if attempts >= RECOVERY_DELAYS_SECS.len() as i64 {
        BudgetDisposition::Exhausted
    } else {
        BudgetDisposition::Allowed
    })
}

#[cfg(test)]
pub(super) fn record_attempt(
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<(), String> {
    with_sessions_writer(|| -> Result<(), String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        record_attempt_with_connection(&tx, run_id, action_kind, target_key, fingerprint)?;
        tx.commit().map_err(|err| err.to_string())
    })
}

/// Record an accepted recovery dispatch using the caller's transaction.
/// Member-Wake reservations use this before handing work to the in-memory
/// scheduler, then commit or refund the provisional attempt by token.
pub(super) fn record_attempt_with_connection(
    conn: &Connection,
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let previous: Option<(String, i64)> = conn
        .query_row(
            "SELECT reason_fingerprint, attempts FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
            params![run_id, action_kind, target_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let attempts = match previous {
        Some((stored, attempts)) if stored == fingerprint => attempts
            .clamp(0, RECOVERY_DELAYS_SECS.len() as i64)
            .saturating_add(1),
        _ => 1,
    };
    let delay_index =
        (attempts.saturating_sub(1) as usize).min(RECOVERY_DELAYS_SECS.len().saturating_sub(1));
    let now = Utc::now();
    let next = now + ChronoDuration::seconds(RECOVERY_DELAYS_SECS[delay_index]);
    conn.execute(
        "INSERT INTO agent_org_runtime_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(org_run_id, action_kind, target_key) DO UPDATE SET
             reason_fingerprint=excluded.reason_fingerprint,
             attempts=excluded.attempts,
             next_allowed_at=excluded.next_allowed_at,
             updated_at=excluded.updated_at,
             reservation_token=NULL",
        params![
            run_id,
            action_kind,
            target_key,
            fingerprint,
            attempts,
            next.to_rfc3339(),
            now.to_rfc3339()
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn clear_rewake_budget(run_id: &str, member_id: &str) -> Result<(), String> {
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
            params![run_id, MEMBER_REWAKE, member_id],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    })
}

#[derive(Debug, Clone)]
pub(super) struct RecoveryAttemptSnapshot {
    pub(super) reason_fingerprint: String,
    pub(super) attempts: i64,
    pub(super) next_allowed_at: String,
    pub(super) updated_at: String,
    pub(super) reservation_token: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskRecoveryReservation {
    pub(crate) token: String,
    pub(crate) generation: i64,
    pub(crate) exhausted: bool,
}

pub(crate) fn task_failure_recovery_attempts_exhausted(attempts: i64) -> bool {
    attempts > RECOVERY_DELAYS_SECS.len() as i64
}

const TASK_FAILURE_RECOVERY: &str = "task_failure_recovery";
const TASK_FAILURE_RECOVERY_EVENT: &str = "task_failure_recovery_event";

pub(crate) fn task_failure_recovery_fingerprint(
    task_id: &str,
    failed_turn_intent_id: &str,
    activation_generation: i64,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(task_id.as_bytes());
    hasher.update(&[0]);
    hasher.update(failed_turn_intent_id.as_bytes());
    hasher.update(&[0]);
    hasher.update(&activation_generation.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

pub(crate) fn task_failure_recovery_already_processed_with_connection(
    conn: &Connection,
    run_id: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3
         )",
        params![run_id, TASK_FAILURE_RECOVERY_EVENT, fingerprint],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Reserve one automatic recovery for an exact failed TaskExecution.
///
/// The caller owns the Task mutation transaction. The failure-event receipt,
/// per-Task budget increment, Task mutation, and final reservation release
/// therefore commit or roll back together.
pub(crate) fn reserve_task_failure_recovery_with_connection(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
    fingerprint: &str,
    activation_generation: i64,
) -> Result<TaskRecoveryReservation, String> {
    let current_generation: i64 = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_runs
             WHERE id=?1 AND status='running'",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("agent_org_run_not_mutable: {run_id}"))?;
    if current_generation != activation_generation {
        return Err("task_actor_generation_mismatch".to_string());
    }

    let now = Utc::now().to_rfc3339();
    let inserted = conn
        .execute(
            "INSERT INTO agent_org_runtime_recovery_attempts(
                org_run_id,action_kind,target_key,reason_fingerprint,attempts,
                next_allowed_at,updated_at,reservation_token
             ) VALUES (?1,?2,?3,?3,1,?4,?4,NULL)
             ON CONFLICT(org_run_id,action_kind,target_key) DO NOTHING",
            params![run_id, TASK_FAILURE_RECOVERY_EVENT, fingerprint, &now],
        )
        .map_err(|error| error.to_string())?;
    if inserted != 1 {
        return Err("task_failure_recovery_event_already_processed".to_string());
    }

    let previous_attempts: i64 = conn
        .query_row(
            "SELECT attempts FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
            params![run_id, TASK_FAILURE_RECOVERY, task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0)
        .max(0);
    let attempts = previous_attempts.saturating_add(1);
    let exhausted = task_failure_recovery_attempts_exhausted(attempts);
    let token = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO agent_org_runtime_recovery_attempts(
            org_run_id,action_kind,target_key,reason_fingerprint,attempts,
            next_allowed_at,updated_at,reservation_token
         ) VALUES (?1,?2,?3,?4,?5,?6,?6,?7)
         ON CONFLICT(org_run_id,action_kind,target_key) DO UPDATE SET
            reason_fingerprint=excluded.reason_fingerprint,
            attempts=excluded.attempts,
            next_allowed_at=excluded.next_allowed_at,
            updated_at=excluded.updated_at,
            reservation_token=excluded.reservation_token",
        params![
            run_id,
            TASK_FAILURE_RECOVERY,
            task_id,
            fingerprint,
            attempts,
            &now,
            &token,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(TaskRecoveryReservation {
        token,
        generation: activation_generation,
        exhausted,
    })
}

pub(crate) fn reserve_task_shutdown_release(
    run_id: &str,
    owner_member_id: &str,
) -> Result<TaskRecoveryReservation, String> {
    reserve_task_system_operation(run_id, "task_shutdown_release", owner_member_id, false)
}

fn reserve_task_system_operation(
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    budgeted: bool,
) -> Result<TaskRecoveryReservation, String> {
    with_sessions_writer(|| -> Result<TaskRecoveryReservation, String> {
        let mut conn = get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let generation: i64 = tx
            .query_row(
                "SELECT activation_generation FROM agent_org_runtime_runs
                 WHERE id=?1 AND status='running'",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("agent_org_run_not_mutable: {run_id}"))?;
        let previous_attempts: i64 = tx
            .query_row(
                "SELECT attempts FROM agent_org_runtime_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
                params![run_id, action_kind, target_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(0)
            .max(0);
        let attempts = if budgeted {
            previous_attempts.saturating_add(1)
        } else {
            1
        };
        let exhausted = budgeted && task_failure_recovery_attempts_exhausted(attempts);
        let token = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO agent_org_runtime_recovery_attempts(
                org_run_id,action_kind,target_key,reason_fingerprint,attempts,
                next_allowed_at,updated_at,reservation_token
             ) VALUES (?1,?2,?3,?4,?5,?6,?6,?7)
             ON CONFLICT(org_run_id,action_kind,target_key) DO UPDATE SET
                reason_fingerprint=excluded.reason_fingerprint,
                attempts=excluded.attempts,
                next_allowed_at=excluded.next_allowed_at,
                updated_at=excluded.updated_at,
                reservation_token=excluded.reservation_token",
            params![
                run_id,
                action_kind,
                target_key,
                format!("generation:{generation}"),
                attempts,
                &now,
                &token,
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(TaskRecoveryReservation {
            token,
            generation,
            exhausted,
        })
    })
}

#[cfg(test)]
pub fn test_only_mark_failed_rewake_attempt(run_id: &str, member_id: &str) -> Result<bool, String> {
    let fingerprint = member_rewake_fingerprint(run_id, member_id, SessionStatus::Failed)?;
    if !delayed_rewake_allowed(run_id, member_id, SessionStatus::Failed, &fingerprint)? {
        return Ok(false);
    }
    record_attempt(run_id, MEMBER_REWAKE, member_id, &fingerprint)?;
    Ok(true)
}

#[cfg(test)]
pub(super) fn delayed_rewake_allowed(
    run_id: &str,
    member_id: &str,
    _status: SessionStatus,
    fingerprint: &str,
) -> Result<bool, String> {
    Ok(matches!(
        budget_disposition(run_id, MEMBER_REWAKE, member_id, fingerprint)?,
        BudgetDisposition::Allowed
    ))
}

/// Non-mutating budget probe: `true` once every rewake attempt for the
/// `(run, member)` pair has been consumed. Distinct from "currently in a
/// backoff window": an exhausted budget never recovers without a
/// successful member turn (which clears it), so it marks the member as
/// beyond autonomous recovery.
#[cfg(test)]
pub(super) fn rewake_budget_exhausted(
    run_id: &str,
    member_id: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    Ok(matches!(
        budget_disposition(run_id, MEMBER_REWAKE, member_id, fingerprint)?,
        BudgetDisposition::Exhausted
    ))
}

#[cfg(test)]
pub(super) fn reason_fingerprint(reason: &str) -> String {
    blake3::hash(reason.as_bytes()).to_hex().to_string()
}

/// Coordinator stall notices for an *unchanged* repair reason back off
/// (1/5/15 min) and stop after [`RECOVERY_DELAYS_SECS`] attempts, so a
/// coordinator that cannot (or will not) repair does not get an
/// unbounded LLM-turn loop every watchdog tick (issue #272 E5). Any
/// change to the reason payload — which every actual repair produces,
/// since it mutates task state — resets the budget.
#[cfg(test)]
pub(super) fn coordinator_notice_allowed(run_id: &str, reason: &str) -> Result<bool, String> {
    let fingerprint = reason_fingerprint(reason);
    if !coordinator_notice_budget_allows(run_id, &fingerprint)? {
        return Ok(false);
    }
    record_attempt(run_id, COORDINATOR_NOTICE, "coordinator", &fingerprint)?;
    Ok(true)
}

#[cfg(test)]
pub(super) fn coordinator_notice_budget_allows(
    run_id: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    Ok(matches!(
        budget_disposition(run_id, COORDINATOR_NOTICE, "coordinator", fingerprint)?,
        BudgetDisposition::Allowed
    ))
}

pub(crate) fn member_rewake_fingerprint(
    run_id: &str,
    member_id: &str,
    status: SessionStatus,
) -> Result<String, String> {
    Ok(member_rewake_fingerprint_from_unread(
        status,
        AgentInboxStore::unread_fingerprint_for_member(member_id, run_id)?.as_deref(),
    ))
}

pub(super) fn member_rewake_fingerprint_from_unread(
    status: SessionStatus,
    unread_fingerprint: Option<&str>,
) -> String {
    unread_fingerprint
        .map(|unread| format!("unread:{unread}"))
        .unwrap_or_else(|| format!("status:{}", status.as_str()))
}
