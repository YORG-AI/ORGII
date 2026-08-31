//! SQLite Bridge Commands
//!
//! Load/save events from SQLite cache with SessionEvent <-> CachedEvent conversion.

use serde::{Deserialize, Serialize};

use crate::agent_sessions::event_pipeline::session_providers;
use tauri::{AppHandle, State};

use crate::agent_sessions::event_pipeline::payload_compaction::{
    load_event_payload_body, EventPayloadBody,
};
use crate::agent_sessions::event_pipeline::types::SessionEvent;
use session_persistence as sqlite_cache;

use super::{
    event_conversion::{
        cached_event_to_session_event, is_synthetic_persistence_artifact,
        session_event_to_cached_event,
    },
    prepare_loaded_events, save_events_retry, schedule_notify, EventStoreState,
    BULK_WRITE_MAX_RETRIES,
};

fn try_load_provider_history_events(session_id: &str) -> Result<Vec<SessionEvent>, String> {
    session_providers::load_history_events(session_id)
}

// ============================================================================
// SQLite Bridge Commands
// ============================================================================

/// Load events from SQLite cache into the target session's store.
///
/// If the in-memory store already has events (e.g. a live streaming child
/// session), the cache load is skipped to avoid overwriting live data.
/// Returns the current event count (from memory or freshly loaded cache).
#[tauri::command]
pub async fn es_load_from_cache(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: String,
) -> Result<usize, String> {
    let existing_count = state
        .with_store_opt(&session_id, |store| store.events().len())
        .unwrap_or(0);
    if existing_count > 0 {
        schedule_notify(&app, &state, &session_id);
        return Ok(existing_count);
    }

    let load_sid = session_id.clone();
    let cached = tokio::task::spawn_blocking(move || sqlite_cache::load_events(&load_sid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut events: Vec<SessionEvent> = cached
        .into_iter()
        .map(|ce| cached_event_to_session_event(&ce))
        .collect();

    if events.is_empty() {
        match try_load_provider_history_events(&session_id) {
            Ok(loaded) if !loaded.is_empty() => events = loaded,
            Ok(_) => {}
            Err(err) => tracing::warn!(
                "[cache_bridge] failed to load provider history for {session_id}: {err}"
            ),
        }
    }

    let events = prepare_loaded_events(&session_id, events);
    let count = events.len();
    if count > 0 {
        state.with_store_mut(&session_id, |store| {
            store.set(events);
            store.repair_subagent_links();
            // Cancel any orphan interactive tool calls that are still
            // AwaitingUser. When the Rust process restarts the QuestionManager
            // loses its in-memory state, so these events would be stuck: the
            // AskQuestionCard would render but clicking Submit would fail.
            let cancelled = store.cancel_orphan_interactive_events();
            if !cancelled.is_empty() {
                tracing::info!(
                    "[cache_bridge] cancelled {} orphan interactive event(s) for session {}: {:?}",
                    cancelled.len(),
                    session_id,
                    cancelled,
                );
            }
        });
    }
    schedule_notify(&app, &state, &session_id);
    Ok(count)
}

/// Save a session's in-memory events to SQLite cache.
#[tauri::command]
pub async fn es_save_to_cache(
    state: State<'_, EventStoreState>,
    session_id: String,
) -> Result<usize, String> {
    if session_providers::skips_event_cache_save(&session_id) {
        return Ok(0);
    }

    let events = state
        .with_store_opt(&session_id, |store| store.events().to_vec())
        .unwrap_or_default();
    let cached: Vec<sqlite_cache::CachedEvent> = events
        .iter()
        .filter(|e| !is_synthetic_persistence_artifact(e))
        .map(session_event_to_cached_event)
        .collect();
    let count = cached.len();
    let save_sid = session_id.clone();
    let save_result = tokio::task::spawn_blocking(move || {
        save_events_retry(
            "es_save_to_cache",
            &save_sid,
            &cached,
            BULK_WRITE_MAX_RETRIES,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Err(err) = save_result {
        tracing::warn!(
            "[event-pipeline] best-effort es_save_to_cache failed for {session_id}: {err}"
        );
        return Ok(0);
    }

    Ok(count)
}

// ============================================================================
// Direct Cache Commands (SessionEvent-based)
//
// These commands accept/return `SessionEvent` directly, performing the
// SessionEvent <-> CachedEvent conversion in Rust. This eliminates the
// JS-side conversion overhead that existed in sqliteCache.ts.
// ============================================================================

/// Search result containing a SessionEvent instead of CachedEvent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventSearchResult {
    pub event: SessionEvent,
    pub rank: f64,
    pub snippet: String,
}

/// Save SessionEvents directly to SQLite cache (conversion happens in Rust).
#[tauri::command]
pub async fn cache_save_session_events(
    session_id: String,
    events: Vec<SessionEvent>,
) -> Result<usize, String> {
    if session_providers::skips_event_cache_save(&session_id) {
        return Ok(0);
    }

    let cached: Vec<sqlite_cache::CachedEvent> = events
        .iter()
        .filter(|e| !is_synthetic_persistence_artifact(e))
        .map(session_event_to_cached_event)
        .collect();
    let count = cached.len();
    tokio::task::spawn_blocking(move || sqlite_cache::save_events(&session_id, &cached))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(count)
}

/// Append one bounded cloud-replay import page without rebuilding metadata,
/// normalized sequences, or the turn index for the already persisted prefix.
/// The import remains unpublished until `cache_finalize_session_event_import`.
#[tauri::command]
pub async fn cache_append_session_event_import(
    session_id: String,
    events: Vec<SessionEvent>,
) -> Result<usize, String> {
    if session_providers::skips_event_cache_save(&session_id) {
        return Ok(0);
    }

    let cached: Vec<sqlite_cache::CachedEvent> = events
        .iter()
        .filter(|event| !is_synthetic_persistence_artifact(event))
        .map(session_event_to_cached_event)
        .collect();
    let count = cached.len();
    tokio::task::spawn_blocking(move || sqlite_cache::save_events_deferred(&session_id, &cached))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(count)
}

/// Publish a page-streamed replay after the final epoch/count check. Exactly
/// one full metadata/sequence pass and one turn-index rebuild are scheduled.
#[tauri::command]
pub async fn cache_finalize_session_event_import(session_id: String) -> Result<usize, String> {
    if session_providers::skips_event_cache_save(&session_id) {
        return Ok(0);
    }
    tokio::task::spawn_blocking(move || sqlite_cache::finalize_deferred_event_import(&session_id))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Count a session's persisted events without loading them — the cheap
/// cache-hit probe for imported replays. Pure read: takes neither the
/// writer serializer nor the sequence-normalization pass.
#[tauri::command]
pub async fn cache_count_session_events(session_id: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || sqlite_cache::count_events(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
        .map(|count| count.max(0) as usize)
}

/// Load SessionEvents directly from SQLite cache (conversion happens in Rust).
#[tauri::command]
pub async fn cache_load_session_events(session_id: String) -> Result<Vec<SessionEvent>, String> {
    log::debug!("[cache_bridge] cache_load_session_events called for session_id={session_id}");
    let sid = session_id.clone();
    let cached = tokio::task::spawn_blocking(move || sqlite_cache::load_events(&sid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut events: Vec<SessionEvent> = cached.iter().map(cached_event_to_session_event).collect();
    if events.is_empty() {
        match try_load_provider_history_events(&session_id) {
            Ok(loaded) if !loaded.is_empty() => events = loaded,
            Ok(_) => {}
            Err(err) => tracing::warn!(
                "[cache_bridge] failed to load provider history for {session_id}: {err}"
            ),
        }
    }
    Ok(prepare_loaded_events(&session_id, events))
}

/// Search events via LIKE substring matching, returning SessionEvents directly.
#[tauri::command]
pub async fn cache_search_session_events(
    session_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SessionEventSearchResult>, String> {
    let results = tokio::task::spawn_blocking(move || {
        sqlite_cache::search_events(&session_id, &query, limit.unwrap_or(50))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(results
        .iter()
        .map(|r| SessionEventSearchResult {
            event: cached_event_to_session_event(&r.event),
            rank: r.rank,
            snippet: r.snippet.clone(),
        })
        .collect())
}

/// Update a single event in cache, accepting SessionEvent directly.
#[tauri::command]
pub async fn cache_update_session_event(
    session_id: String,
    event: SessionEvent,
) -> Result<bool, String> {
    // Silently drop updates targeting TS-side per-delta placeholders — they
    // must not reach SQLite (see `is_ts_placeholder_id` docs).
    if is_synthetic_persistence_artifact(&event) {
        return Ok(false);
    }
    let cached = session_event_to_cached_event(&event);
    tokio::task::spawn_blocking(move || sqlite_cache::update_event(&session_id, &cached))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Get a single event by ID, returning SessionEvent directly.
#[tauri::command]
pub async fn cache_get_session_event(
    session_id: String,
    event_id: String,
) -> Result<Option<SessionEvent>, String> {
    let cached =
        tokio::task::spawn_blocking(move || sqlite_cache::get_event(&session_id, &event_id))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
    Ok(cached.map(|c| cached_event_to_session_event(&c)))
}

#[tauri::command]
pub async fn cache_load_event_payload(
    state: State<'_, EventStoreState>,
    session_id: String,
    event_id: String,
    field_path: String,
) -> Result<Option<EventPayloadBody>, String> {
    if let Some(Some(body)) = state.with_store_opt(&session_id, |store| {
        store
            .get_by_id(&event_id)
            .and_then(|event| load_event_payload_body(event, &field_path))
    }) {
        return Ok(Some(body));
    }

    let cached_session_id = session_id.clone();
    let cached_event_id = event_id.clone();
    let cached = tokio::task::spawn_blocking(move || {
        sqlite_cache::get_event(&cached_session_id, &cached_event_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let Some(cached) = cached else {
        return Ok(None);
    };
    let event = cached_event_to_session_event(&cached);
    Ok(load_event_payload_body(&event, &field_path))
}

/// Full session payload: events + specs_json + timeRange.
///
/// Used by `cache_save_full_session` and `cache_load_full_session` to transfer
/// all data needed by the Simulator engine in one round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSessionPayload {
    pub session_id: String,
    pub events: Vec<SessionEvent>,
    pub specs_json: Option<String>,
    pub time_range_start: Option<String>,
    pub time_range_end: Option<String>,
}

/// Save a full session (events + specs + timeRange) in one call.
///
/// Replaces all existing events. Preferred over `cache_save_session_events`
/// when the caller also has specs/timeRange to persist.
#[tauri::command]
pub async fn cache_save_full_session(payload: FullSessionPayload) -> Result<(), String> {
    if session_providers::skips_event_cache_save(&payload.session_id) {
        return Ok(());
    }

    let cached_events: Vec<sqlite_cache::CachedEvent> = payload
        .events
        .iter()
        .filter(|e| !is_synthetic_persistence_artifact(e))
        .map(session_event_to_cached_event)
        .collect();

    let session = sqlite_cache::CachedSession {
        session_id: payload.session_id,
        events: cached_events,
        specs_json: payload.specs_json,
        time_range_start: payload.time_range_start,
        time_range_end: payload.time_range_end,
    };

    tokio::task::spawn_blocking(move || sqlite_cache::save_session(&session))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Load a full session (events + specs + timeRange) in one call.
///
/// Returns `null` if the session is not cached.
#[tauri::command]
pub async fn cache_load_full_session(
    session_id: String,
) -> Result<Option<FullSessionPayload>, String> {
    let result = tokio::task::spawn_blocking(move || sqlite_cache::load_session(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    Ok(result.map(|s| {
        let events: Vec<SessionEvent> =
            s.events.iter().map(cached_event_to_session_event).collect();
        let events = prepare_loaded_events(&s.session_id, events);
        FullSessionPayload {
            session_id: s.session_id,
            events,
            specs_json: s.specs_json,
            time_range_start: s.time_range_start,
            time_range_end: s.time_range_end,
        }
    }))
}

#[cfg(test)]
#[path = "cache_bridge_tests.rs"]
mod tests;
