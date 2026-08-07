//! Tests for the Cursor IDE bubble parser.
//!
//! Fixtures in `fixtures/` are real bubble JSON blobs anonymized by replacing
//! `/Users/<real_name>/...` paths with `/Users/test_user/...` and stripping
//! the (un-anonymizable) `toolFormerData.toolCallBinary` blob.

use super::*;

const FIXTURE_COMPOSER: &str = include_str!("../fixtures/composer.json");
const FIXTURE_BUBBLE_USER: &str = include_str!("../fixtures/bubble_user.json");
const FIXTURE_BUBBLE_ASSISTANT_TEXT: &str = include_str!("../fixtures/bubble_assistant_text.json");
const FIXTURE_BUBBLE_ASSISTANT_TOOL: &str = include_str!("../fixtures/bubble_assistant_tool.json");

const TEST_SESSION_ID: &str = "cursoride-test-session-uuid";

fn parse_bubble(raw_json: &str, header_type: i64) -> OrderedBubble {
    let raw: RawBubble = serde_json::from_str(raw_json).expect("fixture parse");
    OrderedBubble {
        bubble_id: raw.bubble_id.clone(),
        bubble_type: header_type,
        raw,
    }
}

/// In-memory Cursor DB stand-in. Tests that don't exercise content-blob
/// resolution use an empty schema; the `composer.content.{hash}` lookup
/// then returns `None` (the production fallback path).
fn empty_test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .expect("create test schema");
    conn
}

fn insert_blob(conn: &Connection, key: &str, value: &str) {
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        [key, value],
    )
    .expect("insert blob");
}

// ----------------------------------------------------------------------------
// Composer ordering
// ----------------------------------------------------------------------------

#[test]
fn parses_composer_full_conversation_headers() {
    let parsed: RawComposerForOrder =
        serde_json::from_str(FIXTURE_COMPOSER).expect("composer fixture parses");
    assert_eq!(parsed.full_conversation_headers_only.len(), 6);
    assert_eq!(parsed.full_conversation_headers_only[0].bubble_type, 1);
    assert_eq!(parsed.full_conversation_headers_only[1].bubble_type, 2);
    // All bubble ids non-empty
    for h in &parsed.full_conversation_headers_only {
        assert!(!h.bubble_id.is_empty(), "header with empty bubble_id");
    }
}

// ----------------------------------------------------------------------------
// User bubble
// ----------------------------------------------------------------------------

#[test]
fn user_bubble_becomes_user_message_chunk() {
    let bubble = parse_bubble(FIXTURE_BUBBLE_USER, 1);
    let chunk = user_bubble_to_chunk(TEST_SESSION_ID, &bubble).expect("user chunk emitted");

    assert_eq!(chunk.action_type, "raw");
    assert_eq!(chunk.function, "user_message");
    assert_eq!(chunk.session_id, TEST_SESSION_ID);
    assert_eq!(chunk.result["type"], "user");
    assert_eq!(chunk.result["message"]["role"], "user");
    assert_eq!(
        chunk.result["message"]["content"],
        "currently our system works fine -- except the parallel problem -- what's the minimalistic and smartest move"
    );
}

#[test]
fn user_bubble_with_empty_text_uses_placeholder() {
    let mut bubble = parse_bubble(FIXTURE_BUBBLE_USER, 1);
    bubble.raw.text = String::new();
    let chunk = user_bubble_to_chunk(TEST_SESSION_ID, &bubble).expect("placeholder chunk");
    assert_eq!(
        chunk.result["message"]["content"],
        "User message not loaded."
    );
}

// ----------------------------------------------------------------------------
// Assistant text bubble
// ----------------------------------------------------------------------------

#[test]
fn assistant_text_bubble_becomes_assistant_chunk() {
    let bubble = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TEXT, 2);
    let chunk = assistant_text_bubble_to_chunk(TEST_SESSION_ID, &bubble)
        .expect("assistant text chunk emitted");

    assert_eq!(chunk.action_type, "assistant");
    assert_eq!(chunk.function, "assistant");
    assert_eq!(chunk.result["role"], "assistant");
    assert_eq!(chunk.result["is_delta"], false);
    assert_eq!(chunk.result["is_full_content"], true);
    assert!(chunk.result["content"]
        .as_str()
        .unwrap()
        .contains("simplify"));
}

