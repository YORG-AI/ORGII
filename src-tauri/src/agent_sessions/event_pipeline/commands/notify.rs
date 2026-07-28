//! Notification Helpers
//!
//! Schedules batched `es:changed` frontend notifications (100ms during
//! streaming, immediate on a flush barrier) and builds the two snapshot wire
//! shapes: the full baseline (`emit_snapshot`'s non-streaming path) and the
//! change-journal-only streaming delta (`build_streaming_snapshot_delta`).

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_sessions::event_pipeline::derived::compute_derived;
use crate::agent_sessions::event_pipeline::payload_compaction::compact_event_for_snapshot;
use crate::agent_sessions::event_pipeline::store::EventStore;
use crate::agent_sessions::event_pipeline::types::{SnapshotDelta, SnapshotEventMembership};

use super::EventStoreState;

const NOTIFY_EVENT_NAME: &str = "es:changed";
/// Ten incremental updates per second keeps text/tool streaming responsive
/// without waking Rust, WebView serialization and React ~30 times a second.
const STREAMING_BATCH_MS: u64 = 100;

/// Tauri `es:changed` payload wrapper. The `sessionId` is always present so
/// frontend listeners can route to the correct per-session subscriber.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEnvelope<T: Serialize> {
    session_id: String,
    #[serde(flatten)]
    snapshot: T,
}

/// Schedule a frontend notification for `session_id`. During streaming,
/// batches at `STREAMING_BATCH_MS` intervals per-session.
pub(crate) fn schedule_notify(app: &AppHandle, state: &EventStoreState, session_id: &str) {
    let streaming = state
        .with_store_opt(session_id, EventStore::is_streaming)
        .unwrap_or(false);

    if streaming {
        let mut pending = state
            .notify_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !pending.insert(session_id.to_string()) {
            return;
        }
        let app_handle = app.clone();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(STREAMING_BATCH_MS)).await;
            let state = app_handle.state::<EventStoreState>();
            let should_emit = {
                let mut pending = state
                    .notify_pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                pending.remove(&sid)
            };
            if should_emit {
                emit_snapshot(&app_handle, &state, &sid);
            }
        });
    } else {
        // A terminal/non-streaming update is a flush barrier. Cancel the
        // delayed streaming callback before emitting the final state so the
        // old timer cannot wake and serialize a redundant no-op delta later.
        state
            .notify_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
        emit_snapshot(app, state, session_id);
    }
}

/// Build the live-turn wire update from EventStore's change journal only.
///
/// A full baseline is emitted once before this path is used. Each subsequent
/// batch compacts only the changed events and tells the frontend how those
/// events participate in the four ordered projections. The frontend already
/// owns a normalized baseline, so serializing every historical event/id/map
/// again would be pure duplicate work.
pub(super) fn build_streaming_snapshot_delta(store: &mut EventStore) -> SnapshotDelta {
    use crate::agent_sessions::event_pipeline::derived::{
        is_visible_in_chat, is_visible_in_messages, is_visible_in_simulator,
    };

    let version = store.version();
    let event_count = store.event_count();
    let (base_version, mut changed_ids, removed_ids) = store.take_delta_tracking();
    changed_ids.sort_by_key(|id| store.event_position(id).unwrap_or(usize::MAX));

    let mut upserts = Vec::with_capacity(changed_ids.len());
    let mut memberships = Vec::with_capacity(changed_ids.len());
    for id in changed_ids {
        let Some(event_index) = store.event_position(&id) else {
            continue;
        };
        let Some(event) = store.get_by_id(&id) else {
            continue;
        };
        memberships.push(SnapshotEventMembership {
            id: id.clone(),
            event_index,
            chat: is_visible_in_chat(event),
            messages: is_visible_in_messages(event),
            simulator: is_visible_in_simulator(event),
        });
        upserts.push(compact_event_for_snapshot(event));
    }

    SnapshotDelta {
        version,
        base_version,
        event_count,
        upserts,
        removed_ids,
        last_event_id: store.last_event().map(|event| event.id.clone()),
        snapshot_delta: true,
        incremental_orders: true,
        memberships,
        streaming: true,
        ..SnapshotDelta::default()
    }
}

