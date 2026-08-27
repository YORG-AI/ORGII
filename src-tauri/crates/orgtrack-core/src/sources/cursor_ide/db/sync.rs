//! Delta-sync pipeline: discover changed conversations from Cursor's index and
//! materialize the changed few into normalized cache rows.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::sources::imported_history::{
    cache as source_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_CURSOR_IDE},
};

use super::*;

/// Refresh the Cursor metadata cache from Cursor's lightweight session index.
///
/// A cheap indexed read yields per-session change signatures (`updated_at` +
/// `root_fingerprint`) without parsing any conversation blob, so only
/// genuinely-changed sessions are re-read — the same incremental model the
/// file-based sources use, and no per-restart scan of the multi-GB `state.vscdb`.
/// Newer Cursor releases may omit `conversation-search.db`; those builds use
/// the single `composer.composerHeaders` row in `state.vscdb` as the bounded
/// discovery fallback.
pub(super) fn delta_sync(cache_conn: &mut Connection) -> Result<(), String> {
    // Content lives in `state.vscdb`; open it once and only parse the changed
    // few. Its path is the session's store path even when we can't open it.
    let cursor_conn = open_cursor_db();
    let index_conn = open_cursor_conversation_index_db();
    let Some(discovered) = discover_sessions(index_conn.as_ref(), cursor_conn.as_ref()) else {
        // Neither discovery source is authoritative right now. Retain the
        // last good cache instead of pruning it.
        return Ok(());
    };
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
                children: Vec::new(),
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

/// Resolve the authoritative discovery row set, or `None` when no source is
/// authoritative right now (the caller retains the last good cache).
///
/// Priority: a healthy `conversation-search.db` read wins; the bounded
/// `composer.composerHeaders` registry covers builds without the index. An
/// EMPTY index read is only trusted when the headers registry has nothing
/// either — newer Cursor builds may stop maintaining
/// `conversation-search.db` but leave the stale file on disk, and trusting
/// its emptiness would prune every cached session that headers still see.
pub(super) fn discover_sessions(
    index_conn: Option<&Connection>,
    cursor_conn: Option<&Connection>,
) -> Option<Vec<CursorIndexRow>> {
    let headers = || cursor_conn.and_then(|conn| discover_from_headers(conn).ok().flatten());
    match index_conn.map(discover_from_index) {
        Some(Ok(rows)) if rows.is_empty() => match headers() {
            Some(header_rows) if !header_rows.is_empty() => Some(header_rows),
            // Headers agree (authoritative empty) or are unavailable: the
            // empty index stands, as it did before headers discovery existed.
            _ => Some(rows),
        },
        Some(Ok(rows)) => Some(rows),
        Some(Err(_)) | None => headers(),
    }
}

/// Discover top-level conversations from Cursor's compact header registry.
///
/// This performs one primary-key lookup in `ItemTable`. It intentionally does
/// not scan `cursorDiskKV`; changed sessions are point-read later.
pub(super) fn discover_from_headers(
    cursor_conn: &Connection,
) -> Result<Option<Vec<CursorIndexRow>>, String> {
    let value = cursor_conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            params![COMPOSER_HEADERS_KEY],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Cursor composer headers: {err}"))?
        .flatten();
    let Some(value) = value else {
        return Ok(None);
    };
    let Ok(headers) = serde_json::from_str::<RawComposerHeaders>(&value) else {
        // Cursor may be between writes. The caller must retain the last good
        // cache rather than treating a partial JSON value as an empty index.
        return Ok(None);
    };

    let all_headers = headers.all_composers;
    // Rows whose `type` we do not recognize (today: "" and "head"). If a
    // future Cursor renames the value, every row lands here and the root
    // filter below yields an empty set — that is schema drift, not proof the
    // user deleted all sessions, and must not become an authoritative empty
    // that prunes the whole cache.
    let unrecognized_type_count = all_headers
        .iter()
        .filter(|header| !(header.row_type.is_empty() || header.row_type == "head"))
        .count();
    let mut children_by_parent = HashMap::<String, Vec<CursorIndexChild>>::new();
    for header in &all_headers {
        let Some(parent_id) = header
            .subagent_info
            .as_ref()
            .map(|info| info.parent_composer_id.trim())
            .filter(|parent_id| !parent_id.is_empty())
        else {
            continue;
        };
        let id = header.composer_id.trim();
        if id.is_empty() || id == parent_id || header.is_draft {
            continue;
        }
        children_by_parent
            .entry(parent_id.to_string())
            .or_default()
            .push(CursorIndexChild {
                id: id.to_string(),
                title: header.name.clone(),
                updated_at_ms: header_updated_at_ms(header),
            });
    }
    for children in children_by_parent.values_mut() {
        children.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        children.dedup_by(|left, right| left.id == right.id);
    }

    let rows = all_headers
        .into_iter()
        .filter(|header| header.row_type.is_empty() || header.row_type == "head")
        // Cursor keeps an `empty-state-draft` composer in the registry while
        // the New Agent screen is open. It has no transcript and is not a
        // sidebar conversation, so caching it creates a phantom session.
        .filter(|header| !header.is_draft)
        // Modern Cursor records subagents as ordinary `head` entries. They
        // belong under their parent and must not leak into the root list.
        .filter(|header| {
            header
                .subagent_info
                .as_ref()
                .map(|info| info.parent_composer_id.trim().is_empty())
                .unwrap_or(true)
        })
        .filter_map(|header| {
            let id = header.composer_id.trim();
            if id.is_empty() {
                return None;
            }
            let updated_at_ms = header_updated_at_ms(&header);
            let children = children_by_parent.remove(id).unwrap_or_default();
            let child_fingerprint = children
                .iter()
                .map(|child| format!("{}:{}", child.id, child.updated_at_ms))
                .collect::<Vec<_>>()
                .join(",");
            Some(CursorIndexRow {
                id: id.to_string(),
                title: header.name.clone(),
                updated_at_ms,
                is_archived: header.is_archived,
                root_fingerprint: format!(
                    "headers:{}:{}:{}:{child_fingerprint}",
                    header.created_at, header.last_updated_at, header.name,
                ),
                children,
            })
        })
        .collect::<Vec<_>>();
    if rows.is_empty() && unrecognized_type_count > 0 {
        // Every candidate was dropped by an unrecognized `type` value.
        // Retain the last good cache until the new shape is supported.
        return Ok(None);
    }
    Ok(Some(rows))
}

fn header_updated_at_ms(header: &RawComposerHeader) -> i64 {
    header
        .created_at
        .max(header.last_updated_at)
        .max(header.conversation_checkpoint_last_updated_at)
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
            if input.name.trim().is_empty() {
                input.name.clone_from(&row.title);
            }
            if input.created_at_ms <= 0 {
                input.created_at_ms = row.updated_at_ms;
            }
            let mut seen_child_ids = HashSet::new();
            let live_child_ids = raw
                .subagent_composer_ids
                .iter()
                .chain(row.children.iter().map(|child| &child.id))
                .map(|id| id.trim())
                .filter(|id| !id.is_empty() && *id != row.id)
                .filter(|id| seen_child_ids.insert((*id).to_string()))
                .map(str::to_string)
                .collect::<Vec<_>>();
            let mut inputs = Vec::with_capacity(live_child_ids.len() + 1);
            inputs.push(input);
            for child_id in &live_child_ids {
                let header_child = row.children.iter().find(|child| child.id == *child_id);
                let Some(child_raw) = load_composer_raw(cursor_conn, child_id)? else {
                    if let Some(header_child) = header_child {
                        inputs.push(minimal_cache_input_from_header_child(
                            row,
                            header_child,
                            source_path,
                        ));
                    }
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
                    .max(
                        header_child
                            .map(|child| child.updated_at_ms)
                            .unwrap_or_default(),
                    )
                    .max(row.updated_at_ms);
                let mut child_input = cache_input_from_raw(
                    cursor_conn,
                    child_id,
                    source_path,
                    &child_record_key,
                    child_source_mtime,
                    0,
                    &format!("parent:{child_parent_id}"),
                    &child_raw,
                    Some(child_parent_id),
                )?;
                if child_input.name.trim().is_empty() {
                    if let Some(header_child) = header_child {
                        child_input.name.clone_from(&header_child.title);
                    }
                }
                if child_input.created_at_ms <= 0 {
                    if let Some(header_child) = header_child {
                        child_input.created_at_ms = header_child.updated_at_ms;
                    }
                }
                if let Some(header_child) = header_child {
                    child_input.updated_at_ms =
                        child_input.updated_at_ms.max(header_child.updated_at_ms);
                }
                inputs.push(child_input);
            }
            return Ok(CursorParentBuild {
                inputs,
                live_child_ids,
                child_list_authoritative: true,
            });
        }
    }
    let mut inputs = vec![minimal_cache_input_from_index(
        row,
        source_path,
        &record_key,
    )];
    let mut live_child_ids = Vec::new();
    if let Some(cursor_conn) = cursor_conn {
        for child in &row.children {
            live_child_ids.push(child.id.clone());
            if let Some(child_raw) = load_composer_raw(cursor_conn, &child.id)? {
                let child_record_key = format!(
                    "{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{}",
                    child.id
                );
                let mut child_input = cache_input_from_raw(
                    cursor_conn,
                    &child.id,
                    source_path,
                    &child_record_key,
                    child.updated_at_ms.max(row.updated_at_ms),
                    0,
                    &format!("parent:{}", row.id),
                    &child_raw,
                    Some(&row.id),
                )?;
                if child_input.name.trim().is_empty() {
                    child_input.name.clone_from(&child.title);
                }
                inputs.push(child_input);
            } else {
                inputs.push(minimal_cache_input_from_header_child(
                    row,
                    child,
                    source_path,
                ));
            }
        }
    }
    Ok(CursorParentBuild {
        inputs,
        live_child_ids,
        child_list_authoritative: cursor_conn.is_some() && !row.children.is_empty(),
    })
}

