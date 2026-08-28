use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, TaskStatus};
use crate::tools::impls::orchestration::org_send_message::NoopInboxWakeHook;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::{CallContext, Tool, ToolError};
use test_helpers::test_env;

use super::run_complete::OrgRunCompleteTool;
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
        app_state: None,
    })
}

fn writer_tools_context(caller_member_id: &str) -> Arc<TaskToolsContext> {
    let mut context = (*org_context()).clone();
    let snapshot = crate::definitions::orgs::AgentOrgLaunchSnapshot {
        schema_version: 1,
        org_id: "org-task-tools".into(),
        org_name: "Task Tools Org".into(),
        coordinator_role: "lead".into(),
        coordinator_agent_id: "agent-coordinator".into(),
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        members: vec![
            crate::definitions::orgs::FlatOrgMember {
                member_id: ALICE.into(),
                name: "Alice".into(),
                role: "builder".into(),
                agent_id: "agent-alice".into(),
                runtime_config: None,
            },
            crate::definitions::orgs::FlatOrgMember {
                member_id: BOB.into(),
                name: "Bob".into(),
                role: "reviewer".into(),
                agent_id: "agent-bob".into(),
                runtime_config: None,
            },
        ],
        additional_task_graph_writer_member_ids: vec![ALICE.into()],
        member_communication_links: Vec::new(),
    };
    context.capability_index =
        crate::definitions::orgs::AgentOrgCapabilityIndex::from_snapshot(&snapshot);
    Arc::new(TaskToolsContext {
        caller_agent_id: context
            .require_participant_agent_id(caller_member_id)
            .expect("participant"),
        caller_member_id: caller_member_id.to_string(),
        org_context: Arc::new(context),
        wake_hook: Arc::new(NoopInboxWakeHook),
        app_state: None,
    })
}

fn coordinator_call() -> CallContext {
    coordinator_call_with_id(format!("call-coordinator-{}", next_call_sequence()))
}

fn coordinator_call_with_id(call_id: impl Into<String>) -> CallContext {
    CallContext::for_turn(call_id, ROOT_SESSION, COORDINATOR_TURN, Vec::new()).with_authority(
        crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
            crate::tools::call_context::AgentOrgTurnToolProfile::CoordinatorOrchestration,
        ),
    )
}

fn owner_call(turn_id: &str) -> CallContext {
    CallContext::for_turn(
        format!("call-owner-{}", next_call_sequence()),
        ALICE_SESSION,
        turn_id,
        Vec::new(),
    )
    .with_authority(
        crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
            crate::tools::call_context::AgentOrgTurnToolProfile::TaskExecution,
        ),
    )
}

fn next_call_sequence() -> u64 {
    static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
    NEXT_CALL.fetch_add(1, Ordering::Relaxed)
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
    for (session_id, member_id, agent_id, parent_session_id) in [
        (
            ROOT_SESSION,
            COORDINATOR_MEMBER_ID,
            "agent-coordinator",
            None,
        ),
        (ALICE_SESSION, ALICE, "agent-alice", Some(ROOT_SESSION)),
    ] {
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: session_id.to_string(),
                name: member_id.to_string(),
                status: "running".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                session_type: "sde".to_string(),
                org_member_id: Some(member_id.to_string()),
                agent_definition_id: Some(agent_id.to_string()),
                parent_session_id: parent_session_id.map(str::to_string),
                ..Default::default()
            },
        )
        .expect("participant Session");
        conn.execute(
            "INSERT INTO agent_org_runtime_member_materializations (
                 org_run_id,member_id,agent_id,generation,session_id,
                 authority_class,status,created_at,updated_at
             ) VALUES (?1,?2,?3,1,?4,'formal','succeeded',?5,?5)",
            rusqlite::params![RUN_ID, member_id, agent_id, session_id, &now],
        )
        .expect("participant materialization");
    }
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

