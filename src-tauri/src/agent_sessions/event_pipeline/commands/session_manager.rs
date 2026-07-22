//! Session Manager Commands
//!
//! Multi-session management: set active, pin/unpin, evict, buffer events.
//!
//! With per-session `EventStore` instances, "switching" no longer swaps
//! events in and out of a shared store — each session already has its own.
//! These commands now just mutate the registry and notify.

use tauri::{AppHandle, State};

use crate::agent_sessions::event_pipeline::types::SessionEvent;

use super::{external_replay, schedule_notify, EventStoreState};

/// Set the active session (the default target for commands without an
/// explicit `session_id`). Returns true if a store for the session already
/// exists with events in-memory, false if the caller should load from SQLite.
/// Empty stores are treated as misses so an early switch notification cannot
/// publish an empty snapshot before history hydration.
#[tauri::command]
pub async fn es_switch_session(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: String,
) -> Result<bool, String> {
    let (previous_active, hit, event_count, evicted) = {
        let mut mgr = state
            .session_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous_active = mgr.active_id().map(str::to_string);
        // Serialize old-session prewarm cancellation with its EventStore
        // commit. The commit takes the same manager lock before checking its
        // independent episode ticket, so a late A request cannot write after
        // the active session has switched to B.
        if let Some(previous_active) = previous_active
            .as_deref()
            .filter(|previous_active| *previous_active != session_id)
        {
            external_replay::cancel_prewarm_requests(previous_active);
        }
        let evicted = mgr.set_active(&session_id);
        for evicted_session_id in &evicted {
            external_replay::cancel_prewarm_requests(evicted_session_id);
        }
        let event_count = {
            let stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
            stores
                .get(&session_id)
                .map(|store| store.events().len())
                .unwrap_or(0)
        };
        (previous_active, event_count > 0, event_count, evicted)
    };

    if let Some(previous_active) = previous_active
        .as_deref()
        .filter(|previous_active| *previous_active != session_id)
    {
        external_replay::release_session_runtime(previous_active);
    }

    if !evicted.is_empty() {
        let mut stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
        for sid in &evicted {
            external_replay::release_session_runtime(sid);
            stores.remove(sid);
        }
    }

    if event_count > 0 {
        schedule_notify(&app, &state, &session_id);
    }
    Ok(hit)
}

/// Pin a session (agent running — prevent LRU eviction).
#[tauri::command]
pub async fn es_pin_session(
    state: State<'_, EventStoreState>,
    session_id: String,
) -> Result<(), String> {
    let mut mgr = state
        .session_manager
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    mgr.pin(&session_id);
    Ok(())
}

/// Unpin a session (agent finished).
#[tauri::command]
pub async fn es_unpin_session(
    state: State<'_, EventStoreState>,
    session_id: String,
) -> Result<(), String> {
    let evicted = {
        let mut mgr = state
            .session_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        mgr.unpin(&session_id)
    };
    if !evicted.is_empty() {
        let mut stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
        for sid in &evicted {
            external_replay::release_session_runtime(sid);
            stores.remove(sid);
        }
    }
    Ok(())
}

/// Evict a session from the in-memory cache.
#[tauri::command]
pub async fn es_evict_session(
    state: State<'_, EventStoreState>,
    session_id: String,
) -> Result<(), String> {
    external_replay::release_session_runtime(&session_id);
    {
        let mut mgr = state
            .session_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        mgr.evict(&session_id);
    }
    {
        let mut stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
        stores.remove(&session_id);
    }
    Ok(())
}

/// Buffer events for a (possibly non-active) session's store.
///
/// In the per-session model this is just `append` targeting a specific session —
/// kept under the old name for API compatibility with existing TS callers.
#[tauri::command]
pub async fn es_buffer_events(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: String,
    events: Vec<SessionEvent>,
) -> Result<(), String> {
    let incoming_bytes = state.validate_bounded_replay_input(&session_id, &events)?;
    state.with_store_mut(&session_id, |store| store.append(events));
    state.account_bounded_replay_write(&session_id, incoming_bytes)?;
    schedule_notify(&app, &state, &session_id);
    Ok(())
}
