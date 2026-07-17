//! Parser integration tests using real CLI stdout samples.

#[cfg(test)]
mod tests {
    use crate::agent_sessions::cli::parsers::claude_code::ClaudeCodeParser;
    use crate::agent_sessions::cli::parsers::codex::CodexParser;
    use crate::agent_sessions::cli::parsers::cursor::CursorParser;
    use crate::agent_sessions::cli::parsers::CliAgentParser;

    // ── Codex Parser Tests ──────────────────────────────────────

    #[test]
    fn test_codex_thread_started() {
        let mut parser = CodexParser::new("test-session");
        let chunks = parser.parse_line(
            r#"{"type":"thread.started","thread_id":"019c4a74-9643-7f71-b06a-8acfefc53c83"}"#,
        );

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_start");
        assert_eq!(chunks[0].function, "session_start");
        assert!(chunks[0].thread_id.is_some());
        assert_eq!(
            chunks[0].thread_id.as_deref(),
            Some("019c4a74-9643-7f71-b06a-8acfefc53c83")
        );
    }

    #[test]
    fn test_codex_error_event() {
        let mut parser = CodexParser::new("test-session");
        let chunks = parser.parse_line(
            r#"{"type":"error","message":"Quota exceeded. Check your plan and billing details."}"#,
        );

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "error");
        assert_eq!(chunks[0].function, "error");
        let result = &chunks[0].result;
        assert_eq!(result["success"], false);
        assert!(result["error"].as_str().unwrap().contains("Quota exceeded"));
    }

    #[test]
    fn test_codex_turn_failed() {
        let mut parser = CodexParser::new("test-session");
        let chunks = parser.parse_line(
            r#"{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: "}}"#,
        );

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_end");
        assert_eq!(chunks[0].result["success"], false);
        assert!(chunks[0].result["error_message"]
            .as_str()
            .unwrap()
            .contains("401 Unauthorized"));

        // on_exit should not produce another session_end after turn.failed
        let exit_chunks = parser.on_exit(1);
        assert!(exit_chunks.is_empty());
    }

    #[test]
    fn test_codex_item_completed_command() {
        let mut parser = CodexParser::new("test-session");
        let line = r#"{"type":"item.completed","item":{"type":"command_execution","id":"cmd_1","command":"/bin/bash -lc 'ls -la'","aggregated_output":"total 8\nfile1.txt","exit_code":0,"status":"completed"}}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "tool_call");
        assert_eq!(chunks[0].chunk_id, "tool-call-cmd_1");
        assert_eq!(chunks[0].function, "Shell");
        // Check command was unwrapped from bash wrapper
        assert_eq!(chunks[0].args["command"], "ls -la");
        assert_eq!(chunks[0].result["call_id"], "cmd_1");
        assert_eq!(chunks[0].result["success"]["exitCode"], 0);
        assert!(chunks[0].result["success"]["stdout"]
            .as_str()
            .unwrap()
            .contains("file1.txt"));
    }

    #[test]
    fn test_codex_item_started_and_completed_share_stable_id() {
        let mut parser = CodexParser::new("test-session");
        let started = r#"{"type":"item.started","item":{"type":"file_change","id":"fc_1","changes":[{"path":"/tmp/a.md"}]}}"#;
        let completed = r#"{"type":"item.completed","item":{"type":"file_change","id":"fc_1","changes":[{"path":"/tmp/a.md"}],"status":"completed"}}"#;

        let start_chunks = parser.parse_line(started);
        let complete_chunks = parser.parse_line(completed);

        assert_eq!(start_chunks.len(), 1);
        assert_eq!(complete_chunks.len(), 1);
        assert_eq!(start_chunks[0].chunk_id, "tool-call-fc_1");
        assert_eq!(complete_chunks[0].chunk_id, "tool-call-fc_1");
        assert_eq!(start_chunks[0].result["status"], "running");
        assert_eq!(start_chunks[0].result["call_id"], "fc_1");
        assert_eq!(complete_chunks[0].result["call_id"], "fc_1");
        assert_eq!(complete_chunks[0].result["success"]["path"], "/tmp/a.md");
    }

    #[test]
    fn test_codex_item_completed_agent_message() {
        let mut parser = CodexParser::new("test-session");
        let line = r#"{"type":"item.completed","item":{"type":"agent_message","text":"I'll help you with that."}}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "assistant");
        assert_eq!(chunks[0].function, "message");
        assert_eq!(chunks[0].result["content"], "I'll help you with that.");
    }

    #[test]
    fn test_codex_turn_completed_with_usage() {
        let mut parser = CodexParser::new("test-session");
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":1500,"output_tokens":300,"cached_input_tokens":500},"model":"o3"}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_end");
        assert_eq!(chunks[0].result["success"], true);

        let usage = parser.token_usage().expect("Should have token usage");
        assert_eq!(usage.input_tokens, 1500);
        assert_eq!(usage.output_tokens, 300);
        assert_eq!(usage.cache_read_tokens, 500);
    }

    #[test]
    fn test_codex_on_exit_no_duplicate_session_end() {
        let mut parser = CodexParser::new("test-session");
        // Process turn.completed first
        parser.parse_line(
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#,
        );
        // Then on_exit should not produce another session_end
        let exit_chunks = parser.on_exit(0);
        assert!(exit_chunks.is_empty());
    }

    // ── Cursor Parser Tests ─────────────────────────────────────

    #[test]
    fn test_cursor_system_init() {
        let mut parser = CursorParser::new("test-session");
        let line = r#"{"type":"system","subtype":"init","model":"claude-sonnet-4","cwd":"/home/user/project"}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_start");
        assert_eq!(chunks[0].args["model"], "claude-sonnet-4");
        assert_eq!(chunks[0].args["cwd"], "/home/user/project");
    }

    #[test]
    fn test_cursor_tool_call_shell() {
        let mut parser = CursorParser::new("test-session");
        let line = r#"{"type":"tool_call","subtype":"completed","call_id":"tool_1","tool_call":{"shellToolCall":{"args":{"command":"ls"},"result":{"success":{"exitCode":0,"stdout":"file1.txt","stderr":""}}}}}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "tool_call");
        assert_eq!(chunks[0].chunk_id, "tool-call-tool_1");
        assert_eq!(chunks[0].function, "Shell");
        assert_eq!(chunks[0].result["success"]["exitCode"], 0);
    }

    #[test]
    fn test_cursor_tool_call_started_and_completed_share_stable_id() {
        let mut parser = CursorParser::new("test-session");
        let started = r#"{"type":"tool_call","subtype":"started","call_id":"tool_edit_1","tool_call":{"editFileByReplaceToolCall":{"args":{"path":"/tmp/a.md","streamContent":"hi"}}}}"#;
        let completed = r#"{"type":"tool_call","status":"completed","call_id":"tool_edit_1","tool_call":{"editFileByReplaceToolCall":{"args":{"path":"/tmp/a.md","streamContent":"hi"},"result":{"success":{}}}}}"#;

        let start_chunks = parser.parse_line(started);
        let complete_chunks = parser.parse_line(completed);

        assert_eq!(start_chunks.len(), 1);
        assert_eq!(complete_chunks.len(), 1);
        assert_eq!(start_chunks[0].chunk_id, "tool-call-tool_edit_1");
        assert_eq!(complete_chunks[0].chunk_id, "tool-call-tool_edit_1");
        assert_eq!(start_chunks[0].result["status"], "running");
        assert_eq!(complete_chunks[0].result["success"], serde_json::json!({}));
    }

    #[test]
    fn test_cursor_tool_call_await() {
        let mut parser = CursorParser::new("test-session");
        let line = r#"{"type":"tool_call","subtype":"completed","tool_call":{"awaitToolCall":{"args":{"command":"wait_for","handles":["pid-1"],"block_until_ms":1000},"result":{"success":{"awaitMeta":"{\"command\":\"wait_for\",\"count\":1,\"items\":[]}"}}}}}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "tool_call");
        assert_eq!(chunks[0].function, "Await");
        assert_eq!(chunks[0].args["command"], "wait_for");
    }

    #[test]
    fn test_cursor_assistant_with_text_and_thinking() {
        let mut parser = CursorParser::new("test-session");
        let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me analyze..."},{"type":"text","text":"Here is my answer."}]}}"#;
        let chunks = parser.parse_line(line);

        // Should produce two chunks: thinking + streaming delta
        // (full "assistant" chunk is only emitted on flush, i.e. next non-assistant event)
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].action_type, "llm_thinking");
        assert_eq!(chunks[0].result["thought"], "Let me analyze...");
        assert_eq!(chunks[1].action_type, "assistant_delta");
        assert_eq!(chunks[1].result["content"], "Here is my answer.");
        assert_eq!(chunks[1].result["is_delta"], true);
    }

    // ── Claude Code Parser Tests ────────────────────────────────

    #[test]
    fn test_claude_code_system_init() {
        let mut parser = ClaudeCodeParser::new("test-session");
        let line = r#"{"type":"system","model":"claude-sonnet-4","cwd":"/tmp"}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_start");
    }

    #[test]
    fn test_claude_code_tool_use_result_pairing() {
        let mut parser = ClaudeCodeParser::new("test-session");

        // 1. Assistant with tool_use
        let chunks = parser.parse_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tooluse_abc","name":"Bash","input":{"command":"ls"}}]}}"#);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].function, "Shell"); // Bash → Shell
        assert_eq!(chunks[0].result["status"], "running");

        // 2. User with tool_result
        let chunks = parser.parse_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tooluse_abc","content":"file1.txt\nfile2.txt","is_error":false}]}}"#);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].function, "Shell");
        // Result should be normalized to Cursor Shell format
        assert!(chunks[0].result["success"]["stdout"]
            .as_str()
            .unwrap()
            .contains("file1.txt"));
    }

    #[test]
    fn test_claude_code_streams_tool_argument_deltas() {
        let mut parser = ClaudeCodeParser::new("test-session");

        let start = parser.parse_line(r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_plan","name":"create_plan","input":{}}}"#);
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].action_type, "tool_call_delta");
        assert_eq!(start[0].result["is_delta"], true);
        assert_eq!(start[0].result["index"], 0);
        assert_eq!(start[0].result["tool_call_id"], "toolu_plan");
        assert_eq!(start[0].result["tool_name"], "create_plan");

        let delta = parser.parse_line(r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"title\":\"Plan\",\"content\":\"Step 1"}}"#);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].action_type, "tool_call_delta");
        assert_eq!(delta[0].result["tool_call_id"], "toolu_plan");
        assert_eq!(delta[0].result["tool_name"], "create_plan");
        assert_eq!(
            delta[0].result["arguments_delta"],
            "{\"title\":\"Plan\",\"content\":\"Step 1"
        );
    }

    #[test]
    fn test_claude_code_result_with_usage() {
        let mut parser = ClaudeCodeParser::new("test-session");
        let line = r#"{"type":"result","session_id":"sess-123","is_error":false,"subtype":"success","usage":{"input_tokens":500,"output_tokens":100,"cache_read_input_tokens":200}}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_end");
        assert_eq!(chunks[0].result["success"], true);
        assert_eq!(chunks[0].result["stop_reason"], "success");

        let usage = parser.token_usage().expect("Should have usage");
        assert_eq!(usage.input_tokens, 500);
        assert_eq!(usage.output_tokens, 100);
        assert_eq!(usage.cache_read_tokens, 200);
    }

    #[test]
    fn test_claude_code_result_preserves_stop_reason() {
        let mut parser = ClaudeCodeParser::new("test-session");
        let line = r#"{"type":"result","session_id":"sess-123","is_error":false,"stop_reason":"end_turn"}"#;
        let chunks = parser.parse_line(line);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].action_type, "session_end");
        assert_eq!(chunks[0].result["success"], true);
        assert_eq!(chunks[0].result["stop_reason"], "end_turn");
    }
}
