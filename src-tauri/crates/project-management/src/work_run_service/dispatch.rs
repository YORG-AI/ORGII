use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::{WorkItemDispatchLease, WorkItemRun, WorkItemRunStatus};

use super::path_lock::acquire_path_lock;
use super::read::read;
use super::store::{append_audit, db, iso8601, require_run};
use super::{error, DEFAULT_LEASE_MS};

const MAX_LEASE_MS: i64 = 5 * 60_000;
const MAX_LEASE_RENEWAL_MS: i64 = 60_000;
const PREPARED_LEASE_EXTENSION_MS: i64 = MAX_LEASE_RENEWAL_MS;

/// Lease the oldest ready dispatch. Expired leases are reclaimed by the same
/// query, so process death cannot strand a Run in `dispatching` forever.
pub fn claim_dispatch_for_run(
    run_id: &str,
    worker_id: &str,
    requested_lease_ms: i64,
) -> Result<WorkItemDispatchLease, String> {
    if run_id.trim().is_empty() || worker_id.trim().is_empty() {
        return Err(format!(
            "{}:run_id and worker_id are required",
            error::INVALID_REQUEST
        ));
    }
    let lease_ms = if requested_lease_ms <= 0 {
        DEFAULT_LEASE_MS
    } else {
        requested_lease_ms.min(MAX_LEASE_MS)
    };
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let now = now_ms();
    let candidate: Option<(String, i64)> = db(tx
        .query_row(
            "SELECT d.id, d.delivery_attempt
             FROM pm_dispatch_outbox d
             JOIN pm_work_item_runs r ON r.id = d.run_id
             WHERE d.run_id = ?1
               AND (
                   d.status IN ('pending', 'retry_wait')
                   OR (d.status = 'leased' AND d.lease_expires_at <= ?2)
               )
               AND r.status IN ('queued', 'deferred', 'dispatching')
             ORDER BY d.generation DESC
             LIMIT 1",
            params![run_id, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())?;
    let Some((dispatch_id, previous_attempts)) = candidate else {
        return Err(format!(
            "{}:{run_id} has no claimable dispatch",
            error::INVALID_TRANSITION
        ));
    };
    let mut run = require_run(&tx, run_id)?;
    acquire_path_lock(&tx, &run, now)?;

    let lease_token = format!("lease_{}", uuid::Uuid::new_v4().simple());
    let lease_expires_at = now.saturating_add(lease_ms);
    let delivery_attempt = previous_attempts.saturating_add(1);
    db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET status = 'leased', delivery_attempt = ?2, lease_token = ?3,
             claim_token = NULL,
             lease_owner = ?4, lease_expires_at = ?5, updated_at = ?1
         WHERE id = ?6",
        params![
            now,
            delivery_attempt,
            lease_token,
            worker_id,
            lease_expires_at,
            dispatch_id
        ],
    ))?;
    db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = 'dispatching', updated_at = ?2
         WHERE id = ?1 AND status IN ('queued', 'deferred', 'dispatching')",
        params![run_id, now],
    ))?;
    run.status = WorkItemRunStatus::Dispatching;
    run.updated_at = iso8601(now);
    append_audit(
        &tx,
        run_id,
        "work_run.dispatch_claimed",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "workerId": worker_id,
            "deliveryAttempt": delivery_attempt,
            "leaseExpiresAt": lease_expires_at,
            "inline": true,
        }),
    )?;
    db(tx.commit())?;

    Ok(WorkItemDispatchLease {
        dispatch_id,
        lease_token,
        lease_owner: worker_id.to_string(),
        lease_expires_at: iso8601(lease_expires_at),
        delivery_attempt: u32::try_from(delivery_attempt)
            .map_err(|_| "dispatch delivery_attempt out of range".to_string())?,
        run,
    })
}

