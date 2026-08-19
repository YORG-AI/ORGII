use std::sync::{Arc, Barrier};
use std::time::Duration;

use rusqlite::{params, Connection};

use super::*;
use crate::definitions::orgs::{AgentOrgLaunchSnapshot, FlatOrgMember, PlanApprovalPolicy};

const RUN_ID: &str = "run-a";
const ROOT_SESSION_ID: &str = "session-root";
const MEMBER_SESSION_ID: &str = "session-member";
const MEMBER_ID: &str = "member-a";

fn test_upsert_turn_intent(
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
            session_id, turn_intent_id, client_message_id, org_run_id,
            source, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
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

fn register_bridge() {
    crate::foundation::session_bridge::register_upsert_turn_intent_with_connection(
        test_upsert_turn_intent,
    );
}

fn snapshot_json() -> String {
    serde_json::to_string(&AgentOrgLaunchSnapshot {
        schema_version: 1,
        org_id: "org-a".into(),
        org_name: "Team A".into(),
        coordinator_role: "Lead".into(),
        coordinator_agent_id: "agent-coordinator".into(),
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![FlatOrgMember {
            member_id: MEMBER_ID.into(),
            name: "Member A".into(),
            role: "Builder".into(),
            agent_id: "agent-member".into(),
            runtime_config: None,
        }],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    })
    .expect("serialize launch snapshot")
}

fn create_fixture(conn: &Connection) {
    register_bridge();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE session_turn_intents (
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            client_message_id TEXT,
            org_run_id TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(session_id, turn_intent_id)
         );
         CREATE TABLE agent_sessions (
            session_id TEXT PRIMARY KEY,
            agent_definition_id TEXT,
            org_member_id TEXT
         );
         CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
         CREATE TABLE agent_org_runtime_runs (
            id TEXT PRIMARY KEY,
            root_session_id TEXT,
            org_snapshot_json TEXT,
            activation_generation INTEGER NOT NULL,
            status TEXT NOT NULL
         );
         CREATE TABLE agent_org_runtime_member_materializations (
            org_run_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            PRIMARY KEY(org_run_id, member_id, generation),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
         );
         CREATE TABLE agent_org_runtime_tasks (
            org_run_id TEXT NOT NULL,
            id TEXT NOT NULL,
            owner TEXT,
            PRIMARY KEY(org_run_id, id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
         );
         CREATE TABLE agent_org_runtime_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            org_run_id TEXT NOT NULL,
            recipient_member_id TEXT,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
         );
         CREATE TABLE agent_org_runtime_initial_inputs (
            org_run_id TEXT PRIMARY KEY,
            turn_intent_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            status TEXT NOT NULL,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
         );",
    )
    .expect("create canonical fixture schema");
    create_schema(conn).expect("create Turn context schema");
    conn.execute(
        "INSERT INTO agent_org_runtime_runs
            (id, root_session_id, org_snapshot_json, activation_generation, status)
         VALUES (?1, ?2, ?3, 1, 'running')",
        params![RUN_ID, ROOT_SESSION_ID, snapshot_json()],
    )
    .expect("seed run");
    conn.execute_batch(
        "INSERT INTO agent_sessions VALUES
            ('session-root', 'agent-coordinator', 'coordinator'),
            ('session-member', 'agent-member', 'member-a');
         INSERT INTO agent_org_runtime_member_materializations
            (org_run_id, member_id, agent_id, generation, session_id, status)
         VALUES
            ('run-a', 'coordinator', 'agent-coordinator', 1, 'session-root', 'succeeded'),
            ('run-a', 'member-a', 'agent-member', 1, 'session-member', 'succeeded');
         INSERT INTO agent_org_runtime_tasks VALUES ('run-a', 'task-a', 'member-a');
         INSERT INTO events VALUES ('event-direct', 'session-member');
         INSERT INTO agent_org_runtime_inbox (org_run_id, recipient_member_id)
            VALUES ('run-a', 'member-a'), ('run-a', 'member-a');",
    )
    .expect("seed canonical identities and sources");
}

fn connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    create_fixture(&conn);
    conn
}

fn accept_in_transaction(
    conn: &mut Connection,
    request: &AgentOrgTurnAdmission,
) -> Result<AgentOrgTurnContext, String> {
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let context = accept_with_connection(&transaction, request)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(context)
}

fn task_request(turn_id: &str) -> AgentOrgTurnAdmission {
    AgentOrgTurnAdmission::task_execution(
        RUN_ID,
        MEMBER_SESSION_ID,
        turn_id,
        Some(format!("message-{turn_id}")),
        "task-a",
        MEMBER_ID,
        1,
    )
}

