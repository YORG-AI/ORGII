//! Aggregate statistics computation for market/billing analysis.
//!
//! Provides functions to compute aggregate statistics across sessions,
//! including token counts and cost estimation.

use super::accounting::session_usage_summaries;
use super::status::{is_active_status, is_completed_status, is_failed_status};
use super::types::{AggregateStats, SessionAggregateRecord};

// ============================================================================
// Aggregate Statistics
// ============================================================================

/// Compute aggregate statistics for a set of sessions.
pub fn compute_aggregate_stats(sessions: &[SessionAggregateRecord]) -> AggregateStats {
    compute_aggregate_stats_from_usage(sessions, None)
}

/// Compute aggregate statistics using prompt-cache-aware token accounting.
pub fn compute_aggregate_stats_with_accounting(
    sessions: &[SessionAggregateRecord],
) -> Result<AggregateStats, String> {
    let usage = session_usage_summaries(sessions)?;
    Ok(compute_aggregate_stats_from_usage(sessions, Some(&usage)))
}

fn compute_aggregate_stats_from_usage(
    sessions: &[SessionAggregateRecord],
    usage: Option<&std::collections::BTreeMap<String, super::accounting::SessionUsageSummary>>,
) -> AggregateStats {
    let mut total_cost_usd = 0.0;
    let mut total_tokens_input: i64 = 0;
    let mut total_tokens_output: i64 = 0;
    let mut total_tokens: i64 = 0;
    let mut ongoing_count = 0;
    let mut completed_count = 0;
    let mut failed_count = 0;

    for session in sessions {
        if let Some(summary) = usage.and_then(|usage| usage.get(&session.session_id)) {
            total_tokens_input += summary.input_tokens;
            total_tokens_output += summary.output_tokens;
            total_tokens += summary.total_tokens;
            total_cost_usd += summary.cost_usd;
        } else {
            total_tokens += session.total_tokens;
        }

        if is_active_status(&session.status) {
            ongoing_count += 1;
        } else if is_completed_status(&session.status) {
            completed_count += 1;
        } else if is_failed_status(&session.status) {
            failed_count += 1;
        }
    }

    AggregateStats {
        total_cost_usd,
        total_tokens_input,
        total_tokens_output,
        total_tokens,
        ongoing_count,
        completed_count,
        failed_count,
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
            user_input: None,
            repo_path: None,
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
        }
    }

    #[test]
    fn test_compute_aggregate_stats_empty() {
        let sessions: Vec<SessionAggregateRecord> = vec![];
        let stats = compute_aggregate_stats(&sessions);

        assert_eq!(stats.total_tokens, 0);
        assert_eq!(stats.ongoing_count, 0);
        assert_eq!(stats.completed_count, 0);
        assert_eq!(stats.failed_count, 0);
    }

    #[test]
    fn test_compute_aggregate_stats_with_tokens() {
        let mut s1 = make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey);
        s1.total_tokens = 5000;
        let mut s2 = make_session("2", "completed", SessionCategory::Cli, KeySource::OwnKey);
        s2.total_tokens = 3000;

        let sessions = vec![s1, s2];
        let stats = compute_aggregate_stats(&sessions);

        assert_eq!(stats.total_tokens, 8000);
        assert_eq!(stats.ongoing_count, 1);
        assert_eq!(stats.completed_count, 1);
    }

    #[test]
    fn test_compute_aggregate_stats_cost_estimation() {
        let mut session = make_session("1", "completed", SessionCategory::Cli, KeySource::OwnKey);
        session.total_tokens = 10000;

        let stats = compute_aggregate_stats(&[session]);

        // 10000 tokens / 1000 * 0.003 = $0.03
        assert!((stats.total_cost_usd - 0.03).abs() < 0.0001);
    }
}
