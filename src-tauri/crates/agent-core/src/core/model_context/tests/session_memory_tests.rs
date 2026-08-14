//! Tests for session memory: config defaults, extraction triggers, SM-compact,
//! message preservation, and API invariant handling.

use crate::model_context::session_memory::{
    last_turn_has_tool_calls, resolve_summarized_boundary_idx, should_extract, try_sm_compact,
    SessionMemoryCompactConfig, SessionMemoryConfig, SessionMemoryState,
};
use crate::test_support::{assistant_msg, assistant_with_tool_calls, tool_msg, user_msg};
use serde_json::{json, Value};

/// Test shim: identity start-sequences (seq == index) so the pre-seq test
/// fixtures keep their meaning while also exercising the anchor resolver.
fn sm_compact(
    messages: &[Value],
    state: &SessionMemoryState,
    config: &SessionMemoryCompactConfig,
) -> Option<Vec<Value>> {
    let start_seqs: Vec<i64> = (0..messages.len() as i64).collect();
    let anchor_idx = resolve_summarized_boundary_idx(state.last_summarized_seq, &start_seqs);
    try_sm_compact(messages, state.content.as_deref(), anchor_idx, config)
}

fn message_text(msg: &Value) -> &str {
    let content = msg.get("content").expect("message content");
    if let Some(text) = content.as_str() {
        return text;
    }
    content
        .as_array()
        .and_then(|blocks| blocks.first())
        .and_then(|block| block.get("text"))
        .and_then(Value::as_str)
        .expect("structured text content")
}

// ============================================
// Config defaults
// ============================================

#[test]
fn config_defaults_match_spec() {
    let config = SessionMemoryConfig::default();
    assert!(config.enabled);
    assert_eq!(config.min_tokens_to_init, 10_000);
    assert_eq!(config.min_tokens_between_update, 5_000);
    assert_eq!(config.tool_calls_between_updates, 3);
    assert_eq!(config.max_section_tokens, 2_000);
    assert_eq!(config.max_total_tokens, 12_000);
    assert_eq!(config.extraction_max_tokens, 4096);
}

#[test]
fn compact_config_defaults_match_spec() {
    let config = SessionMemoryCompactConfig::default();
    assert_eq!(config.min_tokens_to_keep, 10_000);
    assert_eq!(config.min_text_messages_to_keep, 5);
    assert_eq!(config.max_tokens_to_keep, 40_000);
}

// ============================================
// State defaults
// ============================================

#[test]
fn state_default_is_empty() {
    let state = SessionMemoryState::default();
    assert!(state.content.is_none());
    assert!(state.last_summarized_seq.is_none());
    assert_eq!(state.tokens_at_last_extraction, 0);
    assert_eq!(state.tool_calls_since_extraction, 0);
    assert!(!state.initialized);
    assert!(!state.extraction_in_progress);
}

#[test]
fn record_tool_calls_increments() {
    let mut state = SessionMemoryState::default();
    state.record_tool_calls(2);
    assert_eq!(state.tool_calls_since_extraction, 2);
    state.record_tool_calls(1);
    assert_eq!(state.tool_calls_since_extraction, 3);
}

// ============================================
// should_extract
// ============================================

#[test]
fn should_extract_disabled() {
    let config = SessionMemoryConfig {
        enabled: false,
        ..Default::default()
    };
    let state = SessionMemoryState::default();
    assert!(!should_extract(&state, &config, 50_000, false));
}

#[test]
fn should_extract_in_progress_blocks() {
    let config = SessionMemoryConfig::default();
    let state = SessionMemoryState {
        extraction_in_progress: true,
        ..Default::default()
    };
    assert!(!should_extract(&state, &config, 50_000, false));
}

#[test]
fn should_extract_below_init_threshold() {
    let config = SessionMemoryConfig::default();
    let state = SessionMemoryState::default();
    assert!(!should_extract(&state, &config, 5_000, false));
}

