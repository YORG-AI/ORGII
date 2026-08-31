use super::super::{
    init_schema, AgentInboxDeliveryResolutionKind, AgentInboxRecord, AgentInboxStore,
    InsertInboxParams, ResolveInboxDeliveryParams, SYSTEM_SENDER_ID,
};
use super::*;
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use database::db::get_connection;
use rusqlite::params;

fn sandbox_with_inbox_schema() -> test_helpers::test_env::SandboxGuard {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("open sandbox database");
    init_schema(&conn).expect("initialize agent inbox schema");
    sandbox
}

fn seed_minimal_running_run_for_delivery_resolution(run_id: &str) {
    let conn = get_connection().expect("open sandbox database");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runs (
                 id TEXT PRIMARY KEY,
                 status TEXT NOT NULL,
                 org_snapshot_json TEXT,
                 root_session_id TEXT
             );
             CREATE TABLE IF NOT EXISTS agent_sessions (
                 session_id TEXT PRIMARY KEY,
                 status TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 parent_session_id TEXT,
                 agent_definition_id TEXT,
                 org_member_id TEXT
             );
             CREATE TABLE IF NOT EXISTS code_sessions (
                 session_id TEXT PRIMARY KEY,
                 cli_agent_type TEXT NOT NULL,
                 status TEXT NOT NULL,
                 parent_session_id TEXT,
                 org_member_id TEXT,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_org_tasks (
                 id TEXT PRIMARY KEY,
                 org_run_id TEXT NOT NULL
             );",
    )
    .expect("initialize minimal delivery-repair dependencies");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("initialize intervention lookup for delivery repair");
    let root_session_id = format!("root-{run_id}");
    conn.execute(
        "INSERT INTO agent_sessions (session_id, status, updated_at)
             VALUES (?1, 'idle', ?2)",
        params![&root_session_id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("seed coordinator session");
    conn.execute(
        "INSERT INTO agent_org_runs (id, status, org_snapshot_json, root_session_id)
             VALUES (?1, 'running', NULL, ?2)",
        params![run_id, &root_session_id],
    )
    .expect("seed running run");
}

fn seed_legacy_orphan_inbox_row(run_id: &str, summary: &str, text: &str) -> AgentInboxRecord {
    let message = AgentMessage::Plain {
        summary: summary.to_string(),
        text: text.to_string(),
    };
    let payload_json = serde_json::to_string(&message).expect("serialize legacy payload");
    let conn = get_connection().expect("open sandbox database");
    conn.execute(
        "INSERT INTO agent_inbox (
                 recipient_agent_id, recipient_member_id,
                 sender_agent_id, sender_member_id, org_run_id,
                 payload_kind, payload_json, request_id,
                 created_at, read_at, causation_inbox_id
             ) VALUES (?1, NULL, ?2, ?3, ?4, 'plain', ?5, NULL, ?6, NULL, NULL)",
        params![
            "missing-agent",
            "coordinator-agent",
            "coordinator",
            run_id,
            payload_json,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("seed historical orphan Inbox row");
    let inbox_id = conn.last_insert_rowid();
    AgentInboxStore::get_by_id_for_run(run_id, inbox_id)
        .expect("load historical orphan row")
        .expect("historical orphan row exists")
}

fn messages_for_each_task_identifier_position(task_id: &str) -> Vec<(&'static str, AgentMessage)> {
    vec![
        (
            "PlanApprovalRequest.source_task_id",
            AgentMessage::PlanApprovalRequest {
                request_id: RequestId("request-task-id-boundary".into()),
                approval_id: "approval-task-id-boundary".into(),
                plan_revision_id: "revision-task-id-boundary".into(),
                source_task_id: task_id.into(),
                plan_title: "Task identifier boundary".into(),
                plan_path: "/tmp/task-id-boundary.plan.md".into(),
                plan_content: "# Plan".into(),
            },
        ),
        (
            "MemberIdle.unfinished_task_ids[]",
            AgentMessage::MemberIdle {
                member_id: "worker".into(),
                member_name: "Worker".into(),
                reason: MemberIdleReason::Available,
                current_mode: Some(AgentExecMode::Build),
                summary: None,
                failure_reason: None,
                unfinished_task_ids: vec![task_id.into()],
            },
        ),
        (
            "TaskAssigned.task_id",
            AgentMessage::TaskAssigned {
                task_id: task_id.into(),
                subject: "Assigned task".into(),
                description: "Validate the task identifier boundary".into(),
                assigned_by: "Coordinator".into(),
                execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
                dependency_outputs: Vec::new(),
            },
        ),
        (
            "TaskAssigned.dependency_outputs[].task_id",
            AgentMessage::TaskAssigned {
                task_id: "dependent-task".into(),
                subject: "Dependent task".into(),
                description: "Consume a completed dependency".into(),
                assigned_by: "Coordinator".into(),
                execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
                dependency_outputs: vec![TaskDependencyOutput {
                    task_id: task_id.into(),
                    subject: "Dependency".into(),
                    summary: "Dependency completed".into(),
                    content: None,
                    artifact_ids: Vec::new(),
                    produced_by_member_id: "producer".into(),
                }],
            },
        ),
        (
            "TaskAssigned.dependency_outputs[].produced_by_member_id",
            AgentMessage::TaskAssigned {
                task_id: "dependent-producer-task".into(),
                subject: "Dependent task".into(),
                description: "Consume a completed dependency".into(),
                assigned_by: "Coordinator".into(),
                execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
                dependency_outputs: vec![TaskDependencyOutput {
                    task_id: "dependency-task".into(),
                    subject: "Dependency".into(),
                    summary: "Dependency completed".into(),
                    content: None,
                    artifact_ids: Vec::new(),
                    produced_by_member_id: task_id.into(),
                }],
            },
        ),
        (
            "MemberTerminated.member_id",
            AgentMessage::MemberTerminated {
                member_id: task_id.into(),
                member_name: "Worker".into(),
                reason: MemberTerminationReason::Shutdown,
            },
        ),
        (
            "MemberIdle.member_id",
            AgentMessage::MemberIdle {
                member_id: task_id.into(),
                member_name: "Worker".into(),
                reason: MemberIdleReason::Available,
                current_mode: Some(AgentExecMode::Build),
                summary: None,
                failure_reason: None,
                unfinished_task_ids: Vec::new(),
            },
        ),
        (
            "TaskCompleted.task_id",
            AgentMessage::TaskCompleted {
                task_id: task_id.into(),
                subject: "Completed task".into(),
                completed_by_member_id: "worker".into(),
                output_summary: Some("Done".into()),
                remaining_open_task_count: 0,
            },
        ),
        (
            "TaskCompleted.completed_by_member_id",
            AgentMessage::TaskCompleted {
                task_id: "completed-member-boundary".into(),
                subject: "Completed task".into(),
                completed_by_member_id: task_id.into(),
                output_summary: Some("Done".into()),
                remaining_open_task_count: 0,
            },
        ),
    ]
}

fn insert_boundary_message(
    run_id: &str,
    message: AgentMessage,
) -> Result<AgentInboxRecord, String> {
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "recipient-agent".into(),
        recipient_member_id: Some("recipient-member".into()),
        sender_agent_id: SYSTEM_SENDER_ID.into(),
        sender_member_id: None,
        org_run_id: Some(run_id.into()),
        message,
    })
}

#[test]
fn plain_validation() {
    let msg = AgentMessage::Plain {
        summary: "ping".into(),
        text: "hello".into(),
    };
    assert!(msg.validate().is_ok());
    assert_eq!(msg.kind_tag(), "plain");
    assert!(msg.request_id().is_none());

    let bad = AgentMessage::Plain {
        summary: "".into(),
        text: "hello".into(),
    };
    assert!(bad.validate().is_err());
}

#[test]
fn rpc_request_id_round_trip() {
    let req_id = RequestId::new();
    let msg = AgentMessage::ShutdownRequest {
        request_id: req_id.clone(),
        reason: Some("done".into()),
    };
    assert_eq!(msg.request_id(), Some(&req_id));
    assert_eq!(msg.kind_tag(), "shutdown_request");
    assert!(msg.validate().is_ok());
}

#[test]
fn plan_approval_request_validates_required_fields() {
    let ok = AgentMessage::PlanApprovalRequest {
        request_id: RequestId("req-1".into()),
        approval_id: "approval-1".into(),
        plan_revision_id: "revision-1".into(),
        source_task_id: "task-plan".into(),
        plan_title: "Refactor auth".into(),
        plan_path: "/tmp/auth.plan.md".into(),
        plan_content: "# steps".into(),
    };
    assert!(ok.validate().is_ok());
    assert_eq!(ok.kind_tag(), "plan_approval_request");
    assert!(ok.is_structured());

    let bad_title = AgentMessage::PlanApprovalRequest {
        request_id: RequestId("req-2".into()),
        approval_id: "approval-2".into(),
        plan_revision_id: "revision-2".into(),
        source_task_id: "task-plan".into(),
        plan_title: "  ".into(),
        plan_path: "/tmp/x".into(),
        plan_content: "body".into(),
    };
    assert!(bad_title.validate().is_err());

    let bad_path = AgentMessage::PlanApprovalRequest {
        request_id: RequestId("req-3".into()),
        approval_id: "approval-3".into(),
        plan_revision_id: "revision-3".into(),
        source_task_id: "task-plan".into(),
        plan_title: "t".into(),
        plan_path: "".into(),
        plan_content: "body".into(),
    };
    assert!(bad_path.validate().is_err());

    let bad_content = AgentMessage::PlanApprovalRequest {
        request_id: RequestId("req-4".into()),
        approval_id: "approval-4".into(),
        plan_revision_id: "revision-4".into(),
        source_task_id: "task-plan".into(),
        plan_title: "t".into(),
        plan_path: "/tmp/x".into(),
        plan_content: "   ".into(),
    };
    assert!(bad_content.validate().is_err());
}

#[test]
fn plan_approval_response_round_trip() {
    let approved = AgentMessage::PlanApprovalResponse {
        request_id: RequestId("req-rt".into()),
        accepted: true,
        feedback: None,
        next_mode: Some(AgentExecMode::Build),
    };
    let json = serde_json::to_string(&approved).unwrap();
    let parsed: AgentMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(approved, parsed);
    assert!(json.contains("\"kind\":\"plan_approval_response\""));

    let rejected = AgentMessage::PlanApprovalResponse {
        request_id: RequestId("req-rj".into()),
        accepted: false,
        feedback: Some("scope is wrong".into()),
        next_mode: Some(AgentExecMode::Plan),
    };
    assert!(rejected.validate().is_ok());
}

#[test]
fn is_structured_distinguishes_plain_from_rpc() {
    assert!(!AgentMessage::Plain {
        summary: "s".into(),
        text: "t".into()
    }
    .is_structured());
    assert!(AgentMessage::ShutdownRequest {
        request_id: RequestId::new(),
        reason: None
    }
    .is_structured());
    assert!(AgentMessage::ShutdownResponse {
        request_id: RequestId::new(),
        accepted: true,
        note: None
    }
    .is_structured());
}

#[test]
fn serde_round_trip_via_tag() {
    let msg = AgentMessage::Plain {
        summary: "s".into(),
        text: "t".into(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: AgentMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(msg, parsed);
    assert!(json.contains("\"kind\":\"plain\""));
}

#[test]
fn member_idle_unfinished_tasks_are_backward_compatible_and_omit_empty_wire_data() {
    let message = AgentMessage::MemberIdle {
        member_id: "member-worker".into(),
        member_name: "Worker".into(),
        reason: MemberIdleReason::Available,
        current_mode: Some(AgentExecMode::Build),
        summary: None,
        failure_reason: None,
        unfinished_task_ids: Vec::new(),
    };
    let serialized = serde_json::to_string(&message).expect("serialize MemberIdle");
    assert!(!serialized.contains("unfinished_task_ids"));

    let legacy = r#"{"kind":"member_idle","member_id":"member-worker","member_name":"Worker","reason":"available","current_mode":"build","summary":null,"failure_reason":null}"#;
    let decoded: AgentMessage = serde_json::from_str(legacy).expect("decode legacy MemberIdle");
    assert_eq!(decoded, message);
}

/// Regression guard: every variant's `kind_tag()` MUST equal the
/// serde `tag = "kind"` string. The `payload_kind` SQLite column
/// is populated from `kind_tag()` and queried via the JSON tag, so a
/// drift here silently corrupts the inbox.
#[test]
fn kind_tag_matches_serde_tag() {
    let cases: Vec<AgentMessage> = vec![
        AgentMessage::Plain {
            summary: "s".into(),
            text: "t".into(),
        },
        AgentMessage::ShutdownRequest {
            request_id: RequestId::new(),
            reason: None,
        },
        AgentMessage::ShutdownResponse {
            request_id: RequestId::new(),
            accepted: true,
            note: None,
        },
        AgentMessage::PlanApprovalRequest {
            request_id: RequestId::new(),
            approval_id: "approval-1".into(),
            plan_revision_id: "revision-1".into(),
            source_task_id: "task-plan".into(),
            plan_title: "title".into(),
            plan_path: "/tmp/x.plan.md".into(),
            plan_content: "body".into(),
        },
        AgentMessage::PlanApprovalResponse {
            request_id: RequestId::new(),
            accepted: true,
            feedback: None,
            next_mode: Some(AgentExecMode::Build),
        },
        AgentMessage::MemberTerminated {
            member_id: "alice".into(),
            member_name: "alice".into(),
            reason: MemberTerminationReason::Shutdown,
        },
        AgentMessage::MemberIdle {
            member_id: "alice".into(),
            member_name: "alice".into(),
            reason: MemberIdleReason::Available,
            current_mode: Some(AgentExecMode::Plan),
            summary: Some("DM'd coord with progress".into()),
            failure_reason: None,
            unfinished_task_ids: Vec::new(),
        },
        AgentMessage::TaskAssigned {
            task_id: "task-1".into(),
            subject: "subject".into(),
            description: "d".into(),
            assigned_by: "Coord".into(),
            dependency_outputs: Vec::new(),
            execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
        },
        AgentMessage::TaskCompleted {
            task_id: "task-1".into(),
            subject: "subject".into(),
            completed_by_member_id: "alice".into(),
            output_summary: Some("done".into()),
            remaining_open_task_count: 0,
        },
        AgentMessage::ExecModeSetRequest {
            request_id: RequestId::new(),
            mode: AgentExecMode::Plan,
            reason: Some("draft a plan first".into()),
        },
    ];
    for msg in cases {
        let json = serde_json::to_value(&msg).unwrap();
        let serde_tag = json
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("missing kind on {}", msg.kind_tag()));
        assert_eq!(
            serde_tag,
            msg.kind_tag(),
            "kind_tag() drift for {:?}",
            msg.kind_tag()
        );
    }
}

/// `MemberTerminated` is the system-emitted notification the
/// coordinator-side drain produces after cancelling a member that
/// acknowledged shutdown. Pin: kind tag, structured-ness (broadcast
/// guard depends on it), validate() rejects empty agent_id/name, and
/// the wire format includes `reason` as a snake_case string.
#[test]
fn member_terminated_validate_serde_and_kind_tag() {
    let ok = AgentMessage::MemberTerminated {
        member_id: "alice".into(),
        member_name: "alice".into(),
        reason: MemberTerminationReason::Shutdown,
    };
    assert!(ok.validate().is_ok());
    assert_eq!(ok.kind_tag(), "member_terminated");
    assert!(
        ok.is_structured(),
        "MemberTerminated must be structured so the broadcast guard rejects fan-out"
    );
    assert!(
        ok.request_id().is_none(),
        "MemberTerminated has no RPC correlation"
    );

    let json = serde_json::to_value(&ok).unwrap();
    assert_eq!(json["kind"], "member_terminated");
    assert_eq!(json["member_id"], "alice");
    assert_eq!(json["member_name"], "alice");
    assert_eq!(json["reason"], "shutdown");

    let parsed: AgentMessage = serde_json::from_value(json).unwrap();
    assert_eq!(parsed, ok);

    let bad_id = AgentMessage::MemberTerminated {
        member_id: "  ".into(),
        member_name: "alice".into(),
        reason: MemberTerminationReason::Shutdown,
    };
    assert!(bad_id.validate().is_err());

    let bad_name = AgentMessage::MemberTerminated {
        member_id: "alice".into(),
        member_name: "".into(),
        reason: MemberTerminationReason::Shutdown,
    };
    assert!(bad_name.validate().is_err());
}

#[test]
fn task_assigned_validation_and_metadata() {
    let ok = AgentMessage::TaskAssigned {
        task_id: "task-1".into(),
        subject: "Refactor auth".into(),
        description: "Move bcrypt cost to env".into(),
        assigned_by: "Coordinator".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
    };
    assert!(ok.validate().is_ok());
    assert_eq!(ok.kind_tag(), "task_assigned");
    assert!(ok.is_structured());
    assert!(ok.request_id().is_none());
}

#[test]
fn every_task_identifier_position_accepts_the_exact_char_and_byte_limit() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-task-id-exact-{}", uuid::Uuid::new_v4());
    // One emoji is four UTF-8 bytes, so this value simultaneously reaches
    // the exact character and byte ceilings (1000 chars / 4000 bytes).
    let exact_limit = "😀".repeat(limits::TASK_IDENTIFIER_MAX_CHARS);

    for (position, message) in messages_for_each_task_identifier_position(&exact_limit) {
        insert_boundary_message(&run_id, message)
            .unwrap_or_else(|error| panic!("{position} rejected the exact limit: {error}"));
    }

    assert_eq!(
        AgentInboxStore::list_by_run(&run_id)
            .expect("list exact-limit inbox rows")
            .len(),
        9
    );
}

#[test]
fn every_task_identifier_position_rejects_over_char_limit_before_persistence() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-task-id-char-over-{}", uuid::Uuid::new_v4());
    let over_char_limit = "x".repeat(limits::TASK_IDENTIFIER_MAX_CHARS + 1);

    for (position, message) in messages_for_each_task_identifier_position(&over_char_limit) {
        let error = match insert_boundary_message(&run_id, message) {
            Ok(_) => panic!("{position} accepted an oversized task id"),
            Err(error) => error,
        };
        assert!(error.contains("chars"), "{position}: {error}");
    }

    assert!(
        AgentInboxStore::list_by_run(&run_id)
            .expect("list rejected char-limit rows")
            .is_empty(),
        "invalid task identifiers must not reach durable inbox storage"
    );
}

