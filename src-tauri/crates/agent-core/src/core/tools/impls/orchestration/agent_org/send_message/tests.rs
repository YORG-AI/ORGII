//! Unit tests for `org_send_message`: recipient resolution, JSON-schema
//! shape, LLM-description routing/kind hints, and `execute_text`
//! persistence / wake-hook / self-abort-hook behavior.

use super::*;
use crate::coordination::agent_inbox::AgentInboxStore;
use crate::coordination::agent_org_runs::{AgentOrgContextMember, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    new_task_id, AgentOrgTaskStore, CreateTaskParams, TaskGraphWriterAdmin, TaskStatus,
    TASK_METADATA_ELIGIBLE_MEMBER_IDS,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static NEXT_CALL_ID: AtomicU64 = AtomicU64::new(1);

fn call_context(sender_member_id: &str) -> crate::tools::call_context::CallContext {
    let (session_id, turn_intent_id) = if sender_member_id == COORDINATOR_MEMBER_ID {
        ("root-1", "coordinator-turn")
    } else {
        ("builder-session", "builder-turn")
    };
    crate::tools::call_context::CallContext {
        session_id: session_id.to_string(),
        turn_intent_id: turn_intent_id.to_string(),
        call_id: format!("send-call-{}", NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed)),
        ..Default::default()
    }
    .with_authority(
        crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
            if sender_member_id == COORDINATOR_MEMBER_ID {
                crate::tools::call_context::AgentOrgTurnToolProfile::CoordinatorOrchestration
            } else {
                crate::tools::call_context::AgentOrgTurnToolProfile::TaskExecution
            },
        ),
    )
}

fn call_context_with_new_id(
    template: &crate::tools::call_context::CallContext,
) -> crate::tools::call_context::CallContext {
    let mut call = template.clone();
    call.call_id = format!("send-call-{}", NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed));
    call
}

fn context() -> Arc<AgentOrgRunContext> {
    Arc::new(AgentOrgRunContext {
        run_id: "run-1".to_string(),
        org_id: "org-1".to_string(),
        org_name: "Org".to_string(),
        org_role: "lead".to_string(),
        coordinator_agent_id: "agent-coord".to_string(),
        coordinator_name: "Coordinator".to_string(),
        coordinator_role: "lead".to_string(),
        members: vec![
            AgentOrgContextMember {
                member_id: "planner".to_string(),
                name: "Planner".to_string(),
                role: "plan".to_string(),
                agent_id: "agent-shared".to_string(),
            },
            AgentOrgContextMember {
                member_id: "builder".to_string(),
                name: "Builder".to_string(),
                role: "build".to_string(),
                agent_id: "agent-shared".to_string(),
            },
        ],
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        capability_index: Default::default(),
        root_session_id: Some("root-1".to_string()),
    })
}

fn linked_context() -> Arc<AgentOrgRunContext> {
    let snapshot = crate::definitions::orgs::AgentOrgLaunchSnapshot {
        schema_version: 1,
        org_id: "org-1".to_string(),
        org_name: "Org".to_string(),
        coordinator_role: "lead".to_string(),
        coordinator_agent_id: "agent-coord".to_string(),
        members: vec![
            crate::definitions::orgs::FlatOrgMember {
                member_id: "planner".to_string(),
                name: "Planner".to_string(),
                role: "plan".to_string(),
                agent_id: "agent-shared".to_string(),
                runtime_config: None,
            },
            crate::definitions::orgs::FlatOrgMember {
                member_id: "builder".to_string(),
                name: "Builder".to_string(),
                role: "build".to_string(),
                agent_id: "agent-shared".to_string(),
                runtime_config: None,
            },
        ],
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: vec![
            crate::definitions::orgs::MemberCommunicationLink::canonical("builder", "planner"),
        ],
    };
    let mut run_context = (*context()).clone();
    run_context.capability_index =
        crate::definitions::orgs::AgentOrgCapabilityIndex::from_snapshot(&snapshot);
    Arc::new(run_context)
}

fn params(recipient_member_id: &str) -> serde_json::Value {
    json!({
        "recipient_member_id": recipient_member_id,
        "kind": "plain",
        "summary": "hello",
        "text": "hello"
    })
}

fn grant_member_writer_in_frozen_snapshot(conn: &rusqlite::Connection, member_id: &str) {
    let mut snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id='run-1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|json| serde_json::from_str(&json).expect("decode frozen snapshot"))
        .expect("load frozen snapshot");
    snapshot
        .additional_task_graph_writer_member_ids
        .push(member_id.to_string());
    snapshot.additional_task_graph_writer_member_ids.sort();
    snapshot.additional_task_graph_writer_member_ids.dedup();
    conn.execute(
        "UPDATE agent_org_runtime_runs SET org_snapshot_json=?1 WHERE id='run-1'",
        [serde_json::to_string(&snapshot).expect("encode frozen snapshot")],
    )
    .expect("persist frozen writer capability");
}

fn seed_owned_task(owner_member_id: &str) -> String {
    let task_id = new_task_id();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.clone(),
        org_run_id: "run-1".to_string(),
        subject: "Durable formal work".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some(owner_member_id.to_string()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: [owner_member_id],
        })),
    })
    .expect("seed task");
    task_id
}

#[derive(Default, Debug)]
struct RecordingWakeHook {
    calls: Mutex<Vec<(String, String)>>,
    user_directed_calls: Mutex<Vec<UserDirectedWake>>,
}

impl RecordingWakeHook {
    fn snapshot(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }

    fn user_directed_snapshot(&self) -> Vec<UserDirectedWake> {
        self.user_directed_calls.lock().unwrap().clone()
    }
}

impl InboxWakeHook for RecordingWakeHook {
    fn wake_member(&self, member_id: &str, org_run_id: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((member_id.to_string(), org_run_id.to_string()));
    }

    fn wake_user_directed_member(&self, wake: UserDirectedWake) {
        self.user_directed_calls.lock().unwrap().push(wake);
    }
}

#[derive(Default, Debug)]
struct RecordingSelfAbortHook {
    calls: Mutex<Vec<(String, String)>>,
}

