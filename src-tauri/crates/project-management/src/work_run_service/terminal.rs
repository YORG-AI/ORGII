use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::{
    EnqueueWorkItemRunRequest, WorkItemRun, WorkItemRunFailure, WorkItemRunFailureClass,
    WorkItemRunRetryDisposition, WorkItemRunStatus, WorkItemRunTarget, WorkItemRunUsage,
};
use crate::work_service;

use super::dispatch::leased_run_id;
use super::enqueue::enqueue;
use super::path_lock::release_path_lock;
use super::read::read;
use super::store::{append_audit, db, require_run};
use super::{error, WorkItemRunTerminalOutcome};

const REVIEW_PROJECTION_SETTLED_OPERATION: &str = "work_run.review_projection_settled";

fn retry_delay_ms(delivery_attempt: i64) -> i64 {
    let exponent = delivery_attempt.saturating_sub(1).clamp(0, 6) as u32;
    (1_000_i64.saturating_mul(2_i64.saturating_pow(exponent))).min(60_000)
}

/// Convert an untyped runtime/provider error into a stable product category
/// and retry disposition. Matching is intentionally conservative: unknown,
/// auth, quota and configuration failures never auto-retry.
pub fn classify_failure(message: &str, has_session: bool) -> WorkItemRunFailure {
    let normalized = message.to_ascii_lowercase();
    let (class, code, retryable, retry_disposition) =
        if normalized.contains("cancelled") || normalized.contains("canceled") {
            (
                WorkItemRunFailureClass::Cancelled,
                "cancelled",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("context length")
            || normalized.contains("context window")
            || normalized.contains("too many tokens")
            || normalized.contains("maximum context")
        {
            (
                WorkItemRunFailureClass::ContextOverflow,
                "context_overflow",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        } else if normalized.contains("unauthorized")
            || normalized.contains("authentication")
            || normalized.contains("invalid api key")
            || normalized.contains("status 401")
        {
            (
                WorkItemRunFailureClass::Authentication,
                "authentication_failed",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("forbidden")
            || normalized.contains("permission denied")
            || normalized.contains("status 403")
        {
            (
                WorkItemRunFailureClass::Authorization,
                "authorization_failed",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("rate limit")
            || normalized.contains("quota")
            || normalized.contains("insufficient credit")
            || normalized.contains("status 429")
        {
            (
                WorkItemRunFailureClass::Quota,
                "quota_exhausted",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        } else if normalized.contains("timed out")
            || normalized.contains("timeout")
            || normalized.contains("deadline exceeded")
        {
            (
                WorkItemRunFailureClass::Timeout,
                "timeout",
                true,
                if has_session {
                    WorkItemRunRetryDisposition::ResumeSession
                } else {
                    WorkItemRunRetryDisposition::StartNewSession
                },
            )
        } else if normalized.contains("connection reset")
            || normalized.contains("connection refused")
            || normalized.contains("network")
            || normalized.contains("dns")
            || normalized.contains("tls")
        {
            (
                WorkItemRunFailureClass::TransientNetwork,
                "network_unavailable",
                true,
                if has_session {
                    WorkItemRunRetryDisposition::ResumeSession
                } else {
                    WorkItemRunRetryDisposition::StartNewSession
                },
            )
        } else if normalized.contains("status 502")
            || normalized.contains("status 503")
            || normalized.contains("status 504")
            || normalized.contains("provider unavailable")
            || normalized.contains("service unavailable")
        {
            (
                WorkItemRunFailureClass::ProviderUnavailable,
                "provider_unavailable",
                true,
                if has_session {
                    WorkItemRunRetryDisposition::ResumeSession
                } else {
                    WorkItemRunRetryDisposition::StartNewSession
                },
            )
        } else if normalized.contains("no selected")
            || normalized.contains("not configured")
            || normalized.contains("no host repo")
            || normalized.contains("missing configuration")
        {
            (
                WorkItemRunFailureClass::Configuration,
                "configuration_invalid",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("model not found")
            || normalized.contains("unknown model")
            || normalized.contains("unsupported model")
        {
            (
                WorkItemRunFailureClass::Model,
                "model_invalid",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        } else if normalized.contains("invalid request")
            || normalized.contains("invalid input")
            || normalized.contains("malformed")
        {
            (
                WorkItemRunFailureClass::InvalidInput,
                "invalid_input",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("runtime crashed")
            || normalized.contains("process exited")
            || normalized.contains("worker died")
        {
            (
                WorkItemRunFailureClass::Runtime,
                "runtime_failed",
                true,
                WorkItemRunRetryDisposition::StartNewSession,
            )
        } else {
            (
                WorkItemRunFailureClass::Unknown,
                "unknown",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        };
    WorkItemRunFailure {
        class,
        code: code.to_string(),
        message: message.to_string(),
        retryable,
        retry_disposition,
        occurred_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Nack a leased dispatch. Safe transient failures are delayed and retried;
/// permanent or exhausted failures move both dispatch and Run terminal.
pub fn record_dispatch_failure(
    dispatch_id: &str,
    lease_token: &str,
    message: &str,
) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let run_id = leased_run_id(&tx, dispatch_id, lease_token)?;
    let run = require_run(&tx, &run_id)?;
    let delivery_attempt: i64 = db(tx.query_row(
        "SELECT delivery_attempt FROM pm_dispatch_outbox WHERE id = ?1",
        params![dispatch_id],
        |row| row.get(0),
    ))?;
    let failure = classify_failure(message, false);
    let failure_json = serde_json::to_string(&failure)
        .map_err(|err| format!("work run failure serialization: {err}"))?;
    let retry = failure.retryable && delivery_attempt < i64::from(run.max_attempts);
    let now = now_ms();

    if retry {
        let available_at = now.saturating_add(retry_delay_ms(delivery_attempt));
        db(tx.execute(
            "UPDATE pm_dispatch_outbox
             SET status = 'retry_wait', available_at = ?3,
                 lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
                 last_error_json = ?4, updated_at = ?5
             WHERE id = ?1 AND lease_token = ?2",
            params![dispatch_id, lease_token, available_at, failure_json, now],
        ))?;
        db(tx.execute(
            "UPDATE pm_work_item_runs
             SET status = 'deferred', failure_json = ?2, updated_at = ?3
             WHERE id = ?1 AND status = 'dispatching'",
            params![run_id, failure_json, now],
        ))?;
    } else {
        db(tx.execute(
            "UPDATE pm_dispatch_outbox
             SET status = 'dead_letter', lease_token = NULL, lease_owner = NULL,
                 lease_expires_at = NULL, last_error_json = ?3, updated_at = ?4
             WHERE id = ?1 AND lease_token = ?2",
            params![dispatch_id, lease_token, failure_json, now],
        ))?;
        db(tx.execute(
            "UPDATE pm_work_item_runs
             SET status = 'failed', failure_json = ?2, completed_at = ?3,
                 updated_at = ?3
             WHERE id = ?1 AND status = 'dispatching'",
            params![run_id, failure_json, now],
        ))?;
    }
    release_path_lock(&tx, &run_id)?;
    let updated = require_run(&tx, &run_id)?;
    append_audit(
        &tx,
        &run_id,
        if retry {
            "work_run.dispatch_deferred"
        } else {
            "work_run.dispatch_failed"
        },
        updated.generation as i64,
        updated.project_slug.as_deref(),
        &updated.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "failure": failure,
            "deliveryAttempt": delivery_attempt,
            "willRetry": retry,
        }),
    )?;
    db(tx.commit())?;
    crate::projects::events::notify_work_item_dispatch_ready();
    let persisted = read(&run_id)?;
    if let Err(err) = crate::work_item_features::subscriptions::notify_run_terminal(&persisted) {
        tracing::warn!(run_id = %persisted.id, error = %err, "failed to project Run failure into Inbox");
    }
    Ok(persisted)
}

/// Reconcile a turn terminal into the exact owning Run.
///
/// `expected_session_id` guards against a stale completion from an earlier
/// Session being applied after a retry has attached the Run elsewhere. Run
/// finality is deliberately independent from Work Item completion.
pub fn record_run_terminal(
    run_id: &str,
    expected_session_id: Option<&str>,
    outcome: WorkItemRunTerminalOutcome,
    usage: WorkItemRunUsage,
    error_message: Option<&str>,
) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let existing = require_run(&tx, run_id)?;
    if let Some(expected) = expected_session_id {
        if existing
            .session_id
            .as_deref()
            .is_some_and(|actual| actual != expected)
        {
            return Err(format!(
                "{}:{} expected session {}, found {}",
                error::INVALID_TRANSITION,
                run_id,
                expected,
                existing.session_id.as_deref().unwrap_or("none")
            ));
        }
    }
    if existing.status.is_terminal() {
        release_path_lock(&tx, run_id)?;
        db(tx.commit())?;
        crate::projects::events::notify_work_item_dispatch_ready();
        if existing.status == WorkItemRunStatus::Succeeded {
            match review_projection_is_settled(run_id) {
                Ok(false) => project_succeeded_run_for_review(&existing),
                Ok(true) => {}
                Err(error) => tracing::warn!(
                    run_id,
                    error = %error,
                    "failed to read Work Item review projection receipt"
                ),
            }
        }
        return Ok(existing);
    }

    let (status, failure) = match outcome {
        WorkItemRunTerminalOutcome::Succeeded => (WorkItemRunStatus::Succeeded, None),
        WorkItemRunTerminalOutcome::Failed => (
            WorkItemRunStatus::Failed,
            Some(classify_failure(
                error_message.unwrap_or("session failed without an error message"),
                true,
            )),
        ),
        WorkItemRunTerminalOutcome::Cancelled => (
            WorkItemRunStatus::Cancelled,
            Some(classify_failure(
                error_message.unwrap_or("session cancelled"),
                true,
            )),
        ),
    };
    let failure_json = failure
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("work run failure serialization: {err}"))?;
    let usage_json = serde_json::to_string(&usage)
        .map_err(|err| format!("work run usage serialization: {err}"))?;
    let now = now_ms();
    db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = ?2, failure_json = ?3, usage_json = ?4,
             session_id = COALESCE(session_id, ?6),
             completed_at = ?5, updated_at = ?5
         WHERE id = ?1 AND status IN ('running', 'waiting', 'dispatching')",
        params![
            run_id,
            status.as_str(),
            failure_json,
            usage_json,
            now,
            expected_session_id
        ],
    ))?;
    release_path_lock(&tx, run_id)?;
    let updated = require_run(&tx, run_id)?;
    append_audit(
        &tx,
        run_id,
        "work_run.terminal",
        updated.generation as i64,
        updated.project_slug.as_deref(),
        &updated.org_id,
        serde_json::json!({
            "sessionId": expected_session_id.or(existing.session_id.as_deref()),
            "status": status.as_str(),
            "failure": failure,
            "usage": usage,
        }),
    )?;
    db(tx.commit())?;
    crate::projects::events::notify_work_item_dispatch_ready();
    let persisted = read(run_id)?;
    if persisted.status == WorkItemRunStatus::Succeeded {
        project_succeeded_run_for_review(&persisted);
    }
    if let Err(err) = crate::work_item_features::subscriptions::notify_run_terminal(&persisted) {
        tracing::warn!(run_id = %persisted.id, error = %err, "failed to project Run terminal into Inbox");
    }
    Ok(persisted)
}

fn project_succeeded_run_for_review(run: &WorkItemRun) {
    let projection = match work_service::project_run_success_to_review(
        run.project_slug.as_deref(),
        &run.org_id,
        &run.work_item_id,
        run.session_id.as_deref(),
    ) {
        Ok(projection) => projection,
        Err(error) => {
            // Run finality is authoritative and must not be rolled back when
            // its human-lifecycle projection temporarily fails. A repeated
            // terminal reconciliation can retry until a receipt is written.
            tracing::warn!(
                run_id = %run.id,
                work_item_id = %run.work_item_id,
                error = %error,
                "failed to move successful Work Item Run into review"
            );
            return;
        }
    };
    match projection {
        work_service::RunSuccessReviewProjection::Transitioned => {
            tracing::info!(
                run_id = %run.id,
                work_item_id = %run.work_item_id,
                "successful Work Item Run is awaiting review"
            );
        }
        work_service::RunSuccessReviewProjection::AlreadyInReview
        | work_service::RunSuccessReviewProjection::PreservedStatus
        | work_service::RunSuccessReviewProjection::Superseded => {}
    }

    if let Err(error) = mark_review_projection_settled(run, projection) {
        tracing::warn!(
            run_id = %run.id,
            error = %error,
            "failed to persist Work Item review projection receipt"
        );
    }
}

fn review_projection_is_settled(run_id: &str) -> Result<bool, String> {
    let connection = conn()?;
    Ok(db(connection
        .query_row(
            "SELECT 1 FROM pm_audit_events
             WHERE entity_type = 'work_item_run' AND entity_id = ?1 AND operation = ?2
             LIMIT 1",
            params![run_id, REVIEW_PROJECTION_SETTLED_OPERATION],
            |_| Ok(()),
        )
        .optional())?
    .is_some())
}

fn mark_review_projection_settled(
    run: &WorkItemRun,
    projection: work_service::RunSuccessReviewProjection,
) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let exists = db(tx
        .query_row(
            "SELECT 1 FROM pm_audit_events
             WHERE entity_type = 'work_item_run' AND entity_id = ?1 AND operation = ?2
             LIMIT 1",
            params![&run.id, REVIEW_PROJECTION_SETTLED_OPERATION],
            |_| Ok(()),
        )
        .optional())?
    .is_some();
    if !exists {
        let outcome = match projection {
            work_service::RunSuccessReviewProjection::Transitioned => "transitioned",
            work_service::RunSuccessReviewProjection::AlreadyInReview => "already_in_review",
            work_service::RunSuccessReviewProjection::PreservedStatus => "preserved_status",
            work_service::RunSuccessReviewProjection::Superseded => "superseded",
        };
        append_audit(
            &tx,
            &run.id,
            REVIEW_PROJECTION_SETTLED_OPERATION,
            run.generation as i64,
            run.project_slug.as_deref(),
            &run.org_id,
            serde_json::json!({
                "workItemId": run.work_item_id,
                "outcome": outcome,
            }),
        )?;
    }
    db(tx.commit())
}

/// Compatibility lookup for legacy Session-terminal callers. Multiple Runs
/// may resume one Session, so only the newest non-terminal episode is chosen.
/// New code should use [`record_run_terminal`] with the durable turn intent id.
pub fn record_session_terminal(
    session_id: &str,
    outcome: WorkItemRunTerminalOutcome,
    usage: WorkItemRunUsage,
    error_message: Option<&str>,
) -> Result<Option<WorkItemRun>, String> {
    let connection = conn()?;
    let run_id: Option<String> = db(connection
        .query_row(
            "SELECT id FROM pm_work_item_runs
             WHERE session_id = ?1
               AND status IN ('dispatching', 'running', 'waiting')
             ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC
             LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional())?;
    drop(connection);
    let Some(run_id) = run_id else {
        return Ok(None);
    };
    record_run_terminal(&run_id, Some(session_id), outcome, usage, error_message).map(Some)
}

pub fn mark_waiting(run_id: &str) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let now = now_ms();
    let changed = db(tx.execute(
        "UPDATE pm_work_item_runs SET status = 'waiting', updated_at = ?2
         WHERE id = ?1 AND status = 'running'",
        params![run_id, now],
    ))?;
    if changed != 1 {
        return Err(format!(
            "{}:{} -> waiting",
            error::INVALID_TRANSITION,
            run_id
        ));
    }
    let run = require_run(&tx, run_id)?;
    append_audit(
        &tx,
        run_id,
        "work_run.waiting",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({}),
    )?;
    db(tx.commit())?;
    read(run_id)
}

/// Create the next execution episode from a failed Run according to the
/// typed failure policy. This never mutates or reopens the previous Run.
pub fn retry(run_id: &str, idempotency_key: &str) -> Result<WorkItemRun, String> {
    let previous = read(run_id)?;
    if previous.status != WorkItemRunStatus::Failed {
        return Err(format!(
            "{}:{} is not failed",
            error::RETRY_NOT_ALLOWED,
            run_id
        ));
    }
    let failure = previous.failure.as_ref().ok_or_else(|| {
        format!(
            "{}:{} has no typed failure",
            error::RETRY_NOT_ALLOWED,
            run_id
        )
    })?;
    if !failure.retryable {
        return Err(format!(
            "{}:{}:{}",
            error::RETRY_NOT_ALLOWED,
            run_id,
            failure.code
        ));
    }
    if previous.attempt >= previous.max_attempts {
        return Err(format!(
            "{}:{} exhausted attempt budget ({}/{})",
            error::RETRY_NOT_ALLOWED,
            run_id,
            previous.attempt,
            previous.max_attempts
        ));
    }

    let mut target_snapshot = previous.target_snapshot.clone();
    if failure.retry_disposition == WorkItemRunRetryDisposition::ResumeSession {
        let session_id = previous.session_id.clone().ok_or_else(|| {
            format!(
                "{}:{} requires a Session to resume",
                error::RETRY_NOT_ALLOWED,
                run_id
            )
        })?;
        target_snapshot.target = WorkItemRunTarget::ResumeSession { session_id };
    }
    enqueue(EnqueueWorkItemRunRequest {
        project_slug: previous.project_slug,
        org_id: previous.org_id,
        work_item_id: previous.work_item_id,
        trigger: crate::projects::types::WorkItemRunTrigger::Retry {
            previous_run_id: previous.id.clone(),
        },
        target_snapshot,
        input: previous.input,
        idempotency_key: idempotency_key.to_string(),
        max_attempts: previous.max_attempts,
        parent_run_id: Some(previous.id),
    })
}
