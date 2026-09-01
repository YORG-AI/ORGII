//! Session and task liveness predicates: which session statuses are active or
//! wakeable, how long a Pending member may stay unmaterialized, and when an
//! `in_progress` task counts as stale.

use super::super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::core::coordination::agent_org_watchdog) enum PendingMaterializationDisposition {
    Grace,
    Expired,
    InvalidTimestamp,
}

pub(in crate::core::coordination::agent_org_watchdog) fn pending_materialization_disposition(
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

pub(super) fn is_active_status(status: SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Running | SessionStatus::WaitingForUser | SessionStatus::WaitingForFunds
    )
}

pub(in crate::core::coordination::agent_org_watchdog) fn is_wakeable_status(
    status: SessionStatus,
) -> bool {
    matches!(
        status,
        SessionStatus::Idle
            | SessionStatus::Completed
            | SessionStatus::Failed
            | SessionStatus::Cancelled
            | SessionStatus::Abandoned
            | SessionStatus::Timeout
    )
}

pub(super) fn is_stale_in_progress(
    task_updated_at: &str,
    owner_updated_at: Option<&String>,
) -> bool {
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
