//! Unit tests for `org_send_message`: recipient resolution, JSON-schema
//! shape, LLM-description routing/kind hints, and `execute_text`
//! persistence / wake-hook / self-abort-hook behavior.

use super::*;
use crate::coordination::agent_inbox::AgentInboxStore;
use crate::coordination::agent_org_runs::{AgentOrgContextMember, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    new_task_id, AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
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

fn params(recipient_member_id: &str) -> serde_json::Value {
    json!({
        "recipient_member_id": recipient_member_id,
        "kind": "plain",
        "summary": "hello",
        "text": "hello"
    })
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
fn schema_keeps_openai_compatible_routing_fields() {
    let tool = OrgSendMessageTool::new(context(), "builder".to_string());
    let schema = tool.parameters();

    assert_eq!(
        schema["properties"]["recipient_member_id"]["type"].as_str(),
        Some("string")
    );
    assert_eq!(
        schema["properties"]["kind"]["type"].as_str(),
        Some("string")
    );
    assert!(schema["properties"]["recipient_member_id"]
        .get("enum")
        .is_none());
    assert!(schema["properties"]["kind"].get("enum").is_none());
    assert!(schema.get("allOf").is_none());

    assert_eq!(schema["properties"]["purpose"]["type"], "string");
    assert_eq!(
        schema["properties"]["purpose"]["enum"],
        json!([
            "blocker",
            "decision_required",
            "material_change",
            "risk",
            "requested_reply"
        ])
    );
    assert!(!schema.to_string().contains("$ref"));
}

#[test]
fn llm_description_carries_current_routing_hints() {
    let tool = OrgSendMessageTool::new(context(), "builder".to_string());
    let description = tool.llm_description().expect("description");

    assert!(description.contains("recipient_member_id enum: [coordinator]"));
    assert!(description.contains("Routine work progress is NOT a message or assistant reply"));
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
    input["related_task_id"] = Value::String(task_id);
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
async fn routine_member_progress_without_task_or_purpose_is_guidance_with_zero_wake() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    let trigger_before: (i64, i64) = conn
        .query_row(
            "SELECT coordinator_trigger_sequence,coordinator_claimed_trigger_sequence
             FROM agent_org_runtime_run_progress WHERE org_run_id='run-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
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
    let trigger_after: (i64, i64) = conn
        .query_row(
            "SELECT coordinator_trigger_sequence,coordinator_claimed_trigger_sequence
             FROM agent_org_runtime_run_progress WHERE org_run_id='run-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
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
async fn actionable_member_coordination_purposes_deliver_and_coalesce_trigger() {
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
    let (sequence, claimed): (i64, i64) = conn
        .query_row(
            "SELECT coordinator_trigger_sequence,coordinator_claimed_trigger_sequence
             FROM agent_org_runtime_run_progress WHERE org_run_id='run-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("coalesced coordinator trigger");
    assert_eq!((sequence, claimed), (1, 0));
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
