use rusqlite::params;

use super::agent_org_archive::{
    archive_run_commit, pending_receipt_ids, record_teardown_attempt, summary_for_run,
    teardown_targets, ArchiveTeardownStatus,
};
use super::agent_org_runs::COORDINATOR_MEMBER_ID;
use super::agent_org_tasks::{TaskOutputInput, TaskOwnerExecution};

fn setup() {
    let conn = database::db::get_connection().expect("sandbox DB");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::session::persistence::init(&conn).expect("session schema");
    crate::interaction::plan_approval::persistence::init_schema(&conn)
        .expect("plan approval schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
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
            PRIMARY KEY(session_id,turn_intent_id)
        );",
    )
    .expect("turn intent schema");
}

fn seed_session(session_id: &str, parent: Option<&str>, member_id: &str) {
    database::db::get_connection()
        .expect("sandbox DB")
        .execute(
            "INSERT INTO agent_sessions (
                session_id,name,status,created_at,updated_at,session_type,
                parent_session_id,org_member_id,workspace_additional_json,key_source
             ) VALUES (?1,?1,'running',?2,?2,'agent',?3,?4,'{}','own_key')",
            params![session_id, "2026-08-23T00:00:00Z", parent, member_id],
        )
        .expect("seed Session");
}

fn seed_run(run_id: &str, root_session_id: &str, status: &str, generation: i64) {
    let snapshot = serde_json::json!({
        "schemaVersion": 1,
        "orgId": "org-archive-test",
        "orgName": "Archive Test Team",
        "coordinatorRole": "Lead",
        "coordinatorAgentId": "coordinator-agent",
        "planApprovalPolicy": "coordinator",
        "members": [
            {
                "memberId": "worker",
                "name": "Worker",
                "role": "Builder",
                "agentId": "worker-agent"
            }
        ],
        "additionalTaskGraphWriterMemberIds": [],
        "memberCommunicationLinks": [],
    })
    .to_string();
    database::db::get_connection()
        .expect("sandbox DB")
        .execute(
            "INSERT INTO agent_org_runtime_runs (
                id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,entry_mode,
                status,activation_generation,created_at,updated_at
             ) VALUES (?1,'org-archive-test','coordinator-agent',?2,?3,
                       'standalone_session',?4,?5,?6,?6)",
            params![
                run_id,
                root_session_id,
                snapshot,
                status,
                generation,
                "2026-08-23T00:00:00Z"
            ],
        )
        .expect("seed Run");
}

fn scalar_string(sql: &str, key: &str) -> String {
    database::db::get_connection()
        .expect("sandbox DB")
        .query_row(sql, [key], |row| row.get(0))
        .expect("read scalar")
}

fn assert_archive_failure_rolled_back(run_id: &str, expected_error: &str) {
    let error = archive_run_commit(run_id, &uuid::Uuid::new_v4().to_string())
        .expect_err("injected Archive write failure must roll back");
    assert!(
        error.contains(expected_error),
        "unexpected Archive error: {error}"
    );
    assert_eq!(
        scalar_string(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            run_id
        ),
        "running"
    );
    let receipt_count: i64 = database::db::get_connection()
        .expect("sandbox DB")
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_archive_episodes WHERE org_run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("receipt count");
    assert_eq!(receipt_count, 0);
}

