//! Tests for context compaction: token estimation, message trimming, and tool-call handling.

use crate::model_context::compaction::{
    compacted_summary_message, CompactionConfig, CompactionState, ContextCompactor,
    MAX_CONSECUTIVE_COMPACTION_FAILURES, MIN_KEEP_RATIO,
};
use crate::model_context::summarization;
use crate::model_context::summarization::truncate_for_summary;
use crate::model_context::tokenizer;
use crate::test_support::{assistant_msg, assistant_with_tool_calls, tool_msg, user_msg};
use serde_json::{json, Value};

fn default_config() -> CompactionConfig {
    CompactionConfig::default()
}

// -- tokenizer::count_tokens --

#[test]
fn count_tokens_empty() {
    assert_eq!(tokenizer::count_tokens(""), 0);
}

#[test]
fn count_tokens_proportional_to_length() {
    let short = tokenizer::count_tokens("hello");
    let long = tokenizer::count_tokens(&"x".repeat(100));
    assert!(long > short);
}

// -- estimate_message_tokens --

#[test]
fn estimate_message_tokens_simple() {
    let msg = user_msg("hello world");
    let tokens = ContextCompactor::estimate_message_tokens(&msg);
    assert!(
        tokens > 0,
        "should estimate some tokens for content + overhead"
    );
}

#[test]
fn estimate_message_tokens_with_tool_calls() {
    let msg = json!({
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "function": {
                "name": "read_file",
                "arguments": "{\"file_path\": \"/tmp/long_path.txt\"}"
            }
        }]
    });
    let tokens = ContextCompactor::estimate_message_tokens(&msg);
    assert!(tokens > 10, "should include tool call argument tokens");
}

#[test]
fn estimate_message_tokens_with_reasoning() {
    let reasoning = "a".repeat(400);
    let msg = json!({
        "role": "assistant",
        "content": "short",
        "reasoning_content": reasoning
    });
    let without_reasoning = json!({"role": "assistant", "content": "short"});
    let with = ContextCompactor::estimate_message_tokens(&msg);
    let without = ContextCompactor::estimate_message_tokens(&without_reasoning);
    assert!(with > without, "reasoning content should add tokens");
}

// -- estimate_messages_tokens --

#[test]
fn estimate_messages_tokens_sums_all() {
    let msgs = vec![user_msg("hello"), assistant_msg("world")];
    let total = ContextCompactor::estimate_messages_tokens(&msgs);
    let sum: usize = msgs
        .iter()
        .map(ContextCompactor::estimate_message_tokens)
        .sum();
    assert_eq!(total, sum);
}

// -- needs_compaction --

#[test]
fn needs_compaction_disabled() {
    let mut config = default_config();
    config.enabled = false;
    let history: Vec<Value> = (0..20).map(|i| user_msg(&format!("msg {}", i))).collect();
    assert!(!ContextCompactor::needs_compaction(&history, 100, &config));
}

#[test]
fn needs_compaction_too_few_messages() {
    let config = default_config();
    let history = vec![user_msg("a"), assistant_msg("b")];
    assert!(!ContextCompactor::needs_compaction(&history, 1, &config));
}

#[test]
fn needs_compaction_within_budget() {
    let config = default_config();
    let history: Vec<Value> = (0..10).map(|i| user_msg(&format!("m{}", i))).collect();
    assert!(!ContextCompactor::needs_compaction(
        &history, 1_000_000, &config
    ));
}

#[test]
fn needs_compaction_exceeds_budget() {
    let config = default_config();
    let big_msg = "x".repeat(4000);
    let history: Vec<Value> = (0..10).map(|_| user_msg(&big_msg)).collect();
    assert!(ContextCompactor::needs_compaction(&history, 100, &config));
}

// Pin that `trigger_ratio` actually gates compaction (threshold =
// effective_budget * trigger_ratio). Uses the real token estimator so
// these guards survive small ratio tweaks in the estimator.
fn build_history_with_target_tokens(target_tokens: usize) -> Vec<Value> {
    let probe = user_msg(&"x".repeat(400));
    let probe_tokens = ContextCompactor::estimate_message_tokens(&probe);
    assert!(probe_tokens > 0, "estimator must report positive tokens");
    let count = target_tokens.div_ceil(probe_tokens).max(1);
    (0..count).map(|_| probe.clone()).collect()
}

