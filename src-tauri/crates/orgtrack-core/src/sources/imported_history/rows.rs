use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use super::{
    epoch_ms_to_iso, repo_name_from_path, DEFAULT_LIST_LIMIT, IMPORTED_HISTORY_CATEGORY,
    IMPORTED_STATUS_COMPLETED,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySessionRow {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub category: &'static str,
    pub read_only: bool,
    pub model: Option<String>,
    pub total_tokens: i64,
    pub background: bool,
    pub is_active: bool,
    pub repo_path: Option<String>,
    pub storage_path: Option<String>,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySessionPage {
    pub sessions: Vec<ImportedHistorySessionRow>,
    pub has_more: bool,
}

/// Lightweight cached row for list-only surfaces such as the session sidebar.
/// Carries the impact/model fields that card surfaces (e.g. the Kanban board)
/// render inline; the heavier source metadata stays in SQLite until requested.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySidebarRow {
    pub session_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// Live status override (`running`, `waiting_for_user`, `failed`)
    /// decorated by the desktop layer from lifecycle-hook signals or the
    /// transcript-mtime fallback. Absent means the frontend's historical
    /// default ("completed") applies. The core query never sets these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// The source app's own transcript file — the store of record for an
    /// imported session, which never has a `sessions.db` copy. Absent for
    /// rows cached before the path was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub total_tokens: i64,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySidebarPage {
    pub sessions: Vec<ImportedHistorySidebarRow>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistoryRecentPath {
    pub path: String,
    pub name: Option<String>,
    pub last_used_at: String,
    pub session_count: usize,
}

pub struct ImportedHistoryRowInput {
    pub session_id: String,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub repo_path: Option<String>,
    pub storage_path: Option<String>,
    pub branch: Option<String>,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImportedToolCall {
    pub call_id: String,
    pub raw_name: String,
    pub canonical_name: String,
    pub args: Value,
    pub created_at: String,
}

pub fn effective_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_LIST_LIMIT
    } else {
        limit
    }
}

pub fn page_from_rows(
    mut rows: Vec<ImportedHistorySessionRow>,
    limit: usize,
    offset: usize,
) -> ImportedHistorySessionPage {
    rows.sort_by(|session_a, session_b| session_b.updated_at.cmp(&session_a.updated_at));
    let limit = effective_limit(limit);
    let has_more = rows.len() > offset.saturating_add(limit);
    let sessions = rows.into_iter().skip(offset).take(limit).collect();
    ImportedHistorySessionPage { sessions, has_more }
}

pub fn row_from_input(input: ImportedHistoryRowInput) -> ImportedHistorySessionRow {
    let repo_name = input.repo_path.as_deref().and_then(repo_name_from_path);
    ImportedHistorySessionRow {
        session_id: input.session_id,
        name: input.name,
        status: IMPORTED_STATUS_COMPLETED.to_string(),
        created_at: epoch_ms_to_iso(input.created_at_ms),
        updated_at: epoch_ms_to_iso(input.updated_at_ms),
        category: IMPORTED_HISTORY_CATEGORY,
        read_only: true,
        model: input.model,
        total_tokens: input.input_tokens + input.output_tokens,
        background: false,
        is_active: false,
        repo_path: input.repo_path,
        storage_path: input.storage_path,
        repo_name,
        branch: input.branch,
        files_changed: input.files_changed,
        lines_added: input.lines_added,
        lines_removed: input.lines_removed,
        touched_files: input.touched_files,
        parent_session_id: input.parent_session_id,
    }
}

pub fn recent_paths_from_rows(
    rows: &[ImportedHistorySessionRow],
) -> Vec<ImportedHistoryRecentPath> {
    let paths = rows
        .iter()
        .filter_map(|row| {
            let path = row.repo_path.as_deref()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(ImportedHistoryRecentPath {
                path: path.to_string(),
                name: repo_name_from_path(path),
                last_used_at: row.updated_at.clone(),
                session_count: 1,
            })
        })
        .collect::<Vec<_>>();
    recent_paths_from_paths(&paths)
}

pub fn recent_paths_from_paths(
    paths: &[ImportedHistoryRecentPath],
) -> Vec<ImportedHistoryRecentPath> {
    let mut path_stats: HashMap<String, (Option<String>, String, usize)> = HashMap::new();

    for recent_path in paths {
        let path = recent_path.path.trim();
        if path.is_empty() {
            continue;
        }

        let entry = path_stats.entry(path.to_string()).or_insert_with(|| {
            (
                recent_path
                    .name
                    .clone()
                    .or_else(|| repo_name_from_path(path)),
                recent_path.last_used_at.clone(),
                0,
            )
        });
        if recent_path.last_used_at > entry.1 {
            entry.1 = recent_path.last_used_at.clone();
        }
        entry.2 += recent_path.session_count;
    }

    let mut recent_paths = path_stats
        .into_iter()
        .map(
            |(path, (name, last_used_at, session_count))| ImportedHistoryRecentPath {
                name,
                path,
                last_used_at,
                session_count,
            },
        )
        .collect::<Vec<_>>();
    recent_paths.sort_by(|path_a, path_b| path_b.last_used_at.cmp(&path_a.last_used_at));
    recent_paths
}
