//! Agent Session Statistics Tests
//!
//! Tests `compute_aggregate_stats` across diverse session sets.
//!
//! ## Coverage
//! - Empty session list → zero stats
//! - All sessions active → active count matches total
//! - All sessions completed → completed count matches total
//! - All sessions failed → failed count matches total
//! - Mixed sessions → each bucket is counted independently
//! - Token accumulation: simple, large, zero-token sessions
//! - Cost estimation sanity: non-negative, proportional to tokens
//! - Sessions spanning multiple categories (CLI + Agent + OS)
//! - Single session edge case

use crate::agent_sessions::unified_stats::display::generate_display_label;
use crate::agent_sessions::unified_stats::stats::compute_aggregate_stats;
use crate::agent_sessions::unified_stats::status::is_active_status;
use crate::agent_sessions::unified_stats::types::{SessionAggregateRecord, SessionCategory};
use core_types::key_source::KeySource;

// ============================================================================
// Helpers
// ============================================================================

fn make_session(
    id: &str,
    status: &str,
    tokens: i64,
    category: SessionCategory,
) -> SessionAggregateRecord {
    let name = format!("Session {id}");
    SessionAggregateRecord {
        session_id: id.to_string(),
        name: name.clone(),
        status: status.to_string(),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T01:00:00Z".to_string(),
        category,
        external_history_source: None,
        user_input: None,
        repo_path: None,
        storage_path: None,
        repo_name: None,
        branch: None,
        model: None,
        account_id: None,
        cli_agent_type: None,
        key_source: KeySource::OwnKey,
        tier: None,
        pid: None,
        total_tokens: tokens,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: false,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
        is_active: is_active_status(status),
        display_label: generate_display_label(&name, None),
        parent_session_id: None,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: None,
        agent_exec_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: false,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        touched_files: None,
        channel: None,
    }
}

// ============================================================================
// Empty
// ============================================================================

#[test]
fn empty_sessions_returns_zero_stats() {
    let stats = compute_aggregate_stats(&[]);
    assert_eq!(stats.total_tokens, 0);
    assert_eq!(stats.ongoing_count, 0);
    assert_eq!(stats.completed_count, 0);
    assert_eq!(stats.failed_count, 0);
    assert_eq!(stats.total_cost_usd, 0.0);
}

// ============================================================================
// Single session
// ============================================================================

#[test]
fn single_running_session() {
    let sessions = vec![make_session("s1", "running", 500, SessionCategory::Cli)];
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 1);
    assert_eq!(stats.completed_count, 0);
    assert_eq!(stats.failed_count, 0);
    assert_eq!(stats.total_tokens, 500);
}

#[test]
fn single_completed_session() {
    let sessions = vec![make_session(
        "s1",
        "completed",
        2000,
        SessionCategory::Agent,
    )];
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 0);
    assert_eq!(stats.completed_count, 1);
    assert_eq!(stats.failed_count, 0);
    assert_eq!(stats.total_tokens, 2000);
}

#[test]
fn single_failed_session() {
    let sessions = vec![make_session("s1", "failed", 300, SessionCategory::Os)];
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 0);
    assert_eq!(stats.completed_count, 0);
    assert_eq!(stats.failed_count, 1);
}

// ============================================================================
// All same status
// ============================================================================

#[test]
fn all_active_sessions() {
    let sessions: Vec<_> = (0..5)
        .map(|i| make_session(&format!("a{i}"), "running", 100, SessionCategory::Cli))
        .collect();
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 5);
    assert_eq!(stats.completed_count, 0);
    assert_eq!(stats.failed_count, 0);
    assert_eq!(stats.total_tokens, 500);
}

#[test]
fn all_completed_sessions() {
    let sessions: Vec<_> = (0..8)
        .map(|i| make_session(&format!("c{i}"), "completed", 1000, SessionCategory::Agent))
        .collect();
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 0);
    assert_eq!(stats.completed_count, 8);
    assert_eq!(stats.failed_count, 0);
    assert_eq!(stats.total_tokens, 8000);
}

