use super::*;

fn upsert_resume_turn_intent(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    org_run_id: Option<&str>,
    source: crate::foundation::session_bridge::TurnIntentBridgeSource,
    status: crate::foundation::session_bridge::TurnIntentBridgeStatus,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO session_turn_intents (
             session_id,turn_intent_id,client_message_id,org_run_id,
             source,status,created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        params![
            session_id,
            turn_intent_id,
            client_message_id,
            org_run_id,
            source.as_str(),
            status.as_str(),
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[test]
fn resumed_coordinator_can_approve_revision_authored_before_pause() {
    crate::foundation::session_bridge::register_upsert_turn_intent_with_connection(
        upsert_resume_turn_intent,
    );
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: "root-plan-approval".into(),
            name: "Coordinator".into(),
            status: crate::session::SessionStatus::Idle.as_str().into(),
            created_at: now.clone(),
            updated_at: now.clone(),
            session_type: crate::session::persistence::session_type::ORG_MEMBER.into(),
            agent_definition_id: Some("coord-agent".into()),
            org_member_id: Some(COORDINATOR_MEMBER_ID.into()),
            ..Default::default()
        },
    )
    .expect("canonical Coordinator session");
    let conn = get_connection().expect("Pause fixture database");
    crate::coordination::agent_org_run_completion::create_schema(&conn)
        .expect("completion certificate schema");
    crate::coordination::agent_org_final_summary::create_schema(&conn)
        .expect("final summary schema");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_dispatch_allocators (
             org_run_id,member_id,next_sequence
         ) VALUES (?1,'planner',2)
         ON CONFLICT(org_run_id,member_id) DO UPDATE SET next_sequence=2",
        [&context.run_id],
    )
    .expect("Planner dispatch sequence after original Turn");
    for (member_id, agent_id, session_id) in [
        (COORDINATOR_MEMBER_ID, "coord-agent", "root-plan-approval"),
        ("planner", "planner-agent", "planner-session"),
    ] {
        conn.execute(
            "INSERT INTO agent_org_runtime_member_materializations (
                 org_run_id,member_id,agent_id,generation,session_id,
                 authority_class,status,created_at,updated_at
             ) VALUES (?1,?2,?3,1,?4,'formal','succeeded',?5,?5)",
            params![&context.run_id, member_id, agent_id, session_id, &now],
        )
        .expect("canonical pre-Pause materialization");
    }
    drop(conn);

    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000008f01",
    )
    .expect("pause pending Plan decision");
    for (session_id, turn_intent_id) in [
        ("root-plan-approval", "coordinator-turn"),
        ("planner-session", "planner-turn"),
    ] {
        crate::coordination::agent_org_pause::mark_runtime_absent(
            &paused.episode_id,
            session_id,
            turn_intent_id,
        )
        .expect("release pre-Pause formal Turn");
    }
    let resumed = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000008f02",
    )
    .expect("resume pending Plan decision");
    assert_eq!(resumed.resume_generation, 3);

    let stale_error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some("coordinator-turn"),
    )
    .expect_err("pre-Pause Coordinator Turn must remain fenced");
    assert!(stale_error.contains("generation_mismatch"), "{stale_error}");

    let conn = get_connection().expect("resumed Plan database");
    let continuation_turn_id: String = conn
        .query_row(
            "SELECT continuation_turn_intent_id
             FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 AND turn_kind='coordinator'
               AND continuation_status='queued'",
            [&resumed.episode_id],
            |row| row.get(0),
        )
        .expect("current Coordinator continuation");
    drop(conn);

    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        &pending.source_task_id,
        &pending.source_turn_intent_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "root-plan-approval",
        Some(&continuation_turn_id),
    )
    .expect("current Coordinator approves exact pre-Pause revision");

    assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
    assert_eq!(
        approved.task_outcome.current.activation_generation, 1,
        "Pause/Resume fences Turns without rewriting immutable Task provenance"
    );
    let output = approved
        .task_outcome
        .current
        .output
        .as_ref()
        .expect("Planning TaskOutput");
    assert_eq!(
        output.plan_revision_id.as_deref(),
        Some(pending.plan_revision_id.as_str())
    );

    let conn = get_connection().expect("approved Plan database");
    let (run_generation, actor_kind, actor_turn): (i64, String, Option<String>) = conn
        .query_row(
            "SELECT run.activation_generation,event.actor_kind,event.source_turn_intent_id
             FROM agent_org_runtime_runs run
             JOIN agent_org_runtime_task_events event ON event.org_run_id=run.id
             WHERE run.id=?1 AND event.task_id=?2
               AND event.next_status='completed'
             ORDER BY event.created_at DESC LIMIT 1",
            params![&context.run_id, &pending.source_task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("Plan completion audit");
    assert_eq!(run_generation, resumed.resume_generation);
    assert_eq!(actor_kind, "graph_writer");
    assert_eq!(actor_turn.as_deref(), Some(continuation_turn_id.as_str()));
}