fn direct_request(turn_id: &str) -> AgentOrgTurnAdmission {
    AgentOrgTurnAdmission::direct_member(
        RUN_ID,
        MEMBER_SESSION_ID,
        turn_id,
        Some(format!("message-{turn_id}")),
        MEMBER_ID,
        "event-direct",
    )
}

fn group_request(turn_id: &str) -> AgentOrgTurnAdmission {
    AgentOrgTurnAdmission::group_mention(
        RUN_ID,
        MEMBER_SESSION_ID,
        turn_id,
        Some(format!("message-{turn_id}")),
        MEMBER_ID,
        1,
    )
}

fn inbox_request(turn_id: &str) -> AgentOrgTurnAdmission {
    AgentOrgTurnAdmission::member_inbox(
        RUN_ID,
        MEMBER_SESSION_ID,
        turn_id,
        Some(format!("message-{turn_id}")),
        MEMBER_ID,
        2,
    )
}

fn status(conn: &Connection, turn_id: &str) -> String {
    conn.query_row(
        "SELECT status FROM session_turn_intents WHERE turn_intent_id=?1",
        [turn_id],
        |row| row.get(0),
    )
    .expect("read Turn status")
}

fn row_count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap_or_else(|error| panic!("count {table}: {error}"))
}

#[test]
fn coordinator_is_root_scoped_and_never_allocates_member_sequence() {
    let mut conn = connection();
    let request = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-root",
        Some("message-root".into()),
        TurnIntentBridgeSource::UserSubmit,
    );
    let first = accept_in_transaction(&mut conn, &request).expect("accept Root Turn");
    let replay = accept_in_transaction(&mut conn, &request).expect("replay Root Turn");

    assert_eq!(first, replay);
    assert_eq!(first.turn_kind, AgentOrgTurnKind::Coordinator);
    assert_eq!(first.participant_id, COORDINATOR_MEMBER_ID);
    assert_eq!(first.source_kind, AgentOrgTurnSourceKind::RootTurn);
    assert_eq!(first.activation_generation, Some(1));
    assert_eq!(first.member_dispatch_sequence, None);
    assert_eq!(
        row_count(&conn, "agent_org_runtime_member_dispatch_allocators"),
        0
    );

    for (turn_id, source) in [
        ("turn-root-queue", TurnIntentBridgeSource::Queue),
        ("turn-root-force", TurnIntentBridgeSource::ForceSend),
    ] {
        let context = accept_in_transaction(
            &mut conn,
            &AgentOrgTurnAdmission::coordinator(
                RUN_ID,
                ROOT_SESSION_ID,
                turn_id,
                Some(format!("message-{turn_id}")),
                source,
            ),
        )
        .expect("accept queued/steered Root Turn");
        assert_eq!(context.turn_kind, AgentOrgTurnKind::Coordinator);
        assert_eq!(context.member_dispatch_sequence, None);
    }

    let member_as_root = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-member-untyped",
        None,
        TurnIntentBridgeSource::AgentOrg,
    );
    let error = accept_in_transaction(&mut conn, &member_as_root)
        .expect_err("legacy Member path must fail closed");
    assert!(error.contains("is not canonical Root"), "{error}");
    assert_eq!(row_count(&conn, "session_turn_intents"), 3);
}

