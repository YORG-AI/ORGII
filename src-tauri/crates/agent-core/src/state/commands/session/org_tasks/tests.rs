//! Unit tests for the Agent Org session command families.
//!
//! These exercise cross-family helpers (run-view projection, group-chat
//! persistence/history, resume/wake orchestration, intervention boundaries), so
//! they live in one module and pull the internals in through `super::*`.

use super::*;

use std::collections::HashMap;

use database::db::get_connection;
use rusqlite::params;

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, USER_SENDER_ID,
};
use crate::coordination::agent_member_interventions::{
    AgentMemberInterventionStore, EnterMemberInterventionParams,
};
use crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalSummary;
use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunStatus, AgentOrgRunStore,
    COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{Task, TaskExecutionMode, TaskStatus, TaskSummary};
use crate::definitions::orgs::{AgentOrgLaunchSnapshot, FlatOrgMember, PlanApprovalPolicy};
use crate::foundation::session_bridge::{TurnIntentBridgeSource, TurnIntentBridgeStatus};

fn context_with_shared_member_agent_id() -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: "run-shared-agent".to_string(),
        org_id: "org-shared-agent".to_string(),
        org_name: "Shared Agent Org".to_string(),
        org_role: "Coordinate shared backend members".to_string(),
        coordinator_agent_id: "builtin:sde".to_string(),
        coordinator_name: "Coordinator".to_string(),
        coordinator_role: "Lead".to_string(),
        members: vec![
            AgentOrgContextMember {
                member_id: "member-planner".to_string(),
                name: "Planner".to_string(),
                role: "Plan work".to_string(),
                agent_id: "builtin:sde".to_string(),
            },
            AgentOrgContextMember {
                member_id: "member-builder".to_string(),
                name: "Builder".to_string(),
                role: "Build work".to_string(),
                agent_id: "builtin:sde".to_string(),
            },
        ],
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        capability_index: Default::default(),
        root_session_id: Some("root-shared-agent".to_string()),
    }
}

fn prepare_command_run(status: &str) -> AgentOrgRunContext {
    let context = context_with_shared_member_agent_id();
    let conn = get_connection().expect("db connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
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
            PRIMARY KEY (session_id, turn_intent_id)
        );",
    )
    .expect("base Turn lifecycle schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("complete Agent Org schemas");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs (
             id, org_id, coordinator_agent_id, root_session_id,
             org_snapshot_json, entry_mode, status, work_item_id,
             project_slug, routine_fire_id, summary, last_error,
             created_at, updated_at, idled_at,archived_at,archive_receipt_id
         ) VALUES (?1, ?2, ?3, ?4, NULL, 'standalone_session', ?5,
                   NULL, NULL, NULL, NULL, NULL, ?6, ?6, NULL,
                   CASE WHEN ?5='archived' THEN ?6 ELSE NULL END,
                   CASE WHEN ?5='archived' THEN ?7 ELSE NULL END)",
        params![
            &context.run_id,
            &context.org_id,
            &context.coordinator_agent_id,
            context.root_session_id.as_deref(),
            status,
            &now,
            format!("{}-archive-receipt", context.run_id),
        ],
    )
    .expect("insert command test run");
    context
}

fn inbox_count_for_member(context: &AgentOrgRunContext, member_id: &str) -> usize {
    let conn = get_connection().expect("db connection");
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox
             WHERE org_run_id=?1 AND recipient_member_id=?2",
            params![&context.run_id, member_id],
            |row| row.get(0),
        )
        .expect("count member inbox rows");
    usize::try_from(count).expect("non-negative inbox count")
}

struct PauseTurnSeed<'a> {
    session_id: &'a str,
    turn_intent_id: &'a str,
    turn_kind: &'a str,
    intent_status: &'a str,
    task_id: Option<&'a str>,
    activation_generation: Option<i64>,
    member_sequence: Option<i64>,
}

fn seed_pause_turn_context(
    conn: &rusqlite::Connection,
    context: &AgentOrgRunContext,
    seed: PauseTurnSeed<'_>,
) {
    let PauseTurnSeed {
        session_id,
        turn_intent_id,
        turn_kind,
        intent_status,
        task_id,
        activation_generation,
        member_sequence,
    } = seed;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents (
            session_id,turn_intent_id,client_message_id,org_run_id,source,status,
            created_at,updated_at
         ) VALUES (?1,?2,?2,?3,'agent_org',?4,?5,?5)",
        params![
            session_id,
            turn_intent_id,
            &context.run_id,
            intent_status,
            &now
        ],
    )
    .expect("insert Pause base Turn");
    let (
        participant_id,
        task_id,
        owner,
        dispatch_member,
        source_kind,
        source_id,
        root_turn,
        actor_version,
    ) = match turn_kind {
        "coordinator" => (
            COORDINATOR_MEMBER_ID,
            None,
            None,
            None,
            "root_turn",
            turn_intent_id,
            None,
            None,
        ),
        "task_execution" => {
            let task_id = task_id.unwrap_or("pause-task");
            (
                "member-planner",
                Some(task_id),
                Some("member-planner"),
                Some("member-planner"),
                "task",
                task_id,
                None,
                None,
            )
        }
        "user_directed_work" => (
            "member-planner",
            None,
            None,
            Some("member-planner"),
            "direct_member",
            turn_intent_id,
            Some(turn_intent_id),
            Some(1_i64),
        ),
        other => panic!("unknown test Turn kind {other}"),
    };
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,task_id,
            owner_member_id,dispatch_member_id,member_dispatch_sequence,source_kind,
            source_id,root_authority_turn_id,actor_version,activation_generation,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            session_id,
            turn_intent_id,
            &context.run_id,
            participant_id,
            turn_kind,
            task_id,
            owner,
            dispatch_member,
            member_sequence,
            source_kind,
            source_id,
            root_turn,
            actor_version,
            activation_generation,
            &now,
        ],
    )
    .expect("insert Pause companion context");
}

fn test_upsert_pause_turn_intent(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    org_run_id: Option<&str>,
    source: TurnIntentBridgeSource,
    status: TurnIntentBridgeStatus,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO session_turn_intents (
            session_id,turn_intent_id,client_message_id,org_run_id,source,status,
            created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        params![
            session_id,
            turn_intent_id,
            client_message_id,
            org_run_id,
            source.as_str(),
            status.as_str(),
            &now,
        ],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn configure_pause_resume_authority(conn: &rusqlite::Connection, context: &AgentOrgRunContext) {
    crate::foundation::session_bridge::register_upsert_turn_intent_with_connection(
        test_upsert_pause_turn_intent,
    );
    let snapshot = AgentOrgLaunchSnapshot {
        schema_version: 1,
        org_id: context.org_id.clone(),
        org_name: context.org_name.clone(),
        coordinator_role: context.coordinator_role.clone(),
        coordinator_agent_id: context.coordinator_agent_id.clone(),
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: context
            .members
            .iter()
            .map(|member| FlatOrgMember {
                member_id: member.member_id.clone(),
                name: member.name.clone(),
                role: member.role.clone(),
                agent_id: member.agent_id.clone(),
                runtime_config: None,
            })
            .collect(),
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };
    conn.execute(
        "UPDATE agent_org_runtime_runs SET org_snapshot_json=?2 WHERE id=?1",
        params![
            &context.run_id,
            serde_json::to_string(&snapshot).expect("serialize test snapshot")
        ],
    )
    .expect("install immutable launch snapshot");
    let now = chrono::Utc::now().to_rfc3339();
    for (session_id, agent_id, member_id) in [
        (
            context.root_session_id.as_deref().expect("root session"),
            context.coordinator_agent_id.as_str(),
            COORDINATOR_MEMBER_ID,
        ),
        ("planner-session", "builtin:sde", "member-planner"),
    ] {
        conn.execute(
            "INSERT INTO agent_sessions (
                session_id,name,status,created_at,updated_at,session_type,
                agent_definition_id,org_member_id
             ) VALUES (?1,?1,'idle',?4,?4,'agent',?2,?3)",
            params![session_id, agent_id, member_id, &now],
        )
        .expect("seed canonical materialized Agent session");
    }
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations (
            org_run_id,member_id,agent_id,generation,session_id,authority_class,
            status,created_at,updated_at
         ) VALUES (?1,?2,?3,1,?4,'formal','succeeded',?5,?5)",
        params![
            &context.run_id,
            COORDINATOR_MEMBER_ID,
            &context.coordinator_agent_id,
            context.root_session_id.as_deref().expect("root session"),
            &now,
        ],
    )
    .expect("materialize coordinator");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations (
            org_run_id,member_id,agent_id,generation,session_id,authority_class,
            status,created_at,updated_at
         ) VALUES (?1,'member-planner','builtin:sde',1,'planner-session','formal',
                   'succeeded',?2,?2)",
        params![&context.run_id, &now],
    )
    .expect("materialize planner");
}

