use serde_json::{json, Value};

use crate::session::prompt::cache::ORGII_SYSTEM_CACHE_SCOPE_KEY;
use crate::tools::metadata::strip_tool_schema_cache_scope;

pub fn strip_tool_schema_cache_scopes(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let mut tool = tool.clone();
            strip_tool_schema_cache_scope(&mut tool);
            tool
        })
        .collect()
}

pub fn sanitize_openai_compat_messages(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(sanitize_message).collect()
}

/// Merge every `system`/`developer` message into a single `system` message at
/// index 0, preserving the order of all other messages.
///
/// vLLM's OpenAI-compatible endpoint rejects any `system` message that is not
/// `messages[0]` ("system message must be at the beginning"). ORGII emits the
/// system prompt as several inline system messages (a stable prompt plus a
/// per-turn dynamic-sections block, and sometimes more from compaction or
/// reconstructed history); most OpenAI-compatible servers accept that, but vLLM
/// does not. Applied only on the vLLM send path so other providers are
/// unchanged.
///
/// Assumes `system`/`developer` content has already been flattened to a string
/// by [`sanitize_openai_compat_messages`]; falls back to flattening defensively.
pub fn coalesce_system_messages_to_front(messages: Vec<Value>) -> Vec<Value> {
    let mut system_texts: Vec<String> = Vec::new();
    let mut others: Vec<Value> = Vec::with_capacity(messages.len());

    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if role == "system" || role == "developer" {
            let content = message.get("content");
            let text = content
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| content.and_then(flatten_text_content));
            if let Some(text) = text {
                if !text.trim().is_empty() {
                    system_texts.push(text);
                }
            }
        } else {
            others.push(message);
        }
    }

    if system_texts.is_empty() {
        return others;
    }

    let mut result = Vec::with_capacity(others.len() + 1);
    result.push(json!({
        "role": "system",
        "content": system_texts.join("\n\n"),
    }));
    result.extend(others);
    result
}

pub fn sanitize_deepseek_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let mut sanitized = message.clone();
            if let Some(content) = sanitized.get_mut("content") {
                if let Some(text) = flatten_text_content_with_image_placeholders(content) {
                    *content = Value::String(text);
                }
            }
            sanitized
        })
        .collect()
}

/// True when the wire target is DeepSeek's text-only chat completions.
///
/// Matches both the native `deepseek` provider spec and any aggregator-routed
/// deepseek model id (e.g. `zenmux` provider with `deepseek/deepseek-v4-flash`),
/// because DeepSeek's API rejects `image_url` content blocks with HTTP 400
/// ("unknown variant image_url, expected text").
pub fn is_deepseek_text_only_wire(provider_name: &str, wire_model: &str) -> bool {
    provider_name == "deepseek"
        || super::model_capabilities::resolve(wire_model, None).text_only_wire
}

fn sanitize_message(message: &Value) -> Value {
    let mut sanitized = message.clone();
    let role = sanitized
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let Some(content) = sanitized.get_mut("content") else {
        return sanitized;
    };

    if role == "system" || role == "developer" {
        if let Some(text) = flatten_text_content(content) {
            *content = Value::String(text);
        }
        return sanitized;
    }

    strip_content_cache_metadata(content);
    sanitized
}

pub fn flatten_text_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let blocks = content.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(text)
}

fn flatten_text_content_with_image_placeholders(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let blocks = content.as_array()?;
    let parts = blocks
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text") => block.get("text").and_then(Value::as_str).map(str::to_string),
            Some("image_url") | Some("image") => Some(
                "[Image omitted: DeepSeek chat completions currently require text-only message content.]"
                    .to_string(),
            ),
            _ => block.get("text").and_then(Value::as_str).map(str::to_string),
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(parts)
}