#[test]
fn every_member_kind_and_source_shares_one_fifo_and_replay_does_not_bump_it() {
    let mut conn = connection();
    let requests = [
        task_request("turn-task"),
        direct_request("turn-direct"),
        group_request("turn-group"),
        inbox_request("turn-inbox"),
    ];
    let contexts = requests
        .iter()
        .map(|request| accept_in_transaction(&mut conn, request).expect("accept Member Turn"))
        .collect::<Vec<_>>();

    assert_eq!(contexts[0].turn_kind, AgentOrgTurnKind::TaskExecution);
    assert_eq!(
        contexts[1].source_kind,
        AgentOrgTurnSourceKind::DirectMember
    );
    assert_eq!(
        contexts[2].source_kind,
        AgentOrgTurnSourceKind::GroupMention
    );
    assert_eq!(contexts[3].source_kind, AgentOrgTurnSourceKind::MemberInbox);
    assert_eq!(
        contexts
            .iter()
            .map(|context| context.member_dispatch_sequence.unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    assert_eq!(
        contexts[1].root_authority_turn_id.as_deref(),
        Some("turn-direct")
    );
    assert_eq!(
        contexts[2].root_authority_turn_id.as_deref(),
        Some("turn-group")
    );
    assert_eq!(contexts[3].root_authority_turn_id, None);

    let replay = accept_in_transaction(&mut conn, &requests[0]).expect("exact replay");
    assert_eq!(replay.member_dispatch_sequence, Some(1));
    let next_sequence: i64 = conn
        .query_row(
            "SELECT next_sequence FROM agent_org_runtime_member_dispatch_allocators
             WHERE org_run_id=?1 AND member_id=?2",
            params![RUN_ID, MEMBER_ID],
            |row| row.get(0),
        )
        .expect("read allocator");
    assert_eq!(next_sequence, 5);

    let conflict = AgentOrgTurnAdmission::member_inbox(
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-task",
        Some("message-turn-task".into()),
        MEMBER_ID,
        2,
    );
    assert!(accept_in_transaction(&mut conn, &conflict)
        .expect_err("kind-changing replay must fail")
        .contains("context replay mismatch"));
}

#[test]
fn user_directed_actor_version_is_independent_from_formal_activation_generation() {
    let mut conn = connection();
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=2 WHERE id=?1",
        [RUN_ID],
    )
    .unwrap();

    let context = accept_in_transaction(&mut conn, &direct_request("turn-cross-activation"))
        .expect("UDW keeps the stable materialized actor across a formal generation bump");
    assert_eq!(context.actor_version, Some(1));
    assert_eq!(context.activation_generation, None);

    let formal = task_request("turn-stale-formal");
    assert!(accept_in_transaction(&mut conn, &formal)
        .expect_err("formal work must carry the current activation generation")
        .contains("TaskExecution authority mismatch"));
}

#[test]
fn canonical_check_and_exhaustive_decode_fail_closed() {
    let conn = connection();
    test_upsert_turn_intent(
        &conn,
        ROOT_SESSION_ID,
        "turn-invalid-shape",
        None,
        Some(RUN_ID),
        TurnIntentBridgeSource::AgentOrg,
        TurnIntentBridgeStatus::Queued,
    )
    .unwrap();
    let invalid = conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
            session_id, turn_intent_id, org_run_id, participant_id, turn_kind,
            dispatch_member_id, member_dispatch_sequence, source_kind, source_id,
            activation_generation, created_at
         ) VALUES (?1, 'turn-invalid-shape', ?2, 'coordinator', 'coordinator',
                   'member-a', 1, 'root_turn', 'turn-invalid-shape', 1, 'now')",
        params![ROOT_SESSION_ID, RUN_ID],
    );
    assert!(invalid.is_err(), "row-shape CHECK must reject mixed kinds");

    test_upsert_turn_intent(
        &conn,
        ROOT_SESSION_ID,
        "turn-unknown-kind",
        None,
        Some(RUN_ID),
        TurnIntentBridgeSource::AgentOrg,
        TurnIntentBridgeStatus::Queued,
    )
    .unwrap();
    conn.execute_batch("PRAGMA ignore_check_constraints=ON;")
        .expect("simulate corrupted stored discriminant");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
            session_id, turn_intent_id, org_run_id, participant_id, turn_kind,
            source_kind, source_id, activation_generation, created_at
         ) VALUES (?1, 'turn-unknown-kind', ?2, 'coordinator', 'future_kind',
                   'root_turn', 'turn-unknown-kind', 1, 'now')",
        params![ROOT_SESSION_ID, RUN_ID],
    )
    .expect("seed corrupt future discriminant");
    conn.execute_batch("PRAGMA ignore_check_constraints=OFF;")
        .unwrap();
    let error = require_context_with_connection(&conn, ROOT_SESSION_ID, "turn-unknown-kind")
        .expect_err("unknown discriminant must not default");
    assert!(error.contains("unknown Agent Org Turn kind"), "{error}");
}

#[test]
fn transaction_failure_rolls_back_allocator_base_and_context() {
    for failure_target in ["base", "context"] {
        let mut conn = connection();
        let trigger = if failure_target == "base" {
            "CREATE TRIGGER fail_admission BEFORE INSERT ON session_turn_intents
             BEGIN SELECT RAISE(ABORT, 'base fault'); END;"
        } else {
            "CREATE TRIGGER fail_admission BEFORE INSERT ON agent_org_runtime_turn_contexts
             BEGIN SELECT RAISE(ABORT, 'context fault'); END;"
        };
        conn.execute_batch(trigger).expect("install fault trigger");
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let error = accept_with_connection(&transaction, &task_request("turn-fault"))
            .expect_err("fault must abort admission");
        assert!(error.contains("fault"), "{error}");
        transaction.rollback().expect("rollback failed admission");
        assert_eq!(row_count(&conn, "session_turn_intents"), 0);
        assert_eq!(row_count(&conn, "agent_org_runtime_turn_contexts"), 0);
        assert_eq!(
            row_count(&conn, "agent_org_runtime_member_dispatch_allocators"),
            0
        );
    }
}

