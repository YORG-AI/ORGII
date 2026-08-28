use super::*;
use crate::coordination::agent_inbox::{AgentMessage, PlanDecisionOutcome};

#[test]
fn plan_request_receipt_binds_the_exact_revision_task_and_source_turn() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);

    let revision = AgentOrgPlanApprovalStore::create_pending_with_request(
        approval_params(&context),
        coordinator_request_delivery(),
    )
    .expect("submit Coordinator-reviewed Plan revision");

    let conn = get_connection().expect("Plan receipt database");
    let receipt: (
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT source_kind,task_id,owner_member_id,source_turn_intent_id,
                    plan_revision_id,task_output_digest
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1 AND source_kind='plan_request'",
            [&context.run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("exact Plan request receipt");
    assert_eq!(receipt.0, "plan_request");
    assert_eq!(receipt.1, revision.source_task_id);
    assert_eq!(receipt.2, revision.source_member_id);
    assert_eq!(
        receipt.3.as_deref(),
        Some(revision.source_turn_intent_id.as_str())
    );
    assert_eq!(receipt.4, revision.plan_revision_id);
    assert_eq!(receipt.5, None);
}

#[test]
fn approved_plan_receipt_binds_the_canonical_task_output_digest() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Automatic);
    create_plan_task(&context);

    let approved =
        AgentOrgPlanApprovalStore::create_and_approve_automatic(approval_params(&context))
            .expect("automatically approve Plan revision");
    let output = approved
        .task_outcome
        .current
        .output
        .as_ref()
        .expect("approved Planning TaskOutput");
    let expected_digest = crate::coordination::agent_org_tasks::task_output_digest(output)
        .expect("canonical TaskOutput digest");

    let conn = get_connection().expect("Plan receipt database");
    let (inbox_id, source_turn, digest, revision_id): (i64, Option<String>, String, String) = conn
        .query_row(
            "SELECT inbox_id,source_turn_intent_id,task_output_digest,plan_revision_id
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1 AND source_kind='plan_decision'",
            [&context.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("approved Plan decision receipt");
    assert_eq!(
        source_turn.as_deref(),
        Some(approved.revision.source_turn_intent_id.as_str())
    );
    assert_eq!(digest, expected_digest);
    assert_eq!(revision_id, approved.revision.plan_revision_id);

    let row = AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, &context.run_id)
        .expect("Coordinator Plan decision input")
        .into_iter()
        .find(|row| row.id == inbox_id)
        .expect("receipt-bound Plan decision row");
    match row.decode_payload().expect("decode Plan decision") {
        AgentMessage::PlanDecisionCommitted {
            outcome,
            task_output_digest,
            ..
        } => {
            assert_eq!(outcome, PlanDecisionOutcome::Approved);
            assert_eq!(
                task_output_digest.as_deref(),
                Some(expected_digest.as_str())
            );
        }
        other => panic!("unexpected Plan decision payload: {other:?}"),
    }
}

#[test]
fn user_request_changes_creates_a_pending_coordinator_decision_fact() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    AgentOrgPlanApprovalStore::request_changes(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::User,
        "Add a rollback checkpoint.",
        planner_changes_delivery(),
    )
    .expect("request Plan changes");

    let conn = get_connection().expect("Plan receipt database");
    let (status, source_turn, digest): (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT status,source_turn_intent_id,task_output_digest
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1 AND source_kind='plan_decision'",
            [&context.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("user Plan decision receipt");
    assert_eq!(status, "pending");
    assert_eq!(
        source_turn, None,
        "a UI command must not invent a Provider Turn"
    );
    assert_eq!(digest, None, "changes requested has no TaskOutput");
    assert!(
        AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, &context.run_id)
            .expect("Coordinator decision input")
            .iter()
            .any(|row| row.payload_kind == "plan_decision_committed")
    );
}

#[test]
fn coordinator_decision_turn_resolves_its_own_plan_and_assignment_facts() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "build-after-coordinator-plan".into(),
        org_run_id: context.run_id.clone(),
        subject: "Build the approved Plan".into(),
        description: String::new(),
        active_form: None,
        owner: Some("builder".into()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: vec!["plan-task".into()],
        metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "build" })),
    })
    .expect("dependent build Task");
    let pending = create_pending_approval(&context);

    let mut conn = get_connection().expect("Plan receipt database");
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("Coordinator decision transaction");
    let approved = AgentOrgPlanApprovalStore::approve_in_tx(
        &tx,
        crate::coordination::agent_org_plan_approvals::ApprovePlanRevisionInTxParams {
            approval_id: &pending.approval_id,
            plan_revision_id: &pending.plan_revision_id,
            source_task_id: &pending.source_task_id,
            source_turn_intent_id: &pending.source_turn_intent_id,
            decision_by: AgentOrgPlanDecisionBy::Coordinator,
            decision_source_session_id: "root-plan-approval",
            decision_source_turn_intent_id: Some("coordinator-turn"),
        },
    )
    .expect("approve from exact Coordinator Turn");
    tx.commit().expect("commit Coordinator decision");

    assert!(!approved
        .wake_member_ids
        .iter()
        .any(|member_id| member_id == COORDINATOR_MEMBER_ID));
    assert!(approved
        .wake_member_ids
        .iter()
        .any(|member_id| member_id == "builder"));
    let mut stmt = conn
        .prepare(
            "SELECT source_kind,status,doorbell_status,source_turn_intent_id
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1 AND source_kind IN ('plan_decision','task_assignment')
             ORDER BY source_kind",
        )
        .expect("self-observed receipt query");
    let receipts = stmt
        .query_map([&context.run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .expect("self-observed receipts")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect self-observed receipts");
    assert_eq!(receipts.len(), 2);
    assert!(receipts.iter().all(|receipt| {
        receipt.1 == "resolved"
            && receipt.2 == "suppressed"
            && receipt.3.as_deref() == Some("coordinator-turn")
    }));
}
