use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::canonical::{AgentMetadata, SessionRecord};
use crate::privacy::ORGTRACK_SCHEMA_VERSION;
use crate::store::{sqlite::SqliteRecordStore, RecordStore};
use chrono::Utc;
use rusqlite::{
    params, params_from_iter, types::Type, types::Value as SqlValue, Connection, OptionalExtension,
};

use super::metadata::{
    ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
};
use super::{
    effective_limit, recent_paths_from_rows, row_from_input, ImportedHistoryRecentPath,
    ImportedHistoryRowInput, ImportedHistorySessionPage, ImportedHistorySessionRow,
};

#[derive(Debug, Clone)]
pub struct ImportedHistoryCachedSession {
    pub source_session_id: String,
    pub session_id: String,
    pub source_path: String,
    pub source_record_key: String,
    pub source_mtime_ms: i64,
    pub source_size_bytes: i64,
    pub source_fingerprint: String,
    pub parser_version: i64,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub impact: ImportedHistoryImpactStats,
    pub listable: bool,
    pub source_metadata_json: Option<String>,
    pub parent_session_id: Option<String>,
}

impl ImportedHistoryCachedSession {
    pub fn to_row(&self) -> ImportedHistorySessionRow {
        row_from_input(ImportedHistoryRowInput {
            session_id: self.session_id.clone(),
            name: self.name.clone(),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            model: self.model.clone(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            repo_path: self.repo_path.clone(),
            storage_path: Some(self.source_path.clone()),
            branch: self.branch.clone(),
            files_changed: self.impact.files_changed,
            lines_added: self.impact.lines_added,
            lines_removed: self.impact.lines_removed,
            touched_files: self.impact.touched_files.clone(),
            parent_session_id: self.parent_session_id.clone(),
        })
    }
}

pub fn cached_record_signatures_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<HashMap<String, ImportedHistoryRecordSignature>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_session_id, source_path, source_mtime_ms, source_size_bytes, \
                    source_fingerprint, parser_version \
             FROM imported_history_session_cache \
             WHERE source = ?1",
        )
        .map_err(|err| format!("Failed to prepare imported history signature query: {err}"))?;
    let rows = stmt
        .query_map([source], |row| {
            Ok(ImportedHistoryRecordSignature {
                source_session_id: row.get(0)?,
                source_path: row.get(1)?,
                source_mtime_ms: row.get(2)?,
                source_size_bytes: row.get(3)?,
                source_fingerprint: row.get(4)?,
                parser_version: row.get(5)?,
            })
        })
        .map_err(|err| format!("Failed to query imported history signatures: {err}"))?;

    let mut signatures = HashMap::new();
    for row in rows {
        let signature =
            row.map_err(|err| format!("Failed to read imported history signature: {err}"))?;
        signatures.insert(signature.source_session_id.clone(), signature);
    }
    Ok(signatures)
}

pub fn record_matches_cached_signature(
    cached: &ImportedHistoryRecordSignature,
    discovered: &ImportedHistoryRecordSignature,
) -> bool {
    cached.source_path == discovered.source_path
        && cached.source_mtime_ms == discovered.source_mtime_ms
        && cached.source_size_bytes == discovered.source_size_bytes
        && cached.source_fingerprint == discovered.source_fingerprint
        && cached.parser_version == discovered.parser_version
}

