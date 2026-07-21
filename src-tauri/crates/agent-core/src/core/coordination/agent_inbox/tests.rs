//! Store-integration tests for `agent_inbox`. These exercise the persisted
//! write/read/drain paths against a sandboxed SQLite database and share the
//! `sandbox_with_inbox_schema` fixture. Pure `AgentMessage` validation/serde
//! tests live next to the code they exercise (see `message.rs`).

use super::store_read::{task_assignment_lookup_sql, UNREAD_COUNTS_BY_RECIPIENT_SQL};
use super::*;
use database::db::get_connection;
use rusqlite::params;
use std::collections::HashSet;

fn sandbox_with_inbox_schema() -> test_helpers::test_env::SandboxGuard {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("open sandbox database");
    init_schema(&conn).expect("initialize agent inbox schema");
    sandbox
}

#[test]
fn list_by_run_round_trips_in_insert_order() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let other_run_id = format!("run-{}", uuid::Uuid::new_v4());

    // Two messages on the run we care about, plus one on a sibling run
    // — list_by_run must filter out the sibling.
    let first = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-worker-1".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "kickoff".into(),
            text: "begin".into(),
        },
    })
    .expect("insert first");
    let second = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coord".into(),
        recipient_member_id: Some("coordinator".into()),
        sender_agent_id: "worker-1".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::ShutdownRequest {
            request_id: RequestId("req-shut-1".into()),
            reason: Some("done".into()),
        },
    })
    .expect("insert second");
    let _ = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-worker-1".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(other_run_id.clone()),
        message: AgentMessage::Plain {
            summary: "other".into(),
            text: "irrelevant".into(),
        },
    })
    .expect("insert other-run row");

    let rows = AgentInboxStore::list_by_run(&run_id).expect("list_by_run");
    assert_eq!(rows.len(), 2, "only the run-scoped rows must surface");
    assert_eq!(rows[0].id, first.id);
    assert_eq!(rows[1].id, second.id);
    assert_eq!(rows[0].payload_kind, "plain");
    assert_eq!(rows[1].payload_kind, "shutdown_request");
    assert_eq!(rows[1].request_id.as_deref(), Some("req-shut-1"));
}

#[test]
fn inbox_history_pages_are_cursor_bounded_without_gaps() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-history-page-{}", uuid::Uuid::new_v4());
    let payload = serde_json::to_string(&AgentMessage::Plain {
        summary: "history".into(),
        text: "bounded row".into(),
    })
    .expect("serialize history payload");
    let mut conn = get_connection().expect("open inbox database");
    let tx = conn.transaction().expect("begin history fixture");
    let now = chrono::Utc::now().to_rfc3339();
    for _ in 0..205 {
        tx.execute(
            "INSERT INTO agent_inbox (
                 recipient_agent_id, recipient_member_id, sender_agent_id,
                 sender_member_id, org_run_id, payload_kind, payload_json,
                 request_id, created_at, read_at, causation_inbox_id
             ) VALUES ('worker-agent','worker-member','sender',NULL,?1,
                       'plain',?2,NULL,?3,NULL,NULL)",
            params![&run_id, &payload, &now],
        )
        .expect("seed history row");
    }
    tx.commit().expect("commit history fixture");

    let first =
        AgentInboxStore::list_page_by_run(&run_id, None, usize::MAX).expect("first bounded page");
    assert_eq!(first.rows.len(), MAX_INBOX_HISTORY_PAGE_ROWS);
    assert!(first.has_more);
    let second = AgentInboxStore::list_page_by_run(&run_id, first.next_cursor, usize::MAX)
        .expect("second bounded page");
    assert_eq!(second.rows.len(), MAX_INBOX_HISTORY_PAGE_ROWS);
    assert!(second.has_more);
    let third = AgentInboxStore::list_page_by_run(&run_id, second.next_cursor, usize::MAX)
        .expect("third bounded page");
    assert_eq!(third.rows.len(), 5);
    assert!(!third.has_more);
    assert!(third.next_cursor.is_none());

    let ids = first
        .rows
        .iter()
        .chain(second.rows.iter())
        .chain(third.rows.iter())
        .map(|row| row.id)
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 205);
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
}

