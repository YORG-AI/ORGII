//! Bounded demand sync between discovered Kimi records and the shared cache.

use std::path::Path;

use rusqlite::{params, Connection};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, SOURCE_KIMI},
    ImportedHistoryRecentPath, ImportedHistorySessionPage,
};

use super::discovery::discover_kimi_records_in;
use super::identity::{
    layout_from_source_id, KimiLayout, DEFAULT_MODEL, MAX_CHANGED_SESSIONS_PER_SYNC,
    MAX_PARSE_SOURCE_BYTES_PER_SYNC,
};
use super::parse::parse_kimi_meta;

pub fn list_kimi_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    sync_kimi_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_KIMI, limit, offset)
}

pub fn list_kimi_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ImportedHistoryRecentPath>, String> {
    sync_kimi_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_KIMI, limit)
}

fn sync_kimi_history_cache(conn: &mut Connection) -> Result<(), String> {
    let home = app_paths::external_history_home_dir();
    sync_kimi_history_cache_in(conn, &home, std::env::var_os("KIMI_CODE_HOME").as_deref())
}

pub(super) fn sync_kimi_history_cache_in(
    conn: &mut Connection,
    home: &Path,
    kimi_code_home: Option<&std::ffi::OsStr>,
) -> Result<(), String> {
    let discovery = discover_kimi_records_in(conn, home, kimi_code_home)?;
    let signatures = discovery
        .records
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let mut changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_KIMI,
        &discovery.records,
        ImportedHistoryDiscoveredRecord::signature,
    )?;
    changed.sort_by(|left, right| {
        right
            .source_mtime_ms
            .cmp(&left.source_mtime_ms)
            .then_with(|| left.source_session_id.cmp(&right.source_session_id))
    });

    let mut processed = 0usize;
    let mut admitted_source_bytes = 0_i64;
    for record in changed {
        if processed >= MAX_CHANGED_SESSIONS_PER_SYNC {
            break;
        }
        let next_source_bytes =
            admitted_source_bytes.saturating_add(record.source_size_bytes.max(0));
        if processed > 0 && next_source_bytes > MAX_PARSE_SOURCE_BYTES_PER_SYNC {
            break;
        }
        let layout = layout_from_source_id(&record.source_session_id)?;
        let default_model = match layout {
            KimiLayout::Legacy => discovery.legacy_config.model.as_str(),
            KimiLayout::Code => DEFAULT_MODEL,
        };
        let stored = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_KIMI,
            &record.source_session_id,
        )?;
        let Some(parsed) = imported_history::skip_unparsable_record(
            SOURCE_KIMI,
            &record.source_session_id,
            parse_kimi_meta(record, layout, default_model, stored.as_ref()),
        ) else {
            continue;
        };
        let session_id = parsed.input.session_id.clone();
        // The session cache signature is the authoritative changed-record
        // marker, so commit it last. If a prior write fails, or the final
        // upsert fails, the old signature keeps this record eligible and the
        // next demand scan deterministically replaces the same rounds and
        // watermark state.
        imported_cache::write_session_rounds_from_conn(
            conn,
            std::slice::from_ref(&session_id),
            &parsed.rounds,
        )?;
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_KIMI,
            &record.source_session_id,
            &parsed.watermark,
        )?;
        upsert_kimi_cache_retry_safe(conn, &parsed.input)?;
        processed = processed.saturating_add(1);
        admitted_source_bytes = next_source_bytes;
    }

    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_KIMI,
        imported_cache::live_ids_from_signatures(&signatures),
        Vec::new(),
    )
}

fn upsert_kimi_cache_retry_safe(
    conn: &mut Connection,
    input: &ImportedHistoryCacheInput,
) -> Result<(), String> {
    let result =
        imported_cache::upsert_imported_session_cache_from_conn(conn, std::slice::from_ref(input));
    let Err(error) = result else {
        return Ok(());
    };

    // The shared cache helper commits its signature row before projecting the
    // core session. If that later projection fails, invalidate only the newly
    // committed signature so the next demand sync retries instead of treating
    // a partial projection as complete. The cache row remains visible but is
    // deliberately ineligible for signature reuse until recovery succeeds.
    conn.execute(
        "UPDATE imported_history_session_cache
         SET parser_version = -1
         WHERE source = ?1
           AND source_session_id = ?2
           AND source_path = ?3
           AND source_mtime_ms = ?4
           AND source_size_bytes = ?5
           AND source_fingerprint = ?6
           AND parser_version = ?7",
        params![
            input.source,
            input.source_session_id,
            input.source_path,
            input.source_mtime_ms,
            input.source_size_bytes,
            input.source_fingerprint,
            input.parser_version,
        ],
    )
    .map_err(|recovery_error| {
        format!("{error}; failed to keep the Kimi record retry-eligible: {recovery_error}")
    })?;
    Err(error)
}