fn emit_snapshot(app: &AppHandle, state: &EventStoreState, session_id: &str) {
    use crate::agent_sessions::event_pipeline::derived::{
        build_simulator_preview_indexes, is_visible_in_chat, is_visible_in_messages,
        is_visible_in_simulator, latest_canvas_preview, sort_simulator_events,
    };
    use crate::agent_sessions::event_pipeline::types::EventDisplayStatus;

    let mut stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
    let Some(store) = stores.get_mut(session_id) else {
        return;
    };
    if store.should_emit_full_snapshot() {
        let derived = compute_derived(store.events(), store.version());
        let envelope = SnapshotEnvelope {
            session_id: session_id.to_string(),
            snapshot: derived,
        };
        // Only mark the full snapshot as emitted when the emit actually
        // succeeded; otherwise we'd silently drop the baseline and the
        // frontend would never receive a full snapshot for this version.
        if app.emit(NOTIFY_EVENT_NAME, &envelope).is_ok() {
            store.mark_full_snapshot_emitted();
        }
        crate::infrastructure::main_runloop::wake_main_runloop();
        return;
    }

    if store.is_streaming() {
        let snapshot = build_streaming_snapshot_delta(store);
        let envelope = SnapshotEnvelope {
            session_id: session_id.to_string(),
            snapshot,
        };
        app.emit(NOTIFY_EVENT_NAME, &envelope).ok();
        crate::infrastructure::main_runloop::wake_main_runloop();
        return;
    }

    let version = store.version();
    let event_count = store.event_count();
    let (base_version, changed_ids, removed_ids) = store.take_delta_tracking();
    let events = store.events();
    let changed_id_set = changed_ids.iter().collect::<std::collections::HashSet<_>>();
    let upserts = events
        .iter()
        .filter(|event| changed_id_set.contains(&event.id))
        .map(compact_event_for_snapshot)
        .collect::<Vec<_>>();
    let event_ids = events
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    let mut chat_event_ids = Vec::with_capacity(events.len() / 2);
    let mut messages_event_ids = Vec::with_capacity(events.len() / 2);
    let mut simulator_preview_events = Vec::with_capacity(events.len() / 2);
    let mut has_running_event = false;
    for event in events {
        if event.display_status == EventDisplayStatus::Running {
            has_running_event = true;
        }
        if is_visible_in_chat(event) {
            chat_event_ids.push(event.id.clone());
        }
        if is_visible_in_messages(event) {
            messages_event_ids.push(event.id.clone());
        }
        if is_visible_in_simulator(event) {
            simulator_preview_events.push(compact_event_for_snapshot(event));
        }
    }
    sort_simulator_events(&mut simulator_preview_events);
    let preview_indexes = build_simulator_preview_indexes(&simulator_preview_events);
    let latest_canvas_preview = latest_canvas_preview(events);
    let chat_event_count = chat_event_ids.len();
    let snapshot = SnapshotDelta {
        version,
        base_version,
        event_count,
        upserts,
        removed_ids,
        event_ids,
        chat_event_ids,
        messages_event_ids,
        sorted_simulator_event_ids: preview_indexes.sorted_simulator_event_ids,
        event_preview_by_id: preview_indexes.event_preview_by_id,
        created_at_by_id: preview_indexes.created_at_by_id,
        thread_id_by_id: preview_indexes.thread_id_by_id,
        function_name_by_id: preview_indexes.function_name_by_id,
        display_status_by_id: preview_indexes.display_status_by_id,
        display_variant_by_id: preview_indexes.display_variant_by_id,
        last_event_id: store.last_event().map(|event| event.id.clone()),
        chat_event_count,
        has_running_event,
        latest_canvas_preview,
        snapshot_delta: true,
        incremental_orders: false,
        memberships: Vec::new(),
        streaming: false,
    };
    let envelope = SnapshotEnvelope {
        session_id: session_id.to_string(),
        snapshot,
    };
    app.emit(NOTIFY_EVENT_NAME, &envelope).ok();
    crate::infrastructure::main_runloop::wake_main_runloop();
}
