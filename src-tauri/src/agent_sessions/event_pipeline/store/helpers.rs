//! Pure free functions used by EventStore internals.
//!
//! These helpers operate on `SessionEvent` slices and values but hold no
//! store state themselves, making them easy to test in isolation.

use std::collections::HashSet;

use crate::agent_sessions::event_pipeline::types::{
    EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

pub(super) const MAX_EVENTS: usize = 8000;
pub(super) const TURN_PLACEHOLDER_FUNCTION_NAME: &str = "turn_placeholder";
pub(super) const TURN_PLACEHOLDER_ID_PREFIX: &str = "turn-placeholder-";

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

pub(super) fn is_synthetic_transcript_placeholder(event: &SessionEvent) -> bool {
    event
        .result
        .get("syntheticUserInput")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub(super) fn transcript_text(event: &SessionEvent) -> Option<String> {
    let display_text = event.display_text.trim();
    if !display_text.is_empty() {
        return Some(display_text.to_string());
    }

    event
        .result
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|value| value.as_str())
        .or_else(|| event.result.get("content").and_then(|value| value.as_str()))
        .or_else(|| {
            event
                .result
                .get("observation")
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn transcript_message_key(event: &SessionEvent) -> Option<(EventSource, String)> {
    match event.source {
        EventSource::User | EventSource::Assistant => {
            transcript_text(event).map(|text| (event.source.clone(), text))
        }
        _ => None,
    }
}

/// Mirror of the frontend's `normalizeUserText` (collapse whitespace, trim)
/// so content matching agrees across the IPC boundary.
pub(super) fn normalize_user_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn normalized_event_text(event: &SessionEvent) -> String {
    event
        .display_text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn is_completed_authoritative_stream_transcript(event: &SessionEvent) -> bool {
    let is_stream_transcript = matches!(
        event.display_variant,
        EventDisplayVariant::Message | EventDisplayVariant::Thinking
    ) && (event.id.starts_with("stream-msg-")
        || event.id.starts_with("stream-think-"));

    event.source == EventSource::Assistant
        && is_stream_transcript
        && event.display_status == EventDisplayStatus::Completed
        && event.is_delta != Some(true)
        && !normalized_event_text(event).is_empty()
}

pub(super) fn is_authoritative_transcript_message(event: &SessionEvent) -> bool {
    transcript_message_key(event).is_some() && !is_synthetic_transcript_placeholder(event)
}

// ---------------------------------------------------------------------------
// Placeholder / turn helpers
// ---------------------------------------------------------------------------

pub(super) fn reconcile_loaded_synthetic_transcript_placeholders(
    events: &mut Vec<SessionEvent>,
) -> usize {
    let authoritative_keys: Vec<(EventSource, String)> = events
        .iter()
        .filter(|event| is_authoritative_transcript_message(event))
        .filter_map(transcript_message_key)
        .collect();

    let removed_ids: HashSet<String> = events
        .iter()
        .filter(|event| {
            is_synthetic_transcript_placeholder(event)
                && transcript_message_key(event)
                    .as_ref()
                    .is_some_and(|key| authoritative_keys.iter().any(|candidate| candidate == key))
        })
        .map(|event| event.id.clone())
        .collect();

    let removed = removed_ids.len();
    if removed > 0 {
        events.retain(|event| !removed_ids.contains(&event.id));
    }
    removed
}

pub(super) fn is_turn_placeholder(event: &SessionEvent) -> bool {
    event.function_name == TURN_PLACEHOLDER_FUNCTION_NAME
        || event.id.starts_with(TURN_PLACEHOLDER_ID_PREFIX)
        // Provider-backed history readers build assistant-shaped placeholders
        // whose stable shared contract is `result.unloadedTurn`. Match that
        // semantic payload rather than maintaining one prefix per provider, so
        // a renamed or newly added provider cannot leave its final-reply
        // preview beside the real body after a round-window merge.
        || placeholder_turn_id(event).is_some()
}

pub(super) fn placeholder_turn_id(event: &SessionEvent) -> Option<&str> {
    event
        .result
        .get("unloadedTurn")
        .and_then(|value| value.get("turnId"))
        .and_then(|value| value.as_str())
}

pub(super) fn placeholder_next_turn_id(event: &SessionEvent) -> Option<&str> {
    event
        .result
        .get("unloadedTurn")
        .and_then(|value| value.get("nextTurnId"))
        .and_then(|value| value.as_str())
}

pub(super) fn loaded_turn_ids_from_events(events: &[SessionEvent]) -> HashSet<String> {
    events
        .iter()
        .filter(|event| event.source == EventSource::User)
        .map(|event| event.id.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Timeline ordering
// ---------------------------------------------------------------------------

pub(super) fn timeline_source_order(source: &EventSource) -> u8 {
    match source {
        EventSource::User => 0,
        EventSource::Assistant => 1,
        EventSource::System => 2,
    }
}

// ---------------------------------------------------------------------------
// Stream placeholder matching
// ---------------------------------------------------------------------------

pub(super) fn stream_placeholder_prefix_for_authoritative(event_id: &str) -> Option<&'static str> {
    if event_id.starts_with("stream-think-") && !event_id.starts_with("stream-think-ts-") {
        return Some("stream-think-ts-");
    }
    if event_id.starts_with("stream-msg-") && !event_id.starts_with("stream-msg-ts-") {
        return Some("stream-msg-ts-");
    }
    None
}