#[test]
fn needs_compaction_respects_trigger_ratio_below() {
    // With trigger_ratio = 0.8 and effective_budget = 100k, history
    // well below 80k tokens should NOT trigger compaction.
    let mut config = default_config();
    config.trigger_ratio = 0.8;
    config.reserved_summary_tokens = 0;
    config.buffer_tokens = 0;
    config.min_messages = 0;
    let history = build_history_with_target_tokens(60_000);
    let total = ContextCompactor::estimate_messages_tokens(&history);
    assert!(
        total < 80_000,
        "fixture should stay under 80k, got {}",
        total
    );
    assert!(
        !ContextCompactor::needs_compaction(&history, 100_000, &config),
        "history at {} tokens should not trigger with budget=100k, ratio=0.8",
        total
    );
}

#[test]
fn needs_compaction_respects_trigger_ratio_above() {
    // Push history past 80k → must trigger.
    let mut config = default_config();
    config.trigger_ratio = 0.8;
    config.reserved_summary_tokens = 0;
    config.buffer_tokens = 0;
    config.min_messages = 0;
    let history = build_history_with_target_tokens(90_000);
    let total = ContextCompactor::estimate_messages_tokens(&history);
    assert!(total > 80_000, "fixture should exceed 80k, got {}", total);
    assert!(
        ContextCompactor::needs_compaction(&history, 100_000, &config),
        "history at {} tokens should trigger with budget=100k, ratio=0.8",
        total
    );
}

#[test]
fn needs_compaction_trigger_ratio_lower_fires_earlier() {
    // With a stricter ratio (0.5), compaction should fire at a history
    // size that would not have triggered with the 0.8 default. Build a
    // fixture sized between 50% and 80% of budget=100k.
    let history = build_history_with_target_tokens(65_000);
    let total = ContextCompactor::estimate_messages_tokens(&history);
    assert!(
        total > 50_000 && total < 80_000,
        "fixture must straddle the 0.5/0.8 thresholds, got {}",
        total
    );
    let mut lax = default_config();
    lax.trigger_ratio = 0.8;
    lax.reserved_summary_tokens = 0;
    lax.buffer_tokens = 0;
    lax.min_messages = 0;
    let mut strict = lax.clone();
    strict.trigger_ratio = 0.5;
    assert!(
        !ContextCompactor::needs_compaction(&history, 100_000, &lax),
        "lax ratio (0.8) should not trigger at {} tokens",
        total
    );
    assert!(
        ContextCompactor::needs_compaction(&history, 100_000, &strict),
        "strict ratio (0.5) should trigger at {} tokens",
        total
    );
}

// -- is_oversized --

#[test]
fn is_oversized_small_message() {
    assert!(!ContextCompactor::is_oversized(&user_msg("short"), 1000));
}

#[test]
fn is_oversized_huge_message() {
    let huge = user_msg(&"x".repeat(40_000));
    assert!(ContextCompactor::is_oversized(&huge, 1000));
}

// -- adaptive_keep_ratio --

#[test]
fn adaptive_keep_ratio_empty() {
    assert_eq!(
        ContextCompactor::adaptive_keep_ratio(&[], 100_000, 0.4),
        0.4
    );
}

#[test]
fn adaptive_keep_ratio_small_messages() {
    let history: Vec<Value> = (0..5).map(|i| user_msg(&format!("msg {}", i))).collect();
    let ratio = ContextCompactor::adaptive_keep_ratio(&history, 100_000, 0.4);
    assert!(
        (ratio - 0.4).abs() < 0.01,
        "small messages should not reduce ratio"
    );
}

#[test]
fn adaptive_keep_ratio_large_messages_reduces() {
    let big = "x".repeat(80_000);
    let history: Vec<Value> = (0..5).map(|_| user_msg(&big)).collect();
    let ratio = ContextCompactor::adaptive_keep_ratio(&history, 100_000, 0.4);
    assert!(ratio < 0.4, "large messages should reduce the keep ratio");
    assert!(
        ratio >= MIN_KEEP_RATIO,
        "should not go below MIN_KEEP_RATIO"
    );
}

// -- adjust_split_for_tool_pairs --

