use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::coordination::agent_inbox::{AgentInboxStore, AgentMessage};
use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_DEPENDENCY_CYCLE_ERROR,
};
use crate::core::session::persistence::{upsert_session, UnifiedSessionRecord};
use crate::definitions::orgs::HierarchyMode;
use crate::tools::impls::orchestration::org_send_message::{InboxWakeHook, NoopInboxWakeHook};
use crate::tools::traits::{Tool, ToolError};
use test_helpers::test_env;

use super::task_create::TaskCreateTool as ProductionTaskCreateTool;
use super::task_graph_create::TaskGraphCreateTool;
use super::task_list_get::{TaskGetTool, TaskListTool};
use super::task_update::TaskUpdateTool;
use super::TaskToolsContext;

fn test_ctx() -> crate::tools::call_context::CallContext {
    crate::tools::call_context::CallContext::default()
}

/// Most task-tool tests exercise ownership, eligibility, output, or update
/// behavior rather than the dispatch-policy parser. Make their independent
/// scheduling choice explicit in one place; dependency-specific tests pass an
/// `after_dependencies` policy themselves and are left untouched.
struct TaskCreateTool {
    inner: ProductionTaskCreateTool,
    coordinator_default_parallel_override: bool,
}

impl TaskCreateTool {
    fn new(ctx: Arc<TaskToolsContext>) -> Self {
        let coordinator_default_parallel_override = ctx.is_coordinator();
        Self {
            inner: ProductionTaskCreateTool::new(ctx),
            coordinator_default_parallel_override,
        }
    }

    async fn execute_text(
        &self,
        mut params: Value,
        ctx: &crate::tools::call_context::CallContext,
    ) -> Result<String, ToolError> {
        if params.get("dispatch_policy").is_none() {
            params["dispatch_policy"] = json!("immediate");
        }
        if params.get("execution_mode").is_none() {
            params["execution_mode"] = json!("build");
        }
        if self.coordinator_default_parallel_override
            && params
                .get("allow_parallel_with_unlisted_open_tasks")
                .is_none()
        {
            params["allow_parallel_with_unlisted_open_tasks"] = json!(true);
        }
        self.inner.execute_text(params, ctx).await
    }
}

fn org_context() -> Arc<AgentOrgRunContext> {
    Arc::new(AgentOrgRunContext {
        run_id: "run-tools-1".into(),
        org_id: "org-tools-1".into(),
        org_name: "Tools Org".into(),
        org_role: "lead engineer".into(),
        coordinator_agent_id: "coord-1".into(),
        coordinator_name: "Coordinator".into(),
        coordinator_role: "lead engineer".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: "m-alice".into(),
                name: "Alice".into(),
                role: "engineer".into(),
                agent_id: "alice-1".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "m-bob".into(),
                name: "Bob".into(),
                role: "engineer".into(),
                agent_id: "bob-1".into(),
                parent_member_id: None,
            },
        ],
        hierarchy_mode: Default::default(),
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        root_session_id: Some("root-tools-1".into()),
    })
}

fn ctx(caller_member_id: &str) -> Arc<TaskToolsContext> {
    ctx_for_org(org_context(), caller_member_id)
}

fn ctx_for_org(
    org_context: Arc<AgentOrgRunContext>,
    caller_member_id: &str,
) -> Arc<TaskToolsContext> {
    let caller_agent_id = org_context
        .require_participant_agent_id(caller_member_id)
        .expect("test caller member id resolves");
    Arc::new(TaskToolsContext {
        org_context,
        caller_agent_id,
        caller_member_id: caller_member_id.to_string(),
        wake_hook: Arc::new(NoopInboxWakeHook),
    })
}

fn hierarchical_org_context(hierarchy_mode: HierarchyMode) -> Arc<AgentOrgRunContext> {
    Arc::new(AgentOrgRunContext {
        run_id: "run-hierarchy-tools".into(),
        org_id: "org-hierarchy-tools".into(),
        org_name: "Hierarchy Tools Org".into(),
        org_role: "coordinator".into(),
        coordinator_agent_id: "coord-hierarchy".into(),
        coordinator_name: "Coordinator".into(),
        coordinator_role: "coordinator".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: "manager".into(),
                name: "Manager".into(),
                role: "team lead".into(),
                agent_id: "manager-agent".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "report".into(),
                name: "Direct Report".into(),
                role: "implementer".into(),
                agent_id: "report-agent".into(),
                parent_member_id: Some("manager".into()),
            },
            AgentOrgContextMember {
                member_id: "peer".into(),
                name: "Peer".into(),
                role: "reviewer".into(),
                agent_id: "peer-agent".into(),
                parent_member_id: None,
            },
        ],
        hierarchy_mode,
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        root_session_id: Some("root-hierarchy-tools".into()),
    })
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

fn ctx_with_wake(
    caller_member_id: &str,
    wake_hook: Arc<dyn InboxWakeHook>,
) -> Arc<TaskToolsContext> {
    let org_context = org_context();
    let caller_agent_id = org_context
        .require_participant_agent_id(caller_member_id)
        .expect("test caller member id resolves");
    Arc::new(TaskToolsContext {
        org_context,
        caller_agent_id,
        caller_member_id: caller_member_id.to_string(),
        wake_hook,
    })
}

fn shared_sde_ctx(caller_member_id: Option<&str>) -> Arc<TaskToolsContext> {
    Arc::new(TaskToolsContext {
        org_context: Arc::new(AgentOrgRunContext {
            run_id: "run-shared-sde".into(),
            org_id: "org-shared-sde".into(),
            org_name: "Default Agent Org".into(),
            org_role: "Coordinator".into(),
            coordinator_agent_id: "builtin:sde".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "Coordinator".into(),
            members: vec![AgentOrgContextMember {
                member_id: "sde-planner".into(),
                name: "Planner".into(),
                role: "Plans".into(),
                agent_id: "builtin:sde".into(),
                parent_member_id: None,
            }],
            hierarchy_mode: Default::default(),
            plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
            root_session_id: Some("root-shared-sde".into()),
        }),
        caller_agent_id: "builtin:sde".into(),
        caller_member_id: caller_member_id
            .unwrap_or(COORDINATOR_MEMBER_ID)
            .to_string(),
        wake_hook: Arc::new(NoopInboxWakeHook),
    })
}

fn task_tools_sandbox() -> test_env::SandboxGuard {
    let sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent sessions schema");
    crate::session::persistence::init(&conn).expect("unified session schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
    crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("member intervention schema");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent team tasks schema");
    crate::coordination::agent_org_plan_approvals::init_schema(&conn)
        .expect("agent org plan approval schema");
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
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, turn_intent_id)
        );",
    )
    .expect("cli session schema");
    sandbox
}

