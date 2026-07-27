//! Non-streaming `chat()` implementation for OpenAI-compatible providers.

use serde_json::Value;
use tracing::{info, warn};

use super::super::client::OpenAICompatClient;
use super::super::types::{ChatCompletionRequest, ChatCompletionResponse, RequestBuilderExt};
use super::think_split::ThinkTagSplitter;
use super::translate_tool_choice_for_openai;
use crate::providers::openai_policy::ChatTokenLimitField;
use crate::providers::registry::provider_id;
use crate::providers::safe_truncate::safe_truncate_utf8;
use crate::providers::traits::{finish_reason as finish, LLMResponse, ProviderError};
use crate::providers::wire_sanitize::{
    coalesce_system_messages_to_front, sanitize_deepseek_messages, sanitize_openai_compat_messages,
    strip_tool_schema_cache_scopes,
};
use crate::utils::http_retry::extract_retry_after_secs;

pub(super) async fn run_chat(
    this: &OpenAICompatClient,
    messages: &[Value],
    tools: Option<&[Value]>,
    model: &str,
    max_tokens: u32,
    _temperature: f32,
) -> Result<LLMResponse, ProviderError> {
    // Azure gateway: strip provider prefix but don't add litellm prefix.
    // The Azure endpoint expects the bare deployment/model name.
    let resolved_model = if this.config.is_azure {
        this.strip_provider_prefix(model)
    } else {
        crate::providers::model_hints::wire_model_name(this.provider_spec, model)
    };

    // Strip the reasoning-level suffix ORG2 encodes into variant ids and
    // resolve `reasoning_effort` (OpenAI) or the `thinking` toggle (Zhipu
    // GLM). Shared with the streaming path via `resolve_openai_compat_thinking`.
    let crate::providers::thinking_mode::OpenAiCompatThinking {
        base_model,
        reasoning_effort,
        thinking,
    } = crate::providers::thinking_mode::resolve_openai_compat_thinking(
        &resolved_model,
        this.provider_spec.name,
    );

    let sanitized_messages = sanitize_openai_compat_messages(messages);
    let wire_messages = if this.provider_spec.name == provider_id::DEEPSEEK {
        sanitize_deepseek_messages(&sanitized_messages)
    } else {
        super::super::wire_expand::expand_tool_images_for_openai_wire(&sanitized_messages)
    };
    // vLLM strictly requires a single `system` message at index 0; ORGII emits
    // several inline system messages, so coalesce them on the vLLM path only.
    let wire_messages = if this.provider_spec.name == provider_id::VLLM {
        coalesce_system_messages_to_front(wire_messages)
    } else {
        wire_messages
    };

    info!(
        "LLM call: provider={}, model={}, messages={} (wire={}), tools={}, azure_gw={}",
        this.provider_spec.name,
        resolved_model,
        messages.len(),
        wire_messages.len(),
        tools.map_or(0, |t| t.len()),
        this.config.is_azure,
    );

    let wire_tools = tools.map(strip_tool_schema_cache_scopes);
    // Extract forced tool_choice from side_query structured output
    let (tool_choice_override, clean_wire_tools) = if let Some(ref wt) = wire_tools {
        let (ovr, cleaned) = crate::core::side_query::extract_tool_choice_override(wt);
        (ovr, Some(cleaned))
    } else {
        (None, None)
    };
    let wire_tools_final = clean_wire_tools.or(wire_tools);

    let wire_policy = this.chat_wire_policy(&base_model);
    let request_body = ChatCompletionRequest {
        model: base_model.clone(),
        messages: wire_messages,
        tools: wire_tools_final,
        tool_choice: if let Some(ovr) = tool_choice_override {
            // Map Anthropic-style {"type":"tool","name":"x"} → OpenAI {"type":"function","function":{"name":"x"}}
            Some(translate_tool_choice_for_openai(&ovr))
        } else if wire_policy.send_tool_choice_auto {
            tools.map(|_| Value::String("auto".to_string()))
        } else {
            None
        },
        max_tokens: match wire_policy.token_limit_field {
            ChatTokenLimitField::MaxTokens => Some(max_tokens),
            ChatTokenLimitField::MaxCompletionTokens => None,
        },
        max_completion_tokens: match wire_policy.token_limit_field {
            ChatTokenLimitField::MaxTokens => None,
            ChatTokenLimitField::MaxCompletionTokens => Some(max_tokens),
        },
        temperature: if wire_policy.send_temperature {
            Some(_temperature)
        } else {
            None
        },
        stream: false,
        stream_options: None,
        reasoning_effort,
        thinking,
    };

    let url = this.chat_url(&base_model);
    let mut request = this
        .client
        .post(&url)
        .header("Content-Type", "application/json")
        .bearer_token(&this.config.api_key);

    for (key, value) in &this.config.extra_headers {
        request = request.header(key, value);
    }

    if this.is_azure() {
        request = request.header("api-key", &this.config.api_key);
    } else if this.provider_spec.name == crate::providers::registry::provider_id::ANTHROPIC {
        request = request
            .header("x-api-key", &this.config.api_key)
            .header("anthropic-version", "2023-06-01");
    }

    let response = request
        .json(&request_body)
        .send()
        .await
        .map_err(|err| ProviderError::RequestFailed(err.to_string()))?;

    let status = response.status().as_u16();
    let retry_after = extract_retry_after_secs(&response);
    let body = response
        .text()
        .await
        .map_err(|err| ProviderError::ParseError(err.to_string()))?;

    if status != 200 {
        return Err(OpenAICompatClient::parse_error_response(
            status,
            &body,
            retry_after,
        ));
    }

    // Some proxies ignore `stream: false` and return SSE chunks anyway.
    // Detect this and reassemble into a single ChatCompletionResponse.
    if body.starts_with("data:") {
        warn!("Provider returned SSE stream despite stream:false — reassembling chunks");
        return OpenAICompatClient::reassemble_sse_to_response(&body);
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&body).map_err(|err| {
        ProviderError::ParseError(format!(
            "Failed to parse response: {}. Body: {}",
            err,
            safe_truncate_utf8(&body, 500)
        ))
    })?;

    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| ProviderError::ParseError("No choices in response".to_string()))?;

    let usage = parsed
        .usage
        .map(|api_usage| api_usage.to_usage_map())
        .unwrap_or_default();

    let tool_calls = choice
        .message
        .tool_calls
        .as_ref()
        .map(|tcs| OpenAICompatClient::parse_tool_calls(tcs))
        .unwrap_or_default();

    // Demux inline `<think>…</think>` reasoning out of the message content.
    // Mirrors the same logic used in `sse_stream::run_chat_streaming` so the
    // streaming and non-streaming paths surface reasoning identically.
    let (content, reasoning_content) =
        split_inline_thinking(choice.message.content, choice.message.reasoning_content);

    let response = LLMResponse {
        content,
        tool_calls,
        finish_reason: choice
            .finish_reason
            .unwrap_or_else(|| finish::STOP.to_string()),
        usage,
        reasoning_content,
        blocks: Vec::new(),
        stream_error_kind: None,
        retry_after_ms: None,
    };

    info!(
        "LLM response: finish_reason={}, tool_calls={}, content_len={}",
        response.finish_reason,
        response.tool_calls.len(),
        response.content.as_ref().map_or(0, |c| c.len()),
    );

    Ok(response)
}