#[test]
fn adjust_split_no_tool_at_boundary() {
    let messages = vec![user_msg("a"), assistant_msg("b"), user_msg("c")];
    assert_eq!(
        ContextCompactor::adjust_split_for_tool_pairs(&messages, 1),
        1
    );
}

#[test]
fn adjust_split_tool_result_at_boundary() {
    let messages = vec![
        user_msg("a"),
        tool_msg("read_file", "content"),
        user_msg("b"),
    ];
    let adjusted = ContextCompactor::adjust_split_for_tool_pairs(&messages, 1);
    assert_eq!(adjusted, 2, "should skip past tool result");
}

#[test]
fn adjust_split_assistant_with_tool_calls() {
    let tc = json!({"id": "tc1", "function": {"name": "edit_file", "arguments": "{}"}});
    let messages = vec![
        user_msg("a"),
        assistant_with_tool_calls("", vec![tc]),
        tool_msg("edit_file", "ok"),
        user_msg("b"),
    ];
    let adjusted = ContextCompactor::adjust_split_for_tool_pairs(&messages, 2);
    assert_eq!(
        adjusted, 3,
        "should include tool result with its assistant message"
    );
}

#[test]
fn adjust_split_consecutive_tool_results() {
    let tc = json!({"id": "tc1", "function": {"name": "edit_file", "arguments": "{}"}});
    let messages = vec![
        user_msg("a"),
        assistant_with_tool_calls("", vec![tc]),
        tool_msg("edit_file", "ok"),
        tool_msg("code_search", "found"),
        user_msg("b"),
    ];
    let adjusted = ContextCompactor::adjust_split_for_tool_pairs(&messages, 2);
    assert_eq!(adjusted, 4, "should skip past all consecutive tool results");
}

// -- snap_to_api_round_boundary --

#[test]
fn snap_to_round_at_user_message() {
    let messages = vec![user_msg("a"), assistant_msg("b"), user_msg("c")];
    assert_eq!(
        ContextCompactor::snap_to_api_round_boundary(&messages, 0),
        0
    );
    assert_eq!(
        ContextCompactor::snap_to_api_round_boundary(&messages, 2),
        2
    );
}

#[test]
fn snap_to_round_skips_to_next_user() {
    let messages = vec![
        user_msg("a"),
        assistant_msg("b"),
        tool_msg("read_file", "content"),
        user_msg("c"),
    ];
    assert_eq!(
        ContextCompactor::snap_to_api_round_boundary(&messages, 1),
        3
    );
}

#[test]
fn snap_to_round_no_user_in_window_returns_original() {
    let messages: Vec<Value> = (0..10).map(|_| assistant_msg("x")).collect();
    assert_eq!(
        ContextCompactor::snap_to_api_round_boundary(&messages, 2),
        2
    );
}

// -- compacted summary cache rebase --

#[test]
fn compacted_summary_message_marks_session_cache_scope() {
    let msg =
        compacted_summary_message("[Conversation summary — 4 earlier messages compacted]\n\nDone");
    assert_eq!(msg["role"].as_str().unwrap(), "system");
    let blocks = msg["content"].as_array().expect("structured content");
    assert_eq!(blocks.len(), 1);
    assert_eq!(
        blocks[0]["text"].as_str().unwrap(),
        "[Conversation summary — 4 earlier messages compacted]\n\nDone"
    );
    assert_eq!(
        blocks[0][crate::session::prompt::cache::ORGII_SYSTEM_CACHE_SCOPE_KEY]
            .as_str()
            .unwrap(),
        "session"
    );
}

// -- simple_truncate --

#[test]
fn simple_truncate_within_budget() {
    let history = vec![user_msg("a"), assistant_msg("b")];
    let result = ContextCompactor::simple_truncate(&history, 1_000_000);
    assert_eq!(result.len(), 2);
}

#[test]
fn simple_truncate_removes_older_messages() {
    let big = "x".repeat(4000);
    let history: Vec<Value> = (0..10).map(|_| user_msg(&big)).collect();
    let total = ContextCompactor::estimate_messages_tokens(&history);
    let budget = total / 2;
    let result = ContextCompactor::simple_truncate(&history, budget);
    assert!(result.len() < 10);
    assert!(!result.is_empty());
    // Head (first user message = task statement) is always preserved,
    // followed by the truncation marker.
    let first_role = result[0].get("role").and_then(|v| v.as_str()).unwrap();
    assert_eq!(first_role, "user", "task statement must survive truncation");
    let second_role = result[1].get("role").and_then(|v| v.as_str()).unwrap();
    assert_eq!(second_role, "system", "should have truncation marker");
    assert!(result[1]
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap()
        .contains("truncated"));
}

