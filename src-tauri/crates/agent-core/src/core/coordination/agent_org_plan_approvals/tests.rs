use std::path::PathBuf;

use database::db::get_connection;
use rusqlite::params;

use super::*;
use crate::coordination::agent_inbox::{AgentInboxStore, AgentMessage};
use crate::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunEntryMode, AgentOrgRunStatus,
    AgentOrgRunStore, CreateAgentOrgRunParams, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_EXECUTION_MODE,
};
use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember};

fn setup(policy: PlanApprovalPolicy) -> (test_helpers::test_env::SandboxGuard, AgentOrgRunContext) {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("test db");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("inbox schema");
    init_schema(&conn).expect("approval schema");
    let workspace = sandbox.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("create planner workspace");
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(
        &crate::session::persistence::UnifiedSessionRecord {
            session_id: "planner-session".into(),
            name: "Planner".into(),
            status: crate::session::SessionStatus::Idle.as_str().into(),
            created_at: now.clone(),
            updated_at: now,
            session_type: crate::session::persistence::session_type::ORG_MEMBER.into(),
            workspace_path: Some(workspace.to_string_lossy().into_owned()),
            agent_definition_id: Some("planner-agent".into()),
            org_member_id: Some("planner".into()),
            parent_session_id: Some("root-plan-approval".into()),
            ..Default::default()
        },
    )
    .expect("upsert planner session");

    let org = OrgDefinition {
        id: "org-plan-approval".into(),
        name: "Plan Approval Org".into(),
        role: "lead".into(),
        agent_id: "coord-agent".into(),
        description: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: policy,
        children: vec![
            OrgMember {
                id: "planner".into(),
                name: "Planner".into(),
                role: "plan".into(),
                agent_id: "planner-agent".into(),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "builder".into(),
                name: "Builder".into(),
                role: "build".into(),
                agent_id: "builder-agent".into(),
                runtime_config: None,
                children: Vec::new(),
            },
        ],
    };
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some("root-plan-approval".into()),
        org_snapshot: org,
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run");
    let context = AgentOrgRunContext {
        run_id: run.id,
        org_id: "org-plan-approval".into(),
        org_name: "Plan Approval Org".into(),
        org_role: "lead".into(),
        coordinator_agent_id: "coord-agent".into(),
        coordinator_name: "Coordinator".into(),
        coordinator_role: "lead".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: "planner".into(),
                name: "Planner".into(),
                role: "plan".into(),
                agent_id: "planner-agent".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "builder".into(),
                name: "Builder".into(),
                role: "build".into(),
                agent_id: "builder-agent".into(),
                parent_member_id: None,
            },
        ],
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: policy,
        root_session_id: Some("root-plan-approval".into()),
    };
    (sandbox, context)
}

fn create_plan_task(context: &AgentOrgRunContext) {
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "plan-task".into(),
        org_run_id: context.run_id.clone(),
        subject: "Plan the work".into(),
        description: "Produce a plan".into(),
        active_form: None,
        owner: Some("planner".into()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "plan" })),
    })
    .expect("create plan task");
}

fn approval_params(context: &AgentOrgRunContext) -> CreateAgentOrgPlanApprovalParams {
    CreateAgentOrgPlanApprovalParams {
        request_id: "request-plan".into(),
        org_run_id: context.run_id.clone(),
        source_task_id: "plan-task".into(),
        source_member_id: "planner".into(),
        source_session_id: "planner-session".into(),
        root_session_id: "root-plan-approval".into(),
        policy: context.plan_approval_policy,
        plan_title: "Implementation plan".into(),
        plan_path: AgentOrgPlanApprovalStore::managed_plan_path_for_session(
            "planner-session",
            &format!("{}.plan.md", uuid::Uuid::new_v4()),
        )
        .expect("managed planner plan path")
        .to_string_lossy()
        .into_owned(),
        plan_content: "# Plan\n\n1. Build it.".into(),
    }
}

fn create_pending_approval(context: &AgentOrgRunContext) -> AgentOrgPlanApproval {
    AgentOrgPlanApprovalStore::create_pending(approval_params(context)).expect("create approval")
}

