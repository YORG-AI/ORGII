use super::*;
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};
use crate::foundation::session_bridge::{TurnIntentBridgeSource, TurnIntentBridgeStatus};
use crate::session::persistence::{session_type, upsert_session, UnifiedSessionRecord};
use rusqlite::params;

const MEMBER_ID: &str = "member-direct";
const MEMBER_AGENT_ID: &str = "agent-direct";

#[derive(Clone)]
struct DirectFixture {
    run_id: String,
    member_session_id: String,
}

fn test_upsert_turn_intent_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    org_run_id: Option<&str>,
    source: TurnIntentBridgeSource,
    status: TurnIntentBridgeStatus,
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
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_direct_test_schemas() {
    let conn = get_connection().expect("test sqlite connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("session snapshot schema");
    crate::session::persistence::init(&conn).expect("unified Session schema");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_turn_intents (
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            client_message_id TEXT,
            org_run_id TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(session_id,turn_intent_id)
        );
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            function_name TEXT,
            thread_id TEXT,
            args_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT NOT NULL DEFAULT '{}',
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            meta_json TEXT,
            history_sequence INTEGER,
            UNIQUE(id,session_id)
        );",
    )
    .expect("Turn intent and EventStore schemas");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    crate::foundation::session_bridge::register_upsert_turn_intent_with_connection(
        test_upsert_turn_intent_with_connection,
    );
}

fn sample_org(prefix: &str) -> OrgDefinition {
    OrgDefinition {
        id: format!("org-{prefix}"),
        name: format!("Direct fixture {prefix}"),
        role: "lead".to_string(),
        agent_id: format!("agent-root-{prefix}"),
        description: None,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![FlatOrgMember {
            member_id: MEMBER_ID.to_string(),
            name: "Direct Member".to_string(),
            role: "engineer".to_string(),
            agent_id: MEMBER_AGENT_ID.to_string(),
            runtime_config: None,
        }],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    }
}

fn create_fixture(prefix: &str, status: AgentOrgRunStatus) -> DirectFixture {
    ensure_direct_test_schemas();
    let org = sample_org(prefix);
    let root_session_id = format!("root-{prefix}");
    let member_session_id = format!("member-session-{prefix}");
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some(root_session_id.clone()),
        org_snapshot: (&org).into(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create direct fixture Team");

    let now = chrono::Utc::now().to_rfc3339();
    for (session_id, session_kind, parent, agent_id, member_id) in [
        (
            root_session_id.as_str(),
            session_type::GENERIC,
            None,
            Some(org.agent_id.as_str()),
            Some(COORDINATOR_MEMBER_ID),
        ),
        (
            member_session_id.as_str(),
            session_type::ORG_MEMBER,
            Some(root_session_id.as_str()),
            Some(MEMBER_AGENT_ID),
            Some(MEMBER_ID),
        ),
    ] {
        upsert_session(&UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: session_id.to_string(),
            status: "idle".to_string(),
            session_type: session_kind.to_string(),
            parent_session_id: parent.map(str::to_string),
            agent_definition_id: agent_id.map(str::to_string),
            org_member_id: member_id.map(str::to_string),
            created_at: now.clone(),
            updated_at: now.clone(),
            ..Default::default()
        })
        .expect("upsert canonical Session");
    }

    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations (
            org_run_id,member_id,agent_id,generation,session_id,
            authority_class,status,created_at,updated_at
         ) VALUES (?1,?2,?3,1,?4,'formal','succeeded',?5,?5)",
        params![
            &run.id,
            MEMBER_ID,
            MEMBER_AGENT_ID,
            &member_session_id,
            &now
        ],
    )
    .expect("materialize canonical Member");
    if status != AgentOrgRunStatus::Running {
        match status {
            AgentOrgRunStatus::Archived => {
                conn.execute(
                    "UPDATE agent_org_runtime_runs
                     SET status='archived',archived_at=?2,archive_receipt_id=?3,updated_at=?2
                     WHERE id=?1",
                    params![&run.id, &now, format!("archive-{prefix}")],
                )
                .expect("archive fixture Team");
            }
            other => {
                conn.execute(
                    "UPDATE agent_org_runtime_runs SET status=?2,updated_at=?3 WHERE id=?1",
                    params![&run.id, other.as_str(), &now],
                )
                .expect("set fixture Team status");
            }
        }
    }
    DirectFixture {
        run_id: run.id,
        member_session_id,
    }
}

fn seed_direct_source(
    fixture: &DirectFixture,
    event_id: &str,
    turn_intent_id: &str,
    content: &str,
) {
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO events (
            id,session_id,event_type,function_name,args_json,result_json,
            content,created_at,meta_json
         ) VALUES (?1,?2,'raw','user_message','{}',?3,'',?4,?5)",
        params![
            event_id,
            &fixture.member_session_id,
            serde_json::json!({
                "syntheticUserInput": true,
                "agentOrgDirectSource": true,
                "turnIntentId": turn_intent_id,
                "message": { "content": content },
            })
            .to_string(),
            chrono::Utc::now().to_rfc3339(),
            serde_json::json!({ "source": "user" }).to_string(),
        ],
    )
    .expect("persist canonical direct source");
}

fn enqueue(
    fixture: &DirectFixture,
    event_id: &str,
    turn_intent_id: &str,
    content: &str,
    queue_cap: i64,
) -> Result<EnqueueUserDirectedWorkResult, String> {
    AgentMemberInterventionStore::enqueue_user_directed_work(EnqueueUserDirectedWorkParams {
        org_run_id: fixture.run_id.clone(),
        session_id: fixture.member_session_id.clone(),
        member_id: MEMBER_ID.to_string(),
        turn_intent_id: turn_intent_id.to_string(),
        client_message_id: Some(format!("message-{turn_intent_id}")),
        source_event_id: event_id.to_string(),
        dispatch_content: content.to_string(),
        source_display_content: content.to_string(),
        source_images: None,
        queue_cap,
    })
}

