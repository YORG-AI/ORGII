//! Streaming response handler for the OpenAI Responses API (public API).
//!
//! Parses server-sent events from the `/v1/responses` endpoint.
//! Event format matches the Codex native backend but with full parameter support.

use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use tracing::{debug, info, warn};

use super::client::OpenAIResponsesClient;
use crate::providers::responses_common::{
    parse_response, ResponsesResponse, ResponsesStreamNormalizer, ResponsesStreamOutput,
};
use crate::providers::traits::{
    finish_reason as finish, AssistantBlock, LLMProvider, LLMResponse, ProviderError, StreamDelta,
    StreamErrorKind, ToolCallDelta, ToolCallRequest,
};

#[async_trait]
impl LLMProvider for OpenAIResponsesClient {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let request_body =
            Self::build_responses_request(messages, tools, model, max_tokens, _temperature, false);

        let url = self.responses_url();
        info!(
            "[openai-responses] Non-streaming request to {}, model={}",
            url, model
        );

        let response = self
            .build_request(&url, &request_body)?
            .send()
            .await
            .map_err(|err| ProviderError::RequestFailed(err.to_string()))?;

        let status = response.status();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let body = response
            .text()
            .await
            .map_err(|err| ProviderError::ParseError(err.to_string()))?;

        if !status.is_success() {
            return Err(Self::parse_error(status.as_u16(), &body, retry_after));
        }

        debug!(
            "[openai-responses] Response body: {}",
            &body[..body.len().min(500)]
        );

        let resp: ResponsesResponse = serde_json::from_str(&body)
            .map_err(|err| ProviderError::ParseError(format!("JSON parse error: {}", err)))?;

        parse_response(resp)
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        _temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        use futures_util::StreamExt;

        let request_body =
            Self::build_responses_request(messages, tools, model, max_tokens, _temperature, true);

        let url = self.responses_url();
        info!(
            "[openai-responses] Streaming request to {}, model={}, messages={}",
            url,
            model,
            messages.len()
        );

        let send_future = self.build_request(&url, &request_body)?.send();
        let response = if let Some(flag) = cancel_flag {
            tokio::select! {
                result = send_future => result.map_err(|err| ProviderError::RequestFailed(err.to_string()))?,
                _ = async {
                    while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                } => {
                    info!("[openai-responses] Request cancelled before stream response (model={})", model);
                    return Err(ProviderError::Cancelled);
                }
            }
        } else {
            send_future
                .await
                .map_err(|err| ProviderError::RequestFailed(err.to_string()))?
        };