fn select_claimable_dispatch(
    connection: &Connection,
    now: i64,
) -> Result<Option<(String, String, i64)>, String> {
    db(connection
        .query_row(
            "SELECT d.id, d.run_id, d.delivery_attempt
             FROM pm_dispatch_outbox d
             JOIN pm_work_item_runs r ON r.id = d.run_id
             WHERE (
                 (d.status IN ('pending', 'retry_wait') AND d.available_at <= ?1)
                 OR (d.status = 'leased' AND d.lease_expires_at <= ?1)
               )
               AND r.status IN ('queued', 'deferred', 'dispatching')
               AND (
                   COALESCE(json_extract(r.target_json, '$.allowSharedCheckout'), 0) = 1
                   OR NULLIF(TRIM(json_extract(r.target_json, '$.workspacePath')), '') IS NULL
                   OR NOT EXISTS (
                       SELECT 1 FROM pm_work_item_path_locks path_lock
                        WHERE path_lock.workspace_path = json_extract(r.target_json, '$.workspacePath')
                          AND path_lock.run_id <> r.id
                          AND path_lock.lease_expires_at > ?1
                   )
               )
             ORDER BY d.available_at ASC, d.created_at ASC, d.id ASC
             LIMIT 1",
            params![now],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional())
}

/// Cheap read-only readiness probe used before entering an `IMMEDIATE`
/// transaction. An idle dispatcher therefore never takes SQLite's writer
/// reservation merely to discover an empty queue.
pub(super) fn has_claimable_dispatch_on(connection: &Connection) -> Result<bool, String> {
    Ok(select_claimable_dispatch(connection, now_ms())?.is_some())
}

pub fn has_claimable_dispatch() -> Result<bool, String> {
    let connection = conn()?;
    has_claimable_dispatch_on(&connection)
}

/// Earliest persisted dispatch/lease deadline. The dispatcher sleeps until
/// this instant (bounded by its crash-recovery interval) and can still be
/// interrupted immediately by an in-process outbox commit or the
/// cross-process PM watermark.
pub fn next_dispatch_due_at_ms() -> Result<Option<i64>, String> {
    let connection = conn()?;
    db(connection.query_row(
        "SELECT MIN(
             CASE
               WHEN d.status IN ('pending', 'retry_wait') THEN d.available_at
               WHEN d.status = 'leased' THEN d.lease_expires_at
               ELSE NULL
             END
         )
         FROM pm_dispatch_outbox d
         JOIN pm_work_item_runs r ON r.id = d.run_id
         WHERE d.status IN ('pending', 'retry_wait', 'leased')
           AND r.status IN ('queued', 'deferred', 'dispatching')",
        [],
        |row| row.get(0),
    ))
}

/// Lease the oldest ready dispatch. Expired leases are reclaimed by the same
/// query, so process death cannot strand a Run in `dispatching` forever.
pub fn claim_next_dispatch(
    worker_id: &str,
    requested_lease_ms: i64,
) -> Result<Option<WorkItemDispatchLease>, String> {
    if worker_id.trim().is_empty() {
        return Err(format!("{}:worker_id is required", error::INVALID_REQUEST));
    }
    let lease_ms = if requested_lease_ms <= 0 {
        DEFAULT_LEASE_MS
    } else {
        requested_lease_ms.min(MAX_LEASE_MS)
    };
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let now = now_ms();
    let candidate = select_claimable_dispatch(&tx, now)?;
    let Some((dispatch_id, run_id, previous_attempts)) = candidate else {
        db(tx.commit())?;
        return Ok(None);
    };
    let mut run = require_run(&tx, &run_id)?;
    acquire_path_lock(&tx, &run, now)?;

    let lease_token = format!("lease_{}", uuid::Uuid::new_v4().simple());
    let lease_expires_at = now.saturating_add(lease_ms);
    let delivery_attempt = previous_attempts.saturating_add(1);
    db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET status = 'leased', delivery_attempt = ?2, lease_token = ?3,
             claim_token = NULL,
             lease_owner = ?4, lease_expires_at = ?5, updated_at = ?1
         WHERE id = ?6",
        params![
            now,
            delivery_attempt,
            lease_token,
            worker_id,
            lease_expires_at,
            dispatch_id
        ],
    ))?;
    db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = 'dispatching', updated_at = ?2
         WHERE id = ?1 AND status IN ('queued', 'deferred', 'dispatching')",
        params![run_id, now],
    ))?;
    run.status = WorkItemRunStatus::Dispatching;
    run.updated_at = iso8601(now);
    append_audit(
        &tx,
        &run_id,
        "work_run.dispatch_claimed",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "workerId": worker_id,
            "deliveryAttempt": delivery_attempt,
            "leaseExpiresAt": lease_expires_at,
        }),
    )?;
    db(tx.commit())?;

    Ok(Some(WorkItemDispatchLease {
        dispatch_id,
        lease_token,
        lease_owner: worker_id.to_string(),
        lease_expires_at: iso8601(lease_expires_at),
        delivery_attempt: u32::try_from(delivery_attempt)
            .map_err(|_| "dispatch delivery_attempt out of range".to_string())?,
        run,
    }))
}

