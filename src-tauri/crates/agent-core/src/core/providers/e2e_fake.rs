#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use serde_json::Value;

use super::traits::{
    finish_reason, usage_key, LLMProvider, LLMResponse, ProviderError, StreamDelta, ToolCallRequest,
};

const ADDRESS_COMMENTS_MARKER: &str =
    "Teammates left review comments on this session. Address every comment below";
const ADDRESS_COMMENT_ID_MARKER: &str = " — id: ";
const REPLY_SESSION_COMMENT_TOOL: &str = "reply_session_comment";

pub const E2E_FAKE_PROVIDER_MODEL_PREFIX: &str = "e2e-fake-provider";

pub fn is_e2e_fake_provider_model(model: &str) -> bool {
    model.starts_with(E2E_FAKE_PROVIDER_MODEL_PREFIX)
}

#[derive(Debug, Default)]
pub struct E2eFakeProvider;

impl E2eFakeProvider {
    fn response_for(messages: &[Value]) -> String {
        let system_text = messages
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");

        if system_text.contains("You are a context compactor") {
            return "E2E_FAKE_COMPACT_SUMMARY: older history was compacted without carrying old full markers forward.".to_string();
        }

        let latest_user = messages
            .iter()
            .rev()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|message| message.get("content"))
            .and_then(content_text)
            .unwrap_or_default();

        format!("E2E_FAKE_PROVIDER_REPLY: {latest_user}")
    }

    fn address_comment_ids(messages: &[Value]) -> Vec<String> {
        let Some(latest_user_index) = messages
            .iter()
            .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        else {
            return Vec::new();
        };
        if messages[latest_user_index + 1..]
            .iter()
            .any(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        {
            return Vec::new();
        }
        let Some(text) = messages[latest_user_index]
            .get("content")
            .and_then(content_text)
        else {
            return Vec::new();
        };
        if !text.contains(ADDRESS_COMMENTS_MARKER) {
            return Vec::new();
        }

        let mut ids = Vec::new();
        for line in text.lines() {
            let Some((_, id)) = line.split_once(ADDRESS_COMMENT_ID_MARKER) else {
                continue;
            };
            let id = id.trim();
            if !id.is_empty() && !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
        }
        ids
    }

    fn has_tool(tools: Option<&[Value]>, name: &str) -> bool {
        tools.is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.get("name").and_then(Value::as_str) == Some(name)
                    || tool
                        .get("function")
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                        == Some(name)
            })
        })
    }

    fn address_comment_tool_calls(
        messages: &[Value],
        tools: Option<&[Value]>,
    ) -> Vec<ToolCallRequest> {
        if !Self::has_tool(tools, REPLY_SESSION_COMMENT_TOOL) {
            return Vec::new();
        }
        Self::address_comment_ids(messages)
            .into_iter()
            .enumerate()
            .map(|(index, comment_id)| ToolCallRequest {
                id: format!("e2e-reply-session-comment-{index}"),
                name: REPLY_SESSION_COMMENT_TOOL.to_string(),
                arguments: serde_json::json!({
                    "commentId": comment_id,
                    "body": format!("E2E addressed comment {comment_id}"),
                }),
                thought_signature: None,
            })
            .collect()
    }
}

fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

#[async_trait]
impl LLMProvider for E2eFakeProvider {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let tool_calls = Self::address_comment_tool_calls(messages, tools);
        let content = if tool_calls.is_empty() {
            Some(Self::response_for(messages))
        } else {
            None
        };
        let prompt_tokens = messages
            .iter()
            .map(|message| message.to_string().len() as i64 / 4)
            .sum::<i64>();
        let completion_tokens = content
            .as_deref()
            .map_or(tool_calls.len() as i64 * 12, |text| text.len() as i64 / 4)
            .max(1);
        let mut usage = HashMap::new();
        usage.insert(usage_key::PROMPT_TOKENS.to_string(), prompt_tokens);
        usage.insert(usage_key::COMPLETION_TOKENS.to_string(), completion_tokens);
        usage.insert(
            usage_key::TOTAL_TOKENS.to_string(),
            prompt_tokens + completion_tokens,
        );

        Ok(LLMResponse {
            content,
            finish_reason: if tool_calls.is_empty() {
                finish_reason::STOP.to_string()
            } else {
                finish_reason::TOOL_CALLS.to_string()
            },
            tool_calls,
            usage,
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        if cancel_flag.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err(ProviderError::Cancelled);
        }

        let response = self
            .chat(messages, tools, model, max_tokens, temperature)
            .await?;
        if let Some(content) = response.content.clone() {
            on_delta(StreamDelta {
                content: Some(content),
                reasoning: None,
                tool_call_delta: None,
                finish_reason: None,
                usage: None,
            });
        }
        on_delta(StreamDelta {
            content: None,
            reasoning: None,
            tool_call_delta: None,
            finish_reason: Some(response.finish_reason.clone()),
            usage: Some(response.usage.clone()),
        });
        Ok(response)
    }

    fn default_model(&self) -> &str {
        E2E_FAKE_PROVIDER_MODEL_PREFIX
    }

    fn provider_name(&self) -> &str {
        "e2e_fake_provider"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply_tool() -> Value {
        json!({
            "type": "function",
            "function": { "name": REPLY_SESSION_COMMENT_TOOL }
        })
    }

    #[test]
    fn address_comments_briefing_emits_one_tool_call_per_comment() {
        let messages = vec![json!({
            "role": "user",
            "content": format!(
                "{ADDRESS_COMMENTS_MARKER}.\n### Comment 1 — id: c-1\n### Comment 2 — id: c-2"
            )
        })];

        let calls = E2eFakeProvider::address_comment_tool_calls(&messages, Some(&[reply_tool()]));

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, REPLY_SESSION_COMMENT_TOOL);
        assert_eq!(calls[0].arguments["commentId"], "c-1");
        assert_eq!(calls[1].arguments["commentId"], "c-2");
    }

    #[test]
    fn tool_result_stops_the_fake_provider_from_repeating_replies() {
        let messages = vec![
            json!({
                "role": "user",
                "content": format!("{ADDRESS_COMMENTS_MARKER}.\n### Comment 1 — id: c-1")
            }),
            json!({
                "role": "tool",
                "tool_call_id": "e2e-reply-session-comment-0",
                "content": "ok"
            }),
        ];

        assert!(
            E2eFakeProvider::address_comment_tool_calls(&messages, Some(&[reply_tool()]))
                .is_empty()
        );
    }

    #[test]
    fn ordinary_fake_provider_prompts_never_gain_comment_tool_calls() {
        let messages = vec![json!({ "role": "user", "content": "fix the tests" })];

        assert!(
            E2eFakeProvider::address_comment_tool_calls(&messages, Some(&[reply_tool()]))
                .is_empty()
        );
    }
}
