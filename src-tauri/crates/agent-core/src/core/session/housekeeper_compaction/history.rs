use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::model_context::compaction::ContextCompactor;

const KEEP_RECENT_MESSAGES: usize = 6;
const KEEP_RECENT_TOKENS: usize = 2_000;
const MIN_BACKGROUND_SEGMENT_TOKENS: usize = 1_500;
const MIN_EXPLICIT_SEGMENT_TOKENS: usize = 512;
const MAX_SEGMENT_TOKENS: usize = 7_000;
const REQUEST_OVERHEAD_TOKENS: usize = 700;
const MIN_SEGMENT_BUDGET_TOKENS: usize = 800;
const MAX_OUTPUT_TOKENS: usize = 1_200;

const MINICPM_CONTINUATION_SUFFIX: &str = "This is a background-maintained summary of older conversation messages. Use it as established context, continue from the recent messages below, and do not mention or re-describe the summary unless the user asks.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunMode {
    Background,
    Explicit,
}

#[derive(Debug)]
pub(crate) struct SelectedChunk {
    pub end: usize,
    pub segment_tokens: usize,
    pub max_output_tokens: u32,
}

pub(crate) fn prefix_hash(messages: &[Value], end: usize) -> Option<String> {
    if end > messages.len() {
        return None;
    }
    let encoded = serde_json::to_vec(&messages[..end]).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(encoded);
    Some(format!("{:x}", hasher.finalize()))
}

fn normalized_for_overlay(message: &Value) -> Value {
    let mut normalized = message.clone();
    if normalized.get("role").and_then(Value::as_str) == Some("tool") {
        normalized["content"] = Value::String("[tool result content]".to_string());
    }
    normalized
}

pub(crate) fn structurally_matches(canonical: &[Value], current: &[Value]) -> bool {
    if canonical.len() != current.len() {
        return false;
    }

    canonical
        .iter()
        .zip(current)
        .all(|(left, right)| normalized_for_overlay(left) == normalized_for_overlay(right))
}

pub(crate) fn summary_message(summary: &str, covered_messages: usize) -> Value {
    serde_json::json!({
        "role": "user",
        "content": format!(
            "[MiniCPM rolling context summary - {covered_messages} earlier messages]\n\n{}\n\n{}",
            summary.trim(),
            MINICPM_CONTINUATION_SUFFIX,
        ),
    })
}

fn message_tokens(message: &Value) -> usize {
    ContextCompactor::estimate_message_tokens(message)
}

fn summary_tokens(summary: Option<&str>, covered_messages: usize) -> usize {
    summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| message_tokens(&summary_message(value, covered_messages)))
        .unwrap_or(0)
}

fn recent_tail_start(history: &[Value]) -> usize {
    let by_message_count = history.len().saturating_sub(KEEP_RECENT_MESSAGES);
    let mut token_total = 0usize;
    let mut by_token_count = history.len();

    for (index, message) in history.iter().enumerate().rev() {
        token_total = token_total.saturating_add(message_tokens(message));
        by_token_count = index;
        if token_total >= KEEP_RECENT_TOKENS {
            break;
        }
    }

    by_message_count.min(by_token_count)
}

fn snap_end_to_user_boundary(history: &[Value], covered: usize, candidate: usize) -> usize {
    (covered + 1..=candidate)
        .rev()
        .find(|index| {
            history
                .get(*index)
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("user")
        })
        .unwrap_or(covered)
}

pub(crate) fn select_next_chunk(
    history: &[Value],
    covered: usize,
    previous_summary: Option<&str>,
    context_limit_tokens: usize,
    mode: RunMode,
) -> Option<SelectedChunk> {
    if covered >= history.len() {
        return None;
    }

    let max_end = recent_tail_start(history);
    if max_end <= covered {
        return None;
    }

    let output_tokens = (context_limit_tokens / 8).clamp(384, MAX_OUTPUT_TOKENS);
    let prior_summary_tokens = summary_tokens(previous_summary, covered);
    let segment_budget = context_limit_tokens
        .saturating_sub(prior_summary_tokens)
        .saturating_sub(output_tokens)
        .saturating_sub(REQUEST_OVERHEAD_TOKENS)
        .min(MAX_SEGMENT_TOKENS);
    if segment_budget < MIN_SEGMENT_BUDGET_TOKENS {
        return None;
    }

    let mut candidate = covered;
    let mut segment_tokens = 0usize;
    for (index, message) in history.iter().enumerate().take(max_end).skip(covered) {
        let next_tokens = message_tokens(message);
        if segment_tokens > 0 && segment_tokens.saturating_add(next_tokens) > segment_budget {
            break;
        }
        segment_tokens = segment_tokens.saturating_add(next_tokens);
        candidate = index + 1;
        if segment_tokens >= segment_budget {
            break;
        }
    }

    let end = snap_end_to_user_boundary(history, covered, candidate);
    if end <= covered || end - covered < 2 {
        return None;
    }

    let segment_tokens = ContextCompactor::estimate_messages_tokens(&history[covered..end]);
    let minimum = match mode {
        RunMode::Background => MIN_BACKGROUND_SEGMENT_TOKENS,
        RunMode::Explicit => MIN_EXPLICIT_SEGMENT_TOKENS,
    };
    if segment_tokens < minimum || segment_tokens > segment_budget {
        return None;
    }

    Some(SelectedChunk {
        end,
        segment_tokens,
        max_output_tokens: output_tokens as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns(count: usize, body: &str) -> Vec<Value> {
        let mut messages = Vec::new();
        for index in 0..count {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("request {index} {body}"),
            }));
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": format!("response {index} {body}"),
            }));
        }
        messages
    }

    #[test]
    fn leaves_a_recent_tail_and_ends_at_a_user_boundary() {
        let body = (0..400)
            .map(|index| format!("context-token-{index} "))
            .collect::<String>();
        let history = turns(12, &body);
        let selected = select_next_chunk(&history, 0, None, 10_000, RunMode::Background)
            .expect("a background chunk");

        assert!(history.len() - selected.end >= KEEP_RECENT_MESSAGES);
        assert_eq!(history[selected.end]["role"], "user");
        assert!(selected.segment_tokens >= MIN_BACKGROUND_SEGMENT_TOKENS);
    }

    #[test]
    fn short_history_is_not_compacted() {
        let history = turns(3, "short");
        assert!(select_next_chunk(&history, 0, None, 10_000, RunMode::Explicit).is_none());
    }

    #[test]
    fn overlay_match_ignores_only_tool_result_content() {
        let canonical = vec![serde_json::json!({
            "role": "tool",
            "tool_call_id": "call-1",
            "content": "large result",
        })];
        let trimmed = vec![serde_json::json!({
            "role": "tool",
            "tool_call_id": "call-1",
            "content": "[cleared]",
        })];
        let other_call = vec![serde_json::json!({
            "role": "tool",
            "tool_call_id": "call-2",
            "content": "[cleared]",
        })];

        assert!(structurally_matches(&canonical, &trimmed));
        assert!(!structurally_matches(&canonical, &other_call));
    }
}
