use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanDecisionStatus, AgentOrgPlanRevision,
};
use crate::definitions::orgs::PlanApprovalPolicy;

use super::drain::user_plan_response_matches_revision;

fn changes_requested_revision() -> AgentOrgPlanRevision {
    AgentOrgPlanRevision {
        approval_id: "approval-1".to_string(),
        plan_revision_id: "revision-1".to_string(),
        revision_number: 1,
        previous_plan_revision_id: None,
        request_id: "request-1".to_string(),
        org_run_id: "run-1".to_string(),
        source_task_id: "task-1".to_string(),
        source_member_id: "planner".to_string(),
        source_session_id: "planner-session".to_string(),
        source_turn_intent_id: "planner-turn".to_string(),
        root_session_id: "root-session".to_string(),
        policy: PlanApprovalPolicy::User,
        status: AgentOrgPlanDecisionStatus::ChangesRequested,
        plan_title: "Plan".to_string(),
        plan_path: "/tmp/plan.md".to_string(),
        plan_content: "Immutable plan body".to_string(),
        content_digest: "a".repeat(64),
        decision_by: Some("user".to_string()),
        feedback: Some("Add checkpoints".to_string()),
        task_output: None,
        created_at: "2026-08-28T00:00:00Z".to_string(),
        resolved_at: Some("2026-08-28T00:00:01Z".to_string()),
    }
}

#[test]
fn exact_user_changes_request_is_authorized_for_its_planner() {
    let revision = changes_requested_revision();

    assert!(user_plan_response_matches_revision(
        &revision,
        "planner",
        "request-1",
        false,
        Some("Add checkpoints"),
    ));
}

#[test]
fn mismatched_or_accepted_user_response_is_not_authority() {
    let revision = changes_requested_revision();

    assert!(!user_plan_response_matches_revision(
        &revision,
        "another-member",
        "request-1",
        false,
        Some("Add checkpoints"),
    ));
    assert!(!user_plan_response_matches_revision(
        &revision,
        "planner",
        "request-1",
        true,
        Some("Add checkpoints"),
    ));
    assert!(!user_plan_response_matches_revision(
        &revision,
        "planner",
        "request-1",
        false,
        Some("Different feedback"),
    ));
}
