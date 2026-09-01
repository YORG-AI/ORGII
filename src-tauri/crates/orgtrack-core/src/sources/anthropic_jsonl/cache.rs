use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord},
    watermark, ImportedHistoryRecentPath, ImportedHistorySessionPage,
};

use super::config::AnthropicJsonlSource;
use super::discovery::discover_records;
use super::meta::{parse_session_meta, parse_session_meta_incremental};
use super::model::SessionMeta;
use super::transcript::load_from_path;

pub fn list_sessions_paginated(
    config: &AnthropicJsonlSource,
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    sync_cache(config, conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, config.source, limit, offset)
}

pub fn list_recent_paths(
    config: &AnthropicJsonlSource,
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ImportedHistoryRecentPath>, String> {
    sync_cache(config, conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, config.source, limit)
}

pub fn load_session(
    config: &AnthropicJsonlSource,
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let cached = if config.session_id_from_header {
        imported_cache::query_cached_session_by_session_id_from_conn(conn, session_id)?
            .filter(|(source, _)| source == config.source)
            .map(|(_, cached)| cached)
    } else {
        let source_session_id = source_id_from_session_id(config, session_id)?;
        imported_cache::query_cached_session_from_conn(conn, config.source, source_session_id)?
    }
    .ok_or_else(|| format!("{} session not found: {session_id}", config.display_name))?;
    load_from_path(config, session_id, Path::new(&cached.source_path))
}

fn sync_cache(config: &AnthropicJsonlSource, conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_records(config, conn)?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        config.source,
        &discovered,
        ImportedHistoryDiscoveredRecord::signature,
    )?;
    let mut inputs = Vec::new();
    for record in changed {
        let meta = if config.incremental_metadata {
            let stored = watermark::read_parse_watermark_from_conn(
                conn,
                config.source,
                &record.source_session_id,
            )?;
            let Some(parse) = imported_history::skip_unparsable_record(
                config.source,
                &record.source_session_id,
                parse_session_meta_incremental(config, record, stored.as_ref()),
            ) else {
                continue;
            };
            watermark::write_parse_watermark_from_conn(
                conn,
                config.source,
                &record.source_session_id,
                &parse.watermark,
            )?;
            parse.meta
        } else {
            let Some(meta) = imported_history::skip_unparsable_record(
                config.source,
                &record.source_session_id,
                parse_session_meta(config, record),
            ) else {
                continue;
            };
            meta
        };
        inputs.push(meta_to_cache_input(config, meta));
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        config.source,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn meta_to_cache_input(
    config: &AnthropicJsonlSource,
    meta: SessionMeta,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: config.source,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: config.parser_version,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
        client_origin: None,
        client_origin_raw: None,
    }
}

fn source_id_from_session_id<'a>(
    config: &AnthropicJsonlSource,
    session_id: &'a str,
) -> Result<&'a str, String> {
    session_id
        .strip_prefix(config.session_prefix)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Invalid {} session id: {session_id}", config.display_name))
}
