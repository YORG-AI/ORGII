use database::db::get_connection;

use super::*;

fn make_params(org_run_id: &str, id: &str, subject: &str) -> CreateTaskParams {
    let conn = get_connection().expect("task test database");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO agent_org_runs
         (id, org_id, coordinator_agent_id, entry_mode, status, created_at, updated_at)
         VALUES (?1, 'task-test-org', 'task-test-coordinator', 'standalone_session', 'running', ?2, ?2)",
        rusqlite::params![org_run_id, now],
    )
    .expect("seed running parent Agent Org run");
    CreateTaskParams {
        id: id.into(),
        org_run_id: org_run_id.into(),
        subject: subject.into(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
        })),
    }
}

fn make_eligible_params(
    org_run_id: &str,
    id: &str,
    subject: &str,
    member_ids: &[&str],
) -> CreateTaskParams {
    let mut params = make_params(org_run_id, id, subject);
    params.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: member_ids,
    }));
    params
}

fn make_task_batch(org_run_id: &str, prefix: &str, count: usize) -> Vec<CreateTaskParams> {
    let template = make_params(org_run_id, "template", "template");
    (0..count)
        .map(|index| {
            let mut task = template.clone();
            task.id = format!("{prefix}-{index}");
            task.subject = format!("{prefix} {index}");
            task
        })
        .collect()
}

fn task_store_sandbox() -> test_helpers::test_env::SandboxGuard {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("test sqlite connection");
    crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
    crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
    init_schema(&conn).expect("agent team tasks schema");
    sandbox
}

#[test]
fn task_status_wire_round_trip() {
    for status in [
        TaskStatus::Pending,
        TaskStatus::InProgress,
        TaskStatus::Completed,
    ] {
        assert_eq!(TaskStatus::from_wire(status.as_wire()).unwrap(), status);
    }
    assert!(TaskStatus::from_wire("garbage").is_err());
}

#[test]
fn create_rejects_task_ids_that_cannot_cross_the_inbox_boundary() {
    let _sandbox = task_store_sandbox();
    let oversized_id =
        "x".repeat(crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS + 1);
    let error = AgentOrgTaskStore::create(make_eligible_params(
        "run-task-id-limit",
        &oversized_id,
        "ownerless bounded task",
        &["member-a"],
    ))
    .expect_err("an undeliverable task id must not be persisted");

    assert!(error.contains("task id must be <= 1000 chars"), "{error}");
    assert!(AgentOrgTaskStore::list("run-task-id-limit")
        .expect("inspect rejected run")
        .is_empty());
}

#[test]
fn create_rejects_oversized_dependency_ids_before_persistence() {
    let _sandbox = task_store_sandbox();
    let mut params = make_eligible_params(
        "run-dependency-id-limit",
        "bounded-task",
        "bounded dependency",
        &["member-a"],
    );
    params.blocked_by =
        vec!["x"
            .repeat(crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS + 1)];
    let error = AgentOrgTaskStore::create(params)
        .expect_err("an oversized dependency id must not be persisted");

    assert!(
        error.contains("blocked_by[0] must be <= 1000 chars"),
        "{error}"
    );
    assert!(AgentOrgTaskStore::list("run-dependency-id-limit")
        .expect("inspect rejected run")
        .is_empty());
}

#[test]
fn task_mutations_require_running_parent_run() {
    let _sandbox = task_store_sandbox();
    let conn = get_connection().expect("db");
    crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runs
         (id, org_id, coordinator_agent_id, entry_mode, status, created_at, updated_at)
         VALUES ('guarded-run', 'org', 'coord', 'standalone_session', 'paused', ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("seed paused run");

    let create_error = AgentOrgTaskStore::create(make_eligible_params(
        "guarded-run",
        "guarded-task",
        "guarded",
        &["member-a"],
    ))
    .expect_err("paused run must reject task create");
    assert!(create_error.contains("agent_org_run_not_mutable"));

    conn.execute(
        "UPDATE agent_org_runs SET status='running' WHERE id='guarded-run'",
        [],
    )
    .unwrap();
    AgentOrgTaskStore::create(make_eligible_params(
        "guarded-run",
        "guarded-task",
        "guarded",
        &["member-a"],
    ))
    .expect("running run permits create");
    conn.execute(
        "UPDATE agent_org_runs SET status='completed' WHERE id='guarded-run'",
        [],
    )
    .unwrap();
    assert!(AgentOrgTaskStore::update(
        "guarded-run",
        "guarded-task",
        UpdateTaskPatch {
            subject: Some("too late".to_string()),
            ..Default::default()
        },
    )
    .unwrap_err()
    .contains("agent_org_run_not_mutable"));
    assert!(AgentOrgTaskStore::delete("guarded-run", "guarded-task")
        .unwrap_err()
        .contains("agent_org_run_not_mutable"));
}

#[test]
fn create_get_round_trip() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let task_id = new_task_id();

    let mut params = make_params(&run_id, &task_id, "Write tests");
    params.description = "all the tests".into();
    params.active_form = Some("Writing tests".into());
    params.metadata = Some(serde_json::json!({
        "priority": "high",
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
    }));
    let created = AgentOrgTaskStore::create(params).unwrap();

    let fetched = AgentOrgTaskStore::get(&run_id, &task_id).unwrap().unwrap();
    assert_eq!(fetched.id, task_id);
    assert_eq!(fetched.subject, "Write tests");
    assert_eq!(fetched.description, "all the tests");
    assert_eq!(fetched.active_form.as_deref(), Some("Writing tests"));
    assert_eq!(fetched.status, TaskStatus::Pending);
    assert!(fetched.owner.is_none());
    assert_eq!(
        fetched.metadata.as_ref().and_then(|m| m.get("priority")),
        Some(&serde_json::Value::String("high".into()))
    );
    assert_eq!(created.created_at, fetched.created_at);
}