#[tokio::test]
async fn task_graph_create_inserts_complete_chain_atomically() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskGraphCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let result = tool
        .execute_text(
            json!({
                "tasks": [
                    { "key": "plan", "subject": "Plan", "owner_member_id": "m-alice", "execution_mode": "plan" },
                    { "key": "write", "subject": "Write", "owner_member_id": "m-bob", "execution_mode": "build", "depends_on": ["plan"] },
                    { "key": "review", "subject": "Review", "owner_member_id": "m-alice", "execution_mode": "build", "depends_on": ["write"] },
                    { "key": "final", "subject": "Synthesize", "owner_member_id": "coordinator", "execution_mode": "build", "depends_on": ["review"] }
                ]
            }),
            &test_ctx(),
        )
        .await
        .expect("valid graph");
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["created"], true);
    assert_eq!(value["tasks"].as_array().unwrap().len(), 4);

    let plan_id = value["task_id_by_key"]["plan"].as_str().unwrap();
    let write_id = value["task_id_by_key"]["write"].as_str().unwrap();
    let review_id = value["task_id_by_key"]["review"].as_str().unwrap();
    let final_id = value["task_id_by_key"]["final"].as_str().unwrap();
    assert_eq!(
        AgentOrgTaskStore::get("run-tools-1", write_id)
            .unwrap()
            .unwrap()
            .blocked_by,
        vec![plan_id]
    );
    assert_eq!(
        AgentOrgTaskStore::get("run-tools-1", review_id)
            .unwrap()
            .unwrap()
            .blocked_by,
        vec![write_id]
    );
    assert_eq!(
        AgentOrgTaskStore::get("run-tools-1", final_id)
            .unwrap()
            .unwrap()
            .blocked_by,
        vec![review_id]
    );
}

#[test]
fn task_graph_create_schema_is_provider_compatible() {
    let tool = TaskGraphCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let schema = tool.parameters();
    crate::tools::traits::assert_llm_compatible_schema(&schema)
        .expect("task_graph_create schema must remain provider-compatible");
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("tasks")));
}

#[tokio::test]
async fn task_graph_create_is_coordinator_only() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskGraphCreateTool::new(ctx("m-alice"));
    let result = tool
        .execute_text(
            json!({
                "tasks": [
                    { "key": "self", "subject": "Self", "owner_member_id": "m-alice", "execution_mode": "build" }
                ]
            }),
            &test_ctx(),
        )
        .await
        .expect("authorization denial is structured guidance");
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert!(AgentOrgTaskStore::list("run-tools-1").unwrap().is_empty());
}

#[tokio::test]
async fn task_graph_create_cycle_leaves_board_empty() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskGraphCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let error = tool
        .execute_text(
            json!({
                "tasks": [
                    { "key": "a", "subject": "A", "owner_member_id": "m-alice", "execution_mode": "build", "depends_on": ["b"] },
                    { "key": "b", "subject": "B", "owner_member_id": "m-bob", "execution_mode": "build", "depends_on": ["a"] }
                ]
            }),
            &test_ctx(),
        )
        .await
        .expect_err("cycle must reject the whole graph")
        .to_string();
    assert!(error.contains(TASK_DEPENDENCY_CYCLE_ERROR), "{error}");
    assert!(AgentOrgTaskStore::list("run-tools-1").unwrap().is_empty());
}

#[tokio::test]
async fn task_create_rejects_missing_dispatch_policy() {
    let _sandbox = task_tools_sandbox();
    let tool = ProductionTaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({ "subject": "Ambiguous scheduling", "owner_member_id": "m-alice", "execution_mode": "build" }),
            &test_ctx(),
        )
        .await
        .expect_err("dispatch policy must never silently default to immediate");
    assert!(
        matches!(err, ToolError::InvalidParams(message) if message.contains("dispatch_policy"))
    );
}

#[test]
fn task_create_schema_requires_unambiguous_dispatch_policy() {
    let tool = ProductionTaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let schema = tool.parameters();
    crate::tools::traits::assert_llm_compatible_schema(&schema)
        .expect("task_create schema must remain provider-compatible");
    let required = schema["required"]
        .as_array()
        .expect("task_create schema has required fields");
    assert!(required.iter().any(|field| field == "dispatch_policy"));
    assert!(required.iter().any(|field| field == "execution_mode"));
    let properties = schema["properties"]
        .as_object()
        .expect("task_create schema has properties");
    assert!(properties.contains_key("dispatch_policy"));
    assert!(properties.contains_key("allow_parallel_with_unlisted_open_tasks"));
    assert!(!properties.contains_key("blocked_by"));
    assert!(!properties.contains_key("blocks"));
}

#[tokio::test]
async fn task_create_rejects_unknown_dependency_id() {
    let _sandbox = task_tools_sandbox();
    let tool = ProductionTaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({
                "subject": "Review missing work",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "execution_mode": "build",
                "dependency_task_ids": ["task-that-does-not-exist"]
            }),
            &test_ctx(),
        )
        .await
        .expect_err("unknown dependencies must not create permanently blocked work");
    assert!(matches!(
        err,
        ToolError::InvalidParams(message)
            if message.contains("do not exist") && message.contains("task-that-does-not-exist")
    ));
}

#[tokio::test]
async fn task_create_rejects_dispatch_policy_shape_mismatches() {
    let _sandbox = task_tools_sandbox();
    let tool = ProductionTaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let error = tool
        .execute_text(
            json!({
                "subject": "Immediate with hidden dependency",
                "owner_member_id": "m-alice",
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "dependency_task_ids": ["some-upstream"]
            }),
            &test_ctx(),
        )
        .await
        .expect_err("immediate work cannot smuggle a dependency");
    assert!(matches!(
        error,
        ToolError::InvalidParams(message) if message.contains("cannot include dependency_task_ids")
    ));

    let result = tool
        .execute_text(
            json!({
                "subject": "Dependent without upstream",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "execution_mode": "build"
            }),
            &test_ctx(),
        )
        .await
        .expect("missing dependency ids are recoverable guidance");
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["requires_dependency_ids"], true);
}

