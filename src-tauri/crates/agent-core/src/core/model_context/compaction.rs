//! Context compaction: LLM-based summarization of older messages.
//!
//! When conversation history exceeds the context window budget, older
//! messages are summarized by the LLM instead of being silently dropped.
//! This preserves key decisions, file changes, errors, and context.
//!
//! # Strategy
//!
//! 1. History is split into "older" (to compact) and "recent" (to keep verbatim).
//! 2. The older portion is summarized via a dedicated LLM call using a fast model.
//! 3. The summary replaces the older messages as a system message.
//! 4. Summaries are cached per session so re-compaction is incremental.

#[cfg(test)]
#[path = "tests/compaction_tests.rs"]
mod tests;

use serde_json::Value;
use tracing::{info, warn};

use super::summarization;
use super::tokenizer;
use crate::core::session::prompt::cache::{RenderedSystemBlockScope, ORGII_SYSTEM_CACHE_SCOPE_KEY};
use crate::providers::traits::LLMProvider;

// ============================================
// Configuration
// ============================================

/// Compaction configuration.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionConfig {
    /// Whether compaction is enabled (vs. silent truncation).
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Token budget at which compaction triggers (fraction of MAX_HISTORY_TOKENS).
    #[serde(default = "default_trigger_ratio")]
    pub trigger_ratio: f32,

    /// Fraction of token budget to keep as verbatim recent messages.
    #[serde(default = "default_keep_ratio")]
    pub keep_ratio: f32,

    /// Model to use for summarization. If empty, uses the agent's main model.
    #[serde(default)]
    pub model: Option<String>,

    /// Maximum tokens for the summarization response.
    #[serde(default = "default_summary_max_tokens")]
    pub summary_max_tokens: u32,

    /// Minimum number of messages before compaction is considered.
    #[serde(default = "default_min_messages")]
    pub min_messages: usize,

    /// Hard floor: minimum tokens to preserve as recent context.
    #[serde(default = "default_floor_tokens")]
    pub floor_tokens: usize,

    /// Tokens reserved for the compaction summary output (default 2048).
    #[serde(default = "default_reserved_summary_tokens")]
    pub reserved_summary_tokens: usize,

    /// Fixed buffer to avoid hitting the exact context limit (default 13000).
    #[serde(default = "default_buffer_tokens")]
    pub buffer_tokens: usize,
}

fn default_enabled() -> bool {
    true
}
fn default_trigger_ratio() -> f32 {
    0.8
}
fn default_keep_ratio() -> f32 {
    0.4
}
fn default_summary_max_tokens() -> u32 {
    // grill-me 式结构化压缩 schema 比散文摘要长得多（任务树/决策账本/否定路线/
    // 用户纠正原话保真）。OpenClaw 侧目标 ≤12k tokens，这里给到 12000 上限，
    // 避免结构化摘要在决策账本/下一步章节处被截断。
    12_000
}
fn default_min_messages() -> usize {
    8
}
fn default_floor_tokens() -> usize {
    16_000
}
fn default_reserved_summary_tokens() -> usize {
    20_000
}
fn default_buffer_tokens() -> usize {
    13_000
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            trigger_ratio: default_trigger_ratio(),
            keep_ratio: default_keep_ratio(),
            model: None,
            summary_max_tokens: default_summary_max_tokens(),
            min_messages: default_min_messages(),
            floor_tokens: default_floor_tokens(),
            reserved_summary_tokens: default_reserved_summary_tokens(),
            buffer_tokens: default_buffer_tokens(),
        }
    }
}

impl CompactionConfig {
    /// Compute the effective budget for compaction.
    ///
    /// `effective = context_window - reserved_summary - buffer`
    ///
    /// Reserve space for the summary output and a safety buffer,
    /// then compact when history exceeds the remaining budget.
    pub fn effective_budget(&self, context_window: usize) -> usize {
        context_window
            .saturating_sub(self.reserved_summary_tokens)
            .saturating_sub(self.buffer_tokens)
    }
}

// ============================================
// Compaction State (per session)
// ============================================

/// Cached compaction state for a session.
///
/// Tracks the summary of previously compacted messages and how many
/// messages have been compacted, enabling incremental compaction.
#[derive(Debug, Clone, Default)]
pub struct CompactionState {
    /// Summary of compacted older messages.
    pub summary: Option<String>,
    /// Number of original messages covered by the summary.
    pub compacted_count: usize,
    /// Consecutive LLM compaction failures. Reset on success.
    /// Acts as a circuit breaker to avoid wasting API calls when
    /// summarization is persistently failing.
    pub consecutive_failures: u32,
    /// Re-compaction metadata — tracks how many times this session
    /// has been compacted and which turn triggered the last compaction.
    pub recompaction_info: RecompactionInfo,
}

