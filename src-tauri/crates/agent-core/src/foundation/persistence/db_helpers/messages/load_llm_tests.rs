use super::*;
use database::db::get_connection;
use test_helpers::test_env;

const DB_PREFIX: &str = "llm_history_test";
const DB_SESSION: &str = "llm-history-session";

fn create_message_table(prefix: &str) {
    let conn = get_connection().expect("get_connection in create_message_table");
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {prefix}_messages (
                id           TEXT PRIMARY KEY,
                session_id   TEXT NOT NULL,
                role         TEXT NOT NULL,
                content      TEXT NOT NULL DEFAULT '',
                tool_name    TEXT,
                tool_call_id TEXT,
                tool_input   TEXT,
                tool_output  TEXT,
                model        TEXT,
                sequence     INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL,
                images       TEXT,
                compact_from_sequence INTEGER,
                compact_tokens_before INTEGER,
                compact_tokens_after INTEGER
             );"
    ))
    .expect("create message table");
}

fn insert_text_message(prefix: &str, session_id: &str, role: &str, content: &str, sequence: i64) {
    let conn = get_connection().expect("get_connection in insert_text_message");
    conn.execute(
        &format!(
            "INSERT INTO {prefix}_messages
                 (id, session_id, role, content, sequence, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ),
        rusqlite::params![
            format!("msg-{sequence}"),
            session_id,
            role,
            content,
            sequence,
            "2024-01-01T00:00:00Z",
        ],
    )
    .expect("insert text message");
}

#[test]
fn load_llm_history_empty_table_returns_ok_empty() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);

    let history = load_llm_history(DB_PREFIX, DB_SESSION).expect("empty history should load");
    assert!(history.is_empty());
}

#[test]
fn load_llm_history_reconstructs_db_rows() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    insert_text_message(DB_PREFIX, DB_SESSION, message_role::USER, "Hello", 1);
    insert_text_message(DB_PREFIX, DB_SESSION, message_role::ASSISTANT, "Hi", 2);

    let history = load_llm_history(DB_PREFIX, DB_SESSION).expect("history should load");
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["role"], message_role::USER);
    assert_eq!(history[0]["content"], "Hello");
    assert_eq!(history[1]["role"], message_role::ASSISTANT);
    assert_eq!(history[1]["content"], "Hi");
}

#[test]
fn reconstruct_preserves_persisted_compact_summary_system_rows() {
    let history = reconstruct_llm_history(vec![
        make_system_msg(1, "Previous conversation summary: compacted old turns"),
        make_user_msg(2, "recent follow-up"),
        make_assistant_msg(3, "recent answer"),
    ]);

    assert_eq!(history.len(), 3);
    assert_eq!(history[0]["role"], message_role::SYSTEM);
    assert_eq!(
        history[0]["content"],
        "Previous conversation summary: compacted old turns"
    );
    assert_eq!(history[1]["content"], "recent follow-up");
    assert_eq!(history[2]["content"], "recent answer");
}

#[test]
fn text_only_history_does_not_hydrate_images() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    let conn = get_connection().expect("get connection");
    conn.execute(
        &format!(
            "INSERT INTO {DB_PREFIX}_messages
                 (id, session_id, role, content, sequence, created_at, images)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        ),
        rusqlite::params![
            "image-msg",
            DB_SESSION,
            message_role::USER,
            "inspect this",
            1,
            "2024-01-01T00:00:00Z",
            serde_json::to_string(&vec!["data:image/png;base64,AAAA"]).unwrap(),
        ],
    )
    .expect("insert image row");

    let (history, start_seqs) =
        load_llm_history_text_only(DB_PREFIX, DB_SESSION).expect("text history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["content"], "inspect this");
    assert!(history[0]["content"].is_string());
    assert_eq!(start_seqs, vec![1], "start sequences mirror the messages");
}

#[test]
fn bounded_text_only_load_returns_full_history_under_budget() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    let sid = "bounded-under-budget";
    insert_text_message(DB_PREFIX, sid, message_role::USER, "hello", 0);
    insert_text_message(DB_PREFIX, sid, message_role::ASSISTANT, "hi", 1);
    insert_text_message(DB_PREFIX, sid, message_role::USER, "more", 2);

    let full = load_llm_history_text_only(DB_PREFIX, sid).expect("full load");
    let bounded =
        load_llm_history_text_only_bounded(DB_PREFIX, sid, 1024 * 1024).expect("bounded load");
    assert_eq!(bounded, full);
}

