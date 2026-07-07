//! Response parsing for OpenAI Responses API.
//!
//! Converts Responses API output items to the internal LLMResponse format.

use std::collections::HashMap;

use super::types::{ResponseItem, ResponsesResponse};
use crate::providers::traits::{
    finish_reason, usage_key, AssistantBlock, LLMResponse, ProviderError, ToolCallRequest,
};
use serde_json::Value;

pub fn response_reasoning_summary_text_from_values(summary: &[Value]) -> Vec<String> {
    summary
        .iter()
        .flat_map(reasoning_summary_text_from_value)
        .collect()
}

fn reasoning_summary_text_from_value(value: &Value) -> Vec<String> {
    if let Some(text) = value.as_str() {
        return vec![text.to_string()];
    }

    if let Some(object) = value.as_object() {
        if let Some(text) = object.get("text").and_then(Value::as_str) {
            return vec![text.to_string()];
        }
        if let Some(content) = object.get("content") {
            return reasoning_summary_text_from_value(content);
        }
    }

    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .flat_map(reasoning_summary_text_from_value)
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a Responses API response into our LLMResponse format.
///
/// `resp.output` is a `Vec<ResponseItem>` in source order. Each `Message` item
/// becomes a single `AssistantBlock::Text` (its `ResponseContent` parts are
/// the message's own internal chunks, not separate model-emitted segments —
/// they are joined into one block). Each `FunctionCall` becomes a
/// `ToolCall` block, and each `Reasoning` becomes a `Reasoning` block.
/// The resulting `blocks` therefore preserves the interleave between text,
/// reasoning, and tool calls that the model produced.
pub fn parse_response(resp: ResponsesResponse) -> Result<LLMResponse, ProviderError> {
    if let Some(err) = resp.error {
        return Err(ProviderError::RequestFailed(
            err.message
                .unwrap_or_else(|| "Unknown API error".to_string()),
        ));
    }

    let mut content_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCallRequest> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let mut blocks: Vec<AssistantBlock> = Vec::with_capacity(resp.output.len());

    for item in resp.output {
        match item {
            ResponseItem::Message(msg) => {
                let mut buf = String::new();
                for part in msg.content {
                    if part.content_type.as_deref() == Some("output_text") {
                        if let Some(text) = part.text {
                            buf.push_str(&text);
                        }
                    }
                }
                if !buf.is_empty() {
                    content_parts.push(buf.clone());
                    blocks.push(AssistantBlock::Text { text: buf });
                }
            }
            ResponseItem::FunctionCall(fc) => {
                let arguments: Value = serde_json::from_str(&fc.arguments)
                    .unwrap_or(Value::Object(serde_json::Map::new()));
                let tool_call = ToolCallRequest {
                    id: fc.call_id,
                    name: fc.name,
                    arguments,
                    thought_signature: None,
                };
                tool_calls.push(tool_call.clone());
                blocks.push(AssistantBlock::ToolCall(tool_call));
            }
            ResponseItem::Reasoning(r) => {
                let summary_text = response_reasoning_summary_text_from_values(&r.summary);
                if !summary_text.is_empty() {
                    let joined = summary_text.join("\n");
                    reasoning_parts.push(joined.clone());
                    blocks.push(AssistantBlock::Reasoning { text: joined });
                }
            }
            ResponseItem::Unknown => {}
        }
    }

    let content = if content_parts.is_empty() {
        None
    } else {
        Some(content_parts.join(""))
    };

    // Multiple Reasoning items are rare but possible — join them to keep the
    // flat reasoning_content faithful to what `blocks` carries.
    let reasoning_content = if reasoning_parts.is_empty() {
        None
    } else {
        Some(reasoning_parts.join("\n"))
    };

    let finish = if !tool_calls.is_empty() {
        finish_reason::TOOL_CALLS.to_string()
    } else {
        finish_reason::STOP.to_string()
    };

    let mut usage = HashMap::new();
    if let Some(u) = resp.usage {
        if let Some(input) = u.input_tokens {
            usage.insert(usage_key::PROMPT_TOKENS.to_string(), input);
        }
        if let Some(output) = u.output_tokens {
            usage.insert(usage_key::COMPLETION_TOKENS.to_string(), output);
        }
        if let Some(total) = u.total_tokens {
            usage.insert(usage_key::TOTAL_TOKENS.to_string(), total);
        }
        if let Some(ref details) = u.input_tokens_details {
            if details.cached_tokens > 0 {
                usage.insert(
                    usage_key::CACHE_READ_TOKENS.to_string(),
                    details.cached_tokens,
                );
            }
        }
    }

    Ok(LLMResponse {
        content,
        tool_calls,
        finish_reason: finish,
        usage,
        reasoning_content,
        blocks,
        stream_error_kind: None,
        retry_after_ms: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::responses_common::types::{
        ResponseContent, ResponseFunctionCall, ResponseMessage, ResponsesError, ResponsesUsage,
    };

    #[test]
    fn test_parse_response_with_message() {
        let resp = ResponsesResponse {
            output: vec![ResponseItem::Message(ResponseMessage {
                content: vec![ResponseContent {
                    content_type: Some("output_text".to_string()),
                    text: Some("Hello, world!".to_string()),
                }],
            })],
            usage: Some(ResponsesUsage {
                input_tokens: Some(10),
                input_tokens_details: None,
                output_tokens: Some(5),
                total_tokens: Some(15),
            }),
            error: None,
        };

        let result = parse_response(resp).unwrap();
        assert_eq!(result.content, Some("Hello, world!".to_string()));
        assert!(result.tool_calls.is_empty());
        assert_eq!(result.finish_reason, "stop");
        assert_eq!(result.usage.get("prompt_tokens"), Some(&10));
        assert_eq!(result.usage.get("completion_tokens"), Some(&5));
    }

    #[test]
    fn test_parse_response_with_function_call() {
        let resp = ResponsesResponse {
            output: vec![ResponseItem::FunctionCall(ResponseFunctionCall {
                call_id: "call_123".to_string(),
                name: "get_weather".to_string(),
                arguments: r#"{"location": "Tokyo"}"#.to_string(),
            })],
            usage: None,
            error: None,
        };

        let result = parse_response(resp).unwrap();
        assert!(result.content.is_none());
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "call_123");
        assert_eq!(result.tool_calls[0].name, "get_weather");
        assert_eq!(result.tool_calls[0].arguments["location"], "Tokyo");
        assert_eq!(result.finish_reason, "tool_calls");
    }

    #[test]
    fn test_parse_response_with_error() {
        let resp = ResponsesResponse {
            output: vec![],
            usage: None,
            error: Some(ResponsesError {
                message: Some("Rate limit exceeded".to_string()),
            }),
        };

        let result = parse_response(resp);
        assert!(result.is_err());
        match result {
            Err(ProviderError::RequestFailed(msg)) => {
                assert_eq!(msg, "Rate limit exceeded");
            }
            _ => panic!("Expected RequestFailed error"),
        }
    }

    #[test]
    fn test_parse_response_multiple_items() {
        let resp = ResponsesResponse {
            output: vec![
                ResponseItem::Message(ResponseMessage {
                    content: vec![ResponseContent {
                        content_type: Some("output_text".to_string()),
                        text: Some("Let me check ".to_string()),
                    }],
                }),
                ResponseItem::Message(ResponseMessage {
                    content: vec![ResponseContent {
                        content_type: Some("output_text".to_string()),
                        text: Some("the weather.".to_string()),
                    }],
                }),
            ],
            usage: None,
            error: None,
        };

        let result = parse_response(resp).unwrap();
        assert_eq!(
            result.content,
            Some("Let me check the weather.".to_string())
        );
    }

    /// Interleaved Text/ToolCall/Text sequence from the Responses API must be
    /// preserved verbatim in `blocks`, while flat `content` and `tool_calls`
    /// aggregates stay faithful for order-insensitive consumers.
    #[test]
    fn test_parse_response_preserves_block_order() {
        use crate::providers::traits::AssistantBlock;

        let resp = ResponsesResponse {
            output: vec![
                ResponseItem::Message(ResponseMessage {
                    content: vec![ResponseContent {
                        content_type: Some("output_text".to_string()),
                        text: Some("Let me look it up.".to_string()),
                    }],
                }),
                ResponseItem::FunctionCall(ResponseFunctionCall {
                    call_id: "call_abc".to_string(),
                    name: "search".to_string(),
                    arguments: r#"{"q": "weather"}"#.to_string(),
                }),
                ResponseItem::Message(ResponseMessage {
                    content: vec![ResponseContent {
                        content_type: Some("output_text".to_string()),
                        text: Some("Here you go.".to_string()),
                    }],
                }),
            ],
            usage: None,
            error: None,
        };

        let result = parse_response(resp).unwrap();
        assert_eq!(result.blocks.len(), 3);
        match &result.blocks[0] {
            AssistantBlock::Text { text } => assert_eq!(text, "Let me look it up."),
            _ => panic!("expected Text block first"),
        }
        match &result.blocks[1] {
            AssistantBlock::ToolCall(tc) => {
                assert_eq!(tc.name, "search");
                assert_eq!(tc.id, "call_abc");
            }
            _ => panic!("expected ToolCall block second"),
        }
        match &result.blocks[2] {
            AssistantBlock::Text { text } => assert_eq!(text, "Here you go."),
            _ => panic!("expected Text block third"),
        }

        // Flat aggregates remain consumable by order-insensitive callers.
        assert_eq!(
            result.content,
            Some("Let me look it up.Here you go.".to_string())
        );
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "call_abc");
    }
}
