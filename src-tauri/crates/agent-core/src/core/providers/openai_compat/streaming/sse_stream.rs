//! Streaming `chat_streaming()` implementation for OpenAI-compatible providers.
//!
//! Parses `data: …` SSE lines from `/v1/chat/completions?stream=true`
//! into the shared `StreamEvent` type. Handles `tool_calls` deltas,
//! `content` deltas, the `[DONE]` sentinel, idle timeouts, and provider
//! error frames. Reassembly logic for incomplete tool calls and parse
//! error classification live in sibling modules (`parse`,
//! `index_resolver`, `error_classify`).

use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use tracing::{debug, info, warn};

use super::super::client::OpenAICompatClient;
use super::super::types::{ChatCompletionRequest, RequestBuilderExt, StreamChunk};
use super::error_classify::{looks_overloaded, parse_retry_after_ms};
use super::index_resolver::resolve_tool_call_index;
use super::parse::{build_stream_parse_error_args, parse_streamed_tool_args, ParsedToolArgs};
use super::think_split::ThinkTagSplitter;
use super::translate_tool_choice_for_openai;
use crate::providers::openai_policy::ChatTokenLimitField;
use crate::providers::registry::provider_id;
use crate::providers::safe_truncate::safe_truncate_utf8;
use crate::providers::traits::{
    finish_reason as finish, LLMResponse, ProviderError, StreamDelta, StreamErrorKind,
    ToolCallDelta, ToolCallRequest,
};
use crate::providers::wire_sanitize::{
    coalesce_system_messages_to_front, sanitize_deepseek_messages, sanitize_openai_compat_messages,
    strip_tool_schema_cache_scopes,
};
use crate::utils::http_retry::extract_retry_after_secs;

fn finish_reason_after_incomplete_tool_calls(
    finish_reason: String,
    tool_call_count: usize,
    incomplete_tool_call_count: usize,
) -> (String, Option<StreamErrorKind>) {
    if finish_reason == finish::TOOL_CALLS && tool_call_count == 0 && incomplete_tool_call_count > 0
    {
        (
            finish::STREAM_ERROR.to_string(),
            Some(StreamErrorKind::ProviderError),
        )
    } else {
        (finish_reason, None)
    }
}

