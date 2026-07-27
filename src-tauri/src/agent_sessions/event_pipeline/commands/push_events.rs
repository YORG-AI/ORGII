//! Push-events write path.
//!
//! `push_events_to_session` is the single funnel `UnifiedEventHandler`
//! (parent) and `UnifiedSubagentHandler` (child) push every `SessionEvent`
//! through: merge into the in-memory store, persist the canonical post-merge
//! rows to SQLite (fire-and-forget), and schedule a frontend notification.
//! The two `update_*_with_persist` helpers are the write-through counterparts
//! of in-memory-only `EventStore` patches (subagent linkage stamps) that must
//! survive a session reload.

use std::collections::HashSet;

use core_types::extracted::ExtractedData;
use tauri::AppHandle;

use crate::agent_sessions::event_pipeline::types::SessionEvent;

use super::event_conversion;
use super::{
    persist_events_with_retry, persist_runtime_orgtrack_records_async, schedule_notify,
    EventStoreState, BULK_WRITE_MAX_RETRIES, CRITICAL_WRITE_MAX_RETRIES,
};

const ACTION_TYPE_TOOL_CALL: &str = "tool_call";
const ACTION_TYPE_TOOL_RESULT: &str = "tool_result";

pub(super) fn collect_post_merge_persistable_events(
    events: &[SessionEvent],
    incoming_event_ids: &HashSet<String>,
    result_call_ids: &HashSet<String>,
) -> Vec<SessionEvent> {
    events
        .iter()
        .filter(|event| {
            incoming_event_ids.contains(&event.id)
                || event.call_id.as_ref().is_some_and(|call_id| {
                    event.action_type == ACTION_TYPE_TOOL_CALL && result_call_ids.contains(call_id)
                })
        })
        // Preserve EventStore timeline order. SQLite assigns missing
        // history_sequence values in this exact iteration order.
        .cloned()
        .collect()
}

/// Push live events into any session's store from Rust-side code (no Tauri
/// command round-trip). Callers: `UnifiedEventHandler` (parent) and
/// `UnifiedSubagentHandler` (child) — both funnel every SessionEvent they
/// produce through this single write path.
///
/// After merging into the in-memory store, non-placeholder events are
/// persisted to the `events` SQLite table via `spawn_blocking` (fire-and-
/// forget). This write-through means interrupted sessions keep their
/// history even if `broadcast_complete` / the 30s frontend timer never run.
pub fn push_events_to_session(
    app: &AppHandle,
    state: &EventStoreState,
    session_id: &str,
    events: Vec<SessionEvent>,
) {
    if events.is_empty() {
        return;
    }

    let result_call_ids: HashSet<String> = events
        .iter()
        .filter(|event| event.action_type == ACTION_TYPE_TOOL_RESULT)
        .filter_map(|event| event.call_id.clone())
        .collect();
    let incoming_event_ids: HashSet<String> = events
        .iter()
        .filter(|event| !event_conversion::is_ts_placeholder_id(&event.id))
        .map(|event| event.id.clone())
        .collect();

    let (persistable_events, merged_tool_calls) = state.with_store_mut(session_id, |store| {
        store.merge_events(events);
        let mut current_turn_id: Option<String> = None;
        let mut matched = Vec::new();
        for (sequence_index, event) in store.events().iter().enumerate() {
            if event.function_name == "user_message"
                && event
                    .result
                    .get("syntheticUserInput")
                    .and_then(|value| value.as_bool())
                    != Some(true)
            {
                current_turn_id = Some(event.id.clone());
            }
            if event.action_type == ACTION_TYPE_TOOL_CALL
                && event
                    .call_id
                    .as_ref()
                    .is_some_and(|call_id| result_call_ids.contains(call_id))
            {
                matched.push((sequence_index, current_turn_id.clone(), event.clone()));
            }
        }

        // Persist the canonical post-merge rows, not the raw incoming values.
        // This is what makes first-insert replay bookmarks survive same-ID
        // updates and avoids writing a second shell-output copy on the raw
        // tool_result row.
        let persistable = collect_post_merge_persistable_events(
            store.events(),
            &incoming_event_ids,
            &result_call_ids,
        );
        (persistable, matched)
    });

    let persistable = persistable_events
        .iter()
        .map(event_conversion::session_event_to_cached_event)
        .collect::<Vec<_>>();

    let mut runtime_artifact_events = Vec::new();
    for (sequence_index, turn_id, event) in merged_tool_calls {
        if event_conversion::is_ts_placeholder_id(&event.id) {
            continue;
        }
        if matches!(
            event.extracted,
            Some(
                ExtractedData::File(_)
                    | ExtractedData::Edit(_)
                    | ExtractedData::Search(_)
                    | ExtractedData::DeleteFile(_)
            )
        ) {
            runtime_artifact_events.push((sequence_index, turn_id, event.clone()));
        }
    }

    if !runtime_artifact_events.is_empty() {
        persist_runtime_orgtrack_records_async(
            app.clone(),
            session_id.to_string(),
            runtime_artifact_events,
        );
    }

    schedule_notify(app, state, session_id);

    if !persistable.is_empty() {
        persist_events_with_retry(
            "push_events",
            session_id.to_string(),
            persistable,
            BULK_WRITE_MAX_RETRIES,
        );
    }
}