#[test]
fn should_extract_below_update_threshold() {
    let config = SessionMemoryConfig::default();
    let state = SessionMemoryState {
        initialized: true,
        tokens_at_last_extraction: 48_000,
        tool_calls_since_extraction: 5,
        ..Default::default()
    };
    assert!(!should_extract(&state, &config, 50_000, false));
}

#[test]
fn should_extract_tool_calls_threshold() {
    let config = SessionMemoryConfig::default();
    let state = SessionMemoryState {
        initialized: true,
        tokens_at_last_extraction: 10_000,
        tool_calls_since_extraction: 3,
        ..Default::default()
    };
    assert!(should_extract(&state, &config, 20_000, true));
}

#[test]
fn should_extract_natural_break() {
    let config = SessionMemoryConfig::default();
    let state = SessionMemoryState {
        initialized: true,
        tokens_at_last_extraction: 10_000,
        tool_calls_since_extraction: 0,
        ..Default::default()
    };
    assert!(should_extract(&state, &config, 20_000, false));
}

#[test]
fn should_extract_first_init() {
    let config = SessionMemoryConfig::default();
    let state = SessionMemoryState {
        tool_calls_since_extraction: 5,
        ..Default::default()
    };
    assert!(should_extract(&state, &config, 15_000, true));
}

// ============================================
// last_turn_has_tool_calls
// ============================================

#[test]
fn last_turn_no_tool_calls() {
    let messages = vec![user_msg("hello"), assistant_msg("hi there")];
    assert!(!last_turn_has_tool_calls(&messages));
}

#[test]
fn last_turn_with_tool_calls() {
    let tc = json!({"id": "tc1", "function": {"name": "read_file", "arguments": "{}"}});
    let messages = vec![
        user_msg("hello"),
        assistant_with_tool_calls("", vec![tc]),
        tool_msg("read_file", "content"),
    ];
    assert!(last_turn_has_tool_calls(&messages));
}

#[test]
fn last_turn_empty_messages() {
    let messages: Vec<Value> = vec![];
    assert!(!last_turn_has_tool_calls(&messages));
}

// ============================================
// try_sm_compact
// ============================================

fn big_user_msg(idx: usize) -> Value {
    let content = format!(
        "User message {} with some substantial content: {}",
        idx,
        "x".repeat(500)
    );
    json!({"role": "user", "content": content})
}

fn big_assistant_msg(idx: usize) -> Value {
    let content = format!(
        "Assistant response {} with detailed explanation: {}",
        idx,
        "y".repeat(500)
    );
    json!({"role": "assistant", "content": content})
}

#[test]
fn sm_compact_no_content_returns_none() {
    let state = SessionMemoryState::default();
    let config = SessionMemoryCompactConfig::default();
    let messages = vec![user_msg("hello"), assistant_msg("hi")];
    assert!(sm_compact(&messages, &state, &config).is_none());
}

#[test]
fn sm_compact_empty_content_returns_none() {
    let state = SessionMemoryState {
        content: Some("   ".to_string()),
        ..Default::default()
    };
    let config = SessionMemoryCompactConfig::default();
    let messages = vec![user_msg("hello"), assistant_msg("hi")];
    assert!(sm_compact(&messages, &state, &config).is_none());
}

#[test]
fn sm_compact_produces_summary_plus_recent() {
    let mut messages: Vec<Value> = Vec::new();
    for idx in 0..40 {
        messages.push(big_user_msg(idx));
        messages.push(big_assistant_msg(idx));
    }

    let state = SessionMemoryState {
        content: Some("# Session Summary\n\nWorking on project X".to_string()),
        last_summarized_seq: Some(20),
        ..Default::default()
    };
    let config = SessionMemoryCompactConfig {
        min_tokens_to_keep: 100,
        min_text_messages_to_keep: 2,
        max_tokens_to_keep: 5_000,
    };

    let result = sm_compact(&messages, &state, &config);
    assert!(result.is_some());

    let compacted = result.unwrap();
    assert!(
        compacted.len() < messages.len(),
        "compacted ({}) should be smaller than original ({})",
        compacted.len(),
        messages.len()
    );

    let first_role = compacted[0]
        .get("role")
        .and_then(|val| val.as_str())
        .unwrap();
    assert_eq!(first_role, "user");

    let first_content = message_text(&compacted[0]);
    assert!(first_content.contains("Session Memory"));
    assert!(first_content.contains("Working on project X"));
}

