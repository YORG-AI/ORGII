use super::*;
use crate::coordination::agent_inbox::{AgentMessage, MemberIdleReason};
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
    TASK_METADATA_REQUIRED_ROLE,
};
use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember};
use crate::session::persistence::{session_type, UnifiedSessionRecord};
use crate::session::turn::member_idle::{MemberIdleHook, MemberIdleHookGuard};
use std::sync::{Arc, Mutex};

static TEST_SERIAL: Mutex<()> = Mutex::new(());

fn test_serial_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone)]
struct IdleCall {
    org_run_id: String,
    coordinator_agent_id: String,
    member_id: String,
    member_agent_id: String,
    member_name: String,
    reason: MemberIdleReason,
    current_mode: Option<crate::session::AgentExecMode>,
    failure_reason: Option<String>,
    unfinished_task_ids: Vec<String>,
}

#[derive(Default)]
struct RecordingMemberIdleHook {
    calls: Mutex<Vec<IdleCall>>,
}

impl RecordingMemberIdleHook {
    fn snapshot(&self) -> Vec<IdleCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl MemberIdleHook for RecordingMemberIdleHook {
    #[allow(clippy::too_many_arguments)]
    fn post_member_idle(
        &self,
        org_run_id: &str,
        coordinator_agent_id: &str,
        member_id: &str,
        member_agent_id: &str,
        member_name: &str,
        reason: MemberIdleReason,
        current_mode: Option<crate::session::AgentExecMode>,
        _summary: Option<String>,
        failure_reason: Option<String>,
        unfinished_task_ids: Vec<String>,
    ) {
        self.calls.lock().unwrap().push(IdleCall {
            org_run_id: org_run_id.to_string(),
            coordinator_agent_id: coordinator_agent_id.to_string(),
            member_id: member_id.to_string(),
            member_agent_id: member_agent_id.to_string(),
            member_name: member_name.to_string(),
            reason,
            current_mode,
            failure_reason,
            unfinished_task_ids,
        });
    }
}

fn ensure_runtime_schemas() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org tasks schema");
    crate::coordination::agent_org_plan_approvals::init_schema(&conn)
        .expect("agent org plan approvals schema");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("agent member interventions schema");
    crate::coordination::agent_org_watchdog::init_schema(&conn).expect("agent org recovery schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
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
                PRIMARY KEY (session_id, turn_intent_id)
            );",
    )
    .expect("turn lifecycle schemas");
}

#[test]
fn unread_race_guard_defers_during_direct_user_intervention() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    let member_id = "member-worker";
    crate::coordination::agent_inbox::AgentInboxStore::insert(
        crate::coordination::agent_inbox::InsertInboxParams {
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: Some(member_id.to_string()),
            sender_agent_id: crate::coordination::agent_inbox::SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: "deferred work".to_string(),
                text: "read this after direct user chat".to_string(),
            },
        },
    )
    .expect("insert unread row");
    crate::coordination::agent_member_interventions::AgentMemberInterventionStore::enter(
        crate::coordination::agent_member_interventions::EnterMemberInterventionParams {
            org_run_id: run_id.clone(),
            member_id: member_id.to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "member-session".to_string(),
            reason: Some("direct_user_chat".to_string()),
            ttl_secs: 180,
        },
    )
    .expect("enter intervention");

    assert!(!should_rewake_agent_org_member_after_turn(&run_id, member_id).expect("deferred gate"));

    crate::coordination::agent_member_interventions::AgentMemberInterventionStore::clear(
        &run_id, member_id,
    )
    .expect("clear intervention");
    assert!(should_rewake_agent_org_member_after_turn(&run_id, member_id).expect("wakeable gate"));
}

fn org_definition(member_agent_id: &str) -> OrgDefinition {
    OrgDefinition {
        id: "org-lifecycle".to_string(),
        name: "Lifecycle Org".to_string(),
        role: "coordinator".to_string(),
        agent_id: "builtin:coord".to_string(),
        description: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        children: vec![
            OrgMember {
                id: "member-worker".to_string(),
                name: "Worker".to_string(),
                role: "builder".to_string(),
                agent_id: member_agent_id.to_string(),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "member-peer".to_string(),
                name: "Peer".to_string(),
                role: "builder".to_string(),
                agent_id: "builtin:sde".to_string(),
                runtime_config: None,
                children: Vec::new(),
            },
        ],
    }
}