#[test]
fn create_rolls_back_when_transactional_outbox_fails() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let result: Result<(Task, ()), String> = AgentOrgTaskStore::create_with_transactional_effects(
        make_params(&run_id, "atomic-create", "Atomic create"),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: false,
        },
        |_tx, _task, _tasks| Err("injected outbox failure".to_string()),
    );
    assert!(result.unwrap_err().contains("injected outbox failure"));
    assert!(AgentOrgTaskStore::get(&run_id, "atomic-create")
        .unwrap()
        .is_none());
    assert!(AgentOrgTaskStore::list_history(&run_id).unwrap().is_empty());
    assert!(
        crate::coordination::agent_org_runs::AgentOrgRunStore::progress(&run_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn graph_create_rolls_back_every_row_when_transactional_outbox_fails() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut downstream = make_params(&run_id, "graph-b", "Graph B");
    downstream.blocked_by = vec!["graph-a".to_string()];
    let result: Result<(Vec<Task>, ()), String> =
        AgentOrgTaskStore::create_batch_with_transactional_effects(
            vec![make_params(&run_id, "graph-a", "Graph A"), downstream],
            true,
            |_tx, _created, _tasks| Err("injected graph outbox failure".to_string()),
        );
    assert!(result
        .unwrap_err()
        .contains("injected graph outbox failure"));
    assert!(AgentOrgTaskStore::list(&run_id).unwrap().is_empty());
    assert!(AgentOrgTaskStore::list_history(&run_id).unwrap().is_empty());
}

#[test]
fn update_rolls_back_task_history_revision_and_outbox_together() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let created =
        AgentOrgTaskStore::create(make_params(&run_id, "atomic-update", "Before update")).unwrap();
    let history_before = AgentOrgTaskStore::list_history(&run_id).unwrap();
    let revision_before = crate::coordination::agent_org_runs::AgentOrgRunStore::progress(&run_id)
        .unwrap()
        .unwrap()
        .work_revision;

    let result: Result<(TaskMutationOutcome, ()), String> =
        AgentOrgTaskStore::update_with_outcome_if_unchanged_and_transactional_effects(
            &run_id,
            &created.id,
            &created.updated_at,
            UpdateTaskPatch {
                subject: Some("After update".to_string()),
                ..Default::default()
            },
            |_tx, _outcome, _tasks| Err("injected update outbox failure".to_string()),
        );
    assert!(result
        .unwrap_err()
        .contains("injected update outbox failure"));
    assert_eq!(
        AgentOrgTaskStore::get(&run_id, &created.id)
            .unwrap()
            .unwrap()
            .subject,
        "Before update"
    );
    assert_eq!(
        AgentOrgTaskStore::list_history(&run_id).unwrap().len(),
        history_before.len()
    );
    assert_eq!(
        crate::coordination::agent_org_runs::AgentOrgRunStore::progress(&run_id)
            .unwrap()
            .unwrap()
            .work_revision,
        revision_before
    );
}

#[test]
fn concurrent_assignment_update_commits_exactly_one_task_assigned_outbox_row() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let created =
        AgentOrgTaskStore::create(make_params(&run_id, "concurrent-assignment", "Assign once"))
            .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..2 {
            let barrier = std::sync::Arc::clone(&barrier);
            let run_id = run_id.clone();
            let task_id = created.id.clone();
            let expected_updated_at = created.updated_at.clone();
            handles.push(scope.spawn(move || {
                barrier.wait();
                AgentOrgTaskStore::update_with_outcome_if_unchanged_and_transactional_effects(
                    &run_id,
                    &task_id,
                    &expected_updated_at,
                    UpdateTaskPatch {
                        owner: Some(Some("member-default".to_string())),
                        ..Default::default()
                    },
                    |tx, outcome, tasks| {
                        enqueue_task_assigned_to_with_tasks_in_tx(
                            tx,
                            &outcome.current,
                            tasks,
                            "member-agent",
                            "member-default",
                            crate::coordination::agent_inbox::SYSTEM_SENDER_ID,
                            None,
                            "Coordinator",
                        )
                    },
                )
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().expect("assignment thread"))
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                result.as_ref().is_err_and(|error| {
                    error.contains(
                        crate::coordination::agent_org_tasks::TASK_MUTATION_CONFLICT_ERROR,
                    )
                })
            })
            .count(),
        1
    );
    assert_eq!(
        crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
            "member-default",
            &run_id,
        )
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn delete_rejects_task_still_referenced_by_canonical_dependencies() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "dependency", "Dependency")).unwrap();
    let mut dependent = make_params(&run_id, "dependent", "Dependent");
    dependent.blocked_by = vec!["dependency".to_string()];
    AgentOrgTaskStore::create(dependent).unwrap();

    let error = AgentOrgTaskStore::delete(&run_id, "dependency")
        .expect_err("referenced dependency must not be silently removed");
    assert!(error.contains("task_delete_has_dependents"));
    assert!(error.contains("dependent"));
    assert!(AgentOrgTaskStore::get(&run_id, "dependency")
        .unwrap()
        .is_some());
}

#[test]
fn delete_rejects_task_used_as_an_inbox_delivery_replacement() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "replacement-task", "Replacement work"))
        .expect("create replacement task");

    let conn = get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_inbox (
             recipient_agent_id, sender_agent_id, org_run_id,
             payload_kind, payload_json, created_at
         ) VALUES (
             'removed-agent', 'coordinator-agent', ?1,
             'plain', '{\"kind\":\"plain\",\"summary\":\"old\",\"text\":\"old\"}', ?2
         )",
        rusqlite::params![&run_id, &now],
    )
    .expect("seed source inbox evidence");
    let inbox_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO agent_inbox_delivery_resolutions (
             inbox_id, org_run_id, resolution_kind, resolved_by_member_id,
             reason, replacement_task_id, created_at
         ) VALUES (?1, ?2, 'superseded', 'coordinator', 'Moved to task',
                   'replacement-task', ?3)",
        rusqlite::params![inbox_id, &run_id, &now],
    )
    .expect("seed task replacement resolution");

    let error = AgentOrgTaskStore::delete(&run_id, "replacement-task")
        .expect_err("replacement evidence must not be deleted");
    assert!(error.contains(TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR));
    assert!(AgentOrgTaskStore::get(&run_id, "replacement-task")
        .expect("reload task")
        .is_some());
}