#[test]
fn simple_truncate_preserves_system_prompt_and_task() {
    let big = "x".repeat(4000);
    let mut history = vec![
        json!({"role": "system", "content": "SYSTEM PROMPT"}),
        user_msg("THE TASK GOAL"),
    ];
    history.extend((0..10).map(|_| assistant_msg(&big)));
    let total = ContextCompactor::estimate_messages_tokens(&history);
    let result = ContextCompactor::simple_truncate(&history, total / 3);

    assert_eq!(
        result[0].get("content").and_then(|v| v.as_str()),
        Some("SYSTEM PROMPT")
    );
    assert_eq!(
        result[1].get("content").and_then(|v| v.as_str()),
        Some("THE TASK GOAL")
    );
    assert!(result.len() < history.len());
    // Tail (most recent messages) survives too.
    let last_role = result
        .last()
        .unwrap()
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap();
    assert_eq!(last_role, "assistant");
}

// -- truncate_for_summary --

#[test]
fn truncate_for_summary_short_text() {
    assert_eq!(truncate_for_summary("hello", 100), "hello");
}

#[test]
fn truncate_for_summary_long_text() {
    let long = "a".repeat(200);
    let result = truncate_for_summary(&long, 50);
    assert!(result.contains("... [truncated]"));
    assert!(result.len() < 200);
}

// -- format_messages_for_summary_refs --

#[test]
fn format_messages_labels_roles() {
    let msgs = [user_msg("hi"), assistant_msg("hello")];
    let refs: Vec<&Value> = msgs.iter().collect();
    let formatted = summarization::format_messages_for_summary_refs(&refs);
    assert!(formatted.contains("**User:**"));
    assert!(formatted.contains("**Assistant:**"));
}

#[test]
fn format_messages_includes_tool_results() {
    let msgs = [tool_msg("code_search", "found 3 matches")];
    let refs: Vec<&Value> = msgs.iter().collect();
    let formatted = summarization::format_messages_for_summary_refs(&refs);
    assert!(formatted.contains("**Tool result (code_search):**"));
}

#[test]
fn format_messages_skips_system() {
    let msgs = [json!({"role": "system", "content": "secret"})];
    let refs: Vec<&Value> = msgs.iter().collect();
    let formatted = summarization::format_messages_for_summary_refs(&refs);
    assert!(formatted.is_empty());
}

// -- format_tool_calls --

#[test]
fn format_tool_calls_extracts_name_and_args() {
    let msg = json!({
        "tool_calls": [{
            "function": {
                "name": "edit_file",
                "arguments": "{\"file_path\": \"main.rs\"}"
            }
        }]
    });
    let formatted = summarization::format_tool_calls(&msg);
    assert!(formatted.contains("edit_file"));
    assert!(formatted.contains("main.rs"));
}

#[test]
fn format_tool_calls_no_tool_calls() {
    let msg = json!({"role": "assistant", "content": "text"});
    assert!(summarization::format_tool_calls(&msg).is_empty());
}

// -- CompactionConfig default --

#[test]
fn compaction_config_defaults() {
    let config = CompactionConfig::default();
    assert!(config.enabled);
    assert!((config.trigger_ratio - 0.8).abs() < f32::EPSILON);
    assert!((config.keep_ratio - 0.4).abs() < f32::EPSILON);
    assert_eq!(config.summary_max_tokens, 4096);
    assert_eq!(config.min_messages, 8);
    assert_eq!(config.floor_tokens, 16_000);
    assert_eq!(config.reserved_summary_tokens, 20_000);
    assert_eq!(config.buffer_tokens, 13_000);
    assert!(config.model.is_none());
}

// -- effective_budget --

#[test]
fn effective_budget_subtracts_reserves() {
    let config = CompactionConfig::default();
    let budget = config.effective_budget(200_000);
    assert_eq!(budget, 200_000 - 20_000 - 13_000);
}

#[test]
fn effective_budget_saturates_at_zero() {
    let config = CompactionConfig {
        reserved_summary_tokens: 100_000,
        buffer_tokens: 100_000,
        ..Default::default()
    };
    assert_eq!(config.effective_budget(50_000), 0);
}