#[test]
fn pr3_group_chat_rejects_legacy_member_before_inbox_write() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");

    let error = persist_pr3_group_chat_message(
        &context,
        "builtin:sde",
        "member-planner",
        "This Member producer has no typed PR3 authority",
        Some("@Planner This Member producer has no typed PR3 authority"),
    )
    .expect_err("PR3 must reject the legacy Member producer");

    assert!(
        error.starts_with(
            crate::coordination::agent_org_turn_contexts::TURN_CONTEXT_INVARIANT_PREFIX
        ),
        "{error}"
    );
    assert!(error.contains("without typed authority"), "{error}");
    assert_eq!(inbox_count_for_member(&context, "member-planner"), 0);
}

fn inbox_record(
    sender_member_id: Option<&str>,
    recipient_member_id: Option<&str>,
) -> AgentInboxRecord {
    AgentInboxRecord {
        id: 7,
        recipient_agent_id: "builtin:sde".to_string(),
        recipient_member_id: recipient_member_id.map(str::to_string),
        sender_agent_id: "builtin:sde".to_string(),
        sender_member_id: sender_member_id.map(str::to_string),
        org_run_id: Some("run-shared-agent".to_string()),
        payload_kind: "plain".to_string(),
        payload_json: serde_json::to_string(&AgentMessage::Plain {
            summary: "Ready".to_string(),
            text: "Ready for review".to_string(),
        })
        .expect("serialize payload"),
        request_id: None,
        created_at: "2026-05-28T00:00:00Z".to_string(),
        read_at: None,
    }
}

#[test]
fn inbox_row_names_prefer_member_ids_when_agents_share_backend() {
    let context = context_with_shared_member_agent_id();
    let rows = enrich_inbox_rows(
        &context,
        vec![inbox_record(Some("member-builder"), Some("member-planner"))],
    );

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].sender_name, "Builder");
    assert_eq!(rows[0].recipient_name, "Planner");
}

#[test]
fn inbox_row_names_resolve_coordinator_member_id_before_agent_id() {
    let context = context_with_shared_member_agent_id();
    let rows = enrich_inbox_rows(
        &context,
        vec![inbox_record(
            Some(COORDINATOR_MEMBER_ID),
            Some("member-builder"),
        )],
    );

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].sender_name, "Coordinator");
    assert_eq!(rows[0].recipient_name, "Builder");
}

fn task_for_resume(owner: Option<&str>, status: TaskStatus) -> Task {
    Task {
        id: "resume-task".to_string(),
        org_run_id: "run-shared-agent".to_string(),
        subject: "Resume work".to_string(),
        description: "Continue after pause".to_string(),
        active_form: None,
        owner: owner.map(str::to_string),
        status,
        execution_mode: TaskExecutionMode::Build,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
        output: None,
        failure_reason: None,
        cancel_reason: None,
        created_by_participant_id: "coordinator".to_string(),
        source_turn_intent_id: "turn-test".to_string(),
        originating_message_id: None,
        replaces_task_id: None,
        created_at: "2026-05-28T00:00:00Z".to_string(),
        updated_at: "2026-05-28T00:00:00Z".to_string(),
    }
}

#[test]
fn run_phase_projects_completed_work_as_finalizing_then_idle() {
    let overview = AgentOrgRunTaskOverview {
        total: 1,
        pending: 0,
        in_progress: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
        corrupt: 0,
        visible: 1,
        truncated: false,
    };
    assert_eq!(
        project_run_phase(AgentOrgRunStatus::Running, &[], &overview, 0, &[]),
        AgentOrgRunPhase::Finalizing
    );
    assert_eq!(
        project_run_phase(
            AgentOrgRunStatus::Idle,
            &[],
            &AgentOrgRunTaskOverview {
                total: 0,
                pending: 0,
                in_progress: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
                corrupt: 0,
                visible: 0,
                truncated: false,
            },
            0,
            &[],
        ),
        AgentOrgRunPhase::Idle
    );
}

fn assert_run_view_is_a_pure_read(status: &str) {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("session snapshot schema");
    crate::session::persistence::init(&conn).expect("session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
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
    .expect("runtime support schemas");
    drop(conn);

    let context = prepare_command_run(status);
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: "root-shared-agent".to_string(),
            name: "Coordinator".to_string(),
            status: crate::session::SessionStatus::Idle.as_str().to_string(),
            session_type: "agent".to_string(),
            agent_definition_id: Some("builtin:sde".to_string()),
            org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            created_at: "2026-05-28T00:00:00Z".to_string(),
            updated_at: "2026-05-28T00:00:00Z".to_string(),
            ..Default::default()
        },
    )
    .expect("persist coordinator Session");
    let observer = get_connection().expect("observer connection");
    let before_data_version: i64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .expect("read data version");
    let before_updated_at: String = observer
        .query_row(
            "SELECT updated_at FROM agent_org_runtime_runs WHERE id=?1",
            [&context.run_id],
            |row| row.get(0),
        )
        .expect("read run timestamp");

    let view = build_agent_org_run_view(&context, COORDINATOR_MEMBER_ID.to_string())
        .expect("build pure Run View");

    let after_data_version: i64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .expect("read data version after Run View");
    let after_updated_at: String = observer
        .query_row(
            "SELECT updated_at FROM agent_org_runtime_runs WHERE id=?1",
            [&context.run_id],
            |row| row.get(0),
        )
        .expect("read run timestamp after Run View");
    assert_eq!(view.run_status, status);
    assert_eq!(after_data_version, before_data_version);
    assert_eq!(after_updated_at, before_updated_at);
}

#[test]
fn running_run_view_is_a_pure_read_and_does_not_advance_updated_at() {
    assert_run_view_is_a_pure_read("running");
}

#[test]
fn archived_run_view_is_a_pure_read_and_does_not_advance_updated_at() {
    assert_run_view_is_a_pure_read("archived");
}

