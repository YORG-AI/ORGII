use super::*;
use crate::sources::imported_history::replay::drivers::common::{
    legacy_stable_id_hash_delimited, utf8_boundary_at_or_before,
};

pub(super) fn open_source_db(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("open structured replay source {}: {err}", path.display()))
}

pub(super) fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    let object = value.as_object()?;
    names.iter().find_map(|name| object.get(*name))
}

pub(super) fn field_str<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    field(value, names).and_then(Value::as_str)
}

pub(super) fn timestamp_value_to_iso(value: &Value) -> Option<String> {
    if let Some(raw) = value.as_str() {
        return Some(imported_history::normalize_created_at(raw));
    }
    let seconds = field(value, &["seconds"])?;
    let seconds = seconds
        .as_i64()
        .or_else(|| seconds.as_str().and_then(|raw| raw.parse().ok()))?;
    let nanos = field(value, &["nanos"])
        .and_then(Value::as_i64)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp(seconds, nanos.max(0) as u32).map(|dt| dt.to_rfc3339())
}

pub(super) fn parse_warp_timestamp_ms(value: &str) -> Option<i64> {
    imported_history::parse_iso_to_epoch_ms_opt(value).or_else(|| {
        ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"]
            .iter()
            .find_map(|format| chrono::NaiveDateTime::parse_from_str(value, format).ok())
            .map(|timestamp| timestamp.and_utc().timestamp_millis())
    })
}

pub(super) fn camel_to_snake(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 4);
    for (index, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                output.push('_');
            }
            output.push(ch.to_ascii_lowercase());
        } else {
            output.push(ch);
        }
    }
    output
}

pub(super) fn chunk_field_text(chunk: &ActivityChunk, field_path: &str) -> Result<String, String> {
    let (root, path) = field_path
        .split_once('.')
        .map_or((field_path, ""), |parts| parts);
    let value = match root {
        "args" => &chunk.args,
        "result" => &chunk.result,
        _ => return Err("Replay payload field must be under args or result".to_string()),
    };
    let target = if path.is_empty() {
        value
    } else {
        path.split('.')
            .try_fold(value, |current, key| current.get(key))
            .ok_or_else(|| "Replay payload field no longer exists".to_string())?
    };
    Ok(target
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| target.to_string()))
}

pub(super) fn value_at_path_mut<'a>(value: &'a mut Value, path: &str) -> Option<&'a mut String> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object_mut()?.get_mut(segment)?;
    }
    match current {
        Value::String(text) => Some(text),
        _ => None,
    }
}

pub(super) fn head_preview(text: &str, max_bytes: usize) -> String {
    let end = utf8_boundary_at_or_before(text, max_bytes);
    format!("{}\n… [payload truncated]", &text[..end])
}

pub(super) fn stable_event_id(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    event_key: &str,
) -> String {
    format!(
        "replay-{}-{}",
        source.as_str(),
        legacy_stable_id_hash_delimited(&[source_session_id.as_bytes(), event_key.as_bytes()])
    )
}

pub(super) fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.is_empty() || text.len() % 2 != 0 {
        return None;
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(pair, 16).ok()
        })
        .collect()
}