#[test]
fn delete_fails_closed_when_delivery_resolution_schema_is_missing() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(
        &run_id,
        "schema-guarded-task",
        "Must survive schema failure",
    ))
    .expect("create guarded task");
    let conn = get_connection().expect("test sqlite connection");
    conn.execute("DROP TABLE agent_inbox_delivery_resolutions", [])
        .expect("simulate damaged delivery-resolution schema");

    let error = AgentOrgTaskStore::delete(&run_id, "schema-guarded-task")
        .expect_err("schema failure must not be treated as an unreferenced task");
    assert!(error.contains("agent_inbox_delivery_resolutions"));
    assert!(AgentOrgTaskStore::get(&run_id, "schema-guarded-task")
        .expect("reload guarded task")
        .is_some());
}

#[test]
fn create_batch_rechecks_existing_open_work_inside_transaction() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "existing", "Existing work"))
        .expect("seed existing open task");

    let error =
        AgentOrgTaskStore::create_batch(vec![make_params(&run_id, "new", "New graph root")], false)
            .expect_err("unlisted existing work must be rejected by the store transaction");
    assert!(error.starts_with(TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR));
    assert_eq!(
        AgentOrgTaskStore::list(&run_id)
            .expect("list after rejected graph")
            .len(),
        1,
        "a rejected graph must not leave a partial task row"
    );

    let mut dependent = make_params(&run_id, "dependent", "Dependent graph root");
    dependent.blocked_by = vec!["existing".to_string()];
    AgentOrgTaskStore::create_batch(vec![dependent], false)
        .expect("explicitly covering existing work should succeed");
    assert_eq!(AgentOrgTaskStore::list(&run_id).unwrap().len(), 2);
}

#[test]
fn create_rejects_blank_subject_and_id() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());

    let mut bad = make_params(&run_id, "task-1", "");
    bad.subject = "   ".into();
    assert!(AgentOrgTaskStore::create(bad).is_err());

    let bad_id = make_params(&run_id, "   ", "ok");
    assert!(AgentOrgTaskStore::create(bad_id).is_err());
}

#[test]
fn create_rejects_in_progress_without_owner() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "task-1", "ownerless running");
    params.status = TaskStatus::InProgress;

    let err = AgentOrgTaskStore::create(params).unwrap_err();
    assert!(
        err.contains("in_progress task must have an owner"),
        "got {err}"
    );
}

#[test]
fn create_rejects_noncanonical_eligibility_member_ids() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "task-1", "Noncanonical eligibility");
    params.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: [" member-default "]
    }));
    let err = AgentOrgTaskStore::create(params)
        .expect_err("surrounding whitespace must not be silently canonicalized");
    assert!(err.contains("leading or trailing whitespace"), "got {err}");
}

#[test]
fn corrupt_predicate_flags_ownerless_in_progress_and_spaced_eligibility() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let _ = make_params(&run_id, "template", "seed parent run");
    let conn = get_connection().expect("task database");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_tasks
         (id, org_run_id, subject, description, active_form, owner, status,
          blocks_json, blocked_by_json, metadata_json, created_at, updated_at)
         VALUES ('ownerless-running', ?1, 'bad running row', '', NULL, NULL,
                 'in_progress', '[]', '[]', ?2, ?3, ?3)",
        rusqlite::params![
            &run_id,
            serde_json::json!({TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"]}).to_string(),
            &now
        ],
    )
    .expect("seed ownerless in-progress row");
    conn.execute(
        "INSERT INTO agent_org_tasks
         (id, org_run_id, subject, description, active_form, owner, status,
          blocks_json, blocked_by_json, metadata_json, created_at, updated_at)
         VALUES ('spaced-eligibility', ?1, 'bad eligibility row', '', NULL, NULL,
                 'pending', '[]', '[]', ?2, ?3, ?3)",
        rusqlite::params![
            &run_id,
            serde_json::json!({TASK_METADATA_ELIGIBLE_MEMBER_IDS: [" member-default "]})
                .to_string(),
            &now
        ],
    )
    .expect("seed spaced eligibility row");

    let predicate = corrupt_task_row_predicate_sql();
    let corrupt_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM agent_org_tasks WHERE org_run_id=?1 AND {predicate}"),
            rusqlite::params![&run_id],
            |row| row.get(0),
        )
        .expect("count corrupt historical rows");
    assert_eq!(corrupt_count, 2);
}

#[test]
fn summary_filtered_total_matches_rows_after_scalar_corruption_filtering() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "valid-task", "Visible task"))
        .expect("create visible task");
    let conn = get_connection().expect("task database");
    let now = chrono::Utc::now().to_rfc3339();
    let oversized_id =
        "x".repeat(crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS + 1);
    conn.execute(
        "INSERT INTO agent_org_tasks
         (id, org_run_id, subject, description, active_form, owner, status,
          blocks_json, blocked_by_json, metadata_json, created_at, updated_at)
         VALUES (?1, ?2, 'hidden corrupt row', '', NULL, NULL, 'pending',
                 '[]', '[]', ?3, ?4, ?4)",
        rusqlite::params![
            oversized_id,
            &run_id,
            serde_json::json!({TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"]}).to_string(),
            now
        ],
    )
    .expect("seed oversized historical id");

    let page = AgentOrgTaskStore::list_summary_page(&run_id, None, None, None, 200)
        .expect("bounded summary page");
    assert_eq!(page.filtered_total, 1);
    assert_eq!(page.tasks.len(), 1);
    assert_eq!(page.tasks[0].id, "valid-task");
}

#[test]
fn store_rejects_ownerless_pending_without_eligibility() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "task-1", "missing eligibility");
    params.metadata = None;

    let err = AgentOrgTaskStore::create(params).unwrap_err();
    assert!(err.contains("non-empty eligible_member_ids"), "got {err}");
}

