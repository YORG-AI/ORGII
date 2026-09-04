//! Bounded extraction helpers shared by the metadata, enrichment, replay,
//! workspace, and tool-mapping readers.

use serde_json::Value;

pub(super) fn bounded_nonempty(value: &str, max_bytes: usize) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed.len() <= max_bytes).then(|| trimmed.to_string())
}

pub(super) fn bounded_data_str(data: &Value, key: &str, max_bytes: usize) -> Option<String> {
    data.get(key)
        .and_then(Value::as_str)
        .and_then(|value| bounded_nonempty(value, max_bytes))
}

const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;

pub(super) fn bounded_tool_arguments(arguments: &Value) -> Option<Value> {
    let encoded = serde_json::to_vec(arguments).ok()?;
    (encoded.len() <= MAX_TOOL_ARGUMENT_BYTES).then(|| arguments.clone())
}