pub(super) fn leased_run_id(
    tx: &Transaction<'_>,
    dispatch_id: &str,
    lease_token: &str,
) -> Result<String, String> {
    db(tx
        .query_row(
            "SELECT run_id FROM pm_dispatch_outbox
             WHERE id = ?1 AND status = 'leased' AND lease_token = ?2",
            params![dispatch_id, lease_token],
            |row| row.get(0),
        )
        .optional())?
    .ok_or_else(|| format!("{}:{}", error::STALE_LEASE, dispatch_id))
}

/// Extend one exact live dispatch lease. The lease token is the durable
/// worker fence, so a reclaimed row rejects a late heartbeat.
pub fn renew_dispatch_lease(
    dispatch_id: &str,
    lease_token: &str,
    requested_extension_ms: i64,
) -> Result<bool, String> {
    let extension_ms = requested_extension_ms.clamp(1_000, MAX_LEASE_RENEWAL_MS);
    let now = now_ms();
    let connection = conn()?;
    let changed = db(connection.execute(
        "UPDATE pm_dispatch_outbox
         SET lease_expires_at = ?3, updated_at = ?2
         WHERE id = ?1 AND status = 'leased' AND lease_token = ?4",
        params![
            dispatch_id,
            now,
            now.saturating_add(extension_ms),
            lease_token
        ],
    ))?;
    Ok(changed == 1)
}

/// Durably bind the local Session selected for a remote-root hand-off while
/// retaining the exact outbox lease. Prepare is idempotent for the same
/// claimant and Session; a claimant may never switch runners after prepare.
pub fn prepare_dispatch_session(
    dispatch_id: &str,
    lease_token: &str,
    claim_token: &str,
    session_id: &str,
) -> Result<WorkItemRun, String> {
    if session_id.trim().is_empty() {
        return Err(format!("{}:session_id is required", error::INVALID_REQUEST));
    }
    if claim_token.trim().is_empty() {
        return Err(format!(
            "{}:claim_token is required",
            error::INVALID_REQUEST
        ));
    }

    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let run_id = leased_run_id(&tx, dispatch_id, lease_token)?;
    let previous_claim_token: Option<String> = db(tx.query_row(
        "SELECT claim_token FROM pm_dispatch_outbox
         WHERE id = ?1 AND status = 'leased' AND lease_token = ?2",
        params![dispatch_id, lease_token],
        |row| row.get(0),
    ))?;
    if previous_claim_token
        .as_deref()
        .is_some_and(|current| current != claim_token)
    {
        return Err(format!("{}:{}", error::STALE_LEASE, dispatch_id));
    }

    let prepare_now = now_ms();
    let claimed = db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET claim_token = ?3, updated_at = ?4,
             lease_expires_at = MAX(lease_expires_at, ?5)
         WHERE id = ?1 AND status = 'leased' AND lease_token = ?2
           AND (claim_token IS NULL OR claim_token = ?3)",
        params![
            dispatch_id,
            lease_token,
            claim_token,
            prepare_now,
            prepare_now.saturating_add(PREPARED_LEASE_EXTENSION_MS)
        ],
    ))?;
    if claimed != 1 {
        return Err(format!("{}:{}", error::STALE_LEASE, dispatch_id));
    }

    let existing = require_run(&tx, &run_id)?;
    if existing.status != WorkItemRunStatus::Dispatching {
        return Err(format!(
            "{}:{} cannot prepare from {}",
            error::INVALID_TRANSITION,
            run_id,
            existing.status.as_str()
        ));
    }
    if let Some(bound) = existing.session_id.as_deref() {
        if bound != session_id && previous_claim_token.as_deref() == Some(claim_token) {
            return Err(format!(
                "{}:{} prepared session {}, got {}",
                error::INVALID_TRANSITION,
                run_id,
                bound,
                session_id
            ));
        }
        if bound == session_id {
            db(tx.commit())?;
            return read(&run_id);
        }
    }

    let now = now_ms();
    let changed = db(tx.execute(
        "UPDATE pm_work_item_runs
         SET session_id = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'dispatching'",
        params![run_id, session_id, now],
    ))?;
    if changed != 1 {
        return Err(format!(
            "{}:{} could not prepare session",
            error::INVALID_TRANSITION,
            run_id
        ));
    }
    let prepared = require_run(&tx, &run_id)?;
    append_audit(
        &tx,
        &run_id,
        "work_run.dispatch_prepared",
        prepared.generation as i64,
        prepared.project_slug.as_deref(),
        &prepared.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "sessionId": session_id,
        }),
    )?;
    db(tx.commit())?;
    read(&run_id)
}