#[test]
fn every_task_identifier_position_rejects_over_byte_limit_before_persistence() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-task-id-byte-over-{}", uuid::Uuid::new_v4());
    let over_byte_limit = "😀".repeat(limits::TASK_IDENTIFIER_MAX_CHARS + 1);

    for (position, message) in messages_for_each_task_identifier_position(&over_byte_limit) {
        let error = match insert_boundary_message(&run_id, message) {
            Ok(_) => panic!("{position} accepted an oversized task id"),
            Err(error) => error,
        };
        assert!(error.contains("bytes"), "{position}: {error}");
    }

    assert!(
        AgentInboxStore::list_by_run(&run_id)
            .expect("list rejected byte-limit rows")
            .is_empty(),
        "byte-oversized task identifiers must not reach durable inbox storage"
    );
}

#[test]
fn task_assigned_rejects_blank_required_fields() {
    let bad_id = AgentMessage::TaskAssigned {
        task_id: "  ".into(),
        subject: "s".into(),
        description: "d".into(),
        assigned_by: "by".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
    };
    assert!(bad_id.validate().is_err());

    let bad_subject = AgentMessage::TaskAssigned {
        task_id: "task-1".into(),
        subject: "".into(),
        description: "d".into(),
        assigned_by: "by".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
    };
    assert!(bad_subject.validate().is_err());

    let bad_assigned_by = AgentMessage::TaskAssigned {
        task_id: "task-1".into(),
        subject: "s".into(),
        description: "d".into(),
        assigned_by: "".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
    };
    assert!(bad_assigned_by.validate().is_err());
}