#[test]
fn archive_fence_cancels_open_work_and_is_request_idempotent() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    let run_id = "archive-full-run";
    let root = "archive-full-root";
    let member = "archive-full-member";
    seed_session(root, None, COORDINATOR_MEMBER_ID);
    seed_session(member, Some(root), "worker");
    seed_run(run_id, root, "running", 1);
    let conn = database::db::get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks (
            id,org_run_id,activation_generation,subject,description,owner,status,execution_mode,
            blocked_by_json,created_by_participant_id,source_turn_intent_id,
            created_at,updated_at
         ) VALUES ('task-open',?1,1,'Open work','','worker','in_progress','build',
                   '[]','coordinator','turn-create',?2,?2)",
        params![run_id, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Task");
    conn.execute(
        "INSERT INTO session_turn_intents (
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES (?1,'turn-running',?2,'agent_org','running',?3,?3)",
        params![member, run_id, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Turn");
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox (
            recipient_agent_id,recipient_member_id,sender_agent_id,sender_member_id,
            org_run_id,payload_kind,payload_json,created_at
         ) VALUES ('worker-agent','worker','coordinator-agent','coordinator',?1,
                   'plain','{\"summary\":\"work\",\"text\":\"work\"}',?2)",
        params![run_id, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Inbox");
    let inbox_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox_materializations (
            inbox_id,session_id,transcript_message_id,transcript_intent_id,materialized_at
         ) VALUES (?1,?2,'materialized-message','materialized-intent',?3)",
        params![inbox_id, member, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Inbox materialization");
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_revisions (
            plan_revision_id,org_run_id,source_task_id,source_member_id,
            source_session_id,source_turn_intent_id,root_session_id,
            revision_number,plan_title,plan_path,plan_content,content_digest,created_at
         ) VALUES (
            'revision-open',?1,'task-open','worker',?2,'turn-running',?3,1,
            'Plan','/tmp/plan.md','# Plan',?4,?5
         )",
        params![run_id, member, root, "a".repeat(64), "2026-08-23T00:00:00Z"],
    )
    .expect("seed Plan revision");
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_decisions (
            approval_id,plan_revision_id,request_id,policy,status,created_at
         ) VALUES ('approval-open','revision-open','approval-request','user','pending',?1)",
        params!["2026-08-23T00:00:00Z"],
    )
    .expect("seed Plan decision");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,task_id,
            owner_member_id,dispatch_member_id,member_dispatch_sequence,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,'turn-running',?2,'worker','task_execution','task-open',
                   'worker','worker',1,'task','task-open',1,?3)",
        params![member, run_id, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Turn context");
    conn.execute(
        "INSERT INTO agent_org_runtime_pause_episodes (
            episode_id,org_run_id,pause_request_id,pause_generation,status,
            teardown_owner_id,created_at,updated_at
         ) VALUES ('pause-open',?1,'pause-request',2,'active','pause-owner',?2,?2)",
        params![run_id, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Pause episode");
    conn.execute(
        "INSERT INTO agent_org_runtime_pause_handoffs (
            handoff_id,episode_id,org_run_id,session_id,original_turn_intent_id,
            turn_kind,participant_id,task_id,original_owner_member_id,
            original_activation_generation,original_intent_status,drain_status,
            continuation_turn_intent_id,continuation_status,created_at,updated_at
         ) VALUES (
            'handoff-open','pause-open',?1,?2,'turn-running','task_execution',
            'worker','task-open','worker',1,'running','released',
            'continuation-open','queued',?3,?3
         )",
        params![run_id, member, "2026-08-23T00:00:00Z"],
    )
    .expect("seed queued Pause continuation");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_interventions (
            intervention_receipt_id,org_run_id,member_id,agent_id,session_id,
            status,source_event_id,entered_at,last_user_activity_at,updated_at
         ) VALUES ('intervention-open',?1,'worker','worker-agent',?2,
                   'active','source-open',?3,?3,?3)",
        params![run_id, member, "2026-08-23T00:00:00Z"],
    )
    .expect("seed intervention");
    drop(conn);

    let request_id = uuid::Uuid::new_v4().to_string();
    let first = archive_run_commit(run_id, &request_id).expect("Archive commit");
    assert!(first.owns_teardown);
    assert!(first.outcome.transitioned);
    assert_eq!(first.outcome.archive_generation, 2);
    assert_eq!(first.outcome.cancellations.tasks, 1);
    assert_eq!(first.outcome.cancellations.turns, 1);
    assert_eq!(first.outcome.cancellations.inbox_deliveries, 1);
    assert_eq!(first.outcome.cancellations.plan_approvals, 1);
    assert_eq!(first.outcome.cancellations.interventions, 1);
    assert_eq!(first.outcome.cancellations.pause_continuations, 1);
    let wire = serde_json::to_value(&first.outcome).expect("serialize Archive outcome");
    let wire_object = wire.as_object().expect("Archive outcome object");
    assert_eq!(
        wire_object.len(),
        8,
        "wire stays bounded to contract fields"
    );
    assert_eq!(wire["requestId"], request_id);
    assert_eq!(wire["runId"], run_id);
    assert_eq!(wire["archiveGeneration"], 2);
    assert_eq!(wire["teardown"]["status"], "pending");
    assert_eq!(
        wire["teardown"]
            .as_object()
            .expect("Archive teardown object")
            .len(),
        5,
        "teardown wire must not expose logs or user content"
    );
    assert!(wire.get("request_id").is_none());
    assert!(wire["teardown"].get("lastError").is_none());
    assert_eq!(
        scalar_string(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            run_id
        ),
        "archived"
    );
    assert_eq!(
        scalar_string(
            "SELECT status FROM agent_org_runtime_tasks WHERE org_run_id=?1",
            run_id
        ),
        "cancelled"
    );
    assert_eq!(
        scalar_string(
            "SELECT status FROM session_turn_intents WHERE org_run_id=?1",
            run_id
        ),
        "cancelled"
    );
    assert_eq!(
        scalar_string(
            "SELECT decision.status
             FROM agent_org_runtime_plan_decisions decision
             JOIN agent_org_runtime_plan_revisions revision
               ON revision.plan_revision_id=decision.plan_revision_id
             WHERE revision.org_run_id=?1",
            run_id
        ),
        "cancelled"
    );
    assert_eq!(
        scalar_string(
            "SELECT continuation_status FROM agent_org_runtime_pause_handoffs WHERE org_run_id=?1",
            run_id
        ),
        "skipped"
    );
    let materialization_count: i64 = database::db::get_connection()
        .expect("sandbox DB")
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_inbox_materializations WHERE inbox_id=?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("materialization count");
    assert_eq!(materialization_count, 0);
    let claim_error =
        crate::coordination::agent_inbox::AgentInboxStore::list_unread_batch_for_member(
            "worker", run_id,
        )
        .expect_err("Archived Inbox claim must fail");
    assert!(claim_error.starts_with("team_archived:"));
    let ack_error = crate::coordination::agent_inbox::AgentInboxStore::mark_many_read(&[inbox_id])
        .expect_err("Archived Inbox acknowledgement must fail");
    assert!(ack_error.starts_with("team_archived:"));
    let materialize_error = crate::session::persistence::materialize_agent_org_inbox_transcript(
        member,
        &[inbox_id],
        "late-materialized-message",
        "late-materialized-intent",
        "late",
    )
    .expect_err("Archived Inbox materialization must fail");
    assert!(materialize_error.starts_with("team_archived:"));
    let teardown_count: i64 = database::db::get_connection()
        .expect("sandbox DB")
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_archive_teardowns WHERE org_run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("teardown count");
    assert_eq!(teardown_count, 2);

    let late_task_result =
        crate::coordination::agent_org_tasks::AgentOrgTaskStore::owner_complete_with_transactional_effects(
            TaskOwnerExecution::new(member, "turn-running").expect("late Task owner actor"),
            run_id,
            "task-open",
            TaskOutputInput {
                summary: "late after Archive".to_string(),
                content: None,
                artifact_ids: Vec::new(),
            },
            |_tx, _outcome, _tasks| Ok(()),
        )
        .expect_err("Archived Team rejects late Task final");
    assert!(late_task_result.starts_with("team_archived:"));
    let resume_error =
        crate::coordination::agent_org_pause::resume_run(run_id, &uuid::Uuid::new_v4().to_string())
            .expect_err("Archived Team rejects Resume");
    assert!(resume_error.starts_with("team_archived:"));

    let replay = archive_run_commit(run_id, &request_id).expect("Archive replay");
    assert!(!replay.owns_teardown);
    assert!(!replay.outcome.transitioned);
    assert_eq!(replay.outcome.receipt_id, first.outcome.receipt_id);
    assert_eq!(replay.outcome.archive_generation, 2);
    let error = archive_run_commit(run_id, &uuid::Uuid::new_v4().to_string())
        .expect_err("different request cannot re-Archive");
    assert!(error.starts_with("team_archived:"));
}

#[test]
fn concurrent_different_archive_requests_transition_exactly_once() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    let run_id = "archive-concurrent-run";
    seed_session("archive-concurrent-root", None, COORDINATOR_MEMBER_ID);
    seed_run(run_id, "archive-concurrent-root", "running", 1);
    let request_ids = [
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    ];
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(request_ids.len()));
    let handles = request_ids.map(|request_id| {
        let barrier = std::sync::Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            archive_run_commit(run_id, &request_id)
        })
    });
    let results = handles.map(|handle| handle.join().expect("Archive writer thread"));
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result
                .as_ref()
                .is_err_and(|error| error.starts_with("team_archived:")))
            .count(),
        1
    );
    assert_eq!(
        scalar_string(
            "SELECT CAST(activation_generation AS TEXT)
             FROM agent_org_runtime_runs WHERE id=?1",
            run_id
        ),
        "2"
    );
}

