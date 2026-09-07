//! Unit tests for the codex app-server event → ActivityChunk mapping.
//!
//! Fixture payloads are verbatim (trimmed) captures from a live
//! `codex app-server` stdio session (codex-cli 0.143.0).

use serde_json::{json, Value};

use super::{
    approval_auto_accept, build_thread_launch_request, build_turn_input, thread_permission_params,
    CodexAppServerEventParser, CodexAppServerTurn,
};
use crate::agent_sessions::cli::session_runner::launch_profiles::CliPermissionMode;

const SESSION_ID: &str = "test-session";

fn parser() -> CodexAppServerEventParser {
    CodexAppServerEventParser::new(SESSION_ID)
}

fn notif(
    parser: &mut CodexAppServerEventParser,
    method: &str,
    params: Value,
) -> Vec<core_types::activity::ActivityChunk> {
    parser.handle_notification(method, &params)
}

// ─── thread lifecycle ───

#[test]
fn thread_response_captures_id_and_emits_session_start_once() {
    let mut p = parser();
    let result = json!({
        "thread": {"id": "019f6f52-4aa1-7ac2-8fe4-486e23145e36", "ephemeral": false},
        "model": "gpt-5.5",
    });
    let chunks = p.on_thread_response(&result);
    assert_eq!(p.thread_id(), Some("019f6f52-4aa1-7ac2-8fe4-486e23145e36"));
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "session_start");
    assert_eq!(
        chunks[0].thread_id.as_deref(),
        Some("019f6f52-4aa1-7ac2-8fe4-486e23145e36")
    );

    // thread/started for the same thread must not emit a duplicate.
    let dup = notif(
        &mut p,
        "thread/started",
        json!({"thread": {"id": "019f6f52-4aa1-7ac2-8fe4-486e23145e36"}}),
    );
    assert!(dup.is_empty());
}

#[test]
fn native_thread_rebind_emits_fresh_id_after_initial_session_start() {
    let mut p = parser();
    let _ = p.on_thread_response(&json!({"thread": {"id": "source-thread"}}));

    let chunks = p.on_thread_rebound(&json!({"thread": {"id": "forked-thread"}}));

    assert_eq!(p.thread_id(), Some("forked-thread"));
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "session_start");
    assert_eq!(chunks[0].thread_id.as_deref(), Some("forked-thread"));
    assert_eq!(chunks[0].result["native_rollover"], true);
}

#[test]
fn turn_started_captures_turn_id_without_chunks() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "turn/started",
        json!({"threadId": "t", "turn": {"id": "turn-1", "status": "inProgress", "items": []}}),
    );
    assert!(chunks.is_empty());
    assert_eq!(p.turn_id(), Some("turn-1"));
}

// ─── messages / reasoning ───

#[test]
fn agent_message_delta_maps_to_broadcast_only_assistant_delta() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "item/agentMessage/delta",
        json!({"delta": "po", "itemId": "msg_1", "threadId": "t", "turnId": "u"}),
    );
    assert_eq!(chunks.len(), 1);
    let chunk = &chunks[0];
    assert_eq!(chunk.action_type, "assistant_delta");
    assert!(chunk.broadcast_only);
    assert_eq!(chunk.result["content"], "po");
    assert_eq!(chunk.result["is_delta"], true);
}

#[test]
fn completed_agent_message_maps_to_full_assistant_chunk() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "item/completed",
        json!({"item": {"type": "agentMessage", "id": "msg_1", "text": "pong", "phase": "final_answer"}}),
    );
    assert_eq!(chunks.len(), 1);
    let chunk = &chunks[0];
    assert_eq!(chunk.action_type, "assistant");
    assert_eq!(chunk.function, "message");
    assert!(!chunk.broadcast_only);
    assert_eq!(chunk.result["content"], "pong");
    assert_eq!(chunk.result["is_full_content"], true);
}

#[test]
fn started_agent_message_and_user_echo_are_skipped() {
    let mut p = parser();
    assert!(notif(
        &mut p,
        "item/started",
        json!({"item": {"type": "agentMessage", "id": "msg_1", "text": ""}}),
    )
    .is_empty());
    assert!(notif(
        &mut p,
        "item/completed",
        json!({"item": {"type": "userMessage", "id": "u1", "content": [{"type": "text", "text": "hi"}]}}),
    )
    .is_empty());
}

