//! Unit tests for session-message exec-mode resolution and Agent Org wake
//! claiming.
//!
//! The wake-mode cases share one durable fixture (run + coordinator/member
//! sessions + a controlled task), so the exec-mode and org-wake helpers are
//! exercised together here rather than split across their two modules.

use super::exec_mode::{resolve_agent_mode, restore_mode_before_plan_entry};
use super::org_wake::{promote_agent_org_wake_session_to_running, resolve_agent_org_wake_mode};
use super::send::should_divert_to_mid_turn_steering;
use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, RequestId,
};
use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionStore, EnterMemberInterventionParams,
};
use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanApprovalStore, CreateAgentOrgPlanApprovalParams,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::coordination::agent_org_tasks::{
    enqueue_task_assigned_to_with_tasks, AgentOrgTaskStore, CreateTaskParams, TaskStatus,
    TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_EXECUTION_MODE,
};
use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};
use crate::session::{AgentExecMode, SessionStatus};
use core_types::key_source::KeySource;

struct WakeModeFixture {
    _sandbox: test_helpers::test_env::SandboxGuard,
    run_id: String,
    session_id: String,
    member_id: String,
    task_id: String,
}

fn setup_wake_mode_fixture(execution_mode: &str, task_status: TaskStatus) -> WakeModeFixture {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("test db");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::session::persistence::init(&conn).expect("session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schema");

    let member_id = "planner".to_string();
    let session_id = "planner-session".to_string();
    let org = OrgDefinition {
        id: format!("org-mode-{}", uuid::Uuid::new_v4()),
        name: "Mode Resolver Org".into(),
        role: "Coordinator".into(),
        agent_id: "coordinator-agent".into(),
        description: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![OrgMember {
            id: member_id.clone(),
            name: "Planner".into(),
            role: "Planner".into(),
            agent_id: "planner-agent".into(),
            runtime_config: None,
            children: Vec::new(),
        }],
    };
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some("root-session".into()),
        org_snapshot: org,
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run");
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: "root-session".into(),
            name: "Coordinator".into(),
            status: "idle".into(),
            created_at: now.clone(),
            updated_at: now.clone(),
            session_type: "sde".into(),
            org_member_id: Some(COORDINATOR_MEMBER_ID.into()),
            agent_definition_id: Some("coordinator-agent".into()),
            key_source: KeySource::OwnKey,
            ..Default::default()
        },
    )
    .expect("seed coordinator session");
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: session_id.clone(),
            name: "Planner".into(),
            status: "idle".into(),
            created_at: now.clone(),
            updated_at: now,
            session_type: "sde".into(),
            org_member_id: Some(member_id.clone()),
            parent_session_id: Some("root-session".into()),
            agent_definition_id: Some("planner-agent".into()),
            key_source: KeySource::OwnKey,
            ..Default::default()
        },
    )
    .expect("seed member session");
    let task_id = "mode-task".to_string();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.clone(),
        org_run_id: run.id.clone(),
        subject: "Controlled work".into(),
        description: String::new(),
        active_form: None,
        owner: Some(member_id.clone()),
        status: task_status,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_EXECUTION_MODE: execution_mode,
        })),
    })
    .expect("create controlled task");

    WakeModeFixture {
        _sandbox: sandbox,
        run_id: run.id,
        session_id,
        member_id,
        task_id,
    }
}

fn insert_control(fixture: &WakeModeFixture, sender_member_id: &str, message: AgentMessage) -> i64 {
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "planner-agent".into(),
        recipient_member_id: Some(fixture.member_id.clone()),
        sender_agent_id: if sender_member_id == COORDINATOR_MEMBER_ID {
            "coordinator-agent".into()
        } else {
            "peer-agent".into()
        },
        sender_member_id: Some(sender_member_id.into()),
        org_run_id: Some(fixture.run_id.clone()),
        message,
    })
    .expect("insert control row")
    .id
}

#[test]
fn force_send_never_enters_mid_turn_steering() {
    use crate::foundation::session_bridge::TurnIntentBridgeSource;

    assert_eq!(
        TurnIntentBridgeSource::parse("force_send")
            .expect("force_send source")
            .as_str(),
        "force_send"
    );
    assert!(TurnIntentBridgeSource::parse("force-send").is_none());

    assert!(should_divert_to_mid_turn_steering(
        TurnIntentBridgeSource::UserSubmit,
        false,
        "ordinary live guidance",
        None,
        true,
    ));
    assert!(!should_divert_to_mid_turn_steering(
        TurnIntentBridgeSource::ForceSend,
        false,
        "start a fresh turn now",
        None,
        true,
    ));
    assert!(!should_divert_to_mid_turn_steering(
        TurnIntentBridgeSource::Queue,
        false,
        "queued follow-up",
        None,
        true,
    ));
}

