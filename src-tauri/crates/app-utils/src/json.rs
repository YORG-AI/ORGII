//! Shared JSON file I/O helpers.
//!
//! Used by CLI agent config modules (Claude Code, Cursor) and anywhere else
//! that needs to read/write/merge JSON files on disk.

use std::path::Path;

/// Read a JSON file, returning an empty object `{}` if it does not exist.
pub fn read_json_file(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let val: serde_json::Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid JSON: {err}"))?;
    Ok(val)
}

/// Write a `serde_json::Value` to a file as pretty-printed JSON.
/// Creates parent directories if needed.
pub fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("Failed to create {}: {err}", dir.display()))?;
    }
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|err| format!("JSON serialize error: {err}"))?;
    std::fs::write(path, serialized)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;
    Ok(())
}

/// Recursively merge `partial` into `base` (both must be JSON objects).
/// Nested objects are merged; other types are overwritten.
pub fn merge_json(base: &mut serde_json::Value, partial: &serde_json::Value) {
    if let (serde_json::Value::Object(base_map), serde_json::Value::Object(partial_map)) =
        (base, partial)
    {
        for (key, value) in partial_map {
            if let (Some(existing), serde_json::Value::Object(_)) = (base_map.get_mut(key), value) {
                if existing.is_object() {
                    merge_json(existing, value);
                    continue;
                }
            }
            base_map.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_json_file_returns_empty_object_when_missing() {
        let dir = tempfile::tempdir().expect("temp dir");

        let value = read_json_file(&dir.path().join("missing.json")).expect("missing file");

        assert_eq!(value, json!({}));
    }

    #[test]
    fn write_json_file_creates_parents_and_round_trips_pretty_json() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("nested").join("settings.json");
        let expected = json!({"enabled": true, "nested": {"count": 2}});

        write_json_file(&path, &expected).expect("write json");

        let raw = std::fs::read_to_string(&path).expect("read raw json");
        assert!(raw.contains("\n  \"enabled\": true"));
        assert_eq!(read_json_file(&path).expect("read json"), expected);
    }

    #[test]
    fn read_json_file_rejects_invalid_json() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("invalid.json");
        std::fs::write(&path, "{not valid json").expect("write fixture");

        let error = read_json_file(&path).expect_err("invalid JSON should fail");

        assert!(error.starts_with("Invalid JSON:"), "{error}");
    }

    #[test]
    fn write_json_file_reports_parent_creation_failures() {
        let dir = tempfile::tempdir().expect("temp dir");
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, "file").expect("write blocker");

        let error = write_json_file(&blocker.join("value.json"), &json!({}))
            .expect_err("file cannot be used as parent directory");

        assert!(error.starts_with("Failed to create "), "{error}");
    }

    #[test]
    fn merge_json_recursively_merges_objects_and_replaces_other_values() {
        let mut base = json!({
            "nested": {"kept": true, "changed": "old"},
            "scalar": 1,
            "array": [1, 2],
            "untouched": "value"
        });
        let partial = json!({
            "nested": {"changed": "new", "added": 3},
            "scalar": {"now": "object"},
            "array": [9],
            "new": false
        });

        merge_json(&mut base, &partial);

        assert_eq!(
            base,
            json!({
                "nested": {"kept": true, "changed": "new", "added": 3},
                "scalar": {"now": "object"},
                "array": [9],
                "untouched": "value",
                "new": false
            })
        );
    }

    #[test]
    fn merge_json_leaves_non_object_roots_unchanged() {
        let mut scalar_base = json!("base");
        merge_json(&mut scalar_base, &json!({"key": "value"}));
        assert_eq!(scalar_base, json!("base"));

        let mut object_base = json!({"key": "value"});
        merge_json(&mut object_base, &json!(null));
        assert_eq!(object_base, json!({"key": "value"}));
    }
}