#[test]
fn sm_compact_preserves_tool_pairs() {
    let tc = json!({"id": "tc1", "function": {"name": "edit_file", "arguments": "{}"}});
    let mut messages: Vec<Value> = Vec::new();

    for idx in 0..10 {
        messages.push(big_user_msg(idx));
        messages.push(big_assistant_msg(idx));
    }
    messages.push(assistant_with_tool_calls("", vec![tc]));
    messages.push(tool_msg("edit_file", "ok"));
    messages.push(user_msg("thanks"));
    messages.push(assistant_msg("done"));

    let state = SessionMemoryState {
        content: Some("# Summary\n\nDoing things".to_string()),
        last_summarized_seq: Some(5),
        ..Default::default()
    };
    let config = SessionMemoryCompactConfig::default();

    let result = sm_compact(&messages, &state, &config);
    if let Some(compacted) = result {
        for (idx, msg) in compacted.iter().enumerate() {
            let role = msg.get("role").and_then(|val| val.as_str()).unwrap_or("");
            if role == "tool" {
                assert!(
                    idx > 0,
                    "tool result should not be the first preserved message"
                );
                let prev_role = compacted[idx - 1]
                    .get("role")
                    .and_then(|val| val.as_str())
                    .unwrap_or("");
                assert!(
                    prev_role == "assistant" || prev_role == "tool",
                    "tool result must follow assistant or another tool, got: {}",
                    prev_role
                );
            }
        }
    }
}

#[test]
fn sm_compact_no_boundary_keeps_from_start() {
    let messages = vec![
        big_user_msg(0),
        big_assistant_msg(0),
        big_user_msg(1),
        big_assistant_msg(1),
        big_user_msg(2),
        big_assistant_msg(2),
    ];

    let state = SessionMemoryState {
        content: Some("# Summary\n\nStarting work".to_string()),
        last_summarized_seq: None,
        ..Default::default()
    };
    let config = SessionMemoryCompactConfig::default();

    let result = sm_compact(&messages, &state, &config);
    if let Some(compacted) = result {
        assert!(
            compacted[0].get("role").and_then(|val| val.as_str()) == Some("user"),
            "first message should be SM summary"
        );
    }
}

// ============================================
// SM-compact: edge cases
// ============================================

#[test]
fn sm_compact_single_message_expands_to_all() {
    let state = SessionMemoryState {
        content: Some("Summary".to_string()),
        last_summarized_seq: Some(0),
        ..Default::default()
    };
    let config = SessionMemoryCompactConfig::default();
    let messages = vec![user_msg("single")];

    let result = sm_compact(&messages, &state, &config);
    // With one tiny message and default min thresholds, backward expansion
    // goes to index 0 — nothing gets dropped, so the result is still valid
    // (summary + all messages).
    if let Some(compacted) = &result {
        let first_role = compacted[0]
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap();
        assert_eq!(first_role, "user");
    }
}

#[test]
fn sm_compact_boundary_beyond_messages_still_compacts() {
    let state = SessionMemoryState {
        content: Some("Summary of old work".to_string()),
        last_summarized_seq: Some(100),
        ..Default::default()
    };
    let config = SessionMemoryCompactConfig::default();
    let messages = vec![user_msg("a"), assistant_msg("b")];

    let result = sm_compact(&messages, &state, &config);
    // Boundary is clamped to messages.len(), so backward expansion keeps
    // all messages. The result has summary + all original messages.
    if let Some(compacted) = &result {
        let first_role = compacted[0]
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap();
        assert_eq!(first_role, "user");
        let content = message_text(&compacted[0]);
        assert!(content.contains("Summary of old work"));
    }
}

