use super::super::{WATCHDOG_INTERVAL_SECS, WATCHDOG_MAX_RECEIPTS, WATCHDOG_TEAM_BUDGET};
use super::fixture::{RecordingWake, UnacceptedWake, WatchdogFixture};

#[test]
fn watchdog_budget_is_fixed_and_bounded() {
    assert_eq!(WATCHDOG_INTERVAL_SECS, 60);
    assert_eq!(WATCHDOG_MAX_RECEIPTS, 100);
    assert_eq!(WATCHDOG_TEAM_BUDGET, std::time::Duration::from_millis(250));
}

#[test]
fn no_missing_doorbell_is_a_read_only_noop() {
    let _fixture = WatchdogFixture::new();
    let observer = database::db::get_connection().unwrap();
    let before: i64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    let wake = RecordingWake::default();

    let report = super::super::recover::repair_missing_doorbells_with_hook(&wake).unwrap();
    let after: i64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(report, Default::default());
    assert!(wake.calls().is_empty());
    assert_eq!(after, before, "no-op scan must not commit a write");
}

#[test]
fn five_ticks_repair_only_the_original_receipt_once() {
    let fixture = WatchdogFixture::new();
    let receipt_id = fixture.insert_missing_receipt("task-one");
    let wake = RecordingWake::default();

    let first = super::super::recover::repair_missing_doorbells_with_hook(&wake).unwrap();
    assert_eq!(first.repaired_receipts, 1);
    assert_eq!(first.receipt_ids, vec![receipt_id.clone()]);
    for _ in 0..4 {
        assert_eq!(
            super::super::recover::repair_missing_doorbells_with_hook(&wake).unwrap(),
            Default::default()
        );
    }

    assert_eq!(wake.calls().len(), 1);
    let conn = database::db::get_connection().unwrap();
    let state: (String, String, i64, i64) = conn
        .query_row(
            "SELECT receipt.status,receipt.doorbell_status,
                    (SELECT COUNT(*) FROM agent_org_runtime_inbox),
                    progress.work_revision
             FROM agent_org_runtime_formal_trigger_receipts receipt
             JOIN agent_org_runtime_run_progress progress
               ON progress.org_run_id=receipt.org_run_id
             WHERE receipt.receipt_id=?1",
            [&receipt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(state, ("pending".into(), "delivered".into(), 0, 0));
}

#[test]
fn unaccepted_wake_keeps_confirmation_missing_for_next_tick() {
    let fixture = WatchdogFixture::new();
    let receipt_id = fixture.insert_missing_receipt("unaccepted");
    let wake = UnacceptedWake::default();

    for _ in 0..2 {
        let report = super::super::recover::repair_missing_doorbells_with_hook(&wake).unwrap();
        assert_eq!(report.receipt_ids, vec![receipt_id.clone()]);
    }

    assert_eq!(wake.calls().len(), 2);
    let conn = database::db::get_connection().unwrap();
    let doorbell: String = conn
        .query_row(
            "SELECT doorbell_status
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE receipt_id=?1",
            [&receipt_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(doorbell, "missing");
}

#[test]
fn missing_doorbell_scan_uses_the_partial_index() {
    let fixture = WatchdogFixture::new();
    fixture.insert_missing_receipt("indexed");
    let conn = database::db::get_connection().unwrap();
    let details = {
        let mut stmt = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT receipt_id FROM agent_org_runtime_formal_trigger_receipts receipt
                 WHERE receipt.status='pending' AND receipt.doorbell_status='missing'
                   AND EXISTS (
                       SELECT 1 FROM agent_org_runtime_runs run
                       WHERE run.id=receipt.org_run_id AND run.status='running'
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_formal_trigger_attempts attempt
                       WHERE attempt.receipt_id=receipt.receipt_id
                         AND attempt.status IN ('queued','running')
                   )
                 ORDER BY receipt.created_at,receipt.receipt_id LIMIT 100",
            )
            .unwrap();
        stmt.query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("idx_agent_org_formal_trigger_missing_doorbell")),
        "query plan did not use the missing-doorbell index: {details:?}"
    );
}