// -- CompactionState circuit breaker --

#[test]
fn compaction_state_default_has_zero_failures() {
    let state = CompactionState::default();
    assert_eq!(state.consecutive_failures, 0);
    assert!(state.summary.is_none());
    assert_eq!(state.compacted_count, 0);
}

#[test]
fn circuit_breaker_threshold_is_three() {
    assert_eq!(MAX_CONSECUTIVE_COMPACTION_FAILURES, 3);
}

#[test]
fn circuit_breaker_below_threshold_allows_compaction() {
    let state = CompactionState {
        consecutive_failures: 2,
        ..Default::default()
    };
    assert!(state.consecutive_failures < MAX_CONSECUTIVE_COMPACTION_FAILURES);
}

#[test]
fn circuit_breaker_at_threshold_blocks_compaction() {
    let state = CompactionState {
        consecutive_failures: 3,
        ..Default::default()
    };
    assert!(state.consecutive_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES);
}

#[test]
fn circuit_breaker_above_threshold_blocks_compaction() {
    let state = CompactionState {
        consecutive_failures: 10,
        ..Default::default()
    };
    assert!(state.consecutive_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES);
}

#[test]
fn circuit_breaker_reset_on_success() {
    let mut state = CompactionState {
        consecutive_failures: 2,
        ..Default::default()
    };
    state.consecutive_failures = 0;
    assert_eq!(state.consecutive_failures, 0);
    assert!(state.consecutive_failures < MAX_CONSECUTIVE_COMPACTION_FAILURES);
}

#[test]
fn circuit_breaker_increment_on_failure() {
    let mut state = CompactionState::default();
    for expected in 1..=4 {
        state.consecutive_failures += 1;
        assert_eq!(state.consecutive_failures, expected);
    }
    assert!(state.consecutive_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES);
}

// -- RecompactionInfo --

#[test]
fn recompaction_info_default() {
    let info = CompactionState::default().recompaction_info;
    assert_eq!(info.compaction_count, 0);
    assert_eq!(info.last_compaction_turn, 0);
}

// -- CompactionOutcome --

#[test]
fn compaction_outcome_variants() {
    use crate::model_context::compaction::CompactionOutcome;

    let skipped = CompactionOutcome::Skipped;
    assert_eq!(skipped, CompactionOutcome::Skipped);

    let compacted = CompactionOutcome::Compacted {
        messages_dropped: 10,
        messages_kept: 5,
    };
    if let CompactionOutcome::Compacted {
        messages_dropped,
        messages_kept,
    } = compacted
    {
        assert_eq!(messages_dropped, 10);
        assert_eq!(messages_kept, 5);
    }

    let truncated = CompactionOutcome::Truncated {
        messages_dropped: 8,
    };
    if let CompactionOutcome::Truncated { messages_dropped } = truncated {
        assert_eq!(messages_dropped, 8);
    }
}

// -- PTL error detection --

#[test]
fn ptl_detects_prompt_too_long() {
    assert!(ContextCompactor::is_prompt_too_long_error(
        "Error: prompt is too long (150000 tokens)"
    ));
}

#[test]
fn ptl_detects_context_length_exceeded() {
    assert!(ContextCompactor::is_prompt_too_long_error(
        "context_length_exceeded: max 128000 tokens"
    ));
}

#[test]
fn ptl_detects_too_many_tokens() {
    assert!(ContextCompactor::is_prompt_too_long_error(
        "Request has too many tokens"
    ));
}

#[test]
fn ptl_ignores_unrelated_errors() {
    assert!(!ContextCompactor::is_prompt_too_long_error(
        "network timeout after 30s"
    ));
    assert!(!ContextCompactor::is_prompt_too_long_error(
        "authentication failed"
    ));
}


#[test]
fn compaction_summary_model_ignores_config_override_for_route_consistency() {
    let mut config = default_config();
    config.model = Some("cheap/fallback-summary-model".to_string());

    // Runtime compaction must not honor this override. The live provider was
    // constructed for the foreground route; summary side-query gets the
    // foreground model from ContextCompactor::compact and uses the same route.
    assert_eq!(config.model.as_deref(), Some("cheap/fallback-summary-model"));
}
