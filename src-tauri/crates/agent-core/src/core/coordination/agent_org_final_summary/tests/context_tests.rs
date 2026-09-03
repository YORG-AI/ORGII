use database::db::get_connection;

use super::fixture::SummaryFixture;

#[test]
fn summary_context_contains_bounded_certified_evidence_not_session_transcript() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-context");
    let conn = get_connection().unwrap();
    conn.execute(
        "INSERT INTO events(id,session_id,event_type,content,created_at)
         VALUES ('unrelated-history','summary-root','raw','SECRET_TRANSCRIPT_TEXT',?1)",
        [chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();
    drop(conn);

    let context = super::super::summary_context_for_turn("summary-root", "summary-turn-context")
        .unwrap()
        .expect("summary evidence context");
    assert!(context.contains("Verification report"));
    assert!(context.contains("artifact://verification-report"));
    assert!(context.contains(&fixture.certificate.id));
    assert!(!context.contains("SECRET_TRANSCRIPT_TEXT"));
    assert!(context.len() <= 128 * 1024 + 1024);
}

#[test]
fn summary_context_excludes_terminal_tasks_not_bound_by_certificate() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-exact-evidence");
    let conn = get_connection().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks(
            id,org_run_id,activation_generation,subject,description,owner,status,
            execution_mode,blocked_by_json,output_json,created_by_participant_id,
            source_turn_intent_id,created_at,updated_at
         ) VALUES ('unbound-task',?1,1,'Unbound secret','', 'worker','completed',
                   'build','[]',?2,'coordinator','unbound-turn',?3,?3)",
        rusqlite::params![
            &fixture.run_id,
            serde_json::json!({
                "summary": "UNBOUND_TERMINAL_SECRET",
                "content": null,
                "artifactIds": [],
                "producedByMemberId": "worker",
                "producedAt": &now,
            })
            .to_string(),
            &now,
        ],
    )
    .unwrap();
    drop(conn);

    let context =
        super::super::summary_context_for_turn("summary-root", "summary-turn-exact-evidence")
            .unwrap()
            .expect("summary evidence context");
    assert!(!context.contains("UNBOUND_TERMINAL_SECRET"));
    assert!(context.contains("Verified implementation"));
}

#[test]
fn summary_context_rejects_task_output_digest_drift() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-digest-drift");
    let conn = get_connection().unwrap();
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET output_json=json_set(output_json,'$.summary','mutated after certificate')
         WHERE org_run_id=?1 AND id='report-task'",
        [&fixture.run_id],
    )
    .unwrap();
    drop(conn);

    let error = super::super::summary_context_for_turn("summary-root", "summary-turn-digest-drift")
        .unwrap_err();
    assert_eq!(error, "final_summary_output_digest_mismatch:report-task");
}

#[test]
fn summary_context_requires_explicit_disclosure_of_user_cancelled_scope() {
    let mut fixture = SummaryFixture::new();
    let conn = get_connection().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let cancel_reason = serde_json::json!({
        "code": "user_scope_removed",
        "message": "User cancelled this test from Run View",
        "sourceEventId": "cancel-request-1",
    });
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks(
            id,org_run_id,activation_generation,subject,description,owner,status,
            execution_mode,blocked_by_json,cancel_reason_json,
            created_by_participant_id,source_turn_intent_id,created_at,updated_at
         ) VALUES ('cancelled-test',?1,1,'Slow packaged smoke test','',
                   'worker','cancelled','build','[]',?2,'coordinator',
                   'coordinator-turn',?3,?3)",
        rusqlite::params![&fixture.run_id, cancel_reason.to_string(), &now],
    )
    .unwrap();
    fixture.certificate.resolution_links.push(
        crate::coordination::agent_org_run_completion::RunCompletionResolutionLink {
            task_id: "cancelled-test".into(),
            kind: crate::coordination::agent_org_run_completion::RunCompletionResolutionKind::UserScopeRemoved,
            resolved_by_task_id: None,
            source_event_id: Some("cancel-request-1".into()),
        },
    );
    conn.execute(
        "UPDATE agent_org_runtime_run_completion_certificates
         SET resolution_links_json=?1 WHERE id=?2",
        rusqlite::params![
            serde_json::to_string(&fixture.certificate.resolution_links).unwrap(),
            &fixture.certificate.id,
        ],
    )
    .unwrap();
    drop(conn);

    fixture.create_receipt();
    fixture.claim("summary-turn-cancelled-scope");
    let context =
        super::super::summary_context_for_turn("summary-root", "summary-turn-cancelled-scope")
            .unwrap()
            .expect("summary evidence context");

    assert!(context.contains("userCancelledScope"));
    assert!(context.contains("Slow packaged smoke test"));
    assert!(context.contains("never describe that item as completed, verified, passed"));
}
