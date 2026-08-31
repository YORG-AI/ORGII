use super::timeline::{decode_cursor, encode_cursor, finalize_page_bounds};
use super::*;
use rusqlite::{params, Connection};

fn order(
    created_at: &str,
    source_rank: u16,
    stable_source_id: &str,
    item_ordinal: u8,
) -> AgentOrgGroupOrderKey {
    AgentOrgGroupOrderKey {
        created_at: created_at.to_string(),
        source_rank,
        stable_source_id: stable_source_id.to_string(),
        item_ordinal,
    }
}

#[test]
fn cursor_v2_round_trip_is_opaque_and_strict() {
    let order = order("2026-01-01T00:00:00Z", 30, "task-event-7", 0);
    let encoded = encode_cursor(&order).expect("encode cursor");
    let decoded = decode_cursor(&encoded).expect("decode cursor");
    assert_eq!(decoded.version, 2);
    assert_eq!(decoded.created_at, order.created_at);
    assert_eq!(decoded.source_rank, order.source_rank);
    assert_eq!(decoded.stable_source_id, order.stable_source_id);
    assert_eq!(decoded.item_ordinal, order.item_ordinal);
    assert_eq!(
        decode_cursor("not a cursor"),
        Err("invalid_group_projection_cursor".to_string())
    );
}

#[test]
fn serialized_page_cap_preserves_older_pagination() {
    let text = "x".repeat(MAX_VISIBLE_TEXT_CHARS);
    let mut keyed = (1..=100)
        .map(|index| {
            let order = order(
                "2026-01-01T00:00:00Z",
                30,
                &format!("task-event-{index:03}"),
                0,
            );
            KeyedItem {
                order: order.clone(),
                item: AgentOrgGroupProjectionItem::Activity(AgentOrgGroupActivityItem {
                    id: format!("activity:{index}"),
                    kind: "team_activity",
                    order,
                    activity_kind: AgentOrgGroupActivityKind::TaskCreated,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    member_id: None,
                    member_name: None,
                    previous_member_id: None,
                    previous_member_name: None,
                    task_id: Some(format!("task-{index}")),
                    task_subject: Some(text.clone()),
                    replaced_task_id: None,
                    replaced_task_subject: None,
                    outcome: None,
                    public_error_code: None,
                }),
            }
        })
        .collect::<Vec<_>>();
    let mut page = AgentOrgGroupProjectionPage {
        run_id: "run-large-page".to_string(),
        items: keyed.iter().map(|entry| entry.item.clone()).collect(),
        has_more: false,
        next_cursor: None,
    };
    let mut has_more = false;

    finalize_page_bounds(&mut page, &mut keyed, &mut has_more)
        .expect("enforce serialized payload cap");

    assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_PAGE_BYTES);
    assert!(page.items.len() < 100);
    assert!(page.has_more);
    let decoded = decode_cursor(page.next_cursor.as_deref().expect("older-page cursor"))
        .expect("decode emitted cursor");
    assert_eq!(
        decoded.stable_source_id,
        keyed.first().unwrap().order.stable_source_id
    );
}

