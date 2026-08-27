//! Outbox CRUD against `projects.db`.
//!
//! Every public function here is `Result<T, String>` per the project
//! store convention. The atomic claim path is the centerpiece: a single
//! UPDATE … SET status='in_flight' WHERE id=? AND status='pending'
//! moves a row out of the pending pool with no race window.

pub mod read;
pub mod write;

use database::db::{get_projects_connection, PooledConnection};

/// Backoff schedule for `failed` rows. Index is `retry_count - 1`; when
/// `retry_count` exceeds the table length the row transitions to
/// `Abandoned` instead of getting another retry slot.
///
/// Values: 30s, 2m, 10m, 1h. Total ~1h 12m before abandonment.
pub const RETRY_BACKOFF_SECS: &[u64] = &[30, 120, 600, 3600];

/// `retry_count` value at and beyond which the row is abandoned.
/// `len()` because retries are 1-indexed in the schedule above (the
/// row is on its Nth attempt; once N == 5 we run out of slots).
pub const MAX_RETRY_COUNT: u32 = 5;

/// Open a fresh `projects.db` connection.
pub fn conn() -> Result<PooledConnection, String> {
    let connection = get_projects_connection().map_err(|err| format!("DB error: {}", err))?;
    #[cfg(test)]
    crate::projects::schema::init_project_tables(&connection)
        .map_err(|err| format!("DB error: {}", err))?;
    Ok(connection)
}

pub use read::{
    count_by_status, last_error_for_project, list_bound_projects, list_for_project, list_problems,
    load_by_id, read_adapter_binding, read_last_webhook_at, read_sync_cursor, AdapterBinding,
    ProjectBinding, SyncCursor,
};
pub use write::{
    append, attach_adapter, claim_next_merge_external, claim_next_pending, detach_adapter,
    discard_one, gc_succeeded, mark_failed_with_backoff, mark_succeeded, record_local_update,
    requeue_for_project, requeue_one, reset_in_flight_to_pending, write_sync_cursor,
};
