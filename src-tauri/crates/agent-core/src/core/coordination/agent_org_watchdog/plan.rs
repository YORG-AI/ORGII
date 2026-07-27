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
    /// Stable hash of the repair state keys used to reset the notice budget
    /// when the underlying stalled board changes.
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