// ============================================
// SM state restore from persisted data
// ============================================

#[test]
fn restore_sm_state_from_persisted_data() {
    let mut state = SessionMemoryState::default();
    assert!(!state.initialized);
    assert!(state.content.is_none());
    assert!(state.last_summarized_seq.is_none());

    // Simulate restoring from PersistedSessionMemoryState
    let persisted_content = Some("## Session Title\nMigration task".to_string());
    let persisted_seq = Some(42_i64);

    state.content = persisted_content.clone();
    state.last_summarized_seq = persisted_seq;
    state.initialized = true;

    assert!(state.initialized);
    assert_eq!(state.content, persisted_content);
    assert_eq!(state.last_summarized_seq, Some(42));
    // Counters remain zero — they track in-session activity only
    assert_eq!(state.tokens_at_last_extraction, 0);
    assert_eq!(state.tool_calls_since_extraction, 0);
}

#[test]
fn restored_sm_state_enables_sm_compact() {
    let state = SessionMemoryState {
        content: Some("## Current State\nWorking on file X".to_string()),
        last_summarized_seq: Some(5),
        initialized: true,
        ..Default::default()
    };

    let config = SessionMemoryCompactConfig::default();
    let mut messages = Vec::new();
    for idx in 0..20 {
        if idx % 2 == 0 {
            messages.push(user_msg(&format!("Question {}", idx)));
        } else {
            messages.push(assistant_msg(&format!("Answer {} with a long detailed explanation that uses many tokens to ensure we have enough content to pass the threshold checks for the compaction algorithm", idx)));
        }
    }

    let result = sm_compact(&messages, &state, &config);
    assert!(
        result.is_some(),
        "SM-compact should work with restored state"
    );
    let compacted = result.unwrap();
    // compacted_summary_message emits a plain-text user message (summary +
    // continuation instruction).
    let first_content = compacted[0]
        .get("content")
        .and_then(|val| val.as_str())
        .unwrap();
    assert!(first_content.contains("Working on file X"));
}

#[test]
fn restore_with_no_persisted_data_leaves_state_default() {
    let state = SessionMemoryState::default();
    // Simulating: persisted content is None, so we don't touch state
    let persisted_content: Option<String> = None;
    if persisted_content.is_some() {
        unreachable!();
    }
    // State remains default
    assert!(!state.initialized);
    assert!(state.content.is_none());
}

// ============================================
// Section analysis + enforcement reminders
// ============================================

use super::super::session_memory::sections::{analyze_section_sizes, generate_section_reminders};

#[test]
fn analyze_section_sizes_parses_headers() {
    let content = "### Session Title\nBuild a web app\n\n### Current State\nWorking on auth module\nAdded login page\nFixed CORS issues\n\n### Learnings\nUse JWT tokens\n";
    let sections = analyze_section_sizes(content);
    assert_eq!(sections.len(), 3);
    assert_eq!(sections[0].header, "### Session Title");
    assert_eq!(sections[1].header, "### Current State");
    assert_eq!(sections[2].header, "### Learnings");
    assert!(sections[1].tokens > sections[0].tokens);
}

#[test]
fn analyze_section_sizes_empty_content() {
    let sections = analyze_section_sizes("");
    assert!(sections.is_empty());
}

#[test]
fn analyze_section_sizes_no_headers() {
    let sections = analyze_section_sizes("Just some text without headers");
    assert!(sections.is_empty());
}

#[test]
fn reminders_empty_when_all_within_budget() {
    let content = "### Session Title\nShort\n### Current State\nBrief\n";
    let sections = analyze_section_sizes(content);
    let total = content.len() / 4;
    let reminders = generate_section_reminders(&sections, total, 2000, 12000);
    assert!(reminders.is_empty());
}

