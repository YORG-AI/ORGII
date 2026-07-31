//! Session health check utilities.
//!
//! Provides functions to detect stale sessions and check if sessions are in progress.

use chrono::{DateTime, Utc};

use crate::agent_sessions::unified_stats::types::{SessionAggregateRecord, SessionHealthStatus};

// ============================================================================
// Constants
// ============================================================================

/// Thresholds for stale session detection (matches frontend values)
const PENDING_STALE_THRESHOLD_MS: i64 = 2 * 60 * 1000; // 2 minutes
const RUNNING_STALE_THRESHOLD_MS: i64 = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Health Check
// ============================================================================

/// Check if a session is in progress and/or stale.
pub fn check_session_health(session: &SessionAggregateRecord) -> SessionHealthStatus {
    let status = session.status.as_str();

    // waiting_for_user is always in progress
    if status == "waiting_for_user" {
        return SessionHealthStatus {
            is_in_progress: true,
            is_stale: false,
            stale_reason: None,
            last_activity_at: Some(session.updated_at.clone()),
        };
    }

    // Running status - check for stale
    if status == "running" {
        let has_pid = session.pid.is_some();

        if !has_pid {
            // No PID - check if stale by time
            if let Some(age_ms) = compute_age_ms(&session.updated_at) {
                if age_ms > RUNNING_STALE_THRESHOLD_MS {
                    return SessionHealthStatus {
                        is_in_progress: false,
                        is_stale: true,
                        stale_reason: Some("running_no_pid_timeout".to_string()),
                        last_activity_at: Some(session.updated_at.clone()),
                    };
                }
            }
        }

        return SessionHealthStatus {
            is_in_progress: true,
            is_stale: false,
            stale_reason: None,
            last_activity_at: Some(session.updated_at.clone()),
        };
    }

    // Pending status - check for stale
    if status == "pending" {
        let has_pid = session.pid.is_some();

        if !has_pid {
            if let Some(age_ms) = compute_age_ms(&session.updated_at) {
                if age_ms > PENDING_STALE_THRESHOLD_MS {
                    return SessionHealthStatus {
                        is_in_progress: false,
                        is_stale: true,
                        stale_reason: Some("pending_timeout".to_string()),
                        last_activity_at: Some(session.updated_at.clone()),
                    };
                }
            }
        }

        return SessionHealthStatus {
            is_in_progress: true,
            is_stale: false,
            stale_reason: None,
            last_activity_at: Some(session.updated_at.clone()),
        };
    }

    // Other statuses are not in progress
    SessionHealthStatus {
        is_in_progress: false,
        is_stale: false,
        stale_reason: None,
        last_activity_at: Some(session.updated_at.clone()),
    }
}

// ============================================================================
// Time Utilities
// ============================================================================

/// Compute the age of a timestamp in milliseconds from now.
pub fn compute_age_ms(timestamp: &str) -> Option<i64> {
    let parsed = DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|dt| dt.with_timezone(&Utc));

    parsed.map(|dt| {
        let now = Utc::now();
        (now - dt).num_milliseconds()
    })
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::unified_stats::display::generate_display_label;
    use crate::agent_sessions::unified_stats::status::is_active_status;
    use crate::agent_sessions::unified_stats::types::SessionCategory;
    use core_types::key_source::KeySource;

    fn make_session(
        id: &str,
        status: &str,
        category: SessionCategory,
        key_source: KeySource,
    ) -> SessionAggregateRecord {
        let name = format!("Session {}", id);
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
            model: Some("gpt-4".to_string()),
            account_id: None,
            cli_agent_type: None,
            key_source,
            tier: None,
            pid: None,
            total_tokens: 1000,
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
            agent_display_name: None,
            agent_icon_id: None,
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

    #[test]
    fn test_check_session_health_waiting_for_user() {
        let session = make_session(
            "1",
            "waiting_for_user",
            SessionCategory::Cli,
            KeySource::OwnKey,
        );
        let health = check_session_health(&session);

        assert!(health.is_in_progress);
        assert!(!health.is_stale);
        assert!(health.stale_reason.is_none());
    }

    #[test]
    fn test_check_session_health_running_with_pid() {
        let mut session = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        session.pid = Some(12345);

        let health = check_session_health(&session);

        assert!(health.is_in_progress);
        assert!(!health.is_stale);
    }

    #[test]
    fn test_check_session_health_completed() {
        let session = make_session("1", "completed", SessionCategory::Cli, KeySource::OwnKey);
        let health = check_session_health(&session);

        assert!(!health.is_in_progress);
        assert!(!health.is_stale);
    }

    #[test]
    fn test_check_session_health_failed() {
        let session = make_session("1", "failed", SessionCategory::Cli, KeySource::OwnKey);
        let health = check_session_health(&session);

        assert!(!health.is_in_progress);
        assert!(!health.is_stale);
    }

    #[test]
    fn test_compute_age_ms_valid() {
        // Use a timestamp that's definitely in the past
        let past = "2020-01-01T00:00:00Z";
        let age = compute_age_ms(past);

        assert!(age.is_some());
        assert!(age.unwrap() > 0);
    }

    #[test]
    fn test_compute_age_ms_invalid() {
        let invalid = "not a timestamp";
        let age = compute_age_ms(invalid);

        assert!(age.is_none());
    }

    #[test]
    fn test_compute_age_ms_empty() {
        let age = compute_age_ms("");
        assert!(age.is_none());
    }
}
