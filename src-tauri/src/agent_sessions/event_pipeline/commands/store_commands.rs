//! Store Commands
//!
//! Core EventStore operations: set, append, upsert, merge, streaming mode.
//!
//! Every write command accepts an optional `session_id`. When omitted, the
//! active session (tracked by `SessionStoreManager`) is the target — this
//! preserves the original "single active session" behaviour for unmigrated
//! callers while enabling multi-session writes for new callers.

use tauri::{AppHandle, State};

use crate::agent_sessions::event_pipeline::ingestion::function_map::resolve_ui_canonical;
use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventSource, SessionEvent, SessionEventPatch,
};

use super::event_conversion::normalize_event_record_value;
use super::{schedule_notify, EventStoreState};

fn normalize_event_records(event: &mut SessionEvent) {
    event.args = normalize_event_record_value(std::mem::take(&mut event.args));
    event.result = normalize_event_record_value(std::mem::take(&mut event.result));
}

fn normalize_events(events: &mut [SessionEvent]) {
    for event in events {
        normalize_event_records(event);
    }
}

fn is_synthetic_user_input(event: &SessionEvent) -> bool {
    event.source == EventSource::User
        && event.function_name == "user_message"
        && event
            .result
            .get("syntheticUserInput")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
}

/// Set the active repository context on a session's store.
#[tauri::command]
pub async fn es_set_repo_context(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    repo_id: Option<String>,
    repo_path: Option<String>,
) -> Result<(), String> {
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| {
        store.set_repo_context(repo_id, repo_path);
    });
    Ok(())
}

/// Replace all events (session load).
#[tauri::command]
pub async fn es_set(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    mut events: Vec<SessionEvent>,
) -> Result<(), String> {
    normalize_events(&mut events);
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| store.set(events));
    schedule_notify(&app, &state, &sid);
    Ok(())
}

/// Append events (deduped by ID).
///
/// Backfills empty `ui_canonical` fields from the static alias map,
/// matching the guarantee provided by `es_upsert`.
///
/// User-authored events (source = "user") are written through to SQLite
/// **synchronously** (i.e. the spawn_blocking write completes before this
/// command returns) so that any caller awaiting `eventStoreProxy.append`
/// can rely on the row being queryable from SQLite immediately afterwards.
///
/// This is critical for the edit/regenerate path: `useEditUserMessage`
/// truncates at the edited message and resubmits, and the truncate looks
/// up the target event by id in the `events` table.
#[tauri::command]
pub async fn es_append(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    mut events: Vec<SessionEvent>,
) -> Result<(), String> {
    use super::event_conversion::{is_ts_placeholder_id, session_event_to_cached_event};
    use super::{save_events_retry, BULK_WRITE_MAX_RETRIES};

    for event in &mut events {
        if event.ui_canonical.is_empty() {
            event.ui_canonical = resolve_ui_canonical(&event.function_name);
        }
        normalize_event_records(event);
    }
    let sid = state.resolve_session_id(session_id)?;

    // Persist user-authored events so the truncate-on-edit path can locate
    // them by ID. Non-user events appended via es_append are UI-only
    // (streaming deltas, placeholders) and must NOT be written to SQLite
    // here — they are either already persisted by push_events_to_session
    // or are transient.
    //
    // Sessions whose transcript of record lives elsewhere (managed CLI
    // sessions replay chunks / the CLI's native store; imported histories
    // replay their source files) must never gain `events` rows: the copies
    // only resurface as duplicate user bubbles on the next replay merge.
    // Their edit path (`cli_agent_truncate_after_chunk`) truncates chunks by
    // timestamp and does not consult the `events` table.
    let user_events: Vec<_> = if session_providers::skips_event_cache_save(&sid) {
        Vec::new()
    } else {
        events
            .iter()
            .filter(|event| {
                event.source == EventSource::User
                    && !is_ts_placeholder_id(&event.id)
                    && !is_synthetic_user_input(event)
            })
            .map(session_event_to_cached_event)
            .collect()
    };

    state.with_store_mut(&sid, |store| store.append(events));
    schedule_notify(&app, &state, &sid);

    if !user_events.is_empty() {
        let persist_sid = sid.clone();
        // Keep append UI-first: the EventStore has already been updated in memory
        // and listeners have been notified. SQLite cache write-through is still
        // attempted synchronously for edit/regenerate lookup freshness, but a
        // transient writer lock must not crash the rendered app or roll back the
        // visible user turn.
        let persist_result = tokio::task::spawn_blocking(move || {
            save_events_retry(
                "es_append_user",
                &persist_sid,
                &user_events,
                BULK_WRITE_MAX_RETRIES,
            )
        })
        .await
        .map_err(|err| format!("es_append spawn_blocking join failed: {err}"));

        match persist_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::warn!(
                    "[event-pipeline] best-effort es_append_user failed for {sid}: {err}"
                );
            }
            Err(err) => {
                tracing::warn!("[event-pipeline] es_append_user join failed for {sid}: {err}");
            }
        }
    }

    Ok(())
}