fn seed_run(member_agent_id: &str) -> String {
    ensure_runtime_schemas();
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(&UnifiedSessionRecord {
        session_id: "root-session".to_string(),
        name: "root".to_string(),
        status: crate::session::SessionStatus::Running.as_str().to_string(),
        session_type: session_type::GENERIC.to_string(),
        created_at: now.clone(),
        updated_at: now.clone(),
        agent_definition_id: Some("builtin:coord".to_string()),
        ..Default::default()
    })
    .expect("upsert root session");
    crate::session::persistence::upsert_session(&UnifiedSessionRecord {
        session_id: "member-session".to_string(),
        name: "member".to_string(),
        status: crate::session::SessionStatus::Running.as_str().to_string(),
        session_type: session_type::ORG_MEMBER.to_string(),
        created_at: now.clone(),
        updated_at: now,
        agent_definition_id: None,
        org_member_id: Some("member-worker".to_string()),
        parent_session_id: Some("root-session".to_string()),
        agent_exec_mode: Some(crate::session::AgentExecMode::Ask.as_str().to_string()),
        ..Default::default()
    })
    .expect("upsert member session");
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: "org-lifecycle".to_string(),
        coordinator_agent_id: "builtin:coord".to_string(),
        root_session_id: Some("root-session".to_string()),
        org_snapshot: org_definition(member_agent_id),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run");
    run.id
}

fn seed_in_progress_task(run_id: &str, task_id: &str) {
    seed_in_progress_task_with_metadata(run_id, task_id, None);
}

fn seed_in_progress_task_with_metadata(
    run_id: &str,
    task_id: &str,
    metadata: Option<serde_json::Value>,
) {
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.to_string(),
        org_run_id: run_id.to_string(),
        subject: task_id.to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-worker".to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata,
    })
    .expect("create in-progress task");
}

#[test]
fn successful_empty_coordinator_finalize_does_not_observe_staged_work() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_sessions
             SET org_member_id=?2, agent_exec_mode='ask'
             WHERE session_id=?1",
        rusqlite::params![
            "root-session",
            crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
        ],
    )
    .expect("mark root as coordinator member session");

    let presented_revision = AgentOrgRunStore::stage_coordinator_work_revision(&run_id)
        .expect("stage coordinator work revision")
        .expect("running run has a work revision");
    assert_eq!(
        AgentOrgRunStore::progress(&run_id)
            .expect("load progress")
            .expect("progress exists")
            .coordinator_observed_work_revision,
        None
    );

    // This is the lifecycle shape of WakeNoop: processing returned Ok,
    // but no provider turn ran. Finalization must not promote a staged
    // revision merely because the outer scheduler call succeeded.
    finalize_agent_org_member_turn(None, "root-session", &Ok(String::new()));

    let progress = AgentOrgRunStore::progress(&run_id)
        .expect("load progress after no-op")
        .expect("progress exists after no-op");
    assert_eq!(
        progress.coordinator_presented_work_revision,
        Some(presented_revision)
    );
    assert_eq!(progress.coordinator_observed_work_revision, None);
}