fn minimal_cache_input_from_header_child(
    parent: &CursorIndexRow,
    child: &CursorIndexChild,
    source_path: &str,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: child.id.clone(),
        session_id: super::canonical_session_id(&child.id),
        source_path: source_path.to_string(),
        source_record_key: format!(
            "{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{}",
            child.id
        ),
        source_mtime_ms: child.updated_at_ms,
        source_size_bytes: 0,
        source_fingerprint: format!("header-child:{}:{}", parent.id, child.updated_at_ms),
        parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        name: child.title.clone(),
        created_at_ms: child.updated_at_ms,
        updated_at_ms: child.updated_at_ms,
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: None,
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: false,
        source_metadata_json: serde_json::to_string(&CursorCacheMetadata::default()).ok(),
        parent_session_id: Some(super::canonical_session_id(&parent.id)),
        client_origin: None,
        client_origin_raw: None,
    }
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
        client_origin: None,
        client_origin_raw: None,
    }
}

/// Point-lookup + parse a single `composerData:<id>` row (fast; primary key).
fn load_composer_raw(
    cursor_conn: &Connection,
    id: &str,
) -> Result<Option<RawComposerData>, String> {
    let key = format!("{COMPOSER_KEY_PREFIX}{id}");
    let value = cursor_conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            params![key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Cursor composer {id}: {err}"))?
        .flatten();
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
        client_origin: None,
        client_origin_raw: None,
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
        let bubble_json = cursor_conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                params![bubble_key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| format!("Failed to read Cursor latest bubble timestamp: {err}"))?
            .flatten();
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