#[test]
fn assistant_text_bubble_with_empty_text_is_skipped() {
    let mut bubble = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TEXT, 2);
    bubble.raw.text = String::new();
    assert!(assistant_text_bubble_to_chunk(TEST_SESSION_ID, &bubble).is_none());
}

// ----------------------------------------------------------------------------
// Assistant tool bubble
// ----------------------------------------------------------------------------

#[test]
fn assistant_tool_bubble_becomes_tool_call_chunk_with_canonical_name() {
    let conn = empty_test_db();
    let bubble = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TOOL, 2);
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble)
        .expect("tool chunk emitted");

    assert_eq!(chunk.action_type, "tool_call");
    // edit_file_v2 → edit_file_by_replace (built-in canonical)
    assert_eq!(chunk.function, "edit_file_by_replace");
    // Cursor's `relativeWorkspacePath` translated to canonical `file_path`
    // (still keep the original alongside, for debugging/inspection).
    assert_eq!(
        chunk.args["file_path"],
        "/Users/test_user/Documents/GitHub/orgii_frontend/src/store/session/sessionAtom/atoms.ts"
    );
    assert_eq!(
        chunk.args["relativeWorkspacePath"],
        "/Users/test_user/Documents/GitHub/orgii_frontend/src/store/session/sessionAtom/atoms.ts"
    );
    // call_id + status enriched onto the result
    assert_eq!(chunk.result["call_id"], "toolu_01Lz199WAyPGPwoETvjas8he");
    assert_eq!(chunk.result["status"], "completed");
    // Inner result fields preserved (content blobs unresolved here — empty DB)
    assert!(chunk.result["beforeContentId"].is_string());
    assert!(chunk.result["afterContentId"].is_string());
    assert!(chunk.result.get("old_content").is_none());
    assert!(chunk.result.get("new_content").is_none());
}

#[test]
fn assistant_bubble_without_tool_data_falls_back_to_text_path() {
    let conn = empty_test_db();
    let bubble = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TEXT, 2);
    assert!(
        assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).is_none(),
        "tool path must reject text-only bubbles"
    );
}

#[test]
fn cursor_switch_mode_history_stays_native_tool_name() {
    let conn = empty_test_db();
    let bubble = OrderedBubble {
        bubble_id: "switch-mode-bubble".to_string(),
        bubble_type: 2,
        raw: RawBubble {
            bubble_type: 2,
            bubble_id: "switch-mode-bubble".to_string(),
            created_at: "2026-05-17T08:58:00.000Z".to_string(),
            text: String::new(),
            tool_former_data: Some(RawToolFormerData {
                name: "SwitchMode".to_string(),
                tool_call_id: "call_switch_mode".to_string(),
                status: "completed".to_string(),
                params: r#"{"targetModeId":"plan","explanation":"Need a plan first"}"#.to_string(),
                result: r#"{"success":{"fromModeId":"","toModeId":"plan"}}"#.to_string(),
                additional_data: serde_json::Value::Null,
            }),
        },
    };

    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble)
        .expect("switch mode chunk emitted");

    assert_eq!(chunk.action_type, "tool_call");
    assert_eq!(chunk.function, "SwitchMode");
    assert_eq!(chunk.args["targetModeId"], "plan");
    assert_eq!(chunk.args["explanation"], "Need a plan first");
    assert_eq!(chunk.result["status"], "completed");
    assert_eq!(chunk.result["call_id"], "call_switch_mode");
    assert_eq!(chunk.result["success"]["toModeId"], "plan");
    assert!(chunk.result.get("pending").is_none());
}

// ----------------------------------------------------------------------------
// Canonical tool name mapping
// ----------------------------------------------------------------------------

