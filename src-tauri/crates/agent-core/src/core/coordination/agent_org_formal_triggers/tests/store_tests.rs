use database::db::get_connection;

use super::fixture::FormalFixture;
use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

#[test]
fn structured_fact_creates_one_exact_receipt_while_narration_creates_none() {
    let fixture = FormalFixture::new();
    let fact = fixture.insert_task_output("one");
    fixture.insert_plain_narration();

    let conn = get_connection().expect("formal trigger database");
    let receipts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_formal_trigger_receipts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let inbox_id: i64 = conn
        .query_row(
            "SELECT inbox_id FROM agent_org_runtime_formal_trigger_receipts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 1);
    assert_eq!(inbox_id, fact.id);
}

#[test]
fn replaying_the_same_inbox_identity_does_not_create_a_second_receipt() {
    let fixture = FormalFixture::new();
    let fact = fixture.insert_task_output("replay");
    let conn = get_connection().expect("formal trigger database");

    let replay = super::super::record_inbox_trigger_in_tx(
        &conn,
        &fixture.run_id,
        fact.id,
        super::super::InboxFormalTriggerSource {
            source_kind: "task_output",
            task_id: Some("task-replay"),
            owner_member_id: Some("worker"),
            source_turn_intent_id: None,
            task_output_digest: None,
            plan_revision_id: None,
            suppress_self_wake: false,
        },
    )
    .expect("idempotent receipt replay");
    assert_eq!(replay.inbox_id, Some(fact.id));
    assert_eq!(replay.current_attempt, 0);
}

#[test]
fn self_observed_coordinator_fact_is_resolved_without_a_follow_up_wake() {
    let fixture = FormalFixture::new();
    let record = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coordinator-agent".into(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        sender_agent_id: SYSTEM_SENDER_ID.into(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        org_run_id: Some(fixture.run_id),
        message: AgentMessage::TaskCompleted {
            task_id: "self-task".into(),
            subject: "Self-observed task".into(),
            completed_by_member_id: COORDINATOR_MEMBER_ID.into(),
            output_summary: Some("Already observed".into()),
            plan_revision_id: None,
            remaining_open_task_count: 0,
        },
    })
    .expect("self-observed fact");

    let conn = get_connection().expect("formal trigger database");
    let state: (String, String, bool) = conn
        .query_row(
            "SELECT receipt.status,receipt.doorbell_status,inbox.read_at IS NOT NULL
             FROM agent_org_runtime_formal_trigger_receipts receipt
             JOIN agent_org_runtime_inbox inbox ON inbox.id=receipt.inbox_id
             WHERE inbox.id=?1",
            [record.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(state, ("resolved".into(), "suppressed".into(), true));
}

#[test]
fn doorbell_acknowledgement_does_not_cover_rows_created_after_its_snapshot() {
    let fixture = FormalFixture::new();
    let first = fixture.insert_task_output("snapshot-first");
    let snapshot = super::super::missing_doorbell_ids_for_run(&fixture.run_id, 100)
        .expect("snapshot exact missing doorbells");
    assert_eq!(snapshot.len(), 1);

    let second = fixture.insert_task_output("snapshot-later");
    assert_eq!(
        super::super::mark_doorbells_delivered(&snapshot).expect("acknowledge snapshot"),
        1
    );

    let conn = get_connection().expect("formal trigger database");
    let states = [first.id, second.id]
        .into_iter()
        .map(|inbox_id| {
            conn.query_row(
                "SELECT doorbell_status
                 FROM agent_org_runtime_formal_trigger_receipts
                 WHERE inbox_id=?1",
                [inbox_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(states, vec!["delivered", "missing"]);

    let activity = super::super::activity_with_connection(&conn, &fixture.run_id, 100)
        .expect("pending delivery batch");
    assert_eq!(activity.pending_count, 2);
    assert_eq!(activity.pending_receipt_ids.len(), 2);
}