#[tokio::test]
async fn task_create_requires_confirmation_for_omitted_open_tasks() {
    let _sandbox = task_tools_sandbox();
    let tool = ProductionTaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));

    tool.execute_text(
        json!({
            "id": "plan-stage",
            "subject": "Plan the deliverable",
            "owner_member_id": "m-alice",
            "dispatch_policy": "immediate",
            "execution_mode": "plan"
        }),
        &test_ctx(),
    )
    .await
    .unwrap();
    let premature_build = tool
        .execute_text(
            json!({
                "id": "premature-build",
                "subject": "Build before planning finishes",
                "owner_member_id": "m-bob",
                "dispatch_policy": "immediate",
                "execution_mode": "build"
            }),
            &test_ctx(),
        )
        .await
        .expect("open planning task returns dependency guidance");
    let premature_value: Value = serde_json::from_str(&premature_build).unwrap();
    assert_eq!(premature_value["requires_dependency_confirmation"], true);
    assert_eq!(
        premature_value["unlisted_open_tasks"][0]["id"],
        "plan-stage"
    );
    assert!(AgentOrgTaskStore::get("run-tools-1", "premature-build")
        .unwrap()
        .is_none());
    tool.execute_text(
        json!({
            "id": "implement-stage",
            "subject": "Write the deliverable",
            "owner_member_id": "m-bob",
            "dispatch_policy": "after_dependencies",
            "execution_mode": "build",
            "dependency_task_ids": ["plan-stage"]
        }),
        &test_ctx(),
    )
    .await
    .unwrap();

    let review_guidance = tool
        .execute_text(
            json!({
                "id": "review-stage",
                "subject": "Review the written deliverable",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "execution_mode": "build",
                "dependency_task_ids": ["plan-stage"]
            }),
            &test_ctx(),
        )
        .await
        .expect("omitted dependency returns recoverable guidance");
    let review_value: Value = serde_json::from_str(&review_guidance).unwrap();
    assert_eq!(review_value["created"], false);
    assert_eq!(review_value["requires_dependency_confirmation"], true);
    assert_eq!(
        review_value["unlisted_open_tasks"][0]["id"],
        "implement-stage"
    );
    assert!(
        AgentOrgTaskStore::get("run-tools-1", "review-stage")
            .unwrap()
            .is_none(),
        "guidance must not leave a partially-created task"
    );

    tool.execute_text(
        json!({
            "id": "review-stage",
            "subject": "Review the written deliverable",
            "owner_member_id": "m-alice",
            "dispatch_policy": "after_dependencies",
            "execution_mode": "build",
            "dependency_task_ids": ["plan-stage", "implement-stage"]
        }),
        &test_ctx(),
    )
    .await
    .expect("coordinator can retry with the missing dependency");

    let synthesis_guidance = tool
        .execute_text(
            json!({
                "id": "synthesis-stage",
                "subject": "Synthesize the final result",
                "owner_member_id": "m-bob",
                "dispatch_policy": "after_dependencies",
                "execution_mode": "build",
                "dependency_task_ids": ["plan-stage"]
            }),
            &test_ctx(),
        )
        .await
        .expect("final synthesis must confirm every omitted open stage");
    let synthesis_value: Value = serde_json::from_str(&synthesis_guidance).unwrap();
    let omitted_ids = synthesis_value["unlisted_open_tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(omitted_ids, vec!["implement-stage", "review-stage"]);
    assert!(AgentOrgTaskStore::get("run-tools-1", "synthesis-stage")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn task_create_allows_explicit_parallelism_with_unlisted_open_tasks() {
    let _sandbox = task_tools_sandbox();
    let tool = ProductionTaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));

    for (id, owner) in [("producer-a", "m-alice"), ("unrelated-b", "m-bob")] {
        tool.execute_text(
            json!({
                "id": id,
                "subject": id,
                "owner_member_id": owner,
                "dispatch_policy": "immediate",
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": id == "unrelated-b"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    }

    let response = tool
        .execute_text(
            json!({
                "id": "consumer-a",
                "subject": "Consume only producer A",
                "owner_member_id": "coordinator",
                "dispatch_policy": "after_dependencies",
                "execution_mode": "build",
                "dependency_task_ids": ["producer-a"],
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &test_ctx(),
        )
        .await
        .expect("explicit confirmation preserves intentional parallelism");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["already_exists"], false);
    assert_eq!(value["task"]["blocked_by"], json!(["producer-a"]));
}

#[tokio::test]
async fn task_create_rejects_ownerless_pending_without_eligibility() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let tool = TaskCreateTool::new(Arc::clone(&ctx));
    let err = tool
        .execute_text(json!({ "subject": "S1" }), &test_ctx())
        .await
        .expect_err("ownerless pending tasks require eligibility");
    assert!(
        matches!(err, ToolError::InvalidParams(message) if message.contains("eligible_member_ids"))
    );
}

#[tokio::test]
async fn task_create_rejects_reserved_metadata_dispatch_keys() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({
                "subject": "Reserved metadata",
                "owner_member_id": "m-alice",
                "metadata": { "eligible_member_ids": ["m-bob"] }
            }),
            &test_ctx(),
        )
        .await
        .expect_err("reserved metadata must use typed fields");
    assert!(matches!(err, ToolError::InvalidParams(message) if message.contains("reserved")));
}

#[tokio::test]
async fn task_create_unassigned_with_eligibility_waits_for_coordinator_assignment() {
    let _sandbox = task_tools_sandbox();
    let wake_hook = Arc::new(RecordingWakeHook::default());
    let ctx = ctx_with_wake(COORDINATOR_MEMBER_ID, wake_hook.clone());
    let tool = TaskCreateTool::new(ctx);

    let res = tool
        .execute_text(
            json!({
                "subject": "S1 eligible",
                "eligible_member_ids": ["m-alice"],
                "required_role": "engineer",
            }),
            &test_ctx(),
        )
        .await
        .expect("task_create succeeds");

    let value: Value = serde_json::from_str(&res).unwrap();
    assert!(!value["task_assigned_dispatched"].as_bool().unwrap());
    assert_eq!(value["assignment_required"], true);
    assert!(value["guidance"]
        .as_str()
        .is_some_and(|guidance| guidance.contains("explicit owner assignment")));
    assert!(wake_hook.snapshot().is_empty());
    let alice_inbox = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1").unwrap();
    let bob_inbox = AgentInboxStore::list_unread_for_member("m-bob", "run-tools-1").unwrap();
    assert!(alice_inbox.is_empty());
    assert!(bob_inbox.is_empty());
}

#[tokio::test]
async fn task_create_rejects_coordinator_in_eligible_member_ids() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({
                "subject": "Invalid eligibility",
                "eligible_member_ids": ["coordinator"],
            }),
            &test_ctx(),
        )
        .await
        .expect_err("coordinator is not a worker eligibility target");
    match err {
        ToolError::InvalidParams(msg) => assert!(msg.contains("eligible_member_ids")),
        other => panic!("expected InvalidParams, got {other:?}"),
    }
}

#[tokio::test]
async fn task_create_with_owner_dispatches_inbox() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let tool = TaskCreateTool::new(Arc::clone(&ctx));
    let res = tool
        .execute_text(
            json!({
                "subject": "S2",
                "owner_member_id": "m-alice",
                "description": "do the thing",
            }),
            &test_ctx(),
        )
        .await
        .expect("task_create succeeds");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert!(value["task_assigned_dispatched"].as_bool().unwrap());

    let inbox = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1").unwrap();
    assert_eq!(inbox.len(), 1);
    let payload: AgentMessage = serde_json::from_str(&inbox[0].payload_json).unwrap();
    match &payload {
        AgentMessage::TaskAssigned {
            subject,
            assigned_by,
            ..
        } => {
            assert_eq!(subject, "S2");
            assert_eq!(assigned_by, "Coordinator");
        }
        other => panic!("expected TaskAssigned, got {other:?}"),
    }
}

#[tokio::test]
async fn task_create_duplicate_explicit_id_returns_existing_without_dispatch() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let tool = TaskCreateTool::new(Arc::clone(&ctx));
    let first = tool
        .execute_text(
            json!({
                "id": "stable-task-id",
                "subject": "Original subject",
                "owner_member_id": "m-alice",
            }),
            &test_ctx(),
        )
        .await
        .expect("first task_create succeeds");
    let first_value: Value = serde_json::from_str(&first).unwrap();
    assert!(!first_value["already_exists"].as_bool().unwrap());
    assert!(first_value["task_assigned_dispatched"].as_bool().unwrap());

    let second = tool
        .execute_text(
            json!({
                "id": "stable-task-id",
                "subject": "Retry subject should not replace original",
                "owner_member_id": "m-bob",
            }),
            &test_ctx(),
        )
        .await
        .expect("duplicate task_create returns existing task");
    let second_value: Value = serde_json::from_str(&second).unwrap();
    assert!(second_value["already_exists"].as_bool().unwrap());
    assert!(!second_value["task_assigned_dispatched"].as_bool().unwrap());
    assert_eq!(
        second_value["task"]["subject"].as_str().unwrap(),
        "Original subject"
    );
    assert_eq!(second_value["task"]["owner"].as_str().unwrap(), "m-alice");

    let alice_inbox = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1").unwrap();
    let bob_inbox = AgentInboxStore::list_unread_for_member("m-bob", "run-tools-1").unwrap();
    assert_eq!(alice_inbox.len(), 1);
    assert!(bob_inbox.is_empty());
}

