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
pub use super::summarization::ForkSummaryInputs;
use super::tokenizer;
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

    /// Fraction of the effective budget at which compaction triggers.
    /// The effective budget already carves out the summary reserve and
    /// safety buffer, so the default is 1.0 — trigger at the effective
    /// budget directly. Lower values trigger earlier.
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

    /// Tokens reserved for the compaction summary output (default 20000).
    #[serde(default = "default_reserved_summary_tokens")]
    pub reserved_summary_tokens: usize,

    /// Fixed buffer to avoid hitting the exact context limit (default 13000).
    #[serde(default = "default_buffer_tokens")]
    pub buffer_tokens: usize,
}

fn default_enabled() -> bool {
    true
}
// 1.0: `effective_budget` already subtracts the summary reserve and safety
// buffer, so no extra ratio margin is stacked on top. Ref: claude_code
// autoCompact.ts triggers at effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS
// with no ratio multiplier.
fn default_trigger_ratio() -> f32 {
    1.0
}
fn default_keep_ratio() -> f32 {
    0.4
}
// Matches `reserved_summary_tokens`. Ref: claude_code
// COMPACT_MAX_OUTPUT_TOKENS = 20_000 (p99.99 of summary output ≈ 17.4k);
// a 4k cap truncated 9-section summaries mid-section.
fn default_summary_max_tokens() -> u32 {
    20_000
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
    /// LLM summarization failed (or the circuit breaker is open). The
    /// history is returned UNCHANGED — never silently truncated. Ref:
    /// claude_code autoCompact.ts: a failed compaction returns
    /// `wasCompacted: false` and the turn proceeds with the original
    /// history (if it can't compact, it doesn't compact).
    Failed { reason: String },
    /// History was already within budget — no compaction needed.
    Skipped,
}