#[test]
fn run_view_projects_only_active_interventions_and_distinguishes_formal_handoffs() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS code_sessions (
             session_id TEXT PRIMARY KEY,
             cli_agent_type TEXT NOT NULL,
             status TEXT NOT NULL,
             parent_session_id TEXT,
             org_member_id TEXT,
             updated_at TEXT NOT NULL
         );",
    )
    .expect("CLI Session projection schema");
    drop(conn);
    for (session_id, member_id) in [
        ("planner-direct-session", "member-planner"),
        ("builder-direct-session", "member-builder"),
    ] {
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: session_id.to_string(),
                name: member_id.to_string(),
                status: crate::session::SessionStatus::Idle.as_str().to_string(),
                session_type: "agent".to_string(),
                agent_definition_id: Some("builtin:sde".to_string()),
                org_member_id: Some(member_id.to_string()),
                parent_session_id: context.root_session_id.clone(),
                created_at: "2026-08-26T00:00:00Z".to_string(),
                updated_at: "2026-08-26T00:00:00Z".to_string(),
                ..Default::default()
            },
        )
        .expect("persist canonical Member Session");
    }

    let conn = get_connection().expect("db connection");
    let now = "2026-08-26T00:00:00Z";
    conn.execute(
        "INSERT INTO agent_org_runtime_member_interventions (
            intervention_receipt_id,org_run_id,member_id,agent_id,session_id,
            status,source_event_id,entered_at,last_user_activity_at,updated_at
         ) VALUES ('receipt-side-quest',?1,'member-planner','builtin:sde',
                   'planner-direct-session','active','event-side-quest',?2,?2,?2)",
        params![&context.run_id, now],
    )
    .expect("insert nonbusy direct receipt");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_interventions (
            intervention_receipt_id,org_run_id,member_id,agent_id,session_id,
            status,source_event_id,original_task_id,original_turn_intent_id,
            entered_at,last_user_activity_at,updated_at
         ) VALUES ('receipt-formal-handoff',?1,'member-builder','builtin:sde',
                   'builder-direct-session','active','event-formal-handoff',
                   'task-formal','turn-formal',?2,?2,?2)",
        params![&context.run_id, now],
    )
    .expect("insert formal handoff receipt");
    for (session_id, turn_id, source_event_id, receipt_id) in [
        (
            "planner-direct-session",
            "turn-side-quest",
            "event-side-quest",
            "receipt-side-quest",
        ),
        (
            "builder-direct-session",
            "turn-formal-direct",
            "event-formal-handoff",
            "receipt-formal-handoff",
        ),
    ] {
        conn.execute(
            "INSERT INTO session_turn_intents (
                session_id,turn_intent_id,client_message_id,org_run_id,source,status,
                created_at,updated_at
             ) VALUES (?1,?2,?2,?3,'agent_org','running',?4,?4)",
            params![session_id, turn_id, &context.run_id, now],
        )
        .expect("insert direct base Turn");
        conn.execute(
            "INSERT INTO agent_org_runtime_member_intervention_turns (
                intervention_receipt_id,session_id,turn_intent_id,source_event_id,
                dispatch_content,display_content,member_dispatch_sequence,
                chain_position,status,enqueued_at,started_at
             ) VALUES (?1,?2,?3,?4,'direct work','direct work',1,1,'running',?5,?5)",
            params![receipt_id, session_id, turn_id, source_event_id, now],
        )
        .expect("insert running direct chain Turn");
    }
    drop(conn);

    let active_view = build_agent_org_run_view(&context, "member-planner".to_string())
        .expect("build active Run View");
    let planner = active_view
        .members
        .iter()
        .find(|member| member.member_id == "member-planner")
        .expect("planner member");
    assert!(matches!(
        planner.activity.as_ref().map(|activity| &activity.kind),
        Some(AgentOrgMemberActivityKind::SideQuest)
    ));
    let builder = active_view
        .members
        .iter()
        .find(|member| member.member_id == "member-builder")
        .expect("builder member");
    assert!(matches!(
        builder.activity.as_ref().map(|activity| &activity.kind),
        Some(AgentOrgMemberActivityKind::UserIntervention)
    ));

    assert!(
        AgentMemberInterventionStore::clear(&context.run_id, "member-planner")
            .expect("clear nonbusy receipt")
    );
    assert!(
        AgentMemberInterventionStore::clear(&context.run_id, "member-builder")
            .expect("clear formal receipt")
    );
    let cleared_view = build_agent_org_run_view(&context, "member-planner".to_string())
        .expect("build cleared Run View");
    for member_id in ["member-planner", "member-builder"] {
        let member = cleared_view
            .members
            .iter()
            .find(|member| member.member_id == member_id)
            .expect("cleared member");
        assert!(member.activity.is_none());
        assert!(member.intervention.is_none());
    }
}

#[test]
fn task_runtime_projects_execution_mode_on_the_wire() {
    let task = AgentOrgTaskRuntime {
        task: task_for_resume(Some("member-planner"), TaskStatus::Pending),
        description_truncated: false,
        blocks_truncated: false,
        blocked_by_truncated: false,
        dependencies_satisfied: true,
        execution_mode: TaskExecutionMode::Plan,
        output_summary: None,
        owner_member: None,
        owner_runtime: None,
    };

    let value = serde_json::to_value(task).expect("serialize task runtime");
    assert_eq!(value["executionMode"], "plan");
}

#[test]
fn run_view_task_omits_durable_metadata_and_output() {
    let context = context_with_shared_member_agent_id();
    let projected = tasks_for_context(
        &context,
        vec![TaskSummary {
            id: "resume-task".to_string(),
            subject: "Resume work".to_string(),
            description: "bounded description".to_string(),
            description_truncated: true,
            active_form: None,
            owner: Some("member-builder".to_string()),
            status: TaskStatus::Completed,
            blocks: Vec::new(),
            blocks_truncated: false,
            blocked_by: Vec::new(),
            blocked_by_truncated: false,
            dependencies_satisfied: true,
            eligible_member_ids: vec!["member-builder".to_string()],
            eligible_member_ids_truncated: false,
            required_role: None,
            execution_mode: TaskExecutionMode::Build,
            output: None,
            failure_reason: None,
            cancel_reason: None,
            replaces_task_id: None,
            created_at: "2026-05-28T00:00:00Z".to_string(),
            updated_at: "2026-05-28T00:00:00Z".to_string(),
        }],
        &HashMap::new(),
    );
    assert_eq!(projected.len(), 1);
    assert!(projected[0].task.metadata.is_none());
    assert_eq!(projected[0].task.description, "bounded description");
    assert!(projected[0].description_truncated);
}

#[test]
fn run_view_inbox_preview_omits_durable_payload_json() {
    let row = AgentOrgInboxPreviewRow {
        id: 7,
        recipient_agent_id: "agent-a".to_string(),
        recipient_member_id: Some("member-a".to_string()),
        sender_agent_id: USER_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some("run-a".to_string()),
        payload_kind: "plain".to_string(),
        request_id: None,
        created_at: "2026-05-28T00:00:00Z".to_string(),
        read_at: None,
        delivery_resolution: None,
        recipient_name: "Alice".to_string(),
        sender_name: "User".to_string(),
        display_text: "hello".to_string(),
    };

    let value = serde_json::to_value(row).expect("serialize inbox preview");
    assert!(value.get("payloadJson").is_none());
    assert_eq!(value["displayText"], "hello");
}

#[test]
fn run_phase_projects_quiet_user_plan_gate_as_awaiting_approval() {
    let task = AgentOrgTaskRuntime {
        task: task_for_resume(Some("member-planner"), TaskStatus::InProgress),
        description_truncated: false,
        blocks_truncated: false,
        blocked_by_truncated: false,
        dependencies_satisfied: true,
        execution_mode: TaskExecutionMode::Plan,
        output_summary: None,
        owner_member: None,
        owner_runtime: None,
    };
    let overview = AgentOrgRunTaskOverview {
        total: 1,
        pending: 0,
        in_progress: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        corrupt: 0,
        visible: 1,
        truncated: false,
    };
    let approval = AgentOrgPlanApprovalSummary {
        approval_id: "approval-1".to_string(),
        plan_revision_id: "revision-1".to_string(),
        request_id: "request-1".to_string(),
        org_run_id: "run-shared-agent".to_string(),
        source_task_id: task.task.id.clone(),
        source_member_id: "member-planner".to_string(),
        source_session_id: "planner-session".to_string(),
        source_turn_intent_id: "planner-turn".to_string(),
        root_session_id: "root-shared-agent".to_string(),
        policy: crate::definitions::orgs::PlanApprovalPolicy::User,
        status: crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStatus::Pending,
        plan_title: "Plan".to_string(),
        plan_content_bytes: 6,
        created_at: "2026-05-28T00:00:00Z".to_string(),
    };
    assert_eq!(
        project_run_phase(AgentOrgRunStatus::Running, &[], &overview, 0, &[approval]),
        AgentOrgRunPhase::AwaitingPlanApproval
    );
}

#[test]
fn resume_wake_requires_unread_inbox() {
    assert_eq!(should_wake_member_for_progress(false), None);
    assert_eq!(
        should_wake_member_for_progress(true),
        Some(AgentOrgWakeReason::UnreadInbox)
    );
}