fn projection_connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open projection database");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    conn.execute_batch(
        "CREATE TABLE events (
           id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           event_type TEXT NOT NULL,
           function_name TEXT,
           args_json TEXT NOT NULL DEFAULT '{}',
           result_json TEXT NOT NULL DEFAULT '{}',
           content TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           history_sequence INTEGER
         );
         CREATE INDEX idx_events_agent_org_initial_reply
         ON events(
           json_extract(result_json, '$.agent_org_initial_reply.message_id'),
           json_extract(result_json, '$.agent_org_initial_reply.turn_intent_id'),
           session_id,
           history_sequence
         )
         WHERE CASE WHEN json_valid(result_json)
                    THEN json_type(result_json, '$.agent_org_initial_reply.message_id')='text'
                     AND json_type(result_json, '$.agent_org_initial_reply.turn_intent_id')='text'
                    ELSE 0 END;
         CREATE INDEX idx_events_agent_org_group_mention_reply
         ON events(
           CAST(json_extract(result_json, '$.agent_org_user_directed_reply.source_inbox_id') AS INTEGER),
           session_id,
           history_sequence
         )
         WHERE CASE WHEN json_valid(result_json)
                    THEN json_extract(result_json, '$.agent_org_user_directed_reply.source_kind')='group_mention'
                    ELSE 0 END;
         CREATE INDEX idx_events_agent_org_group_root_reply
         ON events(
           json_extract(result_json, '$.agent_org_group_root_reply.source_event_id'),
           session_id,
           history_sequence
         )
         WHERE CASE WHEN json_valid(result_json)
                    THEN json_type(result_json, '$.agent_org_group_root_reply.source_event_id')='text'
                    ELSE 0 END;
         CREATE TABLE session_turn_intents (
           session_id TEXT NOT NULL,
           turn_intent_id TEXT NOT NULL,
           client_message_id TEXT,
           org_run_id TEXT,
           source TEXT NOT NULL,
           status TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY (session_id,turn_intent_id)
         );",
    )
    .expect("create projection EventStore fixture");
    crate::coordination::init_agent_org_schemas(&conn).expect("create Agent Org schemas");
    conn
}

fn projection_context() -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: "run-projection".into(),
        org_id: "org-projection".into(),
        org_name: "Projection Team".into(),
        org_role: "Test public projection".into(),
        coordinator_agent_id: "agent-coordinator".into(),
        coordinator_name: "Coordinator".into(),
        coordinator_role: "Lead".into(),
        members: vec![crate::coordination::agent_org_runs::AgentOrgContextMember {
            member_id: "reviewer".into(),
            name: "Reviewer".into(),
            role: "Review".into(),
            agent_id: "agent-reviewer".into(),
        }],
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        capability_index: Default::default(),
        root_session_id: Some("session-root".into()),
    }
}

fn seed_run(conn: &Connection) {
    let now = "2026-01-01T00:00:00Z";
    conn.execute(
        "INSERT INTO agent_org_runtime_runs (
           id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
           entry_mode,status,created_at,updated_at
         ) VALUES ('run-projection','org-projection','agent-coordinator',
                   'session-root',NULL,'standalone_session','running',?1,?1)",
        [now],
    )
    .expect("insert run");
    for (session_id, member_id) in [
        ("session-root", "coordinator"),
        ("session-reviewer", "reviewer"),
        ("session-direct", "reviewer"),
    ] {
        conn.execute(
            "INSERT INTO agent_sessions (
               session_id,name,status,created_at,updated_at,org_member_id,parent_session_id
             ) VALUES (?1,?1,'idle',?3,?3,?2,
                       CASE WHEN ?2='coordinator' THEN NULL ELSE 'session-root' END)",
            params![session_id, member_id, now],
        )
        .expect("insert session");
    }
}

fn seed_initial_exchange(conn: &Connection) {
    conn.execute(
        "INSERT INTO session_turn_intents (
           session_id,turn_intent_id,client_message_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('session-root','turn-initial','message-initial','run-projection',
                   'agent_org','completed','2026-01-01T00:00:00Z','2026-01-01T00:00:02Z')",
        [],
    )
    .expect("insert initial intent");
    conn.execute(
        "INSERT INTO agent_org_runtime_initial_inputs (
           org_run_id,turn_intent_id,message_id,content,payload_json,status,created_at,updated_at
         ) VALUES ('run-projection','turn-initial','message-initial','Build the Team result',
                   '{}','dispatched','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
        [],
    )
    .expect("insert initial input");
    conn.execute_batch(
        "INSERT INTO events (
           id,session_id,event_type,function_name,args_json,result_json,content,created_at,history_sequence
         ) VALUES
           ('reply-initial','session-root','raw','assistant','{}',
            '{\"content\":\"Initial accepted\",\"agent_org_initial_reply\":{\"message_id\":\"message-initial\",\"turn_intent_id\":\"turn-initial\"}}',
            'Initial accepted','2026-01-01T00:00:01Z',1),
           ('reply-ordinary','session-root','raw','assistant','{}',
            '{\"content\":\"private coordinator deliberation\"}',
            'private coordinator deliberation','2026-01-01T00:00:02Z',2),
           ('reply-direct','session-direct','raw','assistant','{}',
            '{\"content\":\"private direct answer\",\"agent_org_user_directed_reply\":{\"source_kind\":\"direct_member\",\"source_inbox_id\":99}}',
            'private direct answer','2026-01-01T00:00:03Z',1);",
    )
    .expect("insert initial and private replies");
}

