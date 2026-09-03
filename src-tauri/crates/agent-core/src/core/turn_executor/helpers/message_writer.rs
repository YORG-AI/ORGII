//! Append messages onto the conversation history with the right wire shape.
//!
//! Rich tool output (MCP images/audio/resources, `_meta`, `structuredContent`)
//! is carried on the message JSON under a single non-standard key,
//! [`STRUCTURED_SIDECAR_KEY`]. OpenAI Chat Completions explicitly allows
//! unknown message fields, so OpenAI-compat backends (OpenAI, Azure, DeepSeek,
//! Groq, xAI, OpenRouter, LiteLLM, Ollama, Gemini-compat) silently ignore
//! this field and continue to read the flattened `content: <string>`. Only
//! the Anthropic-native provider reads the sidecar and promotes image/audio
//! blocks to top-level `user.content[]` siblings of the `tool_result` block.
//!
//! Keeping the structured payload on the message (rather than a side
//! HashMap keyed by tool_call_id) means every pipeline that already walks
//! `Vec<Value>` — microcompact, session persistence, file registry,
//! history truncation — automatically carries it without extra plumbing.

use serde_json::Value;

use crate::core::tools::traits::{McpMeta, ToolContentBlock, ToolExecuteResult};

/// Non-standard key carrying `_meta`, `structuredContent`, and
/// `content_blocks` on `role: "tool"` messages. See module comment.
pub const STRUCTURED_SIDECAR_KEY: &str = "_orgii_structured";

/// Sub-key inside [`STRUCTURED_SIDECAR_KEY`] holding the array of
/// MCP-style content blocks (`{type: "image"|"text"|"resource", ...}`).
/// Read by `microcompact::cap_recent_tool_images` and the per-provider
/// wire expansion paths (Anthropic-native, OpenAI Responses, OpenAI compat).
pub const STRUCTURED_CONTENT_BLOCKS_KEY: &str = "content_blocks";

/// Non-standard meta key flagging a `role: "tool"` message as an error
/// tool_result. Wire-format emitters that distinguish error results
/// from normal returns (Anthropic-native: `is_error: true` on the
/// `tool_result` content block) read this field. OpenAI-compat
/// providers ignore unknown fields per the OpenAI Chat Completions
/// spec, so this remains a no-op there.
///
/// The flag is set by the tool dispatchers (`single.rs`, `parallel.rs`,
/// `mod.rs`, `stream_error_recovery.rs`) wherever they already know the
/// outcome was an error (permission denial, streaming parse failure,
/// cancellation, `is_error_text(content)` over `TOOL_ERROR_PREFIX`).
/// Carrying the flag on the in-memory message — instead of re-running
/// the prefix sniff at wire-emit time — keeps a single source of truth
/// for "is this a failed tool call?" and lets us tighten the prefix
/// contract later without touching every emitter.
pub const TOOL_RESULT_IS_ERROR_KEY: &str = "_orgii_is_error";

/// Add an assistant message to the conversation history.
///
/// Handles the OpenAI format with optional tool_calls and reasoning content.
/// Stamps the current wall-clock time so time-based microcompact can compute
/// the gap since the last assistant response.
pub fn add_assistant_message(
    messages: &mut Vec<Value>,
    content: Option<&str>,
    tool_calls: Option<&[Value]>,
    reasoning_content: Option<&str>,
) {
    use crate::model_context::microcompact::{now_epoch_ms, TIMESTAMP_META_KEY};

    let mut msg = serde_json::json!({
        "role": "assistant",
        TIMESTAMP_META_KEY: now_epoch_ms(),
    });

    if let Some(text) = content {
        msg["content"] = Value::String(text.to_string());
    } else {
        msg["content"] = Value::Null;
    }

    if let Some(calls) = tool_calls {
        msg["tool_calls"] = Value::Array(calls.to_vec());
    }

    if let Some(reasoning) = reasoning_content {
        msg["reasoning_content"] = Value::String(reasoning.to_string());
    }

    messages.push(msg);
}

/// Add a tool result message to the conversation history (no timestamp).
///
/// `is_error == true` stamps [`TOOL_RESULT_IS_ERROR_KEY`] so the
/// Anthropic-native wire emitter promotes the resulting `tool_result`
/// block with `is_error: true`. Pass `false` for normal returns.
pub fn add_tool_result(
    messages: &mut Vec<Value>,
    tool_call_id: &str,
    tool_name: &str,
    result: &str,
    is_error: bool,
) {
    let mut msg = serde_json::json!({
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": result,
    });
    if is_error {
        msg[TOOL_RESULT_IS_ERROR_KEY] = Value::Bool(true);
    }
    messages.push(msg);
}

/// Same as [`add_tool_result`] but stamps the current wall-clock time
/// for time-based microcompact age tracking.
pub fn add_tool_result_with_timestamp(
    messages: &mut Vec<Value>,
    tool_call_id: &str,
    tool_name: &str,
    result: &str,
    is_error: bool,
) {
    use crate::model_context::microcompact::{now_epoch_ms, TIMESTAMP_META_KEY};
    let mut msg = serde_json::json!({
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": result,
        TIMESTAMP_META_KEY: now_epoch_ms(),
    });
    if is_error {
        msg[TOOL_RESULT_IS_ERROR_KEY] = Value::Bool(true);
    }
    messages.push(msg);
}