#[test]
fn archive_accepts_only_documented_source_states() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    for (index, status) in ["running", "paused", "idle", "failed"]
        .into_iter()
        .enumerate()
    {
        let run_id = format!("archive-state-run-{index}");
        let root = format!("archive-state-root-{index}");
        seed_session(&root, None, COORDINATOR_MEMBER_ID);
        seed_run(&run_id, &root, status, 1);
        assert!(
            archive_run_commit(&run_id, &uuid::Uuid::new_v4().to_string())
                .expect("allowed Archive state")
                .outcome
                .transitioned
        );
    }

    seed_session("archive-starting-root", None, COORDINATOR_MEMBER_ID);
    seed_run(
        "archive-starting-run",
        "archive-starting-root",
        "starting",
        1,
    );
    let error = archive_run_commit("archive-starting-run", &uuid::Uuid::new_v4().to_string())
        .expect_err("Starting is not ready for Archive");
    assert!(error.starts_with("team_not_ready:"));
    assert_eq!(
        scalar_string(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            "archive-starting-run"
        ),
        "starting"
    );
}

#[test]
fn archive_rolls_back_the_fence_when_a_cancellation_write_fails() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    let run_id = "archive-rollback-run";
    let root = "archive-rollback-root";
    seed_session(root, None, COORDINATOR_MEMBER_ID);
    seed_run(run_id, root, "running", 1);
    let conn = database::db::get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_org_runtime_tasks (
            id,org_run_id,activation_generation,subject,description,status,execution_mode,blocked_by_json,
            created_by_participant_id,source_turn_intent_id,created_at,updated_at
         ) VALUES ('task-rollback',?1,1,'Open work','','pending','build','[]',
                   'coordinator','turn-create',?2,?2)",
        params![run_id, "2026-08-23T00:00:00Z"],
    )
    .expect("seed Task");
    conn.execute_batch(
        "CREATE TRIGGER abort_archive_task_cancel
         BEFORE UPDATE OF status ON agent_org_runtime_tasks
         WHEN NEW.status='cancelled'
         BEGIN SELECT RAISE(ABORT,'injected Archive cancellation failure'); END;",
    )
    .expect("install failure injection");
    drop(conn);

    assert_archive_failure_rolled_back(run_id, "injected Archive cancellation failure");
    assert_eq!(
        scalar_string(
            "SELECT status FROM agent_org_runtime_tasks WHERE org_run_id=?1",
            run_id
        ),
        "pending"
    );
}

