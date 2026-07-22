//! OpenCode session metadata listing and imported-history cache synchronization.

use super::*;

pub(super) fn sync_opencode_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    sync_opencode_history_cache_inner(cache_conn, true)
}

pub(super) fn sync_opencode_history_cache_inner(
    cache_conn: &mut Connection,
    include_legacy_impact: bool,
) -> Result<(), String> {
    let Some((conn, db_path)) = open_opencode_db()? else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_OPENCODE,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&db_path, "OpenCode")?;
    let mut metas = list_all_opencode_session_meta_from_conn(
        &conn,
        &db_path,
        source_mtime_ms,
        source_size_bytes,
    )?;
    let managed_source_session_ids = managed_opencode_source_session_ids_from_conn(cache_conn)?;
    for meta in &mut metas {
        meta.source_fingerprint.push_str(
            if managed_source_session_ids.contains(&meta.source_session_id) {
                "|managed=1"
            } else {
                "|managed=0"
            },
        );
    }
    let container_parent_ids = container_parent_ids_from_metas(&metas);
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let changed_ids = imported_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_OPENCODE,
        &metas,
        opencode_meta_signature,
    )?
    .into_iter()
    .map(|meta| meta.source_session_id.clone())
    .collect::<HashSet<_>>();
    let mut inputs = Vec::with_capacity(changed_ids.len());
    for mut meta in metas
        .into_iter()
        .filter(|meta| changed_ids.contains(&meta.source_session_id))
    {
        populate_opencode_impact(&conn, cache_conn, &mut meta, include_legacy_impact)?;
        inputs.push(session_meta_to_cache_input(
            meta,
            &container_parent_ids,
            &managed_source_session_ids,
        ));
    }
    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_OPENCODE, live_ids, inputs)
}

pub(super) fn populate_opencode_impact(
    source_conn: &Connection,
    cache_conn: &Connection,
    meta: &mut OpenCodeSessionMeta,
    include_legacy_impact: bool,
) -> Result<(), String> {
    if include_legacy_impact {
        let session_id = format!("{OPENCODE_SESSION_PREFIX}{}", meta.source_session_id);
        meta.impact = load_opencode_compatible_impact_from_conn(
            source_conn,
            &session_id,
            &meta.source_session_id,
            OPENCODE_PROVIDER_SLUG,
        )?;
    } else if let Some(cached) = imported_cache::query_cached_session_from_conn(
        cache_conn,
        SOURCE_OPENCODE,
        &meta.source_session_id,
    )? {
        // Catalog refresh preserves the compact projection already published
        // for this session. It never replays historical tool rows merely
        // because the shared DB/WAL changed.
        meta.impact = cached.impact;
    }
    Ok(())
}

fn opencode_meta_signature(meta: &OpenCodeSessionMeta) -> ImportedHistoryRecordSignature {
    ImportedHistoryRecordSignature {
        source_session_id: meta.source_session_id.clone(),
        source_path: meta.source_path.clone(),
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint.clone(),
        parser_version: OPENCODE_METADATA_PARSER_VERSION,
    }
}

pub(super) fn managed_opencode_source_session_ids_from_conn(
    conn: &Connection,
) -> Result<HashSet<String>, String> {
    // Shared helper unions the live `code_sessions.cli_session_id` binding
    // with the append-only native-transcript ledger (superseded forks).
    crate::sources::imported_history::managed_mirror::managed_source_session_ids_from_conn(
        conn,
        "opencode",
        crate::sources::imported_history::metadata::SOURCE_OPENCODE,
    )
}

pub(super) fn container_parent_ids_from_metas(metas: &[OpenCodeSessionMeta]) -> HashSet<String> {
    let source_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.as_str())
        .collect::<HashSet<_>>();
    let parent_by_child = metas
        .iter()
        .filter_map(|meta| {
            meta.parent_id
                .as_deref()
                .map(|parent_id| (meta.source_session_id.as_str(), parent_id))
        })
        .collect::<std::collections::HashMap<_, _>>();

    metas
        .iter()
        .filter_map(|meta| {
            let parent_id = meta.parent_id.as_deref()?;
            if parent_id == meta.source_session_id || !source_ids.contains(parent_id) {
                return None;
            }
            if parent_by_child.get(parent_id).copied() == Some(meta.source_session_id.as_str()) {
                return None;
            }
            Some(parent_id.to_string())
        })
        .collect()
}

