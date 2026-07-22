//! Analytics Commands
//!
//! Session analytics computation for per-session and cached sessions.

use tauri::State;

use crate::agent_sessions::event_pipeline::analytics::{
    self, MultiSessionSummary, SessionAnalytics,
};
use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::types::SessionEvent;
use session_persistence as sqlite_cache;

use super::event_conversion::cached_event_to_session_event;
use super::EventStoreState;

/// Compute analytics for a session's in-memory events.
#[tauri::command]
pub async fn es_compute_analytics(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
) -> Result<SessionAnalytics, String> {
    let sid = state.resolve_session_id(session_id)?;
    Ok(state
        .with_store_opt(&sid, |store| {
            analytics::compute_session_analytics(store.events())
        })
        .unwrap_or_else(|| analytics::compute_session_analytics(&[])))
}

/// Compute analytics for a specific cached session (by loading from cache).
#[tauri::command]
pub async fn es_compute_cached_session_analytics(
    session_id: String,
) -> Result<SessionAnalytics, String> {
    session_providers::reject_bounded_replay_full_load(&session_id)?;
    let cached = tokio::task::spawn_blocking(move || sqlite_cache::load_events(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let events: Vec<SessionEvent> = cached.iter().map(cached_event_to_session_event).collect();
    Ok(analytics::compute_session_analytics(&events))
}

/// Compute aggregated analytics across multiple sessions.
#[tauri::command]
pub async fn es_compute_multi_session_analytics(
    session_ids: Vec<String>,
) -> Result<MultiSessionSummary, String> {
    for session_id in &session_ids {
        session_providers::reject_bounded_replay_full_load(session_id)?;
    }
    let session_events = tokio::task::spawn_blocking(move || {
        let mut result: Vec<(String, Vec<SessionEvent>)> = Vec::new();
        for session_id in &session_ids {
            match sqlite_cache::load_events(session_id) {
                Ok(cached) => {
                    let events: Vec<SessionEvent> =
                        cached.iter().map(cached_event_to_session_event).collect();
                    if !events.is_empty() {
                        result.push((session_id.clone(), events));
                    }
                }
                Err(err) => {
                    eprintln!("[analytics] Failed to load session {}: {}", session_id, err);
                }
            }
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(analytics::compute_multi_session_analytics(&session_events))
}
