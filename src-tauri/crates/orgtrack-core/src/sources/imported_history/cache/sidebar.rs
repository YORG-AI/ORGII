use rusqlite::{params_from_iter, types::Type, types::Value as SqlValue, Connection};

use super::continuation::continuation_lineage_id_from_metadata_json;
use super::session_row::{non_empty_string, query_cached_sessions_from_conn};
use super::super::client_origin::ImportedClientOrigin;
use super::super::{
    effective_limit, recent_paths_from_rows, ImportedHistoryRecentPath,
    ImportedHistorySessionPage, ImportedHistorySidebarPage, ImportedHistorySidebarRow,
};

pub fn query_imported_session_page_from_conn(
    conn: &Connection,
    source: &str,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    let limit = effective_limit(limit);
    let rows = query_cached_sessions_from_conn(conn, source, limit.saturating_add(1), offset)?;
    let has_more = rows.len() > limit;
    let sessions = rows
        .into_iter()
        .take(limit)
        .map(|session| session.to_row())
        .collect();
    Ok(ImportedHistorySessionPage { sessions, has_more })
}

/// Query a bounded, lightweight page from ORGII's imported-history cache.
/// `end_ms` is exclusive so adjacent date buckets cannot overlap.
pub fn query_imported_sidebar_page_from_conn(
    conn: &Connection,
    source: &str,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySidebarPage, String> {
    let limit = effective_limit(limit);
    let mut range_sql = String::new();
    let mut values = vec![SqlValue::from(source.to_string())];
    if let Some(start_ms) = start_ms {
        values.push(SqlValue::from(start_ms));
        range_sql.push_str(&format!(" AND updated_at_ms >= ?{}", values.len()));
    }
    if let Some(end_ms) = end_ms {
        values.push(SqlValue::from(end_ms));
        range_sql.push_str(&format!(" AND updated_at_ms < ?{}", values.len()));
    }
    let limit_param = values.len() + 1;
    let offset_param = values.len() + 2;
    values.push(SqlValue::from(limit.saturating_add(1) as i64));
    values.push(SqlValue::from(offset as i64));
    let sql = format!(
        "SELECT session_id, name, created_at_ms, updated_at_ms, cache.repo_path,
                model, files_changed, lines_added, lines_removed, touched_files_json,
                input_tokens, output_tokens, source_path,
                identity.repo_root_path, identity.remote_urls_json, cache.branch,
                cache.source_metadata_json, cache.client_origin, cache.client_origin_raw
         FROM imported_history_session_cache cache
         LEFT JOIN imported_history_repo_identity identity
           ON identity.working_path = cache.repo_path
         WHERE cache.source = ?1
           AND cache.listable = 1
           AND cache.parent_session_id = ''
           {range_sql}
         ORDER BY cache.updated_at_ms DESC, cache.created_at_ms DESC,
                  cache.source_session_id ASC
         LIMIT ?{limit_param} OFFSET ?{offset_param}"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("Failed to prepare imported sidebar query for {source}: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(values), |row| {
            let repo_path: String = row.get(4)?;
            let model: String = row.get(5)?;
            let touched_files_json: String = row.get(9)?;
            let touched_files =
                serde_json::from_str::<Vec<String>>(&touched_files_json).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(9, Type::Text, Box::new(err))
                })?;
            let input_tokens: i64 = row.get(10)?;
            let output_tokens: i64 = row.get(11)?;
            let source_path: String = row.get(12)?;
            let repo_root_path: Option<String> = row.get(13)?;
            let remote_urls_json: Option<String> = row.get(14)?;
            let repo_remote_urls =
                serde_json::from_str::<Vec<String>>(remote_urls_json.as_deref().unwrap_or("[]"))
                    .map_err(|err| {
                        rusqlite::Error::FromSqlConversionFailure(14, Type::Text, Box::new(err))
                    })?;
            // Stored as "" for sources that report no branch (the upsert
            // coalesces `None`), so normalize back to absent.
            let branch: String = row.get(15)?;
            let source_metadata_json: String = row.get(16)?;
            Ok(ImportedHistorySidebarRow {
                session_id: row.get(0)?,
                name: row.get(1)?,
                created_at: super::super::epoch_ms_to_iso(row.get(2)?),
                updated_at: super::super::epoch_ms_to_iso(row.get(3)?),
                status: None,
                is_active: None,
                // Stamped by the desktop layer from the pin overlay, alongside
                // the live-status decoration — the core query stays a pure
                // projection of the imported cache.
                pinned: false,
                repo_path: non_empty_string(repo_path),
                repo_root_path: repo_root_path.and_then(non_empty_string),
                repo_remote_urls,
                branch: non_empty_string(branch),
                storage_path: non_empty_string(source_path),
                model: non_empty_string(model),
                continuation_lineage_id: continuation_lineage_id_from_metadata_json(
                    &source_metadata_json,
                ),
                total_tokens: input_tokens + output_tokens,
                files_changed: row.get(6)?,
                lines_added: row.get(7)?,
                lines_removed: row.get(8)?,
                touched_files,
                client_origin: non_empty_string(row.get(17)?)
                    .as_deref()
                    .and_then(ImportedClientOrigin::from_wire_str),
                client_origin_raw: non_empty_string(row.get(18)?),
            })
        })
        .map_err(|err| format!("Failed to query imported sidebar rows for {source}: {err}"))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(
            row.map_err(|err| format!("Failed to read imported sidebar row for {source}: {err}"))?,
        );
    }
    let has_more = sessions.len() > limit;
    sessions.truncate(limit);
    Ok(ImportedHistorySidebarPage { sessions, has_more })
}

pub fn query_imported_recent_paths_from_conn(
    conn: &Connection,
    source: &str,
    limit: usize,
) -> Result<Vec<ImportedHistoryRecentPath>, String> {
    let rows = query_cached_sessions_from_conn(conn, source, i64::MAX as usize, 0)?;
    Ok(recent_paths_from_rows(
        &rows
            .into_iter()
            .map(|session| session.to_row())
            .collect::<Vec<_>>(),
    )
    .into_iter()
    .take(effective_limit(limit))
    .collect())
}
