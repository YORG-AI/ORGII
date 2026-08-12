//! Integration tests for the work application service (Phase 2a):
//! strict FSM transitions, optimistic concurrency, and the audit +
//! `pm_change_seq` trail emitted by the atomic choke point.

use super::*;
use crate::projects::io::helpers::conn;
use crate::projects::io::{
    acquire_execution_lock, read_work_item, update_work_item_partial, write_project,
    write_work_item,
};
use crate::projects::types::{
    ProjectMeta, WorkItemExecutionLockReason, WorkItemFrontmatter, WorkItemPartialUpdate,
};
use test_helpers::test_env;

fn project_fixture(id: &str, name: &str) -> ProjectMeta {
    ProjectMeta {
        id: id.to_string(),
        name: name.to_string(),
        org_id: "personal-org".to_string(),
        status: "active".to_string(),
        priority: "none".to_string(),
        health: "no_updates".to_string(),
        lead: None,
        members: vec![],
        labels: vec![],
        linked_repos: vec![],
        start_date: None,
        target_date: None,
        created_at: String::new(),
        updated_at: String::new(),
        next_work_item_id: 1,
        work_item_prefix: "AAA".to_string(),
        work_item_prefix_custom: true,
        agent_defaults: None,
    }
}

fn work_item_fixture(id: &str, short_id: &str, title: &str) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: id.to_string(),
        short_id: short_id.to_string(),
        title: title.to_string(),
        project: None,
        status: "backlog".to_string(),
        priority: "none".to_string(),
        assignee: None,
        assignee_type: None,
        labels: vec![],
        milestone: None,
        parent: None,
        stage: None,
        start_date: None,
        target_date: None,
        created_by: None,
        created_at: String::new(),
        updated_at: String::new(),
        deleted_at: None,
        starred: false,
        todos: vec![],
        comments: vec![],
        history: vec![],
        delegations: vec![],
        linked_sessions: vec![],
        handoff: None,
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

fn seed(slug: &str, project_id: &str) {
    write_project(slug, &project_fixture(project_id, "Demo"), "", true).expect("project");
    let fm = work_item_fixture("w1", "AAA-0001", "Initial");
    write_work_item(slug, "AAA-0001", &fm, "body v1").expect("seed work item");
}

fn change_seq() -> i64 {
    conn()
        .expect("conn")
        .query_row("SELECT seq FROM pm_change_seq WHERE id = 1", [], |row| {
            row.get(0)
        })
        .expect("pm_change_seq row")
}

fn last_audit_row() -> (String, i64, String) {
    conn()
        .expect("conn")
        .query_row(
            "SELECT operation, revision, payload_json FROM pm_audit_events
             ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("audit row")
}

#[test]
fn strict_transition_rejects_illegal_portable_edge() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    // backlog maps to open; open -> completed skips the claim edge.
    let err = transition_project_work_item("demo", "AAA-0001", "completed", None, None, None)
        .expect_err("must reject");
    assert!(
        err.starts_with(error::INVALID_TRANSITION),
        "unexpected error: {err}"
    );

    let unchanged = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(unchanged.frontmatter.status, "backlog");
}

#[test]
fn strict_transition_applies_and_audits_legal_edge() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    let seq_before = change_seq();

    let data = transition_project_work_item(
        "demo",
        "AAA-0001",
        "in_progress",
        Some("starting work"),
        None,
        Some(0),
    )
    .expect("legal transition");
    assert_eq!(data.frontmatter.status, "in_progress");

    assert_eq!(change_seq(), seq_before + 1, "watermark bumps per mutation");
    let (operation, revision, payload_json) = last_audit_row();
    assert_eq!(operation, "work.transition");
    assert_eq!(revision, 1);
    let payload: serde_json::Value = serde_json::from_str(&payload_json).expect("payload json");
    assert_eq!(payload["status_from"], "backlog");
    assert_eq!(payload["status_to"], "in_progress");
    assert_eq!(payload["reason"], "starting work");
    assert!(payload.get("fsm_violation").is_none());
}

#[test]
fn expected_revision_mismatch_is_a_typed_conflict() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let err = transition_project_work_item("demo", "AAA-0001", "in_progress", None, None, Some(7))
        .expect_err("stale revision must conflict");
    assert!(
        err.starts_with(error::REVISION_CONFLICT),
        "unexpected error: {err}"
    );
    assert!(err.ends_with(":7:0"), "carries expected/current: {err}");

    let unchanged = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(unchanged.frontmatter.status, "backlog");
}

#[test]
fn release_to_open_clears_execution_lock() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    transition_project_work_item("demo", "AAA-0001", "in_progress", None, None, None)
        .expect("claim edge");
    acquire_execution_lock(
        "demo",
        "AAA-0001",
        "session-1",
        Some("coding"),
        WorkItemExecutionLockReason::ManualStart,
    )
    .expect("lock");
    let locked = read_work_item("demo", "AAA-0001").expect("read");
    assert!(locked.frontmatter.execution_lock.is_some());

    // in_progress -> backlog maps to the in_progress -> open release edge.
    let released = transition_project_work_item(
        "demo",
        "AAA-0001",
        "backlog",
        Some("agent died"),
        None,
        None,
    )
    .expect("release");
    assert_eq!(released.frontmatter.status, "backlog");
    assert!(
        released.frontmatter.execution_lock.is_none(),
        "release edge must clear the claim record"
    );
}

