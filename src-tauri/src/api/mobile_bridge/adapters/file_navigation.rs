//! Event-scoped file navigation from Mobile Remote to the Desktop shell.

use std::path::{Path, PathBuf};

use core_types::extracted::ExtractedData;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::agent_sessions::event_pipeline::types::SessionEvent;
use crate::agent_sessions::session_directory::aggregation::list_all_sessions;
use crate::agent_sessions::session_directory::types::SessionFilter;
use crate::api::mobile_bridge::rpc::{RpcError, RpcErrorCode};

use super::session;

const MAX_ID_BYTES: usize = 1_024;
const MAX_TARGET_INDEX: usize = 64;
const OPEN_SESSION_FILE_EVENT: &str = "mobile-open-session-file";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionFileParams {
    session_id: String,
    round_id: String,
    event_id: String,
    #[serde(default)]
    target_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EventFileTarget {
    file_path: String,
    line: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionFileEvent {
    session_id: String,
    file_path: String,
    line: Option<usize>,
}

fn parse_params(params: &Value) -> Result<OpenSessionFileParams, RpcError> {
    let parsed: OpenSessionFileParams = serde_json::from_value(params.clone())
        .map_err(|_| RpcError::invalid_params("invalid session/open_file params"))?;
    for (name, value) in [
        ("sessionId", parsed.session_id.as_str()),
        ("roundId", parsed.round_id.as_str()),
        ("eventId", parsed.event_id.as_str()),
    ] {
        if value.trim().is_empty() || value.len() > MAX_ID_BYTES {
            return Err(RpcError::invalid_params(format!(
                "{name} is required and must be at most {MAX_ID_BYTES} bytes"
            )));
        }
    }
    if parsed.target_index > MAX_TARGET_INDEX {
        return Err(RpcError::invalid_params("targetIndex is out of range"));
    }
    Ok(parsed)
}

fn file_target_from_event(
    event: &SessionEvent,
    target_index: usize,
) -> Result<EventFileTarget, RpcError> {
    match event.extracted.as_ref() {
        Some(ExtractedData::File(file)) if target_index == 0 => Ok(EventFileTarget {
            file_path: file.file_path.clone(),
            line: file.start_line,
        }),
        Some(ExtractedData::Edit(edit)) => {
            let target = if edit.apply_patch_segments.is_empty() {
                if target_index != 0 {
                    return Err(RpcError::invalid_params("file target was not found"));
                }
                edit
            } else {
                edit.apply_patch_segments
                    .get(target_index)
                    .ok_or_else(|| RpcError::invalid_params("file target was not found"))?
            };
            Ok(EventFileTarget {
                file_path: target.file_path.clone(),
                line: target.new_start_line.or(target.old_start_line),
            })
        }
        Some(ExtractedData::DeleteFile(file)) if target_index == 0 => Ok(EventFileTarget {
            file_path: file.file_path.clone(),
            line: None,
        }),
        _ if target_index == 0 => event
            .file_path
            .as_ref()
            .filter(|path| !path.trim().is_empty())
            .map(|file_path| EventFileTarget {
                file_path: file_path.clone(),
                line: None,
            })
            .ok_or_else(|| RpcError::invalid_params("event does not own a file target")),
        _ => Err(RpcError::invalid_params("file target was not found")),
    }
}

fn session_workspace_root(session_id: &str) -> Result<PathBuf, RpcError> {
    let filter = SessionFilter {
        session_ids: Some(vec![session_id.to_string()]),
        limit: Some(1),
        ..Default::default()
    };
    let response = list_all_sessions(Some(&filter)).map_err(|err| {
        RpcError::new(
            RpcErrorCode::InvalidRequest,
            format!("failed to load session workspace: {err}"),
        )
    })?;
    let row = response
        .sessions
        .into_iter()
        .find(|row| row.session_id == session_id)
        .ok_or_else(|| {
            RpcError::new(
                RpcErrorCode::SessionNotFound,
                format!("session was not found: {session_id}"),
            )
        })?;
    row.worktree_path
        .or(row.repo_root_path)
        .or(row.repo_path)
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| RpcError::invalid_params("session has no workspace root"))
}

fn resolve_canonical_file(root: &Path, event_path: &str) -> Result<PathBuf, RpcError> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|_| RpcError::invalid_params("session workspace is unavailable"))?;
    if !canonical_root.is_dir() {
        return Err(RpcError::invalid_params(
            "session workspace is not a directory",
        ));
    }
    let path = Path::new(event_path);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };
    let canonical_file = std::fs::canonicalize(candidate)
        .map_err(|_| RpcError::invalid_params("event file is unavailable"))?;
    if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
        return Err(RpcError::invalid_params(
            "event file is outside the session workspace",
        ));
    }
    Ok(canonical_file)
}