#[test]
fn reasoning_summary_delta_and_completed_summary_map_to_thinking() {
    let mut p = parser();
    let deltas = notif(
        &mut p,
        "item/reasoning/summaryTextDelta",
        json!({"delta": "thinking…", "itemId": "rs_1", "summaryIndex": 0}),
    );
    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0].action_type, "llm_thinking_delta");
    assert!(deltas[0].broadcast_only);

    let chunks = notif(
        &mut p,
        "item/completed",
        json!({"item": {"type": "reasoning", "id": "rs_1", "summary": ["part one", "part two"], "content": []}}),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "llm_thinking");
    assert_eq!(chunks[0].result["thought"], "part one\npart two");

    // Empty summary (live capture shape) emits nothing.
    let empty = notif(
        &mut p,
        "item/completed",
        json!({"item": {"type": "reasoning", "id": "rs_2", "summary": [], "content": []}}),
    );
    assert!(empty.is_empty());
}

// ─── tool calls ───

#[test]
fn command_execution_maps_to_shell_with_call_id() {
    let mut p = parser();
    let started = notif(
        &mut p,
        "item/started",
        json!({"item": {
            "type": "commandExecution",
            "id": "call_1",
            "command": "/bin/bash -lc 'ls -la'",
            "cwd": "/repo",
            "status": "inProgress",
        }}),
    );
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].function, "Shell");
    assert_eq!(started[0].chunk_id, "tool-call-call_1");
    assert_eq!(started[0].args["command"], "ls -la");
    assert_eq!(started[0].result["status"], "running");
    assert_eq!(started[0].result["call_id"], "call_1");

    let completed = notif(
        &mut p,
        "item/completed",
        json!({"item": {
            "type": "commandExecution",
            "id": "call_1",
            "command": "/bin/bash -lc 'ls -la'",
            "cwd": "/repo",
            "aggregatedOutput": "total 0",
            "exitCode": 0,
            "status": "completed",
        }}),
    );
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].function, "Shell");
    assert_eq!(completed[0].result["success"]["exitCode"], 0);
    assert_eq!(completed[0].result["success"]["stdout"], "total 0");
    assert_eq!(completed[0].result["call_id"], "call_1");
}

#[test]
fn failed_command_execution_maps_to_error_result() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "item/completed",
        json!({"item": {
            "type": "commandExecution",
            "id": "call_2",
            "command": "false",
            "cwd": "/repo",
            "aggregatedOutput": "boom",
            "exitCode": 1,
            "status": "failed",
        }}),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].result["error"]["exitCode"], 1);
    assert_eq!(chunks[0].result["error"]["stdout"], "boom");
}

#[test]
fn file_change_maps_to_edit_chunk() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "item/completed",
        json!({"item": {
            "type": "fileChange",
            "id": "fc_1",
            "status": "completed",
            "changes": [
                {"path": "/repo/src/a.rs", "kind": "update", "diff": "-old\n+new"},
                {"path": "/repo/src/b.rs", "kind": "add", "diff": "+created"},
            ],
        }}),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "Edit");
    assert_eq!(chunks[0].args["path"], "/repo/src/a.rs");
    assert_eq!(chunks[0].result["success"]["path"], "/repo/src/a.rs");
    assert_eq!(
        chunks[0].result["success"]["files"],
        json!(["/repo/src/a.rs", "/repo/src/b.rs"])
    );
    assert_eq!(chunks[0].result["call_id"], "fc_1");
}

#[test]
fn declined_file_change_maps_to_error() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "item/completed",
        json!({"item": {
            "type": "fileChange",
            "id": "fc_2",
            "status": "declined",
            "changes": [{"path": "/repo/x.rs", "kind": "update", "diff": ""}],
        }}),
    );
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].result.get("error").is_some());
}

#[test]
fn mcp_tool_call_uses_tool_name_and_result() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "item/completed",
        json!({"item": {
            "type": "mcpToolCall",
            "id": "mcp_1",
            "server": "docs",
            "tool": "search_docs",
            "status": "completed",
            "arguments": {"query": "tokio"},
            "result": {"content": "found"},
            "error": null,
        }}),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "search_docs");
    assert_eq!(chunks[0].args["query"], "tokio");
    assert_eq!(chunks[0].result["content"], "found");
}

// ─── plan / todos ───