pub fn upsert_imported_session_cache_from_conn(
    conn: &mut Connection,
    inputs: &[ImportedHistoryCacheInput],
) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let tx = conn
        .transaction()
        .map_err(|err| format!("Failed to start imported history cache transaction: {err}"))?;
    let updated_at = Utc::now().to_rfc3339();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO imported_history_session_cache (
                    source, source_session_id, session_id, source_path, source_record_key,
                    source_mtime_ms, source_size_bytes, source_fingerprint, parser_version,
                    name, created_at_ms, updated_at_ms, model, input_tokens, output_tokens,
                    repo_path, branch, files_changed, lines_added, lines_removed,
                    touched_files_json, listable, source_metadata_json, parent_session_id,
                    updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
                )
                ON CONFLICT(source, source_session_id) DO UPDATE SET
                    session_id = excluded.session_id,
                    source_path = excluded.source_path,
                    source_record_key = excluded.source_record_key,
                    source_mtime_ms = excluded.source_mtime_ms,
                    source_size_bytes = excluded.source_size_bytes,
                    source_fingerprint = excluded.source_fingerprint,
                    parser_version = excluded.parser_version,
                    name = excluded.name,
                    created_at_ms = excluded.created_at_ms,
                    updated_at_ms = excluded.updated_at_ms,
                    model = excluded.model,
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens,
                    repo_path = excluded.repo_path,
                    branch = excluded.branch,
                    files_changed = excluded.files_changed,
                    lines_added = excluded.lines_added,
                    lines_removed = excluded.lines_removed,
                    touched_files_json = excluded.touched_files_json,
                    listable = excluded.listable,
                    source_metadata_json = excluded.source_metadata_json,
                    parent_session_id = excluded.parent_session_id,
                    updated_at = excluded.updated_at",
            )
            .map_err(|err| format!("Failed to prepare imported history cache upsert: {err}"))?;
        for input in inputs {
            let touched_files_json = serde_json::to_string(&input.impact.touched_files)
                .map_err(|err| format!("Failed to encode imported history touched files: {err}"))?;
            stmt.execute(params![
                input.source,
                input.source_session_id,
                input.session_id,
                input.source_path,
                input.source_record_key,
                input.source_mtime_ms,
                input.source_size_bytes,
                input.source_fingerprint,
                input.parser_version,
                input.name,
                input.created_at_ms,
                input.updated_at_ms,
                input.model.as_deref().unwrap_or_default(),
                input.input_tokens,
                input.output_tokens,
                input.repo_path.as_deref().unwrap_or_default(),
                input.branch.as_deref().unwrap_or_default(),
                input.impact.files_changed,
                input.impact.lines_added,
                input.impact.lines_removed,
                touched_files_json,
                if input.listable { 1_i64 } else { 0_i64 },
                input.source_metadata_json.as_deref().unwrap_or_default(),
                input.parent_session_id.as_deref().unwrap_or_default(),
                updated_at,
            ])
            .map_err(|err| format!("Failed to upsert imported history cache row: {err}"))?;
        }
    }
    tx.commit()
        .map_err(|err| format!("Failed to commit imported history cache rows: {err}"))?;

    let store = SqliteRecordStore::new(conn);
    for input in inputs {
        store.upsert_session(&core_session_record_from_imported_input(input))?;
    }
    Ok(())
}

fn core_session_record_from_imported_input(input: &ImportedHistoryCacheInput) -> SessionRecord {
    SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: input.source.to_string(),
        source_session_id: input.source_session_id.clone(),
        session_id: input.session_id.clone(),
        title: input.name.clone(),
        status: Some(super::IMPORTED_STATUS_COMPLETED.to_string()),
        created_at: Some(super::epoch_ms_to_iso(input.created_at_ms)),
        updated_at: Some(super::epoch_ms_to_iso(input.updated_at_ms)),
        completed_at: Some(super::epoch_ms_to_iso(input.updated_at_ms)),
        workspace_path: input.repo_path.clone(),
        branch: input.branch.clone(),
        parent_session_id: input.parent_session_id.clone(),
        org_member_id: None,
        metadata: AgentMetadata {
            origin: Some(input.source.to_string()),
            display_name: Some(input.source.to_string()),
            model: input.model.clone(),
            ..AgentMetadata::default()
        },
    }
}

pub fn prune_missing_records_from_conn(
    conn: &Connection,
    source: &str,
    live_source_session_ids: &[String],
) -> Result<(), String> {
    if live_source_session_ids.is_empty() {
        conn.execute(
            "DELETE FROM imported_history_session_cache WHERE source = ?1",
            [source],
        )
        .map_err(|err| format!("Failed to prune imported history cache source {source}: {err}"))?;
        return Ok(());
    }

    let placeholders = (2..live_source_session_ids.len().saturating_add(2))
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM imported_history_session_cache \
         WHERE source = ?1 AND source_session_id NOT IN ({placeholders})"
    );
    let params = std::iter::once(source)
        .chain(live_source_session_ids.iter().map(String::as_str))
        .collect::<Vec<_>>();
    conn.execute(&sql, params_from_iter(params))
        .map_err(|err| format!("Failed to prune imported history cache source {source}: {err}"))?;
    Ok(())
}

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

pub fn get_cached_source_path_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT source_path FROM imported_history_session_cache \
         WHERE source = ?1 AND source_session_id = ?2",
        params![source, source_session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("Failed to query imported history source path: {err}"))
}

fn query_cached_sessions_from_conn(
    conn: &Connection,
    source: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    query_cached_sessions_by_filter_from_conn(
        conn,
        source,
        "listable = ?2 AND parent_session_id = ''",
        &[SqlValue::from(1_i64)],
        limit,
        offset,
    )
}