fn strip_content_cache_metadata(content: &mut Value) {
    let Some(blocks) = content.as_array_mut() else {
        return;
    };

    for block in blocks {
        if let Some(object) = block.as_object_mut() {
            object.remove(ORGII_SYSTEM_CACHE_SCOPE_KEY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_openai_compat_messages_flattens_structured_system_cache_blocks() {
        let messages = vec![json!({
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": "Stable summary",
                    (ORGII_SYSTEM_CACHE_SCOPE_KEY): "session"
                },
                {
                    "type": "text",
                    "text": "Rules snapshot",
                    (ORGII_SYSTEM_CACHE_SCOPE_KEY): "org"
                }
            ]
        })];

        let sanitized = sanitize_openai_compat_messages(&messages);

        assert_eq!(sanitized[0]["content"], "Stable summary\n\nRules snapshot");
        assert!(messages[0]["content"][0][ORGII_SYSTEM_CACHE_SCOPE_KEY].is_string());
    }

    #[test]
    fn sanitize_openai_compat_messages_strips_cache_metadata_from_user_blocks() {
        let messages = vec![json!({
            "role": "user",
            "content": [{
                "type": "text",
                "text": "Hello",
                (ORGII_SYSTEM_CACHE_SCOPE_KEY): "volatile"
            }]
        })];

        let sanitized = sanitize_openai_compat_messages(&messages);

        assert_eq!(sanitized[0]["content"][0]["text"], "Hello");
        assert!(sanitized[0]["content"][0]
            .get(ORGII_SYSTEM_CACHE_SCOPE_KEY)
            .is_none());
    }

    #[test]
    fn coalesce_system_messages_to_front_merges_and_relocates() {
        // Stable + volatile leading system messages, plus a mid-array system
        // (e.g. from compaction/history) — vLLM rejects all but messages[0].
        let messages = vec![
            json!({ "role": "system", "content": "A" }),
            json!({ "role": "system", "content": "B" }),
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "system", "content": "C" }),
            json!({ "role": "assistant", "content": "yo" }),
        ];

        let result = coalesce_system_messages_to_front(messages);

        assert_eq!(result.len(), 3);
        assert_eq!(result[0]["role"], "system");
        assert_eq!(result[0]["content"], "A\n\nB\n\nC");
        assert_eq!(result[1]["role"], "user");
        assert_eq!(result[1]["content"], "hi");
        assert_eq!(result[2]["role"], "assistant");
        assert_eq!(result[2]["content"], "yo");
    }

    #[test]
    fn coalesce_system_messages_to_front_is_noop_without_system() {
        let messages = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "yo" }),
        ];

        let result = coalesce_system_messages_to_front(messages.clone());

        assert_eq!(result, messages);
    }

    #[test]
    fn sanitize_deepseek_messages_flattens_multimodal_user_content() {
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                { "type": "text", "text": "What is in this image?" }
            ]
        })];

        let sanitized = sanitize_deepseek_messages(&messages);

        assert_eq!(
            sanitized[0]["content"],
            "[Image omitted: DeepSeek chat completions currently require text-only message content.]\n\nWhat is in this image?"
        );
    }

    #[test]
    fn is_deepseek_text_only_wire_matches_native_and_aggregator_routed() {
        // native deepseek provider spec
        assert!(is_deepseek_text_only_wire(
            "deepseek",
            "deepseek/deepseek-chat"
        ));
        // zenmux/aggregator provider with a deepseek wire model
        assert!(is_deepseek_text_only_wire(
            "zenmux",
            "deepseek/deepseek-v4-flash"
        ));
        // slug-carrying deepseek wire model
        assert!(is_deepseek_text_only_wire(
            "zenmux",
            "deepseek/deepseek-v4-flash:deepseek"
        ));
        // non-deepseek models routed through aggregators stay unaffected
        assert!(!is_deepseek_text_only_wire(
            "zenmux",
            "anthropic/claude-sonnet-4.5"
        ));
        assert!(!is_deepseek_text_only_wire("openai", "gpt-5"));
        // substring safety: unrelated model containing the word must not match
        assert!(!is_deepseek_text_only_wire("zenmux", "z-ai/glm-4.5-air"));
    }

    #[test]
    fn sanitize_deepseek_messages_leaves_string_content_as_string() {
        let messages = vec![json!({
            "role": "tool",
            "content": "plain tool output",
            "tool_call_id": "call_1"
        })];

        let sanitized = sanitize_deepseek_messages(&messages);

        assert_eq!(sanitized[0]["content"], "plain tool output");
        assert_eq!(sanitized[0]["tool_call_id"], "call_1");
    }

    #[test]
    fn strip_tool_schema_cache_scopes_removes_internal_tool_metadata() {
        let tools = vec![json!({
            "type": "function",
            "function": { "name": "read_file" },
            (crate::tools::metadata::ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY): "stable_prefix"
        })];

        let sanitized = strip_tool_schema_cache_scopes(&tools);

        assert!(sanitized[0]
            .get(crate::tools::metadata::ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY)
            .is_none());
        assert!(tools[0]
            .get(crate::tools::metadata::ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY)
            .is_some());
    }
}