#[test]
fn archived_group_message_writes_neither_inbox_nor_intervention_clear() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
    })
    .expect("enter intervention");
    let conn = get_connection().expect("db connection");
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='archived',activation_generation=activation_generation+1,
             archived_at=?2,archive_receipt_id=?3
         WHERE id=?1",
        params![
            &context.run_id,
            chrono::Utc::now().to_rfc3339(),
            format!("{}-group-test-archive-receipt", context.run_id)
        ],
    )
    .expect("archive test Run without clearing the corruption fixture");

    let error = persist_group_chat_message(
        &context,
        "builtin:sde",
        "member-planner",
        "This must not enter an Archived run",
        None,
    )
    .expect_err("Archived run rejects group message");

    assert!(error.contains("team_archived"));
    assert_eq!(inbox_count_for_member(&context, "member-planner"), 0);
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("load intervention")
            .is_some(),
        "a rejected terminal message must not partially clear intervention state"
    );
}

#[test]
fn paused_group_message_is_rejected_without_inbox_write_or_auto_resume() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("paused");
    let error = persist_group_chat_message(
        &context,
        &context.coordinator_agent_id,
        COORDINATOR_MEMBER_ID,
        "This must wait for explicit Resume",
        None,
    )
    .expect_err("Paused run rejects Group Chat submission");
    assert!(error.contains("this status does not accept"));
    assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 0);
    assert_eq!(
        AgentOrgRunStore::get_run_status(&context.run_id).expect("run status"),
        Some(AgentOrgRunStatus::Paused)
    );
}

#[test]
fn group_message_does_not_clear_direct_intervention() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
    })
    .expect("enter intervention");
    persist_group_chat_message(
        &context,
        "builtin:sde",
        "member-planner",
        "Group chat must not Return a direct intervention",
        None,
    )
    .expect("persist independent group message");

    assert_eq!(inbox_count_for_member(&context, "member-planner"), 1);
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("load intervention")
            .is_some(),
        "group messaging cannot substitute for explicit receipt-based Return"
    );
}

#[test]
fn group_chat_history_pages_all_rows_and_preserves_long_display_text_after_reload() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let long_body = "长".repeat(900);
    let long_display = format!("@Planner {long_body}");
    for index in 0..205 {
        let (body, display) = if index == 204 {
            (long_body.as_str(), long_display.as_str())
        } else {
            (
                "historical group message",
                "@Planner historical group message",
            )
        };
        persist_group_chat_message(
            &context,
            "builtin:sde",
            "member-planner",
            body,
            Some(display),
        )
        .expect("persist history row");
    }

    let first =
        load_group_chat_history_page(&context, None, 100).expect("load newest history page");
    assert_eq!(first.rows.len(), 100);
    assert!(first.has_more);
    assert_eq!(
        first.rows.last().expect("newest row").display_text,
        long_display
    );
    assert_eq!(first.rows.last().expect("newest row").text, long_body);

    let mut all_ids = first
        .rows
        .iter()
        .map(|row| row.inbox_id)
        .collect::<Vec<_>>();
    let mut before = first.next_before_id;
    while let Some(cursor) = before {
        let page = load_group_chat_history_page(&context, Some(cursor), 100)
            .expect("load older history page");
        all_ids.extend(page.rows.iter().map(|row| row.inbox_id));
        before = page.next_before_id;
        if !page.has_more {
            break;
        }
    }
    all_ids.sort_unstable();
    all_ids.dedup();
    assert_eq!(
        all_ids.len(),
        205,
        "cursor pages must have no gaps or duplicates"
    );

    let conn = get_connection().expect("db connection");
    conn.execute(
        "UPDATE agent_org_runtime_runs
         SET status='archived',activation_generation=activation_generation+1,
             archived_at=?2,archive_receipt_id=?3
         WHERE id=?1",
        params![
            &context.run_id,
            chrono::Utc::now().to_rfc3339(),
            format!("{}-history-archive-receipt", context.run_id)
        ],
    )
    .expect("archive run");
    assert_eq!(
        load_group_chat_history_page(&context, None, 100)
            .expect("terminal history stays readable")
            .rows
            .len(),
        100
    );
}

#[test]
fn pause_episode_and_resume_request_are_durable_and_idempotent() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let pause_request = "00000000-0000-4000-8000-000000000001";
    let resume_request = "00000000-0000-4000-8000-000000000002";

    let first_commit =
        crate::coordination::agent_org_pause::pause_run_commit(&context.run_id, pause_request)
            .expect("pause transaction");
    let first = first_commit.outcome;
    assert!(first_commit.teardown_owner_id.is_some());
    let duplicate_commit =
        crate::coordination::agent_org_pause::pause_run_commit(&context.run_id, pause_request)
            .expect("duplicate pause request");
    let duplicate = duplicate_commit.outcome;
    assert!(duplicate_commit.teardown_owner_id.is_none());
    assert!(first.transitioned);
    assert_eq!(duplicate, first);
    assert_eq!(first.captured_turn_count, 0);

    let resumed = crate::coordination::agent_org_pause::resume_run(&context.run_id, resume_request)
        .expect("resume transaction");
    let duplicate_resume =
        crate::coordination::agent_org_pause::resume_run(&context.run_id, resume_request)
            .expect("duplicate resume request");
    assert!(resumed.transitioned);
    assert_eq!(duplicate_resume, resumed);
    assert_eq!(resumed.resume_generation, first.pause_generation + 1);
    assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 0);
}

#[test]
fn concurrent_pause_and_resume_requests_advance_each_episode_once() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let run_id = context.run_id.clone();
    let pause_request = "00000000-0000-4000-8000-000000000201".to_string();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let pause_threads = (0..8)
        .map(|_| {
            let run_id = run_id.clone();
            let request_id = pause_request.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                crate::coordination::agent_org_pause::pause_run(&run_id, &request_id)
            })
        })
        .collect::<Vec<_>>();
    let pause_results = pause_threads
        .into_iter()
        .map(|thread| thread.join().expect("Pause worker did not panic"))
        .collect::<Result<Vec<_>, _>>()
        .expect("same-request concurrent Pause");
    assert!(pause_results.iter().all(|outcome| outcome.transitioned));
    assert!(pause_results.windows(2).all(|pair| pair[0] == pair[1]));

    let resume_request = "00000000-0000-4000-8000-000000000202".to_string();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let resume_threads = (0..8)
        .map(|_| {
            let run_id = run_id.clone();
            let request_id = resume_request.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                crate::coordination::agent_org_pause::resume_run(&run_id, &request_id)
            })
        })
        .collect::<Vec<_>>();
    let resume_results = resume_threads
        .into_iter()
        .map(|thread| thread.join().expect("Resume worker did not panic"))
        .collect::<Result<Vec<_>, _>>()
        .expect("same-request concurrent Resume");
    assert!(resume_results.iter().all(|outcome| outcome.transitioned));
    assert!(resume_results.windows(2).all(|pair| pair[0] == pair[1]));

    crate::coordination::agent_org_pause::pause_run(
        &run_id,
        "00000000-0000-4000-8000-000000000203",
    )
    .expect("second Pause episode");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let different_resume_threads = (0..8)
        .map(|index| {
            let run_id = run_id.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                crate::coordination::agent_org_pause::resume_run(
                    &run_id,
                    &format!("00000000-0000-4000-8000-{:012}", 300 + index),
                )
            })
        })
        .collect::<Vec<_>>();
    let different_resume_results = different_resume_threads
        .into_iter()
        .map(|thread| {
            thread
                .join()
                .expect("different Resume worker did not panic")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        different_resume_results
            .iter()
            .filter(|result| result.as_ref().is_ok_and(|outcome| outcome.transitioned))
            .count(),
        1
    );
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let different_pause_threads = (0..8)
        .map(|index| {
            let run_id = run_id.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                crate::coordination::agent_org_pause::pause_run(
                    &run_id,
                    &format!("00000000-0000-4000-8000-{:012}", 400 + index),
                )
            })
        })
        .collect::<Vec<_>>();
    let different_pause_results = different_pause_threads
        .into_iter()
        .map(|thread| thread.join().expect("different Pause worker did not panic"))
        .collect::<Result<Vec<_>, _>>()
        .expect("different-request concurrent Pause");
    assert_eq!(
        different_pause_results
            .iter()
            .filter(|outcome| outcome.transitioned)
            .count(),
        1
    );
    let conn = get_connection().expect("db connection");
    let final_state: (String, i64, i64) = conn
        .query_row(
            "SELECT status,activation_generation,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_episodes WHERE org_run_id=?1)
             FROM agent_org_runtime_runs WHERE id=?1",
            [&run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read concurrent lifecycle state");
    assert_eq!(final_state, ("paused".to_string(), 6, 3));
}

#[test]
fn pause_run_update_failure_writes_no_episode_or_handoff() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TRIGGER reject_pause_run_update
         BEFORE UPDATE ON agent_org_runtime_runs
         WHEN OLD.status='running' AND NEW.status='paused'
         BEGIN SELECT RAISE(ABORT, 'injected pause run update failure'); END;",
    )
    .expect("install Pause run update trigger");
    drop(conn);

    let error = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000021",
    )
    .expect_err("run update failure aborts Pause");
    assert!(error.contains("injected pause run update failure"));
    let conn = get_connection().expect("db connection");
    let state: (String, i64, i64, i64) = conn
        .query_row(
            "SELECT status,activation_generation,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_episodes WHERE org_run_id=?1),
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_handoffs WHERE org_run_id=?1)
             FROM agent_org_runtime_runs WHERE id=?1",
            [&context.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read failed Pause run update state");
    assert_eq!(state, ("running".to_string(), 1, 0, 0));
}

