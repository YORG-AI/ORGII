//! Unit tests for `org_send_message`: recipient resolution, JSON-schema
//! shape, LLM-description routing/kind hints, and `execute_text`
//! persistence / wake-hook / self-abort-hook behavior.

use super::*;
use crate::coordination::agent_inbox::AgentInboxStore;
use crate::coordination::agent_org_runs::{AgentOrgContextMember, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    new_task_id, AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
};
use crate::definitions::orgs::HierarchyMode;
use std::sync::Mutex;

fn context() -> Arc<AgentOrgRunContext> {
    context_with_mode(HierarchyMode::Strict)
}

fn context_with_mode(hierarchy_mode: HierarchyMode) -> Arc<AgentOrgRunContext> {
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
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "builder".to_string(),
                name: "Builder".to_string(),
                role: "build".to_string(),
                agent_id: "agent-shared".to_string(),
                parent_member_id: Some("planner".to_string()),
            },
        ],
        hierarchy_mode,
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
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
    crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org tasks schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("member intervention schema");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS code_sessions (
            session_id TEXT PRIMARY KEY,
            cli_agent_type TEXT NOT NULL,
            status TEXT NOT NULL,
            parent_session_id TEXT,
            org_member_id TEXT,
            updated_at TEXT NOT NULL
        );",
    )
    .expect("CLI session schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runs (
             id, org_id, coordinator_agent_id, root_session_id,
             entry_mode, status, created_at, updated_at
         ) VALUES ('run-1', 'org-1', 'agent-coord', 'root-1',
                   'build', 'running', ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("seed running Agent Org run");
    sandbox
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
    assert!(error.contains("planner"), "{error}");
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
}

#[test]
fn llm_description_carries_flat_hierarchy_routing_hints() {
    let tool = OrgSendMessageTool::new(
        context_with_mode(HierarchyMode::Flat),
        "builder".to_string(),
    );
    let description = tool.llm_description().expect("description");

    assert!(description.contains("hierarchy_mode: flat"));
    assert!(description.contains("recipient_member_id enum: [coordinator, planner]"));
}

#[test]
fn llm_description_recipient_hints_follow_strict_hierarchy_mode() {
    let coordinator_tool = OrgSendMessageTool::new(
        context_with_mode(HierarchyMode::Strict),
        COORDINATOR_MEMBER_ID.to_string(),
    );
    let builder_tool = OrgSendMessageTool::new(
        context_with_mode(HierarchyMode::Strict),
        "builder".to_string(),
    );

    assert!(coordinator_tool
        .llm_description()
        .expect("description")
        .contains("recipient_member_id enum: [builder, planner]"));
    assert!(builder_tool
        .llm_description()
        .expect("description")
        .contains("recipient_member_id enum: [coordinator, planner]"));
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
    assert!(description.contains("hierarchy_mode: strict"));
    assert!(description.contains("sender_member_id: builder"));
    assert!(description.contains("recipient_member_id enum: [coordinator, planner]"));
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
    let result = tool
        .execute_text(input, &crate::tools::call_context::CallContext::default())
        .await
        .expect("send should succeed");
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
        .execute_text(
            params("builder"),
            &crate::tools::call_context::CallContext::default(),
        )
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
async fn ordinary_message_does_not_create_unread_work_after_run_is_terminal() {
    let _sandbox = init_inbox_schema();
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runs SET status='completed' WHERE id='run-1'",
        [],
    )
    .expect("complete run");
    let wake = Arc::new(RecordingWakeHook::default());
    let tool = OrgSendMessageTool::with_hooks(
        context(),
        "builder".to_string(),
        wake.clone(),
        Arc::new(NoopSelfAbortHook),
    );

    let result = tool
        .execute_text(
            params("coordinator"),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .expect("terminal race returns structured no-delivery guidance");
    let value: Value = serde_json::from_str(&result).expect("guidance json");
    assert_eq!(value["delivered"], false);
    assert_eq!(value["reason"], "run_not_running");
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
        .execute_text(input, &crate::tools::call_context::CallContext::default())
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
        .execute_text(input, &crate::tools::call_context::CallContext::default())
        .await
        .expect("blocked work returns guidance");
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["reason"], "related_task_dependencies_unresolved");
    assert!(wake.snapshot().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn worker_status_message_to_coordinator_does_not_require_task() {
    let _sandbox = init_inbox_schema();
    let tool = OrgSendMessageTool::new(context(), "builder".to_string());

    let result = tool
        .execute_text(
            params("coordinator"),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .expect("worker escalation to coordinator remains available");
    let value: Value = serde_json::from_str(&result).expect("result json");
    assert_eq!(
        value["delivered"][0]["recipient_member_id"].as_str(),
        Some("coordinator")
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
        &crate::tools::call_context::CallContext::default(),
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
            &crate::tools::call_context::CallContext::default(),
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