impl RecordingSelfAbortHook {
    fn snapshot(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl SelfAbortHook for RecordingSelfAbortHook {
    fn abort_self(&self, sender_member_id: &str, org_run_id: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((sender_member_id.to_string(), org_run_id.to_string()));
    }
}

fn init_inbox_schema() -> test_helpers::test_env::SandboxGuard {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent sessions schema");
    crate::session::persistence::init(&conn).expect("session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS code_sessions (
            session_id TEXT PRIMARY KEY,
            cli_agent_type TEXT NOT NULL,
            status TEXT NOT NULL,
            parent_session_id TEXT,
            org_member_id TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_turn_intents (
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
    .expect("CLI session schema");
    let snapshot = crate::definitions::orgs::AgentOrgLaunchSnapshot {
        schema_version: 1,
        org_id: "org-1".to_string(),
        org_name: "Org".to_string(),
        coordinator_role: "lead".to_string(),
        coordinator_agent_id: "agent-coord".to_string(),
        members: vec![
            crate::definitions::orgs::FlatOrgMember {
                member_id: "planner".to_string(),
                name: "Planner".to_string(),
                role: "plan".to_string(),
                agent_id: "agent-shared".to_string(),
                runtime_config: None,
            },
            crate::definitions::orgs::FlatOrgMember {
                member_id: "builder".to_string(),
                name: "Builder".to_string(),
                role: "build".to_string(),
                agent_id: "agent-shared".to_string(),
                runtime_config: None,
            },
        ],
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs (
             id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
             entry_mode,status,activation_generation,created_at,updated_at
         ) VALUES ('run-1','org-1','agent-coord','root-1',?1,
                   'standalone_session','running',1,?2,?2)",
        rusqlite::params![serde_json::to_string(&snapshot).unwrap(), &now],
    )
    .expect("seed running Agent Org run");
    for (session_id, member_id, agent_id) in [
        ("root-1", COORDINATOR_MEMBER_ID, "agent-coord"),
        ("builder-session", "builder", "agent-shared"),
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
                parent_session_id: (member_id != COORDINATOR_MEMBER_ID)
                    .then(|| "root-1".to_string()),
                ..Default::default()
            },
        )
        .expect("seed Agent Org participant session");
    }
    let authority_task_id = new_task_id();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: authority_task_id.clone(),
        org_run_id: "run-1".to_string(),
        subject: "Builder execution authority".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("builder".to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .expect("seed builder authority Task");
    conn.execute_batch(&format!(
        "INSERT INTO agent_org_runtime_member_materializations (
             org_run_id,member_id,agent_id,generation,session_id,
             authority_class,status,created_at,updated_at
         ) VALUES
             ('run-1','coordinator','agent-coord',1,'root-1','formal','succeeded','{now}','{now}'),
             ('run-1','builder','agent-shared',1,'builder-session','formal','succeeded','{now}','{now}');"
    ))
    .expect("seed canonical materializations");
    conn.execute_batch(&format!(
        "INSERT INTO session_turn_intents (
             session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES
             ('root-1','coordinator-turn','run-1','agent_org','running','{now}','{now}'),
             ('builder-session','builder-turn','run-1','agent_org','running','{now}','{now}');
         INSERT INTO agent_org_runtime_turn_contexts (
             session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
             task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
             source_kind,source_id,root_authority_turn_id,actor_version,
             activation_generation,created_at
         ) VALUES
             ('root-1','coordinator-turn','run-1','coordinator','coordinator',
              NULL,NULL,NULL,NULL,'root_turn','coordinator-turn',NULL,NULL,1,'{now}'),
             ('builder-session','builder-turn','run-1','builder','task_execution',
              '{authority_task_id}','builder','builder',1,'task','{authority_task_id}',NULL,NULL,1,'{now}');"
    ))
    .expect("seed formal Turn contexts");
    sandbox
}

fn upsert_linked_turn_intent(
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
             session_id,turn_intent_id,client_message_id,org_run_id,source,status,
             created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        rusqlite::params![
            session_id,
            turn_intent_id,
            client_message_id,
            org_run_id,
            source.as_str(),
            status.as_str(),
            &now,
        ],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn seed_started_group_udw_with_link() -> crate::tools::call_context::CallContext {
    crate::foundation::session_bridge::register_upsert_turn_intent_with_connection(
        upsert_linked_turn_intent,
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let mut snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id='run-1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|json| serde_json::from_str(&json).expect("decode launch snapshot"))
        .expect("load launch snapshot");
    snapshot.member_communication_links =
        vec![crate::definitions::orgs::MemberCommunicationLink::canonical("builder", "planner")];
    conn.execute(
        "UPDATE agent_org_runtime_runs SET org_snapshot_json=?1 WHERE id='run-1'",
        [serde_json::to_string(&snapshot).expect("encode launch snapshot")],
    )
    .expect("install frozen communication link");
    conn.execute(
        "UPDATE session_turn_intents SET status='completed'
         WHERE session_id='builder-session' AND turn_intent_id='builder-turn'",
        [],
    )
    .expect("finish the earlier formal Turn before starting Group UDW");
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: "planner-session".to_string(),
            name: "planner".to_string(),
            status: "idle".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            session_type: "sde".to_string(),
            org_member_id: Some("planner".to_string()),
            agent_definition_id: Some("agent-shared".to_string()),
            parent_session_id: Some("root-1".to_string()),
            ..Default::default()
        },
    )
    .expect("seed linked Planner session");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations (
             org_run_id,member_id,agent_id,generation,session_id,
             authority_class,status,created_at,updated_at
         ) VALUES ('run-1','planner','agent-shared',1,'planner-session',
                   'formal','succeeded',?1,?1)",
        [&now],
    )
    .expect("seed linked Planner materialization");
    let source = AgentInboxStore::insert_in_tx_without_formal_trigger(
        &conn,
        crate::coordination::agent_inbox::InsertInboxParams {
            recipient_agent_id: "agent-shared".to_string(),
            recipient_member_id: Some("builder".to_string()),
            sender_agent_id: crate::coordination::agent_inbox::USER_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some("run-1".to_string()),
            message: crate::coordination::agent_inbox::AgentMessage::Plain {
                summary: "Group mention".to_string(),
                text: "Check the boundary".to_string(),
            },
        },
    )
    .expect("seed Group source Inbox");
    conn.execute(
        "UPDATE agent_org_runtime_inbox
         SET delivery_class='user_directed',display_text='@Builder Check the boundary'
         WHERE id=?1",
        [source.id],
    )
    .expect("classify Group source");
    conn.execute(
        "INSERT INTO session_turn_intents (
             session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('builder-session','builder-udw-turn','run-1','agent_org','running',?1,?1)",
        [&now],
    )
    .expect("seed UDW intent");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
             session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
             dispatch_member_id,member_dispatch_sequence,source_kind,source_id,
             root_authority_turn_id,actor_version,created_at
         ) VALUES ('builder-session','builder-udw-turn','run-1','builder',
                   'user_directed_work','builder',2,'group_mention',?1,
                   'builder-udw-turn',1,?2)",
        rusqlite::params![source.id.to_string(), &now],
    )
    .expect("seed UDW Turn context");
    let root = crate::coordination::agent_org_user_directed_work::NewUserDirectedDelivery {
        org_run_id: "run-1",
        session_id: "builder-session",
        turn_intent_id: "builder-udw-turn",
        root_authority_turn_id: "builder-udw-turn",
        parent_delivery_id: None,
        parent_inbox_id: None,
        source_kind:
            crate::coordination::agent_org_user_directed_work::UserDirectedSourceKind::GroupMention,
        source_event_id: None,
        source_inbox_id: Some(source.id),
        dispatch_member_id: "builder",
        member_dispatch_sequence: 2,
        depth: 0,
        delivery_ordinal: 1,
        dispatch_content: "Check the boundary",
        display_content: "@Builder Check the boundary",
        images: None,
    };
    crate::coordination::agent_org_user_directed_work::insert_root_delivery_with_connection(
        &conn, &root,
    )
    .expect("seed UDW root receipt");
    assert!(
        crate::coordination::agent_org_user_directed_work::mark_turn_started_with_connection(
            &conn,
            "builder-session",
            "builder-udw-turn",
        )
        .expect("start UDW root")
    );
    crate::tools::call_context::CallContext {
        session_id: "builder-session".to_string(),
        turn_intent_id: "builder-udw-turn".to_string(),
        call_id: format!("send-call-{}", NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed)),
        ..Default::default()
    }
    .with_authority(
        crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
            crate::tools::call_context::AgentOrgTurnToolProfile::UserDirectedWorker,
        ),
    )
}

fn builder_authority_task_id() -> String {
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.query_row(
        "SELECT task_id FROM agent_org_runtime_turn_contexts
         WHERE session_id='builder-session' AND turn_intent_id='builder-turn'",
        [],
        |row| row.get(0),
    )
    .expect("builder TaskExecution task id")
}

