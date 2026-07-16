//! Message and tool conversion for OpenAI Responses API.
//!
//! Converts between the internal Chat Completions message format
//! (used by the agent loop) and the Responses API format.

use serde_json::Value;

use crate::providers::wire_sanitize::{
    sanitize_openai_compat_messages, strip_tool_schema_cache_scopes,
};

use crate::turn_executor::helpers::STRUCTURED_SIDECAR_KEY;

use super::types::enforce_strict_schema;

/// Fallback MIME when the sidecar's `mime_type` is missing or empty.
const FALLBACK_IMAGE_MIME: &str = "image/png";

/// Convert Chat Completions messages to Responses API input.
///
/// Extracts the system message as `instructions`, converts
/// assistant/tool messages to Responses API item shapes, and
/// *always* expands `_orgii_structured` image sidecars on
/// `role:"tool"` messages into follow-up synthetic `role:"user"`
/// items with `input_image` content blocks.
///
/// ### Why unconditional expansion?
///
/// Earlier this path gated image expansion on a hardcoded
/// `VISION_MODEL_KEYWORDS` allow-list. That was wrong: proxies,
/// LiteLLM-style routed names, Azure deployments, and user-hosted
/// models all carry names the allow-list could never predict, and
/// the failure mode was *silent image drop* — strictly worse than
/// the alternative of letting the API return 400. The Responses
/// API family (GPT-5, GPT-5.4-*, o-series) is uniformly vision-
/// capable today, so unconditional expansion has no known false
/// positive and is the right default for future models routed
/// through this wire.
///
/// Chat Completions format (agent-core internal):
/// ```json
/// [
///   {"role": "system", "content": "..."},
///   {"role": "user", "content": "..."},
///   {"role": "assistant", "content": "...", "tool_calls": [...]},
///   {"role": "tool", "tool_call_id": "...", "content": "...",
///    "_orgii_structured": {"content_blocks": [{"type":"image", ...}]}}
/// ]
/// ```
///
/// Responses API format (wire):
/// ```json
/// {
///   "instructions": "...",
///   "input": [
///     {"role": "user", "content": "..."},
///     {"type": "message", "role": "assistant",
///      "content": [{"type": "output_text", "text": "..."}]},
///     {"type": "function_call", "call_id": "...", "name": "...", "arguments": "..."},
///     {"type": "function_call_output", "call_id": "...", "output": "..."},
///     {"role": "user", "content": [
///       {"type": "input_text", "text": "Image(s) from the previous tool call."},
///       {"type": "input_image", "image_url": "data:image/png;base64,..."}
///     ]}
///   ]
/// }
/// ```
pub fn convert_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut instructions: Option<String> = None;
    let mut input: Vec<Value> = Vec::new();
    let sanitized_messages = sanitize_openai_compat_messages(messages);

    for msg in &sanitized_messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");

        match role {
            "system" => {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    instructions = Some(content.to_string());
                }
            }
            "user" => {
                input.push(normalize_input_message(msg));
            }
            "assistant" => {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        input.push(serde_json::json!({
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": content}]
                        }));
                    }
                }

                if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                    for tc in tool_calls {
                        let func = tc.get("function");
                        let name = func
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        let arguments = func
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| a.as_str())
                            .unwrap_or("{}");
                        let call_id = tc.get("id").and_then(|id| id.as_str()).unwrap_or("");

                        input.push(serde_json::json!({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments,
                        }));
                    }
                }
            }
            "tool" => {
                let call_id = msg
                    .get("tool_call_id")
                    .and_then(|id| id.as_str())
                    .unwrap_or("");
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");

                input.push(serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": content,
                }));

                if let Some(followup) = build_image_followup(msg) {
                    input.push(followup);
                }
            }
            _ => {
                input.push(normalize_input_message(msg));
            }
        }
    }

    (instructions, input)
}

fn normalize_input_message(msg: &Value) -> Value {
    let Some(content) = msg.get("content").and_then(Value::as_array) else {
        return msg.clone();
    };

    let mut normalized = msg.clone();
    normalized["content"] = Value::Array(
        content
            .iter()
            .map(|part| normalize_input_content_part(part))
            .collect(),
    );
    normalized
}