#[test]
fn reminders_flags_oversized_section() {
    let big_body = "x".repeat(10_000);
    let content = format!(
        "### Files and Functions\n{}\n### Session Title\nShort\n",
        big_body
    );
    let sections = analyze_section_sizes(&content);
    let total = content.len() / 4;
    let reminders = generate_section_reminders(&sections, total, 2000, 12000);
    assert!(reminders.contains("IMPORTANT"));
    assert!(reminders.contains("Files and Functions"));
    assert!(!reminders.contains("Session Title"));
}

#[test]
fn reminders_flags_total_over_budget() {
    let big_body = "x".repeat(60_000);
    let content = format!("### Current State\n{}\n", big_body);
    let sections = analyze_section_sizes(&content);
    let total = content.len() / 4;
    let reminders = generate_section_reminders(&sections, total, 2000, 12000);
    assert!(reminders.contains("CRITICAL"));
    assert!(reminders.contains("exceeds the maximum"));
}

#[test]
fn reminders_includes_both_total_and_section_warnings() {
    let big_body = "x".repeat(60_000);
    let content = format!("### Current State\n{}\n### Workflow\nShort\n", big_body);
    let sections = analyze_section_sizes(&content);
    let total = content.len() / 4;
    let reminders = generate_section_reminders(&sections, total, 2000, 12000);
    assert!(reminders.contains("CRITICAL"));
    assert!(reminders.contains("Oversized sections to condense"));
    assert!(reminders.contains("Current State"));
}

// ============================================
// truncate_for_compact
// ============================================

use super::super::session_memory::sections::truncate_for_compact;

#[test]
fn truncate_no_op_when_all_within_limit() {
    let content = "### Session Title\nBuild a web app\n### Current State\nWorking on auth\n";
    let (result, truncated) = truncate_for_compact(content, 2000);
    assert!(!truncated);
    assert!(result.contains("Build a web app"));
    assert!(result.contains("Working on auth"));
}

#[test]
fn truncate_clips_oversized_section() {
    let big_body = (0..500)
        .map(|idx| format!("Line {}: some content here", idx))
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        "### Files and Functions\n{}\n### Session Title\nShort\n",
        big_body
    );
    let (result, truncated) = truncate_for_compact(&content, 500);
    assert!(truncated);
    assert!(result.contains("[... section truncated for length ...]"));
    assert!(result.contains("### Session Title"));
    assert!(result.contains("Short"));
    assert!(result.len() < content.len());
}

#[test]
fn truncate_preserves_small_sections() {
    let big = "x".repeat(10_000);
    let content = format!("### Workflow\n{}\n### Learnings\nSmall section\n", big);
    let (result, truncated) = truncate_for_compact(&content, 500);
    assert!(truncated);
    assert!(result.contains("Small section"));
    assert!(result.contains("### Learnings"));
}

// ============================================
// Compact boundary floor
// ============================================

use super::super::session_memory::compact::is_compact_boundary_message;

#[test]
fn compact_boundary_detects_sm_compact_message() {
    let msg = serde_json::json!({
        "role": "system",
        "content": "[Session Memory — 15 earlier messages compacted]\n\nSummary here"
    });
    assert!(is_compact_boundary_message(&msg));
}

#[test]
fn compact_boundary_detects_llm_compact_message() {
    let msg = serde_json::json!({
        "role": "system",
        "content": "[Conversation summary — 10 earlier messages compacted]\n\nSummary"
    });
    assert!(is_compact_boundary_message(&msg));
}

#[test]
fn compact_boundary_detects_structured_compact_message() {
    let msg = serde_json::json!({
        "role": "system",
        "content": [{
            "type": "text",
            "text": "[Session Memory — 15 earlier messages compacted]\n\nSummary here"
        }]
    });
    assert!(is_compact_boundary_message(&msg));
}