fn mark_direct_terminal(fixture: &DirectFixture, turn_intent_id: &str) {
    assert!(AgentMemberInterventionStore::mark_turn_terminal(
        &fixture.member_session_id,
        turn_intent_id,
        "completed",
        None,
    )
    .expect("mark direct terminal"));
}

fn create_recoverable_formal_intervention(
    prefix: &str,
) -> (DirectFixture, EnqueueUserDirectedWorkResult, String, String) {
    let fixture = create_fixture(prefix, AgentOrgRunStatus::Running);
    let task_id = format!("task-{prefix}");
    let formal_turn_id = format!("turn-formal-{prefix}");
    let direct_turn_id = format!("turn-direct-{prefix}");
    let direct_event_id = format!("event-direct-{prefix}");
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.clone(),
        org_run_id: fixture.run_id.clone(),
        subject: format!("recover {prefix}"),
        description: String::new(),
        active_form: None,
        owner: Some(MEMBER_ID.to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: [MEMBER_ID],
        })),
    })
    .expect("create recoverable formal Task");
    agent_org_turn_contexts::accept(&AgentOrgTurnAdmission::task_execution(
        &fixture.run_id,
        &fixture.member_session_id,
        &formal_turn_id,
        None,
        &task_id,
        MEMBER_ID,
        1,
    ))
    .expect("admit recoverable formal Turn");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![&fixture.member_session_id, &formal_turn_id],
    )
    .expect("start recoverable formal Turn");
    drop(conn);

    seed_direct_source(
        &fixture,
        &direct_event_id,
        &direct_turn_id,
        "interrupt formal work",
    );
    let accepted = enqueue(
        &fixture,
        &direct_event_id,
        &direct_turn_id,
        "interrupt formal work",
        32,
    )
    .expect("accept interrupting direct Turn");
    assert!(
        AgentMemberInterventionStore::bind_runtime_and_request_yield(
            &accepted.intervention.intervention_receipt_id,
            &formal_turn_id,
            &format!("lease-{prefix}"),
            &format!("generation-{prefix}"),
        )
        .expect("bind recoverable formal runtime")
    );
    assert!(AgentMemberInterventionStore::mark_yield_released(
        &accepted.intervention.intervention_receipt_id,
        &format!("lease-{prefix}"),
        &format!("generation-{prefix}"),
    )
    .expect("release recoverable formal runtime"));
    mark_direct_terminal(&fixture, &direct_turn_id);
    (fixture, accepted, task_id, formal_turn_id)
}

#[test]
fn statuses_have_no_expiry_state() {
    assert!(MemberInterventionStatus::YieldRequested.is_active());
    assert!(MemberInterventionStatus::Active.is_active());
    assert!(MemberInterventionStatus::ReturnRequested.is_active());
    assert!(!MemberInterventionStatus::Cleared.is_active());
    assert!(!MemberInterventionStatus::Failed.is_active());
}

#[test]
fn admission_atomically_persists_source_context_sequence_receipt_and_chain() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("atomic", AgentOrgRunStatus::Running);
    seed_direct_source(&fixture, "event-atomic", "turn-atomic", "inspect fixture");

    let accepted = enqueue(
        &fixture,
        "event-atomic",
        "turn-atomic",
        "inspect fixture",
        32,
    )
    .expect("accept canonical direct work");
    assert!(!accepted.duplicate);
    assert!(!accepted.should_request_yield);
    assert_eq!(accepted.context.source_id, "event-atomic");
    assert_eq!(accepted.context.member_dispatch_sequence, Some(1));
    assert_eq!(
        accepted.intervention.status,
        MemberInterventionStatus::Active
    );
    assert_eq!(accepted.intervention.queued_user_directed_count, 1);

    let conn = get_connection().expect("test sqlite connection");
    let persisted: (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM events WHERE id='event-atomic'),
                (SELECT COUNT(*) FROM session_turn_intents
                   WHERE session_id=?1 AND turn_intent_id='turn-atomic' AND status='queued'),
                (SELECT COUNT(*) FROM agent_org_runtime_turn_contexts
                   WHERE session_id=?1 AND turn_intent_id='turn-atomic'
                     AND source_kind='direct_member' AND source_id='event-atomic'),
                (SELECT COUNT(*) FROM agent_org_runtime_member_intervention_turns
                   WHERE session_id=?1 AND turn_intent_id='turn-atomic'
                     AND member_dispatch_sequence=1 AND chain_position=1)",
            [&fixture.member_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read accepted direct facts");
    assert_eq!(persisted, (1, 1, 1, 1));
}

