use super::*;
use core_types::activity::ActivityChunk;
use serde_json::json;

// -- CliAgentType::as_str --

#[test]
fn cli_agent_type_as_str_cursor_cli() {
    assert_eq!(CliAgentType::CursorCli.as_str(), "cursor_cli");
}

#[test]
fn cli_agent_type_as_str_claude_code() {
    assert_eq!(CliAgentType::ClaudeCode.as_str(), "claude_code");
}

#[test]
fn cli_agent_type_as_str_codex() {
    assert_eq!(CliAgentType::Codex.as_str(), "codex");
}

#[test]
fn cli_agent_type_as_str_kiro() {
    assert_eq!(CliAgentType::Kiro.as_str(), "kiro");
}

#[test]
fn cli_agent_type_as_str_copilot() {
    assert_eq!(CliAgentType::Copilot.as_str(), "copilot");
}

// -- CliAgentType::parse canonical names --

#[test]
fn cli_agent_type_parse_canonical_names() {
    assert_eq!(
        CliAgentType::parse("cursor_cli"),
        Some(CliAgentType::CursorCli)
    );
    assert_eq!(
        CliAgentType::parse("claude_code"),
        Some(CliAgentType::ClaudeCode)
    );
    assert_eq!(CliAgentType::parse("codex"), Some(CliAgentType::Codex));
    assert_eq!(CliAgentType::parse("kiro"), Some(CliAgentType::Kiro));
    assert_eq!(CliAgentType::parse("copilot"), Some(CliAgentType::Copilot));
}

// -- CliAgentType::parse aliases --

#[test]
fn cli_agent_type_parse_aliases() {
    assert_eq!(CliAgentType::parse("cursor"), Some(CliAgentType::CursorCli));
}

// -- CliAgentType::parse unknown --

#[test]
fn cli_agent_type_parse_unknown() {
    assert_eq!(CliAgentType::parse("unknown"), None);
    assert_eq!(CliAgentType::parse(""), None);
    assert_eq!(CliAgentType::parse("foo_bar"), None);
}

// -- AgentPlatform roundtrip --

#[test]
fn cli_agent_type_parse_roundtrip() {
    for platform in [
        CliAgentType::CursorCli,
        CliAgentType::ClaudeCode,
        CliAgentType::Codex,
        CliAgentType::Kiro,
        CliAgentType::Copilot,
        CliAgentType::QoderCli,
        CliAgentType::TraeCli,
    ] {
        assert_eq!(
            CliAgentType::parse(platform.as_str()),
            Some(platform),
            "parse({:?}) should roundtrip",
            platform
        );
    }
}

// -- ActivityChunk::new --

#[test]
fn activity_chunk_new_creates_with_correct_fields() {
    let chunk = ActivityChunk::new("sid-1", "tool_call", "Shell");
    assert_eq!(chunk.session_id, "sid-1");
    assert_eq!(chunk.action_type, "tool_call");
    assert_eq!(chunk.function, "Shell");
    assert_eq!(chunk.args, json!({}));
    assert_eq!(chunk.result, json!({}));
    assert!(chunk.thread_id.is_none());
    assert!(!chunk.chunk_id.is_empty());
    assert!(!chunk.created_at.is_empty());
}

// -- ActivityChunk::with_args --

#[test]
fn activity_chunk_with_args_sets_args() {
    let args = json!({"command": "ls", "workingDirectory": "/tmp"});
    let chunk = ActivityChunk::new("sid", "tool_call", "Shell").with_args(args.clone());
    assert_eq!(chunk.args, args);
}

// -- ActivityChunk::with_result --

#[test]
fn activity_chunk_with_result_sets_result() {
    let result = json!({"success": true, "stdout": "ok"});
    let chunk = ActivityChunk::new("sid", "tool_call", "Shell").with_result(result.clone());
    assert_eq!(chunk.result, result);
}

// -- ActivityChunk::with_thread_id --

#[test]
fn activity_chunk_with_thread_id_sets_thread_id() {
    let chunk = ActivityChunk::new("sid", "tool_call", "Shell").with_thread_id("thread-123");
    assert_eq!(chunk.thread_id, Some("thread-123".to_string()));
}

// -- TokenUsage::default --

#[test]
fn token_usage_default_all_zeros_model_none() {
    let usage = TokenUsage::default();
    assert_eq!(usage.input_tokens, 0);
    assert_eq!(usage.output_tokens, 0);
    assert_eq!(usage.cache_read_tokens, 0);
    assert_eq!(usage.cache_write_tokens, 0);
    assert_eq!(usage.total_tokens, 0);
    assert_eq!(usage.model, None);
}

// -- AgentPlatform serde roundtrip --

#[test]
fn cli_agent_type_serde_roundtrip() {
    for platform in [
        CliAgentType::CursorCli,
        CliAgentType::ClaudeCode,
        CliAgentType::Codex,
        CliAgentType::Kiro,
        CliAgentType::Copilot,
    ] {
        let json = serde_json::to_string(&platform).unwrap();
        let parsed: CliAgentType = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, platform, "serde roundtrip for {:?}", platform);
    }
}
