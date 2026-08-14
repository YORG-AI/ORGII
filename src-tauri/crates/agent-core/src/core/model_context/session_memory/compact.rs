//! SM-compact: zero-API path that replaces older messages with the pre-built
//! SM markdown summary.
//!
//! Algorithm:
//! 1. Start at the resolved anchor index + 1
//! 2. If the tail is already large enough, use it
//! 3. Otherwise expand backwards until min thresholds are met
//! 4. Never exceed `max_tokens_to_keep`
//! 5. Never cross a previous compaction boundary
//! 6. Adjust for tool_use/tool_result pair integrity

use serde_json::Value;
use tracing::info;

use super::config::{SessionMemoryCompactConfig, SessionMemoryConfig};
use super::sections::truncate_for_compact;
use crate::core::model_context::compaction::ContextCompactor;

/// Attempt to compact the conversation using session memory.
///
/// Returns `Some(compacted_messages)` if SM-compact succeeds, or `None` if
/// SM is not available and the caller should fall through to legacy LLM
/// compaction.
///
/// `last_summarized_idx` is the anchor already resolved into `messages`'
/// own frame (see [`super::resolve_summarized_boundary_idx`]); callers on
/// different frames (turn tail, freshly loaded history) each resolve the
/// durable sequence anchor themselves.
///
/// **Zero API calls** — the summary is the pre-extracted SM markdown.
pub fn try_sm_compact(
    messages: &[Value],
    sm_content: Option<&str>,
    last_summarized_idx: Option<usize>,
    compact_config: &SessionMemoryCompactConfig,
) -> Option<Vec<Value>> {
    let sm_content = sm_content?;

    if sm_content.trim().is_empty() {
        return None;
    }

    let keep_from = calculate_messages_to_keep_index(messages, last_summarized_idx, compact_config);

    if keep_from >= messages.len() {
        return None;
    }

    let preserved = &messages[keep_from..];
    let dropped_count = keep_from;

    let (truncated_sm, was_truncated) = truncate_for_compact(
        sm_content,
        SessionMemoryConfig::default().max_section_tokens,
    );
    if was_truncated {
        info!(
            "[session_memory] SM content truncated before compact injection ({} → {} chars)",
            sm_content.len(),
            truncated_sm.len(),
        );
    }

    let summary_msg = crate::core::model_context::compaction::compacted_summary_message(format!(
        "{} {} earlier messages compacted]\n\n{}",
        SM_COMPACT_BOUNDARY_PREFIX, dropped_count, truncated_sm
    ));

    let mut compacted = Vec::with_capacity(preserved.len() + 1);
    compacted.push(summary_msg);
    compacted.extend_from_slice(preserved);

    let compacted_tokens = ContextCompactor::estimate_messages_tokens(&compacted);
    info!(
        "[session_memory] SM-compact: {} → {} messages, ~{} tokens (dropped {})",
        messages.len(),
        compacted.len(),
        compacted_tokens,
        dropped_count,
    );

    Some(compacted)
}

/// Prefix written by `try_sm_compact` on the synthetic system message
/// that wraps the SM markdown. Mirrored in `is_compact_boundary_message`
/// so the boundary detector never drifts from the writer.
const SM_COMPACT_BOUNDARY_PREFIX: &str = "[Session Memory \u{2014}";
/// Prefix written by legacy LLM-driven compaction in
/// `compaction.rs::compact`. Re-exported as
/// [`super::LLM_COMPACT_BOUNDARY_PREFIX`] so the writer there stays in
/// sync with this detector.
pub(in crate::core::model_context) const LLM_COMPACT_BOUNDARY_PREFIX: &str =
    "[Conversation summary \u{2014}";

/// Check if a message is a compaction boundary marker.
///
/// Both SM-compact and LLM-compact insert summary messages with
/// recognisable prefixes. New summaries land as `user` messages (with a
/// continuation instruction); summaries persisted before that change were
/// `system` messages, so both roles are accepted. The backward expansion in
/// [`calculate_messages_to_keep_index`] must not cross these boundaries
/// to avoid re-summarising already-compacted content.
pub fn is_compact_boundary_message(msg: &Value) -> bool {
    let role = msg.get("role").and_then(|val| val.as_str()).unwrap_or("");
    if role != "system" && role != "user" {
        return false;
    }
    let content = compact_boundary_text(msg).unwrap_or("");
    content.starts_with(SM_COMPACT_BOUNDARY_PREFIX)
        || content.starts_with(LLM_COMPACT_BOUNDARY_PREFIX)
}

/// A persisted compact-boundary row's content, split for display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCompactBoundary {
    /// Header line, e.g. `[Conversation summary — 12 earlier messages compacted]`.
    pub header: Option<String>,
    /// Summary body with the header line and continuation suffix stripped.
    pub body: String,
    /// `N` parsed from the header, when present.
    pub compacted_count: Option<u64>,
}