#[test]
fn bounded_text_only_load_stops_before_full_history() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    let sid = "bounded-oversized";
    for seq in 0..40_i64 {
        let role = if seq % 2 == 0 {
            message_role::USER
        } else {
            message_role::ASSISTANT
        };
        insert_text_message(DB_PREFIX, sid, role, &"x".repeat(1024), seq);
    }

    let max_bytes = 4 * 1024;
    let (full, full_seqs) = load_llm_history_text_only(DB_PREFIX, sid).expect("full load");
    let (bounded, bounded_seqs) =
        load_llm_history_text_only_bounded(DB_PREFIX, sid, max_bytes).expect("bounded load");

    assert!(
        bounded.len() < full.len(),
        "oversized transcript must not be fully materialized"
    );
    assert_eq!(bounded[..], full[full.len() - bounded.len()..]);
    assert_eq!(
        bounded_seqs[..],
        full_seqs[full_seqs.len() - bounded_seqs.len()..]
    );

    let serialized: usize = bounded
        .iter()
        .map(|message| serde_json::to_vec(message).map_or(0, |encoded| encoded.len()))
        .sum();
    assert!(
        serialized > max_bytes,
        "suffix must cover the budget plus the first rejected message"
    );
}

#[test]
fn bounded_text_only_load_keeps_summary_when_window_fits() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    let sid = "bounded-boundary";
    insert_text_message(DB_PREFIX, sid, message_role::USER, "old", 0);
    insert_text_message(DB_PREFIX, sid, message_role::USER, "recent", 1);
    let conn = get_connection().expect("conn");
    conn.execute(
        &format!(
            "INSERT INTO {DB_PREFIX}_messages
                 (id, session_id, role, content, sequence, created_at, compact_from_sequence)
                 VALUES ('b-1', ?1, 'system', 'summary', 2, '2024-01-02T00:00:00Z', 1)"
        ),
        [sid],
    )
    .expect("insert boundary row");

    let full = load_llm_history_text_only(DB_PREFIX, sid).expect("full load");
    let bounded =
        load_llm_history_text_only_bounded(DB_PREFIX, sid, 1024 * 1024).expect("bounded load");
    assert_eq!(bounded, full);
    assert_eq!(bounded.0.len(), 2);
    assert_eq!(bounded.0[0]["role"], "user");
    assert_eq!(bounded.0[0]["content"], "summary");
}

#[test]
fn load_llm_history_missing_table_returns_err() {
    let _sandbox = test_env::sandbox();

    let err = load_llm_history("missing_llm_history", DB_SESSION)
        .expect_err("missing table must be surfaced");
    let err_text = err.to_string();
    assert!(
        err_text.contains("missing_llm_history_messages") || err_text.contains("no such table"),
        "got: {}",
        err_text
    );
}

/// Test helper: reconstruct LLM history without hitting the DB. Just
/// a thin alias over `super::reconstruct` for readability.
fn reconstruct_llm_history(messages: Vec<AgentMessageRow>) -> Vec<serde_json::Value> {
    reconstruct(&messages)
}