fn normalize_input_content_part(part: &Value) -> Value {
    let Some(content_type) = part.get("type").and_then(Value::as_str) else {
        return part.clone();
    };

    match content_type {
        "text" => {
            let mut normalized = part.clone();
            normalized["type"] = Value::String("input_text".to_string());
            normalized
        }
        "image_url" => {
            let mut normalized = part.clone();
            normalized["type"] = Value::String("input_image".to_string());

            if let Some(url) = part
                .get("image_url")
                .and_then(|image_url| image_url.get("url").or(Some(image_url)))
                .and_then(Value::as_str)
            {
                normalized["image_url"] = Value::String(url.to_string());
            }

            normalized
        }
        _ => part.clone(),
    }
}

/// Build a Responses API `user` message with `input_image` blocks from
/// the `_orgii_structured` sidecar on a `role:"tool"` message, or
/// `None` if there are no image blocks to lift.
///
/// Mirrors the shape used by
/// `openai_compat::wire_expand::expand_tool_images_for_openai_wire`
/// but emits Responses-API-native `input_text` / `input_image` block
/// types with an `image_url` **string** (not object).
fn build_image_followup(tool_msg: &Value) -> Option<Value> {
    let sidecar = tool_msg.get(STRUCTURED_SIDECAR_KEY)?;
    let blocks = sidecar.get("content_blocks").and_then(Value::as_array)?;

    let images: Vec<(String, String)> = blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str)? != "image" {
                return None;
            }
            let data = block.get("data").and_then(Value::as_str)?.to_string();
            if data.is_empty() {
                return None;
            }
            let mime = block
                .get("mime_type")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or(FALLBACK_IMAGE_MIME)
                .to_string();
            Some((mime, data))
        })
        .collect();

    if images.is_empty() {
        return None;
    }

    let mut content: Vec<Value> = Vec::with_capacity(images.len() + 1);
    content.push(serde_json::json!({
        "type": "input_text",
        "text": "Image(s) from the previous tool call.",
    }));
    for (mime, data) in images {
        content.push(serde_json::json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{}", mime, data),
        }));
    }

    Some(serde_json::json!({
        "role": "user",
        "content": content,
    }))
}

/// Convert Chat Completions tool definitions to Responses API format.
///
/// Chat Completions: `{ type: "function", function: { name, description, parameters } }`
/// Responses API:    `{ type: "function", name, description, parameters, strict: true }`
///
/// The Responses API enforces strict schema validation: every object-type
/// node must have `"additionalProperties": false`.
pub fn convert_tools(tools: Option<&[Value]>) -> Option<Vec<Value>> {
    tools.map(|tool_list| {
        strip_tool_schema_cache_scopes(tool_list)
            .into_iter()
            .map(|tool| {
                if let Some(func) = tool.get("function") {
                    let mut converted = serde_json::json!({
                        "type": "function",
                    });
                    if let Some(name) = func.get("name") {
                        converted["name"] = name.clone();
                    }
                    if let Some(desc) = func.get("description") {
                        converted["description"] = desc.clone();
                    }
                    if let Some(params) = func.get("parameters") {
                        let mut params = params.clone();
                        enforce_strict_schema(&mut params);
                        converted["parameters"] = params;
                    }
                    converted
                } else {
                    tool.clone()
                }
            })
            .collect()
    })
}

/// Convert Chat Completions tools to Responses API tool definitions and the
/// matching `tool_choice` value, honoring any `side_query` structured-output
/// override sentinel.
///
/// `side_query` appends a `{ "_orgii_tool_choice_override": {...} }` element
/// to the tools array to force a specific tool call. That sentinel has no
/// `"function"` key, so passing it through `convert_tools` verbatim leaks a
/// `type`-less object into the request and the Responses backend rejects it
/// with `Unsupported tool type: None`. This helper strips the sentinel before
/// conversion and maps it to the Responses `tool_choice` shape
/// (`{"type":"function","name":"x"}`), mirroring how `openai_compat` and
/// `anthropic_native` handle the same sentinel. With no override present,
/// `tool_choice` defaults to `"auto"`.
pub fn convert_tools_with_choice(tools: Option<&[Value]>) -> (Option<Vec<Value>>, Option<Value>) {
    let Some(tool_list) = tools else {
        return (None, None);
    };

    let (override_val, cleaned) = crate::core::side_query::extract_tool_choice_override(tool_list);
    let converted = convert_tools(Some(&cleaned));
    let tool_choice = match override_val {
        Some(ovr) => Some(translate_tool_choice_for_responses(&ovr)),
        None => Some(Value::String("auto".to_string())),
    };
    (converted, tool_choice)
}