fn member_coordination_params(purpose: &str) -> Value {
    let mut input = params(COORDINATOR_MEMBER_ID);
    input["related_task_id"] = json!(builder_authority_task_id());
    input["purpose"] = json!(purpose);
    input
}

#[test]
fn frozen_writer_capability_reaches_task_execution_policy_and_store_authorizer() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    assert_eq!(
        crate::tools::policy::resolve_persisted_agent_org_tool_authority(
            "builder-session",
            "builder-turn",
        )
        .expect("resolve ordinary TaskExecution worker")
        .profile,
        crate::tools::call_context::AgentOrgTurnToolProfile::TaskExecution
    );
    TaskGraphWriterAdmin::new("builder-session", "builder-turn")
        .expect("ordinary worker actor")
        .validate(&conn, "run-1")
        .expect_err("ordinary worker must fail the Task store writer boundary");
    grant_member_writer_in_frozen_snapshot(&conn, "builder");

    let authority = crate::tools::policy::resolve_persisted_agent_org_tool_authority(
        "builder-session",
        "builder-turn",
    )
    .expect("resolve TaskExecution writer from immutable launch snapshot");
    assert_eq!(
        authority.profile,
        crate::tools::call_context::AgentOrgTurnToolProfile::TaskExecutionWriter
    );
    TaskGraphWriterAdmin::new("builder-session", "builder-turn")
        .expect("writer actor")
        .validate(&conn, "run-1")
        .expect("Task store must accept the same frozen writer identity");
}

#[test]
fn frozen_writer_capability_reaches_group_user_directed_policy() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    grant_member_writer_in_frozen_snapshot(&conn, "builder");
    drop(conn);
    let call = seed_started_group_udw_with_link();

    let authority = crate::tools::policy::resolve_persisted_agent_org_tool_authority(
        &call.session_id,
        &call.turn_intent_id,
    )
    .expect("resolve GroupMention writer from immutable launch snapshot");
    assert_eq!(
        authority.profile,
        crate::tools::call_context::AgentOrgTurnToolProfile::UserDirectedWriter
    );
}

#[test]
fn resolves_only_recipient_member_id() {
    let tool = OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
    let recipients = tool
        .resolve_recipient(&OrgSendMessageParams {
            recipient_member_id: Some("builder".to_string()),
            kind: "plain".to_string(),
            summary: Some("hello".to_string()),
            text: Some("hello".to_string()),
            related_task_id: None,
            purpose: None,
            note: None,
            reason: None,
            request_id: None,
            accepted: None,
            feedback: None,
            next_mode: None,
        })
        .expect("builder should be addressable");

    assert_eq!(recipients[0].member_id, "builder");
    assert_eq!(recipients[0].agent_id, "agent-shared");
}

#[test]
fn rejects_unroutable_member_id_with_allowed_ids() {
    let tool = OrgSendMessageTool::new(context(), "builder".to_string());
    let error = tool
        .resolve_recipient(&OrgSendMessageParams {
            recipient_member_id: Some("ghost".to_string()),
            kind: "plain".to_string(),
            summary: Some("hello".to_string()),
            text: Some("hello".to_string()),
            related_task_id: None,
            purpose: None,
            note: None,
            reason: None,
            request_id: None,
            accepted: None,
            feedback: None,
            next_mode: None,
        })
        .expect_err("unknown member id should fail");

    assert!(error.contains("recipient_member_id 'ghost'"), "{error}");
    assert!(error.contains("coordinator"), "{error}");
    assert!(!error.contains("planner"), "{error}");
}

#[test]
fn schema_is_serialized_for_the_exact_message_direction() {
    let member_schema = OrgSendMessageTool::new(context(), "builder".to_string()).parameters();
    let coordinator_schema =
        OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string()).parameters();

    assert_eq!(
        member_schema["properties"]["recipient_member_id"]["type"].as_str(),
        Some("string")
    );
    assert_eq!(
        member_schema["properties"]["kind"]["type"].as_str(),
        Some("string")
    );
    assert_eq!(
        member_schema["properties"]["recipient_member_id"]["enum"],
        json!(["coordinator"])
    );
    assert_eq!(
        member_schema["properties"]["kind"]["enum"],
        json!(["plain", "shutdown_response"])
    );

    assert_eq!(member_schema["properties"]["purpose"]["type"], "string");
    assert_eq!(
        member_schema["properties"]["purpose"]["enum"],
        json!([
            "blocker",
            "decision_required",
            "material_change",
            "risk",
            "requested_reply"
        ])
    );
    assert!(coordinator_schema["properties"].get("purpose").is_none());
    assert_eq!(
        coordinator_schema["properties"]["kind"]["enum"],
        json!(["plain", "shutdown_request", "plan_approval_response"])
    );
    assert!(!member_schema.to_string().contains("$ref"));
    assert!(!coordinator_schema.to_string().contains("$ref"));
}

#[test]
fn llm_description_carries_current_routing_hints() {
    let tool = OrgSendMessageTool::new(context(), "builder".to_string());
    let description = tool.llm_description().expect("description");

    assert!(description.contains("recipient_member_id enum: [coordinator]"));
    assert!(description.contains("routine progress is NOT a message or assistant reply"));
    assert!(description.contains("During UserDirectedWork"));
    assert!(description
        .contains("blocker | decision_required | material_change | risk | requested_reply"));
    assert!(!description.contains("status/escalation messages do not need"));
}

#[test]
fn llm_description_recipient_hints_keep_peer_send_disabled() {
    let coordinator_tool = OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
    let builder_tool = OrgSendMessageTool::new(context(), "builder".to_string());

    assert!(coordinator_tool
        .llm_description()
        .expect("description")
        .contains("recipient_member_id enum: [builder, planner]"));
    assert!(builder_tool
        .llm_description()
        .expect("description")
        .contains("recipient_member_id enum: [coordinator]"));
}

#[tokio::test]
async fn started_udw_can_send_exactly_once_to_a_snapshot_linked_peer() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    grant_member_writer_in_frozen_snapshot(&conn, "planner");
    drop(conn);
    let call = seed_started_group_udw_with_link();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        linked_context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let input = params("planner");
    let first = tool
        .execute_text(input.clone(), &call)
        .await
        .expect("linked peer message");
    let replay = tool
        .execute_text(input, &call)
        .await
        .expect("exact call replay");
    assert_eq!(first, replay);
    let value: serde_json::Value = serde_json::from_str(&first).expect("decode receipt");
    assert_eq!(value["user_directed"], true);
    assert_eq!(value["delivered"][0]["recipient_member_id"], "planner");
    assert_eq!(wake.user_directed_snapshot().len(), 1);
    let child_turn_intent_id = value["delivered"][0]["turn_intent_id"]
        .as_str()
        .expect("child Turn id");
    let causal = crate::coordination::agent_org_user_directed_work::causal_reply_for_turn(
        "planner-session",
        child_turn_intent_id,
    )
    .expect("load child causal reply")
    .expect("child causal reply exists");
    assert_eq!(causal.source_kind, "member_inbox");
    assert_eq!(causal.root_authority_turn_id, "builder-udw-turn");
    assert_eq!(causal.depth, 1);
    assert_eq!(causal.delivery_ordinal, 2);
    assert_eq!(
        crate::tools::policy::resolve_persisted_agent_org_tool_authority(
            "planner-session",
            child_turn_intent_id,
        )
        .expect("resolve MemberInbox writer from immutable launch snapshot")
        .profile,
        crate::tools::call_context::AgentOrgTurnToolProfile::UserDirectedWriter,
    );

    let mut changed = params("planner");
    changed["text"] = json!("changed after the same call_id");
    let conflict = tool
        .execute_text(changed, &call)
        .await
        .expect_err("same call_id with changed content must conflict");
    assert!(
        conflict
            .to_string()
            .contains("agent_org_tool_call_receipt_conflict"),
        "{conflict}"
    );
    assert_eq!(wake.user_directed_snapshot().len(), 1);

    let conn = database::db::get_connection().expect("test sqlite connection");
    let (child_count, child_parent, child_source, child_depth): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),MIN(parent_delivery_id),MIN(source_inbox_id),MIN(depth)
             FROM agent_org_runtime_user_directed_deliveries
             WHERE source_kind='member_inbox' AND dispatch_member_id='planner'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("load linked child receipt");
    assert_eq!(child_count, 1);
    assert!(child_parent > 0);
    assert!(child_source > 0);
    assert_eq!(child_depth, 1);
}

