//! `LLMProvider` impl for `AnthropicClient`.
//!
//! This file is the thin glue between the trait and the Anthropic-specific
//! helpers. The actual work is split across:
//!
//! - `request.rs`     — body construction + auth/header application
//! - `usage.rs`       — `Usage` extraction (non-streaming + streaming halves)
//! - `stream_parser.rs` — SSE event parser + per-block accumulators + finalize
//!
//! Both `chat` and `chat_streaming` walk the same `prepare_request` →
//! `apply_headers` → send → handle prelude. They diverge only in how they
//! consume the response body (one full JSON parse vs. an SSE read loop).

use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use tracing::{error, info, warn};

use super::client::{AnthropicClient, ClaudeOAuthRefreshEligibility};
use super::errors::{classify_error, parse_error};
use super::request::{apply_headers, prepare_request};
use super::stream_parser::{finalize_blocks, handle_event, EventOutcome, StreamState};
use super::types::{ContentBlock, MessagesResponse, StreamEvent};
use super::usage as usage_helpers;
use crate::providers::safe_truncate::safe_truncate_utf8;
use crate::providers::traits::{
    finish_reason as finish, AssistantBlock, ChatOptions, LLMProvider, LLMResponse, ProviderError,
    StreamDelta, StreamErrorKind, ToolCallRequest,
};
use crate::utils::http_retry::extract_retry_after_secs;