#[test]
fn canonical_tool_names_map_correctly() {
    assert_eq!(cursor_tool_name_to_canonical("read_file_v2"), "read_file");
    assert_eq!(
        cursor_tool_name_to_canonical("edit_file_v2"),
        "edit_file_by_replace"
    );
    assert_eq!(
        cursor_tool_name_to_canonical("run_terminal_command_v2"),
        "run_command_line"
    );
    assert_eq!(cursor_tool_name_to_canonical("delete_file"), "delete_file");
    assert_eq!(cursor_tool_name_to_canonical("read_lints"), "query_lsp");
    assert_eq!(cursor_tool_name_to_canonical("ripgrep_raw_search"), "grep");
    assert_eq!(cursor_tool_name_to_canonical("todo_write"), "manage_todo");
    assert_eq!(cursor_tool_name_to_canonical("web_fetch"), "web_search");
    assert_eq!(cursor_tool_name_to_canonical("task_v2"), "subagent");
}

#[test]
fn ask_question_maps_to_canonical_ask_user_questions() {
    assert_eq!(
        cursor_tool_name_to_canonical("ask_question"),
        "ask_user_questions"
    );
}

#[test]
fn unknown_tool_names_pass_through_unchanged() {
    // await, update_current_step, mcp-* — not in built-in set
    assert_eq!(cursor_tool_name_to_canonical("await"), "await");
    assert_eq!(
        cursor_tool_name_to_canonical("update_current_step"),
        "update_current_step"
    );
    assert_eq!(
        cursor_tool_name_to_canonical("mcp-cursor-ide-browser-browser_tabs"),
        "mcp-cursor-ide-browser-browser_tabs"
    );
}

// ----------------------------------------------------------------------------
// Inner JSON parsing
// ----------------------------------------------------------------------------

#[test]
fn parse_inner_json_handles_valid_string() {
    let parsed = parse_inner_json(r#"{"foo": "bar"}"#);
    assert_eq!(parsed["foo"], "bar");
}

#[test]
fn parse_inner_json_handles_empty_string() {
    let parsed = parse_inner_json("");
    assert!(parsed.is_object());
    assert_eq!(parsed.as_object().unwrap().len(), 0);
}

#[test]
fn parse_inner_json_preserves_unparseable_string() {
    let parsed = parse_inner_json("not json at all");
    assert_eq!(parsed["raw"], "not json at all");
}

// ----------------------------------------------------------------------------
// Created-at normalization
// ----------------------------------------------------------------------------

#[test]
fn normalize_created_at_passes_through_valid_iso() {
    assert_eq!(
        normalize_created_at("2026-05-02T08:32:32.293Z"),
        "2026-05-02T08:32:32.293Z"
    );
}

#[test]
fn normalize_created_at_replaces_empty() {
    let out = normalize_created_at("");
    assert!(chrono::DateTime::parse_from_rfc3339(&out).is_ok());
}

#[test]
fn normalize_created_at_replaces_garbage() {
    let out = normalize_created_at("not a date");
    assert!(chrono::DateTime::parse_from_rfc3339(&out).is_ok());
}

// ----------------------------------------------------------------------------
// Session prefix
// ----------------------------------------------------------------------------

#[test]
fn strip_session_prefix_strips_when_present() {
    assert_eq!(strip_session_prefix("cursoride-abc-123"), "abc-123");
}

#[test]
fn strip_session_prefix_passthrough_when_absent() {
    assert_eq!(strip_session_prefix("abc-123"), "abc-123");
}

// ----------------------------------------------------------------------------
// End-to-end: bubbles_to_chunks ordering and filtering
// ----------------------------------------------------------------------------

#[test]
fn bubbles_to_chunks_preserves_order_and_filters_empty() {
    let user = parse_bubble(FIXTURE_BUBBLE_USER, 1);
    let mut empty_assistant = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TEXT, 2);
    empty_assistant.raw.text = String::new();
    empty_assistant.raw.tool_former_data = None;
    empty_assistant.raw.bubble_id = "empty-assistant".to_string();
    let asst_text = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TEXT, 2);
    let asst_tool = parse_bubble(FIXTURE_BUBBLE_ASSISTANT_TOOL, 2);

    let conn = empty_test_db();
    let chunks = bubbles_to_chunks(
        &conn,
        TEST_SESSION_ID,
        &[user, empty_assistant, asst_text, asst_tool],
        &CursorComposerContext::default(),
    );

    // Empty bubble dropped → 3 chunks
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].function, "user_message");
    assert_eq!(chunks[1].function, "assistant");
    assert_eq!(chunks[2].function, "edit_file_by_replace");

    // Every chunk carries the session id
    for chunk in &chunks {
        assert_eq!(chunk.session_id, TEST_SESSION_ID);
    }
}

