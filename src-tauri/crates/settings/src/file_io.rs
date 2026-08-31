//! Settings File I/O
//!
//! Read and write the user settings JSONC file at `~/.orgii/settings.jsonc`.
//! Handles:
//! - JSONC parsing (strip comments before JSON parse)
//! - Creating the file with defaults if it doesn't exist
//! - Merging partial updates into the existing file
//! - Pretty-printing with comment preservation

use std::fs;
use std::path::{Path, PathBuf};

/// Get the settings directory path: `~/.orgii/`
pub fn get_settings_dir() -> PathBuf {
    app_paths::orgii_root()
}

/// Get the full path to the settings file: `~/.orgii/settings.jsonc`
pub fn get_settings_path() -> PathBuf {
    app_paths::settings()
}

/// Get the full path to the JSON schema file: `~/.orgii/settings-schema.json`
pub fn get_schema_path() -> PathBuf {
    app_paths::settings_schema()
}

/// Strip single-line (`// ...`) and block (`/* ... */`) comments from JSONC content.
/// Returns valid JSON that can be parsed by serde_json.
fn strip_jsonc_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut idx = 0;
    let mut in_string = false;
    let mut escape_next = false;

    while idx < len {
        if escape_next {
            result.push(chars[idx]);
            escape_next = false;
            idx += 1;
            continue;
        }

        if in_string {
            if chars[idx] == '\\' {
                escape_next = true;
                result.push(chars[idx]);
            } else if chars[idx] == '"' {
                in_string = false;
                result.push(chars[idx]);
            } else {
                result.push(chars[idx]);
            }
            idx += 1;
            continue;
        }

        if chars[idx] == '"' {
            in_string = true;
            result.push(chars[idx]);
            idx += 1;
            continue;
        }

        if idx + 1 < len && chars[idx] == '/' && chars[idx + 1] == '/' {
            while idx < len && chars[idx] != '\n' {
                idx += 1;
            }
            continue;
        }

        if idx + 1 < len && chars[idx] == '/' && chars[idx + 1] == '*' {
            idx += 2;
            while idx + 1 < len && !(chars[idx] == '*' && chars[idx + 1] == '/') {
                idx += 1;
            }
            if idx + 1 < len {
                idx += 2;
            }
            continue;
        }

        result.push(chars[idx]);
        idx += 1;
    }

    result
}

fn find_complete_json_prefix(input: &str) -> Option<&str> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape_next = false;
    let mut started = false;

    for (idx, ch) in input.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }

        if in_string {
            if ch == '\\' {
                escape_next = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }

        if ch == '{' || ch == '[' {
            depth += 1;
            started = true;
            continue;
        }

        if ch == '}' || ch == ']' {
            if depth == 0 {
                return None;
            }
            depth -= 1;
            if started && depth == 0 {
                return Some(&input[..idx + ch.len_utf8()]);
            }
        }
    }

    None
}

fn recover_trailing_garbage_json(input: &str) -> Option<serde_json::Value> {
    let prefix = find_complete_json_prefix(input)?;
    if input[prefix.len()..].trim().is_empty() {
        return None;
    }
    serde_json::from_str(prefix).ok()
}

fn backup_corrupt_settings(path: &Path, content: &str) -> Result<PathBuf, String> {
    let mut backup_path = path.to_path_buf();
    backup_path.set_extension("jsonc.corrupt");
    fs::write(&backup_path, content)
        .map_err(|err| format!("Failed to back up corrupt settings file: {err}"))?;
    Ok(backup_path)
}

/// Read settings from `~/.orgii/settings.jsonc`.
/// Returns the parsed JSON value. Creates the file with defaults if it doesn't exist.
pub fn read_settings() -> Result<serde_json::Value, String> {
    let path = get_settings_path();

    if !path.exists() {
        // First launch or file was deleted — create with empty object.
        // The frontend will populate with defaults and write back.
        let dir = get_settings_dir();
        fs::create_dir_all(&dir).map_err(|err| format!("Failed to create settings dir: {err}"))?;
        let empty = serde_json::json!({});
        let content = serde_json::to_string_pretty(&empty)
            .map_err(|err| format!("Failed to serialize defaults: {err}"))?;
        fs::write(&path, &content)
            .map_err(|err| format!("Failed to write settings file: {err}"))?;
        return Ok(empty);
    }

    let content =
        fs::read_to_string(&path).map_err(|err| format!("Failed to read settings file: {err}"))?;

    let json_content = strip_jsonc_comments(&content);
    match serde_json::from_str::<serde_json::Value>(&json_content) {
        Ok(value) => Ok(value),
        Err(parse_err) => {
            if let Some(recovered) = recover_trailing_garbage_json(&json_content) {
                let backup_path = backup_corrupt_settings(&path, &content)?;
                write_settings_json(&recovered)?;
                eprintln!(
                    "[Settings] Recovered settings from trailing garbage; backup saved to {}",
                    backup_path.display()
                );
                return Ok(recovered);
            }

            Err(format!("Failed to parse settings JSONC: {parse_err}"))
        }
    }
}

/// Write the complete JSONC content to `~/.orgii/settings.jsonc`.
/// The content string should include comments (generated by the frontend schema).
pub fn write_settings_jsonc(content: &str) -> Result<(), String> {
    let path = get_settings_path();
    let dir = get_settings_dir();

    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create settings dir: {err}"))?;
    fs::write(&path, content).map_err(|err| format!("Failed to write settings file: {err}"))?;

    Ok(())
}

/// Write a JSON value to the settings file (without comments, pretty-printed).
/// Used for partial updates where we don't need to preserve comments.
pub fn write_settings_json(value: &serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to serialize settings: {err}"))?;
    let path = get_settings_path();
    let dir = get_settings_dir();

    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create settings dir: {err}"))?;
    fs::write(&path, format!("{content}\n"))
        .map_err(|err| format!("Failed to write settings file: {err}"))?;

    Ok(())
}

/// Check if the settings file exists
pub fn settings_file_exists() -> Result<bool, String> {
    let path = get_settings_path();
    Ok(path.exists())
}

#[cfg(test)]
#[path = "tests/file_io_tests.rs"]
mod tests;
