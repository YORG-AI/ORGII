//! Public listing entry points plus the bounded discovery → enrichment →
//! parse → imported-history-cache sync pipeline.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror,
    metadata::{ImportedHistoryCacheInput, SOURCE_COPILOT},
};

use super::discovery::discover_copilot_history_records;
use super::enrichment::{
    read_cached_copilot_enrichment, read_cached_copilot_fingerprints, read_copilot_store_enrichment,
    strip_managed_fingerprint,
};
use super::metadata::parse_copilot_session_meta;
use super::paths::{copilot_session_state_dirs, copilot_session_store_db_path};
use super::types::{CopilotDiscoveredRecord, CopilotHistoryMeta};
use super::{
    CopilotHistorySessionPage, CopilotRecentPath, COPILOT_AGENT_TYPE,
    COPILOT_METADATA_PARSER_VERSION, MAX_CHANGED_SESSIONS_PER_SYNC, MAX_DB_CANDIDATES,
    MAX_PARSE_SOURCE_BYTES_PER_SYNC, MAX_RECENT_DB_CANDIDATES,
};

pub fn list_copilot_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CopilotHistorySessionPage, String> {
    sync_copilot_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_COPILOT, limit, offset)
}

pub fn list_copilot_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<CopilotRecentPath>, String> {
    sync_copilot_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_COPILOT, limit)
}

// ---------------------------------------------------------------------------
// Discovery + cache sync
// ---------------------------------------------------------------------------

fn sync_copilot_history_cache(conn: &mut Connection) -> Result<(), String> {
    let roots = copilot_session_state_dirs()?;
    sync_copilot_history_cache_in_roots(conn, &roots, copilot_session_store_db_path().as_deref())
}

