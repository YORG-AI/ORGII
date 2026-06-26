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
    session_bridge::register_upsert_turn_intent(upsert_turn_intent_adapter);
    session_bridge::register_update_turn_intent_status(update_turn_intent_status_adapter);
    session_bridge::register_mark_pending_turn_intents_stale(
        mark_pending_turn_intents_stale_adapter,
    );
}
