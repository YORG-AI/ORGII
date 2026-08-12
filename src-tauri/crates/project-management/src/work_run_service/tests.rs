use super::*;
use crate::projects::io;
use crate::projects::types::{
    EnqueueWorkItemRunRequest, WorkItemPartialUpdate, WorkItemRunTarget, WorkItemRunTargetSnapshot,
    WorkItemRunTrigger,
};
use crate::work_service::{self, CreateWorkItemRequest};
use test_helpers::test_env;

fn seed() {
    work_service::tests_support::seed_project("demo", "project-1");
    work_service::create_project_work_item(
        "demo",
        "AAA-0001",
        &CreateWorkItemRequest {
            title: "Durable work".to_string(),
            ..Default::default()
        },
        None,
    )
    .expect("seed work item");
}

fn request(key: &str) -> EnqueueWorkItemRunRequest {
    EnqueueWorkItemRunRequest {
        project_slug: Some("demo".to_string()),
        org_id: "personal-org".to_string(),
        work_item_id: "AAA-0001".to_string(),
        trigger: WorkItemRunTrigger::Manual,
        target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::StartWorkItem {
            account_id: Some("account-1".to_string()),
            model_id: Some("model-1".to_string()),
        }),
        input: serde_json::json!({"instruction": "ship it"}),
        idempotency_key: key.to_string(),
        max_attempts: 3,
        parent_run_id: None,
    }
}