#[test]
fn direct_images_are_source_verified_and_recovered_from_the_exact_event() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("images", AgentOrgRunStatus::Idle);
    seed_direct_source(&fixture, "event-images", "turn-images", "inspect image");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE events SET result_json=?2 WHERE id=?1",
        params![
            "event-images",
            serde_json::json!({
                "syntheticUserInput": true,
                "agentOrgDirectSource": true,
                "turnIntentId": "turn-images",
                "message": { "content": "inspect image" },
                "images": ["data:image/png;base64,exact"],
            })
            .to_string(),
        ],
    )
    .expect("attach canonical source image");
    drop(conn);

    let mismatch =
        AgentMemberInterventionStore::enqueue_user_directed_work(EnqueueUserDirectedWorkParams {
            org_run_id: fixture.run_id.clone(),
            session_id: fixture.member_session_id.clone(),
            member_id: MEMBER_ID.to_string(),
            turn_intent_id: "turn-images".to_string(),
            client_message_id: Some("message-turn-images".to_string()),
            source_event_id: "event-images".to_string(),
            dispatch_content: "inspect image".to_string(),
            source_display_content: "inspect image".to_string(),
            source_images: Some(vec!["data:image/png;base64,different".to_string()]),
            queue_cap: 32,
        })
        .expect_err("mismatched provider image input must fail");
    assert!(mismatch.contains("user_directed_source_invalid"));

    let accepted =
        AgentMemberInterventionStore::enqueue_user_directed_work(EnqueueUserDirectedWorkParams {
            org_run_id: fixture.run_id.clone(),
            session_id: fixture.member_session_id.clone(),
            member_id: MEMBER_ID.to_string(),
            turn_intent_id: "turn-images".to_string(),
            client_message_id: Some("message-turn-images".to_string()),
            source_event_id: "event-images".to_string(),
            dispatch_content: "inspect image".to_string(),
            source_display_content: "inspect image".to_string(),
            source_images: Some(vec!["data:image/png;base64,exact".to_string()]),
            queue_cap: 32,
        })
        .expect("accept exact source image");
    assert!(!accepted.duplicate);
    let recovered = AgentMemberInterventionStore::recoverable_queued_turns(100)
        .expect("read pending direct recovery");
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].images.as_deref(),
        Some(["data:image/png;base64,exact".to_string()].as_slice())
    );
}

#[test]
fn direct_startup_recovery_uses_a_stable_keyset_across_pages() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("recovery-keyset", AgentOrgRunStatus::Idle);
    for (event_id, turn_id, content) in [
        ("event-keyset-a", "turn-keyset-a", "first pending direct"),
        ("event-keyset-b", "turn-keyset-b", "second pending direct"),
    ] {
        seed_direct_source(&fixture, event_id, turn_id, content);
        enqueue(&fixture, event_id, turn_id, content, 32).expect("accept pending direct Turn");
    }

    let first = AgentMemberInterventionStore::recoverable_queued_turns_after(None, 1)
        .expect("read first direct recovery page");
    assert_eq!(first.len(), 1);
    let second = AgentMemberInterventionStore::recoverable_queued_turns_after(
        Some(first[0].recovery_key),
        1,
    )
    .expect("read second direct recovery page");
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].turn_intent_id, second[0].turn_intent_id);
    assert!(second[0].recovery_key > first[0].recovery_key);
    assert!(
        AgentMemberInterventionStore::recoverable_queued_turns_after(
            Some(second[0].recovery_key),
            1,
        )
        .expect("read exhausted direct recovery page")
        .is_empty()
    );
}

#[test]
fn exact_replay_returns_the_same_receipt_and_never_allocates_again() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("replay", AgentOrgRunStatus::Idle);
    seed_direct_source(&fixture, "event-replay", "turn-replay", "repeat safely");
    let first = enqueue(&fixture, "event-replay", "turn-replay", "repeat safely", 32)
        .expect("first acceptance");
    let replay = enqueue(&fixture, "event-replay", "turn-replay", "repeat safely", 32)
        .expect("idempotent replay");

    assert!(replay.duplicate);
    assert_eq!(first.turn_status, "queued");
    assert_eq!(replay.turn_status, "queued");
    assert_eq!(replay.context.context_id, first.context.context_id);
    assert_eq!(
        replay.intervention.intervention_receipt_id,
        first.intervention.intervention_receipt_id
    );
    assert_eq!(replay.context.member_dispatch_sequence, Some(1));
    let conn = get_connection().expect("test sqlite connection");
    let counts: (i64, i64, i64) = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM session_turn_intents WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_turn_contexts WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_member_intervention_turns WHERE session_id=?1)",
            [&fixture.member_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read replay counts");
    assert_eq!(counts, (1, 1, 1));
}

#[test]
fn failed_dispatch_replay_stays_terminal_and_is_not_startup_recoverable() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("dispatch-failed", AgentOrgRunStatus::Idle);
    seed_direct_source(
        &fixture,
        "event-dispatch-failed",
        "turn-dispatch-failed",
        "run once only",
    );
    let first = enqueue(
        &fixture,
        "event-dispatch-failed",
        "turn-dispatch-failed",
        "run once only",
        32,
    )
    .expect("accept direct Turn before scheduler failure");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='rejected'
         WHERE session_id=?1 AND turn_intent_id='turn-dispatch-failed'",
        [&fixture.member_session_id],
    )
    .expect("persist scheduler rejection");
    drop(conn);
    assert!(AgentMemberInterventionStore::mark_turn_terminal(
        &fixture.member_session_id,
        "turn-dispatch-failed",
        "failed",
        Some("scheduler_enqueue_failed"),
    )
    .expect("persist scheduler failure"));

    let replay = enqueue(
        &fixture,
        "event-dispatch-failed",
        "turn-dispatch-failed",
        "run once only",
        32,
    )
    .expect("read exact failed receipt");
    assert!(replay.duplicate);
    assert_eq!(replay.turn_status, "failed");
    assert_eq!(
        replay.intervention.intervention_receipt_id,
        first.intervention.intervention_receipt_id
    );
    assert!(AgentMemberInterventionStore::recoverable_queued_turns(100)
        .expect("read recoverable direct Turns")
        .is_empty());
}