fn make_system_msg(seq: i64, content: &str) -> AgentMessageRow {
    AgentMessageRow {
        id: format!("msg-{}", seq),
        session_id: "test-session".to_string(),
        role: message_role::SYSTEM.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: seq,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

fn make_user_msg(seq: i64, content: &str) -> AgentMessageRow {
    AgentMessageRow {
        id: format!("msg-{}", seq),
        session_id: "test-session".to_string(),
        role: message_role::USER.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: seq,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

fn make_assistant_msg(seq: i64, content: &str) -> AgentMessageRow {
    AgentMessageRow {
        id: format!("msg-{}", seq),
        session_id: "test-session".to_string(),
        role: message_role::ASSISTANT.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: Some("test-model".to_string()),
        sequence: seq,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

fn make_tool_call(seq: i64, call_id: &str, name: &str, args: &str) -> AgentMessageRow {
    AgentMessageRow {
        id: format!("msg-{}", seq),
        session_id: "test-session".to_string(),
        role: message_role::TOOL_CALL.to_string(),
        content: format!("Tool call: {}", name),
        tool_name: Some(name.to_string()),
        tool_call_id: Some(call_id.to_string()),
        tool_input: Some(args.to_string()),
        tool_output: None,
        model: None,
        sequence: seq,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

fn make_tool_result(seq: i64, call_id: &str, name: &str, result: &str) -> AgentMessageRow {
    AgentMessageRow {
        id: format!("msg-{}", seq),
        session_id: "test-session".to_string(),
        role: message_role::TOOL_RESULT.to_string(),
        content: result.to_string(),
        tool_name: Some(name.to_string()),
        tool_call_id: Some(call_id.to_string()),
        tool_input: None,
        tool_output: Some(result.to_string()),
        model: None,
        sequence: seq,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

/// Test case 1: Parallel execution (all tool_calls first, then all tool_results)
/// DB order: tool_call:0, tool_call:1, tool_call:2, tool_result:0, tool_result:1, tool_result:2
/// Expected LLM format:
///   assistant: { tool_calls: [0, 1, 2] }
///   tool: { tool_call_id: 0 }
///   tool: { tool_call_id: 1 }
///   tool: { tool_call_id: 2 }
#[test]
fn test_parallel_tool_execution() {
    let messages = vec![
        make_user_msg(1, "Hello"),
        make_tool_call(2, "list_dir:0", "list_dir", r#"{"path":"/"}"#),
        make_tool_call(3, "read_file:1", "read_file", r#"{"path":"/a.txt"}"#),
        make_tool_call(4, "read_file:2", "read_file", r#"{"path":"/b.txt"}"#),
        make_tool_result(5, "list_dir:0", "list_dir", "file1\nfile2"),
        make_tool_result(6, "read_file:1", "read_file", "content of a"),
        make_tool_result(7, "read_file:2", "read_file", "content of b"),
    ];

    let history = reconstruct_llm_history(messages);

    assert_eq!(history.len(), 5, "Expected 5 messages in history");
    assert_eq!(history[0]["role"], "user");
    assert_eq!(history[1]["role"], "assistant");

    let tool_calls = history[1]["tool_calls"].as_array().unwrap();
    assert_eq!(
        tool_calls.len(),
        3,
        "Expected 3 tool_calls in one assistant message"
    );
    assert_eq!(tool_calls[0]["id"], "list_dir:0");
    assert_eq!(tool_calls[1]["id"], "read_file:1");
    assert_eq!(tool_calls[2]["id"], "read_file:2");

    assert_eq!(history[2]["role"], "tool");
    assert_eq!(history[2]["tool_call_id"], "list_dir:0");
    assert_eq!(history[3]["role"], "tool");
    assert_eq!(history[3]["tool_call_id"], "read_file:1");
    assert_eq!(history[4]["role"], "tool");
    assert_eq!(history[4]["tool_call_id"], "read_file:2");
}

/// Test case 2: Serial execution (interleaved tool_call and tool_result)
/// DB order: tool_call:0, tool_result:0, tool_call:1, tool_result:1
/// Expected: Same as parallel - all tool_calls merged into one assistant message
#[test]
fn test_serial_tool_execution() {
    let messages = vec![
        make_user_msg(1, "Hello"),
        make_tool_call(2, "list_dir:0", "list_dir", r#"{"path":"/"}"#),
        make_tool_result(3, "list_dir:0", "list_dir", "file1\nfile2"),
        make_tool_call(4, "read_file:1", "read_file", r#"{"path":"/a.txt"}"#),
        make_tool_result(5, "read_file:1", "read_file", "content of a"),
    ];

    let history = reconstruct_llm_history(messages);

    assert_eq!(history.len(), 4, "Expected 4 messages in history");
    assert_eq!(history[0]["role"], "user");
    assert_eq!(history[1]["role"], "assistant");

    let tool_calls = history[1]["tool_calls"].as_array().unwrap();
    assert_eq!(
        tool_calls.len(),
        2,
        "Expected 2 tool_calls merged into one assistant message"
    );
    assert_eq!(tool_calls[0]["id"], "list_dir:0");
    assert_eq!(tool_calls[1]["id"], "read_file:1");

    assert_eq!(history[2]["tool_call_id"], "list_dir:0");
    assert_eq!(history[3]["tool_call_id"], "read_file:1");
}

/// Test case 3: Multiple turns with tool calls
/// Turn 1: user -> tool_calls -> tool_results -> assistant
/// Turn 2: user -> tool_calls -> tool_results
#[test]
fn test_multiple_turns() {
    let messages = vec![
        make_user_msg(1, "Hello"),
        make_tool_call(2, "list_dir:0", "list_dir", r#"{"path":"/"}"#),
        make_tool_result(3, "list_dir:0", "list_dir", "file1"),
        make_assistant_msg(4, "I found file1"),
        make_user_msg(5, "Read it"),
        make_tool_call(6, "read_file:1", "read_file", r#"{"path":"/file1"}"#),
        make_tool_result(7, "read_file:1", "read_file", "content"),
    ];

    let history = reconstruct_llm_history(messages);

    assert_eq!(history.len(), 7, "Expected 7 messages");
    assert_eq!(history[0]["role"], "user");
    assert_eq!(history[1]["role"], "assistant");
    assert!(history[1]["tool_calls"].is_array());
    assert_eq!(history[2]["role"], "tool");
    assert_eq!(history[3]["role"], "assistant");
    assert_eq!(history[3]["content"], "I found file1");
    assert_eq!(history[4]["role"], "user");
    assert_eq!(history[5]["role"], "assistant");
    assert!(history[5]["tool_calls"].is_array());
    assert_eq!(history[6]["role"], "tool");
}

/// Test case 4: Simple conversation without tools
#[test]
fn test_no_tools() {
    let messages = vec![
        make_user_msg(1, "Hello"),
        make_assistant_msg(2, "Hi there!"),
        make_user_msg(3, "How are you?"),
        make_assistant_msg(4, "I'm doing well!"),
    ];

    let history = reconstruct_llm_history(messages);

    assert_eq!(history.len(), 4);
    assert_eq!(history[0]["content"], "Hello");
    assert_eq!(history[1]["content"], "Hi there!");
    assert_eq!(history[2]["content"], "How are you?");
    assert_eq!(history[3]["content"], "I'm doing well!");
}

/// Test case 5: Tool calls at the end (no tool results yet - streaming interrupted)
#[test]
fn test_pending_tool_calls() {
    let messages = vec![
        make_user_msg(1, "Hello"),
        make_tool_call(2, "list_dir:0", "list_dir", r#"{"path":"/"}"#),
        make_tool_call(3, "read_file:1", "read_file", r#"{"path":"/a.txt"}"#),
    ];

    let history = reconstruct_llm_history(messages);

    assert_eq!(
        history.len(),
        2,
        "Expected 2 messages (user + assistant with tool_calls)"
    );
    assert_eq!(history[0]["role"], "user");
    assert_eq!(history[1]["role"], "assistant");

    let tool_calls = history[1]["tool_calls"].as_array().unwrap();
    assert_eq!(tool_calls.len(), 2);
}

/// Verify that each tool_call_id in tool_calls has a matching tool message
fn validate_tool_call_result_pairing(history: &[serde_json::Value]) -> Result<(), String> {
    for (idx, msg) in history.iter().enumerate() {
        if msg["role"] == "assistant" && msg.get("tool_calls").is_some() {
            let tool_calls = msg["tool_calls"].as_array().unwrap();
            let tool_call_ids: Vec<&str> = tool_calls
                .iter()
                .map(|tc| tc["id"].as_str().unwrap())
                .collect();

            let mut found_tool_ids: Vec<&str> = Vec::new();
            for following_msg in history.iter().skip(idx + 1) {
                if following_msg["role"] == "tool" {
                    if let Some(id) = following_msg["tool_call_id"].as_str() {
                        found_tool_ids.push(id);
                    }
                } else if following_msg["role"] == "assistant" || following_msg["role"] == "user" {
                    break;
                }
            }

            for tc_id in &tool_call_ids {
                if !found_tool_ids.contains(tc_id) {
                    return Err(format!(
                        "tool_call_id '{}' has no matching tool message",
                        tc_id
                    ));
                }
            }
        }
    }
    Ok(())
}

#[test]
fn test_tool_call_result_pairing_valid() {
    let messages = vec![
        make_user_msg(1, "Hello"),
        make_tool_call(2, "list_dir:0", "list_dir", r#"{"path":"/"}"#),
        make_tool_call(3, "read_file:1", "read_file", r#"{"path":"/a.txt"}"#),
        make_tool_result(4, "list_dir:0", "list_dir", "file1"),
        make_tool_result(5, "read_file:1", "read_file", "content"),
    ];

    let history = reconstruct_llm_history(messages);
    assert!(
        validate_tool_call_result_pairing(&history).is_ok(),
        "Tool call/result pairing should be valid"
    );
}

fn make_boundary_msg(seq: i64, content: &str, from_sequence: i64) -> AgentMessageRow {
    let mut msg = make_system_msg(seq, content);
    msg.compact_from_sequence = Some(from_sequence);
    msg
}

#[test]
fn visible_rows_without_boundary_passes_all_rows_through() {
    let rows = vec![make_user_msg(0, "u1"), make_assistant_msg(1, "a1")];
    let visible = visible_rows(&rows);
    assert_eq!(visible.len(), 2);
    assert_eq!(visible[0].content, "u1");
}

#[test]
fn visible_rows_latest_boundary_hides_older_rows() {
    let rows = vec![
        make_user_msg(0, "old user"),
        make_assistant_msg(1, "old assistant"),
        make_user_msg(2, "recent user"),
        make_assistant_msg(3, "recent assistant"),
        make_boundary_msg(4, "summary", 2),
    ];
    let visible = visible_rows(&rows);
    assert_eq!(visible.len(), 3);
    assert_eq!(visible[0].content, "summary");
    assert_eq!(visible[1].content, "recent user");
    assert_eq!(visible[2].content, "recent assistant");
}

#[test]
fn visible_rows_second_boundary_wins_and_older_boundary_is_skipped() {
    let rows = vec![
        make_user_msg(0, "u1"),
        make_user_msg(1, "u2"),
        make_boundary_msg(2, "first summary", 1),
        make_user_msg(3, "u3"),
        make_boundary_msg(4, "second summary", 3),
    ];
    let visible = visible_rows(&rows);
    assert_eq!(visible.len(), 2);
    assert_eq!(visible[0].content, "second summary");
    assert_eq!(visible[1].content, "u3");
}

#[test]
fn start_sequences_match_reconstruct_len() {
    let rows = vec![
        make_user_msg(0, "Hello"),
        make_tool_call(1, "list_dir:0", "list_dir", r#"{"path":"/"}"#),
        make_tool_call(2, "read_file:1", "read_file", r#"{"path":"/a"}"#),
        make_tool_result(3, "list_dir:0", "list_dir", "f1"),
        make_tool_result(4, "read_file:1", "read_file", "c"),
        make_assistant_msg(5, "done"),
        make_user_msg(6, "next"),
    ];
    let refs: Vec<&AgentMessageRow> = rows.iter().collect();
    let starts = llm_message_start_sequences(&refs);
    let history = reconstruct(&rows);
    assert_eq!(
        starts.len(),
        history.len(),
        "start-sequence mapping must mirror reconstruct grouping"
    );
    // user(0), assistant tool_calls(1), tool(1), tool(1), assistant(5), user(6)
    assert_eq!(starts, vec![0, 1, 1, 1, 5, 6]);
}

#[test]
fn compact_cutoff_sequence_maps_tail_len_onto_durable_sequence() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    let sid = "cutoff-session";
    insert_text_message(DB_PREFIX, sid, message_role::USER, "u1", 0);
    insert_text_message(DB_PREFIX, sid, message_role::ASSISTANT, "a1", 1);
    insert_text_message(DB_PREFIX, sid, message_role::USER, "u2", 2);
    insert_text_message(DB_PREFIX, sid, message_role::ASSISTANT, "a2", 3);

    // Keep last 2 LLM messages -> cutoff at sequence 2.
    assert_eq!(
        compact_cutoff_sequence(DB_PREFIX, sid, 2).expect("cutoff"),
        2
    );
    // tail_len covering everything degrades to window start.
    assert_eq!(
        compact_cutoff_sequence(DB_PREFIX, sid, 10).expect("cutoff"),
        0
    );
    // tail_len 0 hides the entire window.
    assert_eq!(
        compact_cutoff_sequence(DB_PREFIX, sid, 0).expect("cutoff"),
        4
    );
}

#[test]
fn load_llm_history_applies_compact_boundary_from_db() {
    let _sandbox = test_env::sandbox();
    create_message_table(DB_PREFIX);
    let sid = "boundary-db-session";
    insert_text_message(DB_PREFIX, sid, message_role::USER, "old", 0);
    insert_text_message(DB_PREFIX, sid, message_role::USER, "recent", 1);
    let conn = get_connection().expect("conn");
    conn.execute(
        &format!(
            "INSERT INTO {DB_PREFIX}_messages
                 (id, session_id, role, content, sequence, created_at, compact_from_sequence)
                 VALUES ('b-1', ?1, 'system', 'summary', 2, '2024-01-02T00:00:00Z', 1)"
        ),
        [sid],
    )
    .expect("insert boundary row");

    let history = load_llm_history(DB_PREFIX, sid).expect("load");
    assert_eq!(history.len(), 2);
    // Stored as `system`, rendered as `user` in the LLM view.
    assert_eq!(history[0]["role"], "user");
    assert_eq!(history[0]["content"], "summary");
    assert_eq!(history[1]["content"], "recent");
}
