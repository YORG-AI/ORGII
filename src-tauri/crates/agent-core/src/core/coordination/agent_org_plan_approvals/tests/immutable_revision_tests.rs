use super::*;

#[test]
fn revision_number_overflow_fails_closed() {
    assert_eq!(
        super::super::transitions::next_revision_number(None).unwrap(),
        1
    );
    assert_eq!(
        super::super::transitions::next_revision_number(Some(41)).unwrap(),
        42
    );
    assert_eq!(
        super::super::transitions::next_revision_number(Some(i64::MAX)).unwrap_err(),
        "agent_org_plan_revision_number_overflow"
    );
}

#[test]
fn user_approval_preserves_the_exact_immutable_revision() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::User,
        "root-plan-approval",
        None,
    )
    .expect("approve exact revision");

    assert_eq!(approved.revision.plan_content, pending.plan_content);
    assert_eq!(
        std::fs::read_to_string(&pending.plan_path).expect("read derived plan artifact"),
        pending.plan_content
    );
    let output = crate::coordination::agent_org_tasks::task_output(&approved.task_outcome.current)
        .expect("Planning Task output");
    assert_eq!(output.content, Some(pending.plan_content));
    assert_eq!(
        output.plan_revision_id.as_deref(),
        Some(pending.plan_revision_id.as_str())
    );
}

#[test]
fn invalid_derived_artifact_target_does_not_rollback_approval() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    std::fs::remove_file(&pending.plan_path).expect("remove materialized artifact");
    std::fs::create_dir(&pending.plan_path).expect("replace artifact with directory");

    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::User,
        "root-plan-approval",
        None,
    )
    .expect("SQLite approval remains authoritative");
    assert_eq!(
        approved.revision.status,
        AgentOrgPlanApprovalStatus::Approved
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
    std::fs::remove_dir(&pending.plan_path).expect("remove target directory");
}

#[test]
fn stale_revision_cannot_complete_a_plan_twice() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect("first approval");

    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect_err("same revision must be one-shot");
    assert!(error.contains("stale_revision"));
}

#[test]
fn new_revision_links_to_history_without_mutating_the_previous_version() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let first = create_pending_approval(&context);
    AgentOrgPlanApprovalStore::request_changes(
        &first.approval_id,
        &first.plan_revision_id,
        &first.source_task_id,
        &first.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "Add recovery coverage.",
        planner_changes_delivery(),
    )
    .unwrap();
    let mut second_params = approval_params(&context);
    second_params.request_id = "request-plan-revision-two".into();
    second_params.plan_content = "# Plan\n\n1. Build it.\n2. Verify recovery.".into();
    let second = AgentOrgPlanApprovalStore::create_pending(second_params).unwrap();

    assert_eq!(second.revision_number, 2);
    assert_eq!(
        second.previous_plan_revision_id.as_deref(),
        Some(first.plan_revision_id.as_str())
    );
    let history = AgentOrgPlanApprovalStore::list_revision_summaries_by_run_with_connection(
        &get_connection().unwrap(),
        &context.run_id,
        100,
    )
    .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(
        history
            .iter()
            .find(|revision| revision.plan_revision_id == first.plan_revision_id)
            .unwrap()
            .status,
        AgentOrgPlanApprovalStatus::ChangesRequested
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn run_view_plan_history_keeps_pending_first_then_uses_creation_time() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    let mut approvals = Vec::new();
    for (index, (task_id, turn_id, request_id)) in [
        ("plan-old", "planner-turn-old", "request-plan-old"),
        ("plan-new", "planner-turn-new", "request-plan-new"),
        (
            "plan-pending",
            "planner-turn-pending",
            "request-plan-pending",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        create_plan_task_with_ids(&context, task_id, turn_id, index as i64 + 1);
        let approval = AgentOrgPlanApprovalStore::create_pending(approval_params_with_ids(
            &context, task_id, turn_id, request_id,
        ))
        .expect("create independent plan approval");
        approvals.push(approval);
    }

    for approval in &approvals[..2] {
        AgentOrgPlanApprovalStore::approve(
            &approval.approval_id,
            &approval.plan_revision_id,
            &approval.source_task_id,
            &approval.source_turn_intent_id,
            AgentOrgPlanDecisionBy::User,
            "root-plan-approval",
            None,
        )
        .expect("approve historical plan");
    }

    let conn = get_connection().unwrap();
    let history = AgentOrgPlanApprovalStore::list_revision_summaries_by_run_with_connection(
        &conn,
        &context.run_id,
        100,
    )
    .unwrap();
    assert_eq!(
        history
            .iter()
            .map(|revision| revision.source_task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["plan-pending", "plan-new", "plan-old"]
    );
}

#[test]
fn sqlite_rejects_any_plan_revision_update() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let error = get_connection()
        .unwrap()
        .execute(
            "UPDATE agent_org_runtime_plan_revisions
             SET plan_content='# rewritten' WHERE plan_revision_id=?1",
            [&pending.plan_revision_id],
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("agent_org_plan_revision_immutable"));
    assert_eq!(
        AgentOrgPlanApprovalStore::get_revision(&pending.approval_id, &pending.plan_revision_id)
            .unwrap()
            .unwrap()
            .content_digest,
        pending.content_digest
    );
}