#[tokio::test]
async fn task_create_coordinator_in_progress_requires_explicit_owner_member_id() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({
                "subject": "Coordinator started work",
                "status": "in_progress"
            }),
            &test_ctx(),
        )
        .await
        .expect_err("ownerless in_progress task_create is invalid");
    match err {
        ToolError::InvalidParams(msg) => assert!(msg.contains("owner_member_id")),
        other => panic!("expected InvalidParams, got {other:?}"),
    }
}

#[tokio::test]
async fn task_create_coordinator_can_start_explicit_coordinator_work() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let res = tool
        .execute_text(
            json!({
                "subject": "Coordinator explicit work",
                "status": "in_progress",
                "owner_member_id": "coordinator"
            }),
            &test_ctx(),
        )
        .await
        .expect("coordinator can explicitly own in-progress work");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["status"].as_str().unwrap(), "in_progress");
    assert_eq!(value["task"]["owner"].as_str().unwrap(), "coordinator");
}

#[tokio::test]
async fn task_create_coordinator_can_assign_member_pending_work() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let res = tool
        .execute_text(
            json!({
                "subject": "Coordinator assigned member work",
                "status": "pending",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .expect("task_create assigns pending member work");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["status"].as_str().unwrap(), "pending");
    assert_eq!(value["task"]["owner"].as_str().unwrap(), "m-alice");
    assert!(value["task_assigned_dispatched"].as_bool().unwrap());
    let inbox = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1").unwrap();
    assert_eq!(inbox.len(), 1);
}

#[tokio::test]
async fn task_create_member_in_progress_requires_explicit_owner_member_id() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx("m-alice"));
    let err = tool
        .execute_text(
            json!({
                "subject": "Alice started work",
                "status": "in_progress"
            }),
            &test_ctx(),
        )
        .await
        .expect_err("ownerless in_progress task_create is invalid");
    match err {
        ToolError::InvalidParams(msg) => assert!(msg.contains("owner_member_id")),
        other => panic!("expected InvalidParams, got {other:?}"),
    }
}

#[tokio::test]
async fn task_create_coordinator_cannot_start_member_work_in_progress() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({
                "subject": "Coordinator attempted member start",
                "status": "in_progress",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .expect_err("coordinator cannot start another member's work");
    match err {
        ToolError::InvalidParams(msg) => assert!(msg.contains("owning member")),
        other => panic!("expected InvalidParams, got {other:?}"),
    }
}

#[tokio::test]
async fn task_create_member_cannot_start_other_member_work_in_progress() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx("m-alice"));
    let response = tool
        .execute_text(
            json!({
                "subject": "Alice attempted Bob start",
                "status": "in_progress",
                "owner_member_id": "m-bob"
            }),
            &test_ctx(),
        )
        .await
        .expect("authorization misuse returns structured guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_create.assign_owner");
    assert_eq!(value["denied_target_member_ids"], json!(["m-bob"]));
    assert!(AgentOrgTaskStore::list("run-tools-1").unwrap().is_empty());
}

