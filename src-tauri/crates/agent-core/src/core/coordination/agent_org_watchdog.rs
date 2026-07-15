//! Agent Org watchdog: periodic stall detection and recovery.
//!
//! Every [`WATCHDOG_INTERVAL_SECS`] the watchdog scans running Agent Org
//! runs whose workers are all quiescent and produces a
//! [`StallRecoveryPlan`]:
//!
//! - **Wake members** that have durable input: unread inbox rows, a
//!   redelivered explicit assignment, or a concrete continuation message.
//!   Ownerless work and mere ownership are not wake signals: without real
//!   input they would create empty turns and UI flicker.
//! - **Escalate to the coordinator** when the board cannot make progress
//!   without explicit repair: tasks owned by dead members, stale
//!   `in_progress` work, and ready ownerless tasks awaiting explicit
//!   coordinator assignment (issue #272 E1).
//! - **Reconcile the run** when every task is resolved and every worker
//!   is terminal.
//!
//! Failed members are rate-limited by a per-`(run, member)` rewake budget
//! (three attempts with 1/5/15-minute backoff) that resets on the next
//! successful member turn.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::AppHandle;

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore;
use crate::coordination::agent_org_runs::{
    AgentOrgRunStatus, AgentOrgRunStore, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{self, Task, TaskStatus};
use crate::core::session::SessionStatus;
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;

const WATCHDOG_INTERVAL_SECS: u64 = 60;
const RECOVERY_DELAYS_SECS: [i64; 3] = [60, 5 * 60, 15 * 60];
const MEMBER_REWAKE: &str = "member_rewake";
const COORDINATOR_NOTICE: &str = "coordinator_notice";

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_recovery_attempts (
            org_run_id TEXT NOT NULL,
            action_kind TEXT NOT NULL,
            target_key TEXT NOT NULL,
            reason_fingerprint TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_allowed_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (org_run_id, action_kind, target_key)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_recovery_attempts_run
            ON agent_org_recovery_attempts(org_run_id);",
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BudgetDisposition {
    Allowed,
    Backoff,
    Exhausted,
}

fn budget_disposition(
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<BudgetDisposition, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT reason_fingerprint, attempts, next_allowed_at
             FROM agent_org_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
            params![run_id, action_kind, target_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((stored_fingerprint, attempts, next_allowed_at)) = row else {
        return Ok(BudgetDisposition::Allowed);
    };
    if stored_fingerprint != fingerprint {
        return Ok(BudgetDisposition::Allowed);
    }
    if attempts >= RECOVERY_DELAYS_SECS.len() as i64 {
        return Ok(BudgetDisposition::Exhausted);
    }
    let next_allowed_at = match DateTime::parse_from_rfc3339(&next_allowed_at) {
        Ok(parsed) => parsed.with_timezone(&Utc),
        Err(err) => {
            // A corrupt persisted deadline must not suppress recovery forever.
            // Fail open for this tick; an accepted action rewrites the row with
            // a valid UTC timestamp through `record_attempt`.
            tracing::warn!(
                run_id,
                action_kind,
                target_key,
                value = %next_allowed_at,
                error = %err,
                "[agent_org_watchdog] invalid recovery deadline; allowing retry"
            );
            return Ok(BudgetDisposition::Allowed);
        }
    };
    Ok(if Utc::now() < next_allowed_at {
        BudgetDisposition::Backoff
    } else {
        BudgetDisposition::Allowed
    })
}

fn record_attempt(
    run_id: &str,
    action_kind: &str,
    target_key: &str,
    fingerprint: &str,
) -> Result<(), String> {
    with_sessions_writer(|| -> Result<(), String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let previous: Option<(String, i64)> = tx
            .query_row(
                "SELECT reason_fingerprint, attempts FROM agent_org_recovery_attempts
                 WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
                params![run_id, action_kind, target_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let attempts = match previous {
            Some((stored, attempts)) if stored == fingerprint => attempts + 1,
            _ => 1,
        };
        let delay_index =
            (attempts.saturating_sub(1) as usize).min(RECOVERY_DELAYS_SECS.len().saturating_sub(1));
        let now = Utc::now();
        let next = now + ChronoDuration::seconds(RECOVERY_DELAYS_SECS[delay_index]);
        tx.execute(
            "INSERT INTO agent_org_recovery_attempts
                 (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(org_run_id, action_kind, target_key) DO UPDATE SET
                 reason_fingerprint=excluded.reason_fingerprint,
                 attempts=excluded.attempts,
                 next_allowed_at=excluded.next_allowed_at,
                 updated_at=excluded.updated_at",
            params![run_id, action_kind, target_key, fingerprint, attempts, next.to_rfc3339(), now.to_rfc3339()],
        )
        .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())
    })
}

pub fn clear_rewake_budget(run_id: &str, member_id: &str) -> Result<(), String> {
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_org_recovery_attempts
             WHERE org_run_id=?1 AND action_kind=?2 AND target_key=?3",
            params![run_id, MEMBER_REWAKE, member_id],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    })
}

pub(crate) fn record_accepted_member_rewake(
    run_id: &str,
    member_id: &str,
    status: SessionStatus,
) -> Result<(), String> {
    record_attempt(run_id, MEMBER_REWAKE, member_id, status.as_str())
}

#[cfg(test)]
pub fn test_only_mark_failed_rewake_attempt(run_id: &str, member_id: &str) -> bool {
    if !delayed_rewake_allowed(run_id, member_id, SessionStatus::Failed) {
        return false;
    }
    record_attempt(run_id, MEMBER_REWAKE, member_id, "failed").is_ok()
}

fn delayed_rewake_allowed(run_id: &str, member_id: &str, status: SessionStatus) -> bool {
    if status == SessionStatus::Idle {
        return true;
    }
    matches!(
        budget_disposition(run_id, MEMBER_REWAKE, member_id, status.as_str()),
        Ok(BudgetDisposition::Allowed)
    )
}

/// Non-mutating budget probe: `true` once every rewake attempt for the
/// `(run, member)` pair has been consumed. Distinct from "currently in a
/// backoff window": an exhausted budget never recovers without a
/// successful member turn (which clears it), so it marks the member as
/// beyond autonomous recovery.
fn rewake_budget_exhausted(run_id: &str, member_id: &str, status: SessionStatus) -> bool {
    matches!(
        budget_disposition(run_id, MEMBER_REWAKE, member_id, status.as_str()),
        Ok(BudgetDisposition::Exhausted)
    )
}

fn reason_fingerprint(reason: &str) -> String {
    blake3::hash(reason.as_bytes()).to_hex().to_string()
}

/// Coordinator stall notices for an *unchanged* repair reason back off
/// (1/5/15 min) and stop after [`RECOVERY_DELAYS_SECS`] attempts, so a
/// coordinator that cannot (or will not) repair does not get an
/// unbounded LLM-turn loop every watchdog tick (issue #272 E5). Any
/// change to the reason payload — which every actual repair produces,
/// since it mutates task state — resets the budget.
#[cfg(test)]
fn coordinator_notice_allowed(run_id: &str, reason: &str) -> bool {
    let fingerprint = reason_fingerprint(reason);
    if !coordinator_notice_budget_allows(run_id, &fingerprint) {
        return false;
    }
    record_attempt(run_id, COORDINATOR_NOTICE, "coordinator", &fingerprint).is_ok()
}

fn coordinator_notice_budget_allows(run_id: &str, fingerprint: &str) -> bool {
    matches!(
        budget_disposition(run_id, COORDINATOR_NOTICE, "coordinator", fingerprint),
        Ok(BudgetDisposition::Allowed)
    )
}

/// Recovery actions the watchdog decided on for one quiescent run.
///
/// Unlike the previous four-state enum, actions are not mutually
/// exclusive: one tick may redeliver concrete member input AND escalate an
/// unrelated stale or unassigned task to the coordinator.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StallRecoveryPlan {
    /// Idle/terminal members to wake for unread inbox rows (missed
    /// delivery). May include
    /// [`COORDINATOR_MEMBER_ID`] for coordinator missed deliveries.
    pub wake_member_ids: Vec<String>,
    /// Terminal members that still own open work. The executor persists one
    /// concrete continuation message before waking them; ownership alone is
    /// never used as model input.
    pub continuation_actions: Vec<MemberContinuationAction>,
    /// Ready, owned Pending tasks whose original TaskAssigned delivery was
    /// lost. The executor recreates the typed assignment before waking.
    pub assignment_actions: Vec<MemberTaskAssignmentAction>,
    /// Human-readable repair reasons for the coordinator, one per
    /// stalled task. `Some` only when the coordinator has no unread
    /// inbox rows (an unread notice already covers redelivery via
    /// `wake_member_ids`).
    pub coordinator_repair_reason: Option<String>,
    /// Stable hash of typed repair facts (task/reason/member ids), excluding
    /// prose and timestamps so copy edits do not reset the retry budget.
    pub coordinator_repair_fingerprint: Option<String>,
    /// Every task resolved + every worker terminal: the run can be
    /// reconciled to a terminal status.
    pub terminal_candidate: bool,
}

impl StallRecoveryPlan {
    pub fn is_noop(&self) -> bool {
        self.wake_member_ids.is_empty()
            && self.continuation_actions.is_empty()
            && self.assignment_actions.is_empty()
            && self.coordinator_repair_reason.is_none()
            && self.coordinator_repair_fingerprint.is_none()
            && !self.terminal_candidate
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberContinuationAction {
    pub member_id: String,
    pub recipient_agent_id: String,
    pub task_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberTaskAssignmentAction {
    pub member_id: String,
    pub recipient_agent_id: String,
    pub task_ids: Vec<String>,
}

fn ready_unassigned_repair_reason(task: &Task) -> String {
    let mut eligible = agent_org_tasks::eligible_member_ids(task);
    eligible.sort();
    if eligible.is_empty() {
        format!(
            "task {} is ready but has no owner and no eligible_member_ids. Repair eligibility, then choose an explicit owner_member_id; workers cannot self-claim it.",
            task.id
        )
    } else {
        format!(
            "task {} is ready but has no owner. Workers cannot self-claim it; choose an explicit owner_member_id from eligible_member_ids [{}].",
            task.id,
            eligible.join(", ")
        )
    }
}

pub fn spawn(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(WATCHDOG_INTERVAL_SECS));
        // A slow scan must not be "repaid" with back-to-back burst
        // ticks afterwards; the next scheduled tick is enough.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let handle = app_handle.clone();
            if let Err(err) =
                tokio::task::spawn_blocking(move || recover_all_stalled_runs(handle)).await
            {
                tracing::warn!(error = %err, "[agent_org_watchdog] watchdog task join failed");
            }
        }
    });
}

