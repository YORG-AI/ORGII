use std::sync::{Arc, Mutex};

use super::*;
use crate::coordination::agent_inbox::AgentInboxStore;
use test_helpers::test_env;

#[derive(Default, Debug)]
struct RecordingWakeHook {
    calls: Mutex<Vec<(String, String)>>,
}

impl RecordingWakeHook {
    fn snapshot(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl InboxWakeHook for RecordingWakeHook {
    fn wake_member(&self, member_id: &str, org_run_id: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((member_id.to_string(), org_run_id.to_string()));
    }
}

fn insert_member_inbox_row(run_id: &str, member_id: &str) {
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".to_string(),
        recipient_member_id: Some(member_id.to_string()),
        sender_agent_id: crate::coordination::agent_inbox::USER_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some(run_id.to_string()),
        message: AgentMessage::Plain {
            summary: "User group chat message".to_string(),
            text: "Who are you?".to_string(),
        },
    })
    .expect("insert member inbox row");
}

fn seed_run(conn: &rusqlite::Connection, run_id: &str, status: &str) {
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
         );",
    )
    .expect("Turn intent schema");
    crate::coordination::init_agent_org_schemas(conn).expect("canonical Agent Org schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs (
             id, org_id, coordinator_agent_id, root_session_id,
             entry_mode, status, created_at, updated_at,archived_at,archive_receipt_id
         ) VALUES (?1, 'org-1', 'coord', 'root-1', 'build', ?2, ?3, ?3,
                   CASE WHEN ?2='archived' THEN ?3 ELSE NULL END,
                   CASE WHEN ?2='archived' THEN ?4 ELSE NULL END)",
        rusqlite::params![run_id, status, now, format!("{run_id}-archive-receipt")],
    )
    .expect("seed Agent Org run");
}

fn seed_completed_task(conn: &rusqlite::Connection, run_id: &str, member_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks (
             id,org_run_id,activation_generation,subject,description,owner,status,
             execution_mode,blocked_by_json,output_json,created_by_participant_id,
             source_turn_intent_id,created_at,updated_at
         ) VALUES (
             'task-terminal',?1,1,'Terminal work','',?2,'completed','build','[]',
             '{\"summary\":\"done\"}','coordinator','turn-create',?3,?3
         )",
        rusqlite::params![run_id, member_id, now],
    )
    .expect("seed terminal Task");
}

fn seed_active_task_turn(conn: &rusqlite::Connection, run_id: &str, member_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents (
             session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('worker-session','worker-turn',?1,'agent_org','running',?2,?2)",
        rusqlite::params![run_id, &now],
    )
    .expect("seed active worker Turn intent");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
             session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
             task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
             source_kind,source_id,activation_generation,created_at
         ) VALUES (
             'worker-session','worker-turn',?1,?2,'task_execution',
             'task-terminal',?2,?2,1,'task','task-terminal',1,?3
         )",
        rusqlite::params![run_id, member_id, &now],
    )
    .expect("seed exact worker Turn context");
}

#[test]
fn blocking_section_is_safe_inside_current_thread_runtime() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    runtime.block_on(async {
        assert_eq!(run_agent_org_blocking_section(|| 42), 42);
    });
}

#[test]
fn routine_member_idle_persists_without_coordinator_provider_wake() {
    let _sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test connection");
    seed_run(&conn, "run-1", "running");
    let wake_hook = Arc::new(RecordingWakeHook::default());
    let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

    hook.post_member_idle(
        "run-1",
        "coord",
        "member-worker",
        "worker-1",
        "Worker",
        MemberIdleReason::Available,
        Some(crate::session::AgentExecMode::Plan),
        None,
        None,
        Vec::new(),
    );

    let inbox = AgentInboxStore::list_unread_for_member(
        crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
        "run-1",
    )
    .expect("coordinator inbox");
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].payload_kind, "member_idle");
    assert!(wake_hook.snapshot().is_empty());
    let receipt_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_formal_trigger_receipts",
            [],
            |row| row.get(0),
        )
        .expect("receipt count");
    assert_eq!(receipt_count, 0);
}

#[test]
fn final_member_idle_creates_exact_formal_receipt_and_wakes_coordinator() {
    let _sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test connection");
    seed_run(&conn, "run-final", "running");
    seed_completed_task(&conn, "run-final", "member-worker");
    seed_active_task_turn(&conn, "run-final", "member-worker");
    let wake_hook = Arc::new(RecordingWakeHook::default());
    let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

    hook.post_member_idle(
        "run-final",
        "coord",
        "member-worker",
        "worker-1",
        "Worker",
        MemberIdleReason::Available,
        Some(crate::session::AgentExecMode::Build),
        None,
        None,
        Vec::new(),
    );

    assert_eq!(
        wake_hook.snapshot(),
        vec![(
            crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.into(),
            "run-final".into()
        )]
    );
    let receipt: (String, String, String, String, String) = conn
        .query_row(
            "SELECT source_kind,status,task_id,owner_member_id,source_turn_intent_id
             FROM agent_org_runtime_formal_trigger_receipts",
            [],
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
        .expect("final MemberIdle receipt");
    assert_eq!(
        receipt,
        (
            "formal_lifecycle".to_string(),
            "pending".to_string(),
            "task-terminal".to_string(),
            "member-worker".to_string(),
            "worker-turn".to_string(),
        )
    );
}

#[test]
fn member_idle_wakes_member_when_post_turn_inbox_is_unread() {
    let _sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test connection");
    seed_run(&conn, "run-1", "running");
    insert_member_inbox_row("run-1", "member-worker");
    let wake_hook = Arc::new(RecordingWakeHook::default());
    let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

    hook.post_member_idle(
        "run-1",
        "coord",
        "member-worker",
        "worker-1",
        "Worker",
        MemberIdleReason::Available,
        Some(crate::session::AgentExecMode::Build),
        None,
        None,
        Vec::new(),
    );

    assert_eq!(
        wake_hook.snapshot(),
        vec![("member-worker".into(), "run-1".into())]
    );
}

#[test]
fn member_idle_does_not_reopen_terminal_run_inbox() {
    let _sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test connection");
    seed_run(&conn, "run-terminal", "archived");
    let wake_hook = Arc::new(RecordingWakeHook::default());
    let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

    hook.post_member_idle(
        "run-terminal",
        "coord",
        "member-worker",
        "worker-1",
        "Worker",
        MemberIdleReason::Available,
        Some(crate::session::AgentExecMode::Build),
        None,
        None,
        Vec::new(),
    );

    assert!(AgentInboxStore::list_unread_for_member(
        crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
        "run-terminal",
    )
    .expect("coordinator inbox")
    .is_empty());
    assert!(wake_hook.snapshot().is_empty());
}