/// Tool result with structured sidecar.
///
/// Writes the flattened `result.text` as `content: <string>` (OpenAI-compat
/// wire format, unchanged) and additionally attaches non-text
/// `content_blocks` plus `mcp_meta` under [`STRUCTURED_SIDECAR_KEY`] when
/// any structured payload is present. `truncated_text` is the text that
/// was already passed through `truncate_output` + storage persistence —
/// pass it in so the sidecar's `content` matches the message body
/// verbatim; `rich` supplies only the extra structured blocks.
///
/// Provider behavior:
/// - OpenAI-compat (openai_compat/mod.rs): reads only `content`, ignores
///   the sidecar per OpenAI's "unknown fields are ignored" rule.
/// - Anthropic-native (anthropic_native/client.rs::extract_system): reads
///   the sidecar and emits top-level `image`/`audio` blocks as siblings
///   of `tool_result`.
pub fn add_tool_result_rich_with_timestamp(
    messages: &mut Vec<Value>,
    tool_call_id: &str,
    tool_name: &str,
    truncated_text: &str,
    rich: &ToolExecuteResult,
    is_error: bool,
) {
    use crate::model_context::microcompact::{now_epoch_ms, TIMESTAMP_META_KEY};
    let mut msg = serde_json::json!({
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": truncated_text,
        TIMESTAMP_META_KEY: now_epoch_ms(),
    });
    if let Some(sidecar) = build_structured_sidecar(&rich.content_blocks, rich.mcp_meta.as_ref()) {
        msg[STRUCTURED_SIDECAR_KEY] = sidecar;
    }
    if is_error {
        msg[TOOL_RESULT_IS_ERROR_KEY] = Value::Bool(true);
    }
    messages.push(msg);
}

