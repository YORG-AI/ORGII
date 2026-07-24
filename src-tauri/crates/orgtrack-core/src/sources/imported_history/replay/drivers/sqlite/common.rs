use super::*;

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
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [payload truncated]", &text[..end])
}

pub(super) fn stable_event_id(source: ImportedHistorySourceId, source_key: &str) -> String {
    format!(
        "{}-sqlite-{}",
        source.as_str(),
        hash_parts(&[source_key.as_bytes()])
    )
}

pub(super) fn hash_parts(parts: &[&[u8]]) -> String {
    let mut hash = StableHash::new();
    for part in parts {
        hash.write(part);
    }
    hash.finish_hex()
}

pub(super) struct StableHash(u64);

impl StableHash {
    pub(super) fn new() -> Self {
        Self(0xcbf29ce484222325)
    }
    pub(super) fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
    pub(super) fn finish_hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}
