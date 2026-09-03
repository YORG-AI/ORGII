use database::db::get_connection;

use super::fixture::FormalFixture;
use crate::coordination::agent_inbox::{AgentInboxStore, AgentMessage, SYSTEM_SENDER_ID};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_tasks::{
    enqueue_task_assigned_to, enqueue_task_assigned_to_with_tasks_in_tx, AgentOrgTaskStore,
    CreateTaskParams, TaskStatus,
};

fn assigned_task(
    fixture: &FormalFixture,
    task_id: &str,
) -> crate::coordination::agent_org_tasks::Task {
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.to_string(),
        org_run_id: fixture.run_id.clone(),
        subject: format!("Assigned {task_id}"),
        description: "Exercise the assignment receipt boundary".into(),
        active_form: None,
        owner: Some("worker".into()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .expect("create assigned Task")
}

#[test]
fn coordinator_created_assignment_records_one_resolved_receipt_without_self_wake() {
    let fixture = FormalFixture::new();
    let task = assigned_task(&fixture, "coordinator-assignment");
    let mut conn = get_connection().expect("formal trigger database");
    let tx = conn.transaction().expect("assignment transaction");
    let owner_inbox_id = enqueue_task_assigned_to_with_tasks_in_tx(
        &tx,
        &task,
        std::slice::from_ref(&task),
        "worker-agent",
        "worker",
        "coordinator-agent",
        Some(COORDINATOR_MEMBER_ID),
        "Coordinator",
        Some("coordinator-assignment-turn"),
    )
    .expect("persist self-observed assignment");
    tx.commit().expect("commit assignment transaction");

    let state: (String, String, Option<String>, String, i64) = conn
        .query_row(
            "SELECT status,doorbell_status,source_turn_intent_id,owner_member_id,inbox_id
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE source_kind='task_assignment'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("resolved assignment receipt");
    assert_eq!(state.0, "resolved");
    assert_eq!(state.1, "suppressed");
    assert_eq!(state.2.as_deref(), Some("coordinator-assignment-turn"));
    assert_eq!(state.3, "worker");
    assert_eq!(state.4, owner_inbox_id);
    assert_eq!(
        AgentInboxStore::list_unread_for_member("worker", &fixture.run_id)
            .expect("worker assignment")
            .len(),
        1,
        "recording Coordinator observation must not consume worker execution input"
    );
}

#[test]
fn external_assignment_materializes_a_separate_coordinator_fact_without_consuming_owner_input() {
    let fixture = FormalFixture::new();
    let task = assigned_task(&fixture, "external-assignment");
    let owner_inbox_id = enqueue_task_assigned_to(
        &task,
        "worker-agent",
        "worker",
        SYSTEM_SENDER_ID,
        None,
        "Agent Org lifecycle",
    )
    .expect("persist external assignment and observation");

    let conn = get_connection().expect("formal trigger database");
    let observation: (i64, String, String, String) = conn
        .query_row(
            "SELECT receipt.inbox_id,inbox.payload_kind,receipt.status,receipt.owner_member_id
             FROM agent_org_runtime_formal_trigger_receipts receipt
             JOIN agent_org_runtime_inbox inbox ON inbox.id=receipt.inbox_id
             WHERE receipt.source_kind='task_assignment'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("pending assignment observation");
    assert_ne!(observation.0, owner_inbox_id);
    assert_eq!(observation.1, "task_assignment_committed");
    assert_eq!(observation.2, "pending");
    assert_eq!(observation.3, "worker");

    fixture.admit_coordinator_turn("assignment-observation-turn");
    let batch = AgentInboxStore::list_formal_coordinator_input_for_turn(
        COORDINATOR_MEMBER_ID,
        &fixture.run_id,
        "formal-root",
        "assignment-observation-turn",
    )
    .expect("claim assignment observation");
    assert_eq!(batch.rows.len(), 1);
    assert_eq!(batch.rows[0].id, observation.0);
    assert_eq!(batch.rows[0].payload_kind, "task_assignment_committed");
    match batch.rows[0]
        .decode_payload()
        .expect("decode Coordinator assignment observation")
    {
        AgentMessage::TaskAssignmentCommitted {
            task_id,
            owner_member_id,
            subject,
            assigned_by,
        } => {
            assert_eq!(task_id, task.id);
            assert_eq!(owner_member_id, "worker");
            assert_eq!(subject, task.subject);
            assert_eq!(assigned_by, "Agent Org lifecycle");
        }
        other => panic!("unexpected Coordinator assignment observation: {other:?}"),
    }
    assert_eq!(
        AgentInboxStore::list_unread_for_member("worker", &fixture.run_id)
            .expect("worker assignment")
            .iter()
            .map(|row| row.id)
            .collect::<Vec<_>>(),
        vec![owner_inbox_id],
        "Coordinator materialization must not claim the worker's TaskAssigned row"
    );
}
