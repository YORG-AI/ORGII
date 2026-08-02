use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::coordination::agent_org_runs::{
    agent_org_submission_in_progress, establish_conversation_delete_fence, AgentOrgRunStatus,
    AgentOrgSubmissionLease, COORDINATOR_MEMBER_ID,
};
use crate::session::persistence::{self as session_persistence, session_type};
use crate::session::scheduler::ExecuteFn;
use crate::session::{ScheduledKind, ScheduledMessage, SessionStatus};
use crate::state::{AgentAppState, AgentSession};

use super::agent_org_delete::{
    agent_org_delete_topology_matches, delete_agent_org_session_hierarchy,
    load_agent_org_session_delete_plan, stop_agent_org_runtime_sessions_with_timeout,
    validate_agent_org_delete_ready, AgentOrgRunDeletePlan, AgentOrgSessionDeleteNode,
    AgentOrgSessionDeletePlan, MAX_AGENT_ORG_DELETE_RUNS, MAX_AGENT_ORG_DELETE_SESSIONS,
};

const NOW: &str = "2026-08-02T00:00:00Z";

fn ensure_schemas() {
    let conn = database::db::get_connection().expect("sandbox DB");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("snapshot schema");
    session_persistence::init(&conn).expect("Session schema");
    crate::interaction::plan_approval::persistence::init_schema(&conn).expect("approval schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    project_management::lineage::schema::init_lineage_tables(&conn).expect("lineage schema");
    crate::memory::learnings::init_learnings_table(&conn).expect("learnings schema");
    database::init_shell_replay_tables(&conn).expect("shell replay schema");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS code_sessions (session_id TEXT PRIMARY KEY,cli_agent_type TEXT NOT NULL,status TEXT NOT NULL,parent_session_id TEXT,org_member_id TEXT,updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS session_turn_intents (session_id TEXT NOT NULL,turn_intent_id TEXT NOT NULL,client_message_id TEXT,org_run_id TEXT,source TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(session_id,turn_intent_id));
         CREATE TABLE session_turns (session_id TEXT); CREATE TABLE session_turn_index_state (session_id TEXT); CREATE TABLE sessions (session_id TEXT); CREATE TABLE goal_loop_state (session_id TEXT); CREATE TABLE housekeeper_context_compaction (session_id TEXT);",
    )
    .expect("runtime schemas");
}

fn seed_session(
    conn: &Connection,
    session_id: &str,
    parent_session_id: Option<&str>,
    status: SessionStatus,
    kind: &str,
    member_id: Option<&str>,
) {
    conn.execute(
        "INSERT INTO agent_sessions (session_id,name,status,created_at,updated_at,session_type,agent_definition_id,org_member_id,parent_session_id,workspace_additional_json,key_source) VALUES (?1,?1,?2,?3,?3,?4,?5,?6,?7,'{}','own_key')",
        params![
            session_id,
            status.as_str(),
            NOW,
            kind,
            member_id.map(|_| "agent-worker"),
            member_id,
            parent_session_id
        ],
    )
    .expect("seed Session");
}

fn seed_root(conn: &Connection, session_id: &str) {
    seed_session(
        conn,
        session_id,
        None,
        SessionStatus::Idle,
        session_type::GENERIC,
        None,
    );
}

fn seed_plain_child(conn: &Connection, session_id: &str, parent: &str) {
    seed_session(
        conn,
        session_id,
        Some(parent),
        SessionStatus::Idle,
        session_type::GENERIC,
        None,
    );
}

fn seed_run(conn: &Connection, run_id: &str, root: &str, status: AgentOrgRunStatus) {
    conn.execute(
        "INSERT INTO agent_org_runs (id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,created_at,updated_at) VALUES (?1,'org-delete-test','coordinator-agent',?2,'standalone_session',?3,?4,?4)",
        params![run_id, root, status.as_str(), NOW],
    )
    .expect("seed Run");
    conn.execute(
        "INSERT INTO agent_org_run_sessions (org_run_id,member_id,session_id,role,created_at) VALUES (?1,?2,?3,'coordinator',?4)",
        params![run_id, COORDINATOR_MEMBER_ID, root, NOW],
    )
    .expect("seed Coordinator mapping");
}

fn seed_done_run(conn: &Connection, run_id: &str, root: &str) {
    seed_run(conn, run_id, root, AgentOrgRunStatus::Completed);
}

fn seed_worker(conn: &Connection, run_id: &str, worker: &str, root: &str, member: &str) {
    seed_session(
        conn,
        worker,
        Some(root),
        SessionStatus::Completed,
        session_type::ORG_MEMBER,
        Some(member),
    );
    conn.execute(
        "INSERT INTO agent_org_run_sessions (org_run_id,member_id,session_id,role,created_at) VALUES (?1,?2,?3,'worker',?4)",
        params![run_id, member, worker, NOW],
    )
    .expect("seed Worker mapping");
}

fn seed_owned_rows(conn: &Connection, session_id: &str) {
    for table in [
        "session_turns",
        "session_turn_index_state",
        "sessions",
        "goal_loop_state",
        "housekeeper_context_compaction",
    ] {
        conn.execute(
            &format!("INSERT INTO {table} (session_id) VALUES (?1)"),
            [session_id],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO agent_messages (id,session_id,role,content,sequence,created_at) VALUES (?1,?2,'user','delete me',0,?3)",
        params![format!("message-{session_id}"), session_id, NOW],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_todos (session_id,content) VALUES (?1,'delete me')",
        [session_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO events (id,session_id) VALUES (?1,?2)",
        params![format!("event-{session_id}"), session_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_turn_intents (session_id,turn_intent_id,source,status,created_at,updated_at) VALUES (?1,?2,'session','pending',?3,?3)",
        params![session_id, format!("intent-session-{session_id}"), NOW],
    )
    .unwrap();
}

fn seed_run_rows(conn: &Connection, run_id: &str) {
    conn.execute(
        "INSERT INTO agent_org_tasks (id,org_run_id,subject,status,created_at,updated_at) VALUES (?1,?2,'delete me','completed',?3,?3)",
        params![format!("task-{run_id}"), run_id, NOW],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_inbox (recipient_agent_id,recipient_member_id,sender_agent_id,org_run_id,payload_kind,payload_json,created_at) VALUES ('worker-agent','worker','system',?1,'plain','{\"summary\":\"delete me\",\"text\":\"body\"}',?2)",
        params![run_id, NOW],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_turn_intents (session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at) VALUES (?1,?2,?3,'agent_org','pending',?4,?4)",
        params![format!("run-owner-{run_id}"), format!("intent-run-{run_id}"), run_id, NOW],
    )
    .unwrap();
}

fn exists(conn: &Connection, table: &str, column: &str, value: &str) -> bool {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1)"),
        [value],
        |row| row.get(0),
    )
    .expect("inspect row")
}

fn fenced_plan(root: &str) -> AgentOrgSessionDeletePlan {
    establish_conversation_delete_fence(root).expect("establish durable fence");
    let conn = database::db::get_connection().unwrap();
    load_agent_org_session_delete_plan(&conn, root)
        .expect("load delete plan")
        .expect("Root owns Runs")
}

#[test]
fn deletion_submission_lease_is_reference_counted() {
    let session_id = format!("delete-submission-lease-{}", uuid::Uuid::new_v4());
    assert!(!agent_org_submission_in_progress(&session_id));
    let first = AgentOrgSubmissionLease::begin(&session_id);
    let second = AgentOrgSubmissionLease::begin(&session_id);
    drop(first);
    assert!(agent_org_submission_in_progress(&session_id));
    drop(second);
    assert!(!agent_org_submission_in_progress(&session_id));
}

#[test]
fn session_hierarchy_delete_removes_exact_multi_run_ownership() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().unwrap();
    let root = "delete-multi-root";
    seed_root(&conn, root);
    seed_done_run(&conn, "delete-run-a", root);
    seed_run(&conn, "delete-run-b", root, AgentOrgRunStatus::Paused);
    seed_worker(&conn, "delete-run-a", "delete-worker-a", root, "worker-a");
    seed_worker(&conn, "delete-run-b", "delete-worker-b", root, "worker-b");
    conn.execute(
        "UPDATE agent_sessions SET session_type=?1
         WHERE session_id='delete-worker-a'",
        [session_type::GENERIC],
    )
    .unwrap();
    seed_plain_child(&conn, "delete-plain-child", root);
    seed_root(&conn, "delete-unrelated-root");
    seed_done_run(&conn, "delete-unrelated-run", "delete-unrelated-root");
    seed_worker(
        &conn,
        "delete-unrelated-run",
        "delete-unrelated-worker",
        "delete-unrelated-root",
        "unrelated-worker",
    );
    for session in [
        root,
        "delete-worker-a",
        "delete-worker-b",
        "delete-unrelated-root",
    ] {
        seed_owned_rows(&conn, session);
    }
    for run in ["delete-run-a", "delete-run-b", "delete-unrelated-run"] {
        seed_run_rows(&conn, run);
    }
    let scratch_workspace = tempfile::TempDir::new().unwrap();
    let scratchpad = app_paths::ensure_scratchpad(root, scratch_workspace.path()).unwrap();
    std::fs::write(scratchpad.join("delete-me.txt"), "ephemeral").unwrap();
    drop(conn);

    let plan = fenced_plan(root);
    assert_eq!(plan.runs.len(), 2);
    let safe = plan
        .sessions
        .iter()
        .map(|node| node.session_id.clone())
        .collect::<HashSet<_>>();
    let receipt = delete_agent_org_session_hierarchy(&plan, &safe).expect("atomic delete");
    assert_eq!(
        receipt
            .deleted_session_ids
            .into_iter()
            .collect::<HashSet<_>>(),
        HashSet::from([
            root.to_string(),
            "delete-worker-a".to_string(),
            "delete-worker-b".to_string(),
        ])
    );

    let conn = database::db::get_connection().unwrap();
    for session in [root, "delete-worker-a", "delete-worker-b"] {
        assert!(!exists(&conn, "agent_sessions", "session_id", session));
        assert!(!exists(
            &conn,
            "session_turn_intents",
            "session_id",
            session
        ));
        for table in [
            "session_turns",
            "session_turn_index_state",
            "sessions",
            "goal_loop_state",
            "housekeeper_context_compaction",
        ] {
            assert!(!exists(&conn, table, "session_id", session));
        }
    }
    for run in ["delete-run-a", "delete-run-b"] {
        assert!(!exists(&conn, "agent_org_runs", "id", run));
        assert!(!exists(&conn, "agent_org_tasks", "org_run_id", run));
        assert!(!exists(&conn, "agent_inbox", "org_run_id", run));
        assert!(!exists(&conn, "session_turn_intents", "org_run_id", run));
    }
    assert!(!exists(
        &conn,
        "agent_org_conversation_delete_fences",
        "root_session_id",
        root,
    ));
    for session in [
        "delete-plain-child",
        "delete-unrelated-root",
        "delete-unrelated-worker",
    ] {
        assert!(exists(&conn, "agent_sessions", "session_id", session));
    }
    assert!(exists(
        &conn,
        "agent_org_runs",
        "id",
        "delete-unrelated-run"
    ));
    assert!(!scratchpad.exists());
}

#[test]
fn session_hierarchy_delete_rolls_back_then_retries_idempotently() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().unwrap();
    let root = "delete-rollback-root";
    seed_root(&conn, root);
    for suffix in ["a", "b"] {
        let run = format!("delete-rollback-run-{suffix}");
        let worker = format!("delete-rollback-worker-{suffix}");
        seed_done_run(&conn, &run, root);
        seed_worker(&conn, &run, &worker, root, &format!("worker-{suffix}"));
        seed_owned_rows(&conn, &worker);
        seed_run_rows(&conn, &run);
    }
    seed_owned_rows(&conn, root);
    drop(conn);
    let plan = fenced_plan(root);
    let conn = database::db::get_connection().unwrap();
    conn.execute_batch(
        "CREATE TRIGGER abort_multi_run_root_delete
         BEFORE DELETE ON agent_sessions
         WHEN OLD.session_id='delete-rollback-root'
         BEGIN SELECT RAISE(ABORT, 'injected multi-run delete failure'); END;",
    )
    .unwrap();
    drop(conn);

    let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect_err("trigger aborts the entire transaction");
    assert!(error.contains("injected multi-run delete failure"));
    let conn = database::db::get_connection().unwrap();
    for session in [root, "delete-rollback-worker-a", "delete-rollback-worker-b"] {
        assert!(exists(&conn, "agent_sessions", "session_id", session));
        assert!(exists(&conn, "agent_messages", "session_id", session));
        assert!(exists(&conn, "session_turns", "session_id", session));
    }
    for run in ["delete-rollback-run-a", "delete-rollback-run-b"] {
        assert!(exists(&conn, "agent_org_runs", "id", run));
        assert!(exists(&conn, "agent_org_tasks", "org_run_id", run));
    }
    assert!(exists(
        &conn,
        "agent_org_conversation_delete_fences",
        "root_session_id",
        root,
    ));
    conn.execute_batch("DROP TRIGGER abort_multi_run_root_delete")
        .unwrap();
    drop(conn);

    let first = delete_agent_org_session_hierarchy(&plan, &HashSet::new()).unwrap();
    let repeated = delete_agent_org_session_hierarchy(&plan, &HashSet::new()).unwrap();
    assert_eq!(repeated.deleted_session_ids, first.deleted_session_ids);
}

