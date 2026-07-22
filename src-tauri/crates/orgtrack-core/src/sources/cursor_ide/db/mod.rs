//! Cursor IDE metadata cache and delta sync.
//!
//! Cursor owns `state.vscdb`; this module opens it read-only, parses only
//! composer metadata rows, and stores normalized session metadata in the shared
//! external-history cache table. Full bubble/transcript content stays in
//! Cursor's DB and is loaded lazily by `history.rs`.

use chrono::TimeZone;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
// Re-exported so the `#[path]` test module's `use super::*` reaches `params!`.
#[cfg(test)]
use rusqlite::params;

use crate::sources::imported_history::{
    cache as source_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryRecordSignature, SOURCE_CURSOR_IDE},
};

use super::io::{
    cursor_conversation_index_path, cursor_db_path, open_cursor_conversation_index_db,
    open_cursor_db,
};
use super::CURSORIDE_SESSION_PREFIX;
// Re-exported so submodule code moved out of this file keeps resolving its
// original `super::helpers::…` / `super::canonical_session_id` paths (whose
// `super` was `cursor_ide`) against this `db` module instead.
use super::canonical_session_id;
use super::helpers;

mod sync;

use sync::delta_sync;
#[cfg(test)]
use sync::{build_inputs_from_index, discover_from_index};