fn planner_changes_delivery() -> AgentOrgPlanInboxDelivery {
    AgentOrgPlanInboxDelivery {
        recipient_agent_id: "planner-agent".into(),
        sender_agent_id: "coord-agent".into(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
    }
}

fn coordinator_request_delivery() -> AgentOrgPlanInboxDelivery {
    AgentOrgPlanInboxDelivery {
        recipient_agent_id: "coord-agent".into(),
        sender_agent_id: "planner-agent".into(),
        sender_member_id: Some("planner".into()),
    }
}

#[test]
fn approval_completes_source_task_and_dispatches_unblocked_work() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "build-task".into(),
        org_run_id: context.run_id.clone(),
        subject: "Build the plan".into(),
        description: "Use the approved plan".into(),
        active_form: None,
        owner: Some("builder".into()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: vec!["plan-task".into()],
        metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "build" })),
    })
    .expect("create dependent task");
    let pending = create_pending_approval(&context);

    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        None,
    )
    .expect("approve");
    assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
    let output = crate::coordination::agent_org_tasks::task_output(&approved.task_outcome.current)
        .expect("plan output");
    assert!(output
        .content
        .as_deref()
        .is_some_and(|value| value.contains("Build it")));

    let wake_members = approved.wake_member_ids.clone();
    assert!(wake_members.contains(&"builder".to_string()));
    assert!(wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
    let builder_inbox =
        AgentInboxStore::list_unread_for_member("builder", &context.run_id).unwrap();
    assert!(builder_inbox
        .iter()
        .any(|row| row.payload_kind == "task_assigned"));
}

#[test]
fn approval_dispatches_task_from_legacy_blocks_only_edge() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "legacy-build-task".into(),
        org_run_id: context.run_id.clone(),
        subject: "Build the approved legacy plan".into(),
        description: String::new(),
        active_form: None,
        owner: Some("builder".into()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({ TASK_METADATA_EXECUTION_MODE: "build" })),
    })
    .expect("create legacy dependent task");

    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_tasks SET blocks_json='[\"legacy-build-task\"]'
             WHERE org_run_id=?1 AND id='plan-task'",
        params![&context.run_id],
    )
    .expect("seed legacy upstream blocks edge");
    conn.execute(
        "UPDATE agent_org_tasks SET blocked_by_json='[]'
             WHERE org_run_id=?1 AND id='legacy-build-task'",
        params![&context.run_id],
    )
    .expect("preserve legacy blocks-only representation");
    conn.execute("DELETE FROM agent_inbox", [])
        .expect("remove create-time assignment noise");

    let pending = create_pending_approval(&context);
    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        None,
    )
    .expect("approve legacy graph");

    assert!(approved.wake_member_ids.contains(&"builder".to_string()));
    let assignments = AgentInboxStore::list_unread_for_member("builder", &context.run_id)
        .expect("list builder inbox")
        .into_iter()
        .filter(|row| {
            matches!(
                row.decode_payload(),
                Ok(AgentMessage::TaskAssigned { ref task_id, .. })
                    if task_id == "legacy-build-task"
            )
        })
        .count();
    assert_eq!(assignments, 1);
}

#[test]
fn approval_policy_rejects_the_wrong_decision_actor() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        None,
    )
    .expect_err("coordinator cannot bypass user policy");
    assert!(error.contains("unauthorized"));
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn coordinator_request_and_pending_approval_commit_together() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);

    let approval = AgentOrgPlanApprovalStore::create_pending_with_request(
        approval_params(&context),
        coordinator_request_delivery(),
    )
    .expect("create approval and coordinator request");

    assert_eq!(approval.status, AgentOrgPlanApprovalStatus::Pending);
    let coordinator_inbox =
        AgentInboxStore::list_unread_for_member(COORDINATOR_MEMBER_ID, &context.run_id).unwrap();
    assert!(coordinator_inbox.iter().any(|row| {
        row.payload_kind == "plan_approval_request"
            && row.request_id.as_deref() == Some(approval.request_id.as_str())
    }));
}

#[test]
fn pending_summary_omits_markdown_and_exact_revision_loads_detail() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    let summaries = AgentOrgPlanApprovalStore::list_pending_summaries_by_run(&context.run_id)
        .expect("list pending summaries");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].approval_id, pending.approval_id);
    assert_eq!(
        summaries[0].plan_content_bytes,
        u64::try_from(pending.plan_content.len()).expect("content length")
    );
    let serialized = serde_json::to_value(&summaries[0]).expect("serialize summary");
    assert!(serialized.get("planContent").is_none());
    assert!(serialized.get("planPath").is_none());

    let detail =
        AgentOrgPlanApprovalStore::get_revision(&pending.approval_id, &pending.plan_revision_id)
            .expect("load exact revision")
            .expect("detail exists");
    assert_eq!(detail.plan_content, pending.plan_content);
    assert!(
        AgentOrgPlanApprovalStore::get_revision(&pending.approval_id, "different-revision")
            .expect("load mismatched revision")
            .is_none()
    );
}

