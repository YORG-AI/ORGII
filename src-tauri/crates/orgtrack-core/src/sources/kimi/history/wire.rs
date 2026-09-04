//! Shared accessors over raw Kimi wire-record JSON values.

use serde_json::Value;

use super::identity::{MAX_REPLAY_MESSAGE_CHARS, MAX_REPLAY_TEXT_BYTES};
use super::replay::bounded_replay_fragment;

pub(super) fn legacy_timestamp_ms(value: &Value) -> Option<i64> {
    let timestamp = value.get("timestamp")?.as_f64()?;
    if !timestamp.is_finite() || timestamp <= 0.0 {
        return None;
    }
    let millis = timestamp * 1000.0;
    (millis.is_finite() && millis > 0.0 && millis <= i64::MAX as f64).then_some(millis as i64)
}

pub(super) fn code_timestamp_ms(value: &Value) -> Option<i64> {
    value
        .get("time")?
        .as_i64()
        .filter(|timestamp| *timestamp > 0)
}

pub(super) fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

pub(super) fn code_context_message(value: &Value) -> Option<(&str, &Value)> {
    if value.get("type").and_then(Value::as_str) != Some("context.append_message") {
        return None;
    }
    let message = value.get("message")?;
    let role = message.get("role")?.as_str()?;
    Some((role, message.get("content")?))
}

pub(super) fn code_context_message_text(value: &Value) -> Option<(&str, String)> {
    let (role, content) = code_context_message(value)?;
    Some((role, code_content_text(content)))
}

pub(super) fn code_content_has_text(content: &Value) -> bool {
    if content.as_str().is_some_and(|text| !text.is_empty()) {
        return true;
    }
    content.as_array().is_some_and(|parts| {
        parts.iter().any(|part| {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
            match kind {
                "text" => part
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty()),
                "think" => part
                    .get("think")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty()),
                _ => false,
            }
        })
    })
}

pub(super) fn code_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return bounded_replay_fragment(text, MAX_REPLAY_MESSAGE_CHARS, MAX_REPLAY_TEXT_BYTES);
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    let mut chars = 0usize;
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
        let raw = match kind {
            "text" => part.get("text").and_then(Value::as_str),
            "think" => part.get("think").and_then(Value::as_str),
            _ => None,
        };
        let Some(raw) = raw else {
            continue;
        };
        let fragment = bounded_replay_fragment(
            raw,
            MAX_REPLAY_MESSAGE_CHARS.saturating_sub(chars),
            MAX_REPLAY_TEXT_BYTES.saturating_sub(text.len()),
        );
        chars = chars.saturating_add(fragment.chars().count());
        text.push_str(&fragment);
        if chars >= MAX_REPLAY_MESSAGE_CHARS {
            break;
        }
    }
    text
}

pub(super) fn code_loop_part(value: &Value) -> Option<(&str, &str)> {
    if value.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
        return None;
    }
    let event = value.get("event")?;
    if event.get("type").and_then(Value::as_str) != Some("content.part") {
        return None;
    }
    let part = event.get("part")?;
    match part.get("type").and_then(Value::as_str)? {
        "text" => Some(("text", part.get("text")?.as_str()?)),
        "think" => Some(("think", part.get("think")?.as_str()?)),
        _ => None,
    }
}
