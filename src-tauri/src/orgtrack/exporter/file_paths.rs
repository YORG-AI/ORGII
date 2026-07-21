//! Extraction of edited file paths out of raw tool payloads, and the repo
//! ownership check that keeps foreign-workspace edits out of an export.

use std::path::Path;

use core_types::tool_names;

use super::loaders::{table_columns, table_exists};

pub(super) fn is_file_edit_function(function_name: &str) -> bool {
    matches!(
        function_name,
        tool_names::EDIT_FILE
            | tool_names::APPLY_PATCH
            | tool_names::STORAGE_WRITE_FILE
            | tool_names::STORAGE_CREATE_FILE
            | tool_names::STORAGE_EDIT_FILE_BY_REPLACE
            | tool_names::STORAGE_APPEND_FILE
            | tool_names::STORAGE_FILE_RANGE_EDIT
            | tool_names::STORAGE_INSERT_CONTENT_AT_LINE
            | tool_names::CLI_DISPLAY_EDIT
            | tool_names::CLI_DISPLAY_WRITE
            | tool_names::CLI_DISPLAY_CREATE
            | tool_names::CLI_DISPLAY_PATCH
            | "file_diff"
    )
}

pub(super) fn extract_file_paths_from_json(
    function_name: &str,
    args_json: &str,
    result_json: &str,
) -> Vec<String> {
    let args =
        serde_json::from_str::<serde_json::Value>(args_json).unwrap_or(serde_json::Value::Null);
    let result =
        serde_json::from_str::<serde_json::Value>(result_json).unwrap_or(serde_json::Value::Null);
    let mut paths = Vec::new();

    if matches!(
        function_name,
        tool_names::APPLY_PATCH | tool_names::CLI_DISPLAY_PATCH
    ) {
        if let Some(patch_text) = args.get("patch_text").and_then(|value| value.as_str()) {
            paths.extend(extract_paths_from_patch_text(patch_text));
        }
        if let Some(patch_text) = args.get("patch").and_then(|value| value.as_str()) {
            paths.extend(extract_paths_from_patch_text(patch_text));
        }
    }

    let success = result.get("success").unwrap_or(&serde_json::Value::Null);
    for candidate in [
        args.get("file_path"),
        args.get("file_name"),
        args.get("path"),
        result.get("file_path"),
        result.get("path"),
        success.get("file_path"),
        success.get("path"),
    ] {
        if let Some(path) = candidate
            .and_then(|value| value.as_str())
            .filter(|path| !path.trim().is_empty())
        {
            paths.push(path.to_string());
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

fn extract_paths_from_patch_text(patch_text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch_text.lines() {
        let trimmed = line.trim();
        let path = trimmed
            .strip_prefix("*** Add File:")
            .or_else(|| trimmed.strip_prefix("*** Update File:"))
            .or_else(|| trimmed.strip_prefix("*** Delete File:"))
            .or_else(|| trimmed.strip_prefix("+++ b/"))
            .or_else(|| trimmed.strip_prefix("--- a/"));
        if let Some(path) = path
            .map(str::trim)
            .filter(|path| !path.is_empty() && *path != "/dev/null")
        {
            paths.push(path.to_string());
        }
    }
    paths
}

pub(super) fn path_belongs_to_repo(
    conn: &rusqlite::Connection,
    repo_path: &Path,
    session_id: &str,
    file_path: &str,
) -> Result<bool, String> {
    let path = Path::new(file_path);
    if path.is_absolute() {
        return Ok(path.starts_with(repo_path));
    }
    if file_path.starts_with("../") || file_path.contains("/../") {
        return Ok(false);
    }
    let Some(session_workspace) = session_workspace_path(conn, session_id)? else {
        return Ok(true);
    };
    Ok(Path::new(&session_workspace) == repo_path)
}

fn session_workspace_path(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    if table_exists(conn, "agent_sessions")? {
        let columns = table_columns(conn, "agent_sessions")?;
        if columns.contains_key("workspace_path") {
            let value = match conn.query_row(
                "SELECT workspace_path FROM agent_sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            ) {
                Ok(value) => value,
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(format!("Failed to read agent session workspace: {}", err)),
            };
            if value
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Ok(value);
            }
        }
    }
    if table_exists(conn, "code_sessions")? {
        let columns = table_columns(conn, "code_sessions")?;
        if columns.contains_key("repo_path") {
            let value = match conn.query_row(
                "SELECT repo_path FROM code_sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            ) {
                Ok(value) => value,
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(format!("Failed to read code session repo: {}", err)),
            };
            if value
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Ok(value);
            }
        }
    }
    Ok(None)
}