/// Map an Anthropic-style forced-tool override `{"type":"tool","name":"x"}`
/// (as minted by `side_query`) to the Responses API `tool_choice` shape
/// `{"type":"function","name":"x"}`. Anything that isn't a recognizable
/// forced-tool override falls back to `"auto"`.
fn translate_tool_choice_for_responses(override_val: &Value) -> Value {
    if let Some(name) = override_val.get("name").and_then(Value::as_str) {
        return serde_json::json!({ "type": "function", "name": name });
    }
    Value::String("auto".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_messages_extracts_system_as_instructions() {
        let messages = vec![
            serde_json::json!({"role": "system", "content": "You are helpful."}),
            serde_json::json!({"role": "user", "content": "Hello"}),
        ];
        let (instructions, input) = convert_messages(&messages);
        assert_eq!(instructions, Some("You are helpful.".to_string()));
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
    }

    #[test]
    fn convert_messages_normalizes_user_text_blocks_for_responses() {
        let messages = vec![serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "Hello" },
                { "type": "input_text", "text": "Already native" }
            ]
        })];

        let (_, input) = convert_messages(&messages);
        let content = input[0]["content"].as_array().expect("array content");
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[0]["text"], "Hello");
        assert_eq!(content[1]["type"], "input_text");
    }

    #[test]
    fn convert_messages_normalizes_user_image_url_blocks_for_responses() {
        let messages = vec![serde_json::json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
            ]
        })];

        let (_, input) = convert_messages(&messages);
        let content = input[0]["content"].as_array().expect("array content");
        assert_eq!(content[0]["type"], "input_image");
        assert_eq!(content[0]["image_url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn test_convert_messages_converts_tool_results() {
        let messages = vec![serde_json::json!({
            "role": "tool",
            "tool_call_id": "call_123",
            "content": "Result data"
        })];
        let (_, input) = convert_messages(&messages);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call_output");
        assert_eq!(input[0]["call_id"], "call_123");
        assert_eq!(input[0]["output"], "Result data");
    }

    // -- Unconditional image sidecar expansion --

    fn tool_msg_with_image(mime: &str, data: &str) -> Value {
        serde_json::json!({
            "role": "tool",
            "tool_call_id": "call_img",
            "content": "[image breadcrumb]",
            STRUCTURED_SIDECAR_KEY: {
                "content_blocks": [
                    { "type": "image", "mime_type": mime, "data": data }
                ]
            }
        })
    }

    #[test]
    fn convert_messages_always_appends_input_image_user() {
        let messages = vec![tool_msg_with_image("image/png", "AAAA")];
        let (_, input) = convert_messages(&messages);
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], "function_call_output");
        assert_eq!(input[1]["role"], "user");

        let content = input[1]["content"].as_array().expect("array content");
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[1]["type"], "input_image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn convert_messages_multiple_images_one_followup() {
        let tool = serde_json::json!({
            "role": "tool",
            "tool_call_id": "call_img",
            "content": "[two images]",
            STRUCTURED_SIDECAR_KEY: {
                "content_blocks": [
                    { "type": "image", "mime_type": "image/png", "data": "AAA" },
                    { "type": "text", "text": "middle text" },
                    { "type": "image", "mime_type": "image/jpeg", "data": "BBB" }
                ]
            }
        });
        let messages = vec![tool];
        let (_, input) = convert_messages(&messages);
        assert_eq!(input.len(), 2);

        let content = input[1]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,AAA");
        assert_eq!(content[2]["image_url"], "data:image/jpeg;base64,BBB");
    }

    #[test]
    fn convert_messages_audio_only_sidecar_no_followup() {
        let tool = serde_json::json!({
            "role": "tool",
            "tool_call_id": "t",
            "content": "text",
            STRUCTURED_SIDECAR_KEY: {
                "content_blocks": [
                    { "type": "audio", "mime_type": "audio/wav", "data": "AAAA" }
                ]
            }
        });
        let (_, input) = convert_messages(&[tool]);
        assert_eq!(input.len(), 1, "audio-only sidecar does not get lifted");
    }

    #[test]
    fn convert_messages_missing_mime_uses_fallback() {
        let tool = serde_json::json!({
            "role": "tool",
            "tool_call_id": "t",
            "content": "",
            STRUCTURED_SIDECAR_KEY: {
                "content_blocks": [
                    { "type": "image", "data": "CCC" }
                ]
            }
        });
        let (_, input) = convert_messages(&[tool]);
        assert_eq!(input.len(), 2);
        let content = input[1]["content"].as_array().unwrap();
        assert_eq!(content[1]["image_url"], "data:image/png;base64,CCC");
    }

    #[test]
    fn convert_messages_empty_data_skipped() {
        let tool = serde_json::json!({
            "role": "tool",
            "tool_call_id": "t",
            "content": "",
            STRUCTURED_SIDECAR_KEY: {
                "content_blocks": [
                    { "type": "image", "mime_type": "image/png", "data": "" }
                ]
            }
        });
        let (_, input) = convert_messages(&[tool]);
        assert_eq!(
            input.len(),
            1,
            "empty-data image block must not produce followup"
        );
    }

    #[test]
    fn convert_messages_followup_order_matches_source() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "please screenshot"}),
            tool_msg_with_image("image/png", "A"),
            serde_json::json!({"role": "assistant", "content": "done"}),
            tool_msg_with_image("image/gif", "B"),
        ];
        let (_, input) = convert_messages(&messages);
        // user, function_call_output, user(input_image),
        // assistant message, function_call_output, user(input_image)
        assert_eq!(input.len(), 6);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[2]["role"], "user");
        assert_eq!(input[2]["content"][1]["type"], "input_image");
        assert_eq!(input[3]["type"], "message");
        assert_eq!(input[4]["type"], "function_call_output");
        assert_eq!(input[5]["role"], "user");
    }

    #[test]
    fn test_convert_tools_flattens_function_definition() {
        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"}
                    }
                }
            }
        })];
        let converted = convert_tools(Some(&tools)).unwrap();
        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["type"], "function");
        assert_eq!(converted[0]["name"], "get_weather");
        assert!(converted[0].get("function").is_none());
        assert_eq!(
            converted[0]["parameters"]["additionalProperties"],
            Value::Bool(false)
        );
    }

    #[test]
    fn convert_tools_with_choice_strips_sidequery_override_sentinel() {
        // side_query appends a sentinel that is NOT a function definition.
        // It must never reach the wire as a tool, or the Responses backend
        // rejects the request with "Unsupported tool type: None".
        use crate::core::side_query::TOOL_CHOICE_OVERRIDE_KEY;
        let tools = vec![
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "emit_session_title",
                    "description": "Emit structured output",
                    "parameters": { "type": "object", "properties": {} }
                }
            }),
            serde_json::json!({
                TOOL_CHOICE_OVERRIDE_KEY: { "type": "tool", "name": "emit_session_title" }
            }),
        ];

        let (converted, tool_choice) = convert_tools_with_choice(Some(&tools));
        let converted = converted.unwrap();

        assert_eq!(converted.len(), 1, "sentinel must be stripped from tools");
        assert_eq!(converted[0]["type"], "function");
        assert_eq!(converted[0]["name"], "emit_session_title");
        assert!(
            converted
                .iter()
                .all(|t| t.get(TOOL_CHOICE_OVERRIDE_KEY).is_none()),
            "no tool may carry the override sentinel"
        );
        assert_eq!(
            tool_choice,
            Some(serde_json::json!({ "type": "function", "name": "emit_session_title" })),
            "override must map to Responses tool_choice shape"
        );
    }

    #[test]
    fn convert_tools_with_choice_defaults_to_auto_without_override() {
        let tools = vec![serde_json::json!({
            "type": "function",
            "function": { "name": "get_weather", "parameters": {} }
        })];
        let (converted, tool_choice) = convert_tools_with_choice(Some(&tools));
        assert_eq!(converted.unwrap().len(), 1);
        assert_eq!(tool_choice, Some(Value::String("auto".to_string())));
    }

    #[test]
    fn convert_tools_with_choice_none_tools_yields_none() {
        let (converted, tool_choice) = convert_tools_with_choice(None);
        assert!(converted.is_none());
        assert!(tool_choice.is_none());
    }
}
