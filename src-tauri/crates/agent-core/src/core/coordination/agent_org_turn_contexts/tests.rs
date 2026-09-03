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
         CREATE TABLE agent_org_runtime_run_progress (
            org_run_id TEXT PRIMARY KEY,
            work_revision INTEGER NOT NULL DEFAULT 0,
            coordinator_presented_work_revision INTEGER,
            coordinator_observed_work_revision INTEGER,
            completion_requested INTEGER NOT NULL DEFAULT 0,
            completion_requested_at TEXT,
            completion_requested_work_revision INTEGER,
            completion_summary TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
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
            activation_generation INTEGER NOT NULL DEFAULT 1,
            owner TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            execution_mode TEXT NOT NULL DEFAULT 'build',
            blocked_by_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT 'now',
            PRIMARY KEY(org_run_id, id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
         );
         CREATE TABLE agent_org_runtime_task_events (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            previous_owner TEXT,
            next_owner TEXT,
            previous_status TEXT,
            next_status TEXT,
            actor_member_id TEXT,
            actor_kind TEXT NOT NULL,
            source_turn_intent_id TEXT,
            created_at TEXT NOT NULL
         );
         CREATE INDEX idx_agent_org_runtime_task_events_task
            ON agent_org_runtime_task_events(org_run_id, task_id, created_at, id);
         CREATE TABLE agent_org_runtime_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipient_agent_id TEXT NOT NULL DEFAULT 'agent-member',
            org_run_id TEXT NOT NULL,
            recipient_member_id TEXT,
            sender_agent_id TEXT NOT NULL DEFAULT '_system',
            sender_member_id TEXT,
            payload_kind TEXT NOT NULL DEFAULT 'plain',
            payload_json TEXT NOT NULL DEFAULT '{}',
            request_id TEXT,
            created_at TEXT NOT NULL DEFAULT 'now',
            read_at TEXT,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
         );
         CREATE TABLE agent_org_runtime_inbox_delivery_resolutions (
            inbox_id INTEGER PRIMARY KEY
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
    crate::coordination::agent_inbox::create_task_message_binding_schema(conn)
        .expect("create task message binding schema");
    crate::coordination::agent_org_task_handoffs::create_schema(conn)
        .expect("create Task execution handoff schema");
    crate::coordination::agent_member_interventions::create_schema(conn)
        .expect("create intervention receipt and chain schema");
    crate::coordination::agent_org_pause::create_schema(conn).expect("create Pause receipt schema");
    crate::coordination::agent_org_formal_triggers::create_schema(conn)
        .expect("create FormalTriggerReceipt schema");
    crate::coordination::agent_org_plan_approvals::create_schema(conn)
        .expect("create immutable Plan revision schema");
    crate::coordination::agent_org_run_completion::create_schema(conn)
        .expect("create completion certificate schema");
    crate::coordination::agent_org_final_summary::create_schema(conn)
        .expect("create FinalSummaryReceipt schema");
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
         INSERT INTO agent_org_runtime_tasks
            (org_run_id,id,owner,status,execution_mode,blocked_by_json)
            VALUES ('run-a', 'task-a', 'member-a', 'pending', 'build', '[]');
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

fn insert_task_assignment(conn: &Connection, task_id: &str) -> i64 {
    let message = crate::coordination::agent_inbox::AgentMessage::TaskAssigned {
        task_id: task_id.to_string(),
        subject: format!("Task {task_id}"),
        description: String::new(),
        assigned_by: "Coordinator".into(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
        dependency_outputs: Vec::new(),
    };
    let payload = serde_json::to_string(&message).expect("serialize TaskAssigned");
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox (
            recipient_agent_id,org_run_id,recipient_member_id,sender_agent_id,
            sender_member_id,payload_kind,payload_json,created_at
         ) VALUES ('agent-member',?1,?2,'_system',NULL,'task_assigned',?3,'now')",
        params![RUN_ID, MEMBER_ID, payload],
    )
    .expect("insert TaskAssigned");
    conn.last_insert_rowid()
}

fn insert_bound_coordinator_reply(
    conn: &Connection,
    task_id: &str,
    source_turn_intent_id: &str,
) -> i64 {
    let message = crate::coordination::agent_inbox::AgentMessage::Plain {
        summary: "Coordinator reply".into(),
        text: "Continue and complete the current task.".into(),
    };
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox (
            recipient_agent_id,org_run_id,recipient_member_id,sender_agent_id,
            sender_member_id,payload_kind,payload_json,created_at
         ) VALUES ('agent-member',?1,?2,'agent-coordinator','coordinator','plain',?3,'now')",
        params![
            RUN_ID,
            MEMBER_ID,
            serde_json::to_string(&message).expect("serialize plain reply")
        ],
    )
    .expect("insert Coordinator reply");
    let inbox_id = conn.last_insert_rowid();
    crate::coordination::agent_inbox::AgentInboxStore::bind_task_message_in_tx(
        conn,
        RUN_ID,
        inbox_id,
        task_id,
        MEMBER_ID,
        source_turn_intent_id,
    )
    .expect("bind Coordinator reply to Task");
    inbox_id
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
fn idle_root_coordinator_turn_runs_and_persists_without_activating_team() {
    let mut conn = connection();
    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='idle' WHERE id=?1",
        [RUN_ID],
    )
    .unwrap();
    let request = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-idle-root",
        Some("message-idle-root".into()),
        TurnIntentBridgeSource::UserSubmit,
    );
    let context = accept_in_transaction(&mut conn, &request).expect("Idle Root Turn admission");
    assert_eq!(context.turn_kind, AgentOrgTurnKind::Coordinator);
    revalidate_context_with_connection(&conn, ROOT_SESSION_ID, "turn-idle-root")
        .expect("Idle Root can enter provider execution");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id='turn-idle-root'",
        [ROOT_SESSION_ID],
    )
    .unwrap();
    revalidate_assistant_persistence_with_connection(&conn, ROOT_SESSION_ID, "turn-idle-root")
        .expect("Idle Root can persist its final assistant answer");
    let status: String = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            [RUN_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "idle", "Q&A alone must not activate formal work");
}

