use database::db::get_connection;
use rusqlite::params;

use super::super::FinalSummaryStatus;
use super::fixture::SummaryFixture;

#[test]
fn restart_reconciles_existing_stable_event_without_calling_provider_again() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-event-first");
    super::super::mark_persisting_for_turn("summary-root", "summary-turn-event-first").unwrap();
    let event_id =
        super::super::stable_event_id_for_turn("summary-root", "summary-turn-event-first")
            .unwrap()
            .unwrap();
    let conn = get_connection().unwrap();
    conn.execute(
        "INSERT INTO events(id,session_id,event_type,created_at)
         VALUES (?1,'summary-root','raw',?2)",
        params![&event_id, chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();

    assert_eq!(super::super::reconcile_after_restart(&conn).unwrap(), 1);
    let receipt = super::super::active_for_run_with_connection(&conn, &fixture.run_id, 1)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.status, FinalSummaryStatus::Persisted);
    assert_eq!(receipt.event_id.as_deref(), Some(event_id.as_str()));
}

#[test]
fn unknown_started_output_fails_once_without_automatic_retry() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-unknown");
    let conn = get_connection().unwrap();

    assert_eq!(super::super::reconcile_after_restart(&conn).unwrap(), 1);
    assert_eq!(super::super::reconcile_after_restart(&conn).unwrap(), 0);
    let failed = super::super::active_for_run_with_connection(&conn, &fixture.run_id, 1)
        .unwrap()
        .unwrap();
    assert_eq!(failed.status, FinalSummaryStatus::Failed);
    assert_eq!(
        failed.typed_error.as_deref(),
        Some("started_but_output_unknown_after_restart")
    );
    assert!(failed.can_retry);
}
