use super::*;
use crate::projects::types::{
    RoutineCatchUpPolicy, RoutineOutputMode, RoutineResourceSelection, RoutineRunTarget,
    RoutineWorkspaceTarget,
};
use test_helpers::test_env;

fn routine_fixture(id: &str, policy: RoutineOutputPolicy) -> RoutineDefinition {
    RoutineDefinition {
        id: id.to_string(),
        name: format!("Routine {id}"),
        description: "Routine test fixture".to_string(),
        enabled: true,
        trigger: RoutineTrigger::OneTime {
            at: "2026-05-30T00:00:00Z".to_string(),
        },
        run_template: RoutineRunTemplate {
            prompt: "Ask about the fixture".to_string(),
            target: RoutineRunTarget::AgentDefinition {
                agent_definition_id: Some("builtin:sde".to_string()),
            },
            resources: RoutineResourceSelection {
                key_source: Some("own_key".to_string()),
                account_id: Some("account-1".to_string()),
                model: Some("model-1".to_string()),
                native_harness_type: None,
            },
            workspace: RoutineWorkspaceTarget::LocalWorkspace {
                workspace_path: "/tmp/orgii-routine-test".to_string(),
                additional_directories: vec![],
            },
            mode: Some("ask".to_string()),
            name: Some("Routine fixture session".to_string()),
        },
        output_policy: policy,
        last_evaluated_at: None,
        next_fire_at: None,
        last_fire_at: None,
        last_fire_status: None,
        last_fire_error: None,
        last_fire_session_id: None,
        last_fire_work_item_id: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn policy(concurrency_policy: RoutineConcurrencyPolicy) -> RoutineOutputPolicy {
    RoutineOutputPolicy {
        mode: RoutineOutputMode::DirectSession,
        concurrency_policy,
        catch_up_policy: RoutineCatchUpPolicy::RunOnce,
        max_catch_up_runs: 1,
        idempotency_scope: "routine_fire".to_string(),
        create_work_item_status: "planned".to_string(),
        create_work_item_project_slug: None,
        create_work_item_title: None,
        create_work_item_body: None,
        auto_start: true,
        update_work_item_short_id: None,
        update_work_item_project_slug: None,
    }
}

#[test]
fn upsert_round_trips_output_policy() {
    let _sandbox = test_env::sandbox();
    let saved = upsert_routine(routine_fixture(
        "routine-roundtrip",
        policy(RoutineConcurrencyPolicy::QueueIfActive),
    ))
    .expect("upsert routine");

    assert_eq!(
        saved.output_policy.concurrency_policy,
        RoutineConcurrencyPolicy::QueueIfActive
    );
    assert_eq!(saved.output_policy.mode, RoutineOutputMode::DirectSession);
    assert_eq!(saved.output_policy.idempotency_scope, "routine_fire");

    let read = read_routine("routine-roundtrip").expect("read routine");
    assert_eq!(read.output_policy, saved.output_policy);
}

#[test]
fn upsert_computes_next_fire_immediately_in_declared_timezone() {
    use chrono::Timelike;

    let _sandbox = test_env::sandbox();
    let mut routine = routine_fixture(
        "routine-next-fire",
        policy(RoutineConcurrencyPolicy::AlwaysCreate),
    );
    routine.trigger = RoutineTrigger::Cron {
        cron: "0 9 * * *".to_string(),
        timezone: "America/Vancouver".to_string(),
    };

    let saved = upsert_routine(routine).expect("upsert routine");
    let next = saved.next_fire_at.expect("next fire projected on save");
    let next = chrono::DateTime::parse_from_rfc3339(&next)
        .expect("next fire is RFC3339")
        .with_timezone(&"America/Vancouver".parse::<chrono_tz::Tz>().unwrap());
    assert_eq!(next.hour(), 9);
    assert_eq!(next.minute(), 0);
}

#[test]
fn routine_projects_the_latest_fire_result() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-latest-result",
        policy(RoutineConcurrencyPolicy::AlwaysCreate),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-latest-result").expect("create fire");
    mark_routine_fire_work_item_created(&fire.id, "ABC-0001").expect("link work item");

    let routine = read_routine("routine-latest-result").expect("read routine");
    assert_eq!(routine.last_fire_status, Some(RoutineFireStatus::Succeeded));
    assert_eq!(routine.last_fire_work_item_id.as_deref(), Some("ABC-0001"));
    assert!(routine.last_fire_at.is_some());
}

#[test]
fn empty_output_policy_json_decodes_to_default_policy() {
    assert_eq!(
        decode_output_policy("{}").expect("decode default"),
        RoutineOutputPolicy::default()
    );
    assert_eq!(
        decode_output_policy("   ").expect("decode blank default"),
        RoutineOutputPolicy::default()
    );
}

#[test]
fn coalesce_policy_records_pointer_without_session() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-coalesce",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");

    let first = create_routine_fire_for_policy(
        "routine-coalesce",
        &policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    )
    .expect("first fire");
    let second = create_routine_fire_for_policy(
        "routine-coalesce",
        &policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    )
    .expect("second fire");

    assert_eq!(first.status, RoutineFireStatus::Pending);
    assert_eq!(second.status, RoutineFireStatus::Coalesced);
    assert_eq!(
        second.coalesced_into_fire_id.as_deref(),
        Some(first.id.as_str())
    );
    assert!(second.session_id.is_none());
    assert!(second.completed_at.is_some());
}

