//! Discovery and metadata parsing for Cline sessions: scanning the session
//! index DB and the per-session store, then folding each transcript into a
//! cache-input row.

use super::*;

pub(super) fn sync_cline_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_cline_history_records()?;
    let signatures = discovered
        .iter()
        .map(ClineDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_CLINE, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_cline_session_meta(record)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CLINE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

pub(super) fn discover_cline_history_records() -> Result<Vec<ClineDiscoveredRecord>, String> {
    let mut records = Vec::new();
    let mut discovered_ids = HashSet::new();
    for db_path in cline_db_paths()? {
        if !db_path.is_file() {
            continue;
        }
        if let Ok(db_records) = discover_cline_db_records(&db_path) {
            for record in db_records {
                discovered_ids.insert(record.record.source_session_id.clone());
                records.push(record);
            }
        }
    }
    for sessions_dir in cline_sessions_dirs()? {
        if !sessions_dir.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&sessions_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(id) = dir.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let messages_path = dir.join(format!("{id}{MESSAGES_SUFFIX}"));
            if !messages_path.is_file() || discovered_ids.contains(id) {
                continue;
            }
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&messages_path, "Cline")?;
            records.push(ClineDiscoveredRecord {
                record: ImportedHistoryDiscoveredRecord {
                    source_session_id: id.to_string(),
                    source_path: messages_path,
                    source_record_key: id.to_string(),
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint: String::new(),
                    parser_version: CLINE_METADATA_PARSER_VERSION,
                },
                db_meta: None,
            });
        }
    }
    Ok(records)
}