fn strict_provider_task_update_payload(operation: &str, id: &str) -> Value {
    json!({
        "operation": operation,
        "id": id,
        "subject": null,
        "description": "",
        "active_form": " \t ",
        "clear_active_form": false,
        "owner_member_id": "",
        "clear_owner": false,
        "execution_mode": "",
        "blocked_by": [],
        "metadata": {},
        "eligible_member_ids": [],
        "required_role": "\n",
        "body": "",
        "output": {
            "summary": "",
            "content": "  ",
            "artifact_ids": []
        },
        "reason": {
            "code": "",
            "message": " \n"
        },
        "replacement": {
            "id": "",
            "subject": " ",
            "description": null,
            "active_form": "",
            "owner_member_id": "\t",
            "execution_mode": "",
            "blocked_by": [],
            "metadata": {},
            "eligible_member_ids": [],
            "required_role": ""
        }
    })
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
    assert!(update_schema.to_string().contains("patch_pending"));
    assert!(!update_schema.to_string().contains("\"start\""));
    assert!(update_schema["properties"].get("active_form").is_some());
    assert!(update_schema["properties"].get("output").is_some());

    let owner_update = TaskUpdateTool::new(tools_context(ALICE));
    let owner_update_schema = owner_update.parameters();
    crate::tools::traits::assert_llm_compatible_schema(&owner_update_schema)
        .expect("Owner task_update schema");
    assert!(owner_update_schema.to_string().contains("\"start\""));
    assert!(!owner_update_schema.to_string().contains("patch_pending"));
    assert!(owner_update_schema["properties"]
        .get("active_form")
        .is_some());
    assert!(owner_update_schema["properties"].get("output").is_some());
    let owner_wire =
        crate::providers::responses_common::convert_tools(Some(&[owner_update.to_schema()]))
            .expect("Responses tool conversion");
    let owner_wire_params = &owner_wire[0]["parameters"];
    assert!(owner_wire_params["properties"].get("active_form").is_some());
    assert!(owner_wire_params["properties"].get("output").is_some());
    assert!(owner_wire_params["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "output"));

    let graph = TaskGraphCreateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    crate::tools::traits::assert_llm_compatible_schema(&graph.parameters())
        .expect("task_graph_create schema");
}

#[tokio::test]
async fn completion_request_replays_without_rewriting_progress() {
    let _sandbox = sandbox();
    let conn = database::db::get_connection().expect("test sqlite");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_run_progress (org_run_id,updated_at)
         VALUES (?1,?2)",
        rusqlite::params![RUN_ID, &now],
    )
    .expect("completion progress fixture");
    conn.execute(
        "UPDATE agent_org_runtime_turn_contexts
         SET coordinator_work_revision=0
         WHERE session_id=?1 AND turn_intent_id=?2",
        rusqlite::params![ROOT_SESSION, COORDINATOR_TURN],
    )
    .expect("presented completion revision");
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks (
            id,org_run_id,activation_generation,subject,description,status,owner,
            execution_mode,blocked_by_json,output_json,created_by_participant_id,
            source_turn_intent_id,created_at,updated_at
         ) VALUES ('completion-task',?1,1,'Completed work','','completed',?3,'build','[]',
                   ?2,'coordinator',?4,?5,?5)",
        rusqlite::params![
            RUN_ID,
            serde_json::json!({
                "summary": "Completed work",
                "content": null,
                "artifactIds": [],
                "producedByMemberId": ALICE,
                "producedAt": &now,
            })
            .to_string(),
            ALICE,
            COORDINATOR_TURN,
            &now,
        ],
    )
    .expect("output-backed completion Task");
    crate::coordination::agent_org_work_episodes::associate_task_in_tx(
        &conn,
        RUN_ID,
        "completion-task",
        1,
        COORDINATOR_TURN,
    )
    .expect("completion Task work episode");
    let tool = OrgRunCompleteTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let call = coordinator_call_with_id("completion-call");
    let request = json!({
        "candidate_outcome":"delivered",
        "summary":"The requested work is complete"
    });
    let first = tool
        .execute_text(request.clone(), &call)
        .await
        .expect("completion request records");
    let progress_before = crate::coordination::agent_org_runs::AgentOrgRunStore::progress(RUN_ID)
        .unwrap()
        .unwrap();
    let replay = tool
        .execute_text(request, &call)
        .await
        .expect("same completion request replays");
    let progress_after = crate::coordination::agent_org_runs::AgentOrgRunStore::progress(RUN_ID)
        .unwrap()
        .unwrap();
    assert_eq!(replay, first);
    assert_eq!(progress_after, progress_before);
}