/// Historical callers without a task-scoped mode keep Build semantics.
#[test]
fn wake_defaults_to_build() {
    assert_eq!(resolve_agent_mode(None).unwrap(), AgentExecMode::Build);
}

#[test]
fn empty_string_defaults_to_build() {
    assert_eq!(resolve_agent_mode(Some("")).unwrap(), AgentExecMode::Build);
    assert_eq!(
        resolve_agent_mode(Some("   ")).unwrap(),
        AgentExecMode::Build
    );
}

#[test]
fn explicit_plan_parses() {
    assert_eq!(
        resolve_agent_mode(Some("plan")).unwrap(),
        AgentExecMode::Plan
    );
}

#[test]
fn queued_agent_org_wake_rechecks_run_member_and_intervention_at_turn_start() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let conn = database::db::get_connection().expect("test db");

    assert_eq!(
        promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
            .expect("claim valid wake"),
        1
    );

    for invalid_status in [SessionStatus::Paused, SessionStatus::Archived] {
        conn.execute(
            "UPDATE agent_sessions SET status=?1 WHERE session_id=?2",
            rusqlite::params![invalid_status.as_str(), &fixture.session_id],
        )
        .expect("set invalid member status");
        assert_eq!(
            promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
                .expect("invalid wake is a no-op"),
            0,
            "queued wake must not revive {invalid_status:?} member"
        );
    }

    conn.execute(
        "UPDATE agent_sessions SET status='idle' WHERE session_id=?1",
        rusqlite::params![&fixture.session_id],
    )
    .expect("restore member idle");
    conn.execute(
        "UPDATE agent_org_runs SET status='paused' WHERE id=?1",
        rusqlite::params![&fixture.run_id],
    )
    .expect("pause run");
    assert_eq!(
        promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
            .expect("paused run wake is a no-op"),
        0
    );

    conn.execute(
        "UPDATE agent_org_runs SET status='running' WHERE id=?1",
        rusqlite::params![&fixture.run_id],
    )
    .expect("resume run");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: fixture.run_id.clone(),
        member_id: fixture.member_id.clone(),
        agent_id: "planner-agent".into(),
        session_id: fixture.session_id.clone(),
        reason: Some("User is directly inspecting the planner".into()),
        ttl_secs: 60,
    })
    .expect("enter intervention");
    assert_eq!(
        promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
            .expect("intervened wake is a no-op"),
        0
    );
}

#[test]
fn plan_entry_without_prior_non_plan_mode_restores_to_plan() {
    assert_eq!(restore_mode_before_plan_entry(None), AgentExecMode::Plan);
}

#[test]
fn plan_entry_after_build_restores_to_build() {
    assert_eq!(
        restore_mode_before_plan_entry(Some(AgentExecMode::Build)),
        AgentExecMode::Build
    );
}

#[test]
fn unknown_mode_is_rejected_not_silently_downgraded() {
    let err = resolve_agent_mode(Some("plann")).unwrap_err();
    assert!(
        err.contains("Unknown agent exec mode"),
        "expected typo to fail loudly, got: {err}"
    );
}

#[test]
fn ordinary_coordinator_message_is_not_a_member_takeover() {
    assert!(!can_enter_member_intervention(COORDINATOR_MEMBER_ID));
}

#[test]
fn direct_worker_message_is_a_member_takeover() {
    assert!(can_enter_member_intervention("member-planner"));
}