#[test]
fn pause_episode_insert_failure_rolls_back_status_generation_and_episode() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    let original_generation: i64 = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_runs WHERE id=?1",
            params![&context.run_id],
            |row| row.get(0),
        )
        .expect("original generation");
    conn.execute_batch(
        "CREATE TRIGGER reject_pause_episode
         BEFORE INSERT ON agent_org_runtime_pause_episodes
         BEGIN SELECT RAISE(ABORT, 'injected pause episode failure'); END;",
    )
    .expect("install failure trigger");
    drop(conn);

    let error = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000003",
    )
    .expect_err("episode failure rolls back Pause fence");
    assert!(error.contains("injected pause episode failure"));
    let conn = get_connection().expect("db connection");
    let state: (String, i64, i64) = conn
        .query_row(
            "SELECT status,activation_generation,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_episodes WHERE org_run_id=?1)
             FROM agent_org_runtime_runs WHERE id=?1",
            params![&context.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("rolled-back Pause state");
    assert_eq!(state, ("running".to_string(), original_generation, 0));
}

#[test]
fn pause_captures_only_current_generation_formal_in_flight_turns() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "queued-coordinator",
            turn_kind: "coordinator",
            intent_status: "queued",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "planner-session-running",
            turn_intent_id: "running-task",
            turn_kind: "task_execution",
            intent_status: "running",
            task_id: Some("pause-task"),
            activation_generation: Some(1),
            member_sequence: Some(1),
        },
    );
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "planner-session-direct",
            turn_intent_id: "running-user-directed",
            turn_kind: "user_directed_work",
            intent_status: "running",
            task_id: None,
            activation_generation: None,
            member_sequence: Some(2),
        },
    );
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-old-generation",
            turn_intent_id: "running-old-generation",
            turn_kind: "coordinator",
            intent_status: "running",
            task_id: None,
            activation_generation: Some(2),
            member_sequence: None,
        },
    );
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-terminal",
            turn_intent_id: "completed-coordinator",
            turn_kind: "coordinator",
            intent_status: "completed",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);

    let outcome = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000004",
    )
    .expect("Pause selector transaction");
    assert_eq!(outcome.captured_turn_count, 2);
    assert_eq!(outcome.draining_turn_count, 1);

    let conn = get_connection().expect("db connection");
    let captured: Vec<(String, String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT original_turn_intent_id,turn_kind,drain_status
                 FROM agent_org_runtime_pause_handoffs
                 WHERE episode_id=?1 ORDER BY original_turn_intent_id",
            )
            .expect("prepare receipt query");
        statement
            .query_map([&outcome.episode_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("query receipts")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect receipts")
    };
    assert_eq!(
        captured,
        vec![
            (
                "queued-coordinator".to_string(),
                "coordinator".to_string(),
                "runtime_absent".to_string(),
            ),
            (
                "running-task".to_string(),
                "task_execution".to_string(),
                "waiting".to_string(),
            ),
        ]
    );
    let statuses: Vec<(String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT turn_intent_id,status FROM session_turn_intents
                 ORDER BY turn_intent_id",
            )
            .expect("prepare status query");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query statuses")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect statuses")
    };
    assert!(statuses.contains(&("queued-coordinator".to_string(), "stale".to_string())));
    assert!(statuses.contains(&("running-task".to_string(), "running".to_string())));
    assert!(statuses.contains(&("running-user-directed".to_string(), "running".to_string())));
}

#[test]
fn pause_release_receipt_requires_the_exact_runtime_lease_and_turn_generation() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "release-owner-session",
            turn_intent_id: "release-owner-intent",
            turn_kind: "coordinator",
            intent_status: "running",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);
    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000041",
    )
    .expect("Pause before owner binding");
    assert!(
        crate::coordination::agent_org_pause::bind_runtime_and_request_yield(
            &paused.episode_id,
            "release-owner-session",
            "release-owner-intent",
            "lease-current",
            "turn-current",
        )
        .expect("bind exact runtime owner")
    );

    assert_eq!(
        crate::coordination::agent_org_pause::mark_released(
            "release-owner-session",
            "release-owner-intent",
            "lease-old",
            "turn-current",
        )
        .expect("stale release callback"),
        None
    );
    assert_eq!(
        crate::coordination::agent_org_pause::mark_released(
            "release-owner-session",
            "release-owner-intent",
            "lease-current",
            "turn-old",
        )
        .expect("stale generation callback"),
        None
    );
    let conn = get_connection().expect("db connection");
    let still_waiting: String = conn
        .query_row(
            "SELECT drain_status FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 AND session_id='release-owner-session'",
            [&paused.episode_id],
            |row| row.get(0),
        )
        .expect("read handoff after stale callbacks");
    assert_eq!(still_waiting, "waiting");
    drop(conn);

    assert_eq!(
        crate::coordination::agent_org_pause::mark_released(
            "release-owner-session",
            "release-owner-intent",
            "lease-current",
            "turn-current",
        )
        .expect("release exact owner"),
        Some(paused.episode_id.clone())
    );
    let conn = get_connection().expect("db connection");
    let released: String = conn
        .query_row(
            "SELECT drain_status FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 AND session_id='release-owner-session'",
            [&paused.episode_id],
            |row| row.get(0),
        )
        .expect("read released handoff");
    assert_eq!(released, "released");
}

#[test]
fn pause_nth_child_failure_rolls_back_fence_and_all_receipts() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    for (index, intent) in ["child-one", "child-two"].into_iter().enumerate() {
        seed_pause_turn_context(
            &conn,
            &context,
            PauseTurnSeed {
                session_id: if index == 0 {
                    "child-session-one"
                } else {
                    "child-session-two"
                },
                turn_intent_id: intent,
                turn_kind: "coordinator",
                intent_status: "queued",
                task_id: None,
                activation_generation: Some(1),
                member_sequence: None,
            },
        );
    }
    conn.execute_batch(
        "CREATE TRIGGER reject_second_pause_child
         BEFORE INSERT ON agent_org_runtime_pause_handoffs
         WHEN NEW.original_turn_intent_id='child-two'
         BEGIN SELECT RAISE(ABORT, 'injected second child failure'); END;",
    )
    .expect("install child failure trigger");
    drop(conn);

    let error = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000005",
    )
    .expect_err("N-th child failure rolls back entire Pause");
    assert!(error.contains("injected second child failure"), "{error}");
    let conn = get_connection().expect("db connection");
    let state: (String, i64, i64, i64) = conn
        .query_row(
            "SELECT status,activation_generation,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_episodes WHERE org_run_id=?1),
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_handoffs WHERE org_run_id=?1)
             FROM agent_org_runtime_runs WHERE id=?1",
            [&context.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read rolled-back child state");
    assert_eq!(state, ("running".to_string(), 1, 0, 0));
}

