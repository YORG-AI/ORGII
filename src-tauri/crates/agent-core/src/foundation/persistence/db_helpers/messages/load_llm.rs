//! `load_llm_history`: rebuild OpenAI-format conversation history from the
//! `<prefix>_messages` table.
//!
//! Two non-trivial pieces of logic live here:
//!
//! 1. Multimodal user messages (text + image URLs) are reconstructed
//!    from the `images` column, with on-disk image refs lazily loaded
//!    back into `data:` URLs via `resolve_image_for_llm`.
//! 2. Consecutive `tool_call` rows are merged into one assistant
//!    message with a multi-element `tool_calls` array, followed by the
//!    matching `tool` rows. This matches the wire format that LLM APIs
//!    accept and that yoyo evolved to after dogfooding both serial and
//!    parallel tool execution.

use crate::persistence::images;

use super::super::{load_messages, message_role, AgentMessageRow};

/// Resolve an image reference to a base64 data URL for LLM consumption.
///
/// Handles both legacy base64 data URLs (returned as-is) and disk file paths
/// (read from disk and encoded).
fn resolve_image_for_llm(image_ref: &str) -> Option<String> {
    if image_ref.starts_with("data:") {
        Some(image_ref.to_string())
    } else {
        images::load_image_as_data_url(image_ref)
    }
}

/// Build multimodal content for a user message with images.
///
/// Returns an OpenAI-compatible content array:
/// `[{ "type": "image_url", ... }, ..., { "type": "text", "text": "..." }]`
fn build_multimodal_content(text: &str, image_refs: &[String]) -> serde_json::Value {
    tracing::info!(
        "[build_multimodal_content] building content with {} image_ref(s)",
        image_refs.len()
    );
    let mut parts: Vec<serde_json::Value> = image_refs
        .iter()
        .enumerate()
        .filter_map(|(i, img_ref)| {
            let resolved = resolve_image_for_llm(img_ref);
            if resolved.is_none() {
                tracing::warn!(
                    "[build_multimodal_content] image_refs[{}] failed to resolve (ref prefix: {})",
                    i,
                    img_ref.get(..60).unwrap_or(img_ref)
                );
            } else {
                tracing::info!("[build_multimodal_content] image_refs[{}] resolved OK", i);
            }
            resolved.map(|data_url| {
                serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": data_url }
                })
            })
        })
        .collect();

    parts.push(serde_json::json!({ "type": "text", "text": text }));
    serde_json::Value::Array(parts)
}

