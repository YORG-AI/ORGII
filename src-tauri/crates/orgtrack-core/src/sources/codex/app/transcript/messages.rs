use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::sources::imported_history::{self, strip_orgii_exec_mode_bridge};

use super::super::CodexJsonlLine;
use super::CODEX_PROVIDER_SLUG;

const CODEX_EMBEDDED_IMAGE_MARKER: &str = "\"image_url\":\"data:image/";
const CODEX_OMITTED_IMAGE_VALUE: &str = "[embedded image omitted]";

/// Codex can repeat a screenshot's base64 payload in thousands of tool-output
/// rows. The replay projection only consumes each output part's text field, so
/// deserializing the image bytes into `serde_json::Value` is pure allocation
/// churn. Remove the ignored payload in-place before JSON parsing while
/// preserving the surrounding output array and text parts.
pub(crate) fn strip_ignored_embedded_images(line: &mut String) {
    let mut search_from = 0usize;
    while let Some(relative_marker) = line[search_from..].find(CODEX_EMBEDDED_IMAGE_MARKER) {
        let marker_start = search_from + relative_marker;
        let value_start = marker_start + "\"image_url\":\"".len();
        let Some(relative_end) = line[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + relative_end;
        line.replace_range(value_start..value_end, CODEX_OMITTED_IMAGE_VALUE);
        search_from = value_start + CODEX_OMITTED_IMAGE_VALUE.len();
    }
}

pub(crate) fn legacy_user_message_text_from_payload(payload: &Value) -> Option<String> {
    let raw = payload.get("message").and_then(Value::as_str)?;
    let stripped = strip_orgii_exec_mode_bridge(raw);
    // Bridge-only messages carry no user-authored text: skip them entirely
    // (no replay bubble, no title candidate).
    if stripped.trim().is_empty() {
        return None;
    }
    Some(stripped.to_string())
}

#[derive(Debug)]
pub(super) struct CodexUserMessage {
    pub(super) text: String,
    pub(super) image_refs: Vec<String>,
}

pub(super) fn user_message_from_line(parsed: &CodexJsonlLine) -> Option<CodexUserMessage> {
    match parsed.payload.get("type").and_then(Value::as_str) {
        Some("user_message") => {
            let text = legacy_user_message_text_from_payload(&parsed.payload).unwrap_or_default();
            let image_refs = user_image_refs_from_payload(&parsed.payload);
            if text.is_empty() && image_refs.is_empty() {
                return None;
            }
            Some(CodexUserMessage { text, image_refs })
        }
        Some("item_completed") => paginated_user_message_from_payload(&parsed.payload),
        _ => None,
    }
}

pub(in crate::sources::codex::app) fn user_message_text_from_line(
    parsed: &CodexJsonlLine,
) -> Option<String> {
    user_message_from_line(parsed)
        .map(|message| message.text)
        .filter(|text| !text.trim().is_empty())
}

fn paginated_user_message_from_payload(payload: &Value) -> Option<CodexUserMessage> {
    let item = payload.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("UserMessage") {
        return None;
    }
    let mut text_parts = Vec::new();
    let mut image_refs = Vec::new();
    for part in item.get("content").and_then(Value::as_array)? {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    text_parts.push(text);
                }
            }
            Some("image") => push_unique_string_field(&mut image_refs, part, "image_url"),
            Some("local_image") => push_unique_string_field(&mut image_refs, part, "path"),
            _ => {}
        }
    }
    let raw_text = text_parts.join("\n");
    let text = strip_orgii_exec_mode_bridge(&raw_text).to_string();
    if text.trim().is_empty() && image_refs.is_empty() {
        return None;
    }
    Some(CodexUserMessage { text, image_refs })
}

fn push_unique_string_field(values: &mut Vec<String>, object: &Value, field: &str) {
    let Some(value) = object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

fn user_image_refs_from_payload(payload: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    for field in ["local_images", "images"] {
        let Some(values) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        for value in values {
            let Some(image_ref) = value.as_str().map(str::trim) else {
                continue;
            };
            if !image_ref.is_empty() && !refs.iter().any(|existing| existing == image_ref) {
                refs.push(image_ref.to_string());
            }
        }
    }
    refs
}

pub(super) fn user_message_chunk_from_line(
    session_id: &str,
    sequence: usize,
    created_at: &str,
    parsed: &CodexJsonlLine,
) -> Option<ActivityChunk> {
    let message = user_message_from_line(parsed)?;
    let mut chunk = imported_history::user_message_chunk(
        session_id,
        CODEX_PROVIDER_SLUG,
        sequence,
        created_at,
        &message.text,
    );
    if !message.image_refs.is_empty() {
        chunk.result["images"] = json!(message.image_refs);
    }
    Some(chunk)
}

pub(super) fn content_text_from_payload(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(content_part_text)
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

fn content_part_text(part: &Value) -> Option<String> {
    part.get("text")
        .and_then(Value::as_str)
        .or_else(|| part.get("content").and_then(Value::as_str))
        .map(ToString::to_string)
}

pub(super) fn reasoning_text_from_payload(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let summary = payload.get("summary")?.as_array()?;
    let parts = summary
        .iter()
        .filter_map(content_part_text)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}