#[test]
fn startup_enqueue_failure_remains_recoverable_without_replaying_started_work() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("recovery-enqueue-failed", AgentOrgRunStatus::Idle);
    seed_direct_source(
        &fixture,
        "event-recovery-enqueue-failed",
        "turn-recovery-enqueue-failed",
        "resume pending work",
    );
    enqueue(
        &fixture,
        "event-recovery-enqueue-failed",
        "turn-recovery-enqueue-failed",
        "resume pending work",
        32,
    )
    .expect("accept pending direct Turn");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='rejected'
         WHERE session_id=?1 AND turn_intent_id='turn-recovery-enqueue-failed'",
        [&fixture.member_session_id],
    )
    .expect("simulate startup scheduler capacity failure");
    drop(conn);

    assert!(
        AgentMemberInterventionStore::requeue_direct_after_recovery_enqueue_failure(
            &fixture.member_session_id,
            "turn-recovery-enqueue-failed",
        )
        .expect("restore pending recovery status")
    );
    let recoverable = AgentMemberInterventionStore::recoverable_queued_turns(100)
        .expect("read requeued direct recovery");
    assert_eq!(recoverable.len(), 1);
    assert_eq!(
        recoverable[0].turn_intent_id,
        "turn-recovery-enqueue-failed"
    );
}

#[test]
fn mismatched_source_or_replayed_identity_is_rejected_without_mutation() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("conflict", AgentOrgRunStatus::Paused);
    seed_direct_source(&fixture, "event-conflict", "turn-conflict", "exact content");
    let accepted = enqueue(
        &fixture,
        "event-conflict",
        "turn-conflict",
        "exact content",
        32,
    )
    .expect("accept first direct Turn");
    seed_direct_source(&fixture, "event-other", "turn-conflict", "exact content");

    let wrong_content = enqueue(
        &fixture,
        "event-conflict",
        "turn-conflict",
        "changed content",
        32,
    )
    .expect_err("content mismatch must fail");
    assert!(wrong_content.contains("user_directed_source_invalid"));
    let wrong_dispatch =
        AgentMemberInterventionStore::enqueue_user_directed_work(EnqueueUserDirectedWorkParams {
            org_run_id: fixture.run_id.clone(),
            session_id: fixture.member_session_id.clone(),
            member_id: MEMBER_ID.to_string(),
            turn_intent_id: "turn-conflict".to_string(),
            client_message_id: Some("message-turn-conflict".to_string()),
            source_event_id: "event-conflict".to_string(),
            dispatch_content: "different expanded agent prompt".to_string(),
            source_display_content: "exact content".to_string(),
            source_images: None,
            queue_cap: 32,
        })
        .expect_err("same visible source cannot replay with another Provider prompt");
    assert!(
        wrong_dispatch.contains("user_directed_idempotency_conflict"),
        "unexpected replay error: {wrong_dispatch}"
    );
    let wrong_source = enqueue(
        &fixture,
        "event-other",
        "turn-conflict",
        "exact content",
        32,
    )
    .expect_err("same Turn with another source must fail");
    assert!(wrong_source.contains("agent_org_turn_context_invalid"));

    let current = AgentMemberInterventionStore::get_by_receipt(
        &accepted.intervention.intervention_receipt_id,
    )
    .expect("read receipt")
    .expect("receipt remains");
    assert_eq!(current.source_event_id, "event-conflict");
    assert_eq!(current.queued_user_directed_count, 1);
}

#[test]
fn queue_cap_rejects_n_plus_one_and_keeps_the_user_event_only() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("cap", AgentOrgRunStatus::Running);
    seed_direct_source(&fixture, "event-cap-1", "turn-cap-1", "first");
    seed_direct_source(&fixture, "event-cap-2", "turn-cap-2", "second");
    enqueue(&fixture, "event-cap-1", "turn-cap-1", "first", 1).expect("first Turn fits cap");
    let error = enqueue(&fixture, "event-cap-2", "turn-cap-2", "second", 1)
        .expect_err("N+1 must fail closed");
    assert!(error.contains("user_directed_queue_full"));

    let conn = get_connection().expect("test sqlite connection");
    let counts: (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM events WHERE session_id=?1),
                (SELECT COUNT(*) FROM session_turn_intents WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_turn_contexts WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_member_intervention_turns WHERE session_id=?1)",
            [&fixture.member_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read cap facts");
    assert_eq!(counts, (2, 1, 1, 1));
}

#[test]
fn receipt_or_chain_failure_rolls_back_turn_context_and_sequence() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("rollback", AgentOrgRunStatus::Running);
    seed_direct_source(&fixture, "event-rollback", "turn-rollback", "roll back");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute_batch(
        "CREATE TRIGGER fail_direct_chain_fixture
         BEFORE INSERT ON agent_org_runtime_member_intervention_turns
         BEGIN SELECT RAISE(ABORT,'fixture chain failure'); END;",
    )
    .expect("install transaction fault");
    drop(conn);

    let error = enqueue(&fixture, "event-rollback", "turn-rollback", "roll back", 32)
        .expect_err("fault must abort acceptance");
    assert!(error.contains("fixture chain failure"));
    let conn = get_connection().expect("test sqlite connection");
    let counts: (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM session_turn_intents WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_turn_contexts WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_member_interventions WHERE session_id=?1),
                (SELECT COUNT(*) FROM agent_org_runtime_member_dispatch_allocators
                   WHERE org_run_id=?2 AND member_id=?3)",
            params![&fixture.member_session_id, &fixture.run_id, MEMBER_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read rolled-back facts");
    assert_eq!(counts, (0, 0, 0, 0));
}