#[test]
fn skip_policy_records_terminal_fire_without_session() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-skip",
        policy(RoutineConcurrencyPolicy::SkipIfActive),
    ))
    .expect("upsert routine");

    let first = create_routine_fire_for_policy(
        "routine-skip",
        &policy(RoutineConcurrencyPolicy::SkipIfActive),
    )
    .expect("first fire");
    let second = create_routine_fire_for_policy(
        "routine-skip",
        &policy(RoutineConcurrencyPolicy::SkipIfActive),
    )
    .expect("second fire");

    assert_eq!(first.status, RoutineFireStatus::Pending);
    assert_eq!(second.status, RoutineFireStatus::Skipped);
    assert!(second.session_id.is_none());
    assert!(second.completed_at.is_some());
    assert!(second
        .error
        .as_deref()
        .is_some_and(|error| error.contains(first.id.as_str())));
}

#[test]
fn queue_policy_records_non_terminal_queued_fire() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-queue",
        policy(RoutineConcurrencyPolicy::QueueIfActive),
    ))
    .expect("upsert routine");

    let first = create_routine_fire_for_policy(
        "routine-queue",
        &policy(RoutineConcurrencyPolicy::QueueIfActive),
    )
    .expect("first fire");
    let second = create_routine_fire_for_policy(
        "routine-queue",
        &policy(RoutineConcurrencyPolicy::QueueIfActive),
    )
    .expect("second fire");

    assert_eq!(first.status, RoutineFireStatus::Pending);
    assert_eq!(second.status, RoutineFireStatus::Queued);
    assert!(second.session_id.is_none());
    assert!(second.completed_at.is_none());
    assert!(second
        .error
        .as_deref()
        .is_some_and(|error| error.contains(first.id.as_str())));
}

#[test]
fn always_create_policy_ignores_active_fire() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-always",
        policy(RoutineConcurrencyPolicy::AlwaysCreate),
    ))
    .expect("upsert routine");

    let first = create_routine_fire_for_policy(
        "routine-always",
        &policy(RoutineConcurrencyPolicy::AlwaysCreate),
    )
    .expect("first fire");
    let second = create_routine_fire_for_policy(
        "routine-always",
        &policy(RoutineConcurrencyPolicy::AlwaysCreate),
    )
    .expect("second fire");

    assert_eq!(first.status, RoutineFireStatus::Pending);
    assert_eq!(second.status, RoutineFireStatus::Pending);
    assert_ne!(first.id, second.id);
}

