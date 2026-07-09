//! OpenAI → Anthropic message-format conversion.
//!
//! Converts the OpenAI chat-completions message shape we use internally
//! into the Anthropic Messages API shape on its way out, applying:
//!
//! - System message extraction into the structured `system` array with
//!   cache_control stamped on cacheable blocks.
//! - `assistant.tool_calls[]` → `content: [{ type: "tool_use" }]`.
//! - `tool` role → `user` role with `{ type: "tool_result" }` blocks
//!   (and any `_orgii_structured` sidecar media siblings).
//! - `image_url` user blocks → Anthropic `image` blocks (data-URL or URL).
//! - Consecutive same-role messages merged (Anthropic requires alternating).
//! - Sliding history-tail cache_control breakpoint (BP3) on the trailing
//!   block of the last message.
//!
//! Pure functions only — no `&self` dependency on `AnthropicClient`.

use serde_json::Value;

use crate::core::session::prompt::cache::{
    RenderedSystemBlock, RenderedSystemBlockScope, ORGII_SYSTEM_CACHE_SCOPE_KEY,
};
use crate::core::turn_executor::helpers::TOOL_RESULT_IS_ERROR_KEY as IS_ERROR_META_KEY;

/// Extract system messages and convert OpenAI-format messages to Anthropic format.
///
/// Returns (system_content, non_system_messages) where system_content is
/// a structured array with `cache_control` for prompt caching.
///
/// Conversions performed:
/// - `role: "system"` → extracted into structured content blocks with cache_control
/// - `role: "assistant"` with `tool_calls` → content blocks with `type: "tool_use"`
/// - `role: "tool"` → `role: "user"` with content block `type: "tool_result"`
/// - Consecutive same-role messages are merged (Anthropic requires alternating roles)
///
/// When `skip_cache_write` is true, NO `cache_control` breakpoints are
/// stamped — neither on the system blocks (BP1) nor on the history tail
/// (BP3). Used for one-shot side queries (e.g. compaction summarization)
/// whose prefix is never sent again, so a cache write is pure cost.
pub(super) fn extract_system(
    messages: &[Value],
    skip_cache_write: bool,
) -> (Option<Value>, Vec<Value>) {
    let mut system_parts: Vec<RenderedSystemBlock> = Vec::new();
    let mut converted: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");

        match role {
            "system" => {
                if let Some(blocks) = msg.get("content").and_then(|content| content.as_array()) {
                    for block in blocks {
                        let Some(text) = block.get("text").and_then(Value::as_str) else {
                            continue;
                        };
                        let scope = block
                            .get(ORGII_SYSTEM_CACHE_SCOPE_KEY)
                            .and_then(Value::as_str)
                            .and_then(parse_cache_scope)
                            .unwrap_or(RenderedSystemBlockScope::Volatile);
                        system_parts.push(RenderedSystemBlock::new(text, scope));
                    }
                } else if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    system_parts.push(RenderedSystemBlock::new(
                        content,
                        RenderedSystemBlockScope::Session,
                    ));
                }
            }
            "assistant" => {
                let mut content_blocks: Vec<Value> = Vec::new();

                let text = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                if !text.is_empty() {
                    content_blocks.push(serde_json::json!({
                        "type": "text",
                        "text": text,
                    }));
                }

                if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                    for tc in tool_calls {
                        if let Some(thinking) = anthropic_thinking_block(tc) {
                            content_blocks.push(thinking);
                        }

                        let tc_id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
                        let func = tc.get("function");
                        let name = func
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        let input = func
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| {
                                if a.is_string() {
                                    let raw = a.as_str().unwrap_or("{}");
                                    // Falling back to `{}` on invalid JSON
                                    // here is intentional — Anthropic
                                    // rejects the whole assistant turn if
                                    // any tool_use block has a non-object
                                    // `input`, so a corrupt arg string
                                    // would otherwise hard-fail the
                                    // entire conversion. Warn so the
                                    // upstream OpenAI-format corruption
                                    // is visible in logs instead of
                                    // silently substituting empty args.
                                    match serde_json::from_str(raw) {
                                        Ok(v) => Some(v),
                                        Err(err) => {
                                            tracing::warn!(
                                                tool = %name,
                                                tool_call_id = %tc_id,
                                                error = %err,
                                                raw = %raw,
                                                "anthropic_native::messages: tool_call arguments string is not valid JSON; substituting {{}}"
                                            );
                                            None
                                        }
                                    }
                                } else {
                                    Some(a.clone())
                                }
                            })
                            .unwrap_or_else(|| serde_json::json!({}));

                        content_blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc_id,
                            "name": name,
                            "input": input,
                        }));
                    }
                }

                if content_blocks.is_empty() {
                    // Nothing to say and no tool calls — emitting an empty
                    // text block would 400 on the API. Drop the message;
                    // consecutive same-role neighbors merge downstream.
                    continue;
                }

                converted.push(serde_json::json!({
                    "role": "assistant",
                    "content": content_blocks,
                }));
            }
            "tool" => {
                // Convert OpenAI tool result → Anthropic tool_result block.
                // If the message carries a `_orgii_structured` sidecar
                // (emitted by `turn_executor::helpers::add_tool_result_rich_with_timestamp`),
                // translate MCP image / audio blocks into Anthropic image
                // blocks and push them as **siblings** of the `tool_result`
                // — Anthropic's wire format expects image blocks at the
                // top level of `user.content[]`, not nested inside
                // `tool_result.content[]`, otherwise the model does not
                // see the attached media.
                let tool_call_id = msg
                    .get("tool_call_id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("");
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");

                // Promote the in-memory `_orgii_is_error` meta (stamped
                // by `turn_executor::helpers::add_tool_result*`) into
                // the Anthropic-native wire `is_error: true` field on
                // the `tool_result` block. Without this, error
                // tool_results look identical to successful ones over
                // the wire and the model will reason as if the tool
                // succeeded. Error tool_result content is always
                // paired with `is_error: true`.
                let is_error = msg
                    .get(IS_ERROR_META_KEY)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let mut tool_result_block = serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                });
                if is_error {
                    tool_result_block["is_error"] = Value::Bool(true);
                }
                // Propagate a message-level volatile cache-scope marker (set
                // when the per-turn reminder was folded into this tool result)
                // onto the block, so `stamp_trailing_cache_control` skips it —
                // its bytes change every turn. Stripped before wire.
                if msg
                    .get(ORGII_SYSTEM_CACHE_SCOPE_KEY)
                    .and_then(Value::as_str)
                    == Some("volatile")
                {
                    tool_result_block[ORGII_SYSTEM_CACHE_SCOPE_KEY] =
                        Value::String("volatile".to_string());
                }
                let mut blocks_for_message: Vec<Value> = vec![tool_result_block];

                // Error tool_results must carry ONLY text — attaching media
                // siblings to a failed call confuses the model (it reasons
                // over an image that "succeeded" next to an error) and some
                // gateways reject the combination outright.
                if !is_error {
                    if let Some(sidecar) = msg.get("_orgii_structured") {
                        if let Some(extra_blocks) = sidecar_to_anthropic_sibling_blocks(sidecar) {
                            blocks_for_message.extend(extra_blocks);
                        }
                    }
                }

                let can_merge = converted
                    .last()
                    .and_then(|last| last.get("role").and_then(|r| r.as_str()))
                    == Some("user");

                if can_merge {
                    if let Some(last) = converted.last_mut() {
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            arr.extend(blocks_for_message);
                        }
                    }
                } else {
                    converted.push(serde_json::json!({
                        "role": "user",
                        "content": blocks_for_message,
                    }));
                }
            }
            "user" => {
                let raw_content = msg.get("content");
                let new_blocks: Vec<Value> = if let Some(s) = raw_content.and_then(|c| c.as_str()) {
                    vec![serde_json::json!({ "type": "text", "text": s })]
                } else if let Some(arr) = raw_content.and_then(|c| c.as_array()) {
                    arr.iter().map(convert_content_block).collect()
                } else {
                    vec![serde_json::json!({ "type": "text", "text": "" })]
                };

                let can_merge = converted
                    .last()
                    .and_then(|last| last.get("role").and_then(|r| r.as_str()))
                    == Some("user");

                if can_merge {
                    if let Some(last) = converted.last_mut() {
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            arr.extend(new_blocks);
                        }
                    }
                } else {
                    converted.push(serde_json::json!({
                        "role": "user",
                        "content": new_blocks,
                    }));
                }
            }
            _ => {
                converted.push(msg.clone());
            }
        }
    }

    let system = render_system_blocks(&system_parts, skip_cache_write);

    // Final wire-hygiene pass (each rule maps to a real API 400 class):
    // 1. A message whose content ends with a thinking block and nothing
    //    after it (orphan thinking — stream died before text/tool_use)
    //    is rejected; drop the orphan thinking block.
    // 2. Trailing assistant message with effectively-empty text is
    //    rejected ("final assistant content cannot be empty").
    finalize_wire_hygiene(&mut converted);

    // Sliding history breakpoint (BP3): stamp `cache_control: ephemeral`
    // on the last non-volatile content block. Combined with
    // BP1 (system end) and BP2 (tools end) elsewhere this gives us the
    // 3-breakpoint Anthropic agentic-loop pattern. Without BP3 the entire
    // message history is re-tokenised on every turn, so cache_read covers
    // only system + tools and cache_creation grows linearly with turn count.
    // Volatile blocks (the per-turn context reminder appended after the
    // history) are skipped: stamping them would move the breakpoint onto
    // content that changes every turn and defeat the cache.
    if !skip_cache_write {
        stamp_trailing_cache_control(&mut converted);
    }
    strip_cache_scope_markers(&mut converted);

    (system, converted)
}