#[test]
fn fifty_concurrent_direct_turns_share_one_receipt_and_one_fifo() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("concurrent", AgentOrgRunStatus::Idle);
    for index in 0..50 {
        seed_direct_source(
            &fixture,
            &format!("event-concurrent-{index}"),
            &format!("turn-concurrent-{index}"),
            &format!("direct {index}"),
        );
    }

    let handles = (0..50)
        .map(|index| {
            let fixture = fixture.clone();
            std::thread::spawn(move || {
                enqueue(
                    &fixture,
                    &format!("event-concurrent-{index}"),
                    &format!("turn-concurrent-{index}"),
                    &format!("direct {index}"),
                    64,
                )
            })
        })
        .collect::<Vec<_>>();
    let mut accepted = handles
        .into_iter()
        .map(|handle| handle.join().expect("direct enqueue thread"))
        .collect::<Result<Vec<_>, _>>()
        .expect("all concurrent direct Turns accepted");
    accepted.sort_by_key(|result| result.context.member_dispatch_sequence);

    let receipt_id = accepted[0].intervention.intervention_receipt_id.clone();
    assert!(accepted.iter().all(|result| {
        !result.duplicate && result.intervention.intervention_receipt_id == receipt_id
    }));
    assert_eq!(
        accepted
            .iter()
            .map(|result| result.context.member_dispatch_sequence)
            .collect::<Vec<_>>(),
        (1..=50).map(Some).collect::<Vec<_>>()
    );
    let receipt = AgentMemberInterventionStore::get_by_receipt(&receipt_id)
        .expect("read concurrent receipt")
        .expect("concurrent receipt exists");
    assert_eq!(receipt.queued_user_directed_count, 50);
}

#[test]
fn direct_admission_allows_working_idle_paused_and_rejects_other_states() {
    let _sandbox = test_helpers::test_env::sandbox();
    for (index, status) in [
        AgentOrgRunStatus::Running,
        AgentOrgRunStatus::Idle,
        AgentOrgRunStatus::Paused,
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = create_fixture(&format!("allowed-{index}"), status);
        let event_id = format!("event-allowed-{index}");
        let turn_id = format!("turn-allowed-{index}");
        seed_direct_source(&fixture, &event_id, &turn_id, "allowed");
        enqueue(&fixture, &event_id, &turn_id, "allowed", 32)
            .unwrap_or_else(|error| panic!("{status} must allow direct work: {error}"));
    }
    for (index, status) in [
        AgentOrgRunStatus::Starting,
        AgentOrgRunStatus::Failed,
        AgentOrgRunStatus::Archived,
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = create_fixture(&format!("denied-{index}"), status);
        let event_id = format!("event-denied-{index}");
        let turn_id = format!("turn-denied-{index}");
        seed_direct_source(&fixture, &event_id, &turn_id, "denied");
        let error = enqueue(&fixture, &event_id, &turn_id, "denied", 32).unwrap_err();
        assert!(
            error.contains("team_archived")
                || error.contains("UserDirectedWork cannot enter Team status"),
            "unexpected {status} rejection: {error}"
        );
    }
}

#[test]
fn one_receipt_chains_followups_without_repeating_the_formal_handoff() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("handoff", AgentOrgRunStatus::Running);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "task-handoff".to_string(),
        org_run_id: fixture.run_id.clone(),
        subject: "formal work".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some(MEMBER_ID.to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: [MEMBER_ID],
        })),
    })
    .expect("create open formal Task");
    let formal = AgentOrgTurnAdmission::task_execution(
        &fixture.run_id,
        &fixture.member_session_id,
        "turn-formal",
        Some("message-formal".to_string()),
        "task-handoff",
        MEMBER_ID,
        1,
    );
    agent_org_turn_contexts::accept(&formal).expect("admit formal TaskExecution");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id='turn-formal'",
        [&fixture.member_session_id],
    )
    .expect("start formal Turn");
    drop(conn);

    seed_direct_source(&fixture, "event-handoff-1", "turn-handoff-1", "interrupt");
    let first = enqueue(
        &fixture,
        "event-handoff-1",
        "turn-handoff-1",
        "interrupt",
        32,
    )
    .expect("enqueue first direct Turn");
    assert!(first.should_request_yield);
    assert_eq!(
        first.intervention.original_task_id.as_deref(),
        Some("task-handoff")
    );
    assert_eq!(
        first.intervention.original_turn_intent_id.as_deref(),
        Some("turn-formal")
    );

    seed_direct_source(&fixture, "event-handoff-2", "turn-handoff-2", "follow up");
    let second = enqueue(
        &fixture,
        "event-handoff-2",
        "turn-handoff-2",
        "follow up",
        32,
    )
    .expect("enqueue follow-up direct Turn");
    assert!(!second.should_request_yield);
    assert_eq!(
        second.intervention.intervention_receipt_id,
        first.intervention.intervention_receipt_id
    );
    assert_eq!(second.intervention.queued_user_directed_count, 2);
    assert_eq!(second.context.member_dispatch_sequence, Some(3));
}