#[test]
fn recent_run_snapshot_is_bounded_and_counts_do_not_load_payloads() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut inserted_ids = Vec::new();
    for index in 0..3 {
        let row = AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker-agent".into(),
            recipient_member_id: Some("worker-member".into()),
            sender_agent_id: "sender".into(),
            sender_member_id: None,
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: format!("message-{index}"),
                text: format!("body-{index}"),
            },
        })
        .expect("insert run row");
        inserted_ids.push(row.id);
    }
    // Historical agent-only rows remain readable, but the production
    // write boundary no longer permits creating new ones.
    let conn = get_connection().expect("open inbox database for legacy fixture");
    conn.execute(
        "INSERT INTO agent_inbox (
             recipient_agent_id, recipient_member_id, sender_agent_id,
             sender_member_id, org_run_id, payload_kind, payload_json,
             request_id, created_at, read_at, causation_inbox_id
         ) VALUES (?1,NULL,?2,NULL,?3,'plain',?4,NULL,?5,NULL,NULL)",
        params![
            "coordinator-agent",
            "sender",
            &run_id,
            serde_json::to_string(&AgentMessage::Plain {
                summary: "message-3".into(),
                text: "body-3".into(),
            })
            .expect("serialize legacy payload"),
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("seed legacy agent-only row");
    inserted_ids.push(conn.last_insert_rowid());
    AgentInboxStore::mark_many_read(&inserted_ids[..1]).expect("mark first row read");

    let recent = AgentInboxStore::list_recent_by_run(&run_id, 2).expect("recent snapshot");
    assert_eq!(
        recent.iter().map(|row| row.id).collect::<Vec<_>>(),
        inserted_ids[2..].to_vec(),
        "the bounded tail must be returned in chronological order"
    );
    assert!(AgentInboxStore::list_recent_by_run(&run_id, 0)
        .expect("empty snapshot")
        .is_empty());

    let counts = AgentInboxStore::run_counts_by_recipient(&run_id).expect("recipient counts");
    let worker = counts
        .iter()
        .find(|count| count.recipient_member_id.as_deref() == Some("worker-member"))
        .expect("worker aggregate");
    assert_eq!(worker.activity_count, 3);
    assert_eq!(worker.unread_count, 2);
    let legacy_coordinator = counts
        .iter()
        .find(|count| count.recipient_member_id.is_none())
        .expect("agent-id-only aggregate");
    assert_eq!(legacy_coordinator.activity_count, 1);
    assert_eq!(legacy_coordinator.unread_count, 1);

    let conn = get_connection().expect("open inbox database");
    let unread_counts = AgentInboxStore::unread_counts_by_recipient_with_connection(&conn, &run_id)
        .expect("unread-only recipient counts");
    let unread_worker = unread_counts
        .iter()
        .find(|count| count.recipient_member_id.as_deref() == Some("worker-member"))
        .expect("unread worker aggregate");
    assert_eq!(unread_worker.unread_count, 2);
    let unread_legacy = unread_counts
        .iter()
        .find(|count| count.recipient_member_id.is_none())
        .expect("unread legacy aggregate");
    assert_eq!(unread_legacy.unread_count, 1);

    let mut query_plan = conn
        .prepare(&format!(
            "EXPLAIN QUERY PLAN {UNREAD_COUNTS_BY_RECIPIENT_SQL}"
        ))
        .expect("prepare unread query plan");
    let details = query_plan
        .query_map(params![&run_id], |row| row.get::<_, String>(3))
        .expect("query unread plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect unread plan");
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("idx_agent_inbox_run_unread_recipient")),
        "watchdog/run-view unread aggregation must stay on the partial unread index: {details:?}"
    );
    assert!(
        details
            .iter()
            .all(|detail| !detail.contains("USE TEMP B-TREE")),
        "unread aggregation order must stream from its covering index: {details:?}"
    );

    let previews =
        AgentInboxStore::list_recent_previews_by_run(&run_id, 4).expect("run activity previews");
    assert_eq!(previews[0].display_preview.as_deref(), Some("body-0"));
    assert_ne!(
        previews[0].display_preview.as_deref(),
        Some("message-0"),
        "plain activity must project the delivered text, not only its label"
    );
}