#[test]
fn run_scoped_revision_lookup_rejects_cross_run() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    let cross_run = AgentOrgPlanApprovalStore::get_revision_for_run(
        "different-run",
        &pending.approval_id,
        &pending.plan_revision_id,
    )
    .expect("cross-run lookup should be a normal miss");
    assert!(cross_run.is_none());

    let detail = AgentOrgPlanApprovalStore::get_revision_for_run(
        &context.run_id,
        &pending.approval_id,
        &pending.plan_revision_id,
    )
    .expect("authorized lookup")
    .expect("authorized revision exists");
    assert_eq!(detail.plan_content, pending.plan_content);
}

#[test]
fn new_approval_rejects_external_non_plan_path() {
    let (sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let external_notes = sandbox.path().join("notes.md");
    std::fs::write(&external_notes, "user-owned notes").expect("seed external notes");
    let mut params = approval_params(&context);
    params.plan_path = external_notes.to_string_lossy().into_owned();

    let error = AgentOrgPlanApprovalStore::create_pending(params)
        .expect_err("an external notes path must be rejected");
    assert!(error.contains("*.plan.md") || error.contains("managed root"));
    assert_eq!(
        std::fs::read_to_string(&external_notes).expect("read external notes"),
        "user-owned notes"
    );
    assert!(
        AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
            .expect("list approvals")
            .is_empty()
    );
}

#[test]
fn watchdog_pending_task_projection_never_materializes_plan_markdown() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    // An invalid UTF-8 TEXT payload would fail `row.get::<_, String>` if
    // the watchdog accidentally selected plan_content. Selecting only the
    // source id remains valid and proves the hot path does not decode it.
    get_connection()
        .unwrap()
        .execute(
            "UPDATE agent_org_plan_approvals
                 SET plan_content=CAST(X'80' AS TEXT)
                 WHERE approval_id=?1",
            params![&pending.approval_id],
        )
        .unwrap();

    assert_eq!(
        AgentOrgPlanApprovalStore::pending_source_task_ids_by_run(&context.run_id).unwrap(),
        vec!["plan-task".to_string()]
    );
}

#[test]
fn coordinator_request_insert_failure_rolls_back_pending_creation() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    get_connection()
        .expect("test db")
        .execute("DROP TABLE agent_inbox", [])
        .expect("remove inbox to force request delivery failure");

    let params = approval_params(&context);
    let plan_path = PathBuf::from(&params.plan_path);
    let file_name = plan_path.file_name().unwrap().to_string_lossy();
    let staged_prefix = format!(".{file_name}.approval-");

    AgentOrgPlanApprovalStore::create_pending_with_request(params, coordinator_request_delivery())
        .expect_err("request delivery failure must reject approval creation");

    assert!(
        AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
    assert!(
        !plan_path.exists(),
        "a failed DB transaction must not install the derived plan artifact"
    );
    let leaked_stages = std::fs::read_dir(plan_path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(&staged_prefix) && name.ends_with(".tmp")
        })
        .count();
    assert_eq!(
        leaked_stages, 0,
        "a failed DB transaction must clean its pre-staged artifact"
    );
}

#[test]
fn automatic_creation_approves_plan_task_in_one_transaction() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Automatic);
    create_plan_task(&context);

    let approved =
        AgentOrgPlanApprovalStore::create_and_approve_automatic(approval_params(&context))
            .expect("create and automatically approve");

    assert_eq!(
        approved.approval.status,
        AgentOrgPlanApprovalStatus::Approved
    );
    assert_eq!(approved.task_outcome.current.status, TaskStatus::Completed);
    assert!(
        AgentOrgPlanApprovalStore::list_pending_by_run(&context.run_id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn approval_leaves_newly_ready_ownerless_task_for_coordinator_assignment() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "claim-after-plan".into(),
        org_run_id: context.run_id.clone(),
        subject: "Claim approved work".into(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: vec!["plan-task".into()],
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
            TASK_METADATA_EXECUTION_MODE: "build",
        })),
    })
    .expect("create ownerless dependent task");
    let pending = create_pending_approval(&context);
    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        None,
    )
    .expect("approve");

    let wake_members = approved.wake_member_ids.clone();
    assert!(!wake_members.contains(&"builder".to_string()));
    assert!(wake_members.contains(&COORDINATOR_MEMBER_ID.to_string()));
    assert!(
        AgentInboxStore::list_unread_for_member("builder", &context.run_id)
            .unwrap()
            .is_empty(),
        "ownerless work must not forge TaskAssigned or wake a candidate"
    );
    let task = AgentOrgTaskStore::get(&context.run_id, "claim-after-plan")
        .unwrap()
        .unwrap();
    assert_eq!(task.owner, None);
    assert_eq!(task.status, TaskStatus::Pending);
}

