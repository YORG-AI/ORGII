//! Windsurf composer metadata listing and imported-history cache synchronization.

use super::*;

pub(super) fn sync_windsurf_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
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
    let metas =
        list_windsurf_composer_meta_from_conn(&conn, &db_path, source_mtime_ms, source_size_bytes)?;
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

pub(super) fn list_windsurf_composer_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
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
        let bubbles = load_bubbles_by_id(
            conn,
            &composer.composer_id,
            &composer.full_conversation_headers_only,
        )?;
        let chunks = bubbles_to_chunks(
            conn,
            &format!("{WINDSURF_SESSION_PREFIX}{}", composer.composer_id),
            &bubbles,
        );
        let listable = is_listable_composer(&composer, &chunks);
        let impact = imported_history::impact_from_edit_chunks(&chunks);
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

fn is_listable_composer(composer: &RawComposerData, chunks: &[ActivityChunk]) -> bool {
    if composer.composer_id.trim().is_empty() || composer.name.trim().is_empty() {
        return false;
    }
    if composer.subagent_info.is_some() || composer.full_conversation_headers_only.is_empty() {
        return false;
    }
    !chunks.is_empty()
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
        client_origin: None,
        client_origin_raw: None,
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