#[tokio::test]
async fn task_create_member_can_start_self_work_in_progress() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx("m-alice"));
    let res = tool
        .execute_text(
            json!({
                "subject": "Alice started self work",
                "status": "in_progress",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .expect("member can start self-owned work");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["status"].as_str().unwrap(), "in_progress");
    assert_eq!(value["task"]["owner"].as_str().unwrap(), "m-alice");
}

#[tokio::test]
async fn task_authority_manager_may_assign_direct_reports_only_when_hierarchy_exists() {
    let _sandbox = task_tools_sandbox();
    for (mode, task_id, should_create) in [
        (HierarchyMode::Soft, "soft-report-task", true),
        (HierarchyMode::Strict, "strict-report-task", true),
        (HierarchyMode::Flat, "flat-report-task", false),
    ] {
        let tool = TaskCreateTool::new(ctx_for_org(hierarchical_org_context(mode), "manager"));
        let response = tool
            .execute_text(
                json!({
                    "id": task_id,
                    "subject": "Manager assigns a direct report",
                    "owner_member_id": "report"
                }),
                &test_ctx(),
            )
            .await
            .unwrap();
        let value: Value = serde_json::from_str(&response).unwrap();
        if should_create {
            assert_eq!(value["task"]["owner"], "report", "mode={mode:?}");
            assert_eq!(value["already_exists"], false, "mode={mode:?}");
            AgentOrgTaskStore::delete("run-hierarchy-tools", task_id)
                .expect("each hierarchy case must start with an empty scheduling board");
        } else {
            assert_eq!(value["authorization_denied"], true, "mode={mode:?}");
            assert_eq!(value["denied_target_member_ids"], json!(["report"]));
        }
    }
}

#[tokio::test]
async fn task_authority_manager_cannot_assign_peer_even_when_soft_routing_allows_chat() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx_for_org(
        hierarchical_org_context(HierarchyMode::Soft),
        "manager",
    ));
    let response = tool
        .execute_text(
            json!({
                "id": "soft-peer-assignment",
                "subject": "Manager attempted peer assignment",
                "owner_member_id": "peer"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["denied_target_member_ids"], json!(["peer"]));
    assert!(
        AgentOrgTaskStore::get("run-hierarchy-tools", "soft-peer-assignment")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn task_authority_member_cannot_create_cross_peer_candidate_pool() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx("m-alice"));
    let response = tool
        .execute_text(
            json!({
                "id": "cross-peer-pool",
                "subject": "Alice attempted a Bob candidate pool",
                "eligible_member_ids": ["m-bob"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_create.set_eligibility");
    assert!(AgentOrgTaskStore::get("run-tools-1", "cross-peer-pool")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn task_authority_only_coordinator_can_override_unlisted_open_work() {
    let _sandbox = task_tools_sandbox();
    let tool = ProductionTaskCreateTool::new(ctx("m-alice"));
    let response = tool
        .execute_text(
            json!({
                "subject": "Alice attempted global parallel override",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["not-yet-checked"],
                "execution_mode": "build",
                "allow_parallel_with_unlisted_open_tasks": true
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_create.override_unlisted_open_tasks");
    assert!(AgentOrgTaskStore::list("run-tools-1").unwrap().is_empty());
}

#[tokio::test]
async fn task_create_shared_agent_coordinator_member_id_explicitly_starts_work() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(shared_sde_ctx(Some(COORDINATOR_MEMBER_ID)));
    let res = tool
        .execute_text(
            json!({
                "subject": "Shared SDE coordinator explicit start",
                "status": "in_progress",
                "owner_member_id": "coordinator"
            }),
            &test_ctx(),
        )
        .await
        .expect("shared-agent coordinator task_create uses member_id only");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["status"].as_str().unwrap(), "in_progress");
    assert_eq!(value["task"]["owner"].as_str().unwrap(), "coordinator");
}

#[tokio::test]
async fn task_create_rejects_unknown_owner() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({ "subject": "S3", "owner_member_id": "ghost" }),
            &test_ctx(),
        )
        .await
        .expect_err("must reject unknown owner");
    assert!(matches!(err, ToolError::InvalidParams(_)));
}

#[tokio::test]
async fn task_create_rejects_dependency_cycle_as_invalid_params() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let err = tool
        .execute_text(
            json!({
                "id": "cycle-self",
                "subject": "S3-cycle",
                "eligible_member_ids": ["m-alice"],
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["cycle-self"]
            }),
            &test_ctx(),
        )
        .await
        .expect_err("must reject task dependency cycle");
    match err {
        ToolError::InvalidParams(msg) => assert!(msg.contains(TASK_DEPENDENCY_CYCLE_ERROR)),
        other => panic!("expected InvalidParams, got {other:?}"),
    }
}

#[tokio::test]
async fn task_update_rejects_dependency_cycle_as_invalid_params() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    create
        .execute_text(
            json!({
                "id": "first-cycle",
                "subject": "First",
                "eligible_member_ids": ["m-alice"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    create
        .execute_text(
            json!({ "id": "second-cycle", "subject": "Second", "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    update
        .execute_text(
            json!({ "id": "first-cycle", "blocks": ["second-cycle"] }),
            &test_ctx(),
        )
        .await
        .expect("first dependency edge is acyclic");
    let err = update
        .execute_text(
            json!({ "id": "second-cycle", "blocks": ["first-cycle"] }),
            &test_ctx(),
        )
        .await
        .expect_err("must reject task dependency cycle");
    match err {
        ToolError::InvalidParams(msg) => assert!(msg.contains(TASK_DEPENDENCY_CYCLE_ERROR)),
        other => panic!("expected InvalidParams, got {other:?}"),
    }
}

#[tokio::test]
async fn task_update_in_progress_without_owner_returns_structured_rejection() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    create
        .execute_text(
            json!({ "id": "coord-start", "subject": "Coordinator start", "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let response = update
        .execute_text(
            json!({ "id": "coord-start", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .expect("ownerless in_progress misuse returns correction guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["rejected"], true);
    assert_eq!(value["rejection_code"], "lifecycle_owner_only");
    assert_eq!(value["mutation_applied"], false);
    assert_eq!(value["task"]["status"], "pending");
}

#[tokio::test]
async fn task_update_coordinator_can_start_explicit_coordinator_task() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    create
        .execute_text(
            json!({
                "id": "coordinator-owned-start",
                "subject": "Coordinator owned start",
                "owner_member_id": "coordinator"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let res = update
        .execute_text(
            json!({ "id": "coordinator-owned-start", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .expect("coordinator starts explicitly owned task");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["status"].as_str().unwrap(), "in_progress");
    assert_eq!(value["task"]["owner"].as_str().unwrap(), "coordinator");
}

#[tokio::test]
async fn task_update_coordinator_cannot_start_member_task_in_progress() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    create
        .execute_text(
            json!({
                "id": "member-owned-start-attempt",
                "subject": "Member owned start attempt",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let response = update
        .execute_text(
            json!({ "id": "member-owned-start-attempt", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .expect("coordinator misuse returns structured correction guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["rejected"], true);
    assert_eq!(value["rejection_code"], "lifecycle_owner_only");
    assert_eq!(value["details"]["caller_member_id"], "coordinator");
    assert_eq!(value["details"]["owner_member_id"], "m-alice");
    assert_eq!(value["task"]["status"], "pending");
}

#[tokio::test]
async fn task_update_coordinator_cannot_complete_member_task() {
    let _sandbox = task_tools_sandbox();
    let coordinator = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&coordinator));
    create
        .execute_text(
            json!({
                "id": "member-owned-completion-attempt",
                "subject": "Member owned completion attempt",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(coordinator);
    let response = update
        .execute_text(
            json!({
                "id": "member-owned-completion-attempt",
                "status": "completed",
                "output": { "summary": "Coordinator guessed it was done" }
            }),
            &test_ctx(),
        )
        .await
        .expect("coordinator completion misuse returns structured guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["rejected"], true);
    assert_eq!(value["rejection_code"], "output_owner_only");
    assert_eq!(value["mutation_applied"], false);
    assert_eq!(
        AgentOrgTaskStore::get("run-tools-1", "member-owned-completion-attempt")
            .unwrap()
            .unwrap()
            .status
            .as_wire(),
        "pending"
    );
}

#[tokio::test]
async fn task_update_missing_output_summary_returns_structured_rejection() {
    let _sandbox = task_tools_sandbox();
    let create = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    create
        .execute_text(
            json!({
                "id": "missing-summary",
                "subject": "Write a durable result",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({
                "id": "missing-summary",
                "status": "completed",
                "output": { "content": "The full result exists, but its summary was omitted." }
            }),
            &test_ctx(),
        )
        .await
        .expect("missing summary is a recoverable rejection, not a tool error");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["rejected"], true);
    assert_eq!(value["rejection_code"], "missing_output_summary");
    assert_eq!(value["task"]["subject"], "Write a durable result");
    assert_eq!(value["task"]["status"], "pending");
    assert!(value["guidance"].as_str().unwrap().contains("summary"));
}

#[test]
fn task_update_schema_and_description_require_owner_authored_summary() {
    let tool = TaskUpdateTool::new(ctx(COORDINATOR_MEMBER_ID));
    let schema = tool.parameters();
    crate::tools::traits::assert_llm_compatible_schema(&schema)
        .expect("task_update schema must remain provider-compatible");
    let output_schema = &schema["properties"]["output"];
    let output_schema = output_schema
        .get("anyOf")
        .and_then(Value::as_array)
        .and_then(|variants| {
            variants
                .iter()
                .find(|variant| variant.get("properties").is_some())
        })
        .unwrap_or(output_schema);
    assert!(output_schema["required"]
        .as_array()
        .is_some_and(|required| required.iter().any(|field| field == "summary")));
    let description = tool.description();
    assert!(description.contains("only the current owner may set"));
    assert!(description.contains("summary` is required"));
}

#[tokio::test]
async fn task_update_member_cannot_start_other_member_task_in_progress() {
    let _sandbox = task_tools_sandbox();
    let coord = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&coord));
    create
        .execute_text(
            json!({
                "id": "bob-owned-start-attempt",
                "subject": "Bob owned start attempt",
                "owner_member_id": "m-bob"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let alice = ctx("m-alice");
    let update = TaskUpdateTool::new(Arc::clone(&alice));
    let response = update
        .execute_text(
            json!({ "id": "bob-owned-start-attempt", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .expect("authorization misuse returns structured guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_update.modify");
    assert_eq!(value["denied_target_member_ids"], json!(["m-bob"]));
}

#[tokio::test]
async fn task_authority_worker_cannot_delete_peer_task() {
    let _sandbox = task_tools_sandbox();
    let create = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    create
        .execute_text(
            json!({
                "id": "peer-delete-target",
                "subject": "Bob's protected task",
                "owner_member_id": "m-bob"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({ "id": "peer-delete-target", "status": "deleted" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_update.delete");
    assert!(AgentOrgTaskStore::get("run-tools-1", "peer-delete-target")
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn task_authority_worker_cannot_reassign_own_task_to_peer() {
    let _sandbox = task_tools_sandbox();
    let create = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    create
        .execute_text(
            json!({
                "id": "self-to-peer-reassign",
                "subject": "Alice's task",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({
                "id": "self-to-peer-reassign",
                "owner_member_id": "m-bob"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_update.reassign_owner");
    assert_eq!(
        AgentOrgTaskStore::get("run-tools-1", "self-to-peer-reassign")
            .unwrap()
            .unwrap()
            .owner
            .as_deref(),
        Some("m-alice")
    );
}

#[tokio::test]
async fn task_authority_worker_cannot_unassign_into_preserved_cross_peer_pool() {
    let _sandbox = task_tools_sandbox();
    let create = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    create
        .execute_text(
            json!({
                "id": "cross-peer-release",
                "subject": "Alice task with coordinator-approved backups",
                "owner_member_id": "m-alice",
                "eligible_member_ids": ["m-alice", "m-bob"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({ "id": "cross-peer-release", "owner_member_id": null }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(
        value["action"],
        "task_update.unassign_for_coordinator_assignment"
    );
    assert_eq!(value["denied_target_member_ids"], json!(["m-bob"]));
    assert_eq!(
        AgentOrgTaskStore::get("run-tools-1", "cross-peer-release")
            .unwrap()
            .unwrap()
            .owner
            .as_deref(),
        Some("m-alice")
    );
}

#[tokio::test]
async fn task_authority_manager_can_edit_direct_report_but_not_peer_task() {
    let _sandbox = task_tools_sandbox();
    let coordinator = ctx_for_org(
        hierarchical_org_context(HierarchyMode::Soft),
        COORDINATOR_MEMBER_ID,
    );
    let create = TaskCreateTool::new(coordinator);
    for (id, owner) in [("report-work", "report"), ("peer-work", "peer")] {
        create
            .execute_text(
                json!({ "id": id, "subject": id, "owner_member_id": owner }),
                &test_ctx(),
            )
            .await
            .unwrap();
    }

    let manager = TaskUpdateTool::new(ctx_for_org(
        hierarchical_org_context(HierarchyMode::Soft),
        "manager",
    ));
    let report_response = manager
        .execute_text(
            json!({
                "id": "report-work",
                "description": "Authorized manager clarification"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let report_value: Value = serde_json::from_str(&report_response).unwrap();
    assert_eq!(
        report_value["task"]["description"],
        "Authorized manager clarification"
    );

    let peer_response = manager
        .execute_text(
            json!({ "id": "peer-work", "description": "Unauthorized peer edit" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let peer_value: Value = serde_json::from_str(&peer_response).unwrap();
    assert_eq!(peer_value["authorization_denied"], true);
    assert_eq!(peer_value["denied_target_member_ids"], json!(["peer"]));
}

#[tokio::test]
async fn task_update_shared_agent_member_can_start_own_task() {
    let _sandbox = task_tools_sandbox();
    let coord = shared_sde_ctx(None);
    let create = TaskCreateTool::new(Arc::clone(&coord));
    create
        .execute_text(
            json!({
                "id": "shared-member-owned-start",
                "subject": "Shared member owned start",
                "owner_member_id": "sde-planner"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let planner = shared_sde_ctx(Some("sde-planner"));
    let update = TaskUpdateTool::new(Arc::clone(&planner));
    let res = update
        .execute_text(
            json!({ "id": "shared-member-owned-start", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .expect("shared-agent member starts own task");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["status"].as_str().unwrap(), "in_progress");
    assert_eq!(value["task"]["owner"].as_str().unwrap(), "sde-planner");
}

#[tokio::test]
async fn task_update_rejects_completed_to_in_progress_reopen() {
    let _sandbox = task_tools_sandbox();
    let tool = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    tool.execute_text(
        json!({
            "id": "completed-reopen",
            "subject": "Completed task",
            "owner_member_id": "m-alice",
        }),
        &test_ctx(),
    )
    .await
    .unwrap();
    let alice = ctx("m-alice");
    let update = TaskUpdateTool::new(Arc::clone(&alice));
    update
        .execute_text(
            json!({
                "id": "completed-reopen",
                "status": "completed",
                "output": { "summary": "Initial work completed" }
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let response = update
        .execute_text(
            json!({ "id": "completed-reopen", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .expect("completed-task reopen returns structured guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert!(value["status_ignored"].as_bool().unwrap());
    assert_eq!(value["task"]["status"], "completed");
    assert!(value["guidance"].as_str().unwrap().contains("follow-up"));
}

#[tokio::test]
async fn task_update_member_cannot_self_assign_ownerless_task() {
    let _sandbox = task_tools_sandbox();
    let coord = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&coord));
    create
        .execute_text(
            json!({ "id": "alice-start", "subject": "Alice start", "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let alice = ctx("m-alice");
    let update = TaskUpdateTool::new(Arc::clone(&alice));
    let res = update
        .execute_text(
            json!({
                "id": "alice-start",
                "owner_member_id": "m-alice",
                "status": "in_progress"
            }),
            &test_ctx(),
        )
        .await
        .expect("ownerless self-assignment returns structured guidance");
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_update.assign_ownerless");
    let task = AgentOrgTaskStore::get("run-tools-1", "alice-start")
        .unwrap()
        .unwrap();
    assert_eq!(task.owner, None);
    assert_eq!(task.status, TaskStatus::Pending);
}

#[tokio::test]
async fn task_update_ownerless_self_assignment_is_denied_before_dependency_mutation() {
    let _sandbox = task_tools_sandbox();
    let coordinator = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    coordinator
        .execute_text(
            json!({
                "id": "manual-claim-blocker",
                "subject": "Produce upstream result",
                "owner_member_id": "m-bob"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    coordinator
        .execute_text(
            json!({
                "id": "manual-claim-blocked",
                "subject": "Consume upstream result",
                "eligible_member_ids": ["m-alice", "m-bob"],
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["manual-claim-blocker"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({
                "id": "manual-claim-blocked",
                "owner_member_id": "m-alice",
                "status": "in_progress"
            }),
            &test_ctx(),
        )
        .await
        .expect("ownerless self-assignment returns structured guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_update.assign_ownerless");
}

#[tokio::test]
async fn task_update_ownerless_self_assignment_is_denied_even_when_member_is_busy() {
    let _sandbox = task_tools_sandbox();
    let coordinator = TaskCreateTool::new(ctx(COORDINATOR_MEMBER_ID));
    coordinator
        .execute_text(
            json!({
                "id": "manual-claim-current",
                "subject": "Alice current work",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    TaskUpdateTool::new(ctx("m-alice"))
        .execute_text(
            json!({ "id": "manual-claim-current", "status": "in_progress" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    coordinator
        .execute_text(
            json!({
                "id": "manual-claim-second",
                "subject": "Another shared task",
                "eligible_member_ids": ["m-alice", "m-bob"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({
                "id": "manual-claim-second",
                "owner_member_id": "m-alice",
                "status": "in_progress"
            }),
            &test_ctx(),
        )
        .await
        .expect("ownerless self-assignment returns structured guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["authorization_denied"], true);
    assert_eq!(value["action"], "task_update.assign_ownerless");
}

#[tokio::test]
async fn task_update_reassign_dispatches_inbox() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    let res = create
        .execute_text(
            json!({ "subject": "S4", "owner_member_id": "m-alice" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let task_id = serde_json::from_str::<Value>(&res).unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let res = update
        .execute_text(
            json!({ "id": task_id, "owner_member_id": "m-bob" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert!(value["owner_changed"].as_bool().unwrap());
    assert!(value["task_assigned_dispatched"].as_bool().unwrap());
    let bob_inbox = AgentInboxStore::list_unread_for_member("m-bob", "run-tools-1").unwrap();
    assert_eq!(bob_inbox.len(), 1);
}

#[tokio::test]
async fn task_create_blocked_assigned_task_does_not_dispatch_until_unblocked() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    create
        .execute_text(
            json!({ "id": "blocker-task", "subject": "Blocker", "owner_member_id": "coordinator" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let blocked = create
        .execute_text(
            json!({
                "id": "blocked-task",
                "subject": "Blocked work",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["blocker-task"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let blocked_value: Value = serde_json::from_str(&blocked).unwrap();
    assert!(!blocked_value["task_assigned_dispatched"].as_bool().unwrap());
    let alice_before = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1").unwrap();
    assert!(alice_before.is_empty());

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let completed = update
        .execute_text(
            json!({
                "id": "blocker-task",
                "status": "completed",
                "output": { "summary": "Blocker result", "content": "Durable input for Alice" }
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let completed_value: Value = serde_json::from_str(&completed).unwrap();
    assert_eq!(
        completed_value["unblocked_task_assigned_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["blocked-task"]
    );
    let alice_after = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1").unwrap();
    assert_eq!(alice_after.len(), 1);
}

#[tokio::test]
async fn completing_upstream_task_delivers_durable_output_to_downstream_member() {
    let _sandbox = task_tools_sandbox();
    let wake_hook = Arc::new(RecordingWakeHook::default());
    let coordinator = ctx_with_wake(COORDINATOR_MEMBER_ID, wake_hook.clone());
    let create = TaskCreateTool::new(Arc::clone(&coordinator));
    create
        .execute_text(
            json!({
                "id": "draft-task",
                "subject": "Write the draft",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    create
        .execute_text(
            json!({
                "id": "review-task",
                "subject": "Review the draft",
                "owner_member_id": "m-bob",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["draft-task"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let alice = ctx_with_wake("m-alice", wake_hook.clone());
    let update = TaskUpdateTool::new(alice);
    let response = update
        .execute_text(
            json!({
                "id": "draft-task",
                "status": "completed",
                "output": {
                    "summary": "Eight episode summaries drafted",
                    "content": "Episode 1 ... Episode 8 ...",
                    "artifact_ids": ["artifact://dragon-draft"]
                }
            }),
            &test_ctx(),
        )
        .await
        .expect("upstream completion succeeds");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(
        value["task"]["output"]["summary"],
        "Eight episode summaries drafted"
    );
    assert!(value["task_completed_notified"].as_bool().unwrap());

    let bob_inbox = AgentInboxStore::list_unread_for_member("m-bob", "run-tools-1").unwrap();
    assert_eq!(bob_inbox.len(), 1);
    match bob_inbox[0]
        .decode_payload()
        .expect("decode downstream assignment")
    {
        AgentMessage::TaskAssigned {
            task_id,
            dependency_outputs,
            ..
        } => {
            assert_eq!(task_id, "review-task");
            assert_eq!(dependency_outputs.len(), 1);
            assert_eq!(dependency_outputs[0].task_id, "draft-task");
            assert_eq!(
                dependency_outputs[0].content.as_deref(),
                Some("Episode 1 ... Episode 8 ...")
            );
        }
        other => panic!("expected downstream TaskAssigned, got {other:?}"),
    }

    let coordinator_inbox =
        AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, "run-tools-1").unwrap();
    assert!(coordinator_inbox.iter().any(|row| matches!(
        row.decode_payload(),
        Ok(AgentMessage::TaskCompleted { ref task_id, .. }) if task_id == "draft-task"
    )));
    let wakes = wake_hook.snapshot();
    assert!(wakes.contains(&("m-bob".to_string(), "run-tools-1".to_string())));
    assert!(wakes.contains(&(COORDINATOR_MEMBER_ID.to_string(), "run-tools-1".to_string())));
}

#[tokio::test]
async fn three_stage_dependency_chain_dispatches_one_stage_at_a_time() {
    let _sandbox = task_tools_sandbox();
    let coordinator = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&coordinator));

    create
        .execute_text(
            json!({
                "id": "implement-stage",
                "subject": "Write the episode summaries",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    create
        .execute_text(
            json!({
                "id": "review-stage",
                "subject": "Review the episode summaries",
                "owner_member_id": "m-bob",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["implement-stage"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    create
        .execute_text(
            json!({
                "id": "test-stage",
                "subject": "Verify the reviewed result",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["review-stage"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let initial_alice = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
        .unwrap()
        .into_iter()
        .filter_map(|row| row.decode_payload().ok())
        .filter_map(|message| match message {
            AgentMessage::TaskAssigned { task_id, .. } => Some(task_id),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(initial_alice, vec!["implement-stage"]);
    assert!(
        AgentInboxStore::list_unread_for_member("m-bob", "run-tools-1")
            .unwrap()
            .is_empty()
    );

    let implementer = TaskUpdateTool::new(ctx("m-alice"));
    let implement_result = implementer
        .execute_text(
            json!({
                "id": "implement-stage",
                "status": "completed",
                "output": { "summary": "Draft complete", "content": "Draft text" }
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let implement_value: Value = serde_json::from_str(&implement_result).unwrap();
    assert_eq!(
        implement_value["unblocked_task_assigned_ids"],
        json!(["review-stage"])
    );

    let reviewer = TaskUpdateTool::new(ctx("m-bob"));
    let review_result = reviewer
        .execute_text(
            json!({
                "id": "review-stage",
                "status": "completed",
                "output": { "summary": "Review complete", "content": "Approved draft" }
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let review_value: Value = serde_json::from_str(&review_result).unwrap();
    assert_eq!(
        review_value["unblocked_task_assigned_ids"],
        json!(["test-stage"])
    );

    let alice_assignments = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
        .unwrap()
        .into_iter()
        .filter_map(|row| row.decode_payload().ok())
        .filter_map(|message| match message {
            AgentMessage::TaskAssigned {
                task_id,
                dependency_outputs,
                ..
            } => Some((task_id, dependency_outputs)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(alice_assignments.len(), 2);
    assert_eq!(alice_assignments[1].0, "test-stage");
    assert_eq!(alice_assignments[1].1.len(), 1);
    assert_eq!(alice_assignments[1].1[0].task_id, "review-stage");
    assert_eq!(
        alice_assignments[1].1[0].content.as_deref(),
        Some("Approved draft")
    );
}

#[tokio::test]
async fn every_task_completion_requires_durable_output() {
    let _sandbox = task_tools_sandbox();
    let coordinator = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&coordinator));
    create
        .execute_text(
            json!({
                "id": "source-without-output",
                "subject": "Produce source",
                "owner_member_id": "m-alice"
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    create
        .execute_text(
            json!({
                "id": "consumer",
                "subject": "Consume source",
                "owner_member_id": "m-bob",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["source-without-output"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();

    let update = TaskUpdateTool::new(ctx("m-alice"));
    let response = update
        .execute_text(
            json!({ "id": "source-without-output", "status": "completed" }),
            &test_ctx(),
        )
        .await
        .expect("missing output returns recoverable guidance");
    let value: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(value["rejected"], true);
    assert_eq!(value["rejection_code"], "completion_requires_output");
    assert_eq!(value["mutation_applied"], false);
    assert_eq!(value["task"]["status"], "pending");
    assert!(
        AgentInboxStore::list_unread_for_member("m-bob", "run-tools-1")
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn task_update_clearing_blockers_on_assigned_pending_dispatches_once() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    create
        .execute_text(
            json!({ "id": "manual-blocker", "subject": "Manual blocker", "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();
    create
        .execute_text(
            json!({
                "id": "manually-unblocked",
                "subject": "Manual unblock",
                "owner_member_id": "m-alice",
                "dispatch_policy": "after_dependencies",
                "dependency_task_ids": ["manual-blocker"]
            }),
            &test_ctx(),
        )
        .await
        .unwrap();
    assert!(
        AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
            .unwrap()
            .is_empty()
    );

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let res = update
        .execute_text(
            json!({ "id": "manually-unblocked", "blocked_by": [] }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert!(value["task_assigned_dispatched"].as_bool().unwrap());
    assert_eq!(
        AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
            .unwrap()
            .len(),
        1
    );

    let repeat = update
        .execute_text(
            json!({ "id": "manually-unblocked", "description": "metadata update" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let repeat_value: Value = serde_json::from_str(&repeat).unwrap();
    assert!(!repeat_value["task_assigned_dispatched"].as_bool().unwrap());
    assert_eq!(
        AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn task_update_unassign_does_not_dispatch_inbox() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    let res = create
        .execute_text(
            json!({ "subject": "S5", "owner_member_id": "m-alice" }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let task_id = serde_json::from_str::<Value>(&res).unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let before = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
        .unwrap()
        .len();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let res = update
        .execute_text(
            json!({ "id": task_id, "owner_member_id": null, "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert!(value["owner_changed"].as_bool().unwrap());
    assert!(!value["task_assigned_dispatched"].as_bool().unwrap());
    let after = AgentInboxStore::list_unread_for_member("m-alice", "run-tools-1")
        .unwrap()
        .len();
    assert_eq!(before, after);
}

#[tokio::test]
async fn task_update_status_deleted_removes_row() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    let res = create
        .execute_text(
            json!({ "subject": "S6", "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let task_id = serde_json::from_str::<Value>(&res).unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let update = TaskUpdateTool::new(Arc::clone(&ctx));
    let res = update
        .execute_text(json!({ "id": task_id, "status": "deleted" }), &test_ctx())
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert!(value["deleted"].as_bool().unwrap());
    assert!(AgentOrgTaskStore::get("run-tools-1", &task_id)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn task_list_filters_by_owner_and_mine() {
    let _sandbox = task_tools_sandbox();
    let coord = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&coord));
    for (subject, owner) in [("L1", Some("m-alice")), ("L2", Some("m-bob")), ("L3", None)] {
        let mut req = json!({ "subject": subject });
        if let Some(o) = owner {
            req["owner_member_id"] = json!(o);
        } else {
            req["eligible_member_ids"] = json!(["m-alice"]);
        }
        create.execute_text(req, &test_ctx()).await.unwrap();
    }
    let coord_list = TaskListTool::new(Arc::clone(&coord));
    let res = coord_list
        .execute_text(json!({}), &test_ctx())
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["total"].as_u64().unwrap(), 3);
    let res = coord_list
        .execute_text(json!({ "owner_member_id": "m-alice" }), &test_ctx())
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["total"].as_u64().unwrap(), 1);
    assert_eq!(value["filtered_total"].as_u64().unwrap(), 1);
    assert_eq!(value["run_summary"]["total"].as_u64().unwrap(), 3);
    assert_eq!(value["run_summary"]["open"].as_u64().unwrap(), 3);
    // Alice only sees her tasks via mine_only.
    let alice = ctx("m-alice");
    let alice_list = TaskListTool::new(alice);
    let res = alice_list
        .execute_text(json!({ "mine_only": true }), &test_ctx())
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["total"].as_u64().unwrap(), 1);
}

#[tokio::test]
async fn task_list_completion_certificate_blocks_while_reviewer_is_running() {
    let _sandbox = task_tools_sandbox();
    let now = chrono::Utc::now().to_rfc3339();
    let conn = database::db::get_connection().unwrap();
    conn.execute(
        "INSERT INTO agent_org_runs
         (id, org_id, coordinator_agent_id, root_session_id, entry_mode, status, created_at, updated_at)
         VALUES ('run-tools-1', 'org-tools-1', 'coord-1', 'root-tools-1', 'standalone_session', 'running', ?1, ?1)",
        rusqlite::params![now],
    )
    .unwrap();
    for record in [
        UnifiedSessionRecord {
            session_id: "root-tools-1".to_string(),
            name: "Coordinator".to_string(),
            status: "running".to_string(),
            session_type: "agent".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            ..Default::default()
        },
        UnifiedSessionRecord {
            session_id: "reviewer-session".to_string(),
            name: "Reviewer".to_string(),
            status: "running".to_string(),
            session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
            parent_session_id: Some("root-tools-1".to_string()),
            agent_definition_id: Some("reviewer-agent".to_string()),
            org_member_id: Some("m-alice".to_string()),
            created_at: now.clone(),
            updated_at: now.clone(),
            ..Default::default()
        },
    ] {
        upsert_session(&record).unwrap();
    }
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "finished-task".to_string(),
        org_run_id: "run-tools-1".to_string(),
        subject: "Finished producer".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("m-bob".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .unwrap();

    let list = TaskListTool::new(ctx(COORDINATOR_MEMBER_ID));
    let result = list
        .execute_text(json!({ "status": "" }), &test_ctx())
        .await
        .expect("blank optional filter is ignored");
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["run_summary"]["open"], 0);
    assert_eq!(value["run_summary"]["completion_ready"], false);
    assert_eq!(
        value["run_summary"]["active_member_ids"],
        json!(["m-alice"])
    );
    assert!(value["run_summary"]["completion_blockers"]
        .as_array()
        .unwrap()
        .contains(&json!("active_members")));

    conn.execute(
        "UPDATE agent_sessions SET status='idle', updated_at=?2 WHERE session_id=?1",
        rusqlite::params!["reviewer-session", chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_turn_intents
         (session_id, turn_intent_id, source, status, created_at, updated_at)
         VALUES (?1, 'queued-review', 'agent_org_wake', 'queued', ?2, ?2)",
        rusqlite::params!["reviewer-session", chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();
    let result = list.execute_text(json!({}), &test_ctx()).await.unwrap();
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["run_summary"]["completion_ready"], false);
    assert_eq!(value["run_summary"]["pending_worker_turn_intent_count"], 1);
    assert!(value["run_summary"]["completion_blockers"]
        .as_array()
        .unwrap()
        .contains(&json!("pending_worker_turn_intent")));

    conn.execute(
        "UPDATE session_turn_intents SET status='completed', updated_at=?2
         WHERE session_id=?1 AND turn_intent_id='queued-review'",
        rusqlite::params!["reviewer-session", chrono::Utc::now().to_rfc3339()],
    )
    .unwrap();
    let result = list.execute_text(json!({}), &test_ctx()).await.unwrap();
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["run_summary"]["completion_ready"], true);
    assert_eq!(value["run_summary"]["completion_blockers"], json!([]));
}

#[tokio::test]
async fn task_get_returns_full_row() {
    let _sandbox = task_tools_sandbox();
    let ctx = ctx(COORDINATOR_MEMBER_ID);
    let create = TaskCreateTool::new(Arc::clone(&ctx));
    let res = create
        .execute_text(
            json!({ "subject": "G1", "description": "details", "eligible_member_ids": ["m-alice"] }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let task_id = serde_json::from_str::<Value>(&res).unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let get = TaskGetTool::new(Arc::clone(&ctx));
    let res = get
        .execute_text(json!({ "id": task_id }), &test_ctx())
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&res).unwrap();
    assert_eq!(value["task"]["subject"], "G1");
    assert_eq!(value["task"]["description"], "details");
}
