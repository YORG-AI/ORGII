//! Per-turn usage persistence.
//!
//! Writes the aggregate token-usage row and the per-iteration LLM span /
//! per-tool attribution telemetry batch for a completed turn.

use tracing::warn;

use crate::turn_executor::{ContextUsageSnapshot, TurnResult};

use super::UnifiedMessageProcessor;

impl UnifiedMessageProcessor {
    /// Records token usage for a turn.
    pub(super) fn record_token_usage(&self, session_id: &str, result: &TurnResult) {
        if result.total_tokens == 0 {
            return;
        }

        let context_usage_json = result
            .context_usage_snapshot
            .clone()
            .or_else(|| {
                (result.context_tokens > 0).then(|| {
                    let context_window =
                        crate::core::providers::model_capabilities::resolve_effective_context_window(
                        &self.runtime.model,
                        self.runtime.account_id.as_deref(),
                        self.runtime
                            .resolved
                            .context_window_configured
                            .then_some(self.runtime.resolved.context_window),
                    ) as i64;
                    ContextUsageSnapshot::from_payload(
                        &result.messages,
                        &[],
                        result.context_tokens,
                        result.cache_read_tokens,
                        result.cache_write_tokens,
                        Some(context_window),
                    )
                })
            })
            .as_ref()
            .and_then(|snapshot| serde_json::to_string(snapshot).ok());

        tokio::task::block_in_place(|| {
            use crate::foundation::session_bridge::{record_token_usage, TokenUsageRow};
            if let Err(err) = record_token_usage(TokenUsageRow {
                session_id,
                session_type: crate::session::persistence::session_type::GENERIC,
                model: Some(&self.runtime.model),
                // Attribute usage to the account the runtime was built with —
                // an account switch rebuilds the runtime, so the dying turn
                // still bills the account that actually served it.
                account_id: self.runtime.account_id.as_deref(),
                input_tokens: result.prompt_tokens,
                output_tokens: result.completion_tokens,
                cache_read_tokens: result.cache_read_tokens,
                cache_write_tokens: result.cache_write_tokens,
                total_tokens: result.total_tokens,
                context_tokens: result.context_tokens,
                context_usage_json,
            }) {
                warn!("[unified_processor] Failed to record token usage: {}", err);
            }
        });
    }

    pub(super) fn record_usage_telemetry(
        &self,
        session_id: &str,
        turn_id: &str,
        result: &TurnResult,
    ) {
        if result.usage_telemetry.llm_spans.is_empty()
            && result.usage_telemetry.tool_attributions.is_empty()
        {
            return;
        }

        let related_tool_call_ids_json = result
            .usage_telemetry
            .llm_spans
            .iter()
            .map(|span| serde_json::to_string(&span.related_tool_call_ids).ok())
            .collect::<Vec<_>>();

        tokio::task::block_in_place(|| {
            use crate::foundation::session_bridge::{
                record_usage_telemetry_batch, LlmUsageSpanRow, ToolUsageAttributionRow,
                UsageTelemetryBatch,
            };

            let llm_spans = result
                .usage_telemetry
                .llm_spans
                .iter()
                .zip(related_tool_call_ids_json.iter())
                .map(|(span, related_ids_json)| LlmUsageSpanRow {
                    session_id,
                    turn_id,
                    iteration_index: span.iteration_index,
                    model: Some(&self.runtime.model),
                    account_id: self.runtime.account_id.as_deref(),
                    prompt_tokens: span.prompt_tokens,
                    completion_tokens: span.completion_tokens,
                    cache_read_tokens: span.cache_read_tokens,
                    cache_write_tokens: span.cache_write_tokens,
                    total_tokens: span.total_tokens,
                    context_tokens: span.context_tokens,
                    related_tool_call_ids_json: related_ids_json.clone(),
                    context_usage_json: span.context_usage_json.clone(),
                })
                .collect::<Vec<_>>();
            let tool_attributions = result
                .usage_telemetry
                .tool_attributions
                .iter()
                .map(|attribution| ToolUsageAttributionRow {
                    session_id,
                    turn_id,
                    event_id: &attribution.event_id,
                    tool_call_id: &attribution.tool_call_id,
                    tool_name: &attribution.tool_name,
                    iteration_index: attribution.iteration_index,
                    decision_completion_tokens: attribution.decision_completion_tokens,
                    result_context_tokens: attribution.result_context_tokens,
                    followup_completion_tokens: attribution.followup_completion_tokens,
                    input_bytes: attribution.input_bytes,
                    output_bytes: attribution.output_bytes,
                    attribution_method: attribution.attribution_method.as_str(),
                })
                .collect::<Vec<_>>();

            if let Err(err) = record_usage_telemetry_batch(UsageTelemetryBatch {
                llm_spans,
                tool_attributions,
            }) {
                warn!(
                    "[unified_processor] Failed to record usage telemetry batch: {}",
                    err
                );
            }
        });
    }
}
