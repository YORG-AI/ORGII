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
    ensure_agent_org_turn_is_runnable, promote_turn_to_running_in_tx,
    should_divert_to_mid_turn_steering, terminal_intent_status_override,
};
use crate::coordination::agent_inbox::AgentInboxStore;
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
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent message schema");
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
    let materialized_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations (
            org_run_id,member_id,agent_id,generation,session_id,
            authority_class,status,created_at,updated_at
         ) VALUES (?1,?2,'planner-agent',1,?3,'formal','succeeded',?4,?4)",
        rusqlite::params![&run.id, &member_id, &session_id, &materialized_at],
    )
    .expect("seed canonical member materialization");
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

fn enqueue_and_materialize_task_assignment(fixture: &WakeModeFixture, turn_intent_id: &str) -> i64 {
    let task = AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
        .expect("load Task")
        .expect("Task exists");
    let inbox_id = crate::coordination::agent_org_tasks::enqueue_task_assigned_to(
        &task,
        "planner-agent",
        &fixture.member_id,
        "coordinator-agent",
        Some(COORDINATOR_MEMBER_ID),
        "Coordinator",
    )
    .expect("enqueue canonical TaskAssigned input");
    let batch = AgentInboxStore::list_unread_task_input_for_turn(
        &fixture.member_id,
        &fixture.run_id,
        &fixture.task_id,
        &fixture.session_id,
        turn_intent_id,
    )
    .expect("claim exact TaskExecution input while Task is Pending");
    assert_eq!(batch.rows.len(), 1);
    assert_eq!(batch.rows[0].id, inbox_id);
    crate::session::persistence::materialize_agent_org_inbox_transcript_for_turn(
        &fixture.session_id,
        turn_intent_id,
        &[inbox_id],
        &format!("agent-org-inbox-message-{inbox_id}"),
        &format!("agent-org-inbox-intent-{inbox_id}"),
        "Planner received the assigned Task",
    )
    .expect("materialize TaskAssigned transcript before Provider");
    inbox_id
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
        false,
    ));
    assert!(!should_divert_to_mid_turn_steering(
        TurnIntentBridgeSource::ForceSend,
        false,
        "start a fresh turn now",
        None,
        true,
        false,
    ));
    assert!(!should_divert_to_mid_turn_steering(
        TurnIntentBridgeSource::Queue,
        false,
        "queued follow-up",
        None,
        true,
        false,
    ));
}

#[test]
fn agent_org_root_follow_up_never_enters_mid_turn_steering() {
    use crate::foundation::session_bridge::TurnIntentBridgeSource;

    assert!(!should_divert_to_mid_turn_steering(
        TurnIntentBridgeSource::UserSubmit,
        false,
        "queue this as the next Coordinator turn",
        None,
        true,
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
    })
    .expect("enter intervention");
    assert_eq!(
        promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
            .expect("intervened wake is a no-op"),
        0
    );
}

