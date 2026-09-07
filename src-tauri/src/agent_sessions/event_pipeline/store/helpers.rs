//! Pure free functions used by EventStore internals.
//!
//! These helpers operate on `SessionEvent` slices and values but hold no
//! store state themselves, making them easy to test in isolation.

use std::collections::{HashMap, HashSet};

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

/// Stable identity of one accepted user turn across the frontend placeholder,
/// the Rust runtime's low-level `user_input` row, and the persisted
/// `user_message` row.
///
/// Modern submissions carry `turnIntentId`. Older Agent rows still expose the
/// same relationship through `user_message.result.messageId == user_input.id`.
/// Text is deliberately not part of this key: two consecutive turns may have
/// identical words and must remain distinct.
pub(super) fn logical_user_turn_key(event: &SessionEvent) -> Option<String> {
    if event.source != EventSource::User {
        return None;
    }
    if let Some(turn_intent_id) = event
        .result
        .get("turnIntentId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
    {
        return Some(format!("intent:{turn_intent_id}"));
    }
    let message_id = event
        .result
        .get("messageId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            (event.function_name == "user_input" && !event.id.is_empty())
                .then_some(event.id.as_str())
        })?;
    Some(format!("message:{message_id}"))
}

/// Prefer the single durable projection when several transport layers report
/// the same logical user turn.
pub(super) fn user_turn_projection_authority(event: &SessionEvent) -> u8 {
    if is_synthetic_transcript_placeholder(event) {
        return 0;
    }
    if event
        .result
        .get("backendPersisted")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return 3;
    }
    if event.function_name == "user_message" {
        return 2;
    }
    1
}

/// Collapse duplicate user-turn projections during full hydration while
/// retaining the first slot in timeline order and the strongest event body.
pub(super) fn reconcile_loaded_duplicate_user_turns(events: &mut Vec<SessionEvent>) -> usize {
    let mut owner_by_key = HashMap::<String, usize>::new();
    let mut reconciled = Vec::with_capacity(events.len());
    let mut removed = 0usize;

    for mut event in events.drain(..) {
        let Some(key) = logical_user_turn_key(&event) else {
            reconciled.push(event);
            continue;
        };
        let Some(&existing_idx) = owner_by_key.get(&key) else {
            owner_by_key.insert(key, reconciled.len());
            reconciled.push(event);
            continue;
        };
        removed += 1;
        if user_turn_projection_authority(&event)
            > user_turn_projection_authority(&reconciled[existing_idx])
        {
            event.created_at = reconciled[existing_idx].created_at.clone();
            reconciled[existing_idx] = event;
        }
    }

    *events = reconciled;
    removed
}

// ---------------------------------------------------------------------------
// Placeholder / turn helpers
// ---------------------------------------------------------------------------

pub(super) fn reconcile_loaded_synthetic_transcript_placeholders(
    events: &mut Vec<SessionEvent>,
) -> usize {
    let synthetic_candidates: Vec<((EventSource, String), String, Option<String>)> = events
        .iter()
        .filter(|event| is_synthetic_transcript_placeholder(event))
        .filter_map(|event| {
            transcript_message_key(event).map(|key| {
                (
                    key,
                    event.id.clone(),
                    event
                        .result
                        .get("turnIntentId")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                )
            })
        })
        .collect();

    let mut removed_ids = HashSet::new();
    for authoritative in events
        .iter_mut()
        .filter(|event| is_authoritative_transcript_message(event))
    {
        let Some(authoritative_key) = transcript_message_key(authoritative) else {
            continue;
        };
        let Some((_, candidate_id, turn_intent_id)) =
            synthetic_candidates
                .iter()
                .find(|(candidate_key, candidate_id, _)| {
                    candidate_key == &authoritative_key && !removed_ids.contains(candidate_id)
                })
        else {
            continue;
        };
        removed_ids.insert(candidate_id.clone());
        preserve_synthetic_turn_intent(authoritative, turn_intent_id.as_deref());
    }

    let removed = removed_ids.len();
    if removed > 0 {
        events.retain(|event| !removed_ids.contains(&event.id));
    }
    removed
}

/// Preserve ORGII's durable user-intent identity when a provider transcript
/// row replaces the optimistic frontend placeholder. Provider JSONL rows do
/// not carry this id, but turn indexing and conversation publishing require it.
pub(super) fn preserve_synthetic_turn_intent(
    authoritative: &mut SessionEvent,
    turn_intent_id: Option<&str>,
) {
    let Some(turn_intent_id) = turn_intent_id.filter(|value| !value.is_empty()) else {
        return;
    };
    if authoritative
        .result
        .get("turnIntentId")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    if !authoritative.result.is_object() {
        authoritative.result = serde_json::json!({});
    }
    if let Some(result) = authoritative.result.as_object_mut() {
        result.insert(
            "turnIntentId".to_string(),
            serde_json::Value::String(turn_intent_id.to_string()),
        );
    }
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
