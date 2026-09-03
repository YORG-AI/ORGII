use super::*;

#[test]
fn unknown_plan_decision_actor_fails_closed() {
    assert!(super::super::persistence::parse_decision_by(0, None)
        .unwrap()
        .is_none());
    assert_eq!(
        super::super::persistence::parse_decision_by(0, Some("automatic".into())).unwrap(),
        Some("automatic".into())
    );
    assert!(super::super::persistence::parse_decision_by(0, Some("mystery".into())).is_err());
}

#[test]
fn coordinator_request_and_pending_approval_commit_together() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);

    let approval = AgentOrgPlanApprovalStore::create_pending_with_request(
        approval_params(&context),
        coordinator_request_delivery(),
    )
    .expect("create approval and coordinator request");

    assert_eq!(approval.status, AgentOrgPlanApprovalStatus::Pending);
    let coordinator_inbox =
        AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, &context.run_id).unwrap();
    assert!(coordinator_inbox.iter().any(|row| {
        row.payload_kind == "plan_approval_request"
            && row.request_id.as_deref() == Some(approval.request_id.as_str())
    }));
}

#[test]
fn new_approval_rejects_external_non_plan_path() {
    let (sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let external_notes = sandbox.path().join("notes.md");
    std::fs::write(&external_notes, "user-owned notes").expect("seed external notes");
    let mut params = approval_params(&context);
    params.plan_path = external_notes.to_string_lossy().into_owned();

    let error = AgentOrgPlanApprovalStore::create_pending(params)
        .expect_err("an external notes path must be rejected");
    assert!(error.contains("*.plan.md") || error.contains("managed root"));
    assert_eq!(
        std::fs::read_to_string(&external_notes).expect("read external notes"),
        "user-owned notes"
    );
    assert!(
        AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
            .expect("list approvals")
            .is_empty()
    );
}

#[test]
fn coordinator_request_insert_failure_rolls_back_pending_creation() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    get_connection()
        .expect("test db")
        .execute("DROP TABLE agent_org_runtime_inbox", [])
        .expect("remove inbox to force request delivery failure");

    let params = approval_params(&context);
    let plan_path = PathBuf::from(&params.plan_path);
    let file_name = plan_path.file_name().unwrap().to_string_lossy();
    let staged_prefix = format!(".{file_name}.approval-");

    AgentOrgPlanApprovalStore::create_pending_with_request(params, coordinator_request_delivery())
        .expect_err("request delivery failure must reject approval creation");

    assert!(
        AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
    assert!(
        !plan_path.exists(),
        "a failed DB transaction must not install the derived plan artifact"
    );
    let leaked_stages = std::fs::read_dir(plan_path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(&staged_prefix) && name.ends_with(".tmp")
        })
        .count();
    assert_eq!(
        leaked_stages, 0,
        "a failed DB transaction must clean its pre-staged artifact"
    );
}