#[test]
fn turn_plan_updated_maps_to_update_todos() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "turn/plan/updated",
        json!({
            "threadId": "t", "turnId": "u", "explanation": null,
            "plan": [
                {"step": "Explore", "status": "completed"},
                {"step": "Implement", "status": "inProgress"},
                {"step": "Test", "status": "pending"},
            ],
        }),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "UpdateTodos");
    let todos = chunks[0].args["todos"].as_array().expect("todos array");
    assert_eq!(todos.len(), 3);
    assert_eq!(todos[0]["status"], "completed");
    assert_eq!(todos[1]["status"], "in_progress");
    assert_eq!(todos[2]["status"], "pending");
    assert_eq!(todos[1]["content"], "Implement");
}

// ─── usage / turn end / errors ───

#[test]
fn token_usage_updated_captures_last_breakdown() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "thread/tokenUsage/updated",
        json!({
            "threadId": "t", "turnId": "u",
            "tokenUsage": {
                "total": {"totalTokens": 99999, "inputTokens": 90000, "cachedInputTokens": 5000, "outputTokens": 200, "reasoningOutputTokens": 50},
                "last": {"totalTokens": 12098, "inputTokens": 12076, "cachedInputTokens": 2432, "outputTokens": 22, "reasoningOutputTokens": 15},
            },
        }),
    );
    assert!(chunks.is_empty());
    let usage = p.usage().expect("usage captured");
    assert_eq!(usage.input_tokens, 12076);
    assert_eq!(usage.output_tokens, 22);
    assert_eq!(usage.cache_read_tokens, 2432);
    assert_eq!(usage.total_tokens, 12098);
}

#[test]
fn token_usage_derives_total_when_provider_omits_it() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "thread/tokenUsage/updated",
        json!({
            "threadId": "t", "turnId": "u",
            "tokenUsage": {
                "last": {
                    "inputTokens": 91133,
                    "cachedInputTokens": 76288,
                    "outputTokens": 1876
                }
            }
        }),
    );
    assert!(chunks.is_empty());
    let usage = p.usage().expect("usage captured");
    assert_eq!(usage.total_tokens, 93009);
    assert_eq!(usage.cache_read_tokens, 76288);
}

#[test]
fn turn_completed_emits_session_end_and_records_status() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {"id": "u", "items": [], "status": "completed", "error": null}}),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "session_end");
    assert_eq!(chunks[0].result["success"], true);
    assert_eq!(chunks[0].result["stop_reason"], "completed");
    assert_eq!(p.turn_status(), Some("completed"));
}

#[test]
fn failed_turn_emits_unsuccessful_session_end_with_error() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {
            "id": "u", "items": [], "status": "failed",
            "error": {"message": "stream disconnected"},
        }}),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].result["success"], false);
    assert_eq!(chunks[0].result["error_message"], "stream disconnected");
    assert_eq!(p.turn_status(), Some("failed"));
    assert_eq!(p.turn_error(), Some("stream disconnected"));
}

#[test]
fn context_overflow_is_recoverable_only_before_output_or_tools() {
    let overflow = json!({"threadId": "t", "turn": {
        "id": "u", "items": [], "status": "failed",
        "error": {"message": "Codex ran out of room in the model's context window."},
    }});

    let clean = parser();
    assert!(clean.should_recover_context_exhaustion(&overflow));
    assert!(!clean.should_recover_context_exhaustion(&json!({
        "turn": {
            "status": "completed",
            "error": {"message": "Codex ran out of room in the model's context window."}
        }
    })));
    assert!(!clean.should_recover_context_exhaustion(&json!({
        "turn": {
            "status": "failed",
            "error": {"message": "connection refused"}
        }
    })));

    let mut with_output = parser();
    let chunks = notif(
        &mut with_output,
        "item/agentMessage/delta",
        json!({"delta": "partial", "itemId": "msg_1"}),
    );
    assert_eq!(chunks.len(), 1);
    assert!(!with_output.should_recover_context_exhaustion(&overflow));

    let mut with_tool = parser();
    let _ = notif(
        &mut with_tool,
        "item/started",
        json!({"item": {
            "type": "commandExecution", "id": "call_1",
            "command": "touch changed", "cwd": "/repo", "status": "inProgress",
        }}),
    );
    assert!(!with_tool.should_recover_context_exhaustion(&overflow));
}

