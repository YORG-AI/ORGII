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

/// Atomic-write a `HashMap<String, String>` as JSON with restricted permissions.
///
/// Used for sensitive key-value stores (auth tokens, GitHub tokens, extension secrets).
/// Writes to a `.tmp` file first, sets restrictive permissions, then renames.
pub fn save_json_store(
    path: &Path,
    store: &std::collections::HashMap<String, String>,
    context_label: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {context_label} dir: {err}"))?;
    }
    let contents = serde_json::to_string_pretty(store)
        .map_err(|err| format!("Failed to serialize {context_label}: {err}"))?;

    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &contents)
        .map_err(|err| format!("Failed to write {context_label} temp file: {err}"))?;

    app_paths::set_sensitive_file_permissions(&tmp_path).ok();

    std::fs::rename(&tmp_path, path)
        .map_err(|err| format!("Failed to rename {context_label} file: {err}"))
}

/// Load a `HashMap<String, String>` from a JSON file, returning empty map if missing.
///
/// `load_json_store` is called for sensitive auth-token / secret stores
/// (GitHub tokens, extension secrets, etc.). A corrupt or unreadable
/// existing file silently turning into an empty map would mean the very
/// next `save_json_store` call overwrites the corrupt file with `{}`,
/// permanently destroying every other token in the store while the user
/// is just re-saving one new entry. Warn separately on FS read failure
/// and JSON parse failure so the operator notices before the next save
/// wipes the file.
pub fn load_json_store(path: &Path) -> std::collections::HashMap<String, String> {
    if !path.exists() {
        return std::collections::HashMap::new();
    }
    match std::fs::read_to_string(path) {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(map) => map,
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "load_json_store: JSON parse failed on existing file; returning empty map (next save will OVERWRITE this file)"
                );
                std::collections::HashMap::new()
            }
        },
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "load_json_store: read failed on existing file; returning empty map (next save will OVERWRITE this file)"
            );
            std::collections::HashMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

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

    #[test]
    fn save_and_load_json_store_round_trip_atomically() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("secrets").join("tokens.json");
        let store = HashMap::from([
            ("github".to_string(), "gh-token".to_string()),
            ("openai".to_string(), "sk-token".to_string()),
        ]);

        save_json_store(&path, &store, "token store").expect("save store");

        assert_eq!(load_json_store(&path), store);
        assert!(!path.with_extension("json.tmp").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("store metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn load_json_store_returns_empty_for_missing_invalid_and_unreadable_paths() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("missing.json");
        assert!(load_json_store(&missing).is_empty());

        let invalid = dir.path().join("invalid.json");
        std::fs::write(&invalid, "[]").expect("write invalid map fixture");
        assert!(load_json_store(&invalid).is_empty());

        assert!(load_json_store(dir.path()).is_empty());
    }

    #[test]
    fn save_json_store_reports_parent_creation_failures_without_temp_artifacts() {
        let dir = tempfile::tempdir().expect("temp dir");
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, "file").expect("write blocker");
        let path = blocker.join("tokens.json");

        let error = save_json_store(&path, &HashMap::new(), "token store")
            .expect_err("file cannot be used as parent directory");

        assert!(
            error.starts_with("Failed to create token store dir:"),
            "{error}"
        );
        assert!(!path.with_extension("json.tmp").exists());
    }
}
