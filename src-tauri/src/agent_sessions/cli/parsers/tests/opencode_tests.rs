use serde_json::json;

use crate::agent_sessions::cli::parsers::acp_common::{AcpAgentAdapter, AcpNotificationParser};
use crate::agent_sessions::cli::parsers::opencode::OpenCodeAdapter;

// ============================================
// OpenCodeAdapter::map_tool_kind — name-based overrides
// ============================================
//
// The adapter checks `raw_input["name"]` (or `raw_input["tool"]`) first.
// If matched, the name-based branch wins regardless of `kind`.

#[test]
fn map_tool_kind_name_write_lowercase() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "write"})),
        "Edit"
    );
}

#[test]
fn map_tool_kind_name_write_pascal_case() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "Write"})),
        "Edit"
    );
}

#[test]
fn map_tool_kind_name_read_lowercase() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "read"})),
        "Read"
    );
}

#[test]
fn map_tool_kind_name_read_pascal_case() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "Read"})),
        "Read"
    );
}

#[test]
fn map_tool_kind_name_bash_lowercase() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "bash"})),
        "Shell"
    );
}

#[test]
fn map_tool_kind_name_bash_pascal_case() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "Bash"})),
        "Shell"
    );
}

#[test]
fn map_tool_kind_name_execute() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "execute"})),
        "Shell"
    );
}

#[test]
fn map_tool_kind_name_grep_lowercase() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "grep"})),
        "Grep"
    );
}

#[test]
fn map_tool_kind_name_grep_pascal_case() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "Grep"})),
        "Grep"
    );
}

#[test]
fn map_tool_kind_name_glob_lowercase() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "glob"})),
        "Glob"
    );
}

#[test]
fn map_tool_kind_name_glob_pascal_case() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "Glob"})),
        "Glob"
    );
}

#[test]
fn map_tool_kind_name_fetch_lowercase() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "fetch"})),
        "WebFetch"
    );
}

#[test]
fn map_tool_kind_name_fetch_pascal_case() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "Fetch"})),
        "WebFetch"
    );
}

#[test]
fn map_tool_kind_name_webfetch_exact() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "WebFetch"})),
        "WebFetch"
    );
}

#[test]
fn map_tool_kind_name_todo_write() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"name": "TodoWrite"})),
        "UpdateTodos"
    );
}

// `tool` field as alias for `name`
#[test]
fn map_tool_kind_tool_field_write() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("other", "", &json!({"tool": "write"})),
        "Edit"
    );
}

#[test]
fn map_tool_kind_tool_field_bash() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("read", "", &json!({"tool": "bash"})),
        "Shell"
    );
}

// ============================================
// OpenCodeAdapter::map_tool_kind — kind-based fallback
// (fires when name/tool field is absent or unrecognised)
// ============================================

#[test]
fn map_tool_kind_kind_execute_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("execute", "", &json!({})), "Shell");
}

#[test]
fn map_tool_kind_kind_read_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("read", "", &json!({})), "Read");
}

#[test]
fn map_tool_kind_kind_write_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("write", "", &json!({})), "Edit");
}

#[test]
fn map_tool_kind_kind_edit_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("edit", "", &json!({})), "Edit");
}

#[test]
fn map_tool_kind_kind_search_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("search", "", &json!({})), "Grep");
}

#[test]
fn map_tool_kind_kind_delete_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("delete", "", &json!({})), "Delete");
}

#[test]
fn map_tool_kind_kind_fetch_no_name() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("fetch", "", &json!({})), "WebFetch");
}

#[test]
fn map_tool_kind_kind_other_maps_to_task() {
    let adapter = OpenCodeAdapter;
    assert_eq!(adapter.map_tool_kind("other", "", &json!({})), "Task");
}

#[test]
fn map_tool_kind_unrecognised_kind_passthrough() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("something_custom", "", &json!({})),
        "something_custom"
    );
}

// Name-based match takes priority over kind
#[test]
fn map_tool_kind_name_wins_over_kind() {
    let adapter = OpenCodeAdapter;
    // kind says "read", but name says "write" → Edit should win
    assert_eq!(
        adapter.map_tool_kind("read", "", &json!({"name": "write"})),
        "Edit"
    );
}

// Unrecognised name falls through to kind-based mapping
#[test]
fn map_tool_kind_unrecognised_name_falls_through_to_kind() {
    let adapter = OpenCodeAdapter;
    assert_eq!(
        adapter.map_tool_kind("execute", "", &json!({"name": "some_unknown_tool"})),
        "Shell"
    );
}