/// Load conversation history in the format expected by LLM providers.
///
/// Returns messages in OpenAI-compatible format including tool calls:
/// - `user` messages (with optional multimodal content)
/// - `assistant` messages (text or tool_calls)
/// - `tool` messages (tool results)
///
/// Tool calls persisted as separate DB rows are reconstructed into
/// assistant messages with `tool_calls` arrays + matching `tool` messages.
///
/// IMPORTANT: Consecutive tool_call rows are merged into a single assistant
/// message with multiple tool_calls, followed by their corresponding tool results.
/// This matches the LLM API format where one assistant turn can have multiple
/// tool calls, each requiring a matching tool result message.
///
/// **Compact boundaries:** when the session contains compaction boundary
/// rows (`compact_from_sequence IS NOT NULL`), the latest boundary wins:
/// the returned history is `[boundary summary] + reconstruct(rows with
/// sequence >= boundary.compact_from_sequence)`. Rows before that pointer
/// and older boundary rows stay in the table untouched (immutable
/// transcript) but are excluded from the LLM view.
pub fn load_llm_history(
    prefix: &str,
    session_id: &str,
) -> rusqlite::Result<Vec<serde_json::Value>> {
    let messages = load_messages(prefix, session_id)?;

    // Debug: log raw message sequence
    tracing::debug!(
        "[load_llm_history] session={} raw_messages: {:?}",
        session_id,
        messages
            .iter()
            .map(|m| format!("{}:{}", m.role, m.tool_call_id.as_deref().unwrap_or("-")))
            .collect::<Vec<_>>()
    );

    let result = reconstruct(&visible_rows(&messages));

    // Debug: log reconstructed message summary
    tracing::debug!(
        "[load_llm_history] session={} reconstructed: {:?}",
        session_id,
        result
            .iter()
            .map(|m| {
                let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("?");
                let tc_count = m
                    .get("tool_calls")
                    .and_then(|tc| tc.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let tc_id = m
                    .get("tool_call_id")
                    .and_then(|id| id.as_str())
                    .unwrap_or("-");
                if tc_count > 0 {
                    format!("{}(tool_calls={})", role, tc_count)
                } else if tc_id != "-" {
                    format!("{}({})", role, tc_id)
                } else {
                    role.to_string()
                }
            })
            .collect::<Vec<_>>()
    );

    Ok(result)
}

/// Sequence of the first row contributing to each reconstructed LLM
/// message, in output order. Mirrors the grouping rules of
/// [`reconstruct`] (consecutive tool_call/tool_result rows form one
/// assistant message followed by its tool messages, all attributed to
/// the group's first row). Must stay in sync with `reconstruct`; the
/// `start_sequences_match_reconstruct_len` test pins that.
fn llm_message_start_sequences(messages: &[&AgentMessageRow]) -> Vec<i64> {
    let mut result: Vec<i64> = Vec::new();
    let mut pending_calls = 0usize;
    let mut pending_results = 0usize;
    let mut group_start: Option<i64> = None;

    fn flush(
        result: &mut Vec<i64>,
        pending_calls: &mut usize,
        pending_results: &mut usize,
        group_start: &mut Option<i64>,
    ) {
        if let Some(seq) = *group_start {
            if *pending_calls > 0 {
                result.push(seq);
            }
            for _ in 0..*pending_results {
                result.push(seq);
            }
        }
        *pending_calls = 0;
        *pending_results = 0;
        *group_start = None;
    }

    for msg in messages {
        match msg.role.as_str() {
            message_role::SYSTEM | message_role::USER | message_role::ASSISTANT => {
                flush(
                    &mut result,
                    &mut pending_calls,
                    &mut pending_results,
                    &mut group_start,
                );
                result.push(msg.sequence);
            }
            message_role::TOOL_CALL => {
                group_start.get_or_insert(msg.sequence);
                pending_calls += 1;
            }
            message_role::TOOL_RESULT => {
                group_start.get_or_insert(msg.sequence);
                pending_results += 1;
            }
            _ => {}
        }
    }
    flush(
        &mut result,
        &mut pending_calls,
        &mut pending_results,
        &mut group_start,
    );

    result
}

/// Map "the last `tail_len` LLM messages stay visible" onto a durable
/// sequence cutoff for a new compact boundary.
///
/// Operates on the current visible window (after the latest existing
/// boundary, if any). Conservative by construction: when `tail_len`
/// covers the whole window (or in-memory/durable views have drifted),
/// the cutoff falls back to the window start, which keeps *more* context
/// visible rather than hiding unsummarized rows. Never deletes anything.
pub fn compact_cutoff_sequence(
    prefix: &str,
    session_id: &str,
    tail_len: usize,
) -> rusqlite::Result<i64> {
    let rows = load_messages(prefix, session_id)?;

    let latest_boundary = rows
        .iter()
        .filter(|m| m.compact_from_sequence.is_some())
        .max_by_key(|m| m.sequence);

    let window_start = match latest_boundary {
        Some(boundary) => boundary
            .compact_from_sequence
            .expect("filtered on is_some above"),
        None => rows.first().map(|m| m.sequence).unwrap_or(0),
    };
    let tail_rows: Vec<&AgentMessageRow> = rows
        .iter()
        .filter(|m| m.compact_from_sequence.is_none() && m.sequence >= window_start)
        .collect();

    if tail_len == 0 {
        // Hide the entire window behind the summary.
        return Ok(tail_rows
            .last()
            .map(|m| m.sequence + 1)
            .unwrap_or(window_start));
    }

    let starts = llm_message_start_sequences(&tail_rows);
    if tail_len >= starts.len() {
        return Ok(window_start);
    }
    Ok(starts[starts.len() - tail_len])
}

/// Apply the latest compact boundary to the raw row list.
///
/// Returns the rows that form the current LLM view: when a boundary row
/// (`compact_from_sequence IS NOT NULL`) exists, the view is the boundary
/// row itself (rendered as a system summary) followed by every
/// non-boundary row with `sequence >= compact_from_sequence`. Without a
/// boundary, all rows pass through unchanged. Boundary rows other than
/// the latest are always skipped.
fn visible_rows(messages: &[AgentMessageRow]) -> Vec<AgentMessageRow> {
    let latest_boundary = messages
        .iter()
        .filter(|m| m.compact_from_sequence.is_some())
        .max_by_key(|m| m.sequence);

    let Some(boundary) = latest_boundary else {
        return messages.to_vec();
    };
    let from_sequence = boundary
        .compact_from_sequence
        .expect("filtered on is_some above");

    let mut visible = Vec::with_capacity(messages.len());
    visible.push(boundary.clone());
    visible.extend(
        messages
            .iter()
            .filter(|m| m.compact_from_sequence.is_none() && m.sequence >= from_sequence)
            .cloned(),
    );
    visible
}

/// Pure reconstruction step: turn an ordered slice of `AgentMessageRow` rows
/// into the OpenAI-compatible JSON array. Lifted out of
/// `load_llm_history` so the unit tests below can exercise it without a
/// SQLite round-trip.
fn reconstruct(messages: &[AgentMessageRow]) -> Vec<serde_json::Value> {
    let mut result: Vec<serde_json::Value> = Vec::with_capacity(messages.len());

    // Collect consecutive tool_calls into batches
    let mut pending_tool_calls: Vec<serde_json::Value> = Vec::new();
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();

    // Helper to flush pending tool calls and results
    let flush_pending = |result: &mut Vec<serde_json::Value>,
                         tool_calls: &mut Vec<serde_json::Value>,
                         tool_results: &mut Vec<serde_json::Value>| {
        if !tool_calls.is_empty() {
            result.push(serde_json::json!({
                "role": message_role::ASSISTANT,
                "content": serde_json::Value::Null,
                "tool_calls": tool_calls.clone()
            }));
            tool_calls.clear();
        }
        result.append(tool_results);
    };

    // Avoid resending every historical image on every turn: base64 image
    // payloads are large and can exceed gateway/body limits quickly. Preserve
    // multimodal content for the most recent image-bearing user message, and
    // render older image messages as text-only history.
    let last_image_msg_index = messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(idx, msg)| {
            if msg.role == message_role::USER
                && msg
                    .images
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    .map(|refs| !refs.is_empty())
                    .unwrap_or(false)
            {
                Some(idx)
            } else {
                None
            }
        });

    for (msg_idx, msg) in messages.iter().enumerate() {
        match msg.role.as_str() {
            message_role::SYSTEM => {
                flush_pending(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut pending_tool_results,
                );
                result.push(serde_json::json!({
                    "role": message_role::SYSTEM,
                    "content": msg.content,
                }));
            }
            message_role::USER => {
                flush_pending(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut pending_tool_results,
                );

                if last_image_msg_index == Some(msg_idx) {
                    if let Some(images_json) = &msg.images {
                        if let Ok(image_refs) = serde_json::from_str::<Vec<String>>(images_json) {
                            if !image_refs.is_empty() {
                            result.push(serde_json::json!({
                                "role": message_role::USER,
                                "content": build_multimodal_content(&msg.content, &image_refs),
                            }));
                            continue;
                        }
                    }
                }
                }
                result.push(serde_json::json!({
                    "role": message_role::USER,
                    "content": msg.content,
                }));
            }
            message_role::ASSISTANT => {
                flush_pending(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut pending_tool_results,
                );

                result.push(serde_json::json!({
                    "role": message_role::ASSISTANT,
                    "content": msg.content,
                }));
            }
            message_role::TOOL_CALL => {
                let tool_call_id = msg.tool_call_id.as_deref().unwrap_or("unknown");
                let tool_name = msg.tool_name.as_deref().unwrap_or("unknown");
                let arguments = msg.tool_input.as_deref().unwrap_or("{}");

                pending_tool_calls.push(serde_json::json!({
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": arguments,
                    }
                }));
            }
            message_role::TOOL_RESULT => {
                let tool_call_id = msg.tool_call_id.as_deref().unwrap_or("unknown");
                let content = msg.tool_output.as_deref().unwrap_or(&msg.content);

                pending_tool_results.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content,
                }));
            }
            _ => {}
        }
    }

    flush_pending(
        &mut result,
        &mut pending_tool_calls,
        &mut pending_tool_results,
    );

    result
}

#[cfg(test)]
mod tests {
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
                compact_from_sequence INTEGER
             );"
        ))
        .expect("create message table");
    }

    fn insert_text_message(
        prefix: &str,
        session_id: &str,
        role: &str,
        content: &str,
        sequence: i64,
    ) {
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
                    } else if following_msg["role"] == "assistant"
                        || following_msg["role"] == "user"
                    {
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
        assert_eq!(history[0]["role"], "system");
        assert_eq!(history[0]["content"], "summary");
        assert_eq!(history[1]["content"], "recent");
    }
}