#[test]
fn member_wake_binds_oldest_dependency_ready_assignment_and_revalidates_at_start() {
    let mut conn = connection();
    conn.execute_batch(
        "INSERT INTO agent_org_runtime_tasks
            (org_run_id,id,owner,status,execution_mode,blocked_by_json)
         VALUES
            ('run-a','blocker','member-a','failed','build','[]'),
            ('run-a','task-blocked','member-a','pending','build','[\"blocker\"]');",
    )
    .expect("seed blocked formal work");
    let blocked_inbox_id = insert_task_assignment(&conn, "task-blocked");
    let ready_inbox_id = insert_task_assignment(&conn, "task-a");

    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("wake transaction");
    let context = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-wake-ready",
        Some("wake-ready".into()),
        MEMBER_ID,
    )
    .expect("accept ready TaskExecution");
    transaction.commit().expect("commit ready admission");
    assert_eq!(context.turn_kind, AgentOrgTurnKind::TaskExecution);
    assert_eq!(context.task_id.as_deref(), Some("task-a"));
    assert_eq!(context.owner_member_id.as_deref(), Some(MEMBER_ID));
    assert_eq!(context.activation_generation, Some(1));
    assert_eq!(context.member_dispatch_sequence, Some(1));
    assert!(
        revalidate_context_with_connection(&conn, MEMBER_SESSION_ID, "turn-wake-ready").is_ok()
    );
    let still_unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox
             WHERE id IN (?1,?2) AND read_at IS NULL",
            params![blocked_inbox_id, ready_inbox_id],
            |row| row.get(0),
        )
        .expect("read deferred Inbox state");
    assert_eq!(
        still_unread, 2,
        "admission must not acknowledge Inbox input"
    );

    conn.execute(
        "UPDATE agent_org_runtime_tasks SET owner='member-reassigned'
         WHERE org_run_id=?1 AND id='task-a'",
        [RUN_ID],
    )
    .expect("race reassign task");
    let error = revalidate_context_with_connection(&conn, MEMBER_SESSION_ID, "turn-wake-ready")
        .expect_err("queued stale owner binding must fail before Provider execution");
    assert!(error.contains("no longer owned"), "{error}");
}

