//! Placeholder chunk builders for unloaded / lazily-fetched turns.

use super::*;

// ============================================================================
// Placeholder chunk builders
// ============================================================================

pub(in crate::sources::cursor_ide) fn fallback_turn_created_at(
    order: &[RawComposerHeader],
    bubbles_by_id: &HashMap<String, OrderedBubble>,
    index: usize,
) -> String {
    let next_user_index = order
        .iter()
        .enumerate()
        .skip(index + 1)
        .find(|(_, candidate)| candidate.bubble_type == CURSOR_BUBBLE_TYPE_USER)
        .map(|(candidate_index, _)| candidate_index)
        .unwrap_or(order.len());
    order[index..next_user_index]
        .iter()
        .find_map(|header| bubbles_by_id.get(&header.bubble_id))
        .map(|bubble| normalize_created_at(&bubble.raw.created_at))
        .unwrap_or_default()
}

pub(in crate::sources::cursor_ide) fn build_fallback_user_chunk(
    session_id: &str,
    user_bubble_id: &str,
    created_at: String,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, "raw", "user_message");
    chunk.chunk_id = format!("cursoride-user-{}", user_bubble_id);
    chunk.created_at = created_at;
    chunk.result = json!({
        "type": "user",
        "message": { "content": "User message not loaded.", "role": "user" },
    });
    chunk
}

pub(in crate::sources::cursor_ide) fn build_unloaded_turn_placeholder_chunk(
    session_id: &str,
    order: &[RawComposerHeader],
    recent_ids: &HashSet<&str>,
    bubbles_by_id: &HashMap<String, OrderedBubble>,
    summaries_by_turn_id: &HashMap<String, super::models::CursorIdeTurnSummary>,
    index: usize,
) -> Option<ActivityChunk> {
    let header = order.get(index)?;
    if header.bubble_type != CURSOR_BUBBLE_TYPE_USER {
        return None;
    }

    let next_user_index = order
        .iter()
        .enumerate()
        .skip(index + 1)
        .find(|(_, candidate)| candidate.bubble_type == CURSOR_BUBBLE_TYPE_USER)
        .map(|(candidate_index, _)| candidate_index)
        .unwrap_or(order.len());
    let turn_headers = &order[index..next_user_index];
    let has_unloaded_body = turn_headers
        .iter()
        .skip(1)
        .any(|candidate| !recent_ids.contains(candidate.bubble_id.as_str()));

    if !has_unloaded_body {
        return None;
    }

    let next_user_bubble_id = if next_user_index < order.len() {
        order
            .get(next_user_index)
            .map(|candidate| candidate.bubble_id.clone())
    } else {
        None
    };
    let end_header = turn_headers.last()?;
    let end_bubble = bubbles_by_id
        .get(&end_header.bubble_id)
        .or_else(|| bubbles_by_id.get(&header.bubble_id))?;

    let summary = summaries_by_turn_id.get(&header.bubble_id);
    let body_event_count = summary
        .map(|cached_summary| cached_summary.body_event_count)
        .unwrap_or_else(|| turn_headers.len().saturating_sub(1));
    let event_count = summary
        .map(|cached_summary| cached_summary.event_count)
        .unwrap_or(turn_headers.len());
    let started_at = summary
        .map(|cached_summary| cached_summary.started_at.clone())
        .unwrap_or_else(|| normalize_created_at(&end_bubble.raw.created_at));
    let ended_at = summary
        .and_then(|cached_summary| cached_summary.ended_at.clone())
        .unwrap_or_else(|| normalize_created_at(&end_bubble.raw.created_at));
    let duration_ms = summary.and_then(|cached_summary| cached_summary.duration_ms);
    let content = format!("Cursor IDE turn {} is not loaded yet.", header.bubble_id);
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("cursoride-unloaded-turn-{}", header.bubble_id);
    chunk.created_at = ended_at.clone();
    chunk.result = json!({
        "observation": content,
        "content": content,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
        "unloadedTurn": {
            "turnId": header.bubble_id,
            "nextTurnId": summary
                .and_then(|cached_summary| cached_summary.next_turn_id.clone())
                .or(next_user_bubble_id),
            "startedAt": started_at,
            "endedAt": ended_at,
            "durationMs": duration_ms,
            "eventCount": event_count,
            "bodyEventCount": body_event_count,
        },
    });
    Some(chunk)
}
