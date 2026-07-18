//! Agent Org watchdog: periodic stall detection and recovery.
//!
//! Every [`WATCHDOG_INTERVAL_SECS`] the watchdog scans running Agent Org
//! runs whose workers are all quiescent and produces a
//! [`StallRecoveryPlan`]:
//!
//! - **Wake members** that have durable input: unread inbox rows, a
//!   redelivered explicit assignment, or a concrete continuation message.
//!   Ownerless work and mere ownership are not wake signals: without real
//!   input they would create empty turns and UI flicker.
//! - **Escalate to the coordinator** when the board cannot make progress
//!   without explicit repair: tasks owned by dead members, stale
//!   `in_progress` work, and ready ownerless tasks awaiting explicit
//!   coordinator assignment (issue #272 E1).
//! - **Reconcile the run** when every task is resolved and every worker
//!   is terminal.
//!
//! Failed members are rate-limited by a per-`(run, member)` rewake budget
//! (three attempts with 1/5/15-minute backoff) that resets on the next
//! successful member turn.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::AppHandle;

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore;
use crate::coordination::agent_org_runs::{
    recovery_dispatch_recipient_is_available, AgentOrgFinalityBlocker, AgentOrgFinalityDecision,
    AgentOrgRunRecord, AgentOrgRunStatus, AgentOrgRunStore, WorkerSessionRuntime,
    COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{self, Task, TaskStatus};
use crate::core::session::SessionStatus;
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;

const WATCHDOG_INTERVAL_SECS: u64 = 60;
const RECOVERY_DELAYS_SECS: [i64; 3] = [60, 5 * 60, 15 * 60];
const PENDING_MATERIALIZATION_GRACE_SECS: i64 = 2 * 60;
const MEMBER_REWAKE: &str = "member_rewake";
const COORDINATOR_NOTICE: &str = "coordinator_notice";

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
enum BudgetDisposition {
    Allowed,
    Backoff,
    Exhausted,
}

#[cfg(test)]
fn budget_disposition(
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<BudgetDisposition, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    budget_disposition_with_connection(&conn, run_id, action_kind, target_key, fingerprint)
}

fn budget_disposition_with_connection(
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

#[cfg(test)]
fn record_attempt(
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
/// Coordinator notice execution uses this together with its final state
/// checks and Inbox insert so two concurrent scans cannot both pass the
/// budget gate or lose the attempt in a crash window.
fn record_attempt_with_connection(
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
struct RecoveryAttemptSnapshot {
    reason_fingerprint: String,
    attempts: i64,
    next_allowed_at: String,
    updated_at: String,
    reservation_token: Option<String>,
}

/// Provisional durable claim for one scheduler dispatch.
///
/// SQLite and the in-memory scheduler cannot share a transaction. Reserving
/// first closes the unsafe side of that gap: a crash can conservatively spend
/// one cooldown, but it cannot enqueue a provider turn that was never charged
/// to the recovery budget. Failed/coalesced requests refund by this unique
/// token, so they cannot roll back a newer fingerprint's reservation.
pub(crate) struct MemberRewakeReservation {
    run_id: String,
    member_id: String,
    token: String,
    previous: Option<RecoveryAttemptSnapshot>,
}

pub(crate) enum MemberRewakeReservationOutcome {
    Reserved(MemberRewakeReservation),
    Deferred,
}

pub(crate) fn reserve_member_rewake_dispatch(
    run_id: &str,
    member_id: &str,
    fingerprint: &str,
) -> Result<MemberRewakeReservationOutcome, String> {
    with_sessions_writer(|| -> Result<MemberRewakeReservationOutcome, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        if !matches!(
            budget_disposition_with_connection(&tx, run_id, MEMBER_REWAKE, member_id, fingerprint,)?,
            BudgetDisposition::Allowed
        ) {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(MemberRewakeReservationOutcome::Deferred);
        }

        let previous = tx
            .query_row(
                "SELECT reason_fingerprint, attempts, next_allowed_at, updated_at,
                        reservation_token
                 FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
                params![run_id, MEMBER_REWAKE, member_id],
                |row| {
                    Ok(RecoveryAttemptSnapshot {
                        reason_fingerprint: row.get(0)?,
                        attempts: row.get(1)?,
                        next_allowed_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        reservation_token: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())?;
        record_attempt_with_connection(&tx, run_id, MEMBER_REWAKE, member_id, fingerprint)?;
        let token = uuid::Uuid::new_v4().to_string();
        let updated = tx
            .execute(
                "UPDATE agent_org_recovery_attempts
                 SET reservation_token=?1
                 WHERE org_run_id=?2 AND action_kind=?3 AND target_key=?4
                   AND reason_fingerprint=?5",
                params![&token, run_id, MEMBER_REWAKE, member_id, fingerprint],
            )
            .map_err(|err| err.to_string())?;
        if updated != 1 {
            return Err("member rewake reservation disappeared before commit".to_string());
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(MemberRewakeReservationOutcome::Reserved(
            MemberRewakeReservation {
                run_id: run_id.to_string(),
                member_id: member_id.to_string(),
                token,
                previous,
            },
        ))
    })
}

pub(crate) fn commit_member_rewake_reservation(
    reservation: &MemberRewakeReservation,
) -> Result<(), String> {
    with_sessions_writer(|| -> Result<(), String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE agent_org_recovery_attempts
             SET reservation_token=NULL
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3
               AND reservation_token=?4",
            params![
                &reservation.run_id,
                MEMBER_REWAKE,
                &reservation.member_id,
                &reservation.token,
            ],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    })
}

pub(crate) fn refund_member_rewake_reservation(
    reservation: &MemberRewakeReservation,
) -> Result<bool, String> {
    with_sessions_writer(|| -> Result<bool, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let owns_current: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_recovery_attempts
                     WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3
                       AND reservation_token=?4
                 )",
                params![
                    &reservation.run_id,
                    MEMBER_REWAKE,
                    &reservation.member_id,
                    &reservation.token,
                ],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if !owns_current {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        }

        if let Some(previous) = reservation.previous.as_ref() {
            tx.execute(
                "UPDATE agent_org_recovery_attempts
                 SET reason_fingerprint=?1, attempts=?2, next_allowed_at=?3,
                     updated_at=?4, reservation_token=?5
                 WHERE org_run_id=?6 AND action_kind=?7 AND target_key=?8
                   AND reservation_token=?9",
                params![
                    &previous.reason_fingerprint,
                    previous.attempts,
                    &previous.next_allowed_at,
                    &previous.updated_at,
                    previous.reservation_token.as_deref(),
                    &reservation.run_id,
                    MEMBER_REWAKE,
                    &reservation.member_id,
                    &reservation.token,
                ],
            )
            .map_err(|err| err.to_string())?;
        } else {
            tx.execute(
                "DELETE FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3
                   AND reservation_token=?4",
                params![
                    &reservation.run_id,
                    MEMBER_REWAKE,
                    &reservation.member_id,
                    &reservation.token,
                ],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(true)
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
fn delayed_rewake_allowed(
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

/// Final, non-mutating recovery-budget gate used by every production wake
/// dispatcher. The watchdog also checks this while planning, but a wake may be
/// requested by inbox delivery, resume, or lifecycle hooks after that snapshot
/// was taken. Rechecking immediately before enqueue keeps all sources on the
/// same durable 1/5/15-minute budget.
#[cfg(test)]
pub(crate) fn member_rewake_dispatch_allowed(
    run_id: &str,
    member_id: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    delayed_rewake_allowed(run_id, member_id, SessionStatus::Idle, fingerprint)
}

/// Non-mutating budget probe: `true` once every rewake attempt for the
/// `(run, member)` pair has been consumed. Distinct from "currently in a
/// backoff window": an exhausted budget never recovers without a
/// successful member turn (which clears it), so it marks the member as
/// beyond autonomous recovery.
#[cfg(test)]
fn rewake_budget_exhausted(
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
fn reason_fingerprint(reason: &str) -> String {
    blake3::hash(reason.as_bytes()).to_hex().to_string()
}

/// A machine-stable recovery fact. Human-readable repair prose is deliberately
/// excluded: copy edits must not reset retry budgets, while a change in any
/// typed field must. Fields are Option-aware and length-prefixed so ids that
/// contain `:`, `|`, or `,` cannot cross field or set boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveryRepairFact {
    kind: &'static str,
    fields: Vec<Option<String>>,
}

impl RecoveryRepairFact {
    fn new(kind: &'static str, fields: impl IntoIterator<Item = Option<String>>) -> Self {
        Self {
            kind,
            fields: fields.into_iter().collect(),
        }
    }

    fn marker(kind: &'static str) -> Self {
        Self::new(kind, std::iter::empty())
    }

    fn digest(&self) -> String {
        fn write_bytes(hasher: &mut blake3::Hasher, bytes: &[u8]) {
            hasher.update(&(bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }

        let mut hasher = blake3::Hasher::new();
        write_bytes(&mut hasher, b"agent-org-recovery-fact-v1");
        write_bytes(&mut hasher, self.kind.as_bytes());
        hasher.update(&(self.fields.len() as u64).to_le_bytes());
        for field in &self.fields {
            match field {
                Some(value) => {
                    hasher.update(&[1]);
                    write_bytes(&mut hasher, value.as_bytes());
                }
                None => {
                    hasher.update(&[0]);
                }
            }
        }
        hasher.finalize().to_hex().to_string()
    }
}

fn recovery_repair_fingerprint(facts: &[RecoveryRepairFact]) -> Option<String> {
    if facts.is_empty() {
        return None;
    }
    let mut digests = facts
        .iter()
        .map(RecoveryRepairFact::digest)
        .collect::<Vec<_>>();
    digests.sort();
    digests.dedup();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"agent-org-recovery-set-v1");
    hasher.update(&(digests.len() as u64).to_le_bytes());
    for digest in digests {
        hasher.update(&(digest.len() as u64).to_le_bytes());
        hasher.update(digest.as_bytes());
    }
    Some(hasher.finalize().to_hex().to_string())
}

/// Stable identities for malformed task rows. Counting alone is insufficient:
/// corrupt row A can disappear while corrupt row B appears in the same tick,
/// and that must reset the coordinator notice budget even when the count is
/// unchanged.
fn corrupt_task_repair_facts(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<RecoveryRepairFact>, String> {
    let task_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_tasks WHERE org_run_id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if task_count > crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS as i64 {
        return Ok(vec![RecoveryRepairFact::new(
            "task_run_limit_exceeded",
            [Some(task_count.to_string())],
        )]);
    }
    let predicate = agent_org_tasks::corrupt_task_row_predicate_sql();
    let dependency_json_max =
        crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES;
    let metadata_max = crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES;
    let sql = format!(
        "SELECT substr(id,1,1024), length(CAST(id AS BLOB)),
                substr(status,1,128),
                length(CAST(blocks_json AS BLOB)), hex(substr(blocks_json,1,1024)),
                length(CAST(blocked_by_json AS BLOB)), hex(substr(blocked_by_json,1,1024)),
                length(CAST(COALESCE(metadata_json,'') AS BLOB)),
                hex(substr(COALESCE(metadata_json,''),1,1024))
         FROM (
             SELECT id, subject, description, active_form, owner, status,
                    created_at, updated_at,
                    CASE WHEN length(CAST(blocks_json AS BLOB))<={dependency_json_max}
                         THEN blocks_json ELSE '!' END AS blocks_json,
                    CASE WHEN length(CAST(blocked_by_json AS BLOB))<={dependency_json_max}
                         THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                    CASE WHEN metadata_json IS NULL
                              OR length(CAST(metadata_json AS BLOB))<={metadata_max}
                         THEN metadata_json ELSE '!' END AS metadata_json
             FROM agent_org_tasks WHERE org_run_id=?1
         ) AS bounded_tasks
         WHERE {predicate}
         ORDER BY id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![run_id], |row| {
            Ok(RecoveryRepairFact::new(
                "corrupt_task_data",
                [
                    Some(row.get::<_, String>(0)?),
                    Some(row.get::<_, i64>(1)?.to_string()),
                    Some(row.get::<_, String>(2)?),
                    Some(row.get::<_, i64>(3)?.to_string()),
                    Some(row.get::<_, String>(4)?),
                    Some(row.get::<_, i64>(5)?.to_string()),
                    Some(row.get::<_, String>(6)?),
                    Some(row.get::<_, i64>(7)?.to_string()),
                    Some(row.get::<_, String>(8)?),
                ],
            ))
        })
        .map_err(|err| err.to_string())?;
    let facts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(facts)
}

/// Coordinator stall notices for an *unchanged* repair reason back off
/// (1/5/15 min) and stop after [`RECOVERY_DELAYS_SECS`] attempts, so a
/// coordinator that cannot (or will not) repair does not get an
/// unbounded LLM-turn loop every watchdog tick (issue #272 E5). Any
/// change to the reason payload — which every actual repair produces,
/// since it mutates task state — resets the budget.
#[cfg(test)]
fn coordinator_notice_allowed(run_id: &str, reason: &str) -> Result<bool, String> {
    let fingerprint = reason_fingerprint(reason);
    if !coordinator_notice_budget_allows(run_id, &fingerprint)? {
        return Ok(false);
    }
    record_attempt(run_id, COORDINATOR_NOTICE, "coordinator", &fingerprint)?;
    Ok(true)
}

#[cfg(test)]
fn coordinator_notice_budget_allows(run_id: &str, fingerprint: &str) -> Result<bool, String> {
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

/// Recovery actions the watchdog decided on for one quiescent run.
///
/// Unlike the previous four-state enum, actions are not mutually
/// exclusive: one tick may redeliver concrete member input AND escalate an
/// unrelated stale or unassigned task to the coordinator.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StallRecoveryPlan {
    /// Idle/terminal members to wake for unread inbox rows (missed
    /// delivery). May include
    /// [`COORDINATOR_MEMBER_ID`] for coordinator missed deliveries.
    pub wake_member_ids: Vec<String>,
    /// Terminal members that still own open work. The executor persists one
    /// concrete continuation message before waking them; ownership alone is
    /// never used as model input.
    pub continuation_actions: Vec<MemberContinuationAction>,
    /// Ready, owned Pending tasks whose original TaskAssigned delivery was
    /// lost. The executor recreates the typed assignment before waking.
    pub assignment_actions: Vec<MemberTaskAssignmentAction>,
    /// Human-readable repair reasons for the coordinator, one per
    /// stalled task. `Some` only when the coordinator has no unread
    /// inbox rows (an unread notice already covers redelivery via
    /// `wake_member_ids`).
    pub coordinator_repair_reason: Option<String>,
    /// Stable hash of typed repair facts (task/reason/member ids), excluding
    /// prose and timestamps so copy edits do not reset the retry budget.
    pub coordinator_repair_fingerprint: Option<String>,
    /// Work revision observed with the task snapshot used to compose the
    /// coordinator repair. The executor compares it again under the shared
    /// writer lock before persisting the notice.
    pub coordinator_repair_work_revision: Option<i64>,
    /// Stable fingerprint of the canonical task state/graph used to compose
    /// the repair. This catches stale analyzer output even when a historical
    /// writer failed to bump `work_revision`.
    pub coordinator_repair_task_fingerprint: Option<String>,
    /// Stable fingerprint of typed unavailable-unread recipient facts used to
    /// compose the repair. The executor recomputes it before inserting a
    /// notice so a concurrently restored session or drained Inbox cannot
    /// produce stale guidance.
    pub coordinator_repair_inbox_fingerprint: Option<String>,
    /// Whether the coherent snapshot still contained any coordinator repair
    /// condition, including one temporarily suppressed by an already-unread
    /// coordinator message. A false value ends the previous fault episode and
    /// clears its notice budget so the same fault can be reported if it later
    /// genuinely recurs.
    pub coordinator_repair_active: bool,
    /// End a previously persisted coordinator fault episode. Set only when
    /// the analyzer sees no current repair *and* a budget row actually exists,
    /// avoiding one no-op writer transaction per healthy run per tick.
    pub clear_coordinator_notice_budget: bool,
    /// Every task resolved + every worker terminal: the run can be
    /// reconciled to a terminal status.
    pub terminal_candidate: bool,
}

impl StallRecoveryPlan {
    pub fn is_noop(&self) -> bool {
        self.wake_member_ids.is_empty()
            && self.continuation_actions.is_empty()
            && self.assignment_actions.is_empty()
            && self.coordinator_repair_reason.is_none()
            && self.coordinator_repair_fingerprint.is_none()
            && self.coordinator_repair_work_revision.is_none()
            && self.coordinator_repair_task_fingerprint.is_none()
            && self.coordinator_repair_inbox_fingerprint.is_none()
            && !self.clear_coordinator_notice_budget
            && !self.terminal_candidate
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberContinuationAction {
    pub member_id: String,
    pub recipient_agent_id: String,
    pub task_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberTaskAssignmentAction {
    pub member_id: String,
    pub recipient_agent_id: String,
    pub task_ids: Vec<String>,
}

fn ready_unassigned_repair_reason(task: &Task) -> String {
    let mut eligible = agent_org_tasks::eligible_member_ids(task);
    eligible.sort();
    if eligible.is_empty() {
        format!(
            "task {} is ready but has no owner and no eligible_member_ids. Repair eligibility, then choose an explicit owner_member_id; workers cannot self-claim it.",
            task.id
        )
    } else {
        format!(
            "task {} is ready but has no owner. Workers cannot self-claim it; choose an explicit owner_member_id from eligible_member_ids [{}].",
            task.id,
            bounded_id_list_preview(&eligible, 8, 160)
        )
    }
}

fn bounded_id_list_preview(ids: &[String], max_items: usize, max_chars_per_id: usize) -> String {
    let preview = ids
        .iter()
        .take(max_items)
        .map(|id| crate::utils::safe_truncate_chars_to_string(id, max_chars_per_id))
        .collect::<Vec<_>>()
        .join(", ");
    let omitted = ids.len().saturating_sub(max_items);
    if omitted > 0 {
        format!("{preview}, +{omitted} more (use task_list/task_get)")
    } else {
        preview
    }
}

/// AgentMessage::Plain is capped at 20k characters. Leave headroom for the
/// fixed notice instructions and bound the combined diagnostics so a damaged
/// large board cannot turn the watchdog into a validation-failure treadmill.
fn bounded_recovery_reason_text(reasons: &[String]) -> String {
    const MAX_REASON_CHARS: usize = 15_000;
    let mut out = String::new();
    let mut used = 0usize;
    let mut included = 0usize;
    for reason in reasons {
        let separator = usize::from(!out.is_empty());
        let remaining = MAX_REASON_CHARS.saturating_sub(used.saturating_add(separator));
        if remaining == 0 {
            break;
        }
        let bounded = crate::utils::safe_truncate_chars_to_string(reason, remaining);
        if !out.is_empty() {
            out.push('\n');
            used += 1;
        }
        used = used.saturating_add(bounded.chars().count());
        out.push_str(&bounded);
        included += 1;
        if bounded.chars().count() < reason.chars().count() {
            break;
        }
    }
    let omitted = reasons.len().saturating_sub(included);
    if omitted > 0 {
        let suffix = format!(
            "\n+{omitted} additional repair item(s); use task_list/task_get for the full board."
        );
        let keep = MAX_REASON_CHARS.saturating_sub(suffix.chars().count());
        out = crate::utils::safe_truncate_chars_to_string(&out, keep);
        out.push_str(&suffix);
    }
    out
}

fn task_snapshot_fingerprint(tasks: &[Task]) -> String {
    fn hash_field(hasher: &mut blake3::Hasher, field_kind: &str, value: &str) {
        hasher.update(&(field_kind.len() as u64).to_le_bytes());
        hasher.update(field_kind.as_bytes());
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }

    fn hash_list(hasher: &mut blake3::Hasher, field_kind: &str, values: &[String]) {
        hasher.update(&(field_kind.len() as u64).to_le_bytes());
        hasher.update(field_kind.as_bytes());
        hasher.update(&(values.len() as u64).to_le_bytes());
        for value in values {
            hash_field(hasher, "item", value);
        }
    }

    let mut hasher = blake3::Hasher::new();
    hasher.update(b"agent-org-task-snapshot-v2");
    let mut ordered_tasks = tasks.iter().collect::<Vec<_>>();
    ordered_tasks.sort_by(|left, right| left.id.cmp(&right.id));
    hasher.update(&(ordered_tasks.len() as u64).to_le_bytes());
    for task in ordered_tasks {
        let mut blocked_by = task.blocked_by.clone();
        blocked_by.sort();
        blocked_by.dedup();
        let mut eligible_member_ids = agent_org_tasks::eligible_member_ids(task);
        eligible_member_ids.sort();
        eligible_member_ids.dedup();
        hash_field(&mut hasher, "task_id", &task.id);
        hash_field(&mut hasher, "status", task.status.as_wire());
        match task.owner.as_deref() {
            Some(owner) => hash_field(&mut hasher, "owner_some", owner),
            None => hash_field(&mut hasher, "owner_none", ""),
        }
        hash_list(&mut hasher, "blocked_by", &blocked_by);
        hash_list(&mut hasher, "eligible_member_ids", &eligible_member_ids);
        hash_field(&mut hasher, "updated_at", &task.updated_at);
    }
    hasher.finalize().to_hex().to_string()
}

/// Diagnose dependency damage that current mutation APIs reject but a
/// historical/manual database may still contain. Recovery never guesses a
/// new graph: it emits one typed coordinator repair and leaves data intact.
fn append_dependency_integrity_repairs(
    tasks: &[Task],
    reasons: &mut Vec<String>,
    facts: &mut Vec<RecoveryRepairFact>,
) {
    let known_ids = tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<HashSet<_>>();
    let mut missing_edges = Vec::<(String, String, String)>::new();
    for task in tasks {
        for blocker_id in &task.blocked_by {
            if !known_ids.contains(blocker_id.as_str()) {
                missing_edges.push((
                    "blocked_by".to_string(),
                    task.id.clone(),
                    blocker_id.clone(),
                ));
            }
        }
        for downstream_id in &task.blocks {
            if !known_ids.contains(downstream_id.as_str()) {
                missing_edges.push(("blocks".to_string(), task.id.clone(), downstream_id.clone()));
            }
        }
    }
    missing_edges.sort();
    missing_edges.dedup();
    if !missing_edges.is_empty() {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"agent-org-missing-dependency-edges-v1");
        for (relation, task_id, missing_id) in &missing_edges {
            for field in [relation, task_id, missing_id] {
                hasher.update(&(field.len() as u64).to_le_bytes());
                hasher.update(field.as_bytes());
            }
        }
        facts.push(RecoveryRepairFact::new(
            "missing_dependency_edges",
            [
                Some(missing_edges.len().to_string()),
                Some(hasher.finalize().to_hex().to_string()),
            ],
        ));
        let preview = missing_edges
            .iter()
            .take(8)
            .map(|(relation, task_id, missing_id)| {
                format!("{task_id}.{relation} -> missing task {missing_id}")
            })
            .collect::<Vec<_>>()
            .join("; ");
        let remainder = missing_edges.len().saturating_sub(8);
        reasons.push(format!(
            "the task graph contains {} dependency reference(s) to task ids that do not exist: {}{}. Repair those persisted edges before continuing; the watchdog will not guess which task was intended.",
            missing_edges.len(),
            preview,
            if remainder > 0 {
                format!("; +{remainder} more (use task_list/task_get)")
            } else {
                String::new()
            }
        ));
    }

    let Some(run_id) = tasks.first().map(|task| task.org_run_id.as_str()) else {
        return;
    };
    if let Err(error) = agent_org_tasks::validate_dependency_graph(tasks, run_id) {
        let mut edges = tasks
            .iter()
            .flat_map(|task| {
                task.blocked_by
                    .iter()
                    .map(move |blocker| (task.id.clone(), blocker.clone()))
            })
            .collect::<Vec<_>>();
        edges.sort();
        edges.dedup();
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"agent-org-dependency-cycle-v1");
        for (task_id, blocker_id) in &edges {
            for field in [task_id, blocker_id] {
                hasher.update(&(field.len() as u64).to_le_bytes());
                hasher.update(field.as_bytes());
            }
        }
        facts.push(RecoveryRepairFact::new(
            "dependency_cycle",
            [Some(hasher.finalize().to_hex().to_string())],
        ));
        reasons.push(format!(
            "the persisted task dependency graph contains a cycle ({}). Break the cycle explicitly before continuing; cyclic tasks can never become ready.",
            crate::utils::safe_truncate_chars_to_string(&error, 2_000)
        ));
    }
}

pub fn spawn(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Plan files are derived artifacts; SQLite approval revisions are the
        // durable source of truth. Heal a process-crash window (DB commit
        // succeeded but the same-directory artifact rename did not) before
        // normal recovery begins. This scan is blocking, paged, and isolated
        // from the async runtime and from subsequent watchdog ticks.
        match tokio::task::spawn_blocking(|| {
            AgentOrgPlanApprovalStore::repair_latest_plan_artifacts()
        })
        .await
        {
            Ok(Ok(report)) => {
                if report.repaired > 0 || report.failed > 0 {
                    tracing::info!(
                        inspected = report.inspected,
                        repaired = report.repaired,
                        failed = report.failed,
                        "[agent_org_watchdog] reconciled durable plan artifacts at startup"
                    );
                }
            }
            Ok(Err(err)) => tracing::warn!(
                error = %err,
                "[agent_org_watchdog] startup plan artifact reconciliation failed"
            ),
            Err(err) => tracing::warn!(
                error = %err,
                "[agent_org_watchdog] startup plan artifact worker failed"
            ),
        }
        let mut interval = tokio::time::interval(Duration::from_secs(WATCHDOG_INTERVAL_SECS));
        // A slow scan must not be "repaid" with back-to-back burst
        // ticks afterwards; the next scheduled tick is enough.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let handle = app_handle.clone();
            match tokio::task::spawn_blocking(move || recover_all_stalled_runs(handle)).await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    tracing::warn!(error = %err, "[agent_org_watchdog] watchdog scan failed")
                }
                Err(err) => {
                    tracing::warn!(error = %err, "[agent_org_watchdog] watchdog task join failed")
                }
            }
        }
    });
}

fn recover_all_stalled_runs(app_handle: AppHandle) -> Result<(), String> {
    let runs = AgentOrgRunStore::list_running_runs(usize::MAX)?;
    run_best_effort_cleanup("prune recovery budgets", prune_recovery_budgets);
    run_best_effort_cleanup("clear expired member interventions", || {
        crate::coordination::agent_member_interventions::AgentMemberInterventionStore::clear_expired_and_legacy()
            .map(|_| ())
    });
    run_best_effort_cleanup("cancel stale plan approvals", || {
        AgentOrgPlanApprovalStore::cancel_pending_for_terminal_or_missing_runs().map(|_| ())
    });
    recover_listed_runs(app_handle, runs, recover_stalled_run)
}

/// Maintenance is useful but must never become a global recovery gate. A
/// corrupt row in one auxiliary table must not prevent healthy runs from being
/// inspected during the same watchdog tick.
fn run_best_effort_cleanup(label: &'static str, cleanup: impl FnOnce() -> Result<(), String>) {
    if let Err(err) = cleanup() {
        tracing::warn!(
            cleanup = label,
            error = %err,
            "[agent_org_watchdog] maintenance failed; continuing run scan"
        );
    }
}

fn recover_listed_runs<H: Clone, T>(
    handle: H,
    runs: Vec<AgentOrgRunRecord>,
    mut recover: impl FnMut(H, &str) -> Result<T, String>,
) -> Result<(), String> {
    let mut failed_run_ids = Vec::new();
    for run in runs {
        if let Err(err) = recover(handle.clone(), &run.id) {
            tracing::warn!(
                run_id = %run.id,
                error = %err,
                "[agent_org_watchdog] recovery failed for one run; continuing scan"
            );
            failed_run_ids.push(run.id);
        }
    }
    if !failed_run_ids.is_empty() {
        return Err(format!(
            "{} Agent Org run(s) failed recovery inspection: {}",
            failed_run_ids.len(),
            failed_run_ids.join(", ")
        ));
    }
    Ok(())
}

/// Drop budget entries whose run is no longer running so the
/// process-global maps cannot grow unbounded over the app lifetime
/// (issue #272 E6). Paused runs also lose their entries; resuming one
/// intentionally grants a fresh set of recovery attempts.
fn prune_recovery_budgets() -> Result<(), String> {
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

pub fn recover_stalled_run(
    app_handle: AppHandle,
    run_id: &str,
) -> Result<StallRecoveryPlan, String> {
    let plan = inspect_stalled_run(run_id)?;
    let wake_hook = AppHandleInboxWakeHook::new(app_handle);
    execute_stall_recovery_plan(run_id, plan, wake_hook.as_ref())
}

/// Execute an advisory analyzer plan through a caller-supplied Wake hook.
/// Keeping orchestration here makes the full reconcile → revalidate → persist
/// → wake ordering directly testable without constructing a Tauri runtime.
fn execute_stall_recovery_plan(
    run_id: &str,
    plan: StallRecoveryPlan,
    wake_hook: &dyn InboxWakeHook,
) -> Result<StallRecoveryPlan, String> {
    // Reconcile first: when the run actually closes there is nothing
    // left to wake or repair. When reconciliation declines (e.g. the
    // coordinator root session is still open), fall through and deliver
    // the wakes so pending inbox rows still reach their recipients.
    if plan.terminal_candidate {
        let reconciled = AgentOrgRunStore::reconcile_run_finality(run_id)?;
        if reconciled.is_some_and(|status| status != AgentOrgRunStatus::Running) {
            return Ok(plan);
        }
    }

    // Analyzer output is advisory. Every derived inbox row is revalidated
    // under the same writer lock + IMMEDIATE transaction as its insert. A
    // task completed, reassigned, or re-blocked after inspection therefore
    // produces neither stale input nor a spurious wake.
    let action_member_ids = plan
        .assignment_actions
        .iter()
        .map(|action| action.member_id.as_str())
        .chain(
            plan.continuation_actions
                .iter()
                .map(|action| action.member_id.as_str()),
        )
        .collect::<HashSet<_>>();
    let mut wake_member_ids = HashSet::new();

    for action in &plan.assignment_actions {
        let has_current_assignment =
            !agent_org_tasks::enqueue_task_assignments_if_still_ready_for_recovery(
                run_id,
                &action.task_ids,
                &action.recipient_agent_id,
                &action.member_id,
                SYSTEM_SENDER_ID,
                None,
                "Agent Org recovery",
            )?
            .is_empty();
        if has_current_assignment || has_unread_for_member(run_id, &action.member_id)? {
            wake_member_ids.insert(action.member_id.clone());
        }
    }

    for action in &plan.continuation_actions {
        if insert_member_continuation_if_tasks_current(run_id, action)? {
            wake_member_ids.insert(action.member_id.clone());
        }
    }

    // Members without a derived action were selected only because the
    // analyzer observed unread durable input. Recheck that input rather than
    // waking from the stale plan alone.
    if AgentOrgRunStore::get_run_status(run_id)? == Some(AgentOrgRunStatus::Running) {
        for member_id in &plan.wake_member_ids {
            if !action_member_ids.contains(member_id.as_str())
                && has_unread_for_member(run_id, member_id)?
            {
                wake_member_ids.insert(member_id.clone());
            }
        }
    }

    if !wake_member_ids.is_empty() {
        for member_id in &wake_member_ids {
            wake_hook.wake_member(member_id, run_id);
        }
    }

    if let Some(reason) = plan.coordinator_repair_reason.as_deref() {
        let fingerprint = plan
            .coordinator_repair_fingerprint
            .as_deref()
            .unwrap_or(reason);
        match insert_coordinator_stall_notice(
            run_id,
            reason,
            fingerprint,
            plan.coordinator_repair_work_revision,
            plan.coordinator_repair_task_fingerprint.as_deref(),
            plan.coordinator_repair_inbox_fingerprint.as_deref(),
        )? {
            CoordinatorNoticeDispatch::Inserted => {
                wake_hook.wake_member(COORDINATOR_MEMBER_ID, run_id);
            }
            CoordinatorNoticeDispatch::ExistingUnread => {
                wake_hook.wake_member(COORDINATOR_MEMBER_ID, run_id);
            }
            CoordinatorNoticeDispatch::Deferred => {
                tracing::debug!(
                    run_id = %run_id,
                    "[agent_org_watchdog] coordinator notice deferred during session materialization grace"
                );
            }
            CoordinatorNoticeDispatch::RecipientUnavailable => {
                // There is no healthy coordinator Inbox to receive another
                // notice. Persist only the diagnostic budget so this
                // impossible self-repair does not become a one-minute log
                // and wake treadmill. The original unread rows remain
                // untouched and the Run remains non-terminal.
                tracing::warn!(
                    run_id = %run_id,
                    repair_reason = %reason,
                    "[agent_org_watchdog] coordinator repair cannot be delivered because the coordinator session is unavailable"
                );
            }
            CoordinatorNoticeDispatch::BudgetSuppressed => {
                tracing::debug!(
                    run_id = %run_id,
                    "[agent_org_watchdog] coordinator stall notice suppressed by budget (reason unchanged)"
                );
            }
            CoordinatorNoticeDispatch::Stale => {}
        }
    }

    if plan.clear_coordinator_notice_budget {
        clear_coordinator_notice_budget_if_recovered(run_id)?;
    }

    Ok(plan)
}

fn clear_coordinator_notice_budget_if_recovered(run_id: &str) -> Result<(), String> {
    with_sessions_writer(|| -> Result<(), String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        // A clear decision is just as stale-able as a notice decision. Re-run
        // the pure analyzer under the writer snapshot so a new fault that
        // appeared after inspection cannot lose its current budget episode.
        if !inspect_stalled_run_with_connection(&tx, run_id)?.coordinator_repair_active {
            tx.execute(
                "DELETE FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key='coordinator'",
                params![run_id, COORDINATOR_NOTICE],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(())
    })
}

fn coordinator_notice_budget_exists_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key='coordinator'
         )",
        params![run_id, COORDINATOR_NOTICE],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

pub fn inspect_stalled_run(run_id: &str) -> Result<StallRecoveryPlan, String> {
    let mut conn = get_connection().map_err(|err| err.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
        .map_err(|err| err.to_string())?;
    let plan = inspect_stalled_run_with_connection(&tx, run_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(plan)
}

/// Analyze one run from one coherent SQLite read snapshot. The executor still
/// opens short writer transactions and revalidates every derived action before
/// committing it; this function intentionally performs no writes.
fn inspect_stalled_run_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<StallRecoveryPlan, String> {
    if AgentOrgRunStore::get_run_status_with_connection(conn, run_id)?
        != Some(AgentOrgRunStatus::Running)
    {
        return Ok(StallRecoveryPlan::default());
    }

    let finality_assessment = AgentOrgRunStore::finality_assessment_with_connection(conn, run_id)?;
    let unread_counts = AgentInboxStore::unread_counts_by_recipient_with_connection(conn, run_id)?;
    let unread_fingerprints_by_member = unread_fingerprints_by_member(&unread_counts);
    let (coordinator_unread, coordinator_unread_wake_member_ids) =
        coordinator_unread_recovery_with_connection(conn, run_id, &unread_fingerprints_by_member)?;
    let workers = AgentOrgRunStore::list_descendant_worker_sessions_with_connection(conn, run_id)?;
    let unavailable_unread_repairs =
        unavailable_unread_recipient_repairs_from_counts_with_connection(
            conn,
            run_id,
            &workers,
            &unread_counts,
        )?;
    let unavailable_unread_fingerprint =
        unread_recipient_repair_snapshot_fingerprint(&unavailable_unread_repairs);
    let coordinator_unread_is_unavailable = unavailable_unread_repairs
        .iter()
        .any(|repair| repair.recipient_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID));
    let coordinator_unread_suppresses_notice =
        coordinator_unread && !coordinator_unread_is_unavailable;

    // Strict task decoding is intentionally fail-closed. If canonical SQL
    // facts already found malformed JSON, do not call `TaskStore::list` and
    // lose the diagnosis as a generic per-run scan error. Surface one stable
    // coordinator repair (or wake the coordinator's existing unread input)
    // and wait for explicit data repair.
    if finality_assessment.facts.corrupt_task_count > 0 {
        let count = finality_assessment.facts.corrupt_task_count;
        let mut reasons = vec![format!(
            "The Agent Org task board has {count} persisted integrity or run-limit violation(s). The watchdog refused to guess task state or declare completion. Use task_list to identify bounded diagnostics. Ordinary task tools intentionally cannot rewrite malformed rows; cancel/delete this run or use a trusted maintenance path to repair the database before continuing."
        )];
        let mut repair_facts = corrupt_task_repair_facts(conn, run_id)?;
        append_unread_recipient_repairs(
            &unavailable_unread_repairs,
            &mut reasons,
            &mut repair_facts,
        );
        let has_new_notice = !coordinator_unread_suppresses_notice;
        let work_revision = finality_assessment
            .facts
            .progress
            .as_ref()
            .map(|progress| progress.work_revision);
        return Ok(StallRecoveryPlan {
            wake_member_ids: coordinator_unread_wake_member_ids,
            continuation_actions: Vec::new(),
            assignment_actions: Vec::new(),
            coordinator_repair_reason: has_new_notice
                .then(|| bounded_recovery_reason_text(&reasons)),
            coordinator_repair_fingerprint: has_new_notice
                .then(|| {
                    recovery_repair_fingerprint(&repair_facts).ok_or_else(|| {
                        format!(
                            "finality reported {count} corrupt task row(s), but no corrupt identity was found"
                        )
                    })
                })
                .transpose()?,
            coordinator_repair_work_revision: has_new_notice.then_some(work_revision).flatten(),
            coordinator_repair_task_fingerprint: None,
            coordinator_repair_inbox_fingerprint: has_new_notice
                .then_some(unavailable_unread_fingerprint)
                .flatten(),
            coordinator_repair_active: true,
            clear_coordinator_notice_budget: false,
            terminal_candidate: false,
        });
    }
    // `finality_assessment` above already proved this board is within the row
    // limit and has zero corrupt rows in this same read snapshot.
    let tasks =
        agent_org_tasks::AgentOrgTaskStore::list_operational_after_validated_with_connection(
            conn, run_id,
        )?;
    let task_snapshot_work_revision = finality_assessment
        .facts
        .progress
        .as_ref()
        .map(|progress| progress.work_revision);
    let task_snapshot_fingerprint = task_snapshot_fingerprint(&tasks);
    let task_graph = agent_org_tasks::TaskGraphIndex::new(&tasks);
    let pending_plan_task_ids =
        AgentOrgPlanApprovalStore::list_pending_summaries_by_run_with_connection(conn, run_id)?
            .into_iter()
            .map(|approval| approval.source_task_id)
            .collect::<HashSet<_>>();
    let has_active_worker = workers.iter().any(|worker| is_active_status(worker.status));
    // An existing coordinator row suppresses a duplicate notice only when the
    // coordinator still has a real delivery path. Missing/Archived/Paused or
    // exhausted coordinator sessions must not hide the diagnosis.

    let mut member_status = HashMap::new();
    let mut member_updated_at = HashMap::new();
    let mut unsupported_transport_members = HashSet::new();
    for worker in &workers {
        if let Some(member_id) = worker.member_id.as_deref() {
            member_status
                .entry(member_id.to_string())
                .or_insert(worker.status);
            member_updated_at
                .entry(member_id.to_string())
                .or_insert_with(|| worker.updated_at.clone());
            if worker.cli_agent_type.is_some() {
                unsupported_transport_members.insert(member_id.to_string());
            }
        }
    }

    // E3 remains intentionally run-level for automated member recovery: while
    // any worker is active, do not wake peers or reassign/claim work. The one
    // safe exception is an observation-only coordinator notice for a Running
    // owner whose task and session timestamps are stale (or corrupt). Age is
    // never used to steal ownership.
    if has_active_worker {
        let mut reasons = Vec::new();
        let mut repair_facts = Vec::new();
        append_unread_recipient_repairs(
            &unavailable_unread_repairs,
            &mut reasons,
            &mut repair_facts,
        );
        append_dependency_integrity_repairs(&tasks, &mut reasons, &mut repair_facts);
        for task in &tasks {
            let Some(owner) = task.owner.as_deref() else {
                let ready = task.status == TaskStatus::Pending && task_graph.is_ready(task);
                if ready {
                    let mut eligible = agent_org_tasks::eligible_member_ids(task);
                    eligible.sort();
                    let mut fields = vec![Some(task.id.clone())];
                    fields.extend(eligible.into_iter().map(Some));
                    repair_facts.push(RecoveryRepairFact::new(
                        "awaiting_coordinator_assignment",
                        fields,
                    ));
                    reasons.push(ready_unassigned_repair_reason(task));
                }
                continue;
            };
            if unsupported_transport_members.contains(owner) && !task.status.is_resolved() {
                repair_facts.push(RecoveryRepairFact::new(
                    "unsupported_transport",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                reasons.push(format!(
                    "task {} is owned by historical CLI member {}, whose Agent Org transport is unsupported; reassign it to a Rust member.",
                    task.id, owner
                ));
                continue;
            }
            if pending_plan_task_ids.contains(&task.id)
                || task.status != TaskStatus::InProgress
                || member_status.get(owner) != Some(&SessionStatus::Running)
                || !is_stale_in_progress(task.updated_at.as_str(), member_updated_at.get(owner))
                || unread_fingerprints_by_member.contains_key(owner)
            {
                continue;
            }
            repair_facts.push(RecoveryRepairFact::new(
                "stale_running_owner",
                [Some(task.id.clone()), Some(owner.to_string())],
            ));
            reasons.push(format!(
                "task {} is still in_progress under Running member {} but appears stale; the watchdog will not steal it based on age. Ask the owner to continue/retry or explicitly reassign it.",
                task.id, owner
            ));
        }
        let coordinator_repair_active = !reasons.is_empty();
        let clear_coordinator_notice_budget = !coordinator_repair_active
            && coordinator_notice_budget_exists_with_connection(conn, run_id)?;
        let has_new_notice = coordinator_repair_active && !coordinator_unread_suppresses_notice;
        return Ok(StallRecoveryPlan {
            wake_member_ids: coordinator_unread_wake_member_ids,
            continuation_actions: Vec::new(),
            assignment_actions: Vec::new(),
            coordinator_repair_reason: has_new_notice
                .then(|| bounded_recovery_reason_text(&reasons)),
            coordinator_repair_fingerprint: has_new_notice
                .then(|| recovery_repair_fingerprint(&repair_facts))
                .flatten(),
            coordinator_repair_work_revision: has_new_notice
                .then_some(task_snapshot_work_revision)
                .flatten(),
            coordinator_repair_task_fingerprint: has_new_notice
                .then(|| task_snapshot_fingerprint.clone()),
            coordinator_repair_inbox_fingerprint: has_new_notice
                .then_some(unavailable_unread_fingerprint)
                .flatten(),
            coordinator_repair_active,
            clear_coordinator_notice_budget,
            terminal_candidate: false,
        });
    }

    // One task-list scan identifies ownerless work that is ready for an
    // explicit coordinator assignment. It is never a Worker wake reason.
    let ready_unassigned_task_ids: HashSet<String> =
        agent_org_tasks::ready_unassigned_tasks(&tasks)
            .into_iter()
            .map(|task| task.id.clone())
            .collect();
    let historically_assigned_task_ids =
        AgentInboxStore::task_assignment_ids_for_open_tasks_with_connection(conn, run_id)?;
    let mut owned_open_tasks_by_member: HashMap<&str, Vec<String>> = HashMap::new();
    let mut ready_pending_tasks_by_member: HashMap<&str, Vec<String>> = HashMap::new();
    for task in &tasks {
        if task.status.is_resolved() || pending_plan_task_ids.contains(&task.id) {
            continue;
        }
        if let Some(owner) = task.owner.as_deref() {
            owned_open_tasks_by_member
                .entry(owner)
                .or_default()
                .push(task.id.clone());
            if task.status == TaskStatus::Pending
                && !historically_assigned_task_ids.contains(&task.id)
                && task_graph.is_ready(task)
            {
                ready_pending_tasks_by_member
                    .entry(owner)
                    .or_default()
                    .push(task.id.clone());
            }
        }
    }
    // Wake pass (issue #272 E2). "Idle with unread inbox" is the
    // canonical missed-wake state, so it is a wake reason — not a skip
    // condition — and members are gated individually instead of the
    // previous all-or-nothing unread check.
    let mut wake_member_ids: Vec<String> = Vec::new();
    let mut continuation_actions = Vec::new();
    let mut assignment_actions = Vec::new();
    for worker in &workers {
        let Some(member_id) = worker.member_id.as_deref() else {
            continue;
        };
        if !is_wakeable_status(worker.status) {
            continue;
        }
        if unsupported_transport_members.contains(member_id) {
            continue;
        }
        if wake_member_ids.iter().any(|existing| existing == member_id) {
            continue;
        }
        let unread_fingerprint = unread_fingerprints_by_member.get(member_id);
        let has_unread = unread_fingerprint.is_some();
        let continuation_task_ids = owned_open_tasks_by_member.get(member_id);
        let assignment_task_ids = ready_pending_tasks_by_member.get(member_id);
        let needs_assignment = assignment_task_ids.is_some_and(|task_ids| !task_ids.is_empty());
        let in_progress_continuation_task_ids = continuation_task_ids
            .map(|task_ids| {
                task_ids
                    .iter()
                    .filter(|task_id| {
                        tasks.iter().any(|task| {
                            &task.id == *task_id
                                && (task.status == TaskStatus::InProgress
                                    || (task.status == TaskStatus::Pending
                                        && historically_assigned_task_ids.contains(&task.id)))
                        })
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let needs_terminal_continuation =
            worker.status.is_terminal() && !in_progress_continuation_task_ids.is_empty();
        if !has_unread && !needs_assignment && !needs_terminal_continuation {
            continue;
        }
        let rewake_fingerprint = member_rewake_fingerprint_from_unread(
            worker.status,
            unread_fingerprint.map(String::as_str),
        );
        if budget_disposition_with_connection(
            conn,
            run_id,
            MEMBER_REWAKE,
            member_id,
            &rewake_fingerprint,
        )? != BudgetDisposition::Allowed
        {
            continue;
        }
        if !has_unread && needs_assignment {
            let Some(recipient_agent_id) = worker.agent_definition_id.clone() else {
                continue;
            };
            assignment_actions.push(MemberTaskAssignmentAction {
                member_id: member_id.to_string(),
                recipient_agent_id,
                task_ids: assignment_task_ids.cloned().unwrap_or_default(),
            });
        } else if !has_unread && needs_terminal_continuation {
            let Some(recipient_agent_id) = worker.agent_definition_id.clone() else {
                continue;
            };
            continuation_actions.push(MemberContinuationAction {
                member_id: member_id.to_string(),
                recipient_agent_id,
                task_ids: in_progress_continuation_task_ids,
            });
        }
        wake_member_ids.push(member_id.to_string());
    }

    // Coordinator missed-delivery recovery: an unread coordinator inbox
    // row with a quiescent coordinator session means a wake was lost
    // (e.g. dropped at shutdown). Redeliver instead of inserting more
    // notices on top of it.
    wake_member_ids.extend(coordinator_unread_wake_member_ids);

    let mut needs_repair = Vec::new();
    let mut repair_facts = Vec::new();
    append_unread_recipient_repairs(
        &unavailable_unread_repairs,
        &mut needs_repair,
        &mut repair_facts,
    );
    append_dependency_integrity_repairs(&tasks, &mut needs_repair, &mut repair_facts);
    for task in &tasks {
        if task.status.is_resolved() {
            continue;
        }
        if let Some(owner) = task.owner.as_deref() {
            let owner_status = member_status.get(owner).copied();
            if unsupported_transport_members.contains(owner) {
                repair_facts.push(RecoveryRepairFact::new(
                    "unsupported_transport",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                needs_repair.push(format!(
                    "task {} is owned by historical CLI member {}, whose Agent Org transport is unsupported; reassign owner_member_id to a Rust member",
                    task.id, owner
                ));
            } else if owner_status.is_none() || owner_status == Some(SessionStatus::Archived) {
                repair_facts.push(RecoveryRepairFact::new(
                    "missing_owner",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                needs_repair.push(format!(
                    "task {} is owned by unavailable member {}; reassign owner_member_id or repair eligible_member_ids",
                    task.id, owner
                ));
            } else if owner_status == Some(SessionStatus::Paused) {
                repair_facts.push(RecoveryRepairFact::new(
                    "paused_owner",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                needs_repair.push(format!(
                    "task {} is owned by administratively paused member {}. The watchdog will not wake a paused member; resume that member or explicitly reassign owner_member_id.",
                    task.id, owner
                ));
            } else if owner_status == Some(SessionStatus::Pending) {
                match pending_materialization_disposition(
                    member_updated_at.get(owner).map(String::as_str),
                ) {
                    PendingMaterializationDisposition::Grace => {}
                    PendingMaterializationDisposition::Expired => {
                        repair_facts.push(RecoveryRepairFact::new(
                            "pending_owner_timeout",
                            [Some(task.id.clone()), Some(owner.to_string())],
                        ));
                        needs_repair.push(format!(
                            "task {} is owned by member {}, but that session remained Pending beyond the {}-second materialization grace period. Retry materialization or explicitly reassign owner_member_id.",
                            task.id, owner, PENDING_MATERIALIZATION_GRACE_SECS
                        ));
                    }
                    PendingMaterializationDisposition::InvalidTimestamp => {
                        repair_facts.push(RecoveryRepairFact::new(
                            "pending_owner_invalid_timestamp",
                            [Some(task.id.clone()), Some(owner.to_string())],
                        ));
                        needs_repair.push(format!(
                            "task {} is owned by Pending member {}, whose session timestamp is missing or invalid. Repair the session or explicitly reassign owner_member_id.",
                            task.id, owner
                        ));
                    }
                }
            } else if match owner_status {
                Some(
                    status @ (SessionStatus::Completed
                    | SessionStatus::Failed
                    | SessionStatus::Cancelled
                    | SessionStatus::Abandoned
                    | SessionStatus::Timeout
                    | SessionStatus::Archived),
                ) => {
                    let fingerprint = member_rewake_fingerprint_from_unread(
                        status,
                        unread_fingerprints_by_member.get(owner).map(String::as_str),
                    );
                    budget_disposition_with_connection(
                        conn,
                        run_id,
                        MEMBER_REWAKE,
                        owner,
                        &fingerprint,
                    )? == BudgetDisposition::Exhausted
                }
                Some(
                    SessionStatus::Pending
                    | SessionStatus::Idle
                    | SessionStatus::Running
                    | SessionStatus::WaitingForUser
                    | SessionStatus::WaitingForFunds
                    | SessionStatus::Paused,
                )
                | None => false,
            } {
                repair_facts.push(RecoveryRepairFact::new(
                    "terminal_owner",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                needs_repair.push(format!(
                    "task {} is owned by terminal member {} whose automatic retry budget is exhausted; retry the owner, reassign owner_member_id, or repair eligible_member_ids",
                    task.id, owner
                ));
            } else if task.status == TaskStatus::InProgress
                && !pending_plan_task_ids.contains(&task.id)
                && is_stale_in_progress(task.updated_at.as_str(), member_updated_at.get(owner))
                && !unread_fingerprints_by_member.contains_key(owner)
            {
                repair_facts.push(RecoveryRepairFact::new(
                    "stale_owner",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                let eligible = agent_org_tasks::eligible_member_ids(task);
                let eligible = if eligible.is_empty() {
                    "none".to_string()
                } else {
                    bounded_id_list_preview(&eligible, 8, 160)
                };
                needs_repair.push(format!(
                    "task {} is still in_progress under member {} but appears stale; task_updated_at={}, owner_updated_at={}, eligible_member_ids=[{}]. The watchdog does not steal work from a Running member based on age alone. Ask the owner to continue/retry, reassign owner_member_id, or repair eligible_member_ids.",
                    task.id,
                    owner,
                    task.updated_at,
                    member_updated_at
                        .get(owner)
                        .map(String::as_str)
                        .unwrap_or("unknown"),
                    eligible
                ));
            } else if task.status == TaskStatus::Pending
                && historically_assigned_task_ids.contains(&task.id)
                && owner_status == Some(SessionStatus::Idle)
                && is_stale_in_progress(task.updated_at.as_str(), member_updated_at.get(owner))
                && !unread_fingerprints_by_member.contains_key(owner)
            {
                repair_facts.push(RecoveryRepairFact::new(
                    "consumed_assignment_without_start",
                    [Some(task.id.clone()), Some(owner.to_string())],
                ));
                needs_repair.push(format!(
                    "task {} was assigned to member {}, its assignment was consumed, but the task never entered in_progress. Ask the owner for status or explicitly retry/reassign it.",
                    task.id, owner
                ));
            }
            continue;
        }
        if task.status != TaskStatus::Pending {
            continue;
        }
        if !ready_unassigned_task_ids.contains(task.id.as_str()) {
            // Blocked on other work; nothing to recover yet.
            continue;
        }
        let eligible_member_ids = agent_org_tasks::eligible_member_ids(task);
        let mut stable_eligible = eligible_member_ids.clone();
        stable_eligible.sort();
        let mut fields = vec![Some(task.id.clone())];
        fields.extend(stable_eligible.into_iter().map(Some));
        repair_facts.push(RecoveryRepairFact::new(
            "awaiting_coordinator_assignment",
            fields,
        ));
        needs_repair.push(ready_unassigned_repair_reason(task));
    }

    for blocker in &finality_assessment.blockers {
        match blocker {
            AgentOrgFinalityBlocker::EmptyTaskBoardRequiresCompletionIntent => {
                repair_facts.push(RecoveryRepairFact::marker(
                    "empty_board_requires_completion_intent",
                ));
                needs_repair.push(
                    "the Agent Org task board is empty. If the mission truly requires no durable tasks, call org_run_complete with a concise summary; otherwise create the missing task graph."
                        .to_string(),
                );
            }
            AgentOrgFinalityBlocker::StaleCompletionIntent {
                requested_work_revision,
                current_work_revision,
            } => {
                repair_facts.push(RecoveryRepairFact::new(
                    "stale_completion_intent",
                    [
                        requested_work_revision.map(|revision| revision.to_string()),
                        Some(current_work_revision.to_string()),
                    ],
                ));
                needs_repair.push(format!(
                    "the previous completion request observed work revision {requested_work_revision:?}, but the board is now revision {current_work_revision}. Re-inspect the current task board and call org_run_complete again only if it is still finished."
                ));
            }
            AgentOrgFinalityBlocker::CoordinatorHasNotObservedLatestWork {
                observed_work_revision,
                current_work_revision,
            } if tasks.iter().all(|task| task.status.is_resolved()) => {
                repair_facts.push(RecoveryRepairFact::new(
                    "coordinator_observation",
                    [
                        observed_work_revision.map(|revision| revision.to_string()),
                        Some(current_work_revision.to_string()),
                    ],
                ));
                needs_repair.push(format!(
                    "all durable tasks are resolved, but the coordinator has only observed work revision {observed_work_revision:?}; the current revision is {current_work_revision}. Refresh task_list and produce the final user-facing synthesis."
                ));
            }
            AgentOrgFinalityBlocker::CorruptTaskData { count } => {
                repair_facts.extend(corrupt_task_repair_facts(conn, run_id)?);
                needs_repair.push(format!(
                    "{count} task row(s) contain invalid persisted JSON. Do not declare completion; inspect and repair the task records."
                ));
            }
            AgentOrgFinalityBlocker::ProgressStateMissing => {
                repair_facts.push(RecoveryRepairFact::marker("missing_run_progress"));
                needs_repair.push(
                    "the run is missing its durable work-revision record. Do not declare completion until the state is repaired."
                        .to_string(),
                );
            }
            AgentOrgFinalityBlocker::RootSessionMissing => {
                repair_facts.push(RecoveryRepairFact::marker("missing_coordinator_session"));
                needs_repair.push(
                    "the run has no materialized coordinator session, so final completion cannot be safely presented."
                        .to_string(),
                );
            }
            AgentOrgFinalityBlocker::RunMissing
            | AgentOrgFinalityBlocker::RunNotRunning { .. }
            | AgentOrgFinalityBlocker::SessionsActive { .. }
            | AgentOrgFinalityBlocker::OpenTasks { .. }
            | AgentOrgFinalityBlocker::CoordinatorHasNotObservedLatestWork { .. }
            | AgentOrgFinalityBlocker::UnreadInbox { .. }
            | AgentOrgFinalityBlocker::ActiveInterventions { .. }
            | AgentOrgFinalityBlocker::InFlightTurnIntents { .. }
            | AgentOrgFinalityBlocker::PendingPlanApprovals { .. }
            | AgentOrgFinalityBlocker::TerminalStateInconsistent { .. } => {}
        }
    }

    let coordinator_repair_reason =
        if !needs_repair.is_empty() && !coordinator_unread_suppresses_notice {
            Some(bounded_recovery_reason_text(&needs_repair))
        } else {
            None
        };
    let coordinator_repair_fingerprint = coordinator_repair_reason
        .as_ref()
        .and_then(|_| recovery_repair_fingerprint(&repair_facts));

    let terminal_candidate = matches!(
        finality_assessment.decision,
        AgentOrgFinalityDecision::Complete | AgentOrgFinalityDecision::Abandon
    );
    let has_coordinator_repair = coordinator_repair_reason.is_some();
    let coordinator_repair_active = !needs_repair.is_empty();
    let clear_coordinator_notice_budget = !coordinator_repair_active
        && coordinator_notice_budget_exists_with_connection(conn, run_id)?;

    Ok(StallRecoveryPlan {
        wake_member_ids,
        continuation_actions,
        assignment_actions,
        coordinator_repair_reason,
        coordinator_repair_fingerprint,
        coordinator_repair_work_revision: has_coordinator_repair
            .then_some(task_snapshot_work_revision)
            .flatten(),
        coordinator_repair_task_fingerprint: has_coordinator_repair
            .then_some(task_snapshot_fingerprint),
        coordinator_repair_inbox_fingerprint: has_coordinator_repair
            .then_some(unavailable_unread_fingerprint)
            .flatten(),
        coordinator_repair_active,
        clear_coordinator_notice_budget,
        terminal_candidate,
    })
}

fn is_active_status(status: SessionStatus) -> bool {
    status.is_in_flight()
}

fn is_wakeable_status(status: SessionStatus) -> bool {
    status.is_agent_org_wakeable()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingMaterializationDisposition {
    Grace,
    Expired,
    InvalidTimestamp,
}

fn pending_materialization_disposition(
    owner_updated_at: Option<&str>,
) -> PendingMaterializationDisposition {
    let Some(owner_updated_at) = owner_updated_at else {
        return PendingMaterializationDisposition::InvalidTimestamp;
    };
    let updated_at = match DateTime::parse_from_rfc3339(owner_updated_at) {
        Ok(parsed) => parsed.with_timezone(&Utc),
        Err(err) => {
            tracing::warn!(
                timestamp = %owner_updated_at,
                error = %err,
                "[agent_org_watchdog] unparseable Pending member updated_at; escalating repair"
            );
            return PendingMaterializationDisposition::InvalidTimestamp;
        }
    };
    if Utc::now() - updated_at <= ChronoDuration::seconds(PENDING_MATERIALIZATION_GRACE_SECS) {
        PendingMaterializationDisposition::Grace
    } else {
        PendingMaterializationDisposition::Expired
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum UnreadRecipientUnavailableReason {
    MissingCanonicalMemberId,
    UnknownRosterMember,
    MissingSession,
    ArchivedSession,
    UnsupportedTransport,
    AdministrativelyPaused,
    PendingMaterializationExpired,
    InvalidSessionTimestamp,
    RecoveryBudgetExhausted,
}

impl UnreadRecipientUnavailableReason {
    fn as_key(self) -> &'static str {
        match self {
            Self::MissingCanonicalMemberId => "missing_canonical_member_id",
            Self::UnknownRosterMember => "unknown_roster_member",
            Self::MissingSession => "missing_session",
            Self::ArchivedSession => "archived_session",
            Self::UnsupportedTransport => "unsupported_transport",
            Self::AdministrativelyPaused => "administratively_paused",
            Self::PendingMaterializationExpired => "pending_materialization_expired",
            Self::InvalidSessionTimestamp => "invalid_session_timestamp",
            Self::RecoveryBudgetExhausted => "recovery_budget_exhausted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnreadRecipientRepair {
    recipient_member_id: Option<String>,
    recipient_agent_id: String,
    unread_count: usize,
    max_unread_id: i64,
    reason: UnreadRecipientUnavailableReason,
}

impl UnreadRecipientRepair {
    fn repair_fact(&self) -> RecoveryRepairFact {
        RecoveryRepairFact::new(
            "unread_recipient",
            [
                Some(self.reason.as_key().to_string()),
                self.recipient_member_id.clone(),
                self.recipient_member_id
                    .is_none()
                    .then(|| self.recipient_agent_id.clone()),
            ],
        )
    }

    fn stable_key(&self) -> String {
        self.repair_fact().digest()
    }

    fn snapshot_fact(&self) -> RecoveryRepairFact {
        RecoveryRepairFact::new(
            "unread_recipient_snapshot",
            [
                Some(self.reason.as_key().to_string()),
                self.recipient_member_id.clone(),
                self.recipient_member_id
                    .is_none()
                    .then(|| self.recipient_agent_id.clone()),
                Some(self.unread_count.to_string()),
                Some(self.max_unread_id.to_string()),
            ],
        )
    }

    fn coordinator_reason(&self) -> String {
        let recipient = self
            .recipient_member_id
            .as_deref()
            .map(|member_id| format!("member {member_id}"))
            .unwrap_or_else(|| {
                format!(
                    "a legacy Inbox recipient without recipient_member_id (recipient_agent_id={})",
                    self.recipient_agent_id
                )
            });
        let repair = match self.reason {
            UnreadRecipientUnavailableReason::MissingCanonicalMemberId => {
                "the durable row has no canonical member identity. Do not guess from agent_id because multiple roster members may share one AgentDefinition; restore the intended member identity or cancel the run"
            }
            UnreadRecipientUnavailableReason::UnknownRosterMember => {
                "that member is not present in this run's immutable launch roster; inspect the corrupted routing identity or cancel the run"
            }
            UnreadRecipientUnavailableReason::MissingSession => {
                "no materialized session exists for that roster member; restore/materialize the member session or cancel the run"
            }
            UnreadRecipientUnavailableReason::ArchivedSession => {
                "the recipient session is Archived and cannot be woken; reopen the member or cancel the run"
            }
            UnreadRecipientUnavailableReason::UnsupportedTransport => {
                "the recipient is a historical CLI member, whose Agent Org Inbox transport is unsupported; move the work to a Rust member or cancel the run"
            }
            UnreadRecipientUnavailableReason::AdministrativelyPaused => {
                "the recipient session is administratively Paused; resume it explicitly or cancel the run"
            }
            UnreadRecipientUnavailableReason::PendingMaterializationExpired => {
                "the recipient session remained Pending beyond the materialization grace period; retry materialization or cancel the run"
            }
            UnreadRecipientUnavailableReason::InvalidSessionTimestamp => {
                "the Pending recipient has a missing or invalid timestamp, so automatic recovery cannot safely wait; repair the session or cancel the run"
            }
            UnreadRecipientUnavailableReason::RecoveryBudgetExhausted => {
                "automatic Wake attempts for the current unread set are exhausted; explicitly retry/reopen the recipient or cancel the run"
            }
        };
        format!(
            "{recipient} has {} pending Agent Org Inbox message(s), but {repair}. The watchdog preserves those rows as unread because the intended recipient did not read them. Inspect the newest affected inbox_id {} with org_inbox_repair. If recovery is impossible, create any legitimate replacement work first and explicitly supersede it, or explicitly cancel that delivery; never mark it read by guessing the recipient.",
            self.unread_count,
            self.max_unread_id
        )
    }
}

fn unread_fingerprints_by_member(
    counts: &[crate::coordination::agent_inbox::AgentInboxUnreadRecipientCounts],
) -> HashMap<String, String> {
    let mut aggregate = HashMap::<String, (i64, usize)>::new();
    for counts in counts {
        let Some(member_id) = counts
            .recipient_member_id
            .as_deref()
            .filter(|member_id| !member_id.trim().is_empty())
        else {
            continue;
        };
        let entry = aggregate
            .entry(member_id.to_string())
            .or_insert((counts.max_unread_id, 0));
        entry.0 = entry.0.max(counts.max_unread_id);
        entry.1 = entry.1.saturating_add(counts.unread_count);
    }
    aggregate
        .into_iter()
        .map(|(member_id, (max_id, count))| (member_id, format!("{max_id}:{count}")))
        .collect()
}

fn unavailable_unread_recipient_repairs_with_connection(
    conn: &Connection,
    run_id: &str,
    workers: &[WorkerSessionRuntime],
) -> Result<Vec<UnreadRecipientRepair>, String> {
    let counts = AgentInboxStore::unread_counts_by_recipient_with_connection(conn, run_id)?;
    unavailable_unread_recipient_repairs_from_counts_with_connection(conn, run_id, workers, &counts)
}

fn unavailable_unread_recipient_repairs_from_counts_with_connection(
    conn: &Connection,
    run_id: &str,
    workers: &[WorkerSessionRuntime],
    counts: &[crate::coordination::agent_inbox::AgentInboxUnreadRecipientCounts],
) -> Result<Vec<UnreadRecipientRepair>, String> {
    let unread_fingerprints_by_member = unread_fingerprints_by_member(counts);
    let roster_member_ids = AgentOrgRunStore::snapshot_member_ids_with_connection(conn, run_id)?;
    let coordinator = AgentOrgRunStore::find_coordinator_session_by_member_id_with_connection(
        conn,
        run_id,
        COORDINATOR_MEMBER_ID,
    )?;
    let mut repairs = Vec::new();

    // Canonical member identity wins over AgentDefinition identity. Multiple
    // roster members may share one definition and one member may retain
    // historical rows under more than one definition id, so aggregate all
    // groups for the same member before classifying or reporting counts.
    let mut canonical = HashMap::<String, (BTreeSet<String>, usize, i64)>::new();
    let mut legacy = Vec::new();
    for count in counts.iter().filter(|counts| counts.unread_count > 0) {
        if let Some(member_id) = count
            .recipient_member_id
            .as_deref()
            .filter(|member_id| !member_id.trim().is_empty())
        {
            let entry = canonical
                .entry(member_id.to_string())
                .or_insert_with(|| (BTreeSet::new(), 0, count.max_unread_id));
            entry.0.insert(count.recipient_agent_id.clone());
            entry.1 = entry.1.saturating_add(count.unread_count);
            entry.2 = entry.2.max(count.max_unread_id);
        } else {
            legacy.push(count.clone());
        }
    }
    let mut normalized_counts = legacy;
    normalized_counts.extend(canonical.into_iter().map(
        |(member_id, (agent_ids, unread_count, max_unread_id))| {
            crate::coordination::agent_inbox::AgentInboxUnreadRecipientCounts {
                recipient_agent_id: agent_ids.into_iter().collect::<Vec<_>>().join(","),
                recipient_member_id: Some(member_id),
                unread_count,
                max_unread_id,
            }
        },
    ));
    normalized_counts.sort_by(|left, right| {
        left.recipient_member_id
            .cmp(&right.recipient_member_id)
            .then_with(|| left.recipient_agent_id.cmp(&right.recipient_agent_id))
    });

    for counts in &normalized_counts {
        let Some(member_id) = counts
            .recipient_member_id
            .as_deref()
            .filter(|member_id| !member_id.trim().is_empty())
        else {
            repairs.push(UnreadRecipientRepair {
                recipient_member_id: None,
                recipient_agent_id: counts.recipient_agent_id.clone(),
                unread_count: counts.unread_count,
                max_unread_id: counts.max_unread_id,
                reason: UnreadRecipientUnavailableReason::MissingCanonicalMemberId,
            });
            continue;
        };

        if member_id != COORDINATOR_MEMBER_ID
            && roster_member_ids
                .as_ref()
                .is_some_and(|roster| !roster.contains(member_id))
        {
            repairs.push(UnreadRecipientRepair {
                recipient_member_id: Some(member_id.to_string()),
                recipient_agent_id: counts.recipient_agent_id.clone(),
                unread_count: counts.unread_count,
                max_unread_id: counts.max_unread_id,
                reason: UnreadRecipientUnavailableReason::UnknownRosterMember,
            });
            continue;
        }

        let runtime = if member_id == COORDINATOR_MEMBER_ID {
            coordinator
                .as_ref()
                .map(|runtime| (runtime.status, runtime.updated_at.as_str(), false))
        } else {
            // `list_descendant_worker_sessions` is newest-first. Never let an
            // older duplicate session overwrite the current runtime.
            workers
                .iter()
                .find(|runtime| runtime.member_id.as_deref() == Some(member_id))
                .map(|runtime| {
                    (
                        runtime.status,
                        runtime.updated_at.as_str(),
                        runtime.cli_agent_type.is_some(),
                    )
                })
        };
        let Some((status, updated_at, unsupported_transport)) = runtime else {
            repairs.push(UnreadRecipientRepair {
                recipient_member_id: Some(member_id.to_string()),
                recipient_agent_id: counts.recipient_agent_id.clone(),
                unread_count: counts.unread_count,
                max_unread_id: counts.max_unread_id,
                reason: UnreadRecipientUnavailableReason::MissingSession,
            });
            continue;
        };

        let reason = if unsupported_transport {
            Some(UnreadRecipientUnavailableReason::UnsupportedTransport)
        } else {
            match status {
                SessionStatus::Pending => {
                    match pending_materialization_disposition(Some(updated_at)) {
                        PendingMaterializationDisposition::Grace => None,
                        PendingMaterializationDisposition::Expired => {
                            Some(UnreadRecipientUnavailableReason::PendingMaterializationExpired)
                        }
                        PendingMaterializationDisposition::InvalidTimestamp => {
                            Some(UnreadRecipientUnavailableReason::InvalidSessionTimestamp)
                        }
                    }
                }
                SessionStatus::Paused => {
                    Some(UnreadRecipientUnavailableReason::AdministrativelyPaused)
                }
                SessionStatus::Archived => Some(UnreadRecipientUnavailableReason::ArchivedSession),
                SessionStatus::Idle
                | SessionStatus::Completed
                | SessionStatus::Failed
                | SessionStatus::Cancelled
                | SessionStatus::Abandoned
                | SessionStatus::Timeout => {
                    let unread_fingerprint = unread_fingerprints_by_member
                        .get(member_id)
                        .map(|fingerprint| format!("unread:{fingerprint}"))
                        .ok_or_else(|| {
                            format!(
                                "unread recipient {member_id} was missing from grouped snapshot"
                            )
                        })?;
                    match budget_disposition_with_connection(
                        conn,
                        run_id,
                        MEMBER_REWAKE,
                        member_id,
                        &unread_fingerprint,
                    )? {
                        BudgetDisposition::Exhausted => {
                            Some(UnreadRecipientUnavailableReason::RecoveryBudgetExhausted)
                        }
                        BudgetDisposition::Allowed | BudgetDisposition::Backoff => None,
                    }
                }
                SessionStatus::Running
                | SessionStatus::WaitingForUser
                | SessionStatus::WaitingForFunds => None,
            }
        };

        if let Some(reason) = reason {
            repairs.push(UnreadRecipientRepair {
                recipient_member_id: Some(member_id.to_string()),
                recipient_agent_id: counts.recipient_agent_id.clone(),
                unread_count: counts.unread_count,
                max_unread_id: counts.max_unread_id,
                reason,
            });
        }
    }

    repairs.sort_by_key(UnreadRecipientRepair::stable_key);
    Ok(repairs)
}

fn unread_recipient_repair_snapshot_fingerprint(
    repairs: &[UnreadRecipientRepair],
) -> Option<String> {
    let facts = repairs
        .iter()
        .map(UnreadRecipientRepair::snapshot_fact)
        .collect::<Vec<_>>();
    recovery_repair_fingerprint(&facts)
}

fn append_unread_recipient_repairs(
    repairs: &[UnreadRecipientRepair],
    reasons: &mut Vec<String>,
    facts: &mut Vec<RecoveryRepairFact>,
) {
    for repair in repairs {
        reasons.push(repair.coordinator_reason());
        facts.push(repair.repair_fact());
    }
}

fn is_stale_in_progress(task_updated_at: &str, owner_updated_at: Option<&String>) -> bool {
    let stale_before =
        Utc::now() - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS);
    let task_updated_at = match DateTime::parse_from_rfc3339(task_updated_at) {
        Ok(parsed) => parsed.with_timezone(&Utc),
        Err(err) => {
            // Corrupt timestamps must escalate, not silently exempt the
            // task from staleness forever (issue #272 E6). The notice
            // budget caps any resulting repeat noise.
            tracing::warn!(
                timestamp = %task_updated_at,
                error = %err,
                "[agent_org_watchdog] unparseable task updated_at; treating task as stale"
            );
            return true;
        }
    };
    if task_updated_at > stale_before {
        return false;
    }
    let Some(owner_updated_at) = owner_updated_at else {
        return true;
    };
    match DateTime::parse_from_rfc3339(owner_updated_at) {
        Ok(parsed) => parsed.with_timezone(&Utc) <= stale_before,
        Err(err) => {
            tracing::warn!(
                timestamp = %owner_updated_at,
                error = %err,
                "[agent_org_watchdog] unparseable owner updated_at; treating task as stale"
            );
            true
        }
    }
}

fn has_unread_for_member(run_id: &str, member_id: &str) -> Result<bool, String> {
    AgentInboxStore::has_unread_for_member(member_id, run_id)
}

/// Persist a terminal-member continuation only when at least one task from
/// the analyzed action still has the same owner, remains unresolved, and has
/// no unresolved blockers. The validation and insert share the same writer
/// transaction, closing the analyzer/executor TOCTOU window.
fn insert_member_continuation_if_tasks_current(
    run_id: &str,
    action: &MemberContinuationAction,
) -> Result<bool, String> {
    with_sessions_writer(|| -> Result<bool, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let running: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_runs WHERE id=?1 AND status='running'
                 )",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if !running {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        }

        let sessions =
            AgentOrgRunStore::list_descendant_worker_sessions_with_connection(&tx, run_id)?;
        if !recovery_dispatch_recipient_is_available(
            &sessions,
            &action.member_id,
            &action.recipient_agent_id,
        ) {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        }

        let has_unread: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_inbox
                     WHERE org_run_id=?1 AND recipient_member_id=?2 AND read_at IS NULL
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                           WHERE resolution.inbox_id=agent_inbox.id
                       )
                 )",
                params![run_id, &action.member_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if has_unread {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(true);
        }

        let tasks =
            agent_org_tasks::AgentOrgTaskStore::list_operational_with_connection(&tx, run_id)?;
        let graph = agent_org_tasks::TaskGraphIndex::new(&tasks);
        let planned_ids = action.task_ids.iter().collect::<HashSet<_>>();
        let pending_plan_task_ids = {
            let mut stmt = tx
                .prepare(
                    "SELECT source_task_id FROM agent_org_plan_approvals
                     WHERE org_run_id=?1 AND status='pending'",
                )
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![run_id], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            rows.collect::<Result<HashSet<_>, _>>()
                .map_err(|err| err.to_string())?
        };
        let current_task_ids = tasks
            .iter()
            .filter(|task| planned_ids.contains(&task.id))
            .filter(|task| task.owner.as_deref() == Some(action.member_id.as_str()))
            .filter(|task| {
                matches!(task.status, TaskStatus::Pending | TaskStatus::InProgress)
                    && graph.unresolved_blockers(&task.id).is_empty()
                    && !pending_plan_task_ids.contains(&task.id)
            })
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        if current_task_ids.is_empty() {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        }

        AgentInboxStore::insert_in_tx(
            &tx,
            InsertInboxParams {
                recipient_agent_id: action.recipient_agent_id.clone(),
                recipient_member_id: Some(action.member_id.clone()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(run_id.to_string()),
                message: AgentMessage::Plain {
                    summary: "Retry assigned Agent Org work".to_string(),
                    text: format!(
                        "A previous turn ended before your owned task(s) were resolved. Continue only these durable task ids: {}. Refresh task_list/task_get first, then update each task from its current state. Do not create replacement duplicates.",
                        bounded_id_list_preview(&current_task_ids, 8, 1_000)
                    ),
                },
            },
        )?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(true)
    })
}

fn coordinator_unread_recovery_with_connection(
    conn: &Connection,
    run_id: &str,
    unread_fingerprints_by_member: &HashMap<String, String>,
) -> Result<(bool, Vec<String>), String> {
    let Some(unread_fingerprint) = unread_fingerprints_by_member.get(COORDINATOR_MEMBER_ID) else {
        return Ok((false, Vec::new()));
    };
    let Some(info) = AgentOrgRunStore::find_coordinator_session_by_member_id_with_connection(
        conn,
        run_id,
        COORDINATOR_MEMBER_ID,
    )?
    else {
        return Ok((true, Vec::new()));
    };
    let fingerprint = member_rewake_fingerprint_from_unread(info.status, Some(unread_fingerprint));
    let wake = is_wakeable_status(info.status)
        && budget_disposition_with_connection(
            conn,
            run_id,
            MEMBER_REWAKE,
            COORDINATOR_MEMBER_ID,
            &fingerprint,
        )? == BudgetDisposition::Allowed;
    Ok((
        true,
        wake.then(|| COORDINATOR_MEMBER_ID.to_string())
            .into_iter()
            .collect(),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoordinatorNoticeDispatch {
    Inserted,
    ExistingUnread,
    Deferred,
    RecipientUnavailable,
    BudgetSuppressed,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoordinatorRecipientDisposition {
    Available,
    Deferred,
    Unavailable,
}

fn insert_coordinator_stall_notice(
    run_id: &str,
    reason: &str,
    reason_fingerprint: &str,
    expected_work_revision: Option<i64>,
    expected_task_fingerprint: Option<&str>,
    expected_inbox_fingerprint: Option<&str>,
) -> Result<CoordinatorNoticeDispatch, String> {
    with_sessions_writer(|| -> Result<CoordinatorNoticeDispatch, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        // The analyzer plan is advisory. Re-run the pure analyzer against the
        // exact writer snapshot and require the same typed fault set before
        // persisting prose or consuming notice budget. This catches session,
        // intervention, turn-intent, approval and finality changes that do not
        // necessarily bump task work_revision.
        let current_plan = inspect_stalled_run_with_connection(&tx, run_id)?;
        if current_plan.coordinator_repair_fingerprint.as_deref() != Some(reason_fingerprint) {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(CoordinatorNoticeDispatch::Stale);
        }
        let coordinator_runtime: Option<(String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT run.coordinator_agent_id, session.status, session.updated_at
                 FROM agent_org_runs run
                 LEFT JOIN agent_sessions session
                   ON session.session_id=run.root_session_id
                 WHERE run.id=?1 AND run.status='running'",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let Some((coordinator_agent_id, coordinator_status, coordinator_updated_at)) =
            coordinator_runtime
        else {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(CoordinatorNoticeDispatch::Stale);
        };

        let current_work_revision = tx
            .query_row(
                "SELECT work_revision FROM agent_org_run_progress WHERE org_run_id=?1",
                params![run_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if current_work_revision != expected_work_revision {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(CoordinatorNoticeDispatch::Stale);
        }

        if let Some(expected_task_fingerprint) = expected_task_fingerprint {
            let current_tasks =
                agent_org_tasks::AgentOrgTaskStore::list_operational_with_connection(&tx, run_id)?;
            if task_snapshot_fingerprint(&current_tasks) != expected_task_fingerprint {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(CoordinatorNoticeDispatch::Stale);
            }
        }

        if let Some(expected_inbox_fingerprint) = expected_inbox_fingerprint {
            let workers =
                AgentOrgRunStore::list_descendant_worker_sessions_with_connection(&tx, run_id)?;
            let current_repairs =
                unavailable_unread_recipient_repairs_with_connection(&tx, run_id, &workers)?;
            if unread_recipient_repair_snapshot_fingerprint(&current_repairs).as_deref()
                != Some(expected_inbox_fingerprint)
            {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(CoordinatorNoticeDispatch::Stale);
            }
        }

        let coordinator_disposition = match coordinator_status {
            None => CoordinatorRecipientDisposition::Unavailable,
            Some(coordinator_status) => {
                let coordinator_status =
                    SessionStatus::parse(&coordinator_status).ok_or_else(|| {
                        format!(
                            "unknown coordinator session status for run {run_id}: {coordinator_status:?}"
                        )
                    })?;
                let disposition = match coordinator_status {
                    SessionStatus::Pending => {
                        match pending_materialization_disposition(coordinator_updated_at.as_deref())
                        {
                            PendingMaterializationDisposition::Grace => {
                                CoordinatorRecipientDisposition::Deferred
                            }
                            PendingMaterializationDisposition::Expired
                            | PendingMaterializationDisposition::InvalidTimestamp => {
                                CoordinatorRecipientDisposition::Unavailable
                            }
                        }
                    }
                    SessionStatus::Paused | SessionStatus::Archived => {
                        CoordinatorRecipientDisposition::Unavailable
                    }
                    SessionStatus::Idle
                    | SessionStatus::Running
                    | SessionStatus::WaitingForUser
                    | SessionStatus::WaitingForFunds
                    | SessionStatus::Completed
                    | SessionStatus::Failed
                    | SessionStatus::Cancelled
                    | SessionStatus::Abandoned
                    | SessionStatus::Timeout => CoordinatorRecipientDisposition::Available,
                };
                if disposition == CoordinatorRecipientDisposition::Available
                    && matches!(
                        coordinator_status,
                        SessionStatus::Idle
                            | SessionStatus::Completed
                            | SessionStatus::Failed
                            | SessionStatus::Cancelled
                            | SessionStatus::Abandoned
                            | SessionStatus::Timeout
                    )
                {
                    let unread_fingerprint =
                        AgentInboxStore::unread_fingerprint_for_member_with_connection(
                            &tx,
                            COORDINATOR_MEMBER_ID,
                            run_id,
                        )?;
                    if let Some(unread_fingerprint) = unread_fingerprint {
                        let fingerprint = format!("unread:{unread_fingerprint}");
                        if budget_disposition_with_connection(
                            &tx,
                            run_id,
                            MEMBER_REWAKE,
                            COORDINATOR_MEMBER_ID,
                            &fingerprint,
                        )? == BudgetDisposition::Exhausted
                        {
                            CoordinatorRecipientDisposition::Unavailable
                        } else {
                            disposition
                        }
                    } else {
                        disposition
                    }
                } else {
                    disposition
                }
            }
        };
        match coordinator_disposition {
            CoordinatorRecipientDisposition::Deferred => {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(CoordinatorNoticeDispatch::Deferred);
            }
            CoordinatorRecipientDisposition::Unavailable => {
                if !matches!(
                    budget_disposition_with_connection(
                        &tx,
                        run_id,
                        COORDINATOR_NOTICE,
                        "coordinator",
                        reason_fingerprint,
                    )?,
                    BudgetDisposition::Allowed
                ) {
                    tx.commit().map_err(|err| err.to_string())?;
                    return Ok(CoordinatorNoticeDispatch::BudgetSuppressed);
                }
                record_attempt_with_connection(
                    &tx,
                    run_id,
                    COORDINATOR_NOTICE,
                    "coordinator",
                    reason_fingerprint,
                )?;
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(CoordinatorNoticeDispatch::RecipientUnavailable);
            }
            CoordinatorRecipientDisposition::Available => {}
        }

        let coordinator_has_unread: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_inbox
                     WHERE org_run_id=?1
                       AND recipient_member_id=?2
                       AND read_at IS NULL
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                           WHERE resolution.inbox_id=agent_inbox.id
                       )
                 )",
                params![run_id, COORDINATOR_MEMBER_ID],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if coordinator_has_unread {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(CoordinatorNoticeDispatch::ExistingUnread);
        }

        if !matches!(
            budget_disposition_with_connection(
                &tx,
                run_id,
                COORDINATOR_NOTICE,
                "coordinator",
                reason_fingerprint,
            )?,
            BudgetDisposition::Allowed
        ) {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(CoordinatorNoticeDispatch::BudgetSuppressed);
        }

        AgentInboxStore::insert_in_tx(
            &tx,
            InsertInboxParams {
                recipient_agent_id: coordinator_agent_id,
                recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(run_id.to_string()),
                message: AgentMessage::Plain {
                    summary: "Agent Org recovery needed".to_string(),
                    text: format!(
                        "The Agent Org watchdog detected stalled work that needs coordinator repair.\n\n{reason}\n\nUse task_list/task_get to inspect the task board, then use task_update owner_member_id or eligible_member_ids to repair dispatch. Never assign work outside eligible_member_ids."
                    ),
                },
            },
        )?;
        record_attempt_with_connection(
            &tx,
            run_id,
            COORDINATOR_NOTICE,
            "coordinator",
            reason_fingerprint,
        )?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(CoordinatorNoticeDispatch::Inserted)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_inbox::AgentInboxStore;
    use crate::coordination::agent_org_runs::{AgentOrgRunEntryMode, CreateAgentOrgRunParams};
    use crate::coordination::agent_org_tasks::{
        AgentOrgTaskStore, CreateTaskParams, TaskOutput, UpdateTaskPatch,
        TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_EXECUTION_MODE, TASK_METADATA_OUTPUT,
        TASK_METADATA_REQUIRED_ROLE,
    };
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};
    use crate::session::persistence::{session_type, UnifiedSessionRecord};
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingWakeHook {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl InboxWakeHook for RecordingWakeHook {
        fn wake_member(&self, member_id: &str, org_run_id: &str) {
            self.calls
                .lock()
                .expect("recording wake lock")
                .push((member_id.to_string(), org_run_id.to_string()));
        }
    }

    impl RecordingWakeHook {
        fn member_ids(&self) -> Vec<String> {
            self.calls
                .lock()
                .expect("recording wake lock")
                .iter()
                .map(|(member_id, _)| member_id.clone())
                .collect()
        }
    }

    #[test]
    fn wakeable_status_includes_idle_and_terminal_but_not_running() {
        assert!(is_wakeable_status(SessionStatus::Idle));
        assert!(is_wakeable_status(SessionStatus::Failed));
        assert!(!is_wakeable_status(SessionStatus::Running));
    }

    #[test]
    fn delayed_rewake_budget_limits_and_clears_failed_member_retries() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("inbox schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-a";
        assert!(test_only_mark_failed_rewake_attempt(&run_id, member_id).expect("attempt"));
        let failed_fingerprint =
            member_rewake_fingerprint(&run_id, member_id, SessionStatus::Failed)
                .expect("failed fingerprint");
        assert!(!delayed_rewake_allowed(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed,
            &failed_fingerprint,
        )
        .expect("budget"));
        assert!(
            !member_rewake_dispatch_allowed(&run_id, member_id, &failed_fingerprint)
                .expect("dispatcher budget"),
            "the final production dispatcher must share the watchdog backoff"
        );
        let idle_fingerprint = member_rewake_fingerprint(&run_id, member_id, SessionStatus::Idle)
            .expect("idle fingerprint");
        assert!(
            member_rewake_dispatch_allowed(&run_id, member_id, &idle_fingerprint)
                .expect("dispatcher budget"),
            "new durable input/status fingerprints must be dispatchable immediately"
        );
        assert!(delayed_rewake_allowed(
            run_id.as_str(),
            member_id,
            SessionStatus::Idle,
            &idle_fingerprint,
        )
        .expect("budget"));
        clear_rewake_budget(run_id.as_str(), member_id).unwrap();
        assert!(delayed_rewake_allowed(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed,
            "failed",
        )
        .expect("budget"));
    }

    #[test]
    fn member_rewake_reservation_is_atomic_and_refundable() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-reserved";
        let fingerprint = "unread-42";

        let first = match reserve_member_rewake_dispatch(&run_id, member_id, fingerprint)
            .expect("reserve first dispatch")
        {
            MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
            MemberRewakeReservationOutcome::Deferred => panic!("first dispatch must reserve"),
        };
        assert!(matches!(
            reserve_member_rewake_dispatch(&run_id, member_id, fingerprint)
                .expect("concurrent reservation gate"),
            MemberRewakeReservationOutcome::Deferred
        ));
        assert!(refund_member_rewake_reservation(&first).expect("refund failed dispatch"));
        assert!(matches!(
            reserve_member_rewake_dispatch(&run_id, member_id, fingerprint)
                .expect("reserve after refund"),
            MemberRewakeReservationOutcome::Reserved(_)
        ));
    }

    #[test]
    fn stale_rewake_refund_cannot_undo_newer_fingerprint() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-new-input";
        let old = match reserve_member_rewake_dispatch(&run_id, member_id, "unread-1")
            .expect("reserve old fingerprint")
        {
            MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
            MemberRewakeReservationOutcome::Deferred => panic!("old fingerprint must reserve"),
        };
        let current = match reserve_member_rewake_dispatch(&run_id, member_id, "unread-2")
            .expect("new durable input resets budget")
        {
            MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
            MemberRewakeReservationOutcome::Deferred => {
                panic!("new fingerprint must have its own reservation")
            }
        };

        assert!(
            !refund_member_rewake_reservation(&old).expect("stale refund is a safe no-op"),
            "an old dispatch token must not roll back a newer durable input"
        );
        commit_member_rewake_reservation(&current).expect("commit current dispatch");
        assert_eq!(
            budget_disposition(&run_id, MEMBER_REWAKE, member_id, "unread-2")
                .expect("read current budget"),
            BudgetDisposition::Backoff
        );
    }

    #[test]
    fn corrupt_recovery_deadline_does_not_suppress_retry_forever() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
                 (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 1, 'not-a-timestamp', ?5)",
            params![
                "run-corrupt-budget",
                MEMBER_REWAKE,
                "member-a",
                SessionStatus::Failed.as_str(),
                Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();

        assert!(delayed_rewake_allowed(
            "run-corrupt-budget",
            "member-a",
            SessionStatus::Failed,
            "failed",
        )
        .expect("budget"));
    }

    #[test]
    fn corrupt_recovery_attempt_counts_are_normalized_without_overflow() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let elapsed_deadline = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();

        for (target_key, stored_attempts, expected_attempts) in
            [("negative", -7_i64, 1_i64), ("maximum", i64::MAX, 4_i64)]
        {
            conn.execute(
                "INSERT INTO agent_org_recovery_attempts
                     (org_run_id, action_kind, target_key, reason_fingerprint,
                      attempts, next_allowed_at, updated_at)
                 VALUES ('run-corrupt-attempts', ?1, ?2, 'same-fault', ?3, ?4, ?4)",
                params![
                    MEMBER_REWAKE,
                    target_key,
                    stored_attempts,
                    &elapsed_deadline
                ],
            )
            .expect("seed corrupt attempt count");

            record_attempt_with_connection(
                &conn,
                "run-corrupt-attempts",
                MEMBER_REWAKE,
                target_key,
                "same-fault",
            )
            .expect("normalize and record attempt");

            let (attempts, next_allowed_at): (i64, String) = conn
                .query_row(
                    "SELECT attempts, next_allowed_at
                     FROM agent_org_recovery_attempts
                     WHERE org_run_id='run-corrupt-attempts'
                       AND action_kind=?1 AND target_key=?2",
                    params![MEMBER_REWAKE, target_key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read normalized attempt");
            assert_eq!(attempts, expected_attempts);
            assert!(
                DateTime::parse_from_rfc3339(&next_allowed_at)
                    .expect("normalized deadline")
                    .with_timezone(&Utc)
                    > Utc::now(),
                "recording a normalized attempt must restore a valid future deadline"
            );
        }
    }

    #[test]
    fn coordinator_notice_budget_backs_off_and_resets_on_new_reason() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        assert!(coordinator_notice_allowed(&run_id, "task a stuck").expect("notice"));
        assert!(
            !coordinator_notice_allowed(&run_id, "task a stuck").expect("notice"),
            "identical reason must back off instead of nagging every tick"
        );
        assert!(
            coordinator_notice_allowed(&run_id, "task b stuck").expect("notice"),
            "a changed reason means board state moved; budget must reset"
        );
        assert!(!coordinator_notice_allowed(&run_id, "task b stuck").expect("notice"));
    }

    #[test]
    fn rewake_budget_exhausted_only_after_all_attempts_consumed() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-x";
        assert!(!rewake_budget_exhausted(run_id.as_str(), member_id, "failed",).expect("budget"));
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, 'failed', ?4, ?5, ?5)",
            params![run_id, MEMBER_REWAKE, member_id, RECOVERY_DELAYS_SECS.len() as i64, Utc::now().to_rfc3339()],
        )
        .expect("seed exhausted budget");
        assert!(rewake_budget_exhausted(run_id.as_str(), member_id, "failed",).expect("budget"));
        clear_rewake_budget(run_id.as_str(), member_id).unwrap();
        assert!(!rewake_budget_exhausted(run_id.as_str(), member_id, "failed",).expect("budget"));
    }

    #[test]
    fn third_rewake_attempt_stays_in_backoff_until_its_deadline_then_is_exhausted() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-third-attempt";
        let fingerprint = "same-failure";
        let future_deadline = (Utc::now() + ChronoDuration::minutes(15)).to_rfc3339();
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
              next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &run_id,
                MEMBER_REWAKE,
                member_id,
                fingerprint,
                RECOVERY_DELAYS_SECS.len() as i64,
                future_deadline,
                Utc::now().to_rfc3339(),
            ],
        )
        .expect("seed third attempt inside backoff");

        assert_eq!(
            budget_disposition_with_connection(
                &conn,
                &run_id,
                MEMBER_REWAKE,
                member_id,
                fingerprint,
            )
            .expect("budget during third cooldown"),
            BudgetDisposition::Backoff,
            "the accepted third dispatch owns its whole 15-minute cooldown"
        );
        assert!(
            !rewake_budget_exhausted(&run_id, member_id, fingerprint).expect("exhaustion probe"),
            "the third attempt is not exhausted while its cooldown is still active"
        );

        let elapsed_deadline = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
        conn.execute(
            "UPDATE agent_org_recovery_attempts
             SET next_allowed_at=?1, updated_at=?1
             WHERE org_run_id=?2 AND action_kind=?3 AND target_key=?4",
            params![elapsed_deadline, &run_id, MEMBER_REWAKE, member_id],
        )
        .expect("expire third-attempt cooldown");

        assert_eq!(
            budget_disposition_with_connection(
                &conn,
                &run_id,
                MEMBER_REWAKE,
                member_id,
                fingerprint,
            )
            .expect("budget after third cooldown"),
            BudgetDisposition::Exhausted
        );
        assert!(rewake_budget_exhausted(&run_id, member_id, fingerprint)
            .expect("exhaustion probe after deadline"));
    }

    #[test]
    fn prune_recovery_budgets_drops_entries_for_finished_runs() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        let live_run = format!("run-{}", uuid::Uuid::new_v4());
        let dead_run = format!("run-{}", uuid::Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        for (run_id, status) in [
            (&live_run, AgentOrgRunStatus::Running),
            (&dead_run, AgentOrgRunStatus::Completed),
        ] {
            conn.execute(
                "INSERT INTO agent_org_runs
                 (id, org_id, coordinator_agent_id, entry_mode, status, created_at, updated_at)
                 VALUES (?1, 'org', 'coord', 'standalone_session', ?2, ?3, ?3)",
                params![run_id, status.as_str(), now],
            )
            .expect("seed run");
        }
        record_attempt(&live_run, MEMBER_REWAKE, "m", "failed").unwrap();
        record_attempt(&dead_run, MEMBER_REWAKE, "m", "failed").unwrap();
        assert!(coordinator_notice_allowed(&live_run, "reason").expect("notice"));
        assert!(coordinator_notice_allowed(&dead_run, "reason").expect("notice"));

        prune_recovery_budgets().unwrap();

        let count_for = |run_id: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_org_recovery_attempts WHERE org_run_id=?1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(count_for(&live_run), 2);
        assert_eq!(count_for(&dead_run), 0);
    }

    #[test]
    fn maintenance_failures_do_not_skip_healthy_run_scan() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);

        run_best_effort_cleanup("fault injected budget cleanup", || {
            Err("injected budget cleanup failure".to_string())
        });
        run_best_effort_cleanup("fault injected intervention cleanup", || {
            Err("injected intervention cleanup failure".to_string())
        });
        run_best_effort_cleanup("fault injected approval cleanup", || {
            Err("injected approval cleanup failure".to_string())
        });

        let runs = AgentOrgRunStore::list_running_runs(usize::MAX).expect("running runs");
        let mut scanned_run_ids = Vec::new();
        recover_listed_runs((), runs, |(), current_run_id| {
            scanned_run_ids.push(current_run_id.to_string());
            Ok(())
        })
        .expect("healthy scan must continue");

        assert!(scanned_run_ids.contains(&run_id));
    }

    #[test]
    fn one_failed_run_does_not_skip_the_next_run() {
        let _sandbox = test_helpers::test_env::sandbox();
        let first_run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let second_run_id = seed_run_with_workers(&[("member-b", SessionStatus::Idle)]);
        let runs = AgentOrgRunStore::list_running_runs(usize::MAX).expect("running runs");
        let mut scanned_run_ids = Vec::new();

        let error = recover_listed_runs((), runs, |(), current_run_id| {
            scanned_run_ids.push(current_run_id.to_string());
            if current_run_id == first_run_id {
                Err("fault injected per-run recovery failure".to_string())
            } else {
                Ok(())
            }
        })
        .expect_err("the aggregate scan must report the failed run");

        assert!(error.contains(&first_run_id));
        assert!(scanned_run_ids.contains(&first_run_id));
        assert!(scanned_run_ids.contains(&second_run_id));
    }

    #[test]
    fn executor_rechecks_unread_input_and_drops_a_stale_member_wake() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "owned-task",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        seed_unread(&run_id, "member-a");
        let plan = inspect_stalled_run(&run_id).expect("inspect wake plan");
        assert!(plan.wake_member_ids.contains(&"member-a".to_string()));

        let unread = AgentInboxStore::list_unread_for_member("member-a", &run_id)
            .expect("list unread before stale execution");
        AgentInboxStore::mark_many_read(&unread.iter().map(|row| row.id).collect::<Vec<_>>())
            .expect("consume input before executor");
        let wake_hook = RecordingWakeHook::default();
        execute_stall_recovery_plan(&run_id, plan, &wake_hook).expect("execute stale plan");
        assert!(
            !wake_hook.member_ids().contains(&"member-a".to_string()),
            "executor must not wake a member after the analyzed input disappeared"
        );
    }

    #[test]
    fn executor_can_wake_a_member_and_notify_coordinator_in_one_plan() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, "member-a");
        seed_task(
            &run_id,
            "ownerless-task",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("inspect combined plan");
        assert!(plan.wake_member_ids.contains(&"member-a".to_string()));
        assert!(plan.coordinator_repair_reason.is_some());

        let wake_hook = RecordingWakeHook::default();
        execute_stall_recovery_plan(&run_id, plan, &wake_hook).expect("execute combined plan");
        let woken = wake_hook.member_ids();
        assert!(woken.contains(&"member-a".to_string()));
        assert!(woken.contains(&COORDINATOR_MEMBER_ID.to_string()));
    }

    #[test]
    fn successful_terminal_reconcile_stops_all_remaining_plan_actions() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Completed)]);
        let presented = AgentOrgRunStore::stage_coordinator_work_revision(&run_id)
            .expect("stage coordinator revision")
            .expect("running run revision");
        AgentOrgRunStore::mark_coordinator_observed_work_revision(&run_id, presented)
            .expect("observe revision");
        AgentOrgRunStore::request_completion(&run_id, "terminal executor test")
            .expect("request completion");
        let mut plan = inspect_stalled_run(&run_id).expect("inspect terminal plan");
        assert!(plan.terminal_candidate);
        plan.wake_member_ids.push("member-a".to_string());
        plan.coordinator_repair_reason = Some("must not be delivered".to_string());
        plan.coordinator_repair_fingerprint =
            recovery_repair_fingerprint(&[RecoveryRepairFact::marker("must_not_be_delivered")]);

        let wake_hook = RecordingWakeHook::default();
        execute_stall_recovery_plan(&run_id, plan, &wake_hook).expect("execute terminal plan");
        assert!(wake_hook.member_ids().is_empty());
        assert_eq!(
            AgentOrgRunStore::get_run_status(&run_id).expect("run status"),
            Some(AgentOrgRunStatus::Completed)
        );
    }

    #[test]
    fn corrupt_timestamps_count_as_stale() {
        assert!(
            is_stale_in_progress("not-a-timestamp", None),
            "corrupt task timestamp must escalate instead of silently exempting the task"
        );
        let old = (Utc::now()
            - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS * 2))
        .to_rfc3339();
        assert!(is_stale_in_progress(&old, Some(&"garbage".to_string())));
    }

    // ==========================================================
    // DB-backed state-machine tests for inspect_stalled_run
    // ==========================================================

    fn ensure_runtime_schemas() {
        let conn = database::db::get_connection().expect("test sqlite connection");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org tasks schema");
        crate::coordination::agent_org_plan_approvals::init_schema(&conn)
            .expect("agent org plan approvals schema");
        init_schema(&conn).expect("agent org recovery schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
        crate::coordination::agent_member_interventions::init_schema(&conn)
            .expect("agent member interventions schema");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS code_sessions (
                session_id TEXT PRIMARY KEY,
                cli_agent_type TEXT NOT NULL,
                status TEXT NOT NULL,
                parent_session_id TEXT,
                org_member_id TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_turn_intents (
                session_id TEXT NOT NULL,
                turn_intent_id TEXT NOT NULL,
                client_message_id TEXT,
                org_run_id TEXT,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (session_id, turn_intent_id)
            );",
        )
        .expect("cli session schema");
    }

    fn org_definition(member_ids: &[&str]) -> OrgDefinition {
        OrgDefinition {
            id: "org-watchdog".to_string(),
            name: "Watchdog Org".to_string(),
            role: "coordinator".to_string(),
            agent_id: "builtin:coord".to_string(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: member_ids
                .iter()
                .map(|member_id| OrgMember {
                    id: (*member_id).to_string(),
                    name: (*member_id).to_string(),
                    role: "builder".to_string(),
                    agent_id: "builtin:sde".to_string(),
                    runtime_config: None,
                    children: Vec::new(),
                })
                .collect(),
        }
    }

    fn upsert_session(
        session_id: &str,
        session_type_value: &str,
        status: SessionStatus,
        org_member_id: Option<&str>,
        parent_session_id: Option<&str>,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(&UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: session_id.to_string(),
            status: status.as_str().to_string(),
            session_type: session_type_value.to_string(),
            created_at: now.clone(),
            updated_at: now,
            agent_definition_id: Some("builtin:sde".to_string()),
            org_member_id: org_member_id.map(str::to_string),
            parent_session_id: parent_session_id.map(str::to_string),
            ..Default::default()
        })
        .expect("upsert session");
    }

    /// Seed a Running org run with a coordinator root session plus one
    /// worker session per `(member_id, status)` pair. Returns the run id.
    fn seed_run_with_workers(members: &[(&str, SessionStatus)]) -> String {
        ensure_runtime_schemas();
        upsert_session(
            "root-session",
            session_type::GENERIC,
            SessionStatus::Idle,
            None,
            None,
        );
        for (member_id, status) in members {
            upsert_session(
                &format!("session-{member_id}"),
                session_type::ORG_MEMBER,
                *status,
                Some(member_id),
                Some("root-session"),
            );
        }
        let member_ids: Vec<&str> = members.iter().map(|(member_id, _)| *member_id).collect();
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: "org-watchdog".to_string(),
            coordinator_agent_id: "builtin:coord".to_string(),
            root_session_id: Some("root-session".to_string()),
            org_snapshot: org_definition(&member_ids),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create run");
        run.id
    }

    fn seed_task(
        run_id: &str,
        task_id: &str,
        owner: Option<&str>,
        status: TaskStatus,
        eligible: Option<&[&str]>,
    ) {
        if owner.is_none() && status == TaskStatus::Pending && eligible.is_none() {
            let conn = get_connection().expect("db");
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO agent_org_tasks
                 (id, org_run_id, subject, description, status, blocks_json, blocked_by_json, created_at, updated_at)
                 VALUES (?1, ?2, ?1, '', 'pending', '[]', '[]', ?3, ?3)",
                params![task_id, run_id, now],
            )
            .expect("seed historical invalid task");
            return;
        }
        AgentOrgTaskStore::create(CreateTaskParams {
            id: task_id.to_string(),
            org_run_id: run_id.to_string(),
            subject: task_id.to_string(),
            description: String::new(),
            active_form: None,
            owner: owner.map(str::to_string),
            status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: eligible.map(
                |member_ids| serde_json::json!({ TASK_METADATA_ELIGIBLE_MEMBER_IDS: member_ids }),
            ),
        })
        .expect("create task");
    }

    fn seed_unread(run_id: &str, member_id: &str) {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: Some(member_id.to_string()),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(run_id.to_string()),
            message: AgentMessage::Plain {
                summary: "note".to_string(),
                text: "pending note".to_string(),
            },
        })
        .expect("insert unread inbox row");
    }

    fn exhaust_rewake_budget(run_id: &str, member_id: &str) {
        let conn = get_connection().expect("db");
        let fingerprint = member_rewake_fingerprint(run_id, member_id, SessionStatus::Failed)
            .expect("fingerprint");
        let elapsed_deadline = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            ON CONFLICT(org_run_id, action_kind, target_key) DO UPDATE SET
                reason_fingerprint=excluded.reason_fingerprint,
                attempts=excluded.attempts,
                next_allowed_at=excluded.next_allowed_at,
                updated_at=excluded.updated_at",
            params![
                run_id,
                MEMBER_REWAKE,
                member_id,
                fingerprint,
                RECOVERY_DELAYS_SECS.len() as i64,
                elapsed_deadline,
            ],
        )
        .expect("exhaust recovery budget");
    }

    fn set_session_status(session_id: &str, status: SessionStatus) {
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions SET status=?1, updated_at=?2 WHERE session_id=?3",
            params![status.as_str(), Utc::now().to_rfc3339(), session_id],
        )
        .expect("update session status");
    }

    fn assert_unread_count(run_id: &str, member_id: Option<&str>, expected: usize) {
        let counts = AgentInboxStore::run_counts_by_recipient(run_id).expect("recipient counts");
        let actual = counts
            .iter()
            .find(|counts| counts.recipient_member_id.as_deref() == member_id)
            .map(|counts| counts.unread_count)
            .unwrap_or_default();
        assert_eq!(actual, expected);
    }

    #[test]
    fn wakes_idle_member_with_unread_inbox_even_without_assigned_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert!(plan.assignment_actions.is_empty());
        assert!(plan.continuation_actions.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("task board is empty")));
        assert!(!plan.terminal_candidate);
    }

    #[test]
    fn wakeable_and_missing_unread_recipients_are_handled_in_the_same_plan() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Idle),
            ("member-b", SessionStatus::Idle),
        ]);
        let conn = get_connection().expect("db");
        conn.execute(
            "DELETE FROM agent_sessions WHERE session_id='session-member-b'",
            [],
        )
        .expect("remove materialized member-b session");
        seed_unread(&run_id, "member-a");
        seed_unread(&run_id, "member-b");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-b")
                && reason.contains("no materialized session")));
        assert!(plan.coordinator_repair_inbox_fingerprint.is_some());
        assert_unread_count(&run_id, Some("member-b"), 1);
    }

    #[test]
    fn archived_unread_recipient_is_reported_without_faking_a_read() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Archived)]);
        seed_unread(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-a")
                && reason.contains("Archived")
                && reason.contains("preserves those rows as unread")));
        assert_unread_count(&run_id, Some("member-a"), 1);
    }

    #[test]
    fn legacy_unread_without_member_identity_is_never_guessed_from_agent_id() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let conn = get_connection().expect("db");
        conn.execute(
            "INSERT INTO agent_inbox (
                recipient_agent_id, recipient_member_id, sender_agent_id,
                org_run_id, payload_kind, payload_json, created_at
             ) VALUES (?1,NULL,?2,?3,'plain',?4,?5)",
            params![
                "builtin:sde",
                SYSTEM_SENDER_ID,
                &run_id,
                serde_json::to_string(&AgentMessage::Plain {
                    summary: "legacy note".to_string(),
                    text: "recipient identity was not persisted".to_string(),
                })
                .expect("encode legacy payload"),
                Utc::now().to_rfc3339(),
            ],
        )
        .expect("seed legacy unread row");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids.is_empty(),
            "a shared agent definition is not a canonical recipient identity"
        );
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("without recipient_member_id")
                && reason.contains("Do not guess from agent_id")));
        assert_unread_count(&run_id, None, 1);
    }

    #[test]
    fn unread_for_member_outside_immutable_roster_is_reported_as_corrupt_routing() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, "member-ghost");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-ghost")
                && reason.contains("immutable launch roster")));
        assert_unread_count(&run_id, Some("member-ghost"), 1);
    }

    #[test]
    fn pending_unread_recipient_gets_grace_before_repair() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Pending)]);
        seed_unread(&run_id, "member-a");

        let within_grace = inspect_stalled_run(&run_id).expect("inspect within grace");
        assert!(within_grace.wake_member_ids.is_empty());
        assert!(!within_grace
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(
                |reason| reason.contains("member member-a has 1 pending Agent Org Inbox message")
            ));
        assert!(within_grace.coordinator_repair_inbox_fingerprint.is_none());

        let expired = (Utc::now()
            - ChronoDuration::seconds(PENDING_MATERIALIZATION_GRACE_SECS + 1))
        .to_rfc3339();
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions SET updated_at=?1 WHERE session_id='session-member-a'",
            params![expired],
        )
        .expect("expire pending recipient");

        let after_grace = inspect_stalled_run(&run_id).expect("inspect after grace");
        assert!(after_grace
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason
                .contains("member member-a has 1 pending Agent Org Inbox message")
                && reason.contains("materialization grace period")));
        assert!(after_grace.coordinator_repair_inbox_fingerprint.is_some());
    }

    #[test]
    fn unread_repair_fingerprint_does_not_reset_when_only_count_changes() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Archived)]);
        seed_unread(&run_id, "member-a");
        let first = inspect_stalled_run(&run_id).expect("first inspect");

        seed_unread(&run_id, "member-a");
        let second = inspect_stalled_run(&run_id).expect("second inspect");

        assert_ne!(
            first.coordinator_repair_inbox_fingerprint, second.coordinator_repair_inbox_fingerprint,
            "the exact executor snapshot must change when unread count/high-water changes"
        );
        assert_eq!(
            first.coordinator_repair_fingerprint, second.coordinator_repair_fingerprint,
            "human-readable unread counts must not reset coordinator notice budget"
        );
        assert_unread_count(&run_id, Some("member-a"), 2);
    }

    #[test]
    fn unread_groups_for_one_member_are_aggregated_before_repair_or_wake() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Archived)]);
        for recipient_agent_id in ["builtin:sde-old", "builtin:sde-new"] {
            AgentInboxStore::insert(InsertInboxParams {
                recipient_agent_id: recipient_agent_id.to_string(),
                recipient_member_id: Some("member-a".to_string()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(run_id.clone()),
                message: AgentMessage::Plain {
                    summary: "split identity history".to_string(),
                    text: format!("message retained under {recipient_agent_id}"),
                },
            })
            .expect("insert unread row under historical agent definition");
        }

        let conn = get_connection().expect("db");
        let raw_counts =
            AgentInboxStore::unread_counts_by_recipient_with_connection(&conn, &run_id)
                .expect("load raw recipient groups");
        assert_eq!(
            raw_counts.len(),
            2,
            "the fixture must exercise two persisted agent-id groups"
        );
        let workers =
            AgentOrgRunStore::list_descendant_worker_sessions_with_connection(&conn, &run_id)
                .expect("load canonical workers");
        let repairs = unavailable_unread_recipient_repairs_from_counts_with_connection(
            &conn,
            &run_id,
            &workers,
            &raw_counts,
        )
        .expect("classify unavailable recipients");
        assert_eq!(
            repairs.len(),
            1,
            "member_id is the delivery identity; historical agent ids must not create two repairs"
        );
        assert_eq!(repairs[0].recipient_member_id.as_deref(), Some("member-a"));
        assert_eq!(repairs[0].unread_count, 2);
        assert_eq!(
            repairs[0].recipient_agent_id, "builtin:sde-new,builtin:sde-old",
            "diagnostics retain a deterministic union of the historical agent ids"
        );
        assert!(unread_recipient_repair_snapshot_fingerprint(&repairs).is_some());

        let archived = inspect_stalled_run(&run_id).expect("inspect archived recipient");
        let archived_reason = archived
            .coordinator_repair_reason
            .as_deref()
            .expect("archived member needs repair");
        assert_eq!(
            archived_reason
                .matches("member member-a has 2 pending Agent Org Inbox message")
                .count(),
            1,
            "the coordinator receives one aggregate diagnosis, not one per agent id"
        );

        set_session_status("session-member-a", SessionStatus::Idle);
        let recovered = inspect_stalled_run(&run_id).expect("inspect recovered recipient");
        assert_eq!(
            recovered.wake_member_ids,
            vec!["member-a".to_string()],
            "the recovered member is woken once for both durable rows"
        );
        assert!(!recovered
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-a has")));
    }

    #[test]
    fn unread_repair_fingerprint_cannot_collide_through_field_separators() {
        let left = UnreadRecipientRepair {
            recipient_member_id: Some("member:a".to_string()),
            recipient_agent_id: "agent:b".to_string(),
            unread_count: 1,
            max_unread_id: 1,
            reason: UnreadRecipientUnavailableReason::MissingSession,
        };
        let right = UnreadRecipientRepair {
            recipient_member_id: Some("member".to_string()),
            recipient_agent_id: "a:agent:b".to_string(),
            unread_count: 1,
            max_unread_id: 1,
            reason: UnreadRecipientUnavailableReason::MissingSession,
        };

        assert_ne!(left.stable_key(), right.stable_key());
    }

    #[test]
    fn repair_set_fingerprint_cannot_collide_across_field_or_set_boundaries() {
        let left = vec![
            RecoveryRepairFact::new(
                "stale_owner",
                [Some("task|member".to_string()), Some("peer".to_string())],
            ),
            RecoveryRepairFact::new("marker", [Some("tail".to_string())]),
        ];
        let right = vec![
            RecoveryRepairFact::new(
                "stale_owner",
                [Some("task".to_string()), Some("member|peer".to_string())],
            ),
            RecoveryRepairFact::new("marker", [Some("tail".to_string())]),
        ];
        assert_ne!(
            recovery_repair_fingerprint(&left),
            recovery_repair_fingerprint(&right)
        );
    }

    #[test]
    fn corrupt_task_identity_change_resets_repair_fingerprint_at_same_count() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let conn = get_connection().expect("db");
        let now = Utc::now().to_rfc3339();
        let insert_corrupt = |task_id: &str| {
            conn.execute(
                "INSERT INTO agent_org_tasks
                 (id, org_run_id, subject, description, owner, status, blocks_json,
                  blocked_by_json, metadata_json, created_at, updated_at)
                 VALUES (?1, ?2, 'corrupt', '', NULL, 'pending', '[]', '[]', '{', ?3, ?3)",
                params![task_id, &run_id, &now],
            )
            .expect("insert corrupt task");
        };
        insert_corrupt("bad|task:a");
        let first = inspect_stalled_run(&run_id).expect("inspect first corruption");
        conn.execute(
            "DELETE FROM agent_org_tasks WHERE org_run_id=?1 AND id='bad|task:a'",
            params![&run_id],
        )
        .expect("remove first corruption");
        insert_corrupt("bad:task|b");
        let second = inspect_stalled_run(&run_id).expect("inspect second corruption");

        assert_ne!(
            first.coordinator_repair_fingerprint, second.coordinator_repair_fingerprint,
            "a different corrupt row must reset the notice budget even when count stays one"
        );
    }

    #[test]
    fn typed_task_output_is_valid_for_finality_and_survives_summary_projection() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let produced_at = "2026-07-17T08:09:10Z".to_string();
        let output = TaskOutput {
            summary: "implementation and verification complete".to_string(),
            content: Some("full durable handoff".to_string()),
            artifact_ids: vec!["artifact://report.md".to_string()],
            produced_by_member_id: "member-a".to_string(),
            produced_at: produced_at.clone(),
        };
        let mut params = CreateTaskParams {
            id: "typed-output-task".to_string(),
            org_run_id: run_id.clone(),
            subject: "Typed output".to_string(),
            description: "Verify the canonical durable output shape".to_string(),
            active_form: None,
            owner: Some("member-a".to_string()),
            status: TaskStatus::Completed,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-a"],
            })),
        };
        params
            .metadata
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
            .expect("task metadata object")
            .insert(
                TASK_METADATA_OUTPUT.to_string(),
                serde_json::to_value(&output).expect("serialize TaskOutput"),
            );
        AgentOrgTaskStore::create(params).expect("create completed task with typed output");

        let conn = get_connection().expect("db");
        let raw_metadata: String = conn
            .query_row(
                "SELECT metadata_json FROM agent_org_tasks WHERE org_run_id=?1 AND id=?2",
                params![&run_id, "typed-output-task"],
                |row| row.get(0),
            )
            .expect("raw task metadata");
        assert!(raw_metadata.contains("\"artifactIds\""));
        assert!(raw_metadata.contains("\"producedByMemberId\""));
        assert!(raw_metadata.contains("\"producedAt\""));
        assert!(!raw_metadata.contains("\"artifact_ids\""));

        let finality = AgentOrgRunStore::finality_assessment_with_connection(&conn, &run_id)
            .expect("assess finality");
        assert_eq!(
            finality.facts.corrupt_task_count, 0,
            "the SQL predicate must accept serde's canonical camelCase TaskOutput"
        );
        assert!(
            corrupt_task_repair_facts(&conn, &run_id)
                .expect("watchdog corrupt facts")
                .is_empty(),
            "watchdog and finality must agree that the typed row is healthy"
        );

        let page = AgentOrgTaskStore::list_summary_page_with_connection(
            &conn, &run_id, None, None, None, 10,
        )
        .expect("summary page");
        let summary = page
            .tasks
            .iter()
            .find(|task| task.id == "typed-output-task")
            .expect("typed task summary");
        let summary_output = summary.output.as_ref().expect("summary output");
        assert_eq!(summary_output.summary, output.summary);
        assert_eq!(summary_output.artifact_ids, output.artifact_ids);
        assert_eq!(
            summary_output.produced_by_member_id.as_deref(),
            Some("member-a")
        );
        assert_eq!(
            summary_output.produced_at.as_deref(),
            Some(produced_at.as_str())
        );
        assert!(summary_output.has_content);
    }

    #[test]
    fn finality_and_watchdog_share_corrupt_task_predicate_for_bounded_fields() {
        use crate::coordination::agent_org_payload_limits as limits;

        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let conn = get_connection().expect("db");
        let now = Utc::now().to_rfc3339();
        let long_dependency_ids = (0..9)
            .map(|index| format!("{index}-{}", "x".repeat(899)))
            .collect::<Vec<_>>();
        assert!(
            long_dependency_ids
                .iter()
                .map(|id| id.chars().count())
                .sum::<usize>()
                > limits::TASK_DEPENDENCY_TOTAL_MAX_CHARS
        );
        let valid_output = |content: String| {
            serde_json::json!({
                "summary": "done",
                "content": content,
                "artifactIds": [],
                "producedByMemberId": "member-a",
                "producedAt": now.clone(),
            })
        };
        let cases = vec![
            (
                "oversized-metadata",
                "pending",
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!({
                    "padding": "x".repeat(limits::TASK_METADATA_MAX_BYTES + 1),
                }),
            ),
            (
                "oversized-output",
                "completed",
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!({
                    TASK_METADATA_OUTPUT: valid_output(
                        "x".repeat(limits::TASK_OUTPUT_CONTENT_MAX_CHARS + 1)
                    ),
                }),
            ),
            (
                "oversized-blocks",
                "pending",
                serde_json::to_value(&long_dependency_ids).expect("blocks json"),
                serde_json::json!([]),
                serde_json::json!({}),
            ),
            (
                "oversized-blocked-by",
                "pending",
                serde_json::json!([]),
                serde_json::to_value(&long_dependency_ids).expect("blocked_by json"),
                serde_json::json!({}),
            ),
            (
                "oversized-required-role",
                "pending",
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!({
                    TASK_METADATA_REQUIRED_ROLE:
                        "r".repeat(limits::TASK_REQUIRED_ROLE_MAX_CHARS + 1),
                }),
            ),
            (
                "invalid-execution-mode",
                "pending",
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "observe" }),
            ),
        ];

        for (task_id, status, blocks, blocked_by, metadata) in &cases {
            conn.execute(
                "INSERT INTO agent_org_tasks
                 (id, org_run_id, subject, description, owner, status, blocks_json,
                  blocked_by_json, metadata_json, created_at, updated_at)
                 VALUES (?1, ?2, ?1, '', 'member-a', ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    task_id,
                    &run_id,
                    status,
                    blocks.to_string(),
                    blocked_by.to_string(),
                    metadata.to_string(),
                    &now,
                ],
            )
            .unwrap_or_else(|error| panic!("insert {task_id}: {error}"));
        }

        let finality = AgentOrgRunStore::finality_assessment_with_connection(&conn, &run_id)
            .expect("assess corrupt task rows");
        let repair_facts =
            corrupt_task_repair_facts(&conn, &run_id).expect("watchdog corrupt repair facts");
        assert_eq!(finality.facts.corrupt_task_count, cases.len());
        assert_eq!(
            repair_facts.len(),
            cases.len(),
            "every row counted by finality must have one concrete watchdog repair identity"
        );
        assert!(
            repair_facts
                .iter()
                .all(|fact| fact.kind == "corrupt_task_data"),
            "the test remains below the separate run-level task-count limit"
        );
    }

    #[test]
    fn missing_dependency_is_typed_repair_without_wake_or_terminal_transition() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let conn = get_connection().expect("db");
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agent_org_tasks
             (id, org_run_id, subject, description, owner, status, blocks_json,
              blocked_by_json, metadata_json, created_at, updated_at)
             VALUES ('dependent', ?1, 'Dependent', '', 'member-a', 'pending', '[]',
                     '[\"missing-task\"]', '{}', ?2, ?2)",
            params![&run_id, now],
        )
        .expect("insert task with missing dependency");

        let plan = inspect_stalled_run(&run_id).expect("inspect missing dependency");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan.assignment_actions.is_empty());
        assert!(plan.continuation_actions.is_empty());
        assert!(!plan.terminal_candidate);
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| {
                reason.contains("dependency reference") && reason.contains("missing-task")
            }));
        let mut reasons = Vec::new();
        let mut facts = Vec::new();
        let tasks = AgentOrgTaskStore::list_operational_with_connection(&conn, &run_id)
            .expect("operational tasks");
        append_dependency_integrity_repairs(&tasks, &mut reasons, &mut facts);
        assert!(
            facts
                .iter()
                .any(|fact| fact.kind == "missing_dependency_edges"),
            "repair fingerprint must use a typed graph-integrity fact"
        );
    }

    #[test]
    fn dependency_cycle_is_typed_repair_without_wake_or_terminal_transition() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        let conn = get_connection().expect("db");
        let now = Utc::now().to_rfc3339();
        for (task_id, blocker_id) in [("cycle-a", "cycle-b"), ("cycle-b", "cycle-a")] {
            conn.execute(
                "INSERT INTO agent_org_tasks
                 (id, org_run_id, subject, description, owner, status, blocks_json,
                  blocked_by_json, metadata_json, created_at, updated_at)
                 VALUES (?1, ?2, ?1, '', 'member-a', 'pending', '[]', ?3, '{}', ?4, ?4)",
                params![
                    task_id,
                    &run_id,
                    serde_json::json!([blocker_id]).to_string(),
                    &now
                ],
            )
            .unwrap_or_else(|error| panic!("insert {task_id}: {error}"));
        }

        let plan = inspect_stalled_run(&run_id).expect("inspect dependency cycle");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan.assignment_actions.is_empty());
        assert!(plan.continuation_actions.is_empty());
        assert!(!plan.terminal_candidate);
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("dependency graph contains a cycle")));
        let mut reasons = Vec::new();
        let mut facts = Vec::new();
        let tasks = AgentOrgTaskStore::list_operational_with_connection(&conn, &run_id)
            .expect("operational tasks");
        append_dependency_integrity_repairs(&tasks, &mut reasons, &mut facts);
        assert!(
            facts.iter().any(|fact| fact.kind == "dependency_cycle"),
            "repair fingerprint must use a typed cycle fact"
        );
    }

    #[test]
    fn paused_unread_recipient_is_escalated_without_wake() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Paused)]);
        seed_unread(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect paused recipient");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-a")
                && reason.contains("administratively Paused")));
        assert!(plan.coordinator_repair_inbox_fingerprint.is_some());
        assert_unread_count(&run_id, Some("member-a"), 1);
    }

    #[test]
    fn pending_unread_recipient_with_invalid_timestamp_is_escalated() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Pending)]);
        seed_unread(&run_id, "member-a");
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions SET updated_at='not-a-timestamp' WHERE session_id='session-member-a'",
            [],
        )
        .expect("corrupt pending timestamp");

        let plan = inspect_stalled_run(&run_id).expect("inspect invalid pending timestamp");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-a")
                && reason.contains("missing or invalid timestamp")));
        assert!(plan.coordinator_repair_inbox_fingerprint.is_some());
        assert_unread_count(&run_id, Some("member-a"), 1);
    }

    #[test]
    fn stale_unread_repair_is_dropped_when_recipient_recovers_before_commit() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Archived)]);
        seed_unread(&run_id, "member-a");
        let plan = inspect_stalled_run(&run_id).expect("analyze unavailable recipient");
        let reason = plan
            .coordinator_repair_reason
            .as_deref()
            .expect("unavailable recipient needs repair");

        set_session_status("session-member-a", SessionStatus::Idle);

        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                reason,
                plan.coordinator_repair_fingerprint
                    .as_deref()
                    .expect("repair fingerprint"),
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("recheck stale recipient repair"),
            CoordinatorNoticeDispatch::Stale
        );
        assert!(
            !has_unread_for_member(&run_id, COORDINATOR_MEMBER_ID).expect("coordinator unread"),
            "a repaired recipient must not receive stale coordinator guidance"
        );
        assert_unread_count(&run_id, Some("member-a"), 1);
    }

    #[test]
    fn active_worker_does_not_hide_an_unavailable_unread_peer() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Running),
            ("member-b", SessionStatus::Archived),
        ]);
        seed_unread(&run_id, "member-b");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids.is_empty(),
            "E3 still suppresses peer wake"
        );
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(
                |reason| reason.contains("member member-b") && reason.contains("Archived")
            ));
    }

    #[test]
    fn exhausted_unread_only_recipient_escalates_instead_of_disappearing() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_unread(&run_id, "member-a");
        exhaust_rewake_budget(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member member-a")
                && reason.contains("Wake attempts")
                && reason.contains("exhausted")));
        assert_unread_count(&run_id, Some("member-a"), 1);
    }

    #[test]
    fn exhausted_coordinator_unread_is_diagnosed_without_a_wake_or_notice_treadmill() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        set_session_status("root-session", SessionStatus::Failed);
        seed_unread(&run_id, COORDINATOR_MEMBER_ID);
        exhaust_rewake_budget(&run_id, COORDINATOR_MEMBER_ID);

        let plan = inspect_stalled_run(&run_id).expect("inspect exhausted coordinator");
        assert!(
            !plan
                .wake_member_ids
                .contains(&COORDINATOR_MEMBER_ID.to_string()),
            "an exhausted coordinator must not be scheduled for another wake"
        );
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member coordinator")
                && reason.contains("Wake attempts")
                && reason.contains("exhausted")));

        let wake_hook = RecordingWakeHook::default();
        execute_stall_recovery_plan(&run_id, plan.clone(), &wake_hook)
            .expect("record unavailable coordinator diagnosis");
        execute_stall_recovery_plan(&run_id, plan, &wake_hook)
            .expect("repeat exhausted coordinator diagnosis");
        assert!(
            wake_hook.member_ids().is_empty(),
            "neither the unread row nor its self-repair notice may wake an exhausted coordinator"
        );
        assert_unread_count(&run_id, Some(COORDINATOR_MEMBER_ID), 1);

        let conn = get_connection().expect("db");
        let (notice_attempts, total_coordinator_rows): (i64, i64) = (
            conn.query_row(
                "SELECT attempts FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key='coordinator'",
                params![&run_id, COORDINATOR_NOTICE],
                |row| row.get(0),
            )
            .expect("unavailable coordinator diagnosis budget"),
            conn.query_row(
                "SELECT COUNT(*) FROM agent_inbox
                 WHERE org_run_id=?1 AND recipient_member_id=?2",
                params![&run_id, COORDINATOR_MEMBER_ID],
                |row| row.get(0),
            )
            .expect("coordinator inbox row count"),
        );
        assert_eq!(notice_attempts, 1, "repeat scans must stay in backoff");
        assert_eq!(
            total_coordinator_rows, 1,
            "the system must preserve the original unread row without adding an undeliverable self-notice"
        );
    }

    #[test]
    fn unread_recipient_inside_rewake_backoff_waits_without_escalating() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "member-a-open-work",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        seed_unread(&run_id, "member-a");
        assert!(test_only_mark_failed_rewake_attempt(&run_id, "member-a").expect("attempt"));

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(
            plan.coordinator_repair_reason.is_none(),
            "backoff-only unread must not escalate: {plan:#?}"
        );
        assert!(plan.coordinator_repair_inbox_fingerprint.is_none());
        assert_unread_count(&run_id, Some("member-a"), 1);
    }

    #[test]
    fn archived_coordinator_unread_does_not_suppress_run_diagnostic() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        set_session_status("root-session", SessionStatus::Archived);
        seed_unread(&run_id, COORDINATOR_MEMBER_ID);

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(!plan
            .wake_member_ids
            .contains(&COORDINATOR_MEMBER_ID.to_string()));
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(
                |reason| reason.contains("member coordinator") && reason.contains("Archived")
            ));
        let reason = plan
            .coordinator_repair_reason
            .as_deref()
            .expect("coordinator diagnostic");
        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                reason,
                plan.coordinator_repair_fingerprint
                    .as_deref()
                    .expect("repair fingerprint"),
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("dispatch unavailable coordinator diagnostic"),
            CoordinatorNoticeDispatch::RecipientUnavailable
        );
        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                reason,
                plan.coordinator_repair_fingerprint
                    .as_deref()
                    .expect("repair fingerprint"),
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("retry unavailable coordinator diagnostic"),
            CoordinatorNoticeDispatch::BudgetSuppressed,
            "the first unavailable dispatch and its budget record commit atomically"
        );
        let conn = get_connection().expect("db");
        let attempts: i64 = conn
            .query_row(
                "SELECT attempts FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key='coordinator'",
                params![&run_id, COORDINATOR_NOTICE],
                |row| row.get(0),
            )
            .expect("coordinator notice attempt");
        assert_eq!(attempts, 1);
        assert_unread_count(&run_id, Some(COORDINATOR_MEMBER_ID), 1);
    }

    #[test]
    fn healthy_coordinator_notice_insert_and_budget_commit_atomically() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "ownerless-for-notice-budget",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("inspect repair");
        let reason = plan
            .coordinator_repair_reason
            .as_deref()
            .expect("ownerless task needs coordinator repair");
        let fingerprint = plan
            .coordinator_repair_fingerprint
            .as_deref()
            .expect("repair fingerprint");

        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                reason,
                fingerprint,
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("insert coordinator notice"),
            CoordinatorNoticeDispatch::Inserted
        );
        let first_notice = AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, &run_id)
            .expect("list coordinator notice");
        assert_eq!(first_notice.len(), 1);
        AgentInboxStore::mark_many_read(&[first_notice[0].id]).expect("read first notice");

        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                reason,
                fingerprint,
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("retry coordinator notice"),
            CoordinatorNoticeDispatch::BudgetSuppressed
        );
        let conn = get_connection().expect("db");
        let (attempts, total_notices): (i64, i64) = (
            conn.query_row(
                "SELECT attempts FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key='coordinator'",
                params![&run_id, COORDINATOR_NOTICE],
                |row| row.get(0),
            )
            .expect("coordinator notice attempt"),
            conn.query_row(
                "SELECT COUNT(*) FROM agent_inbox
                 WHERE org_run_id=?1 AND recipient_member_id=?2",
                params![&run_id, COORDINATOR_MEMBER_ID],
                |row| row.get(0),
            )
            .expect("coordinator notice count"),
        );
        assert_eq!(attempts, 1);
        assert_eq!(total_notices, 1);
    }

    #[test]
    fn missing_coordinator_unread_is_diagnosed_and_budgeted_without_fake_delivery() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, COORDINATOR_MEMBER_ID);
        let conn = get_connection().expect("db");
        conn.execute(
            "DELETE FROM agent_sessions WHERE session_id='root-session'",
            [],
        )
        .expect("remove coordinator session");

        let plan = inspect_stalled_run(&run_id).expect("inspect missing coordinator");
        assert!(!plan
            .wake_member_ids
            .contains(&COORDINATOR_MEMBER_ID.to_string()));
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("member coordinator")
                && reason.contains("no materialized session")));
        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                plan.coordinator_repair_reason
                    .as_deref()
                    .expect("repair reason"),
                plan.coordinator_repair_fingerprint
                    .as_deref()
                    .expect("repair fingerprint"),
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("record unavailable coordinator diagnostic"),
            CoordinatorNoticeDispatch::RecipientUnavailable
        );
        assert_unread_count(&run_id, Some(COORDINATOR_MEMBER_ID), 1);
    }

    #[test]
    fn wakes_terminal_member_that_still_owns_open_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "owned-retry",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert_eq!(plan.coordinator_repair_reason, None);
    }

    #[test]
    fn recreates_typed_assignment_for_idle_owner_when_delivery_was_lost() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "missed-assignment",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert_eq!(plan.assignment_actions.len(), 1);
        assert_eq!(
            plan.assignment_actions[0].task_ids,
            vec!["missed-assignment"]
        );
        assert!(plan.continuation_actions.is_empty());
    }

    #[test]
    fn pending_plan_approval_is_intentionally_quiet_not_stale_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "plan-awaiting-user".to_string(),
            org_run_id: run_id.clone(),
            subject: "Plan before build".to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-a".to_string()),
            status: TaskStatus::InProgress,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                agent_org_tasks::TASK_METADATA_EXECUTION_MODE: "plan"
            })),
        })
        .expect("create planning task");
        crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore::create_pending(
            crate::coordination::agent_org_plan_approvals::CreateAgentOrgPlanApprovalParams {
                request_id: "request-awaiting-user".to_string(),
                org_run_id: run_id.clone(),
                source_task_id: "plan-awaiting-user".to_string(),
                source_member_id: "member-a".to_string(),
                source_session_id: "session-member-a".to_string(),
                root_session_id: "root-session".to_string(),
                policy: PlanApprovalPolicy::User,
                plan_title: "Plan".to_string(),
                plan_path: crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore::managed_plan_path_for_session(
                    "session-member-a",
                    "plan-awaiting-user.plan.md",
                )
                .expect("managed awaiting-user plan path")
                .to_string_lossy()
                .into_owned(),
                plan_content: "# Plan".to_string(),
            },
        )
        .expect("create pending approval");
        let stale = (Utc::now()
            - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS * 2))
        .to_rfc3339();
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_org_tasks SET updated_at=?1 WHERE id='plan-awaiting-user'",
            params![stale],
        )
        .unwrap();

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.is_noop(),
            "pending approval must wait without model turns"
        );
    }

    #[test]
    fn owned_work_waits_during_backoff_then_escalates_only_when_exhausted() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "owned-retry",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        assert!(test_only_mark_failed_rewake_attempt(&run_id, "member-a").expect("attempt"));

        let backoff = inspect_stalled_run(&run_id).expect("inspect backoff");
        assert!(backoff.wake_member_ids.is_empty());
        assert!(backoff.coordinator_repair_reason.is_none());

        exhaust_rewake_budget(&run_id, "member-a");
        let exhausted = inspect_stalled_run(&run_id).expect("inspect exhausted");
        assert!(exhausted.wake_member_ids.is_empty());
        assert!(exhausted
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("automatic retry budget is exhausted")));
    }

    #[test]
    fn unread_member_wakes_but_ownerless_peer_work_waits_for_coordinator() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Idle),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_unread(&run_id, "member-a");
        seed_task(
            &run_id,
            "claim-me",
            None,
            TaskStatus::Pending,
            Some(&["member-b"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids.contains(&"member-a".to_string()),
            "unread member must be woken (missed delivery), got {:?}",
            plan.wake_member_ids
        );
        assert!(!plan.wake_member_ids.contains(&"member-b".to_string()));
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("claim-me") && reason.contains("no owner")));
    }

    #[test]
    fn wakes_coordinator_with_unread_inbox() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, COORDINATOR_MEMBER_ID);
        // Keep one open task so the run is not a terminal candidate.
        seed_task(&run_id, "open", Some("member-a"), TaskStatus::Pending, None);

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids
                .contains(&COORDINATOR_MEMBER_ID.to_string()),
            "idle coordinator with unread inbox must be redelivered, got {:?}",
            plan.wake_member_ids
        );
    }

    #[test]
    fn escalates_ownerless_task_without_waking_failed_candidate() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "stuck",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        exhaust_rewake_budget(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        let reason = plan
            .coordinator_repair_reason
            .expect("exhausted eligible members must escalate to the coordinator");
        assert!(reason.contains("stuck"));
        assert!(reason.contains("member-a"));
        assert!(!plan.terminal_candidate);
    }

    #[test]
    fn ownerless_task_still_requires_coordinator_during_member_backoff() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "retry-later",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        // One consumed attempt: inside the backoff window, not exhausted.
        assert!(test_only_mark_failed_rewake_attempt(&run_id, "member-a").expect("attempt"));

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids.is_empty(),
            "member is inside its backoff window"
        );
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("retry-later") && reason.contains("no owner")));
    }

    #[test]
    fn escalates_unowned_task_without_eligibility_list() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(&run_id, "orphan", None, TaskStatus::Pending, None);

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        let reason = plan
            .coordinator_repair_reason
            .expect("unowned task without eligibility must escalate");
        assert!(reason.contains("orphan"));
        assert!(reason.contains("no eligible_member_ids"));
    }

    #[test]
    fn reports_terminal_candidate_when_everything_resolved() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Completed)]);
        seed_task(
            &run_id,
            "done",
            Some("member-a"),
            TaskStatus::Completed,
            None,
        );
        let revision = AgentOrgRunStore::stage_coordinator_work_revision(&run_id)
            .expect("stage work revision")
            .expect("running run has a work revision");
        AgentOrgRunStore::mark_coordinator_observed_work_revision(&run_id, revision)
            .expect("observe work revision");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.terminal_candidate);
        assert!(plan.wake_member_ids.is_empty());
        assert_eq!(plan.coordinator_repair_reason, None);
    }

    #[test]
    fn active_worker_keeps_run_untouched() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Running),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_unread(&run_id, "member-b");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.is_noop(),
            "any active worker keeps the watchdog hands-off (known limitation, issue #272 E3)"
        );
    }

    #[test]
    fn stale_cli_duplicate_cannot_make_idle_rust_member_look_active_to_watchdog() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, "member-a");
        let conn = get_connection().expect("db");
        let rust_timestamp = "2026-07-17T10:00:01Z";
        conn.execute(
            "UPDATE agent_sessions SET updated_at=?1 WHERE session_id='session-member-a'",
            params![rust_timestamp],
        )
        .expect("stamp current Rust session");
        conn.execute(
            "INSERT INTO code_sessions
             (session_id, cli_agent_type, status, parent_session_id, org_member_id, updated_at)
             VALUES ('stale-cli-member-a', 'claude_code', 'running', 'root-session',
                     'member-a', '2026-07-17T10:00:00Z')",
            [],
        )
        .expect("seed older unsupported duplicate");

        let newer_rust = inspect_stalled_run(&run_id).expect("inspect newer Rust runtime");
        assert_eq!(
            newer_rust.wake_member_ids,
            vec!["member-a".to_string()],
            "the stale CLI Running row must not trigger the run-level active-worker early return"
        );
        assert!(!newer_rust
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("transport is unsupported")));

        conn.execute(
            "UPDATE code_sessions SET updated_at=?1 WHERE session_id='stale-cli-member-a'",
            params![rust_timestamp],
        )
        .expect("create exact timestamp tie");
        let tied = inspect_stalled_run(&run_id).expect("inspect cross-transport tie");
        assert_eq!(
            tied.wake_member_ids,
            vec!["member-a".to_string()],
            "Rust must also win an exact timestamp tie"
        );
        assert!(!tied
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("transport is unsupported")));
    }

    #[test]
    fn stale_running_owner_only_generates_coordinator_notice() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Running),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_task(
            &run_id,
            "stale-owned",
            Some("member-a"),
            TaskStatus::InProgress,
            Some(&["member-a", "member-b"]),
        );
        seed_task(
            &run_id,
            "ownerless-awaiting-assignment",
            None,
            TaskStatus::Pending,
            Some(&["member-b"]),
        );
        let old = (Utc::now()
            - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS + 1))
        .to_rfc3339();
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions SET updated_at=?1 WHERE session_id='session-member-a'",
            params![&old],
        )
        .unwrap();
        conn.execute(
            "UPDATE agent_org_tasks SET updated_at=?1 WHERE org_run_id=?2 AND id='stale-owned'",
            params![&old, &run_id],
        )
        .unwrap();

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty(), "E3 suppresses peer wake");
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("stale-owned")));
    }

    #[test]
    fn paused_only_eligible_member_escalates_instead_of_waking() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Paused)]);
        seed_task(
            &run_id,
            "paused-work",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("paused-work")));
    }

    #[test]
    fn paused_owner_is_never_woken_and_requires_explicit_coordinator_repair() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Paused)]);
        seed_task(
            &run_id,
            "paused-owned-work",
            Some("member-a"),
            TaskStatus::InProgress,
            Some(&["member-a"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("administratively paused member member-a")));
    }

    #[test]
    fn ownerless_task_waits_for_coordinator_even_when_candidate_is_pending() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Pending)]);
        seed_task(
            &run_id,
            "pending-work",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("pending-work")));
    }

    #[test]
    fn pending_owner_gets_materialization_grace_then_requires_repair() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Pending)]);
        seed_task(
            &run_id,
            "pending-owned-work",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );

        let within_grace = inspect_stalled_run(&run_id).expect("inspect within grace");
        assert!(within_grace.wake_member_ids.is_empty());
        assert_eq!(within_grace.coordinator_repair_reason, None);

        let expired = (Utc::now()
            - ChronoDuration::seconds(PENDING_MATERIALIZATION_GRACE_SECS + 1))
        .to_rfc3339();
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions SET updated_at=?1 WHERE session_id='session-member-a'",
            params![expired],
        )
        .expect("expire Pending session");

        let after_grace = inspect_stalled_run(&run_id).expect("inspect after grace");
        assert!(after_grace.wake_member_ids.is_empty());
        assert!(after_grace
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("materialization grace period")));

        conn.execute(
            "UPDATE agent_sessions SET updated_at='not-a-timestamp' WHERE session_id='session-member-a'",
            [],
        )
        .expect("corrupt Pending session timestamp");
        let invalid_timestamp = inspect_stalled_run(&run_id).expect("inspect invalid timestamp");
        assert!(invalid_timestamp
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("timestamp is missing or invalid")));
    }

    #[test]
    fn historical_cli_member_is_escalated_instead_of_rust_woken() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_runtime_schemas();
        upsert_session(
            "root-session",
            session_type::GENERIC,
            SessionStatus::Idle,
            None,
            None,
        );
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: "org-watchdog".to_string(),
            coordinator_agent_id: "builtin:coord".to_string(),
            root_session_id: Some("root-session".to_string()),
            org_snapshot: org_definition(&["member-cli"]),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .unwrap();
        let conn = get_connection().unwrap();
        conn.execute(
            "INSERT INTO code_sessions
             (session_id, cli_agent_type, status, parent_session_id, org_member_id, updated_at)
             VALUES ('cli-session', 'claude_code', 'idle', 'root-session', 'member-cli', ?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        seed_task(
            &run.id,
            "cli-owned",
            Some("member-cli"),
            TaskStatus::Pending,
            Some(&["member-cli"]),
        );
        seed_unread(&run.id, "member-cli");

        let plan = inspect_stalled_run(&run.id).unwrap();
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("transport is unsupported")
                && reason.contains("member member-cli has 1 pending Agent Org Inbox message")
                && reason.contains("historical CLI member")));
        assert_unread_count(&run.id, Some("member-cli"), 1);
    }

    fn dispatch_analyzed_assignment(run_id: &str, task_id: &str, member_id: &str) -> Option<i64> {
        agent_org_tasks::enqueue_task_assigned_if_still_ready_for_recovery(
            run_id,
            task_id,
            "builtin:sde",
            member_id,
            SYSTEM_SENDER_ID,
            None,
            "Agent Org recovery",
        )
        .expect("dispatch recovery assignment")
    }

    fn unread_assignment_count(run_id: &str, member_id: &str) -> usize {
        AgentInboxStore::list_unread_for_member(member_id, run_id)
            .expect("list unread")
            .into_iter()
            .filter(|row| row.payload_kind == "task_assigned")
            .count()
    }

    #[test]
    fn stale_assignment_plan_does_not_dispatch_after_task_completed() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "finish-before-dispatch",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze assignment");
        assert_eq!(plan.assignment_actions.len(), 1);

        AgentOrgTaskStore::update(
            &run_id,
            "finish-before-dispatch",
            UpdateTaskPatch {
                status: Some(TaskStatus::Completed),
                ..Default::default()
            },
        )
        .expect("complete concurrently");

        assert_eq!(
            dispatch_analyzed_assignment(&run_id, "finish-before-dispatch", "member-a"),
            None
        );
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 0);
    }

    #[test]
    fn current_assignment_dispatch_is_atomic_and_coalesces_duplicate_input() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "current-assignment",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );

        let first = dispatch_analyzed_assignment(&run_id, "current-assignment", "member-a")
            .expect("current assignment inserts");
        let second = dispatch_analyzed_assignment(&run_id, "current-assignment", "member-a")
            .expect("existing unread assignment is reusable");

        assert_eq!(first, second);
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 1);
    }

    #[test]
    fn member_assignment_recovery_batches_board_recheck_and_coalesces_each_task() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        for task_id in ["batch-assignment-a", "batch-assignment-b"] {
            seed_task(
                &run_id,
                task_id,
                Some("member-a"),
                TaskStatus::Pending,
                Some(&["member-a"]),
            );
        }
        let task_ids = vec![
            "batch-assignment-a".to_string(),
            "batch-assignment-b".to_string(),
        ];
        let conn = get_connection().expect("db");
        conn.execute(
            "INSERT INTO agent_inbox
             (recipient_agent_id, recipient_member_id, sender_agent_id,
              org_run_id, payload_kind, payload_json, created_at)
             VALUES ('builtin:sde', 'member-a', 'system', ?1,
                     'task_assigned', 'historical-corrupt-json', ?2)",
            params![&run_id, Utc::now().to_rfc3339()],
        )
        .expect("insert corrupt historical assignment envelope");

        let first = agent_org_tasks::enqueue_task_assignments_if_still_ready_for_recovery(
            &run_id,
            &task_ids,
            "builtin:sde",
            "member-a",
            SYSTEM_SENDER_ID,
            None,
            "Agent Org recovery",
        )
        .expect("batch recovery dispatch");
        let second = agent_org_tasks::enqueue_task_assignments_if_still_ready_for_recovery(
            &run_id,
            &task_ids,
            "builtin:sde",
            "member-a",
            SYSTEM_SENDER_ID,
            None,
            "Agent Org recovery",
        )
        .expect("coalesced batch recovery dispatch");

        assert_eq!(first.len(), 2);
        assert_eq!(first, second);
        let unread = AgentInboxStore::list_unread_for_member("member-a", &run_id)
            .expect("list unread assignments");
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 3);
        assert_eq!(
            unread
                .iter()
                .filter(|row| row.payload_kind == "task_assigned")
                .filter(|row| row.decode_payload().is_ok())
                .count(),
            2,
            "corrupt historical envelopes are ignored without poisoning or coalescing new typed assignments"
        );
    }

    #[test]
    fn stale_assignment_plan_does_not_dispatch_after_task_reassigned() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Idle),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_task(
            &run_id,
            "reassign-before-dispatch",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a", "member-b"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze assignment");
        assert!(plan
            .assignment_actions
            .iter()
            .any(|action| action.member_id == "member-a"));

        AgentOrgTaskStore::update(
            &run_id,
            "reassign-before-dispatch",
            UpdateTaskPatch {
                owner: Some(Some("member-b".to_string())),
                ..Default::default()
            },
        )
        .expect("reassign concurrently");

        assert_eq!(
            dispatch_analyzed_assignment(&run_id, "reassign-before-dispatch", "member-a"),
            None
        );
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 0);
    }

    #[test]
    fn stale_assignment_plan_does_not_dispatch_after_task_reblocked() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "new-blocker",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        seed_task(
            &run_id,
            "reblock-before-dispatch",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze assignment");
        assert!(plan.assignment_actions.iter().any(|action| {
            action
                .task_ids
                .iter()
                .any(|id| id == "reblock-before-dispatch")
        }));

        AgentOrgTaskStore::update(
            &run_id,
            "reblock-before-dispatch",
            UpdateTaskPatch {
                blocked_by: Some(vec!["new-blocker".to_string()]),
                ..Default::default()
            },
        )
        .expect("reblock concurrently");

        assert_eq!(
            dispatch_analyzed_assignment(&run_id, "reblock-before-dispatch", "member-a"),
            None
        );
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 0);
    }

    #[test]
    fn stale_assignment_plan_does_not_dispatch_after_recipient_archived() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "archive-before-dispatch",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze assignment");
        assert!(plan.assignment_actions.iter().any(|action| {
            action.member_id == "member-a"
                && action.task_ids == vec!["archive-before-dispatch".to_string()]
        }));

        set_session_status("session-member-a", SessionStatus::Archived);

        assert_eq!(
            dispatch_analyzed_assignment(&run_id, "archive-before-dispatch", "member-a"),
            None
        );
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 0);
    }

    #[test]
    fn stale_assignment_plan_does_not_dispatch_after_recipient_agent_changes() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "agent-changed-before-dispatch",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze assignment");
        assert_eq!(plan.assignment_actions.len(), 1);
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions
             SET agent_definition_id='builtin:replacement', updated_at=?1
             WHERE session_id='session-member-a'",
            params![Utc::now().to_rfc3339()],
        )
        .expect("replace recipient agent identity");

        assert_eq!(
            dispatch_analyzed_assignment(&run_id, "agent-changed-before-dispatch", "member-a"),
            None
        );
        assert_eq!(unread_assignment_count(&run_id, "member-a"), 0);
    }

    #[test]
    fn stale_coordinator_repair_is_dropped_without_notice_or_budget() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "ownerless-before-repair",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze repair");
        let reason = plan
            .coordinator_repair_reason
            .as_deref()
            .expect("ownerless task needs repair");

        AgentOrgTaskStore::update(
            &run_id,
            "ownerless-before-repair",
            UpdateTaskPatch {
                owner: Some(Some("member-a".to_string())),
                ..Default::default()
            },
        )
        .expect("assign concurrently");

        assert_eq!(
            insert_coordinator_stall_notice(
                &run_id,
                reason,
                plan.coordinator_repair_fingerprint
                    .as_deref()
                    .expect("repair fingerprint"),
                plan.coordinator_repair_work_revision,
                plan.coordinator_repair_task_fingerprint.as_deref(),
                plan.coordinator_repair_inbox_fingerprint.as_deref(),
            )
            .expect("dispatch stale repair"),
            CoordinatorNoticeDispatch::Stale
        );
        assert!(!has_unread_for_member(&run_id, COORDINATOR_MEMBER_ID).expect("unread probe"));
        let conn = get_connection().expect("db");
        let attempts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2",
                params![&run_id, COORDINATOR_NOTICE],
                |row| row.get(0),
            )
            .expect("count attempts");
        assert_eq!(attempts, 0, "stale repair must not consume budget");
    }

    #[test]
    fn stale_continuation_plan_does_not_dispatch_after_task_reblocked() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Failed),
            ("member-b", SessionStatus::Paused),
        ]);
        seed_task(
            &run_id,
            "continuation-blocker",
            Some("member-b"),
            TaskStatus::Pending,
            Some(&["member-b"]),
        );
        seed_task(
            &run_id,
            "continuation-target",
            Some("member-a"),
            TaskStatus::InProgress,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze continuation");
        let action = plan
            .continuation_actions
            .iter()
            .find(|action| action.member_id == "member-a")
            .cloned()
            .expect("terminal owner gets continuation");

        AgentOrgTaskStore::update(
            &run_id,
            "continuation-target",
            UpdateTaskPatch {
                blocked_by: Some(vec!["continuation-blocker".to_string()]),
                ..Default::default()
            },
        )
        .expect("reblock concurrently");

        assert!(
            !insert_member_continuation_if_tasks_current(&run_id, &action)
                .expect("dispatch stale continuation")
        );
        assert!(!has_unread_for_member(&run_id, "member-a").expect("unread probe"));
    }

    #[test]
    fn stale_continuation_plan_does_not_dispatch_after_recipient_paused() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "pause-before-continuation",
            Some("member-a"),
            TaskStatus::InProgress,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("analyze continuation");
        let action = plan
            .continuation_actions
            .iter()
            .find(|action| action.member_id == "member-a")
            .cloned()
            .expect("terminal owner gets continuation");

        set_session_status("session-member-a", SessionStatus::Paused);

        assert!(
            !insert_member_continuation_if_tasks_current(&run_id, &action)
                .expect("dispatch stale continuation")
        );
        assert!(!has_unread_for_member(&run_id, "member-a").expect("unread probe"));
    }
}