#[test]
fn coordinator_reply_resumes_the_same_in_progress_task_execution() {
    let mut conn = connection();
    let original = accept_in_transaction(&mut conn, &task_request("turn-original-task"))
        .expect("accept original TaskExecution");
    conn.execute(
        "UPDATE agent_org_runtime_tasks SET status='in_progress' WHERE id='task-a'",
        [],
    )
    .expect("start Task");
    conn.execute(
        "UPDATE session_turn_intents SET status='completed'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, &original.turn_intent_id],
    )
    .expect("finish original member Turn");

    let root = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-coordinator-reply",
        Some("message-coordinator-reply".into()),
        TurnIntentBridgeSource::Resume,
    );
    accept_in_transaction(&mut conn, &root).expect("accept Coordinator Turn");
    let reply_id = insert_bound_coordinator_reply(&conn, "task-a", "turn-coordinator-reply");

    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("reply wake transaction");
    let resumed = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-task-reply",
        None,
        MEMBER_ID,
    )
    .expect("Coordinator reply resumes exact TaskExecution");
    transaction.commit().expect("commit reply wake");

    assert_eq!(resumed.turn_kind, AgentOrgTurnKind::TaskExecution);
    assert_eq!(resumed.task_id.as_deref(), Some("task-a"));
    assert_eq!(resumed.member_dispatch_sequence, Some(2));
    assert_eq!(
        crate::coordination::agent_inbox::oldest_unread_task_message_binding_with_connection(
            &conn,
            RUN_ID,
            MEMBER_ID,
            Some("task-a")
        )
        .expect("read exact reply binding"),
        Some((reply_id, "task-a".to_string()))
    );
}

#[test]
fn unbound_plain_message_cannot_resume_task_execution() {
    let mut conn = connection();
    accept_in_transaction(&mut conn, &task_request("turn-original-task"))
        .expect("accept original TaskExecution");
    conn.execute(
        "UPDATE agent_org_runtime_tasks SET status='in_progress' WHERE id='task-a'",
        [],
    )
    .expect("start Task");
    let payload = serde_json::to_string(&crate::coordination::agent_inbox::AgentMessage::Plain {
        summary: "Peer chat".into(),
        text: "This is not Task authority.".into(),
    })
    .expect("serialize peer chat");
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox (
             recipient_agent_id,org_run_id,recipient_member_id,sender_agent_id,
             sender_member_id,payload_kind,payload_json,created_at
         ) VALUES ('agent-member',?1,?2,'agent-peer','member-peer','plain',?3,'now')",
        params![RUN_ID, MEMBER_ID, payload],
    )
    .expect("insert unbound peer chat");

    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("unbound wake transaction");
    let error = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-unbound-chat",
        None,
        MEMBER_ID,
    )
    .expect_err("ordinary chat must not grant TaskExecution authority");
    transaction.rollback().expect("rollback rejected wake");
    assert!(error.contains("no canonical ready"), "{error}");
}

#[test]
fn assistant_persistence_accepts_only_exact_same_turn_terminal_provenance() {
    let mut conn = connection();
    let turn_id = "turn-final-assistant";
    accept_in_transaction(&mut conn, &task_request(turn_id)).expect("accept TaskExecution Turn");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, turn_id],
    )
    .expect("promote Turn to running");
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='completed',updated_at='completed-at'
         WHERE org_run_id=?1 AND id='task-a'",
        [RUN_ID],
    )
    .expect("complete Task");
    conn.execute(
        "INSERT INTO agent_org_runtime_task_events (
            id,org_run_id,task_id,event_type,previous_owner,next_owner,
            previous_status,next_status,actor_member_id,actor_kind,
            source_turn_intent_id,created_at
         ) VALUES (
            'event-completed',?1,'task-a','updated',?2,?2,
            'in_progress','completed',?2,'owner_execution',?3,'completed-at'
         )",
        params![RUN_ID, MEMBER_ID, turn_id],
    )
    .expect("record exact terminal provenance");

    let admission_error = revalidate_context_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
        .expect_err("completed Task must remain closed to execution admission");
    assert!(
        admission_error.contains("not runnable (status completed)"),
        "{admission_error}"
    );
    revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
        .expect("same completing Turn may persist its final assistant iteration");

    conn.execute(
        "INSERT INTO agent_org_runtime_task_events (
            id,org_run_id,task_id,event_type,previous_owner,next_owner,
            previous_status,next_status,actor_member_id,actor_kind,
            source_turn_intent_id,created_at
         ) VALUES (
            'event-later-system',?1,'task-a','updated',?2,?2,
            'completed','completed','system:recovery','system',NULL,'later-at'
         )",
        params![RUN_ID, MEMBER_ID],
    )
    .expect("record a later non-owner Task mutation");
    let stale_terminal =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("an older exact terminal event must not outrank a later mutation");
    assert!(
        stale_terminal.contains("terminal provenance"),
        "{stale_terminal}"
    );
    conn.execute(
        "DELETE FROM agent_org_runtime_task_events WHERE id='event-later-system'",
        [],
    )
    .expect("remove later mutation for the remaining provenance cases");

    conn.execute(
        "UPDATE agent_org_runtime_task_events
         SET source_turn_intent_id='turn-other'
         WHERE id='event-completed'",
        [],
    )
    .expect("replace terminal provenance with another Turn");
    let other_turn =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("same participant but another Turn must not authorize persistence");
    assert!(other_turn.contains("terminal provenance"), "{other_turn}");

    conn.execute(
        "UPDATE agent_org_runtime_task_events
         SET source_turn_intent_id=?1,actor_kind='system'
         WHERE id='event-completed'",
        [turn_id],
    )
    .expect("replace owner provenance with system actor");
    let system_actor =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("system terminal mutation must not authorize owner final output");
    assert!(
        system_actor.contains("terminal provenance"),
        "{system_actor}"
    );

    conn.execute(
        "UPDATE agent_org_runtime_task_events
         SET actor_kind='owner_execution'
         WHERE id='event-completed'",
        [],
    )
    .expect("restore exact owner provenance");
    conn.execute(
        "UPDATE session_turn_intents SET status='completed'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, turn_id],
    )
    .expect("make base Turn terminal");
    let terminal_base =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("terminal base Turn must not keep writing assistant iterations");
    assert!(
        terminal_base.contains("requires the current running Turn"),
        "{terminal_base}"
    );
}