#[test]
fn return_outcomes_are_explicit_and_same_request_is_idempotent() {
    let _sandbox = test_helpers::test_env::sandbox();
    for (index, status, expected) in [
        (
            0,
            AgentOrgRunStatus::Idle,
            AppliedReturnToWorkOutcome::ClearedIdle,
        ),
        (
            1,
            AgentOrgRunStatus::Paused,
            AppliedReturnToWorkOutcome::ClearedPaused,
        ),
        (
            2,
            AgentOrgRunStatus::Running,
            AppliedReturnToWorkOutcome::NoLongerNeeded,
        ),
    ] {
        let fixture = create_fixture(&format!("return-{index}"), status);
        let event_id = format!("event-return-{index}");
        let turn_id = format!("turn-return-{index}");
        seed_direct_source(&fixture, &event_id, &turn_id, "side quest");
        let accepted =
            enqueue(&fixture, &event_id, &turn_id, "side quest", 32).expect("accept direct Turn");
        mark_direct_terminal(&fixture, &turn_id);
        let request_id = format!("request-return-{index}");
        let returned = AgentMemberInterventionStore::return_to_work(
            &fixture.member_session_id,
            &accepted.intervention.intervention_receipt_id,
            &request_id,
        )
        .expect("Return to Work");
        assert_eq!(returned.outcome, expected.into());
        assert_eq!(returned.applied_outcome, expected);
        assert!(!returned.had_original_formal_work);
        assert_eq!(returned.cleared_revision, 1);
        assert!(!returned.cleared_at.is_empty());
        assert!(returned.continuation_turn_intent_id.is_none());
        let replay = AgentMemberInterventionStore::return_to_work(
            &fixture.member_session_id,
            &accepted.intervention.intervention_receipt_id,
            &request_id,
        )
        .expect("idempotent Return replay");
        assert_eq!(replay.outcome, ReturnToWorkOutcome::AlreadyApplied);
        assert_eq!(replay.applied_outcome, expected);
        assert!(!replay.had_original_formal_work);
        assert_eq!(replay.cleared_revision, returned.cleared_revision);
        assert_eq!(replay.cleared_at, returned.cleared_at);
        let wire = serde_json::to_value(&replay).expect("serialize replay result");
        assert_eq!(wire["outcome"], "already_applied");
        assert_eq!(wire["appliedOutcome"], expected.as_str());
        assert_eq!(wire["hadOriginalFormalWork"], false);
        assert_eq!(wire["clearedRevision"], returned.cleared_revision);
        assert_eq!(wire["clearedAt"], returned.cleared_at);
    }
}

#[test]
fn return_restores_one_exact_continuation_and_never_duplicates_it() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("restore", AgentOrgRunStatus::Running);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "task-restore".to_string(),
        org_run_id: fixture.run_id.clone(),
        subject: "restore me".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some(MEMBER_ID.to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: [MEMBER_ID],
        })),
    })
    .expect("create restorable Task");
    agent_org_turn_contexts::accept(&AgentOrgTurnAdmission::task_execution(
        &fixture.run_id,
        &fixture.member_session_id,
        "turn-original",
        None,
        "task-restore",
        MEMBER_ID,
        1,
    ))
    .expect("admit original formal Turn");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id='turn-original'",
        [&fixture.member_session_id],
    )
    .expect("start original formal Turn");
    drop(conn);

    seed_direct_source(&fixture, "event-restore", "turn-direct", "quick fix");
    let accepted = enqueue(&fixture, "event-restore", "turn-direct", "quick fix", 32)
        .expect("accept interrupting direct Turn");
    assert!(
        AgentMemberInterventionStore::bind_runtime_and_request_yield(
            &accepted.intervention.intervention_receipt_id,
            "turn-original",
            "lease-original",
            "generation-original",
        )
        .expect("bind exact formal runtime")
    );
    assert!(AgentMemberInterventionStore::mark_yield_released(
        &accepted.intervention.intervention_receipt_id,
        "lease-original",
        "generation-original",
    )
    .expect("release exact formal runtime"));
    mark_direct_terminal(&fixture, "turn-direct");
    let returned = AgentMemberInterventionStore::return_to_work(
        &fixture.member_session_id,
        &accepted.intervention.intervention_receipt_id,
        "return-once",
    )
    .expect("restore formal Task");
    assert_eq!(returned.outcome, ReturnToWorkOutcome::RestoredTask);
    assert_eq!(
        returned.applied_outcome,
        AppliedReturnToWorkOutcome::RestoredTask
    );
    assert!(returned.had_original_formal_work);
    assert_eq!(returned.cleared_revision, 1);
    let continuation_id = returned
        .continuation_turn_intent_id
        .expect("one continuation identity");
    let replay = AgentMemberInterventionStore::return_to_work(
        &fixture.member_session_id,
        &accepted.intervention.intervention_receipt_id,
        "return-once",
    )
    .expect("replay exact Return");
    assert_eq!(replay.outcome, ReturnToWorkOutcome::AlreadyApplied);
    assert_eq!(
        replay.applied_outcome,
        AppliedReturnToWorkOutcome::RestoredTask
    );
    assert!(replay.had_original_formal_work);
    assert_eq!(replay.cleared_revision, returned.cleared_revision);
    assert_eq!(replay.cleared_at, returned.cleared_at);
    assert_eq!(
        replay.continuation_turn_intent_id.as_deref(),
        Some(continuation_id.as_str())
    );

    let conn = get_connection().expect("test sqlite connection");
    let continuation_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_turn_contexts
             WHERE session_id=?1 AND task_id='task-restore'
               AND turn_intent_id<> 'turn-original'",
            [&fixture.member_session_id],
            |row| row.get(0),
        )
        .expect("count continuations");
    assert_eq!(continuation_count, 1);
    assert!(AgentMemberInterventionStore::continuation_is_dispatchable(
        &fixture.member_session_id,
        &continuation_id,
    )
    .expect("continuation dispatchability"));
    let startup_dispatches = AgentMemberInterventionStore::dispatchable_return_continuations(100)
        .expect("read Return startup continuations");
    assert_eq!(startup_dispatches.len(), 1);
    assert_eq!(
        startup_dispatches[0].continuation_turn_intent_id.as_deref(),
        Some(continuation_id.as_str())
    );
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='rejected'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![&fixture.member_session_id, &continuation_id],
    )
    .expect("simulate in-memory enqueue failure");
    drop(conn);
    assert!(
        AgentMemberInterventionStore::requeue_return_continuation_after_enqueue_failure(
            &fixture.member_session_id,
            &continuation_id,
        )
        .expect("requeue exact Return continuation")
    );
    assert!(AgentMemberInterventionStore::continuation_is_dispatchable(
        &fixture.member_session_id,
        &continuation_id,
    )
    .expect("requeued continuation dispatchability"));
}