fn parse_cache_scope(raw: &str) -> Option<RenderedSystemBlockScope> {
    match raw {
        "global" => Some(RenderedSystemBlockScope::Global),
        "org" => Some(RenderedSystemBlockScope::Org),
        "session" => Some(RenderedSystemBlockScope::Session),
        "volatile" => Some(RenderedSystemBlockScope::Volatile),
        _ => None,
    }
}

fn render_system_blocks(
    system_parts: &[RenderedSystemBlock],
    skip_cache_write: bool,
) -> Option<Value> {
    let non_empty_parts: Vec<&RenderedSystemBlock> = system_parts
        .iter()
        .filter(|part| !part.text.trim().is_empty())
        .collect();
    if non_empty_parts.is_empty() {
        return None;
    }

    // BP1 (system end) is suppressed for one-shot requests: caching a
    // prefix that is never re-read only pays the cache-write premium.
    let last_cacheable_index = if skip_cache_write {
        None
    } else {
        non_empty_parts
            .iter()
            .rposition(|part| part.cache_scope.is_cacheable())
    };
    let mut blocks: Vec<Value> = Vec::with_capacity(non_empty_parts.len());
    for (index, part) in non_empty_parts.iter().enumerate() {
        let mut block = serde_json::json!({
            "type": "text",
            "text": part.text,
        });
        if Some(index) == last_cacheable_index {
            block["cache_control"] = serde_json::json!({ "type": "ephemeral" });
        }
        blocks.push(block);
    }
    Some(Value::Array(blocks))
}
/// Put `cache_control: ephemeral` on the last non-volatile content block
/// across all converted messages. Skips cleanly when the message list is
/// empty or no block qualifies.
///
/// Cache-control on a block tells Anthropic "cache everything up to
/// and including this block." Placing it on the trailing stable block every
/// turn creates a sliding breakpoint that captures all historical
/// turns as the conversation grows. Blocks marked with a `volatile` cache
/// scope (the per-turn context reminder) are skipped so the breakpoint
/// never lands on content that changes each turn.
fn stamp_trailing_cache_control(messages: &mut [Value]) {
    for msg in messages.iter_mut().rev() {
        let Some(blocks) = msg.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for block in blocks.iter_mut().rev() {
            let is_volatile = block
                .get(ORGII_SYSTEM_CACHE_SCOPE_KEY)
                .and_then(Value::as_str)
                == Some("volatile");
            if is_volatile {
                continue;
            }
            if let Some(obj) = block.as_object_mut() {
                obj.insert(
                    "cache_control".to_string(),
                    serde_json::json!({ "type": "ephemeral" }),
                );
            }
            return;
        }
    }
}