#[test]
fn assistant_persistence_allows_exact_owner_failure_and_cancelled_turn_end() {
    let mut conn = connection();
    let turn_id = "turn-failed-assistant";
    accept_in_transaction(&mut conn, &task_request(turn_id)).expect("accept TaskExecution Turn");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, turn_id],
    )
    .expect("promote Turn to running");
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='failed',updated_at='failed-at'
         WHERE org_run_id=?1 AND id='task-a'",
        [RUN_ID],
    )
    .expect("fail Task");
    conn.execute(
        "INSERT INTO agent_org_runtime_task_events (
            id,org_run_id,task_id,event_type,previous_owner,next_owner,
            previous_status,next_status,actor_member_id,actor_kind,
            source_turn_intent_id,created_at
         ) VALUES (
            'event-failed',?1,'task-a','updated',?2,?2,
            'in_progress','failed',?2,'owner_execution',?3,'failed-at'
         )",
        params![RUN_ID, MEMBER_ID, turn_id],
    )
    .expect("record exact owner failure provenance");
    revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
        .expect("owner may explain a failure committed by this exact Turn");

    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='cancelled',updated_at='cancelled-at'
         WHERE org_run_id=?1 AND id='task-a'",
        [RUN_ID],
    )
    .expect("cancel Task");
    let cancelled_admission = revalidate_context_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
        .expect_err("cancelled Task must stay closed to formal execution");
    assert!(
        cancelled_admission.contains("not runnable (status cancelled)"),
        "{cancelled_admission}"
    );
    revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
        .expect("the already-running exact Turn may persist its transcript and end naturally");

    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET updated_at='reassigned-at',owner='member-reassigned'
         WHERE org_run_id=?1 AND id='task-a'",
        [RUN_ID],
    )
    .expect("reassign terminal Task");
    let reassigned =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("owner drift must invalidate the old Turn");
    assert!(reassigned.contains("no longer owned"), "{reassigned}");
}

#[test]
fn assistant_persistence_rejects_generation_and_materialization_drift() {
    let mut conn = connection();
    let turn_id = "turn-drift-assistant";
    accept_in_transaction(&mut conn, &task_request(turn_id)).expect("accept TaskExecution Turn");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, turn_id],
    )
    .expect("promote Turn to running");
    revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
        .expect("current in-progress Task may persist assistant output");

    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=2 WHERE id=?1",
        [RUN_ID],
    )
    .expect("advance activation generation");
    let generation =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("stale formal generation must fail closed");
    assert!(
        generation.contains("participant/generation"),
        "{generation}"
    );
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=1 WHERE id=?1",
        [RUN_ID],
    )
    .expect("restore activation generation");

    conn.execute_batch(
        "INSERT INTO agent_sessions VALUES
            ('session-member-new', 'agent-member', 'member-a');
         INSERT INTO agent_org_runtime_member_materializations
            (org_run_id, member_id, agent_id, generation, session_id, status)
         VALUES
            ('run-a', 'member-a', 'agent-member', 2, 'session-member-new', 'succeeded');",
    )
    .expect("replace canonical Member materialization");
    let materialization =
        revalidate_assistant_persistence_with_connection(&conn, MEMBER_SESSION_ID, turn_id)
            .expect_err("replaced Member Session must fail closed");
    assert!(
        materialization.contains("not the latest canonical materialization"),
        "{materialization}"
    );
}