pub(super) fn list_all_opencode_session_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<OpenCodeSessionMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, directory, model, tokens_input, tokens_output, \
                    tokens_reasoning, tokens_cache_read, tokens_cache_write, \
                    time_created, time_updated, parent_id \
             FROM session \
             WHERE time_archived IS NULL",
        )
        .map_err(|err| format!("Failed to prepare OpenCode session query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let cache_read_tokens = row.get::<_, Option<i64>>(7)?.unwrap_or_default();
            let cache_write_tokens = row.get::<_, Option<i64>>(8)?.unwrap_or_default();
            // input_tokens is cache-inclusive (fresh input + both cache kinds).
            let input_tokens = row.get::<_, Option<i64>>(4)?.unwrap_or_default()
                + cache_read_tokens
                + cache_write_tokens;
            let output_tokens = row.get::<_, Option<i64>>(5)?.unwrap_or_default()
                + row.get::<_, Option<i64>>(6)?.unwrap_or_default();
            Ok(OpenCodeSessionMeta {
                source_session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                source_path: String::new(),
                source_record_key: String::new(),
                source_mtime_ms: 0,
                source_size_bytes: 0,
                source_fingerprint: String::new(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                directory: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model: row.get(3)?,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                time_created: row.get::<_, Option<i64>>(9)?.unwrap_or_default(),
                time_updated: row.get::<_, Option<i64>>(10)?.unwrap_or_default(),
                parent_id: row
                    .get::<_, Option<String>>(11)?
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                impact: ImportedHistoryImpactStats::default(),
            })
        })
        .map_err(|err| format!("Failed to query OpenCode sessions: {err}"))?;

    // A single `opencode.db` backs every session, so fold its WAL/`-shm`
    // sidecars into each session's fingerprint once.
    let sidecar_signature = imported_paths::sqlite_sidecar_signature(db_path);
    let mut sessions = Vec::new();
    for row in rows {
        let mut meta = row.map_err(|err| format!("Failed to read OpenCode session row: {err}"))?;
        if meta.source_session_id.trim().is_empty() {
            continue;
        }
        meta.source_path = db_path.to_string_lossy().to_string();
        meta.source_record_key = meta.source_session_id.clone();
        meta.source_mtime_ms = source_mtime_ms;
        meta.source_size_bytes = source_size_bytes;
        meta.source_fingerprint = opencode_source_fingerprint(&meta, &sidecar_signature);
        sessions.push(meta);
    }
    Ok(sessions)
}

/// Content-aware change fingerprint for an OpenCode session.
///
/// The `opencode.db` mtime alone can stay flat across a same-mtime rewrite, so
/// this folds the session's own identity/title/timestamp/token/parent fields
/// together with the shared WAL/`-shm` sidecar signature.
fn opencode_source_fingerprint(meta: &OpenCodeSessionMeta, sidecar_signature: &str) -> String {
    [
        meta.source_session_id.as_str(),
        meta.title.as_str(),
        meta.model.as_deref().unwrap_or_default(),
        &meta.time_created.to_string(),
        &meta.time_updated.to_string(),
        &meta.input_tokens.to_string(),
        &meta.output_tokens.to_string(),
        meta.parent_id.as_deref().unwrap_or_default(),
        sidecar_signature,
    ]
    .join("|")
}

pub(super) fn session_meta_to_cache_input(
    meta: OpenCodeSessionMeta,
    container_parent_ids: &HashSet<String>,
    managed_source_session_ids: &HashSet<String>,
) -> ImportedHistoryCacheInput {
    let model = meta.model.as_deref().and_then(parse_model_name);
    let updated_at_ms = if meta.time_updated > 0 {
        meta.time_updated
    } else {
        meta.time_created
    };
    let is_container_parent = container_parent_ids.contains(&meta.source_session_id);
    let is_managed_history_mirror = managed_source_session_ids.contains(&meta.source_session_id);
    let listable = !is_container_parent && !is_managed_history_mirror;
    let parent_session_id = meta
        .parent_id
        .as_deref()
        .filter(|parent_id| container_parent_ids.contains(*parent_id))
        .map(|parent_id| format!("{OPENCODE_SESSION_PREFIX}{parent_id}"));
    ImportedHistoryCacheInput {
        source: SOURCE_OPENCODE,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{OPENCODE_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: OPENCODE_METADATA_PARSER_VERSION,
        // OpenCode may default the title to the first message text, which for
        // GUI-launched runs starts with the exec-mode briefing — strip it.
        name: imported_history::truncate_name(
            imported_history::strip_orgii_exec_mode_bridge(&meta.title),
            200,
        ),
        created_at_ms: meta.time_created,
        updated_at_ms,
        model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: (!meta.directory.trim().is_empty()).then_some(meta.directory),
        branch: None,
        impact: meta.impact,
        listable,
        source_metadata_json: None,
        parent_session_id,
    }
}

fn parse_model_name(raw_model: &str) -> Option<String> {
    let trimmed = raw_model.trim();
    if trimmed.is_empty() {
        return None;
    }
    let Ok(parsed) = serde_json::from_str::<OpenCodeModelValue>(trimmed) else {
        return Some(trimmed.to_string());
    };
    if !parsed.id.trim().is_empty() {
        Some(parsed.id)
    } else if !parsed.model_id.trim().is_empty() {
        Some(parsed.model_id)
    } else if !parsed.provider_id.trim().is_empty() {
        Some(parsed.provider_id)
    } else {
        None
    }
}
