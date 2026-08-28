use std::sync::Mutex;

use database::db::get_connection;

use crate::coordination::agent_org_formal_triggers::{
    FormalTriggerDoorbellStatus, FormalTriggerSource,
};
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;

pub(super) struct WatchdogFixture {
    _sandbox: test_helpers::test_env::SandboxGuard,
    pub(super) run_id: String,
}

impl WatchdogFixture {
    pub(super) fn new() -> Self {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("watchdog fixture database");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
        let org = OrgDefinition {
            id: "watchdog-org".into(),
            name: "Watchdog Org".into(),
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
            root_session_id: Some("watchdog-root".into()),
            org_snapshot: (&org).into(),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("watchdog run");
        Self {
            _sandbox: sandbox,
            run_id: run.id,
        }
    }

    pub(super) fn insert_missing_receipt(&self, suffix: &str) -> String {
        let conn = get_connection().expect("watchdog fixture database");
        super::super::super::agent_org_formal_triggers::record_trigger_in_tx(
            &conn,
            &self.run_id,
            FormalTriggerSource {
                trigger_kind: "task_output",
                trigger_id: suffix,
                trigger_revision: 1,
                source_kind: "task_output",
                inbox_id: None,
                task_id: Some(suffix),
                owner_member_id: Some("worker"),
                source_turn_intent_id: Some("worker-turn"),
                task_output_digest: Some(&"a".repeat(64)),
                plan_revision_id: None,
                doorbell_status: FormalTriggerDoorbellStatus::Missing,
                initially_resolved: false,
            },
        )
        .expect("missing formal doorbell")
        .receipt_id
    }
}

#[derive(Default)]
pub(super) struct RecordingWake {
    calls: Mutex<Vec<(String, String)>>,
}

impl RecordingWake {
    pub(super) fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl InboxWakeHook for RecordingWake {
    fn wake_member(&self, member_id: &str, org_run_id: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((member_id.to_string(), org_run_id.to_string()));
    }

    fn wake_member_for_formal_receipts(
        &self,
        member_id: &str,
        org_run_id: &str,
        receipt_ids: &[String],
    ) {
        self.wake_member(member_id, org_run_id);
        crate::coordination::agent_org_formal_triggers::mark_doorbells_delivered(receipt_ids)
            .expect("accepted test wake acknowledges exact receipts");
    }
}

#[derive(Default)]
pub(super) struct UnacceptedWake {
    calls: Mutex<Vec<(String, String)>>,
}

impl UnacceptedWake {
    pub(super) fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl InboxWakeHook for UnacceptedWake {
    fn wake_member(&self, member_id: &str, org_run_id: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((member_id.to_string(), org_run_id.to_string()));
    }
}