#[test]
fn store_rejects_malformed_reserved_dispatch_metadata() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "task-1", "bad eligibility");
    params.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: "member-a",
    }));
    let err = AgentOrgTaskStore::create(params).unwrap_err();
    assert!(err.contains("must be an array"), "got {err}");

    let mut invalid_output = make_params(&run_id, "task-output", "bad output timestamp");
    invalid_output.owner = Some("member-default".to_string());
    invalid_output.status = TaskStatus::Completed;
    invalid_output.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
        TASK_METADATA_OUTPUT: {
            "summary": "done",
            "content": null,
            "artifactIds": [],
            "producedByMemberId": "member-default",
            "producedAt": "not-a-timestamp",
        },
    }));
    let err = AgentOrgTaskStore::create(invalid_output).unwrap_err();
    assert!(err.contains("valid RFC3339"), "got {err}");

    let mut timezone_less_output = make_params(&run_id, "task-output-zone", "missing zone");
    timezone_less_output.owner = Some("member-default".to_string());
    timezone_less_output.status = TaskStatus::Completed;
    timezone_less_output.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
        TASK_METADATA_OUTPUT: {
            "summary": "done",
            "content": null,
            "artifactIds": [],
            "producedByMemberId": "member-default",
            "producedAt": "2026-07-17 12:34:56",
        },
    }));
    let err = AgentOrgTaskStore::create(timezone_less_output).unwrap_err();
    assert!(err.contains("valid RFC3339"), "got {err}");

    let mut oversized_producer =
        make_params(&run_id, "task-output-producer", "oversized output producer");
    oversized_producer.owner = Some("member-default".to_string());
    oversized_producer.status = TaskStatus::Completed;
    oversized_producer.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
        TASK_METADATA_OUTPUT: {
            "summary": "done",
            "content": null,
            "artifactIds": [],
            "producedByMemberId": "x".repeat(
                crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS + 1
            ),
            "producedAt": chrono::Utc::now().to_rfc3339(),
        },
    }));
    let err = AgentOrgTaskStore::create(oversized_producer).unwrap_err();
    assert!(
        err.contains("task output produced_by_member_id must be <= 1000 chars"),
        "got {err}"
    );

    let historical_metadata = serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
        TASK_METADATA_OUTPUT: {
            "summary": "done",
            "content": null,
            "artifactIds": [],
            "producedByMemberId": "x".repeat(
                crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS + 1
            ),
            "producedAt": chrono::Utc::now().to_rfc3339(),
        },
    });
    let conn = get_connection().expect("task database");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_tasks
         (id, org_run_id, subject, description, active_form, owner, status,
          blocks_json, blocked_by_json, metadata_json, created_at, updated_at)
         VALUES ('historical-output-producer', ?1, 'historical', '', NULL,
                 'member-default', 'completed', '[]', '[]', ?2, ?3, ?3)",
        rusqlite::params![&run_id, historical_metadata.to_string(), now],
    )
    .expect("seed historical oversized producer");
    let predicate = corrupt_task_row_predicate_sql();
    let classified: bool = conn
        .query_row(
            &format!(
                "SELECT {predicate} FROM agent_org_tasks
                 WHERE org_run_id=?1 AND id='historical-output-producer'"
            ),
            rusqlite::params![&run_id],
            |row| row.get(0),
        )
        .expect("classify historical producer");
    assert!(
        classified,
        "historical oversized producer must block finality"
    );

    let timezone_less_metadata = serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-default"],
        TASK_METADATA_OUTPUT: {
            "summary": "done",
            "content": null,
            "artifactIds": [],
            "producedByMemberId": "member-default",
            "producedAt": "2026-07-17 12:34:56",
        },
    });
    conn.execute(
        "INSERT INTO agent_org_tasks
         (id, org_run_id, subject, description, active_form, owner, status,
          blocks_json, blocked_by_json, metadata_json, created_at, updated_at)
         VALUES ('historical-output-zone', ?1, 'historical', '', NULL,
                 'member-default', 'completed', '[]', '[]', ?2, ?3, ?3)",
        rusqlite::params![&run_id, timezone_less_metadata.to_string(), now],
    )
    .expect("seed historical timezone-less output");
    let classified: bool = conn
        .query_row(
            &format!(
                "SELECT {predicate} FROM agent_org_tasks
                 WHERE org_run_id=?1 AND id='historical-output-zone'"
            ),
            rusqlite::params![&run_id],
            |row| row.get(0),
        )
        .expect("classify historical timezone-less output");
    assert!(classified, "timezone-less output must block finality");
}

#[test]
fn store_rejects_owner_and_eligibility_outside_launch_roster() {
    use crate::coordination::agent_org_runs::{
        AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    };
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};

    let _sandbox = task_store_sandbox();
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: "org-roster".to_string(),
        coordinator_agent_id: "coord".to_string(),
        root_session_id: None,
        org_snapshot: OrgDefinition {
            id: "org-roster".to_string(),
            name: "Roster".to_string(),
            role: "coordinator".to_string(),
            agent_id: "coord".to_string(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: vec![OrgMember {
                id: "member-a".to_string(),
                name: "A".to_string(),
                role: "worker".to_string(),
                agent_id: "agent-a".to_string(),
                runtime_config: None,
                children: Vec::new(),
            }],
        },
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .unwrap();

    let err = AgentOrgTaskStore::create(make_eligible_params(
        &run.id,
        "outside",
        "outside roster",
        &["member-b"],
    ))
    .unwrap_err();
    assert!(err.contains("outside run roster"), "got {err}");

    let mut owned = make_eligible_params(&run.id, "outside-owner", "outside owner", &["member-a"]);
    owned.owner = Some("member-b".to_string());
    owned.status = TaskStatus::InProgress;
    let err = AgentOrgTaskStore::create(owned).unwrap_err();
    assert!(err.contains("owner is outside run roster"), "got {err}");
}

