use super::*;

#[test]
fn pending_summary_omits_markdown_and_exact_revision_loads_detail() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    let summaries = AgentOrgPlanApprovalStore::list_pending_summaries_by_run(&context.run_id)
        .expect("list pending summaries");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].approval_id, pending.approval_id);
    assert_eq!(
        summaries[0].plan_content_bytes,
        u64::try_from(pending.plan_content.len()).expect("content length")
    );
    let serialized = serde_json::to_value(&summaries[0]).expect("serialize summary");
    assert!(serialized.get("planContent").is_none());
    assert!(serialized.get("planPath").is_none());

    let detail =
        AgentOrgPlanApprovalStore::get_revision(&pending.approval_id, &pending.plan_revision_id)
            .expect("load exact revision")
            .expect("detail exists");
    assert_eq!(detail.plan_content, pending.plan_content);
    assert!(
        AgentOrgPlanApprovalStore::get_revision(&pending.approval_id, "different-revision")
            .expect("load mismatched revision")
            .is_none()
    );
}

#[test]
fn run_scoped_revision_lookup_rejects_cross_run() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    let cross_run = AgentOrgPlanApprovalStore::get_revision_for_run(
        "different-run",
        &pending.approval_id,
        &pending.plan_revision_id,
    )
    .expect("cross-run lookup should be a normal miss");
    assert!(cross_run.is_none());

    let detail = AgentOrgPlanApprovalStore::get_revision_for_run(
        &context.run_id,
        &pending.approval_id,
        &pending.plan_revision_id,
    )
    .expect("authorized lookup")
    .expect("authorized revision exists");
    assert_eq!(detail.plan_content, pending.plan_content);
}

#[test]
fn watchdog_pending_task_projection_never_materializes_plan_markdown() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    // An invalid UTF-8 TEXT payload would fail `row.get::<_, String>` if
    // the watchdog accidentally selected plan_content. Selecting only the
    // source id remains valid and proves the hot path does not decode it.
    let conn = get_connection().unwrap();
    conn.execute(
        "DROP TRIGGER trg_agent_org_runtime_plan_revisions_immutable",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE agent_org_runtime_plan_revisions
         SET plan_content=CAST(X'80' AS TEXT)
         WHERE plan_revision_id=?1",
        params![&pending.plan_revision_id],
    )
    .unwrap();

    assert_eq!(
        AgentOrgPlanApprovalStore::pending_source_task_ids_by_run(&context.run_id).unwrap(),
        vec!["plan-task".to_string()]
    );
}