#[test]
fn mark_started_and_failed_update_fire_metadata() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-status",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-status").expect("create fire");

    let started =
        mark_routine_fire_started(&fire.id, "session-1", Some("org-run-1")).expect("mark started");
    assert_eq!(started.status, RoutineFireStatus::Started);
    assert_eq!(started.session_id.as_deref(), Some("session-1"));
    assert_eq!(started.agent_org_run_id.as_deref(), Some("org-run-1"));
    assert!(started.started_at.is_some());
    assert!(started.error.is_none());

    let failed = mark_routine_fire_failed(&fire.id, "provider unavailable").expect("mark failed");
    assert_eq!(failed.status, RoutineFireStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("provider unavailable"));
    assert_eq!(failed.session_id.as_deref(), Some("session-1"));
    assert!(failed.completed_at.is_some());
}

#[test]
fn reconciliation_closes_pre_session_terminal_dispatch_fire() {
    use crate::projects::types::{
        EnqueueWorkItemRunRequest, WorkItemRunTarget, WorkItemRunTargetSnapshot, WorkItemRunTrigger,
    };
    use crate::work_service::{self, CreateWorkItemRequest};

    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-reconcile-dispatch",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-reconcile-dispatch").expect("create fire");

    work_service::tests_support::seed_project("demo", "project-1");
    work_service::create_project_work_item(
        "demo",
        "AAA-0001",
        &CreateWorkItemRequest {
            title: "Routine dispatch".to_string(),
            ..Default::default()
        },
        None,
    )
    .expect("seed work item");
    mark_routine_fire_work_item_started(&fire.id, "AAA-0001", None)
        .expect("link fire before dispatch");

    crate::work_run_service::enqueue(EnqueueWorkItemRunRequest {
        project_slug: Some("demo".to_string()),
        org_id: "personal-org".to_string(),
        work_item_id: "AAA-0001".to_string(),
        trigger: WorkItemRunTrigger::Routine {
            routine_id: "routine-reconcile-dispatch".to_string(),
            fire_id: fire.id.clone(),
        },
        target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::StartWorkItem {
            account_id: Some("account-1".to_string()),
            model_id: Some("model-1".to_string()),
        }),
        input: serde_json::json!({"prompt": "run"}),
        idempotency_key: format!("routine-fire:{}", fire.id),
        max_attempts: 3,
        parent_run_id: None,
    })
    .expect("enqueue run");
    let lease = crate::work_run_service::claim_next_dispatch("desktop-test", 30_000)
        .expect("claim")
        .expect("lease");
    crate::work_run_service::record_dispatch_failure(
        &lease.dispatch_id,
        &lease.lease_token,
        "Unauthorized: invalid API key (status 401)",
    )
    .expect("terminalize dispatch");

    let recovered = reconcile_terminal_dispatch_fires().expect("reconcile");
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].id, fire.id);
    assert_eq!(recovered[0].status, RoutineFireStatus::Failed);
    assert!(recovered[0].session_id.is_none());
    assert!(recovered[0]
        .error
        .as_deref()
        .is_some_and(|error| error.contains("Unauthorized")));
    assert!(reconcile_terminal_dispatch_fires()
        .expect("idempotent reconcile")
        .is_empty());
}