#[test]
fn stale_formal_turn_cannot_materialize_or_ack_inbox_after_pause_fence() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "coordinator-inbox-turn",
            turn_kind: "coordinator",
            intent_status: "running",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);
    let materialize_row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: context.coordinator_agent_id.clone(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        sender_agent_id: USER_SENDER_ID.to_string(),
        sender_member_id: Some(USER_SENDER_ID.to_string()),
        org_run_id: Some(context.run_id.clone()),
        message: AgentMessage::Plain {
            summary: "materialize race".to_string(),
            text: "materialize race".to_string(),
        },
    })
    .expect("insert materialize race row");
    let ack_row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: context.coordinator_agent_id.clone(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        sender_agent_id: USER_SENDER_ID.to_string(),
        sender_member_id: Some(USER_SENDER_ID.to_string()),
        org_run_id: Some(context.run_id.clone()),
        message: AgentMessage::Plain {
            summary: "ack race".to_string(),
            text: "ack race".to_string(),
        },
    })
    .expect("insert ack race row");
    let conn = get_connection().expect("db connection");
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox_materializations (
            inbox_id,session_id,transcript_message_id,transcript_intent_id,materialized_at
         ) VALUES (?1,'root-shared-agent','message-ack','intent-ack',?2)",
        params![ack_row.id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("seed transcript receipt owned by old Turn session");
    drop(conn);

    crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000006",
    )
    .expect("commit Pause fence before Inbox writes");

    let materialize_error =
        crate::session::persistence::materialize_agent_org_inbox_transcript_for_turn(
            "root-shared-agent",
            "coordinator-inbox-turn",
            &[materialize_row.id],
            "message-materialize",
            "intent-materialize",
            "materialize race",
        )
        .expect_err("old Turn cannot materialize after Pause");
    assert!(
        materialize_error.contains("cannot execute in Team status paused"),
        "{materialize_error}"
    );
    let ack_error = AgentInboxStore::mark_many_read_for_turn(
        &[ack_row.id],
        "root-shared-agent",
        "coordinator-inbox-turn",
    )
    .expect_err("old Turn cannot acknowledge after Pause");
    assert!(
        ack_error.contains("generation fence rejected"),
        "{ack_error}"
    );

    let conn = get_connection().expect("db connection");
    let unread_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox
             WHERE id IN (?1,?2) AND read_at IS NULL",
            params![materialize_row.id, ack_row.id],
            |row| row.get(0),
        )
        .expect("read post-race Inbox state");
    let materialize_receipt_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox_materializations
             WHERE inbox_id=?1",
            [materialize_row.id],
            |row| row.get(0),
        )
        .expect("count rejected materialization receipts");
    assert_eq!(unread_count, 2);
    assert_eq!(materialize_receipt_count, 0);
}

