//! Windsurf composer metadata listing and imported-history cache synchronization.

use super::*;

pub(super) fn sync_windsurf_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    sync_windsurf_history_cache_inner(cache_conn, true)
}

pub(super) fn sync_windsurf_history_cache_inner(
    cache_conn: &mut Connection,
    include_legacy_impact: bool,
) -> Result<(), String> {
    let Some((conn, db_path)) = open_windsurf_db() else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_WINDSURF,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&db_path, "Windsurf")?;
    let mut metas = list_windsurf_composer_meta_from_conn_inner(
        &conn,
        &db_path,
        source_mtime_ms,
        source_size_bytes,
        include_legacy_impact,
    )?;
    if !include_legacy_impact {
        for meta in &mut metas {
            if let Some(cached) = imported_cache::query_cached_session_from_conn(
                cache_conn,
                SOURCE_WINDSURF,
                &meta.source_session_id,
            )? {
                meta.impact = cached.impact;
            }
        }
    }
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let inputs = metas
        .into_iter()
        .map(composer_meta_to_cache_input)
        .collect::<Vec<_>>();
    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_WINDSURF, live_ids, inputs)
}

#[cfg(test)]
pub(super) fn list_windsurf_composer_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<WindsurfComposerMeta>, String> {
    list_windsurf_composer_meta_from_conn_inner(
        conn,
        db_path,
        source_mtime_ms,
        source_size_bytes,
        true,
    )
}

