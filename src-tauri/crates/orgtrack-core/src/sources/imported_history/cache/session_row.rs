use rusqlite::{params_from_iter, types::Type, types::Value as SqlValue, Connection};

use super::super::client_origin::ImportedClientOrigin;
use super::super::metadata::ImportedHistoryImpactStats;
use super::super::{row_from_input, ImportedHistoryRowInput, ImportedHistorySessionRow};

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
    pub repo_root_path: Option<String>,
    pub repo_remote_urls: Vec<String>,
    pub branch: Option<String>,
    pub impact: ImportedHistoryImpactStats,
    pub listable: bool,
    pub source_metadata_json: Option<String>,
    pub parent_session_id: Option<String>,
    pub client_origin: Option<ImportedClientOrigin>,
    pub client_origin_raw: Option<String>,
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
            repo_root_path: self.repo_root_path.clone(),
            repo_remote_urls: self.repo_remote_urls.clone(),
            storage_path: Some(self.source_path.clone()),
            branch: self.branch.clone(),
            files_changed: self.impact.files_changed,
            lines_added: self.impact.lines_added,
            lines_removed: self.impact.lines_removed,
            touched_files: self.impact.touched_files.clone(),
            parent_session_id: self.parent_session_id.clone(),
            client_origin: self.client_origin,
            client_origin_raw: self.client_origin_raw.clone(),
        })
    }
}

pub(super) fn query_cached_sessions_from_conn(
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

pub(super) fn query_cached_sessions_by_filter_from_conn(
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
                imported_history_session_cache.repo_path, branch, files_changed,
                lines_added, lines_removed, touched_files_json, listable,
                source_metadata_json, parent_session_id,
                identity.repo_root_path, identity.remote_urls_json,
                client_origin, client_origin_raw
         FROM imported_history_session_cache
         LEFT JOIN imported_history_repo_identity identity
           ON identity.working_path = imported_history_session_cache.repo_path
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
            let repo_root_path: Option<String> = row.get(23)?;
            let remote_urls_json: Option<String> = row.get(24)?;
            let repo_remote_urls =
                serde_json::from_str::<Vec<String>>(remote_urls_json.as_deref().unwrap_or("[]"))
                    .map_err(|err| {
                        rusqlite::Error::FromSqlConversionFailure(24, Type::Text, Box::new(err))
                    })?;
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
                repo_root_path: repo_root_path.and_then(non_empty_string),
                repo_remote_urls,
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
                client_origin: non_empty_string(row.get(25)?)
                    .as_deref()
                    .and_then(ImportedClientOrigin::from_wire_str),
                client_origin_raw: non_empty_string(row.get(26)?),
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

pub(super) fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