#[test]
fn update_rejects_ownerless_in_progress_state() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "task-1", "claim me")).unwrap();

    let err = AgentOrgTaskStore::update(
        &run_id,
        "task-1",
        UpdateTaskPatch {
            status: Some(TaskStatus::InProgress),
            owner: Some(None),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        err.contains("in_progress task must have an owner"),
        "got {err}"
    );
}

#[test]
fn list_scopes_by_run_id() {
    let _sandbox = task_store_sandbox();
    let run_a = format!("run-{}", uuid::Uuid::new_v4());
    let run_b = format!("run-{}", uuid::Uuid::new_v4());

    AgentOrgTaskStore::create(make_params(&run_a, "a-1", "one")).unwrap();
    AgentOrgTaskStore::create(make_params(&run_a, "a-2", "two")).unwrap();
    AgentOrgTaskStore::create(make_params(&run_b, "b-1", "other")).unwrap();

    let listed_a = AgentOrgTaskStore::list(&run_a).unwrap();
    assert_eq!(listed_a.len(), 2);
    assert!(listed_a.iter().all(|t| t.org_run_id == run_a));

    let listed_b = AgentOrgTaskStore::list(&run_b).unwrap();
    assert_eq!(listed_b.len(), 1);
    assert_eq!(listed_b[0].id, "b-1");
}

#[test]
fn update_applies_patch_and_clears_owner() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "t-1", "draft subject");
    params.owner = Some("member-alpha".into());
    params.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(params).unwrap();

    let updated = AgentOrgTaskStore::update(
        &run_id,
        "t-1",
        UpdateTaskPatch {
            subject: Some("final subject".into()),
            description: Some("filled in".into()),
            status: Some(TaskStatus::Completed),
            owner: Some(None),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(updated.subject, "final subject");
    assert_eq!(updated.description, "filled in");
    assert_eq!(updated.status, TaskStatus::Completed);
    assert!(updated.owner.is_none());

    // updated_at must have advanced (or at least be present and different
    // shape — we can't assert strict > because RFC3339 strings may match
    // when the test runs faster than 1s; presence + rewrite is enough).
    assert!(!updated.updated_at.is_empty());
}

#[test]
fn store_rejects_completed_task_status_regression() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "done-once", "done once");
    params.owner = Some("member-alpha".into());
    params.status = TaskStatus::Completed;
    AgentOrgTaskStore::create(params).unwrap();

    let err = AgentOrgTaskStore::update(
        &run_id,
        "done-once",
        UpdateTaskPatch {
            status: Some(TaskStatus::Pending),
            ..Default::default()
        },
    )
    .expect_err("completed status must be monotonic at the store boundary");
    assert!(err.starts_with(super::TASK_COMPLETED_IMMUTABLE_ERROR));
    assert_eq!(
        AgentOrgTaskStore::get(&run_id, "done-once")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
}

#[test]
fn update_outcome_only_marks_ready_transition_once() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_eligible_params(
        &run_id,
        "ready-once",
        "ready once",
        &["member-a"],
    ))
    .unwrap();

    let first = AgentOrgTaskStore::update_with_outcome(
        &run_id,
        "ready-once",
        UpdateTaskPatch {
            owner: Some(Some("member-a".to_string())),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(first.owner_changed);
    assert!(first.became_ready);

    let repeated = AgentOrgTaskStore::update_with_outcome(
        &run_id,
        "ready-once",
        UpdateTaskPatch {
            owner: Some(Some("member-a".to_string())),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!repeated.owner_changed);
    assert!(!repeated.became_ready);
}

#[test]
fn update_missing_returns_error() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    // The mutation invariant first verifies that the parent run exists and is
    // mutable. Seed only that run so this test reaches the missing-task branch.
    let _unused = make_params(&run_id, "not-created", "not created");
    let err =
        AgentOrgTaskStore::update(&run_id, "missing", UpdateTaskPatch::default()).unwrap_err();
    assert!(err.contains("task_not_found"), "got {err}");
}

#[test]
fn create_rejects_self_dependency_cycle() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "self", "self cycle");
    params.blocked_by = vec!["self".into()];

    let err = AgentOrgTaskStore::create(params).unwrap_err();
    assert!(err.contains(TASK_DEPENDENCY_CYCLE_ERROR), "got {err}");
}

#[test]
fn create_rejects_dependency_fan_in_above_persistence_limit() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_params(&run_id, "too-many-inputs", "too many inputs");
    params.blocked_by = (0
        ..=crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_MAX_COUNT)
        .map(|index| format!("dependency-{index}"))
        .collect();

    let error = AgentOrgTaskStore::create(params).expect_err("fan-in must be bounded");
    assert!(
        error.starts_with(TASK_DEPENDENCY_LIMIT_ERROR),
        "got {error}"
    );
    assert!(AgentOrgTaskStore::list(&run_id).unwrap().is_empty());
}

#[test]
fn create_batch_rejects_derived_fan_out_above_persistence_limit() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let root = make_params(&run_id, "root", "root");
    let mut graph = vec![root];
    for index in 0..=crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_MAX_COUNT {
        let mut downstream = make_params(&run_id, &format!("downstream-{index}"), "downstream");
        downstream.blocked_by = vec!["root".to_string()];
        graph.push(downstream);
    }

    let error = AgentOrgTaskStore::create_batch(graph, true)
        .expect_err("derived fan-out projection must be bounded");
    assert!(
        error.starts_with(TASK_DEPENDENCY_LIMIT_ERROR),
        "got {error}"
    );
    assert!(AgentOrgTaskStore::list(&run_id).unwrap().is_empty());
}

#[test]
fn create_batch_rejects_oversized_internal_graph_before_writes() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let template = make_params(&run_id, "template", "template");
    let graph = (0..=crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS)
        .map(|index| {
            let mut task = template.clone();
            task.id = format!("task-{index}");
            task.subject = format!("Task {index}");
            task
        })
        .collect();

    let error = AgentOrgTaskStore::create_batch(graph, true)
        .expect_err("oversized internal graph must be rejected");
    assert!(error.starts_with(TASK_RUN_TASK_LIMIT_ERROR), "got {error}");
    assert!(AgentOrgTaskStore::list(&run_id).unwrap().is_empty());
}

