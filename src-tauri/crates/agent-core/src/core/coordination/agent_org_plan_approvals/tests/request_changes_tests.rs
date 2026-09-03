use super::*;

#[test]
fn changes_requested_and_feedback_delivery_commit_together() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    let (changed, inbox_record) = AgentOrgPlanApprovalStore::request_changes(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "Add rollback coverage.",
        planner_changes_delivery(),
    )
    .expect("request plan changes");

    assert_eq!(changed.status, AgentOrgPlanApprovalStatus::ChangesRequested);
    assert_eq!(inbox_record.recipient_member_id.as_deref(), Some("planner"));
    assert_eq!(inbox_record.payload_kind, "plan_approval_response");
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn feedback_insert_failure_rolls_back_changes_requested_status() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    get_connection()
        .expect("test db")
        .execute("DROP TABLE agent_org_runtime_inbox", [])
        .expect("remove inbox to force delivery failure");

    AgentOrgPlanApprovalStore::request_changes(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "This feedback cannot be delivered.",
        planner_changes_delivery(),
    )
    .expect_err("delivery failure must reject the whole transition");

    assert_eq!(
        AgentOrgPlanApprovalStore::get(&pending.approval_id)
            .unwrap()
            .unwrap()
            .status,
        AgentOrgPlanApprovalStatus::Pending
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}
