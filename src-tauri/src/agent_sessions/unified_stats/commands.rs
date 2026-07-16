//! Tauri commands for unified session statistics.
//!
//! Provides the Tauri command endpoints that the frontend calls to interact
//! with the unified session listing / statistics system.

use crate::agent_sessions::health::check_session_health;

use super::accounting::{
    query_session_heatmap, session_usage_summary as build_session_usage_summary,
    SessionHeatmapFilter, SessionHeatmapResponse, SessionUsageSummary,
};
use super::aggregation::list_all_sessions;
use super::history::build_history_response;
use super::stats::compute_aggregate_stats_with_accounting;
use super::types::{
    AggregateStats, SessionAggregateRecord, SessionFilter, SessionHealthStatus,
    SessionHistoryResponse, SessionListResponse, UsageFilter, UsageRecord,
};
use super::usage::query_usage_list;

use serde::Serialize;

/// Per-session context status for the monitoring panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextStatus {
    pub round_count: i64,
    pub total_tokens: i64,
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get all sessions with statistics.
///
/// This replaces the frontend's parallel loading from 3 Tauri commands
/// (`osagent_list_sessions`, `sde_session_get_sessions`, `cli_agent_list`)
/// with a single session_aggregate_list command.
#[tauri::command]
pub async fn session_aggregate_list(
    filter: Option<SessionFilter>,
) -> Result<SessionListResponse, String> {
    tokio::task::spawn_blocking(move || list_all_sessions(filter.as_ref()))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Check session health (in-progress and stale detection).
///
/// This replaces the frontend's `isSessionInProgress()` utility with
/// centralized logic that uses the same thresholds.
#[tauri::command]
pub async fn session_check_health(session_id: String) -> Result<SessionHealthStatus, String> {
    tokio::task::spawn_blocking(move || {
        // Load all sessions and find the one we want
        let filter = SessionFilter {
            include_stats: Some(false),
            ..SessionFilter::default()
        };
        let response = list_all_sessions(Some(&filter))?;
        let session = response
            .sessions
            .into_iter()
            .find(|session| session.session_id == session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;

        Ok(check_session_health(&session))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get aggregate statistics for sessions.
///
/// Optionally filter by session IDs or key source.
#[tauri::command]
pub async fn session_get_aggregate_stats(
    session_ids: Option<Vec<String>>,
    key_source: Option<String>,
) -> Result<AggregateStats, String> {
    tokio::task::spawn_blocking(move || {
        let filter = SessionFilter {
            key_source,
            include_stats: Some(false),
            ..SessionFilter::default()
        };

        let response = list_all_sessions(Some(&filter))?;

        let sessions: Vec<SessionAggregateRecord> = if let Some(ids) = session_ids {
            response
                .sessions
                .into_iter()
                .filter(|session| ids.contains(&session.session_id))
                .collect()
        } else {
            response.sessions
        };

        compute_aggregate_stats_with_accounting(&sessions)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get session history with metrics for the History page.
///
/// This replaces the frontend's useSessionHistory hook's complex mapping logic.
#[tauri::command]
pub async fn session_get_history(
    repo_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SessionHistoryResponse, String> {
    tokio::task::spawn_blocking(move || {
        let filter = SessionFilter {
            repo_path: repo_id,
            limit,
            include_stats: Some(false),
            ..Default::default()
        };

        let response = list_all_sessions(Some(&filter))?;

        Ok(build_history_response(&response.sessions, offset))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get session usage list for the Dev Record > Sessions tab.
///
/// Replaces the frontend's dual-fetch pipeline (`cli_agent_list` +
/// `agent_list_all_sessions` → JS merge/filter) with a single SQL UNION ALL.
#[tauri::command]
pub async fn session_usage_list(filter: Option<UsageFilter>) -> Result<Vec<UsageRecord>, String> {
    tokio::task::spawn_blocking(move || query_usage_list(filter.as_ref()))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

// ============================================================================
// Monitoring Commands (E6)
// ============================================================================

/// Get ZenMux quota status for the monitoring panel.
///
/// Returns structured quota data (5h/7d usage percentages and reset times).
/// Shares the same 5-minute TTL cache as the Feishu status bar.
#[tauri::command]
pub async fn quota_get_zenmux_status(
) -> Result<Option<agent_core::core::session::status_bar::ZenmuxQuotaStatus>, String> {
    Ok(agent_core::core::session::status_bar::get_zenmux_quota().await)
}

/// Get per-session token usage summary for the monitoring panel.
///
/// Returns `{ roundCount, totalTokens }` for the given session.
#[tauri::command]
pub async fn session_get_context_status(
    session_id: String,
) -> Result<SessionContextStatus, String> {
    tokio::task::spawn_blocking(move || {
        let (round_count, total_tokens) =
            agent_core::core::session::status_bar::get_session_token_summary(&session_id)
                .unwrap_or((0, 0));
        Ok(SessionContextStatus {
            round_count,
            total_tokens,
        })
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Get a prompt-cache-aware token and cost summary for one session.
#[tauri::command]
pub async fn session_usage_summary(session_id: String) -> Result<SessionUsageSummary, String> {
    tokio::task::spawn_blocking(move || build_session_usage_summary(&session_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Get activity heatmap data from the shared unified stats/orgtrack pipeline.
#[tauri::command]
pub async fn session_heatmap(
    filter: Option<SessionHeatmapFilter>,
) -> Result<SessionHeatmapResponse, String> {
    tokio::task::spawn_blocking(move || query_session_heatmap(filter.as_ref()))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}
