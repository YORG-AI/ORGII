//! Small shared helpers for the collab bridge: monotonic-ish wall clock,
//! ISO-8601 <-> epoch-ms conversion, and JSON string-field extraction.
//! Used by both the outbox (local -> remote) and apply (remote -> local)
//! paths.

use serde_json::Value;

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Mirror of `projects::io::helpers::to_iso8601` (private there).
pub(super) fn to_iso8601(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).expect("epoch"))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

pub(super) fn iso_to_ms(value: Option<&str>) -> Option<i64> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

pub(super) fn string_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}