/// Root/db-injectable sync core, so tests can point discovery at a fixture
/// directory and a synthetic `session-store.db`.
pub(super) fn sync_copilot_history_cache_in_roots(
    conn: &mut Connection,
    roots: &[PathBuf],
    store_db_path: Option<&Path>,
) -> Result<(), String> {
    let mut discovered = discover_copilot_history_records(conn, roots)?;
    // Managed (GUI-launched) sessions surface through their code_sessions
    // row; the imported twin goes unlistable. Folding the verdict into the
    // fingerprint re-parses a session whose managed status flips.
    let managed_ids = managed_mirror::managed_source_session_ids_from_conn(
        conn,
        COPILOT_AGENT_TYPE,
        SOURCE_COPILOT,
    )?;
    let cached_fingerprints = read_cached_copilot_fingerprints(conn)?;
    for record in &mut discovered {
        record.record.source_fingerprint = cached_fingerprints
            .get(&record.record.source_session_id)
            .map(|fingerprint| strip_managed_fingerprint(fingerprint).to_string())
            .unwrap_or_else(|| "copilot-events-v2|db=deferred".to_string());
        managed_mirror::append_managed_fingerprint(
            &mut record.record.source_fingerprint,
            managed_ids.contains(&record.record.source_session_id),
        );
    }

    // Candidate selection is cache-driven and bounded. Every event-changed
    // record is eventually admitted in 256-session batches; the newest 64
    // cached sessions are also refreshed so a usage row written just after
    // events.jsonl stopped changing is observed without scanning the whole
    // Copilot database on every sidebar open.
    let mut preliminary_changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_COPILOT,
        &discovered,
        CopilotDiscoveredRecord::signature,
    )?;
    preliminary_changed.sort_by(|left, right| {
        right
            .record
            .source_mtime_ms
            .cmp(&left.record.source_mtime_ms)
            .then_with(|| {
                left.record
                    .source_session_id
                    .cmp(&right.record.source_session_id)
            })
    });
    let mut candidate_ids = preliminary_changed
        .into_iter()
        .take(MAX_CHANGED_SESSIONS_PER_SYNC)
        .map(|record| record.record.source_session_id.clone())
        .collect::<HashSet<_>>();
    let mut newest = discovered.iter().collect::<Vec<_>>();
    newest.sort_by(|left, right| {
        right
            .record
            .source_mtime_ms
            .cmp(&left.record.source_mtime_ms)
            .then_with(|| {
                left.record
                    .source_session_id
                    .cmp(&right.record.source_session_id)
            })
    });
    for record in newest.into_iter().take(MAX_RECENT_DB_CANDIDATES) {
        candidate_ids.insert(record.record.source_session_id.clone());
    }
    if candidate_ids.len() > MAX_DB_CANDIDATES {
        return Err("Copilot enrichment candidate budget exceeded".to_string());
    }
    let candidate_ids = candidate_ids.into_iter().collect::<Vec<_>>();
    let mut cached_enrichment = read_cached_copilot_enrichment(conn, &candidate_ids)?;
    let mut live_enrichment = read_copilot_store_enrichment(store_db_path, &candidate_ids);
    let candidate_set = candidate_ids.iter().collect::<HashSet<_>>();
    for record in &mut discovered {
        if !candidate_set.contains(&record.record.source_session_id) {
            continue;
        }
        let enrichment = match live_enrichment.as_mut() {
            Some(live) => live
                .remove(&record.record.source_session_id)
                .unwrap_or_default(),
            None => cached_enrichment
                .remove(&record.record.source_session_id)
                .unwrap_or_default(),
        };
        record.record.source_fingerprint =
            format!("copilot-events-v2|{}", enrichment.fingerprint());
        managed_mirror::append_managed_fingerprint(
            &mut record.record.source_fingerprint,
            managed_ids.contains(&record.record.source_session_id),
        );
        record.enrichment = enrichment;
    }

    let signatures = discovered
        .iter()
        .map(CopilotDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let mut changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_COPILOT, &discovered, |record| {
            record.signature()
        })?;
    changed.sort_by(|left, right| {
        right
            .record
            .source_mtime_ms
            .cmp(&left.record.source_mtime_ms)
            .then_with(|| {
                left.record
                    .source_session_id
                    .cmp(&right.record.source_session_id)
            })
    });
    let mut inputs = Vec::new();
    let mut rounds = Vec::new();
    let mut reparsed_ids = Vec::new();
    let mut watermarks = Vec::new();
    let mut attempted = 0usize;
    let mut admitted_source_bytes = 0_i64;
    for record in changed {
        if attempted >= MAX_CHANGED_SESSIONS_PER_SYNC {
            break;
        }
        let next_source_bytes =
            admitted_source_bytes.saturating_add(record.record.source_size_bytes.max(0));
        if attempted > 0 && next_source_bytes > MAX_PARSE_SOURCE_BYTES_PER_SYNC {
            break;
        }
        attempted = attempted.saturating_add(1);
        admitted_source_bytes = next_source_bytes;
        let stored = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_COPILOT,
            &record.record.source_session_id,
        )?;
        let Some(parsed) = imported_history::skip_unparsable_record(
            SOURCE_COPILOT,
            &record.record.source_session_id,
            parse_copilot_session_meta(record, stored.as_ref()),
        ) else {
            continue;
        };
        let mut meta = parsed.meta;
        let is_managed_history_mirror = managed_ids.contains(&meta.source_session_id);
        reparsed_ids.push(meta.session_id.clone());
        rounds.append(&mut meta.rounds);
        let mut input = session_meta_to_cache_input(meta);
        input.listable = input.listable && !is_managed_history_mirror;
        inputs.push(input);
        watermarks.push((record.record.source_session_id.clone(), parsed.watermark));
    }
    imported_cache::write_session_rounds_from_conn(conn, &reparsed_ids, &rounds)?;
    for (source_session_id, watermark) in watermarks {
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_COPILOT,
            &source_session_id,
            &watermark,
        )?;
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_COPILOT,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn session_meta_to_cache_input(meta: CopilotHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_COPILOT,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: COPILOT_METADATA_PARSER_VERSION,
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
