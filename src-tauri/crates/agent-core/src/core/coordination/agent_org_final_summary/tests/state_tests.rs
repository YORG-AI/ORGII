use super::super::FinalSummaryStatus;
use super::fixture::SummaryFixture;

#[test]
fn only_active_summary_states_project_finalizing() {
    assert!(FinalSummaryStatus::Pending.is_finalizing());
    assert!(FinalSummaryStatus::Running.is_finalizing());
    assert!(FinalSummaryStatus::Persisting.is_finalizing());
    assert!(!FinalSummaryStatus::Persisted.is_finalizing());
    assert!(!FinalSummaryStatus::Failed.is_finalizing());
}

#[test]
fn summary_receipt_follows_event_store_first_state_machine() {
    let fixture = SummaryFixture::new();
    let pending = fixture.create_receipt();
    assert_eq!(pending.status, FinalSummaryStatus::Pending);

    let running = fixture.claim("summary-turn-one");
    assert_eq!(running.status, FinalSummaryStatus::Running);
    assert!(super::super::mark_persisting_for_turn("summary-root", "summary-turn-one").unwrap());
    let event_id = super::super::stable_event_id_for_turn("summary-root", "summary-turn-one")
        .unwrap()
        .expect("stable EventStore id");
    assert!(
        super::super::mark_persisted_for_turn("summary-root", "summary-turn-one", &event_id)
            .unwrap()
    );

    let conn = database::db::get_connection().unwrap();
    let persisted = super::super::active_for_run_with_connection(&conn, &fixture.run_id, 1)
        .unwrap()
        .expect("terminal receipt");
    assert_eq!(persisted.status, FinalSummaryStatus::Persisted);
    assert_eq!(persisted.event_id.as_deref(), Some(event_id.as_str()));
    assert!(!persisted.can_retry);
}

#[test]
fn stale_state_transitions_fail_closed_instead_of_reporting_success() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-stale");

    assert!(!super::super::mark_persisted_for_turn(
        "summary-root",
        "summary-turn-stale",
        "event-too-early"
    )
    .unwrap());
    assert!(super::super::mark_persisting_for_turn("summary-root", "summary-turn-stale").unwrap());
    assert!(!super::super::mark_persisting_for_turn("summary-root", "summary-turn-stale").unwrap());
}

#[test]
fn summary_claim_requires_its_exact_formal_trigger_in_the_same_transaction() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    let mut conn = database::db::get_connection().expect("summary database");
    let tx = conn.transaction().expect("summary claim transaction");
    tx.execute(
        "DELETE FROM agent_org_runtime_formal_trigger_receipts
         WHERE org_run_id=?1 AND trigger_kind='final_summary'",
        [&fixture.run_id],
    )
    .expect("simulate missing formal trigger");
    let error = super::super::claim_pending_for_coordinator_turn_in_tx(
        &tx,
        &fixture.run_id,
        "summary-root",
        "summary-turn-missing-trigger",
    )
    .expect_err("claim must fail closed");
    assert_eq!(error, "final_summary_formal_trigger_claim_conflict");
    drop(tx);

    let receipt = super::super::active_for_run_with_connection(&conn, &fixture.run_id, 1)
        .expect("load summary receipt")
        .expect("summary receipt remains");
    assert_eq!(receipt.status, FinalSummaryStatus::Pending);
}
