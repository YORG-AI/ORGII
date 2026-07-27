//! Two-phase durable claim for one member-rewake scheduler dispatch.
//!
//! Reserves a [`super::budget`] attempt before handing work to the
//! in-memory scheduler (which cannot share a transaction with SQLite), then
//! commits or refunds it by token once dispatch succeeds or fails.

use super::budget::{
    budget_disposition_with_connection, record_attempt_with_connection, BudgetDisposition,
    RecoveryAttemptSnapshot,
};
use super::*;

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
