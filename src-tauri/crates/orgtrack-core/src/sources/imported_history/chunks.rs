use core_types::activity::ActivityChunk;
use serde_json::json;

use super::{
    ImportedToolCall, ACTION_TYPE_ASSISTANT, ACTION_TYPE_RAW, ACTION_TYPE_THINKING,
    ACTION_TYPE_TOOL_CALL, FUNCTION_ASSISTANT, FUNCTION_THINKING, FUNCTION_USER_MESSAGE,
    IMPORTED_STATUS_COMPLETED,
};

/// Internal wrapper blocks ORGII prepends to the prompt it hands the CLI:
/// the GUI exec-mode briefing and the IDE-context injection
/// (`inject_ide_context_into_prompt`). The CLI's native transcript stores
/// the full prompt verbatim, so replay readers must strip these to recover
/// what the user actually typed.
const INTERNAL_CONTEXT_BLOCKS: &[(&str, &str)] = &[
    ("<orgii_cli_exec_mode_bridge>", "</orgii_cli_exec_mode_bridge>"),
    ("<ide_context>", "</ide_context>"),
];

/// Repeatedly strip LEADING internal wrapper blocks (exec-mode briefing,
/// IDE context) from `text`, in any order.
///
/// If a known tag opens but never closes (e.g. a truncated title), the whole
/// remainder is treated as internal and `""` is returned — an unclosed
/// internal block never carries user-authored text after it.
pub fn strip_internal_context_blocks(text: &str) -> &str {
    let mut remaining = text;
    let mut stripped = false;
    'outer: loop {
        let candidate = remaining.trim_start();
        for (open, close) in INTERNAL_CONTEXT_BLOCKS {
            if let Some(rest) = candidate.strip_prefix(open) {
                match rest.find(close) {
                    Some(end) => {
                        remaining = &rest[end + close.len()..];
                        stripped = true;
                        continue 'outer;
                    }
                    None => return "",
                }
            }
        }
        break;
    }
    if stripped {
        remaining.trim_start()
    } else {
        text
    }
}

/// GUI-launched runs prefix the task with an internal exec-mode briefing;
/// strip it so titles/replay show only what the user typed.
///
/// Back-compat name: now also strips the `<ide_context>` injection via
/// [`strip_internal_context_blocks`].
pub fn strip_orgii_exec_mode_bridge(text: &str) -> &str {
    strip_internal_context_blocks(text)
}

pub fn user_message_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    message: &str,
) -> ActivityChunk {
    // Single funnel for every imported reader's user bubbles: strip the
    // GUI exec-mode briefing and IDE-context injection here so no source
    // can leak them into replay.
    let message = strip_internal_context_blocks(message);
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_RAW, FUNCTION_USER_MESSAGE);
    chunk.chunk_id = format!("{provider_slug}-user-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "type": "user",
        "message": { "content": message, "role": "user" },
    });
    chunk
}

pub fn assistant_message_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    message: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_ASSISTANT, FUNCTION_ASSISTANT);
    chunk.chunk_id = format!("{provider_slug}-asst-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "observation": message,
        "content": message,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
    });
    chunk
}

pub fn thinking_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    thought: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_THINKING, FUNCTION_THINKING);
    chunk.chunk_id = format!("{provider_slug}-thinking-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "thought": thought,
        "content": thought,
        "observation": thought,
        "is_delta": false,
    });
    chunk
}

pub fn tool_call_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_TOOL_CALL, &call.canonical_name);
    chunk.chunk_id = format!("{provider_slug}-tool-{sequence}-{}", call.call_id);
    chunk.created_at = call.created_at.clone();
    chunk.args = call.args.clone();
    chunk.result = json!({
        "success": true,
        "status": IMPORTED_STATUS_COMPLETED,
        "call_id": call.call_id,
        "output": output,
        "observation": output,
        "raw_tool_name": call.raw_name,
    });
    chunk
}
