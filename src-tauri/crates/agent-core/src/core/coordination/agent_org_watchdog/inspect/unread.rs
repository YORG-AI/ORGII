//! Unread Agent Org Inbox analysis: per-member unread fingerprints, the
//! recipients whose unread rows cannot be delivered automatically (and the
//! coordinator prose explaining each), and coordinator missed-delivery rewake.

use super::super::budget::{
    budget_disposition_with_connection, member_rewake_fingerprint_from_unread, BudgetDisposition,
};
use super::super::*;
use super::facts::{recovery_repair_fingerprint, RecoveryRepairFact};
use super::liveness::{
    is_wakeable_status, pending_materialization_disposition, PendingMaterializationDisposition,
};

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
pub(super) struct UnreadRecipientRepair {
    pub(super) recipient_member_id: Option<String>,
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

pub(super) fn unread_fingerprints_by_member(
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

pub(super) fn unavailable_unread_recipient_repairs_from_counts_with_connection(
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

pub(in crate::core::coordination::agent_org_watchdog) fn unavailable_unread_recipient_repair_fingerprint_with_connection(
    conn: &Connection,
    run_id: &str,
    workers: &[WorkerSessionRuntime],
) -> Result<Option<String>, String> {
    let counts = AgentInboxStore::unread_counts_by_recipient_with_connection(conn, run_id)?;
    let repairs = unavailable_unread_recipient_repairs_from_counts_with_connection(
        conn, run_id, workers, &counts,
    )?;
    Ok(unread_recipient_repair_snapshot_fingerprint(&repairs))
}

pub(super) fn unread_recipient_repair_snapshot_fingerprint(
    repairs: &[UnreadRecipientRepair],
) -> Option<String> {
    let facts = repairs
        .iter()
        .map(UnreadRecipientRepair::snapshot_fact)
        .collect::<Vec<_>>();
    recovery_repair_fingerprint(&facts)
}

pub(super) fn append_unread_recipient_repairs(
    repairs: &[UnreadRecipientRepair],
    reasons: &mut Vec<String>,
    facts: &mut Vec<RecoveryRepairFact>,
) {
    for repair in repairs {
        reasons.push(repair.coordinator_reason());
        facts.push(repair.repair_fact());
    }
}

pub(super) fn coordinator_unread_recovery_with_connection(
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