fn seed_task_activity(conn: &Connection) {
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks (
           id,org_run_id,activation_generation,subject,description,owner,status,
           execution_mode,blocked_by_json,output_json,created_by_participant_id,
           source_turn_intent_id,created_at,updated_at
         ) VALUES ('task-1','run-projection',1,'Review result','', 'reviewer','completed',
                   'build','[]','{}','coordinator','turn-initial',
                   '2026-01-01T00:00:03Z','2026-01-01T00:00:05Z')",
        [],
    )
    .expect("insert task");
    conn.execute_batch(
        "INSERT INTO agent_org_runtime_task_events (
           id,org_run_id,task_id,event_type,previous_owner,next_owner,
           previous_status,next_status,actor_member_id,actor_kind,source_turn_intent_id,created_at
         ) VALUES
           ('task-event-created','run-projection','task-1','created',NULL,'reviewer',
            NULL,'pending','coordinator','graph_writer','turn-initial','2026-01-01T00:00:03Z'),
           ('task-event-started','run-projection','task-1','updated','reviewer','reviewer',
            'pending','in_progress','reviewer','owner_execution','turn-initial','2026-01-01T00:00:04Z'),
           ('task-event-completed','run-projection','task-1','updated','reviewer','reviewer',
            'in_progress','completed','reviewer','owner_execution','turn-initial','2026-01-01T00:00:05Z');",
    )
    .expect("insert task activity");
}

