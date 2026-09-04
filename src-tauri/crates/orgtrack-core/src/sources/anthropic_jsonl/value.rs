use serde_json::{json, Value};

use crate::sources::imported_history;

const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;

pub(super) fn effective_role<'a>(line_type: &'a str, message_role: &'a str) -> &'a str {
    if message_role.trim().is_empty() {
        line_type
    } else {
        message_role
    }
}

pub(super) fn timestamp_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => normalize_epoch(number.as_i64()?),
        Value::String(raw) => raw
            .parse::<i64>()
            .ok()
            .and_then(normalize_epoch)
            .or_else(|| imported_history::parse_iso_to_epoch_ms_opt(raw)),
        _ => None,
    }
}

fn normalize_epoch(value: i64) -> Option<i64> {
    if value <= 0 {
        None
    } else if value < 10_000_000_000 {
        value.checked_mul(1_000)
    } else {
        Some(value)
    }
}

pub(super) fn normalized_timestamp(value: &Value) -> String {
    match value {
        Value::String(raw) if !raw.trim().is_empty() => imported_history::normalize_created_at(raw),
        _ => timestamp_ms(value)
            .map(imported_history::epoch_ms_to_iso)
            .unwrap_or_default(),
    }
}

/// Returns `(input_folded, output, cache_read, cache_write)`. `input_folded`
/// is cache-inclusive (fresh + both cache kinds); the cache components are also
/// returned so the usage projection can split them out.
pub(super) fn usage_tokens(usage: &Value) -> (i64, i64, i64, i64) {
    let read = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| usage.get(*key).and_then(Value::as_i64))
            .filter(|value| *value >= 0)
            .unwrap_or_default()
    };
    let cache_read = read(&[
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cacheRead",
        "cache_read",
    ]);
    let cache_write = read(&[
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
        "cacheWrite",
        "cache_write",
    ]);
    let input = read(&["input_tokens", "inputTokens", "input"])
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    let output = read(&["output_tokens", "outputTokens", "output"]);
    (input, output, cache_read, cache_write)
}

pub(super) fn content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(items) => items.clone(),
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        _ => Vec::new(),
    }
}

pub(super) fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

pub(super) fn first_content_text(content: &Value) -> Option<String> {
    content_blocks(content).into_iter().find_map(|block| {
        (block_type(&block) == "text")
            .then(|| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
            })
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

pub(super) fn value_to_text(value: Option<&Value>) -> String {
    let mut output = String::new();
    if let Some(value) = value {
        append_value_text(value, &mut output);
    }
    let output = output.trim();
    if output.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        format!(
            "{}\n… (truncated)",
            output
                .chars()
                .take(MAX_TOOL_OUTPUT_CHARS)
                .collect::<String>()
        )
    } else {
        output.to_string()
    }
}

fn append_value_text(value: &Value, output: &mut String) {
    match value {
        Value::String(text) => push_line(output, text),
        Value::Array(items) => {
            for item in items {
                append_value_text(item, output);
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                push_line(output, text);
            } else if let Some(content) = map.get("content") {
                append_value_text(content, output);
            } else if let Ok(encoded) = serde_json::to_string(value) {
                push_line(output, &encoded);
            }
        }
        Value::Null => {}
        other => push_line(output, &other.to_string()),
    }
}

fn push_line(output: &mut String, text: &str) {
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(text);
}

#[cfg(test)]
mod tests {
    use super::super::model::JsonlLine;
    use super::*;

    #[test]
    fn qoder_style_top_level_role_is_used_when_message_role_is_absent() {
        let line: JsonlLine =
            serde_json::from_str(r#"{"type":"user","message":{"content":"hello"}}"#).unwrap();
        assert_eq!(
            effective_role(&line.line_type, &line.message.unwrap().role),
            "user"
        );
    }

    #[test]
    fn token_metadata_ignores_negatives_and_saturates() {
        assert_eq!(
            usage_tokens(&json!({
                "input": i64::MAX,
                "output": -1,
                "cacheRead": 10,
                "cacheWrite": 20
            })),
            (i64::MAX, 0, 10, 20)
        );
    }
}