/// Resolve an event-owned target and ask the paired Desktop shell to reveal it.
pub async fn open_session_file(params: &Value) -> Result<Value, RpcError> {
    let parsed = parse_params(params)?;
    let events = session::authoritative_round_events(&parsed.session_id, &parsed.round_id).await?;
    let event = events
        .iter()
        .find(|event| event.id == parsed.event_id)
        .ok_or_else(|| RpcError::invalid_params("event was not found in the requested round"))?;
    let target = file_target_from_event(event, parsed.target_index)?;
    let session_id = parsed.session_id.clone();
    let canonical_file = tokio::task::spawn_blocking(move || {
        let root = session_workspace_root(&session_id)?;
        resolve_canonical_file(&root, &target.file_path)
    })
    .await
    .map_err(|_| RpcError::new(RpcErrorCode::InvalidRequest, "file resolution failed"))??;

    let handle = crate::api::get_app_handle()
        .ok_or_else(|| RpcError::new(RpcErrorCode::InvalidRequest, "desktop app is unavailable"))?;
    let window = handle.get_webview_window("main").ok_or_else(|| {
        RpcError::new(
            RpcErrorCode::InvalidRequest,
            "desktop window is unavailable",
        )
    })?;
    let payload = OpenSessionFileEvent {
        session_id: parsed.session_id.clone(),
        file_path: canonical_file.to_string_lossy().into_owned(),
        line: target.line,
    };
    window
        .emit(OPEN_SESSION_FILE_EVENT, payload)
        .map_err(|err| {
            RpcError::new(
                RpcErrorCode::InvalidRequest,
                format!("failed to notify desktop window: {err}"),
            )
        })?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();

    Ok(json!({
        "accepted": true,
        "sessionId": parsed.session_id,
        "eventId": parsed.event_id,
        "targetIndex": parsed.target_index,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_file_must_remain_under_the_session_root() {
        let root = tempfile::tempdir().expect("workspace");
        let inside = root.path().join("src").join("app.ts");
        std::fs::create_dir_all(inside.parent().expect("parent")).expect("directory");
        std::fs::write(&inside, "export {};\n").expect("file");
        assert_eq!(
            resolve_canonical_file(root.path(), "src/app.ts").expect("inside"),
            std::fs::canonicalize(inside).expect("canonical inside")
        );

        let outside = tempfile::NamedTempFile::new().expect("outside file");
        assert!(resolve_canonical_file(root.path(), outside.path().to_str().unwrap()).is_err());
    }

    #[test]
    fn edit_target_index_selects_the_authoritative_patch_segment() {
        let extracted: ExtractedData = serde_json::from_value(json!({
            "kind": "edit",
            "filePath": "unused.ts",
            "fileName": "unused.ts",
            "language": "typescript",
            "applyPatchSegments": [
                {
                    "filePath": "src/a.ts",
                    "fileName": "a.ts",
                    "language": "typescript",
                    "newStartLine": 7
                },
                {
                    "filePath": "src/b.ts",
                    "fileName": "b.ts",
                    "language": "typescript",
                    "newStartLine": 11
                }
            ]
        }))
        .expect("extracted edit");
        let event: SessionEvent = serde_json::from_value(json!({
            "id": "event-1",
            "chunk_id": null,
            "sessionId": "session-1",
            "createdAt": "2026-08-31T00:00:00Z",
            "functionName": "apply_patch",
            "uiCanonical": "edit_file",
            "actionType": "tool_call",
            "args": {},
            "result": {},
            "source": "system",
            "displayText": "Edit",
            "displayStatus": "completed",
            "displayVariant": "tool_call",
            "activityStatus": "processed",
            "extracted": extracted
        }))
        .expect("session event");
        let target = file_target_from_event(&event, 1).expect("target");
        assert_eq!(target.file_path, "src/b.ts");
        assert_eq!(target.line, Some(11));
    }
}