#[test]
fn assistant_terminal_provenance_query_is_task_index_bounded() {
    let conn = connection();
    let explain = format!("EXPLAIN QUERY PLAN {TASK_ASSISTANT_PERSISTENCE_TARGET_SQL}");
    let mut statement = conn.prepare(&explain).expect("prepare query plan");
    let details = statement
        .query_map(params![RUN_ID, "task-a", MEMBER_ID, "turn-a"], |row| {
            row.get::<_, String>(3)
        })
        .expect("query plan rows")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("decode query plan");
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("idx_agent_org_runtime_task_events_task")),
        "task event lookup must use the exact run/task index: {details:?}"
    );
    assert!(
        details
            .iter()
            .all(|detail| !detail.contains("SCAN agent_org_runtime_task_events")),
        "task event lookup must not scan the full history table: {details:?}"
    );
}

#[test]
fn durable_pause_continuation_excludes_parallel_ordinary_wake_until_terminal() {
    let mut conn = connection();
    insert_task_assignment(&conn, "task-a");
    let original = accept_in_transaction(&mut conn, &task_request("turn-original"))
        .expect("accept original TaskExecution");
    conn.execute(
        "UPDATE session_turn_intents SET status='stale'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, &original.turn_intent_id],
    )
    .expect("finish original Turn before persisted continuation");
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=3 WHERE id=?1",
        [RUN_ID],
    )
    .expect("advance run to Resume generation");
    conn.execute(
        "UPDATE agent_org_runtime_member_materializations
         SET generation=3 WHERE org_run_id=?1 AND member_id=?2",
        params![RUN_ID, MEMBER_ID],
    )
    .expect("advance canonical materialization");

    let continuation_id = "turn-pause-continuation";
    let continuation = AgentOrgTurnAdmission::task_continuation(
        RUN_ID,
        MEMBER_SESSION_ID,
        continuation_id,
        Some("message-pause-continuation".into()),
        "task-a",
        MEMBER_ID,
        3,
    );
    let continuation_context = accept_in_transaction(&mut conn, &continuation)
        .expect("persist Resume continuation before dispatcher starts");
    assert_eq!(continuation_context.member_dispatch_sequence, Some(2));
    conn.execute_batch(
        "INSERT INTO agent_org_runtime_pause_episodes (
            episode_id,org_run_id,pause_request_id,pause_generation,status,
            resume_request_id,resume_generation,teardown_owner_id,
            created_at,updated_at,resumed_at
         ) VALUES (
            'episode-a','run-a','pause-request-a',2,'consumed',
            'resume-request-a',3,'teardown-a','now','now','now'
         );
         INSERT INTO agent_org_runtime_pause_handoffs (
            handoff_id,episode_id,org_run_id,session_id,original_turn_intent_id,
            turn_kind,participant_id,task_id,original_owner_member_id,
            original_activation_generation,original_intent_status,drain_status,
            continuation_turn_intent_id,continuation_status,created_at,updated_at
         ) VALUES (
            'handoff-a','episode-a','run-a','session-member','turn-original',
            'task_execution','member-a','task-a','member-a',1,'queued','released',
            'turn-pause-continuation','queued','now','now'
         );",
    )
    .expect("seed durable continuation receipt");

    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("competing ordinary Wake transaction");
    let error = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-duplicate-wake",
        None,
        MEMBER_ID,
    )
    .expect_err("ordinary Wake must not compete with a live continuation");
    transaction
        .rollback()
        .expect("rollback rejected competing Wake");
    assert!(error.contains("durable Pause continuation"), "{error}");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM session_turn_intents WHERE turn_intent_id='turn-duplicate-wake'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("count rejected duplicate intent"),
        0
    );

    conn.execute(
        "UPDATE session_turn_intents SET status='completed'
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![MEMBER_SESSION_ID, continuation_id],
    )
    .expect("finish continuation");
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("post-continuation Wake transaction");
    let next = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-after-continuation",
        None,
        MEMBER_ID,
    )
    .expect("ordinary Wake may proceed after continuation is terminal");
    transaction.commit().expect("commit post-continuation Wake");
    assert_eq!(next.member_dispatch_sequence, Some(3));
}