#[test]
fn initial_team_requirement_and_exact_reply_are_public() {
    let conn = projection_connection();
    seed_run(&conn);
    seed_initial_exchange(&conn);

    let before_changes = conn.total_changes();
    let page = super::timeline::load_projection_page_with_connection(
        &conn,
        &projection_context(),
        None,
        50,
    )
    .expect("project initial Team exchange");
    let texts = page
        .items
        .iter()
        .filter_map(|item| match item {
            AgentOrgGroupProjectionItem::Conversation(item) => Some(item.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert!(texts.contains(&"Build the Team result"));
    assert!(texts.contains(&"Initial accepted"));
    assert!(!texts.contains(&"private coordinator deliberation"));
    assert!(!texts.contains(&"private direct answer"));
    assert_eq!(
        conn.total_changes(),
        before_changes,
        "projection must be read-only"
    );
}

#[test]
fn task_lifecycle_is_merged_into_the_same_public_timeline() {
    let conn = projection_connection();
    seed_run(&conn);
    seed_initial_exchange(&conn);
    seed_task_activity(&conn);

    let page = super::timeline::load_projection_page_with_connection(
        &conn,
        &projection_context(),
        None,
        50,
    )
    .expect("project task lifecycle");
    let activity = page
        .items
        .iter()
        .filter_map(|item| match item {
            AgentOrgGroupProjectionItem::Activity(item) => Some(item.activity_kind),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(
        activity,
        vec![
            AgentOrgGroupActivityKind::TaskCreated,
            AgentOrgGroupActivityKind::TaskStarted,
            AgentOrgGroupActivityKind::TaskCompleted,
        ]
    );
}

fn seed_team_lifecycle(conn: &Connection) {
    let digest = "a".repeat(64);
    conn.execute(
        "INSERT INTO agent_org_runtime_pause_episodes (
           episode_id,org_run_id,pause_request_id,pause_generation,status,
           resume_request_id,resume_generation,teardown_owner_id,created_at,updated_at,resumed_at
         ) VALUES ('pause-1','run-projection','pause-request-1',2,'consumed',
                   'resume-request-1',3,'teardown-owner','2026-01-01T00:00:06Z',
                   '2026-01-01T00:00:07Z','2026-01-01T00:00:07Z')",
        [],
    )
    .expect("insert pause/resume episode");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_interventions (
           intervention_receipt_id,org_run_id,member_id,agent_id,session_id,status,
           source_event_id,entered_at,last_user_activity_at,return_request_id,
           return_outcome,cleared_revision,cleared_at,updated_at
         ) VALUES ('return-1','run-projection','reviewer','agent-reviewer',
                   'session-reviewer','cleared','direct-source','2026-01-01T00:00:07Z',
                   '2026-01-01T00:00:07Z','return-request-1','cleared_idle',4,
                   '2026-01-01T00:00:08Z','2026-01-01T00:00:08Z')",
        [],
    )
    .expect("insert member Return receipt");
    conn.execute(
        "INSERT INTO agent_org_runtime_run_completion_certificates (
           id,org_run_id,activation_generation,work_revision,request_id,request_digest,
           outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
           evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
           resolution_links_json,validator_version,created_at
         ) VALUES ('certificate-1','run-projection',1,1,'completion-request-1',?1,
                   'delivered','Team work complete','session-root','turn-final',
                   '[\"task-1\"]','[]','[]','[]',1,'2026-01-01T00:00:09Z')",
        [&digest],
    )
    .expect("insert completion certificate");
    conn.execute(
        "INSERT INTO events (
           id,session_id,event_type,function_name,args_json,result_json,content,created_at,history_sequence
         ) VALUES ('final-report-event','session-root','raw','assistant','{}',
                   '{\"content\":\"Final public report\"}','Final public report',
                   '2026-01-01T00:00:10Z',10)",
        [],
    )
    .expect("insert final report event");
    conn.execute(
        "INSERT INTO agent_org_runtime_final_summary_receipts (
           receipt_id,org_run_id,activation_generation,certificate_id,evidence_digest,
           attempt,status,coordinator_session_id,turn_intent_id,started_at,terminal_at,
           event_id,created_at,updated_at
         ) VALUES ('summary-1','run-projection',1,'certificate-1',?1,1,'persisted',
                   'session-root','turn-final','2026-01-01T00:00:09Z',
                   '2026-01-01T00:00:10Z','final-report-event',
                   '2026-01-01T00:00:09Z','2026-01-01T00:00:10Z')",
        [&digest],
    )
    .expect("insert persisted final report receipt");
    conn.execute(
        "INSERT INTO agent_org_runtime_final_summary_receipts (
           receipt_id,org_run_id,activation_generation,certificate_id,evidence_digest,
           attempt,status,coordinator_session_id,turn_intent_id,retry_request_id,
           started_at,terminal_at,typed_error,created_at,updated_at
         ) VALUES ('summary-failed','run-projection',1,'certificate-1',?1,2,'failed',
                   'session-root','turn-final-retry','retry-summary-2',
                   '2026-01-01T00:00:10Z','2026-01-01T00:00:11Z',
                   'private provider failure','2026-01-01T00:00:10Z','2026-01-01T00:00:11Z')",
        [&digest],
    )
    .expect("insert failed final report receipt");
    conn.execute(
        "INSERT INTO agent_org_runtime_archive_episodes (
           archive_receipt_id,org_run_id,archive_request_id,archive_generation,
           teardown_status,deadline_at,archived_at,updated_at,quiesced_at
         ) VALUES ('archive-1','run-projection','archive-request-1',4,'quiesced',
                   '2026-01-01T00:01:00Z','2026-01-01T00:00:12Z',
                   '2026-01-01T00:00:12Z','2026-01-01T00:00:12Z')",
        [],
    )
    .expect("insert archive receipt");
}