#[test]
fn archive_rolls_back_at_every_non_task_transaction_boundary() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();

    for boundary in [
        "fence",
        "episode",
        "teardown",
        "turn",
        "inbox",
        "approval",
        "intervention",
        "pause_continuation",
        "receipt_finalize",
    ] {
        let run_id = format!("archive-fault-{boundary}-run");
        let root = format!("archive-fault-{boundary}-root");
        seed_session(&root, None, COORDINATOR_MEMBER_ID);
        seed_run(&run_id, &root, "running", 1);
        let conn = database::db::get_connection().expect("sandbox DB");

        match boundary {
            "turn" => {
                conn.execute(
                    "INSERT INTO session_turn_intents (
                        session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
                     ) VALUES (?1,?2,?3,'agent_org','running',?4,?4)",
                    params![
                        &root,
                        format!("{run_id}-turn"),
                        &run_id,
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed Turn intent");
            }
            "inbox" => {
                conn.execute(
                    "INSERT INTO agent_org_runtime_inbox (
                        recipient_agent_id,recipient_member_id,sender_agent_id,
                        sender_member_id,org_run_id,payload_kind,payload_json,created_at
                     ) VALUES ('coordinator-agent','coordinator','worker-agent','worker',
                               ?1,'plain','{\"summary\":\"work\",\"text\":\"work\"}',?2)",
                    params![&run_id, "2026-08-23T00:00:00Z"],
                )
                .expect("seed Inbox delivery");
            }
            "approval" => {
                let task_id = format!("{run_id}-task");
                conn.execute(
                    "INSERT INTO agent_org_runtime_tasks (
                        id,org_run_id,activation_generation,subject,description,status,execution_mode,
                        blocked_by_json,created_by_participant_id,
                        source_turn_intent_id,created_at,updated_at
                     ) VALUES (?1,?2,1,'Approval work','','pending','plan','[]',
                               'coordinator',?3,?4,?4)",
                    params![
                        &task_id,
                        &run_id,
                        format!("{run_id}-turn"),
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed approval source Task");
                conn.execute(
                    "INSERT INTO agent_org_runtime_plan_revisions (
                        plan_revision_id,org_run_id,source_task_id,source_member_id,
                        source_session_id,source_turn_intent_id,root_session_id,
                        revision_number,plan_title,plan_path,plan_content,
                        content_digest,created_at
                     ) VALUES (?1,?2,?3,'coordinator',?4,?5,?4,1,'Plan',
                               '/tmp/archive-fault-plan.md','# Plan',?6,?7)",
                    params![
                        format!("{run_id}-revision"),
                        &run_id,
                        &task_id,
                        &root,
                        format!("{run_id}-turn"),
                        "b".repeat(64),
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed Plan revision");
                conn.execute(
                    "INSERT INTO agent_org_runtime_plan_decisions (
                        approval_id,plan_revision_id,request_id,policy,status,created_at
                     ) VALUES (?1,?2,?3,'user','pending',?4)",
                    params![
                        format!("{run_id}-approval"),
                        format!("{run_id}-revision"),
                        format!("{run_id}-request"),
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed Plan decision");
            }
            "intervention" => {
                conn.execute(
                    "INSERT INTO agent_org_runtime_member_interventions (
                        intervention_receipt_id,org_run_id,member_id,agent_id,
                        session_id,status,source_event_id,entered_at,
                        last_user_activity_at,updated_at
                     ) VALUES (?1,?2,'coordinator','coordinator-agent',?3,
                               'active',?4,?5,?5,?5)",
                    params![
                        format!("{run_id}-intervention"),
                        &run_id,
                        &root,
                        format!("{run_id}-source"),
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed intervention");
            }
            "pause_continuation" => {
                let episode_id = format!("{run_id}-pause");
                let turn_intent_id = format!("{run_id}-turn");
                conn.execute(
                    "INSERT INTO session_turn_intents (
                        session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
                     ) VALUES (?1,?2,?3,'agent_org','running',?4,?4)",
                    params![&root, &turn_intent_id, &run_id, "2026-08-23T00:00:00Z"],
                )
                .expect("seed Pause Turn intent");
                conn.execute(
                    "INSERT INTO agent_org_runtime_turn_contexts (
                        session_id,turn_intent_id,org_run_id,participant_id,
                        turn_kind,source_kind,source_id,activation_generation,created_at
                     ) VALUES (?1,?2,?3,'coordinator','coordinator','root_turn',?2,1,?4)",
                    params![&root, &turn_intent_id, &run_id, "2026-08-23T00:00:00Z"],
                )
                .expect("seed Pause Turn context");
                conn.execute(
                    "INSERT INTO agent_org_runtime_pause_episodes (
                        episode_id,org_run_id,pause_request_id,pause_generation,status,
                        teardown_owner_id,created_at,updated_at
                     ) VALUES (?1,?2,?3,2,'active',?4,?5,?5)",
                    params![
                        &episode_id,
                        &run_id,
                        format!("{run_id}-pause-request"),
                        format!("{run_id}-pause-owner"),
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed Pause episode");
                conn.execute(
                    "INSERT INTO agent_org_runtime_pause_handoffs (
                        handoff_id,episode_id,org_run_id,session_id,
                        original_turn_intent_id,turn_kind,participant_id,
                        original_activation_generation,original_intent_status,
                        drain_status,continuation_turn_intent_id,continuation_status,
                        created_at,updated_at
                     ) VALUES (?1,?2,?3,?4,?5,'coordinator','coordinator',1,
                               'running','released',?6,'queued',?7,?7)",
                    params![
                        format!("{run_id}-handoff"),
                        &episode_id,
                        &run_id,
                        &root,
                        &turn_intent_id,
                        format!("{run_id}-continuation"),
                        "2026-08-23T00:00:00Z"
                    ],
                )
                .expect("seed Pause continuation");
            }
            _ => {}
        }

        let trigger = match boundary {
            "fence" => format!(
                "CREATE TRIGGER fault_archive_fence_{boundary}
                 BEFORE UPDATE OF status ON agent_org_runtime_runs
                 WHEN NEW.id='{run_id}' AND NEW.status='archived'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_fence'); END;"
            ),
            "episode" => format!(
                "CREATE TRIGGER fault_archive_episode_{boundary}
                 BEFORE INSERT ON agent_org_runtime_archive_episodes
                 WHEN NEW.org_run_id='{run_id}'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_episode'); END;"
            ),
            "teardown" => format!(
                "CREATE TRIGGER fault_archive_teardown_{boundary}
                 BEFORE INSERT ON agent_org_runtime_archive_teardowns
                 WHEN NEW.org_run_id='{run_id}'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_teardown'); END;"
            ),
            "turn" => format!(
                "CREATE TRIGGER fault_archive_turn_{boundary}
                 BEFORE UPDATE OF status ON session_turn_intents
                 WHEN NEW.org_run_id='{run_id}' AND NEW.status='cancelled'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_turn'); END;"
            ),
            "inbox" => format!(
                "CREATE TRIGGER fault_archive_inbox_{boundary}
                 BEFORE INSERT ON agent_org_runtime_inbox_delivery_resolutions
                 WHEN NEW.org_run_id='{run_id}'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_inbox'); END;"
            ),
            "approval" => format!(
                "CREATE TRIGGER fault_archive_approval_{boundary}
                 BEFORE UPDATE OF status ON agent_org_runtime_plan_decisions
                 WHEN NEW.plan_revision_id IN (
                     SELECT plan_revision_id FROM agent_org_runtime_plan_revisions
                     WHERE org_run_id='{run_id}'
                 ) AND NEW.status='cancelled'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_approval'); END;"
            ),
            "intervention" => format!(
                "CREATE TRIGGER fault_archive_intervention_{boundary}
                 BEFORE UPDATE OF cleared_at ON agent_org_runtime_member_interventions
                 WHEN NEW.org_run_id='{run_id}' AND NEW.cleared_at IS NOT NULL
                 BEGIN SELECT RAISE(ABORT,'fault_archive_intervention'); END;"
            ),
            "pause_continuation" => format!(
                "CREATE TRIGGER fault_archive_pause_{boundary}
                 BEFORE UPDATE OF continuation_status ON agent_org_runtime_pause_handoffs
                 WHEN NEW.org_run_id='{run_id}' AND NEW.continuation_status='skipped'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_pause'); END;"
            ),
            "receipt_finalize" => format!(
                "CREATE TRIGGER fault_archive_receipt_{boundary}
                 BEFORE UPDATE OF task_cancel_count ON agent_org_runtime_archive_episodes
                 WHEN NEW.org_run_id='{run_id}'
                 BEGIN SELECT RAISE(ABORT,'fault_archive_receipt'); END;"
            ),
            _ => unreachable!(),
        };
        conn.execute_batch(&trigger).expect("install fault trigger");
        drop(conn);
        let expected_error = match boundary {
            "pause_continuation" => "fault_archive_pause".to_string(),
            "receipt_finalize" => "fault_archive_receipt".to_string(),
            _ => format!("fault_archive_{boundary}"),
        };
        assert_archive_failure_rolled_back(&run_id, &expected_error);
    }
}

#[test]
fn archive_rejects_generation_overflow_without_mutation() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    seed_session("archive-overflow-root", None, COORDINATOR_MEMBER_ID);
    seed_run(
        "archive-overflow-run",
        "archive-overflow-root",
        "running",
        i64::MAX,
    );
    let error = archive_run_commit("archive-overflow-run", &uuid::Uuid::new_v4().to_string())
        .expect_err("generation overflow must fail closed");
    assert!(error.contains("generation overflow"));
    assert_eq!(
        scalar_string(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            "archive-overflow-run"
        ),
        "running"
    );
}