#[test]
fn all_failed_sessions() {
    let sessions: Vec<_> = (0..3)
        .map(|i| make_session(&format!("f{i}"), "cancelled", 0, SessionCategory::Cli))
        .collect();
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 0);
    assert_eq!(stats.completed_count, 0);
    assert_eq!(stats.failed_count, 3);
}

// ============================================================================
// Mixed statuses
// ============================================================================

#[test]
fn mixed_status_sessions_bucketed_correctly() {
    let sessions = vec![
        make_session("r1", "running", 100, SessionCategory::Cli),
        make_session("r2", "pending", 50, SessionCategory::Cli),
        make_session("r3", "waiting_for_user", 200, SessionCategory::Agent),
        make_session("c1", "completed", 500, SessionCategory::Cli),
        make_session("c2", "completed", 300, SessionCategory::Agent),
        make_session("f1", "failed", 100, SessionCategory::Os),
        make_session("f2", "cancelled", 0, SessionCategory::Cli),
        make_session("f3", "abandoned", 10, SessionCategory::Agent),
    ];
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 3, "3 active sessions");
    assert_eq!(stats.completed_count, 2, "2 completed sessions");
    assert_eq!(
        stats.failed_count, 3,
        "3 failed/cancelled/abandoned sessions"
    );
    assert_eq!(
        stats.total_tokens,
        100 + 50 + 200 + 500 + 300 + 100 + 0 + 10
    );
}

// ============================================================================
// Token accumulation
// ============================================================================

#[test]
fn token_accumulation_is_sum_of_all_sessions() {
    let sessions = vec![
        make_session("t1", "completed", 1_000, SessionCategory::Cli),
        make_session("t2", "completed", 10_000, SessionCategory::Cli),
        make_session("t3", "completed", 100_000, SessionCategory::Cli),
    ];
    let stats = compute_aggregate_stats(&sessions);
    assert_eq!(stats.total_tokens, 111_000);
}

#[test]
fn zero_token_sessions_do_not_affect_cost() {
    let sessions = vec![
        make_session("z1", "completed", 0, SessionCategory::Cli),
        make_session("z2", "running", 0, SessionCategory::Agent),
    ];
    let stats = compute_aggregate_stats(&sessions);
    assert_eq!(stats.total_tokens, 0);
    assert_eq!(stats.total_cost_usd, 0.0);
}

// ============================================================================
// Cost estimation
// ============================================================================

#[test]
fn cost_is_non_negative() {
    let sessions = vec![make_session(
        "c1",
        "completed",
        50_000,
        SessionCategory::Cli,
    )];
    let stats = compute_aggregate_stats(&sessions);
    assert!(stats.total_cost_usd >= 0.0, "cost must be non-negative");
}

#[test]
fn cost_is_proportional_to_tokens() {
    let sessions_small = vec![make_session("s1", "completed", 1_000, SessionCategory::Cli)];
    let sessions_large = vec![make_session(
        "s2",
        "completed",
        10_000,
        SessionCategory::Cli,
    )];

    let small_cost = compute_aggregate_stats(&sessions_small).total_cost_usd;
    let large_cost = compute_aggregate_stats(&sessions_large).total_cost_usd;

    assert!(
        large_cost > small_cost,
        "larger token count must produce higher cost"
    );
}

// ============================================================================
// Multi-category
// ============================================================================

#[test]
fn stats_aggregate_across_all_three_categories() {
    let sessions = vec![
        make_session("cli1", "running", 100, SessionCategory::Cli),
        make_session("agent1", "completed", 200, SessionCategory::Agent),
        make_session("os1", "failed", 50, SessionCategory::Os),
    ];
    let stats = compute_aggregate_stats(&sessions);

    assert_eq!(stats.ongoing_count, 1);
    assert_eq!(stats.completed_count, 1);
    assert_eq!(stats.failed_count, 1);
    assert_eq!(stats.total_tokens, 350);
}