#[test]
fn task_execution_starts_after_materialized_input_before_provider_tools() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let turn_intent_id = "task-wake-auto-start";
    seed_task_execution_context(&fixture, turn_intent_id);
    let mut conn = database::db::get_connection().expect("test db");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id=?1 AND turn_intent_id=?2",
        rusqlite::params![&fixture.session_id, turn_intent_id],
    )
    .expect("scheduler marks Turn running before execute callback");
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("turn-start transaction");
    let promotion = promote_turn_to_running_in_tx(
        &tx,
        &fixture.session_id,
        turn_intent_id,
        Some(&fixture.run_id),
        None,
        false,
    )
    .expect("promote exact TaskExecution Turn");
    assert!(promotion);
    tx.commit().expect("commit Session turn start");

    assert_eq!(
        AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
            .expect("load Task before inbox drain")
            .expect("Task exists")
            .status,
        TaskStatus::Pending,
        "Session promotion must not invalidate the Pending TaskAssigned input"
    );
    let inbox_id = enqueue_and_materialize_task_assignment(&fixture, turn_intent_id);
    assert_eq!(
        crate::session::turn::start_task_execution_before_provider(
            &fixture.session_id,
            turn_intent_id,
            &[inbox_id],
        )
        .expect("start exact Task immediately before Provider"),
        Some(fixture.run_id.clone())
    );

    let task = AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
        .expect("load Task")
        .expect("Task exists");
    assert_eq!(task.status, TaskStatus::InProgress);
    let assignment_remains_unread: bool = conn
        .query_row(
            "SELECT read_at IS NULL FROM agent_org_runtime_inbox WHERE id=?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("load durable TaskAssigned acknowledgement state");
    assert!(
        assignment_remains_unread,
        "starting Provider work must not acknowledge TaskAssigned before Turn success"
    );
    let start_event: (String, String, String, String) = conn
        .query_row(
            "SELECT previous_status,next_status,actor_kind,source_turn_intent_id
             FROM agent_org_runtime_task_events
             WHERE org_run_id=?1 AND task_id=?2
             ORDER BY rowid DESC LIMIT 1",
            rusqlite::params![&fixture.run_id, &fixture.task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("load authoritative start event");
    assert_eq!(
        start_event,
        (
            "pending".to_string(),
            "in_progress".to_string(),
            "owner_execution".to_string(),
            turn_intent_id.to_string(),
        )
    );

    let identity =
        crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity {
            org_run_id: fixture.run_id.clone(),
            task_id: fixture.task_id.clone(),
            session_id: fixture.session_id.clone(),
            turn_intent_id: turn_intent_id.to_string(),
            owner_member_id: fixture.member_id.clone(),
            activation_generation: 1,
        };
    let previous_unknown =
        crate::coordination::agent_org_task_execution_fence::begin_external_effect(&identity)
            .expect("the first Provider tool has exact running Task authority");
    assert!(!previous_unknown);
    crate::coordination::agent_org_task_execution_fence::restore_external_effect_after_success(
        &identity,
        previous_unknown,
    )
    .expect("restore test effect marker");
}

#[test]
fn task_execution_cannot_start_before_assignment_materialization() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let turn_intent_id = "task-wake-missing-materialization";
    seed_task_execution_context(&fixture, turn_intent_id);
    let task = AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
        .expect("load Task")
        .expect("Task exists");
    let inbox_id = crate::coordination::agent_org_tasks::enqueue_task_assigned_to(
        &task,
        "planner-agent",
        &fixture.member_id,
        "coordinator-agent",
        Some(COORDINATOR_MEMBER_ID),
        "Coordinator",
    )
    .expect("enqueue TaskAssigned without materializing it");

    let error = crate::session::turn::start_task_execution_before_provider(
        &fixture.session_id,
        turn_intent_id,
        &[inbox_id],
    )
    .expect_err("pre-drain Task start must fail closed");
    assert_eq!(
        error,
        "task_execution_start_requires_materialized_assignment"
    );
    assert_eq!(
        AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
            .expect("load Task")
            .expect("Task exists")
            .status,
        TaskStatus::Pending
    );
}

#[test]
fn cancelled_task_cannot_start_after_assignment_materialization() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let turn_intent_id = "task-wake-cancelled-after-materialization";
    seed_task_execution_context(&fixture, turn_intent_id);
    let inbox_id = enqueue_and_materialize_task_assignment(&fixture, turn_intent_id);
    let conn = database::db::get_connection().expect("test db");
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='cancelled',cancel_reason_json=?3,updated_at=?4
         WHERE org_run_id=?1 AND id=?2",
        rusqlite::params![
            &fixture.run_id,
            &fixture.task_id,
            serde_json::json!({
                "code": "scope.cancelled_before_provider",
                "message": "cancelled after input materialization",
            })
            .to_string(),
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("cancel Task before Provider boundary");

    let error = crate::session::turn::start_task_execution_before_provider(
        &fixture.session_id,
        turn_intent_id,
        &[inbox_id],
    )
    .expect_err("cancelled Task invalidates the materialized Turn");
    assert!(
        error.contains("is not runnable (status cancelled)"),
        "{error}"
    );
    assert_eq!(
        AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
            .expect("load Task")
            .expect("Task exists")
            .status,
        TaskStatus::Cancelled
    );
}

#[test]
fn paused_run_cannot_start_task_after_assignment_materialization() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let turn_intent_id = "task-wake-paused-after-materialization";
    seed_task_execution_context(&fixture, turn_intent_id);
    let inbox_id = enqueue_and_materialize_task_assignment(&fixture, turn_intent_id);
    let conn = database::db::get_connection().expect("test db");
    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='paused',updated_at=?2 WHERE id=?1",
        rusqlite::params![&fixture.run_id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("pause run before Provider boundary");

    let error = crate::session::turn::start_task_execution_before_provider(
        &fixture.session_id,
        turn_intent_id,
        &[inbox_id],
    )
    .expect_err("paused run invalidates the materialized Turn");
    assert!(error.contains("paused"), "{error}");
    assert_eq!(
        AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
            .expect("load Task")
            .expect("Task exists")
            .status,
        TaskStatus::Pending
    );
}

#[test]
fn invalidated_queued_wake_does_not_start_its_task() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let turn_intent_id = "task-wake-invalidated-before-start";
    seed_task_execution_context(&fixture, turn_intent_id);
    let mut conn = database::db::get_connection().expect("test db");
    conn.execute(
        "UPDATE agent_sessions SET status='paused' WHERE session_id=?1",
        [&fixture.session_id],
    )
    .expect("pause member before queued callback runs");
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("turn-start transaction");
    assert_eq!(
        promote_turn_to_running_in_tx(
            &tx,
            &fixture.session_id,
            turn_intent_id,
            Some(&fixture.run_id),
            None,
            false,
        )
        .expect("invalidated wake is a durable no-op"),
        false
    );
    tx.commit().expect("commit no-op claim");
    assert_eq!(
        AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
            .expect("load Task")
            .expect("Task exists")
            .status,
        TaskStatus::Pending
    );
    let started: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_task_events
                 WHERE org_run_id=?1 AND task_id=?2
                   AND previous_status='pending' AND next_status='in_progress'
             )",
            rusqlite::params![&fixture.run_id, &fixture.task_id],
            |row| row.get(0),
        )
        .expect("check start events");
    assert!(!started);
}