#[test]
fn task_assigned_rejects_oversized_payload() {
    let bad_subject = AgentMessage::TaskAssigned {
        task_id: "task-1".into(),
        subject: "x".repeat(201),
        description: "d".into(),
        assigned_by: "by".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
    };
    assert!(bad_subject.validate().is_err());

    let bad_description = AgentMessage::TaskAssigned {
        task_id: "task-1".into(),
        subject: "s".into(),
        description: "x".repeat(4001),
        assigned_by: "by".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
    };
    assert!(bad_description.validate().is_err());
}

#[test]
fn cancelled_delivery_stays_unread_as_evidence_but_leaves_pending_queries() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = "run-delivery-cancel";
    seed_minimal_running_run_for_delivery_resolution(run_id);
    let row = seed_legacy_orphan_inbox_row(run_id, "Undeliverable", "Preserve this exact message");

    let resolution = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
        reason: "Member was removed and the work is no longer required".into(),
        replacement_inbox_id: None,
        replacement_task_id: None,
    })
    .expect("cancel delivery");
    assert_eq!(
        resolution.resolution_kind,
        AgentInboxDeliveryResolutionKind::Cancelled
    );
    let conn = get_connection().expect("open sandbox database");
    assert!(
        AgentInboxStore::unread_counts_by_recipient_with_connection(&conn, run_id)
            .expect("pending delivery snapshot")
            .is_empty()
    );
    let stored = AgentInboxStore::get_by_id_for_run(run_id, row.id)
        .expect("load evidence")
        .expect("source row remains");
    assert!(
        stored.read_at.is_none(),
        "resolution must not fake a read receipt"
    );

    let same = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
        reason: "Member was removed and the work is no longer required".into(),
        replacement_inbox_id: None,
        replacement_task_id: None,
    })
    .expect("exact retry is idempotent");
    assert_eq!(same, resolution);
    let conflict = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
        reason: "A different decision".into(),
        replacement_inbox_id: None,
        replacement_task_id: None,
    })
    .expect_err("different retry must conflict");
    assert!(conflict
        .to_string()
        .contains("different delivery resolution"));
}