/// Metadata about re-compaction history, injected into the summarization
/// prompt so the LLM can produce better incremental summaries.
#[derive(Debug, Clone, Default)]
pub struct RecompactionInfo {
    /// How many times compaction has been performed in this session.
    pub compaction_count: u32,
    /// The turn number (message count) when the last compaction fired.
    pub last_compaction_turn: usize,
}

// ============================================
// Compaction Outcome
// ============================================

/// Describes what happened during a compaction attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionOutcome {
    /// LLM summarization succeeded; older messages replaced with summary.
    Compacted {
        messages_dropped: usize,
        messages_kept: usize,
    },
    /// LLM summarization failed or was skipped by the circuit breaker;
    /// oldest messages were silently dropped instead.
    Truncated { messages_dropped: usize },
    /// History was already within budget — no compaction needed.
    Skipped,
}

// ============================================
// Compactor
// ============================================

/// Safety margin multiplier for token estimation inaccuracy.
const SAFETY_MARGIN: f32 = 1.2;

/// Stop attempting LLM-based compaction after this many consecutive failures.
/// Ref: claude_code autoCompact.ts MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
pub(crate) const MAX_CONSECUTIVE_COMPACTION_FAILURES: u32 = 3;

/// Minimum adaptive keep ratio (don't go below 15% recent).
pub(crate) const MIN_KEEP_RATIO: f32 = 0.15;

/// Context compactor: summarizes older messages to fit the context window.
pub struct ContextCompactor;

pub(crate) fn compacted_summary_message(text: impl Into<String>) -> Value {
    serde_json::json!({
        "role": "system",
        "content": [{
            "type": "text",
            "text": text.into(),
            (ORGII_SYSTEM_CACHE_SCOPE_KEY): RenderedSystemBlockScope::Session.as_str(),
        }],
    })
}

impl ContextCompactor {
    /// Count tokens for a single OpenAI-format message.
    pub(crate) fn estimate_message_tokens(msg: &Value) -> usize {
        tokenizer::count_message_tokens(msg)
    }

    /// Count total tokens across a list of messages.
    pub(crate) fn estimate_messages_tokens(messages: &[Value]) -> usize {
        tokenizer::count_messages_tokens(messages)
    }

    /// Check if a single message is too large to summarize safely.
    pub(crate) fn is_oversized(msg: &Value, budget_tokens: usize) -> bool {
        let tokens = Self::estimate_message_tokens(msg) as f32 * SAFETY_MARGIN;
        tokens > budget_tokens as f32 * 0.5
    }

    /// Compute adaptive keep ratio based on average message size.
    pub(crate) fn adaptive_keep_ratio(
        messages: &[Value],
        budget_tokens: usize,
        base_ratio: f32,
    ) -> f32 {
        if messages.is_empty() {
            return base_ratio;
        }

        let total_tokens = Self::estimate_messages_tokens(messages);
        let avg_tokens = total_tokens as f32 / messages.len() as f32;

        let safe_avg = avg_tokens * SAFETY_MARGIN;
        let avg_ratio = safe_avg / budget_tokens as f32;

        if avg_ratio > 0.1 {
            let reduction = (avg_ratio * 2.0).min(base_ratio - MIN_KEEP_RATIO);
            (base_ratio - reduction).max(MIN_KEEP_RATIO)
        } else {
            base_ratio
        }
    }

    /// Check if compaction is needed.
    ///
    /// Uses `effective_budget` (= context_window - reserved_summary -
    /// buffer) rather than the raw context window, then multiplies it
    /// by `trigger_ratio` so the default 0.8 fires compaction when
    /// history exceeds 80% of the effective budget. The reserved /
    /// buffer carve-out leaves room for the summary output and a
    /// safety margin.
    pub fn needs_compaction(
        history: &[Value],
        context_window: usize,
        config: &CompactionConfig,
    ) -> bool {
        if !config.enabled || history.len() < config.min_messages {
            return false;
        }

        let budget = config.effective_budget(context_window);
        let trigger_threshold = (budget as f32 * config.trigger_ratio) as usize;
        let history_tokens = Self::estimate_messages_tokens(history);
        history_tokens > trigger_threshold
    }