/// Result of a single LLM compaction attempt, before any fallback policy is
/// applied. Internal to [`ContextCompactor::try_compact`] and its wrappers:
/// the automatic path maps non-`Compacted` attempts to `Failed` (history
/// unchanged), the manual path maps them to user-facing statuses.
enum CompactAttempt {
    /// Summarization succeeded; `compacted` is `[summary] + recent tail`.
    Compacted {
        compacted: Vec<Value>,
        messages_dropped: usize,
        messages_kept: usize,
    },
    /// History is under the trigger threshold — nothing to do.
    Skipped,
    /// The keep window covers the entire history (or nothing would remain);
    /// there is no older segment to summarize.
    NoCompactableSegment,
    /// The summarizer input stayed prompt-too-long even after head-dropping
    /// retries. Not a provider failure: the automatic path reports `Failed`
    /// without feeding the circuit breaker, the manual path surfaces it as
    /// an error.
    SummarizeInputExhausted,
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

/// Manual desktop compaction should work on medium-sized histories too; the
/// automatic 16k floor often keeps too much recent context for an explicit
/// user-triggered compaction.
pub(crate) const MANUAL_COMPACT_FLOOR_TOKENS: usize = 4_000;

/// Head-dropping retries when the summarizer input is itself prompt-too-long.
const MAX_PTL_RETRIES: usize = 2;

/// Context compactor: summarizes older messages to fit the context window.
pub struct ContextCompactor;

/// Continuation instruction appended to every compaction summary. The
/// summary lands as a **user** message (models weigh user messages far more
/// than system background), and this suffix tells the model to resume
/// silently instead of treating the summary as reference material.
///
/// `pub` (not `pub(crate)`): the app-side event pipeline strips it when
/// rendering a persisted boundary row as a chat marker, and the TS adapter
/// keeps a string twin in `agentMessageAdapters.ts` — this constant is the
/// source of truth for both.
pub const COMPACT_CONTINUATION_SUFFIX: &str = "This session is being continued from an earlier conversation that exceeded the context window; the older messages were compacted into the summary above. Resume the work directly from this state — do not acknowledge this summary, do not re-describe it to the user, and do not ask questions it already answers. Continue with the last task you were working on, following the user's most recent instructions.";

pub(crate) fn compacted_summary_message(text: impl Into<String>) -> Value {
    serde_json::json!({
        "role": "user",
        "content": format!("{}\n\n{}", text.into(), COMPACT_CONTINUATION_SUFFIX),
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
    /// buffer) rather than the raw context window, scaled by
    /// `trigger_ratio` (default 1.0 — the reserved / buffer carve-out
    /// already leaves room for the summary output and a safety margin,
    /// so no extra ratio margin is stacked on top).
    pub fn needs_compaction(
        history: &[Value],
        context_window: usize,
        config: &CompactionConfig,
    ) -> bool {
        Self::needs_compaction_with_budget(history, config.effective_budget(context_window), config)
    }

    /// Like [`Self::needs_compaction`] but against an explicit (possibly
    /// calibrated) token budget instead of deriving one from the raw
    /// context window.
    pub fn needs_compaction_with_budget(
        history: &[Value],
        budget_tokens: usize,
        config: &CompactionConfig,
    ) -> bool {
        if !config.enabled || history.len() < config.min_messages {
            return false;
        }

        let trigger_threshold = (budget_tokens as f32 * config.trigger_ratio) as usize;
        let history_tokens = Self::estimate_messages_tokens(history);
        history_tokens > trigger_threshold
    }

    /// Like [`Self::needs_compaction`] but also considers the
    /// provider-reported real context fill from the previous turn.
    ///
    /// Triggers when EITHER the local estimate or the observed real fill
    /// exceeds the threshold — the estimator systematically undercounts
    /// (images count as 0 tokens, cl100k vs the provider's tokenizer,
    /// long-text sampling), so an under-threshold estimate alone must not
    /// veto compaction when the provider has already measured the prompt
    /// above the threshold. `observed_tokens` covers the full prompt
    /// (system prefix + tool definitions) while the threshold is
    /// tail-scoped; the resulting slightly-early trigger errs on the safe
    /// side. Pass `0` when no real reading is available.
    pub fn needs_compaction_observed(
        history: &[Value],
        context_window: usize,
        config: &CompactionConfig,
        observed_tokens: usize,
    ) -> bool {
        if !config.enabled {
            return false;
        }

        let budget = config.effective_budget(context_window);
        let trigger_threshold = (budget as f32 * config.trigger_ratio) as usize;

        // A provider-measured fill above the threshold overrides the
        // min_messages gate: a handful of enormous messages must still
        // compact instead of eating a PTL rejection every turn.
        if observed_tokens > trigger_threshold {
            return true;
        }

        // Estimate-only path: keep the gate — tiny histories are noise.
        if history.len() < config.min_messages {
            return false;
        }

        let history_tokens = Self::estimate_messages_tokens(history).max(observed_tokens);
        history_tokens > trigger_threshold
    }

    /// Compact history by summarizing older messages.
    ///
    /// Returns the compacted history and an outcome describing what happened.
    /// If compaction fails (LLM error), the history is returned UNCHANGED
    /// with [`CompactionOutcome::Failed`] — the caller decides whether to
    /// proceed with the original history (auto path) or surface the error
    /// (reactive/manual paths). Never silently truncates.
    pub async fn compact(
        history: &[Value],
        budget_tokens: usize,
        config: &CompactionConfig,
        state: &mut CompactionState,
        provider: &dyn LLMProvider,
        model: &str,
    ) -> (Vec<Value>, CompactionOutcome) {
        Self::compact_with_fork(history, budget_tokens, config, state, provider, model, None).await
    }

    /// Like [`Self::compact`], with optional fork-form summarization
    /// inputs. When provided, the summary call is issued against the main
    /// turn's exact request prefix (system prefix + full history + same
    /// tools/model), reading the provider prompt cache written by the
    /// previous turn instead of paying a cold full-prompt cost. A fork
    /// failure falls back to the side-query path transparently.
    #[allow(clippy::too_many_arguments)]
    pub async fn compact_with_fork(
        history: &[Value],
        budget_tokens: usize,
        config: &CompactionConfig,
        state: &mut CompactionState,
        provider: &dyn LLMProvider,
        model: &str,
        fork_inputs: Option<&ForkSummaryInputs<'_>>,
    ) -> (Vec<Value>, CompactionOutcome) {
        if state.consecutive_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES {
            warn!(
                "[compaction] Circuit breaker: {} consecutive failures, skipping LLM compaction",
                state.consecutive_failures
            );
            return (
                history.to_vec(),
                CompactionOutcome::Failed {
                    reason: format!(
                        "circuit breaker open ({} consecutive failures)",
                        state.consecutive_failures
                    ),
                },
            );
        }

        match Self::try_compact(
            history,
            budget_tokens,
            config,
            state,
            provider,
            model,
            None,
            fork_inputs,
        )
        .await
        {
            Ok(CompactAttempt::Compacted {
                compacted,
                messages_dropped,
                messages_kept,
            }) => (
                compacted,
                CompactionOutcome::Compacted {
                    messages_dropped,
                    messages_kept,
                },
            ),
            Ok(CompactAttempt::Skipped) => (history.to_vec(), CompactionOutcome::Skipped),
            Ok(CompactAttempt::NoCompactableSegment) => (
                history.to_vec(),
                CompactionOutcome::Failed {
                    reason: "no compactable segment (keep window covers entire history)"
                        .to_string(),
                },
            ),
            Ok(CompactAttempt::SummarizeInputExhausted) => (
                history.to_vec(),
                CompactionOutcome::Failed {
                    reason: format!(
                        "summarization input remained too large after {} head-dropping retries",
                        MAX_PTL_RETRIES
                    ),
                },
            ),
            Err(err) => {
                state.consecutive_failures += 1;
                warn!(
                    "[compaction] Summarization failed ({}/{}), keeping history unchanged: {}",
                    state.consecutive_failures, MAX_CONSECUTIVE_COMPACTION_FAILURES, err
                );
                (history.to_vec(), CompactionOutcome::Failed { reason: err })
            }
        }
    }

    /// Force a user-triggered compaction without changing automatic
    /// threshold behavior.
    ///
    /// Unlike [`Self::compact`], this neither consults the failure circuit
    /// breaker nor falls back to silent truncation: the user asked for this
    /// compaction explicitly, so a summarization failure must surface as an
    /// error, and a manual failure must not advance the auto path's failure
    /// counter.
    pub async fn compact_manual_force(
        history: &[Value],
        budget_tokens: usize,
        config: &CompactionConfig,
        state: &mut CompactionState,
        provider: &dyn LLMProvider,
        model: &str,
        custom_instructions: Option<&str>,
    ) -> Result<(Vec<Value>, CompactionOutcome), String> {
        let mut manual_config = config.clone();
        manual_config.trigger_ratio = 0.0;
        manual_config.floor_tokens = manual_config.floor_tokens.min(MANUAL_COMPACT_FLOOR_TOKENS);

        match Self::try_compact(
            history,
            budget_tokens,
            &manual_config,
            state,
            provider,
            model,
            custom_instructions,
            None,
        )
        .await?
        {
            CompactAttempt::Compacted {
                compacted,
                messages_dropped,
                messages_kept,
            } => Ok((
                compacted,
                CompactionOutcome::Compacted {
                    messages_dropped,
                    messages_kept,
                },
            )),
            CompactAttempt::Skipped | CompactAttempt::NoCompactableSegment => {
                Ok((history.to_vec(), CompactionOutcome::Skipped))
            }
            CompactAttempt::SummarizeInputExhausted => Err(format!(
                "summarization input remained too large after {} head-dropping retries",
                MAX_PTL_RETRIES
            )),
        }
    }

    /// One LLM compaction attempt with no fallback: the caller decides how
    /// to handle a summarization failure (`compact` returns the history
    /// unchanged as `Failed`, the manual path surfaces the error to the
    /// user).
    #[allow(clippy::too_many_arguments)]
    async fn try_compact(
        history: &[Value],
        budget_tokens: usize,
        config: &CompactionConfig,
        state: &mut CompactionState,
        provider: &dyn LLMProvider,
        model: &str,
        custom_instructions: Option<&str>,
        fork_inputs: Option<&ForkSummaryInputs<'_>>,
    ) -> Result<CompactAttempt, String> {
        let history_tokens = Self::estimate_messages_tokens(history);

        // Skip at the same trigger threshold as `needs_compaction`, not at
        // the full budget — otherwise a caller whose trigger fired (>80% of
        // budget) gets a silent no-op here (estimate still ≤ 100% of budget)
        // and the history keeps growing until the provider rejects it.
        let trigger_threshold = (budget_tokens as f32 * config.trigger_ratio) as usize;
        if history_tokens <= trigger_threshold {
            return Ok(CompactAttempt::Skipped);
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
            return Ok(CompactAttempt::NoCompactableSegment);
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

        // Fork-form first: reuse the main turn's prompt-cache prefix. The
        // fork summarizes the FULL conversation (prefix includes `recent`);
        // keeping `recent` verbatim afterwards mirrors claude_code, which
        // also keeps recent turns alongside the whole-conversation summary.
        // Any fork failure falls back to the cold side-query path (ref:
        // claude_code tengu_compact_cache_sharing_fallback).
        if let Some(fork) = fork_inputs {
            match summarization::summarize_messages_forked(
                provider,
                fork,
                state,
                custom_instructions,
            )
            .await
            {
                Ok(summary_text) => {
                    return Ok(Self::accept_summary(
                        state,
                        history,
                        split_idx,
                        recent,
                        summary_text,
                    ));
                }
                Err(err) => {
                    warn!(
                        "[compaction] fork-form summarization failed, falling back to side query: {}",
                        err
                    );
                }
            }
        }

        let mut messages_to_summarize: Vec<Value> = older.to_vec();
        let mut ptl_retries = 0;

        loop {
            let summary = summarization::summarize_messages(
                &messages_to_summarize,
                state,
                provider,
                summary_model,
                config,
                budget_tokens,
                custom_instructions,
            )
            .await;

            match summary {
                Ok(summary_text) => {
                    return Ok(Self::accept_summary(
                        state,
                        history,
                        split_idx,
                        recent,
                        summary_text,
                    ));
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
                        warn!(
                            "[compaction] summarization input still too large after {} retries: {}",
                            MAX_PTL_RETRIES, err
                        );
                        return Ok(CompactAttempt::SummarizeInputExhausted);
                    }
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Record a successful summarization into `state` and assemble the
    /// compacted view (`[boundary summary message] + recent tail`).
    fn accept_summary(
        state: &mut CompactionState,
        history: &[Value],
        split_idx: usize,
        recent: &[Value],
        summary_text: String,
    ) -> CompactAttempt {
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
            compacted.len(),
            compacted_tokens,
            history.len(),
            Self::estimate_messages_tokens(history),
        );

        CompactAttempt::Compacted {
            compacted,
            messages_dropped: split_idx,
            messages_kept: recent.len(),
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

    /// Extract the provider-reported ACTUAL prompt token count from a
    /// "prompt too long" error message.
    ///
    /// Returns the largest number immediately followed by the word
    /// "tokens": Anthropic reports `prompt is too long: 1037806 tokens >
    /// 1000000 maximum` (actual precedes "tokens", limit precedes
    /// "maximum"); OpenAI reports `maximum context length is 128000
    /// tokens. However, your messages resulted in 130000 tokens` (both
    /// precede "tokens", the actual is the larger).
    pub fn parse_actual_tokens_from_error(err: &str) -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut current = 0usize;
        let mut in_number = false;
        let bytes = err.as_bytes();
        for (idx, byte) in bytes.iter().enumerate() {
            if byte.is_ascii_digit() {
                current = current.saturating_mul(10) + (byte - b'0') as usize;
                in_number = true;
            } else {
                if in_number {
                    let rest = err[idx..].trim_start_matches([' ', ':']);
                    if rest.starts_with("tokens") && best.is_none_or(|b| current > b) {
                        best = Some(current);
                    }
                }
                current = 0;
                in_number = false;
            }
        }
        // Number at end of string can't be followed by "tokens" — ignore.
        best
    }

    /// Scale `budget_tokens` (denominated in ESTIMATED tokens) down by the
    /// observed estimator undercount, so that truncating/compacting to the
    /// calibrated budget lands the ACTUAL prompt within the real limit.
    ///
    /// `estimated_tokens` is the local estimate of the same history the
    /// provider measured as `actual_tokens`. When the provider reports more
    /// than we estimated (the systematic case: images count as 0 locally,
    /// tokenizer mismatch, sampling), the returned budget is
    /// `budget × estimated / actual`. When the estimate is already at or
    /// above the actual, the budget is returned unchanged.
    pub fn calibrate_budget(
        budget_tokens: usize,
        estimated_tokens: usize,
        actual_tokens: usize,
    ) -> usize {
        if actual_tokens > estimated_tokens && estimated_tokens > 0 {
            ((budget_tokens as u128 * estimated_tokens as u128) / actual_tokens as u128) as usize
        } else {
            budget_tokens
        }
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
