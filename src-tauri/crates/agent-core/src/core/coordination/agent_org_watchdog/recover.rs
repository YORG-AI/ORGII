//! Watchdog scheduling and recovery execution: the periodic scan loop plus
//! carrying out a [`super::plan::StallRecoveryPlan`] returned by
//! [`super::inspect::inspect_stalled_run`].

use super::budget::{
    budget_disposition_with_connection, prune_recovery_budgets, record_attempt_with_connection,
    BudgetDisposition,
};
use super::inspect::{
    inspect_stalled_run_with_connection, pending_materialization_disposition,
    task_snapshot_fingerprint, unavailable_unread_recipient_repair_fingerprint_with_connection,
    PendingMaterializationDisposition,
};
use super::*;

pub fn spawn(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
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

/// Auxiliary cleanup is useful but cannot be a global recovery gate. One bad
/// row must not prevent healthy runs from being inspected during this tick.
pub(super) fn run_best_effort_cleanup(
    label: &'static str,
    cleanup: impl FnOnce() -> Result<(), String>,
) {
    if let Err(err) = cleanup() {
        tracing::warn!(
            cleanup = label,
            error = %err,
            "[agent_org_watchdog] maintenance failed; continuing run scan"
        );
    }
}

pub(super) fn recover_listed_runs<H: Clone, T>(
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
    if failed_run_ids.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} Agent Org run(s) failed recovery inspection: {}",
            failed_run_ids.len(),
            failed_run_ids.join(", ")
        ))
    }
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
            CoordinatorNoticeDispatch::Inserted | CoordinatorNoticeDispatch::ExistingUnread => {
                wake_hook.wake_member(COORDINATOR_MEMBER_ID, run_id);
            }
            CoordinatorNoticeDispatch::Deferred => {
                tracing::debug!(
                    run_id = %run_id,
                    "[agent_org_watchdog] coordinator notice deferred during session materialization grace"
                );
            }
            CoordinatorNoticeDispatch::RecipientUnavailable => {
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

/// Persist a terminal-member continuation only when the analyzed tasks still
/// have the same owner, remain unresolved, and have no unresolved blockers.
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
            if unavailable_unread_recipient_repair_fingerprint_with_connection(
                &tx, run_id, &workers,
            )?
            .as_deref()
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
                if budget_disposition_with_connection(
                    &tx,
                    run_id,
                    COORDINATOR_NOTICE,
                    "coordinator",
                    reason_fingerprint,
                )? != BudgetDisposition::Allowed
                {
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

        if budget_disposition_with_connection(
            &tx,
            run_id,
            COORDINATOR_NOTICE,
            "coordinator",
            reason_fingerprint,
        )? != BudgetDisposition::Allowed
        {
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