#[test]
fn new_agent_org_rows_require_a_nonblank_canonical_recipient_member() {
    let _sandbox = sandbox_with_inbox_schema();
    for recipient_member_id in [None, Some("".to_string()), Some("   ".to_string())] {
        let error = AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker-agent".into(),
            recipient_member_id,
            sender_agent_id: "coordinator-agent".into(),
            sender_member_id: Some("coordinator".into()),
            org_run_id: Some("run-write-boundary".into()),
            message: AgentMessage::Plain {
                summary: "repair".into(),
                text: "payload".into(),
            },
        })
        .expect_err("new Agent Org rows must have a canonical member recipient");
        assert!(
            error.contains("recipient_member_id"),
            "unexpected validation error: {error}"
        );
    }
}

#[test]
fn run_preview_omits_large_plan_payload() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let sentinel = "FULL_PLAN_BODY_MUST_NOT_REACH_RUN_VIEW";
    let plan_content = format!("{sentinel}{}", "x".repeat(18_000));
    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "coordinator-agent".into(),
        recipient_member_id: Some("coordinator".into()),
        sender_agent_id: "planner-agent".into(),
        sender_member_id: Some("planner".into()),
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::PlanApprovalRequest {
            request_id: RequestId("request-large-plan".into()),
            approval_id: "approval-large-plan".into(),
            plan_revision_id: "revision-large-plan".into(),
            source_task_id: "task-plan".into(),
            plan_title: "Large but valid plan".into(),
            plan_path: "/tmp/large.plan.md".into(),
            plan_content,
        },
    })
    .expect("insert large plan request");

    let previews = AgentInboxStore::list_recent_previews_by_run(&run_id, 10)
        .expect("load lightweight preview");
    assert_eq!(previews.len(), 1);
    assert_eq!(previews[0].id, row.id);
    assert_eq!(
        previews[0].display_preview.as_deref(),
        Some("Large but valid plan")
    );
    let wire = serde_json::to_string(&previews).expect("serialize previews");
    assert!(!wire.contains(sentinel));
    assert!(
        wire.len() < 2_000,
        "preview unexpectedly retained payload: {wire}"
    );
}

#[test]
fn caused_inbox_insert_coalesces_only_the_same_recipient_member() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let source_id = 42;
    let make_params = |recipient_member_id: &str| InsertInboxParams {
        recipient_agent_id: "shared-agent-definition".into(),
        recipient_member_id: Some(recipient_member_id.into()),
        sender_agent_id: SYSTEM_SENDER_ID.into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::MemberTerminated {
            member_id: "worker".into(),
            member_name: "Worker".into(),
            reason: MemberTerminationReason::Shutdown,
        },
    };

    let (first, first_inserted) =
        AgentInboxStore::insert_once_for_causation(make_params("coordinator-a"), source_id)
            .expect("insert first caused notification");
    let (replayed, replay_inserted) =
        AgentInboxStore::insert_once_for_causation(make_params("coordinator-a"), source_id)
            .expect("coalesce exact replay");
    let (sibling, sibling_inserted) =
        AgentInboxStore::insert_once_for_causation(make_params("coordinator-b"), source_id)
            .expect("insert for distinct roster member");

    assert!(first_inserted);
    assert!(!replay_inserted);
    assert_eq!(first.id, replayed.id);
    assert!(sibling_inserted);
    assert_ne!(first.id, sibling.id);
    assert_eq!(
        AgentInboxStore::list_by_run(&run_id)
            .expect("list caused rows")
            .len(),
        2
    );
}