// ============================================
// AcpNotificationParser<OpenCodeAdapter> — parse_update integration
// ============================================

fn make_parser() -> AcpNotificationParser<OpenCodeAdapter> {
    make_parser_with_task("")
}

fn make_parser_with_task(task: &str) -> AcpNotificationParser<OpenCodeAdapter> {
    AcpNotificationParser::new_with_task(OpenCodeAdapter, "test-session", task)
}

// Helper: build a session/update notification body
fn session_update(update_type: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("sessionUpdate".to_string(), json!(update_type));
    if let serde_json::Value::Object(extra_map) = extra {
        for (key, value) in extra_map {
            obj.insert(key, value);
        }
    }
    serde_json::Value::Object(obj)
}

#[test]
fn parse_update_agent_message_chunk() {
    let mut parser = make_parser();
    let update = session_update(
        "agent_message_chunk",
        json!({"content": {"text": "Hello from OpenCode"}}),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "assistant_delta");
    assert_eq!(chunks[0].function, "message");
    assert_eq!(chunks[0].result["content"], "Hello from OpenCode");
    assert_eq!(chunks[0].result["is_delta"], true);
}

#[test]
fn parse_update_agent_message_chunk_empty_text_produces_no_chunk() {
    let mut parser = make_parser();
    let update = session_update("agent_message_chunk", json!({"content": {"text": ""}}));
    let chunks = parser.parse_update(&update);
    assert!(chunks.is_empty());
}

#[test]
fn parse_update_tool_call_write_name_maps_to_edit() {
    let mut parser = make_parser();
    let update = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-001",
            "kind": "other",
            "title": "Write file",
            "rawInput": {
                "name": "write",
                "path": "src/main.rs",
                "content": "fn main() {}"
            }
        }),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "tool_call");
    assert_eq!(chunks[0].function, "Edit");
    assert_eq!(chunks[0].args["path"], "src/main.rs");
}

#[test]
fn parse_update_tool_call_bash_name_maps_to_shell() {
    let mut parser = make_parser();
    let update = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-002",
            "kind": "other",
            "title": "Run command",
            "rawInput": {
                "name": "Bash",
                "command": "ls -la"
            }
        }),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "Shell");
    assert_eq!(chunks[0].args["command"], "ls -la");
}

#[test]
fn parse_update_tool_call_read_name() {
    let mut parser = make_parser();
    let update = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-003",
            "kind": "other",
            "title": "",
            "rawInput": {
                "name": "Read",
                "path": "src/lib.rs"
            }
        }),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "Read");
    assert_eq!(chunks[0].args["path"], "src/lib.rs");
}

#[test]
fn parse_update_tool_call_grep_name() {
    let mut parser = make_parser();
    let update = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-004",
            "kind": "search",
            "title": "Search for foo",
            "rawInput": {
                "name": "Grep",
                "pattern": "fn main"
            }
        }),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "Grep");
    assert_eq!(chunks[0].args["query"], "fn main");
}

#[test]
fn parse_update_tool_call_update_resolves_with_result() {
    let mut parser = make_parser();

    // Start a tool call
    let start = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-010",
            "kind": "execute",
            "title": "",
            "rawInput": {"name": "bash", "command": "echo hi"}
        }),
    );
    let start_chunks = parser.parse_update(&start);
    assert_eq!(start_chunks.len(), 1);
    assert_eq!(start_chunks[0].function, "Shell");
    assert_eq!(start_chunks[0].result["status"], "running");

    // Resolve the tool call
    let update = session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-010",
            "status": "completed",
            "content": "hi\n"
        }),
    );
    let update_chunks = parser.parse_update(&update);
    assert_eq!(update_chunks.len(), 1);
    assert_eq!(update_chunks[0].function, "Shell");
    assert!(update_chunks[0].result.get("success").is_some());
}

#[test]
fn parse_update_tool_call_update_error_status() {
    let mut parser = make_parser();

    let start = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-011",
            "kind": "execute",
            "title": "",
            "rawInput": {"name": "bash", "command": "bad_cmd"}
        }),
    );
    parser.parse_update(&start);

    let update = session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-011",
            "status": "failed",
            "content": "command not found"
        }),
    );
    let chunks = parser.parse_update(&update);
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].result.get("error").is_some());
}

#[test]
fn parse_update_todo_write_name() {
    let mut parser = make_parser();
    let update = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-020",
            "kind": "other",
            "title": "",
            "rawInput": {
                "name": "TodoWrite",
                "todos": [
                    {"id": "1", "content": "Task A", "status": "pending"},
                    {"id": "2", "content": "Task B", "status": "completed"}
                ]
            }
        }),
    );
    let chunks = parser.parse_update(&update);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "UpdateTodos");
    let todos = chunks[0].args["todos"].as_array().unwrap();
    assert_eq!(todos.len(), 2);
}

