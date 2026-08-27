use rusqlite::params;

use crate::projects::io::helpers::{conn, now_ms};

use super::error;
use super::store::db;

/// Create a durable audit consumer cursor on first use and return its current
/// position. New consumers start at the caller-provided watermark so enabling
/// a feature does not replay an unbounded historical stream.
pub fn initialize_consumer_cursor(consumer_id: &str, initial_seq: i64) -> Result<i64, String> {
    if consumer_id.trim().is_empty() || initial_seq < 0 {
        return Err(format!(
            "{}:consumer_id and a non-negative initial_seq are required",
            error::INVALID_REQUEST
        ));
    }
    let connection = conn()?;
    let now = now_ms();
    db(connection.execute(
        "INSERT OR IGNORE INTO pm_event_consumers (consumer_id, last_seq, updated_at)
         VALUES (?1, ?2, ?3)",
        params![consumer_id, initial_seq, now],
    ))?;
    db(connection.query_row(
        "SELECT last_seq FROM pm_event_consumers WHERE consumer_id = ?1",
        params![consumer_id],
        |row| row.get(0),
    ))
}

/// Monotonically advance a durable audit consumer after all side effects for
/// the covered window have themselves become durable.
pub fn advance_consumer_cursor(consumer_id: &str, through_seq: i64) -> Result<i64, String> {
    if consumer_id.trim().is_empty() || through_seq < 0 {
        return Err(format!(
            "{}:consumer_id and a non-negative through_seq are required",
            error::INVALID_REQUEST
        ));
    }
    let connection = conn()?;
    let now = now_ms();
    let changed = db(connection.execute(
        "UPDATE pm_event_consumers
         SET last_seq = MAX(last_seq, ?2), updated_at = ?3
         WHERE consumer_id = ?1",
        params![consumer_id, through_seq, now],
    ))?;
    if changed != 1 {
        return Err(format!("{}:{consumer_id}", error::NOT_FOUND));
    }
    db(connection.query_row(
        "SELECT last_seq FROM pm_event_consumers WHERE consumer_id = ?1",
        params![consumer_id],
        |row| row.get(0),
    ))
}
