//! Tauri commands for session event persistence
//!
//! Thin async wrappers around the blocking SQLite operations in `crud` and
//! `editing`. Each command offloads to `tokio::task::spawn_blocking` to avoid
//! blocking the Tauri main thread.
//!
//! Exposed commands: `cache_save_events`, `cache_load_events`,
//! `cache_delete_session`, `cache_truncate_session`, `cache_get_session_metadata`.

use super::crud;
use super::editing;
use super::turn_index::CachedTurnSummary;
use super::types::*;

// ============================================
// Full Session Commands (events + specs + timeRange)
// ============================================

/// Save a full session: events + specs_json + explicit timeRange.
///
/// Preferred over `cache_save_events` when the caller has specs/timeRange
/// (e.g. the Simulator engine). Atomically replaces all events for the session.
#[tauri::command]
pub async fn cache_save_session(session: CachedSession) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crud::save_session(&session))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Load full session data: events + specs_json + timeRange.
///
/// Returns `null` if the session is not cached.
#[tauri::command]
pub async fn cache_load_session(session_id: String) -> Result<Option<CachedSession>, String> {
    tokio::task::spawn_blocking(move || crud::load_session(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Update only the specs_json for an existing cached session.
#[tauri::command]
pub async fn cache_update_session_specs(
    session_id: String,
    specs_json: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || crud::update_session_specs(&session_id, &specs_json))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Save session events to SQLite cache
#[tauri::command]
pub async fn cache_save_events(session_id: String, events: Vec<CachedEvent>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crud::save_events(&session_id, &events))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Load session events from SQLite cache
#[tauri::command]
pub async fn cache_load_events(session_id: String) -> Result<Vec<CachedEvent>, String> {
    tokio::task::spawn_blocking(move || crud::load_events(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Load the materialized turn index for a session.
#[tauri::command]
pub async fn cache_load_turn_index(session_id: String) -> Result<Vec<CachedTurnSummary>, String> {
    tokio::task::spawn_blocking(move || super::turn_index::load_turn_index(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Search events within a session (LIKE substring matching)
#[tauri::command]
pub async fn cache_search_events(
    session_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, String> {
    tokio::task::spawn_blocking(move || {
        crud::search_events(&session_id, &query, limit.unwrap_or(50))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Search across all cached sessions (LIKE substring matching).
///
/// Returns one result per session containing the most recent matched snippet.
/// The frontend should join with the session list to resolve display names.
#[tauri::command]
pub async fn cache_search_all_sessions(
    query: String,
    limit: Option<i64>,
) -> Result<Vec<CrossSessionSearchHit>, String> {
    tokio::task::spawn_blocking(move || crud::search_all_sessions(&query, limit.unwrap_or(30)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Get session metadata
#[tauri::command]
pub async fn cache_get_session_metadata(
    session_id: String,
) -> Result<Option<SessionMetadata>, String> {
    tokio::task::spawn_blocking(move || crud::get_session_metadata(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Delete a session from cache
#[tauri::command]
pub async fn cache_delete_session(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crud::delete_session(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Clear old sessions (default: 24 hours)
#[tauri::command]
pub async fn cache_clear_old_sessions(max_age_hours: Option<i64>) -> Result<i64, String> {
    tokio::task::spawn_blocking(move || crud::clear_old_sessions(max_age_hours.unwrap_or(24)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Get all cached sessions metadata
#[tauri::command]
pub async fn cache_get_all_sessions() -> Result<Vec<SessionMetadata>, String> {
    tokio::task::spawn_blocking(crud::get_all_sessions)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Get cache statistics
#[tauri::command]
pub async fn cache_get_stats() -> Result<CacheStats, String> {
    tokio::task::spawn_blocking(crud::get_cache_stats)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// ============================================
// Message Editing Tauri Commands
// ============================================

/// Truncate history after a specific event ID
/// Used for message editing - removes the target event and all subsequent events
#[tauri::command]
pub async fn cache_truncate_after_event(
    session_id: String,
    event_id: String,
) -> Result<TruncateResult, String> {
    tokio::task::spawn_blocking(move || editing::truncate_after_event(&session_id, &event_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Delete a single event by ID
#[tauri::command]
pub async fn cache_delete_event(session_id: String, event_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || editing::delete_event(&session_id, &event_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Update an existing event
#[tauri::command]
pub async fn cache_update_event(session_id: String, event: CachedEvent) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || editing::update_event(&session_id, &event))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Clear all events for a session
/// Returns the list of deleted event IDs and sequences
#[tauri::command]
pub async fn cache_clear_session_history(session_id: String) -> Result<TruncateResult, String> {
    tokio::task::spawn_blocking(move || editing::clear_session_history(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Get a single event by ID
#[tauri::command]
pub async fn cache_get_event(
    session_id: String,
    event_id: String,
) -> Result<Option<CachedEvent>, String> {
    tokio::task::spawn_blocking(move || crud::get_event(&session_id, &event_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Generate a unified-diff patch for all files modified in a session.
///
/// Uses the per-session file-history snapshots (pre-edit bytes vs. current
/// on-disk content) — works for every SDE Agent session regardless of whether
/// it used worktree isolation. Returns an empty string when the session has no
/// file-history snapshots.
#[tauri::command]
pub async fn cache_get_session_diff(session_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        agent_core::tools::file_history::session_unified_diff(&session_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ============================================
// Per-Round Token Usage Commands
// ============================================

/// Get per-round token usage records for a session.
///
/// Returns a list of records ordered by created_at, each representing
/// one chat round with its model, account, and token counts.
#[tauri::command]
pub async fn get_session_token_usage_records(
    session_id: String,
) -> Result<Vec<super::token_usage::TokenUsageRecord>, String> {
    tokio::task::spawn_blocking(move || super::token_usage::get_token_usage_records(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_session_llm_usage_spans(
    session_id: String,
    turn_id: Option<String>,
) -> Result<Vec<super::tool_usage::LlmUsageSpanRecord>, String> {
    tokio::task::spawn_blocking(move || {
        super::tool_usage::get_llm_usage_spans(&session_id, turn_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_session_tool_usage_attributions(
    session_id: String,
    turn_id: Option<String>,
) -> Result<Vec<super::tool_usage::ToolUsageAttributionRecord>, String> {
    tokio::task::spawn_blocking(move || {
        super::tool_usage::get_tool_usage_attributions(&session_id, turn_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_session_tool_usage_attributions_for_call(
    session_id: String,
    tool_call_id: String,
) -> Result<Vec<super::tool_usage::ToolUsageAttributionRecord>, String> {
    tokio::task::spawn_blocking(move || {
        super::tool_usage::get_tool_usage_attributions_for_call(&session_id, &tool_call_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
