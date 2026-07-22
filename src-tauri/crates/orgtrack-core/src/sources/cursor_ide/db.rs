//! Cursor IDE metadata cache and delta sync.
//!
//! Cursor owns `state.vscdb`; this module opens it read-only, parses only
//! composer metadata rows, and stores normalized session metadata in the shared
//! external-history cache table. Full bubble/transcript content stays in
//! Cursor's DB and is loaded lazily by `history.rs`.

use std::collections::{HashMap, HashSet};

use chrono::TimeZone;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::sources::imported_history::{
    cache as source_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
        SOURCE_CURSOR_IDE,
    },
};

use super::io::{
    cursor_conversation_index_path, cursor_db_path, open_cursor_conversation_index_db,
    open_cursor_db,
};
use super::CURSORIDE_SESSION_PREFIX;

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

/// Refresh the Cursor metadata cache from `conversation-search.db`.
///
/// A cheap indexed read yields per-session change signatures (`updated_at` +
/// `root_fingerprint`) without parsing any conversation blob, so only
/// genuinely-changed sessions are re-read — the same incremental model the
/// file-based sources use, and no per-restart scan of the multi-GB `state.vscdb`.
/// If Cursor's conversation index is absent (very old builds), there's simply
/// nothing to sync.
pub(crate) fn refresh_catalog(cache_conn: &mut Connection) -> Result<(), String> {
    delta_sync(cache_conn)
}

fn delta_sync(cache_conn: &mut Connection) -> Result<(), String> {
    let Some(index_conn) = open_cursor_conversation_index_db() else {
        return Ok(());
    };
    // A missing/foreign `conversations` table degrades to "no sessions" rather
    // than failing the whole session list.
    let discovered = discover_from_index(&index_conn).unwrap_or_default();

    // Content lives in `state.vscdb`; open it only to parse the changed few. Its
    // path is the session's store path even when we can't open it (cloud rows).
    let cursor_conn = open_cursor_db();
    let source_path = cursor_db_path()
        .or_else(cursor_conversation_index_path)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();

    let signatures = discovered
        .iter()
        .map(|row| row.signature(&source_path))
        .collect::<Vec<_>>();
    let live_parent_ids = source_cache::live_ids_from_signatures(&signatures);
    let live_parent_id_set = live_parent_ids.iter().cloned().collect::<HashSet<_>>();
    let cached_child_ids_by_parent = cached_cursor_child_ids_by_parent(cache_conn)?;
    let changed = source_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_CURSOR_IDE,
        &discovered,
        |row| row.signature(&source_path),
    )?;
    let changed_parent_ids = changed
        .iter()
        .map(|row| row.id.clone())
        .collect::<HashSet<_>>();
    let mut authoritative_changed_parent_ids = HashSet::new();
    let mut live_ids = live_parent_ids;
    let mut inputs = Vec::new();

    for row in changed {
        let built = build_inputs_from_index(cursor_conn.as_ref(), row, &source_path)?;
        if built.child_list_authoritative {
            authoritative_changed_parent_ids.insert(row.id.clone());
        }
        live_ids.extend(built.live_child_ids);
        inputs.extend(built.inputs);
    }

    // Unchanged parents retain their cached children without touching the large
    // composer blobs. If a changed parent's blob was temporarily unavailable,
    // retain its previous children too instead of pruning good cache rows.
    for (parent_id, child_ids) in cached_child_ids_by_parent {
        if !live_parent_id_set.contains(&parent_id) {
            continue;
        }
        let changed_with_authoritative_children = changed_parent_ids.contains(&parent_id)
            && authoritative_changed_parent_ids.contains(&parent_id);
        if !changed_with_authoritative_children {
            live_ids.extend(child_ids);
        }
    }

    source_cache::sync_source_cache_from_conn(cache_conn, SOURCE_CURSOR_IDE, live_ids, inputs)?;
    Ok(())
}