#[tokio::test]
async fn udw_link_is_revalidated_from_the_persisted_snapshot_in_the_write_transaction() {
    let _sandbox = init_inbox_schema();
    let call = seed_started_group_udw_with_link();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        linked_context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let mut snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id='run-1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|json| serde_json::from_str(&json).expect("decode launch snapshot"))
        .expect("load launch snapshot");
    snapshot.member_communication_links.clear();
    conn.execute(
        "UPDATE agent_org_runtime_runs SET org_snapshot_json=?1 WHERE id='run-1'",
        [serde_json::to_string(&snapshot).expect("encode launch snapshot")],
    )
    .expect("remove persisted link after tool assembly");
    let before = AgentInboxStore::count_by_run("run-1").expect("Inbox count");

    let error = tool
        .execute_text(params("planner"), &call)
        .await
        .expect_err("stale in-memory link must not authorize a write");
    assert!(
        error.to_string().contains("linked_inbox_link_denied"),
        "{error}"
    );
    assert_eq!(
        AgentInboxStore::count_by_run("run-1").expect("Inbox count after rejection"),
        before
    );
    assert!(wake.user_directed_snapshot().is_empty());
}

#[tokio::test]
async fn udw_rejects_self_unknown_depth_and_delivery_budget_without_writes() {
    let _sandbox = init_inbox_schema();
    let call = seed_started_group_udw_with_link();
    let tool = OrgSendMessageTool::new(linked_context(), "builder".to_string());
    let before = AgentInboxStore::count_by_run("run-1").expect("Inbox count");
    let self_error = tool
        .execute_text(params("builder"), &call)
        .await
        .expect_err("self-send must fail");
    assert!(self_error.to_string().contains("linked_inbox_self_send"));
    let unknown_error = tool
        .execute_text(params("removed-member"), &call)
        .await
        .expect_err("unknown target must fail");
    assert!(unknown_error.to_string().contains("not addressable"));

    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runtime_user_directed_roots
         SET max_cascade_depth=0 WHERE root_authority_turn_id='builder-udw-turn'",
        [],
    )
    .expect("freeze zero depth fixture");
    let depth_error = tool
        .execute_text(params("planner"), &call_context_with_new_id(&call))
        .await
        .expect_err("root depth limit must fail");
    assert!(
        depth_error.to_string().contains("linked_inbox_depth_limit"),
        "{depth_error}"
    );
    conn.execute(
        "UPDATE agent_org_runtime_user_directed_roots
         SET max_cascade_depth=2,next_delivery_ordinal=max_deliveries+2
         WHERE root_authority_turn_id='builder-udw-turn'",
        [],
    )
    .expect("exhaust root delivery fixture");
    let delivery_error = tool
        .execute_text(params("planner"), &call_context_with_new_id(&call))
        .await
        .expect_err("root delivery budget must fail");
    assert!(
        delivery_error
            .to_string()
            .contains("linked_inbox_delivery_limit"),
        "{delivery_error}"
    );
    assert_eq!(
        AgentInboxStore::count_by_run("run-1").expect("Inbox count after rejects"),
        before
    );
}

#[tokio::test]
async fn udw_coordinator_side_quest_uses_root_binding_without_formal_work() {
    let _sandbox = init_inbox_schema();
    let call = seed_started_group_udw_with_link();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        linked_context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let before_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tasks WHERE org_run_id='run-1'",
            [],
            |row| row.get(0),
        )
        .expect("task snapshot");
    let result = tool
        .execute_text(params(COORDINATOR_MEMBER_ID), &call)
        .await
        .expect("Coordinator side quest");
    let value: serde_json::Value = serde_json::from_str(&result).expect("decode receipt");
    assert_eq!(
        value["delivered"][0]["recipient_member_id"],
        COORDINATOR_MEMBER_ID
    );
    let wakes = wake.user_directed_snapshot();
    assert_eq!(wakes.len(), 1);
    assert_eq!(wakes[0].recipient_session_id, "root-1");

    let (binding_count, formal_count, context_kind, source_kind, activation_generation): (
        i64,
        i64,
        String,
        String,
        Option<i64>,
    ) = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*)
                 FROM agent_org_runtime_user_directed_coordinator_bindings),
                (SELECT COUNT(*)
                 FROM agent_org_runtime_formal_trigger_receipts receipt
                 JOIN agent_org_runtime_inbox inbox ON inbox.id=receipt.inbox_id
                 WHERE inbox.delivery_class='user_directed'),
                (SELECT context.turn_kind
                 FROM agent_org_runtime_turn_contexts context
                 JOIN agent_org_runtime_user_directed_coordinator_bindings binding
                   ON binding.session_id=context.session_id
                  AND binding.turn_intent_id=context.turn_intent_id
                 LIMIT 1),
                (SELECT context.source_kind
                 FROM agent_org_runtime_turn_contexts context
                 JOIN agent_org_runtime_user_directed_coordinator_bindings binding
                   ON binding.session_id=context.session_id
                  AND binding.turn_intent_id=context.turn_intent_id
                 LIMIT 1),
                (SELECT context.activation_generation
                 FROM agent_org_runtime_turn_contexts context
                 JOIN agent_org_runtime_user_directed_coordinator_bindings binding
                   ON binding.session_id=context.session_id
                  AND binding.turn_intent_id=context.turn_intent_id
                 LIMIT 1)",
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
        .expect("load Coordinator side-quest authority");
    assert_eq!(binding_count, 1);
    assert_eq!(formal_count, 0);
    assert_eq!(context_kind, "coordinator");
    assert_eq!(source_kind, "member_inbox");
    assert_eq!(activation_generation, None);
    assert_eq!(
        crate::tools::policy::resolve_persisted_agent_org_tool_authority(
            "root-1",
            &wakes[0].turn_intent_id,
        )
        .expect("Working Coordinator side quest policy")
        .profile,
        crate::tools::call_context::AgentOrgTurnToolProfile::CoordinatorOrchestration,
    );
    TaskGraphWriterAdmin::new("root-1", &wakes[0].turn_intent_id)
        .expect("Coordinator side-quest actor identity")
        .validate(&conn, "run-1")
        .expect("Working Coordinator side quest may use canonical graph authority");
    let formal_staging_error =
        crate::coordination::agent_org_runs::AgentOrgRunStore::stage_coordinator_work_revision_and_load_tasks(
            "run-1",
            "root-1",
            &wakes[0].turn_intent_id,
            &[],
        )
        .expect_err("Coordinator side quest must not stage formal work freshness");
    assert!(
        formal_staging_error.contains("Coordinator freshness authority mismatch"),
        "{formal_staging_error}"
    );
    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='idle' WHERE id='run-1'",
        [],
    )
    .expect("idle Team around the same durable side quest");
    assert!(
        crate::coordination::agent_org_runs::AgentOrgRunStore::activate_idle_for_task_graph_in_tx(
            &conn,
            "run-1",
            "root-1",
            &wakes[0].turn_intent_id,
        )
        .expect("Idle Coordinator side quest may atomically activate formal work")
    );
    let (idle_activation_status, idle_activation_generation): (String, Option<i64>) = conn
        .query_row(
            "SELECT run.status,context.activation_generation
             FROM agent_org_runtime_runs run
             JOIN agent_org_runtime_turn_contexts context ON context.org_run_id=run.id
             WHERE run.id='run-1' AND context.session_id='root-1'
               AND context.turn_intent_id=?1",
            [&wakes[0].turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read Idle side-quest activation");
    assert_eq!(idle_activation_status, "running");
    assert_eq!(idle_activation_generation, None);
    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='paused' WHERE id='run-1'",
        [],
    )
    .expect("pause Team around the same durable side quest");
    assert_eq!(
        crate::tools::policy::resolve_persisted_agent_org_tool_authority(
            "root-1",
            &wakes[0].turn_intent_id,
        )
        .expect("Paused Coordinator side quest policy")
        .profile,
        crate::tools::call_context::AgentOrgTurnToolProfile::SummaryOnly,
    );
    let paused_graph_error = TaskGraphWriterAdmin::new("root-1", &wakes[0].turn_intent_id)
        .expect("Coordinator side-quest actor identity")
        .validate(&conn, "run-1")
        .expect_err("Paused Coordinator side quest cannot mutate formal work");
    assert!(
        paused_graph_error.contains("team_paused_resume_required"),
        "{paused_graph_error}"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tasks WHERE org_run_id='run-1'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("task snapshot after side quest"),
        before_tasks
    );
}

