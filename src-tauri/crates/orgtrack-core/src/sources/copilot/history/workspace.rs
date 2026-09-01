//! The `workspace.yaml` metadata sidecar: bounded read plus the flat,
//! hand-rolled scalar parse.

use std::fs;
use std::io::Read;
use std::path::Path;

use super::bounded::bounded_nonempty;
use super::types::CopilotWorkspaceMeta;
use super::{MAX_ID_BYTES, MAX_PATH_BYTES, MAX_WORKSPACE_BYTES, WORKSPACE_FILENAME};

pub(super) fn read_copilot_workspace(events_path: &Path) -> CopilotWorkspaceMeta {
    let Some(session_dir) = events_path.parent() else {
        return CopilotWorkspaceMeta::default();
    };
    let path = session_dir.join(WORKSPACE_FILENAME);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return CopilotWorkspaceMeta::default();
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_WORKSPACE_BYTES
    {
        return CopilotWorkspaceMeta::default();
    }
    let Ok(file) = fs::File::open(path) else {
        return CopilotWorkspaceMeta::default();
    };
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if file
        .take(MAX_WORKSPACE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_WORKSPACE_BYTES
    {
        return CopilotWorkspaceMeta::default();
    }
    std::str::from_utf8(&bytes)
        .ok()
        .map(parse_workspace_yaml)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// workspace.yaml (flat, hand-parsed — no YAML dependency)
// ---------------------------------------------------------------------------

pub(super) fn parse_workspace_yaml(raw: &str) -> CopilotWorkspaceMeta {
    let mut meta = CopilotWorkspaceMeta::default();
    for line in raw.lines() {
        // The sidecar is flat `key: value`; skip blanks, comments, and any
        // indented (nested) line defensively.
        if line.trim().is_empty() || line.trim_start().starts_with('#') || line.starts_with(' ') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = unquote_yaml_scalar(value);
        match key.trim() {
            "cwd" => meta.cwd = bounded_nonempty(&value, MAX_PATH_BYTES),
            "name" => meta.name = bounded_nonempty(&value, 1_024),
            "created_at" => meta.created_at = bounded_nonempty(&value, MAX_ID_BYTES),
            "updated_at" => meta.updated_at = bounded_nonempty(&value, MAX_ID_BYTES),
            _ => {}
        }
    }
    meta
}

/// Trim and unquote a YAML scalar: single-quoted values (the CLI's style,
/// e.g. `name: 'Reply with exactly: OK'`) un-double their embedded `''`;
/// double-quoted values unescape `\"`. Plain scalars pass through trimmed.
pub(super) fn unquote_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(inner) = trimmed
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        return inner.replace("''", "'");
    }
    if let Some(inner) = trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        return inner.replace("\\\"", "\"");
    }
    trimmed.to_string()
}