/// Remove internal `_orgii_cache_scope` markers from every content block
/// before the request goes on the wire — Anthropic rejects unknown fields
/// on content blocks.
fn strip_cache_scope_markers(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        let Some(blocks) = msg.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for block in blocks.iter_mut() {
            if let Some(obj) = block.as_object_mut() {
                obj.remove(ORGII_SYSTEM_CACHE_SCOPE_KEY);
            }
        }
    }
}

/// Final wire-hygiene fixes applied after conversion, before cache
/// stamping. Mutates in place; drops messages that end up empty.
fn finalize_wire_hygiene(messages: &mut Vec<Value>) {
    // 1. Orphan thinking: a thinking block at the END of an assistant
    //    message's content (no text/tool_use after it) is rejected by the
    //    API. Pop such blocks.
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = msg.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        while blocks
            .last()
            .and_then(|b| b.get("type").and_then(Value::as_str))
            .map(|t| t == "thinking" || t == "redacted_thinking")
            .unwrap_or(false)
        {
            blocks.pop();
        }
    }

    // 2. Drop messages whose content collapsed to nothing (or to only
    //    whitespace text) — empty content arrays are rejected. Never drop
    //    tool_result-bearing user messages.
    messages.retain(|msg| {
        let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
            return true; // string content — handled upstream
        };
        if blocks.is_empty() {
            return false;
        }
        blocks.iter().any(|block| {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| !t.trim().is_empty())
                    .unwrap_or(false),
                // tool_use / tool_result / image / document all count as
                // substantive content.
                Some(_) => true,
                None => false,
            }
        })
    });
}

