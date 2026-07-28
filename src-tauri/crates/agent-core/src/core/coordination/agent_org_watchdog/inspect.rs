//! Stall inspection: read the task board and worker sessions for one
//! running Agent Org run and decide the [`super::plan::StallRecoveryPlan`].
//!
//! This is the read-only decision half of the watchdog; [`super::recover`]
//! carries out the plan it returns.

use super::budget::{
    budget_disposition_with_connection, member_rewake_fingerprint_from_unread, BudgetDisposition,
};
use super::plan::ready_unassigned_repair_reason;
use super::*;

/// A machine-stable recovery fact. Human-readable repair prose is excluded so
/// copy edits do not reset retry budgets.
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
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
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

pub(super) fn task_snapshot_fingerprint(tasks: &[Task]) -> String {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PendingMaterializationDisposition {
    Grace,
    Expired,
    InvalidTimestamp,
}

pub(super) fn pending_materialization_disposition(
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

pub(super) fn unavailable_unread_recipient_repair_fingerprint_with_connection(
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
pub(super) fn inspect_stalled_run_with_connection(
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
    matches!(
        status,
        SessionStatus::Running | SessionStatus::WaitingForUser | SessionStatus::WaitingForFunds
    )
}

pub(super) fn is_wakeable_status(status: SessionStatus) -> bool {
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