#[tokio::test]
async fn coordinator_side_quests_keep_durable_fifo_when_kicks_arrive_out_of_order() {
    let _sandbox = init_inbox_schema();
    let first_call = seed_started_group_udw_with_link();
    let tool = OrgSendMessageTool::new(linked_context(), "builder".to_string());
    let first: serde_json::Value = serde_json::from_str(
        &tool
            .execute_text(params(COORDINATOR_MEMBER_ID), &first_call)
            .await
            .expect("persist first Coordinator side quest"),
    )
    .expect("decode first receipt");
    let second_call = call_context_with_new_id(&first_call);
    let second: serde_json::Value = serde_json::from_str(
        &tool
            .execute_text(params(COORDINATOR_MEMBER_ID), &second_call)
            .await
            .expect("persist second Coordinator side quest"),
    )
    .expect("decode second receipt");
    let first_turn = first["delivered"][0]["turn_intent_id"]
        .as_str()
        .expect("first Coordinator Turn");
    let second_turn = second["delivered"][0]["turn_intent_id"]
        .as_str()
        .expect("second Coordinator Turn");
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::coordination::agent_org_turn_contexts::reconcile_in_flight_after_restart(&conn)
        .expect("generic restart reconciliation preserves pending Coordinator side quests");
    let queued_bindings: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_user_directed_coordinator_bindings binding
             JOIN session_turn_intents intent
               ON intent.session_id=binding.session_id
              AND intent.turn_intent_id=binding.turn_intent_id
             WHERE binding.status='pending' AND intent.status='queued'",
            [],
            |row| row.get(0),
        )
        .expect("load pending Coordinator bindings after restart reconciliation");
    assert_eq!(queued_bindings, 2);
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id='root-1' AND turn_intent_id=?1",
        [second_turn],
    )
    .expect("mirror scheduler promotion for the later kick");

    assert!(
        !crate::coordination::agent_org_user_directed_work::mark_turn_started_with_connection(
            &conn,
            "root-1",
            second_turn,
        )
        .expect("later kick is fenced")
    );
    let waiting_status: String = conn
        .query_row(
            "SELECT status FROM session_turn_intents
             WHERE session_id='root-1' AND turn_intent_id=?1",
            [second_turn],
            |row| row.get(0),
        )
        .expect("load requeued Coordinator Turn");
    assert_eq!(waiting_status, "queued");
    assert!(
        crate::coordination::agent_org_user_directed_work::mark_turn_started_with_connection(
            &conn, "root-1", first_turn,
        )
        .expect("FIFO head starts")
    );
    assert!(
        crate::coordination::agent_org_user_directed_work::mark_turn_terminal(
            "root-1",
            first_turn,
            crate::coordination::agent_org_user_directed_work::UserDirectedDeliveryStatus::Completed,
            None,
        )
        .expect("FIFO head completes")
    );
    let next = crate::coordination::agent_org_user_directed_work::next_pending_after_terminal(
        "root-1", first_turn,
    )
    .expect("resolve next Coordinator binding")
    .expect("later side quest remains pending");
    assert_eq!(next.turn_intent_id, second_turn);
    assert_eq!(next.recipient_session_id, "root-1");
    assert_eq!(next.recipient_member_id, COORDINATOR_MEMBER_ID);
}

#[tokio::test]
async fn formal_task_turn_cannot_use_peer_visible_in_static_member_schema() {
    let _sandbox = init_inbox_schema();
    let _ = seed_started_group_udw_with_link();
    crate::coordination::agent_org_user_directed_work::mark_turn_terminal(
        "builder-session",
        "builder-udw-turn",
        crate::coordination::agent_org_user_directed_work::UserDirectedDeliveryStatus::Completed,
        None,
    )
    .expect("finish UDW fixture before restoring the formal Turn");
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id='builder-session' AND turn_intent_id='builder-turn'",
        [],
    )
    .expect("restore formal TaskExecution as the exact current Turn");
    drop(conn);
    let tool = OrgSendMessageTool::new(linked_context(), "builder".to_string());
    assert_eq!(
        tool.parameters()["properties"]["recipient_member_id"]["enum"],
        json!(["coordinator", "planner"])
    );
    let error = tool
        .execute_text(params("planner"), &call_context("builder"))
        .await
        .expect_err("TaskExecution may not turn a peer link into formal routing authority");
    assert!(
        error.to_string().contains("cannot message member")
            || error.to_string().contains("not currently routable")
            || error.to_string().contains("related_task_id"),
        "{error}"
    );
}

#[test]
fn llm_description_restricts_kind_by_sender_role() {
    let coordinator_tool = OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
    let member_tool = OrgSendMessageTool::new(context(), "builder".to_string());

    assert!(coordinator_tool
        .llm_description()
        .expect("description")
        .contains("kind enum for this sender: [plain, shutdown_request, plan_approval_response]"));
    assert!(member_tool
        .llm_description()
        .expect("description")
        .contains("kind enum for this sender: [plain, shutdown_response]"));
}

