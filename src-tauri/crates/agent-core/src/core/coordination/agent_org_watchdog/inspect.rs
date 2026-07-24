//! Stall inspection: read the task board and worker sessions for one
//! running Agent Org run and decide the [`super::plan::StallRecoveryPlan`].
//!
//! This is the read-only decision half of the watchdog; [`super::recover`]
//! carries out the plan it returns.

use super::budget::{delayed_rewake_allowed, reason_fingerprint, rewake_budget_exhausted};
use super::plan::ready_unassigned_repair_reason;
use super::*;

pub fn inspect_stalled_run(run_id: &str) -> Result<StallRecoveryPlan, String> {
    if AgentOrgRunStore::get_run_status(run_id)? != Some(AgentOrgRunStatus::Running) {
        return Ok(StallRecoveryPlan::default());
    }

    let finality_assessment = AgentOrgRunStore::assess_run_finality(run_id)?;
    let tasks = agent_org_tasks::AgentOrgTaskStore::list(run_id)?;
    let task_graph = agent_org_tasks::TaskGraphIndex::new(&tasks);
    let pending_plan_task_ids = AgentOrgPlanApprovalStore::list_pending_by_run(run_id)?
        .into_iter()
        .map(|approval| approval.source_task_id)
        .collect::<HashSet<_>>();
    let workers = AgentOrgRunStore::list_descendant_worker_sessions(run_id)?;
    let has_active_worker = workers.iter().any(|worker| is_active_status(worker.status));

    let mut member_status = HashMap::new();
    let mut member_updated_at = HashMap::new();
    let mut unsupported_transport_members = HashSet::new();
    for worker in &workers {
        if let Some(member_id) = worker.member_id.as_deref() {
            member_status.insert(member_id.to_string(), worker.status);
            member_updated_at.insert(member_id.to_string(), worker.updated_at.clone());
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
        let mut keys = Vec::new();
        for task in &tasks {
            let Some(owner) = task.owner.as_deref() else {
                let ready = task.status == TaskStatus::Pending && task_graph.is_ready(task);
                if ready {
                    let mut eligible = agent_org_tasks::eligible_member_ids(task);
                    eligible.sort();
                    keys.push(format!(
                        "awaiting_coordinator_assignment:{}:{}",
                        task.id,
                        eligible.join(",")
                    ));
                    reasons.push(ready_unassigned_repair_reason(task));
                }
                continue;
            };
            if unsupported_transport_members.contains(owner) && !task.status.is_resolved() {
                keys.push(format!("unsupported_transport:{}:{}", task.id, owner));
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
                || has_unread_for_member(run_id, owner)?
            {
                continue;
            }
            keys.push(format!("stale_running_owner:{}:{}", task.id, owner));
            reasons.push(format!(
                "task {} is still in_progress under Running member {} but appears stale; the watchdog will not steal it based on age. Ask the owner to continue/retry or explicitly reassign it.",
                task.id, owner
            ));
        }
        keys.sort();
        return Ok(StallRecoveryPlan {
            wake_member_ids: Vec::new(),
            continuation_actions: Vec::new(),
            assignment_actions: Vec::new(),
            coordinator_repair_reason: (!reasons.is_empty()).then(|| reasons.join("\n")),
            coordinator_repair_fingerprint: (!keys.is_empty())
                .then(|| reason_fingerprint(&keys.join("|"))),
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
    let assignment_conn = get_connection().map_err(|err| err.to_string())?;
    let historically_assigned_task_ids =
        AgentInboxStore::task_assignment_ids_for_open_tasks_with_connection(
            &assignment_conn,
            run_id,
        )?;
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
        let has_unread = has_unread_for_member(run_id, member_id)?;
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
        let rewake_fingerprint = member_rewake_fingerprint(run_id, member_id, worker.status)?;
        if !delayed_rewake_allowed(run_id, member_id, worker.status, &rewake_fingerprint)? {
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
    let coordinator_unread = has_unread_for_member(run_id, COORDINATOR_MEMBER_ID)?;
    if coordinator_unread {
        if let Some(info) =
            AgentOrgRunStore::find_coordinator_session_by_member_id(run_id, COORDINATOR_MEMBER_ID)?
        {
            let rewake_fingerprint =
                member_rewake_fingerprint(run_id, COORDINATOR_MEMBER_ID, info.status)?;
            if is_wakeable_status(info.status)
                && delayed_rewake_allowed(
                    run_id,
                    COORDINATOR_MEMBER_ID,
                    info.status,
                    &rewake_fingerprint,
                )?
            {
                wake_member_ids.push(COORDINATOR_MEMBER_ID.to_string());
            }
        }
    }

    let mut needs_repair = Vec::new();
    let mut repair_keys = Vec::new();
    for task in &tasks {
        if task.status.is_resolved() {
            continue;
        }
        if let Some(owner) = task.owner.as_deref() {
            let owner_status = member_status.get(owner).copied();
            if unsupported_transport_members.contains(owner) {
                repair_keys.push(format!("unsupported_transport:{}:{}", task.id, owner));
                needs_repair.push(format!(
                    "task {} is owned by historical CLI member {}, whose Agent Org transport is unsupported; reassign owner_member_id to a Rust member",
                    task.id, owner
                ));
            } else if owner_status.is_none() || owner_status == Some(SessionStatus::Archived) {
                repair_keys.push(format!("missing_owner:{}:{}", task.id, owner));
                needs_repair.push(format!(
                    "task {} is owned by unavailable member {}; reassign owner_member_id or repair eligible_member_ids",
                    task.id, owner
                ));
            } else if match owner_status {
                Some(status) if status.is_terminal() => rewake_budget_exhausted(
                    run_id,
                    owner,
                    &member_rewake_fingerprint(run_id, owner, status)?,
                )?,
                _ => false,
            } {
                repair_keys.push(format!("terminal_owner:{}:{}", task.id, owner));
                needs_repair.push(format!(
                    "task {} is owned by terminal member {} whose automatic retry budget is exhausted; retry the owner, reassign owner_member_id, or repair eligible_member_ids",
                    task.id, owner
                ));
            } else if task.status == TaskStatus::InProgress
                && !pending_plan_task_ids.contains(&task.id)
                && is_stale_in_progress(task.updated_at.as_str(), member_updated_at.get(owner))
                && !has_unread_for_member(run_id, owner)?
            {
                repair_keys.push(format!("stale_owner:{}:{}", task.id, owner));
                let eligible = agent_org_tasks::eligible_member_ids(task);
                let eligible = if eligible.is_empty() {
                    "none".to_string()
                } else {
                    eligible.join(", ")
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
                && !has_unread_for_member(run_id, owner)?
            {
                repair_keys.push(format!(
                    "consumed_assignment_without_start:{}:{}",
                    task.id, owner
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
        repair_keys.push(format!(
            "awaiting_coordinator_assignment:{}:{}",
            task.id,
            stable_eligible.join(",")
        ));
        needs_repair.push(ready_unassigned_repair_reason(task));
    }

    // A terminal reconciliation may legitimately decline even when every
    // Task is resolved (for example, the coordinator has not observed the
    // latest work revision). Convert the actionable canonical blockers into
    // one bounded coordinator repair instead of returning an empty plan that
    // leaves the run permanently Running.
    for blocker in &finality_assessment.blockers {
        match blocker {
            AgentOrgFinalityBlocker::EmptyTaskBoardRequiresCompletionIntent => {
                repair_keys.push("empty_board_requires_completion_intent".to_string());
                needs_repair.push(
                    "the Agent Org task board is empty. If the mission truly needs no durable tasks, call org_run_complete with a concise summary; otherwise create the missing task graph."
                        .to_string(),
                );
            }
            AgentOrgFinalityBlocker::StaleCompletionIntent {
                requested_work_revision,
                current_work_revision,
            } => {
                repair_keys.push(format!(
                    "stale_completion_intent:{requested_work_revision:?}:{current_work_revision}"
                ));
                needs_repair.push(format!(
                    "the previous completion request observed work revision {requested_work_revision:?}, but the board is now revision {current_work_revision}. Re-inspect the board before calling org_run_complete again."
                ));
            }
            AgentOrgFinalityBlocker::CoordinatorHasNotObservedLatestWork {
                observed_work_revision,
                current_work_revision,
            } if tasks.iter().all(|task| task.status.is_resolved()) => {
                repair_keys.push(format!(
                    "coordinator_observation:{observed_work_revision:?}:{current_work_revision}"
                ));
                needs_repair.push(format!(
                    "all durable tasks are resolved, but the coordinator has only observed work revision {observed_work_revision:?}; the current revision is {current_work_revision}. Refresh task_list and produce the final user-facing synthesis."
                ));
            }
            _ => {}
        }
    }

    let coordinator_repair_reason = if !needs_repair.is_empty() && !coordinator_unread {
        Some(needs_repair.join("\n"))
    } else {
        None
    };
    repair_keys.sort();
    let coordinator_repair_fingerprint = coordinator_repair_reason
        .as_ref()
        .map(|_| reason_fingerprint(&repair_keys.join("|")));

    let terminal_candidate = matches!(
        finality_assessment.decision,
        AgentOrgFinalityDecision::Complete | AgentOrgFinalityDecision::Abandon
    );

    Ok(StallRecoveryPlan {
        wake_member_ids,
        continuation_actions,
        assignment_actions,
        coordinator_repair_reason,
        coordinator_repair_fingerprint,
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
