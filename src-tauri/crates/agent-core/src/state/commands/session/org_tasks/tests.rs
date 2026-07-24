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
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunStatus, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{Task, TaskExecutionMode, TaskStatus, TaskSummary};
use crate::definitions::orgs::HierarchyMode;

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
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "member-builder".to_string(),
                name: "Builder".to_string(),
                role: "Build work".to_string(),
                agent_id: "builtin:sde".to_string(),
                parent_member_id: Some("member-planner".to_string()),
            },
        ],
        hierarchy_mode: HierarchyMode::Strict,
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        root_session_id: Some("root-shared-agent".to_string()),
    }
}

fn prepare_command_run(status: &str) -> AgentOrgRunContext {
    let context = context_with_shared_member_agent_id();
    let conn = get_connection().expect("db connection");
    crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("inbox schema");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("intervention schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runs (
             id, org_id, coordinator_agent_id, root_session_id,
             org_snapshot_json, entry_mode, status, work_item_id,
             project_slug, routine_fire_id, summary, last_error,
             created_at, updated_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, 'standalone_session', ?5,
                   NULL, NULL, NULL, NULL, NULL, ?6, ?6, NULL)",
        params![
            &context.run_id,
            &context.org_id,
            &context.coordinator_agent_id,
            context.root_session_id.as_deref(),
            status,
            &now,
        ],
    )
    .expect("insert command test run");
    context
}

fn inbox_count_for_member(context: &AgentOrgRunContext, member_id: &str) -> usize {
    let conn = get_connection().expect("db connection");
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_inbox
             WHERE org_run_id=?1 AND recipient_member_id=?2",
            params![&context.run_id, member_id],
            |row| row.get(0),
        )
        .expect("count member inbox rows");
    usize::try_from(count).expect("non-negative inbox count")
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
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
        created_at: "2026-05-28T00:00:00Z".to_string(),
        updated_at: "2026-05-28T00:00:00Z".to_string(),
    }
}

#[test]
fn run_phase_projects_all_completed_running_board_as_finalizing() {
    let overview = AgentOrgRunTaskOverview {
        total: 1,
        pending: 0,
        in_progress: 0,
        completed: 1,
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
            AgentOrgRunStatus::Completed,
            &[],
            &AgentOrgRunTaskOverview {
                total: 0,
                pending: 0,
                in_progress: 0,
                completed: 0,
                corrupt: 0,
                visible: 0,
                truncated: false,
            },
            0,
            &[],
        ),
        AgentOrgRunPhase::Completed
    );
}

#[test]
fn task_runtime_projects_execution_mode_on_the_wire() {
    let task = AgentOrgTaskRuntime {
        task: task_for_resume(Some("member-planner"), TaskStatus::Pending),
        description_truncated: false,
        blocks_truncated: false,
        blocked_by_truncated: false,
        execution_mode: TaskExecutionMode::Plan,
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
            eligible_member_ids: vec!["member-builder".to_string()],
            eligible_member_ids_truncated: false,
            required_role: None,
            execution_mode: TaskExecutionMode::Build,
            output: None,
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
        execution_mode: TaskExecutionMode::Plan,
        owner_member: None,
        owner_runtime: None,
    };
    let overview = AgentOrgRunTaskOverview {
        total: 1,
        pending: 0,
        in_progress: 1,
        completed: 0,
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
fn terminal_group_message_writes_neither_inbox_nor_intervention_clear() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("completed");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: 60,
    })
    .expect("enter intervention");

    let error = persist_group_chat_message(
        &context,
        "builtin:sde",
        "member-planner",
        "This must not enter a terminal run",
        None,
    )
    .expect_err("terminal run rejects group message");

    assert!(error.contains("terminal runs do not accept"));
    assert_eq!(inbox_count_for_member(&context, "member-planner"), 0);
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("load intervention")
            .is_some(),
        "a rejected terminal message must not partially clear intervention state"
    );
}

#[test]
fn group_message_and_intervention_clear_commit_atomically() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: 60,
    })
    .expect("enter intervention");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TRIGGER reject_intervention_clear
         BEFORE UPDATE OF cleared_at ON agent_member_interventions
         BEGIN
             SELECT RAISE(ABORT, 'injected intervention clear failure');
         END;",
    )
    .expect("install failure trigger");
    drop(conn);

    let error = persist_group_chat_message(
        &context,
        "builtin:sde",
        "member-planner",
        "Both writes must commit together",
        None,
    )
    .expect_err("intervention-clear failure rolls back inbox insert");

    assert!(error.contains("injected intervention clear failure"));
    assert_eq!(inbox_count_for_member(&context, "member-planner"), 0);
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("load intervention")
            .is_some(),
        "the inbox insert must roll back if intervention clear cannot commit"
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
        "UPDATE agent_org_runs SET status='completed' WHERE id=?1",
        params![&context.run_id],
    )
    .expect("terminalize run");
    assert_eq!(
        load_group_chat_history_page(&context, None, 100)
            .expect("terminal history stays readable")
            .rows
            .len(),
        100
    );
}