/// Upsert a single event (update or insert).
#[tauri::command]
pub async fn es_upsert(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    mut event: SessionEvent,
) -> Result<(), String> {
    if event.ui_canonical.is_empty() {
        event.ui_canonical = resolve_ui_canonical(&event.function_name);
    }
    normalize_event_records(&mut event);
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| store.upsert(event));
    schedule_notify(&app, &state, &sid);
    Ok(())
}

/// Update a single event by ID with a partial patch.
#[tauri::command]
pub async fn es_update_by_id(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    id: String,
    patch: SessionEventPatch,
) -> Result<bool, String> {
    let sid = state.resolve_session_id(session_id)?;
    let found = state.with_store_mut(&sid, |store| store.update_by_id(&id, &patch));
    if found {
        schedule_notify(&app, &state, &sid);
    }
    Ok(found)
}

/// Merge tool_result events into their matching tool_call events (pure transform).
///
/// Uses O(1) HashMap lookup instead of the TS-side O(n) `findIndex`.
/// Does NOT store events — returns the merged array for the caller to use.
#[tauri::command]
pub async fn es_merge_tool_results(
    mut events: Vec<SessionEvent>,
) -> Result<Vec<SessionEvent>, String> {
    normalize_events(&mut events);
    let mut call_id_index: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut result: Vec<SessionEvent> = Vec::with_capacity(events.len());

    for event in events {
        if event.action_type == "tool_result" {
            if let Some(ref call_id) = event.call_id {
                if let Some(&idx) = call_id_index.get(call_id) {
                    result[idx].result = event.result;
                    result[idx].activity_status = ActivityStatus::Processed;
                    result[idx].display_status = EventDisplayStatus::Completed;
                    continue;
                }
            }
        }
        if event.action_type == "tool_call" {
            if let Some(ref call_id) = event.call_id {
                call_id_index.insert(call_id.clone(), result.len());
            }
        }
        result.push(event);
    }

    Ok(result)
}

/// Merge incoming events (tool_result → tool_call, dedup, append new).
#[tauri::command]
pub async fn es_merge_events(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    mut events: Vec<SessionEvent>,
) -> Result<(), String> {
    normalize_events(&mut events);
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| store.merge_events(events));
    schedule_notify(&app, &state, &sid);
    Ok(())
}

#[tauri::command]
pub async fn es_merge_round_window_events(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    mut events: Vec<SessionEvent>,
) -> Result<(), String> {
    normalize_events(&mut events);
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| store.merge_round_window_events(events));
    schedule_notify(&app, &state, &sid);
    Ok(())
}

/// Set streaming mode on/off.
#[tauri::command]
pub async fn es_set_streaming(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    streaming: bool,
) -> Result<(), String> {
    let sid = match state.resolve_session_id(session_id) {
        Ok(sid) => sid,
        Err(err) if err == "no active session and no explicit sessionId provided" => {
            tracing::debug!(
                "[EventStore] Ignoring streaming={} update without an active session",
                streaming
            );
            return Ok(());
        }
        Err(err) => return Err(err),
    };
    state.with_store_mut(&sid, |store| store.set_streaming(streaming));
    if !streaming {
        schedule_notify(&app, &state, &sid);
    }
    Ok(())
}

/// Clear all events from a session's store.
#[tauri::command]
pub async fn es_clear(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
) -> Result<(), String> {
    let sid = state.resolve_session_id(session_id)?;
    state.with_store_mut(&sid, |store| store.clear());
    schedule_notify(&app, &state, &sid);
    Ok(())
}

/// Keep only events strictly before the event with the given ID.
#[tauri::command]
pub async fn es_truncate_before_id(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    event_id: String,
) -> Result<bool, String> {
    let sid = state.resolve_session_id(session_id)?;
    let found = state.with_store_mut(&sid, |store| store.truncate_before_id(&event_id));
    if found {
        let persist_sid = sid.clone();
        let persist_event_id = event_id.clone();
        tokio::task::spawn_blocking(move || {
            session_persistence::truncate_after_event(&persist_sid, &persist_event_id)
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
        schedule_notify(&app, &state, &sid);
    }
    Ok(found)
}