#[test]
fn bubble_type_of_zero_falls_back_to_header_type() {
    let mut bubble = parse_bubble(FIXTURE_BUBBLE_USER, 1);
    // Simulate a bubble blob where `type` field is missing or zero.
    bubble.raw.bubble_type = 0;
    let conn = empty_test_db();
    let chunks = bubbles_to_chunks(
        &conn,
        TEST_SESSION_ID,
        &[bubble],
        &CursorComposerContext::default(),
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, "user_message");
}

#[test]
fn unknown_bubble_type_is_skipped() {
    let mut bubble = parse_bubble(FIXTURE_BUBBLE_USER, 1);
    bubble.raw.bubble_type = 99;
    bubble.bubble_type = 99;
    let conn = empty_test_db();
    let chunks = bubbles_to_chunks(
        &conn,
        TEST_SESSION_ID,
        &[bubble],
        &CursorComposerContext::default(),
    );
    assert!(chunks.is_empty());
}

#[test]
fn subagent_composer_user_bubble_becomes_subagent_event() {
    let bubble = parse_bubble(FIXTURE_BUBBLE_USER, 1);
    let conn = empty_test_db();
    let composer_context = CursorComposerContext {
        subagent_info: Some(RawCursorSubagentInfo {
            subagent_type_name: "explore".to_string(),
            parent_composer_id: "parent-composer-id".to_string(),
            tool_call_id: "toolu_cursor_subagent".to_string(),
        }),
    };

    let chunks = bubbles_to_chunks(&conn, TEST_SESSION_ID, &[bubble], &composer_context);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].action_type, "tool_call");
    assert_eq!(chunks[0].function, "subagent");
    assert_eq!(chunks[0].args["subagent_type"], "explore");
    assert_eq!(chunks[0].args["parentComposerId"], "parent-composer-id");
    assert_eq!(chunks[0].args["cursorToolCallId"], "toolu_cursor_subagent");
    assert_eq!(chunks[0].result["call_id"], "toolu_cursor_subagent");
    assert_eq!(chunks[0].result["success"], true);
}

// ----------------------------------------------------------------------------
// Lenient parsing: malformed bubble fields shouldn't break the whole session
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Per-canonical field normalization
// ----------------------------------------------------------------------------

fn make_tool_bubble(name: &str, params_json: &str, result_json: &str) -> OrderedBubble {
    make_tool_bubble_with_additional(
        name,
        params_json,
        result_json,
        Value::Object(Default::default()),
    )
}

fn make_tool_bubble_with_additional(
    name: &str,
    params_json: &str,
    result_json: &str,
    additional_data: Value,
) -> OrderedBubble {
    OrderedBubble {
        bubble_id: format!("test-{}", name),
        bubble_type: 2,
        raw: RawBubble {
            bubble_type: 2,
            bubble_id: format!("test-{}", name),
            created_at: "2026-05-02T08:32:32.293Z".to_string(),
            text: String::new(),
            tool_former_data: Some(RawToolFormerData {
                name: name.to_string(),
                tool_call_id: format!("toolu_test_{}", name),
                status: "completed".to_string(),
                params: params_json.to_string(),
                result: result_json.to_string(),
                additional_data,
            }),
        },
    }
}

#[test]
fn read_file_args_translate_targetfile_to_canonical() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "read_file_v2",
        r#"{"targetFile":"/abs/path/foo.ts","charsLimit":1000000,"effectiveUri":"/abs/path/foo.ts"}"#,
        r#"{"contents":"hello world\nline 2\n"}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "read_file");
    assert_eq!(chunk.args["target_file"], "/abs/path/foo.ts");
    assert_eq!(chunk.args["file_path"], "/abs/path/foo.ts");
    // result.contents → result.content (what fileExtractors reads)
    assert_eq!(chunk.result["content"], "hello world\nline 2\n");
}

#[test]
fn terminal_command_description_maps_to_shell_description() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "run_terminal_command_v2",
        r#"{"command":"git log -5 --oneline","cwd":"","commandDescription":"Show recent git commits"}"#,
        r#"{"output":"812aae8a feat(session): import external agent history\n","rejected":false}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");

    assert_eq!(chunk.function, "run_command_line");
    assert_eq!(chunk.args["command"], "git log -5 --oneline");
    assert_eq!(chunk.args["description"], "Show recent git commits");
}

