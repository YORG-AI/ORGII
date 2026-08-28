use super::{event_factory, EventHandlerConfig, UnifiedEventHandler};

#[test]
fn streamed_final_summary_uses_stable_identity_and_certificate_authority() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("final summary EventStore fixture database");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,
             activation_generation,has_initial_work,created_at,updated_at
         ) VALUES ('run','org','coordinator','coordinator-session',
                   'standalone_session','running',1,1,?1,?1)",
        [&now],
    )
    .expect("seed run");
    conn.execute(
        "INSERT INTO agent_org_runtime_run_completion_certificates(
             id,org_run_id,activation_generation,work_revision,request_id,request_digest,
             outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
             evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
             resolution_links_json,validator_version,created_at
         ) VALUES ('certificate','run',1,7,'call',?1,'delivered','done',
                   'coordinator-session','turn','[]','[]','[]','[]',1,?2)",
        rusqlite::params!["a".repeat(64), &now],
    )
    .expect("seed certificate");
    conn.execute(
        "INSERT INTO agent_org_runtime_final_summary_receipts(
             receipt_id,org_run_id,activation_generation,certificate_id,
             evidence_digest,attempt,status,coordinator_session_id,
             turn_intent_id,started_at,created_at,updated_at
         ) VALUES ('summary-receipt','run',1,'certificate',?1,1,'running',
                   'coordinator-session','turn',?2,?2,?2)",
        rusqlite::params!["b".repeat(64), &now],
    )
    .expect("seed certificate-bound summary turn");

    let handler = UnifiedEventHandler::new(EventHandlerConfig {
        agent_org_turn_intent_id: Some("turn".to_string()),
        ..Default::default()
    });
    let mut streamed_event =
        event_factory::build_assistant_message_event("coordinator-session", "Delivered");

    assert!(handler.attach_final_summary_event_identity("coordinator-session", &mut streamed_event));
    assert_eq!(streamed_event.id, "agent-org-summary-receipt");
    assert_eq!(
        streamed_event.chunk_id.as_deref(),
        Some("agent-org-summary-receipt")
    );
    assert!(
        handler.attach_agent_org_assistant_authority("coordinator-session", &mut streamed_event)
    );
    assert_eq!(
        streamed_event
            .result
            .get("agent_org_completion_certificate")
            .and_then(|value| value.get("id"))
            .and_then(serde_json::Value::as_str),
        Some("certificate")
    );
    assert_eq!(
        streamed_event
            .result
            .get("agent_org_completion_certificate")
            .and_then(|value| value.get("outcome"))
            .and_then(serde_json::Value::as_str),
        Some("delivered")
    );

    conn.execute(
        "UPDATE agent_org_runtime_final_summary_receipts
         SET status='failed',typed_error='stopped',terminal_at=?2,updated_at=?2
         WHERE receipt_id=?1",
        rusqlite::params!["summary-receipt", chrono::Utc::now().to_rfc3339()],
    )
    .expect("make summary receipt terminal");
    let mut late_event =
        event_factory::build_assistant_message_event("coordinator-session", "Late report");
    assert!(!handler.attach_final_summary_event_identity("coordinator-session", &mut late_event));
    assert!(handler
        .take_assistant_persistence_error()
        .is_some_and(|error| error.contains("identity is unavailable")));
}