pub(super) fn discover_cline_db_records(
    db_path: &Path,
) -> Result<Vec<ClineDiscoveredRecord>, String> {
    let conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|err| {
            format!(
                "Failed to open Cline session index {}: {err}",
                db_path.display()
            )
        })?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id, started_at, updated_at, provider, model, cwd, workspace_root, \
                    parent_session_id, is_subagent, prompt, metadata_json, messages_path \
             FROM sessions WHERE messages_path IS NOT NULL AND messages_path != ''",
        )
        .map_err(|err| format!("Failed to prepare Cline session-index query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ClineDbSessionMeta {
                session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                started_at: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                updated_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                provider: row.get(3)?,
                model: row.get(4)?,
                cwd: row.get(5)?,
                workspace_root: row.get(6)?,
                parent_session_id: row
                    .get::<_, Option<String>>(7)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                is_subagent: row.get::<_, Option<i64>>(8)?.unwrap_or_default() != 0,
                prompt: row.get(9)?,
                metadata_json: row.get(10)?,
                messages_path: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to query Cline session index: {err}"))?;

    let mut records = Vec::new();
    for row in rows {
        let meta = row.map_err(|err| format!("Failed to read Cline session-index row: {err}"))?;
        if meta.session_id.trim().is_empty() || meta.messages_path.trim().is_empty() {
            continue;
        }
        let messages_path = PathBuf::from(&meta.messages_path);
        if !messages_path.is_file() {
            continue;
        }
        let (source_mtime_ms, source_size_bytes) =
            imported_paths::file_metadata_signature(&messages_path, "Cline")?;
        let source_fingerprint = cline_db_source_fingerprint(&meta);
        records.push(ClineDiscoveredRecord {
            record: ImportedHistoryDiscoveredRecord {
                source_session_id: meta.session_id.clone(),
                source_path: messages_path,
                source_record_key: meta.session_id.clone(),
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint,
                parser_version: CLINE_METADATA_PARSER_VERSION,
            },
            db_meta: Some(meta),
        });
    }
    Ok(records)
}

pub(super) fn cline_db_source_fingerprint(meta: &ClineDbSessionMeta) -> String {
    [
        meta.session_id.as_str(),
        meta.started_at.as_str(),
        meta.updated_at.as_str(),
        meta.provider.as_deref().unwrap_or_default(),
        meta.model.as_deref().unwrap_or_default(),
        meta.cwd.as_deref().unwrap_or_default(),
        meta.workspace_root.as_deref().unwrap_or_default(),
        meta.parent_session_id.as_deref().unwrap_or_default(),
        if meta.is_subagent { "1" } else { "0" },
        meta.prompt.as_deref().unwrap_or_default(),
        meta.metadata_json.as_deref().unwrap_or_default(),
        meta.messages_path.as_str(),
    ]
    .join("|")
}

pub(super) fn parse_cline_session_meta(
    discovered: &ClineDiscoveredRecord,
) -> Result<Option<ClineHistoryMeta>, String> {
    let record = &discovered.record;
    let db_meta = discovered.db_meta.as_ref();
    let messages_path = &record.source_path;
    let sidecar = sidecar_json_path(messages_path, &record.source_session_id);
    let session_json: ClineSessionJson = sidecar
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let transcript = read_transcript(messages_path).unwrap_or_default();
    let db_metadata = db_meta
        .and_then(|meta| meta.metadata_json.as_deref())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);

    let created_at_ms = session_json
        .started_at
        .as_deref()
        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        .or_else(|| {
            db_meta
                .map(|meta| meta.started_at.as_str())
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        })
        .or_else(|| transcript.messages.iter().find_map(|m| m.ts))
        .filter(|ms| *ms > 0)
        .unwrap_or(record.source_mtime_ms);

    let updated_at_ms = transcript
        .messages
        .iter()
        .rev()
        .find_map(|m| m.ts)
        .filter(|ms| *ms > 0)
        .or_else(|| {
            db_meta
                .map(|meta| meta.updated_at.as_str())
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        })
        .unwrap_or(record.source_mtime_ms);

    let title = session_json
        .metadata
        .as_ref()
        .and_then(|meta| meta.title.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| json_nonempty_string(&db_metadata, &["title"]));
    let name = title
        .or_else(|| {
            session_json
                .prompt
                .as_deref()
                .map(strip_user_input_wrapper)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            db_meta
                .and_then(|meta| meta.prompt.as_deref())
                .map(strip_user_input_wrapper)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| first_user_text(&transcript))
        .map(|value| imported_history::truncate_name(&value, 200))
        .unwrap_or_else(|| record.source_record_key.clone());

    let repo_path = session_json
        .workspace_root
        .as_deref()
        .or(session_json.cwd.as_deref())
        .or_else(|| db_meta.and_then(|meta| meta.workspace_root.as_deref()))
        .or_else(|| db_meta.and_then(|meta| meta.cwd.as_deref()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let model = session_json
        .model
        .as_deref()
        .or_else(|| db_meta.and_then(|meta| meta.model.as_deref()))
        .or(session_json.provider.as_deref())
        .or_else(|| db_meta.and_then(|meta| meta.provider.as_deref()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let usage = session_json
        .metadata
        .as_ref()
        .and_then(|m| m.usage.as_ref());
    let input_tokens = usage.and_then(|u| u.input_tokens).unwrap_or_else(|| {
        json_i64_at_paths(
            &db_metadata,
            &[
                &["aggregateUsage", "inputTokens"],
                &["usage", "inputTokens"],
            ],
        )
        .unwrap_or_default()
    });
    let output_tokens = usage.and_then(|u| u.output_tokens).unwrap_or_else(|| {
        json_i64_at_paths(
            &db_metadata,
            &[
                &["aggregateUsage", "outputTokens"],
                &["usage", "outputTokens"],
            ],
        )
        .unwrap_or_default()
    });
    let session_id = format!("{CLINE_SESSION_PREFIX}{}", record.source_session_id);
    let impact =
        imported_history::impact_from_edit_chunks(&transcript_to_chunks(&session_id, &transcript));
    let parent_session_id = db_meta
        .filter(|meta| meta.is_subagent)
        .and_then(|meta| meta.parent_session_id.as_deref())
        .map(str::trim)
        .filter(|parent_id| !parent_id.is_empty() && *parent_id != record.source_session_id)
        .map(|parent_id| format!("{CLINE_SESSION_PREFIX}{parent_id}"));

    Ok(Some(ClineHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: messages_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        created_at_ms,
        updated_at_ms,
        model,
        repo_path,
        input_tokens,
        output_tokens,
        impact,
        parent_session_id,
    }))
}

pub(super) fn session_meta_to_cache_input(meta: ClineHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CLINE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CLINE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: meta.repo_path,
        branch: None,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: meta.parent_session_id,
    }
}