#[test]
fn plan_changes_request_controls_the_first_revision_wake() {
    let fixture = setup_wake_mode_fixture("plan", TaskStatus::InProgress);
    let approval = AgentOrgPlanApprovalStore::create_pending(CreateAgentOrgPlanApprovalParams {
        request_id: "revision-request".into(),
        org_run_id: fixture.run_id.clone(),
        source_task_id: fixture.task_id.clone(),
        source_member_id: fixture.member_id.clone(),
        source_session_id: fixture.session_id.clone(),
        root_session_id: "root-session".into(),
        policy: PlanApprovalPolicy::Coordinator,
        plan_title: "Initial plan".into(),
        plan_path: AgentOrgPlanApprovalStore::managed_plan_path_for_session(
            &fixture.session_id,
            "initial.plan.md",
        )
        .expect("managed initial plan path")
        .to_string_lossy()
        .into_owned(),
        plan_content: "# Initial".into(),
    })
    .expect("create plan approval");
    insert_control(
        &fixture,
        COORDINATOR_MEMBER_ID,
        AgentMessage::PlanApprovalResponse {
            request_id: RequestId(approval.request_id),
            accepted: false,
            feedback: Some("revise scope".into()),
            next_mode: Some(AgentExecMode::Plan),
        },
    );

    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
            .expect("resolve revision mode"),
        Some(AgentExecMode::Plan)
    );
}

#[test]
fn coordinator_exec_override_controls_the_first_wake() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    insert_control(
        &fixture,
        COORDINATOR_MEMBER_ID,
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId("override-plan".into()),
            mode: AgentExecMode::Plan,
            reason: Some("plan before implementation".into()),
        },
    );
    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
            .expect("resolve override"),
        Some(AgentExecMode::Plan)
    );
}

#[test]
fn latest_applicable_control_wins_and_task_mode_comes_from_durable_state() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    insert_control(
        &fixture,
        COORDINATOR_MEMBER_ID,
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId("first-plan".into()),
            mode: AgentExecMode::Plan,
            reason: None,
        },
    );
    let tasks = AgentOrgTaskStore::list(&fixture.run_id).expect("list task board");
    let task = tasks
        .iter()
        .find(|task| task.id == fixture.task_id)
        .expect("controlled task");
    enqueue_task_assigned_to_with_tasks(
        task,
        &tasks,
        "planner-agent",
        &fixture.member_id,
        "coordinator-agent",
        Some(COORDINATOR_MEMBER_ID),
        "Coordinator",
    )
    .expect("insert later TaskAssigned");

    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
            .expect("resolve latest signal"),
        Some(AgentExecMode::Build),
        "later TaskAssigned wins, and its mode is re-read from the durable Build task"
    );
}

#[test]
fn forged_peer_exec_override_is_ignored() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    insert_control(
        &fixture,
        "peer",
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId("forged-plan".into()),
            mode: AgentExecMode::Plan,
            reason: None,
        },
    );
    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
            .expect("ignore forged override"),
        None
    );
}

#[test]
fn control_beyond_current_drain_row_batch_does_not_change_this_turn_mode() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    for index in 0..crate::coordination::agent_inbox::MAX_INBOX_DRAIN_ROWS {
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::Plain {
                summary: format!("older-{index}"),
                text: "ordinary work context".into(),
            },
        );
    }
    insert_control(
        &fixture,
        COORDINATOR_MEMBER_ID,
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId("future-plan".into()),
            mode: AgentExecMode::Plan,
            reason: None,
        },
    );

    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
            .expect("future batch control must not affect this turn"),
        None
    );
}

#[test]
fn control_beyond_current_drain_byte_budget_does_not_change_this_turn_mode() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let large_text = "🧭".repeat(19_000);
    for index in 0..20 {
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::Plain {
                summary: format!("large-{index}"),
                text: large_text.clone(),
            },
        );
    }
    insert_control(
        &fixture,
        COORDINATOR_MEMBER_ID,
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId("later-byte-plan".into()),
            mode: AgentExecMode::Plan,
            reason: None,
        },
    );

    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
            .expect("byte-deferred control must not affect this turn"),
        None
    );
}

#[test]
fn consumed_plan_control_does_not_repeat_on_next_turn() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let row_id = insert_control(
        &fixture,
        COORDINATOR_MEMBER_ID,
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId("one-shot-plan".into()),
            mode: AgentExecMode::Plan,
            reason: None,
        },
    );
    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id).unwrap(),
        Some(AgentExecMode::Plan)
    );
    AgentInboxStore::mark_many_read(&[row_id]).expect("commit successful wake");
    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id).unwrap(),
        None
    );
}

#[test]
fn ownerless_plan_task_does_not_select_member_mode() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "plan-from-pool".to_string(),
        org_run_id: fixture.run_id.clone(),
        subject: "Plan the work".to_string(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["planner"],
            TASK_METADATA_EXECUTION_MODE: "plan",
        })),
    })
    .expect("seed ownerless task");

    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id).expect("resolve mode"),
        None
    );
}