#[test]
fn open_assignment_snapshot_uses_current_tasks_and_expression_index() {
    let _sandbox = sandbox_with_inbox_schema();
    let conn = get_connection().expect("test database");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    for (task_id, status) in [("open-task", "pending"), ("done-task", "completed")] {
        conn.execute(
            "INSERT INTO agent_org_tasks
             (id, org_run_id, subject, description, status, owner,
              blocks_json, blocked_by_json, created_at, updated_at)
             VALUES (?1, ?2, ?1, '', ?3, 'member-worker', '[]', '[]', ?4, ?4)",
            params![task_id, &run_id, status, &now],
        )
        .expect("seed task");
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker".into(),
            recipient_member_id: Some("member-worker".into()),
            sender_agent_id: "coordinator".into(),
            sender_member_id: Some("coordinator".into()),
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::TaskAssigned {
                task_id: task_id.into(),
                subject: task_id.into(),
                description: String::new(),
                assigned_by: "Coordinator".into(),
                dependency_outputs: Vec::new(),
                execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
            },
        })
        .expect("seed assignment");
    }

    let assigned =
        AgentInboxStore::task_assignment_ids_for_open_tasks_with_connection(&conn, &run_id)
            .expect("open assignment snapshot");
    assert_eq!(assigned, HashSet::from(["open-task".to_string()]));

    let mut stmt = conn
        .prepare(&format!(
            "EXPLAIN QUERY PLAN {}",
            task_assignment_lookup_sql()
        ))
        .expect("prepare indexed assignment explain");
    let details = stmt
        .query_map(params![&run_id, "member-worker", "open-task"], |row| {
            row.get::<_, String>(3)
        })
        .expect("query plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect query plan");
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("idx_agent_inbox_run_task_assignment_v4")),
        "assignment lookup must use the expression index: {details:?}"
    );
    assert!(
        details
            .iter()
            .all(|detail| !detail.contains("USE TEMP B-TREE")),
        "exact assignment lookup must not allocate a temp sort: {details:?}"
    );
}

#[test]
fn assignment_snapshot_requires_current_owner_and_valid_typed_payload() {
    let _sandbox = sandbox_with_inbox_schema();
    let conn = get_connection().expect("test database");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    for task_id in ["reassigned-task", "{}"] {
        conn.execute(
            "INSERT INTO agent_org_tasks
             (id, org_run_id, subject, description, status, owner,
              blocks_json, blocked_by_json, created_at, updated_at)
             VALUES (?1, ?2, ?1, '', 'pending', 'member-b', '[]', '[]', ?3, ?3)",
            params![task_id, &run_id, &now],
        )
        .expect("seed reassigned task");
    }

    // A valid historical delivery to the old owner must not suppress a
    // new delivery after the task is reassigned to member-b.
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-a".into(),
        recipient_member_id: Some("member-a".into()),
        sender_agent_id: "coordinator".into(),
        sender_member_id: Some("coordinator".into()),
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::TaskAssigned {
            task_id: "reassigned-task".into(),
            subject: "old delivery".into(),
            description: String::new(),
            assigned_by: "Coordinator".into(),
            dependency_outputs: Vec::new(),
            execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
        },
    })
    .expect("seed old-owner assignment");

    // Valid JSON with the right tag/id but missing required fields is not
    // a real TaskAssigned envelope and cannot suppress recovery.
    conn.execute(
        "INSERT INTO agent_inbox (
             recipient_agent_id, recipient_member_id, sender_agent_id,
             org_run_id, payload_kind, payload_json, created_at
         ) VALUES ('worker-b', 'member-b', 'coordinator', ?1,
                   'task_assigned', ?2, ?3)",
        params![
            &run_id,
            r#"{"kind":"task_assigned","task_id":"reassigned-task"}"#,
            &now
        ],
    )
    .expect("seed incomplete typed payload");

    // A non-text task_id must not collide with the literal task id "{}".
    conn.execute(
        "INSERT INTO agent_inbox (
             recipient_agent_id, recipient_member_id, sender_agent_id,
             org_run_id, payload_kind, payload_json, created_at
         ) VALUES ('worker-b', 'member-b', 'coordinator', ?1,
                   'task_assigned', ?2, ?3)",
        params![
            &run_id,
            r#"{"kind":"task_assigned","task_id":{},"subject":"x","description":"","assigned_by":"Coordinator"}"#,
            &now
        ],
    )
    .expect("seed non-text task id");

    let assigned =
        AgentInboxStore::task_assignment_ids_for_open_tasks_with_connection(&conn, &run_id)
            .expect("scan invalid candidates");
    assert!(assigned.is_empty());

    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-b".into(),
        recipient_member_id: Some("member-b".into()),
        sender_agent_id: "coordinator".into(),
        sender_member_id: Some("coordinator".into()),
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::TaskAssigned {
            task_id: "reassigned-task".into(),
            subject: "new delivery".into(),
            description: String::new(),
            assigned_by: "Coordinator".into(),
            dependency_outputs: Vec::new(),
            execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
        },
    })
    .expect("seed current-owner assignment");
    let assigned =
        AgentInboxStore::task_assignment_ids_for_open_tasks_with_connection(&conn, &run_id)
            .expect("scan current-owner assignment");
    assert_eq!(assigned, HashSet::from(["reassigned-task".to_string()]));
}

