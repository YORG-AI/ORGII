//! Agent Session Health Tests
//!
//! Tests stale-detection and in-progress classification across all session
//! statuses and time scenarios.
//!
//! ## Coverage
//! - `waiting_for_user` is always in-progress, never stale
//! - `running` with PID — healthy, not stale
//! - `running` without PID, fresh — in-progress (not yet timed out)
//! - `running` without PID, aged past threshold — stale, not in-progress
//! - `pending` with PID — in-progress
//! - `pending` without PID, fresh — in-progress
//! - `pending` without PID, aged past threshold — stale
//! - Terminal statuses (completed/failed/cancelled) — never in-progress
//! - `compute_age_ms` edge cases: valid timestamps, invalid, empty string

use crate::agent_sessions::health::{check_session_health, compute_age_ms};
use crate::agent_sessions::unified_stats::display::generate_display_label;
use crate::agent_sessions::unified_stats::status::is_active_status;
use crate::agent_sessions::unified_stats::types::{SessionAggregateRecord, SessionCategory};
use chrono::{Duration, Utc};
use core_types::key_source::KeySource;

// ============================================================================
// Helpers
// ============================================================================

fn make_session(id: &str, status: &str) -> SessionAggregateRecord {
    let now = Utc::now().to_rfc3339();
    let name = format!("Session {id}");
    SessionAggregateRecord {
        session_id: id.to_string(),
        name: name.clone(),
        status: status.to_string(),
        created_at: now.clone(),
        updated_at: now,
        category: SessionCategory::Cli,
        external_history_source: None,
        user_input: None,
        repo_path: None,
        storage_path: None,
        repo_name: None,
        branch: None,
        model: Some("composer-2.5".to_string()),
        account_id: None,
        cli_agent_type: None,
        key_source: KeySource::OwnKey,
        tier: None,
        pid: None,
        total_tokens: 0,
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

/// Returns an RFC-3339 timestamp `delta_seconds` in the past.
fn ts_ago(delta_seconds: i64) -> String {
    (Utc::now() - Duration::seconds(delta_seconds)).to_rfc3339()
}

// ============================================================================
// waiting_for_user
// ============================================================================

#[test]
fn waiting_for_user_is_always_in_progress_not_stale() {
    let session = make_session("wfu-1", "waiting_for_user");
    let health = check_session_health(&session);

    assert!(
        health.is_in_progress,
        "waiting_for_user must be in-progress"
    );
    assert!(!health.is_stale, "waiting_for_user must never be stale");
    assert!(health.stale_reason.is_none());
}

#[test]
fn waiting_for_user_old_timestamp_still_not_stale() {
    let mut session = make_session("wfu-2", "waiting_for_user");
    session.updated_at = ts_ago(600); // 10 minutes ago
    let health = check_session_health(&session);

    assert!(health.is_in_progress);
    assert!(!health.is_stale);
}

// ============================================================================
// running
// ============================================================================

#[test]
fn running_with_pid_is_healthy() {
    let mut session = make_session("run-1", "running");
    session.pid = Some(12345);
    let health = check_session_health(&session);

    assert!(health.is_in_progress);
    assert!(!health.is_stale);
}

#[test]
fn running_without_pid_fresh_is_in_progress() {
    // updated 30 seconds ago — well within the 5-minute threshold
    let mut session = make_session("run-2", "running");
    session.updated_at = ts_ago(30);
    let health = check_session_health(&session);

    assert!(health.is_in_progress);
    assert!(!health.is_stale);
}

#[test]
fn running_without_pid_stale_is_detected() {
    // updated 10 minutes ago — exceeds the 5-minute running stale threshold
    let mut session = make_session("run-3", "running");
    session.updated_at = ts_ago(10 * 60);
    let health = check_session_health(&session);

    assert!(
        !health.is_in_progress,
        "stale running session must not be in-progress"
    );
    assert!(
        health.is_stale,
        "stale running session must be detected as stale"
    );
    assert_eq!(
        health.stale_reason.as_deref(),
        Some("running_no_pid_timeout"),
        "stale_reason must be 'running_no_pid_timeout'"
    );
}

// ============================================================================
// pending
// ============================================================================

#[test]
fn pending_with_pid_is_in_progress() {
    let mut session = make_session("pend-1", "pending");
    session.pid = Some(99999);
    let health = check_session_health(&session);

    assert!(health.is_in_progress);
    assert!(!health.is_stale);
}

#[test]
fn pending_without_pid_fresh_is_in_progress() {
    let mut session = make_session("pend-2", "pending");
    session.updated_at = ts_ago(60); // 1 minute ago — within 2-minute threshold
    let health = check_session_health(&session);

    assert!(health.is_in_progress);
    assert!(!health.is_stale);
}

#[test]
fn pending_without_pid_stale_is_detected() {
    // updated 5 minutes ago — exceeds the 2-minute pending stale threshold
    let mut session = make_session("pend-3", "pending");
    session.updated_at = ts_ago(5 * 60);
    let health = check_session_health(&session);

    assert!(
        !health.is_in_progress,
        "stale pending session must not be in-progress"
    );
    assert!(
        health.is_stale,
        "stale pending session must be detected as stale"
    );
    assert_eq!(
        health.stale_reason.as_deref(),
        Some("pending_timeout"),
        "stale_reason must be 'pending_timeout'"
    );
}

// ============================================================================
// Terminal statuses — never in-progress
// ============================================================================

#[test]
fn terminal_statuses_are_never_in_progress() {
    for status in ["completed", "failed", "cancelled"] {
        let session = make_session(&format!("term-{status}"), status);
        let health = check_session_health(&session);

        assert!(
            !health.is_in_progress,
            "{status}: terminal session must not be in-progress"
        );
        assert!(
            !health.is_stale,
            "{status}: terminal session must not be stale"
        );
        assert!(
            health.stale_reason.is_none(),
            "{status}: terminal session must not have a stale_reason"
        );
    }
}

// ============================================================================
// compute_age_ms edge cases
// ============================================================================

#[test]
fn compute_age_ms_returns_positive_for_past_timestamp() {
    let past = ts_ago(120); // 2 minutes ago
    let age = compute_age_ms(&past);
    assert!(age.is_some());
    let ms = age.unwrap();
    assert!(ms > 0, "age should be positive for past timestamps");
    // Loose bounds: 1s–5min
    assert!(
        ms >= 1_000 && ms <= 300_000,
        "age {ms}ms is outside expected range"
    );
}

#[test]
fn compute_age_ms_returns_none_for_invalid_format() {
    for bad in ["", "not-a-date", "2024/01/01", "01-01-2024T00:00:00"] {
        assert!(
            compute_age_ms(bad).is_none(),
            "compute_age_ms({bad:?}) should return None"
        );
    }
}

#[test]
fn compute_age_ms_accepts_utc_z_suffix() {
    let age = compute_age_ms("2020-01-01T00:00:00Z");
    assert!(age.is_some());
    assert!(age.unwrap() > 0);
}

#[test]
fn compute_age_ms_accepts_offset_timestamp() {
    let age = compute_age_ms("2020-01-01T00:00:00+00:00");
    assert!(age.is_some());
    assert!(age.unwrap() > 0);
}
