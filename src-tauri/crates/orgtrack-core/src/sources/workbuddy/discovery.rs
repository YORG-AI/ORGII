//! Discovery, scanning, and metadata parsing: walking the WorkBuddy/CodeBuddy
//! transcript roots into discovered records and folding each JSONL session into
//! a cache-input row.

use super::*;

pub(super) fn sync_workbuddy_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_workbuddy_history_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_WORKBUDDY, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_workbuddy_session_meta(record)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_WORKBUDDY,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

pub(super) fn refresh_workbuddy_catalog(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_workbuddy_history_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_WORKBUDDY, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if imported_cache::advance_cached_catalog_record_from_conn(
            conn,
            SOURCE_WORKBUDDY,
            record,
            None,
        )? {
            continue;
        }
        if let Some(meta) = parse_workbuddy_session_meta(record)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_WORKBUDDY,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

pub(super) fn discover_workbuddy_history_records(
) -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut files = Vec::new();
    for root in workbuddy_history_roots()? {
        if root.is_dir() {
            collect_workbuddy_session_files(&root, &mut files)?;
        } else if root.is_file() {
            push_workbuddy_session_file(&root, &mut files);
        }
    }
    files
        .into_iter()
        .map(|file| {
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&file.path, "WorkBuddy")?;
            let source_session_id = workbuddy_source_session_id(&file.file_stem, &file.path);
            Ok(ImportedHistoryDiscoveredRecord {
                source_session_id,
                source_path: file.path,
                source_record_key: file.file_stem,
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint: String::new(),
                parser_version: WORKBUDDY_METADATA_PARSER_VERSION,
            })
        })
        .collect()
}

pub(super) fn collect_workbuddy_session_files(
    dir: &Path,
    out: &mut Vec<WorkBuddySessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read WorkBuddy dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read WorkBuddy dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_workbuddy_session_files(&path, out)?;
        } else {
            push_workbuddy_session_file(&path, out);
        }
    }
    Ok(())
}

pub(super) fn push_workbuddy_session_file(path: &Path, out: &mut Vec<WorkBuddySessionFile>) {
    if path
        .extension()
        .is_none_or(|extension| extension != "jsonl")
    {
        return;
    }
    let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return;
    };
    if file_stem == "recording" {
        return;
    }
    out.push(WorkBuddySessionFile {
        file_stem: file_stem.to_string(),
        path: path.to_path_buf(),
    });
}

pub(super) fn parse_workbuddy_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<WorkBuddyHistoryMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open WorkBuddy history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file.take(CATALOG_PREFIX_BYTES));

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read WorkBuddy history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: WorkBuddyJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if let Some(timestamp) = timestamp_value_to_epoch_ms(parsed.timestamp.as_ref())
            .or_else(|| timestamp_value_to_epoch_ms(parsed.created_at.as_ref()))
        {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            if timestamp > updated_at_ms {
                updated_at_ms = timestamp;
            }
        }
        if repo_path.is_none() {
            repo_path = non_empty_string(&parsed.cwd).or_else(|| non_empty_string(&parsed.project));
        }
        if branch.is_none() && !parsed.git_branch.trim().is_empty() {
            branch = Some(parsed.git_branch.clone());
        }
        if !parsed.ai_title.trim().is_empty() {
            first_prompt = imported_history::truncate_name(&parsed.ai_title, 200);
        }
        if first_prompt.is_empty() && !parsed.display.trim().is_empty() {
            first_prompt = imported_history::truncate_name(&parsed.display, 200);
        }
        if let Some(message) = effective_message(&parsed) {
            if first_prompt.is_empty() && message.role == "user" {
                if let Some(text) = content_text(&message.content) {
                    first_prompt = imported_history::truncate_name(&text, 200);
                }
            }
            if model.is_none() && !message.model.trim().is_empty() {
                model = Some(message.model.clone());
            }
            if let Some(usage) = message.usage {
                input_tokens += usage.input_tokens
                    + usage.prompt_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                output_tokens += usage.output_tokens + usage.completion_tokens;
            }
            if message.role == "assistant" {
                for item in content_items(&message.content) {
                    collect_impact_from_item(item, &mut impact, &mut touched_files);
                }
            }
        }
        if let Some(call) = effective_function_call(&parsed) {
            collect_impact_from_function_call(&call, &mut impact, &mut touched_files);
        }
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    Ok(Some(WorkBuddyHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: format!("{WORKBUDDY_SESSION_PREFIX}{}", record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name: if first_prompt.is_empty() {
            record.source_record_key.clone()
        } else {
            first_prompt
        },
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            record.source_mtime_ms
        },
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            record.source_mtime_ms
        },
        model,
        repo_path,
        branch,
        input_tokens,
        output_tokens,
        impact,
        parent_session_id: workbuddy_parent_source_session_id(&record.source_path)
            .map(|parent_id| format!("{WORKBUDDY_SESSION_PREFIX}{parent_id}")),
    }))
}

pub(super) fn session_meta_to_cache_input(meta: WorkBuddyHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_WORKBUDDY,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: WORKBUDDY_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: meta.parent_session_id,
    }
}