#[test]
fn delivery_resolution_invalidates_stale_materialization_guard() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = "run-delivery-stale-guard";
    seed_minimal_running_run_for_delivery_resolution(run_id);
    let row =
        seed_legacy_orphan_inbox_row(run_id, "Stale receipt", "Do not acknowledge after repair");
    let conn = get_connection().expect("open sandbox database");
    conn.execute(
        "INSERT INTO agent_inbox_materializations (
                 inbox_id, session_id, transcript_message_id,
                 transcript_intent_id, materialized_at
             ) VALUES (?1, 'old-session', 'message-1', 'intent-1', ?2)",
        params![row.id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("seed stale receipt");

    AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
        reason: "Recipient permanently unavailable".into(),
        replacement_inbox_id: None,
        replacement_task_id: None,
    })
    .expect("resolve delivery");
    assert_eq!(
        AgentInboxStore::mark_many_read_for_session(&[row.id], "old-session")
            .expect("resolved row is an acknowledgement no-op"),
        0
    );
    let stored = AgentInboxStore::get_by_id_for_run(run_id, row.id)
        .expect("load source")
        .expect("source remains");
    assert!(stored.read_at.is_none());
}

#[test]
fn delivery_resolution_rejects_a_healthy_canonical_recipient() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = "run-delivery-healthy";
    seed_minimal_running_run_for_delivery_resolution(run_id);
    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coordinator-agent".into(),
        recipient_member_id: Some("coordinator".into()),
        sender_agent_id: "worker-agent".into(),
        sender_member_id: Some("worker".into()),
        org_run_id: Some(run_id.into()),
        message: AgentMessage::Plain {
            summary: "Healthy delivery".into(),
            text: "This must reach the coordinator".into(),
        },
    })
    .expect("insert healthy row");
    let error = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
        reason: "The model changed its mind".into(),
        replacement_inbox_id: None,
        replacement_task_id: None,
    })
    .expect_err("healthy recipient cannot be discarded by the model");
    assert!(error
        .to_string()
        .contains("recoverable canonical recipient"));
    assert!(
        AgentInboxStore::has_unread_for_member("coordinator", run_id)
            .expect("healthy delivery remains pending")
    );
}