#[test]
fn run_task_capacity_applies_to_single_and_existing_plus_batch_create() {
    let _sandbox = task_store_sandbox();
    let maximum = crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS;

    let single_run_id = format!("run-single-capacity-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create_batch(make_task_batch(&single_run_id, "seed", maximum - 1), true)
        .expect("seed one slot below the run capacity");
    AgentOrgTaskStore::create(make_params(
        &single_run_id,
        "last-slot",
        "Last available slot",
    ))
    .expect("single create may fill the final run slot");
    let single_error = AgentOrgTaskStore::create(make_params(
        &single_run_id,
        "over-capacity",
        "Must not be inserted",
    ))
    .expect_err("single create must not exceed the durable run capacity");
    assert!(
        single_error.starts_with(TASK_RUN_TASK_LIMIT_ERROR),
        "got {single_error}"
    );
    assert_eq!(
        AgentOrgTaskStore::list(&single_run_id).unwrap().len(),
        maximum
    );

    let batch_run_id = format!("run-batch-capacity-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create_batch(make_task_batch(&batch_run_id, "seed", maximum - 1), true)
        .expect("seed one slot below the run capacity");
    let batch_error =
        AgentOrgTaskStore::create_batch(make_task_batch(&batch_run_id, "overflow", 2), true)
            .expect_err("existing plus batch size must be checked inside the transaction");
    assert!(
        batch_error.starts_with(TASK_RUN_TASK_LIMIT_ERROR),
        "got {batch_error}"
    );
    assert_eq!(
        AgentOrgTaskStore::list(&batch_run_id).unwrap().len(),
        maximum - 1,
        "rejected batch must leave every row uncommitted"
    );
}

#[test]
fn concurrent_single_creates_cannot_cross_run_task_capacity() {
    let _sandbox = task_store_sandbox();
    let maximum = crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS;
    let run_id = format!("run-concurrent-capacity-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create_batch(make_task_batch(&run_id, "seed", maximum - 1), true)
        .expect("seed one slot below the run capacity");

    let first = make_params(&run_id, "concurrent-a", "Concurrent A");
    let second = make_params(&run_id, "concurrent-b", "Concurrent B");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let results = std::thread::scope(|scope| {
        let first_barrier = std::sync::Arc::clone(&barrier);
        let first_handle = scope.spawn(move || {
            first_barrier.wait();
            AgentOrgTaskStore::create(first)
        });
        let second_barrier = std::sync::Arc::clone(&barrier);
        let second_handle = scope.spawn(move || {
            second_barrier.wait();
            AgentOrgTaskStore::create(second)
        });
        vec![
            first_handle.join().expect("first create thread"),
            second_handle.join().expect("second create thread"),
        ]
    });

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let errors = results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 1);
    assert!(
        errors[0].starts_with(TASK_RUN_TASK_LIMIT_ERROR),
        "got {}",
        errors[0]
    );
    assert_eq!(AgentOrgTaskStore::list(&run_id).unwrap().len(), maximum);
}

#[test]
fn update_rejects_dependency_cycle_in_canonical_blocked_by() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "first", "first")).unwrap();
    let mut second = make_params(&run_id, "second", "second");
    second.blocked_by = vec!["first".into()];
    AgentOrgTaskStore::create(second).unwrap();

    let err = AgentOrgTaskStore::update(
        &run_id,
        "first",
        UpdateTaskPatch {
            blocked_by: Some(vec!["second".into()]),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains(TASK_DEPENDENCY_CYCLE_ERROR), "got {err}");

    let first = AgentOrgTaskStore::get(&run_id, "first").unwrap().unwrap();
    assert!(first.blocked_by.is_empty());
}

#[test]
fn dependency_cycle_validation_is_scoped_by_run() {
    let _sandbox = task_store_sandbox();
    let run_a = format!("run-a-{}", uuid::Uuid::new_v4());
    let run_b = format!("run-b-{}", uuid::Uuid::new_v4());

    AgentOrgTaskStore::create(make_params(&run_a, "first", "first")).unwrap();
    let mut run_a_second = make_params(&run_a, "second", "second");
    run_a_second.blocked_by = vec!["first".into()];
    AgentOrgTaskStore::create(run_a_second).unwrap();

    AgentOrgTaskStore::create(make_params(&run_b, "second", "second")).unwrap();
    let mut run_b_first = make_params(&run_b, "first", "first");
    run_b_first.blocked_by = vec!["second".into()];
    AgentOrgTaskStore::create(run_b_first).unwrap();
}

#[test]
fn delete_removes_row() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    AgentOrgTaskStore::create(make_params(&run_id, "t-1", "to delete")).unwrap();

    assert!(AgentOrgTaskStore::delete(&run_id, "t-1").unwrap());
    assert!(AgentOrgTaskStore::get(&run_id, "t-1").unwrap().is_none());
    let history = AgentOrgTaskStore::list_history(&run_id).unwrap();
    assert_eq!(history.last().unwrap().event_type, "deleted");
    assert!(!AgentOrgTaskStore::delete(&run_id, "t-1").unwrap());
}

#[test]
fn authorized_mutation_precondition_rejects_stale_update_and_delete() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let original = AgentOrgTaskStore::create(make_eligible_params(
        &run_id,
        "versioned-task",
        "original",
        &["member-alpha"],
    ))
    .unwrap();

    AgentOrgTaskStore::update(
        &run_id,
        "versioned-task",
        UpdateTaskPatch {
            subject: Some("newer version".to_string()),
            ..Default::default()
        },
    )
    .unwrap();

    let update_error = AgentOrgTaskStore::update_with_outcome_if_unchanged(
        &run_id,
        "versioned-task",
        &original.updated_at,
        UpdateTaskPatch {
            description: Some("stale writer".to_string()),
            ..Default::default()
        },
    )
    .expect_err("stale authorized update must not overwrite a newer owner/version");
    assert!(update_error.starts_with(TASK_MUTATION_CONFLICT_ERROR));

    let delete_error =
        AgentOrgTaskStore::delete_if_unchanged(&run_id, "versioned-task", &original.updated_at)
            .expect_err("stale authorized delete must not remove a newer owner/version");
    assert!(delete_error.starts_with(TASK_MUTATION_CONFLICT_ERROR));

    let stored = AgentOrgTaskStore::get(&run_id, "versioned-task")
        .unwrap()
        .unwrap();
    assert_eq!(stored.subject, "newer version");
    assert_eq!(stored.description, "");
}

