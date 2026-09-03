use database::db::get_connection;

use super::fixture::FormalFixture;
use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, USER_SENDER_ID,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

#[test]
fn same_turn_replays_the_exact_batch_and_leaves_later_facts_pending() {
    let fixture = FormalFixture::new();
    fixture.admit_coordinator_turn("turn-one");
    let first = fixture.insert_task_output("first");

    let claimed =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-one")
            .unwrap()
            .expect("first claim");
    assert_eq!(claimed.inbox_ids, vec![first.id]);

    let later = fixture.insert_task_output("later");
    let replayed =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-one")
            .unwrap()
            .expect("same Turn replay");
    assert_eq!(replayed.inbox_ids, vec![first.id]);
    assert_eq!(
        replayed.materialized_input_id,
        claimed.materialized_input_id
    );
    assert!(replayed.has_more);

    let conn = get_connection().expect("formal trigger database");
    let later_status: String = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_formal_trigger_receipts WHERE inbox_id=?1",
            [later.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(later_status, "pending");

    drop(conn);
    fixture.admit_coordinator_turn("turn-follow-up");
    let follow_up =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-follow-up")
            .unwrap()
            .expect("follow-up Turn claims the late fact");
    assert_eq!(follow_up.inbox_ids, vec![later.id]);
    assert_ne!(
        follow_up.materialized_input_id,
        claimed.materialized_input_id
    );
}

#[test]
fn known_failure_terminates_attempt_and_allows_one_new_attempt() {
    let fixture = FormalFixture::new();
    fixture.admit_coordinator_turn("turn-failed");
    fixture.insert_task_output("failed");
    super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-failed")
        .unwrap()
        .expect("initial claim");

    assert_eq!(
        super::super::fail_attempt_for_turn("formal-root", "turn-failed", "provider_error")
            .unwrap(),
        1
    );
    fixture.admit_coordinator_turn("turn-retry");
    let retried =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-retry")
            .unwrap()
            .expect("retry claim");
    assert_eq!(retried.receipt_ids.len(), 1);

    let conn = get_connection().expect("formal trigger database");
    let attempts: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT attempt,status FROM agent_org_runtime_formal_trigger_attempts
                 ORDER BY attempt",
            )
            .unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(attempts, vec![(1, "failed".into()), (2, "running".into())]);
}

#[test]
fn claim_is_bounded_to_32_receipts_and_reports_follow_up_work() {
    let fixture = FormalFixture::new();
    fixture.admit_coordinator_turn("turn-bounded");
    for index in 0..33 {
        fixture.insert_task_output(&format!("bounded-{index:02}"));
    }

    let batch =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-bounded")
            .unwrap()
            .expect("bounded batch");
    assert_eq!(batch.receipt_ids.len(), 32);
    assert_eq!(batch.inbox_ids.len(), 32);
    assert!(batch.has_more);
}

#[test]
fn user_group_fact_replays_until_exact_provider_turn_acknowledges_it() {
    let fixture = FormalFixture::new();
    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coordinator-agent".into(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        sender_agent_id: USER_SENDER_ID.into(),
        sender_member_id: None,
        org_run_id: Some(fixture.run_id.clone()),
        message: AgentMessage::Plain {
            summary: "User group chat message".into(),
            text: "Please inspect this exact fact".into(),
        },
    })
    .expect("persist group Inbox fact");
    let conn = get_connection().expect("formal trigger database");
    super::super::record_inbox_trigger_in_tx(
        &conn,
        &fixture.run_id,
        row.id,
        super::super::InboxFormalTriggerSource {
            source_kind: "user_group_message",
            task_id: None,
            owner_member_id: None,
            source_turn_intent_id: None,
            task_output_digest: None,
            plan_revision_id: None,
            suppress_self_wake: false,
        },
    )
    .expect("record exact group observation receipt");

    fixture.admit_coordinator_turn("turn-group");
    let first =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-group")
            .unwrap()
            .expect("claim group fact");
    assert_eq!(first.inbox_ids, vec![row.id]);
    let replay =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-group")
            .unwrap()
            .expect("replay unacknowledged group fact");
    assert_eq!(replay, first);

    conn.execute(
        "INSERT INTO agent_org_runtime_inbox_materializations(
             inbox_id,session_id,transcript_message_id,transcript_intent_id,materialized_at
         ) VALUES (?1,'formal-root','group-transcript','turn-group',?2)",
        rusqlite::params![row.id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("persist exact provider materialization");
    drop(conn);
    assert_eq!(
        AgentInboxStore::mark_many_read_for_turn(
            &[row.id],
            "formal-root",
            "turn-group",
            Some("group-provider-event"),
        )
        .expect("acknowledge exact provider observation"),
        1
    );

    let conn = get_connection().expect("formal trigger database");
    let state: (String, bool, Option<String>) = conn
        .query_row(
            "SELECT receipt.status,inbox.read_at IS NOT NULL,receipt.materialized_event_id
             FROM agent_org_runtime_formal_trigger_receipts receipt
             JOIN agent_org_runtime_inbox inbox ON inbox.id=receipt.inbox_id
             WHERE inbox.id=?1",
            [row.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        state,
        (
            "resolved".to_string(),
            true,
            Some("group-provider-event".to_string())
        )
    );
    drop(conn);
    fixture.admit_coordinator_turn("turn-after-group");
    assert!(super::super::claim_for_coordinator_turn(
        &fixture.run_id,
        "formal-root",
        "turn-after-group"
    )
    .unwrap()
    .is_none());
}