/// Build the `_orgii_structured` sidecar object, or `None` if there is
/// nothing to attach (all content blocks are `Text` and no MCP meta).
/// Text blocks are intentionally stripped because they are already
/// reflected in the flattened `content` string; including them would
/// duplicate text in the LLM context window.
fn build_structured_sidecar(
    blocks: &[ToolContentBlock],
    mcp_meta: Option<&McpMeta>,
) -> Option<Value> {
    let non_text: Vec<&ToolContentBlock> = blocks
        .iter()
        .filter(|block| !matches!(block, ToolContentBlock::Text { .. }))
        .collect();

    let meta_is_empty = mcp_meta.map(McpMeta::is_empty).unwrap_or(true);
    if non_text.is_empty() && meta_is_empty {
        return None;
    }

    let mut sidecar = serde_json::Map::new();
    if !non_text.is_empty() {
        // Re-serialize via serde to preserve the `type`-tagged
        // representation defined on ToolContentBlock. `to_value` on a
        // `Serialize` struct made of standard types (String / enum /
        // Vec / Map) is infallible, so the previous
        // `unwrap_or(Value::Null)` would have masked a real bug
        // (custom serde impl panicking) by silently storing `null` in
        // the structured-sidecar column — which the LLM context
        // assembly then reads back as "no content blocks", losing the
        // image/audio/resource attachments without any diagnostic.
        let serialized: Vec<Value> = non_text
            .into_iter()
            .map(|block| {
                serde_json::to_value(block)
                    .expect("ToolContentBlock is serde::Serialize over standard types; infallible")
            })
            .collect();
        sidecar.insert("content_blocks".to_string(), Value::Array(serialized));
    }
    if let Some(meta) = mcp_meta {
        if !meta.is_empty() {
            sidecar.insert(
                "mcp_meta".to_string(),
                serde_json::to_value(meta)
                    .expect("McpMeta is serde::Serialize over standard types; infallible"),
            );
        }
    }
    Some(Value::Object(sidecar))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rich_with_image() -> ToolExecuteResult {
        ToolExecuteResult {
            text: "screenshot captured".to_string(),
            content_blocks: vec![
                ToolContentBlock::Text {
                    text: "screenshot captured".to_string(),
                },
                ToolContentBlock::Image {
                    mime_type: "image/png".to_string(),
                    data: "iVBORw0KG...".to_string(),
                },
            ],
            mcp_meta: None,
            turn_directive: None,
        }
    }

    #[test]
    fn sidecar_omitted_for_text_only_result() {
        let mut messages = Vec::new();
        let rich = ToolExecuteResult::text("hello");
        add_tool_result_rich_with_timestamp(
            &mut messages,
            "tc_1",
            "my_tool",
            "hello",
            &rich,
            false,
        );
        assert_eq!(messages.len(), 1);
        assert!(messages[0].get(STRUCTURED_SIDECAR_KEY).is_none());
        assert!(messages[0].get(TOOL_RESULT_IS_ERROR_KEY).is_none());
        assert_eq!(messages[0]["content"].as_str().unwrap(), "hello");
    }

    #[test]
    fn is_error_flag_set_when_tool_failed() {
        let mut messages = Vec::new();
        let rich = ToolExecuteResult::text("Error: blocked by plugin");
        add_tool_result_rich_with_timestamp(
            &mut messages,
            "tc_err",
            "my_tool",
            "Error: blocked by plugin",
            &rich,
            true,
        );
        assert_eq!(
            messages[0]
                .get(TOOL_RESULT_IS_ERROR_KEY)
                .and_then(|v| v.as_bool()),
            Some(true),
            "is_error meta must be stamped so Anthropic-native wire can emit `is_error: true`"
        );
    }

    #[test]
    fn is_error_flag_set_on_plain_add_tool_result() {
        let mut messages = Vec::new();
        add_tool_result(&mut messages, "tc_plain", "my_tool", "Error: denied", true);
        assert_eq!(
            messages[0]
                .get(TOOL_RESULT_IS_ERROR_KEY)
                .and_then(|v| v.as_bool()),
            Some(true),
        );

        let mut messages_ok = Vec::new();
        add_tool_result(&mut messages_ok, "tc_plain_ok", "my_tool", "ok", false);
        assert!(
            messages_ok[0].get(TOOL_RESULT_IS_ERROR_KEY).is_none(),
            "non-error tool_result must not stamp the meta key"
        );
    }

    #[test]
    fn sidecar_preserves_image_block_but_strips_text_blocks() {
        let mut messages = Vec::new();
        let rich = rich_with_image();
        add_tool_result_rich_with_timestamp(
            &mut messages,
            "tc_img",
            "mcp__img__screenshot",
            "screenshot captured",
            &rich,
            false,
        );
        let sidecar = messages[0]
            .get(STRUCTURED_SIDECAR_KEY)
            .expect("sidecar should be present when image block exists");
        let blocks = sidecar
            .get("content_blocks")
            .and_then(|v| v.as_array())
            .expect("content_blocks array");
        assert_eq!(
            blocks.len(),
            1,
            "text block should be stripped (already in content string)"
        );
        assert_eq!(blocks[0]["type"].as_str().unwrap(), "image");
        assert_eq!(blocks[0]["mime_type"].as_str().unwrap(), "image/png");
    }

    #[test]
    fn sidecar_carries_mcp_meta_even_without_blocks() {
        let mut messages = Vec::new();
        let rich = ToolExecuteResult {
            text: "ok".to_string(),
            content_blocks: Vec::new(),
            mcp_meta: Some(McpMeta {
                meta: Some(serde_json::json!({ "request_id": "r-123" })),
                structured_content: None,
            }),
            turn_directive: None,
        };
        add_tool_result_rich_with_timestamp(&mut messages, "tc", "mcp__x__y", "ok", &rich, false);
        let sidecar = messages[0]
            .get(STRUCTURED_SIDECAR_KEY)
            .expect("sidecar should be present when mcp_meta is set");
        assert!(sidecar.get("content_blocks").is_none());
        let meta = sidecar.get("mcp_meta").expect("mcp_meta in sidecar");
        assert_eq!(
            meta.get("meta")
                .and_then(|m| m.get("request_id"))
                .and_then(Value::as_str),
            Some("r-123")
        );
    }

    #[test]
    fn sidecar_carries_structured_content_when_present() {
        let mut messages = Vec::new();
        let rich = ToolExecuteResult {
            text: "computed".to_string(),
            content_blocks: Vec::new(),
            mcp_meta: Some(McpMeta {
                meta: None,
                structured_content: Some(serde_json::json!({ "rows": [1, 2, 3] })),
            }),
            turn_directive: None,
        };
        add_tool_result_rich_with_timestamp(&mut messages, "tc", "tool", "computed", &rich, false);
        let meta = messages[0]
            .get(STRUCTURED_SIDECAR_KEY)
            .and_then(|s| s.get("mcp_meta"))
            .expect("mcp_meta present");
        assert!(
            meta.get("structured_content")
                .and_then(|sc| sc.get("rows"))
                .is_some(),
            "structured_content should round-trip"
        );
    }

    #[test]
    fn sidecar_preserves_wire_format_for_openai_compat_readers() {
        // Non-anthropic readers only look at role/content/tool_call_id/name.
        // The sidecar key must not interfere with any of those.
        let mut messages = Vec::new();
        let rich = rich_with_image();
        add_tool_result_rich_with_timestamp(
            &mut messages,
            "tc_wire",
            "mcp__img",
            "img flattened text",
            &rich,
            false,
        );
        let msg = &messages[0];
        assert_eq!(msg["role"].as_str().unwrap(), "tool");
        assert_eq!(msg["tool_call_id"].as_str().unwrap(), "tc_wire");
        assert_eq!(msg["name"].as_str().unwrap(), "mcp__img");
        assert_eq!(msg["content"].as_str().unwrap(), "img flattened text");
    }
}