/// Merge `merge_args` into the last still-running spawning tool_call event
/// (matching any of `function_names`) and persist the updated event to SQLite.
///
/// This is the write-through counterpart of `EventStore::update_spawning_tool_args`.
/// In-memory patches that are never written back (e.g. stamping
/// `subagentSessionId` onto the parent's `agent` tool_call event at spawn time)
/// would otherwise be lost on session reload: the SQLite copy still has the
/// pre-patch args, so re-opened sessions would show subagent blocks with no
/// child-session trajectory. Callers that need the patch to survive reload
/// (subagent linkage, elapsed-time stamping) should use this helper instead
/// of calling `update_spawning_tool_args` directly.
///
/// Returns the event id of the patched event when one was found.
pub fn update_spawning_tool_args_with_persist(
    app: &AppHandle,
    state: &EventStoreState,
    session_id: &str,
    function_names: &[&str],
    merge_args: serde_json::Value,
) -> Option<String> {
    let updated = state.with_store_mut(session_id, |store| {
        let id = store.update_spawning_tool_args(function_names, merge_args)?;
        store.get_by_id(&id).cloned().map(|event| (id, event))
    });

    let (event_id, event) = updated?;

    schedule_notify(app, state, session_id);

    if !event_conversion::is_ts_placeholder_id(&event.id) {
        let cached = event_conversion::session_event_to_cached_event(&event);
        persist_events_with_retry(
            "spawning-tool",
            session_id.to_string(),
            vec![cached],
            CRITICAL_WRITE_MAX_RETRIES,
        );
    }

    Some(event_id)
}

/// Like `update_spawning_tool_args_with_persist` but targets a specific
/// tool_call event by its LLM-assigned `call_id` instead of the ambiguous
/// "last running spawning tool" heuristic.
///
/// Required for parallel `background: true` subagent launches so each
/// handler stamps its own parent event.
pub fn update_tool_args_by_call_id_with_persist(
    app: &AppHandle,
    state: &EventStoreState,
    session_id: &str,
    call_id: &str,
    merge_args: serde_json::Value,
) -> Option<String> {
    let updated = state.with_store_mut(session_id, |store| {
        let id = store.update_tool_args_by_call_id(call_id, merge_args)?;
        store.get_by_id(&id).cloned().map(|event| (id, event))
    });

    let (event_id, event) = updated?;

    schedule_notify(app, state, session_id);

    if !event_conversion::is_ts_placeholder_id(&event.id) {
        let cached = event_conversion::session_event_to_cached_event(&event);
        persist_events_with_retry(
            "call-id",
            session_id.to_string(),
            vec![cached],
            CRITICAL_WRITE_MAX_RETRIES,
        );
    }

    Some(event_id)
}
