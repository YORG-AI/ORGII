use std::path::PathBuf;

use database::db::get_connection;
use rusqlite::params;

use super::*;
use super::{
    AgentOrgPlanDecisionDelivery as AgentOrgPlanInboxDelivery,
    AgentOrgPlanDecisionStatus as AgentOrgPlanApprovalStatus,
    AgentOrgPlanRevision as AgentOrgPlanApproval,
    AgentOrgPlanRevisionStore as AgentOrgPlanApprovalStore,
    CreateAgentOrgPlanRevisionParams as CreateAgentOrgPlanApprovalParams,
};
use crate::coordination::agent_inbox::AgentInboxStore;
use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunEntryMode, AgentOrgRunStatus,
    AgentOrgRunStore, CreateAgentOrgRunParams, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskGraphWriterAdmin, TaskStatus, TaskTerminalReason,
    TASK_METADATA_EXECUTION_MODE,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition};

mod approval_flow_tests;
mod decision_atomicity_tests;
mod formal_receipt_tests;
mod immutable_revision_tests;
mod pause_resume_tests;
mod persistence_boundary_tests;
mod projection_tests;
mod request_changes_tests;

fn setup(policy: PlanApprovalPolicy) -> (test_helpers::test_env::SandboxGuard, AgentOrgRunContext) {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("test db");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    conn.execute_batch(
        "CREATE TABLE session_turn_intents (
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
    crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
    crate::coordination::agent_org_turn_contexts::create_schema(&conn)
        .expect("Agent Org Turn context schema");
    crate::coordination::agent_org_pause::create_schema(&conn).expect("Agent Org Pause schema");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("inbox schema");
    crate::coordination::agent_org_formal_triggers::create_schema(&conn)
        .expect("FormalTriggerReceipt schema");
    init_schema(&conn).expect("approval schema");
    let workspace = sandbox.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("create planner workspace");
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: "planner-session".into(),
            name: "Planner".into(),
            status: crate::session::SessionStatus::Idle.as_str().into(),
            created_at: now.clone(),
            updated_at: now,
            session_type: crate::session::persistence::session_type::ORG_MEMBER.into(),
            workspace_path: Some(workspace.to_string_lossy().into_owned()),
            agent_definition_id: Some("planner-agent".into()),
            org_member_id: Some("planner".into()),
            parent_session_id: Some("root-plan-approval".into()),
            ..Default::default()
        },
    )
    .expect("upsert planner session");

    let org = OrgDefinition {
        id: "org-plan-approval".into(),
        name: "Plan Approval Org".into(),
        role: "lead".into(),
        agent_id: "coord-agent".into(),
        description: None,
        plan_approval_policy: policy,
        members: vec![
            FlatOrgMember {
                member_id: "planner".into(),
                name: "Planner".into(),
                role: "plan".into(),
                agent_id: "planner-agent".into(),
                runtime_config: None,
            },
            FlatOrgMember {
                member_id: "builder".into(),
                name: "Builder".into(),
                role: "build".into(),
                agent_id: "builder-agent".into(),
                runtime_config: None,
            },
        ],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some("root-plan-approval".into()),
        org_snapshot: (&org).into(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run");
    let context = AgentOrgRunContext {
        run_id: run.id,
        org_id: "org-plan-approval".into(),
        org_name: "Plan Approval Org".into(),
        org_role: "lead".into(),
        coordinator_agent_id: "coord-agent".into(),
        coordinator_name: "Coordinator".into(),
        coordinator_role: "lead".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: "planner".into(),
                name: "Planner".into(),
                role: "plan".into(),
                agent_id: "planner-agent".into(),
            },
            AgentOrgContextMember {
                member_id: "builder".into(),
                name: "Builder".into(),
                role: "build".into(),
                agent_id: "builder-agent".into(),
            },
        ],
        plan_approval_policy: policy,
        capability_index: Default::default(),
        root_session_id: Some("root-plan-approval".into()),
    };
    let conn = get_connection().expect("Coordinator context database");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('root-plan-approval','coordinator-turn',?1,'agent_org','running',?2,?2)",
        params![&context.run_id, &now],
    )
    .expect("persist Coordinator Turn intent");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            source_kind,source_id,activation_generation,created_at
         ) VALUES ('root-plan-approval','coordinator-turn',?1,'coordinator','coordinator',
                   'root_turn','coordinator-turn',1,?2)",
        params![&context.run_id, &now],
    )
    .expect("persist Coordinator Turn context");
    (sandbox, context)
}

fn create_plan_task(context: &AgentOrgRunContext) {
    create_plan_task_with_ids(context, "plan-task", "planner-turn", 1);
}

fn create_plan_task_with_ids(
    context: &AgentOrgRunContext,
    task_id: &str,
    turn_intent_id: &str,
    dispatch_sequence: i64,
) {
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.into(),
        org_run_id: context.run_id.clone(),
        subject: format!("Plan the work: {task_id}"),
        description: "Produce a plan".into(),
        active_form: None,
        owner: Some("planner".into()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "plan" })),
    })
    .expect("create plan task");
    let conn = get_connection().expect("plan Task context database");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('planner-session',?1,?2,'agent_org','running',?3,?3)",
        params![turn_intent_id, &context.run_id, &now],
    )
    .expect("persist planning Turn intent");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (
            'planner-session',?1,?2,'planner','task_execution',
            ?3,'planner','planner',?4,'task',?3,1,?5
         )",
        params![
            turn_intent_id,
            &context.run_id,
            task_id,
            dispatch_sequence,
            &now
        ],
    )
    .expect("persist planning TaskExecution context");
}

fn approval_params(context: &AgentOrgRunContext) -> CreateAgentOrgPlanApprovalParams {
    approval_params_with_ids(context, "plan-task", "planner-turn", "request-plan")
}

fn approval_params_with_ids(
    context: &AgentOrgRunContext,
    task_id: &str,
    turn_intent_id: &str,
    request_id: &str,
) -> CreateAgentOrgPlanApprovalParams {
    CreateAgentOrgPlanApprovalParams {
        request_id: request_id.into(),
        org_run_id: context.run_id.clone(),
        source_task_id: task_id.into(),
        source_member_id: "planner".into(),
        source_session_id: "planner-session".into(),
        source_turn_intent_id: turn_intent_id.into(),
        root_session_id: "root-plan-approval".into(),
        policy: context.plan_approval_policy,
        plan_title: format!("Implementation plan: {task_id}"),
        plan_path: AgentOrgPlanApprovalStore::managed_plan_path_for_session(
            "planner-session",
            &format!("{}.plan.md", uuid::Uuid::new_v4()),
        )
        .expect("managed planner plan path")
        .to_string_lossy()
        .into_owned(),
        plan_content: "# Plan\n\n1. Build it.".into(),
    }
}

fn create_pending_approval(context: &AgentOrgRunContext) -> AgentOrgPlanApproval {
    AgentOrgPlanApprovalStore::create_pending(approval_params(context)).expect("create approval")
}

fn planner_changes_delivery() -> AgentOrgPlanInboxDelivery {
    AgentOrgPlanInboxDelivery {
        recipient_agent_id: "planner-agent".into(),
        sender_agent_id: "coord-agent".into(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
    }
}

fn coordinator_request_delivery() -> AgentOrgPlanInboxDelivery {
    AgentOrgPlanInboxDelivery {
        recipient_agent_id: "coord-agent".into(),
        sender_agent_id: "planner-agent".into(),
        sender_member_id: Some("planner".into()),
    }
}
