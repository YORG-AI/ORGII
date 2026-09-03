use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, MemberIdleReason, SYSTEM_SENDER_ID,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};

use super::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    COORDINATOR_MEMBER_ID,
};

fn create_run() -> (test_helpers::test_env::SandboxGuard, String) {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("blocking Inbox fixture database");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::session::persistence::init(&conn).expect("Session lifecycle schema");
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
        );
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL
        );",
    )
    .expect("Turn intent schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    let org = OrgDefinition {
        id: "blocking-inbox-org".into(),
        name: "Blocking Inbox Org".into(),
        role: "lead".into(),
        agent_id: "coordinator-agent".into(),
        description: None,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![FlatOrgMember {
            member_id: "worker".into(),
            name: "Worker".into(),
            role: "build".into(),
            agent_id: "worker-agent".into(),
            runtime_config: None,
        }],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some("blocking-inbox-root".into()),
        org_snapshot: (&org).into(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("Agent Org run");
    (sandbox, run.id)
}

#[test]
fn routine_member_idle_stays_visible_without_blocking_formal_convergence() {
    let (_sandbox, run_id) = create_run();
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coordinator-agent".into(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        sender_agent_id: SYSTEM_SENDER_ID.into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::MemberIdle {
            member_id: "worker".into(),
            member_name: "Worker".into(),
            reason: MemberIdleReason::Available,
            current_mode: None,
            summary: None,
            failure_reason: None,
            unfinished_task_ids: Vec::new(),
        },
    })
    .expect("routine MemberIdle");

    let conn = database::db::get_connection().unwrap();
    let routine = AgentOrgRunStore::quiescence_assessment_with_connection(&conn, &run_id).unwrap();
    assert_eq!(routine.facts.unread_inbox_count, 1);
    assert_eq!(routine.facts.blocking_unread_inbox_count, 0);

    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coordinator-agent".into(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        sender_agent_id: SYSTEM_SENDER_ID.into(),
        sender_member_id: Some("worker".into()),
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::TaskCompleted {
            task_id: "task-output".into(),
            subject: "Actionable output".into(),
            completed_by_member_id: "worker".into(),
            output_summary: Some("done".into()),
            plan_revision_id: None,
            remaining_open_task_count: 0,
        },
    })
    .expect("formal TaskOutput");

    let actionable =
        AgentOrgRunStore::quiescence_assessment_with_connection(&conn, &run_id).unwrap();
    assert_eq!(actionable.facts.unread_inbox_count, 2);
    assert_eq!(actionable.facts.blocking_unread_inbox_count, 1);
}