#[test]
fn requeue_in_progress_for_owner_releases_to_coordinator_assignment() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_eligible_params(&run_id, "t-1", "claim me", &["member-alpha"]);
    params.owner = Some("member-alpha".into());
    params.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(params).unwrap();

    let requeued = AgentOrgTaskStore::requeue_in_progress_for_owner(&run_id, "member-alpha")
        .expect("requeue in-progress work");

    assert_eq!(requeued.len(), 1);
    assert_eq!(requeued[0].owner, None);
    assert_eq!(requeued[0].status, TaskStatus::Pending);
    let stored = AgentOrgTaskStore::get(&run_id, "t-1").unwrap().unwrap();
    assert_eq!(stored.owner, None);
    assert_eq!(stored.status, TaskStatus::Pending);
}

#[test]
fn requeue_in_progress_for_owner_preserves_eligibility_metadata() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params = make_eligible_params(
        &run_id,
        "t-shared",
        "claim me",
        &["member-alpha", "member-beta"],
    );
    params.owner = Some("member-alpha".into());
    params.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(params).unwrap();

    let requeued = AgentOrgTaskStore::requeue_in_progress_for_owner(&run_id, "member-alpha")
        .expect("requeue in-progress work");

    assert_eq!(requeued.len(), 1);
    assert_eq!(
        requeued[0].owner, None,
        "failed owner is removed before coordinator reassignment"
    );
    assert_eq!(requeued[0].status, TaskStatus::Pending);
    assert_eq!(
        eligible_member_ids(&requeued[0]),
        vec!["member-alpha".to_string(), "member-beta".to_string()]
    );
}

#[test]
fn task_history_records_create_update_and_release_for_reassignment() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let mut params =
        make_eligible_params(&run_id, "t-1", "history", &["member-alpha", "member-beta"]);
    params.owner = Some("member-alpha".into());
    params.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(params).unwrap();
    AgentOrgTaskStore::update(
        &run_id,
        "t-1",
        UpdateTaskPatch {
            subject: Some("history updated".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    AgentOrgTaskStore::dispose_open_tasks_for_shutdown(&run_id, "member-alpha").unwrap();

    let history = AgentOrgTaskStore::list_history(&run_id).unwrap();
    let event_types: Vec<&str> = history
        .iter()
        .map(|event| event.event_type.as_str())
        .collect();
    assert_eq!(
        event_types,
        vec![TASK_EVENT_CREATED, TASK_EVENT_UPDATED, TASK_EVENT_RELEASED]
    );
    let released = history.last().unwrap();
    assert_eq!(released.previous_owner.as_deref(), Some("member-alpha"));
    assert_eq!(released.next_owner, None);
    assert_eq!(released.next_status, Some(TaskStatus::Pending));
}

#[test]
fn enqueue_task_assigned_writes_inbox_row() {
    use crate::core::coordination::agent_inbox::{AgentInboxStore, AgentMessage};

    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());

    let mut params = make_params(&run_id, "task-1", "Pagination");
    params.description = "Cursor-based".into();
    params.owner = Some("member-alice".into());
    params.status = TaskStatus::InProgress;
    let task = AgentOrgTaskStore::create(params).unwrap();

    let row_id = enqueue_task_assigned_to(
        &task,
        "alice-agent",
        "member-alice",
        "coord-agent",
        Some("coordinator"),
        "Coordinator",
    )
    .unwrap();
    assert!(row_id > 0);

    let pending =
        AgentInboxStore::list_unread_for_member("member-alice", &run_id).expect("list_unread");
    assert_eq!(pending.len(), 1, "one TaskAssigned row should be pending");
    let row = &pending[0];
    assert_eq!(row.payload_kind, "task_assigned");
    assert_eq!(row.sender_agent_id, "coord-agent");
    assert_eq!(row.sender_member_id.as_deref(), Some("coordinator"));
    assert_eq!(row.recipient_agent_id, "alice-agent");
    assert_eq!(row.org_run_id.as_deref(), Some(run_id.as_str()));

    let decoded = row.decode_payload().expect("decode");
    match decoded {
        AgentMessage::TaskAssigned {
            task_id,
            subject,
            description,
            assigned_by,
            dependency_outputs,
            ..
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(subject, "Pagination");
            assert_eq!(description, "Cursor-based");
            assert_eq!(assigned_by, "Coordinator");
            assert!(dependency_outputs.is_empty());
        }
        other => panic!("expected TaskAssigned, got {other:?}"),
    }
}

#[test]
fn enqueue_task_assigned_bounds_total_dependency_output_content() {
    use crate::core::coordination::agent_inbox::{AgentInboxStore, AgentMessage};

    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    let blocker_ids = ["blocker-a", "blocker-b", "blocker-c"];
    for blocker_id in blocker_ids {
        let mut params = make_params(&run_id, blocker_id, blocker_id);
        params.owner = Some("member-producer".into());
        params.status = TaskStatus::Completed;
        params.metadata = Some(serde_json::json!({
            TASK_METADATA_OUTPUT: {
                "summary": format!("{blocker_id} result"),
                "content": "x".repeat(20_000),
                "artifactIds": [],
                "producedByMemberId": "member-producer",
                "producedAt": now.clone(),
            }
        }));
        AgentOrgTaskStore::create(params).expect("create completed blocker");
    }
    let mut dependent = make_params(&run_id, "dependent", "Consume outputs");
    dependent.owner = Some("member-consumer".into());
    dependent.blocked_by = blocker_ids.iter().map(|id| (*id).to_string()).collect();
    let dependent = AgentOrgTaskStore::create(dependent).expect("create dependent");

    enqueue_task_assigned_to(
        &dependent,
        "consumer-agent",
        "member-consumer",
        "coord-agent",
        Some("coordinator"),
        "Coordinator",
    )
    .expect("bounded dependency handoff must validate");
    let row = AgentInboxStore::list_unread_for_member("member-consumer", &run_id)
        .unwrap()
        .pop()
        .expect("assignment row");
    let AgentMessage::TaskAssigned {
        dependency_outputs, ..
    } = row.decode_payload().expect("decode")
    else {
        panic!("expected TaskAssigned");
    };
    let total_inline_chars = dependency_outputs
        .iter()
        .filter_map(|output| output.content.as_ref())
        .map(|content| content.chars().count())
        .sum::<usize>();
    assert!(total_inline_chars <= 50_000);
    assert!(dependency_outputs.iter().any(|output| {
        output
            .content
            .as_deref()
            .is_some_and(|content| content.contains("Inline output truncated"))
            || output.content.is_none()
    }));
}

#[test]
fn enqueue_task_assigned_rejects_unowned_task() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let task = AgentOrgTaskStore::create(make_params(&run_id, "task-2", "subj")).unwrap();
    // No owner set → enqueue must fail with a structured error so the
    // caller (task tools / recovery redelivery) can surface it back to
    // the LLM rather than silently dropping the row.
    let err = enqueue_task_assigned_to(
        &task,
        "worker-agent",
        "member-worker",
        "_system",
        None,
        "system",
    )
    .unwrap_err();
    assert!(err.contains("unowned"), "{err}");
}

