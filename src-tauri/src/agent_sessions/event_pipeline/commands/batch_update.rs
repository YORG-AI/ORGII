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
        state.enforce_bounded_replay_store_policy(&sid)?;
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
    state.validate_bounded_replay_patch(&sid, &ids, &patch)?;
    let count = state.with_store_mut(&sid, |store| store.patch_by_ids(&ids, &patch));
    if count > 0 {
        state.enforce_bounded_replay_store_policy(&sid)?;
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
    let removed = state.with_store_mut(&sid, |store| store.remove_by_id_prefix(&prefix));
    if removed > 0 {
        state.enforce_bounded_replay_store_policy(&sid)?;
        schedule_notify(&app, &state, &sid);
    }
    Ok(removed)
}

/// Remove frontend-injected user placeholders after the backend user turn arrives.
#[tauri::command]
pub async fn es_remove_synthetic_user_inputs(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
) -> Result<usize, String> {
    let sid = state.resolve_session_id(session_id)?;
    let removed = state.with_store_mut(&sid, |store| store.remove_synthetic_user_inputs());
    if removed > 0 {
        state.enforce_bounded_replay_store_policy(&sid)?;
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
    let incoming_bytes =
        state.validate_bounded_replay_input(&sid, std::slice::from_ref(&new_event))?;
    state.with_store_mut(&sid, |store| {
        store.replace_and_remove(remove_id.as_deref(), new_event);
    });
    state.account_bounded_replay_write(&sid, incoming_bytes)?;
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
    state.validate_bounded_replay_args_merge(&sid, &names_refs, &merge_args)?;
    let result = state.with_store_mut(&sid, |store| {
        store.update_spawning_tool_args(&names_refs, merge_args)
    });
    if result.is_some() {
        state.enforce_bounded_replay_store_policy(&sid)?;
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
