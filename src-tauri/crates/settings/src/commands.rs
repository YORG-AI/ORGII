//! Tauri Commands for Settings
//!
//! Exposed to the frontend via `tauri::generate_handler![]`.
//!
//! Commands:
//! - `settings_read` — Read all settings from the JSONC file
//! - `settings_write` — Write a complete JSONC string to the file
//! - `settings_write_partial` — Merge partial settings into the existing file
//! - `settings_reset` — Delete the file (triggers watcher → frontend resets to defaults)
//! - `settings_get_path` — Get the file path for display or agent use
//! - `settings_write_schema` — Write the JSON Schema file alongside settings

use super::file_io;

/// Read all settings from `~/.orgii/settings.jsonc`.
/// Returns the parsed JSON as a `serde_json::Value`.
/// If the file doesn't exist, creates it with an empty object.
#[tauri::command]
pub async fn settings_read() -> Result<serde_json::Value, String> {
    file_io::read_settings()
}

/// Write complete JSONC content to `~/.orgii/settings.jsonc`.
/// The frontend sends the full JSONC string (with comments).
#[tauri::command]
pub async fn settings_write(content: String) -> Result<(), String> {
    file_io::write_settings_jsonc(&content)
}

/// Merge partial settings into the existing file.
/// Reads current settings, applies the partial update, and writes back (without comments).
#[tauri::command]
pub async fn settings_write_partial(partial: serde_json::Value) -> Result<(), String> {
    let mut current = file_io::read_settings()?;

    if let (Some(current_obj), Some(partial_obj)) = (current.as_object_mut(), partial.as_object()) {
        for (key, value) in partial_obj {
            current_obj.insert(key.clone(), value.clone());
        }
    } else {
        return Err("Settings must be a JSON object".to_string());
    }

    file_io::write_settings_json(&current)
}

/// Reset settings by deleting the file.
/// The file watcher will detect the deletion and the frontend will reset to defaults.
/// The file will be recreated with defaults on the next `settings_read`.
#[tauri::command]
pub async fn settings_reset() -> Result<(), String> {
    let path = file_io::get_settings_path();
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|err| format!("Failed to delete settings file: {err}"))?;
    }
    Ok(())
}

/// Get the absolute path to the settings file.
/// Useful for displaying to users or for agents to know where to edit.
#[tauri::command]
pub async fn settings_get_path() -> Result<String, String> {
    Ok(file_io::get_settings_path().to_string_lossy().to_string())
}

/// Write the JSON Schema file alongside the settings file.
/// The schema enables autocomplete in external editors (VS Code, etc.).
#[tauri::command]
pub async fn settings_write_schema(schema_content: String) -> Result<(), String> {
    let path = file_io::get_schema_path();
    let dir = file_io::get_settings_dir();

    std::fs::create_dir_all(&dir).map_err(|err| format!("Failed to create settings dir: {err}"))?;
    std::fs::write(&path, &schema_content)
        .map_err(|err| format!("Failed to write schema file: {err}"))?;

    Ok(())
}
