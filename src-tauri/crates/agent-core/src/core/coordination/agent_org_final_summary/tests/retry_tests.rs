use database::db::get_connection;
use rusqlite::params;

use super::super::FinalSummaryStatus;
use super::fixture::SummaryFixture;

fn fail_and_idle(fixture: &SummaryFixture, turn_intent_id: &str) {
    fixture.create_receipt();
    fixture.claim(turn_intent_id);
    super::super::mark_failed_for_turn("summary-root", turn_intent_id, "provider_error").unwrap();
    let conn = get_connection().unwrap();
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='idle',idled_at=?2,updated_at=?2
         WHERE id=?1 AND status='running' AND activation_generation=1",
        params![&fixture.run_id, chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();
}

#[test]
fn explicit_retry_atomically_reactivates_the_same_generation() {
    let fixture = SummaryFixture::new();
    fail_and_idle(&fixture, "summary-turn-retry");

    let retried = super::super::retry_failed(
        &fixture.run_id,
        &fixture.certificate.id,
        1,
        "retry-request-one",
    )
    .unwrap();
    assert_eq!(retried.attempt, 2);
    assert_eq!(retried.status, FinalSummaryStatus::Pending);

    let conn = get_connection().unwrap();
    let (status, generation): (String, i64) = conn
        .query_row(
            "SELECT status,activation_generation FROM agent_org_runtime_runs WHERE id=?1",
            [&fixture.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "running");
    assert_eq!(generation, fixture.certificate.activation_generation);
    let trigger_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1 AND trigger_kind='final_summary'
               AND trigger_id=?2 AND trigger_revision=2",
            params![&fixture.run_id, &retried.receipt_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(trigger_count, 1);
    drop(conn);

    let replay = super::super::retry_failed(
        &fixture.run_id,
        &fixture.certificate.id,
        1,
        "retry-request-one",
    )
    .unwrap();
    assert_eq!(replay.receipt_id, retried.receipt_id);

    let wrong_attempt = super::super::retry_failed(
        &fixture.run_id,
        &fixture.certificate.id,
        2,
        "retry-request-one",
    )
    .unwrap_err();
    assert_eq!(wrong_attempt, "final_summary_retry_request_replay_conflict");

    let wrong_run = super::super::retry_failed(
        "different-run",
        &fixture.certificate.id,
        1,
        "retry-request-one",
    )
    .unwrap_err();
    assert_eq!(wrong_run, "final_summary_retry_request_replay_conflict");
}

#[test]
fn retry_rejects_changed_certified_evidence_without_reactivating() {
    let fixture = SummaryFixture::new();
    fail_and_idle(&fixture, "summary-turn-conflict");
    let conn = get_connection().unwrap();
    let mut output: serde_json::Value = serde_json::from_str(
        &conn
            .query_row(
                "SELECT output_json FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND id='report-task'",
                [&fixture.run_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    output["content"] = "Evidence changed after certification".into();
    conn.execute(
        "UPDATE agent_org_runtime_tasks SET output_json=?2
         WHERE org_run_id=?1 AND id='report-task'",
        params![&fixture.run_id, output.to_string()],
    )
    .unwrap();
    drop(conn);

    let error = super::super::retry_failed(
        &fixture.run_id,
        &fixture.certificate.id,
        1,
        "retry-conflict",
    )
    .unwrap_err();
    assert_eq!(error, "final_summary_retry_evidence_conflict");
    assert_eq!(
        crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(&fixture.run_id)
            .unwrap(),
        Some(crate::coordination::agent_org_runs::AgentOrgRunStatus::Idle)
    );
}
