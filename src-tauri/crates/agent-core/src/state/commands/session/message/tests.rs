//! Unit tests for session-message exec-mode resolution and Agent Org wake
//! claiming.
//!
//! The wake-mode cases share one durable fixture (run + coordinator/member
//! sessions + a controlled task), so the exec-mode and org-wake helpers are
//! exercised together here rather than split across their two modules.

use super::exec_mode::{resolve_agent_mode, restore_mode_before_plan_entry};
use super::org_wake::{
    promote_agent_org_direct_session_to_running, promote_agent_org_wake_session_to_running,
    resolve_agent_org_wake_mode,
};
use super::send::{
    ensure_agent_org_turn_is_runnable, should_divert_to_mid_turn_steering,
    terminal_intent_status_override,
};
use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionStore, EnterMemberInterventionParams,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_EXECUTION_MODE,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};
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
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![FlatOrgMember {
            member_id: member_id.clone(),
            name: "Planner".into(),
            role: "Planner".into(),
            agent_id: "planner-agent".into(),
            runtime_config: None,
        }],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some("root-session".into()),
        org_snapshot: (&org).into(),
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

fn seed_task_execution_context(fixture: &WakeModeFixture, turn_intent_id: &str) {
    let conn = database::db::get_connection().expect("test db");
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
            PRIMARY KEY(session_id, turn_intent_id)
         );",
    )
    .expect("canonical Turn Intent test schema");
    let generation: i64 = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_runs WHERE id=?1",
            [&fixture.run_id],
            |row| row.get(0),
        )
        .expect("run generation");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents (
            session_id, turn_intent_id, client_message_id, org_run_id,
            source, status, created_at, updated_at
         ) VALUES (?1,?2,NULL,?3,'agent_org','queued',?4,?4)",
        rusqlite::params![&fixture.session_id, turn_intent_id, &fixture.run_id, &now],
    )
    .expect("seed base Turn");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
            session_id, turn_intent_id, org_run_id, participant_id, turn_kind,
            task_id, owner_member_id, dispatch_member_id, member_dispatch_sequence,
            source_kind, source_id, activation_generation, created_at
         ) VALUES (?1,?2,?3,?4,'task_execution',?5,?4,?4,1,'task',?5,?6,?7)",
        rusqlite::params![
            &fixture.session_id,
            turn_intent_id,
            &fixture.run_id,
            &fixture.member_id,
            &fixture.task_id,
            generation,
            &now,
        ],
    )
    .expect("seed typed TaskExecution context");
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

#[test]
fn cancelled_turn_overrides_scheduler_success_terminal() {
    use crate::foundation::session_bridge::TurnIntentBridgeStatus;
    use crate::session::DialogTurnState;

    assert!(matches!(
        terminal_intent_status_override(DialogTurnState::Cancelled),
        Some(TurnIntentBridgeStatus::Cancelled)
    ));
    assert!(terminal_intent_status_override(DialogTurnState::Completed).is_none());
    assert!(terminal_intent_status_override(DialogTurnState::Failed).is_none());
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
        "UPDATE agent_org_runtime_runs SET status='paused' WHERE id=?1",
        rusqlite::params![&fixture.run_id],
    )
    .expect("pause run");
    assert_eq!(
        promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
            .expect("paused run wake is a no-op"),
        0
    );

    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='running' WHERE id=?1",
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
fn direct_agent_org_turn_only_promotes_while_run_is_running() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let conn = database::db::get_connection().expect("test db");
    for status in [
        AgentOrgRunStatus::Starting,
        AgentOrgRunStatus::Paused,
        AgentOrgRunStatus::Idle,
        AgentOrgRunStatus::Failed,
        AgentOrgRunStatus::Archived,
    ] {
        conn.execute(
            "UPDATE agent_org_runtime_runs SET status=?1 WHERE id=?2",
            rusqlite::params![status.as_str(), &fixture.run_id],
        )
        .expect("set non-runnable run status");
        assert_eq!(
            promote_agent_org_direct_session_to_running(
                &conn,
                &fixture.run_id,
                &fixture.session_id,
            )
            .expect("non-running run claim is a no-op"),
            0,
            "{status:?} must not promote the member Session"
        );
        let session_status = conn
            .query_row(
                "SELECT status FROM agent_sessions WHERE session_id=?1",
                [&fixture.session_id],
                |row| row.get::<_, String>(0),
            )
            .expect("load member status");
        assert_eq!(session_status, "idle");
    }

    conn.execute(
        "UPDATE agent_org_runtime_runs SET status=?1 WHERE id=?2",
        rusqlite::params![AgentOrgRunStatus::Running.as_str(), &fixture.run_id],
    )
    .expect("restore running run");
    assert_eq!(
        promote_agent_org_direct_session_to_running(&conn, &fixture.run_id, &fixture.session_id)
            .expect("running run promotes the member Session"),
        1
    );
}

#[test]
fn provider_preflight_exhaustively_rejects_every_non_running_team_status() {
    assert!(ensure_agent_org_turn_is_runnable("run", AgentOrgRunStatus::Running).is_ok());

    for (status, code) in [
        (AgentOrgRunStatus::Starting, "team_not_ready"),
        (AgentOrgRunStatus::Paused, "team_paused"),
        (AgentOrgRunStatus::Idle, "team_idle"),
        (AgentOrgRunStatus::Failed, "team_unavailable"),
        (AgentOrgRunStatus::Archived, "team_archived"),
    ] {
        let error = ensure_agent_org_turn_is_runnable("run", status)
            .expect_err("non-running Team cannot initialize a turn");
        assert!(
            error.starts_with(code),
            "{status:?} should return {code}, got {error}"
        );
    }
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
fn task_wake_mode_comes_from_the_bound_tasks_first_class_column() {
    let fixture = setup_wake_mode_fixture("plan", TaskStatus::Pending);
    seed_task_execution_context(&fixture, "task-wake-plan");

    assert_eq!(
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id, "task-wake-plan",)
            .expect("resolve typed Task wake mode"),
        Some(AgentExecMode::Plan)
    );
}

#[test]
fn task_wake_mode_fails_closed_for_corrupt_first_class_value() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    seed_task_execution_context(&fixture, "task-wake-corrupt");
    let conn = database::db::get_connection().expect("test db");
    conn.execute_batch("PRAGMA ignore_check_constraints=ON;")
        .expect("simulate corrupt canonical row");
    conn.execute(
        "UPDATE agent_org_runtime_tasks SET execution_mode='future_mode'
         WHERE org_run_id=?1 AND id=?2",
        rusqlite::params![&fixture.run_id, &fixture.task_id],
    )
    .expect("corrupt execution mode");
    conn.execute_batch("PRAGMA ignore_check_constraints=OFF;")
        .expect("restore checks");

    let error =
        resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id, "task-wake-corrupt")
            .expect_err("unknown execution mode must not default to Build");
    assert!(error.contains("invalid task execution_mode"), "{error}");
}