#[test]
fn reconciliation_follows_retry_ancestry_to_close_started_fire() {
    use crate::projects::types::{
        EnqueueWorkItemRunRequest, WorkItemRunTarget, WorkItemRunTargetSnapshot,
        WorkItemRunTrigger, WorkItemRunUsage,
    };
    use crate::work_run_service::WorkItemRunTerminalOutcome;
    use crate::work_service::{self, CreateWorkItemRequest};

    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-reconcile-retry",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-reconcile-retry").expect("create fire");
    work_service::tests_support::seed_project("demo", "project-1");
    work_service::create_project_work_item(
        "demo",
        "AAA-0001",
        &CreateWorkItemRequest {
            title: "Routine retry dispatch".to_string(),
            ..Default::default()
        },
        None,
    )
    .expect("seed work item");

    let first = crate::work_run_service::enqueue(EnqueueWorkItemRunRequest {
        project_slug: Some("demo".to_string()),
        org_id: "personal-org".to_string(),
        work_item_id: "AAA-0001".to_string(),
        trigger: WorkItemRunTrigger::Routine {
            routine_id: "routine-reconcile-retry".to_string(),
            fire_id: fire.id.clone(),
        },
        target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::StartWorkItem {
            account_id: Some("account-1".to_string()),
            model_id: Some("model-1".to_string()),
        }),
        input: serde_json::json!({"prompt": "run"}),
        idempotency_key: format!("routine-fire:{}", fire.id),
        max_attempts: 3,
        parent_run_id: None,
    })
    .expect("enqueue first run");
    let first_lease = crate::work_run_service::claim_next_dispatch("desktop-test", 30_000)
        .expect("claim first")
        .expect("first lease");
    crate::work_run_service::acknowledge_dispatch_started(
        &first_lease.dispatch_id,
        &first_lease.lease_token,
        "session-retry",
    )
    .expect("ack first");
    mark_routine_fire_work_item_started(&fire.id, "AAA-0001", Some("session-retry"))
        .expect("link started fire");
    crate::work_run_service::record_run_terminal(
        &first.id,
        Some("session-retry"),
        WorkItemRunTerminalOutcome::Failed,
        WorkItemRunUsage::default(),
        Some("request timed out"),
    )
    .expect("fail first run");

    let retry =
        crate::work_run_service::retry(&first.id, "retry:fire-reconcile").expect("enqueue retry");
    let retry_lease = crate::work_run_service::claim_next_dispatch("desktop-test", 30_000)
        .expect("claim retry")
        .expect("retry lease");
    assert_eq!(retry_lease.run.id, retry.id);
    crate::work_run_service::record_dispatch_failure(
        &retry_lease.dispatch_id,
        &retry_lease.lease_token,
        "invalid input while resuming Session",
    )
    .expect("fail retry dispatch");

    let recovered = reconcile_terminal_dispatch_fires().expect("reconcile retry ancestry");
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].id, fire.id);
    assert_eq!(recovered[0].status, RoutineFireStatus::Failed);
    assert_eq!(recovered[0].session_id.as_deref(), Some("session-retry"));
    assert!(recovered[0]
        .error
        .as_deref()
        .is_some_and(|error| error.contains("invalid input")));
}

#[test]
fn mark_work_item_created_links_fire_without_session() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-work-item-link",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-work-item-link").expect("create fire");

    let linked =
        mark_routine_fire_work_item_created(&fire.id, "AAA-0001").expect("mark work item created");
    assert_eq!(linked.status, RoutineFireStatus::Succeeded);
    assert_eq!(linked.work_item_id.as_deref(), Some("AAA-0001"));
    assert!(linked.session_id.is_none());
    assert!(linked.agent_org_run_id.is_none());
    assert!(linked.started_at.is_some());
    assert!(linked.completed_at.is_some());
    assert!(linked.error.is_none());
}

#[test]
fn idempotency_key_dedupes_fires() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-idem",
        policy(RoutineConcurrencyPolicy::AlwaysCreate),
    ))
    .expect("upsert routine");

    let first = create_routine_fire_for_policy_with_key(
        "routine-idem",
        &policy(RoutineConcurrencyPolicy::AlwaysCreate),
        Some("routine-idem:2026-06-10T09:00:00Z"),
    )
    .expect("first fire");
    let second = create_routine_fire_for_policy_with_key(
        "routine-idem",
        &policy(RoutineConcurrencyPolicy::AlwaysCreate),
        Some("routine-idem:2026-06-10T09:00:00Z"),
    )
    .expect("second fire");

    assert_eq!(first.id, second.id, "same key must return the same fire");
    assert_eq!(
        second.idempotency_key.as_deref(),
        Some("routine-idem:2026-06-10T09:00:00Z")
    );
}

