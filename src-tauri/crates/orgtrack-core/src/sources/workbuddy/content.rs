//! Message-content and value flattening plus timestamp normalization shared by
//! discovery and transcript conversion.

use super::*;

pub(super) fn content_items(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

pub(super) fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        other => other.as_str().map(str::to_string),
    }
}

pub(super) fn assistant_scalar_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

pub(super) fn tool_result_from_content(content: &Value) -> Option<(String, String)> {
    let Value::Array(items) = content else {
        return None;
    };
    let result_item = items.iter().find(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("tool_result" | "function_call_result")
        )
    })?;
    let call_id = result_item
        .get("tool_use_id")
        .and_then(Value::as_str)
        .or_else(|| result_item.get("callId").and_then(Value::as_str))
        .or_else(|| result_item.get("call_id").and_then(Value::as_str))?
        .to_string();
    let output = result_item
        .get("content")
        .or_else(|| result_item.get("output"))
        .map(value_to_text)
        .unwrap_or_default();
    Some((call_id, output))
}

pub(super) fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| object.get("content").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub(super) fn timestamp_value_to_epoch_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().map(normalize_numeric_timestamp_ms),
        Value::String(text) => imported_history::parse_iso_to_epoch_ms_opt(text)
            .or_else(|| text.parse::<i64>().ok().map(normalize_numeric_timestamp_ms)),
        _ => None,
    }
}

pub(super) fn timestamp_value_to_iso(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .map(normalize_numeric_timestamp_ms)
            .map(imported_history::epoch_ms_to_iso),
        Value::String(text) => imported_history::parse_iso_to_epoch_ms_opt(text)
            .map(imported_history::epoch_ms_to_iso)
            .or_else(|| {
                text.parse::<i64>()
                    .ok()
                    .map(normalize_numeric_timestamp_ms)
                    .map(imported_history::epoch_ms_to_iso)
            })
            .or_else(|| Some(imported_history::normalize_created_at(text))),
        _ => None,
    }
}

pub(super) fn normalize_numeric_timestamp_ms(value: i64) -> i64 {
    if value.abs() < 10_000_000_000 {
        value.saturating_mul(1_000)
    } else {
        value
    }
}

pub(super) fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}
