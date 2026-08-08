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
