#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use serde_json::Value;

use super::traits::{
    finish_reason, usage_key, LLMProvider, LLMResponse, ProviderError, StreamDelta,
};

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
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: Option<u32>,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let content = Self::response_for(messages);
        let prompt_tokens = messages
            .iter()
            .map(|message| message.to_string().len() as i64 / 4)
            .sum::<i64>();
        let completion_tokens = (content.len() as i64 / 4).max(1);
        let mut usage = HashMap::new();
        usage.insert(usage_key::PROMPT_TOKENS.to_string(), prompt_tokens);
        usage.insert(usage_key::COMPLETION_TOKENS.to_string(), completion_tokens);
        usage.insert(
            usage_key::TOTAL_TOKENS.to_string(),
            prompt_tokens + completion_tokens,
        );

        Ok(LLMResponse {
            content: Some(content),
            tool_calls: Vec::new(),
            finish_reason: finish_reason::STOP.to_string(),
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
        max_tokens: Option<u32>,
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