#[test]
fn resume_continues_only_legal_work_and_preserves_member_fifo_without_mutating_tasks() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute_batch(
        "INSERT INTO agent_org_runtime_member_dispatch_allocators
            (org_run_id,member_id,next_sequence)
         VALUES ('run-shared-agent','member-planner',6);",
    )
    .expect("seed FIFO allocator");
    for (task_id, status, output_json) in [
        ("open-a", "pending", None),
        ("open-b", "in_progress", None),
        (
            "completed-c",
            "completed",
            Some(r#"{"summary":"finished before Pause"}"#),
        ),
        ("reassigned-d", "pending", None),
        ("old-materialization-e", "pending", None),
    ] {
        conn.execute(
            "INSERT INTO agent_org_runtime_tasks (
                id,org_run_id,subject,description,owner,status,execution_mode,
                blocked_by_json,output_json,cancel_reason_json,created_by_participant_id,
                source_turn_intent_id,created_at,updated_at
             ) VALUES (?1,?2,?1,'resume legality','member-planner',?3,'build','[]',
                       ?4,NULL,'coordinator','seed-task',?5,?5)",
            params![task_id, &context.run_id, status, output_json, &now],
        )
        .expect("seed Resume legality Task");
    }
    conn.execute(
        "UPDATE agent_org_runtime_tasks SET owner='member-builder'
         WHERE org_run_id=?1 AND id='reassigned-d'",
        [&context.run_id],
    )
    .expect("seed reassigned Task owner");
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox (
             recipient_agent_id,recipient_member_id,sender_agent_id,sender_member_id,
             org_run_id,payload_kind,payload_json,created_at
         ) VALUES ('planner-agent','member-planner','coordinator-agent','coordinator',
                   ?1,'task_assigned',?2,?3)",
        params![
            &context.run_id,
            r#"{"kind":"task_assigned","task_id":"completed-c"}"#,
            &now
        ],
    )
    .expect("seed terminal Task assignment Inbox row");
    let terminal_assignment_inbox_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox_materializations (
             inbox_id,session_id,transcript_message_id,transcript_intent_id,materialized_at
         ) VALUES (?1,'planner-session','terminal-assignment-message',
                   'terminal-assignment-intent',?2)",
        params![terminal_assignment_inbox_id, &now],
    )
    .expect("seed terminal Task assignment materialization");
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "resume-root",
            turn_kind: "coordinator",
            intent_status: "running",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    for (sequence, task_id, intent_status) in [
        (1, "open-a", "running"),
        (2, "open-b", "queued"),
        (3, "completed-c", "running"),
        (4, "reassigned-d", "running"),
        (5, "old-materialization-e", "running"),
    ] {
        seed_pause_turn_context(
            &conn,
            &context,
            PauseTurnSeed {
                session_id: if task_id == "old-materialization-e" {
                    "planner-old-session"
                } else {
                    "planner-session"
                },
                turn_intent_id: &format!("resume-{task_id}"),
                turn_kind: "task_execution",
                intent_status,
                task_id: Some(task_id),
                activation_generation: Some(1),
                member_sequence: Some(sequence),
            },
        );
    }
    let tasks_before: Vec<(String, String, Option<String>)> = {
        let mut statement = conn
            .prepare(
                "SELECT id,status,owner FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 ORDER BY id",
            )
            .expect("prepare Task snapshot");
        statement
            .query_map([&context.run_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("query Task snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect Task snapshot")
    };
    drop(conn);

    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000007",
    )
    .expect("Pause formal work");
    assert_eq!(paused.captured_turn_count, 6);
    let resumed = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000008",
    )
    .expect("Resume legal formal work");
    assert_eq!(resumed.continuation_count, 3);
    assert_eq!(resumed.skipped_count, 3);

    let conn = get_connection().expect("db connection");
    let tasks_after: Vec<(String, String, Option<String>)> = {
        let mut statement = conn
            .prepare(
                "SELECT id,status,owner FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 ORDER BY id",
            )
            .expect("prepare post-Resume Task snapshot");
        statement
            .query_map([&context.run_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("query post-Resume Task snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect post-Resume Task snapshot")
    };
    assert_eq!(
        tasks_after, tasks_before,
        "Pause/Resume must not rewrite Tasks"
    );
    let planner_sequences: Vec<i64> = {
        let mut statement = conn
            .prepare(
                "SELECT context.member_dispatch_sequence
                 FROM agent_org_runtime_pause_handoffs handoff
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=handoff.session_id
                  AND context.turn_intent_id=handoff.continuation_turn_intent_id
                 WHERE handoff.episode_id=?1
                   AND handoff.participant_id='member-planner'
                   AND handoff.continuation_status='queued'
                 ORDER BY context.member_dispatch_sequence",
            )
            .expect("prepare continuation FIFO query");
        statement
            .query_map([&resumed.episode_id], |row| row.get(0))
            .expect("query continuation FIFO")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect continuation FIFO")
    };
    assert_eq!(planner_sequences, vec![6, 7]);
    let skipped_reason: String = conn
        .query_row(
            "SELECT skip_reason FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 AND task_id='completed-c'",
            [&resumed.episode_id],
            |row| row.get(0),
        )
        .expect("read terminal Task skip reason");
    assert_eq!(skipped_reason, "task_completed");
    let terminal_assignment_resolution: (String, String, Option<String>, i64) = conn
        .query_row(
            "SELECT resolution.resolution_kind,resolution.reason,inbox.read_at,
                    (SELECT COUNT(*)
                     FROM agent_org_runtime_inbox_materializations materialization
                     WHERE materialization.inbox_id=inbox.id)
             FROM agent_org_runtime_inbox inbox
             JOIN agent_org_runtime_inbox_delivery_resolutions resolution
               ON resolution.inbox_id=inbox.id
             WHERE inbox.id=?1",
            [terminal_assignment_inbox_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read terminal Task assignment resolution");
    assert_eq!(
        terminal_assignment_resolution,
        (
            "cancelled".to_string(),
            "pause_resume_task_completed".to_string(),
            None,
            0,
        ),
        "Resume must resolve the stale assignment without falsifying its read receipt"
    );
    let other_skip_reasons: Vec<(String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT task_id,skip_reason FROM agent_org_runtime_pause_handoffs
                 WHERE episode_id=?1 AND task_id IN ('reassigned-d','old-materialization-e')
                 ORDER BY task_id",
            )
            .expect("prepare legality skip query");
        statement
            .query_map([&resumed.episode_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query legality skips")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect legality skips")
    };
    assert_eq!(
        other_skip_reasons,
        vec![
            (
                "old-materialization-e".to_string(),
                "member_materialization_changed".to_string(),
            ),
            ("reassigned-d".to_string(), "task_owner_changed".to_string(),),
        ]
    );
}

#[test]
fn exact_resume_continuation_consumes_old_assignment_only_after_task_success() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_member_dispatch_allocators
            (org_run_id,member_id,next_sequence)
         VALUES (?1,'member-planner',2)",
        [&context.run_id],
    )
    .expect("seed continuation FIFO");
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks (
            id,org_run_id,subject,description,owner,status,execution_mode,
            blocked_by_json,output_json,cancel_reason_json,created_by_participant_id,
            source_turn_intent_id,created_at,updated_at
         ) VALUES ('resume-owned-task',?1,'Resume owned task','',
                   'member-planner','in_progress','build','[]',NULL,NULL,
                   'coordinator','seed-task',?2,?2)",
        params![&context.run_id, &now],
    )
    .expect("seed in-progress Task");
    let assignment = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "builtin:sde".to_string(),
        recipient_member_id: Some("member-planner".to_string()),
        sender_agent_id: context.coordinator_agent_id.clone(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        org_run_id: Some(context.run_id.clone()),
        message: AgentMessage::TaskAssigned {
            task_id: "resume-owned-task".to_string(),
            subject: "Resume owned task".to_string(),
            description: String::new(),
            assigned_by: "Coordinator".to_string(),
            execution_mode: TaskExecutionMode::Build,
            dependency_outputs: Vec::new(),
        },
    })
    .expect("seed old assignment");
    let unrelated_assignment = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "builtin:sde".to_string(),
        recipient_member_id: Some("member-planner".to_string()),
        sender_agent_id: context.coordinator_agent_id.clone(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        org_run_id: Some(context.run_id.clone()),
        message: AgentMessage::TaskAssigned {
            task_id: "resume-owned-task".to_string(),
            subject: "Unmaterialized duplicate must stay unrelated".to_string(),
            description: String::new(),
            assigned_by: "Coordinator".to_string(),
            execution_mode: TaskExecutionMode::Build,
            dependency_outputs: Vec::new(),
        },
    })
    .expect("seed unrelated unmaterialized assignment");
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "planner-session",
            turn_intent_id: "resume-owned-original",
            turn_kind: "task_execution",
            intent_status: "running",
            task_id: Some("resume-owned-task"),
            activation_generation: Some(1),
            member_sequence: Some(1),
        },
    );
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox_materializations (
             inbox_id,session_id,transcript_message_id,transcript_intent_id,materialized_at
         ) VALUES (?1,'planner-session','resume-owned-message',
                   'resume-owned-transcript-intent',?2)",
        params![assignment.id, &now],
    )
    .expect("materialize assignment before Pause");
    drop(conn);

    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000021",
    )
    .expect("Pause in-progress Task");
    assert!(crate::coordination::agent_org_pause::mark_runtime_absent(
        &paused.episode_id,
        "planner-session",
        "resume-owned-original",
    )
    .expect("mark old runtime absent"));
    let resumed = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000022",
    )
    .expect("Resume in-progress Task");
    assert_eq!(resumed.continuation_count, 1);

    let conn = get_connection().expect("db connection");
    let continuation_turn_intent_id: String = conn
        .query_row(
            "SELECT continuation_turn_intent_id
             FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 AND task_id='resume-owned-task'",
            [&resumed.episode_id],
            |row| row.get(0),
        )
        .expect("read Task continuation");
    drop(conn);
    assert!(
        crate::coordination::agent_org_pause::claim_continuation_dispatch(
            &resumed.episode_id,
            &continuation_turn_intent_id,
        )
        .expect("claim Task continuation")
    );
    let conn = get_connection().expect("db connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id='planner-session' AND turn_intent_id=?1",
        [&continuation_turn_intent_id],
    )
    .expect("start Task continuation");

    let old_turn_batch = AgentInboxStore::list_unread_task_input_for_turn(
        "member-planner",
        &context.run_id,
        "resume-owned-task",
        "planner-session",
        "resume-owned-original",
    )
    .expect("probe stale original Turn");
    assert!(old_turn_batch.rows.is_empty());
    let continuation_batch = AgentInboxStore::list_unread_task_input_for_turn(
        "member-planner",
        &context.run_id,
        "resume-owned-task",
        "planner-session",
        &continuation_turn_intent_id,
    )
    .expect("exact continuation claims old assignment");
    assert_eq!(
        continuation_batch
            .rows
            .iter()
            .map(|row| row.id)
            .collect::<Vec<_>>(),
        vec![assignment.id]
    );
    drop(conn);

    let early_ack = AgentInboxStore::mark_many_read_for_turn(
        &[assignment.id],
        "planner-session",
        &continuation_turn_intent_id,
    )
    .expect_err("in-progress Task must leave assignment unread");
    assert!(early_ack.contains("did not complete the Task successfully"));

    let conn = get_connection().expect("db connection");
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET status='completed',output_json='{}',updated_at=?3
         WHERE org_run_id=?1 AND id=?2",
        params![
            &context.run_id,
            "resume-owned-task",
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .expect("complete resumed Task");
    drop(conn);
    assert_eq!(
        AgentInboxStore::mark_many_read_for_turn(
            &[assignment.id],
            "planner-session",
            &continuation_turn_intent_id,
        )
        .expect("successful continuation acknowledges assignment"),
        1
    );
    let conn = get_connection().expect("db connection");
    let read_at: Option<String> = conn
        .query_row(
            "SELECT read_at FROM agent_org_runtime_inbox WHERE id=?1",
            [assignment.id],
            |row| row.get(0),
        )
        .expect("read assignment receipt");
    assert!(read_at.is_some());
    let unrelated_read_at: Option<String> = conn
        .query_row(
            "SELECT read_at FROM agent_org_runtime_inbox WHERE id=?1",
            [unrelated_assignment.id],
            |row| row.get(0),
        )
        .expect("read unrelated assignment");
    assert!(
        unrelated_read_at.is_none(),
        "Resume must not acknowledge an unmaterialized duplicate assignment"
    );
}