#[test]
fn failed_or_cancelled_blockers_never_unlock_a_task_wake() {
    let mut conn = connection();
    conn.execute_batch(
        "UPDATE agent_org_runtime_tasks SET status='cancelled' WHERE id='task-a';
         INSERT INTO agent_org_runtime_tasks
            (org_run_id,id,owner,status,execution_mode,blocked_by_json)
         VALUES
            ('run-a','blocker','member-a','failed','build','[]'),
            ('run-a','downstream','member-a','pending','build','[\"blocker\"]');",
    )
    .expect("seed failed dependency");
    insert_task_assignment(&conn, "downstream");

    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("wake transaction");
    let error = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-blocked",
        None,
        MEMBER_ID,
    )
    .expect_err("failed dependency cannot authorize TaskExecution");
    transaction.rollback().expect("rollback rejected wake");
    assert!(error.contains("no canonical ready"), "{error}");

    conn.execute(
        "UPDATE agent_org_runtime_tasks SET status='completed'
         WHERE org_run_id=?1 AND id='blocker'",
        [RUN_ID],
    )
    .expect("complete dependency");
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("unblocked wake transaction");
    let context = accept_wake_with_connection(
        &transaction,
        RUN_ID,
        MEMBER_SESSION_ID,
        "turn-unblocked",
        None,
        MEMBER_ID,
    )
    .expect("completed dependency authorizes TaskExecution");
    transaction.commit().expect("commit unblocked wake");
    assert_eq!(context.task_id.as_deref(), Some("downstream"));
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
fn recovery_fails_interrupted_coordinator_but_preserves_task_execution_for_exact_recovery() {
    let mut conn = connection();
    let coordinator = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-interrupted-coordinator",
        Some("message-interrupted-coordinator".into()),
        TurnIntentBridgeSource::UserSubmit,
    );
    accept_in_transaction(&mut conn, &coordinator).unwrap();
    accept_in_transaction(&mut conn, &task_request("turn-interrupted-task")).unwrap();
    conn.execute(
        "UPDATE session_turn_intents
         SET status='running'
         WHERE turn_intent_id IN ('turn-interrupted-coordinator','turn-interrupted-task')",
        [],
    )
    .unwrap();

    assert_eq!(reconcile_in_flight_after_restart(&conn).unwrap(), 1);
    assert_eq!(status(&conn, "turn-interrupted-coordinator"), "failed");
    assert_eq!(status(&conn, "turn-interrupted-task"), "running");
}

#[test]
fn background_coordinator_wake_preserves_the_durable_fact_trigger() {
    let mut conn = connection();
    let receipt = crate::coordination::agent_org_formal_triggers::record_trigger_in_tx(
        &conn,
        RUN_ID,
        crate::coordination::agent_org_formal_triggers::FormalTriggerSource {
            trigger_kind: "task_graph",
            trigger_id: "revision-7",
            trigger_revision: 1,
            source_kind: "task_graph",
            inbox_id: None,
            task_id: None,
            owner_member_id: Some("coordinator"),
            source_turn_intent_id: None,
            task_output_digest: None,
            plan_revision_id: None,
            doorbell_status: crate::coordination::agent_org_formal_triggers::FormalTriggerDoorbellStatus::Missing,
            initially_resolved: false,
        },
    )
    .unwrap();
    let request = AgentOrgTurnAdmission::coordinator(
        RUN_ID,
        ROOT_SESSION_ID,
        "turn-background-wake",
        Some("message-background-wake".into()),
        TurnIntentBridgeSource::Resume,
    );
    accept_in_transaction(&mut conn, &request).unwrap();

    let persisted: (String, String, i64, String, String) = conn
        .query_row(
            "SELECT trigger_kind,trigger_id,trigger_revision,status,doorbell_status
             FROM agent_org_runtime_formal_trigger_receipts WHERE receipt_id=?1",
            [&receipt.receipt_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        persisted,
        (
            "task_graph".to_string(),
            "revision-7".to_string(),
            1,
            "pending".to_string(),
            "missing".to_string(),
        )
    );
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