/// Split a persisted compact-boundary row's content into header line and
/// summary body, stripping the model-facing continuation instructions.
///
/// Single Rust source of truth for boundary display parsing; the TS twin
/// lives in `agentMessageAdapters.ts` (`parseCompactBoundaryContent`).
pub fn parse_compact_boundary_content(content: &str) -> ParsedCompactBoundary {
    let mut text = content;
    if let Some(idx) = text.find(crate::model_context::compaction::COMPACT_CONTINUATION_SUFFIX) {
        text = text[..idx].trim_end();
    }

    let is_boundary_head = text.starts_with(SM_COMPACT_BOUNDARY_PREFIX)
        || text.starts_with(LLM_COMPACT_BOUNDARY_PREFIX)
        // Legacy ASCII-hyphen marker: "[Conversation summary - earlier
        // messages compacted without summary]".
        || text.starts_with("[Conversation summary ")
        || text.starts_with("[Session Memory ");

    let (header, body) = if is_boundary_head {
        match text.find('\n') {
            Some(newline) => (
                Some(text[..newline].trim().to_string()),
                text[newline + 1..].trim().to_string(),
            ),
            None => (Some(text.trim().to_string()), String::new()),
        }
    } else {
        (None, text.trim().to_string())
    };

    let compacted_count = header.as_deref().and_then(parse_compacted_count);

    ParsedCompactBoundary {
        header,
        body,
        compacted_count,
    }
}

/// Extract `N` from `… N earlier messages compacted]`.
fn parse_compacted_count(header: &str) -> Option<u64> {
    let marker = " earlier messages compacted]";
    let end = header.find(marker)?;
    let digits_end = &header[..end];
    let digits_start = digits_end
        .rfind(|ch: char| !ch.is_ascii_digit())
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let digits = &digits_end[digits_start..];
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn compact_boundary_text(msg: &Value) -> Option<&str> {
    let content = msg.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text);
    }
    content
        .as_array()?
        .iter()
        .find_map(|block| block.get("text").and_then(Value::as_str))
}

/// Find the index of the last compaction boundary message (+1).
///
/// Returns `0` if no boundary is found, meaning expansion can go all
/// the way to the beginning.
fn find_compact_boundary_floor(messages: &[Value]) -> usize {
    for idx in (0..messages.len()).rev() {
        if is_compact_boundary_message(&messages[idx]) {
            return idx + 1;
        }
    }
    0
}

fn calculate_messages_to_keep_index(
    messages: &[Value],
    last_summarized_idx: Option<usize>,
    config: &SessionMemoryCompactConfig,
) -> usize {
    let default_start = last_summarized_idx
        .map(|idx| (idx + 1).min(messages.len()))
        .unwrap_or(0);

    let tail = &messages[default_start..];
    let tail_tokens = ContextCompactor::estimate_messages_tokens(tail);
    let tail_text_msgs = count_text_messages(tail);

    if tail_tokens >= config.max_tokens_to_keep {
        return adjust_keep_index_for_api_invariants(messages, default_start);
    }

    if tail_tokens >= config.min_tokens_to_keep
        && tail_text_msgs >= config.min_text_messages_to_keep
    {
        return adjust_keep_index_for_api_invariants(messages, default_start);
    }

    let floor = find_compact_boundary_floor(messages);
    let mut keep_from = default_start;
    let mut running_tokens = tail_tokens;
    let mut running_text_msgs = tail_text_msgs;

    while keep_from > floor {
        keep_from -= 1;
        let msg_tokens = ContextCompactor::estimate_message_tokens(&messages[keep_from]);

        if running_tokens + msg_tokens > config.max_tokens_to_keep {
            keep_from += 1;
            break;
        }

        running_tokens += msg_tokens;
        if is_text_message(&messages[keep_from]) {
            running_text_msgs += 1;
        }

        if running_tokens >= config.min_tokens_to_keep
            && running_text_msgs >= config.min_text_messages_to_keep
        {
            break;
        }
    }

    adjust_keep_index_for_api_invariants(messages, keep_from)
}

/// Adjust the keep-from index so we don't split tool_use/tool_result pairs.
fn adjust_keep_index_for_api_invariants(messages: &[Value], mut idx: usize) -> usize {
    if idx >= messages.len() {
        return idx;
    }

    while idx < messages.len() {
        let role = messages[idx]
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap_or("");
        if role == "tool" {
            idx += 1;
        } else {
            break;
        }
    }

    if idx > 0 && idx < messages.len() {
        let prev = &messages[idx - 1];
        let has_tool_calls = prev
            .get("tool_calls")
            .and_then(|tc| tc.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);

        if has_tool_calls {
            while idx < messages.len() {
                let role = messages[idx]
                    .get("role")
                    .and_then(|val| val.as_str())
                    .unwrap_or("");
                if role == "tool" {
                    idx += 1;
                } else {
                    break;
                }
            }
        }
    }

    idx
}

fn count_text_messages(messages: &[Value]) -> usize {
    messages.iter().filter(|msg| is_text_message(msg)).count()
}

/// A message counts as a "text message" if it is user/assistant with non-empty content.
fn is_text_message(msg: &Value) -> bool {
    let role = msg.get("role").and_then(|val| val.as_str()).unwrap_or("");
    if role != "user" && role != "assistant" {
        return false;
    }
    let content = msg
        .get("content")
        .and_then(|val| val.as_str())
        .unwrap_or("");
    !content.is_empty()
}

/// Check if the last assistant turn in messages has tool calls.
pub fn last_turn_has_tool_calls(messages: &[Value]) -> bool {
    for msg in messages.iter().rev() {
        let role = msg.get("role").and_then(|val| val.as_str()).unwrap_or("");
        if role == "assistant" {
            return msg
                .get("tool_calls")
                .and_then(|tc| tc.as_array())
                .map(|arr| !arr.is_empty())
                .unwrap_or(false);
        }
    }
    false
}