#[test]
fn session_hierarchy_delete_fails_closed_on_invalid_ownership() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().unwrap();

    seed_root(&conn, "delete-unmapped-root");
    seed_done_run(&conn, "delete-unmapped-run", "delete-unmapped-root");
    seed_plain_child(&conn, "delete-unmapped-parent", "delete-unmapped-root");
    seed_session(
        &conn,
        "delete-unmapped-worker",
        Some("delete-unmapped-parent"),
        SessionStatus::Completed,
        session_type::GENERIC,
        Some("unmapped-worker"),
    );
    conn.execute(
        "UPDATE agent_sessions SET agent_definition_id='agent-worker'
         WHERE session_id='delete-unmapped-worker'",
        [],
    )
    .unwrap();
    let error = load_agent_org_session_delete_plan(&conn, "delete-unmapped-root").unwrap_err();
    assert!(error.contains("no exact Run ownership"));

    seed_root(&conn, "delete-missing-map-root");
    conn.execute(
        "INSERT INTO agent_org_runs (id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,created_at,updated_at) VALUES ('delete-missing-map-run','org','agent','delete-missing-map-root','standalone_session','completed',?1,?1)",
        [NOW],
    )
    .unwrap();
    let error = load_agent_org_session_delete_plan(&conn, "delete-missing-map-root").unwrap_err();
    assert!(error.contains("Coordinator mapping is missing"));

    seed_root(&conn, "delete-nested-root");
    seed_done_run(&conn, "delete-nested-outer-run", "delete-nested-root");
    seed_plain_child(&conn, "delete-inner-root", "delete-nested-root");
    seed_done_run(&conn, "delete-nested-inner-run", "delete-inner-root");
    let error = load_agent_org_session_delete_plan(&conn, "delete-nested-root").unwrap_err();
    assert!(error.contains("unsupported nested run"));

    seed_root(&conn, "delete-cli-root");
    seed_done_run(&conn, "delete-cli-run", "delete-cli-root");
    conn.execute(
        "INSERT INTO code_sessions (session_id,cli_agent_type,status,parent_session_id,updated_at) VALUES ('delete-cli-child','codex','completed','delete-cli-root',?1)",
        [NOW],
    )
    .unwrap();
    let error = load_agent_org_session_delete_plan(&conn, "delete-cli-root").unwrap_err();
    assert!(error.contains("historical CLI"));

    seed_root(&conn, "delete-worker-cli-root");
    seed_done_run(&conn, "delete-worker-cli-run", "delete-worker-cli-root");
    seed_worker(
        &conn,
        "delete-worker-cli-run",
        "delete-worker-cli-worker",
        "delete-worker-cli-root",
        "worker",
    );
    conn.execute(
        "INSERT INTO code_sessions (session_id,cli_agent_type,status,parent_session_id,updated_at) VALUES ('delete-worker-cli-child','codex','completed','delete-worker-cli-worker',?1)",
        [NOW],
    )
    .unwrap();
    let error = load_agent_org_session_delete_plan(&conn, "delete-worker-cli-root").unwrap_err();
    assert!(error.contains("historical CLI"));

    seed_root(&conn, "delete-cli-snapshot-root");
    seed_done_run(&conn, "delete-cli-snapshot-run", "delete-cli-snapshot-root");
    conn.execute(
        "UPDATE agent_org_runs SET org_snapshot_json=?1 WHERE id='delete-cli-snapshot-run'",
        [r#"{"id":"legacy-cli-org","name":"Legacy CLI Org","role":"lead","agentId":"builtin:general","children":[{"id":"cli-worker","name":"CLI Worker","role":"worker","agentId":"cli:claude_code","children":[]}]}"#],
    )
    .unwrap();
    let error = load_agent_org_session_delete_plan(&conn, "delete-cli-snapshot-root").unwrap_err();
    assert!(error.contains("CLI members are unsupported"));

    for root in [
        "delete-unmapped-root",
        "delete-missing-map-root",
        "delete-nested-root",
        "delete-cli-root",
        "delete-worker-cli-root",
        "delete-cli-snapshot-root",
    ] {
        assert!(!exists(
            &conn,
            "agent_org_conversation_delete_fences",
            "root_session_id",
            root,
        ));
    }
}