#[test]
fn llm_description_explains_planning_protocol() {
    let tool = OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
    let description = tool.llm_description().expect("description");

    assert!(
        description.contains("Coordinator planning protocol"),
        "description must include planning protocol guidance: {description}"
    );
    assert!(
        description.contains("task_create execution_mode=\"plan\"")
            && description.contains("starts in Plan mode automatically"),
        "description must explain task-scoped Plan mode: {description}"
    );
    assert!(
        description.contains("kind = \"plan_approval_response\"")
            && description.contains("accepted = true")
            && description.contains("accepted = false"),
        "description must explain member plan approval and rejection: {description}"
    );
    assert!(
        description.contains("durable approval bound to that planning task"),
        "description must bind approval to the planning task: {description}"
    );
}

#[test]
fn llm_description_lists_only_member_ids() {
    let tool = OrgSendMessageTool::new(context(), "builder".to_string());
    let description = tool.llm_description().expect("description");

    assert!(description.contains("Current Agent Org routing context"));
    assert!(description.contains("sender_member_id: builder"));
    assert!(description.contains("recipient_member_id enum: [coordinator]"));
    assert!(!description.contains("recipient_agent_id"));
    assert!(!description.contains("recipient_name"));
    assert!(!description.contains("Builder"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn execute_persists_and_wakes_by_member_id() {
    let _sandbox = init_inbox_schema();
    let task_id = seed_owned_task("builder");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let mut input = params("builder");
    input["related_task_id"] = Value::String(task_id.clone());
    let call = call_context(COORDINATOR_MEMBER_ID);
    let result = tool
        .execute_text(input.clone(), &call)
        .await
        .expect("send should succeed");
    let replay = tool
        .execute_text(input, &call)
        .await
        .expect("lost response retry replays the original delivery");
    assert_eq!(replay, result);
    let value: serde_json::Value = serde_json::from_str(&result).expect("json result");

    assert_eq!(value["sender_member_id"].as_str(), Some("coordinator"));
    assert_eq!(
        value["delivered"][0]["recipient_member_id"].as_str(),
        Some("builder")
    );
    assert!(value["delivered"][0].get("recipient_agent_id").is_none());
    assert_eq!(
        wake.snapshot(),
        vec![("builder".to_string(), "run-1".to_string())]
    );

    let rows = AgentInboxStore::list_unread_for_member("builder", "run-1").expect("inbox");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].recipient_member_id.as_deref(), Some("builder"));
    assert_eq!(rows[0].sender_member_id.as_deref(), Some("coordinator"));
    let conn = database::db::get_connection().expect("test sqlite connection");
    let binding: (String, String, String) = conn
        .query_row(
            "SELECT task_id,recipient_member_id,source_turn_intent_id
             FROM agent_org_runtime_inbox_task_bindings WHERE inbox_id=?1",
            [rows[0].id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("Coordinator message has exact durable Task binding");
    assert_eq!(binding.0, task_id);
    assert_eq!(binding.1, "builder");
    assert_eq!(binding.2, call.turn_intent_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn member_inbox_coordinator_task_dispatch_returns_root_guidance_with_zero_business_writes() {
    let _sandbox = init_inbox_schema();
    let task_id = seed_owned_task("builder");
    let member_call = seed_started_group_udw_with_link();
    let side_quest_wake = Arc::new(RecordingWakeHook::default());
    let member_tool = OrgSendMessageTool::with_hooks(
        linked_context(),
        "builder".to_string(),
        side_quest_wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    member_tool
        .execute_text(params(COORDINATOR_MEMBER_ID), &member_call)
        .await
        .expect("seed a real durable Coordinator member-inbox activation");
    let coordinator_turn_intent_id = side_quest_wake.user_directed_snapshot()[0]
        .turn_intent_id
        .clone();
    let member_inbox_call = crate::tools::call_context::CallContext {
        session_id: "root-1".to_string(),
        turn_intent_id: coordinator_turn_intent_id,
        call_id: format!("send-call-{}", NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed)),
        ..Default::default()
    }
    .with_authority(
        crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
            crate::tools::call_context::AgentOrgTurnToolProfile::CoordinatorOrchestration,
        ),
    );
    let before_inbox = AgentInboxStore::count_by_run("run-1").expect("baseline Inbox count");
    let conn = database::db::get_connection().expect("test sqlite connection");
    let before_bindings: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox_task_bindings WHERE org_run_id='run-1'",
            [],
            |row| row.get(0),
        )
        .expect("baseline task-message binding count");
    drop(conn);

    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let mut input = params("builder");
    input["related_task_id"] = json!(task_id);
    let result = tool
        .execute_text(input.clone(), &member_inbox_call)
        .await
        .expect("member-inbox Coordinator dispatch receives recoverable guidance");
    let value: Value = serde_json::from_str(&result).expect("guidance json");
    assert_eq!(value["delivered"], false);
    assert_eq!(
        value["reason"],
        "coordinator_task_dispatch_requires_root_authority"
    );
    assert_eq!(value["requires_root_coordinator"], true);
    assert!(wake.snapshot().is_empty());

    let retry = tool
        .execute_text(input, &call_context_with_new_id(&member_inbox_call))
        .await
        .expect("a fresh retry remains side-effect free");
    assert_eq!(
        serde_json::from_str::<Value>(&retry).unwrap()["reason"],
        "coordinator_task_dispatch_requires_root_authority"
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let inbox_count = AgentInboxStore::count_by_run("run-1").expect("count Inbox rows");
    let binding_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox_task_bindings WHERE org_run_id='run-1'",
            [],
            |row| row.get(0),
        )
        .expect("count task message bindings");
    assert_eq!(inbox_count, before_inbox);
    assert_eq!(binding_count, before_bindings);
    assert!(wake.snapshot().is_empty());
}

#[test]
fn formal_task_batch_validates_every_recipient_before_the_first_inbox_write() {
    let _sandbox = init_inbox_schema();
    let task_id = seed_owned_task("builder");
    let mut input = params("builder");
    input["related_task_id"] = json!(task_id);
    let params: OrgSendMessageParams =
        serde_json::from_value(input).expect("decode formal task message params");
    let message = AgentMessage::Plain {
        summary: "batch preflight".to_string(),
        text: "the whole batch must remain atomic".to_string(),
    };
    let recipients = vec![
        OrgRecipientTarget {
            member_id: "builder".to_string(),
            agent_id: "agent-shared".to_string(),
        },
        OrgRecipientTarget {
            member_id: "planner".to_string(),
            agent_id: "agent-shared".to_string(),
        },
    ];
    let sender = context()
        .participant_by_member_id(COORDINATOR_MEMBER_ID)
        .expect("Coordinator participant");
    let conn = database::db::get_connection().expect("test sqlite connection");
    let turn_context =
        crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
            &conn,
            "root-1",
            "coordinator-turn",
        )
        .expect("root Coordinator turn context");

    let result = persist_ordinary_message_in_tx(
        &conn,
        "run-1",
        &sender,
        &turn_context,
        &params,
        &message,
        &recipients,
    )
    .expect("invalid batch returns guidance before writing");
    let OrdinaryMessagePersistOutcome::Guidance(guidance) = result else {
        panic!("mixed-validity batch must not be delivered");
    };
    let guidance: Value = serde_json::from_str(&guidance).expect("guidance json");
    assert_eq!(guidance["reason"], "related_task_not_owned_by_recipient");
    assert_eq!(AgentInboxStore::count_by_run("run-1").unwrap(), 0);
    let binding_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox_task_bindings WHERE org_run_id='run-1'",
            [],
            |row| row.get(0),
        )
        .expect("count task message bindings");
    assert_eq!(binding_count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn binding_write_failure_rolls_back_inbox_receipt_and_wake() {
    let _sandbox = init_inbox_schema();
    let task_id = seed_owned_task("builder");
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute_batch(
        "CREATE TRIGGER fail_task_message_binding
         BEFORE INSERT ON agent_org_runtime_inbox_task_bindings
         BEGIN SELECT RAISE(ABORT,'injected task message binding failure'); END;",
    )
    .expect("install binding failure injection");
    drop(conn);

    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let mut input = params("builder");
    input["related_task_id"] = json!(task_id);
    let error = tool
        .execute_text(input, &call_context(COORDINATOR_MEMBER_ID))
        .await
        .expect_err("post-insert binding failure must abort the whole transaction");
    assert!(
        error
            .to_string()
            .contains("atomic Agent Org message write failed and was rolled back"),
        "{error}"
    );

    let conn = database::db::get_connection().expect("test sqlite connection");
    for (table, expected) in [
        ("agent_org_runtime_inbox", 0_i64),
        ("agent_org_runtime_inbox_task_bindings", 0_i64),
        ("agent_org_runtime_tool_call_receipts", 0_i64),
    ] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("count {table}: {error}"));
        assert_eq!(count, expected, "{table} must have no partial write");
    }
    assert!(wake.snapshot().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn plain_message_to_worker_without_task_returns_guidance_and_does_not_wake() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let result = tool
        .execute_text(params("builder"), &call_context(COORDINATOR_MEMBER_ID))
        .await
        .expect("missing task is recoverable guidance, not a red tool error");
    let value: Value = serde_json::from_str(&result).expect("guidance json");

    assert_eq!(value["delivered"].as_bool(), Some(false));
    assert_eq!(value["requires_task"].as_bool(), Some(true));
    assert_eq!(
        value["reason"].as_str(),
        Some("plain_worker_message_requires_related_task")
    );
    assert!(wake.snapshot().is_empty());
    assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
        .expect("inbox")
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn ordinary_message_does_not_create_unread_work_after_run_is_archived() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='archived',activation_generation=activation_generation+1,
             archived_at=?1,archive_receipt_id='send-message-archive-receipt'
         WHERE id='run-1'",
        [chrono::Utc::now().to_rfc3339()],
    )
    .expect("archive run");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let error = tool
        .execute_text(params("coordinator"), &call_context("builder"))
        .await
        .expect_err("Archived Team rejects the write with a stable error");
    assert!(error.to_string().contains("team_archived"));
    assert!(wake.snapshot().is_empty());
    assert!(
        AgentInboxStore::list_unread_for_member("coordinator", "run-1")
            .expect("coordinator inbox")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn plain_message_cannot_turn_ownerless_eligibility_into_assignment() {
    let _sandbox = init_inbox_schema();
    let task_id = new_task_id();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.clone(),
        org_run_id: "run-1".to_string(),
        subject: "Await coordinator assignment".to_string(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
        })),
    })
    .expect("seed ownerless task");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let mut input = params("builder");
    input["related_task_id"] = json!(task_id);

    let result = tool
        .execute_text(input, &call_context(COORDINATOR_MEMBER_ID))
        .await
        .expect("ownerless work returns structured guidance");
    let value: Value = serde_json::from_str(&result).expect("guidance json");
    assert_eq!(value["delivered"], false);
    assert_eq!(value["reason"], "related_task_not_owned_by_recipient");
    assert!(wake.snapshot().is_empty());
    assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
        .expect("inbox")
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn plain_message_cannot_wake_worker_before_related_task_dependencies_complete() {
    let _sandbox = init_inbox_schema();
    let upstream_id = seed_owned_task("planner");
    let child_id = new_task_id();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: child_id.clone(),
        org_run_id: "run-1".to_string(),
        subject: "Review only after upstream".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("builder".to_string()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: vec![upstream_id],
        metadata: Some(json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
        })),
    })
    .expect("seed blocked child");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let mut input = params("builder");
    input["related_task_id"] = json!(child_id);

    let result = tool
        .execute_text(input, &call_context(COORDINATOR_MEMBER_ID))
        .await
        .expect("blocked work returns guidance");
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["reason"], "related_task_dependencies_unresolved");
    assert!(wake.snapshot().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn shutdown_request_is_rejected_while_member_still_owns_open_tasks() {
    let _sandbox = init_inbox_schema();
    let task_id = seed_owned_task("builder");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let result = tool
        .execute_text(
            json!({
                "recipient_member_id": "builder",
                "kind": "shutdown_request",
                "request_id": "shutdown-with-open-task",
                "reason": "premature cleanup"
            }),
            &call_context(COORDINATOR_MEMBER_ID),
        )
        .await
        .expect("open Task returns recoverable shutdown guidance");
    let value: Value = serde_json::from_str(&result).expect("shutdown guidance json");
    assert_eq!(value["delivered"], false);
    assert_eq!(value["reason"], "shutdown_blocked_by_open_tasks");
    assert_eq!(value["blocked_members"][0]["member_id"], "builder");
    assert!(value["blocked_members"][0]["open_task_count"]
        .as_i64()
        .is_some_and(|count| count >= 1));
    assert!(wake.snapshot().is_empty());
    assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
        .expect("builder Inbox")
        .iter()
        .all(|row| row.payload_kind != "shutdown_request"));

    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='completed',output_json='{
             \"summary\":\"done\",
             \"content\":null,
             \"artifactIds\":[],
             \"producedByMemberId\":\"builder\",
             \"producedAt\":\"2026-08-29T00:00:00Z\"
         }'
         WHERE org_run_id='run-1' AND owner='builder'
           AND status IN ('pending','in_progress')",
        [],
    )
    .expect("complete every owned Task");
    assert!(AgentOrgTaskStore::get("run-1", &task_id)
        .expect("read completed Task")
        .is_some_and(|task| task.status == TaskStatus::Completed));
    let result = tool
        .execute_text(
            json!({
                "recipient_member_id": "builder",
                "kind": "shutdown_request",
                "request_id": "shutdown-after-task",
                "reason": "normal cleanup"
            }),
            &CallContext {
                call_id: "call-shutdown-after-task".to_string(),
                ..call_context(COORDINATOR_MEMBER_ID)
            },
        )
        .await
        .expect("shutdown may be delivered after Task closure");
    let delivered: Value = serde_json::from_str(&result).expect("shutdown result json");
    assert_eq!(delivered["kind"], "shutdown_request");
    assert_eq!(wake.snapshot().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn routine_member_progress_without_task_or_purpose_is_guidance_with_zero_wake() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    let trigger_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id='run-1'",
            [],
            |row| row.get(0),
        )
        .expect("initial task trigger");
    drop(conn);
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let result = tool
        .execute_text(params("coordinator"), &call_context("builder"))
        .await
        .expect("missing objective context returns recoverable guidance");
    let value: Value = serde_json::from_str(&result).expect("result json");
    assert_eq!(value["delivered"], false);
    assert_eq!(value["reason"], "member_coordination_requires_related_task");
    assert!(wake.snapshot().is_empty());
    assert!(
        AgentInboxStore::list_unread_for_member("coordinator", "run-1")
            .expect("coordinator inbox")
            .is_empty()
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let trigger_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id='run-1'",
            [],
            |row| row.get(0),
        )
        .expect("trigger after guidance");
    assert_eq!(trigger_after, trigger_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn member_coordination_requires_purpose_and_exact_current_task() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let mut missing_purpose = params(COORDINATOR_MEMBER_ID);
    missing_purpose["related_task_id"] = json!(builder_authority_task_id());
    let result = tool
        .execute_text(missing_purpose, &call_context("builder"))
        .await
        .expect("missing purpose returns guidance");
    let value: Value = serde_json::from_str(&result).expect("guidance json");
    assert_eq!(value["reason"], "member_coordination_requires_purpose");

    let mut wrong_task = member_coordination_params("blocker");
    wrong_task["related_task_id"] = json!("another-task");
    let result = tool
        .execute_text(wrong_task, &call_context("builder"))
        .await
        .expect("wrong task returns guidance");
    let value: Value = serde_json::from_str(&result).expect("guidance json");
    assert_eq!(value["reason"], "member_coordination_task_mismatch");

    assert!(wake.snapshot().is_empty());
    assert!(
        AgentInboxStore::list_unread_for_member("coordinator", "run-1")
            .expect("coordinator inbox")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn coordinator_old_purpose_parameter_returns_retry_guidance_before_any_write() {
    let _sandbox = init_inbox_schema();
    let task_id = seed_owned_task("builder");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let mut input = params("builder");
    input["related_task_id"] = json!(task_id);
    input["purpose"] = json!("requested_reply");

    let error = tool
        .execute_text(input, &call_context(COORDINATOR_MEMBER_ID))
        .await
        .expect_err("reverse-direction purpose must fail before persistence");

    assert!(
        error.to_string().contains("Remove purpose and retry"),
        "{error}"
    );
    assert!(
        error
            .to_string()
            .contains("no Task or handoff state changed"),
        "{error}"
    );
    assert!(wake.snapshot().is_empty());
    assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
        .expect("builder inbox")
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn actionable_member_coordination_purposes_create_exact_triggers() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    for purpose in [
        "blocker",
        "decision_required",
        "material_change",
        "risk",
        "requested_reply",
    ] {
        let result = tool
            .execute_text(
                member_coordination_params(purpose),
                &call_context("builder"),
            )
            .await
            .expect("actionable member coordination should deliver");
        let value: Value = serde_json::from_str(&result).expect("delivery json");
        assert_eq!(value["purpose"], purpose);
        assert_eq!(value["related_task_id"], builder_authority_task_id());
        assert_eq!(
            value["delivered"][0]["recipient_member_id"],
            COORDINATOR_MEMBER_ID
        );
    }

    assert_eq!(
        AgentInboxStore::list_unread_for_member("coordinator", "run-1")
            .expect("coordinator inbox")
            .len(),
        5
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let exact_triggers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id='run-1'
               AND source_kind IN (
                   'blocker','decision_required','material_change','risk','requested_reply'
               )",
            [],
            |row| row.get(0),
        )
        .expect("exact Coordinator triggers");
    assert_eq!(exact_triggers, 5);
    assert_eq!(wake.snapshot().len(), 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn member_coordination_revalidates_task_run_and_turn_before_delivery() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let task_id = builder_authority_task_id();

    let set_task = |status: &str, owner: &str| {
        let conn = database::db::get_connection().expect("test sqlite connection");
        conn.execute(
            "UPDATE agent_org_runtime_tasks
             SET status=?1,
                 owner=?2,
                 output_json=NULL,
                 failure_reason_json=CASE WHEN ?1='failed' THEN '{\"code\":\"test_terminal\"}' ELSE NULL END,
                 cancel_reason_json=NULL
             WHERE org_run_id='run-1' AND id=?3",
            rusqlite::params![status, owner, &task_id],
        )
        .expect("update exact authority Task");
    };
    let set_run = |status: &str, generation: i64| {
        let conn = database::db::get_connection().expect("test sqlite connection");
        conn.execute(
            "UPDATE agent_org_runtime_runs
             SET status=?1,
                 activation_generation=?2,
                 archived_at=CASE WHEN ?1='archived' THEN updated_at ELSE NULL END,
                 archive_receipt_id=CASE WHEN ?1='archived' THEN 'test-archive-receipt' ELSE NULL END
             WHERE id='run-1'",
            rusqlite::params![status, generation],
        )
        .expect("update exact Agent Org run");
    };

    set_task("failed", "builder");
    tool.execute_text(
        member_coordination_params("blocker"),
        &call_context("builder"),
    )
    .await
    .expect_err("terminal Task cannot produce Member coordination");

    set_task("in_progress", "planner");
    tool.execute_text(
        member_coordination_params("decision_required"),
        &call_context("builder"),
    )
    .await
    .expect_err("reassigned Task rejects the stale owner");

    set_task("in_progress", "builder");
    set_run("paused", 1);
    tool.execute_text(member_coordination_params("risk"), &call_context("builder"))
        .await
        .expect_err("Paused Team invalidates TaskExecution authority");

    set_run("archived", 1);
    tool.execute_text(
        member_coordination_params("material_change"),
        &call_context("builder"),
    )
    .await
    .expect_err("Archived Team rejects the mutation");

    set_run("running", 2);
    tool.execute_text(
        member_coordination_params("requested_reply"),
        &call_context("builder"),
    )
    .await
    .expect_err("stale activation generation fails closed");

    assert!(wake.snapshot().is_empty());
    assert!(
        AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, "run-1")
            .expect("coordinator inbox")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn member_coordination_receipt_replay_is_idempotent() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let call = call_context("builder");
    let input = member_coordination_params("blocker");

    let first = tool
        .execute_text(input.clone(), &call)
        .await
        .expect("first coordination message");
    let replay = tool
        .execute_text(input, &call)
        .await
        .expect("idempotent receipt replay");

    assert_eq!(replay, first);
    assert_eq!(wake.snapshot().len(), 1);
    assert_eq!(
        AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, "run-1")
            .expect("coordinator inbox")
            .len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn unknown_member_coordination_purpose_fails_before_side_effects() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );
    let error = tool
        .execute_text(
            member_coordination_params("progress_update"),
            &call_context("builder"),
        )
        .await
        .expect_err("unknown purpose must fail closed");
    assert!(
        error.to_string().contains("progress_update")
            && error.to_string().contains("requested_reply"),
        "{error}"
    );
    assert!(wake.snapshot().is_empty());
    assert!(
        AgentInboxStore::list_unread_for_member("coordinator", "run-1")
            .expect("coordinator inbox")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn shutdown_response_to_coordinator_self_aborts_sender_member() {
    let _sandbox = init_inbox_schema();
    let abort = Arc::new(RecordingSelfAbortHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        Arc::new(NoopInboxWakeHook),
        abort.clone(),
    );

    tool.execute_text(
        json!({
            "recipient_member_id": "coordinator",
            "kind": "shutdown_response",
            "request_id": "req-1",
            "accepted": true
        }),
        &call_context("builder"),
    )
    .await
    .expect("shutdown response should send");

    assert_eq!(
        abort.snapshot(),
        vec![("builder".to_string(), "run-1".to_string())]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn shutdown_response_to_member_is_rejected_before_wake() {
    let _sandbox = init_inbox_schema();
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        COORDINATOR_MEMBER_ID.to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let error = tool
        .execute_text(
            json!({
                "recipient_member_id": "builder",
                "kind": "shutdown_response",
                "request_id": "req-2",
                "accepted": true
            }),
            &call_context(COORDINATOR_MEMBER_ID),
        )
        .await
        .expect_err("shutdown response to non-coordinator should fail")
        .to_string();

    assert!(
        error.contains("shutdown_response") && error.contains("coordinator"),
        "{error}"
    );
    assert!(wake.snapshot().is_empty());
    assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
        .expect("inbox")
        .is_empty());
}
