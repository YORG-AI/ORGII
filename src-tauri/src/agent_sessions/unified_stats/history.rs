//! Session history utilities for the History page.
//!
//! Provides functions to convert aggregate records to history format
//! and compute history-specific metrics.

use super::status::{is_active_status, is_completed_status};
use super::types::{
    HistorySessionRecord, SessionAggregateRecord, SessionHistoryMetrics, SessionHistoryResponse,
};

// ============================================================================
// Conversion
// ============================================================================

/// Convert an aggregate record to history format.
pub fn aggregate_record_to_history(session: &SessionAggregateRecord) -> HistorySessionRecord {
    HistorySessionRecord {
        session_id: session.session_id.clone(),
        name: session.name.clone(),
        status: session.status.clone(),
        repo_name: session.repo_name.clone(),
        repo_path: session.repo_path.clone(),
        branch: session.branch.clone(),
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        model: session.model.clone(),
        total_tokens: session.total_tokens,
        added_lines: 0, // TODO: Could be fetched from event store if needed
        deleted_lines: 0,
        pr_link: None, // TODO: Could be stored in session metadata
        is_active: session.is_active,
        category: session.category,
    }
}

// ============================================================================
// Metrics Computation
// ============================================================================

/// Compute history metrics for a set of sessions.
pub fn compute_history_metrics(sessions: &[SessionAggregateRecord]) -> SessionHistoryMetrics {
    let mut total_tokens: i64 = 0;
    let mut ongoing_count = 0;
    let mut completed_count = 0;

    for session in sessions {
        total_tokens += session.total_tokens;

        if is_active_status(&session.status) {
            ongoing_count += 1;
        } else if is_completed_status(&session.status) {
            completed_count += 1;
        }
    }

    SessionHistoryMetrics {
        total_sessions: sessions.len(),
        total_tokens,
        total_added_lines: 0, // Would need per-session tracking
        total_deleted_lines: 0,
        starred_count: 0, // Would need starred field in session
        ongoing_count,
        completed_count,
    }
}

/// Build a history response from aggregate sessions.
pub fn build_history_response(
    sessions: &[SessionAggregateRecord],
    offset: Option<usize>,
) -> SessionHistoryResponse {
    // Apply offset manually (we already have the full list)
    let sessions_to_convert: Vec<&SessionAggregateRecord> = if let Some(off) = offset {
        sessions.iter().skip(off).collect()
    } else {
        sessions.iter().collect()
    };

    // Convert to history format
    let history_sessions: Vec<HistorySessionRecord> = sessions_to_convert
        .iter()
        .copied()
        .map(aggregate_record_to_history)
        .collect();

    // Compute metrics from the full list (before offset/limit)
    let metrics = compute_history_metrics(sessions);

    SessionHistoryResponse {
        sessions: history_sessions,
        metrics,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::unified_stats::display::generate_display_label;
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

    #[test]
    fn test_compute_history_metrics() {
        let mut s1 = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        s1.total_tokens = 2000;
        let mut s2 = make_session("2", "completed", SessionCategory::Agent, KeySource::OwnKey);
        s2.total_tokens = 3000;

        let sessions = vec![s1, s2];
        let metrics = compute_history_metrics(&sessions);

        assert_eq!(metrics.total_sessions, 2);
        assert_eq!(metrics.total_tokens, 5000);
        assert_eq!(metrics.ongoing_count, 1);
        assert_eq!(metrics.completed_count, 1);
    }

    #[test]
    fn test_aggregate_record_to_history() {
        let mut session =
            make_session("test-1", "running", SessionCategory::Cli, KeySource::OwnKey);
        session.repo_name = Some("my-repo".to_string());
        session.branch = Some("main".to_string());
        session.total_tokens = 5000;

        let history = aggregate_record_to_history(&session);

        assert_eq!(history.session_id, "test-1");
        assert_eq!(history.status, "running");
        assert_eq!(history.repo_name, Some("my-repo".to_string()));
        assert_eq!(history.branch, Some("main".to_string()));
        assert_eq!(history.total_tokens, 5000);
        assert!(history.is_active);
        assert_eq!(history.category, SessionCategory::Cli);
    }
}