#[test]
fn cancelled_queued_task_cannot_be_restarted_by_its_old_turn() {
    let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
    let turn_intent_id = "task-wake-cancelled-before-start";
    seed_task_execution_context(&fixture, turn_intent_id);
    let mut conn = database::db::get_connection().expect("test db");
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='cancelled',cancel_reason_json=?3,updated_at=?4
         WHERE org_run_id=?1 AND id=?2",
        rusqlite::params![
            &fixture.run_id,
            &fixture.task_id,
            serde_json::json!({
                "code": "scope.cancelled_before_start",
                "message": "cancelled while queued",
            })
            .to_string(),
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("cancel Task before queued callback runs");
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("turn-start transaction");
    let error = promote_turn_to_running_in_tx(
        &tx,
        &fixture.session_id,
        turn_intent_id,
        Some(&fixture.run_id),
        None,
        false,
    )
    .expect_err("terminal Task invalidates the old queued Turn");
    assert!(
        error.contains("is not runnable (status cancelled)"),
        "{error}"
    );
    drop(tx);
    assert_eq!(
        AgentOrgTaskStore::get(&fixture.run_id, &fixture.task_id)
            .expect("load Task")
            .expect("Task exists")
            .status,
        TaskStatus::Cancelled
    );
    let member_status: String = conn
        .query_row(
            "SELECT status FROM agent_sessions WHERE session_id=?1",
            [&fixture.session_id],
            |row| row.get(0),
        )
        .expect("load member status");
    assert_eq!(member_status, SessionStatus::Idle.as_str());
}

#[test]
fn direct_agent_org_turn_allows_running_or_canonical_root_idle() {
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
            "UPDATE agent_org_runtime_runs
             SET status=?1,
                 archived_at=CASE WHEN ?1='archived' THEN ?3 ELSE NULL END,
                 archive_receipt_id=CASE WHEN ?1='archived' THEN ?4 ELSE NULL END
             WHERE id=?2",
            rusqlite::params![
                status.as_str(),
                &fixture.run_id,
                chrono::Utc::now().to_rfc3339(),
                "direct-turn-archive-receipt"
            ],
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
        "UPDATE agent_org_runtime_runs
         SET status=?1,archived_at=NULL,archive_receipt_id=NULL WHERE id=?2",
        rusqlite::params![AgentOrgRunStatus::Idle.as_str(), &fixture.run_id],
    )
    .expect("set idle run");
    assert_eq!(
        promote_agent_org_direct_session_to_running(&conn, &fixture.run_id, "root-session")
            .expect("Idle canonical Root can start a Provider turn"),
        1
    );
    let run_status = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            [&fixture.run_id],
            |row| row.get::<_, String>(0),
        )
        .expect("load idle run status");
    assert_eq!(
        run_status,
        AgentOrgRunStatus::Idle.as_str(),
        "Root Q&A admission must not activate formal Team work"
    );

    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status=?1,archived_at=NULL,archive_receipt_id=NULL WHERE id=?2",
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
fn provider_preflight_allows_only_running_or_canonical_root_idle_turns() {
    assert!(
        ensure_agent_org_turn_is_runnable("run", AgentOrgRunStatus::Running, false, false).is_ok()
    );
    assert!(ensure_agent_org_turn_is_runnable("run", AgentOrgRunStatus::Idle, true, false).is_ok());

    for (status, code) in [
        (AgentOrgRunStatus::Starting, "team_not_ready"),
        (AgentOrgRunStatus::Paused, "team_paused"),
        (AgentOrgRunStatus::Idle, "team_idle"),
        (AgentOrgRunStatus::Failed, "team_unavailable"),
        (AgentOrgRunStatus::Archived, "team_archived"),
    ] {
        let error = ensure_agent_org_turn_is_runnable("run", status, false, false)
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
