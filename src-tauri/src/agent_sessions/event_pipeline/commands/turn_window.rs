//! Turn-window Tauri commands and supporting types.
//!
//! Handles loading, building, and unloading paginated turn windows for
//! long-running sessions. Turn windows allow the UI to render only the
//! relevant slice of events without loading the entire session history.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};
use session_persistence as sqlite_cache;

use super::{
    event_conversion::cached_event_to_session_event, prepare_loaded_events, schedule_notify,
    EventStoreState,
};

const DEFAULT_RECENT_TURN_BODY_COUNT: usize = 1;

// ============================================================================
// Turn Window Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnBodyWindow {
    pub turn_id: String,
    pub events: Vec<SessionEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInitialTurnWindow {
    pub turns: Vec<sqlite_cache::CachedTurnSummary>,
    pub events: Vec<SessionEvent>,
}

// ============================================================================
// Turn Window Helpers
// ============================================================================

fn normalize_turn_user_preview(preview: &str) -> String {
    let preview = preview.trim();
    preview
        .strip_prefix("user_message ")
        .or_else(|| preview.strip_prefix("user "))
        .unwrap_or(preview)
        .trim()
        .to_string()
}

fn turn_user_preview_text(turn: &sqlite_cache::CachedTurnSummary) -> String {
    normalize_turn_user_preview(&turn.user_preview)
}

fn turn_has_user_header(
    turn: &sqlite_cache::CachedTurnSummary,
    present_event_ids: &HashSet<String>,
) -> bool {
    present_event_ids.contains(&turn.turn_id)
        || turn
            .user_event_ids
            .iter()
            .any(|event_id| present_event_ids.contains(event_id))
}

