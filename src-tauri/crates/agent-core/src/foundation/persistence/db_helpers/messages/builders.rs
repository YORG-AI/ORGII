//! Typed convenience builders that wrap [`super::super::insert_message_retry`].
//!
//! Each helper composes an `AgentMessageRow` with the right role + tool-call
//! plumbing for one of the four canonical message kinds. They are the
//! sole writers used by the agent loop and persistence layer; ad-hoc
//! callers should not hand-roll `AgentMessageRow` literals.

use chrono::Utc;
use rusqlite::Result as SqliteResult;
use uuid::Uuid;

use crate::persistence::images;

use super::super::{insert_message_retry, message_role, AgentMessageRow};

pub fn save_system_msg(prefix: &str, session_id: &str, content: &str) -> SqliteResult<String> {
    let msg = AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: message_role::SYSTEM.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: 0,
        created_at: Utc::now().to_rfc3339(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    };
    insert_message_retry(prefix, &msg)
}

/// Save a compact-boundary row: a `system` summary whose
/// `compact_from_sequence` points at the first surviving tail row.
/// Appended like any other message (sequence assigned by
/// `insert_message_retry`); never rewrites or deletes prior rows.
pub fn save_compact_boundary_msg(
    prefix: &str,
    session_id: &str,
    summary: &str,
    from_sequence: i64,
    tokens_before: Option<i64>,
    tokens_after: Option<i64>,
) -> SqliteResult<(String, String)> {
    let created_at = Utc::now().to_rfc3339();
    let msg = AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: message_role::SYSTEM.to_string(),
        content: summary.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: 0,
        created_at: created_at.clone(),
        images: None,
        compact_from_sequence: Some(from_sequence),
        compact_tokens_before: tokens_before,
        compact_tokens_after: tokens_after,
    };
    let id = insert_message_retry(prefix, &msg)?;
    Ok((id, created_at))
}

/// Save a user message, optionally with images.
///
/// Accepts base64 data URLs, persists them to disk via content-hash dedup,
/// and stores the resulting file paths as a JSON array in the `images` column.
pub fn save_user_msg(
    prefix: &str,
    session_id: &str,
    content: &str,
    images: Option<&[String]>,
) -> SqliteResult<String> {
    let images_json = images.filter(|imgs| !imgs.is_empty()).map(|imgs| {
        let file_paths = images::persist_images(imgs);
        // Both branches serialize a `Vec<String>` / `&[String]`, which is
        // infallible. Using `expect` keeps the invariant load-bearing: any
        // future schema change that breaks it must fix this site, not silently
        // store an empty string and orphan the user's image attachments.
        if file_paths.is_empty() {
            serde_json::to_string(imgs).expect("Vec<String> serialization is infallible")
        } else {
            serde_json::to_string(&file_paths).expect("Vec<String> serialization is infallible")
        }
    });
    let msg = AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: message_role::USER.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: 0, // overwritten inside insert_message_retry
        created_at: Utc::now().to_rfc3339(),
        images: images_json,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    };
    insert_message_retry(prefix, &msg)
}

/// Save an assistant message.
pub fn save_assistant_msg(
    prefix: &str,
    session_id: &str,
    content: &str,
    model: &str,
) -> SqliteResult<String> {
    let msg = AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: message_role::ASSISTANT.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: Some(model.to_string()),
        sequence: 0, // overwritten inside insert_message_retry
        created_at: Utc::now().to_rfc3339(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    };
    insert_message_retry(prefix, &msg)
}

/// Save a tool call.
pub fn save_tool_call_msg(
    prefix: &str,
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    arguments: &str,
) -> SqliteResult<String> {
    let msg = AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: message_role::TOOL_CALL.to_string(),
        content: format!("Tool call: {}", tool_name),
        tool_name: Some(tool_name.to_string()),
        tool_call_id: Some(tool_call_id.to_string()),
        tool_input: Some(arguments.to_string()),
        tool_output: None,
        model: None,
        sequence: 0, // overwritten inside insert_message_retry
        created_at: Utc::now().to_rfc3339(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    };
    insert_message_retry(prefix, &msg)
}

/// Save a tool result.
pub fn save_tool_result_msg(
    prefix: &str,
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    result: &str,
) -> SqliteResult<String> {
    let content_preview: String = crate::utils::safe_truncate_chars_to_string(&result, 2000);
    let msg = AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: message_role::TOOL_RESULT.to_string(),
        content: content_preview,
        tool_name: Some(tool_name.to_string()),
        tool_call_id: Some(tool_call_id.to_string()),
        tool_input: None,
        tool_output: Some(result.to_string()),
        model: None,
        sequence: 0, // overwritten inside insert_message_retry
        created_at: Utc::now().to_rfc3339(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    };
    insert_message_retry(prefix, &msg)
}
