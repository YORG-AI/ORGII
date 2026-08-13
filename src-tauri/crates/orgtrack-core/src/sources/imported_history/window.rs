//! Provider-neutral bounded replay windows for imported histories.
//!
//! Provider readers continue to own their source formats. This layer turns
//! their canonical `ActivityChunk` stream into a bounded initial wire payload:
//! every user round remains discoverable, while only the newest round bodies
//! cross IPC. Older bodies are represented by the same `unloadedTurn`
//! contract used by Codex and Cursor and can be fetched one round at a time.

use core_types::activity::ActivityChunk;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::projectors::turn_metadata::{project_activity_chunks, ProjectedTurnMetadata};

use super::{load_activity_chunks_for_session, FUNCTION_ASSISTANT, FUNCTION_USER_MESSAGE};

const ORPHAN_INITIAL_CHUNK_LIMIT: usize = 200;
const TURN_PREVIEW_MAX_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistoryInitialWindow {
    pub chunks: Vec<ActivityChunk>,
    pub total_turn_count: usize,
    pub loaded_turn_count: usize,
    pub has_unloaded_turns: bool,
    #[serde(skip)]
    pub turns: Vec<ProjectedTurnMetadata>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistoryTurnWindow {
    pub chunks: Vec<ActivityChunk>,
    pub turn_id: String,
    pub loaded_event_count: usize,
}

fn is_user_chunk(chunk: &ActivityChunk) -> bool {
    chunk.function == FUNCTION_USER_MESSAGE
}

fn bounded_turn_preview(message: &str) -> String {
    if message.len() <= TURN_PREVIEW_MAX_BYTES {
        return message.to_string();
    }
    let mut cut = TURN_PREVIEW_MAX_BYTES;
    while !message.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &message[..cut])
}

