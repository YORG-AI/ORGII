use super::*;
use crate::sources::imported_history::replay::drivers::common::{
    legacy_stable_id_hash_concat, utf8_boundary_at_or_before,
};

pub(super) fn field_path_is_under(field_path: &str, root: &str) -> bool {
    field_path == root
        || field_path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

pub(super) fn value_at_path_mut<'a>(value: &'a mut Value, path: &str) -> Option<&'a mut String> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object_mut()?.get_mut(segment)?;
    }
    current.as_str()?;
    match current {
        Value::String(text) => Some(text),
        _ => None,
    }
}

pub(super) fn head_preview(text: &str, max_bytes: usize) -> String {
    let end = utf8_boundary_at_or_before(text, max_bytes);
    format!("{}\n… [payload truncated]", &text[..end])
}

pub(super) fn stable_event_id(source: ImportedHistorySourceId, source_key: &str) -> String {
    format!(
        "{}-sqlite-{}",
        source.as_str(),
        legacy_stable_id_hash_concat(&[source_key.as_bytes()])
    )
}