/// Split inline `<think>…</think>` blocks out of `content` into the reasoning
/// channel. If `existing_reasoning` is already populated the splitter still
/// runs on `content` (some providers do both — DeepSeek-R1 always uses
/// `reasoning_content`, but a relay forwarding from a model that uses inline
/// tags may pass them through unchanged regardless), and inline reasoning is
/// appended after the existing buffer.
fn split_inline_thinking(
    content: Option<String>,
    existing_reasoning: Option<String>,
) -> (Option<String>, Option<String>) {
    let Some(content) = content else {
        return (None, existing_reasoning);
    };

    let mut splitter = ThinkTagSplitter::new();
    let split = splitter.push(&content);
    let tail = splitter.flush();

    let mut new_content = split.content;
    new_content.push_str(&tail.content);

    let mut new_reasoning = split.reasoning;
    new_reasoning.push_str(&tail.reasoning);

    // No inline `<think>` actually fired — keep the input untouched so we
    // don't accidentally drop trailing whitespace that the splitter's
    // tag-tracking might have shuffled around.
    if !splitter.saw_think_tag() {
        return (Some(content), existing_reasoning);
    }

    let merged_reasoning = match (existing_reasoning, new_reasoning.is_empty()) {
        (Some(prev), true) => Some(prev),
        (Some(prev), false) => Some(format!("{prev}\n{new_reasoning}")),
        (None, true) => None,
        (None, false) => Some(new_reasoning),
    };

    let content_out = if new_content.is_empty() {
        None
    } else {
        Some(new_content)
    };

    (content_out, merged_reasoning)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::registry::{find_by_name, provider_id};
    use crate::providers::traits::{usage_key, LLMProvider, ProviderConfig};
    use std::collections::HashMap;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn non_streaming_standard_usage_normalizes_cached_tokens() {
        crate::test_support::install_crypto_provider_for_tests();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"content": "ok"},
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 1200,
                    "completion_tokens": 300,
                    "total_tokens": 1500,
                    "prompt_tokens_details": {"cached_tokens": 800}
                }
            })))
            .mount(&server)
            .await;

        let spec = find_by_name(provider_id::OPENAI).expect("OpenAI provider registered");
        let client = OpenAICompatClient::new(
            ProviderConfig {
                api_key: "test-key".to_string(),
                api_base: Some(server.uri()),
                extra_headers: HashMap::new(),
                is_azure: false,
            },
            spec,
            "gpt-4.1".to_string(),
        );

        let response = client
            .chat(
                &[serde_json::json!({"role": "user", "content": "hello"})],
                None,
                "gpt-4.1",
                1024,
                0.0,
            )
            .await
            .expect("OpenAI-compatible response should parse");

        assert_eq!(response.usage[usage_key::PROMPT_TOKENS], 400);
        assert_eq!(response.usage[usage_key::COMPLETION_TOKENS], 300);
        assert_eq!(response.usage[usage_key::TOTAL_TOKENS], 1500);
        assert_eq!(response.usage[usage_key::CACHE_READ_TOKENS], 800);
        assert!(!response.usage.contains_key(usage_key::CACHE_WRITE_TOKENS));
    }
}