#[test]
fn fenced_root_without_runs_never_falls_back_to_ordinary_delete() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().unwrap();
    let root = "delete-orphan-fence-root";
    seed_root(&conn, root);
    seed_done_run(&conn, "delete-orphan-fence-run", root);
    drop(conn);
    establish_conversation_delete_fence(root).unwrap();
    let conn = database::db::get_connection().unwrap();
    conn.execute(
        "DELETE FROM agent_org_run_sessions WHERE org_run_id='delete-orphan-fence-run'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM agent_org_runs WHERE id='delete-orphan-fence-run'",
        [],
    )
    .unwrap();

    let error = load_agent_org_session_delete_plan(&conn, root).unwrap_err();
    assert!(error.contains("conversation_deleting"));
    assert!(exists(&conn, "agent_sessions", "session_id", root));
    assert!(exists(
        &conn,
        "agent_org_conversation_delete_fences",
        "root_session_id",
        root,
    ));
}

#[test]
fn session_hierarchy_delete_enforces_run_limit_and_rechecks_topology() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let mut conn = database::db::get_connection().unwrap();
    let root = "delete-run-limit-root";
    seed_root(&conn, root);
    let tx = conn.transaction().unwrap();
    for index in 0..MAX_AGENT_ORG_DELETE_RUNS {
        seed_done_run(&tx, &format!("delete-limit-run-{index:04}"), root);
    }
    tx.commit().unwrap();
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .unwrap()
        .unwrap();
    assert_eq!(plan.runs.len(), MAX_AGENT_ORG_DELETE_RUNS);
    seed_done_run(&conn, "delete-limit-run-overflow", root);
    let error = load_agent_org_session_delete_plan(&conn, root).unwrap_err();
    assert!(error.contains("Run ownership exceeds"));

    let topology_root = "delete-topology-root";
    seed_root(&conn, topology_root);
    seed_done_run(&conn, "delete-topology-run-a", topology_root);
    seed_worker(
        &conn,
        "delete-topology-run-a",
        "delete-topology-worker-a",
        topology_root,
        "worker-a",
    );
    drop(conn);
    let expected = fenced_plan(topology_root);
    let conn = database::db::get_connection().unwrap();
    seed_done_run(&conn, "delete-topology-run-b", topology_root);
    let current = load_agent_org_session_delete_plan(&conn, topology_root)
        .unwrap()
        .unwrap();
    assert!(!agent_org_delete_topology_matches(&expected, &current));
    drop(conn);
    let error = delete_agent_org_session_hierarchy(&expected, &HashSet::new()).unwrap_err();
    assert!(error.contains("ownership changed before deletion"));
}