#[test]
fn resume_run_update_failure_keeps_active_episode_without_continuations() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "resume-run-update-root",
            turn_kind: "coordinator",
            intent_status: "queued",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);
    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000022",
    )
    .expect("Pause before Resume run update fault");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TRIGGER reject_resume_run_update
         BEFORE UPDATE ON agent_org_runtime_runs
         WHEN OLD.status='paused' AND NEW.status='running'
         BEGIN SELECT RAISE(ABORT, 'injected Resume run update failure'); END;",
    )
    .expect("install Resume run update trigger");
    drop(conn);

    let error = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000023",
    )
    .expect_err("run update failure aborts Resume");
    assert!(error.contains("injected Resume run update failure"));
    let conn = get_connection().expect("db connection");
    let state: (String, i64, String, i64, i64) = conn
        .query_row(
            "SELECT run.status,run.activation_generation,episode.status,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_handoffs handoff
                     WHERE handoff.episode_id=episode.episode_id
                       AND handoff.continuation_status IS NOT NULL),
                    (SELECT COUNT(*) FROM session_turn_intents intent
                     WHERE intent.org_run_id=run.id AND intent.source='resume')
             FROM agent_org_runtime_runs run
             JOIN agent_org_runtime_pause_episodes episode ON episode.org_run_id=run.id
             WHERE run.id=?1",
            [&context.run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read failed Resume run update state");
    assert_eq!(
        state,
        (
            "paused".to_string(),
            paused.pause_generation,
            "active".to_string(),
            0,
            0
        )
    );
}

#[test]
fn resume_continuation_insert_failure_rolls_back_run_and_receipts() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "resume-continuation-fault-root",
            turn_kind: "coordinator",
            intent_status: "queued",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);
    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000024",
    )
    .expect("Pause before Resume continuation fault");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TRIGGER reject_resume_continuation_insert
         BEFORE INSERT ON session_turn_intents
         WHEN NEW.source='resume'
         BEGIN SELECT RAISE(ABORT, 'injected Resume continuation failure'); END;",
    )
    .expect("install Resume continuation trigger");
    drop(conn);

    let error = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000025",
    )
    .expect_err("continuation failure aborts Resume");
    assert!(error.contains("injected Resume continuation failure"));
    let conn = get_connection().expect("db connection");
    let state: (String, i64, String, i64, i64) = conn
        .query_row(
            "SELECT run.status,run.activation_generation,episode.status,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_handoffs handoff
                     WHERE handoff.episode_id=episode.episode_id
                       AND handoff.continuation_status IS NOT NULL),
                    (SELECT COUNT(*) FROM session_turn_intents intent
                     WHERE intent.org_run_id=run.id AND intent.source='resume')
             FROM agent_org_runtime_runs run
             JOIN agent_org_runtime_pause_episodes episode ON episode.org_run_id=run.id
             WHERE run.id=?1",
            [&context.run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read failed Resume continuation state");
    assert_eq!(
        state,
        (
            "paused".to_string(),
            paused.pause_generation,
            "active".to_string(),
            0,
            0
        )
    );
}

#[test]
fn resume_precommit_failure_rolls_back_generation_episode_and_continuations() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "resume-fault-root",
            turn_kind: "coordinator",
            intent_status: "queued",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);
    let paused = crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000009",
    )
    .expect("Pause before Resume fault");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TRIGGER reject_resume_precommit
         BEFORE UPDATE ON agent_org_runtime_pause_episodes
         WHEN NEW.status='consumed'
         BEGIN SELECT RAISE(ABORT, 'injected Resume precommit failure'); END;",
    )
    .expect("install Resume failure trigger");
    drop(conn);

    let error = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000010",
    )
    .expect_err("Resume precommit fault rolls back all writes");
    assert!(
        error.contains("injected Resume precommit failure"),
        "{error}"
    );
    let conn = get_connection().expect("db connection");
    let state: (String, i64, String, i64, i64) = conn
        .query_row(
            "SELECT run.status,run.activation_generation,episode.status,
                    (SELECT COUNT(*) FROM agent_org_runtime_pause_handoffs handoff
                     WHERE handoff.episode_id=episode.episode_id
                       AND handoff.continuation_status IS NOT NULL),
                    (SELECT COUNT(*) FROM session_turn_intents intent
                     WHERE intent.org_run_id=run.id AND intent.source='resume')
             FROM agent_org_runtime_runs run
             JOIN agent_org_runtime_pause_episodes episode ON episode.org_run_id=run.id
             WHERE run.id=?1",
            [&context.run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read rolled-back Resume state");
    assert_eq!(
        state,
        (
            "paused".to_string(),
            paused.pause_generation,
            "active".to_string(),
            0,
            0
        )
    );
}

#[test]
fn restart_recovers_one_durable_continuation_without_replaying_it_twice() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    let conn = get_connection().expect("db connection");
    configure_pause_resume_authority(&conn, &context);
    seed_pause_turn_context(
        &conn,
        &context,
        PauseTurnSeed {
            session_id: "root-shared-agent",
            turn_intent_id: "restart-root",
            turn_kind: "coordinator",
            intent_status: "running",
            task_id: None,
            activation_generation: Some(1),
            member_sequence: None,
        },
    );
    drop(conn);
    crate::coordination::agent_org_pause::pause_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000011",
    )
    .expect("Pause before restart");
    let resumed = crate::coordination::agent_org_pause::resume_run(
        &context.run_id,
        "00000000-0000-4000-8000-000000000012",
    )
    .expect("Resume before restart");
    let conn = get_connection().expect("db connection");
    let continuation_turn_intent_id: String = conn
        .query_row(
            "SELECT continuation_turn_intent_id
             FROM agent_org_runtime_pause_handoffs WHERE episode_id=?1",
            [&resumed.episode_id],
            |row| row.get(0),
        )
        .expect("read continuation id");
    drop(conn);
    assert!(
        crate::coordination::agent_org_pause::claim_continuation_dispatch(
            &resumed.episode_id,
            &continuation_turn_intent_id,
        )
        .expect("simulate pre-crash dispatch claim")
    );
    let nudge = crate::coordination::agent_org_pause::continuation_nudge_for_turn(
        "root-shared-agent",
        &continuation_turn_intent_id,
    )
    .expect("resolve durable continuation nudge")
    .expect("claimed continuation has transient provider work");
    assert!(nudge.contains("Continue coordinating the paused Agent Org run"));

    let conn = get_connection().expect("db connection");
    conn.execute(
        "UPDATE session_turn_intents SET status='running'
         WHERE session_id='root-shared-agent' AND turn_intent_id=?1",
        [&continuation_turn_intent_id],
    )
    .expect("simulate a continuation that crossed the scheduler boundary before crash");
    let first = crate::coordination::reconcile_agent_org_turns_after_restart(&conn)
        .expect("first restart reconciliation");
    assert!(
        first >= 3,
        "runtime absence, running intent, and dispatch claim should reconcile"
    );
    let recovered: (String, String, String) = conn
        .query_row(
            "SELECT handoff.drain_status,handoff.continuation_status,intent.status
             FROM agent_org_runtime_pause_handoffs handoff
             JOIN session_turn_intents intent
               ON intent.session_id=handoff.session_id
              AND intent.turn_intent_id=handoff.continuation_turn_intent_id
             WHERE handoff.episode_id=?1",
            [&resumed.episode_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read recovered continuation");
    assert_eq!(
        recovered,
        (
            "runtime_absent".to_string(),
            "queued".to_string(),
            "queued".to_string(),
        )
    );
    let second = crate::coordination::reconcile_agent_org_turns_after_restart(&conn)
        .expect("idempotent restart reconciliation");
    assert_eq!(second, 0);
    drop(conn);
    let dispatches = crate::coordination::agent_org_pause::list_dispatchable_continuations(10)
        .expect("list recovered continuations");
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].turn_intent_id, continuation_turn_intent_id);
}
