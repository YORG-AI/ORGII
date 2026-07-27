//! Watchdog scheduling and recovery execution: the periodic scan loop plus
//! carrying out a [`super::plan::StallRecoveryPlan`] returned by
//! [`super::inspect::inspect_stalled_run`].

use super::budget::{coordinator_notice_budget_allows, prune_recovery_budgets, record_attempt};
use super::*;

pub fn spawn(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
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

    if AgentOrgRunStore::get_run_status(run_id)? == Some(AgentOrgRunStatus::Running) {
        let recovery_tasks = agent_org_tasks::AgentOrgTaskStore::list(run_id)?;
        for action in &plan.assignment_actions {
            if has_unread_for_member(run_id, &action.member_id)? {
                continue;
            }
            for task_id in &action.task_ids {
                let Some(task) = recovery_tasks.iter().find(|task| &task.id == task_id) else {
                    continue;
                };
                let ready = task.status == TaskStatus::Pending
                    && task.owner.as_deref() == Some(action.member_id.as_str())
                    && task.blocked_by.iter().all(|blocker_id| {
                        recovery_tasks
                            .iter()
                            .find(|candidate| &candidate.id == blocker_id)
                            .is_some_and(|candidate| candidate.status.is_resolved())
                    });
                if ready {
                    agent_org_tasks::enqueue_task_assigned_to(
                        task,
                        &action.recipient_agent_id,
                        &action.member_id,
                        SYSTEM_SENDER_ID,
                        None,
                        "Agent Org recovery",
                    )?;
                }
            }
        }
        for action in &plan.continuation_actions {
            if has_unread_for_member(run_id, &action.member_id)? {
                continue;
            }
            AgentInboxStore::insert(InsertInboxParams {
                recipient_agent_id: action.recipient_agent_id.clone(),
                recipient_member_id: Some(action.member_id.clone()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(run_id.to_string()),
                message: AgentMessage::Plain {
                    summary: "Retry assigned Agent Org work".to_string(),
                    text: format!(
                        "A previous turn ended before your owned task(s) were resolved. Continue only these durable task ids: {}. Refresh task_list/task_get first, then update each task from its current state. Do not create replacement duplicates.",
                        action.task_ids.join(", ")
                    ),
                },
            })?;
        }
    }

    if !plan.wake_member_ids.is_empty() {
        let wake_hook = AppHandleInboxWakeHook::new(app_handle.clone());
        for member_id in &plan.wake_member_ids {
            wake_hook.wake_member(member_id, run_id);
        }
    }

    if let Some(reason) = plan.coordinator_repair_reason.as_deref() {
        let fingerprint = plan
            .coordinator_repair_fingerprint
            .as_deref()
            .unwrap_or(reason);
        if coordinator_notice_budget_allows(run_id, fingerprint)? {
            if insert_coordinator_stall_notice(run_id, reason)? {
                record_attempt(run_id, COORDINATOR_NOTICE, "coordinator", fingerprint)?;
                AppHandleInboxWakeHook::new(app_handle).wake_member(COORDINATOR_MEMBER_ID, run_id);
            }
        } else {
            tracing::debug!(
                run_id = %run_id,
                "[agent_org_watchdog] coordinator stall notice suppressed by budget (reason unchanged)"
            );
        }
    }

    Ok(plan)
}

fn insert_coordinator_stall_notice(run_id: &str, reason: &str) -> Result<bool, String> {
    if AgentOrgRunStore::get_run_status(run_id)? != Some(AgentOrgRunStatus::Running) {
        return Ok(false);
    }
    let store = crate::definitions::orgs::orgs_store();
    let Some(context) = AgentOrgRunStore::context_for_run(run_id, &store)? else {
        return Ok(false);
    };
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: context.coordinator_agent_id,
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
    })?;
    Ok(true)
}