#[async_trait]
impl LLMProvider for AnthropicClient {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        self.chat_with_options(
            messages,
            tools,
            model,
            max_tokens,
            temperature,
            ChatOptions::default(),
        )
        .await
    }

    /// Non-streaming chat body. [`Self::chat`] delegates here with default
    /// options; `options.skip_cache_write` suppresses all three
    /// `cache_control` breakpoints in the prepared request (one-shot side
    /// queries never read the cache back, so writing it is pure cost).
    async fn chat_with_options(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        options: ChatOptions,
    ) -> Result<LLMResponse, ProviderError> {
        let mut prepared = prepare_request(
            self,
            messages,
            tools,
            model,
            max_tokens,
            temperature,
            false,
            options.skip_cache_write,
        );

        info!(
            "Anthropic chat: model={}, url={}, messages={}, tools={}",
            prepared.resolved_model,
            prepared.url,
            prepared.body.messages.len(),
            tools.map_or(0, |t| t.len()),
        );

        let mut auth_retry_used = false;
        let mut temp_retry_used = false;
        let body = loop {
            let req = apply_headers(
                self,
                &prepared.resolved_model,
                self.client.post(&prepared.url),
            );
            let response = req
                .json(&prepared.body)
                .send()
                .await
                .map_err(|err| ProviderError::RequestFailed(err.to_string()))?;

            let status = response.status().as_u16();
            let retry_after = extract_retry_after_secs(&response);
            let headers = response.headers().clone();
            let body = response
                .text()
                .await
                .map_err(|err| ProviderError::ParseError(err.to_string()))?;

            if status == 401
                && self.auth_mode == super::client::AnthropicAuthMode::ClaudeOauth
                && !auth_retry_used
                && self.claude_oauth_refresh_eligibility().await?
                    == ClaudeOAuthRefreshEligibility::Eligible
            {
                warn!("[anthropic] Claude OAuth access token crossed local expiry boundary; refreshing and retrying once");
                self.refresh_auth_after_local_expiry().await?;
                auth_retry_used = true;
                continue;
            }

            if status != 200 {
                let classification = classify_error(status, &body, Some(&headers), retry_after);

                // 403 "OAuth token has been revoked": another process rotated
                // the token server-side. Force one refresh and retry with the
                // fresh token; if the refresh fails, the AuthError propagates
                // and fails fast (no blind status-based retries).
                if super::errors::is_oauth_token_revoked(status, &body)
                    && self.auth_mode == super::client::AnthropicAuthMode::ClaudeOauth
                    && !auth_retry_used
                {
                    warn!("[anthropic] Claude OAuth token revoked (403); refreshing and retrying once");
                    self.refresh_auth_after_local_expiry().await?;
                    auth_retry_used = true;
                    continue;
                }

                // Self-healing temperature deprecation: the model rejected the
                // `temperature` param. Record it so all future requests omit it,
                // then retry THIS request once without temperature — the user
                // never sees a reconnect for a deterministic, fixable 400.
                if super::errors::is_temperature_rejected(status, &body) && !temp_retry_used {
                    crate::providers::model_capabilities::mark_temperature_unsupported(
                        &prepared.resolved_model,
                    );
                    warn!(
                        "[anthropic] model={} rejected temperature; retrying once without it (learned for this process)",
                        prepared.resolved_model
                    );
                    prepared.body.temperature = None;
                    temp_retry_used = true;
                    continue;
                }

                if classification.mark_temporary_unavailable {
                    self.mark_claude_oauth_upstream_health(
                        status,
                        &classification.error_type,
                        Some(&classification.message),
                        classification.retry_after_secs,
                    );
                }
                error!(
                    "Anthropic error: HTTP {} from {} | body: {}",
                    status,
                    prepared.url,
                    safe_truncate_utf8(&body, 500)
                );
                return Err(parse_error(
                    status,
                    &body,
                    classification.retry_after_secs,
                    classification.should_retry,
                ));
            }

            self.clear_claude_oauth_upstream_health();
            break body;
        };

        let parsed: MessagesResponse = serde_json::from_str(&body).map_err(|err| {
            ProviderError::ParseError(format!(
                "Failed to parse: {}. Body: {}",
                err,
                safe_truncate_utf8(&body, 500)
            ))
        })?;

        Ok(build_non_streaming_response(parsed))
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        use futures_util::StreamExt;

        // Streaming serves the main agent loop, whose prefix IS re-read on
        // the next turn — always keep cache writes on.
        let mut prepared = prepare_request(
            self, messages, tools, model, max_tokens, temperature, true, false,
        );

        info!(
            "Anthropic streaming: model={}, url={}, messages={}, tools={}",
            prepared.resolved_model,
            prepared.url,
            prepared.body.messages.len(),
            tools.map_or(0, |t| t.len()),
        );

        let mut auth_retry_used = false;
        let mut temp_retry_used = false;
        let response = loop {
            let req = apply_headers(
                self,
                &prepared.resolved_model,
                self.client.post(&prepared.url),
            );
            let send_future = req.json(&prepared.body).send();
            let response = if let Some(flag) = cancel_flag {
                tokio::select! {
                    result = send_future => result.map_err(|err| ProviderError::RequestFailed(err.to_string()))?,
                    _ = async {
                        while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    } => {
                        info!(
                            "[anthropic] Request cancelled before stream response (model={})",
                            prepared.resolved_model
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
            if status == 401
                && self.auth_mode == super::client::AnthropicAuthMode::ClaudeOauth
                && !auth_retry_used
                && self.claude_oauth_refresh_eligibility().await?
                    == ClaudeOAuthRefreshEligibility::Eligible
            {
                let body = crate::utils::response_text_or_read_error(response).await;
                warn!(
                    "[anthropic] Claude OAuth access token crossed local expiry boundary before stream; refreshing and retrying once: {}",
                    safe_truncate_utf8(&body, 500)
                );
                self.refresh_auth_after_local_expiry().await?;
                auth_retry_used = true;
                continue;
            }

            if status != 200 {
                let retry_after = extract_retry_after_secs(&response);
                let headers = response.headers().clone();
                let body = crate::utils::response_text_or_read_error(response).await;
                let classification = classify_error(status, &body, Some(&headers), retry_after);

                // 403 "OAuth token has been revoked": force one refresh and
                // retry with the fresh token; a failed refresh propagates as
                // AuthError and fails fast (see the non-streaming twin above).
                if super::errors::is_oauth_token_revoked(status, &body)
                    && self.auth_mode == super::client::AnthropicAuthMode::ClaudeOauth
                    && !auth_retry_used
                {
                    warn!("[anthropic] Claude OAuth token revoked (403) before stream; refreshing and retrying once");
                    self.refresh_auth_after_local_expiry().await?;
                    auth_retry_used = true;
                    continue;
                }

                // Self-healing temperature deprecation: learn it and retry this
                // stream once without `temperature` so the user never sees a
                // reconnect for a deterministic, fixable 400.
                if super::errors::is_temperature_rejected(status, &body) && !temp_retry_used {
                    crate::providers::model_capabilities::mark_temperature_unsupported(
                        &prepared.resolved_model,
                    );
                    warn!(
                        "[anthropic] model={} rejected temperature; retrying stream once without it (learned for this process)",
                        prepared.resolved_model
                    );
                    prepared.body.temperature = None;
                    temp_retry_used = true;
                    continue;
                }

                if classification.mark_temporary_unavailable {
                    self.mark_claude_oauth_upstream_health(
                        status,
                        &classification.error_type,
                        Some(&classification.message),
                        classification.retry_after_secs,
                    );
                }
                error!(
                    "Anthropic streaming error: HTTP {} from {} | model={} | body: {}",
                    status,
                    prepared.url,
                    prepared.resolved_model,
                    safe_truncate_utf8(&body, 1000)
                );
                return Err(parse_error(
                    status,
                    &body,
                    classification.retry_after_secs,
                    classification.should_retry,
                ));
            }

            self.clear_claude_oauth_upstream_health();
            break response;
        };

        let mut state = StreamState::default();
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut stream_done = false;

        // Anthropic streams content as indexed blocks:
        //   content_block_start  { index, content_block }
        //   content_block_delta  { index, delta }
        //   content_block_stop   { index }
        //
        // We dispatch each event to `handle_event`; the per-index block
        // accumulators inside `state` rebuild the original interleave at
        // end-of-stream. See `stream_parser.rs` for the per-event handlers.
        const CHUNK_READ_TIMEOUT: Duration = Duration::from_secs(90);

        loop {
            if let Some(flag) = cancel_flag {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    info!(
                        "[anthropic] Stream cancelled by user (model={})",
                        prepared.resolved_model
                    );
                    drop(stream);
                    return Err(ProviderError::Cancelled);
                }
            }

            let chunk_result = tokio::select! {
                timed = tokio::time::timeout(CHUNK_READ_TIMEOUT, stream.next()) => match timed {
                    Ok(Some(result)) => result,
                    Ok(None) => break,
                    Err(_elapsed) => {
                        warn!(
                            "Anthropic stream chunk timeout after {}s (model={}, partial={})",
                            CHUNK_READ_TIMEOUT.as_secs(),
                            prepared.resolved_model,
                            state.has_partial_data()
                        );
                        if state.has_partial_data() {
                            state.mark_stream_error(StreamErrorKind::IdleTimeout);
                            break;
                        }
                        return Err(ProviderError::RequestFailed(format!(
                            "Anthropic stream timed out: no data received for {}s",
                            CHUNK_READ_TIMEOUT.as_secs()
                        )));
                    }
                },
                _ = async {
                    loop {
                        if let Some(flag) = cancel_flag {
                            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                                break;
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }, if cancel_flag.is_some() => {
                    info!(
                        "[anthropic] Stream cancelled by user (model={})",
                        prepared.resolved_model
                    );
                    drop(stream);
                    return Err(ProviderError::Cancelled);
                }
            };

            let chunk = match chunk_result {
                Ok(bytes) => bytes,
                Err(err) => {
                    if state.has_partial_data() {
                        warn!(
                            "Anthropic stream interrupted after partial output (model={}): {}",
                            prepared.resolved_model, err
                        );
                        state.mark_stream_error(StreamErrorKind::ConnectionError);
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

                // SSE spec allows "data: value" or "data:value" (no space).
                let data = line["data:".len()..].trim_start();
                if data == "[DONE]" {
                    stream_done = true;
                    break;
                }

                let event = match serde_json::from_str::<StreamEvent>(data) {
                    Ok(event) => event,
                    Err(error) => {
                        state.unknown_frame_count += 1;
                        warn!(
                            model = prepared.resolved_model,
                            error = %error,
                            sample = %safe_truncate_utf8(data, 500),
                            "Anthropic stream emitted unparsed data frame"
                        );
                        continue;
                    }
                };

                match handle_event(event, &mut state, on_delta, &prepared.resolved_model) {
                    EventOutcome::Continue => {}
                    EventOutcome::StreamDone => {
                        stream_done = true;
                        break;
                    }
                    EventOutcome::HardError(err) => {
                        return Err(err);
                    }
                }
            }

            if stream_done {
                break;
            }
        }

        let (blocks, tool_calls) = finalize_blocks(&mut state);
        usage_helpers::finalize_total(&mut state.usage);
        if state.unknown_frame_count > 0 {
            tracing::warn!(
                unknown_frame_count = state.unknown_frame_count,
                "Anthropic stream completed with unknown frame(s)"
            );
        }

        on_delta(StreamDelta {
            content: None,
            reasoning: None,
            tool_call_delta: None,
            finish_reason: Some(state.finish_reason.clone()),
            usage: Some(state.usage.clone()),
        });

        info!(
            "Anthropic stream complete: finish_reason={}, tool_calls={}, content_len={}, usage={:?}",
            state.finish_reason,
            tool_calls.len(),
            state.accumulated_content.len(),
            state.usage,
        );

        Ok(LLMResponse {
            content: if state.accumulated_content.is_empty() {
                None
            } else {
                Some(state.accumulated_content)
            },
            tool_calls,
            finish_reason: state.finish_reason,
            usage: state.usage,
            reasoning_content: if state.accumulated_reasoning.is_empty() {
                None
            } else {
                Some(state.accumulated_reasoning)
            },
            blocks,
            stream_error_kind: state.stream_error_kind,
            // Provider retry floor parsed from an SSE error frame (if any) —
            // the in-stream retry loop honors it over its exponential default.
            retry_after_ms: state.retry_after_ms,
        })
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    fn provider_name(&self) -> &str {
        crate::providers::registry::provider_id::ANTHROPIC
    }
}

/// Parse the non-streaming `MessagesResponse` into the unified `LLMResponse`.
///
/// Walks Anthropic's ordered content blocks once. Each block becomes an
/// `AssistantBlock` in source order (preserves text→tool→text interleave
/// for downstream block-driven consumers). The flat `text_content` /
/// `tool_calls` / `reasoning` aggregates are also filled for consumers
/// that don't care about ordering (message history, side queries, etc.).
fn build_non_streaming_response(parsed: MessagesResponse) -> LLMResponse {
    let mut text_content = String::new();
    let mut tool_calls = Vec::new();
    let mut reasoning = String::new();
    let mut blocks: Vec<AssistantBlock> = Vec::with_capacity(parsed.content.len());
    let mut pending_anthropic_thinking: Option<Value> = None;

    for block in &parsed.content {
        match block {
            ContentBlock::Text { text } => {
                if text.is_empty() {
                    continue;
                }
                text_content.push_str(text);
                blocks.push(AssistantBlock::Text { text: text.clone() });
            }
            ContentBlock::ToolUse { id, name, input } => {
                let tool_call = ToolCallRequest {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: input.clone(),
                    thought_signature: pending_anthropic_thinking.take(),
                };
                tool_calls.push(tool_call.clone());
                blocks.push(AssistantBlock::ToolCall(tool_call));
            }
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                if let Some(ref thought) = thinking {
                    if thought.is_empty() {
                        continue;
                    }
                    if let Some(sig) = signature {
                        pending_anthropic_thinking = Some(serde_json::json!({
                            "anthropic": {
                                "thinking": thought,
                                "signature": sig,
                            }
                        }));
                    }
                    reasoning.push_str(thought);
                    blocks.push(AssistantBlock::Reasoning {
                        text: thought.clone(),
                    });
                }
            }
        }
    }

    let usage = usage_helpers::from_non_streaming(&parsed);

    let finish_reason = match parsed.stop_reason.as_deref() {
        Some("end_turn") => finish::STOP,
        Some("tool_use") => finish::TOOL_CALLS,
        // Map `max_tokens` to the unified LENGTH value so the turn
        // executor's truncation recovery fires (see stream_parser.rs).
        Some("max_tokens") => finish::LENGTH,
        // Context-window truncation is the same "response was cut off"
        // situation as max_tokens — route it into the LENGTH recovery path
        // instead of treating the cut as a normal completion.
        Some("model_context_window_exceeded") => finish::LENGTH,
        // Refusal / content-safety stop: empty body. Map to CONTENT_FILTER so
        // the turn executor's empty-response fail-safe emits a visible notice.
        Some("refusal") => finish::CONTENT_FILTER,
        Some(other) => other,
        None => finish::STOP,
    };

    LLMResponse {
        content: if text_content.is_empty() {
            None
        } else {
            Some(text_content)
        },
        tool_calls,
        finish_reason: finish_reason.to_string(),
        usage,
        reasoning_content: if reasoning.is_empty() {
            None
        } else {
            Some(reasoning)
        },
        blocks,
        stream_error_kind: None,
        retry_after_ms: None,
    }
}