#[test]
fn standalone_run_canonicalizes_cloud_org_scope() {
    let _sandbox = test_env::sandbox();
    let org_id = "org-cloud-run";
    io::create_project_org(&crate::projects::types::CreateProjectOrgRequest {
        name: "Cloud Run Org".to_string(),
        id: Some(org_id.to_string()),
    })
    .expect("create org");
    work_service::create_standalone_work_item(
        Some(org_id),
        "WI-0001",
        &CreateWorkItemRequest {
            title: "Cloud scoped run".to_string(),
            ..Default::default()
        },
        None,
    )
    .expect("seed standalone work item");

    let run = enqueue(EnqueueWorkItemRunRequest {
        project_slug: None,
        org_id: format!("cloud:{org_id}"),
        work_item_id: "WI-0001".to_string(),
        trigger: WorkItemRunTrigger::Manual,
        target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::ResumeSession {
            session_id: "session-cloud-run".to_string(),
        }),
        input: serde_json::json!({"instruction": "ship it"}),
        idempotency_key: "manual:cloud-scope".to_string(),
        max_attempts: 3,
        parent_run_id: None,
    })
    .expect("enqueue cloud-scoped run");

    assert_eq!(run.org_id, org_id);
    assert_eq!(
        list_for_work_item(None, &format!("cloud:{org_id}"), "WI-0001", 10)
            .expect("list cloud-scoped runs")
            .len(),
        1
    );

    let lease = claim_next_dispatch("standalone-worker", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-cloud-run")
        .expect("ack");
    record_run_terminal(
        &run.id,
        Some("session-cloud-run"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("terminal");
    let item = io::read_standalone_work_item(Some(org_id), "WI-0001").expect("work item");
    assert_eq!(item.frontmatter.status, "in_review");
}

#[test]
fn enqueue_captures_immutable_work_item_context() {
    let _sandbox = test_env::sandbox();
    seed();
    let run = enqueue(request("manual:snapshot")).expect("enqueue");
    assert_eq!(
        run.target_snapshot.work_item_title.as_deref(),
        Some("Durable work")
    );
    assert_eq!(run.target_snapshot.work_item_revision, 0);

    io::update_work_item_partial(
        "demo",
        "AAA-0001",
        &WorkItemPartialUpdate {
            title: Some("Changed after enqueue".to_string()),
            ..Default::default()
        },
    )
    .expect("mutate live item");
    let stored = read(&run.id).expect("read run");
    assert_eq!(
        stored.target_snapshot.work_item_title.as_deref(),
        Some("Durable work")
    );
    assert_eq!(stored.target_snapshot.work_item_revision, 0);
}

#[test]
fn readiness_probe_tracks_durable_deadlines_without_claiming() {
    let _sandbox = test_env::sandbox();
    seed();
    assert!(!has_claimable_dispatch().expect("empty readiness"));
    assert_eq!(next_dispatch_due_at_ms().expect("empty deadline"), None);

    let before_enqueue = now_ms();
    enqueue(request("manual:readiness")).expect("enqueue");
    assert!(has_claimable_dispatch().expect("pending readiness"));
    assert!(next_dispatch_due_at_ms()
        .expect("pending deadline")
        .is_some_and(|due_at| due_at >= before_enqueue && due_at <= now_ms()));

    claim_next_dispatch("readiness-worker", 30_000)
        .expect("claim")
        .expect("lease");
    assert!(!has_claimable_dispatch().expect("leased readiness"));
    assert!(next_dispatch_due_at_ms()
        .expect("lease deadline")
        .is_some_and(|due_at| due_at > now_ms()));
}

#[test]
fn readiness_probe_never_competes_for_the_sqlite_writer_reservation() {
    let _sandbox = test_env::sandbox();
    seed();
    let mut writer = conn().expect("writer connection");
    let tx = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("reserve writer");
    // Avoid the test-only `conn()` schema idempotency pass: production schema
    // initialization is process-once, while this assertion isolates the
    // dispatcher's steady-state query under a concurrent writer.
    let reader = database::db::get_projects_connection().expect("reader connection");

    // A second IMMEDIATE transaction would block/fail here. The readiness
    // path remains a plain read and can inspect the empty queue concurrently.
    assert!(!has_claimable_dispatch_on(&reader).expect("readiness under writer"));
    tx.commit().expect("release writer");
}

#[test]
fn path_lock_serializes_runs_until_terminal_release() {
    let _sandbox = test_env::sandbox();
    seed();
    let mut first_request = request("manual:path:1");
    first_request.target_snapshot.workspace_path = Some("/tmp/org2-path-lock-test".to_string());
    let first = enqueue(first_request).expect("enqueue first");
    let mut second_request = request("manual:path:2");
    second_request.target_snapshot.workspace_path = Some("/tmp/org2-path-lock-test".to_string());
    let second = enqueue(second_request).expect("enqueue second");

    let first_lease = claim_next_dispatch("worker-1", 30_000)
        .expect("claim first")
        .expect("first lease");
    assert_eq!(first_lease.run.id, first.id);
    assert!(
        claim_next_dispatch("worker-2", 30_000)
            .expect("locked claim")
            .is_none(),
        "a second Run cannot claim the same checkout"
    );

    record_run_terminal(
        &first.id,
        Some("session-path-1"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("release path lock");
    let second_lease = claim_next_dispatch("worker-2", 30_000)
        .expect("claim second")
        .expect("second lease");
    assert_eq!(second_lease.run.id, second.id);
}

#[test]
fn enqueue_is_atomic_and_idempotent() {
    let _sandbox = test_env::sandbox();
    seed();

    let first = enqueue(request("manual:1")).expect("enqueue");
    let replay = enqueue(request("manual:1")).expect("idempotent replay");
    assert_eq!(first.id, replay.id);
    assert_eq!(first.status, WorkItemRunStatus::Queued);
    assert_eq!(first.target_snapshot.work_item_revision, 0);

    let connection = conn().expect("connection");
    let run_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM pm_work_item_runs", [], |row| {
            row.get(0)
        })
        .expect("run count");
    let dispatch_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM pm_dispatch_outbox", [], |row| {
            row.get(0)
        })
        .expect("dispatch count");
    assert_eq!(run_count, 1);
    assert_eq!(dispatch_count, 1);
}

#[test]
fn idempotency_key_rejects_different_request() {
    let _sandbox = test_env::sandbox();
    seed();
    enqueue(request("manual:1")).expect("enqueue");

    let mut conflicting = request("manual:1");
    conflicting.input = serde_json::json!({"instruction": "different"});
    let error = enqueue(conflicting).expect_err("must conflict");
    assert!(error.starts_with(error::IDEMPOTENCY_CONFLICT), "{error}");
}

#[test]
fn dispatch_claim_is_leased_and_ack_requires_matching_token() {
    let _sandbox = test_env::sandbox();
    seed();
    let run = enqueue(request("manual:1")).expect("enqueue");

    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    assert_eq!(lease.run.id, run.id);
    assert_eq!(lease.run.status, WorkItemRunStatus::Dispatching);
    assert_eq!(lease.delivery_attempt, 1);

    let stale = acknowledge_dispatch_started(&lease.dispatch_id, "wrong-token", "session-1")
        .expect_err("stale token");
    assert!(stale.starts_with(error::STALE_LEASE), "{stale}");

    let started = acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-1")
        .expect("ack");
    assert_eq!(started.status, WorkItemRunStatus::Running);
    assert_eq!(started.session_id.as_deref(), Some("session-1"));
    assert!(claim_next_dispatch("desktop-1", 30_000)
        .expect("empty claim")
        .is_none());
}