#[test]
fn paused_resume_and_coordinator_seed_commit_or_rollback_together() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("paused");
    let conn = get_connection().expect("db connection");
    conn.execute_batch(
        "CREATE TRIGGER reject_resume_seed
         BEFORE INSERT ON agent_inbox
         BEGIN
             SELECT RAISE(ABORT, 'injected resume seed failure');
         END;",
    )
    .expect("install failure trigger");
    drop(conn);

    let error = resume_agent_org_context_sync(&context, true)
        .expect_err("seed failure rolls back resume transition");
    assert!(error.contains("injected resume seed failure"));
    let conn = get_connection().expect("db connection");
    let status: String = conn
        .query_row(
            "SELECT status FROM agent_org_runs WHERE id=?1",
            params![&context.run_id],
            |row| row.get(0),
        )
        .expect("load rolled-back run status");
    assert_eq!(status, "paused");
    assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 0);
    conn.execute_batch("DROP TRIGGER reject_resume_seed;")
        .expect("drop failure trigger");
    drop(conn);

    let outcome = resume_agent_org_context_sync(&context, true).expect("resume run");
    assert_eq!(
        outcome,
        AgentOrgResumeOutcome {
            transitioned: true,
            run_is_running: true,
        }
    );
    let conn = get_connection().expect("db connection");
    let status: String = conn
        .query_row(
            "SELECT status FROM agent_org_runs WHERE id=?1",
            params![&context.run_id],
            |row| row.get(0),
        )
        .expect("load resumed run status");
    assert_eq!(status, "running");
    assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 1);
}

#[test]
fn explicit_resume_of_running_run_repairs_unread_without_duplicate_seed() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");

    for _ in 0..2 {
        let outcome =
            resume_agent_org_context_sync(&context, true).expect("idempotent explicit resume");
        assert_eq!(
            outcome,
            AgentOrgResumeOutcome {
                transitioned: false,
                run_is_running: true,
            }
        );
    }

    assert_eq!(inbox_count_for_member(&context, COORDINATOR_MEMBER_ID), 1);
    let targets =
        collect_run_progress_wake_targets(&context.run_id, &org_progress_member_ids(&context))
            .expect("rescan unread inbox rows");
    assert_eq!(
        targets,
        vec![AgentOrgWakeTarget {
            member_id: COORDINATOR_MEMBER_ID.to_string(),
            reason: AgentOrgWakeReason::UnreadInbox,
        }]
    );
}

#[test]
fn return_to_work_boundary_is_not_extended_by_later_mail() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: 60,
    })
    .expect("enter intervention");
    let insert = |summary: &str| {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: Some("member-planner".to_string()),
            sender_agent_id: context.coordinator_agent_id.clone(),
            sender_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            org_run_id: Some(context.run_id.clone()),
            message: AgentMessage::Plain {
                summary: summary.to_string(),
                text: summary.to_string(),
            },
        })
        .expect("insert inbox row")
    };
    let first = insert("pending at return-to-work");
    let (changed, boundary) = AgentMemberInterventionStore::clear_and_capture_unread_boundary(
        &context.run_id,
        "member-planner",
    )
    .expect("clear and capture boundary");
    assert!(changed);
    let boundary = boundary.expect("boundary row");
    assert_eq!(boundary, first.id);

    let later = insert("arrived after return-to-work began");
    assert!(later.id > boundary);
    AgentInboxStore::mark_many_read(&[first.id]).expect("ack original boundary row");

    assert_eq!(
        AgentInboxStore::unread_count_through_boundary(
            "member-planner",
            &context.run_id,
            boundary,
        )
        .expect("count original boundary"),
        0,
        "the acknowledgement wait must finish after its original rows drain"
    );
    assert!(
        AgentInboxStore::has_unread_for_member("member-planner", &context.run_id)
            .expect("later unread remains"),
        "later mail remains unread for the next bounded drain instead of extending this wait"
    );
}

#[test]
fn return_to_work_rolls_back_intervention_clear_when_boundary_capture_fails() {
    let _sandbox = test_helpers::test_env::sandbox();
    let context = prepare_command_run("running");
    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: 60,
    })
    .expect("enter intervention");
    let conn = get_connection().expect("db connection");
    conn.execute("DROP TABLE agent_inbox", [])
        .expect("inject boundary query failure");
    drop(conn);

    let error = AgentMemberInterventionStore::clear_and_capture_unread_boundary(
        &context.run_id,
        "member-planner",
    )
    .expect_err("boundary failure must abort return-to-work transaction");
    assert!(error.contains("agent_inbox"));
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("load intervention after rollback")
            .is_some(),
        "failed boundary capture must not partially clear intervention state"
    );
}

#[test]
fn group_chat_target_clear_exits_direct_intervention() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db connection");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("intervention schema");
    let context = context_with_shared_member_agent_id();

    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id: "member-planner".to_string(),
        agent_id: "builtin:sde".to_string(),
        session_id: "planner-session".to_string(),
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: 60,
    })
    .expect("enter intervention");
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("active before clear")
            .is_some()
    );

    let cleared = clear_group_chat_target_intervention(&context, "member-planner")
        .expect("clear group chat target intervention");

    assert!(cleared);
    assert!(
        AgentMemberInterventionStore::active_for_member(&context.run_id, "member-planner")
            .expect("active after clear")
            .is_none()
    );
}