fn list_windsurf_composer_meta_from_conn_inner(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    include_legacy_impact: bool,
) -> Result<Vec<WindsurfComposerMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .map_err(|err| format!("Failed to prepare Windsurf composer query: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, Option<String>>(0))
        .map_err(|err| format!("Failed to query Windsurf composers: {err}"))?;

    // A single `state.vscdb` backs every composer, so fold its WAL/`-shm`
    // sidecars into each composer's fingerprint once.
    let sidecar_signature = imported_paths::sqlite_sidecar_signature(db_path);
    let mut metas = Vec::new();
    for row in rows {
        let Some(value) =
            row.map_err(|err| format!("Failed to read Windsurf composer row: {err}"))?
        else {
            continue;
        };
        let Ok(composer) = serde_json::from_str::<RawComposerData>(&value) else {
            continue;
        };
        if composer.composer_id.trim().is_empty() {
            continue;
        }
        let listable = is_listable_composer(&composer);
        let impact = if include_legacy_impact {
            composer_impact(conn, &composer)?
        } else {
            ImportedHistoryImpactStats::default()
        };
        let source_fingerprint = windsurf_source_fingerprint(&composer, &sidecar_signature);
        metas.push(WindsurfComposerMeta {
            source_session_id: composer.composer_id.clone(),
            source_path: db_path.to_string_lossy().to_string(),
            source_record_key: composer.composer_id.clone(),
            source_mtime_ms,
            source_size_bytes,
            source_fingerprint,
            composer,
            listable,
            impact,
        });
    }
    Ok(metas)
}

/// Content-aware change fingerprint for a Windsurf composer.
///
/// The `state.vscdb` mtime alone can stay flat across a same-mtime rewrite, so
/// this folds the composer's own identity/status/timestamp/token/turn-count
/// fields together with the shared WAL/`-shm` sidecar signature.
fn windsurf_source_fingerprint(composer: &RawComposerData, sidecar_signature: &str) -> String {
    [
        composer.composer_id.as_str(),
        composer.name.as_str(),
        composer.status.as_str(),
        &composer.created_at.to_string(),
        &composer.last_updated_at.to_string(),
        &composer.context_tokens_used.to_string(),
        &composer.full_conversation_headers_only.len().to_string(),
        composer
            .subagent_info
            .as_ref()
            .map(|info| info.parent_composer_id.as_str())
            .unwrap_or_default(),
        sidecar_signature,
    ]
    .join("|")
}

fn is_listable_composer(composer: &RawComposerData) -> bool {
    if composer.composer_id.trim().is_empty() || composer.name.trim().is_empty() {
        return false;
    }
    if composer.subagent_info.is_some() || composer.full_conversation_headers_only.is_empty() {
        return false;
    }
    true
}

fn composer_impact(
    conn: &Connection,
    composer: &RawComposerData,
) -> Result<ImportedHistoryImpactStats, String> {
    let key_prefix = format!("bubbleId:{}:", composer.composer_id);
    let mut stmt = conn
        .prepare(
            "SELECT
                json_extract(value, '$.toolFormerData.name'),
                json_extract(value, '$.toolFormerData.params')
             FROM cursorDiskKV
             WHERE substr(key, 1, length(?1)) = ?1
               AND json_valid(value)
               AND lower(COALESCE(json_extract(value, '$.toolFormerData.name'), ''))
                   IN ('edit_file', 'edit_file_v2', 'write_file', 'apply_patch')",
        )
        .map_err(|err| format!("Failed to prepare Windsurf compact impact query: {err}"))?;
    let mut rows = stmt
        .query([key_prefix])
        .map_err(|err| format!("Failed to query Windsurf compact edit rows: {err}"))?;
    let mut touched_files = std::collections::BTreeSet::new();
    let mut impact = ImportedHistoryImpactStats::default();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Failed to read Windsurf compact edit row: {err}"))?
    {
        let raw_name = row
            .get::<_, Option<String>>(0)
            .map_err(|err| format!("Failed to read Windsurf compact tool name: {err}"))?
            .unwrap_or_default();
        let raw_args = row
            .get::<_, Option<String>>(1)
            .map_err(|err| format!("Failed to read Windsurf compact tool args: {err}"))?
            .unwrap_or_default();
        let (canonical_name, args) =
            normalize_windsurf_tool_call(&raw_name, imported_history::parse_inner_json(&raw_args));
        let call = ImportedToolCall {
            call_id: String::new(),
            raw_name,
            canonical_name,
            args,
            created_at: String::new(),
        };
        let chunk = imported_history::tool_call_chunk(
            "windsurfapp-catalog",
            WINDSURF_PROVIDER_SLUG,
            0,
            &call,
            "",
        );
        let one = imported_history::impact_from_edit_chunks(&[chunk]);
        impact.lines_added = impact.lines_added.saturating_add(one.lines_added);
        impact.lines_removed = impact.lines_removed.saturating_add(one.lines_removed);
        touched_files.extend(one.touched_files);
    }
    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
    Ok(impact)
}

pub(super) fn composer_meta_to_cache_input(
    meta: WindsurfComposerMeta,
) -> ImportedHistoryCacheInput {
    let metadata = workspace_metadata_from_composer(&meta.composer);
    let model = meta
        .composer
        .model_config
        .and_then(|config| (!config.model_name.trim().is_empty()).then_some(config.model_name));
    let updated_at_ms = if meta.composer.last_updated_at > 0 {
        meta.composer.last_updated_at
    } else {
        meta.composer.created_at
    };
    let parent_session_id = meta
        .composer
        .subagent_info
        .as_ref()
        .map(|info| info.parent_composer_id.trim())
        .filter(|parent_id| !parent_id.is_empty() && *parent_id != meta.source_session_id)
        .map(|parent_id| format!("{WINDSURF_SESSION_PREFIX}{parent_id}"));
    let name = if meta.composer.name.trim().is_empty() && parent_session_id.is_some() {
        "Subagent".to_string()
    } else {
        imported_history::truncate_name(&meta.composer.name, 200)
    };
    ImportedHistoryCacheInput {
        source: SOURCE_WINDSURF,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{WINDSURF_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: WINDSURF_METADATA_PARSER_VERSION,
        name,
        created_at_ms: meta.composer.created_at,
        updated_at_ms,
        model,
        input_tokens: meta.composer.context_tokens_used.round() as i64,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: metadata.repo_path,
        branch: metadata.branch,
        impact: meta.impact,
        listable: meta.listable,
        source_metadata_json: None,
        parent_session_id,
    }
}

fn workspace_metadata_from_composer(composer: &RawComposerData) -> WorkspaceMetadata {
    let tracked_repo = composer.tracked_git_repos.first();
    let repo_path = tracked_repo
        .map(|repo| repo.repo_path.trim())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| {
            composer
                .workspace_identifier
                .as_ref()
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

    WorkspaceMetadata { repo_path, branch }
}
