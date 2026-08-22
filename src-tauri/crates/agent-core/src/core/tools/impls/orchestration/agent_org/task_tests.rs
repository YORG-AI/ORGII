use std::sync::Arc;

use serde_json::{json, Value};

use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, TaskStatus};
use crate::tools::impls::orchestration::org_send_message::NoopInboxWakeHook;
use crate::tools::traits::{CallContext, Tool, ToolError};
use test_helpers::test_env;

use super::task_create::TaskCreateTool;
use super::task_graph_create::TaskGraphCreateTool;
use super::task_list_get::{TaskGetTool, TaskListTool};
use super::task_update::TaskUpdateTool;
use super::TaskToolsContext;

const RUN_ID: &str = "run-task-tools";
const ROOT_SESSION: &str = "root-task-tools";
const COORDINATOR_TURN: &str = "turn-coordinator-task-tools";
const ALICE: &str = "m-alice";
const BOB: &str = "m-bob";
const ALICE_SESSION: &str = "session-alice-task-tools";

fn org_context() -> Arc<AgentOrgRunContext> {
    Arc::new(AgentOrgRunContext {
        run_id: RUN_ID.into(),
        org_id: "org-task-tools".into(),
        org_name: "Task Tools Org".into(),
        org_role: "lead".into(),
        coordinator_agent_id: "agent-coordinator".into(),
        coordinator_name: "Coordinator".into(),
        coordinator_role: "lead".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: ALICE.into(),
                name: "Alice".into(),
                role: "builder".into(),
                agent_id: "agent-alice".into(),
            },
            AgentOrgContextMember {
                member_id: BOB.into(),
                name: "Bob".into(),
                role: "reviewer".into(),
                agent_id: "agent-bob".into(),
            },
        ],
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        capability_index: Default::default(),
        root_session_id: Some(ROOT_SESSION.into()),
    })
}

fn tools_context(caller_member_id: &str) -> Arc<TaskToolsContext> {
    let org_context = org_context();
    Arc::new(TaskToolsContext {
        caller_agent_id: org_context
            .require_participant_agent_id(caller_member_id)
            .expect("participant"),
        caller_member_id: caller_member_id.to_string(),
        org_context,
        wake_hook: Arc::new(NoopInboxWakeHook),
    })
}

fn coordinator_call() -> CallContext {
    CallContext::for_turn(
        "call-coordinator",
        ROOT_SESSION,
        COORDINATOR_TURN,
        Vec::new(),
    )
}

fn owner_call(turn_id: &str) -> CallContext {
    CallContext::for_turn("call-owner", ALICE_SESSION, turn_id, Vec::new())
}

fn sandbox() -> test_env::SandboxGuard {
    let sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test sqlite");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    conn.execute_batch(
        "CREATE TABLE code_sessions (
            session_id TEXT PRIMARY KEY,
            cli_agent_type TEXT NOT NULL,
            status TEXT NOT NULL,
            parent_session_id TEXT,
            org_member_id TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE session_turn_intents (
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
    .expect("base Turn schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    let now = chrono::Utc::now().to_rfc3339();
    let snapshot = serde_json::json!({
        "schemaVersion": 1,
        "orgId": "org-task-tools",
        "orgName": "Task Tools Org",
        "coordinatorRole": "lead",
        "coordinatorAgentId": "agent-coordinator",
        "planApprovalPolicy": "coordinator",
        "members": [
            {"memberId": ALICE, "name": "Alice", "role": "builder", "agentId": "agent-alice"},
            {"memberId": BOB, "name": "Bob", "role": "reviewer", "agentId": "agent-bob"}
        ],
        "additionalTaskGraphWriterMemberIds": [],
        "memberCommunicationLinks": [],
    })
    .to_string();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs(
            id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
            entry_mode,status,activation_generation,created_at,updated_at
         ) VALUES (?1,'org-task-tools','agent-coordinator',?2,?3,
                   'standalone_session','running',1,?4,?4)",
        rusqlite::params![RUN_ID, ROOT_SESSION, snapshot, now],
    )
    .expect("running Team");
    insert_coordinator_context(&conn);
    sandbox
}

fn insert_base_turn(conn: &rusqlite::Connection, session_id: &str, turn_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES (?1,?2,?3,'agent_org','running',?4,?4)",
        rusqlite::params![session_id, turn_id, RUN_ID, now],
    )
    .expect("base Turn");
}

