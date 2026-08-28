use database::db::get_connection;
use rusqlite::params;

use super::fixture::SummaryFixture;

#[test]
fn thousand_task_inbox_and_artifact_rows_do_not_expand_summary_context() {
    let fixture = SummaryFixture::new();
    fixture.create_receipt();
    fixture.claim("summary-turn-scale");

    let mut conn = get_connection().unwrap();
    let tx = conn.transaction().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    for index in 0..1_001 {
        let output = serde_json::json!({
            "summary": format!("UNBOUND_SCALE_SECRET_{index:04}"),
            "content": null,
            "artifactIds": [format!("artifact://unbound/{index:04}")],
            "producedByMemberId": "worker",
            "producedAt": &now,
        });
        tx.execute(
            "INSERT INTO agent_org_runtime_tasks(
                id,org_run_id,activation_generation,subject,description,owner,status,
                execution_mode,blocked_by_json,output_json,created_by_participant_id,
                source_turn_intent_id,created_at,updated_at
             ) VALUES (?1,?2,1,?3,'','worker','completed','build','[]',?4,
                       'coordinator',?5,?6,?6)",
            params![
                format!("scale-task-{index:04}"),
                &fixture.run_id,
                format!("Scale task {index:04}"),
                output.to_string(),
                format!("scale-turn-{index:04}"),
                &now,
            ],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO agent_org_runtime_inbox(
                recipient_agent_id,recipient_member_id,sender_agent_id,sender_member_id,
                org_run_id,payload_kind,payload_json,created_at,display_text
             ) VALUES ('coordinator-agent','coordinator','system','worker',?1,
                       'plain','{}',?2,?3)",
            params![
                &fixture.run_id,
                &now,
                format!("UNBOUND_INBOX_SECRET_{index:04}"),
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    let context = super::super::summary_context_for_turn("summary-root", "summary-turn-scale")
        .unwrap()
        .expect("bounded scale context");
    assert!(context.len() <= 128 * 1024 + 1_024);
    assert!(context.contains("artifact://verification-report"));
    assert!(!context.contains("UNBOUND_SCALE_SECRET_1000"));
    assert!(!context.contains("UNBOUND_INBOX_SECRET_1000"));
}