/// Query the durable receipt used to make the frontend acknowledgement RPC
/// safe to retry after a successful response was lost.
pub fn delivered_dispatch_matches_claim(run_id: &str, claim_token: &str) -> Result<bool, String> {
    let connection = conn()?;
    Ok(db(connection
        .query_row(
            "SELECT 1 FROM pm_dispatch_outbox
             WHERE run_id = ?1 AND status = 'delivered' AND claim_token = ?2
             LIMIT 1",
            params![run_id, claim_token],
            |_| Ok(()),
        )
        .optional())?
    .is_some())
}

/// Acknowledge that the runtime accepted the dispatch and materialized a
/// Session. This is a Run transition only; Work Item status is untouched.
pub fn acknowledge_dispatch_started(
    dispatch_id: &str,
    lease_token: &str,
    session_id: &str,
) -> Result<WorkItemRun, String> {
    acknowledge_dispatch_started_inner(dispatch_id, lease_token, None, session_id)
}

pub fn acknowledge_claimed_dispatch_started(
    dispatch_id: &str,
    lease_token: &str,
    claim_token: &str,
    session_id: &str,
) -> Result<WorkItemRun, String> {
    if claim_token.trim().is_empty() {
        return Err(format!(
            "{}:claim_token is required",
            error::INVALID_REQUEST
        ));
    }
    acknowledge_dispatch_started_inner(dispatch_id, lease_token, Some(claim_token), session_id)
}

fn acknowledge_dispatch_started_inner(
    dispatch_id: &str,
    lease_token: &str,
    claim_token: Option<&str>,
    session_id: &str,
) -> Result<WorkItemRun, String> {
    if session_id.trim().is_empty() {
        return Err(format!("{}:session_id is required", error::INVALID_REQUEST));
    }
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let run_id = match claim_token {
        Some(claim_token) => db(tx
            .query_row(
                "SELECT run_id FROM pm_dispatch_outbox
                 WHERE id = ?1 AND status = 'leased' AND lease_token = ?2
                   AND claim_token = ?3",
                params![dispatch_id, lease_token, claim_token],
                |row| row.get(0),
            )
            .optional())?
        .ok_or_else(|| format!("{}:{}", error::STALE_LEASE, dispatch_id))?,
        None => leased_run_id(&tx, dispatch_id, lease_token)?,
    };
    let now = now_ms();
    db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET status = 'delivered', delivered_at = ?3, updated_at = ?3,
             lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?1 AND lease_token = ?2
           AND (?4 IS NULL OR claim_token = ?4)",
        params![dispatch_id, lease_token, now, claim_token],
    ))?;
    let changed = db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = CASE WHEN status = 'dispatching' THEN 'running' ELSE status END,
             session_id = COALESCE(session_id, ?2),
             failure_json = CASE WHEN status = 'dispatching' THEN NULL ELSE failure_json END,
             started_at = COALESCE(started_at, ?3), updated_at = ?3
         WHERE id = ?1
           AND status IN ('dispatching', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')
           AND (session_id IS NULL OR session_id = ?2)",
        params![run_id, session_id, now],
    ))?;
    if changed != 1 {
        return Err(format!(
            "{}:{} cannot acknowledge from current state",
            error::INVALID_TRANSITION,
            run_id
        ));
    }
    let run = require_run(&tx, &run_id)?;
    append_audit(
        &tx,
        &run_id,
        "work_run.started",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "sessionId": session_id,
        }),
    )?;
    db(tx.commit())?;
    read(&run_id)
}