#[test]
fn latest_for_session_returns_attached_execution_episode() {
    let _sandbox = test_env::sandbox();
    seed();
    let run = enqueue(request("manual:session-latest")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-latest")
        .expect("ack");

    let latest = latest_for_session("session-latest")
        .expect("lookup")
        .expect("attached run");
    assert_eq!(latest.id, run.id);
    assert!(latest_for_session("missing-session")
        .expect("missing lookup")
        .is_none());
}

#[test]
fn active_session_runs_exclude_queued_and_terminal_episodes() {
    let _sandbox = test_env::sandbox();
    seed();
    let queued = enqueue(request("manual:active-queued")).expect("enqueue queued");
    let active = enqueue(request("manual:active-running")).expect("enqueue active");
    let terminal = enqueue(request("manual:active-terminal")).expect("enqueue terminal");

    let first = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim first")
        .expect("first dispatch");
    assert_eq!(first.run.id, queued.id);
    acknowledge_dispatch_started(&first.dispatch_id, &first.lease_token, "session-queued")
        .expect("ack first");
    record_run_terminal(
        &queued.id,
        Some("session-queued"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("finish first");

    let second = claim_next_dispatch("desktop-2", 30_000)
        .expect("claim second")
        .expect("second dispatch");
    assert_eq!(second.run.id, active.id);
    acknowledge_dispatch_started(&second.dispatch_id, &second.lease_token, "session-active")
        .expect("ack second");

    let runs = list_active_session_runs().expect("list active session runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, active.id);
    assert_ne!(runs[0].id, terminal.id);
}

#[test]
fn inline_dispatch_reserves_exact_run_without_racing_background_worker() {
    let _sandbox = test_env::sandbox();
    seed();
    let run = enqueue_for_inline_dispatch(request("manual:inline")).expect("enqueue inline");

    assert!(
        claim_next_dispatch("background-worker", 30_000)
            .expect("background claim")
            .is_none(),
        "future availability must reserve the Run for its inline caller"
    );

    let lease = claim_dispatch_for_run(&run.id, "inline-worker", 30_000).expect("claim exact Run");
    assert_eq!(lease.run.id, run.id);
    assert_eq!(lease.lease_owner, "inline-worker");
    let started =
        acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-inline")
            .expect("ack inline");
    assert_eq!(started.status, WorkItemRunStatus::Running);
    assert_eq!(started.session_id.as_deref(), Some("session-inline"));
}

#[test]
fn transient_dispatch_failure_defers_but_auth_failure_dead_letters() {
    let _sandbox = test_env::sandbox();
    seed();
    let transient = enqueue(request("manual:network")).expect("enqueue transient");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    assert_eq!(lease.run.id, transient.id);
    let deferred = record_dispatch_failure(
        &lease.dispatch_id,
        &lease.lease_token,
        "network connection reset",
    )
    .expect("record transient failure");
    assert_eq!(deferred.status, WorkItemRunStatus::Deferred);
    assert_eq!(
        deferred.failure.as_ref().map(|failure| failure.class),
        Some(WorkItemRunFailureClass::TransientNetwork)
    );

    let permanent = enqueue(request("manual:auth")).expect("enqueue permanent");
    let lease = claim_next_dispatch("desktop-2", 30_000)
        .expect("claim")
        .expect("dispatch");
    assert_eq!(lease.run.id, permanent.id);
    let failed = record_dispatch_failure(
        &lease.dispatch_id,
        &lease.lease_token,
        "Unauthorized: invalid API key (status 401)",
    )
    .expect("record permanent failure");
    assert_eq!(failed.status, WorkItemRunStatus::Failed);
    assert!(!failed.failure.expect("typed failure").retryable);
}

#[test]
fn session_terminal_moves_work_item_to_review_without_completing_it() {
    let _sandbox = test_env::sandbox();
    seed();
    let queued = enqueue(request("manual:1")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-1").expect("ack");

    let terminal = record_session_terminal(
        "session-1",
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage {
            total_tokens: 4321,
            cost_usd: 0.25,
            ..Default::default()
        },
        None,
    )
    .expect("terminal")
    .expect("owned session");
    assert_eq!(terminal.id, queued.id);
    assert_eq!(terminal.status, WorkItemRunStatus::Succeeded);
    assert_eq!(terminal.usage.total_tokens, 4321);

    let item = io::read_work_item("demo", "AAA-0001").expect("work item");
    assert_eq!(item.frontmatter.status, "in_review");
}

#[test]
fn failed_run_does_not_request_review() {
    let _sandbox = test_env::sandbox();
    seed();
    let queued = enqueue(request("manual:failed-review")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(
        &lease.dispatch_id,
        &lease.lease_token,
        "session-failed-review",
    )
    .expect("ack");

    record_run_terminal(
        &queued.id,
        Some("session-failed-review"),
        WorkItemRunTerminalOutcome::Failed,
        WorkItemRunUsage::default(),
        Some("provider failed"),
    )
    .expect("terminal");

    let item = io::read_work_item("demo", "AAA-0001").expect("work item");
    assert_eq!(item.frontmatter.status, "backlog");
}

#[test]
fn succeeded_run_preserves_explicitly_completed_work_item() {
    let _sandbox = test_env::sandbox();
    seed();
    work_service::transition_project_work_item("demo", "AAA-0001", "in_progress", None, None, None)
        .expect("start work");
    work_service::transition_project_work_item("demo", "AAA-0001", "completed", None, None, None)
        .expect("complete explicitly");

    let queued = enqueue(request("manual:completed-preserved")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(
        &lease.dispatch_id,
        &lease.lease_token,
        "session-completed-preserved",
    )
    .expect("ack");
    record_run_terminal(
        &queued.id,
        Some("session-completed-preserved"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("terminal");

    let item = io::read_work_item("demo", "AAA-0001").expect("work item");
    assert_eq!(item.frontmatter.status, "completed");
}

#[test]
fn stale_succeeded_run_does_not_override_a_newer_execution_claim() {
    let _sandbox = test_env::sandbox();
    seed();
    work_service::claim_project_work_item(
        "demo",
        "AAA-0001",
        "session-newer",
        Some("coding"),
        crate::projects::types::WorkItemExecutionLockReason::ManualStart,
        None,
        None,
    )
    .expect("newer claim");

    let queued = enqueue(request("manual:stale-success")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-older")
        .expect("ack");
    record_run_terminal(
        &queued.id,
        Some("session-older"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("terminal");

    let item = io::read_work_item("demo", "AAA-0001").expect("work item");
    assert_eq!(item.frontmatter.status, "in_progress");
    assert_eq!(
        item.frontmatter
            .execution_lock
            .and_then(|lock| lock.active_session_id)
            .as_deref(),
        Some("session-newer")
    );
}

#[test]
fn duplicate_terminal_does_not_reapply_review_after_human_reopens_work() {
    let _sandbox = test_env::sandbox();
    seed();
    let queued = enqueue(request("manual:terminal-replay")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-replay")
        .expect("ack");
    record_run_terminal(
        &queued.id,
        Some("session-replay"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("terminal");
    work_service::transition_project_work_item(
        "demo",
        "AAA-0001",
        "in_progress",
        Some("changes requested"),
        None,
        None,
    )
    .expect("human reopens work");

    record_run_terminal(
        &queued.id,
        Some("session-replay"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage::default(),
        None,
    )
    .expect("duplicate terminal");

    let item = io::read_work_item("demo", "AAA-0001").expect("work item");
    assert_eq!(item.frontmatter.status, "in_progress");
}

#[test]
fn turn_can_finish_before_dispatch_ack_without_losing_finality() {
    let _sandbox = test_env::sandbox();
    seed();
    let queued = enqueue(request("manual:fast-turn")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");

    let terminal = record_run_terminal(
        &queued.id,
        Some("session-fast"),
        WorkItemRunTerminalOutcome::Succeeded,
        WorkItemRunUsage {
            total_tokens: 99,
            ..Default::default()
        },
        None,
    )
    .expect("terminal before ack");
    assert_eq!(terminal.status, WorkItemRunStatus::Succeeded);
    assert_eq!(terminal.session_id.as_deref(), Some("session-fast"));

    let acknowledged =
        acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-fast")
            .expect("terminal ack is idempotent");
    assert_eq!(acknowledged.status, WorkItemRunStatus::Succeeded);
    assert_eq!(acknowledged.usage.total_tokens, 99);
}

#[test]
fn consumer_cursor_is_initialized_once_and_only_moves_forward() {
    let _sandbox = test_env::sandbox();
    seed();

    assert_eq!(
        initialize_consumer_cursor("stage-barrier-test", 12).expect("initialize"),
        12
    );
    assert_eq!(
        initialize_consumer_cursor("stage-barrier-test", 99).expect("reinitialize"),
        12,
        "restart must keep the persisted cursor"
    );
    assert_eq!(
        advance_consumer_cursor("stage-barrier-test", 20).expect("advance"),
        20
    );
    assert_eq!(
        advance_consumer_cursor("stage-barrier-test", 15).expect("stale advance"),
        20
    );
}

#[test]
fn typed_retry_creates_a_new_run_episode_and_resumes_session() {
    let _sandbox = test_env::sandbox();
    seed();
    let first = enqueue(request("manual:retry-source")).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-retry")
        .expect("ack");
    record_run_terminal(
        &first.id,
        Some("session-retry"),
        WorkItemRunTerminalOutcome::Failed,
        WorkItemRunUsage::default(),
        Some("request timed out"),
    )
    .expect("failed terminal");

    let retried = retry(&first.id, "retry:1").expect("typed retry");
    assert_ne!(retried.id, first.id);
    assert_eq!(retried.parent_run_id.as_deref(), Some(first.id.as_str()));
    assert_eq!(retried.attempt, 2);
    assert_eq!(
        retried.target_snapshot.target,
        WorkItemRunTarget::ResumeSession {
            session_id: "session-retry".to_string()
        }
    );
}

#[test]
fn retry_ancestry_preserves_routine_origin() {
    let _sandbox = test_env::sandbox();
    seed();
    let mut routine_request = request("routine:retry-origin");
    routine_request.trigger = WorkItemRunTrigger::Routine {
        routine_id: "routine-origin".to_string(),
        fire_id: "fire-origin".to_string(),
    };
    let first = enqueue(routine_request).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-origin")
        .expect("ack");
    record_run_terminal(
        &first.id,
        Some("session-origin"),
        WorkItemRunTerminalOutcome::Failed,
        WorkItemRunUsage::default(),
        Some("request timed out"),
    )
    .expect("failed terminal");
    let retried = retry(&first.id, "retry:routine-origin").expect("retry");

    assert_eq!(
        routine_origin(&retried.id).expect("resolve origin"),
        Some(("routine-origin".to_string(), "fire-origin".to_string()))
    );
}

#[test]
fn typed_retry_refuses_an_exhausted_attempt_budget() {
    let _sandbox = test_env::sandbox();
    seed();
    let mut exhausted_request = request("manual:retry-exhausted");
    exhausted_request.max_attempts = 1;
    let first = enqueue(exhausted_request).expect("enqueue");
    let lease = claim_next_dispatch("desktop-1", 30_000)
        .expect("claim")
        .expect("dispatch");
    acknowledge_dispatch_started(&lease.dispatch_id, &lease.lease_token, "session-exhausted")
        .expect("ack");
    record_run_terminal(
        &first.id,
        Some("session-exhausted"),
        WorkItemRunTerminalOutcome::Failed,
        WorkItemRunUsage::default(),
        Some("request timed out"),
    )
    .expect("failed terminal");

    let error = retry(&first.id, "retry:exhausted").expect_err("budget must reject retry");
    assert!(error.starts_with(error::RETRY_NOT_ALLOWED), "{error}");
    assert!(error.contains("exhausted attempt budget"), "{error}");
}

#[test]
fn failure_classifier_is_conservative_and_typed() {
    let timeout = classify_failure("request timed out", true);
    assert_eq!(timeout.class, WorkItemRunFailureClass::Timeout);
    assert!(timeout.retryable);
    assert_eq!(
        timeout.retry_disposition,
        WorkItemRunRetryDisposition::ResumeSession
    );

    let quota = classify_failure("status 429: quota exceeded", true);
    assert_eq!(quota.class, WorkItemRunFailureClass::Quota);
    assert!(!quota.retryable);

    let unknown = classify_failure("something surprising", false);
    assert_eq!(unknown.class, WorkItemRunFailureClass::Unknown);
    assert!(!unknown.retryable);
}