#[tokio::test]
async fn configured_writer_uses_one_schema_for_graph_and_owned_lifecycle_authority() {
    let _sandbox = sandbox();
    let conn = database::db::get_connection().expect("test sqlite");
    let mut snapshot: Value = serde_json::from_str(
        &conn
            .query_row(
                "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id=?1",
                [RUN_ID],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    snapshot["additionalTaskGraphWriterMemberIds"] = json!([ALICE]);
    conn.execute(
        "UPDATE agent_org_runtime_runs SET org_snapshot_json=?2 WHERE id=?1",
        rusqlite::params![RUN_ID, serde_json::to_string(&snapshot).unwrap()],
    )
    .unwrap();

    let authority = create_owned("writer-authority", ALICE).await;
    let authority_id = authority["task"]["id"].as_str().unwrap().to_string();
    let target = create_owned("writer-target", BOB).await;
    let target_id = target["task"]["id"].as_str().unwrap().to_string();
    let writer_turn = "turn-configured-writer";
    insert_owner_context(&conn, writer_turn, &authority_id);

    let writer = TaskUpdateTool::new(writer_tools_context(ALICE));
    let schema = writer.parameters().to_string();
    assert!(schema.contains("patch_pending"));
    assert!(schema.contains("\"start\""));

    writer
        .execute_text(
            json!({
                "operation": "patch_pending",
                "id": target_id,
                "description": "Edited by the configured Writer"
            }),
            &owner_call(writer_turn),
        )
        .await
        .expect("configured Writer can patch shared graph work");
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &target_id)
            .unwrap()
            .unwrap()
            .description,
        "Edited by the configured Writer"
    );

    writer
        .execute_text(
            json!({"operation":"start","id":authority_id}),
            &owner_call(writer_turn),
        )
        .await
        .expect("configured Writer keeps Owner authority for its exact execution Task");
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &authority_id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[tokio::test]
async fn task_create_uses_persisted_coordinator_context_and_always_creates_pending() {
    let _sandbox = sandbox();
    let value = create_owned("created", ALICE).await;
    assert_eq!(value["task"]["status"], "pending");
    let task_id = value["task"]["id"].as_str().unwrap();
    let stored = AgentOrgTaskStore::get(RUN_ID, task_id).unwrap().unwrap();
    assert_eq!(stored.status, TaskStatus::Pending);
    assert_eq!(stored.created_by_participant_id, COORDINATOR_MEMBER_ID);
    assert_eq!(stored.source_turn_intent_id, COORDINATOR_TURN);

    let status_error = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID))
        .execute_text(
            json!({
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
async fn idle_first_task_activates_once_and_replay_stays_read_only_after_archive() {
    let _sandbox = sandbox();
    let conn = database::db::get_connection().expect("test sqlite");
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='idle',idled_at=?2,last_activity_outcome='completed'
         WHERE id=?1",
        rusqlite::params![RUN_ID, chrono::Utc::now().to_rfc3339()],
    )
    .expect("idle Team");

    let tool = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let call = coordinator_call_with_id("idle-first-task-call");
    let request = json!({
        "subject": "First work after Idle",
        "owner_member_id": ALICE,
        "dispatch_policy": "immediate",
        "execution_mode": "build"
    });
    let first = tool
        .execute_text(request.clone(), &call)
        .await
        .expect("Idle first work activates and creates");
    let first_value: Value = serde_json::from_str(&first).unwrap();
    let first_task_id = first_value["task"]["id"].as_str().unwrap().to_string();
    let activated = crate::coordination::agent_org_runs::AgentOrgRunStore::load(RUN_ID)
        .unwrap()
        .unwrap();
    assert_eq!(
        activated.status,
        crate::coordination::agent_org_runs::AgentOrgRunStatus::Running
    );
    assert_eq!(activated.activation_generation, 2);
    let marker_generation: i64 = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_turn_contexts
             WHERE session_id=?1 AND turn_intent_id=?2",
            rusqlite::params![ROOT_SESSION, COORDINATOR_TURN],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker_generation, 2);

    let replay = tool
        .execute_text(request.clone(), &call)
        .await
        .expect("same call replays original result");
    assert_eq!(replay, first);
    assert_eq!(AgentOrgTaskStore::list(RUN_ID).unwrap().len(), 1);

    let expansion_call = coordinator_call_with_id("working-expansion-call");
    tool.execute_text(
        json!({
            "subject": "Independent expansion",
            "owner_member_id": ALICE,
            "dispatch_policy": "immediate",
            "execution_mode": "build",
            "allow_parallel_with_unlisted_open_tasks": true
        }),
        &expansion_call,
    )
    .await
    .expect("Working expansion succeeds");
    assert_eq!(
        crate::coordination::agent_org_runs::AgentOrgRunStore::load(RUN_ID)
            .unwrap()
            .unwrap()
            .activation_generation,
        2,
        "Working expansion must not bump activation generation"
    );

    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='archived',activation_generation=activation_generation+1,
             archived_at=?2,archive_receipt_id='idle-replay-archive'
         WHERE id=?1",
        rusqlite::params![RUN_ID, chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();
    let before = (
        AgentOrgTaskStore::list(RUN_ID).unwrap().len(),
        conn.query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox WHERE org_run_id=?1",
            [RUN_ID],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        conn.query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tool_call_receipts WHERE org_run_id=?1",
            [RUN_ID],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
    );
    let archived_replay = tool
        .execute_text(request.clone(), &call)
        .await
        .expect("committed call remains replayable after archive");
    assert_eq!(archived_replay, first);
    let after = (
        AgentOrgTaskStore::list(RUN_ID).unwrap().len(),
        conn.query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox WHERE org_run_id=?1",
            [RUN_ID],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        conn.query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tool_call_receipts WHERE org_run_id=?1",
            [RUN_ID],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
    );
    assert_eq!(after, before);
    assert!(AgentOrgTaskStore::get(RUN_ID, &first_task_id)
        .unwrap()
        .is_some());

    let conflict = tool
        .execute_text(
            json!({
                "subject": "Changed request under same provider call id",
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build"
            }),
            &call,
        )
        .await
        .expect_err("same key with different request conflicts");
    assert!(conflict
        .to_string()
        .contains("agent_org_tool_call_receipt_conflict"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_idle_task_creates_share_one_activation_generation() {
    let _sandbox = sandbox();
    let conn = database::db::get_connection().expect("test sqlite");
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='idle',idled_at=?2,last_activity_outcome='completed'
         WHERE id=?1",
        rusqlite::params![RUN_ID, chrono::Utc::now().to_rfc3339()],
    )
    .expect("idle Team");

    let context = tools_context(COORDINATOR_MEMBER_ID);
    let first_tool = TaskCreateTool::new(Arc::clone(&context));
    let second_tool = TaskCreateTool::new(context);
    let first_call = coordinator_call_with_id("idle-concurrent-call-a");
    let second_call = coordinator_call_with_id("idle-concurrent-call-b");
    let first_request = json!({
        "subject": "Concurrent branch A",
        "owner_member_id": ALICE,
        "dispatch_policy": "immediate",
        "execution_mode": "build",
        "allow_parallel_with_unlisted_open_tasks": true
    });
    let second_request = json!({
        "subject": "Concurrent branch B",
        "owner_member_id": BOB,
        "dispatch_policy": "immediate",
        "execution_mode": "build",
        "allow_parallel_with_unlisted_open_tasks": true
    });

    let (first, second) = tokio::join!(
        first_tool.execute_text(first_request, &first_call),
        second_tool.execute_text(second_request, &second_call)
    );
    first.expect("first concurrent create");
    second.expect("second concurrent create");

    let run = crate::coordination::agent_org_runs::AgentOrgRunStore::load(RUN_ID)
        .unwrap()
        .unwrap();
    assert_eq!(run.activation_generation, 2);
    assert_eq!(AgentOrgTaskStore::list(RUN_ID).unwrap().len(), 2);
    let marker_generation: i64 = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_turn_contexts
             WHERE session_id=?1 AND turn_intent_id=?2",
            rusqlite::params![ROOT_SESSION, COORDINATOR_TURN],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker_generation, 2);
}

#[tokio::test]
async fn paused_first_task_is_rejected_without_task_or_receipt() {
    let _sandbox = sandbox();
    let conn = database::db::get_connection().expect("test sqlite");
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='paused',activation_generation=2,updated_at=?2
         WHERE id=?1",
        rusqlite::params![RUN_ID, chrono::Utc::now().to_rfc3339()],
    )
    .expect("pause Team fixture");
    let tool = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let call = coordinator_call_with_id("paused-first-task-call");

    let error = tool
        .execute_text(
            json!({
                "subject": "Must wait for Resume",
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build"
            }),
            &call,
        )
        .await
        .expect_err("Paused Team rejects new work");
    assert!(error.to_string().contains("team_paused_resume_required"));
    assert!(AgentOrgTaskStore::list(RUN_ID).unwrap().is_empty());
    let receipt_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tool_call_receipts
             WHERE org_run_id=?1 AND call_id=?2",
            rusqlite::params![RUN_ID, &call.call_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipt_count, 0);
}

#[tokio::test]
async fn task_create_rejects_contextless_or_member_graph_writer_calls() {
    let _sandbox = sandbox();
    let missing = TaskCreateTool::new(tools_context(COORDINATOR_MEMBER_ID))
        .execute_text(
            json!({
                "subject": "Missing context",
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &CallContext::default(),
        )
        .await
        .expect_err("unknown direct Tool authority must fail before Store access");
    assert!(missing
        .to_string()
        .contains("tool_authority_denied:task_create"));
    assert!(AgentOrgTaskStore::list(RUN_ID).unwrap().is_empty());

    let member = TaskCreateTool::new(tools_context(ALICE))
        .execute_text(
            json!({
                "subject": "Member graph",
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build"
            }),
            &owner_call("not-a-context"),
        )
        .await
        .expect_err("TaskExecution authority cannot be reused as Writer authority");
    assert!(member
        .to_string()
        .contains("tool_authority_denied:task_create"));
    assert!(AgentOrgTaskStore::list(RUN_ID).unwrap().is_empty());
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
    let created = create_owned("owned", ALICE).await;
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-owned", &task_id);
    let tool = TaskUpdateTool::new(tools_context(ALICE));

    let started: Value = serde_json::from_str(
        &tool
            .execute_text(
                json!({"operation":"start","id":task_id}),
                &owner_call("turn-owned"),
            )
            .await
            .expect("Owner start"),
    )
    .unwrap();
    assert_eq!(started["task"]["status"], "in_progress");

    tool.execute_text(
        json!({"operation":"append_progress","id":task_id,"body":"halfway"}),
        &owner_call("turn-owned"),
    )
    .await
    .expect("Owner progress");

    let completed: Value = serde_json::from_str(
        &tool
            .execute_text(
                json!({
                    "operation":"complete",
                    "id":task_id,
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
    let stored = AgentOrgTaskStore::get(RUN_ID, &task_id).unwrap().unwrap();
    assert_eq!(stored.output.as_ref().unwrap().produced_by_member_id, ALICE);

    let mixed: Value = serde_json::from_str(
        &tool
            .execute_text(
                json!({"operation":"start","id":task_id,"subject":"forged graph field"}),
                &owner_call("turn-owned"),
            )
            .await
            .expect("recoverable mixed-operation misuse returns guidance"),
    )
    .expect("correction JSON");
    assert_eq!(mixed["needs_correction"], true);
    assert_eq!(mixed["unexpected_fields"], json!(["subject"]));
    assert_eq!(mixed["allowed_fields"], json!(["operation", "id"]));
}

#[tokio::test]
async fn owner_task_update_schema_and_parser_handle_real_strict_provider_payloads() {
    let _sandbox = sandbox();
    let created = create_owned("portable", ALICE).await;
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-portable", &task_id);

    let mut registry = ToolRegistry::new();
    registry.register(Box::new(TaskUpdateTool::new(tools_context(ALICE))));
    let correction = registry
        .execute(
            "task_update",
            json!({
                "active_form": "Reading AGENTS.md",
                "blocked_by": null,
                "body": null,
                "clear_active_form": false,
                "clear_owner": false,
                "description": null,
                "eligible_member_ids": null,
                "execution_mode": null,
                "id": task_id,
                "metadata": null,
                "operation": "start",
                "output": null,
                "owner_member_id": null,
                "reason": null,
                "replacement": null,
                "required_role": null,
                "subject": null
            }),
            &owner_call("turn-portable"),
        )
        .await
        .expect("recoverable provider misuse is a structured tool result");
    let correction: Value = serde_json::from_str(&correction.text).expect("correction JSON");
    assert_eq!(correction["needs_correction"], true);
    assert_eq!(correction["unexpected_fields"], json!(["active_form"]));
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &task_id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );

    let started = registry
        .execute(
            "task_update",
            strict_provider_task_update_payload("start", &task_id),
            &owner_call("turn-portable"),
        )
        .await
        .expect("semantic-empty strict-provider placeholders do not block start");
    let started: Value = serde_json::from_str(&started.text).expect("started task JSON");
    assert_eq!(started["task"]["status"], "in_progress");

    let mut complete_payload = strict_provider_task_update_payload("complete", &task_id);
    complete_payload["output"] = json!({
        "summary": "done",
        "content": "full result",
        "artifact_ids": ["artifact-portable"]
    });
    let completed = registry
        .execute(
            "task_update",
            complete_payload,
            &owner_call("turn-portable"),
        )
        .await
        .expect("strict-provider complete payload is normalized by the real registry path");
    let completed: Value = serde_json::from_str(&completed.text).expect("completed task JSON");
    assert_eq!(completed["task"]["status"], "completed");
    assert_eq!(completed["task"]["output"]["summary"], "done");

    let history = AgentOrgTaskStore::list_history(RUN_ID).expect("Task history");
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].event_type, "created");
    assert_eq!(history[0].previous_status, None);
    assert_eq!(history[0].next_status, Some(TaskStatus::Pending));
    assert_eq!(history[1].event_type, "updated");
    assert_eq!(history[1].previous_status, Some(TaskStatus::Pending));
    assert_eq!(history[1].next_status, Some(TaskStatus::InProgress));
    assert_eq!(history[1].actor_member_id.as_deref(), Some(ALICE));
    assert_eq!(history[2].event_type, "updated");
    assert_eq!(history[2].previous_status, Some(TaskStatus::InProgress));
    assert_eq!(history[2].next_status, Some(TaskStatus::Completed));
    assert_eq!(history[2].actor_member_id.as_deref(), Some(ALICE));
    let history_ids = history
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();

    drop(registry);
    let reconciled = crate::coordination::reconcile_agent_org_turns_after_restart(&conn)
        .expect("restart reconciliation");
    assert_eq!(
        reconciled, 1,
        "the fixture's interrupted Coordinator Turn must be closed on restart"
    );
    let coordinator_status: String = conn
        .query_row(
            "SELECT status FROM session_turn_intents
             WHERE session_id=?1 AND turn_intent_id=?2",
            rusqlite::params![ROOT_SESSION, COORDINATOR_TURN],
            |row| row.get(0),
        )
        .expect("reconciled Coordinator status");
    assert_eq!(coordinator_status, "failed");
    let restarted = AgentOrgTaskStore::get(RUN_ID, &task_id)
        .expect("restart Task read")
        .expect("completed Task persists");
    assert_eq!(restarted.status, TaskStatus::Completed);
    assert_eq!(restarted.output.as_ref().unwrap().summary, "done");
    let restarted_history = AgentOrgTaskStore::list_history(RUN_ID).expect("restart history read");
    assert_eq!(
        restarted_history
            .iter()
            .map(|event| event.id.clone())
            .collect::<Vec<_>>(),
        history_ids,
        "restart reconciliation must not synthesize completion history"
    );
}

#[tokio::test]
async fn create_fail_and_cancel_accept_only_semantic_empty_cross_operation_placeholders() {
    let _sandbox = sandbox();

    let mut create_registry = ToolRegistry::new();
    create_registry.register(Box::new(TaskCreateTool::new(tools_context(
        COORDINATOR_MEMBER_ID,
    ))));
    let created = create_registry
        .execute(
            "task_create",
            json!({
                "subject": "Portable create",
                "description": "",
                "active_form": null,
                "owner_member_id": ALICE,
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "dependency_task_ids": [],
                "allow_parallel_with_unlisted_open_tasks": true,
                "metadata": {},
                "eligible_member_ids": null,
                "required_role": null
            }),
            &coordinator_call(),
        )
        .await
        .expect("task_create keeps its existing strict-provider null contract");
    let created: Value = serde_json::from_str(&created.text).expect("created Task JSON");
    assert_eq!(created["task"]["status"], "pending");

    let fail_created = create_owned("fail-portable", ALICE).await;
    let fail_id = fail_created["task"]["id"].as_str().unwrap().to_string();
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-fail-portable", &fail_id);
    let mut owner_registry = ToolRegistry::new();
    owner_registry.register(Box::new(TaskUpdateTool::new(tools_context(ALICE))));
    owner_registry
        .execute(
            "task_update",
            strict_provider_task_update_payload("start", &fail_id),
            &owner_call("turn-fail-portable"),
        )
        .await
        .expect("start before fail");
    let mut fail_payload = strict_provider_task_update_payload("fail", &fail_id);
    fail_payload["reason"] = json!({
        "code": "verification.failed",
        "message": "deterministic failure"
    });
    let failed = owner_registry
        .execute(
            "task_update",
            fail_payload,
            &owner_call("turn-fail-portable"),
        )
        .await
        .expect("fail accepts empty placeholders from other operations");
    let failed: Value = serde_json::from_str(&failed.text).expect("failed Task JSON");
    assert_eq!(failed["task"]["status"], "failed");

    let cancel_created = create_owned("cancel-portable", ALICE).await;
    let cancel_id = cancel_created["task"]["id"].as_str().unwrap().to_string();
    let mut coordinator_registry = ToolRegistry::new();
    coordinator_registry.register(Box::new(TaskUpdateTool::new(tools_context(
        COORDINATOR_MEMBER_ID,
    ))));
    let mut cancel_payload = strict_provider_task_update_payload("cancel", &cancel_id);
    cancel_payload["reason"] = json!({
        "code": "scope.cancelled",
        "message": "no longer required"
    });
    let cancelled = coordinator_registry
        .execute("task_update", cancel_payload, &coordinator_call())
        .await
        .expect("cancel accepts empty placeholders from other operations");
    let cancelled: Value = serde_json::from_str(&cancelled.text).expect("cancelled Task JSON");
    assert_eq!(cancelled["task"]["status"], "cancelled");
}

#[tokio::test]
async fn task_update_placeholder_normalization_stays_fail_closed() {
    let _sandbox = sandbox();
    let strict_created = create_owned("strict-negative", ALICE).await;
    let strict_id = strict_created["task"]["id"].as_str().unwrap().to_string();
    let cancel_created = create_owned("strict-cancel", ALICE).await;
    let cancel_id = cancel_created["task"]["id"].as_str().unwrap().to_string();
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-strict-negative", &strict_id);

    let mut owner_registry = ToolRegistry::new();
    owner_registry.register(Box::new(TaskUpdateTool::new(tools_context(ALICE))));
    let owner_call = owner_call("turn-strict-negative");

    let mut unknown = strict_provider_task_update_payload("start", &strict_id);
    unknown["unknown_provider_field"] = json!("");
    let unknown = owner_registry
        .execute("task_update", unknown, &owner_call)
        .await
        .expect("unknown empty field returns structured correction");
    let unknown: Value = serde_json::from_str(&unknown.text).expect("unknown-field correction");
    assert_eq!(
        unknown["unexpected_fields"],
        json!(["unknown_provider_field"])
    );

    let wrong_shape = owner_registry
        .execute(
            "task_update",
            json!({"operation":"start", "id":strict_id, "body":{}}),
            &owner_call,
        )
        .await
        .expect("wrong-shaped empty field returns structured correction");
    let wrong_shape: Value =
        serde_json::from_str(&wrong_shape.text).expect("wrong-shape correction");
    assert_eq!(wrong_shape["unexpected_fields"], json!(["body"]));

    let meaningful = owner_registry
        .execute(
            "task_update",
            json!({
                "operation":"start",
                "id":strict_id,
                "body":"real progress",
                "output":{"summary":"forged output"},
                "reason":{"code":"forged", "message":"forged reason"}
            }),
            &owner_call,
        )
        .await
        .expect("meaningful cross-operation fields return structured correction");
    let meaningful: Value =
        serde_json::from_str(&meaningful.text).expect("meaningful-field correction");
    assert_eq!(
        meaningful["unexpected_fields"],
        json!(["body", "output", "reason"])
    );
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &strict_id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
    assert_eq!(
        AgentOrgTaskStore::list_history(RUN_ID)
            .unwrap()
            .iter()
            .filter(|event| event.task_id == strict_id)
            .count(),
        1,
        "rejected payloads must not write Task history"
    );

    owner_registry
        .execute(
            "task_update",
            strict_provider_task_update_payload("start", &strict_id),
            &owner_call,
        )
        .await
        .expect("valid start");
    let missing_output = owner_registry
        .execute(
            "task_update",
            json!({"operation":"complete", "id":strict_id}),
            &owner_call,
        )
        .await
        .expect("missing current-operation field returns structured correction");
    let missing_output: Value =
        serde_json::from_str(&missing_output.text).expect("missing-output correction");
    assert_eq!(missing_output["needs_correction"], true);
    assert!(missing_output["reason"]
        .as_str()
        .unwrap()
        .contains("missing field `output`"));

    let empty_output = owner_registry
        .execute(
            "task_update",
            strict_provider_task_update_payload("complete", &strict_id),
            &owner_call,
        )
        .await
        .expect_err("empty current-operation output remains invalid");
    assert!(empty_output.contains("non-empty summary"));
    let empty_reason = owner_registry
        .execute(
            "task_update",
            strict_provider_task_update_payload("fail", &strict_id),
            &owner_call,
        )
        .await
        .expect_err("empty current-operation reason remains invalid");
    assert!(empty_reason.contains("requires non-empty code and message"));
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &strict_id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
    assert_eq!(
        AgentOrgTaskStore::list_history(RUN_ID)
            .unwrap()
            .iter()
            .filter(|event| event.task_id == strict_id)
            .count(),
        2,
        "invalid terminal calls must not write Task history"
    );

    let mut coordinator_registry = ToolRegistry::new();
    coordinator_registry.register(Box::new(TaskUpdateTool::new(tools_context(
        COORDINATOR_MEMBER_ID,
    ))));
    let cancel_error = coordinator_registry
        .execute(
            "task_update",
            strict_provider_task_update_payload("cancel", &cancel_id),
            &coordinator_call(),
        )
        .await
        .expect_err("empty current-operation cancel reason remains invalid");
    assert!(cancel_error.contains("requires non-empty code and message"));
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &cancel_id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
}

#[tokio::test]
async fn coordinator_cannot_submit_output_and_wrong_turn_cannot_start() {
    let _sandbox = sandbox();
    let created = create_owned("protected", ALICE).await;
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let coordinator = TaskUpdateTool::new(tools_context(COORDINATOR_MEMBER_ID));
    let correction: Value = serde_json::from_str(
        &coordinator
            .execute_text(
                json!({
                    "operation":"complete",
                    "id":task_id,
                    "output":{"summary":"forged"}
                }),
                &coordinator_call(),
            )
            .await
            .expect("role misuse returns correction without mutating the Task"),
    )
    .expect("role correction JSON");
    assert_eq!(correction["needs_correction"], true);
    assert!(correction["reason"]
        .as_str()
        .unwrap()
        .contains("outside this caller's frozen Task authority"));
    assert!(!correction["allowed_operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|operation| operation == "complete"));

    let owner = TaskUpdateTool::new(tools_context(ALICE));
    let error = owner
        .execute_text(
            json!({"operation":"start","id":task_id}),
            &owner_call("missing-turn"),
        )
        .await
        .expect_err("missing persisted Turn context");
    assert!(error
        .to_string()
        .contains("tool_authority_denied:task_update"));
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &task_id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
}

#[tokio::test]
async fn cancel_replace_and_late_callback_use_the_store_gate() {
    let _sandbox = sandbox();
    let created = create_owned("old", ALICE).await;
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-old", &task_id);
    let owner = TaskUpdateTool::new(tools_context(ALICE));
    owner
        .execute_text(
            json!({"operation":"start","id":task_id}),
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
                    "id":task_id,
                    "reason":{"code":"scope.changed","message":"new goal"},
                    "replacement":{
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
                "id":task_id,
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
    let completed = create_owned("completed", ALICE).await;
    let completed_id = completed["task"]["id"].as_str().unwrap().to_string();
    let conn = database::db::get_connection().unwrap();
    insert_owner_context(&conn, "turn-complete", &completed_id);
    let owner = TaskUpdateTool::new(tools_context(ALICE));
    owner
        .execute_text(
            json!({"operation":"start","id":completed_id}),
            &owner_call("turn-complete"),
        )
        .await
        .unwrap();
    owner
        .execute_text(
            json!({
                "operation":"complete",
                "id":completed_id,
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
    assert_eq!(
        history["run_summary"]["completion_candidate"]["state"],
        "blocked"
    );
    assert!(history["run_summary"].get("completion_ready").is_none());
    assert!(history["run_summary"].get("completion_blockers").is_none());
    assert!(history["run_summary"].get("quiescence_decision").is_some());

    let detail: Value = serde_json::from_str(
        &TaskGetTool::new(tools_context(COORDINATOR_MEMBER_ID))
            .execute_text(json!({"id":completed_id}), &coordinator_call())
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
