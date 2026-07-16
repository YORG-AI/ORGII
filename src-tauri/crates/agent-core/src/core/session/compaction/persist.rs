//! Shared durable persistence helpers for in-place compaction.
//!
//! App-side sessions do not compact-fork. They append a compact boundary row
//! so the durable transcript renders as `[summary] + tail` without deleting
//! original rows.

use serde_json::Value;

use super::manual::MIN_HISTORY_FOR_MANUAL_COMPACT;
use crate::session::persistence as unified_persistence;

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Split a compacted in-memory view into boundary summary text and preserved
/// tail length.
///
/// The LLM compactor emits `[user compact-boundary summary] + tail`; legacy
/// summaries may be `system`. If no leading summary exists, every message is
/// treated as tail and a generic marker is used.
pub(crate) fn split_summary_and_tail(durable_compacted_messages: &[Value]) -> (String, usize) {
    let is_summary_head = durable_compacted_messages.first().is_some_and(|first| {
        message_role(first) == Some("system")
            || crate::model_context::session_memory::compact::is_compact_boundary_message(first)
    });

    match durable_compacted_messages.first() {
        Some(first) if is_summary_head => (
            content_text(first),
            durable_compacted_messages.len().saturating_sub(1),
        ),
        _ => (
            "[Conversation summary - earlier messages compacted without summary]".to_string(),
            durable_compacted_messages.len(),
        ),
    }
}

/// Durable identity of a freshly appended compact boundary row, so callers
/// can push the matching chat event to the frontend without a full session
/// reload (the load path dedups on `id`).
pub(crate) struct AppendedCompactBoundary {
    pub id: String,
    pub summary: String,
    pub created_at: String,
}

/// Appends an in-place compact boundary for an app-side session.
pub(crate) fn append_in_place_compact_boundary(
    session_id: &str,
    durable_compacted_messages: &[Value],
    token_delta: Option<(usize, usize)>,
) -> Result<AppendedCompactBoundary, String> {
    let (summary_text, tail_len) = split_summary_and_tail(durable_compacted_messages);
    let cutoff = unified_persistence::compact_cutoff_sequence(session_id, tail_len)
        .map_err(|err| err.to_string())?;
    let (tokens_before, tokens_after) = match token_delta {
        Some((before, after)) => (Some(before as i64), Some(after as i64)),
        None => (None, None),
    };
    let (id, created_at) = unified_persistence::append_compact_boundary(
        session_id,
        &summary_text,
        cutoff,
        tokens_before,
        tokens_after,
    )
    .map_err(|err| err.to_string())?;
    Ok(AppendedCompactBoundary {
        id,
        summary: summary_text,
        created_at,
    })
}

/// Keep session-memory content but clear its pre-compaction message index.
pub(crate) fn persist_session_memory_after_compact(session_id: &str) -> Result<(), String> {
    let sm_state = unified_persistence::load_session_memory_state(session_id)
        .map_err(|err| err.to_string())?;
    match sm_state.content.as_deref() {
        Some(content) if !content.trim().is_empty() => {
            unified_persistence::save_session_memory_state(session_id, content, None)
        }
        _ => unified_persistence::clear_session_memory_state(session_id),
    }
    .map_err(|err| err.to_string())
}

/// Detect a transcript that was just compacted and has too little new tail to
/// compact again.
pub(crate) fn is_recently_compacted_without_new_tail(history: &[Value]) -> bool {
    let Some(first) = history.first() else {
        return false;
    };
    if !crate::model_context::session_memory::compact::is_compact_boundary_message(first) {
        return false;
    }
    history.len().saturating_sub(1) < MIN_HISTORY_FOR_MANUAL_COMPACT
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_summary_and_tail_extracts_compact_boundary_summary() {
        let summary = crate::model_context::compaction::compacted_summary_message(
            "[Conversation summary \u{2014} 4 earlier messages compacted]\n\nsummary",
        );
        let messages = vec![
            summary,
            json!({"role": "user", "content": "recent user"}),
            json!({"role": "assistant", "content": "recent assistant"}),
        ];

        let (summary_text, tail_len) = split_summary_and_tail(&messages);

        assert!(summary_text.contains("summary"));
        assert_eq!(tail_len, 2);
    }

    #[test]
    fn split_summary_and_tail_uses_generic_marker_without_summary_head() {
        let messages = vec![
            json!({"role": "user", "content": "recent user"}),
            json!({"role": "assistant", "content": "recent assistant"}),
        ];

        let (summary_text, tail_len) = split_summary_and_tail(&messages);

        assert!(summary_text.contains("compacted without summary"));
        assert_eq!(tail_len, 2);
    }

    #[test]
    fn recently_compacted_requires_boundary_and_short_tail() {
        let summary = crate::model_context::compaction::compacted_summary_message(
            "[Conversation summary \u{2014} 8 earlier messages compacted]\n\nsummary",
        );
        let short_tail = vec![
            summary.clone(),
            json!({"role": "user", "content": "one"}),
            json!({"role": "assistant", "content": "two"}),
        ];
        assert!(is_recently_compacted_without_new_tail(&short_tail));

        let long_tail = vec![
            summary,
            json!({"role": "user", "content": "one"}),
            json!({"role": "assistant", "content": "two"}),
            json!({"role": "user", "content": "three"}),
            json!({"role": "assistant", "content": "four"}),
        ];
        assert!(!is_recently_compacted_without_new_tail(&long_tail));

        let no_boundary = vec![
            json!({"role": "user", "content": "one"}),
            json!({"role": "assistant", "content": "two"}),
        ];
        assert!(!is_recently_compacted_without_new_tail(&no_boundary));
    }
}
