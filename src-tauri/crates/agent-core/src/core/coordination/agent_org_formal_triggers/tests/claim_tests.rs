use database::db::get_connection;

use super::fixture::FormalFixture;

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