#[test]
fn session_hierarchy_delete_enforces_unique_session_limit_plus_one() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let mut conn = database::db::get_connection().unwrap();
    let root = "delete-session-limit-root";
    let run = "delete-session-limit-run";
    seed_root(&conn, root);
    seed_done_run(&conn, run, root);
    let tx = conn.transaction().unwrap();
    for index in 0..(MAX_AGENT_ORG_DELETE_SESSIONS - 1) {
        seed_worker(
            &tx,
            run,
            &format!("delete-session-limit-worker-{index:04}"),
            root,
            &format!("worker-{index:04}"),
        );
    }
    tx.commit().unwrap();
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .unwrap()
        .unwrap();
    assert_eq!(plan.sessions.len(), MAX_AGENT_ORG_DELETE_SESSIONS);

    seed_worker(
        &conn,
        run,
        "delete-session-limit-overflow",
        root,
        "worker-overflow",
    );
    let error = load_agent_org_session_delete_plan(&conn, root).unwrap_err();
    assert!(error.contains("exceed"));
}

#[test]
fn concurrent_hierarchy_deletes_are_complete_and_idempotent() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().unwrap();
    let root = "delete-concurrent-root";
    seed_root(&conn, root);
    seed_done_run(&conn, "delete-concurrent-run", root);
    seed_worker(
        &conn,
        "delete-concurrent-run",
        "delete-concurrent-worker",
        root,
        "worker",
    );
    drop(conn);
    let plan = fenced_plan(root);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let plan = plan.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            })
        })
        .collect::<Vec<_>>();
    let receipts = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        receipts[0].deleted_session_ids,
        receipts[1].deleted_session_ids
    );
    assert_eq!(receipts[0].deleted_session_ids.len(), 2);
}

