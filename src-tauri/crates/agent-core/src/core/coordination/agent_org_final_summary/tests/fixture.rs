use database::db::get_connection;
use rusqlite::params;
use sha2::Digest;

use crate::coordination::agent_org_run_completion::{
    RunCompletionCertificate, RunCompletionOutcome, RunCompletionResolutionKind,
    RunCompletionResolutionLink, RunCompletionTaskOutputRef,
};
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::coordination::agent_org_tasks::TaskOutput;
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};

pub(super) struct SummaryFixture {
    _sandbox: test_helpers::test_env::SandboxGuard,
    pub(super) run_id: String,
    pub(super) certificate: RunCompletionCertificate,
}

impl SummaryFixture {
    pub(super) fn new() -> Self {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("final summary fixture database");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::session::persistence::init(&conn).expect("session schema");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                function_name TEXT,
                thread_id TEXT,
                args_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                meta_json TEXT,
                history_sequence INTEGER,
                UNIQUE(id,session_id)
            );",
        )
        .expect("EventStore schema");
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");

        let org = OrgDefinition {
            id: "final-summary-org".into(),
            name: "Final Summary Org".into(),
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
            root_session_id: Some("summary-root".into()),
            org_snapshot: (&org).into(),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("final summary run");
        let now = chrono::Utc::now().to_rfc3339();
        let output = TaskOutput {
            summary: "Verified implementation".into(),
            content: Some("All owning-boundary tests passed.".into()),
            artifact_ids: vec!["artifact://verification-report".into()],
            plan_revision_id: None,
            produced_by_member_id: "worker".into(),
            produced_at: now.clone(),
        };
        conn.execute(
            "INSERT INTO agent_org_runtime_tasks(
                id,org_run_id,activation_generation,subject,description,owner,status,
                execution_mode,blocked_by_json,output_json,created_by_participant_id,
                source_turn_intent_id,created_at,updated_at
             ) VALUES ('report-task',?1,1,'Verification report','', 'worker','completed',
                       'build','[]',?2,'coordinator','coordinator-turn',?3,?3)",
            params![&run.id, serde_json::to_string(&output).unwrap(), &now],
        )
        .expect("completed evidence Task");
        let output_ref = RunCompletionTaskOutputRef {
            task_id: "report-task".into(),
            output_digest: format!(
                "{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&output).unwrap())
            ),
        };
        let resolution = RunCompletionResolutionLink {
            task_id: "report-task".into(),
            kind: RunCompletionResolutionKind::CompletedOutput,
            resolved_by_task_id: Some("report-task".into()),
            source_event_id: None,
        };
        let certificate = RunCompletionCertificate {
            id: "certificate-one".into(),
            org_run_id: run.id.clone(),
            activation_generation: 1,
            work_revision: 1,
            request_id: "completion-request".into(),
            request_digest: "b".repeat(64),
            outcome: RunCompletionOutcome::Delivered,
            summary: "Deliver the certified implementation and verification report.".into(),
            coordinator_session_id: "summary-root".into(),
            coordinator_turn_intent_id: "completion-turn".into(),
            evidence_task_ids: vec!["report-task".into()],
            closure_task_ids: vec!["report-task".into()],
            task_output_refs: vec![output_ref],
            resolution_links: vec![resolution],
            validator_version: 1,
            created_at: now.clone(),
        };
        conn.execute(
            "INSERT INTO agent_org_runtime_run_completion_certificates(
                id,org_run_id,activation_generation,work_revision,request_id,request_digest,
                outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
                evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
                resolution_links_json,validator_version,created_at
             ) VALUES (?1,?2,1,1,?3,?4,'delivered',?5,?6,?7,?8,?9,?10,?11,1,?12)",
            params![
                &certificate.id,
                &certificate.org_run_id,
                &certificate.request_id,
                &certificate.request_digest,
                &certificate.summary,
                &certificate.coordinator_session_id,
                &certificate.coordinator_turn_intent_id,
                serde_json::to_string(&certificate.evidence_task_ids).unwrap(),
                serde_json::to_string(&certificate.closure_task_ids).unwrap(),
                serde_json::to_string(&certificate.task_output_refs).unwrap(),
                serde_json::to_string(&certificate.resolution_links).unwrap(),
                &certificate.created_at,
            ],
        )
        .expect("completion certificate");
        Self {
            _sandbox: sandbox,
            run_id: run.id,
            certificate,
        }
    }

    pub(super) fn create_receipt(&self) -> super::super::FinalSummaryReceipt {
        let conn = get_connection().expect("final summary fixture database");
        super::super::create_initial_for_certificate_in_tx(&conn, &self.certificate)
            .expect("initial FinalSummaryReceipt")
    }

    pub(super) fn claim(&self, turn_intent_id: &str) -> super::super::FinalSummaryReceipt {
        let conn = get_connection().expect("final summary fixture database");
        super::super::claim_pending_for_coordinator_turn_in_tx(
            &conn,
            &self.run_id,
            "summary-root",
            turn_intent_id,
        )
        .expect("claim FinalSummaryReceipt")
        .expect("pending FinalSummaryReceipt")
    }
}
