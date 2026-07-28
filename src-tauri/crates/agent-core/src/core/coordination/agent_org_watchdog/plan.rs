//! [`StallRecoveryPlan`] and the concrete recovery actions [`super::inspect`]
//! decides on for one quiescent Agent Org run.

use super::*;

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
    /// Work revision observed with the task snapshot used to compose the
    /// coordinator repair. The executor compares it again under the shared
    /// writer lock before persisting the notice.
    pub coordinator_repair_work_revision: Option<i64>,
    /// Stable fingerprint of the canonical task state/graph used to compose
    /// the repair. This catches stale analyzer output even when a historical
    /// writer failed to bump `work_revision`.
    pub coordinator_repair_task_fingerprint: Option<String>,
    /// Stable fingerprint of typed unavailable-unread recipient facts used to
    /// compose the repair. The executor recomputes it before inserting a
    /// notice so a concurrently restored session or drained Inbox cannot
    /// produce stale guidance.
    pub coordinator_repair_inbox_fingerprint: Option<String>,
    /// Whether the coherent snapshot still contained any coordinator repair
    /// condition, including one temporarily suppressed by an already-unread
    /// coordinator message. A false value ends the previous fault episode and
    /// clears its notice budget so the same fault can be reported if it later
    /// genuinely recurs.
    pub coordinator_repair_active: bool,
    /// End a previously persisted coordinator fault episode. Set only when
    /// the analyzer sees no current repair *and* a budget row actually exists,
    /// avoiding one no-op writer transaction per healthy run per tick.
    pub clear_coordinator_notice_budget: bool,
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
            && self.coordinator_repair_work_revision.is_none()
            && self.coordinator_repair_task_fingerprint.is_none()
            && self.coordinator_repair_inbox_fingerprint.is_none()
            && !self.clear_coordinator_notice_budget
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

pub(super) fn ready_unassigned_repair_reason(task: &Task) -> String {
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
