//! ZCode session metadata listing and imported-history cache synchronization.

use super::*;

pub(super) fn sync_zcode_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    sync_zcode_history_cache_inner(cache_conn, true)
}

pub(super) fn sync_zcode_history_cache_inner(
    cache_conn: &mut Connection,
    include_legacy_impact: bool,
) -> Result<(), String> {
    let Some((conn, db_path)) = open_zcode_db()? else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_ZCODE,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&db_path, "ZCode")?;
    let metas =
        list_all_zcode_session_meta_from_conn(&conn, &db_path, source_mtime_ms, source_size_bytes)?;
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let changed_ids = imported_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_ZCODE,
        &metas,
        zcode_meta_signature,
    )?
    .into_iter()
    .map(|meta| meta.source_session_id.clone())
    .collect::<HashSet<_>>();
    let mut inputs = Vec::with_capacity(changed_ids.len());
    for mut meta in metas
        .into_iter()
        .filter(|meta| changed_ids.contains(&meta.source_session_id))
    {
        if include_legacy_impact {
            let session_id = format!("{ZCODE_SESSION_PREFIX}{}", meta.source_session_id);
            meta.impact = load_zcode_impact_from_conn(&conn, &session_id, &meta.source_session_id)?;
        } else if let Some(cached) = imported_cache::query_cached_session_from_conn(
            cache_conn,
            SOURCE_ZCODE,
            &meta.source_session_id,
        )? {
            meta.impact = cached.impact;
        }
        inputs.push(session_meta_to_cache_input(meta));
    }
    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_ZCODE, live_ids, inputs)
}

fn zcode_meta_signature(meta: &ZCodeSessionMeta) -> ImportedHistoryRecordSignature {
    ImportedHistoryRecordSignature {
        source_session_id: meta.source_session_id.clone(),
        source_path: meta.source_path.clone(),
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint.clone(),
        parser_version: ZCODE_METADATA_PARSER_VERSION,
    }
}

pub(super) fn list_all_zcode_session_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<ZCodeSessionMeta>, String> {
    // Tokens live in `turn_usage` (not on the session row): input folds in the
    // cache read/creation tokens, output folds in reasoning — mirroring how the
    // OpenCode reader accounts a session's totals. `model_id` comes from the
    // most recent `model_usage` request for the session.
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.directory, s.parent_id, s.task_type, \
                    s.time_created, s.time_updated, \
                    (SELECT COALESCE(SUM(input_tokens + cache_read_input_tokens \
                        + cache_creation_input_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id), \
                    (SELECT COALESCE(SUM(output_tokens + reasoning_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id), \
                    (SELECT model_id FROM model_usage \
                     WHERE session_id = s.id AND model_id IS NOT NULL AND model_id != '' \
                     ORDER BY started_at DESC LIMIT 1), \
                    (SELECT COALESCE(SUM(cache_read_input_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id), \
                    (SELECT COALESCE(SUM(cache_creation_input_tokens), 0) \
                     FROM turn_usage WHERE session_id = s.id) \
             FROM session s \
             WHERE s.time_archived IS NULL",
        )
        .map_err(|err| format!("Failed to prepare ZCode session query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let task_type = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            Ok(ZCodeSessionMeta {
                source_session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                source_path: String::new(),
                source_record_key: String::new(),
                source_mtime_ms: 0,
                source_size_bytes: 0,
                source_fingerprint: String::new(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                directory: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model: row
                    .get::<_, Option<String>>(9)?
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                input_tokens: row.get::<_, Option<i64>>(7)?.unwrap_or_default(),
                output_tokens: row.get::<_, Option<i64>>(8)?.unwrap_or_default(),
                cache_read_tokens: row.get::<_, Option<i64>>(10)?.unwrap_or_default(),
                cache_write_tokens: row.get::<_, Option<i64>>(11)?.unwrap_or_default(),
                time_created: row.get::<_, Option<i64>>(5)?.unwrap_or_default(),
                time_updated: row.get::<_, Option<i64>>(6)?.unwrap_or_default(),
                parent_id: row
                    .get::<_, Option<String>>(3)?
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                is_subagent: task_type == ZCODE_SUBAGENT_TASK_TYPE,
                impact: ImportedHistoryImpactStats::default(),
            })
        })
        .map_err(|err| format!("Failed to query ZCode sessions: {err}"))?;

    // A single `db.sqlite` backs every session, so fold its WAL/`-shm` sidecars
    // into each session's fingerprint once.
    let sidecar_signature = imported_paths::sqlite_sidecar_signature(db_path);
    let mut sessions = Vec::new();
    for row in rows {
        let mut meta = row.map_err(|err| format!("Failed to read ZCode session row: {err}"))?;
        if meta.source_session_id.trim().is_empty() {
            continue;
        }
        meta.source_path = db_path.to_string_lossy().to_string();
        meta.source_record_key = meta.source_session_id.clone();
        meta.source_mtime_ms = source_mtime_ms;
        meta.source_size_bytes = source_size_bytes;
        meta.source_fingerprint = zcode_source_fingerprint(&meta, &sidecar_signature);
        sessions.push(meta);
    }
    Ok(sessions)
}

/// Content-aware change fingerprint for a ZCode session. The `db.sqlite` mtime
/// alone can stay flat across a same-mtime rewrite, so this folds the session's
/// own identity/title/timestamp/token/parent fields together with the shared
/// WAL/`-shm` sidecar signature.
fn zcode_source_fingerprint(meta: &ZCodeSessionMeta, sidecar_signature: &str) -> String {
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

pub(super) fn session_meta_to_cache_input(meta: ZCodeSessionMeta) -> ImportedHistoryCacheInput {
    let updated_at_ms = if meta.time_updated > 0 {
        meta.time_updated
    } else {
        meta.time_created
    };
    // Sub-agents are hidden from the top-level list and linked to their parent,
    // matching the sidebar's collapse behaviour.
    let listable = !meta.is_subagent;
    let parent_session_id = if meta.is_subagent {
        meta.parent_id
            .as_deref()
            .map(|parent_id| format!("{ZCODE_SESSION_PREFIX}{parent_id}"))
    } else {
        None
    };
    ImportedHistoryCacheInput {
        source: SOURCE_ZCODE,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{ZCODE_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: ZCODE_METADATA_PARSER_VERSION,
        name: imported_history::truncate_name(&meta.title, 200),
        created_at_ms: meta.time_created,
        updated_at_ms,
        model: meta.model,
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
