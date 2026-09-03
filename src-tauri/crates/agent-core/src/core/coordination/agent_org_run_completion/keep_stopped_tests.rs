use rusqlite::{params, Connection};

use super::*;

#[test]
fn keep_stopped_closes_the_last_open_scope_as_cancelled() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    crate::coordination::agent_org_runs::create_schema(&conn).unwrap();
    create_schema(&conn).unwrap();
    crate::coordination::agent_inbox::create_schema(&conn).unwrap();
    crate::coordination::agent_org_formal_triggers::create_schema(&conn).unwrap();
    crate::coordination::agent_org_tasks::create_schema(&conn).unwrap();
    crate::coordination::agent_org_task_handoffs::create_schema(&conn).unwrap();
    crate::coordination::agent_org_final_summary::create_schema(&conn).unwrap();
    conn.execute_batch(
        r#"INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,
             activation_generation,created_at,updated_at
         ) VALUES ('run','org','coordinator-agent','root','standalone_session',
                   'running',3,'2026-08-28T00:00:00Z','2026-08-28T00:00:00Z');
         INSERT INTO agent_org_runtime_tasks(
             id,org_run_id,activation_generation,subject,owner,status,execution_mode,
             cancel_reason_json,created_by_participant_id,source_turn_intent_id,
             created_at,updated_at
         ) VALUES
             ('old','run',1,'Old Task','worker','cancelled','build',
              '{"code":"handoff","message":"replacement requested"}',
              'coordinator','turn-1','2026-08-28T00:00:00Z','2026-08-28T00:00:00Z'),
             ('replacement','run',3,'Replacement','worker','cancelled','build',
              '{"code":"user_keep_stopped","message":"kept stopped"}',
              'coordinator','turn-3','2026-08-28T00:00:01Z','2026-08-28T00:00:01Z');"#,
    )
    .unwrap();
    let episode = crate::coordination::agent_org_work_episodes::associate_task_in_tx(
        &conn, "run", "old", 3, "turn-3",
    )
    .unwrap();
    assert_eq!(
        crate::coordination::agent_org_work_episodes::associate_task_in_tx(
            &conn,
            "run",
            "replacement",
            3,
            "turn-3",
        )
        .unwrap(),
        episode
    );
    conn.execute(
        "INSERT INTO agent_org_runtime_task_execution_handoffs(
             id,org_run_id,activation_generation,request_id,request_digest,
             old_task_id,old_owner_member_id,replacement_task_id,state,
             resolution,requested_at,released_at,resolved_at,updated_at
         ) VALUES ('handoff','run',1,'request',?1,'old','worker','replacement',
                   'released','keep_stopped',?2,?2,?2,?2)",
        params!["a".repeat(64), "2026-08-28T00:00:02Z"],
    )
    .unwrap();

    let certificate = certify_user_keep_stopped_in_tx(&conn, "run", "root", "handoff").unwrap();
    assert_eq!(certificate.outcome, RunCompletionOutcome::Cancelled);
    assert_eq!(certificate.activation_generation, 3);
    let episode_state: (String, String, String) = conn
        .query_row(
            "SELECT status,outcome,certificate_id
             FROM agent_org_runtime_work_episodes WHERE id=?1",
            [&episode],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        episode_state,
        (
            "certified".to_string(),
            "cancelled".to_string(),
            certificate.id.clone()
        )
    );
    assert_eq!(
        conn.query_row(
            "SELECT last_activity_outcome FROM agent_org_runtime_runs WHERE id='run'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "cancelled"
    );
    assert_eq!(
        conn.query_row(
            "SELECT status FROM agent_org_runtime_final_summary_receipts
             WHERE certificate_id=?1",
            [&certificate.id],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "pending"
    );
}