#[test]
fn return_does_not_restore_completed_cancelled_or_reassigned_work() {
    let _sandbox = test_helpers::test_env::sandbox();
    for (prefix, mutation) in [
        ("return-completed", "completed"),
        ("return-cancelled", "cancelled"),
        ("return-reassigned", "reassigned"),
    ] {
        let (fixture, accepted, task_id, formal_turn_id) =
            create_recoverable_formal_intervention(prefix);
        let conn = get_connection().expect("test sqlite connection");
        match mutation {
            "completed" => conn.execute(
                "UPDATE agent_org_runtime_tasks
                 SET status='completed',output_json='{}',updated_at=?3
                 WHERE org_run_id=?1 AND id=?2",
                params![&fixture.run_id, &task_id, chrono::Utc::now().to_rfc3339()],
            ),
            "cancelled" => conn.execute(
                "UPDATE agent_org_runtime_tasks
                 SET status='cancelled',cancel_reason_json='{\"code\":\"test\"}',updated_at=?3
                 WHERE org_run_id=?1 AND id=?2",
                params![&fixture.run_id, &task_id, chrono::Utc::now().to_rfc3339()],
            ),
            "reassigned" => conn.execute(
                "UPDATE agent_org_runtime_tasks SET owner='different-member',updated_at=?3
                 WHERE org_run_id=?1 AND id=?2",
                params![&fixture.run_id, &task_id, chrono::Utc::now().to_rfc3339()],
            ),
            _ => unreachable!("table-driven mutation"),
        }
        .expect("mutate original formal Task before Return");
        drop(conn);

        let returned = AgentMemberInterventionStore::return_to_work(
            &fixture.member_session_id,
            &accepted.intervention.intervention_receipt_id,
            &format!("request-{prefix}"),
        )
        .expect("Return after original work changed");
        assert_eq!(returned.outcome, ReturnToWorkOutcome::NoLongerNeeded);
        assert_eq!(
            returned.applied_outcome,
            AppliedReturnToWorkOutcome::NoLongerNeeded
        );
        assert!(returned.had_original_formal_work);
        assert!(returned.continuation_turn_intent_id.is_none());

        let conn = get_connection().expect("test sqlite connection");
        let continuation_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_turn_contexts
                 WHERE session_id=?1 AND task_id=?2 AND turn_intent_id<>?3",
                params![&fixture.member_session_id, &task_id, &formal_turn_id],
                |row| row.get(0),
            )
            .expect("count continuations after terminal or reassigned Task");
        assert_eq!(continuation_count, 0);
    }
}

#[test]
fn return_refuses_queued_or_running_direct_work_without_clearing_receipt() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("return-active", AgentOrgRunStatus::Idle);
    seed_direct_source(
        &fixture,
        "event-return-active",
        "turn-return-active",
        "stay active",
    );
    let accepted = enqueue(
        &fixture,
        "event-return-active",
        "turn-return-active",
        "stay active",
        32,
    )
    .expect("accept active direct Turn");
    let error = AgentMemberInterventionStore::return_to_work(
        &fixture.member_session_id,
        &accepted.intervention.intervention_receipt_id,
        "return-too-soon",
    )
    .expect_err("Return must wait for Stop or terminal direct work");
    assert!(error.contains("user_directed_work_active"));
    let receipt = AgentMemberInterventionStore::get_by_receipt(
        &accepted.intervention.intervention_receipt_id,
    )
    .expect("read active receipt")
    .expect("receipt exists");
    assert_eq!(receipt.status, MemberInterventionStatus::Active);
    assert_eq!(receipt.queued_user_directed_count, 1);
}

#[test]
fn stop_persists_one_exact_terminal_turn_and_return_waits_for_formal_yield() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("stop-yield", AgentOrgRunStatus::Running);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "task-stop-yield".to_string(),
        org_run_id: fixture.run_id.clone(),
        subject: "yield before return".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some(MEMBER_ID.to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: [MEMBER_ID],
        })),
    })
    .expect("create formal Task");
    agent_org_turn_contexts::accept(&AgentOrgTurnAdmission::task_execution(
        &fixture.run_id,
        &fixture.member_session_id,
        "turn-stop-original",
        None,
        "task-stop-yield",
        MEMBER_ID,
        1,
    ))
    .expect("admit formal Turn");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id='turn-stop-original'",
        [&fixture.member_session_id],
    )
    .expect("start formal Turn");
    drop(conn);

    seed_direct_source(
        &fixture,
        "event-stop-direct",
        "turn-stop-direct",
        "stop this direct Turn",
    );
    let accepted = enqueue(
        &fixture,
        "event-stop-direct",
        "turn-stop-direct",
        "stop this direct Turn",
        32,
    )
    .expect("accept interrupting direct Turn");
    assert_eq!(
        accepted.intervention.status,
        MemberInterventionStatus::YieldRequested
    );
    assert!(AgentMemberInterventionStore::cancel_turn(
        &fixture.member_session_id,
        "turn-stop-direct",
    )
    .expect("cancel exact direct Turn"));

    let return_error = AgentMemberInterventionStore::return_to_work(
        &fixture.member_session_id,
        &accepted.intervention.intervention_receipt_id,
        "return-before-yield",
    )
    .expect_err("Return must not race the formal yield boundary");
    assert!(return_error.contains("user_directed_handoff_pending"));
    let conn = get_connection().expect("read exact Stop evidence");
    let status: String = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_member_intervention_turns
             WHERE session_id=?1 AND turn_intent_id='turn-stop-direct'",
            [&fixture.member_session_id],
            |row| row.get(0),
        )
        .expect("direct chain row");
    assert_eq!(status, "cancelled");
}