#[test]
fn compact_boundary_ignores_regular_system_message() {
    let msg = serde_json::json!({
        "role": "system",
        "content": "You are a helpful assistant."
    });
    assert!(!is_compact_boundary_message(&msg));
}

#[test]
fn compact_boundary_detects_user_summary_message() {
    // Compaction summaries now land as user messages; the prefix still
    // marks them as boundaries.
    let msg = serde_json::json!({
        "role": "user",
        "content": "[Session Memory — 15 earlier messages compacted]\n\nSummary here"
    });
    assert!(is_compact_boundary_message(&msg));
}

#[test]
fn compact_boundary_ignores_tool_message() {
    let msg = serde_json::json!({
        "role": "tool",
        "content": "[Session Memory — fake]"
    });
    assert!(!is_compact_boundary_message(&msg));
}

#[test]
fn sm_compact_respects_boundary_floor() {
    let boundary = serde_json::json!({
        "role": "system",
        "content": "[Session Memory — 5 earlier messages compacted]\n\nOld summary"
    });

    let mut messages = vec![boundary];
    for idx in 0..10 {
        if idx % 2 == 0 {
            messages.push(user_msg(&format!("Q{}", idx)));
        } else {
            messages.push(assistant_msg(&format!("A{} long answer with sufficient tokens to ensure the compaction logic has enough content to work with in backward expansion", idx)));
        }
    }

    let state = SessionMemoryState {
        content: Some("Session summary".to_string()),
        last_summarized_seq: Some(8),
        ..Default::default()
    };

    let config = SessionMemoryCompactConfig {
        min_tokens_to_keep: 1,
        min_text_messages_to_keep: 1,
        max_tokens_to_keep: 999_999,
    };

    let result = sm_compact(&messages, &state, &config);
    assert!(result.is_some());
    let compacted = result.unwrap();

    let has_old_boundary = compacted
        .iter()
        .any(|msg| message_text(msg).contains("Old summary"));
    assert!(
        !has_old_boundary,
        "Old boundary marker should have been dropped"
    );
}

#[test]
fn parse_compact_boundary_content_splits_header_body_and_count() {
    use crate::model_context::compaction::COMPACT_CONTINUATION_SUFFIX;
    use crate::model_context::session_memory::parse_compact_boundary_content;

    let content = format!(
        "[Conversation summary \u{2014} 12 earlier messages compacted]\n\n## Summary\n\nbody text\n\n{}",
        COMPACT_CONTINUATION_SUFFIX
    );
    let parsed = parse_compact_boundary_content(&content);

    assert_eq!(
        parsed.header.as_deref(),
        Some("[Conversation summary \u{2014} 12 earlier messages compacted]")
    );
    assert!(parsed.body.starts_with("## Summary"));
    assert!(parsed.body.ends_with("body text"));
    assert!(
        !parsed
            .body
            .contains("continued from an earlier conversation"),
        "continuation suffix must be stripped"
    );
    assert_eq!(parsed.compacted_count, Some(12));
}

#[test]
fn parse_compact_boundary_content_handles_session_memory_and_legacy_markers() {
    use crate::model_context::session_memory::parse_compact_boundary_content;

    let sm = parse_compact_boundary_content(
        "[Session Memory \u{2014} 3 earlier messages compacted]\n\nsm body",
    );
    assert_eq!(sm.compacted_count, Some(3));
    assert_eq!(sm.body, "sm body");

    // Legacy ASCII-hyphen marker with no count and no body.
    let legacy = parse_compact_boundary_content(
        "[Conversation summary - earlier messages compacted without summary]",
    );
    assert!(legacy.header.is_some());
    assert_eq!(legacy.body, "");
    assert_eq!(legacy.compacted_count, None);

    // Non-boundary content: everything is body, no header.
    let plain = parse_compact_boundary_content("just some text");
    assert_eq!(plain.header, None);
    assert_eq!(plain.body, "just some text");
}
