//! Certificate-bound final-report attempts for an Agent Org run.

mod context;
mod schema;
mod store;

#[cfg(test)]
mod tests;

pub(crate) use context::summary_context_for_turn;
pub(crate) use store::{
    active_for_run_with_connection, certificate_for_turn, claim_pending_for_coordinator_turn_in_tx,
    create_initial_for_certificate_in_tx, has_summary_receipt_for_turn_with_connection,
    is_summary_turn, is_summary_turn_with_connection, mark_failed_for_turn,
    mark_persisted_for_turn, mark_persisting_for_turn, reconcile_after_restart, retry_failed,
    stable_event_id_for_turn, status_for_turn,
};
pub use store::{FinalSummaryReceipt, FinalSummaryStatus};

pub(crate) fn create_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    schema::create_schema(conn)
}