#[test]
fn restart_recovers_only_pending_direct_turns_and_never_replays_started_work() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("restart", AgentOrgRunStatus::Idle);
    seed_direct_source(
        &fixture,
        "event-restart-started",
        "turn-restart-started",
        "started side effect",
    );
    let accepted = enqueue(
        &fixture,
        "event-restart-started",
        "turn-restart-started",
        "started side effect",
        32,
    )
    .expect("accept started Turn");
    assert!(AgentMemberInterventionStore::mark_turn_running(
        &fixture.member_session_id,
        "turn-restart-started",
    )
    .expect("start direct Turn"));
    let conn = get_connection().expect("mark scheduler running state");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id='turn-restart-started'",
        [&fixture.member_session_id],
    )
    .expect("scheduler owns started Turn");
    drop(conn);

    seed_direct_source(
        &fixture,
        "event-restart-pending",
        "turn-restart-pending",
        "pending side effect",
    );
    let follow_up = enqueue(
        &fixture,
        "event-restart-pending",
        "turn-restart-pending",
        "pending side effect",
        32,
    )
    .expect("accept pending follow-up");
    assert_eq!(
        follow_up.intervention.intervention_receipt_id,
        accepted.intervention.intervention_receipt_id
    );

    let conn = get_connection().expect("restart reconciliation connection");
    agent_org_turn_contexts::reconcile_in_flight_after_restart(&conn)
        .expect("reconcile direct Turns");
    let statuses: (String, String, String, String) = conn
        .query_row(
            "SELECT
                (SELECT status FROM agent_org_runtime_member_intervention_turns
                 WHERE turn_intent_id='turn-restart-started'),
                (SELECT status FROM session_turn_intents
                 WHERE turn_intent_id='turn-restart-started'),
                (SELECT status FROM agent_org_runtime_member_intervention_turns
                 WHERE turn_intent_id='turn-restart-pending'),
                (SELECT status FROM session_turn_intents
                 WHERE turn_intent_id='turn-restart-pending')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read restart dispositions");
    assert_eq!(
        statuses,
        (
            "abandoned".into(),
            "failed".into(),
            "queued".into(),
            "queued".into()
        )
    );
    drop(conn);

    let recoverable = AgentMemberInterventionStore::recoverable_queued_turns(10)
        .expect("read exact recoverable queue");
    assert_eq!(recoverable.len(), 1);
    assert_eq!(recoverable[0].turn_intent_id, "turn-restart-pending");
    assert_eq!(recoverable[0].source_event_id, "event-restart-pending");
    let receipt = AgentMemberInterventionStore::get_by_receipt(
        &accepted.intervention.intervention_receipt_id,
    )
    .expect("read preserved receipt")
    .expect("receipt remains durable");
    assert_eq!(receipt.status, MemberInterventionStatus::Active);
    assert_eq!(receipt.queued_user_directed_count, 1);
}

#[test]
fn active_stop_waits_for_terminal_evidence_before_return_becomes_legal() {
    let _sandbox = test_helpers::test_env::sandbox();
    let fixture = create_fixture("active-stop", AgentOrgRunStatus::Idle);
    seed_direct_source(
        &fixture,
        "event-active-stop",
        "turn-active-stop",
        "active side effect",
    );
    let accepted = enqueue(
        &fixture,
        "event-active-stop",
        "turn-active-stop",
        "active side effect",
        32,
    )
    .expect("accept direct Turn");
    assert!(AgentMemberInterventionStore::mark_turn_running(
        &fixture.member_session_id,
        "turn-active-stop",
    )
    .expect("start direct Turn"));
    assert!(AgentMemberInterventionStore::cancel_turn(
        &fixture.member_session_id,
        "turn-active-stop",
    )
    .expect("signal exact active Stop"));
    let receipt = AgentMemberInterventionStore::get_by_receipt(
        &accepted.intervention.intervention_receipt_id,
    )
    .expect("read receipt")
    .expect("receipt remains active");
    assert_eq!(receipt.queued_user_directed_count, 1);
    let error = AgentMemberInterventionStore::return_to_work(
        &fixture.member_session_id,
        &accepted.intervention.intervention_receipt_id,
        "return-before-active-stop-finality",
    )
    .expect_err("Return must wait for active Stop finality");
    assert!(error.contains("user_directed_work_active"));

    assert!(AgentMemberInterventionStore::mark_turn_terminal(
        &fixture.member_session_id,
        "turn-active-stop",
        "cancelled",
        Some("user_stop"),
    )
    .expect("persist active Stop terminal"));
    let returned = AgentMemberInterventionStore::return_to_work(
        &fixture.member_session_id,
        &accepted.intervention.intervention_receipt_id,
        "return-after-active-stop-finality",
    )
    .expect("Return after finality");
    assert_eq!(returned.outcome, ReturnToWorkOutcome::ClearedIdle);
    assert_eq!(
        returned.applied_outcome,
        AppliedReturnToWorkOutcome::ClearedIdle
    );
    assert!(!returned.had_original_formal_work);
}
