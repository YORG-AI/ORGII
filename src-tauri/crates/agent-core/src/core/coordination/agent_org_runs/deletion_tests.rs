use rusqlite::params;

use crate::definitions::orgs::OrgDefinition;
use crate::session::persistence::UnifiedSessionRecord;
use crate::session::SessionStatus;

use super::deletion::{
    establish_conversation_delete_fence, establish_conversation_delete_fence_with_connection,
    is_conversation_deleting_with_connection, CONVERSATION_DELETING_ERROR_CODE,
};
use super::*;

fn sample_org() -> OrgDefinition {
    serde_json::from_str(r#"{"id":"org-delete-fence-test","name":"Delete Fence Test","role":"lead","agentId":"agent-coordinator","hierarchyMode":"flat","planApprovalPolicy":"coordinator","children":[{"id":"member-worker","name":"Worker","role":"worker","agentId":"agent-worker","children":[]}]}"#).unwrap()
}

fn ensure_schemas() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("session snapshot schema");
    crate::session::persistence::init(&conn).expect("unified session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
}

fn run_params(root_session_id: &str, status: AgentOrgRunStatus) -> CreateAgentOrgRunParams {
    let org = sample_org();
    CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some(root_session_id.to_string()),
        org_snapshot: org,
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    }
}

fn create_run(root_session_id: &str, status: AgentOrgRunStatus) -> AgentOrgRunRecord {
    AgentOrgRunStore::create(run_params(root_session_id, status)).expect("create test Run")
}

fn load_status(run_id: &str) -> String {
    database::db::get_connection()
        .expect("test sqlite connection")
        .query_row(
            "SELECT status FROM agent_org_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("load Run status")
}

fn insert_pending_approval(run_id: &str, root_session_id: &str) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO agent_org_plan_approvals (approval_id,plan_revision_id,request_id,org_run_id,source_task_id,source_member_id,source_session_id,root_session_id,policy,status,plan_title,plan_path,plan_content,created_at) VALUES (?1,?2,?3,?4,'task','member-worker','worker',?5,'coordinator','pending','Plan','/tmp/plan.md','# Plan',?6)",
        params![
            format!("approval-{run_id}"),
            format!("revision-{run_id}"),
            format!("request-{run_id}"),
            run_id,
            root_session_id,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("insert pending approval");
}

#[test]
fn starting_status_round_trips_and_is_non_terminal() {
    assert_eq!(
        AgentOrgRunStatus::parse(AgentOrgRunStatus::Starting.as_str()),
        Some(AgentOrgRunStatus::Starting)
    );
    assert!(!AgentOrgRunStatus::Starting.is_terminal());
}

#[test]
fn fence_schema_is_idempotent_and_survives_reopen() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-durable-fence";
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute("DROP TABLE agent_org_conversation_delete_fences", [])
        .expect("simulate a pre-fence database");
    super::init_schema(&conn).expect("upgrade pre-fence database");
    let initially_empty: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_conversation_delete_fences",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(initially_empty, 0);
    let run = create_run(root, AgentOrgRunStatus::Completed);

    establish_conversation_delete_fence(root).expect("establish fence");
    assert_eq!(load_status(&run.id), AgentOrgRunStatus::Completed.as_str());

    let conn = database::db::get_connection().expect("reopened test sqlite connection");
    assert!(is_conversation_deleting_with_connection(&conn, root).unwrap());
    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM agent_org_conversation_delete_fences
             WHERE root_session_id=?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    super::init_schema(&conn).expect("repeat schema initialization");
    assert!(is_conversation_deleting_with_connection(&conn, root).unwrap());

    establish_conversation_delete_fence(root).expect("repeat fence");
    let repeated_created_at: String = conn
        .query_row(
            "SELECT created_at FROM agent_org_conversation_delete_fences
             WHERE root_session_id=?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(repeated_created_at, created_at);
    let fence_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_conversation_delete_fences
             WHERE root_session_id=?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fence_count, 1);
}

#[test]
fn fence_cancels_every_live_status_and_pending_approval() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();

    for (suffix, status) in [
        ("starting", AgentOrgRunStatus::Starting),
        ("running", AgentOrgRunStatus::Running),
        ("paused", AgentOrgRunStatus::Paused),
        ("completed", AgentOrgRunStatus::Completed),
    ] {
        let expected = if status == AgentOrgRunStatus::Completed {
            status
        } else {
            AgentOrgRunStatus::Cancelled
        };
        let root = format!("root-fence-{suffix}");
        let run = create_run(&root, status);
        insert_pending_approval(&run.id, &root);

        establish_conversation_delete_fence(&root).expect("establish fence");
        assert_eq!(load_status(&run.id), expected.as_str());

        let conn = database::db::get_connection().unwrap();
        let approval: (String, Option<String>) = conn
            .query_row(
                "SELECT status, decision_by FROM agent_org_plan_approvals
                 WHERE org_run_id=?1",
                [&run.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            approval,
            ("cancelled".to_string(), Some("system".to_string()))
        );
    }
}

