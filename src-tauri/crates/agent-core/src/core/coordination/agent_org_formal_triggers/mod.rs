//! Exact durable facts that require a Coordinator Turn.
//!
//! A receipt is the authority. The process-local wake is only a doorbell: a
//! lost wake can be repaired without creating another fact, Inbox row, or
//! provider input. Multiple receipts may be materialized by one Coordinator
//! Turn, but their identities remain independently queryable and resolvable.

mod claim;
mod schema;
mod store;

#[cfg(test)]
mod tests;

pub use claim::FormalTriggerBatch;
pub use store::{
    activity_with_connection, mark_doorbells_delivered, missing_doorbell_ids_for_run,
    FormalTriggerActivity, FormalTriggerDoorbellStatus, FormalTriggerReceipt,
    FormalTriggerReceiptStatus, FormalTriggerSource,
};

pub(crate) use claim::{
    claim_for_coordinator_turn, fail_attempt_for_turn, resolve_inbox_receipts_in_tx,
};
pub(crate) use store::{
    list_missing_doorbells_with_connection, record_inbox_trigger_in_tx, record_trigger_in_tx,
    InboxFormalTriggerSource,
};

pub(crate) fn create_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    schema::create_schema(conn)
}
