//! Session helper: list filter, cache-row conversion, and workspace metadata.

use super::*;

// ============================================================================
// Session helper: list filter & cache-row conversion
// ============================================================================

#[derive(Debug, Default)]
pub(in crate::sources::cursor_ide) struct CursorUserBubbleProbe {
    pub has_user_bubble: bool,
    pub first_user_preview: Option<String>,
}

/// Inspect only one composer's indexed bubble-key range.
///
/// Cursor occasionally omits a bubble from
/// `fullConversationHeadersOnly`, so header point-lookups alone are not an
/// authoritative existence check. The primary-key range keeps this bounded to
/// the requested session and avoids the old whole-`cursorDiskKV` scan.
pub(in crate::sources::cursor_ide) fn probe_indexed_cursor_user_bubbles(
    conn: &Connection,
    composer_id: &str,
) -> Result<CursorUserBubbleProbe, String> {
    let prefix = format!("bubbleId:{composer_id}:");
    let upper_bound = format!("bubbleId:{composer_id};");
    let mut stmt = conn
        .prepare(
            "SELECT value
             FROM cursorDiskKV
             WHERE key >= ?1 AND key < ?2
               AND CASE
                     WHEN json_valid(value)
                     THEN json_extract(value, '$.type')
                   END = ?3
             ORDER BY key ASC",
        )
        .map_err(|err| format!("Failed to prepare Cursor user-bubble range lookup: {err}"))?;
    let rows = stmt
        .query_map(
            rusqlite::params![prefix, upper_bound, CURSOR_BUBBLE_TYPE_USER],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|err| format!("Failed to query Cursor user-bubble range: {err}"))?;
    let mut probe = CursorUserBubbleProbe::default();
    for row in rows {
        let Some(value) =
            row.map_err(|err| format!("Failed to read Cursor user-bubble range row: {err}"))?
        else {
            continue;
        };
        let Ok(bubble) = serde_json::from_str::<RawBubble>(&value) else {
            continue;
        };
        if bubble.bubble_type != CURSOR_BUBBLE_TYPE_USER {
            continue;
        }
        probe.has_user_bubble = true;
        let preview = preview_text(&bubble.text);
        if !preview.is_empty() {
            probe.first_user_preview = Some(preview);
            break;
        }
    }
    Ok(probe)
}

/// Convert a cache row to the sidebar-ready session shape.
///
/// Does NOT open Cursor's `state.vscdb` — all fields come from the delta-sync
/// cache. Hover-only fields (`repo_path`, `repo_name`, `touched_files`, `branch`)
/// are intentionally left empty; they are fetched on demand by
/// `cursor_ide_session_detail` when the hover card opens.
pub(in crate::sources::cursor_ide) fn cache_row_to_session_row(
    row: super::db::CursorSession,
) -> Result<CursorIdeSessionRow, String> {
    let session_id = format!("{}{}", CURSORIDE_SESSION_PREFIX, row.id);
    let created_iso = epoch_ms_to_iso(row.created_at);
    let updated_iso = if row.last_active_at > 0 {
        epoch_ms_to_iso(row.last_active_at)
    } else {
        created_iso.clone()
    };
    let model = if row.model.is_empty() {
        None
    } else {
        Some(row.model)
    };
    let repo_name = row.repo_path.as_deref().and_then(repo_name_from_path);
    Ok(CursorIdeSessionRow {
        session_id,
        name: if row.name.is_empty() {
            "Untitled Cursor session".to_string()
        } else {
            row.name
        },
        status: if row.status.is_empty() {
            "completed".to_string()
        } else {
            row.status
        },
        created_at: created_iso,
        updated_at: updated_iso,
        category: CURSOR_IDE_CATEGORY,
        read_only: true,
        model,
        total_tokens: row.tokens_used,
        lines_added: row.lines_added,
        lines_removed: row.lines_removed,
        files_changed: row.files_changed,
        touched_files: row.touched_files,
        background: false,
        is_active: false,
        repo_path: row.repo_path,
        repo_root_path: None,
        repo_remote_urls: Vec::new(),
        storage_path: Some(row.source_path),
        repo_name,
        branch: row.branch,
    })
}

/// The files a session edited, from the composer's `originalFileStates` map
/// (a key is present for every file whose before-state was captured for a diff).
pub(in crate::sources::cursor_ide) fn cursor_touched_files_from_states(
    original_file_states: &std::collections::BTreeMap<
        String,
        super::models::RawCursorOriginalFileState,
    >,
) -> Vec<String> {
    original_file_states
        .iter()
        .filter_map(|(uri, state)| {
            let has_edit_marker = state.is_newly_created || !state.content_key.trim().is_empty();
            has_edit_marker.then(|| cursor_file_uri_to_path(uri))
        })
        .collect()
}

fn cursor_file_uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file://")
        .unwrap_or(uri)
        .trim()
        .to_string()
}

// ============================================================================
// Workspace metadata helpers
// ============================================================================

pub(in crate::sources::cursor_ide) fn cursor_workspace_metadata_from_parts(
    tracked_git_repos: &[super::models::RawTrackedGitRepo],
    workspace_identifier: Option<&super::models::RawWorkspaceIdentifier>,
) -> CursorWorkspaceMetadata {
    let tracked_repo = tracked_git_repos.first();
    let repo_path = tracked_repo
        .map(|repo| repo.repo_path.trim())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| {
            workspace_identifier
                .and_then(|workspace| workspace.uri.as_ref())
                .and_then(|uri| {
                    let fs_path = uri.fs_path.trim();
                    if !fs_path.is_empty() {
                        Some(fs_path.to_string())
                    } else {
                        let path = uri.path.trim();
                        (!path.is_empty()).then(|| path.to_string())
                    }
                })
        });
    let branch = tracked_repo
        .and_then(|repo| repo.branches.first())
        .map(|branch| branch.branch_name.trim())
        .filter(|branch| !branch.is_empty())
        .map(str::to_string);

    CursorWorkspaceMetadata { repo_path, branch }
}

pub(in crate::sources::cursor_ide) fn repo_name_from_path(path: &str) -> Option<String> {
    PathBuf::from(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}