    /// Compact history by summarizing older messages.
    ///
    /// Returns the compacted history and an outcome describing what happened.
    /// If compaction fails (LLM error), falls back to simple truncation.
    pub async fn compact(
        history: &[Value],
        budget_tokens: usize,
        config: &CompactionConfig,
        state: &mut CompactionState,
        provider: &dyn LLMProvider,
        model: &str,
    ) -> (Vec<Value>, CompactionOutcome) {
        if state.consecutive_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES {
            warn!(
                "[compaction] Circuit breaker: {} consecutive failures, skipping LLM compaction",
                state.consecutive_failures
            );
            let truncated = Self::simple_truncate(history, budget_tokens);
            let dropped = history.len().saturating_sub(truncated.len());
            return (
                truncated,
                CompactionOutcome::Truncated {
                    messages_dropped: dropped,
                },
            );
        }

        let history_tokens = Self::estimate_messages_tokens(history);

        if history_tokens <= budget_tokens {
            return (history.to_vec(), CompactionOutcome::Skipped);
        }

        let effective_ratio = Self::adaptive_keep_ratio(history, budget_tokens, config.keep_ratio);
        let keep_tokens =
            (budget_tokens as f32 * effective_ratio).max(config.floor_tokens as f32) as usize;

        let mut kept_tokens = 0usize;
        let mut split_idx = history.len();

        for idx in (0..history.len()).rev() {
            let msg_tokens = Self::estimate_message_tokens(&history[idx]);

            if kept_tokens + msg_tokens > keep_tokens {
                split_idx = idx + 1;
                break;
            }
            kept_tokens += msg_tokens;
        }

        if split_idx == 0 || split_idx >= history.len() {
            let truncated = Self::simple_truncate(history, budget_tokens);
            let dropped = history.len().saturating_sub(truncated.len());
            return (
                truncated,
                CompactionOutcome::Truncated {
                    messages_dropped: dropped,
                },
            );
        }

        let split_idx = Self::snap_to_api_round_boundary(history, split_idx);
        let split_idx = Self::adjust_split_for_tool_pairs(history, split_idx);

        let older = &history[..split_idx];
        let recent = &history[split_idx..];

        info!(
            "[compaction] Compacting {} older messages ({} tokens) → summary; keeping {} recent ({} tokens)",
            older.len(),
            Self::estimate_messages_tokens(older),
            recent.len(),
            Self::estimate_messages_tokens(recent),
        );

        let summary_model = config.model.as_deref().unwrap_or(model);

        let mut messages_to_summarize: Vec<Value> = older.to_vec();
        let mut ptl_retries = 0;
        const MAX_PTL_RETRIES: usize = 2;

        loop {
            let summary = summarization::summarize_messages(
                &messages_to_summarize,
                state,
                provider,
                summary_model,
                config,
                budget_tokens,
            )
            .await;

            match summary {
                Ok(summary_text) => {
                    state.consecutive_failures = 0;
                    state.summary = Some(summary_text.clone());
                    state.compacted_count = split_idx;
                    state.recompaction_info.compaction_count += 1;
                    state.recompaction_info.last_compaction_turn = history.len();

                    let mut compacted = Vec::with_capacity(recent.len() + 1);

                    let summary_msg = compacted_summary_message(format!(
                        "{} {} earlier messages compacted]\n\n{}",
                        super::session_memory::compact::LLM_COMPACT_BOUNDARY_PREFIX,
                        split_idx,
                        summary_text
                    ));
                    compacted.push(summary_msg);
                    compacted.extend_from_slice(recent);

                    let compacted_tokens = Self::estimate_messages_tokens(&compacted);
                    info!(
                        "[compaction] Compacted history: {} messages, ~{} tokens (was {} messages, ~{} tokens)",
                        compacted.len(), compacted_tokens, history.len(), history_tokens
                    );

                    let outcome = CompactionOutcome::Compacted {
                        messages_dropped: split_idx,
                        messages_kept: recent.len(),
                    };
                    return (compacted, outcome);
                }
                Err(err)
                    if Self::is_prompt_too_long_error(&err) && ptl_retries < MAX_PTL_RETRIES =>
                {
                    ptl_retries += 1;
                    let old_len = messages_to_summarize.len();
                    let drop_count = (old_len / 4).max(1);
                    messages_to_summarize = messages_to_summarize[drop_count..].to_vec();
                    warn!(
                        "[compaction] PTL error during summarization (retry {}/{}), truncating head: {} → {} messages. Error: {}",
                        ptl_retries, MAX_PTL_RETRIES, old_len, messages_to_summarize.len(), err,
                    );

                    if messages_to_summarize.is_empty() {
                        let truncated = Self::simple_truncate(history, budget_tokens);
                        let dropped = history.len().saturating_sub(truncated.len());
                        return (
                            truncated,
                            CompactionOutcome::Truncated {
                                messages_dropped: dropped,
                            },
                        );
                    }
                }
                Err(err) => {
                    state.consecutive_failures += 1;
                    warn!(
                        "[compaction] Summarization failed ({}/{}), falling back to truncation: {}",
                        state.consecutive_failures, MAX_CONSECUTIVE_COMPACTION_FAILURES, err
                    );
                    let truncated = Self::simple_truncate(history, budget_tokens);
                    let dropped = history.len().saturating_sub(truncated.len());
                    return (
                        truncated,
                        CompactionOutcome::Truncated {
                            messages_dropped: dropped,
                        },
                    );
                }
            }
        }
    }