#[test]
fn fifty_concurrent_mixed_sources_receive_one_strict_sequence() {
    const COUNT: usize = 50;
    let directory = tempfile::tempdir().expect("temporary database directory");
    let path = directory.path().join("sessions.db");
    let conn = Connection::open(&path).expect("create shared database");
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    create_fixture(&conn);
    drop(conn);

    let barrier = Arc::new(Barrier::new(COUNT));
    let handles = (0..COUNT)
        .map(|index| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut conn = Connection::open(path).expect("open shared database");
                conn.busy_timeout(Duration::from_secs(20)).unwrap();
                conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
                let turn_id = format!("turn-concurrent-{index}");
                let request = match index % 4 {
                    0 => task_request(&turn_id),
                    1 => direct_request(&turn_id),
                    2 => group_request(&turn_id),
                    _ => inbox_request(&turn_id),
                };
                barrier.wait();
                accept_in_transaction(&mut conn, &request)
                    .expect("concurrent admission")
                    .member_dispatch_sequence
                    .expect("Member sequence")
            })
        })
        .collect::<Vec<_>>();
    let mut sequences = handles
        .into_iter()
        .map(|handle| handle.join().expect("admission thread"))
        .collect::<Vec<_>>();
    sequences.sort_unstable();
    assert_eq!(sequences, (1..=COUNT as i64).collect::<Vec<_>>());
}

#[test]
fn recovery_preserves_only_typed_canonical_initial_and_keeps_running_unknown() {
    let mut conn = connection();
    let initial = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-initial",
        Some("message-initial".into()),
        TurnIntentBridgeSource::AgentOrg,
    );
    accept_in_transaction(&mut conn, &initial).unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_initial_inputs
            (org_run_id, turn_intent_id, message_id, status)
         VALUES (?1, 'turn-initial', 'message-initial', 'queued')",
        [RUN_ID],
    )
    .unwrap();
    let later = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-later-root",
        Some("message-later".into()),
        TurnIntentBridgeSource::AgentOrg,
    );
    accept_in_transaction(&mut conn, &later).unwrap();
    for (turn_id, state) in [
        ("turn-contextless-queued", "queued"),
        ("turn-contextless-running", "running"),
        ("turn-contextless-terminal", "completed"),
    ] {
        conn.execute(
            "INSERT INTO session_turn_intents
                (session_id, turn_intent_id, org_run_id, source, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'agent_org', ?4, 'now', 'now')",
            params![ROOT_SESSION_ID, turn_id, RUN_ID, state],
        )
        .unwrap();
    }

    assert_eq!(reconcile_in_flight_after_restart(&conn).unwrap(), 2);
    assert_eq!(status(&conn, "turn-initial"), "queued");
    assert_eq!(status(&conn, "turn-later-root"), "stale");
    assert_eq!(status(&conn, "turn-contextless-queued"), "stale");
    assert_eq!(status(&conn, "turn-contextless-running"), "running");
    assert_eq!(status(&conn, "turn-contextless-terminal"), "completed");

    conn.execute(
        "UPDATE agent_org_runtime_initial_inputs SET message_id='wrong-message' WHERE org_run_id=?1",
        [RUN_ID],
    )
    .unwrap();
    assert_eq!(reconcile_in_flight_after_restart(&conn).unwrap(), 1);
    assert_eq!(status(&conn, "turn-initial"), "stale");
}

#[test]
fn run_delete_cascades_context_and_allocator_without_touching_generic_rows() {
    let mut conn = connection();
    accept_in_transaction(&mut conn, &task_request("turn-delete")).unwrap();
    conn.execute(
        "INSERT INTO session_turn_intents
            (session_id, turn_intent_id, source, status, created_at, updated_at)
         VALUES ('sde-session', 'sde-turn', 'user_submit', 'queued', 'now', 'now')",
        [],
    )
    .unwrap();

    conn.execute(
        "DELETE FROM session_turn_intents WHERE org_run_id=?1",
        [RUN_ID],
    )
    .unwrap();
    assert_eq!(row_count(&conn, "agent_org_runtime_turn_contexts"), 0);
    assert_eq!(
        row_count(&conn, "agent_org_runtime_member_dispatch_allocators"),
        1
    );
    conn.execute("DELETE FROM agent_org_runtime_runs WHERE id=?1", [RUN_ID])
        .unwrap();
    assert_eq!(
        row_count(&conn, "agent_org_runtime_member_dispatch_allocators"),
        0
    );
    assert_eq!(row_count(&conn, "session_turn_intents"), 1);
}