#[test]
fn production_drain_batches_leave_overflow_unread_for_next_wake() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    for index in 0..(MAX_INBOX_DRAIN_ROWS + 2) {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker".into(),
            recipient_member_id: Some("member-worker".into()),
            sender_agent_id: "coordinator".into(),
            sender_member_id: Some("coordinator".into()),
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: format!("message-{index}"),
                text: format!("body-{index}"),
            },
        })
        .expect("insert batched inbox row");
    }

    let first = AgentInboxStore::list_unread_batch_for_member("member-worker", &run_id)
        .expect("first drain batch");
    assert_eq!(first.rows.len(), MAX_INBOX_DRAIN_ROWS);
    assert!(first.has_more);
    AgentInboxStore::mark_many_read(&first.rows.iter().map(|row| row.id).collect::<Vec<_>>())
        .expect("commit first batch");
    assert!(
        AgentInboxStore::has_unread_for_member("member-worker", &run_id)
            .expect("remaining unread probe")
    );

    let second = AgentInboxStore::list_unread_batch_for_member("member-worker", &run_id)
        .expect("second drain batch");
    assert_eq!(second.rows.len(), 2);
    assert!(!second.has_more);
    assert!(second.rows[0].id > first.rows.last().unwrap().id);
}

#[test]
fn unread_ack_queries_use_a_bounded_high_water_mark_without_loading_payloads() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut ids = Vec::new();
    for index in 0..3 {
        let row = AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker".into(),
            recipient_member_id: Some("member-worker".into()),
            sender_agent_id: "coordinator".into(),
            sender_member_id: Some("coordinator".into()),
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: format!("ack-{index}"),
                text: "payload must not be selected by ack polling".into(),
            },
        })
        .expect("insert ack row");
        ids.push(row.id);
    }
    let boundary = AgentInboxStore::unread_ack_boundary_for_member("member-worker", &run_id)
        .expect("capture unread boundary")
        .expect("unread boundary");
    assert_eq!(boundary, ids[2]);

    AgentInboxStore::mark_many_read(&[ids[1]]).expect("ack middle row");
    assert_eq!(
        AgentInboxStore::unread_count_through_boundary("member-worker", &run_id, boundary,)
            .expect("count unread through boundary"),
        2
    );

    let later = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker".into(),
        recipient_member_id: Some("member-worker".into()),
        sender_agent_id: "coordinator".into(),
        sender_member_id: Some("coordinator".into()),
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "later".into(),
            text: "does not extend the captured boundary".into(),
        },
    })
    .expect("insert later row");
    assert!(later.id > boundary);
    assert_eq!(
        AgentInboxStore::unread_count_through_boundary("member-worker", &run_id, boundary,)
            .expect("later row excluded"),
        2
    );
}

#[test]
fn production_drain_batch_obeys_serialized_byte_budget() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let large_text = "🧭".repeat(19_000);
    for index in 0..20 {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker".into(),
            recipient_member_id: Some("member-worker".into()),
            sender_agent_id: "coordinator".into(),
            sender_member_id: Some("coordinator".into()),
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: format!("large-{index}"),
                text: large_text.clone(),
            },
        })
        .expect("insert large valid inbox row");
    }

    let batch = AgentInboxStore::list_unread_batch_for_member("member-worker", &run_id)
        .expect("byte-bounded batch");
    let bytes = batch
        .rows
        .iter()
        .map(|row| row.payload_json.len())
        .sum::<usize>();
    assert!(bytes <= MAX_INBOX_DRAIN_PAYLOAD_BYTES);
    assert!(batch.rows.len() < 20);
    assert!(batch.has_more);
}