#[test]
fn direct_worker_delete_preserves_root_and_run() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().unwrap();
    let root = "delete-direct-worker-root";
    let run = "delete-direct-worker-run";
    let worker = "delete-direct-worker";
    seed_root(&conn, root);
    seed_done_run(&conn, run, root);
    seed_worker(&conn, run, worker, root, "worker");
    assert!(load_agent_org_session_delete_plan(&conn, worker)
        .unwrap()
        .is_none());
    drop(conn);
    establish_conversation_delete_fence(root).unwrap();
    let conn = database::db::get_connection().unwrap();
    let error = load_agent_org_session_delete_plan(&conn, worker).unwrap_err();
    assert!(error.contains("conversation_deleting"));
    conn.execute(
        "DELETE FROM agent_org_conversation_delete_fences WHERE root_session_id=?1",
        [root],
    )
    .unwrap();
    drop(conn);
    session_persistence::delete_session(worker).unwrap();
    let conn = database::db::get_connection().unwrap();
    assert!(exists(&conn, "agent_sessions", "session_id", root));
    assert!(exists(&conn, "agent_org_runs", "id", run));
}

fn runtime_plan(root: &str, worker: Option<&str>) -> AgentOrgSessionDeletePlan {
    let mut sessions = vec![AgentOrgSessionDeleteNode {
        session_id: root.to_string(),
        parent_session_id: None,
        status: SessionStatus::Running,
        owning_run_id: None,
    }];
    let mut workers = Vec::new();
    if let Some(worker) = worker {
        workers.push(worker.to_string());
        sessions.push(AgentOrgSessionDeleteNode {
            session_id: worker.to_string(),
            parent_session_id: Some(root.to_string()),
            status: SessionStatus::Pending,
            owning_run_id: Some("delete-runtime-run".to_string()),
        });
    }
    AgentOrgSessionDeletePlan {
        root_session_id: root.to_string(),
        runs: vec![AgentOrgRunDeletePlan {
            run_id: "delete-runtime-run".to_string(),
            status: AgentOrgRunStatus::Cancelled,
            worker_session_ids: workers,
        }],
        sessions,
    }
}