        let status = response.status();
        if !status.is_success() {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok());
            let body = response
                .text()
                .await
                .map_err(|err| ProviderError::ParseError(err.to_string()))?;
            return Err(Self::parse_error(status.as_u16(), &body, retry_after));
        }

        // Order-preserving stream assembly for the OpenAI Responses API.
        //
        // The Responses stream emits events in block order — text deltas fire
        // between `output_item.added` markers, and a `function_call` item is
        // announced by its own `output_item.added` before its argument deltas.
        // We keep a running `current_text` buffer that flushes to a
        // `Text` block whenever the next block starts (either a new text
        // message item or a function_call item), and push each completed
        // `function_call` as a `ToolCall` block when its `.done` event fires.
        //
        // The result is a `blocks: Vec<AssistantBlock>` that matches the
        // source order. Flat aggregates (`accumulated_text` / `tool_calls`)
        // stay populated for order-insensitive consumers.
        let mut final_response: Option<ResponsesResponse> = None;
        let mut accumulated_text = String::new();
        let mut tool_calls: Vec<ToolCallRequest> = Vec::new();
        let mut stream_normalizer = ResponsesStreamNormalizer::new();
        let mut blocks: Vec<AssistantBlock> = Vec::new();
        let mut current_text = String::new();
        let mut accumulated_reasoning = String::new();

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        let mut finish_reason = finish::STOP.to_string();
        let mut stream_error_kind: Option<StreamErrorKind> = None;

        const CHUNK_READ_TIMEOUT: Duration = Duration::from_secs(90);

        loop {
            let chunk_result = match tokio::time::timeout(CHUNK_READ_TIMEOUT, stream.next()).await {
                Ok(Some(result)) => result,
                Ok(None) => break,
                Err(_elapsed) => {
                    let has_partial_data = !accumulated_text.is_empty()
                        || stream_normalizer.has_pending_tool_calls()
                        || !tool_calls.is_empty();
                    warn!(
                        "OpenAI Responses stream chunk timeout after {}s (model={}, partial={})",
                        CHUNK_READ_TIMEOUT.as_secs(),
                        model,
                        has_partial_data
                    );
                    if has_partial_data {
                        finish_reason = finish::STREAM_ERROR.to_string();
                        stream_error_kind = Some(StreamErrorKind::IdleTimeout);
                        break;
                    }
                    return Err(ProviderError::RequestFailed(format!(
                        "OpenAI Responses stream timed out: no data received for {}s",
                        CHUNK_READ_TIMEOUT.as_secs()
                    )));
                }
            };

            if let Some(flag) = cancel_flag {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    info!(
                        "[openai-responses] Stream cancelled by user (model={})",
                        model
                    );
                    drop(stream);
                    return Err(ProviderError::Cancelled);
                }
            }

            let chunk = match chunk_result {
                Ok(bytes) => bytes,
                Err(err) => {
                    let has_partial_data = !accumulated_text.is_empty()
                        || stream_normalizer.has_pending_tool_calls()
                        || !tool_calls.is_empty();
                    if has_partial_data {
                        warn!(
                            "OpenAI Responses stream interrupted after partial output: {}",
                            err
                        );
                        finish_reason = finish::STREAM_ERROR.to_string();
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

                if line.is_empty() || line.starts_with("event:") {
                    continue;
                }

                if !line.starts_with("data:") {
                    continue;
                }

                let data = line.trim_start_matches("data:").trim();
                if data == "[DONE]" {
                    break;
                }

                let outputs = match stream_normalizer.ingest_json_str(data) {
                    Ok(outputs) => outputs,
                    Err(err) => {
                        debug!(
                            "[openai-responses] Failed to parse SSE event: {} — data: {}",
                            err,
                            &data[..data.len().min(200)]
                        );
                        continue;
                    }
                };

                for output in outputs {
                    match output {
                        ResponsesStreamOutput::BlockBoundary => {
                            if !current_text.is_empty() {
                                blocks.push(AssistantBlock::Text {
                                    text: std::mem::take(&mut current_text),
                                });
                            }
                        }
                        ResponsesStreamOutput::TextDelta(delta_text) => {
                            accumulated_text.push_str(&delta_text);
                            current_text.push_str(&delta_text);
                            on_delta(StreamDelta {
                                content: Some(delta_text),
                                reasoning: None,
                                tool_call_delta: None,
                                finish_reason: None,
                                usage: None,
                            });
                        }
                        ResponsesStreamOutput::ReasoningDelta(reasoning) => {
                            accumulated_reasoning.push_str(&reasoning);
                            blocks.push(AssistantBlock::Reasoning {
                                text: reasoning.clone(),
                            });
                            on_delta(StreamDelta {
                                content: None,
                                reasoning: Some(reasoning),
                                tool_call_delta: None,
                                finish_reason: None,
                                usage: None,
                            });
                        }
                        ResponsesStreamOutput::ToolCallStarted {
                            index,
                            call_id,
                            name,
                            arguments_delta,
                        } => {
                            on_delta(StreamDelta {
                                content: None,
                                reasoning: None,
                                tool_call_delta: Some(ToolCallDelta {
                                    index,
                                    id: Some(call_id),
                                    name: Some(name),
                                    arguments_delta,
                                }),
                                finish_reason: None,
                                usage: None,
                            });
                        }
                        ResponsesStreamOutput::ToolArgumentsDelta {
                            index,
                            arguments_delta,
                        } => {
                            on_delta(StreamDelta {
                                content: None,
                                reasoning: None,
                                tool_call_delta: Some(ToolCallDelta {
                                    index,
                                    id: None,
                                    name: None,
                                    arguments_delta: Some(arguments_delta),
                                }),
                                finish_reason: None,
                                usage: None,
                            });
                        }
                        ResponsesStreamOutput::ToolCallDone(tool_call) => {
                            tool_calls.push(tool_call.clone());
                            blocks.push(AssistantBlock::ToolCall(tool_call));
                        }
                        ResponsesStreamOutput::ResponseCompleted(response) => {
                            final_response = Some(response);
                        }
                        ResponsesStreamOutput::Error(error) => {
                            return Err(error.into_provider_error());
                        }
                        ResponsesStreamOutput::UnknownFrame { event_type, sample } => {
                            warn!(
                                event_type,
                                sample, "[openai-responses] unknown stream frame"
                            );
                        }
                    }
                }
            }
        }

        // Flush a trailing text segment as its own final Text block.
        if !current_text.is_empty() {
            blocks.push(AssistantBlock::Text {
                text: std::mem::take(&mut current_text),
            });
        }
        for tool_call in stream_normalizer.take_pending_tool_calls() {
            tool_calls.push(tool_call.clone());
            blocks.push(AssistantBlock::ToolCall(tool_call));
        }

        let completed_response = final_response.take();
        let parsed_completed_response = if let Some(response) = completed_response {
            Some(parse_response(response)?)
        } else {
            None
        };
        if let Some(parsed) = parsed_completed_response.as_ref() {
            if accumulated_reasoning.is_empty() {
                if let Some(reasoning) = parsed.reasoning_content.as_ref() {
                    accumulated_reasoning.push_str(reasoning);
                    if !reasoning.is_empty() {
                        blocks.push(AssistantBlock::Reasoning {
                            text: reasoning.clone(),
                        });
                        on_delta(StreamDelta {
                            content: None,
                            reasoning: Some(reasoning.clone()),
                            tool_call_delta: None,
                            finish_reason: None,
                            usage: None,
                        });
                    }
                }
            }

            if accumulated_text.is_empty() && tool_calls.is_empty() && blocks.is_empty() {
                on_delta(StreamDelta {
                    content: None,
                    reasoning: None,
                    tool_call_delta: None,
                    finish_reason: Some(parsed.finish_reason.clone()),
                    usage: Some(parsed.usage.clone()),
                });
                return Ok(parsed.clone());
            }

            if tool_calls.is_empty() && !parsed.tool_calls.is_empty() {
                info!(
                    "[openai-responses] Using completed response tool-call fallback ({} call(s))",
                    parsed.tool_calls.len()
                );
                on_delta(StreamDelta {
                    content: None,
                    reasoning: None,
                    tool_call_delta: None,
                    finish_reason: Some(parsed.finish_reason.clone()),
                    usage: Some(parsed.usage.clone()),
                });
                return Ok(parsed.clone());
            }
        }

        let content = if accumulated_text.is_empty() {
            None
        } else {
            Some(accumulated_text)
        };

        if finish_reason != finish::STREAM_ERROR {
            finish_reason = if !tool_calls.is_empty() {
                finish::TOOL_CALLS.to_string()
            } else {
                finish::STOP.to_string()
            };
        }

        let usage = parsed_completed_response
            .as_ref()
            .map(|parsed| parsed.usage.clone())
            .unwrap_or_default();

        on_delta(StreamDelta {
            content: None,
            reasoning: None,
            tool_call_delta: None,
            finish_reason: Some(finish_reason.clone()),
            usage: Some(usage.clone()),
        });

        Ok(LLMResponse {
            content,
            tool_calls,
            finish_reason,
            usage,
            reasoning_content: (!accumulated_reasoning.is_empty()).then_some(accumulated_reasoning),
            blocks,
            stream_error_kind,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    fn provider_name(&self) -> &str {
        "openai_responses"
    }

    // Image handling: `convert_messages` unconditionally expands MCP
    // image sidecars into `input_image` blocks. The GPT-5 / GPT-5.4 /
    // o-series Responses API family is uniformly vision-capable, and
    // on any future non-vision model we prefer a loud 400 over silently
    // dropping image evidence.
}