#[test]
fn decode_payload_round_trip() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let original = AgentMessage::ShutdownResponse {
        request_id: RequestId("req-shut-roundtrip".into()),
        accepted: true,
        note: Some("clean exit".into()),
    };
    let record = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-2".into(),
        recipient_member_id: Some("member-worker-2".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id),
        message: original.clone(),
    })
    .expect("insert");
    let decoded = record.decode_payload().expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn list_unread_filters_by_recipient_run_and_unread() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let other_run = format!("run-{}", uuid::Uuid::new_v4());

    let in_scope = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-worker-1".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "in".into(),
            text: "yes".into(),
        },
    })
    .expect("in-scope");

    // Wrong recipient — must be excluded.
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-2".into(),
        recipient_member_id: Some("member-worker-2".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "wrong-recipient".into(),
            text: "no".into(),
        },
    })
    .expect("wrong-recipient");

    // Wrong run — must be excluded.
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-worker-1".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(other_run),
        message: AgentMessage::Plain {
            summary: "wrong-run".into(),
            text: "no".into(),
        },
    })
    .expect("wrong-run");

    // Same delivery agent id but different member id — must be excluded
    // from member-id drain.
    AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-other-worker".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "member-scoped".into(),
            text: "no".into(),
        },
    })
    .expect("member-scoped");

    let unread =
        AgentInboxStore::list_unread_for_member("member-worker-1", &run_id).expect("list_unread");
    assert_eq!(unread.len(), 1);
    assert_eq!(unread[0].id, in_scope.id);
    assert!(unread[0].read_at.is_none());
}

#[test]
fn mark_many_read_is_idempotent_and_advances_watermark() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let one = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-worker-1".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "a".into(),
            text: "1".into(),
        },
    })
    .expect("one");
    let two = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker-1".into(),
        recipient_member_id: Some("member-worker-1".into()),
        sender_agent_id: "coord".into(),
        sender_member_id: None,
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "b".into(),
            text: "2".into(),
        },
    })
    .expect("two");

    let updated = AgentInboxStore::mark_many_read(&[one.id, two.id]).expect("first mark");
    assert_eq!(updated, 2);

    // Second call is a no-op (idempotent) — already-read rows
    // contribute zero to the count.
    let again = AgentInboxStore::mark_many_read(&[one.id, two.id]).expect("second mark");
    assert_eq!(again, 0);

    let still_unread =
        AgentInboxStore::list_unread_for_member("member-worker-1", &run_id).expect("list_unread");
    assert!(
        still_unread.is_empty(),
        "marked rows must vanish from the unread list"
    );
}

#[test]
fn stale_session_cannot_ack_another_sessions_materialization() {
    let _sandbox = sandbox_with_inbox_schema();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "worker".into(),
        recipient_member_id: Some("member-worker".into()),
        sender_agent_id: "coordinator".into(),
        sender_member_id: Some("coordinator".into()),
        org_run_id: Some(run_id.clone()),
        message: AgentMessage::Plain {
            summary: "ownership".into(),
            text: "ownership".into(),
        },
    })
    .expect("insert inbox row");
    let conn = get_connection().expect("db");
    conn.execute(
        "INSERT INTO agent_inbox_materializations
         (inbox_id, session_id, transcript_message_id, transcript_intent_id, materialized_at)
         VALUES (?1, 'new-session', 'message', 'intent', ?2)",
        params![row.id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("seed current receipt owner");

    assert!(
        AgentInboxStore::mark_many_read_for_session(&[row.id], "old-session")
            .expect_err("stale guard must fail the whole acknowledgement")
            .contains("refusing partial acknowledgement")
    );
    assert_eq!(
        AgentInboxStore::list_unread_for_member("member-worker", &run_id)
            .expect("unread after stale ack")
            .len(),
        1
    );
    assert_eq!(
        AgentInboxStore::mark_many_read_for_session(&[row.id], "new-session").expect("owner ack"),
        1
    );
}

#[test]
fn mark_many_read_empty_input_is_ok() {
    let _sandbox = sandbox_with_inbox_schema();
    let updated = AgentInboxStore::mark_many_read(&[]).expect("empty");
    assert_eq!(updated, 0);
}
