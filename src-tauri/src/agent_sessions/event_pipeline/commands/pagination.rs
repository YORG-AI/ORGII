//! Pagination Commands
//!
//! Paginate, filter, and count events in a per-session store or from the
//! SQLite cache.

use tauri::State;

use crate::agent_sessions::event_pipeline::pagination::{
    self, EventFilters, FunctionUsageCount, PaginatedEvents, PaginationRequest,
};
use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::types::SessionEvent;
use session_persistence as sqlite_cache;

use super::event_conversion::cached_event_to_session_event;
use super::EventStoreState;

/// Paginate events in the target session's store with optional filters.
#[tauri::command]
pub async fn es_paginate_events(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    request: PaginationRequest,
) -> Result<PaginatedEvents, String> {
    let sid = state.resolve_session_id(session_id)?;
    Ok(state
        .with_store_opt(&sid, |store| {
            pagination::paginate_events(store.events(), &request)
        })
        .unwrap_or_else(|| pagination::paginate_events(&[], &request)))
}

/// Paginate events from a cached session.
#[tauri::command]
pub async fn es_paginate_cached_events(
    session_id: String,
    request: PaginationRequest,
) -> Result<PaginatedEvents, String> {
    session_providers::reject_bounded_replay_full_load(&session_id)?;
    let cached = tokio::task::spawn_blocking(move || sqlite_cache::load_events(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let events: Vec<SessionEvent> = cached.iter().map(cached_event_to_session_event).collect();
    Ok(pagination::paginate_events(&events, &request))
}

/// Count events matching filters in the target session's store.
#[tauri::command]
pub async fn es_count_matching_events(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    filters: EventFilters,
) -> Result<usize, String> {
    let sid = state.resolve_session_id(session_id)?;
    Ok(state
        .with_store_opt(&sid, |store| {
            pagination::count_matching_events(store.events(), &filters)
        })
        .unwrap_or(0))
}

/// Get distinct function names with usage counts from the target session's store.
#[tauri::command]
pub async fn es_get_distinct_functions(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
) -> Result<Vec<FunctionUsageCount>, String> {
    let sid = state.resolve_session_id(session_id)?;
    Ok(state
        .with_store_opt(&sid, |store| {
            pagination::get_distinct_functions(store.events())
        })
        .unwrap_or_default())
}