fn recover_all_stalled_runs(app_handle: AppHandle) -> Result<(), String> {
    let runs = AgentOrgRunStore::list_running_runs(usize::MAX)?;
    prune_recovery_budgets()?;
    AgentOrgPlanApprovalStore::cancel_pending_for_non_running_runs()?;
    for run in runs {
        recover_stalled_run(app_handle.clone(), &run.id)?;
    }
    Ok(())
}

/// Drop budget entries whose run is no longer running so the
/// process-global maps cannot grow unbounded over the app lifetime
/// (issue #272 E6). Paused runs also lose their entries; resuming one
/// intentionally grants a fresh set of recovery attempts.
fn prune_recovery_budgets() -> Result<(), String> {
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_org_recovery_attempts
             WHERE NOT EXISTS (
                 SELECT 1 FROM agent_org_runs run
                 WHERE run.id = agent_org_recovery_attempts.org_run_id
                   AND run.status = ?1
             )",
            params![AgentOrgRunStatus::Running.as_str()],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    })
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
        if coordinator_notice_budget_allows(run_id, fingerprint) {
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

pub fn inspect_stalled_run(run_id: &str) -> Result<StallRecoveryPlan, String> {
    if AgentOrgRunStore::get_run_status(run_id)? != Some(AgentOrgRunStatus::Running) {
        return Ok(StallRecoveryPlan::default());
    }

    let tasks = agent_org_tasks::AgentOrgTaskStore::list(run_id)?;
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
                let ready = task.status == TaskStatus::Pending
                    && task.blocked_by.iter().all(|blocker_id| {
                        tasks
                            .iter()
                            .find(|candidate| &candidate.id == blocker_id)
                            .is_some_and(|candidate| candidate.status.is_resolved())
                    });
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
    let historically_assigned_task_ids = AgentInboxStore::list_by_run(run_id)?
        .into_iter()
        .filter_map(|row| match row.decode_payload().ok()? {
            AgentMessage::TaskAssigned { task_id, .. } => Some(task_id),
            _ => None,
        })
        .collect::<HashSet<_>>();
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
                && task.blocked_by.iter().all(|blocker_id| {
                    tasks
                        .iter()
                        .find(|candidate| &candidate.id == blocker_id)
                        .is_some_and(|candidate| candidate.status.is_resolved())
                })
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
        if !delayed_rewake_allowed(run_id, member_id, worker.status) {
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
            if is_wakeable_status(info.status)
                && delayed_rewake_allowed(run_id, COORDINATOR_MEMBER_ID, info.status)
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
            } else if owner_status.is_some_and(|status| {
                status.is_terminal() && rewake_budget_exhausted(run_id, owner, status)
            }) {
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

    let coordinator_repair_reason = if !needs_repair.is_empty() && !coordinator_unread {
        Some(needs_repair.join("\n"))
    } else {
        None
    };
    repair_keys.sort();
    let coordinator_repair_fingerprint = coordinator_repair_reason
        .as_ref()
        .map(|_| reason_fingerprint(&repair_keys.join("|")));

    let has_open_tasks = tasks.iter().any(|task| !task.status.is_resolved());
    let terminal_candidate = !tasks.is_empty()
        && !has_open_tasks
        && wake_member_ids.is_empty()
        && !coordinator_unread
        && coordinator_repair_reason.is_none()
        && !workers.is_empty()
        && workers
            .iter()
            .all(|worker| is_quiescent_completed_run_status(worker.status));

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

fn is_quiescent_completed_run_status(status: SessionStatus) -> bool {
    match status {
        SessionStatus::Idle
        | SessionStatus::Completed
        | SessionStatus::Failed
        | SessionStatus::Cancelled
        | SessionStatus::Abandoned
        | SessionStatus::Timeout
        | SessionStatus::Archived => true,
        SessionStatus::Pending
        | SessionStatus::Running
        | SessionStatus::WaitingForUser
        | SessionStatus::WaitingForFunds
        | SessionStatus::Paused => false,
    }
}

fn is_wakeable_status(status: SessionStatus) -> bool {
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

fn has_unread_for_member(run_id: &str, member_id: &str) -> Result<bool, String> {
    AgentInboxStore::has_unread_for_member(member_id, run_id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_inbox::AgentInboxStore;
    use crate::coordination::agent_org_runs::{AgentOrgRunEntryMode, CreateAgentOrgRunParams};
    use crate::coordination::agent_org_tasks::{
        AgentOrgTaskStore, CreateTaskParams, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
    };
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};
    use crate::session::persistence::{session_type, UnifiedSessionRecord};

    #[test]
    fn wakeable_status_includes_idle_and_terminal_but_not_running() {
        assert!(is_wakeable_status(SessionStatus::Idle));
        assert!(is_wakeable_status(SessionStatus::Failed));
        assert!(!is_wakeable_status(SessionStatus::Running));
    }

    #[test]
    fn delayed_rewake_budget_limits_and_clears_failed_member_retries() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-a";
        assert!(test_only_mark_failed_rewake_attempt(&run_id, member_id));
        assert!(!delayed_rewake_allowed(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed
        ));
        assert!(delayed_rewake_allowed(
            run_id.as_str(),
            member_id,
            SessionStatus::Idle
        ));
        clear_rewake_budget(run_id.as_str(), member_id).unwrap();
        assert!(delayed_rewake_allowed(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed
        ));
    }

    #[test]
    fn corrupt_recovery_deadline_does_not_suppress_retry_forever() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
                 (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 1, 'not-a-timestamp', ?5)",
            params![
                "run-corrupt-budget",
                MEMBER_REWAKE,
                "member-a",
                SessionStatus::Failed.as_str(),
                Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();

        assert!(delayed_rewake_allowed(
            "run-corrupt-budget",
            "member-a",
            SessionStatus::Failed
        ));
    }

    #[test]
    fn coordinator_notice_budget_backs_off_and_resets_on_new_reason() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        assert!(coordinator_notice_allowed(&run_id, "task a stuck"));
        assert!(
            !coordinator_notice_allowed(&run_id, "task a stuck"),
            "identical reason must back off instead of nagging every tick"
        );
        assert!(
            coordinator_notice_allowed(&run_id, "task b stuck"),
            "a changed reason means board state moved; budget must reset"
        );
        assert!(!coordinator_notice_allowed(&run_id, "task b stuck"));
    }

    #[test]
    fn rewake_budget_exhausted_only_after_all_attempts_consumed() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let member_id = "member-x";
        assert!(!rewake_budget_exhausted(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed
        ));
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, 'failed', ?4, ?5, ?5)",
            params![run_id, MEMBER_REWAKE, member_id, RECOVERY_DELAYS_SECS.len() as i64, Utc::now().to_rfc3339()],
        )
        .expect("seed exhausted budget");
        assert!(rewake_budget_exhausted(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed
        ));
        clear_rewake_budget(run_id.as_str(), member_id).unwrap();
        assert!(!rewake_budget_exhausted(
            run_id.as_str(),
            member_id,
            SessionStatus::Failed
        ));
    }

    #[test]
    fn prune_recovery_budgets_drops_entries_for_finished_runs() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db");
        init_schema(&conn).expect("schema");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        let live_run = format!("run-{}", uuid::Uuid::new_v4());
        let dead_run = format!("run-{}", uuid::Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        for (run_id, status) in [
            (&live_run, AgentOrgRunStatus::Running),
            (&dead_run, AgentOrgRunStatus::Completed),
        ] {
            conn.execute(
                "INSERT INTO agent_org_runs
                 (id, org_id, coordinator_agent_id, entry_mode, status, created_at, updated_at)
                 VALUES (?1, 'org', 'coord', 'standalone_session', ?2, ?3, ?3)",
                params![run_id, status.as_str(), now],
            )
            .expect("seed run");
        }
        record_attempt(&live_run, MEMBER_REWAKE, "m", "failed").unwrap();
        record_attempt(&dead_run, MEMBER_REWAKE, "m", "failed").unwrap();
        assert!(coordinator_notice_allowed(&live_run, "reason"));
        assert!(coordinator_notice_allowed(&dead_run, "reason"));

        prune_recovery_budgets().unwrap();

        let count_for = |run_id: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_org_recovery_attempts WHERE org_run_id=?1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(count_for(&live_run), 2);
        assert_eq!(count_for(&dead_run), 0);
    }

    #[test]
    fn corrupt_timestamps_count_as_stale() {
        assert!(
            is_stale_in_progress("not-a-timestamp", None),
            "corrupt task timestamp must escalate instead of silently exempting the task"
        );
        let old = (Utc::now()
            - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS * 2))
        .to_rfc3339();
        assert!(is_stale_in_progress(&old, Some(&"garbage".to_string())));
    }

    // ==========================================================
    // DB-backed state-machine tests for inspect_stalled_run
    // ==========================================================

    fn ensure_runtime_schemas() {
        let conn = database::db::get_connection().expect("test sqlite connection");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org tasks schema");
        crate::coordination::agent_org_plan_approvals::init_schema(&conn)
            .expect("agent org plan approvals schema");
        init_schema(&conn).expect("agent org recovery schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
        crate::coordination::agent_member_interventions::init_schema(&conn)
            .expect("agent member interventions schema");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS code_sessions (
                session_id TEXT PRIMARY KEY,
                cli_agent_type TEXT NOT NULL,
                status TEXT NOT NULL,
                parent_session_id TEXT,
                org_member_id TEXT,
                updated_at TEXT NOT NULL
            );",
        )
        .expect("cli session schema");
    }

    fn org_definition(member_ids: &[&str]) -> OrgDefinition {
        OrgDefinition {
            id: "org-watchdog".to_string(),
            name: "Watchdog Org".to_string(),
            role: "coordinator".to_string(),
            agent_id: "builtin:coord".to_string(),
            description: None,
            instructions: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: member_ids
                .iter()
                .map(|member_id| OrgMember {
                    id: (*member_id).to_string(),
                    name: (*member_id).to_string(),
                    role: "builder".to_string(),
                    agent_id: "builtin:sde".to_string(),
                    instructions: None,
                    runtime_config: None,
                    children: Vec::new(),
                })
                .collect(),
        }
    }

    fn upsert_session(
        session_id: &str,
        session_type_value: &str,
        status: SessionStatus,
        org_member_id: Option<&str>,
        parent_session_id: Option<&str>,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(&UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: session_id.to_string(),
            status: status.as_str().to_string(),
            session_type: session_type_value.to_string(),
            created_at: now.clone(),
            updated_at: now,
            agent_definition_id: Some("builtin:sde".to_string()),
            org_member_id: org_member_id.map(str::to_string),
            parent_session_id: parent_session_id.map(str::to_string),
            ..Default::default()
        })
        .expect("upsert session");
    }

    /// Seed a Running org run with a coordinator root session plus one
    /// worker session per `(member_id, status)` pair. Returns the run id.
    fn seed_run_with_workers(members: &[(&str, SessionStatus)]) -> String {
        ensure_runtime_schemas();
        upsert_session(
            "root-session",
            session_type::GENERIC,
            SessionStatus::Idle,
            None,
            None,
        );
        for (member_id, status) in members {
            upsert_session(
                &format!("session-{member_id}"),
                session_type::ORG_MEMBER,
                *status,
                Some(member_id),
                Some("root-session"),
            );
        }
        let member_ids: Vec<&str> = members.iter().map(|(member_id, _)| *member_id).collect();
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: "org-watchdog".to_string(),
            coordinator_agent_id: "builtin:coord".to_string(),
            root_session_id: Some("root-session".to_string()),
            org_snapshot: org_definition(&member_ids),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create run");
        run.id
    }

    fn seed_task(
        run_id: &str,
        task_id: &str,
        owner: Option<&str>,
        status: TaskStatus,
        eligible: Option<&[&str]>,
    ) {
        if owner.is_none() && status == TaskStatus::Pending && eligible.is_none() {
            let conn = get_connection().expect("db");
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO agent_org_tasks
                 (id, org_run_id, subject, description, status, blocks_json, blocked_by_json, created_at, updated_at)
                 VALUES (?1, ?2, ?1, '', 'pending', '[]', '[]', ?3, ?3)",
                params![task_id, run_id, now],
            )
            .expect("seed historical invalid task");
            return;
        }
        AgentOrgTaskStore::create(CreateTaskParams {
            id: task_id.to_string(),
            org_run_id: run_id.to_string(),
            subject: task_id.to_string(),
            description: String::new(),
            active_form: None,
            owner: owner.map(str::to_string),
            status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: eligible.map(
                |member_ids| serde_json::json!({ TASK_METADATA_ELIGIBLE_MEMBER_IDS: member_ids }),
            ),
        })
        .expect("create task");
    }

    fn seed_unread(run_id: &str, member_id: &str) {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: Some(member_id.to_string()),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(run_id.to_string()),
            message: AgentMessage::Plain {
                summary: "note".to_string(),
                text: "pending note".to_string(),
            },
        })
        .expect("insert unread inbox row");
    }

    fn exhaust_rewake_budget(run_id: &str, member_id: &str) {
        let conn = get_connection().expect("db");
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts, next_allowed_at, updated_at)
             VALUES (?1, ?2, ?3, 'failed', ?4, ?5, ?5)
             ON CONFLICT(org_run_id, action_kind, target_key) DO UPDATE SET attempts=excluded.attempts",
            params![run_id, MEMBER_REWAKE, member_id, RECOVERY_DELAYS_SECS.len() as i64, Utc::now().to_rfc3339()],
        )
        .expect("exhaust recovery budget");
    }

    #[test]
    fn wakes_idle_member_with_unread_inbox_even_without_assigned_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert!(plan.assignment_actions.is_empty());
        assert!(plan.continuation_actions.is_empty());
        assert_eq!(plan.coordinator_repair_reason, None);
        assert!(!plan.terminal_candidate);
    }

    #[test]
    fn wakes_terminal_member_that_still_owns_open_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "owned-retry",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert_eq!(plan.coordinator_repair_reason, None);
    }

    #[test]
    fn recreates_typed_assignment_for_idle_owner_when_delivery_was_lost() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(
            &run_id,
            "missed-assignment",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert_eq!(plan.wake_member_ids, vec!["member-a".to_string()]);
        assert_eq!(plan.assignment_actions.len(), 1);
        assert_eq!(
            plan.assignment_actions[0].task_ids,
            vec!["missed-assignment"]
        );
        assert!(plan.continuation_actions.is_empty());
    }

    #[test]
    fn pending_plan_approval_is_intentionally_quiet_not_stale_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "plan-awaiting-user".to_string(),
            org_run_id: run_id.clone(),
            subject: "Plan before build".to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-a".to_string()),
            status: TaskStatus::InProgress,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                agent_org_tasks::TASK_METADATA_EXECUTION_MODE: "plan"
            })),
        })
        .expect("create planning task");
        crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore::create_pending(
            crate::coordination::agent_org_plan_approvals::CreateAgentOrgPlanApprovalParams {
                request_id: "request-awaiting-user".to_string(),
                org_run_id: run_id.clone(),
                source_task_id: "plan-awaiting-user".to_string(),
                source_member_id: "member-a".to_string(),
                source_session_id: "session-member-a".to_string(),
                root_session_id: "root-session".to_string(),
                policy: PlanApprovalPolicy::User,
                plan_title: "Plan".to_string(),
                plan_path: "/tmp/plan-awaiting-user.md".to_string(),
                plan_content: "# Plan".to_string(),
            },
        )
        .expect("create pending approval");
        let stale = (Utc::now()
            - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS * 2))
        .to_rfc3339();
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_org_tasks SET updated_at=?1 WHERE id='plan-awaiting-user'",
            params![stale],
        )
        .unwrap();

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.is_noop(),
            "pending approval must wait without model turns"
        );
    }

    #[test]
    fn owned_work_waits_during_backoff_then_escalates_only_when_exhausted() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "owned-retry",
            Some("member-a"),
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        assert!(test_only_mark_failed_rewake_attempt(&run_id, "member-a"));

        let backoff = inspect_stalled_run(&run_id).expect("inspect backoff");
        assert!(backoff.wake_member_ids.is_empty());
        assert!(backoff.coordinator_repair_reason.is_none());

        exhaust_rewake_budget(&run_id, "member-a");
        let exhausted = inspect_stalled_run(&run_id).expect("inspect exhausted");
        assert!(exhausted.wake_member_ids.is_empty());
        assert!(exhausted
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("automatic retry budget is exhausted")));
    }

    #[test]
    fn unread_member_wakes_but_ownerless_peer_work_waits_for_coordinator() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Idle),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_unread(&run_id, "member-a");
        seed_task(
            &run_id,
            "claim-me",
            None,
            TaskStatus::Pending,
            Some(&["member-b"]),
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids.contains(&"member-a".to_string()),
            "unread member must be woken (missed delivery), got {:?}",
            plan.wake_member_ids
        );
        assert!(!plan.wake_member_ids.contains(&"member-b".to_string()));
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("claim-me") && reason.contains("no owner")));
    }

    #[test]
    fn wakes_coordinator_with_unread_inbox() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_unread(&run_id, COORDINATOR_MEMBER_ID);
        // Keep one open task so the run is not a terminal candidate.
        seed_task(&run_id, "open", Some("member-a"), TaskStatus::Pending, None);

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids
                .contains(&COORDINATOR_MEMBER_ID.to_string()),
            "idle coordinator with unread inbox must be redelivered, got {:?}",
            plan.wake_member_ids
        );
    }

    #[test]
    fn escalates_ownerless_task_without_waking_failed_candidate() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "stuck",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        exhaust_rewake_budget(&run_id, "member-a");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        let reason = plan
            .coordinator_repair_reason
            .expect("exhausted eligible members must escalate to the coordinator");
        assert!(reason.contains("stuck"));
        assert!(reason.contains("member-a"));
        assert!(!plan.terminal_candidate);
    }

    #[test]
    fn ownerless_task_still_requires_coordinator_during_member_backoff() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Failed)]);
        seed_task(
            &run_id,
            "retry-later",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        // One consumed attempt: inside the backoff window, not exhausted.
        assert!(test_only_mark_failed_rewake_attempt(&run_id, "member-a"));

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.wake_member_ids.is_empty(),
            "member is inside its backoff window"
        );
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("retry-later") && reason.contains("no owner")));
    }

    #[test]
    fn escalates_unowned_task_without_eligibility_list() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Idle)]);
        seed_task(&run_id, "orphan", None, TaskStatus::Pending, None);

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        let reason = plan
            .coordinator_repair_reason
            .expect("unowned task without eligibility must escalate");
        assert!(reason.contains("orphan"));
        assert!(reason.contains("no eligible_member_ids"));
    }

    #[test]
    fn reports_terminal_candidate_when_everything_resolved() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Completed)]);
        seed_task(
            &run_id,
            "done",
            Some("member-a"),
            TaskStatus::Completed,
            None,
        );

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.terminal_candidate);
        assert!(plan.wake_member_ids.is_empty());
        assert_eq!(plan.coordinator_repair_reason, None);
    }

    #[test]
    fn active_worker_keeps_run_untouched() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Running),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_unread(&run_id, "member-b");

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(
            plan.is_noop(),
            "any active worker keeps the watchdog hands-off (known limitation, issue #272 E3)"
        );
    }

    #[test]
    fn stale_running_owner_only_generates_coordinator_notice() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[
            ("member-a", SessionStatus::Running),
            ("member-b", SessionStatus::Idle),
        ]);
        seed_task(
            &run_id,
            "stale-owned",
            Some("member-a"),
            TaskStatus::InProgress,
            Some(&["member-a", "member-b"]),
        );
        seed_task(
            &run_id,
            "ownerless-awaiting-assignment",
            None,
            TaskStatus::Pending,
            Some(&["member-b"]),
        );
        let old = (Utc::now()
            - ChronoDuration::seconds(agent_org_tasks::STALE_MEMBER_NOTICE_SECS + 1))
        .to_rfc3339();
        let conn = get_connection().expect("db");
        conn.execute(
            "UPDATE agent_sessions SET updated_at=?1 WHERE session_id='session-member-a'",
            params![&old],
        )
        .unwrap();
        conn.execute(
            "UPDATE agent_org_tasks SET updated_at=?1 WHERE org_run_id=?2 AND id='stale-owned'",
            params![&old, &run_id],
        )
        .unwrap();

        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty(), "E3 suppresses peer wake");
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("stale-owned")));
    }

    #[test]
    fn paused_only_eligible_member_escalates_instead_of_waking() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Paused)]);
        seed_task(
            &run_id,
            "paused-work",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("paused-work")));
    }

    #[test]
    fn ownerless_task_waits_for_coordinator_even_when_candidate_is_pending() {
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run_with_workers(&[("member-a", SessionStatus::Pending)]);
        seed_task(
            &run_id,
            "pending-work",
            None,
            TaskStatus::Pending,
            Some(&["member-a"]),
        );
        let plan = inspect_stalled_run(&run_id).expect("inspect");
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("pending-work")));
    }

    #[test]
    fn historical_cli_member_is_escalated_instead_of_rust_woken() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_runtime_schemas();
        upsert_session(
            "root-session",
            session_type::GENERIC,
            SessionStatus::Idle,
            None,
            None,
        );
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: "org-watchdog".to_string(),
            coordinator_agent_id: "builtin:coord".to_string(),
            root_session_id: Some("root-session".to_string()),
            org_snapshot: org_definition(&["member-cli"]),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .unwrap();
        let conn = get_connection().unwrap();
        conn.execute(
            "INSERT INTO code_sessions
             (session_id, cli_agent_type, status, parent_session_id, org_member_id, updated_at)
             VALUES ('cli-session', 'claude_code', 'idle', 'root-session', 'member-cli', ?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        seed_task(
            &run.id,
            "cli-owned",
            Some("member-cli"),
            TaskStatus::Pending,
            Some(&["member-cli"]),
        );

        let plan = inspect_stalled_run(&run.id).unwrap();
        assert!(plan.wake_member_ids.is_empty());
        assert!(plan
            .coordinator_repair_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("transport is unsupported")));
    }
}