#[test]
fn legacy_paths_flag_violations_without_blocking() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    // The legacy partial-update path (UI board drag) skips the claim
    // edge; it must keep working but leave an audited violation flag.
    let updates = WorkItemPartialUpdate {
        status: Some("completed".to_string()),
        ..Default::default()
    };
    update_work_item_partial("demo", "AAA-0001", &updates).expect("legacy path stays fail-open");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(after.frontmatter.status, "completed");
    let (operation, _, payload_json) = last_audit_row();
    assert_eq!(operation, "work.patch");
    let payload: serde_json::Value = serde_json::from_str(&payload_json).expect("payload json");
    assert!(
        payload.get("fsm_violation").is_some(),
        "violation must be visible in the audit stream: {payload}"
    );
}

#[test]
fn create_refuses_to_overwrite_an_existing_id_in_any_scope() {
    let _sandbox = test_env::sandbox();
    tests_support::seed_project("demo", "p1");

    let first = CreateWorkItemRequest {
        title: "First".to_string(),
        ..Default::default()
    };
    create_project_work_item("demo", "AAA-0001", &first, None).expect("first create");

    let clobber = CreateWorkItemRequest {
        title: "Second".to_string(),
        ..Default::default()
    };
    let same_scope =
        create_project_work_item("demo", "AAA-0001", &clobber, None).expect_err("must refuse");
    assert!(
        same_scope.starts_with(error::ALREADY_EXISTS),
        "{same_scope}"
    );

    let cross_scope = create_standalone_work_item(None, "AAA-0001", &clobber, None)
        .expect_err("cross-scope must refuse");
    assert!(
        cross_scope.starts_with(error::ALREADY_EXISTS),
        "{cross_scope}"
    );

    let survivor = read_work_item("demo", "AAA-0001").expect("survivor");
    assert_eq!(survivor.frontmatter.title, "First");
}

#[test]
fn claim_with_expected_revision_succeeds_in_one_transaction() {
    let _sandbox = test_env::sandbox();
    tests_support::seed_project("demo", "p1");
    let request = CreateWorkItemRequest {
        title: "Claimable".to_string(),
        status: Some("open".to_string()),
        ..Default::default()
    };
    create_project_work_item("demo", "AAA-0001", &request, None).expect("create");
    let revision = read_project_work_item_revision("demo", "AAA-0001").expect("revision");

    let claimed = claim_project_work_item(
        "demo",
        "AAA-0001",
        "session-1",
        Some("custom"),
        crate::projects::types::WorkItemExecutionLockReason::ManualStart,
        None,
        Some(revision),
    )
    .expect("claim with the observed revision must succeed");
    assert_eq!(claimed.frontmatter.status, "in_progress");
    assert_eq!(
        claimed
            .frontmatter
            .execution_lock
            .as_ref()
            .and_then(|lock| lock.active_session_id.as_deref()),
        Some("session-1")
    );

    let reclaimed = claim_project_work_item(
        "demo",
        "AAA-0001",
        "session-1",
        Some("custom"),
        crate::projects::types::WorkItemExecutionLockReason::FollowUp,
        None,
        None,
    )
    .expect("the active session may resume its own claim");
    assert_eq!(
        reclaimed
            .frontmatter
            .linked_sessions
            .iter()
            .filter(|linked| linked.session_id == "session-1")
            .count(),
        1,
        "resuming one durable session must not append a duplicate run"
    );

    let contended = claim_project_work_item(
        "demo",
        "AAA-0001",
        "session-2",
        Some("custom"),
        crate::projects::types::WorkItemExecutionLockReason::ManualStart,
        None,
        None,
    )
    .expect_err("second session must lose the claim");
    assert!(
        contended.contains("active execution session"),
        "{contended}"
    );

    let stale = claim_project_work_item(
        "demo",
        "AAA-0001",
        "session-1",
        Some("custom"),
        crate::projects::types::WorkItemExecutionLockReason::ManualStart,
        None,
        Some(revision),
    )
    .expect_err("stale revision must conflict");
    assert!(stale.starts_with(error::REVISION_CONFLICT), "{stale}");
}

#[test]
fn run_idempotent_concurrent_same_key_executes_exactly_once() {
    let _sandbox = test_env::sandbox();
    tests_support::seed_project("demo", "p1");
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let executions = Arc::new(AtomicUsize::new(0));
    let request = serde_json::json!({"op": "probe"});

    let spawn_call = |executions: Arc<AtomicUsize>, request: serde_json::Value| {
        std::thread::spawn(move || {
            run_idempotent("actor", "work.probe", "demo", "k1", &request, move || {
                executions.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(300));
                Ok(serde_json::json!({"made": true}))
            })
        })
    };

    let a = spawn_call(executions.clone(), request.clone());
    let b = spawn_call(executions.clone(), request.clone());
    let ra = a.join().expect("thread a").expect("outcome a");
    let rb = b.join().expect("thread b").expect("outcome b");

    assert_eq!(
        executions.load(Ordering::SeqCst),
        1,
        "exactly one execution"
    );
    let fresh = matches!(ra, IdempotencyOutcome::Fresh(_)) as u8
        + matches!(rb, IdempotencyOutcome::Fresh(_)) as u8;
    assert_eq!(fresh, 1, "one fresh, one replayed");
    for outcome in [ra, rb] {
        let value = match outcome {
            IdempotencyOutcome::Fresh(v) | IdempotencyOutcome::Replayed(v) => v,
        };
        assert_eq!(value["made"], true);
    }
}

