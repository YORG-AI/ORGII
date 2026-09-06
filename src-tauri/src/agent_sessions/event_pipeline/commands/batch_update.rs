//! Batch Update Commands
//!
//! Bulk operations: complete last running, patch by IDs, remove by prefix,
//! replace and remove, and update task args.
//!
//! All commands accept an optional `session_id`. When omitted, the active
//! session is targeted.

use tauri::{AppHandle, State};

use crate::agent_sessions::event_pipeline::types::{SessionEvent, SessionEventPatch};

use super::{schedule_notify, EventStoreState};

/// Complete the last running event (mark as completed).
#[tauri::command]
pub async fn es_complete_last_running(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
) -> Result<Option<String>, String> {
    let sid = state.resolve_session_id(session_id)?;
    let result = state.with_store_mut(&sid, |store| store.complete_last_running());
    if result.is_some() {
        schedule_notify(&app, &state, &sid);
    }
    Ok(result)
}

/// Batch-update multiple events by IDs with the same patch.
#[tauri::command]
pub async fn es_patch_by_ids(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    ids: Vec<String>,
    patch: SessionEventPatch,
) -> Result<usize, String> {
    let sid = state.resolve_session_id(session_id)?;
    let count = state.with_store_mut(&sid, |store| store.patch_by_ids(&ids, &patch));
    if count > 0 {
        schedule_notify(&app, &state, &sid);
    }
    Ok(count)
}

/// Remove events whose IDs start with a given prefix.
#[tauri::command]
pub async fn es_remove_by_id_prefix(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    prefix: String,
) -> Result<usize, String> {
    let sid = state.resolve_session_id(session_id)?;
    let removed_ids = state
        .with_store_opt(&sid, |store| {
            store
                .events()
                .iter()
                .filter(|event| event.id.starts_with(&prefix))
                .map(|event| event.id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !removed_ids.is_empty() {
        let persist_sid = sid.clone();
        let persisted_ids = removed_ids.clone();
        tokio::task::spawn_blocking(move || {
            session_persistence::delete_events_by_ids(&persist_sid, &persisted_ids)
                .map(|_| ())
                .map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| format!("es_remove_by_id_prefix worker failed: {err}"))??;
    }
    let removed = state.with_store_mut(&sid, |store| store.remove_by_ids(&removed_ids));
    if removed > 0 {
        schedule_notify(&app, &state, &sid);
    }
    Ok(removed)
}

/// Remove frontend-injected user placeholders after the backend user turn arrives.
/// Intent-bearing placeholders are removed only by their matching durable
/// turn id. Legacy placeholders use `matching_contents` + `older_than`.
/// Omit the whole scope to remove every placeholder in the session.
#[tauri::command]
pub async fn es_remove_synthetic_user_inputs(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    matching_contents: Option<Vec<String>>,
    matching_turn_intent_ids: Option<Vec<String>>,
    older_than: Option<String>,
) -> Result<usize, String> {
    let sid = state.resolve_session_id(session_id)?;
    let removed = state.with_store_mut(&sid, |store| {
        let is_scoped = matching_contents.is_some()
            || matching_turn_intent_ids.is_some()
            || older_than.is_some();
        store.remove_synthetic_user_inputs(is_scoped.then(|| {
            (
                matching_contents.as_deref().unwrap_or_default(),
                matching_turn_intent_ids.as_deref().unwrap_or_default(),
                older_than.as_deref(),
            )
        }))
    });
    if removed > 0 {
        schedule_notify(&app, &state, &sid);
    }
    Ok(removed)
}

/// Atomically remove one event and upsert another.
/// Used for stream finalization (remove streaming placeholder, insert final).
#[tauri::command]
pub async fn es_replace_and_remove(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    remove_id: Option<String>,
    new_event: SessionEvent,
) -> Result<bool, String> {
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| {
        store.replace_and_remove(remove_id.as_deref(), new_event);
    });
    schedule_notify(&app, &state, &sid);
    Ok(true)
}

/// Update args on the last active spawning tool_call (task, session, spawn, Task).
#[tauri::command]
pub async fn es_update_active_task_args(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    merge_args: serde_json::Value,
    function_names: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let sid = state.resolve_session_id(session_id)?;
    let default_names = vec!["task".to_string()];
    let names = function_names.unwrap_or(default_names);
    let names_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
    let result = state.with_store_mut(&sid, |store| {
        store.update_spawning_tool_args(&names_refs, merge_args)
    });
    if result.is_some() {
        schedule_notify(&app, &state, &sid);
    }
    Ok(result)
}

/// Check if there is an active spawning tool_call in the store.
#[tauri::command]
pub async fn es_has_active_task(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    function_names: Option<Vec<String>>,
) -> Result<bool, String> {
    let sid = state.resolve_session_id(session_id)?;
    let default_names = vec!["task".to_string()];
    let names = function_names.unwrap_or(default_names);
    let names_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
    Ok(state
        .with_store_opt(&sid, |store| store.has_active_spawning_tool(&names_refs))
        .unwrap_or(false))
}
