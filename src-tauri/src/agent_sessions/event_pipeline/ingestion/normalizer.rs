//! Event Normalizer
//!
//! Converts raw `RawActivityChunk` into `SessionEvent`.
//! Rust port of the TypeScript `normalizers.ts` — single ingestion point.

use crate::agent_sessions::event_pipeline::ingestion::function_map::{
    resolve_function_name, resolve_ui_canonical,
};
use crate::agent_sessions::event_pipeline::ingestion::types::RawActivityChunk;
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

// ============================================================================
// Content detection keys
// ============================================================================

const CONTENT_KEYS: &[&str] = &[
    "content",
    "output",
    "observation",
    "data",
    "file_content",
    "result",
    "response",
    "thought",
    "files",
    "matches",
    "exit_code",
    "stdout",
    "stderr",
];

const METADATA_KEYS: &[&str] = &["status", "success", "is_error", "pending", "call_id"];

// ============================================================================
// Public API
// ============================================================================

/// Normalize a single raw chunk into a `SessionEvent`.
pub fn normalize_chunk(chunk: &RawActivityChunk, session_id: &str) -> SessionEvent {
    let action_type = chunk.action_type.as_deref().unwrap_or("");
    let raw_function = chunk.function.as_deref().unwrap_or("");
    let args_val = chunk.args.as_ref();
    let result_val = chunk
        .result
        .clone()
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let args_obj = args_val
        .cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));

    let normalized_args = extract_args(action_type, &args_obj);
    let function_name = resolve_function_name(raw_function, action_type, Some(&args_obj));
    let ui_canonical = resolve_ui_canonical(&function_name);

    let chunk_id = chunk.chunk_id.clone().unwrap_or_default();
    // Backfill missing timestamps with the current time so downstream ordering
    // and rendering never see an empty created_at.
    let created_at = chunk
        .created_at
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let sid = chunk
        .session_id
        .as_deref()
        .unwrap_or(session_id)
        .to_string();
    let display_variant = infer_display_variant(action_type, raw_function, &result_val);
    let display_status = infer_display_status(
        action_type,
        raw_function,
        &function_name,
        &args_obj,
        &result_val,
    );
    let display_text = infer_display_text(action_type, raw_function, &args_obj, &result_val);
    let activity_status = infer_activity_status(action_type, &result_val);
    let source = infer_source(action_type, &result_val);

    let file_path = extract_file_path(&normalized_args, &result_val);
    let command = extract_command(&normalized_args, &result_val);
    let call_id = extract_call_id(chunk, &normalized_args, &result_val);
    let is_delta = action_type.contains("delta")
        || raw_function.contains("delta")
        || result_val
            .as_object()
            .and_then(|o| o.get("is_delta"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

    let mut event = SessionEvent {
        id: chunk_id.clone(),
        chunk_id: Some(chunk_id),
        session_id: sid,
        created_at,
        function_name,
        ui_canonical,
        action_type: if action_type.is_empty() {
            "action".to_string()
        } else {
            action_type.to_string()
        },
        args: normalized_args,
        result: result_val,
        source,
        display_text,
        display_status,
        display_variant,
        activity_status,
        thread_id: chunk.thread_id.clone(),
        process_id: chunk.process_id.clone(),
        call_id,
        file_path,
        command,
        is_delta: if is_delta { Some(true) } else { None },
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

/// Batch normalize chunks.
pub fn normalize_chunks(chunks: &[RawActivityChunk], session_id: &str) -> Vec<SessionEvent> {
    chunks
        .iter()
        .map(|c| normalize_chunk(c, session_id))
        .collect()
}

// ============================================================================
// Display Variant Inference
// ============================================================================

fn infer_display_variant(
    action_type: &str,
    function_name: &str,
    result: &serde_json::Value,
) -> EventDisplayVariant {
    // User messages
    if (action_type == "raw" || action_type == "raw_event") && raw_message_text(result).is_some() {
        return EventDisplayVariant::Message;
    }

    // Thinking events
    if matches!(
        action_type,
        "llm_thinking" | "llm_thinking_delta" | "thinking" | "thinking_delta"
    ) || matches!(function_name, "thinking" | "thinking_delta" | "reasoning")
    {
        return EventDisplayVariant::Thinking;
    }

    // Message events
    if matches!(
        action_type,
        "assistant" | "assistant_delta" | "message" | "message_delta"
    ) || matches!(
        function_name,
        "message" | "message_delta" | "assistant_message"
    ) {
        return EventDisplayVariant::Message;
    }

    // Plan events
    if action_type == "plan_update" || function_name == "plan_update" {
        return EventDisplayVariant::Plan;
    }

    // Approval events
    if matches!(
        action_type,
        "approval_request" | "approval_response" | "ask_user_permissions"
    ) || matches!(
        function_name,
        "approval_request" | "approval_response" | "ask_user_permissions"
    ) {
        return EventDisplayVariant::Approval;
    }

    // Session events
    if matches!(action_type, "session_start" | "session_end")
        || matches!(function_name, "session_start" | "session_end")
    {
        return EventDisplayVariant::Session;
    }

    // Error events (task_failed is filtered by is_visible_in_chat, variant doesn't matter)
    if action_type == "error" || function_name == "error" {
        return EventDisplayVariant::Error;
    }

    // Default: tool call
    EventDisplayVariant::ToolCall
}

// ============================================================================
// Display Status Inference
// ============================================================================

fn infer_display_status(
    action_type: &str,
    raw_function: &str,
    function_name: &str,
    args: &serde_json::Value,
    result: &serde_json::Value,
) -> EventDisplayStatus {
    let is_tool_call_type = action_type == "tool_call" || action_type == "tool_result";

    let obj = match result.as_object() {
        Some(o) => o,
        // result is null/non-object. Tool calls with no result are historical
        // orphans (their result was merged into a sibling or the session ended
        // before the result arrived). Treat them as completed so the UI does
        // not show a permanent loading spinner on past sessions.
        None => {
            if is_tool_call_type {
                return EventDisplayStatus::Completed;
            }
            return EventDisplayStatus::Running;
        }
    };

    // Explicit success/failure
    match obj.get("success") {
        Some(serde_json::Value::Bool(true)) => return EventDisplayStatus::Completed,
        Some(serde_json::Value::Object(_)) => return EventDisplayStatus::Completed,
        Some(serde_json::Value::Bool(false)) => return EventDisplayStatus::Failed,
        _ => {}
    }
    if obj.get("is_error") == Some(&serde_json::Value::Bool(true)) {
        return EventDisplayStatus::Failed;
    }

    // Status field
    if let Some(status) = obj.get("status").and_then(|v| v.as_str()) {
        match status {
            "completed" | "success" | "verified" => return EventDisplayStatus::Completed,
            "failed" | "error" => return EventDisplayStatus::Failed,
            "pending" => return EventDisplayStatus::Pending,
            "running" => return EventDisplayStatus::Running,
            _ => {}
        }
    }

    // Approval pending
    if obj.get("pending") == Some(&serde_json::Value::Bool(true)) {
        return EventDisplayStatus::Pending;
    }

    // Has meaningful content → completed
    if has_non_empty_result(obj) {
        return EventDisplayStatus::Completed;
    }

    // Session events are completed by nature
    if action_type == "session_start" || action_type == "session_end" {
        return EventDisplayStatus::Completed;
    }

    // Thinking events without result are in progress
    if action_type == "llm_thinking" || action_type == "llm_thinking_delta" {
        return EventDisplayStatus::Running;
    }

    // AskQuestion events without a result are waiting for user input.
    // Mark them "pending" so they remain visible in simulator/messages filters.
    if is_ask_question_action(action_type, raw_function, function_name, args) {
        return EventDisplayStatus::Pending;
    }

    // Tool calls with an empty result object are historical orphans — the
    // result either never arrived (session crashed) or was merged elsewhere.
    // Render them as completed so the UI shows no loading spinner.
    if is_tool_call_type {
        return EventDisplayStatus::Completed;
    }

    // Streaming message/thinking events without a result are genuinely in
    // progress (their content arrives via deltas).
    if matches!(
        action_type,
        "assistant"
            | "assistant_delta"
            | "message"
            | "message_delta"
            | "thinking"
            | "thinking_delta"
    ) {
        return EventDisplayStatus::Running;
    }

    // Unknown action types with an empty result object: default to Completed
    // so historical/one-shot events never show a permanent loading spinner.
    EventDisplayStatus::Completed
}

fn is_ask_question_action(
    action_type: &str,
    raw_function: &str,
    function_name: &str,
    args: &serde_json::Value,
) -> bool {
    const ASK_NAMES: &[&str] = &[
        "ask_user",
        "ask_user_questions",
        "ask_question",
        "askquestion",
        "askuserquestion",
        "question",
        "collectfeedback",
        "ask_confirmation",
        "prompt_user",
    ];

    let action_lower = action_type.to_ascii_lowercase();
    if ASK_NAMES.contains(&action_lower.as_str()) {
        return true;
    }

    let func_lower = raw_function.to_ascii_lowercase();
    if ASK_NAMES.contains(&func_lower.as_str()) {
        return true;
    }

    let norm_lower = function_name.to_ascii_lowercase();
    if ASK_NAMES.contains(&norm_lower.as_str()) {
        return true;
    }

    // tool_call wrapper: real name may live in args.tool_name / args.name
    if action_type == "tool_call" {
        if let Some(obj) = args.as_object() {
            let tool_name = obj
                .get("tool_name")
                .or_else(|| obj.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tool_lower = tool_name.to_ascii_lowercase();
            if ASK_NAMES.contains(&tool_lower.as_str()) {
                return true;
            }
        }
    }

    false
}

fn has_non_empty_result(obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    for key in CONTENT_KEYS {
        if let Some(val) = obj.get(*key) {
            if !val.is_null() {
                return true;
            }
        }
    }

    for (key, value) in obj {
        if METADATA_KEYS.contains(&key.as_str()) {
            continue;
        }
        if value.is_null() {
            continue;
        }
        match value {
            serde_json::Value::String(s) if s.is_empty() => continue,
            serde_json::Value::Array(arr) if arr.is_empty() => continue,
            serde_json::Value::Object(o) if o.is_empty() => continue,
            _ => return true,
        }
    }

    false
}

// ============================================================================
// Activity Status Inference
// ============================================================================

fn infer_activity_status(action_type: &str, result: &serde_json::Value) -> ActivityStatus {
    if action_type == "ask_user" || action_type == "ask_user_questions" || action_type == "question"
    {
        return ActivityStatus::Pending;
    }

    if let Some(obj) = result.as_object() {
        if obj.get("handled") == Some(&serde_json::Value::Bool(true))
            || obj.get("user_responded") == Some(&serde_json::Value::Bool(true))
        {
            return ActivityStatus::Processed;
        }
    }

    ActivityStatus::Agent
}

// ============================================================================
// Source Inference
// ============================================================================

fn infer_source(action_type: &str, result: &serde_json::Value) -> EventSource {
    if (action_type == "raw" || action_type == "raw_event") && raw_message_text(result).is_some() {
        return EventSource::User;
    }
    EventSource::Assistant
}

// ============================================================================
// Display Text Inference
// ============================================================================

fn infer_display_text(
    action_type: &str,
    function_name: &str,
    args: &serde_json::Value,
    result: &serde_json::Value,
) -> String {
    let args_obj = args.as_object();
    let result_obj = result.as_object();

    match action_type {
        "raw" | "raw_event" => raw_message_text(result).unwrap_or_else(|| "Activity".to_string()),

        "assistant" | "assistant_delta" | "message" | "message_delta" => result_obj
            .and_then(|o| str_field(o, "observation").or_else(|| str_field(o, "content")))
            .or_else(|| args_obj.and_then(|o| str_field(o, "task_description")))
            .unwrap_or_else(|| "AI Processing...".to_string()),

        "llm_thinking" | "llm_thinking_delta" | "thinking" | "thinking_delta" => result_obj
            .and_then(|o| str_field(o, "thought").or_else(|| str_field(o, "content")))
            .unwrap_or_else(|| "Thinking...".to_string()),

        "shellToolCall" | "run_command_line" => {
            let cmd = args_obj
                .and_then(|o| str_field(o, "command"))
                .unwrap_or_default();
            format!("Command: {}", cmd)
        }

        "consult_agent" => args_obj
            .and_then(|o| str_field(o, "task_description"))
            .unwrap_or_else(|| {
                let agent = args_obj
                    .and_then(|o| str_field(o, "agent_name"))
                    .unwrap_or_else(|| "agent".to_string());
                format!("Consulting {}...", agent)
            }),

        "error" => result_obj
            .and_then(|o| {
                str_field(o, "error")
                    .or_else(|| str_field(o, "error_message"))
                    .or_else(|| str_field(o, "observation"))
            })
            .unwrap_or_else(|| "Error".to_string()),

        "plan_update" => "Plan updated".to_string(),

        "approval_request" | "ask_user_permissions" => {
            let tool = args_obj
                .and_then(|o| str_field(o, "tool_name"))
                .unwrap_or_else(|| "action".to_string());
            format!("Approval requested: {}", tool)
        }

        "approval_response" => {
            if result_obj
                .and_then(|o| o.get("approved"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                "Approved".to_string()
            } else {
                "Rejected".to_string()
            }
        }

        "session_start" => {
            let model = args_obj
                .and_then(|o| str_field(o, "model"))
                .unwrap_or_else(|| "unknown model".to_string());
            format!("Session started ({})", model)
        }

        "session_end" => {
            if result_obj
                .and_then(|o| o.get("success"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                "Session completed".to_string()
            } else {
                "Session ended".to_string()
            }
        }

        _ => {
            if !function_name.is_empty() {
                function_name.to_string()
            } else if !action_type.is_empty() {
                action_type.to_string()
            } else {
                "Activity".to_string()
            }
        }
    }
}

fn raw_message_text(result: &serde_json::Value) -> Option<String> {
    let obj = result.as_object()?;
    if obj.get("type").and_then(|v| v.as_str()) != Some("user") && !obj.contains_key("message") {
        return None;
    }

    let text = obj
        .get("message")
        .and_then(extract_text_content)
        .or_else(|| obj.get("content").and_then(extract_text_content))?;
    let text = strip_terminal_code_blocks(&text);
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn extract_text_content(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }

    if let Some(obj) = value.as_object() {
        return obj.get("content").and_then(extract_text_content);
    }

    let parts = value.as_array()?;
    let texts: Vec<&str> = parts
        .iter()
        .filter_map(|part| {
            let obj = part.as_object()?;
            if obj.get("type")?.as_str()? == "text" {
                obj.get("text")?.as_str()
            } else {
                None
            }
        })
        .collect();

    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

/// Strip injected context code blocks appended by the agent content pipeline.
fn strip_terminal_code_blocks(text: &str) -> String {
    if !text.contains("```") {
        return text.to_string();
    }

    if let Some(idx) = text.find("\n\n```") {
        let display_part = &text[..idx];
        let appended_blocks = &text[idx..];

        let has_context_pill = display_part.contains("{{pill:");
        let has_trace_markers = appended_blocks.contains("<!-- context-trace");

        if has_context_pill || has_trace_markers {
            return display_part.trim_end().to_string();
        }
    }

    text.to_string()
}

// ============================================================================
// Field Extraction Helpers
// ============================================================================

fn extract_args(action_type: &str, args: &serde_json::Value) -> serde_json::Value {
    if action_type == "tool_call" {
        if let Some(obj) = args.as_object() {
            if let Some(input) = obj.get("input") {
                return input.clone();
            }
        }
    }
    args.clone()
}

fn extract_file_path(args: &serde_json::Value, result: &serde_json::Value) -> Option<String> {
    let args_obj = args.as_object();
    let result_obj = result.as_object();

    args_obj
        .and_then(|o| {
            str_field(o, "file_path")
                .or_else(|| str_field(o, "filePath"))
                .or_else(|| str_field(o, "path"))
                .or_else(|| str_field(o, "target_file"))
                .or_else(|| str_field(o, "targetFile"))
        })
        .or_else(|| {
            result_obj.and_then(|o| {
                str_field(o, "file_path")
                    .or_else(|| str_field(o, "filePath"))
                    .or_else(|| str_field(o, "target_file"))
                    .or_else(|| str_field(o, "targetFile"))
                    .or_else(|| str_field(o, "path"))
            })
        })
}

fn extract_command(args: &serde_json::Value, result: &serde_json::Value) -> Option<String> {
    let args_obj = args.as_object();
    let result_obj = result.as_object();

    args_obj
        .and_then(|o| str_field(o, "command"))
        .or_else(|| result_obj.and_then(|o| str_field(o, "command")))
}

fn extract_call_id(
    chunk: &RawActivityChunk,
    args: &serde_json::Value,
    result: &serde_json::Value,
) -> Option<String> {
    // Top-level call_id on chunk
    if let Some(ref cid) = chunk.call_id {
        return Some(cid.clone());
    }

    let args_obj = args.as_object();
    let result_obj = result.as_object();

    args_obj
        .and_then(|o| str_field(o, "call_id"))
        .or_else(|| result_obj.and_then(|o| str_field(o, "call_id")))
}

fn str_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[path = "tests/normalizer_tests.rs"]
mod tests;