fn insert_coordinator_context(conn: &rusqlite::Connection) {
    insert_base_turn(conn, ROOT_SESSION, COORDINATOR_TURN);
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,?2,?3,'coordinator','coordinator','root_turn',?2,1,?4)",
        rusqlite::params![ROOT_SESSION, COORDINATOR_TURN, RUN_ID, now],
    )
    .expect("Coordinator context");
}

fn insert_owner_context(conn: &rusqlite::Connection, turn_id: &str, task_id: &str) {
    insert_base_turn(conn, ALICE_SESSION, turn_id);
    let sequence: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(member_dispatch_sequence),0)+1
             FROM agent_org_runtime_turn_contexts
             WHERE org_run_id=?1 AND dispatch_member_id=?2",
            rusqlite::params![RUN_ID, ALICE],
            |row| row.get(0),
        )
        .unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,?2,?3,?4,'task_execution',?5,?4,?4,?6,
                   'task',?5,1,?7)",
        rusqlite::params![
            ALICE_SESSION,
            turn_id,
            RUN_ID,
            ALICE,
            task_id,
            sequence,
            now
        ],
    )
    .expect("Owner context");
}

async fn create_owned(id: &str, owner: &str) -> Value {
    let result = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID))
        .execute_text(
            json!({
                "id": id,
                "subject": format!("Task {id}"),
                "owner_member_id": owner,
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &coordinator_call(),
        )
        .await
        .expect("create assigned pending Task");
    serde_json::from_str(&result).expect("Task JSON")
}

#[test]
fn task_tool_schemas_expose_pending_create_and_tagged_update() {
    let create = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let create_schema = create.parameters();
    crate::tools::traits::assert_llm_compatible_schema(&create_schema).expect("task_create schema");
    assert!(!create_schema["properties"]
        .as_object()
        .unwrap()
        .contains_key("status"));

    let update = TaskUpdateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let update_schema = update.parameters();
    crate::tools::traits::assert_llm_compatible_schema(&update_schema).expect("task_update schema");
    assert!(update_schema.to_string().contains("operation"));

    let graph = TaskGraphCreateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    crate::tools::traits::assert_llm_compatible_schema(&graph.parameters())
        .expect("task_graph_create schema");
}

#[tokio::test]
async fn task_create_uses_persisted_coordinator_context_and_always_creates_pending() {
    let _sandbox = sandbox();
    let value = create_owned("created", ALICE).await;
    assert_eq!(value["task"]["status"], "pending");
    let stored = AgentOrgTaskStore::get(RUN_ID, "created").unwrap().unwrap();
    assert_eq!(stored.status, TaskStatus::Pending);
    assert_eq!(stored.created_by_participant_id, COORDINATOR_MEMBER_ID);
    assert_eq!(stored.source_turn_intent_id, COORDINATOR_TURN);

    let status_error = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID))
        .execute_text(
            json!({
                "id": "forged-state",
                "subject": "Forged",
                "owner_member_id": ALICE,
                "status": "completed",
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &coordinator_call(),
        )
        .await
        .expect_err("initial status is not writable");
    assert!(matches!(status_error, ToolError::InvalidParams(_)));

    let owner_error = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID))
        .execute_text(
            json!({
                "id": "coordinator-owned",
                "subject": "Forbidden",
                "owner_member_id": "coordinator",
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &coordinator_call(),
        )
        .await
        .expect_err("Coordinator cannot be Owner");
    assert!(owner_error.to_string().contains("formal Task Owner"));
}

#[tokio::test]
async fn task_create_rejects_contextless_or_member_graph_writer_calls() {
    let _sandbox = sandbox();
    let missing = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID))
        .execute_text(
            json!({
                "id": "missing-context",
                "subject": "Missing context",
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &CallContext::default(),
        )
        .await
        .expect_err("Store actor requires persisted context");
    assert!(missing.to_string().contains("context_required"));
    assert!(AgentOrgTaskStore::get(RUN_ID, "missing-context")
        .unwrap()
        .is_none());

    let member = TaskCreateTool::new(tools_context(ALICE))
        .execute_text(
            json!({
                "id": "member-graph",
                "subject": "Member graph",
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build"
            }),
            &owner_call("not-a-context"),
        )
        .await
        .expect("tool returns structured self-correcting authorization guidance");
    let denied: Value = serde_json::from_str(&member).expect("authorization JSON");
    assert_eq!(denied["authorization_denied"], true);
    assert!(denied["guidance"].as_str().unwrap().contains("Coordinator"));
    assert!(AgentOrgTaskStore::get(RUN_ID, "member-graph")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn task_graph_create_is_atomic_and_rejects_cycle_or_coordinator_owner() {
    let _sandbox = sandbox();
    let tool = TaskGraphCreateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let cycle = tool
        .execute_text(
            json!({
                "tasks": [
                    {"key":"a","subject":"A","owner_member_id":ALICE,"execution_mode":"build","depends_on":["b"]},
                    {"key":"b","subject":"B","owner_member_id":BOB,"execution_mode":"build","depends_on":["a"]}
                ]
            }),
            &coordinator_call(),
        )
        .await
        .expect_err("cycle rejects graph");
    assert!(cycle.to_string().contains("cycle"));
    assert!(AgentOrgTaskStore::list(RUN_ID).unwrap().is_empty());

    let bad_owner = tool
        .execute_text(
            json!({
                "tasks": [
                    {"key":"a","subject":"A","owner_member_id":"coordinator","execution_mode":"build"}
                ]
            }),
            &coordinator_call(),
        )
        .await
        .expect_err("Coordinator graph node Owner is forbidden");
    assert!(bad_owner.to_string().contains("formal Task Owner"));

    let created: Value = serde_json::from_str(
        &tool
            .execute_text(
                json!({
                    "tasks": [
                        {"key":"a","subject":"A","owner_member_id":ALICE,"execution_mode":"build"},
                        {"key":"b","subject":"B","owner_member_id":BOB,"execution_mode":"build","depends_on":["a"]}
                    ]
                }),
                &coordinator_call(),
            )
            .await
            .expect("valid graph"),
    )
    .unwrap();
    assert_eq!(created["tasks"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn owner_tagged_operations_follow_task_execution_context() {
    let _sandbox = sandbox();
    create_owned("owned", ALICE).await;
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-owned", "owned");
    let tool = TaskUpdateTool::new(tools_context(ALICE));

    let started: Value = serde_json::from_str(
        &tool
            .execute_text(
                json!({"operation":"start","id":"owned"}),
                &owner_call("turn-owned"),
            )
            .await
            .expect("Owner start"),
    )
    .unwrap();
    assert_eq!(started["task"]["status"], "in_progress");

    tool.execute_text(
        json!({"operation":"append_progress","id":"owned","body":"halfway"}),
        &owner_call("turn-owned"),
    )
    .await
    .expect("Owner progress");

    let completed: Value = serde_json::from_str(
        &tool
            .execute_text(
                json!({
                    "operation":"complete",
                    "id":"owned",
                    "output":{
                        "summary":"done",
                        "content":"full result",
                        "artifact_ids":["artifact-1"]
                    }
                }),
                &owner_call("turn-owned"),
            )
            .await
            .expect("Owner complete"),
    )
    .unwrap();
    assert_eq!(completed["task"]["status"], "completed");
    let stored = AgentOrgTaskStore::get(RUN_ID, "owned").unwrap().unwrap();
    assert_eq!(stored.output.as_ref().unwrap().produced_by_member_id, ALICE);

    let mixed = tool
        .execute_text(
            json!({"operation":"start","id":"owned","subject":"forged graph field"}),
            &owner_call("turn-owned"),
        )
        .await
        .expect_err("mixed Owner and graph fields are rejected");
    assert!(matches!(mixed, ToolError::InvalidParams(_)));
}

#[tokio::test]
async fn coordinator_cannot_submit_output_and_wrong_turn_cannot_start() {
    let _sandbox = sandbox();
    create_owned("protected", ALICE).await;
    let coordinator = TaskUpdateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let error = coordinator
        .execute_text(
            json!({
                "operation":"complete",
                "id":"protected",
                "output":{"summary":"forged"}
            }),
            &coordinator_call(),
        )
        .await
        .expect_err("Coordinator cannot complete Owner Task");
    assert!(error.to_string().contains("Owner lifecycle"));

    let owner = TaskUpdateTool::new(tools_context(ALICE));
    let error = owner
        .execute_text(
            json!({"operation":"start","id":"protected"}),
            &owner_call("missing-turn"),
        )
        .await
        .expect_err("missing persisted Turn context");
    assert!(error.to_string().contains("missing companion context"));
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "protected")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
}

#[tokio::test]
async fn cancel_replace_and_late_callback_use_the_store_gate() {
    let _sandbox = sandbox();
    create_owned("old", ALICE).await;
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-old", "old");
    let owner = TaskUpdateTool::new(tools_context(ALICE));
    owner
        .execute_text(
            json!({"operation":"start","id":"old"}),
            &owner_call("turn-old"),
        )
        .await
        .unwrap();

    let coordinator = TaskUpdateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let replaced: Value = serde_json::from_str(
        &coordinator
            .execute_text(
                json!({
                    "operation":"cancel_and_replace",
                    "id":"old",
                    "reason":{"code":"scope.changed","message":"new goal"},
                    "replacement":{
                        "id":"replacement",
                        "subject":"Replacement",
                        "owner_member_id":BOB,
                        "execution_mode":"build",
                        "eligible_member_ids":[BOB]
                    }
                }),
                &coordinator_call(),
            )
            .await
            .expect("cancel and replace"),
    )
    .unwrap();
    assert_eq!(replaced["task"]["status"], "cancelled");
    assert_eq!(replaced["replacement"]["status"], "pending");

    let late = owner
        .execute_text(
            json!({
                "operation":"complete",
                "id":"old",
                "output":{"summary":"late"}
            }),
            &owner_call("turn-old"),
        )
        .await
        .expect_err("late callback rejected");
    assert!(late.to_string().contains("requires_in_progress"));
}

#[tokio::test]
async fn task_list_and_get_cover_five_states_without_loading_detail_in_pages() {
    let _sandbox = sandbox();
    create_owned("pending", BOB).await;
    create_owned("completed", ALICE).await;
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-complete", "completed");
    let owner = TaskUpdateTool::new(tools_context(ALICE));
    owner
        .execute_text(
            json!({"operation":"start","id":"completed"}),
            &owner_call("turn-complete"),
        )
        .await
        .unwrap();
    owner
        .execute_text(
            json!({
                "operation":"complete",
                "id":"completed",
                "output":{"summary":"summary","content":"detail"}
            }),
            &owner_call("turn-complete"),
        )
        .await
        .unwrap();

    let list = TaskListTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let history: Value = serde_json::from_str(
        &list
            .execute_text(
                json!({"status":"completed","limit":50}),
                &coordinator_call(),
            )
            .await
            .expect("completed list"),
    )
    .unwrap();
    assert_eq!(history["tasks"][0]["status"], "completed");
    assert_eq!(history["tasks"][0]["output"]["summary"], "summary");
    assert!(history["tasks"][0]["output"].get("content").is_none());

    let detail: Value = serde_json::from_str(
        &TaskGetTool::new(tools_context(COORDINATOR_MEMBER_ID))
            .execute_text(json!({"id":"completed"}), &coordinator_call())
            .await
            .expect("Task detail"),
    )
    .unwrap();
    assert_eq!(detail["task"]["output"]["content"], "detail");

    for status in ["pending", "in_progress", "completed", "failed", "cancelled"] {
        let parsed = crate::coordination::agent_org_tasks::TaskStatus::from_wire(status)
            .expect("all formal statuses parse");
        assert_eq!(parsed.as_wire(), status);
    }
}