#[test]
fn archive_teardown_is_exactly_bounded_and_retains_failure_evidence() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    let run_id = "archive-retained-run";
    seed_session("archive-retained-root", None, COORDINATOR_MEMBER_ID);
    seed_run(run_id, "archive-retained-root", "running", 1);
    let commit =
        archive_run_commit(run_id, &uuid::Uuid::new_v4().to_string()).expect("Archive commit");

    for expected_attempt in 1..=3 {
        let targets = teardown_targets(&commit.outcome.receipt_id).expect("pending targets");
        assert_eq!(targets.len(), 1);
        let summary = record_teardown_attempt(
            &targets[0],
            Some("retained-lease"),
            Some("retained-turn"),
            false,
            Some("archive_runtime_stop_timeout"),
        )
        .expect("record failed attempt");
        assert_eq!(summary.attempt_count, expected_attempt);
    }

    let summary = summary_for_run(run_id)
        .expect("summary read")
        .expect("Archive summary");
    assert_eq!(summary.status, ArchiveTeardownStatus::RetainedRuntime);
    assert_eq!(summary.attempt_count, 3);
    assert_eq!(summary.retained_runtime_count, 1);
    assert!(teardown_targets(&commit.outcome.receipt_id)
        .expect("terminal targets")
        .is_empty());
    assert!(!pending_receipt_ids(10)
        .expect("pending receipts")
        .contains(&commit.outcome.receipt_id));
}

#[test]
fn archive_teardown_quiesces_only_after_every_captured_session_releases() {
    let _sandbox = test_helpers::test_env::sandbox();
    setup();
    let run_id = "archive-quiesced-run";
    let root = "archive-quiesced-root";
    seed_session(root, None, COORDINATOR_MEMBER_ID);
    seed_session("archive-quiesced-worker", Some(root), "worker");
    seed_run(run_id, root, "idle", 5);
    let commit =
        archive_run_commit(run_id, &uuid::Uuid::new_v4().to_string()).expect("Archive commit");
    let targets = teardown_targets(&commit.outcome.receipt_id).expect("captured targets");
    assert_eq!(targets.len(), 2);

    let first =
        record_teardown_attempt(&targets[0], None, None, true, None).expect("first release");
    assert_eq!(first.status, ArchiveTeardownStatus::Pending);
    let second =
        record_teardown_attempt(&targets[1], None, None, true, None).expect("second release");
    assert_eq!(second.status, ArchiveTeardownStatus::Quiesced);
    assert_eq!(second.attempt_count, 1);
    assert_eq!(second.retained_runtime_count, 0);
}