fn make_turn_user_header_event(
    session_id: &str,
    turn: &sqlite_cache::CachedTurnSummary,
) -> SessionEvent {
    let display_text = turn_user_preview_text(turn);
    let result = serde_json::json!({
        "syntheticTurnHeader": true,
        "type": "user",
        "message": {
            "content": display_text,
            "role": "user",
        },
    });

    let mut event = SessionEvent {
        id: turn.turn_id.clone(),
        chunk_id: Some(turn.turn_id.clone()),
        session_id: session_id.to_string(),
        created_at: turn.started_at.clone(),
        function_name: "user_message".to_string(),
        ui_canonical: "user_message".to_string(),
        action_type: "raw".to_string(),
        args: serde_json::json!({}),
        result,
        source: EventSource::User,
        display_text,
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

fn make_turn_placeholder_event(
    session_id: &str,
    turn: &sqlite_cache::CachedTurnSummary,
) -> SessionEvent {
    let event_count = turn.body_event_count.max(0);
    let duration_ms = turn.duration_ms.unwrap_or(0).max(0);
    let result = serde_json::json!({
        "unloadedTurn": {
            "turnId": turn.turn_id,
            "eventCount": event_count,
            "bodyEventCount": event_count,
            "durationMs": duration_ms,
            "startedAt": turn.started_at,
            "endedAt": turn.ended_at,
            "nextTurnId": turn.next_turn_id,
        },
    });

    let mut event = SessionEvent {
        id: format!("turn-placeholder-{}", turn.turn_id),
        chunk_id: Some(format!("turn-placeholder-{}", turn.turn_id)),
        session_id: session_id.to_string(),
        created_at: turn
            .ended_at
            .clone()
            .unwrap_or_else(|| turn.started_at.clone()),
        function_name: "turn_placeholder".to_string(),
        ui_canonical: "turn_placeholder".to_string(),
        action_type: "turn_placeholder".to_string(),
        args: serde_json::json!({}),
        result,
        source: EventSource::Assistant,
        display_text: format!("Turn {} is not loaded yet.", turn.turn_id),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

// ============================================================================
// Turn Window Commands
// ============================================================================

#[tauri::command]
pub async fn cache_load_session_turn_body(
    session_id: String,
    turn_id: String,
) -> Result<SessionTurnBodyWindow, String> {
    session_providers::reject_bounded_replay_full_load(&session_id)?;
    let sid = session_id.clone();
    let tid = turn_id.clone();
    let window =
        tokio::task::spawn_blocking(move || sqlite_cache::load_turn_body_window(&sid, &tid))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;

    let events: Vec<SessionEvent> = window
        .events
        .iter()
        .map(cached_event_to_session_event)
        .collect();
    let events = prepare_loaded_events(&session_id, events);

    Ok(SessionTurnBodyWindow {
        turn_id: window.turn_id,
        events,
    })
}

pub(super) async fn load_initial_turn_window_events(
    session_id: &str,
    recent_turn_count: Option<usize>,
) -> Result<SessionInitialTurnWindow, String> {
    session_providers::reject_bounded_replay_full_load(session_id)?;
    let sid = session_id.to_string();
    let recent_count = recent_turn_count.unwrap_or(DEFAULT_RECENT_TURN_BODY_COUNT);
    let window = tokio::task::spawn_blocking(move || {
        sqlite_cache::load_initial_turn_window(&sid, recent_count)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let recent_start = window.turns.len().saturating_sub(recent_count);
    let recent_turn_ids = window.turns[recent_start..]
        .iter()
        .map(|turn| turn.turn_id.as_str())
        .collect::<HashSet<_>>();

    let mut events: Vec<SessionEvent> = window
        .events
        .iter()
        .map(cached_event_to_session_event)
        .collect();
    let present_event_ids: HashSet<String> = events.iter().map(|event| event.id.clone()).collect();
    events.extend(
        window
            .turns
            .iter()
            .filter(|turn| !turn_has_user_header(turn, &present_event_ids))
            .map(|turn| make_turn_user_header_event(session_id, turn)),
    );
    events.extend(
        window.turns[..recent_start]
            .iter()
            .filter(|turn| !recent_turn_ids.contains(turn.turn_id.as_str()))
            .filter(|turn| turn.body_event_count > 0)
            .map(|turn| make_turn_placeholder_event(session_id, turn)),
    );
    events.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let events = prepare_loaded_events(session_id, events);

    Ok(SessionInitialTurnWindow {
        turns: window.turns,
        events,
    })
}

#[tauri::command]
pub async fn cache_load_session_initial_turn_window(
    session_id: String,
    recent_turn_count: Option<usize>,
) -> Result<SessionInitialTurnWindow, String> {
    load_initial_turn_window_events(&session_id, recent_turn_count).await
}

#[tauri::command]
pub async fn es_load_initial_turn_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: String,
    recent_turn_count: Option<usize>,
) -> Result<usize, String> {
    let window = load_initial_turn_window_events(&session_id, recent_turn_count).await?;
    let count = window.events.len();
    state.with_store_mut(&session_id, |store| {
        store.set_round_window(window.events);
        store.repair_subagent_links();
    });
    schedule_notify(&app, &state, &session_id);
    Ok(count)
}

#[tauri::command]
pub async fn es_unload_turn_body(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    session_id: String,
    turn_id: String,
) -> Result<usize, String> {
    session_providers::reject_bounded_replay_full_load(&session_id)?;
    let lookup_sid = session_id.clone();
    let lookup_turn_id = turn_id.clone();
    let persisted_turn =
        tokio::task::spawn_blocking(move || sqlite_cache::load_turn_index(&lookup_sid))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|summary| summary.turn_id == lookup_turn_id);
    let turn = match persisted_turn {
        Some(turn) => turn,
        None => crate::orgtrack::history_commands::orgtrack_session_turn_metadata_index(
            session_id.clone(),
            Some(vec![turn_id.clone()]),
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| format!("turn not found: {turn_id}"))?,
    };

    let placeholder = make_turn_placeholder_event(&session_id, &turn);
    let removed = state.with_store_mut(&session_id, |store| {
        store.unload_turn_body(&turn_id, placeholder)
    });
    if removed > 0 {
        schedule_notify(&app, &state, &session_id);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::{normalize_turn_user_preview, session_providers};

    #[test]
    fn imported_user_alias_is_removed_from_placeholder_preview() {
        assert_eq!(normalize_turn_user_preview("user hello"), "hello");
        assert_eq!(
            normalize_turn_user_preview("user_message native hello"),
            "native hello"
        );
    }

    #[test]
    fn unload_turn_body_rpc_boundary_rejects_bounded_replay_sessions() {
        assert!(session_providers::reject_bounded_replay_full_load("cliagent-managed").is_err());
        assert!(session_providers::reject_bounded_replay_full_load("codexapp-fixture").is_err());
        assert!(session_providers::reject_bounded_replay_full_load("sdeagent-native").is_ok());
    }
}
