//! Recovery-attempt budget: durable per-`(run, action, target)` rewake and
//! coordinator-notice backoff, plus the fingerprint helpers that key it.
//!
//! [`super`] consumes this to decide when a repeated recovery action must
//! back off instead of firing on every watchdog tick.

use super::*;

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_recovery_attempts (
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
        CREATE INDEX IF NOT EXISTS idx_agent_org_recovery_attempts_run
            ON agent_org_recovery_attempts(org_run_id);",
    )?;
    // Existing databases predate dispatch reservations. Keeping the token in
    // the same row lets a failed/coalesced scheduler request refund only its
    // own provisional attempt without undoing a newer recovery fingerprint.
    ensure_recovery_attempt_column(conn, "reservation_token", "TEXT")?;
    Ok(())
}

fn ensure_recovery_attempt_column(
    conn: &Connection,
    column_name: &str,
    column_definition: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(agent_org_recovery_attempts)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == column_name {
            return Ok(());
        }
    }
    conn.execute(
        &format!(
            "ALTER TABLE agent_org_recovery_attempts ADD COLUMN {column_name} {column_definition}"
        ),
        [],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BudgetDisposition {
    Allowed,
    Backoff,
    Exhausted,
}

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
             FROM agent_org_recovery_attempts
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
            "SELECT reason_fingerprint, attempts FROM agent_org_recovery_attempts
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
        "INSERT INTO agent_org_recovery_attempts
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
            "DELETE FROM agent_org_recovery_attempts
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

#[cfg(test)]
pub fn test_only_mark_failed_rewake_attempt(run_id: &str, member_id: &str) -> Result<bool, String> {
    let fingerprint = member_rewake_fingerprint(run_id, member_id, SessionStatus::Failed)?;
    if !delayed_rewake_allowed(run_id, member_id, SessionStatus::Failed, &fingerprint)? {
        return Ok(false);
    }
    record_attempt(run_id, MEMBER_REWAKE, member_id, &fingerprint)?;
    Ok(true)
}

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

fn member_rewake_fingerprint_from_unread(
    status: SessionStatus,
    unread_fingerprint: Option<&str>,
) -> String {
    unread_fingerprint
        .map(|unread| format!("unread:{unread}"))
        .unwrap_or_else(|| format!("status:{}", status.as_str()))
}

/// Drop budget entries whose run is no longer running so the
/// process-global maps cannot grow unbounded over the app lifetime
/// (issue #272 E6). Paused runs also lose their entries; resuming one
/// intentionally grants a fresh set of recovery attempts.
pub(super) fn prune_recovery_budgets() -> Result<(), String> {
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_org_recovery_attempts
             WHERE NOT EXISTS (
                 SELECT 1 FROM agent_org_runs run
                 WHERE run.id = agent_org_recovery_attempts.org_run_id
                   AND run.status = ?1
             )",
            params![AgentOrgRunStatus::Running.as_str()],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    })
}
