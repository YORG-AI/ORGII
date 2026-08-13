//! Tests for the workitem-extras-backed orchestrator read paths.
//!
//! The fix replaces a parallel SQLite mirror in `orchestrator_runs`
//! with `json_extract`-based queries over `workitem_extras`. These
//! tests lock down the four invariants the orchestrator command and
//! recovery layers rely on:
//!
//! 1. `read_orchestrator_state` returns `Ok(None)` for a fresh work
//!    item but `Err` for a missing one.
//! 2. `read_linked_sessions` round-trips the same vec that
//!    `update_work_item_atomic` writes.
//! 3. `list_interrupted_work_items` finds rows matching either
//!    `interrupted == true` or `current_phase IN (coding, review)`.
//! 4. `mark_work_items_interrupted` flips `interrupted` to true and
//!    snapshots `interrupted_phase`, but only on rows that are not
//!    already interrupted.

use super::*;
use crate::projects::io::projects::write_project;
use crate::projects::io::work_items::{read_work_item, update_work_item_atomic, write_work_item};
use crate::projects::types::{
    AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType, OrchestratorPhase,
    OrchestratorState, ProjectMeta, WorkItemFrontmatter,
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
        origin_session: None,
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

fn seed_project(slug: &str, project_id: &str) {
    write_project(slug, &project_fixture(project_id, "Demo"), "", true).expect("project");
}

fn seed_work_item(slug: &str, id: &str, short_id: &str, title: &str) {
    let fm = work_item_fixture(id, short_id, title);
    write_work_item(slug, short_id, &fm, "").expect("seed work item");
}

fn sample_session(id: &str, role: AgentRole) -> LinkedSession {
    LinkedSession {
        session_id: id.to_string(),
        session_type: LinkedSessionType::Native,
        agent_role: role,
        started_at: "2025-01-01T00:00:00Z".to_string(),
        completed_at: None,
        status: LinkedSessionStatus::Running,
        cost_usd: 0.0,
        total_tokens: 0,
        parent_session_id: None,
        sub_agent_name: None,
        sub_agent_instance: None,
        result_preview: None,
    }
}

#[test]
fn read_orchestrator_state_returns_none_for_unconfigured_item() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    seed_work_item("demo", "w1", "AAA-0001", "Untouched");

    let state = read_orchestrator_state("demo", "AAA-0001").expect("read should succeed");
    assert!(
        state.is_none(),
        "fresh work item should not have orchestrator state, got {:?}",
        state
    );
}

#[test]
fn read_orchestrator_state_errors_when_work_item_missing() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");

    let err =
        read_orchestrator_state("demo", "AAA-0099").expect_err("missing work item should error");
    assert!(
        err.contains("AAA-0099"),
        "error should reference the missing short_id, got: {}",
        err
    );
}

#[test]
fn read_orchestrator_state_round_trips_after_atomic_write() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    seed_work_item("demo", "w1", "AAA-0001", "Coding");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Coding,
            retry_count: 2,
            review_round: 0,
            interrupted: false,
            interrupted_phase: None,
            last_failure: None,
            active_config: None,
        });
        Ok::<(), String>(())
    })
    .expect("seed orchestrator state");

    let state = read_orchestrator_state("demo", "AAA-0001")
        .expect("read")
        .expect("state present");
    assert_eq!(state.current_phase, OrchestratorPhase::Coding);
    assert_eq!(state.retry_count, 2);
    assert!(!state.interrupted);
}

#[test]
fn read_linked_sessions_round_trips_after_atomic_write() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    seed_work_item("demo", "w1", "AAA-0001", "Sessions");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.linked_sessions = vec![
            sample_session("s-coding", AgentRole::Coding),
            sample_session("s-review", AgentRole::Review),
        ];
        Ok::<(), String>(())
    })
    .expect("seed linked sessions");

    let sessions = read_linked_sessions("demo", "AAA-0001").expect("read sessions");
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].session_id, "s-coding");
    assert_eq!(sessions[1].agent_role, AgentRole::Review);
}

#[test]
fn list_interrupted_work_items_picks_up_interrupted_flag() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    seed_work_item("demo", "w1", "AAA-0001", "Crashed");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Coding,
            interrupted: true,
            interrupted_phase: Some(OrchestratorPhase::Coding),
            ..Default::default()
        });
        Ok::<(), String>(())
    })
    .expect("seed");

    let rows = list_interrupted_work_items().expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].short_id, "AAA-0001");
    assert_eq!(rows[0].interrupted_phase, "coding");
}

#[test]
fn list_interrupted_work_items_picks_up_active_phase_fallback() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    seed_work_item("demo", "w1", "AAA-0001", "Active coding");
    seed_work_item("demo", "w2", "AAA-0002", "Active review");
    seed_work_item("demo", "w3", "AAA-0003", "Idle");
    seed_work_item("demo", "w4", "AAA-0004", "Completed");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Coding,
            ..Default::default()
        });
        Ok::<(), String>(())
    })
    .unwrap();
    update_work_item_atomic("demo", "AAA-0002", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Review,
            ..Default::default()
        });
        Ok::<(), String>(())
    })
    .unwrap();
    update_work_item_atomic("demo", "AAA-0004", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Completed,
            ..Default::default()
        });
        Ok::<(), String>(())
    })
    .unwrap();

    let rows = list_interrupted_work_items().expect("list");
    let mut short_ids: Vec<String> = rows.iter().map(|r| r.short_id.clone()).collect();
    short_ids.sort();
    assert_eq!(
        short_ids,
        vec!["AAA-0001".to_string(), "AAA-0002".to_string()],
        "only coding/review phases should be flagged"
    );
}

#[test]
fn mark_work_items_interrupted_flips_only_uninterrupted_rows() {
    let _sandbox = test_env::sandbox();
    seed_project("demo", "p1");
    seed_work_item("demo", "w1", "AAA-0001", "Will-flip");
    seed_work_item("demo", "w2", "AAA-0002", "Already-flipped");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Coding,
            ..Default::default()
        });
        Ok::<(), String>(())
    })
    .unwrap();
    update_work_item_atomic("demo", "AAA-0002", |fm, _body| {
        fm.orchestrator_state = Some(OrchestratorState {
            current_phase: OrchestratorPhase::Review,
            interrupted: true,
            interrupted_phase: Some(OrchestratorPhase::Review),
            ..Default::default()
        });
        Ok::<(), String>(())
    })
    .unwrap();

    let updated = mark_work_items_interrupted(&[
        ("demo".to_string(), "AAA-0001".to_string()),
        ("demo".to_string(), "AAA-0002".to_string()),
    ])
    .expect("mark");

    assert_eq!(
        updated, 1,
        "only AAA-0001 should flip; AAA-0002 was already interrupted"
    );

    let s1 = read_work_item("demo", "AAA-0001").unwrap();
    let st1 = s1.frontmatter.orchestrator_state.expect("state");
    assert!(st1.interrupted);
    assert_eq!(st1.interrupted_phase, Some(OrchestratorPhase::Coding));

    let s2 = read_work_item("demo", "AAA-0002").unwrap();
    let st2 = s2.frontmatter.orchestrator_state.expect("state");
    assert!(st2.interrupted, "already-interrupted flag should remain");
}

#[test]
fn mark_work_items_interrupted_empty_set_is_noop() {
    let _sandbox = test_env::sandbox();
    let updated = mark_work_items_interrupted(&[]).expect("noop");
    assert_eq!(updated, 0);
}
