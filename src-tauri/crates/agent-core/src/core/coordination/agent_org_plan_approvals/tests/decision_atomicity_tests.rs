use super::*;

#[tokio::test]
async fn approval_rejects_atomically_when_source_task_was_cancelled() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let fence = crate::coordination::agent_org_task_execution_fence::acquire_handoff(
        &context.run_id,
        "plan-task",
    )
    .await;
    let conn = database::db::get_connection().expect("test sqlite");
    let tx = database::db::begin_immediate(&conn).expect("handoff transaction");
    AgentOrgTaskStore::cancel_with_handoff_in_tx(
        &tx,
        TaskGraphWriterAdmin::new("root-plan-approval", "coordinator-turn").unwrap(),
        &context.run_id,
        "plan-task",
        TaskTerminalReason {
            code: "scope.changed".to_string(),
            message: "replace the planning goal".to_string(),
            source_event_id: None,
        },
        &fence.authority(),
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("cancel source Task through typed handoff authority");
    tx.commit().expect("commit source Task cancellation");
    drop(fence);

    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect_err("approval cannot complete a cancelled Task");
    assert!(error.contains("plan_task_not_in_progress"), "{error}");
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
        TaskStatus::Cancelled
    );
}

#[test]
fn paused_run_rejects_plan_decisions_without_mutating_task() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        &uuid::Uuid::new_v4().to_string(),
    )
    .expect("pause run");

    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::User,
        "root-plan-approval",
        None,
    )
    .expect_err("paused run must reject approval");
    assert!(error.contains("not_mutable"));
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn startup_cleanup_preserves_pending_approval_for_paused_run() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        &uuid::Uuid::new_v4().to_string(),
    )
    .expect("pause run");

    let cancelled = AgentOrgPlanApprovalStore::cancel_pending_for_terminal_or_missing_runs()
        .expect("run startup approval cleanup");

    assert_eq!(cancelled, 0, "paused runs are resumable, not terminal");
    let reloaded = AgentOrgPlanApprovalStore::get(&pending.approval_id)
        .expect("load approval after startup cleanup")
        .expect("approval still exists");
    assert_eq!(reloaded.status, AgentOrgPlanApprovalStatus::Pending);
    assert_eq!(reloaded.resolved_at, None);
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn concurrent_decisions_have_exactly_one_transaction_winner() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));

    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..2 {
            let barrier = barrier.clone();
            let approval_id = pending.approval_id.clone();
            let revision_id = pending.plan_revision_id.clone();
            let task_id = pending.source_task_id.clone();
            let turn_id = pending.source_turn_intent_id.clone();
            handles.push(scope.spawn(move || {
                barrier.wait();
                AgentOrgPlanApprovalStore::approve(
                    &approval_id,
                    &revision_id,
                    &task_id,
                    &turn_id,
                    AgentOrgPlanDecisionBy::Coordinator,
                    "root-plan-approval",
                    Some("coordinator-turn"),
                )
            }));
        }
        barrier.wait();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
}