#[test]
fn one_fence_covers_historical_and_live_runs_for_the_same_root() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-fence-multi-run";
    let historical = create_run(root, AgentOrgRunStatus::Completed);
    let live = create_run(root, AgentOrgRunStatus::Running);
    insert_pending_approval(&historical.id, root);
    insert_pending_approval(&live.id, root);

    establish_conversation_delete_fence(root).expect("fence the whole conversation");

    assert_eq!(
        load_status(&historical.id),
        AgentOrgRunStatus::Completed.as_str()
    );
    assert_eq!(load_status(&live.id), AgentOrgRunStatus::Cancelled.as_str());
    let conn = database::db::get_connection().unwrap();
    let cancelled_approvals: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_plan_approvals
             WHERE org_run_id IN (?1, ?2) AND status='cancelled'",
            params![historical.id, live.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cancelled_approvals, 2);
}

#[test]
fn fence_establishment_rolls_back_as_one_transaction() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-fence-rollback";
    let run = create_run(root, AgentOrgRunStatus::Running);
    insert_pending_approval(&run.id, root);

    let mut conn = database::db::get_connection().unwrap();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    establish_conversation_delete_fence_with_connection(&tx, root).unwrap();
    tx.rollback().unwrap();

    assert_eq!(load_status(&run.id), AgentOrgRunStatus::Running.as_str());
    let conn = database::db::get_connection().unwrap();
    assert!(!is_conversation_deleting_with_connection(&conn, root).unwrap());
    let approval_status: String = conn
        .query_row(
            "SELECT status FROM agent_org_plan_approvals WHERE org_run_id=?1",
            [&run.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(approval_status, "pending");
}

#[test]
fn fenced_root_rejects_run_creation_and_worker_materialization_without_orphans() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-fence-write-guards";
    let run = create_run(root, AgentOrgRunStatus::Running);
    establish_conversation_delete_fence(root).expect("establish fence");

    let create_error = AgentOrgRunStore::create(run_params(root, AgentOrgRunStatus::Running))
        .expect_err("fenced root must reject a new Run");
    assert!(create_error.starts_with(CONVERSATION_DELETING_ERROR_CODE));

    let coordinator = UnifiedSessionRecord {
        session_id: root.to_string(),
        name: "Blocked coordinator".to_string(),
        status: SessionStatus::Idle.as_str().to_string(),
        session_type: "agent".to_string(),
        agent_definition_id: Some("agent-coordinator".to_string()),
        org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    let coordinator_error = AgentOrgRunStore::create_with_coordinator_session(
        run_params(root, AgentOrgRunStatus::Running),
        Default::default(),
        &coordinator,
    )
    .expect_err("fenced root must reject coordinator materialization");
    assert!(coordinator_error.starts_with(CONVERSATION_DELETING_ERROR_CODE));

    let worker = UnifiedSessionRecord {
        session_id: "blocked-worker".to_string(),
        name: "Blocked worker".to_string(),
        status: SessionStatus::Pending.as_str().to_string(),
        session_type: crate::session::persistence::session_type::ORG_MEMBER.to_string(),
        agent_definition_id: Some("agent-worker".to_string()),
        org_member_id: Some("member-worker".to_string()),
        parent_session_id: Some(root.to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    let worker_error =
        AgentOrgRunStore::materialize_rust_worker_sessions(&run.id, &[worker.clone()])
            .expect_err("fenced root must reject worker materialization");
    assert!(worker_error.starts_with(CONVERSATION_DELETING_ERROR_CODE));

    let conn = database::db::get_connection().unwrap();
    let session_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_sessions
             WHERE session_id IN (?1, ?2)",
            params![root, worker.session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(session_count, 0);
    let run_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runs WHERE root_session_id=?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(run_count, 1);
}

#[test]
fn standalone_run_delete_cannot_remove_ownership_beneath_a_root_fence() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-fenced-standalone-run-delete";
    let run = create_run(root, AgentOrgRunStatus::Completed);
    establish_conversation_delete_fence(root).expect("establish fence");

    let error = AgentOrgRunStore::delete_by_id(&run.id)
        .expect_err("standalone cleanup must not bypass root deletion ownership");
    assert!(error.starts_with(CONVERSATION_DELETING_ERROR_CODE));

    let conn = database::db::get_connection().unwrap();
    let run_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runs WHERE id=?1",
            [&run.id],
            |row| row.get(0),
        )
        .unwrap();
    let mapping_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_run_sessions WHERE org_run_id=?1",
            [&run.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(run_count, 1);
    assert_eq!(mapping_count, 1);
    assert!(is_conversation_deleting_with_connection(&conn, root).unwrap());
}

#[test]
fn unfenced_live_or_paused_run_can_finish_materializing_workers() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    for status in [
        AgentOrgRunStatus::Starting,
        AgentOrgRunStatus::Running,
        AgentOrgRunStatus::Paused,
    ] {
        let root = format!("root-{}-materialization", status.as_str());
        let run = create_run(&root, status);
        let worker_id = format!("{}-worker", status.as_str());
        let worker = UnifiedSessionRecord {
            session_id: worker_id.clone(),
            name: "Materializing worker".to_string(),
            status: SessionStatus::Pending.as_str().to_string(),
            session_type: crate::session::persistence::session_type::ORG_MEMBER.to_string(),
            agent_definition_id: Some("agent-worker".to_string()),
            org_member_id: Some("member-worker".to_string()),
            parent_session_id: Some(root),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };

        AgentOrgRunStore::materialize_rust_worker_sessions(&run.id, &[worker])
            .expect("unfenced launch topology may finish materializing");
        let conn = database::db::get_connection().unwrap();
        let mapping_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_run_sessions
                 WHERE org_run_id=?1 AND session_id=?2 AND role='worker'",
                params![run.id, worker_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mapping_count, 1, "status={}", status.as_str());
    }
}

#[test]
fn worker_materialization_rejects_terminal_phases() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();

    for status in [
        AgentOrgRunStatus::Completed,
        AgentOrgRunStatus::Failed,
        AgentOrgRunStatus::Cancelled,
        AgentOrgRunStatus::Abandoned,
    ] {
        let root = format!("root-materialization-{}", status.as_str());
        let run = create_run(&root, status);
        let worker_id = format!("worker-materialization-{}", status.as_str());
        let worker = UnifiedSessionRecord {
            session_id: worker_id.clone(),
            name: "Blocked worker".to_string(),
            status: SessionStatus::Pending.as_str().to_string(),
            session_type: crate::session::persistence::session_type::ORG_MEMBER.to_string(),
            agent_definition_id: Some("agent-worker".to_string()),
            org_member_id: Some("member-worker".to_string()),
            parent_session_id: Some(root),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };

        let error = AgentOrgRunStore::materialize_rust_worker_sessions(&run.id, &[worker])
            .expect_err("non-materializing phase must reject Workers");
        assert!(error.starts_with("agent_org_run_not_materializable:"));

        let conn = database::db::get_connection().unwrap();
        let session_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_sessions WHERE session_id=?1",
                [&worker_id],
                |row| row.get(0),
            )
            .unwrap();
        let mapping_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_run_sessions
                 WHERE org_run_id=?1 AND role='worker'",
                [&run.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_count, 0, "status={}", status.as_str());
        assert_eq!(mapping_count, 0, "status={}", status.as_str());
    }
}