fn assistant_preview_text(chunk: &ActivityChunk) -> Option<String> {
    if chunk.function != FUNCTION_ASSISTANT {
        return None;
    }
    chunk
        .result
        .get("observation")
        .or_else(|| chunk.result.get("content"))
        .or_else(|| chunk.result.pointer("/message/content"))
        .or_else(|| chunk.args.get("content"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .map(bounded_turn_preview)
}

fn build_unloaded_turn_placeholder_chunk(
    session_id: &str,
    turn: &ProjectedTurnMetadata,
    next_turn_id: Option<&str>,
    last_agent_preview: Option<&str>,
) -> ActivityChunk {
    let internal_placeholder = format!("Imported turn {} is not loaded yet.", turn.turn_id);
    let display_content = last_agent_preview.unwrap_or(&internal_placeholder);
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("imported-unloaded-turn-{}", turn.turn_id);
    chunk.created_at = turn
        .ended_at
        .clone()
        .unwrap_or_else(|| turn.started_at.clone());
    if last_agent_preview.is_some() {
        chunk.args = json!({ "turnPreviewOnly": true });
    }
    chunk.result = json!({
        "observation": display_content,
        "content": display_content,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
        "unloadedTurn": {
            "turnId": turn.turn_id,
            "nextTurnId": next_turn_id.map(Value::from).unwrap_or(Value::Null),
            "startedAt": turn.started_at,
            "endedAt": turn.ended_at,
            "durationMs": Value::Null,
            "eventCount": turn.event_count,
            "bodyEventCount": turn.body_event_count,
        },
    });
    chunk
}

fn build_user_preview_chunk(
    session_id: &str,
    source: &ActivityChunk,
    turn: &ProjectedTurnMetadata,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, &source.action_type, &source.function);
    chunk.chunk_id = source.chunk_id.clone();
    chunk.created_at = source.created_at.clone();
    chunk.thread_id = source.thread_id.clone();
    chunk.process_id = source.process_id.clone();
    chunk.result = json!({
        "type": "user",
        "message": {
            "content": turn.user_preview,
            "role": "user",
        },
    });
    chunk
}

pub fn build_initial_window(
    session_id: &str,
    chunks: Vec<ActivityChunk>,
    recent_turn_count: usize,
) -> ImportedHistoryInitialWindow {
    let turns = project_activity_chunks(&chunks);
    build_initial_window_from_turns(session_id, chunks, recent_turn_count, turns)
}

/// [`build_initial_window`] with caller-supplied turn projections, for
/// sources whose reduced streams under-report unloaded-round metadata (the
/// Claude index overlays its cheap body-line counts so placeholders always
/// advertise a fetchable body). `turns[i]` must correspond to the i-th user
/// chunk of `chunks` in stream order.
pub fn build_initial_window_from_turns(
    session_id: &str,
    chunks: Vec<ActivityChunk>,
    recent_turn_count: usize,
    turns: Vec<ProjectedTurnMetadata>,
) -> ImportedHistoryInitialWindow {
    let total_turn_count = turns.len();
    if total_turn_count == 0 {
        let chunks = if chunks.len() > ORPHAN_INITIAL_CHUNK_LIMIT {
            let skip = chunks.len() - ORPHAN_INITIAL_CHUNK_LIMIT;
            chunks.into_iter().skip(skip).collect()
        } else {
            chunks
        };
        return ImportedHistoryInitialWindow {
            chunks,
            total_turn_count,
            loaded_turn_count: 0,
            has_unloaded_turns: false,
            turns,
        };
    }

    let loaded_turn_count = recent_turn_count.max(1).min(total_turn_count);
    let first_loaded_turn = total_turn_count - loaded_turn_count;
    let initial_chunk_count = chunks.len();
    let mut window = Vec::with_capacity(
        total_turn_count
            .saturating_mul(2)
            .saturating_add(initial_chunk_count.min(256)),
    );
    let mut chunks = chunks.into_iter().peekable();
    let mut turn_index = 0usize;

    while let Some(chunk) = chunks.next() {
        if !is_user_chunk(&chunk) {
            continue;
        }

        let current_turn_index = turn_index;
        turn_index += 1;

        if current_turn_index >= first_loaded_turn {
            window.push(chunk);
            while chunks.peek().is_some_and(|next| !is_user_chunk(next)) {
                if let Some(body) = chunks.next() {
                    window.push(body);
                }
            }
        } else {
            if let Some(turn) = turns.get(current_turn_index) {
                window.push(build_user_preview_chunk(session_id, &chunk, turn));
                let mut last_agent_preview = None;
                while chunks.peek().is_some_and(|next| !is_user_chunk(next)) {
                    if let Some(body) = chunks.next() {
                        if let Some(preview) = assistant_preview_text(&body) {
                            last_agent_preview = Some(preview);
                        }
                    }
                }
                window.push(build_unloaded_turn_placeholder_chunk(
                    session_id,
                    turn,
                    turns
                        .get(current_turn_index + 1)
                        .map(|next| next.turn_id.as_str()),
                    last_agent_preview.as_deref(),
                ));
            } else {
                window.push(chunk);
                while chunks.peek().is_some_and(|next| !is_user_chunk(next)) {
                    chunks.next();
                }
            }
        }
    }

    ImportedHistoryInitialWindow {
        chunks: window,
        total_turn_count,
        loaded_turn_count,
        has_unloaded_turns: first_loaded_turn > 0,
        turns,
    }
}

pub fn build_turn_window_from_chunks(
    chunks: &[ActivityChunk],
    turn_id: &str,
) -> ImportedHistoryTurnWindow {
    let Some(start_index) = chunks
        .iter()
        .position(|chunk| is_user_chunk(chunk) && chunk.chunk_id == turn_id)
    else {
        return ImportedHistoryTurnWindow {
            chunks: Vec::new(),
            turn_id: turn_id.to_string(),
            loaded_event_count: 0,
        };
    };
    let end_index = chunks[start_index + 1..]
        .iter()
        .position(is_user_chunk)
        .map(|offset| start_index + 1 + offset)
        .unwrap_or(chunks.len());
    let chunks = chunks
        .iter()
        .skip(start_index)
        .take(end_index - start_index)
        .cloned()
        .collect::<Vec<_>>();
    ImportedHistoryTurnWindow {
        loaded_event_count: chunks.len(),
        chunks,
        turn_id: turn_id.to_string(),
    }
}

pub fn load_initial_window_for_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    recent_turn_count: usize,
) -> Result<Option<ImportedHistoryInitialWindow>, String> {
    Ok(load_activity_chunks_for_session(conn, session_id)?
        .map(|chunks| build_initial_window(session_id, chunks, recent_turn_count)))
}

pub fn load_turn_windows_for_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_ids: &[String],
) -> Result<Option<Vec<ImportedHistoryTurnWindow>>, String> {
    Ok(load_activity_chunks_for_session(conn, session_id)?
        .map(|chunks| build_turn_windows_from_chunks(&chunks, turn_ids)))
}

