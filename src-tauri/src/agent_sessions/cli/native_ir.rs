//! Canonical provider-neutral role/tool conversation IR.
//!
//! This module owns validation and projections from provider/Agent history.
//! Native store mutation and provider serialization remain in the materializer.

use std::collections::HashSet;
use std::io::Write;

use core_types::activity::ActivityChunk;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub(super) const MAX_ITEMS: usize = 100_000;
const MAX_SERIALIZED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PORTABLE_TOOL_CALL_ID_LENGTH: usize = 64;
const PORTABLE_TOOL_CALL_NAMESPACE: Uuid = Uuid::from_u128(0x9e7db8a394bf5c589416a244ba6e30d3);

fn is_portable_tool_call_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_PORTABLE_TOOL_CALL_ID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn portable_tool_call_id(value: &str) -> String {
    let value = value.trim();
    if is_portable_tool_call_id(value) {
        return value.to_string();
    }

    format!(
        "call_{}",
        Uuid::new_v5(&PORTABLE_TOOL_CALL_NAMESPACE, value.as_bytes()).simple()
    )
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NativeConversationItem {
    Message {
        id: String,
        role: String,
        text: String,
        #[serde(default)]
        images: Vec<String>,
        created_at: String,
        #[serde(default)]
        turn_id: Option<String>,
    },
    ToolCall {
        id: String,
        call_id: String,
        name: String,
        arguments: String,
        created_at: String,
    },
    ToolResult {
        id: String,
        call_id: String,
        name: String,
        output: String,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        interrupted: bool,
        created_at: String,
    },
    /// Provider-owned effective-context boundary. The full SessionEvent log
    /// remains available for UI/history; materialization uses this typed
    /// summary plus the structured suffix instead of replaying the superseded
    /// pre-compaction model context.
    ContextSummary {
        id: String,
        summary: String,
        created_at: String,
    },
}

impl NativeConversationItem {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Message { id, .. }
            | Self::ToolCall { id, .. }
            | Self::ToolResult { id, .. }
            | Self::ContextSummary { id, .. } => id,
        }
    }

    pub(super) fn created_at(&self) -> &str {
        match self {
            Self::Message { created_at, .. }
            | Self::ToolCall { created_at, .. }
            | Self::ToolResult { created_at, .. }
            | Self::ContextSummary { created_at, .. } => created_at,
        }
    }
}

pub(super) fn validate_items(items: &[NativeConversationItem]) -> Result<(), String> {
    if items.len() > MAX_ITEMS {
        return Err(format!(
            "native transcript has {} items; limit is {MAX_ITEMS}",
            items.len()
        ));
    }
    struct SerializedSize(usize);

    impl Write for SerializedSize {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("native transcript size overflow"))?;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    // Measure the wire representation without allocating a second copy of a
    // potentially 64 MiB transcript on every materialize/synchronize call.
    let mut encoded_size = SerializedSize(0);
    serde_json::to_writer(&mut encoded_size, items)
        .map_err(|err| format!("serialize native transcript input: {err}"))?;
    if encoded_size.0 > MAX_SERIALIZED_BYTES {
        return Err(format!(
            "native transcript is {} bytes; limit is {MAX_SERIALIZED_BYTES}",
            encoded_size.0
        ));
    }
    let mut item_ids = HashSet::with_capacity(items.len());
    for item in items {
        if item.id().trim().is_empty() {
            return Err("native transcript item id is required".to_string());
        }
        if !item_ids.insert(item.id()) {
            return Err(format!(
                "native transcript contains duplicate canonical item id {:?}",
                item.id()
            ));
        }
        match item {
            NativeConversationItem::Message {
                id, role, images, ..
            } => {
                if !matches!(role.as_str(), "user" | "assistant") {
                    return Err(format!("unsupported native message role {role:?}"));
                }
                if role == "assistant" && !images.is_empty() {
                    return Err(format!(
                        "assistant historical images cannot be transferred losslessly to this native target: item={id:?}, images={}",
                        images.len()
                    ));
                }
                for image in images {
                    if !image.starts_with("data:image/") {
                        return Err(format!(
                            "historical images must be embedded data URLs for exact native transfer: item={id:?}"
                        ));
                    }
                }
            }
            NativeConversationItem::ToolCall {
                call_id,
                name,
                arguments,
                ..
            } => {
                if call_id.trim().is_empty() || name.trim().is_empty() {
                    return Err("native tool call requires callId and name".to_string());
                }
                if !is_portable_tool_call_id(call_id) {
                    return Err(format!(
                        "native tool call id must match [A-Za-z0-9_-] and be at most {MAX_PORTABLE_TOOL_CALL_ID_LENGTH} characters"
                    ));
                }
                serde_json::from_str::<Value>(arguments).map_err(|err| {
                    format!("native tool call {call_id} has invalid JSON arguments: {err}")
                })?;
            }
            NativeConversationItem::ToolResult { call_id, name, .. } => {
                if call_id.trim().is_empty() || name.trim().is_empty() {
                    return Err("native tool result requires callId and name".to_string());
                }
                if !is_portable_tool_call_id(call_id) {
                    return Err(format!(
                        "native tool result id must match [A-Za-z0-9_-] and be at most {MAX_PORTABLE_TOOL_CALL_ID_LENGTH} characters"
                    ));
                }
            }
            NativeConversationItem::ContextSummary { summary, .. } => {
                if summary.trim().is_empty() {
                    return Err("native context summary cannot be empty".to_string());
                }
            }
        }
    }
    Ok(())
}

fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn chunk_text(chunk: &ActivityChunk) -> String {
    chunk
        .result
        .get("message")
        .and_then(|message| message.get("content"))
        .map(json_text)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            ["content", "observation", "output"]
                .into_iter()
                .find_map(|field| chunk.result.get(field).and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn transferable_tool_args(chunk: &ActivityChunk) -> Value {
    let mut args = chunk.args.clone();
    if let Some(object) = args.as_object_mut() {
        object.retain(|key, _| {
            key != "conversationTurnId"
                && key != "conversationSender"
                && !key.starts_with("__orgii")
        });
    }
    args
}

fn agent_message_images(message: &Value) -> Vec<String> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            let image = part.get("image_url")?;
            image
                .as_str()
                .or_else(|| image.get("url").and_then(Value::as_str))
                .filter(|url| url.starts_with("data:image/"))
                .map(str::to_string)
        })
        .collect()
}

/// Project the provider reader's authoritative transcript back into the same
/// portable role/tool IR accepted by the materializer. Native lifecycle,
/// usage, reasoning, and compact markers deliberately stay outside this
/// projection; compaction remains owned by the live target provider.
pub(super) fn native_items_from_chunks(chunks: &[ActivityChunk]) -> Vec<NativeConversationItem> {
    let mut items = Vec::new();
    for chunk in chunks {
        match chunk.function.as_str() {
            "context_compacted" => {
                let summary = chunk_text(chunk);
                if !summary.trim().is_empty() {
                    // Only the latest compact boundary is effective model
                    // context. Superseded rows remain in SessionEvents for UI
                    // history but must not be fed to the next provider.
                    items.clear();
                    items.push(NativeConversationItem::ContextSummary {
                        id: chunk.chunk_id.clone(),
                        summary,
                        created_at: chunk.created_at.clone(),
                    });
                }
            }
            orgtrack_core::sources::imported_history::FUNCTION_USER_MESSAGE => {
                let images = chunk
                    .result
                    .get("images")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                items.push(NativeConversationItem::Message {
                    id: chunk.chunk_id.clone(),
                    role: "user".to_string(),
                    text: chunk_text(chunk),
                    images,
                    created_at: chunk.created_at.clone(),
                    turn_id: None,
                });
            }
            orgtrack_core::sources::imported_history::FUNCTION_ASSISTANT => {
                let text = chunk_text(chunk);
                if !text.is_empty() {
                    items.push(NativeConversationItem::Message {
                        id: chunk.chunk_id.clone(),
                        role: "assistant".to_string(),
                        text,
                        images: Vec::new(),
                        created_at: chunk.created_at.clone(),
                        turn_id: None,
                    });
                }
            }
            _ if chunk.action_type == "tool_call" => {
                // A provider-native interrupt is recorded as a tool call with
                // no result. That is not a portable conversation boundary:
                // the canonical projection drops it, so reading the provider
                // store back must drop it too instead of inventing a result
                // the provider never wrote.
                let status_is_pending = chunk
                    .result
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| matches!(status, "pending" | "running"));
                let interrupted =
                    chunk.result.get("interrupted").and_then(Value::as_bool) == Some(true);
                let output = chunk_text(chunk);
                // A call with no provider result cannot cross a runtime
                // boundary. If Stop already observed durable output, however,
                // carry an honest interrupted result: both native writers can
                // encode it as failure (Claude is_error / Codex exit 130).
                if (status_is_pending || interrupted) && (!interrupted || output.is_empty()) {
                    continue;
                }
                let is_error = chunk.result.get("is_error").and_then(Value::as_bool) == Some(true)
                    || chunk.result.get("success").and_then(Value::as_bool) == Some(false)
                    || interrupted
                    || chunk
                        .result
                        .get("status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| matches!(status, "failed" | "error" | "cancelled"));
                let raw_call_id = chunk
                    .result
                    .get("call_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(&chunk.chunk_id);
                let call_id = portable_tool_call_id(raw_call_id);
                let name = chunk.function.clone();
                items.push(NativeConversationItem::ToolCall {
                    id: format!("{}:call", chunk.chunk_id),
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: transferable_tool_args(chunk).to_string(),
                    created_at: chunk.created_at.clone(),
                });
                items.push(NativeConversationItem::ToolResult {
                    id: format!("{}:result", chunk.chunk_id),
                    call_id,
                    name,
                    output,
                    is_error,
                    interrupted,
                    created_at: chunk.created_at.clone(),
                });
            }
            _ => {}
        }
    }
    items
}

pub(super) fn native_items_from_agent_history(history: &[Value]) -> Vec<NativeConversationItem> {
    let mut items = Vec::new();
    for (index, message) in history.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let created_at = message
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match role {
            "user" | "assistant" => {
                let text = message.get("content").map(json_text).unwrap_or_default();
                let images = agent_message_images(message);
                if !text.is_empty() || !images.is_empty() {
                    items.push(NativeConversationItem::Message {
                        id: format!("agent-history-{index}"),
                        role: role.to_string(),
                        text,
                        images,
                        created_at: created_at.clone(),
                        turn_id: None,
                    });
                }
                if role == "assistant" {
                    for (tool_index, tool) in message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .enumerate()
                    {
                        let call_id = portable_tool_call_id(
                            tool.get("id").and_then(Value::as_str).unwrap_or_default(),
                        );
                        let function = tool.get("function").unwrap_or(tool);
                        let name = function
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let arguments = function
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        items.push(NativeConversationItem::ToolCall {
                            id: format!("agent-history-{index}-tool-{tool_index}"),
                            call_id,
                            name: name.to_string(),
                            arguments: arguments.to_string(),
                            created_at: created_at.clone(),
                        });
                    }
                }
            }
            "tool" => {
                let call_id = portable_tool_call_id(
                    message
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                items.push(NativeConversationItem::ToolResult {
                    id: format!("agent-history-{index}-result"),
                    call_id,
                    name: message
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    output: message.get("content").map(json_text).unwrap_or_default(),
                    is_error: message
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    interrupted: message
                        .get("interrupted")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    created_at,
                });
            }
            _ => {}
        }
    }
    items
}

pub(super) fn native_item_semantically_equal(
    left: &NativeConversationItem,
    right: &NativeConversationItem,
) -> bool {
    match (left, right) {
        (
            NativeConversationItem::Message {
                role: left_role,
                text: left_text,
                images: left_images,
                ..
            },
            NativeConversationItem::Message {
                role: right_role,
                text: right_text,
                images: right_images,
                ..
            },
        ) => left_role == right_role && left_text == right_text && left_images == right_images,
        (
            NativeConversationItem::ToolCall {
                call_id: left_id,
                name: left_name,
                arguments: left_arguments,
                ..
            },
            NativeConversationItem::ToolCall {
                call_id: right_id,
                name: right_name,
                arguments: right_arguments,
                ..
            },
        ) => {
            left_id == right_id
                && left_name == right_name
                && serde_json::from_str::<Value>(left_arguments).ok()
                    == serde_json::from_str::<Value>(right_arguments).ok()
        }
        (
            NativeConversationItem::ToolResult {
                call_id: left_id,
                name: left_name,
                output: left_output,
                is_error: left_is_error,
                ..
            },
            NativeConversationItem::ToolResult {
                call_id: right_id,
                name: right_name,
                output: right_output,
                is_error: right_is_error,
                ..
            },
        ) => {
            // `interrupted` refines `is_error` for ORG2 diagnostics only. No
            // supported provider transcript carries it: an Anthropic
            // `tool_result` block is content plus `is_error`, and a Codex
            // `function_call_output` is text. Comparing it here would make
            // every transcript ORG2 wrote diverge from itself on read-back.
            left_id == right_id
                && left_name == right_name
                && left_output == right_output
                && left_is_error == right_is_error
        }
        (
            NativeConversationItem::ContextSummary {
                summary: left_summary,
                ..
            },
            NativeConversationItem::ContextSummary {
                summary: right_summary,
                ..
            },
        ) => left_summary == right_summary,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_tool_ids_use_the_portable_conversation_identity() {
        let raw_call_id = "call_ZQuKyGuKN6l4aFX6Kg6trDeR:part-0";
        let expected = "call_0b3a8cc5654a5208989d80ed5659c267";
        let mut chunk = ActivityChunk::new("source", "tool_call", "read_file");
        chunk.chunk_id = format!("codex-tool-7-{raw_call_id}");
        chunk.args = json!({"path": "CLAUDE.md"});
        chunk.result = json!({
            "call_id": raw_call_id,
            "output": "contents",
            "status": "completed",
            "success": true
        });

        let chunk_items = native_items_from_chunks(&[chunk]);
        assert!(matches!(
            chunk_items.as_slice(),
            [
                NativeConversationItem::ToolCall { call_id, .. },
                NativeConversationItem::ToolResult {
                    call_id: result_call_id,
                    ..
                }
            ] if call_id == expected && result_call_id == expected
        ));

        let history_items = native_items_from_agent_history(&[
            json!({
                "role": "assistant",
                "tool_calls": [{
                    "id": raw_call_id,
                    "function": {"name": "read_file", "arguments": "{\"path\":\"CLAUDE.md\"}"}
                }]
            }),
            json!({
                "role": "tool",
                "tool_call_id": raw_call_id,
                "name": "read_file",
                "content": "contents"
            }),
        ]);
        assert!(matches!(
            history_items.as_slice(),
            [
                NativeConversationItem::ToolCall { call_id, .. },
                NativeConversationItem::ToolResult {
                    call_id: result_call_id,
                    ..
                }
            ] if call_id == expected && result_call_id == expected
        ));

        assert_eq!(
            portable_tool_call_id("call_already_portable"),
            "call_already_portable"
        );
    }

    #[test]
    fn interrupted_tool_output_is_portable_but_an_empty_dangling_call_is_not() {
        let interrupted = |output: &str| {
            let mut chunk = ActivityChunk::new("source", "tool_call", "run_command_line");
            chunk.chunk_id = "interrupted-command".to_string();
            chunk.args = json!({"command": "pnpm test"});
            chunk.result = json!({
                "call_id": "call_interrupted",
                "status": "pending",
                "success": false,
                "interrupted": true,
                "output": output,
                "observation": output
            });
            chunk
        };

        let partial = native_items_from_chunks(&[interrupted("Tests 12 passed\n")]);
        assert!(matches!(
            partial.as_slice(),
            [
                NativeConversationItem::ToolCall { call_id, .. },
                NativeConversationItem::ToolResult {
                    call_id: result_call_id,
                    output,
                    is_error: true,
                    interrupted: true,
                    ..
                }
            ] if call_id == "call_interrupted"
                && result_call_id == "call_interrupted"
                && output == "Tests 12 passed\n"
        ));

        assert!(native_items_from_chunks(&[interrupted("")]).is_empty());
    }

    #[test]
    fn transport_metadata_is_not_part_of_portable_tool_arguments() {
        let mut chunk = ActivityChunk::new("source", "tool_call", "read_file");
        chunk.chunk_id = "materialized-tool".to_string();
        chunk.args = json!({
            "path": "README.md",
            "conversationTurnId": "turn-1",
            "conversationSender": {"memberId": "member-1"},
            "__orgiiSourceEventId": "orgii_evt_source"
        });
        chunk.result = json!({
            "call_id": "call_read",
            "output": "contents",
            "status": "completed",
            "success": true
        });

        let items = native_items_from_chunks(&[chunk]);
        assert!(matches!(
            items.first(),
            Some(NativeConversationItem::ToolCall { arguments, .. })
                if serde_json::from_str::<Value>(arguments).ok()
                    == Some(json!({"path": "README.md"}))
        ));
    }
}