// Mirrors the `LLMProvider::chat_streaming` trait signature (8 args). The
// trait method itself triggers the same warning at the call site; allow
// here so the free function shape stays 1:1 with the trait.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_chat_streaming(
    this: &OpenAICompatClient,
    messages: &[Value],
    tools: Option<&[Value]>,
    model: &str,
    max_tokens: u32,
    _temperature: f32,
    on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
    cancel_flag: Option<&std::sync::atomic::AtomicBool>,
) -> Result<LLMResponse, ProviderError> {
    use futures_util::StreamExt;

    let resolved_model = if this.config.is_azure {
        this.strip_provider_prefix(model)
    } else {
        crate::providers::model_hints::wire_model_name(this.provider_spec, model)
    };

    let url = this.chat_url(&resolved_model);

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
        "LLM streaming call: provider={}, model={}, url={}, messages={} (wire={}), tools={}, azure_gw={}",
        this.provider_spec.name,
        resolved_model,
        url,
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

    let wire_policy = this.chat_wire_policy(&resolved_model);
    let request_body = ChatCompletionRequest {
        model: resolved_model.clone(),
        messages: wire_messages,
        tools: wire_tools_final,
        tool_choice: if let Some(ovr) = tool_choice_override {
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
        stream: true,
        stream_options: if wire_policy.send_stream_options {
            Some(serde_json::json!({"include_usage": true}))
        } else {
            None
        },
    };

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

    let send_future = request.json(&request_body).send();
    let response = if let Some(flag) = cancel_flag {
        tokio::select! {
            result = send_future => result.map_err(|err| ProviderError::RequestFailed(err.to_string()))?,
            _ = async {
                while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            } => {
                tracing::info!(
                    "[openai-compat] Request cancelled before stream response (model={})",
                    resolved_model
                );
                return Err(ProviderError::Cancelled);
            }
        }
    } else {
        send_future
            .await
            .map_err(|err| ProviderError::RequestFailed(err.to_string()))?
    };

    let status = response.status().as_u16();
    if status != 200 {
        let retry_after = extract_retry_after_secs(&response);
        let body = crate::utils::response_text_or_read_error(response).await;
        tracing::error!(
            "LLM streaming error: HTTP {} from {} | model={} | body: {}",
            status,
            url,
            resolved_model,
            safe_truncate_utf8(&body, 1000)
        );
        return Err(OpenAICompatClient::parse_error_response(
            status,
            &body,
            retry_after,
        ));
    }

    // Process SSE stream
    let mut accumulated_content = String::new();
    let mut accumulated_reasoning = String::new();
    // Demuxes inline `<think>…</think>` reasoning out of `delta.content` for
    // providers that don't use the separate `reasoning_content` channel (QwQ,
    // some vLLM/SGLang builds, soydrelay/vincetest1, …). Stateful across chunks
    // because a tag may straddle the SSE frame boundary. Providers that already
    // emit `reasoning_content` are unaffected: the splitter only fires when it
    // actually sees a `<think>` open tag in `delta.content`.
    let mut think_splitter = ThinkTagSplitter::new();
    let mut tool_call_accumulators: HashMap<usize, (String, String, String, Option<Value>)> =
        HashMap::new(); // index -> (id, name, args, thought_signature)
                        // Tracks the index we will assign to an index-less continuation
                        // delta. Seeded to None; set whenever we observe an explicit
                        // `index` on a chunk or allocate a new slot for a chunk carrying
                        // `id`+`function.name`. See `resolve_tool_call_index` for the
                        // full rationale — this exists to defend against providers that
                        // omit `index` on follow-up chunks, which was previously
                        // collapsed to 0 and caused multi-tool argument collisions.
    let mut last_tool_call_index: Option<usize> = None;
    let mut finish_reason = finish::STOP.to_string();
    // Sub-classification for STREAM_ERROR. `None` whenever finish_reason is
    // anything other than STREAM_ERROR. Populated at each break point below
    // so the turn_executor retry layer can pick the right backoff policy.
    let mut stream_error_kind: Option<StreamErrorKind> = None;
    // Provider-supplied retry floor in ms, pulled from the SSE error body
    // when present. Acts as a lower bound on the retry layer's backoff so
    // a server directive of e.g. 60s is honored instead of being capped
    // at our 32s exponential ceiling. The floor is taken verbatim — we
    // never shorten a server-requested wait, only lengthen it via our
    // own exponential backoff.
    let mut stream_retry_after_ms: Option<u64> = None;
    let mut final_usage = HashMap::new();

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut stream_done = false;
    let mut unknown_frame_count = 0usize;

    const CHUNK_READ_TIMEOUT: Duration = Duration::from_secs(90);

    loop {
        let chunk_result = match tokio::time::timeout(CHUNK_READ_TIMEOUT, stream.next()).await {
            Ok(Some(result)) => result,
            Ok(None) => break, // stream ended
            Err(_elapsed) => {
                let has_partial_data = !accumulated_content.is_empty()
                    || !accumulated_reasoning.is_empty()
                    || !tool_call_accumulators.is_empty();
                warn!(
                    "LLM stream chunk timeout after {}s (provider={}, model={}, partial={})",
                    CHUNK_READ_TIMEOUT.as_secs(),
                    this.provider_spec.name,
                    resolved_model,
                    has_partial_data
                );
                if has_partial_data {
                    finish_reason = finish::STREAM_ERROR.to_string();
                    stream_error_kind = Some(StreamErrorKind::IdleTimeout);
                    break;
                }
                return Err(ProviderError::RequestFailed(format!(
                    "LLM stream timed out: no data received for {}s",
                    CHUNK_READ_TIMEOUT.as_secs()
                )));
            }
        };

        if let Some(flag) = cancel_flag {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                info!(
                    "[openai-compat] Stream cancelled by user (provider={}, model={})",
                    this.provider_spec.name, resolved_model
                );
                drop(stream);
                return Err(ProviderError::Cancelled);
            }
        }

        let chunk = match chunk_result {
            Ok(bytes) => bytes,
            Err(err) => {
                let has_partial_data = !accumulated_content.is_empty()
                    || !accumulated_reasoning.is_empty()
                    || !tool_call_accumulators.is_empty();
                if has_partial_data {
                    warn!(
                        "LLM stream interrupted after partial output (provider={}, model={}): {}",
                        this.provider_spec.name, resolved_model, err
                    );
                    finish_reason = finish::STREAM_ERROR.to_string();
                    // `reqwest::Error` from the body stream is almost always a
                    // transport-level drop (TCP reset, TLS error, peer hangup).
                    // Provider-level error frames (`data: {"error": ...}`) are
                    // handled explicitly inside the SSE parse loop below and
                    // produce `StreamErrorKind::{ProviderError, Overloaded}`.
                    stream_error_kind = Some(StreamErrorKind::ConnectionError);
                    break;
                }
                return Err(ProviderError::RequestFailed(format!(
                    "Stream error: {}",
                    err
                )));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if !line.starts_with("data:") {
                continue;
            }

            let data = line["data:".len()..].trim_start();
            if data == "[DONE]" {
                stream_done = true;
                break;
            }

            // Provider-level error frame. OpenAI-compatible providers surface
            // upstream 5xx/529/timeout as a single SSE frame of the shape
            //   `data: {"error": {"message": "...", "type": "..."}}`
            // before closing the stream (or sometimes mid-stream). Without
            // an explicit check here, `serde_json::from_str::<StreamChunk>`
            // fails to match any of the known chunk shapes, we `continue`,
            // and the error is silently eaten — the stream then either
            // closes normally (so turn_executor sees `finish_reason = stop`
            // with no content) or hits the idle watchdog 90s later. Neither
            // path is retried as a ProviderError. Detect it explicitly so
            // the retry layer can classify.
            if data.trim_start().starts_with("{\"error\"")
                || serde_json::from_str::<serde_json::Value>(data)
                    .ok()
                    .and_then(|v| v.get("error").cloned())
                    .is_some()
            {
                warn!(
                    "LLM stream received provider error frame (provider={}, model={}): {}",
                    this.provider_spec.name,
                    resolved_model,
                    &data[..data.len().min(400)]
                );
                finish_reason = finish::STREAM_ERROR.to_string();
                // Classify overload vs generic provider error so the
                // retry layer can pick the right backoff: overload gets
                // a longer, jittered wait (capacity needs time to free
                // up); generic provider errors get our standard
                // exponential schedule. Detection accepts HTTP 529, the
                // canonical `"type":"overloaded_error"` body marker, and
                // a looser `"overloaded"` substring to catch vendor
                // wrappers (OpenRouter, proxies, etc.) that reshape the
                // payload but preserve the keyword.
                let is_overloaded = looks_overloaded(data);
                stream_error_kind = Some(if is_overloaded {
                    StreamErrorKind::Overloaded
                } else {
                    StreamErrorKind::ProviderError
                });
                // Parse an embedded retry floor so turn_executor can
                // honor e.g. `{"error":{"retry_after":60}}` instead of
                // capping at our exponential ceiling.
                stream_retry_after_ms = parse_retry_after_ms(data);
                if let Some(ms) = stream_retry_after_ms {
                    warn!(
                        "LLM stream error frame provided retry floor: {}ms (kind={:?})",
                        ms, stream_error_kind
                    );
                }
                stream_done = true;
                break;
            }

            let chunk = match serde_json::from_str::<StreamChunk>(data) {
                Ok(chunk) => chunk,
                Err(error) => {
                    unknown_frame_count += 1;
                    warn!(
                        provider = this.provider_spec.name,
                        model = resolved_model,
                        error = %error,
                        sample = %safe_truncate_utf8(data, 500),
                        "OpenAI-compatible stream emitted unparsed data frame"
                    );
                    continue;
                }
            };

            for choice in &chunk.choices {
                // Content delta — demux inline `<think>…</think>` reasoning
                // before fanning out. Most providers' chunks have no `<` and
                // pass through the splitter's fast path with zero overhead.
                if let Some(ref content) = choice.delta.content {
                    let split = think_splitter.push(content);
                    if !split.content.is_empty() {
                        accumulated_content.push_str(&split.content);
                        on_delta(StreamDelta {
                            content: Some(split.content),
                            reasoning: None,
                            tool_call_delta: None,
                            finish_reason: None,
                            usage: None,
                        });
                    }
                    if !split.reasoning.is_empty() {
                        accumulated_reasoning.push_str(&split.reasoning);
                        on_delta(StreamDelta {
                            content: None,
                            reasoning: Some(split.reasoning),
                            tool_call_delta: None,
                            finish_reason: None,
                            usage: None,
                        });
                    }
                }

                // Reasoning content delta
                if let Some(ref reasoning) = choice.delta.reasoning_content {
                    accumulated_reasoning.push_str(reasoning);
                    on_delta(StreamDelta {
                        content: None,
                        reasoning: Some(reasoning.clone()),
                        tool_call_delta: None,
                        finish_reason: None,
                        usage: None,
                    });
                }

                // Tool call deltas
                if let Some(ref tool_calls) = choice.delta.tool_calls {
                    for tc_delta in tool_calls {
                        let has_id = tc_delta.id.is_some();
                        let has_name = tc_delta
                            .function
                            .as_ref()
                            .and_then(|f| f.name.as_ref())
                            .is_some();
                        let existing_indices: Vec<usize> =
                            tool_call_accumulators.keys().copied().collect();
                        let index = resolve_tool_call_index(
                            tc_delta.index,
                            has_id,
                            has_name,
                            last_tool_call_index,
                            &existing_indices,
                        );
                        last_tool_call_index = Some(index);
                        let entry = tool_call_accumulators
                            .entry(index)
                            .or_insert_with(|| (String::new(), String::new(), String::new(), None));

                        if let Some(ref id) = tc_delta.id {
                            entry.0 = id.clone();
                        }
                        if let Some(ref func) = tc_delta.function {
                            if let Some(ref name) = func.name {
                                entry.1 = name.clone();
                            }
                            if let Some(ref args) = func.arguments {
                                entry.2.push_str(args);
                            }
                        }
                        if let Some(sig) = tc_delta
                            .extra_content
                            .as_ref()
                            .and_then(|ec| ec.thought_signature().cloned())
                        {
                            entry.3 = Some(sig);
                        }

                        on_delta(StreamDelta {
                            content: None,
                            reasoning: None,
                            tool_call_delta: Some(ToolCallDelta {
                                index,
                                id: tc_delta.id.clone(),
                                name: tc_delta.function.as_ref().and_then(|f| f.name.clone()),
                                arguments_delta: tc_delta
                                    .function
                                    .as_ref()
                                    .and_then(|f| f.arguments.clone()),
                            }),
                            finish_reason: None,
                            usage: None,
                        });
                    }
                }

                // Finish reason
                if let Some(ref reason) = choice.finish_reason {
                    finish_reason = reason.clone();
                }
            }

            // Usage (usually on final chunk when stream_options.include_usage=true)
            if let Some(ref usage) = chunk.usage {
                debug!(
                    "[streaming-usage] OpenAI chunk usage: prompt={}, completion={}, total={}",
                    usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
                );
                final_usage.insert("prompt_tokens".to_string(), usage.prompt_tokens);
                final_usage.insert("completion_tokens".to_string(), usage.completion_tokens);
                final_usage.insert("total_tokens".to_string(), usage.total_tokens);
            }
        }
        if stream_done {
            break;
        }
    }

    // Drain any bytes held inside the think-tag splitter — a server crash
    // mid-stream may leave us with an unclosed `<think>` carry. Better to
    // surface partial reasoning than to silently drop it.
    let tail = think_splitter.flush();
    if !tail.content.is_empty() {
        accumulated_content.push_str(&tail.content);
        on_delta(StreamDelta {
            content: Some(tail.content),
            reasoning: None,
            tool_call_delta: None,
            finish_reason: None,
            usage: None,
        });
    }
    if !tail.reasoning.is_empty() {
        accumulated_reasoning.push_str(&tail.reasoning);
        on_delta(StreamDelta {
            content: None,
            reasoning: Some(tail.reasoning),
            tool_call_delta: None,
            finish_reason: None,
            usage: None,
        });
    }

    // Assemble final tool calls — treat incomplete entries as stream errors.
    let mut tool_calls: Vec<ToolCallRequest> = Vec::new();
    let mut incomplete_tool_call_count = 0usize;
    let mut indices: Vec<usize> = tool_call_accumulators.keys().cloned().collect();
    indices.sort();
    for index in indices {
        if let Some((id, name, args_str, thought_signature)) = tool_call_accumulators.remove(&index)
        {
            if id.is_empty() || name.is_empty() {
                incomplete_tool_call_count += 1;
                warn!(
                    "Discarding incomplete tool call at index {} (missing id/name)",
                    index
                );
                continue;
            }
            let arguments: Value = match parse_streamed_tool_args(&args_str) {
                ParsedToolArgs::Ok(v) => v,
                ParsedToolArgs::Failed { cause, parse_err } => {
                    // Truncate args for log readability; cap at safe UTF-8 boundary.
                    let mut preview_end = args_str.len().min(512);
                    while preview_end > 0 && !args_str.is_char_boundary(preview_end) {
                        preview_end -= 1;
                    }
                    let preview = &args_str[..preview_end];
                    let total_len = args_str.len();

                    warn!(
                        "Failed to parse streamed tool call arguments for '{}' \
                         (index={}, len={}, cause={}): {} | preview={:?}",
                        name, index, total_len, cause, parse_err, preview
                    );
                    build_stream_parse_error_args(cause, &parse_err.to_string(), preview, total_len)
                }
            };
            tool_calls.push(ToolCallRequest {
                id,
                name,
                arguments,
                thought_signature,
            });
        }
    }

    if unknown_frame_count > 0 {
        warn!(
            provider = this.provider_spec.name,
            model = resolved_model,
            unknown_frame_count,
            "OpenAI-compatible stream completed with unparsed data frame(s)"
        );
    }

    let (resolved_finish_reason, malformed_tool_stream_kind) =
        finish_reason_after_incomplete_tool_calls(
            finish_reason.clone(),
            tool_calls.len(),
            incomplete_tool_call_count,
        );
    if let Some(kind) = malformed_tool_stream_kind {
        warn!(
            provider = this.provider_spec.name,
            model = resolved_model,
            incomplete_tool_call_count,
            "OpenAI-compatible stream ended with only incomplete tool call(s)"
        );
        finish_reason = resolved_finish_reason;
        stream_error_kind = Some(kind);
    }

    // Send final delta with finish reason
    on_delta(StreamDelta {
        content: None,
        reasoning: None,
        tool_call_delta: None,
        finish_reason: Some(finish_reason.clone()),
        usage: Some(final_usage.clone()),
    });

    let content = if accumulated_content.is_empty() {
        None
    } else {
        Some(accumulated_content)
    };
    let reasoning = if accumulated_reasoning.is_empty() {
        None
    } else {
        Some(accumulated_reasoning)
    };

    info!(
        "LLM stream complete: finish_reason={}, tool_calls={}, content_len={}, usage={:?}",
        finish_reason,
        tool_calls.len(),
        content.as_ref().map_or(0, |c| c.len()),
        final_usage,
    );

    Ok(LLMResponse {
        content,
        tool_calls,
        finish_reason,
        usage: final_usage,
        reasoning_content: reasoning,
        blocks: Vec::new(),
        stream_error_kind,
        retry_after_ms: stream_retry_after_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::registry::{find_by_name, provider_id};
    use crate::providers::traits::{LLMProvider, ProviderConfig};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn malformed_only_tool_call_finish_becomes_stream_error() {
        let (finish_reason, kind) =
            finish_reason_after_incomplete_tool_calls(finish::TOOL_CALLS.to_string(), 0, 2);

        assert_eq!(finish_reason, finish::STREAM_ERROR);
        assert_eq!(kind, Some(StreamErrorKind::ProviderError));
    }

    #[test]
    fn parsed_tool_calls_keep_tool_call_finish() {
        let (finish_reason, kind) =
            finish_reason_after_incomplete_tool_calls(finish::TOOL_CALLS.to_string(), 1, 1);

        assert_eq!(finish_reason, finish::TOOL_CALLS);
        assert_eq!(kind, None);
    }

    #[test]
    fn non_tool_finish_ignores_incomplete_tool_count() {
        let (finish_reason, kind) =
            finish_reason_after_incomplete_tool_calls(finish::STOP.to_string(), 0, 1);

        assert_eq!(finish_reason, finish::STOP);
        assert_eq!(kind, None);
    }

    #[tokio::test]
    async fn stream_with_only_incomplete_tool_calls_returns_stream_error_response() {
        crate::test_support::install_crypto_provider_for_tests();

        let server = MockServer::start().await;
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"src/main.rs\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;

        let spec = find_by_name(provider_id::OPENCODE).expect("opencode provider registered");
        let client = OpenAICompatClient::new(
            ProviderConfig {
                api_key: "test-key".to_string(),
                api_base: Some(server.uri()),
                extra_headers: HashMap::new(),
                is_azure: false,
            },
            spec,
            "test-model".to_string(),
        );

        let response = client
            .chat_streaming(
                &[serde_json::json!({"role": "user", "content": "read the file"})],
                Some(&[serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "parameters": {"type": "object", "properties": {}}
                    }
                })]),
                "test-model",
                1024,
                0.0,
                &|_| {},
                None,
            )
            .await
            .expect("stream should parse into a response");

        assert_eq!(response.finish_reason, finish::STREAM_ERROR);
        assert_eq!(
            response.stream_error_kind,
            Some(StreamErrorKind::ProviderError)
        );
        assert!(response.tool_calls.is_empty());
        assert_eq!(response.content, None);
    }
}