#[test]
fn superseded_delivery_requires_an_existing_same_run_replacement() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = "run-delivery-supersede";
    seed_minimal_running_run_for_delivery_resolution(run_id);
    let source = seed_legacy_orphan_inbox_row(run_id, "Original", "Original work");
    let conn = get_connection().expect("open sandbox database");
    conn.execute(
        "INSERT INTO agent_org_tasks (id, org_run_id) VALUES ('replacement-task', ?1)",
        params![run_id],
    )
    .expect("seed replacement task");

    let missing = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: source.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Superseded,
        reason: "Moved to a durable replacement".into(),
        replacement_inbox_id: None,
        replacement_task_id: Some("missing-task".into()),
    })
    .expect_err("missing replacement rejected");
    assert!(missing.to_string().contains("does not exist"));

    let resolution = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: source.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: "coordinator".into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Superseded,
        reason: "Moved to a durable replacement".into(),
        replacement_inbox_id: None,
        replacement_task_id: Some("replacement-task".into()),
    })
    .expect("supersede delivery");
    assert_eq!(
        resolution.replacement_task_id.as_deref(),
        Some("replacement-task")
    );
}

#[test]
fn superseded_delivery_can_follow_a_real_replacement_chain_but_not_cycle() {
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};

    let _sandbox = sandbox_with_inbox_schema();
    let run_id = "run-delivery-chain";
    seed_minimal_running_run_for_delivery_resolution(run_id);
    let org = OrgDefinition {
        id: "org-delivery-chain".into(),
        name: "Delivery Chain".into(),
        role: "Coordinator".into(),
        agent_id: "coordinator-agent".into(),
        description: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![
            OrgMember {
                id: "member-a".into(),
                name: "Member A".into(),
                role: "worker".into(),
                agent_id: "agent-a".into(),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "member-b".into(),
                name: "Member B".into(),
                role: "worker".into(),
                agent_id: "agent-b".into(),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "member-c".into(),
                name: "Member C".into(),
                role: "worker".into(),
                agent_id: "agent-c".into(),
                runtime_config: None,
                children: Vec::new(),
            },
        ],
    };
    let conn = get_connection().expect("open sandbox database");
    conn.execute(
        "UPDATE agent_org_runs SET org_snapshot_json=?1 WHERE id=?2",
        params![serde_json::to_string(&org).unwrap(), run_id],
    )
    .expect("seed roster snapshot");
    let now = chrono::Utc::now().to_rfc3339();
    for (session_id, member_id, agent_id) in [
        ("session-a", "member-a", "agent-a"),
        ("session-b", "member-b", "agent-b"),
        ("session-c", "member-c", "agent-c"),
    ] {
        conn.execute(
            "INSERT INTO agent_sessions (
                     session_id, status, updated_at, parent_session_id,
                     agent_definition_id, org_member_id
                 ) VALUES (?1, 'idle', ?2, ?3, ?4, ?5)",
            params![
                session_id,
                &now,
                format!("root-{run_id}"),
                agent_id,
                member_id
            ],
        )
        .expect("seed healthy replacement member");
    }

    let row_a = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "agent-a".into(),
        recipient_member_id: Some("member-a".into()),
        sender_agent_id: "coordinator-agent".into(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        org_run_id: Some(run_id.into()),
        message: AgentMessage::Plain {
            summary: "A".into(),
            text: "Original delivery".into(),
        },
    })
    .expect("insert original delivery");
    let row_b = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "agent-b".into(),
        recipient_member_id: Some("member-b".into()),
        sender_agent_id: "coordinator-agent".into(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        org_run_id: Some(run_id.into()),
        message: AgentMessage::Plain {
            summary: "B".into(),
            text: "First replacement".into(),
        },
    })
    .expect("insert first replacement");
    let row_c = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "agent-c".into(),
        recipient_member_id: Some("member-c".into()),
        sender_agent_id: "coordinator-agent".into(),
        sender_member_id: Some(COORDINATOR_MEMBER_ID.into()),
        org_run_id: Some(run_id.into()),
        message: AgentMessage::Plain {
            summary: "C".into(),
            text: "Second replacement".into(),
        },
    })
    .expect("insert second replacement");

    conn.execute(
        "UPDATE agent_sessions SET status='archived' WHERE session_id='session-a'",
        [],
    )
    .expect("archive original recipient");
    AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row_a.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: COORDINATOR_MEMBER_ID.into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Superseded,
        reason: "Moved from A to B".into(),
        replacement_inbox_id: Some(row_b.id),
        replacement_task_id: None,
    })
    .expect("supersede A with B");

    conn.execute(
        "UPDATE agent_sessions SET status='archived' WHERE session_id='session-b'",
        [],
    )
    .expect("archive first replacement recipient");
    AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row_b.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: COORDINATOR_MEMBER_ID.into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Superseded,
        reason: "Moved from B to C after B became unavailable".into(),
        replacement_inbox_id: Some(row_c.id),
        replacement_task_id: None,
    })
    .expect("supersede unavailable B with C");

    conn.execute(
        "UPDATE agent_sessions SET status='archived' WHERE session_id='session-c'",
        [],
    )
    .expect("archive second replacement recipient");
    let cycle = AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id: row_c.id,
        org_run_id: run_id.into(),
        resolved_by_member_id: COORDINATOR_MEMBER_ID.into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Superseded,
        reason: "Attempt to cycle back to A".into(),
        replacement_inbox_id: Some(row_a.id),
        replacement_task_id: None,
    })
    .expect_err("a replacement chain must not cycle into an already resolved row");
    assert!(cycle
        .to_string()
        .contains("already has a delivery resolution"));
}