#[test]
fn turn_reset_preserves_thread_identity_and_clears_failed_attempt_state() {
    let mut p = parser();
    let _ = p.on_thread_response(&json!({"thread": {"id": "thread-1"}}));
    let _ = notif(
        &mut p,
        "turn/started",
        json!({"turn": {"id": "turn-1", "status": "inProgress"}}),
    );
    let _ = notif(
        &mut p,
        "error",
        json!({"error": {"message": "Prompt is too long"}, "willRetry": false}),
    );
    let _ = notif(
        &mut p,
        "turn/completed",
        json!({"turn": {"id": "turn-1", "status": "failed"}}),
    );
    assert_eq!(p.turn_status(), Some("failed"));

    p.reset_turn_state();

    assert_eq!(p.thread_id(), Some("thread-1"));
    assert_eq!(p.turn_id(), None);
    assert_eq!(p.turn_status(), None);
    assert_eq!(p.turn_error(), None);
    assert!(p.usage().is_none());
}

#[test]
fn failed_context_recovery_restores_error_from_preceding_notification() {
    let mut p = parser();
    let _ = notif(
        &mut p,
        "error",
        json!({
            "error": {"message": "Codex ran out of room in the model's context window."},
            "willRetry": false
        }),
    );
    let completion = json!({"turn": {"id": "turn-1", "status": "failed"}});
    let original_error = p.completed_turn_error(&completion).map(str::to_string);

    // Native recovery drives maintenance turns and resets this transient
    // parser state before it can report a failure of its own.
    p.reset_turn_state();
    p.pending_error_message = original_error;
    let chunks = notif(&mut p, "turn/completed", completion);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].result["success"], false);
    assert_eq!(
        chunks[0].result["error_message"],
        "Codex ran out of room in the model's context window."
    );
}

#[test]
fn native_compaction_notifications_emit_one_deduplicated_marker() {
    let mut p = parser();
    let item = notif(
        &mut p,
        "item/completed",
        json!({"item": {"type": "contextCompaction", "id": "compact-1"}}),
    );
    assert_eq!(item.len(), 1);
    assert_eq!(item[0].action_type, "context_compacted");
    assert_eq!(item[0].result["native"], true);
    assert_eq!(item[0].result["provider"], "codex");

    let legacy = notif(&mut p, "thread/compacted", json!({"threadId": "t"}));
    assert!(legacy.is_empty());
}

#[test]
fn interrupted_turn_records_status() {
    let mut p = parser();
    let chunks = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {"id": "u", "items": [], "status": "interrupted", "error": null}}),
    );
    assert_eq!(chunks[0].result["stop_reason"], "interrupted");
    assert_eq!(p.turn_status(), Some("interrupted"));
}

#[test]
fn fatal_error_is_coalesced_into_authoritative_failed_turn() {
    let mut p = parser();
    let fatal = notif(
        &mut p,
        "error",
        json!({"threadId": "t", "turnId": "u", "error": {"message": "boom"}, "willRetry": false}),
    );
    assert!(fatal.is_empty());

    let duplicate_fatal = notif(
        &mut p,
        "error",
        json!({"threadId": "t", "turnId": "u", "error": {"message": "boom, request-id: second"}, "willRetry": false}),
    );
    assert!(duplicate_fatal.is_empty());

    let retryable = notif(
        &mut p,
        "error",
        json!({"threadId": "t", "turnId": "u", "error": {"message": "transient"}, "willRetry": true}),
    );
    assert!(retryable.is_empty());

    let terminal = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {
            "id": "u", "items": [], "status": "failed",
            "error": {"message": "authoritative upstream failure"},
        }}),
    );
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].action_type, "session_end");
    assert_eq!(terminal[0].result["success"], false);
    assert_eq!(
        terminal[0].result["error_message"],
        "authoritative upstream failure"
    );
    assert_eq!(p.turn_error(), Some("authoritative upstream failure"));
}

#[test]
fn failed_turn_without_a_body_falls_back_to_the_last_retry_notice() {
    let mut p = parser();
    let retryable = notif(
        &mut p,
        "error",
        json!({"threadId": "t", "turnId": "u", "error": {"message": "stream disconnected"}, "willRetry": true}),
    );
    assert!(retryable.is_empty(), "a retry is progress, not an error");

    // codex reports the failure but attaches no error object — without the
    // fallback the turn ends with no explanation at all.
    let terminal = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {"id": "u", "items": [], "status": "failed"}}),
    );
    assert_eq!(terminal[0].result["success"], false);
    assert_eq!(terminal[0].result["error_message"], "stream disconnected");
    assert_eq!(p.turn_error(), Some("stream disconnected"));
}

