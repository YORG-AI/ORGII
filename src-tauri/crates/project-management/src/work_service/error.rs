//! Typed error sentinels understood by upper layers.

pub const PREFIX: &str = "PM_ERR:";
pub const REVISION_CONFLICT: &str = "PM_ERR:REVISION_CONFLICT";
pub const INVALID_TRANSITION: &str = "PM_ERR:INVALID_TRANSITION";
pub const IDEMPOTENCY_CONFLICT: &str = "PM_ERR:IDEMPOTENCY_CONFLICT";
pub const ALREADY_EXISTS: &str = "PM_ERR:ALREADY_EXISTS";

pub fn revision_conflict(expected: i64, current: i64) -> String {
    format!("{}:{}:{}", REVISION_CONFLICT, expected, current)
}

pub fn invalid_transition(from: &str, to: &str) -> String {
    format!("{}:{}:{}", INVALID_TRANSITION, from, to)
}

pub fn already_exists(short_id: &str) -> String {
    format!("{}:{}", ALREADY_EXISTS, short_id)
}