#[test]
fn user_edit_is_persisted_to_file_task_output_and_approval() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    std::fs::write(&pending.plan_path, &pending.plan_content).expect("seed plan file");

    let edited = "# Revised plan\n\n1. Validate.\n2. Build.".to_string();
    let approved = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::User,
        Some(edited.clone()),
    )
    .expect("approve edits");

    assert_eq!(approved.approval.plan_content, edited);
    assert_eq!(
        std::fs::read_to_string(&pending.plan_path).expect("read revised plan"),
        edited
    );
    assert_eq!(
        crate::coordination::agent_org_tasks::task_output(&approved.task_outcome.current)
            .and_then(|output| output.content),
        Some(edited)
    );
}

#[test]
fn invalid_artifact_target_rejects_before_approval_mutation() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    std::fs::remove_file(&pending.plan_path).expect("remove materialized artifact");
    std::fs::create_dir(&pending.plan_path).expect("replace artifact with directory");

    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::User,
        Some("# Edited".to_string()),
    )
    .expect_err("a file cannot atomically replace the target directory");
    assert!(error.contains("plan artifact is not a regular file"));
    assert_eq!(
        AgentOrgPlanApprovalStore::get(&pending.approval_id)
            .unwrap()
            .unwrap()
            .status,
        AgentOrgPlanApprovalStatus::Pending
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
    std::fs::remove_dir(&pending.plan_path).expect("remove target directory");
}

#[test]
fn stale_revision_cannot_complete_a_plan_twice() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        None,
    )
    .expect("first approval");

    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        None,
    )
    .expect_err("same revision must be one-shot");
    assert!(error.contains("stale_revision"));
}

#[test]
fn changes_requested_and_feedback_delivery_commit_together() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);

    let (changed, inbox_record) = AgentOrgPlanApprovalStore::request_changes(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "Add rollback coverage.",
        planner_changes_delivery(),
    )
    .expect("request plan changes");

    assert_eq!(changed.status, AgentOrgPlanApprovalStatus::ChangesRequested);
    assert_eq!(inbox_record.recipient_member_id.as_deref(), Some("planner"));
    assert_eq!(inbox_record.payload_kind, "plan_approval_response");
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn feedback_insert_failure_rolls_back_changes_requested_status() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::Coordinator);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    get_connection()
        .expect("test db")
        .execute("DROP TABLE agent_inbox", [])
        .expect("remove inbox to force delivery failure");

    AgentOrgPlanApprovalStore::request_changes(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::Coordinator,
        "This feedback cannot be delivered.",
        planner_changes_delivery(),
    )
    .expect_err("delivery failure must reject the whole transition");

    assert_eq!(
        AgentOrgPlanApprovalStore::get(&pending.approval_id)
            .unwrap()
            .unwrap()
            .status,
        AgentOrgPlanApprovalStatus::Pending
    );
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn paused_run_rejects_plan_decisions_without_mutating_task() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    AgentOrgRunStore::mark_paused(&context.run_id).expect("pause run");

    let error = AgentOrgPlanApprovalStore::approve(
        &pending.approval_id,
        &pending.plan_revision_id,
        AgentOrgPlanDecisionBy::User,
        None,
    )
    .expect_err("paused run must reject approval");
    assert!(error.contains("not_mutable"));
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}

#[test]
fn startup_cleanup_preserves_pending_approval_for_paused_run() {
    let (_sandbox, context) = setup(PlanApprovalPolicy::User);
    create_plan_task(&context);
    let pending = create_pending_approval(&context);
    AgentOrgRunStore::mark_paused(&context.run_id).expect("pause run");

    let cancelled = AgentOrgPlanApprovalStore::cancel_pending_for_terminal_or_missing_runs()
        .expect("run startup approval cleanup");

    assert_eq!(cancelled, 0, "paused runs are resumable, not terminal");
    let reloaded = AgentOrgPlanApprovalStore::get(&pending.approval_id)
        .expect("load approval after startup cleanup")
        .expect("approval still exists");
    assert_eq!(reloaded.status, AgentOrgPlanApprovalStatus::Pending);
    assert_eq!(reloaded.resolved_at, None);
    assert_eq!(
        AgentOrgTaskStore::get(&context.run_id, "plan-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
}