#[test]
fn requeue_member_work_uses_context_agent_reference_without_self_wake() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("claude_code");
    seed_in_progress_task(&run_id, "cli-task");

    let snapshot = requeue_agent_org_member_in_progress_work("member-session", true)
        .expect("requeue succeeds")
        .expect("member snapshot");

    assert_eq!(snapshot.member_agent_id, "claude_code");
    assert_eq!(snapshot.requeued_tasks.len(), 1);
    let task = AgentOrgTaskStore::get(&run_id, "cli-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.owner, None);
    let inbox = crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
        "member-worker",
        &run_id,
    )
    .expect("list member inbox");
    assert!(
        inbox.is_empty(),
        "released work waits for coordinator assignment"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn successful_member_finalize_keeps_in_progress_work_owned() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task(&run_id, "active-task");

    assert!(
        crate::coordination::agent_org_watchdog::test_only_mark_failed_rewake_attempt(
            &run_id,
            "member-worker"
        )
        .expect("attempt")
    );
    assert!(
        !crate::coordination::agent_org_watchdog::test_only_mark_failed_rewake_attempt(
            &run_id,
            "member-worker"
        )
        .expect("attempt")
    );

    let ok = Ok("done with this turn".to_string());
    finalize_agent_org_member_turn(None, "member-session", &ok);
    assert!(
        crate::coordination::agent_org_watchdog::test_only_mark_failed_rewake_attempt(
            &run_id,
            "member-worker"
        )
        .expect("attempt")
    );

    let task = AgentOrgTaskStore::get(&run_id, "active-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(task.owner.as_deref(), Some("member-worker"));
    let inbox = crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
        "member-worker",
        &run_id,
    )
    .expect("list member inbox");
    assert!(
        inbox.is_empty(),
        "success finalize must not self-assign the same task"
    );
    let release_events = AgentOrgTaskStore::list_history(&run_id)
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "released")
        .collect::<Vec<_>>();
    assert!(release_events.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_member_finalize_releases_task_for_coordinator_assignment() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let hook = Arc::new(RecordingMemberIdleHook::default());
    let _guard = MemberIdleHookGuard::install(hook.clone());
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task_with_metadata(
        &run_id,
        "failed-task",
        Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-worker", "member-peer"],
            TASK_METADATA_REQUIRED_ROLE: "implement",
        })),
    );

    let error = Err("HTTP 429: rate limit exceeded".to_string());
    finalize_agent_org_member_turn(None, "member-session", &error);

    let task = AgentOrgTaskStore::get(&run_id, "failed-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(
        task.owner, None,
        "failed work becomes ownerless so the coordinator can choose the next owner"
    );
    assert_eq!(
        crate::coordination::agent_org_tasks::eligible_member_ids(&task),
        vec!["member-worker".to_string(), "member-peer".to_string()]
    );
    assert_eq!(
        task.metadata
            .as_ref()
            .and_then(|metadata| metadata.get(TASK_METADATA_REQUIRED_ROLE))
            .and_then(serde_json::Value::as_str),
        Some("implement")
    );

    let calls = hook.snapshot();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call.org_run_id, run_id);
    assert_eq!(call.coordinator_agent_id, "builtin:coord");
    assert_eq!(call.member_id, "member-worker");
    assert_eq!(call.member_agent_id, "builtin:sde");
    assert_eq!(call.member_name, "Worker");
    assert_eq!(call.reason, MemberIdleReason::Failed);
    assert_eq!(call.current_mode, Some(crate::session::AgentExecMode::Ask));
    let failure_reason = call.failure_reason.as_deref().unwrap_or_default();
    assert!(failure_reason.contains("HTTP 429: rate limit exceeded"));
    assert!(failure_reason.contains("Requeued tasks from the failed member"));
    assert!(failure_reason.contains("failed-task"));
    assert!(failure_reason.contains("awaiting_coordinator_assignment"));
    assert!(failure_reason.contains("eligible_member_ids: [member-worker, member-peer]"));
    assert!(failure_reason.contains("required_role: implement"));
    assert!(failure_reason.contains("task_update owner_member_id"));
    assert_eq!(call.unfinished_task_ids, vec!["failed-task"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_member_finalize_releases_even_when_only_failed_member_is_eligible() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let hook = Arc::new(RecordingMemberIdleHook::default());
    let _guard = MemberIdleHookGuard::install(hook.clone());
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task_with_metadata(
        &run_id,
        "solo-task",
        Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-worker"],
        })),
    );

    let error = Err("HTTP 500: provider exploded".to_string());
    finalize_agent_org_member_turn(None, "member-session", &error);

    let task = AgentOrgTaskStore::get(&run_id, "solo-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.owner, None);

    let calls = hook.snapshot();
    assert_eq!(calls.len(), 1);
    let failure_reason = calls[0].failure_reason.as_deref().unwrap_or_default();
    assert!(failure_reason.contains("awaiting_coordinator_assignment"));
    assert!(failure_reason.contains("eligible_member_ids: [member-worker]"));
}