#[test]
fn team_lifecycle_and_final_report_are_public_without_raw_failures() {
    let conn = projection_connection();
    seed_run(&conn);
    seed_initial_exchange(&conn);
    seed_task_activity(&conn);
    seed_team_lifecycle(&conn);

    let page = super::timeline::load_projection_page_with_connection(
        &conn,
        &projection_context(),
        None,
        50,
    )
    .expect("project Team lifecycle");
    let activity = page
        .items
        .iter()
        .filter_map(|item| match item {
            AgentOrgGroupProjectionItem::Activity(item) => Some(item.activity_kind),
            _ => None,
        })
        .collect::<Vec<_>>();
    let texts = page
        .items
        .iter()
        .filter_map(|item| match item {
            AgentOrgGroupProjectionItem::Conversation(item) => Some(item.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let serialized = serde_json::to_string(&page).expect("serialize public page");

    assert!(activity.contains(&AgentOrgGroupActivityKind::TeamPaused));
    assert!(activity.contains(&AgentOrgGroupActivityKind::TeamResumed));
    assert!(activity.contains(&AgentOrgGroupActivityKind::MemberReturned));
    assert!(activity.contains(&AgentOrgGroupActivityKind::CompletionCertified));
    assert!(activity.contains(&AgentOrgGroupActivityKind::FinalReportFailed));
    assert!(activity.contains(&AgentOrgGroupActivityKind::TeamArchived));
    assert!(texts.contains(&"Final public report"));
    assert!(!serialized.contains("private provider failure"));
}

#[test]
fn cursor_v2_pages_identical_timestamps_without_duplicates() {
    let conn = projection_connection();
    seed_run(&conn);
    seed_task_activity(&conn);
    conn.execute(
        "UPDATE agent_org_runtime_task_events SET created_at='2026-01-01T00:00:03Z'",
        [],
    )
    .expect("align fixture timestamps");

    let newest = super::timeline::load_projection_page_with_connection(
        &conn,
        &projection_context(),
        None,
        2,
    )
    .expect("load newest page");
    assert!(newest.has_more);
    assert_eq!(newest.items.len(), 2);
    let cursor = decode_cursor(newest.next_cursor.as_deref().expect("older cursor"))
        .expect("decode older cursor");
    let older = super::timeline::load_projection_page_with_connection(
        &conn,
        &projection_context(),
        Some(cursor),
        2,
    )
    .expect("load older page");
    assert!(!older.has_more);
    assert_eq!(older.items.len(), 1);

    let ids = newest
        .items
        .iter()
        .chain(older.items.iter())
        .map(|item| match item {
            AgentOrgGroupProjectionItem::Conversation(item) => item.id.as_str(),
            AgentOrgGroupProjectionItem::Activity(item) => item.id.as_str(),
            AgentOrgGroupProjectionItem::Diagnostic(item) => item.id.as_str(),
        })
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        ids.len(),
        3,
        "stable cursor must neither skip nor duplicate"
    );
}

#[test]
#[ignore = "machine-local public Team timeline performance gate; run with --ignored --nocapture"]
fn public_timeline_p90_stays_bounded_for_fifty_members_and_ten_thousand_events() {
    const MEMBER_COUNT: usize = 50;
    const PUBLIC_CONTEXT_COUNT: usize = 1_000;
    const TOTAL_EVENT_COUNT: usize = 10_000;
    const PAGE_LIMIT: usize = 100;
    const SAMPLE_COUNT: usize = 30;

    let conn = projection_connection();
    seed_run(&conn);
    for member_index in 0..MEMBER_COUNT {
        conn.execute(
            "INSERT INTO agent_sessions (
               session_id,name,status,created_at,updated_at,org_member_id,parent_session_id
             ) VALUES (?1,?2,'idle','2026-01-01T00:00:00Z',
                       '2026-01-01T00:00:00Z',?2,'session-root')",
            params![
                format!("session-member-{member_index}"),
                format!("member-{member_index}"),
            ],
        )
        .expect("insert performance member session");
    }

    conn.execute_batch("BEGIN IMMEDIATE")
        .expect("begin performance fixture transaction");
    for context_index in 0..PUBLIC_CONTEXT_COUNT {
        let member_index = context_index % MEMBER_COUNT;
        let member_id = format!("member-{member_index}");
        let session_id = format!("session-member-{member_index}");
        let turn_id = format!("turn-{context_index}");
        let created_at = format!(
            "2026-01-01T00:{:02}:{:02}Z",
            context_index / 60,
            context_index % 60
        );
        conn.execute(
            "INSERT INTO agent_org_runtime_inbox (
               delivery_class,recipient_agent_id,recipient_member_id,sender_agent_id,
               org_run_id,payload_kind,payload_json,created_at
             ) VALUES ('user_directed',?1,?2,'_user','run-projection','plain',?3,?4)",
            params![
                format!("agent-{member_index}"),
                member_id,
                serde_json::json!({
                    "kind": "plain",
                    "summary": "performance fixture",
                    "text": format!("question-{context_index}"),
                })
                .to_string(),
                created_at,
            ],
        )
        .expect("insert performance Inbox source");
        let inbox_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO session_turn_intents (
               session_id,turn_intent_id,client_message_id,org_run_id,
               source,status,created_at,updated_at
             ) VALUES (?1,?2,?2,'run-projection','agent_org','completed',?3,?3)",
            params![session_id, turn_id, created_at],
        )
        .expect("insert performance Turn intent");
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts (
               session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
               dispatch_member_id,member_dispatch_sequence,source_kind,source_id,
               root_authority_turn_id,actor_version,created_at
             ) VALUES (?1,?2,'run-projection',?3,'user_directed_work',?3,?4,
                       'group_mention',?5,?2,1,?6)",
            params![
                session_id,
                turn_id,
                member_id,
                (context_index / MEMBER_COUNT + 1) as i64,
                inbox_id.to_string(),
                created_at,
            ],
        )
        .expect("insert performance GroupMention context");
        conn.execute(
            "INSERT INTO events (
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             ) VALUES (?1,?2,'raw','assistant','{}',?3,?4,?5,?6)",
            params![
                format!("reply-{context_index}"),
                session_id,
                serde_json::json!({
                    "content": format!("answer-{context_index}"),
                    "agent_org_user_directed_reply": {
                        "source_kind": "group_mention",
                        "source_inbox_id": inbox_id,
                    }
                })
                .to_string(),
                format!("answer-{context_index}"),
                created_at,
                (context_index + 1) as i64,
            ],
        )
        .expect("insert performance exact reply");
    }
    for noise_index in PUBLIC_CONTEXT_COUNT..TOTAL_EVENT_COUNT {
        conn.execute(
            "INSERT INTO events (
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             ) VALUES (?1,'session-root','raw','assistant','{}','{}','private noise',
                       '2026-01-01T00:00:00Z',?2)",
            params![format!("noise-{noise_index}"), noise_index as i64],
        )
        .expect("insert performance EventStore noise");
    }
    conn.execute_batch("COMMIT")
        .expect("commit performance fixture");

    let context = AgentOrgRunContext {
        members: (0..MEMBER_COUNT)
            .map(
                |member_index| crate::coordination::agent_org_runs::AgentOrgContextMember {
                    member_id: format!("member-{member_index}"),
                    name: format!("Member {member_index}"),
                    role: "Worker".to_string(),
                    agent_id: format!("agent-{member_index}"),
                },
            )
            .collect(),
        ..projection_context()
    };
    let sample = || {
        let started = std::time::Instant::now();
        let page = super::timeline::load_projection_page_with_connection(
            &conn, &context, None, PAGE_LIMIT,
        )
        .expect("load performance public timeline page");
        assert_eq!(page.items.len(), PAGE_LIMIT);
        assert!(page.has_more);
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_PAGE_BYTES);
        started.elapsed()
    };

    for _ in 0..3 {
        let _ = sample();
    }
    let before_changes = conn.total_changes();
    let mut samples = (0..SAMPLE_COUNT).map(|_| sample()).collect::<Vec<_>>();
    samples.sort_unstable();
    let p90_index = ((SAMPLE_COUNT as f64 * 0.9).ceil() as usize).saturating_sub(1);
    let p90 = samples[p90_index];
    eprintln!(
        "public Team timeline fixture: members={MEMBER_COUNT} events={TOTAL_EVENT_COUNT} samples={SAMPLE_COUNT} p90_ms={:.3}",
        p90.as_secs_f64() * 1_000.0
    );
    assert!(
        p90 <= std::time::Duration::from_millis(200),
        "public Team timeline P90 exceeded 200 ms: {p90:?}"
    );
    assert_eq!(
        conn.total_changes(),
        before_changes,
        "performance reads must not mutate SQLite"
    );
}