#[test]
fn noted_by_actor_since_sees_only_matching_note_rows() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    // Production items carry id == short_id; audit rows key entity_id on
    // the item id, which the receipt-fallback check queries by short id.
    let fm = work_item_fixture("AAA-0002", "AAA-0002", "Receipt probe");
    write_work_item("demo", "AAA-0002", &fm, "body").expect("seed probe item");
    let actor = crate::projects::types::WorkItemMutationActor {
        id: "agent:os".to_string(),
        name: "os".to_string(),
    };
    let before_ms = chrono::Utc::now().timestamp_millis() - 1;

    assert!(!work_item_noted_by_actor_since("AAA-0002", "agent:os", before_ms).expect("query"));

    // A non-note mutation by the same actor must not satisfy the check.
    transition_project_work_item("demo", "AAA-0002", "in_progress", None, Some(&actor), None)
        .expect("transition");
    assert!(!work_item_noted_by_actor_since("AAA-0002", "agent:os", before_ms).expect("query"));

    note_project_work_item("demo", "AAA-0002", "progress", "half way", Some(&actor)).expect("note");
    assert!(work_item_noted_by_actor_since("AAA-0002", "agent:os", before_ms).expect("query"));

    // Different actor and a window after the write both miss.
    assert!(!work_item_noted_by_actor_since("AAA-0002", "agent:sde", before_ms).expect("query"));
    let after_ms = chrono::Utc::now().timestamp_millis() + 1;
    assert!(!work_item_noted_by_actor_since("AAA-0002", "agent:os", after_ms).expect("query"));
}

#[test]
fn durable_note_id_makes_stage_replay_idempotent() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    let actor = crate::projects::types::WorkItemMutationActor {
        id: "system".to_string(),
        name: "System".to_string(),
    };

    note_project_work_item_idempotent(
        "demo",
        "AAA-0001",
        "note-stage-stable",
        "progress",
        "Stage 1 settled",
        Some(&actor),
    )
    .expect("first note");
    note_project_work_item_idempotent(
        "demo",
        "AAA-0001",
        "note-stage-stable",
        "progress",
        "Stage 1 settled",
        Some(&actor),
    )
    .expect("replayed note");

    let item = read_work_item("demo", "AAA-0001").expect("read");
    let matching: Vec<_> = item
        .frontmatter
        .comments
        .iter()
        .filter(|comment| comment.id == "note-stage-stable")
        .collect();
    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0].content, "[progress] Stage 1 settled");
}

#[test]
fn root_bootstrap_is_idempotent_and_falls_back_to_personal_scope() {
    let _sandbox = test_env::sandbox();

    let first = bootstrap_root_standalone_item(
        "cliagent-boot-1",
        Some("cloud:no-such-org"),
        "Ship the export flow\nwith full history",
    )
    .expect("bootstrap");
    let replay = bootstrap_root_standalone_item(
        "cliagent-boot-1",
        Some("cloud:no-such-org"),
        "different retry content",
    )
    .expect("replayed bootstrap");
    assert_eq!(first, replay, "same session must replay the same root");

    let item = crate::projects::io::read_standalone_work_item(None, &first).expect("read root");
    assert_eq!(item.frontmatter.title, "Ship the export flow");
    assert!(item.body.contains("with full history"));

    let other = bootstrap_root_standalone_item("cliagent-boot-2", None, "Second session root")
        .expect("bootstrap 2");
    assert_ne!(first, other, "distinct sessions get distinct roots");
}

#[test]
fn standalone_note_audits_as_work_note() {
    let _sandbox = test_env::sandbox();
    let fm = work_item_fixture("SA-0001", "SA-0001", "Standalone receipt probe");
    crate::projects::io::write_standalone_work_item(None, "SA-0001", &fm, "body")
        .expect("seed standalone item");
    let actor = crate::projects::types::WorkItemMutationActor {
        id: "agent:os".to_string(),
        name: "os".to_string(),
    };
    let before_ms = chrono::Utc::now().timestamp_millis() - 1;

    note_standalone_work_item(None, "SA-0001", "progress", "receipt", Some(&actor)).expect("note");

    // Standalone notes must stamp the canonical `work.note` operation —
    // the receipt-fallback dedup query depends on it (a `work.patch`
    // label made the fallback double-post on standalone items).
    let (operation, _, _) = last_audit_row();
    assert_eq!(operation, "work.note");
    assert!(work_item_noted_by_actor_since("SA-0001", "agent:os", before_ms).expect("query"));
}
