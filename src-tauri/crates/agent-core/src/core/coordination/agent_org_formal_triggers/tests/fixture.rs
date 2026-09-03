use database::db::get_connection;
use rusqlite::params;

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    COORDINATOR_MEMBER_ID,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};

pub(super) struct FormalFixture {
    _sandbox: test_helpers::test_env::SandboxGuard,
    pub(super) run_id: String,
}

impl FormalFixture {
    pub(super) fn new() -> Self {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("formal trigger fixture database");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::session::persistence::init(&conn).expect("session schema");
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
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");

        let org = OrgDefinition {
            id: "formal-trigger-org".into(),
            name: "Formal Trigger Org".into(),
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
            root_session_id: Some("formal-root".into()),
            org_snapshot: (&org).into(),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("formal trigger run");
        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: "formal-root".into(),
                name: "Coordinator".into(),
                status: crate::session::SessionStatus::Idle.as_str().into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                session_type: crate::session::persistence::session_type::ORG_MEMBER.into(),
                agent_definition_id: Some("coordinator-agent".into()),
                org_member_id: Some(COORDINATOR_MEMBER_ID.into()),
                ..Default::default()
            },
        )
        .expect("Coordinator Session");
        conn.execute(
            "INSERT INTO agent_org_runtime_member_materializations(
                org_run_id,member_id,agent_id,generation,session_id,
                authority_class,status,created_at,updated_at
             ) VALUES (?1,'coordinator','coordinator-agent',1,'formal-root',
                       'formal','succeeded',?2,?2)",
            params![&run.id, &now],
        )
        .expect("Coordinator materialization");
        Self {
            _sandbox: sandbox,
            run_id: run.id,
        }
    }

    pub(super) fn admit_coordinator_turn(&self, turn_intent_id: &str) {
        let conn = get_connection().expect("formal trigger fixture database");
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO session_turn_intents(
                session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
             ) VALUES ('formal-root',?1,?2,'agent_org','running',?3,?3)",
            params![turn_intent_id, &self.run_id, &now],
        )
        .expect("Coordinator Turn intent");
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts(
                session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
                source_kind,source_id,activation_generation,created_at
             ) VALUES ('formal-root',?1,?2,'coordinator','coordinator',
                       'root_turn',?1,1,?3)",
            params![turn_intent_id, &self.run_id, &now],
        )
        .expect("Coordinator Turn context");
    }

    pub(super) fn insert_task_output(&self, suffix: &str) -> AgentInboxRecord {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "coordinator-agent".into(),
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
            sender_agent_id: SYSTEM_SENDER_ID.into(),
            sender_member_id: Some("worker".into()),
            org_run_id: Some(self.run_id.clone()),
            message: AgentMessage::TaskCompleted {
                task_id: format!("task-{suffix}"),
                subject: format!("Task {suffix}"),
                completed_by_member_id: "worker".into(),
                output_summary: Some(format!("Output {suffix}")),
                plan_revision_id: None,
                remaining_open_task_count: 0,
            },
        })
        .expect("insert formal TaskOutput")
    }

    pub(super) fn insert_task_outputs(&self, count: usize) {
        let mut conn = get_connection().expect("formal trigger fixture database");
        let tx = conn
            .transaction()
            .expect("formal trigger scale transaction");
        for index in 0..count {
            AgentInboxStore::insert_in_tx(
                &tx,
                InsertInboxParams {
                    recipient_agent_id: "coordinator-agent".into(),
                    recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
                    sender_agent_id: SYSTEM_SENDER_ID.into(),
                    sender_member_id: Some("worker".into()),
                    org_run_id: Some(self.run_id.clone()),
                    message: AgentMessage::TaskCompleted {
                        task_id: format!("scale-task-{index:04}"),
                        subject: format!("Scale task {index:04}"),
                        completed_by_member_id: "worker".into(),
                        output_summary: Some(format!("Scale output {index:04}")),
                        plan_revision_id: None,
                        remaining_open_task_count: 0,
                    },
                },
            )
            .expect("insert scale formal TaskOutput");
        }
        tx.commit().expect("commit formal trigger scale fixture");
    }

    pub(super) fn insert_plain_narration(&self) -> AgentInboxRecord {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "coordinator-agent".into(),
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.into()),
            sender_agent_id: "worker-agent".into(),
            sender_member_id: Some("worker".into()),
            org_run_id: Some(self.run_id.clone()),
            message: AgentMessage::Plain {
                summary: "Routine progress".into(),
                text: "Still working".into(),
            },
        })
        .expect("insert routine narration")
    }
}