#[test]
fn shutdown_disposition_releases_only_when_peer_is_eligible() {
    let _sandbox = task_store_sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());

    let mut t1 = make_eligible_params(&run_id, "t1", "S1", &["alice", "bob"]);
    t1.owner = Some("alice".into());
    t1.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(t1).unwrap();
    let mut t2 = make_eligible_params(&run_id, "t2", "S2", &["alice"]);
    t2.owner = Some("alice".into());
    t2.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(t2).unwrap();
    let mut t3 = make_eligible_params(&run_id, "t3", "S3", &["bob"]);
    t3.owner = Some("bob".into());
    t3.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(t3).unwrap();
    let mut t4 = make_eligible_params(&run_id, "t4", "S4", &["alice"]);
    t4.owner = Some("alice".into());
    t4.status = TaskStatus::InProgress;
    AgentOrgTaskStore::create(t4).unwrap();
    // Mark t2 completed; unassign should leave it alone.
    AgentOrgTaskStore::update(
        &run_id,
        "t2",
        UpdateTaskPatch {
            status: Some(TaskStatus::Completed),
            ..Default::default()
        },
    )
    .unwrap();
    // t3 owned by bob — must not be touched.

    let unassigned = AgentOrgTaskStore::dispose_open_tasks_for_shutdown(&run_id, "alice").unwrap();
    assert_eq!(unassigned.len(), 2);
    assert_eq!(unassigned[0].id, "t1");
    assert!(unassigned[0].owner.is_none());
    assert_eq!(unassigned[0].status, TaskStatus::Pending);
    let escalated = unassigned.iter().find(|task| task.id == "t4").unwrap();
    assert_eq!(escalated.owner.as_deref(), Some("coordinator"));
    assert_eq!(escalated.status, TaskStatus::Pending);
    let escalated_event = AgentOrgTaskStore::list_history(&run_id)
        .unwrap()
        .into_iter()
        .rev()
        .find(|event| event.task_id == "t4")
        .unwrap();
    assert_eq!(
        escalated_event.event_type,
        TASK_EVENT_ESCALATED_TO_COORDINATOR
    );

    // t2 stays completed + owned, t3 stays owned by bob.
    let t2 = AgentOrgTaskStore::get(&run_id, "t2").unwrap().unwrap();
    assert_eq!(t2.status, TaskStatus::Completed);
    assert_eq!(t2.owner.as_deref(), Some("alice"));
    let t3 = AgentOrgTaskStore::get(&run_id, "t3").unwrap().unwrap();
    assert_eq!(t3.owner.as_deref(), Some("bob"));
}

// ============================================================
// ready_unassigned_tasks (single-pass scan)
// ============================================================

fn plain_task(id: &str, status: TaskStatus) -> Task {
    Task {
        id: id.into(),
        org_run_id: "run".into(),
        subject: id.into(),
        description: String::new(),
        active_form: None,
        owner: None,
        status,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn eligible_task(id: &str, status: TaskStatus, member_ids: &[&str]) -> Task {
    let mut task = plain_task(id, status);
    task.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: member_ids,
    }));
    task
}

#[test]
fn ready_unassigned_tasks_filters_owned_resolved_and_blocked() {
    let mut owned = eligible_task("owned", TaskStatus::Pending, &["alice"]);
    owned.owner = Some("alice".into());
    let completed = plain_task("done", TaskStatus::Completed);
    let mut blocked_on_open = eligible_task("blocked-open", TaskStatus::Pending, &["alice"]);
    blocked_on_open.blocked_by = vec!["owned".into()];
    let mut blocked_on_done = eligible_task("blocked-done", TaskStatus::Pending, &["bob"]);
    blocked_on_done.blocked_by = vec!["done".into()];
    let mut blocked_on_missing = eligible_task("blocked-missing", TaskStatus::Pending, &["carol"]);
    blocked_on_missing.blocked_by = vec!["ghost".into()];
    let free = eligible_task("free", TaskStatus::Pending, &["alice", "bob"]);

    let tasks = vec![
        owned,
        completed,
        blocked_on_open,
        blocked_on_done,
        blocked_on_missing,
        free,
    ];
    let ready: Vec<&str> = ready_unassigned_tasks(&tasks)
        .into_iter()
        .map(|task| task.id.as_str())
        .collect();
    assert_eq!(ready, vec!["blocked-done", "free"]);
}
