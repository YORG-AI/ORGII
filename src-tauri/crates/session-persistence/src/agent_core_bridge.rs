//! Wire-side adapter for `agent_core::foundation::db_bridge` and the
//! token-usage slot on `session_bridge`.
//!
//! Registers concrete implementations from this crate into agent_core's
//! IoC slots so agent_core's memory, consolidation, reflection, learnings,
//! and turn processor can persist state without depending back on
//! `session_persistence`.
//!
//! Called once at startup via [`register`].

use agent_core::foundation::{db_bridge, session_bridge};

use super::tool_usage::{AttributionMethod, NewLlmUsageSpan, NewToolUsageAttribution};
use super::turn_intents::{self, TurnIntentSource as PsSource, TurnIntentStatus as PsStatus};

/// Adapter that maps a `TokenUsageRow` projection into the live
/// `insert_token_usage_record` call.
fn record_token_usage_adapter(row: session_bridge::TokenUsageRow<'_>) -> rusqlite::Result<i64> {
    super::token_usage::insert_token_usage_record(
        row.session_id,
        row.session_type,
        row.model,
        row.account_id,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_write_tokens,
        row.total_tokens,
        row.context_tokens,
        row.context_usage_json.as_deref(),
    )
}

fn map_attribution_method(value: &str) -> AttributionMethod {
    match value {
        "provider_exact" => AttributionMethod::ProviderExact,
        "single_tool_iteration" => AttributionMethod::SingleToolIteration,
        "split_by_serialized_size" => AttributionMethod::SplitBySerializedSize,
        "split_evenly" => AttributionMethod::SplitEvenly,
        "estimated_tokenizer" => AttributionMethod::EstimatedTokenizer,
        "bytes_only" => AttributionMethod::BytesOnly,
        _ => AttributionMethod::BytesOnly,
    }
}

fn record_usage_telemetry_batch_adapter(
    batch: session_bridge::UsageTelemetryBatch<'_>,
) -> rusqlite::Result<()> {
    let spans = batch
        .llm_spans
        .iter()
        .map(|span| NewLlmUsageSpan {
            session_id: span.session_id,
            turn_id: span.turn_id,
            iteration_index: span.iteration_index,
            model: span.model,
            account_id: span.account_id,
            prompt_tokens: span.prompt_tokens,
            completion_tokens: span.completion_tokens,
            cache_read_tokens: span.cache_read_tokens,
            cache_write_tokens: span.cache_write_tokens,
            total_tokens: span.total_tokens,
            context_tokens: span.context_tokens,
            related_tool_call_ids_json: span.related_tool_call_ids_json.as_deref(),
            context_usage_json: span.context_usage_json.as_deref(),
        })
        .collect::<Vec<_>>();
    let attributions = batch
        .tool_attributions
        .iter()
        .map(|attribution| NewToolUsageAttribution {
            session_id: attribution.session_id,
            turn_id: attribution.turn_id,
            event_id: attribution.event_id,
            tool_call_id: attribution.tool_call_id,
            tool_name: attribution.tool_name,
            iteration_index: attribution.iteration_index,
            decision_completion_tokens: attribution.decision_completion_tokens,
            result_context_tokens: attribution.result_context_tokens,
            followup_completion_tokens: attribution.followup_completion_tokens,
            input_bytes: attribution.input_bytes,
            output_bytes: attribution.output_bytes,
            attribution_method: map_attribution_method(attribution.attribution_method),
        })
        .collect::<Vec<_>>();
    super::tool_usage::insert_usage_telemetry_batch(&spans, &attributions)
}

fn map_bridge_status(status: session_bridge::TurnIntentBridgeStatus) -> PsStatus {
    use session_bridge::TurnIntentBridgeStatus as B;
    match status {
        B::Optimistic => PsStatus::Optimistic,
        B::Queued => PsStatus::Queued,
        B::Running => PsStatus::Running,
        B::Completed => PsStatus::Completed,
        B::Failed => PsStatus::Failed,
        B::Cancelled => PsStatus::Cancelled,
        B::Stale => PsStatus::Stale,
        B::Coalesced => PsStatus::Coalesced,
        B::Rejected => PsStatus::Rejected,
    }
}

fn map_bridge_source(source: session_bridge::TurnIntentBridgeSource) -> PsSource {
    use session_bridge::TurnIntentBridgeSource as B;
    match source {
        B::UserSubmit => PsSource::UserSubmit,
        B::Queue => PsSource::Queue,
        B::ForceSend => PsSource::ForceSend,
        B::Resume => PsSource::Resume,
        B::AgentOrg => PsSource::AgentOrg,
        B::Wingman => PsSource::Wingman,
        B::MobileRemote => PsSource::MobileRemote,
    }
}

fn upsert_turn_intent_adapter(
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: session_bridge::TurnIntentBridgeSource,
    status: session_bridge::TurnIntentBridgeStatus,
) {
    if let Err(err) = turn_intents::upsert_initial(
        session_id,
        turn_intent_id,
        client_message_id,
        map_bridge_source(source),
        map_bridge_status(status),
    ) {
        tracing::warn!(
            session_id = %session_id,
            turn_intent_id = %turn_intent_id,
            error = ?err,
            "turn_intents.upsert_initial failed"
        );
    }
}

fn update_turn_intent_status_adapter(
    session_id: &str,
    turn_intent_id: &str,
    new_status: session_bridge::TurnIntentBridgeStatus,
) {
    if let Err(err) =
        turn_intents::update_status(session_id, turn_intent_id, map_bridge_status(new_status))
    {
        // Illegal transitions are expected when, e.g., the scheduler
        // tries to mark a turn `running` after it was already `stale`d by
        // an invalidate_pending bump. Log at debug so the noise doesn't
        // dominate test logs while still being inspectable.
        tracing::debug!(
            session_id = %session_id,
            turn_intent_id = %turn_intent_id,
            error = ?err,
            "turn_intents.update_status rejected"
        );
    }
}

fn mark_pending_turn_intents_stale_adapter(session_id: &str) {
    if let Err(err) = turn_intents::mark_pending_stale(session_id) {
        tracing::warn!(
            session_id = %session_id,
            error = ?err,
            "turn_intents.mark_pending_stale failed"
        );
    }
}

/// Register all `agent_sessions`-backed slots on agent_core's bridges.
pub fn register() {
    db_bridge::register(super::get_connection);
    session_bridge::register_record_token_usage(record_token_usage_adapter);
    session_bridge::register_record_usage_telemetry_batch(record_usage_telemetry_batch_adapter);
    session_bridge::register_upsert_turn_intent(upsert_turn_intent_adapter);
    session_bridge::register_update_turn_intent_status(update_turn_intent_status_adapter);
    session_bridge::register_mark_pending_turn_intents_stale(
        mark_pending_turn_intents_stale_adapter,
    );
}