#[test]
fn shared_run_writable_predicate_and_resume_observe_fence() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let writable_root = "root-run-writable";
    let writable_run = create_run(writable_root, AgentOrgRunStatus::Running);
    let conn = database::db::get_connection().unwrap();
    assert!(is_run_writable_with_connection(&conn, &writable_run.id).unwrap());

    let paused_root = "root-resume-fenced";
    let paused_run = create_run(paused_root, AgentOrgRunStatus::Paused);
    establish_conversation_delete_fence(paused_root).unwrap();
    let resume_error = AgentOrgRunStore::mark_resumed(&paused_run.id)
        .expect_err("fenced paused Run must not resume");
    assert!(resume_error.starts_with(CONVERSATION_DELETING_ERROR_CODE));
    AgentOrgRunStore::mark_failed(&paused_run.id, "late materialization failure").unwrap();
    assert_eq!(
        load_status(&paused_run.id),
        AgentOrgRunStatus::Cancelled.as_str()
    );

    let failed_root = "root-paused-materialization-failed";
    let failed_run = create_run(failed_root, AgentOrgRunStatus::Paused);
    AgentOrgRunStore::mark_failed(&failed_run.id, "materialization failed").unwrap();
    assert_eq!(
        load_status(&failed_run.id),
        AgentOrgRunStatus::Failed.as_str()
    );

    let conn = database::db::get_connection().unwrap();
    assert!(!is_run_writable_with_connection(&conn, &paused_run.id).unwrap());
    assert!(remove_conversation_delete_fence_with_connection(&conn, paused_root).unwrap());
    assert!(!is_conversation_deleting_with_connection(&conn, paused_root).unwrap());
}