// v6: top-level index rows now bring their `subagentComposerIds` into the cache
// as child sessions with `parent_session_id`, allowing the shared sidebar
// parent/child collapse flow to render Cursor subagents.
const CURSOR_IDE_METADATA_PARSER_VERSION: i64 = 6;
const COMPOSER_KEY_PREFIX: &str = "composerData:";
const BUBBLE_KEY_PREFIX: &str = "bubbleId:";
const SOURCE_RECORD_KEY_PREFIX: &str = "cursorDiskKV:";
/// Reads the lightweight conversation index. `source = 'local'` sessions have
/// their content in `state.vscdb`; cloud-cache rows are skipped.
const CONVERSATION_INDEX_QUERY: &str = "SELECT id, title, updated_at, is_archived, \
     root_fingerprint FROM conversations WHERE source = 'local'";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComposerData {
    #[serde(default)]
    composer_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    last_updated_at: i64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    is_agentic: bool,
    #[serde(default)]
    unified_mode: String,
    #[serde(default)]
    model_config: Option<ModelConfig>,
    #[serde(default)]
    total_lines_added: i64,
    #[serde(default)]
    total_lines_removed: i64,
    #[serde(default)]
    files_changed_count: i64,
    #[serde(default)]
    context_tokens_used: f64,
    #[serde(default)]
    full_conversation_headers_only: Vec<BubbleHeader>,
    #[serde(default)]
    subagent_info: Option<super::models::RawCursorSubagentInfo>,
    #[serde(default)]
    subagent_composer_ids: Vec<String>,
    #[serde(default)]
    tracked_git_repos: Vec<super::models::RawTrackedGitRepo>,
    #[serde(default)]
    workspace_identifier: Option<super::models::RawWorkspaceIdentifier>,
    #[serde(default)]
    original_file_states:
        std::collections::BTreeMap<String, super::models::RawCursorOriginalFileState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BubbleHeader {
    #[serde(default)]
    bubble_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BubbleTimestamp {
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfig {
    #[serde(default)]
    model_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorCacheMetadata {
    status: String,
    is_agentic: bool,
    mode: String,
}

/// One row of Cursor's `conversation-search.db` `conversations` table — the
/// cheap discovery signal that replaces scanning every `composerData` blob.
#[derive(Debug, Clone)]
struct CursorIndexRow {
    id: String,
    title: String,
    updated_at_ms: i64,
    is_archived: bool,
    root_fingerprint: String,
}

struct CursorParentBuild {
    inputs: Vec<ImportedHistoryCacheInput>,
    live_child_ids: Vec<String>,
    child_list_authoritative: bool,
}

impl CursorIndexRow {
    /// Change-detection signature straight from the index — no blob parse.
    /// `updated_at` + `root_fingerprint` change whenever the conversation does;
    /// `is_archived` rides in `source_size_bytes` so archive toggles re-sync.
    fn signature(&self, source_path: &str) -> ImportedHistoryRecordSignature {
        ImportedHistoryRecordSignature {
            source_session_id: self.id.clone(),
            source_path: source_path.to_string(),
            source_mtime_ms: self.updated_at_ms,
            source_size_bytes: self.is_archived as i64,
            source_fingerprint: self.root_fingerprint.clone(),
            parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSession {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_active_at: i64,
    pub status: String,
    pub is_agentic: bool,
    pub mode: String,
    pub model: String,
    pub source_path: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
    pub tokens_used: i64,
    /// Workspace repo the session ran in (from the composer's `trackedGitRepos`
    /// / `workspaceIdentifier`), plus the branch and the files it edited.
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub touched_files: Vec<String>,
    /// List-price estimate in USD. Cursor records only a single `tokens_used`
    /// total (no input/output split), so it is priced at a blended rate at the
    /// command boundary (this crate has no pricing dependency); `0.0` until then.
    #[serde(rename = "estimatedCost", default)]
    pub estimated_cost: f64,
    /// Metered spend recorded by the source. Always `0.0` for imported Cursor
    /// sessions — they record no dollar figures.
    #[serde(rename = "recordedCost", default)]
    pub recorded_cost: f64,
}

pub fn get_cursor_sessions(
    cache_conn: &mut Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<CursorSession>, String> {
    delta_sync(cache_conn)?;
    let start_epoch = date_str_to_epoch_ms(start_date);
    let end_epoch = date_str_to_epoch_ms_end(end_date);
    source_cache::query_cached_sessions_in_range_from_conn(
        cache_conn,
        SOURCE_CURSOR_IDE,
        start_epoch,
        end_epoch,
    )?
    .into_iter()
    .map(cursor_session_from_cached)
    .collect()
}

pub(crate) fn refresh_catalog(cache_conn: &mut Connection) -> Result<(), String> {
    delta_sync(cache_conn)
}

pub fn list_for_sidebar(
    cache_conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<(Vec<CursorSession>, bool), String> {
    list_for_sidebar_filtered(cache_conn, limit, offset, |_| Ok(true))
}

pub fn get_cached_session(
    cache_conn: &mut Connection,
    session_id: &str,
) -> Result<Option<CursorSession>, String> {
    delta_sync(cache_conn)?;
    source_cache::query_cached_session_from_conn(cache_conn, SOURCE_CURSOR_IDE, session_id)?
        .map(cursor_session_from_cached)
        .transpose()
}

pub fn list_for_sidebar_filtered<F>(
    cache_conn: &mut Connection,
    limit: usize,
    offset: usize,
    mut include: F,
) -> Result<(Vec<CursorSession>, bool), String>
where
    F: FnMut(&CursorSession) -> Result<bool, String>,
{
    delta_sync(cache_conn)?;

    let rows =
        source_cache::query_cached_sessions_for_source_from_conn(cache_conn, SOURCE_CURSOR_IDE)?;
    let mut matched = Vec::with_capacity(limit.saturating_add(1));
    let mut skipped = 0usize;

    for row in rows {
        let session = cursor_session_from_cached(row)?;
        if !include(&session)? {
            continue;
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        matched.push(session);
        if matched.len() > limit {
            break;
        }
    }

    let has_more = matched.len() > limit;
    if has_more {
        matched.truncate(limit);
    }
    Ok((matched, has_more))
}

fn cursor_session_from_cached(
    row: source_cache::ImportedHistoryCachedSession,
) -> Result<CursorSession, String> {
    let metadata = cursor_metadata_from_cached(&row)?;
    Ok(CursorSession {
        id: row.source_session_id,
        name: row.name,
        created_at: row.created_at_ms,
        last_active_at: row.updated_at_ms,
        status: metadata.status,
        is_agentic: metadata.is_agentic,
        mode: metadata.mode,
        model: row.model.unwrap_or_default(),
        source_path: row.source_path,
        lines_added: row.impact.lines_added,
        lines_removed: row.impact.lines_removed,
        files_changed: row.impact.files_changed,
        tokens_used: row.input_tokens + row.output_tokens,
        repo_path: row.repo_path,
        branch: row.branch,
        touched_files: row.impact.touched_files,
        estimated_cost: 0.0,
        recorded_cost: 0.0,
    })
}

fn cursor_metadata_from_cached(
    row: &source_cache::ImportedHistoryCachedSession,
) -> Result<CursorCacheMetadata, String> {
    let Some(source_metadata_json) = row.source_metadata_json.as_deref() else {
        return Ok(CursorCacheMetadata::default());
    };
    serde_json::from_str(source_metadata_json)
        .map_err(|err| format!("Failed to decode Cursor metadata cache payload: {err}"))
}

fn date_str_to_epoch_ms(date_str: &str) -> i64 {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return 0;
    }
    let year: i32 = parts[0].parse().unwrap_or(2025);
    let month: u32 = parts[1].parse().unwrap_or(1);
    let day: u32 = parts[2].parse().unwrap_or(1);

    match chrono::NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            let dt = date.and_hms_opt(0, 0, 0).unwrap_or_default();
            let local = chrono::Local
                .from_local_datetime(&dt)
                .single()
                .unwrap_or_else(chrono::Local::now);
            local.timestamp_millis()
        }
        None => 0,
    }
}

fn date_str_to_epoch_ms_end(date_str: &str) -> i64 {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return i64::MAX;
    }
    let year: i32 = parts[0].parse().unwrap_or(2025);
    let month: u32 = parts[1].parse().unwrap_or(1);
    let day: u32 = parts[2].parse().unwrap_or(1);

    match chrono::NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            let dt = date.and_hms_opt(23, 59, 59).unwrap_or_default();
            let local = chrono::Local
                .from_local_datetime(&dt)
                .single()
                .unwrap_or_else(chrono::Local::now);
            local.timestamp_millis()
        }
        None => i64::MAX,
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