#[test]
fn parse_update_unhandled_session_update_produces_no_chunk() {
    let mut parser = make_parser();
    let update = session_update("some_unknown_update_type", json!({}));
    let chunks = parser.parse_update(&update);
    assert!(chunks.is_empty());
}

#[test]
fn parse_update_completed_think_task_result_maps_to_subagent_tool_call() {
    let mut parser = make_parser();

    let start = session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-task",
            "kind": "think",
            "title": "",
            "rawInput": {}
        }),
    );
    let start_chunks = parser.parse_update(&start);
    assert!(start_chunks.is_empty());

    let update = session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-task",
            "status": "completed",
            "content": "<task id=\"ses_123\" state=\"completed\">\n<task_result>\nFinal answer from subagent.\n</task_result>\n</task>"
        }),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "tool_call");
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(chunks[0].args["action"], "delegate");
    assert_eq!(chunks[0].args["subagent_type"], "opencode");
    assert_eq!(chunks[0].args["subagentSessionId"], "opencodeapp-ses_123");
    assert_eq!(chunks[0].result["success"], true);
    assert_eq!(chunks[0].result["status"], "completed");
    assert_eq!(chunks[0].result["content"], "Final answer from subagent.");
}

#[test]
fn parse_update_completed_think_task_detailed_content_preserves_prompt() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-detailed",
            "kind": "think",
            "title": "",
            "rawInput": {}
        }),
    ));

    let update = session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-detailed",
            "status": "completed",
            "content": "<task_result>Short answer.</task_result>",
            "rawOutput": {
                "content": "<task_result>Short answer.</task_result>",
                "detailedContent": "<task id=\"ses_detailed\" prompt=\"What is the weather in Paris?\" state=\"completed\"><task_result>Short answer.</task_result></task>"
            }
        }),
    );
    let chunks = parser.parse_update(&update);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(
        chunks[0].args["subagentSessionId"],
        "opencodeapp-ses_detailed"
    );
    assert_eq!(chunks[0].args["prompt"], "What is the weather in Paris?");
    assert_eq!(
        chunks[0].result["subagentSessionId"],
        "opencodeapp-ses_detailed"
    );
}

#[test]
fn parse_update_completed_think_task_raw_input_preserves_prompt() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-raw-input",
            "kind": "think",
            "title": "Fallback title should not win",
            "rawInput": {
                "description": "Analyze the React source tree"
            }
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-raw-input",
            "status": "completed",
            "content": "<task id=\"ses_raw_input\" state=\"completed\"><task_result>Done.</task_result></task>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(chunks[0].args["prompt"], "Analyze the React source tree");
    assert_eq!(
        chunks[0].args["description"],
        "Analyze the React source tree"
    );
}

#[test]
fn parse_update_completed_think_task_ignores_result_like_raw_text() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-result-like-raw",
            "kind": "think",
            "title": "Analyze .rs files in project (@explore subagent)",
            "rawInput": {
                "text": "Now I have all the data. Here is the comprehensive report."
            }
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-result-like-raw",
            "status": "completed",
            "content": "<task id=\"ses_result_like_raw\" state=\"completed\"><task_result>Now I have all the data. Here is the comprehensive report.</task_result></task>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(
        chunks[0].args["prompt"],
        "Analyze .rs files in project (@explore subagent)"
    );
    assert_eq!(
        chunks[0].result["content"],
        "Now I have all the data. Here is the comprehensive report."
    );
}

#[test]
fn parse_update_completed_think_task_ignores_paste_placeholder_raw_text() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-paste-placeholder",
            "kind": "think",
            "title": "Analyze .rs files in project (@explore subagent)",
            "rawInput": {
                "text": "pasted.txt [paste:paste://1782778711175-d8dsv8]"
            }
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-paste-placeholder",
            "status": "completed",
            "content": "<task id=\"ses_paste_placeholder\" state=\"completed\"><task_result>Done.</task_result></task>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(
        chunks[0].args["prompt"],
        "Analyze .rs files in project (@explore subagent)"
    );
}

#[test]
fn parse_update_completed_think_task_result_body_never_becomes_prompt() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-result-body",
            "kind": "think",
            "title": "Task",
            "rawInput": {}
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-result-body",
            "status": "completed",
            "content": "<task id=\"ses_result_body\" state=\"completed\"><task_result>Now I have all the data. Here is the comprehensive report.</task_result></task>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert!(chunks[0].args["prompt"].is_null());
    assert_eq!(chunks[0].args["description"], "Assigned task to subagent");
    assert_eq!(
        chunks[0].result["content"],
        "Now I have all the data. Here is the comprehensive report."
    );
}