fn scheduled_message(kind: ScheduledKind, id: &str, execute: ExecuteFn) -> ScheduledMessage {
    ScheduledMessage {
        kind,
        message_id: id.to_string(),
        generation: 0,
        client_message_id: None,
        turn_intent_id: format!("{id}-intent"),
        org_run_id: Some("delete-runtime-run".to_string()),
        content: String::new(),
        execute,
    }
}

#[tokio::test]
async fn session_hierarchy_delete_quiesces_runtime_and_times_out_safely() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();

    let initializing_state = AgentAppState::new();
    let submission_guard = AgentOrgSubmissionLease::begin("delete-initializing-root");
    let initializing_plan = runtime_plan("delete-initializing-root", None);
    let error = stop_agent_org_runtime_sessions_with_timeout(
        &initializing_state,
        &initializing_plan,
        Duration::from_millis(50),
    )
    .await
    .unwrap_err();
    assert!(error.contains("submission_in_progress"));
    drop(submission_guard);
    stop_agent_org_runtime_sessions_with_timeout(
        &initializing_state,
        &initializing_plan,
        Duration::from_millis(50),
    )
    .await
    .unwrap();

    let paused_state = AgentAppState::new();
    let paused = Arc::new(AgentSession::new(
        "delete-paused-runtime".to_string(),
        crate::definitions::AgentDefinition::default(),
    ));
    paused
        .steering_queue
        .lock()
        .await
        .push(crate::turn_executor::SteeringInjection {
            content: "must be discarded".to_string(),
            turn_intent_id: "delete-paused-steering".to_string(),
        });
    paused
        .cancel_active_turn(crate::state::control_flow::CancelReason::OrgPause)
        .await;
    assert_eq!(paused.steering_queue.lock().await.len(), 1);
    paused_state
        .sessions
        .lock()
        .await
        .insert(paused.id.clone(), Arc::clone(&paused));
    stop_agent_org_runtime_sessions_with_timeout(
        &paused_state,
        &runtime_plan("delete-paused-runtime", None),
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    assert!(paused.steering_queue.lock().await.is_empty());

    let state = AgentAppState::new();
    let runtime = Arc::new(AgentSession::new(
        "delete-runtime-root".to_string(),
        crate::definitions::AgentDefinition::default(),
    ));
    let started = Arc::new(tokio::sync::Notify::new());
    let started_for_job = Arc::clone(&started);
    let runtime_for_job = Arc::clone(&runtime);
    runtime
        .scheduler
        .enqueue(scheduled_message(
            ScheduledKind::Turn,
            "delete-runtime-active",
            Box::new(move || {
                let runtime = Arc::clone(&runtime_for_job);
                let started = Arc::clone(&started_for_job);
                Box::pin(async move {
                    runtime.begin_turn("running".to_string()).await;
                    started.notify_one();
                    while !runtime.cancel_flag.load(Ordering::SeqCst) {
                        tokio::task::yield_now().await;
                    }
                    runtime
                        .end_turn(
                            crate::session::DialogTurnState::Cancelled,
                            crate::session::TurnStats::default(),
                        )
                        .await;
                    Err("cancelled".to_string())
                })
            }),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), started.notified())
        .await
        .unwrap();
    let pending_executed = Arc::new(AtomicBool::new(false));
    let pending_for_job = Arc::clone(&pending_executed);
    runtime
        .scheduler
        .enqueue(scheduled_message(
            ScheduledKind::Turn,
            "delete-runtime-pending",
            Box::new(move || {
                let executed = Arc::clone(&pending_for_job);
                Box::pin(async move {
                    executed.store(true, Ordering::SeqCst);
                    Ok(String::new())
                })
            }),
        ))
        .await
        .unwrap();
    state
        .sessions
        .lock()
        .await
        .insert(runtime.id.clone(), Arc::clone(&runtime));
    let plan = runtime_plan("delete-runtime-root", Some("delete-runtime-pending-worker"));
    let safe = stop_agent_org_runtime_sessions_with_timeout(&state, &plan, Duration::from_secs(1))
        .await
        .unwrap();
    assert!(safe.contains("delete-runtime-pending-worker"));
    assert_eq!(runtime.scheduler.pending_count(), 0);
    assert!(!pending_executed.load(Ordering::SeqCst));
    validate_agent_org_delete_ready(&plan, &safe).unwrap();

    let timeout_state = AgentAppState::new();
    let stuck = Arc::new(AgentSession::new(
        "delete-runtime-stuck".to_string(),
        crate::definitions::AgentDefinition::default(),
    ));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_for_job = Arc::clone(&release);
    stuck
        .scheduler
        .enqueue(scheduled_message(
            ScheduledKind::Maintenance,
            "delete-runtime-stuck-job",
            Box::new(move || {
                let release = Arc::clone(&release_for_job);
                Box::pin(async move {
                    release.notified().await;
                    Ok(String::new())
                })
            }),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !stuck.scheduler.is_processing() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    timeout_state
        .sessions
        .lock()
        .await
        .insert(stuck.id.clone(), Arc::clone(&stuck));
    let error = stop_agent_org_runtime_sessions_with_timeout(
        &timeout_state,
        &runtime_plan("delete-runtime-stuck", None),
        Duration::from_millis(50),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Timed out stopping"));
    assert!(timeout_state
        .get_session("delete-runtime-stuck")
        .await
        .is_some());
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(1), async {
        while stuck.scheduler.is_processing() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn session_hierarchy_delete_reasserts_cancel_after_resume_race() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let state = Arc::new(AgentAppState::new());
    let runtime = Arc::new(AgentSession::new(
        "delete-resume-race-root".to_string(),
        crate::definitions::AgentDefinition::default(),
    ));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_for_job = Arc::clone(&release);
    runtime
        .scheduler
        .enqueue(scheduled_message(
            ScheduledKind::Maintenance,
            "delete-resume-race-job",
            Box::new(move || {
                let release = Arc::clone(&release_for_job);
                Box::pin(async move {
                    release.notified().await;
                    Ok(String::new())
                })
            }),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !runtime.scheduler.is_processing() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    state
        .sessions
        .lock()
        .await
        .insert(runtime.id.clone(), Arc::clone(&runtime));
    let state_for_delete = Arc::clone(&state);
    let delete_task = tokio::spawn(async move {
        stop_agent_org_runtime_sessions_with_timeout(
            &state_for_delete,
            &runtime_plan("delete-resume-race-root", None),
            Duration::from_secs(1),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !runtime.cancel_flag.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    // Simulate the post-resume flag clear racing immediately behind the
    // durable fence. The deletion loop must observe and re-assert its reason.
    runtime.cancel_flag.store(false, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(1), async {
        while !runtime.cancel_flag.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    release.notify_one();
    delete_task.await.unwrap().unwrap();
}
