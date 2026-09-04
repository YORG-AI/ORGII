//! Copilot store locations plus the session-id ↔ on-disk path resolution
//! and its symlink/escape guards.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::discovery::is_plain_session_dir_name;
use super::{COPILOT_SESSION_PREFIX, EVENTS_FILENAME};

// ---------------------------------------------------------------------------
// Paths + id resolution
// ---------------------------------------------------------------------------

pub(super) fn copilot_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(rest) = session_id.strip_prefix(COPILOT_SESSION_PREFIX) else {
        return Err(format!("Invalid Copilot history session id: {session_id}"));
    };
    if !is_plain_session_dir_name(rest) {
        return Err(format!("Invalid Copilot source session id: {rest}"));
    }
    Ok(rest)
}

pub(super) fn resolve_copilot_events_path(
    _conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if !is_plain_session_dir_name(source_session_id) {
        return Err(format!(
            "Invalid Copilot source session id: {source_session_id}"
        ));
    }
    for root in copilot_session_state_dirs()? {
        let candidate = root.join(source_session_id).join(EVENTS_FILENAME);
        if ensure_exact_copilot_events_file(&candidate, &root, source_session_id).is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Copilot history file not found for session: {source_session_id}"
    ))
}

pub(super) fn ensure_exact_copilot_events_file(
    path: &Path,
    root: &Path,
    source_session_id: &str,
) -> Result<(), String> {
    if !is_plain_session_dir_name(source_session_id) {
        return Err("Invalid Copilot session directory name".to_string());
    }
    let expected = root.join(source_session_id).join(EVENTS_FILENAME);
    if path != expected {
        return Err(format!(
            "Unexpected Copilot history path: {}",
            path.display()
        ));
    }
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Failed to inspect Copilot history root: {error}"))?;
    let session_metadata = fs::symlink_metadata(root.join(source_session_id))
        .map_err(|error| format!("Failed to inspect Copilot session directory: {error}"))?;
    let file_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Copilot events file: {error}"))?;
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || session_metadata.file_type().is_symlink()
        || !session_metadata.is_dir()
        || file_metadata.file_type().is_symlink()
        || !file_metadata.is_file()
    {
        return Err(format!("Unsafe Copilot history path: {}", path.display()));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve Copilot history root: {error}"))?;
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve Copilot events path: {error}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!(
            "Copilot history escapes its source root: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(super) fn copilot_session_state_dirs() -> Result<Vec<PathBuf>, String> {
    let home = app_paths::external_history_home_dir();
    Ok(copilot_session_state_dir_candidates(&home))
}

/// `~/.copilot/session-state` — one dir per session.
pub(super) fn copilot_session_state_dir_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".copilot").join("session-state")]
}

pub(super) fn copilot_session_store_db_path() -> Option<PathBuf> {
    Some(
        app_paths::external_history_home_dir()
            .join(".copilot")
            .join("session-store.db"),
    )
}