#[test]
fn edit_file_args_translate_path_and_resolve_content_blobs() {
    let conn = empty_test_db();
    insert_blob(&conn, "composer.content.before123", "keep\nold\n");
    insert_blob(&conn, "composer.content.after456", "keep\nnew\n");

    let bubble = make_tool_bubble(
        "edit_file_v2",
        r#"{"relativeWorkspacePath":"/abs/path/foo.ts","noCodeblock":true}"#,
        r#"{"beforeContentId":"composer.content.before123","afterContentId":"composer.content.after456"}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "edit_file_by_replace");
    assert_eq!(chunk.args["file_path"], "/abs/path/foo.ts");
    assert_eq!(chunk.result["old_content"], "keep\nold\n");
    assert_eq!(chunk.result["new_content"], "keep\nnew\n");
    assert_eq!(chunk.result["linesAdded"], 1);
    assert_eq!(chunk.result["linesRemoved"], 1);
    assert!(chunk.result["diffString"]
        .as_str()
        .unwrap()
        .contains("-old"));
    assert!(chunk.result["diffString"]
        .as_str()
        .unwrap()
        .contains("+new"));
}

#[test]
fn edit_file_with_missing_content_blobs_does_not_panic() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "edit_file_v2",
        r#"{"relativeWorkspacePath":"/abs/path/foo.ts"}"#,
        r#"{"beforeContentId":"composer.content.gone","afterContentId":"composer.content.alsogone"}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.args["file_path"], "/abs/path/foo.ts");
    assert!(chunk.result.get("old_content").is_none());
    assert!(chunk.result.get("new_content").is_none());
}

#[test]
fn delete_file_translates_path_field() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "delete_file",
        r#"{"relativeWorkspacePath":"/abs/path/dead.ts"}"#,
        "{}",
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "delete_file");
    assert_eq!(chunk.args["file_path"], "/abs/path/dead.ts");
}

#[test]
fn glob_translates_globpattern_to_pattern() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "glob_file_search",
        r#"{"targetDirectory":"src","globPattern":"**/*.ts"}"#,
        r#"{"directories":[]}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "glob_file_search");
    assert_eq!(chunk.args["pattern"], "**/*.ts");
    assert_eq!(chunk.args["path"], "src");
}

#[test]
fn grep_merges_cursor_pruned_summary_from_additional_data() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble_with_additional(
        "ripgrep_raw_search",
        r#"{"pattern":"dedupe","path":"src"}"#,
        "",
        json!({
            "isPruned": true,
            "totalFiles": 1,
            "totalMatches": 13,
            "topFiles": [
                { "uri": "src/modules/WorkStation/CodeEditor/SessionReplay/__tests__/deduplication.test.ts", "matchCount": 13 }
            ]
        }),
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "grep");
    assert_eq!(chunk.result["totalMatches"], 13);
    assert_eq!(chunk.result["topFiles"][0]["matchCount"], 13);
    assert_eq!(chunk.result["cursorAdditionalData"]["totalMatches"], 13);
    assert_eq!(
        chunk.result["cursorAdditionalData"]["topFiles"][0]["matchCount"],
        13
    );
}

#[test]
fn web_fetch_url_is_copied_to_query() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "web_fetch",
        r#"{"url":"https://example.com/docs"}"#,
        r##"{"url":"https://example.com/docs","markdown":"# Hello"}"##,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "web_search");
    assert_eq!(chunk.args["query"], "https://example.com/docs");
    // Original `url` field preserved for callers that want it.
    assert_eq!(chunk.args["url"], "https://example.com/docs");
}

#[test]
fn todo_write_lifts_finaltodos_to_todos() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "todo_write",
        r#"{"merge":true}"#,
        r#"{"success":true,"finalTodos":[{"id":"1","content":"do thing","status":"pending"}]}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "manage_todo");
    let todos = chunk.result["todos"].as_array().expect("todos array");
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0]["content"], "do thing");
    // `finalTodos` is consumed (removed) when lifted.
    assert!(chunk.result.get("finalTodos").is_none());
}