#[test]
fn parse_update_completed_think_task_title_preserves_prompt() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-title",
            "kind": "think",
            "title": "Analyze .tsx files",
            "rawInput": {}
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-title",
            "status": "completed",
            "content": "<task id=\"ses_title\" state=\"completed\"><task_result>Done.</task_result></task>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(chunks[0].args["prompt"], "Analyze .tsx files");
    assert_eq!(chunks[0].args["description"], "Analyze .tsx files");
}

#[test]
fn parse_update_completed_think_task_generic_title_does_not_use_parent_prompt() {
    let mut parser = make_parser_with_task(
        "启动一个子任务（subagent），让它帮我分析当前项目里有多少个 .tsx 文件，并生成一份报告",
    );

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-generic-title",
            "kind": "think",
            "title": "task",
            "rawInput": {}
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-generic-title",
            "status": "completed",
            "content": "<task id=\"ses_generic_title\" state=\"completed\"><task_result>Done.</task_result></task>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert!(chunks[0].args["prompt"].is_null());
    assert_eq!(chunks[0].args["description"], "Assigned task to subagent");
}

#[test]
fn parse_update_completed_think_task_strips_opencode_prompt_prelude() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-prelude",
            "kind": "think",
            "title": "task",
            "rawInput": {}
        }),
    ));

    let wrapped_prompt = "<skills>\n## Skills (mandatory)\n</skills>\n\n<orgii_cli_exec_mode_bridge>\nYou are running inside ORGII BUILD mode.\n</orgii_cli_exec_mode_bridge>\n\n启动一个子任务，分析 .tsx 文件";
    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-prelude",
            "status": "completed",
            "content": "<task_result>Done.</task_result>",
            "rawOutput": {
                "content": "<task_result>Done.</task_result>",
                "detailedContent": format!("<task id=\"ses_prelude\" state=\"completed\">{}<task_result>Done.</task_result></task>", wrapped_prompt)
            }
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(chunks[0].args["prompt"], "启动一个子任务，分析 .tsx 文件");
    assert_eq!(
        chunks[0].args["description"],
        "启动一个子任务，分析 .tsx 文件"
    );
}

#[test]
fn parse_update_failed_think_task_result_stays_tool_call() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-failed",
            "kind": "think",
            "title": "",
            "rawInput": {}
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-failed",
            "status": "failed",
            "content": "<task_result>not a successful answer</task_result>"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "tool_call");
    assert_eq!(chunks[0].function, "think");
    assert!(chunks[0].result.get("error").is_some());
}

#[test]
fn parse_update_plain_think_result_stays_tool_call() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-plain",
            "kind": "think",
            "title": "",
            "rawInput": {}
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-plain",
            "status": "completed",
            "content": "ordinary reasoning note"
        }),
    ));

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "tool_call");
    assert_eq!(chunks[0].function, "think");
    assert_eq!(chunks[0].result["content"], "ordinary reasoning note");
}

#[test]
fn parse_update_successful_empty_think_result_is_suppressed() {
    let mut parser = make_parser();

    parser.parse_update(&session_update(
        "tool_call",
        json!({
            "toolCallId": "tc-think-empty",
            "kind": "think",
            "title": "",
            "rawInput": {}
        }),
    ));

    let chunks = parser.parse_update(&session_update(
        "tool_call_update",
        json!({
            "toolCallId": "tc-think-empty",
            "status": "completed",
            "content": ""
        }),
    ));

    assert!(chunks.is_empty());
}

#[test]
fn parse_update_agent_thought_chunk_plain_text() {
    let mut parser = make_parser();
    let update = session_update(
        "agent_thought_chunk",
        json!({"content": {"text": "I'm thinking about this..."}}),
    );
    let chunks = parser.parse_update(&update);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "llm_thinking_delta");
}

#[test]
fn flush_thought_buffer_emits_accumulated_thought() {
    let mut parser = make_parser();
    // Send a thought chunk that starts a JSON object (not complete yet)
    let partial = session_update(
        "agent_thought_chunk",
        json!({"content": {"text": "plain thought text"}}),
    );
    let _ = parser.parse_update(&partial);

    // Flushing should emit remaining thought
    let flush_chunks = parser.flush_thought_buffer();
    // Plain text is emitted immediately, so buffer should be empty here
    assert!(flush_chunks.is_empty());
}
