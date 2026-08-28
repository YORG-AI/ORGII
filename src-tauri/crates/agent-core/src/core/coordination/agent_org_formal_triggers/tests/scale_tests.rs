use database::db::get_connection;

use super::fixture::FormalFixture;

#[test]
fn thousand_pending_facts_still_materialize_one_bounded_batch() {
    let fixture = FormalFixture::new();
    fixture.admit_coordinator_turn("turn-scale");
    fixture.insert_task_outputs(1_001);

    let batch =
        super::super::claim_for_coordinator_turn(&fixture.run_id, "formal-root", "turn-scale")
            .unwrap()
            .expect("bounded scale batch");
    assert_eq!(batch.receipt_ids.len(), 32);
    assert_eq!(batch.inbox_ids.len(), 32);
    assert!(batch.has_more);

    let conn = get_connection().expect("formal trigger scale database");
    let states: (i64, i64) = conn
        .query_row(
            "SELECT
                SUM(CASE WHEN status='materialized' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1",
            [&fixture.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(states, (32, 969));
}
