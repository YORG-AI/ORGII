use super::{
    assignment_requires_coordinator_observation, committed_task_outbox_wake_member_ids,
    TaskOutboxCommit,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

#[test]
fn only_an_exact_coordinator_turn_suppresses_assignment_observation() {
    assert!(!assignment_requires_coordinator_observation(
        Some(COORDINATOR_MEMBER_ID),
        Some("coordinator-turn")
    ));
    assert!(assignment_requires_coordinator_observation(
        Some(COORDINATOR_MEMBER_ID),
        None
    ));
    assert!(assignment_requires_coordinator_observation(
        Some("additional-writer"),
        Some("writer-turn")
    ));
    assert!(assignment_requires_coordinator_observation(None, None));
}

#[test]
fn pending_assignment_observation_adds_one_coordinator_doorbell() {
    let outbox = TaskOutboxCommit {
        coordinator_observation_required: true,
        task_completed_notified: true,
        ..TaskOutboxCommit::default()
    };
    assert_eq!(
        committed_task_outbox_wake_member_ids(&outbox),
        vec![COORDINATOR_MEMBER_ID],
        "multiple formal facts in one transaction must coalesce the runtime kick without merging receipt identities"
    );
}