#[test]
fn retry_notice_never_outlives_its_turn() {
    let mut p = parser();
    notif(
        &mut p,
        "error",
        json!({"threadId": "t", "turnId": "u", "error": {"message": "stream disconnected"}, "willRetry": true}),
    );

    // Codex retried and got through: the notice describes nothing.
    let ok = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {"id": "u", "items": [], "status": "completed"}}),
    );
    assert_eq!(ok[0].result["success"], true);
    assert!(ok[0].result.get("error_message").is_none());

    // And it must not be waiting to attach itself to the next turn either.
    let next = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {"id": "v", "items": [], "status": "failed"}}),
    );
    assert!(next[0].result.get("error_message").is_none());
    assert_eq!(p.turn_error(), None);
}

#[test]
fn interrupted_turn_does_not_borrow_a_retry_notice() {
    let mut p = parser();
    notif(
        &mut p,
        "error",
        json!({"threadId": "t", "turnId": "u", "error": {"message": "stream disconnected"}, "willRetry": true}),
    );

    // The user cancelled; "stream disconnected" is not why this turn ended.
    let interrupted = notif(
        &mut p,
        "turn/completed",
        json!({"threadId": "t", "turn": {"id": "u", "items": [], "status": "interrupted"}}),
    );
    assert_eq!(interrupted[0].result["stop_reason"], "interrupted");
    assert!(interrupted[0].result.get("error_message").is_none());
}

#[test]
fn unknown_notifications_are_ignored() {
    let mut p = parser();
    for method in [
        "thread/status/changed",
        "hook/started",
        "mcpServer/startupStatus/updated",
        "account/rateLimits/updated",
    ] {
        assert!(notif(&mut p, method, json!({})).is_empty(), "{method}");
    }
}

// ─── permission-mode mapping ───

#[test]
fn permission_mode_maps_to_exec_equivalent_thread_params() {
    assert_eq!(
        thread_permission_params(CliPermissionMode::Plan),
        ("on-request", "read-only")
    );
    assert_eq!(
        thread_permission_params(CliPermissionMode::Manual),
        ("on-request", "workspace-write")
    );
    assert_eq!(
        thread_permission_params(CliPermissionMode::AutoEdit),
        ("never", "workspace-write")
    );
    assert_eq!(
        thread_permission_params(CliPermissionMode::FullPermission),
        ("never", "danger-full-access")
    );
}

#[test]
fn only_full_permission_auto_accepts_approvals() {
    assert!(approval_auto_accept(CliPermissionMode::FullPermission));
    assert!(!approval_auto_accept(CliPermissionMode::AutoEdit));
    assert!(!approval_auto_accept(CliPermissionMode::Manual));
    assert!(!approval_auto_accept(CliPermissionMode::Plan));
}

fn native_turn(
    user_input: &str,
    developer_instructions: &str,
    resume_thread_id: Option<&str>,
) -> CodexAppServerTurn {
    CodexAppServerTurn {
        session_id: SESSION_ID.to_string(),
        user_input: user_input.to_string(),
        developer_instructions: Some(developer_instructions.to_string()),
        working_dir: "/workspace".to_string(),
        resume_thread_id: resume_thread_id.map(str::to_string),
        model: Some("gpt-5.6-sol".to_string()),
        permission_mode: CliPermissionMode::Manual,
        config: Some(json!({"mcp_servers": {"orgii": {"enabled": true}}})),
        image_paths: vec!["/tmp/native-image.png".to_string()],
        allow_native_context_recovery: false,
    }
}

#[test]
fn fresh_thread_keeps_agent_context_out_of_native_user_input() {
    let developer_context = concat!(
        "<orgii_cli_exec_mode_bridge>build</orgii_cli_exec_mode_bridge>\n\n",
        "<ide_context>focused file</ide_context>"
    );
    let turn = native_turn("Literal visible user text", developer_context, None);

    let (method, params) = build_thread_launch_request(&turn);
    assert_eq!(method, "thread/start");
    assert_eq!(params["developerInstructions"], developer_context);
    assert!(params.get("baseInstructions").is_none());

    let input = build_turn_input(&turn);
    assert_eq!(
        input[0],
        json!({"type": "text", "text": "Literal visible user text"})
    );
    assert_eq!(
        input[1],
        json!({"type": "localImage", "path": "/tmp/native-image.png"})
    );
    let visible_payload = serde_json::to_string(&input).expect("serialize turn input");
    assert!(!visible_payload.contains("<orgii_"));
    assert!(!visible_payload.contains("<ide_context>"));
}

