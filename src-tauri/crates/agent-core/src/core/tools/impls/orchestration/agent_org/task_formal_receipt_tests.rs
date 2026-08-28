use std::sync::Arc;

use database::db::get_connection;
use rusqlite::params;

use super::TaskToolsContext;
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{Task, TaskExecutionMode, TaskOutput, TaskStatus};
use crate::tools::impls::orchestration::org_send_message::NoopInboxWakeHook;

#[test]
fn task_output_receipt_binds_the_exact_source_turn_and_output_digest() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("Task formal receipt database");
    crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("Inbox schema");
    crate::coordination::agent_org_formal_triggers::create_schema(&conn)
        .expect("FormalTriggerReceipt schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
             entry_mode,status,activation_generation,has_initial_work,created_at,updated_at
         ) VALUES (?1,'org-task-output','coordinator-agent','root-task-output',NULL,
                   'standalone_session','running',1,1,?2,?2)",
        params!["run-task-output", &now],
    )
    .expect("running Agent Org run");

    let output = TaskOutput {
        summary: "Verified result".into(),
        content: Some("The owning boundary passed.".into()),
        artifact_ids: vec!["artifact-task-output".into()],
        plan_revision_id: None,
        produced_by_member_id: "worker".into(),
        produced_at: now.clone(),
    };
    let task = Task {
        id: "task-output".into(),
        org_run_id: "run-task-output".into(),
        activation_generation: 1,
        subject: "Produce a durable result".into(),
        description: String::new(),
        active_form: None,
        owner: Some("worker".into()),
        status: TaskStatus::Completed,
        execution_mode: TaskExecutionMode::Build,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
        output: Some(output.clone()),
        failure_reason: None,
        cancel_reason: None,
        created_by_participant_id: COORDINATOR_MEMBER_ID.into(),
        source_turn_intent_id: "coordinator-assignment-turn".into(),
        originating_message_id: None,
        replaces_task_id: None,
        created_at: now.clone(),
        updated_at: now,
    };
    let context = TaskToolsContext {
        org_context: Arc::new(AgentOrgRunContext {
            run_id: "run-task-output".into(),
            org_id: "org-task-output".into(),
            org_name: "Task Output Org".into(),
            org_role: "lead".into(),
            coordinator_agent_id: "coordinator-agent".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "lead".into(),
            members: Vec::new(),
            plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
            capability_index: Default::default(),
            root_session_id: Some("root-task-output".into()),
        }),
        caller_agent_id: "worker-agent".into(),
        caller_member_id: "worker".into(),
        wake_hook: Arc::new(NoopInboxWakeHook),
        app_state: None,
    };

    context
        .persist_task_completed_in_tx(&conn, &task, 0, Some("worker-completion-turn"))
        .expect("persist exact TaskOutput observation");

    let expected_digest = crate::coordination::agent_org_tasks::task_output_digest(&output)
        .expect("canonical TaskOutput digest");
    let receipt: (String, String, String, Option<String>, String, String) = conn
        .query_row(
            "SELECT source_kind,task_id,owner_member_id,source_turn_intent_id,
                    task_output_digest,status
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id='run-task-output'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("TaskOutput FormalTriggerReceipt");
    assert_eq!(receipt.0, "task_output");
    assert_eq!(receipt.1, task.id);
    assert_eq!(receipt.2, "worker");
    assert_eq!(receipt.3.as_deref(), Some("worker-completion-turn"));
    assert_eq!(receipt.4, expected_digest);
    assert_eq!(receipt.5, "pending");
}
