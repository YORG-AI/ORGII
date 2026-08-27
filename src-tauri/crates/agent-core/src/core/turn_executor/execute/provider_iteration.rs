use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use crate::model_context::microcompact;
use crate::providers::traits::{LLMProvider, LLMResponse, ProviderError, StreamDelta};
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

#[cfg(debug_assertions)]
use super::super::provider_request_capture;
use super::super::screenshot::resolve_screenshot_markers;
use super::super::stream_normalizer::{NormalizedStreamEvent, TurnStreamNormalizer};
use super::super::tool_execution::is_cancelled;
use super::super::types::{TurnConfig, TurnEventHandler};
use super::loop_state::TurnLoopState;

/// Provider-visible request inputs after history repair, compaction, media
/// resolution, metadata stripping, and tool-budget projection.
pub(super) struct PreparedRequest {
    pub(super) messages: Vec<Value>,
    pub(super) tool_definitions: Vec<Value>,
}

pub(super) fn prepare_request(
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    tools: &ToolRegistry,
    policy: &ResolvedToolPolicy,
    config: &TurnConfig,
    session_id: &str,
) -> PreparedRequest {
    // Re-run full-history pairing normalization before every provider call;
    // dispatch-time repair cannot see corruption introduced mid-turn.
    if crate::session::recovery::ensure_tool_result_pairing(messages) {
        warn!(
            "[agent-core] tool-pairing normalization repaired history mid-turn (session={})",
            session_id
        );
    }

    microcompact::microcompact_messages(messages, &state.microcompact_config);
    microcompact::cap_recent_tool_images(messages);

    info!(
        "[agent-core] collecting tool definitions (session={})",
        session_id
    );
    let tool_definitions = tools.get_definitions_budgeted(policy);
    info!(
        "[agent-core] collected {} tool definitions (session={})",
        tool_definitions.len(),
        session_id
    );

    // Resolve screenshots, then remove internal timestamps before sending.
    let mut provider_messages = if let Some(ref store) = config.screenshot_store {
        resolve_screenshot_markers(messages, store, &config.model)
    } else {
        messages.clone()
    };
    microcompact::strip_timestamp_metadata(&mut provider_messages);
    info!(
        "[agent-core] built {} LLM messages for provider (session={})",
        provider_messages.len(),
        session_id
    );

    PreparedRequest {
        messages: provider_messages,
        tool_definitions,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn call_provider(
    state: &TurnLoopState,
    request: &PreparedRequest,
    provider: &dyn LLMProvider,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<LLMResponse, ProviderError> {
    let stream_normalizer_for_cb = std::sync::Mutex::new(TurnStreamNormalizer::new());
    provider.set_session_context(session_id);

    #[cfg(debug_assertions)]
    provider_request_capture::capture(
        session_id,
        state.iteration,
        &config.model,
        state.effective_max_tokens,
        config.temperature,
        &request.messages,
        &request.tool_definitions,
    );

    let cancel_for_stream = cancel_flag.cloned();
    let cancel_ref = cancel_flag.as_ref().map(|flag| flag.as_ref());
    let session_id_for_stream = session_id.to_string();
    if state.retry_budgets.non_streaming_fallback {
        // Repeated SSE failure with no partial output gets one whole-response
        // request; the assembled response follows the same completion path.
        info!(
            "[agent-core] Using non-streaming request for this attempt (session={})",
            session_id
        );
        provider
            .chat(
                &request.messages,
                Some(&request.tool_definitions),
                &config.model,
                state.effective_max_tokens,
                config.temperature,
            )
            .await
    } else {
        provider
            .chat_streaming(
                &request.messages,
                Some(&request.tool_definitions),
                &config.model,
                state.effective_max_tokens,
                config.temperature,
                &move |delta: StreamDelta| {
                    if is_cancelled(cancel_for_stream.as_ref()) {
                        return;
                    }
                    let normalized_events = match stream_normalizer_for_cb.lock() {
                        Ok(mut normalizer) => normalizer.ingest_delta(delta),
                        Err(_) => {
                            warn!("[agent-core] stream normalizer lock poisoned; dropping delta");
                            return;
                        }
                    };
                    for event in normalized_events {
                        match event {
                            NormalizedStreamEvent::MessageDelta(content) => {
                                handler.on_message_delta(&session_id_for_stream, &content);
                            }
                            NormalizedStreamEvent::ThinkingDelta(reasoning) => {
                                handler.on_thinking_delta(&session_id_for_stream, &reasoning);
                            }
                            NormalizedStreamEvent::ToolCallDelta(delta) => {
                                handler.on_tool_call_delta(
                                    &session_id_for_stream,
                                    delta.index,
                                    delta.id.as_deref(),
                                    delta.name.as_deref(),
                                    delta.arguments_delta.as_deref(),
                                );
                            }
                            NormalizedStreamEvent::UnknownFrame {
                                provider,
                                event_type,
                                sample,
                            } => {
                                warn!(
                                    provider,
                                    event_type,
                                    sample,
                                    "[agent-core] provider stream emitted unknown frame"
                                );
                            }
                            NormalizedStreamEvent::Finish { .. }
                            | NormalizedStreamEvent::FlushSegment(_) => {}
                        }
                    }
                },
                cancel_ref,
            )
            .await
    }
}
