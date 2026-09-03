use super::*;

#[test]
fn approval_completes_source_task_and_dispatches_unblocked_work() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "build-task".into(),
        org_run_id: context.run_id.clone(),
        subject: "Build the plan".into(),
        description: "Use the approved plan".into(),
        active_form: None,
        owner: Some("builder".into()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: vec!["plan-task".into()],
        metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "build" })),
    })
    .expect("create dependent task");
    let pending = create_pending_approval(&context);

    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect("approve");
    assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
    let output = crate::coordination::agent_org_tasks::task_output(&approved.task_outcome.current)
        .expect("plan output");
    assert!(output
        .content
        .as_deref()
        .is_some_and(|value| value.contains("Build it")));

    let wake_members = approved.wake_member_ids.clone();
    assert!(wake_members.contains(&"builder".to_string()));
    assert!(!wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
    let builder_inbox =
        AgentInboxStore::list_unread_for_member("builder", &context.run_id).unwrap();
    assert!(builder_inbox
        .iter()
        .any(|row| row.payload_kind == "task_assigned"));
}
#[test]
fn approval_policy_rejects_the_wrong_decision_actor() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect_err("coordinator cannot bypass user policy");
    assert!(error.contains("unauthorized"));
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn automatic_creation_approves_plan_task_in_one_transaction() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Automatic);
    create_plan_task(&context);

    let approved =
        AgentOrgPlanApprovalStore::create_and_approve_automatic(approval_params(&context))
            .expect("create and automatically approve");

    assert_eq!(
        approved.revision.status,
        AgentOrgPlanApprovalStatus::Approved
    );
    assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
    assert!(
        AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn approval_leaves_newly_ready_ownerless_task_for_coordinator_assignment() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "claim-after-plan".into(),
        org_run_id: context.run_id.clone(),
        subject: "Claim approved work".into(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: vec!["plan-task".into()],
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
            TASK_METADATA_EXECUTION_MODE: "build",
        })),
    })
    .expect("create ownerless dependent task");
    let pending = create_pending_approval(&context);
    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect("approve");

    let wake_members = approved.wake_member_ids.clone();
    assert!(!wake_members.contains(&"builder".to_string()));
    assert!(!wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
    assert!(
        AgentInboxStore::list_unread_for_member("builder", &context.run_id)
            .unwrap()
            .is_empty(),
        "ownerless work must not forge TaskAssigned or wake a candidate"
    );
    let task = AgentOrgTaskStore::get(&context.run_id, "claim-after-plan")
        .unwrap()
        .unwrap();
    assert_eq!(task.owner, None);
    assert_eq!(task.status, TaskStatus::Pending);
}