#[test]
fn task_v2_routes_to_subagent_canonical_with_replayable_session_id() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "task_v2",
        r#"{"description":"Research slow startup","prompt":"Read main.rs and report cold-start hot paths."}"#,
        r#"{"agentId":"c6f60eb9-575a-4478-aef7-037ee6c9f620"}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");

    // task_v2 → subagent (matches the alias map; SubagentBlock handles it).
    assert_eq!(chunk.function, "subagent");

    // SubagentAdapter fallback reads `args.description` / `args.prompt` directly —
    // Cursor already names them correctly, so no translation needed.
    assert_eq!(chunk.args["description"], "Research slow startup");
    assert_eq!(
        chunk.args["prompt"],
        "Read main.rs and report cold-start hot paths."
    );

    // `agentId` is moved off the result and surfaced as
    // `args.subagentSessionId` (with the cursoride- prefix) so the
    // SubagentBlock can `useSessionEvents(...)` against it and the
    // frontend's lazy EventStore loader can resolve it back to a composer
    // uuid. The original `agentId` field is removed to keep the expanded
    // block payload clean (the prefixed form is the canonical session id).
    assert_eq!(
        chunk.args["subagentSessionId"],
        "cursoride-c6f60eb9-575a-4478-aef7-037ee6c9f620"
    );
    assert!(
        chunk.result.get("agentId").is_none(),
        "agentId must be moved off the result onto args.subagentSessionId"
    );
    assert_eq!(chunk.result["success"], true);
    // Enriched call_id / status from `enrich_tool_result` still present.
    assert_eq!(chunk.result["call_id"], "toolu_test_task_v2");
    assert_eq!(chunk.result["status"], "completed");
}

#[test]
fn task_v2_with_missing_agent_id_does_not_crash() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble("task_v2", r#"{"description":"d","prompt":"p"}"#, r#"{}"#);
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "subagent");
    assert!(chunk.args.get("subagentSessionId").is_none());
    // success default still applied
    assert_eq!(chunk.result["success"], true);
}

#[test]
fn task_v2_with_non_string_agent_id_keeps_payload_intact() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "task_v2",
        r#"{"description":"d","prompt":"p"}"#,
        // Defensive: tomorrow's Cursor schema might wrap `agentId` in an
        // object. We must neither panic nor lose the data.
        r#"{"agentId":{"unexpected":"shape"}}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert!(chunk.args.get("subagentSessionId").is_none());
    assert!(chunk.result["agentId"].is_object());
}

// ----------------------------------------------------------------------------
// ask_question normalization
// ----------------------------------------------------------------------------

#[test]
fn ask_question_maps_to_ask_user_questions_and_resolves_answer_labels() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "ask_question",
        // Real Cursor wire shape — option ids referenced by the result.
        r#"{"questions":[{"id":"concern","prompt":"Pick a path:","options":[{"id":"trigger","label":"Refresh trigger"},{"id":"stale","label":"Force DB re-read"}]}]}"#,
        r#"{"answers":[{"questionId":"trigger"}]}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "ask_user_questions");
    // FE extractor reads `result.answers` as a `string[][]` — one row per
    // question, one entry per selected option.
    assert_eq!(
        chunk.result["answers"],
        serde_json::json!([["Refresh trigger"]])
    );
    // Without this, `resolveDisplayStatus` would tag the card as "skipped".
    assert_eq!(chunk.result["status"], "answered");
}

#[test]
fn ask_question_falls_back_to_option_id_when_label_missing() {
    let conn = empty_test_db();
    // No matching option in args → keep the raw id so the user still sees
    // *something* in the answered card.
    let bubble = make_tool_bubble(
        "ask_question",
        r#"{"questions":[{"id":"q","prompt":"P","options":[{"id":"other","label":"Other"}]}]}"#,
        r#"{"answers":[{"questionId":"missing"}]}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.result["answers"], serde_json::json!([["missing"]]));
}

#[test]
fn ask_question_without_answers_preserves_pending_status() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "ask_question",
        r#"{"questions":[{"id":"q","prompt":"P","options":[{"id":"a","label":"A"}]}]}"#,
        r#"{}"#,
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "ask_user_questions");
    // No `answers` ⇒ no rewrite, no synthetic `status: "answered"`. The
    // `enrich_tool_result` step still attaches Cursor's own `status` from
    // `toolFormerData.status` ("completed" in our fixture) — that's
    // expected and lets `resolveDisplayStatus` classify the card as
    // "skipped" (terminal but unanswered) rather than spinning forever.
    assert!(chunk.result.get("answers").is_none());
    assert_eq!(chunk.result["status"], "completed");
}