fn anthropic_thinking_block(tool_call: &Value) -> Option<Value> {
    let anthropic = tool_call.get("extra_content")?.get("anthropic")?;
    let thinking = anthropic.get("thinking")?.as_str()?;
    let signature = anthropic.get("signature")?.as_str()?;
    if thinking.is_empty() || signature.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "type": "thinking",
        "thinking": thinking,
        "signature": signature,
    }))
}

/// Convert a single content block from OpenAI format to Anthropic format.
///
/// Handles `image_url` → `image` conversion for vision support.
/// Data URL format: `data:<media_type>;base64,<data>`. Plain URLs go
/// through as `{ source: { type: "url", url } }`. Other block types
/// pass through unchanged.
fn convert_content_block(block: &Value) -> Value {
    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if block_type != "image_url" {
        return block.clone();
    }

    let data_url = block
        .get("image_url")
        .and_then(|iu| iu.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");

    if let Some(rest) = data_url.strip_prefix("data:") {
        if let Some(semi_pos) = rest.find(';') {
            let media_type = &rest[..semi_pos];
            if let Some(payload) = rest[semi_pos..].strip_prefix(";base64,") {
                return serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": payload,
                    }
                });
            }
        }
    }

    if !data_url.is_empty() {
        return serde_json::json!({
            "type": "image",
            "source": {
                "type": "url",
                "url": data_url,
            }
        });
    }

    block.clone()
}

/// Translate `_orgii_structured` into Anthropic content blocks.
///
/// The sidecar shape is defined in
/// `turn_executor::helpers::add_tool_result_rich_with_timestamp`:
///
/// ```json
/// {
///   "content_blocks": [
///     { "type": "image", "mime_type": "image/png", "data": "base64..." },
///     { "type": "audio", "mime_type": "audio/wav", "data": "base64..." },
///     { "type": "resource", "uri": "file:///...", "mime_type": "...", "text": "..." },
///     { "type": "resource_link", "uri": "https://...", "name": "...", "description": "..." }
///   ],
///   "mcp_meta": { ... }
/// }
/// ```
///
/// Returns the set of blocks to **append as siblings** of the `tool_result`
/// inside the Anthropic `user` message. Pushes images as top-level user
/// content blocks (not nested inside `tool_result`) so that
/// `is_error: true` tool_results stay valid. Returns `None` when nothing
/// in the sidecar needs a sibling block (e.g. only `mcp_meta` or only
/// text blocks).
pub(super) fn sidecar_to_anthropic_sibling_blocks(sidecar: &Value) -> Option<Vec<Value>> {
    let blocks = sidecar.get("content_blocks")?.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for block in blocks {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match block_type {
            "image" => {
                let mime = block
                    .get("mime_type")
                    .and_then(|m| m.as_str())
                    .unwrap_or("image/png");
                let data = block.get("data").and_then(|d| d.as_str()).unwrap_or("");
                if data.is_empty() {
                    continue;
                }
                out.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime,
                        "data": data,
                    }
                }));
            }
            "audio" => {
                // Anthropic Messages API does not currently accept inline
                // audio blocks. Degrade to a text breadcrumb so the model
                // at least knows audio was returned and can ask the tool
                // to render / transcribe it.
                let mime = block
                    .get("mime_type")
                    .and_then(|m| m.as_str())
                    .unwrap_or("audio");
                out.push(serde_json::json!({
                    "type": "text",
                    "text": format!("[audio payload attached ({mime}); Anthropic wire cannot render audio inline]"),
                }));
            }
            "resource" | "resource_link" => {
                // MCP resources don't map 1:1 to any Anthropic block type;
                // keep them as text so the LLM sees the URI and can ask
                // the tool for the contents.
                let uri = block.get("uri").and_then(|u| u.as_str()).unwrap_or("");
                let text = block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string());
                let description = block
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string());
                let mut rendered = format!("[MCP resource: {}]", uri);
                if let Some(desc) = description {
                    rendered.push_str(&format!(" {}", desc));
                }
                if let Some(inline) = text {
                    rendered.push('\n');
                    rendered.push_str(&inline);
                }
                out.push(serde_json::json!({
                    "type": "text",
                    "text": rendered,
                }));
            }
            "text" => {
                // Already flattened into the tool_result's `content` string
                // by `add_tool_result_rich_with_timestamp`; the sidecar
                // emitter skips them, but stay defensive.
                continue;
            }
            _ => continue,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
#[path = "tests/messages_tests.rs"]
mod tests;