fn cached_cursor_child_ids_by_parent(
    cache_conn: &Connection,
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = cache_conn
        .prepare(
            "SELECT source_session_id, parent_session_id
             FROM imported_history_session_cache
             WHERE source = ?1 AND parent_session_id != ''",
        )
        .map_err(|err| format!("Failed to prepare cached Cursor child query: {err}"))?;
    let rows = stmt
        .query_map([SOURCE_CURSOR_IDE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("Failed to query cached Cursor children: {err}"))?;

    let mut child_ids_by_parent = HashMap::<String, Vec<String>>::new();
    for row in rows {
        let (child_id, parent_session_id) =
            row.map_err(|err| format!("Failed to read cached Cursor child row: {err}"))?;
        let Some(parent_id) = parent_session_id.strip_prefix(CURSORIDE_SESSION_PREFIX) else {
            continue;
        };
        child_ids_by_parent
            .entry(parent_id.to_string())
            .or_default()
            .push(child_id);
    }
    Ok(child_ids_by_parent)
}

fn discover_from_index(index_conn: &Connection) -> Result<Vec<CursorIndexRow>, String> {
    let mut stmt = index_conn
        .prepare(CONVERSATION_INDEX_QUERY)
        .map_err(|err| format!("Failed to prepare Cursor conversation index query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CursorIndexRow {
                id: row.get::<_, String>(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                updated_at_ms: row.get::<_, i64>(2)?,
                is_archived: row.get::<_, i64>(3)? != 0,
                root_fingerprint: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to read Cursor conversation index: {err}"))?;

    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(|err| format!("Failed to read Cursor index row: {err}"))?;
        if !row.id.is_empty() {
            out.push(row);
        }
    }
    Ok(out)
}

/// Build a cache row for a changed index conversation. Point-looks-up its
/// `composerData` in `state.vscdb` for the rich metadata (status / mode / tokens
/// / impact); if that's missing (state.vscdb absent or a cloud-only row), falls
/// back to a minimal row carrying just the index's title + timestamp.
fn build_inputs_from_index(
    cursor_conn: Option<&Connection>,
    row: &CursorIndexRow,
    source_path: &str,
) -> Result<CursorParentBuild, String> {
    let record_key = format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{}", row.id);
    if let Some(cursor_conn) = cursor_conn {
        if let Some(raw) = load_composer_raw(cursor_conn, &row.id)? {
            let mut input = cache_input_from_raw(
                cursor_conn,
                &row.id,
                source_path,
                &record_key,
                row.updated_at_ms,
                row.is_archived as i64,
                &row.root_fingerprint,
                &raw,
                None,
            )?;
            // Sort/display recency comes from the index's authoritative
            // `updated_at`, not the composer's possibly-stale last-bubble time.
            if row.updated_at_ms > 0 {
                input.updated_at_ms = row.updated_at_ms;
            }
            let mut seen_child_ids = HashSet::new();
            let live_child_ids = raw
                .subagent_composer_ids
                .iter()
                .map(|id| id.trim())
                .filter(|id| !id.is_empty() && *id != row.id)
                .filter(|id| seen_child_ids.insert((*id).to_string()))
                .map(str::to_string)
                .collect::<Vec<_>>();
            let mut inputs = Vec::with_capacity(live_child_ids.len() + 1);
            inputs.push(input);
            for child_id in &live_child_ids {
                let Some(child_raw) = load_composer_raw(cursor_conn, child_id)? else {
                    continue;
                };
                let child_parent_id = child_raw
                    .subagent_info
                    .as_ref()
                    .map(|info| info.parent_composer_id.trim())
                    .filter(|parent_id| !parent_id.is_empty())
                    .unwrap_or(&row.id);
                let child_record_key =
                    format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{child_id}");
                let child_source_mtime = child_raw
                    .created_at
                    .max(child_raw.last_updated_at)
                    .max(row.updated_at_ms);
                inputs.push(cache_input_from_raw(
                    cursor_conn,
                    child_id,
                    source_path,
                    &child_record_key,
                    child_source_mtime,
                    0,
                    &format!("parent:{child_parent_id}"),
                    &child_raw,
                    Some(child_parent_id),
                )?);
            }
            return Ok(CursorParentBuild {
                inputs,
                live_child_ids,
                child_list_authoritative: true,
            });
        }
    }
    Ok(CursorParentBuild {
        inputs: vec![minimal_cache_input_from_index(
            row,
            source_path,
            &record_key,
        )],
        live_child_ids: Vec::new(),
        child_list_authoritative: false,
    })
}

/// Minimal cache row from the index alone — used when the composer blob is
/// unavailable. Lists the session with its title and last-updated time; the
/// rich fields fill in if the blob reappears (the signature stays keyed on the
/// index, so a later scan won't spuriously re-import).
fn minimal_cache_input_from_index(
    row: &CursorIndexRow,
    source_path: &str,
    record_key: &str,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: row.id.clone(),
        session_id: super::canonical_session_id(&row.id),
        source_path: source_path.to_string(),
        source_record_key: record_key.to_string(),
        source_mtime_ms: row.updated_at_ms,
        source_size_bytes: row.is_archived as i64,
        source_fingerprint: row.root_fingerprint.clone(),
        parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        name: row.title.clone(),
        created_at_ms: row.updated_at_ms,
        updated_at_ms: row.updated_at_ms,
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: None,
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: true,
        source_metadata_json: serde_json::to_string(&CursorCacheMetadata::default()).ok(),
        parent_session_id: None,
    }
}

/// Point-lookup + parse a single `composerData:<id>` row (fast; primary key).
fn load_composer_raw(
    cursor_conn: &Connection,
    id: &str,
) -> Result<Option<RawComposerData>, String> {
    let key = format!("{COMPOSER_KEY_PREFIX}{id}");
    let value: Option<String> = cursor_conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Cursor composer {id}: {err}"))?;
    let Some(value) = value else {
        return Ok(None);
    };
    // A malformed blob shouldn't fail the whole sync — treat it as absent.
    Ok(serde_json::from_str(&value).ok())
}

/// Normalize a parsed `composerData` blob into a cache row.
#[allow(clippy::too_many_arguments)]
fn cache_input_from_raw(
    cursor_conn: &Connection,
    id: &str,
    source_path: &str,
    source_record_key: &str,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: &str,
    raw: &RawComposerData,
    parent_source_session_id: Option<&str>,
) -> Result<ImportedHistoryCacheInput, String> {
    let model = raw
        .model_config
        .as_ref()
        .map(|config| config.model_name.trim())
        .filter(|model_name| !model_name.is_empty())
        .map(str::to_string);
    let last_active_at = cursor_last_active_at(cursor_conn, raw)?;
    // Git + touched-file metadata straight from the composer blob (these used to
    // be computed lazily on hover; now they ride in the row like every other
    // source).
    let workspace = super::helpers::cursor_workspace_metadata_from_parts(
        &raw.tracked_git_repos,
        raw.workspace_identifier.as_ref(),
    );
    let touched_files = super::helpers::cursor_touched_files_from_states(&raw.original_file_states);
    let metadata = CursorCacheMetadata {
        status: raw.status.clone(),
        is_agentic: raw.is_agentic,
        mode: raw.unified_mode.clone(),
    };
    let source_metadata_json = serde_json::to_string(&metadata)
        .map_err(|err| format!("Failed to encode Cursor metadata cache payload: {err}"))?;

    let parent_session_id = parent_source_session_id
        .map(str::trim)
        .filter(|parent_id| !parent_id.is_empty() && *parent_id != id)
        .map(|parent_id| format!("{CURSORIDE_SESSION_PREFIX}{parent_id}"));
    Ok(ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: id.to_string(),
        session_id: super::canonical_session_id(id),
        source_path: source_path.to_string(),
        source_record_key: source_record_key.to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: source_fingerprint.to_string(),
        parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        name: raw.name.clone(),
        created_at_ms: raw.created_at,
        updated_at_ms: last_active_at,
        model,
        input_tokens: raw.context_tokens_used as i64,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: workspace.repo_path,
        branch: workspace.branch,
        impact: ImportedHistoryImpactStats {
            files_changed: raw.files_changed_count,
            lines_added: raw.total_lines_added,
            lines_removed: raw.total_lines_removed,
            touched_files,
        },
        // Child rows are fetched through `es_get_child_sessions`, not through
        // root-session pagination or analytics lists.
        listable: parent_session_id.is_none(),
        source_metadata_json: Some(source_metadata_json),
        parent_session_id,
    })
}

fn cursor_last_active_at(cursor_conn: &Connection, raw: &RawComposerData) -> Result<i64, String> {
    let mut last_active_at = raw.created_at.max(raw.last_updated_at);
    if let Some(last_header) = raw
        .full_conversation_headers_only
        .last()
        .filter(|header| !header.bubble_id.is_empty())
    {
        let bubble_key = format!(
            "{BUBBLE_KEY_PREFIX}{}:{}",
            raw.composer_id, last_header.bubble_id
        );
        let bubble_json: Option<String> = cursor_conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                params![bubble_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("Failed to read Cursor latest bubble timestamp: {err}"))?;
        if let Some(value) = bubble_json {
            if let Ok(timestamp) = serde_json::from_str::<BubbleTimestamp>(&value) {
                let bubble_active_at = parse_iso_to_epoch_ms(&timestamp.created_at);
                if bubble_active_at > 0 {
                    last_active_at = last_active_at.max(bubble_active_at);
                }
            }
        }
    }
    Ok(last_active_at)
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

fn parse_iso_to_epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_composer_detects_subagent_info_when_present() {
        let json = r#"{
            "composerId": "c6f60eb9-575a-4478-aef7-037ee6c9f620",
            "name": "Cleanup bucket A",
            "createdAt": 1746150752293,
            "status": "completed",
            "contextTokensUsed": 12345.0,
            "subagentInfo": {
                "subagentType": 3,
                "subagentTypeName": "generalPurpose",
                "parentComposerId": "df05eda5-7f2e-40d1-9e15-1667a1c49af2"
            }
        }"#;
        let row: RawComposerData = serde_json::from_str(json).expect("parse");
        let info = row.subagent_info.expect("subagent info");
        assert_eq!(info.subagent_type_name, "generalPurpose");
        assert_eq!(
            info.parent_composer_id,
            "df05eda5-7f2e-40d1-9e15-1667a1c49af2"
        );
    }

    #[test]
    fn raw_composer_treats_missing_subagent_info_as_top_level() {
        let json = r#"{
            "composerId": "df05eda5-7f2e-40d1-9e15-1667a1c49af2",
            "name": "User-initiated session",
            "createdAt": 1746150752293,
            "status": "completed",
            "contextTokensUsed": 0.0
        }"#;
        let row: RawComposerData = serde_json::from_str(json).expect("parse");
        assert!(row.subagent_info.is_none());
    }

    #[test]
    fn raw_composer_treats_null_subagent_info_as_top_level() {
        let json = r#"{
            "composerId": "abc",
            "name": "Top-level",
            "createdAt": 1,
            "status": "",
            "contextTokensUsed": 0.0,
            "subagentInfo": null
        }"#;
        let row: RawComposerData = serde_json::from_str(json).expect("parse");
        assert!(row.subagent_info.is_none());
    }

    #[test]
    fn cursor_cache_metadata_round_trips() {
        let metadata = CursorCacheMetadata {
            status: "completed".to_string(),
            is_agentic: true,
            mode: "agent".to_string(),
        };
        let encoded = serde_json::to_string(&metadata).expect("encode");
        let decoded: CursorCacheMetadata = serde_json::from_str(&encoded).expect("decode");

        assert_eq!(decoded.status, "completed");
        assert!(decoded.is_agentic);
        assert_eq!(decoded.mode, "agent");
    }

    fn index_db_with_rows() -> Connection {
        let conn = Connection::open_in_memory().expect("open index db");
        conn.execute(
            "CREATE TABLE conversations (id TEXT, title TEXT, updated_at INTEGER, \
             is_archived INTEGER, root_fingerprint TEXT, source TEXT)",
            [],
        )
        .expect("create conversations");
        for (id, title, updated, archived, fp, source) in [
            ("c1", "Local chat", 1700, 0, "fp1", "local"),
            ("c2", "Archived", 1800, 1, "fp2", "local"),
            ("c3", "Cloud only", 1900, 0, "fp3", "cloud-cache"),
        ] {
            conn.execute(
                "INSERT INTO conversations VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, title, updated, archived, fp, source],
            )
            .expect("insert conversation");
        }
        conn
    }

    #[test]
    fn index_discovery_reads_only_local_rows() {
        let conn = index_db_with_rows();
        let mut rows = discover_from_index(&conn).expect("discover");
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        // cloud-cache row (c3) is excluded — its content isn't in state.vscdb.
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "c1");
        assert_eq!(rows[0].title, "Local chat");
        assert_eq!(rows[0].updated_at_ms, 1700);
        assert!(!rows[0].is_archived);
        assert!(rows[1].is_archived);
    }

    #[test]
    fn index_signature_tracks_update_archive_and_fingerprint() {
        let row = CursorIndexRow {
            id: "c1".into(),
            title: "t".into(),
            updated_at_ms: 1700,
            is_archived: false,
            root_fingerprint: "fp1".into(),
        };
        let sig = row.signature("/p/state.vscdb");
        assert_eq!(sig.source_session_id, "c1");
        assert_eq!(sig.source_mtime_ms, 1700);
        assert_eq!(sig.source_size_bytes, 0);
        assert_eq!(sig.source_fingerprint, "fp1");
        assert_eq!(sig.parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
        // Archiving alone changes the signature (rides in source_size_bytes).
        let archived = CursorIndexRow {
            is_archived: true,
            ..row.clone()
        };
        assert_ne!(
            archived.signature("/p").source_size_bytes,
            sig.source_size_bytes
        );
    }

    #[test]
    fn build_input_from_index_without_composer_uses_index_fields() {
        let row = CursorIndexRow {
            id: "c9".into(),
            title: "Just title".into(),
            updated_at_ms: 4242,
            is_archived: false,
            root_fingerprint: "fp".into(),
        };
        let built =
            build_inputs_from_index(None, &row, "/store/state.vscdb").expect("build inputs");
        assert!(!built.child_list_authoritative);
        assert!(built.live_child_ids.is_empty());
        assert_eq!(built.inputs.len(), 1);
        let input = &built.inputs[0];
        assert_eq!(input.session_id, format!("{CURSORIDE_SESSION_PREFIX}c9"));
        assert_eq!(input.name, "Just title");
        assert_eq!(input.created_at_ms, 4242);
        assert_eq!(input.updated_at_ms, 4242);
        assert_eq!(input.source_mtime_ms, 4242);
        assert!(input.listable);
        assert!(input.model.is_none());
    }

    #[test]
    fn build_input_from_index_with_composer_reads_rich_metadata() {
        let cursor = Connection::open_in_memory().expect("open cursor db");
        cursor
            .execute(
                "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
                [],
            )
            .expect("create cursorDiskKV");
        let composer = serde_json::json!({
            "composerId": "c1", "name": "Rich", "createdAt": 1000, "lastUpdatedAt": 2000,
            "status": "completed", "isAgentic": true, "unifiedMode": "agent",
            "totalLinesAdded": 5, "totalLinesRemoved": 2, "filesChangedCount": 1,
            "contextTokensUsed": 42.0,
            "trackedGitRepos": [{"repoPath": "/repo/orgii", "branches": [{"branchName": "fix/295"}]}],
            "originalFileStates": {
                "file:///repo/orgii/src/a.ts": {"isNewlyCreated": false, "contentKey": "k1"},
                "file:///repo/orgii/src/b.ts": {"isNewlyCreated": true, "contentKey": ""},
                "file:///repo/orgii/src/untouched.ts": {"isNewlyCreated": false, "contentKey": ""}
            }
        })
        .to_string();
        cursor
            .execute(
                "INSERT INTO cursorDiskKV VALUES ('composerData:c1', ?1)",
                params![composer],
            )
            .expect("insert composer");

        let row = CursorIndexRow {
            id: "c1".into(),
            title: "Index title".into(),
            updated_at_ms: 3000,
            is_archived: false,
            root_fingerprint: "fp".into(),
        };
        let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build inputs");
        assert!(built.child_list_authoritative);
        assert!(built.live_child_ids.is_empty());
        assert_eq!(built.inputs.len(), 1);
        let input = &built.inputs[0];
        // Rich fields come from the composer blob…
        assert_eq!(input.name, "Rich");
        assert_eq!(input.created_at_ms, 1000);
        assert_eq!(input.impact.lines_added, 5);
        assert_eq!(input.input_tokens, 42);
        // …including git + touched-file metadata (the point of the unification).
        assert_eq!(input.repo_path.as_deref(), Some("/repo/orgii"));
        assert_eq!(input.branch.as_deref(), Some("fix/295"));
        let mut touched = input.impact.touched_files.clone();
        touched.sort();
        // Edited (contentKey) + newly-created files, but not the untouched one.
        assert_eq!(
            touched,
            vec!["/repo/orgii/src/a.ts", "/repo/orgii/src/b.ts"]
        );
        // …while recency + change-signature come from the index row.
        assert_eq!(input.updated_at_ms, 3000);
        assert_eq!(input.source_mtime_ms, 3000);
        assert_eq!(input.source_fingerprint, "fp");
    }

    #[test]
    fn changed_parent_builds_collapsible_subagent_rows() {
        let cursor = Connection::open_in_memory().expect("open cursor db");
        cursor
            .execute(
                "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
                [],
            )
            .expect("create cursorDiskKV");
        let parent = serde_json::json!({
            "composerId": "parent-1",
            "name": "Parent",
            "createdAt": 1000,
            "lastUpdatedAt": 3000,
            "subagentComposerIds": ["child-1", "child-1", "", "parent-1"]
        })
        .to_string();
        let child = serde_json::json!({
            "composerId": "child-1",
            "name": "Explore codebase",
            "createdAt": 1500,
            "lastUpdatedAt": 2500,
            "status": "completed",
            "subagentInfo": {
                "subagentTypeName": "explore",
                "parentComposerId": "parent-1",
                "toolCallId": "tool-1"
            }
        })
        .to_string();
        cursor
            .execute(
                "INSERT INTO cursorDiskKV VALUES ('composerData:parent-1', ?1)",
                params![parent],
            )
            .expect("insert parent");
        cursor
            .execute(
                "INSERT INTO cursorDiskKV VALUES ('composerData:child-1', ?1)",
                params![child],
            )
            .expect("insert child");

        let row = CursorIndexRow {
            id: "parent-1".into(),
            title: "Index parent".into(),
            updated_at_ms: 3000,
            is_archived: false,
            root_fingerprint: "fp".into(),
        };
        let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build inputs");

        assert!(built.child_list_authoritative);
        assert_eq!(built.live_child_ids, vec!["child-1"]);
        assert_eq!(built.inputs.len(), 2);
        let parent_input = &built.inputs[0];
        assert!(parent_input.listable);
        assert!(parent_input.parent_session_id.is_none());
        let child_input = &built.inputs[1];
        assert_eq!(
            child_input.session_id,
            format!("{CURSORIDE_SESSION_PREFIX}child-1")
        );
        assert!(!child_input.listable);
        assert_eq!(
            child_input.parent_session_id.as_deref(),
            Some("cursoride-parent-1")
        );
        assert_eq!(child_input.name, "Explore codebase");
    }
}