fn build_turn_windows_from_chunks(
    chunks: &[ActivityChunk],
    turn_ids: &[String],
) -> Vec<ImportedHistoryTurnWindow> {
    let requested = turn_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut ranges = HashMap::<&str, (usize, usize)>::with_capacity(requested.len());
    let mut active: Option<(&str, usize)> = None;

    for (index, chunk) in chunks.iter().enumerate() {
        if !is_user_chunk(chunk) {
            continue;
        }
        if let Some((turn_id, start_index)) = active.take() {
            ranges.insert(turn_id, (start_index, index));
        }
        if requested.contains(chunk.chunk_id.as_str()) {
            active = Some((chunk.chunk_id.as_str(), index));
        }
    }
    if let Some((turn_id, start_index)) = active {
        ranges.insert(turn_id, (start_index, chunks.len()));
    }

    turn_ids
        .iter()
        .map(|turn_id| {
            let Some((start_index, end_index)) = ranges.get(turn_id.as_str()).copied() else {
                return ImportedHistoryTurnWindow {
                    chunks: Vec::new(),
                    turn_id: turn_id.clone(),
                    loaded_event_count: 0,
                };
            };
            let chunks = chunks[start_index..end_index].to_vec();
            ImportedHistoryTurnWindow {
                loaded_event_count: chunks.len(),
                chunks,
                turn_id: turn_id.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, function: &str, text: &str) -> ActivityChunk {
        let mut chunk = ActivityChunk::new("test-session", "raw", function);
        chunk.chunk_id = id.to_string();
        chunk.created_at = format!("2026-01-01T00:00:0{}Z", id.len());
        chunk.args = json!({ "content": text });
        chunk
    }

    #[test]
    fn initial_window_keeps_all_round_headers_but_only_recent_body() {
        let oversized_prompt = "x".repeat(1_024);
        let chunks = vec![
            chunk("u1", FUNCTION_USER_MESSAGE, &oversized_prompt),
            chunk("a1", "assistant", "answer one"),
            chunk("u2", FUNCTION_USER_MESSAGE, "two"),
            chunk("a2", "assistant", "answer two"),
            chunk("u3", FUNCTION_USER_MESSAGE, "three"),
            chunk("a3", "assistant", "answer three"),
        ];

        let window = build_initial_window("test-session", chunks, 1);

        assert_eq!(window.total_turn_count, 3);
        assert_eq!(window.loaded_turn_count, 1);
        assert!(window.has_unloaded_turns);
        assert_eq!(
            window
                .chunks
                .iter()
                .filter(|chunk| is_user_chunk(chunk))
                .count(),
            3
        );
        assert_eq!(
            window
                .chunks
                .iter()
                .filter(|chunk| chunk.result.get("unloadedTurn").is_some())
                .count(),
            2
        );
        assert!(window.chunks.iter().any(|chunk| chunk.chunk_id == "a3"));
        assert!(!window.chunks.iter().any(|chunk| chunk.chunk_id == "a1"));
        let placeholders = window
            .chunks
            .iter()
            .filter(|chunk| chunk.result.get("unloadedTurn").is_some())
            .collect::<Vec<_>>();
        assert_eq!(
            placeholders
                .iter()
                .filter_map(|chunk| chunk.result.get("observation"))
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            vec!["answer one", "answer two"]
        );
        assert!(placeholders
            .iter()
            .all(|chunk| chunk.args.get("turnPreviewOnly") == Some(&Value::Bool(true))));
        let first_preview = window
            .chunks
            .iter()
            .find(|chunk| chunk.chunk_id == "u1")
            .and_then(|chunk| chunk.result.pointer("/message/content"))
            .and_then(Value::as_str)
            .expect("first preview");
        assert!(first_preview.len() <= 515);
        assert!(first_preview.ends_with('…'));
    }

    #[test]
    fn initial_window_bounds_last_reply_preview_on_a_utf8_boundary() {
        let long_reply = "🙂".repeat(200);
        let chunks = vec![
            chunk("u1", FUNCTION_USER_MESSAGE, "one"),
            chunk("a1", FUNCTION_ASSISTANT, &long_reply),
            chunk("u2", FUNCTION_USER_MESSAGE, "two"),
            chunk("a2", FUNCTION_ASSISTANT, "answer two"),
        ];

        let window = build_initial_window("test-session", chunks, 1);
        let preview = window.chunks[1]
            .result
            .get("observation")
            .and_then(Value::as_str)
            .expect("last reply preview");

        assert!(preview.len() <= TURN_PREVIEW_MAX_BYTES + '…'.len_utf8());
        assert!(preview.ends_with('…'));
        assert!(preview[..preview.len() - '…'.len_utf8()]
            .chars()
            .all(|character| character == '🙂'));
    }

    #[test]
    fn turn_window_returns_exact_user_bounded_round() {
        let chunks = vec![
            chunk("u1", FUNCTION_USER_MESSAGE, "one"),
            chunk("a1", "assistant", "answer one"),
            chunk("u2", FUNCTION_USER_MESSAGE, "two"),
            chunk("a2", "assistant", "answer two"),
        ];

        let window = build_turn_window_from_chunks(&chunks, "u1");

        assert_eq!(window.turn_id, "u1");
        assert_eq!(window.loaded_event_count, 2);
        assert_eq!(
            window
                .chunks
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["u1", "a1"]
        );
    }

    #[test]
    fn batched_turn_windows_share_one_source_snapshot() {
        let chunks = vec![
            chunk("u1", FUNCTION_USER_MESSAGE, "one"),
            chunk("a1", "assistant", "answer one"),
            chunk("u2", FUNCTION_USER_MESSAGE, "two"),
            chunk("a2", "assistant", "answer two"),
        ];

        let windows =
            build_turn_windows_from_chunks(&chunks, &["u1".to_string(), "u2".to_string()]);

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].loaded_event_count, 2);
        assert_eq!(windows[1].loaded_event_count, 2);
    }

    #[test]
    fn initial_window_bounds_histories_without_user_boundaries() {
        let chunks = (0..250)
            .map(|index| chunk(&format!("a{index}"), "assistant", "body"))
            .collect();

        let window = build_initial_window("test-session", chunks, 1);

        assert_eq!(window.total_turn_count, 0);
        assert_eq!(window.chunks.len(), ORPHAN_INITIAL_CHUNK_LIMIT);
        assert_eq!(
            window.chunks.first().map(|chunk| chunk.chunk_id.as_str()),
            Some("a50")
        );
    }
}
