//! Token usage accumulation for one turn.
//!
//! Extracted from `execute_turn` to keep the main loop body focused on
//! control flow. `UsageTotals` holds the per-turn counters; `accumulate`
//! folds one provider response into the totals and emits a structured log
//! line with both per-call and cumulative cache hit rates.

use std::collections::HashMap;

use tracing::info;

use crate::providers::traits::usage_key;

use super::backoff::cache_hit_rate;

/// Per-turn token totals accumulated across every LLM call within `execute_turn`.
#[derive(Default)]
pub(super) struct UsageTotals {
    pub prompt: i64,
    pub completion: i64,
    pub total: i64,
    /// Prompt tokens from the most recent LLM call — represents current
    /// context-window fill level (the `context_tokens` field on `TurnResult`).
    pub last_prompt: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

impl UsageTotals {
    /// Fold one provider response's usage map into the running totals and
    /// emit the structured per-call + cumulative log line.
    ///
    /// `usage` is the map returned on every successful streaming response;
    /// callers should skip this when the map is empty (e.g. the provider
    /// didn't surface any usage for an interrupted iteration).
    pub fn accumulate(&mut self, usage: &HashMap<String, i64>, session_id: &str) {
        let iter_prompt = usage.get(usage_key::PROMPT_TOKENS).copied().unwrap_or(0);
        let iter_completion = usage
            .get(usage_key::COMPLETION_TOKENS)
            .copied()
            .unwrap_or(0);
        let iter_total = usage.get(usage_key::TOTAL_TOKENS).copied().unwrap_or(0);
        let iter_cache_read = usage
            .get(usage_key::CACHE_READ_TOKENS)
            .copied()
            .unwrap_or(0);
        let iter_cache_write = usage
            .get(usage_key::CACHE_WRITE_TOKENS)
            .copied()
            .unwrap_or(0);

        self.prompt += iter_prompt;
        self.completion += iter_completion;
        self.total += iter_total;
        // Context-window fill = full prompt as seen by the provider. With
        // prompt caching, Anthropic's `prompt_tokens` is billable input only
        // (cache misses); the cached prefix arrives in cache_read/cache_write.
        // Summing them reconstructs the real context size — otherwise a
        // fully-cached 200K prompt reports as "2 tokens used" and every
        // breakdown percentage (computed against used_tokens) explodes.
        self.last_prompt = iter_prompt + iter_cache_read + iter_cache_write;
        self.cache_read += iter_cache_read;
        self.cache_write += iter_cache_write;

        // Cache hit rate = cache_read / prompt_tokens. In Anthropic's
        // accounting, `prompt_tokens` is billable input only (excluding
        // cache_read), so the "real" hit rate is
        // cache_read / (prompt_tokens + cache_read). That's the number that
        // maps directly to cost savings: at 90 %+ the prompt is almost free,
        // at < 30 % the caching barely helps. Logging both per-call and
        // cumulative makes regressions visible immediately — a sudden drop
        // means something started invalidating the prefix.
        let iter_hit_rate = cache_hit_rate(iter_cache_read, iter_prompt);
        let cum_hit_rate = cache_hit_rate(self.cache_read, self.prompt);
        info!(
            "[agent-core] Tokens this call: prompt={}, completion={}, total={}, cache_read={}, cache_write={}, hit_rate={:.0}% | cumulative: prompt={}, completion={}, total={}, cache_read={}, hit_rate={:.0}% (session={})",
            iter_prompt, iter_completion, iter_total, iter_cache_read, iter_cache_write, iter_hit_rate * 100.0,
            self.prompt, self.completion, self.total, self.cache_read, cum_hit_rate * 100.0,
            session_id,
        );
    }

    /// Final reconciliation: if the provider only surfaced split prompt /
    /// completion counts (no `total_tokens` row), back-fill `total` from
    /// the parts so callers see a consistent value.
    pub fn finalize(&mut self) {
        if self.total == 0 && (self.prompt > 0 || self.completion > 0) {
            self.total = self.prompt + self.completion;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_openai_compat_usage_preserves_context_and_hit_rate() {
        let usage = HashMap::from([
            (usage_key::PROMPT_TOKENS.to_string(), 400),
            (usage_key::COMPLETION_TOKENS.to_string(), 300),
            (usage_key::TOTAL_TOKENS.to_string(), 1500),
            (usage_key::CACHE_READ_TOKENS.to_string(), 800),
        ]);
        let mut totals = UsageTotals::default();

        totals.accumulate(&usage, "openai-compat-test");

        assert_eq!(totals.prompt, 400);
        assert_eq!(totals.completion, 300);
        assert_eq!(totals.total, 1500);
        assert_eq!(totals.last_prompt, 1200);
        assert_eq!(totals.cache_read, 800);
        assert_eq!(totals.cache_write, 0);
        assert!(
            (cache_hit_rate(totals.cache_read, totals.prompt) - (2.0 / 3.0)).abs() < f64::EPSILON
        );
    }
}