    /// Snap the split index forward to the nearest "user" message.
    ///
    /// This aligns the split at a conversation API-round boundary so the
    /// "older" segment ends at a natural turn break and the "recent"
    /// segment starts with a user message.  If no user message is found
    /// within a small window (5 messages), the original index is returned
    /// to avoid discarding too many messages.
    pub(crate) fn snap_to_api_round_boundary(messages: &[Value], split_idx: usize) -> usize {
        const MAX_SCAN: usize = 5;
        for offset in 0..MAX_SCAN {
            let idx = split_idx + offset;
            if idx >= messages.len() {
                break;
            }
            let role = messages[idx]
                .get("role")
                .and_then(|val| val.as_str())
                .unwrap_or("");
            if role == "user" {
                return idx;
            }
        }
        split_idx
    }

    /// Adjust the split index to avoid breaking tool call/result pairs.
    pub(crate) fn adjust_split_for_tool_pairs(messages: &[Value], mut split_idx: usize) -> usize {
        while split_idx < messages.len() {
            let role = messages[split_idx]
                .get("role")
                .and_then(|val| val.as_str())
                .unwrap_or("");

            if role == "tool" {
                split_idx += 1;
            } else {
                break;
            }
        }

        if split_idx > 0 && split_idx < messages.len() {
            let last_older = &messages[split_idx - 1];
            let has_tool_calls = last_older
                .get("tool_calls")
                .and_then(|tc| tc.as_array())
                .map(|arr| !arr.is_empty())
                .unwrap_or(false);

            if has_tool_calls {
                while split_idx < messages.len() {
                    let role = messages[split_idx]
                        .get("role")
                        .and_then(|val| val.as_str())
                        .unwrap_or("");
                    if role == "tool" {
                        split_idx += 1;
                    } else {
                        break;
                    }
                }
            }
        }

        split_idx
    }

    /// Check if an error message indicates a "prompt too long" (PTL) condition.
    pub(crate) fn is_prompt_too_long_error(err: &str) -> bool {
        let lower = err.to_lowercase();
        lower.contains("prompt is too long")
            || lower.contains("context_length_exceeded")
            || lower.contains("max_tokens")
            || lower.contains("too many tokens")
            || lower.contains("token limit")
            || lower.contains("context window")
            || lower.contains("prompt too long")
    }

    /// Fallback: simple truncation when LLM-based compaction fails or is not feasible.
    ///
    /// Always preserves the head of the conversation (leading system
    /// messages plus the first user message — i.e. the task statement) and
    /// truncates from the message *after* it. Truncating from index 0 used
    /// to drop the task goal first, leaving the agent amnesiac about what
    /// it was even doing.
    pub(crate) fn simple_truncate(history: &[Value], budget_tokens: usize) -> Vec<Value> {
        // Head = leading system messages + the first user message.
        let mut head_len = 0usize;
        for msg in history {
            let role = msg.get("role").and_then(|val| val.as_str()).unwrap_or("");
            if role == "system" {
                head_len += 1;
            } else if role == "user" {
                head_len += 1;
                break;
            } else {
                break;
            }
        }

        let total_tokens = Self::estimate_messages_tokens(history);
        let head_tokens: usize = history[..head_len]
            .iter()
            .map(Self::estimate_message_tokens)
            .sum();
        let tail_budget = budget_tokens.saturating_sub(head_tokens);

        let mut start_idx = head_len;
        if total_tokens > budget_tokens {
            let mut trimmed = 0usize;
            let tail_tokens = total_tokens.saturating_sub(head_tokens);
            for (offset, msg) in history[head_len..].iter().enumerate() {
                trimmed += Self::estimate_message_tokens(msg);
                if tail_tokens.saturating_sub(trimmed) <= tail_budget {
                    start_idx = head_len + offset + 1;
                    break;
                }
            }
        }

        if start_idx > head_len && start_idx < history.len() {
            start_idx = Self::adjust_split_for_tool_pairs(history, start_idx);
        }

        let mut result: Vec<Value> = history[..head_len.min(history.len())].to_vec();
        if start_idx > head_len && start_idx < history.len() {
            result.push(serde_json::json!({
                "role": "system",
                "content": format!("[{} earlier messages truncated to fit context window]", start_idx - head_len),
            }));
        }
        if start_idx < history.len() {
            result.extend_from_slice(&history[start_idx..]);
        }
        result
    }
}