#[test]
fn mark_succeeded_completes_started_fire() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-succeed",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-succeed").expect("create fire");
    mark_routine_fire_started(&fire.id, "session-9", None).expect("mark started");

    let succeeded = mark_routine_fire_succeeded(&fire.id).expect("mark succeeded");
    assert_eq!(succeeded.status, RoutineFireStatus::Succeeded);
    assert!(succeeded.completed_at.is_some());
    assert!(succeeded.error.is_none());
}

#[test]
fn find_started_fire_by_session_matches_only_active() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-find",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let fire = create_routine_fire("routine-find").expect("create fire");
    mark_routine_fire_started(&fire.id, "session-find", None).expect("mark started");

    let found = find_started_fire_by_session("session-find")
        .expect("query")
        .expect("fire found");
    assert_eq!(found.id, fire.id);

    mark_routine_fire_succeeded(&fire.id).expect("mark succeeded");
    assert!(find_started_fire_by_session("session-find")
        .expect("query")
        .is_none());
}

#[test]
fn take_next_queued_fire_promotes_oldest_when_idle() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-dequeue",
        policy(RoutineConcurrencyPolicy::QueueIfActive),
    ))
    .expect("upsert routine");

    let active = create_routine_fire_for_policy(
        "routine-dequeue",
        &policy(RoutineConcurrencyPolicy::QueueIfActive),
    )
    .expect("active fire");
    let queued = create_routine_fire_for_policy(
        "routine-dequeue",
        &policy(RoutineConcurrencyPolicy::QueueIfActive),
    )
    .expect("queued fire");
    assert_eq!(queued.status, RoutineFireStatus::Queued);

    // Active fire still pending → nothing to dequeue.
    assert!(take_next_queued_fire("routine-dequeue")
        .expect("dequeue")
        .is_none());

    mark_routine_fire_failed(&active.id, "boom").expect("fail active");

    let promoted = take_next_queued_fire("routine-dequeue")
        .expect("dequeue")
        .expect("queued fire promoted");
    assert_eq!(promoted.id, queued.id);
    assert_eq!(promoted.status, RoutineFireStatus::Pending);

    // Promotion is one-shot.
    assert!(take_next_queued_fire("routine-dequeue")
        .expect("dequeue")
        .is_none());
}

#[test]
fn schedule_marks_round_trip_without_touching_updated_at() {
    let _sandbox = test_env::sandbox();
    let saved = upsert_routine(routine_fixture(
        "routine-marks",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");

    update_routine_schedule_marks("routine-marks", 1_750_000_000_000, Some(1_750_000_060_000))
        .expect("update marks");

    let read = read_routine("routine-marks").expect("read routine");
    assert!(read.last_evaluated_at.is_some());
    assert!(read.next_fire_at.is_some());
    assert_eq!(read.updated_at, saved.updated_at);
}

#[test]
fn unknown_fire_status_is_a_decode_error() {
    let _sandbox = test_env::sandbox();
    upsert_routine(routine_fixture(
        "routine-bad-status",
        policy(RoutineConcurrencyPolicy::CoalesceIfActive),
    ))
    .expect("upsert routine");
    let connection = conn().expect("conn");
    connection
        .execute(
            "INSERT INTO routine_fires (
                    id, routine_id, fired_at, status, session_id, agent_org_run_id,
                    work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
                    completed_at, error
                 ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
            params!["bad-fire", "routine-bad-status", now_ms(), "mystery"],
        )
        .expect("insert bad fire");

    let error = list_routine_fires("routine-bad-status").expect_err("decode should fail");
    assert!(
        error.contains("unknown routine fire status"),
        "unexpected error: {error}"
    );
}
