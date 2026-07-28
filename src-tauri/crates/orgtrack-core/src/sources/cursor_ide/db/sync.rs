//! Delta-sync pipeline: discover changed conversations from Cursor's index and
//! materialize the changed few into normalized cache rows.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::sources::imported_history::{
    cache as source_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_CURSOR_IDE},
};

use super::*;

/// Refresh the Cursor metadata cache from `conversation-search.db`.
///
/// A cheap indexed read yields per-session change signatures (`updated_at` +
/// `root_fingerprint`) without parsing any conversation blob, so only
/// genuinely-changed sessions are re-read — the same incremental model the
/// file-based sources use, and no per-restart scan of the multi-GB `state.vscdb`.
/// If Cursor's conversation index is absent (very old builds), there's simply
/// nothing to sync.
pub(super) fn delta_sync(cache_conn: &mut Connection) -> Result<(), String> {
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

pub(super) fn discover_from_index(index_conn: &Connection) -> Result<Vec<CursorIndexRow>, String> {
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
pub(super) fn build_inputs_from_index(
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

fn parse_iso_to_epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}
