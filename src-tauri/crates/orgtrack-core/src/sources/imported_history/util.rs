use std::path::Path;

use chrono::TimeZone;
use serde_json::{json, Value};

pub fn parse_inner_json(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or_else(|_| json!({ "input": raw }))
}

pub fn parse_iso_to_epoch_ms_opt(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

pub fn normalize_created_at(raw: &str) -> String {
    if raw.is_empty() {
        return chrono::Utc::now().to_rfc3339();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        dt.with_timezone(&chrono::Utc).to_rfc3339()
    } else {
        raw.to_string()
    }
}

pub fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::Utc
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

pub fn repo_name_from_path(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
}

pub fn truncate_name(name: &str, max_len: usize) -> String {
    let trimmed = name.trim();
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(max_len.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}