fn query_cached_sessions_by_filter_from_conn(
    conn: &Connection,
    source: &str,
    filter_sql: &str,
    filter_params: &[SqlValue],
    limit: usize,
    offset: usize,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    let sql = format!(
        "SELECT source_session_id, session_id, source_path, source_record_key,
                source_mtime_ms, source_size_bytes, source_fingerprint, parser_version,
                name, created_at_ms, updated_at_ms, model, input_tokens, output_tokens,
                repo_path, branch, files_changed, lines_added, lines_removed,
                touched_files_json, listable, source_metadata_json, parent_session_id
         FROM imported_history_session_cache
         WHERE source = ?1 AND {filter_sql}
         ORDER BY updated_at_ms DESC, created_at_ms DESC, source_session_id ASC
         LIMIT ?{} OFFSET ?{}",
        filter_params.len() + 2,
        filter_params.len() + 3
    );
    let params = std::iter::once(SqlValue::from(source.to_string()))
        .chain(filter_params.iter().cloned())
        .chain([SqlValue::from(limit as i64), SqlValue::from(offset as i64)])
        .collect::<Vec<_>>();
    let mut stmt = conn.prepare(&sql).map_err(|err| {
        format!("Failed to prepare imported history cache query for {source}: {err}")
    })?;
    let rows = stmt
        .query_map(params_from_iter(params), |row| {
            let model: String = row.get(11)?;
            let repo_path: String = row.get(14)?;
            let branch: String = row.get(15)?;
            let touched_files_json: String = row.get(19)?;
            let touched_files =
                serde_json::from_str::<Vec<String>>(&touched_files_json).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(19, Type::Text, Box::new(err))
                })?;
            let parent_session_id: String = row.get(22)?;
            Ok(ImportedHistoryCachedSession {
                source_session_id: row.get(0)?,
                session_id: row.get(1)?,
                source_path: row.get(2)?,
                source_record_key: row.get(3)?,
                source_mtime_ms: row.get(4)?,
                source_size_bytes: row.get(5)?,
                source_fingerprint: row.get(6)?,
                parser_version: row.get(7)?,
                name: row.get(8)?,
                created_at_ms: row.get(9)?,
                updated_at_ms: row.get(10)?,
                model: non_empty_string(model),
                input_tokens: row.get(12)?,
                output_tokens: row.get(13)?,
                repo_path: non_empty_string(repo_path),
                branch: non_empty_string(branch),
                impact: ImportedHistoryImpactStats {
                    files_changed: row.get(16)?,
                    lines_added: row.get(17)?,
                    lines_removed: row.get(18)?,
                    touched_files,
                },
                listable: row.get::<_, i64>(20)? != 0,
                source_metadata_json: non_empty_string(row.get(21)?),
                parent_session_id: non_empty_string(parent_session_id),
            })
        })
        .map_err(|err| {
            format!("Failed to query imported history cache rows for {source}: {err}")
        })?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|err| {
            format!("Failed to read imported history cache row for {source}: {err}")
        })?);
    }
    Ok(sessions)
}

pub fn sync_source_cache_from_conn(
    conn: &mut Connection,
    source: &'static str,
    live_source_session_ids: Vec<String>,
    inputs: Vec<ImportedHistoryCacheInput>,
) -> Result<(), String> {
    upsert_imported_session_cache_from_conn(conn, &inputs)?;
    prune_missing_records_from_conn(conn, source, &live_source_session_ids)
}

pub fn query_cached_session_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<ImportedHistoryCachedSession>, String> {
    let sessions = query_cached_sessions_by_filter_from_conn(
        conn,
        source,
        "source_session_id = ?2",
        &[SqlValue::from(source_session_id.to_string())],
        1,
        0,
    )?;
    Ok(sessions.into_iter().next())
}

pub fn query_cached_sessions_for_source_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    query_cached_sessions_by_filter_from_conn(
        conn,
        source,
        "listable = ?2",
        &[SqlValue::from(1_i64)],
        i64::MAX as usize,
        0,
    )
}

pub fn query_cached_sessions_in_range_from_conn(
    conn: &Connection,
    source: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    query_cached_sessions_by_filter_from_conn(
        conn,
        source,
        "created_at_ms >= ?2 AND created_at_ms <= ?3 AND listable = ?4",
        &[
            SqlValue::from(start_ms),
            SqlValue::from(end_ms),
            SqlValue::from(1_i64),
        ],
        i64::MAX as usize,
        0,
    )
}

pub fn current_epoch_ms() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System time is before Unix epoch: {err}"))
        .map(|duration| duration.as_millis() as i64)
}

pub fn changed_records_from_conn<'a, T, F>(
    conn: &Connection,
    source: &str,
    discovered: &'a [T],
    signature_for: F,
) -> Result<Vec<&'a T>, String>
where
    F: Fn(&T) -> ImportedHistoryRecordSignature,
{
    let cached = cached_record_signatures_from_conn(conn, source)?;
    Ok(discovered
        .iter()
        .filter(|record| {
            let signature = signature_for(record);
            cached
                .get(&signature.source_session_id)
                .is_none_or(|cached_signature| {
                    !record_matches_cached_signature(cached_signature, &signature)
                })
        })
        .collect())
}

pub fn live_ids_from_signatures(signatures: &[ImportedHistoryRecordSignature]) -> Vec<String> {
    let mut seen = HashSet::new();
    signatures
        .iter()
        .filter_map(|signature| {
            if seen.insert(signature.source_session_id.clone()) {
                Some(signature.source_session_id.clone())
            } else {
                None
            }
        })
        .collect()
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