#[test]
fn ripgrep_pattern_passes_through_unchanged() {
    let conn = empty_test_db();
    let bubble = make_tool_bubble(
        "ripgrep_raw_search",
        r#"{"pattern":"foo_bar","caseInsensitive":false}"#,
        "{}",
    );
    let chunk = assistant_tool_bubble_to_chunk(&conn, TEST_SESSION_ID, &bubble).expect("chunk");
    assert_eq!(chunk.function, "grep");
    // ripgrep already uses `pattern` — don't double-translate.
    assert_eq!(chunk.args["pattern"], "foo_bar");
}

// ----------------------------------------------------------------------------
// Content blob loader
// ----------------------------------------------------------------------------

#[test]
fn load_content_blob_returns_text_when_present() {
    let conn = empty_test_db();
    insert_blob(&conn, "composer.content.abc", "file body\n");
    assert_eq!(
        load_content_blob(&conn, "composer.content.abc"),
        Some("file body\n".to_string())
    );
}

#[test]
fn load_content_blob_returns_none_for_missing_key() {
    let conn = empty_test_db();
    assert_eq!(load_content_blob(&conn, "composer.content.gone"), None);
}

#[test]
fn load_content_blob_rejects_unrelated_keys() {
    let conn = empty_test_db();
    insert_blob(&conn, "agentKv:something", "should not be returned");
    // Even if a non-content-prefix key exists, we refuse to dereference it.
    assert_eq!(load_content_blob(&conn, "agentKv:something"), None);
}

// Subagent composer filter has moved to `cursor_db.rs` (the shared cache
// pipeline filters subagents at write time). The serde-shape tests live in
// `cursor_db_tests.rs` next to `RawComposerData`.

// ----------------------------------------------------------------------------
// Lenient parsing
// ----------------------------------------------------------------------------

#[test]
fn raw_bubble_with_unknown_fields_still_parses() {
    let json = r#"{
        "type": 2,
        "bubbleId": "x",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "text": "hi",
        "someFutureField": { "nested": [1, 2, 3] },
        "anotherUnknownFlag": true
    }"#;
    let parsed: RawBubble = serde_json::from_str(json).expect("lenient parse");
    assert_eq!(parsed.bubble_type, 2);
    assert_eq!(parsed.text, "hi");
}

#[test]
fn monotonic_created_at_breaks_tied_turn_timestamps() {
    use core_types::activity::ActivityChunk;
    let make = |id: &str, ts: &str| {
        let mut chunk = ActivityChunk::new("cursoride-x", "raw", "user_message");
        chunk.chunk_id = id.to_string();
        chunk.created_at = ts.to_string();
        chunk
    };
    // A whole turn stamped identically (Cursor's quirk): user + two assistant
    // bubbles at the same instant, then a genuinely-later turn.
    let mut chunks = vec![
        make("cursoride-user-a", "2026-07-12T19:25:18.317Z"),
        make("cursoride-asst-b", "2026-07-12T19:25:18.317Z"),
        make("cursoride-asst-c", "2026-07-12T19:25:18.317Z"),
        make("cursoride-asst-d", "2026-07-12T19:25:30.950Z"),
    ];
    enforce_monotonic_created_at(&mut chunks);

    let times: Vec<i64> = chunks
        .iter()
        .map(|chunk| parse_iso_to_epoch_ms(&chunk.created_at))
        .collect();
    // Strictly increasing → any downstream (created_at, id) sort keeps the
    // user bubble first even though "asst" < "user".
    assert!(
        times.windows(2).all(|pair| pair[0] < pair[1]),
        "not strictly increasing: {times:?}"
    );
    // Ties are nudged by ms; the real later turn is not dragged backwards.
    assert_eq!(times[3], parse_iso_to_epoch_ms("2026-07-12T19:25:30.950Z"));
    assert!(times[3] - times[0] > 12_000);
}