#[test]
fn task_assigned_round_trips_through_serde() {
    let msg = AgentMessage::TaskAssigned {
        task_id: "task-42".into(),
        subject: "Pagination on /search".into(),
        description: "Add cursor-based paging".into(),
        assigned_by: "Alice".into(),
        dependency_outputs: Vec::new(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Plan,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: AgentMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(msg, parsed);
    // Tag must be the wire-stable snake_case discriminator.
    assert!(json.contains("\"kind\":\"task_assigned\""));
}

#[test]
fn task_completed_round_trips_and_validates() {
    let msg = AgentMessage::TaskCompleted {
        task_id: "task-42".into(),
        subject: "Review draft".into(),
        completed_by_member_id: "reviewer".into(),
        output_summary: Some("Approved with two corrections".into()),
        remaining_open_task_count: 0,
    };
    assert!(msg.validate().is_ok());
    assert_eq!(msg.kind_tag(), "task_completed");
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: AgentMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(msg, parsed);
}

/// `ExecModeSetRequest` is the coordinator's mode-flip channel.
/// Pin: kind tag, structured-ness, request_id required, mode is a
/// snake_case wire string, reason length cap.
#[test]
fn exec_mode_set_request_validate_serde_and_kind_tag() {
    let ok = AgentMessage::ExecModeSetRequest {
        request_id: RequestId("req-mode-1".into()),
        mode: AgentExecMode::Plan,
        reason: Some("draft a plan first".into()),
    };
    assert!(ok.validate().is_ok());
    assert_eq!(ok.kind_tag(), "exec_mode_set_request");
    assert!(ok.is_structured());
    assert_eq!(ok.request_id().map(|r| r.as_str()), Some("req-mode-1"));

    let json = serde_json::to_value(&ok).unwrap();
    assert_eq!(json["kind"], "exec_mode_set_request");
    assert_eq!(json["mode"], "plan");

    let bad_request = AgentMessage::ExecModeSetRequest {
        request_id: RequestId("   ".into()),
        mode: AgentExecMode::Build,
        reason: None,
    };
    assert!(bad_request.validate().is_err());

    let bad_reason = AgentMessage::ExecModeSetRequest {
        request_id: RequestId("req".into()),
        mode: AgentExecMode::Build,
        reason: Some("x".repeat(501)),
    };
    assert!(bad_reason.validate().is_err());
}

#[test]
fn exec_mode_set_request_round_trips_through_serde() {
    let msg = AgentMessage::ExecModeSetRequest {
        request_id: RequestId("req-mode-rt".into()),
        mode: AgentExecMode::Ask,
        reason: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: AgentMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(msg, parsed);
    assert!(json.contains("\"kind\":\"exec_mode_set_request\""));
    assert!(json.contains("\"mode\":\"ask\""));
}