#[test]
fn resumed_thread_receives_the_updated_developer_context() {
    let first = native_turn("first", "WORKSPACE_CONTEXT_V1", None);
    let (_, first_params) = build_thread_launch_request(&first);
    assert_eq!(
        first_params["developerInstructions"],
        "WORKSPACE_CONTEXT_V1"
    );

    let resumed = native_turn(
        "second literal user turn",
        "WORKSPACE_CONTEXT_V2\n<orgii_hook_context>latest</orgii_hook_context>",
        Some("native-codex-thread"),
    );
    let (method, params) = build_thread_launch_request(&resumed);
    assert_eq!(method, "thread/resume");
    assert_eq!(params["threadId"], "native-codex-thread");
    assert_eq!(
        params["developerInstructions"],
        "WORKSPACE_CONTEXT_V2\n<orgii_hook_context>latest</orgii_hook_context>"
    );
    assert!(params.get("baseInstructions").is_none());
    assert_eq!(
        build_turn_input(&resumed)[0],
        json!({"type": "text", "text": "second literal user turn"})
    );
}

// ─── live smoke (opt-in) ───

/// End-to-end smoke against a real `codex app-server` process. Requires the
/// codex binary on PATH and valid auth in `~/.codex` (spends a few tokens),
/// so it is `#[ignore]`d — run manually with:
/// `cargo test -p org2 --lib codex_app_server -- --ignored`
#[tokio::test]
#[ignore = "spawns real codex app-server; needs codex auth + network"]
async fn live_smoke_trivial_turn() {
    use super::run_app_server_turn;
    use std::process::Stdio;

    let mut child = match tokio::process::Command::new("codex")
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            eprintln!("SKIP: codex binary unavailable: {err}");
            return;
        }
    };
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel(256);

    let turn = CodexAppServerTurn {
        session_id: SESSION_ID.to_string(),
        user_input: "Reply with exactly: pong".to_string(),
        developer_instructions: None,
        working_dir: std::env::temp_dir().to_string_lossy().to_string(),
        resume_thread_id: None,
        model: None,
        permission_mode: CliPermissionMode::Plan,
        config: None,
        image_paths: vec![],
        allow_native_context_recovery: false,
    };

    let protocol =
        tokio::spawn(async move { run_app_server_turn(stdin, stdout, turn, chunk_tx).await });

    let mut saw_session_start_thread_id = false;
    let mut assistant_text = String::new();
    let drain = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        while let Some(chunk) = chunk_rx.recv().await {
            if chunk.action_type == "session_start" && chunk.thread_id.is_some() {
                saw_session_start_thread_id = true;
            }
            if chunk.action_type == "assistant" {
                if let Some(text) = chunk.result.get("content").and_then(|v| v.as_str()) {
                    assistant_text.push_str(text);
                }
            }
        }
    })
    .await;
    assert!(drain.is_ok(), "chunk stream did not close within 120s");

    let result = protocol
        .await
        .expect("protocol task join")
        .unwrap_or_else(|err| {
            if err.contains("unauthorized")
                || err.contains("login")
                || err.contains("not authenticated")
            {
                eprintln!("SKIP: codex auth unavailable: {err}");
                std::process::exit(0);
            }
            panic!("protocol error: {err}");
        });

    let _ = child.kill().await;

    assert!(!result.thread_id.is_empty(), "thread id captured");
    assert_eq!(result.turn_status, "completed");
    assert!(
        saw_session_start_thread_id,
        "session_start carried thread_id"
    );
    assert!(
        assistant_text.to_lowercase().contains("pong"),
        "assistant replied: {assistant_text:?}"
    );
    assert!(result.usage.is_some(), "token usage captured");

    // The rollout must exist with the thread id as the file-stem suffix —
    // native transcript replay and managed-mirror dedup key on it.
    let codex_home = std::env::var("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join(".codex"));
    let mut found_rollout = false;
    let mut stack = vec![codex_home.join("sessions")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|stem| stem.ends_with(&result.thread_id))
            {
                found_rollout = true;
            }
        }
    }
    assert!(
        found_rollout,
        "rollout jsonl written for {}",
        result.thread_id
    );
}