#[tokio::test]
async fn ordinary_session_admission_has_zero_agent_org_queries_and_leases() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    reset_submission_metrics();
    let record = UnifiedSessionRecord {
        session_id: "ordinary-sde-admission".to_string(),
        session_type: crate::session::persistence::session_type::CODING.to_string(),
        ..Default::default()
    };
    let resolved = submission_scope_for_loaded_session(&record).expect("classify ordinary SDE");
    assert_eq!(resolved, AgentOrgSubmissionScope::Ordinary);
    let scope = std::sync::Arc::new(AgentOrgSubmissionPolicy::new(resolved));

    assert!(admit_agent_org_submission(&scope, &record.session_id)
        .await
        .expect("ordinary admission")
        .is_none());
    assert_eq!(submission_metrics(), (0, 0));
}

#[tokio::test]
async fn ordinary_session_admission_ignores_agent_org_schema_failure() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute("DROP TABLE agent_org_conversation_delete_fences", [])
        .expect("inject Agent Org schema failure");
    drop(conn);
    reset_submission_metrics();
    let scope = std::sync::Arc::new(AgentOrgSubmissionPolicy::new(
        AgentOrgSubmissionScope::Ordinary,
    ));

    assert!(
        admit_agent_org_submission(&scope, "ordinary-schema-failure")
            .await
            .expect("ordinary SDE must not depend on Agent Org schema")
            .is_none()
    );
    assert_eq!(submission_metrics(), (0, 0));
}

#[tokio::test]
async fn cold_unknown_resolves_exact_mapping_once_then_stays_ordinary() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    reset_submission_metrics();
    let scope = std::sync::Arc::new(AgentOrgSubmissionPolicy::new(
        AgentOrgSubmissionScope::Unknown,
    ));

    for _ in 0..2 {
        assert!(admit_agent_org_submission(&scope, "cold-unknown-ordinary")
            .await
            .expect("resolve cold unknown")
            .is_none());
    }
    assert_eq!(scope.snapshot(), AgentOrgSubmissionScope::Ordinary);
    assert_eq!(submission_metrics(), (1, 0));
}

#[tokio::test]
async fn concurrent_cold_unknown_uses_one_exact_mapping_query() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    reset_submission_metrics();
    let scope = std::sync::Arc::new(AgentOrgSubmissionPolicy::new(
        AgentOrgSubmissionScope::Unknown,
    ));
    let admissions = (0..8).map(|_| {
        let scope = std::sync::Arc::clone(&scope);
        tokio::spawn(async move {
            admit_agent_org_submission(&scope, "cold-unknown-concurrent")
                .await
                .expect("ordinary admission")
        })
    });
    for admission in admissions {
        assert!(admission.await.expect("admission task").is_none());
    }
    assert_eq!(submission_metrics(), (1, 0));
}

#[tokio::test]
async fn agent_org_admission_lease_balances_and_fence_rejects() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-submission-admission";
    let run = create_run(root, AgentOrgRunStatus::Running);
    let scope = std::sync::Arc::new(AgentOrgSubmissionPolicy::new(
        AgentOrgSubmissionScope::Run {
            run_id: run.id.clone(),
        },
    ));
    reset_submission_metrics();

    let lease = admit_agent_org_submission(&scope, root)
        .await
        .expect("admit writable Agent Org")
        .expect("Agent Org acquires lease");
    assert!(agent_org_submission_in_progress(root));
    drop(lease);
    assert!(!agent_org_submission_in_progress(root));
    assert_eq!(submission_metrics(), (1, 2));

    establish_conversation_delete_fence(root).expect("fence root");
    let error = admit_agent_org_submission(&scope, root)
        .await
        .expect_err("fenced Agent Org rejects submission");
    assert!(error.starts_with(CONVERSATION_DELETING_ERROR_CODE));
    assert!(!agent_org_submission_in_progress(root));
    assert_eq!(submission_metrics(), (2, 4));
}

#[tokio::test]
async fn install_recheck_rejects_fence_created_after_initial_admission() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_schemas();
    let root = "root-late-install-fence";
    let run = create_run(root, AgentOrgRunStatus::Running);
    let scope = std::sync::Arc::new(AgentOrgSubmissionPolicy::new(
        AgentOrgSubmissionScope::Run {
            run_id: run.id.clone(),
        },
    ));

    let lease = admit_agent_org_submission(&scope, root)
        .await
        .expect("initial runtime-build admission")
        .expect("Agent Org runtime build holds lease");
    establish_conversation_delete_fence(root).expect("fence during slow runtime build");
    let error = recheck_agent_org_submission(&scope)
        .await
        .expect_err("the sole install boundary must reject the late fence");
    assert!(
        error.starts_with(CONVERSATION_DELETING_ERROR_CODE),
        "{error}"
    );
    assert!(agent_org_submission_in_progress(root));
    drop(lease);
    assert!(!agent_org_submission_in_progress(root));
}
