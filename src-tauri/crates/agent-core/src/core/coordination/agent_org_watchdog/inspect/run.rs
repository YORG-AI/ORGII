//! The top-level stall inspection pass: read one run's finality assessment,
//! task board, worker sessions and inbox from a single SQLite read snapshot
//! and derive the [`super::super::plan::StallRecoveryPlan`].

use super::super::budget::{
    budget_disposition_with_connection, member_rewake_fingerprint_from_unread, BudgetDisposition,
};
use super::super::plan::ready_unassigned_repair_reason;
use super::super::*;
use super::coordinator_notice::{
    bounded_id_list_preview, bounded_recovery_reason_text,
    coordinator_notice_budget_exists_with_connection,
};
use super::dependency_integrity::append_dependency_integrity_repairs;
use super::facts::{
    corrupt_task_repair_facts, recovery_repair_fingerprint, task_snapshot_fingerprint,
    RecoveryRepairFact,
};
use super::liveness::{
    is_active_status, is_stale_in_progress, is_wakeable_status,
    pending_materialization_disposition, PendingMaterializationDisposition,
};
use super::unread::{
    append_unread_recipient_repairs, coordinator_unread_recovery_with_connection,
    unavailable_unread_recipient_repairs_from_counts_with_connection,
    unread_fingerprints_by_member, unread_recipient_repair_snapshot_fingerprint,
};

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
pub(in crate::core::coordination::agent_org_watchdog) fn inspect_stalled_run_with_connection(
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
