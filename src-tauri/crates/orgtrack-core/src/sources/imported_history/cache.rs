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
    RoundUsage,
};
use super::{
    effective_limit, recent_paths_from_rows, row_from_input, ImportedHistoryRecentPath,
    ImportedHistoryRowInput, ImportedHistorySessionPage, ImportedHistorySessionRow,
    ImportedHistorySidebarPage, ImportedHistorySidebarRow,
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
                    cache_read_tokens, cache_write_tokens,
                    repo_path, branch, files_changed, lines_added, lines_removed,
                    touched_files_json, listable, source_metadata_json, parent_session_id,
                    updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
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
                    cache_read_tokens = excluded.cache_read_tokens,
                    cache_write_tokens = excluded.cache_write_tokens,
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
                input.cache_read_tokens,
                input.cache_write_tokens,
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
    // Project usage/cost for rows that carry token counts. Best-effort: a
    // projection failure must not fail the import scan (the startup backfill
    // repairs missing rows), and this crate has no logging facility to report
    // it through.
    for input in inputs {
        if input.input_tokens > 0 || input.output_tokens > 0 {
            let _ = crate::session_usage::recompute_session_usage(conn, &input.session_id);
        }
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
        collaboration_origin: None,
        metadata: AgentMetadata {
            origin: Some(input.source.to_string()),
            display_name: Some(input.source.to_string()),
            model: input.model.clone(),
            ..AgentMetadata::default()
        },
    }
}

/// Replace the per-round usage rows for the given (re-parsed) sessions: delete
/// any existing rounds for those `session_id`s, then insert `rounds`. Called
/// once per scan with the sessions that were actually re-parsed, so unchanged
/// sessions keep their rounds.
pub fn write_session_rounds_from_conn(
    conn: &Connection,
    reparsed_session_ids: &[String],
    rounds: &[RoundUsage],
) -> Result<(), String> {
    if reparsed_session_ids.is_empty() && rounds.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("Failed to start round-usage transaction: {err}"))?;
    for chunk in reparsed_session_ids.chunks(400) {
        let placeholders = (1..=chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        tx.execute(
            &format!(
                "DELETE FROM imported_history_round_usage WHERE session_id IN ({placeholders})"
            ),
            params_from_iter(chunk.iter().map(String::as_str)),
        )
        .map_err(|err| format!("Failed to clear stale imported rounds: {err}"))?;
    }
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO imported_history_round_usage (
                    source, source_session_id, session_id, seq, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|err| format!("Failed to prepare imported round insert: {err}"))?;
        for round in rounds {
            stmt.execute(params![
                round.source,
                round.source_session_id,
                round.session_id,
                round.seq,
                round.model.as_deref().unwrap_or_default(),
                round.input_tokens,
                round.output_tokens,
                round.cache_read_tokens,
                round.cache_write_tokens,
                round.created_at_ms,
            ])
            .map_err(|err| format!("Failed to insert imported round: {err}"))?;
        }
    }
    tx.commit()
        .map_err(|err| format!("Failed to commit imported rounds: {err}"))
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
        conn.execute(
            "DELETE FROM imported_history_round_usage WHERE source = ?1",
            [source],
        )
        .ok();
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
    // Drop rounds whose owning session was just pruned.
    conn.execute(
        "DELETE FROM imported_history_round_usage \
         WHERE source = ?1 AND session_id NOT IN \
             (SELECT session_id FROM imported_history_session_cache WHERE source = ?1)",
        [source],
    )
    .ok();
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
        "SELECT session_id, name, created_at_ms, updated_at_ms, repo_path,
                model, files_changed, lines_added, lines_removed, touched_files_json,
                input_tokens, output_tokens, source_path
         FROM imported_history_session_cache
         WHERE source = ?1
           AND listable = 1
           AND parent_session_id = ''
           {range_sql}
         ORDER BY updated_at_ms DESC, created_at_ms DESC, source_session_id ASC
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
            Ok(ImportedHistorySidebarRow {
                session_id: row.get(0)?,
                name: row.get(1)?,
                created_at: super::epoch_ms_to_iso(row.get(2)?),
                updated_at: super::epoch_ms_to_iso(row.get(3)?),
                status: None,
                is_active: None,
                repo_path: non_empty_string(repo_path),
                storage_path: non_empty_string(source_path),
                model: non_empty_string(model),
                total_tokens: input_tokens + output_tokens,
                files_changed: row.get(6)?,
                lines_added: row.get(7)?,
                lines_removed: row.get(8)?,
                touched_files,
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

/// Like [`get_cached_source_path_from_conn`], but also matches a
/// `-`-bounded suffix of the cached key. Codex imports key on the rollout
/// file stem (`rollout-<timestamp>-<thread-uuid>`) while runner bindings
/// carry the bare thread uuid; newest wins when several rollouts share a
/// thread (resume forks).
pub fn get_cached_source_path_by_suffix_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT source_path FROM imported_history_session_cache \
         WHERE source = ?1 \
           AND (source_session_id = ?2 OR source_session_id LIKE '%-' || ?2) \
         ORDER BY updated_at_ms DESC LIMIT 1",
        params![source, source_session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("Failed to query imported history source path: {err}"))
}

/// Freshness stat of one imported session's transcript source file, keyed by
/// the app-level (prefixed) session id the frontend holds. Returns `Ok(None)`
/// when the session is not cached or the file is gone — callers fall back to
/// a full refresh, which re-syncs the cache.
///
/// SQLite-backed stores (Cursor, OpenCode, ZCode, …) run in WAL mode, where
/// commits land in the `-wal` sibling without touching the main db's mtime
/// until a checkpoint. Fold the sibling into the signature so those sources
/// don't read as permanently unchanged.
pub fn stat_imported_transcript_by_session_id_from_conn(
    conn: &Connection,
    source: &str,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let path: Option<String> = conn
        .query_row(
            "SELECT source_path FROM imported_history_session_cache \
             WHERE source = ?1 AND session_id = ?2 AND source_path != ''",
            params![source, session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Failed to query imported history source path: {err}"))?;
    let Some(path) = path else {
        return Ok(None);
    };

    let Ok(main) = std::fs::metadata(&path) else {
        return Ok(None);
    };
    let mut mtime_ms = metadata_mtime_epoch_ms(&main);
    let mut size_bytes = main.len();
    if let Ok(wal) = std::fs::metadata(format!("{path}-wal")) {
        mtime_ms = mtime_ms.max(metadata_mtime_epoch_ms(&wal));
        size_bytes += wal.len();
    }
    Ok(Some((mtime_ms, size_bytes)))
}

fn metadata_mtime_epoch_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Cached session counts for a source, split into top-level sessions and child
/// sub-agent sessions. A session is a sub-agent when it has a parent — either a
/// non-empty `parent_session_id` or a `:subagent:` id segment — which is exactly
/// the signal the sidebar uses to collapse a session under its parent
/// (`isPrimarySessionListSession`), independent of `listable`. This matters
/// because sub-agents are represented two ways: Cursor hides them
/// (`listable = 0`) while Claude Code / Codex / Cline keep them listable but
/// collapsed. Returns `(sessions, subagents)`; the two sum to the source total.
pub fn source_session_counts_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<(usize, usize), String> {
    // Keep this predicate in sync with `isPrimarySessionListSession`
    // (src/util/session/sessionVisibility.ts): a child = has a parent id.
    const IS_SUBAGENT: &str =
        "(COALESCE(parent_session_id, '') != '' OR source_session_id LIKE '%:subagent:%')";
    let sql = format!(
        "SELECT \
            COALESCE(SUM(CASE WHEN {IS_SUBAGENT} THEN 0 ELSE 1 END), 0), \
            COALESCE(SUM(CASE WHEN {IS_SUBAGENT} THEN 1 ELSE 0 END), 0) \
         FROM imported_history_session_cache WHERE source = ?1"
    );
    conn.query_row(&sql, [source], |row| {
        Ok((
            row.get::<_, i64>(0)? as usize,
            row.get::<_, i64>(1)? as usize,
        ))
    })
    .map_err(|err| format!("Failed to count imported history sessions: {err}"))
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

/// Most recently updated cached sessions for a source, including managed
/// mirrors and child sessions that are intentionally hidden from sidebar
/// listings. Background provenance reconciliation needs the complete set.
pub fn query_recent_cached_sessions_for_source_from_conn(
    conn: &Connection,
    source: &str,
    limit: usize,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    query_cached_sessions_by_filter_from_conn(conn, source, "1 = 1", &[], limit, 0)
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

/// Resolve one canonical session ID without scanning paginated source rows.
///
/// Sidebar deep links use the canonical ID rendered by the rest of ORGII,
/// while the cache primary key is `(source, source_session_id)`. Resolve the
/// source first, then reuse the canonical row decoder so the targeted and
/// paginated paths cannot drift in field handling.
pub fn query_cached_session_by_session_id_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, ImportedHistoryCachedSession)>, String> {
    let source = conn
        .query_row(
            "SELECT source FROM imported_history_session_cache WHERE session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| {
            format!("Failed to resolve imported history source for {session_id}: {err}")
        })?;
    let Some(source) = source else {
        return Ok(None);
    };
    let sessions = query_cached_sessions_by_filter_from_conn(
        conn,
        &source,
        "session_id = ?2",
        &[SqlValue::from(session_id.to_string())],
        1,
        0,
    )?;
    Ok(sessions.into_iter().next().map(|session| (source, session)))
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

/// Query cached sessions for one repository, including child/subagent rows
/// that list surfaces intentionally hide. A child without its own repository
/// inherits the parent's match in SQL so reconciliation stays repo-scoped
/// without loading every historical session into memory.
pub fn query_cached_sessions_for_repo_from_conn(
    conn: &Connection,
    source: &str,
    repo_path: &str,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    query_cached_sessions_by_filter_from_conn(
        conn,
        source,
        "(repo_path = ?2 OR (
            repo_path = '' AND parent_session_id IN (
                SELECT parent_match.session_id
                FROM imported_history_session_cache parent_match
                WHERE parent_match.source = ?1 AND parent_match.repo_path = ?2
            )
        ))",
        &[SqlValue::from(repo_path.to_string())],
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

/// Advance only the discovery signature for an already-cached catalog row.
///
/// Sidebar rescans must notice that an external transcript grew without
/// re-reading its body merely to rebuild metadata we already persisted.  The
/// bounded replay index owns body/token/impact updates; this helper preserves
/// those fields and updates only source identity, freshness, and the optional
/// listability decision derived from cheap source indexes.
pub fn advance_cached_catalog_record_from_conn(
    conn: &Connection,
    source: &str,
    record: &super::metadata::ImportedHistoryDiscoveredRecord,
    listable: Option<bool>,
) -> Result<bool, String> {
    let updated_at_ms = record.source_mtime_ms.saturating_div(1_000_000);
    let changed = conn
        .execute(
            "UPDATE imported_history_session_cache
             SET source_path = ?3,
                 source_record_key = ?4,
                 source_mtime_ms = ?5,
                 source_size_bytes = ?6,
                 source_fingerprint = ?7,
                 parser_version = ?8,
                 updated_at_ms = MAX(updated_at_ms, ?9),
                 listable = CASE WHEN ?10 IS NULL THEN listable ELSE ?10 END,
                 updated_at = ?11
             WHERE source = ?1 AND source_session_id = ?2",
            params![
                source,
                record.source_session_id,
                record.source_path.to_string_lossy(),
                record.source_record_key,
                record.source_mtime_ms,
                record.source_size_bytes,
                record.source_fingerprint,
                record.parser_version,
                updated_at_ms,
                listable.map(i64::from),
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|err| format!("Failed to advance imported catalog record: {err}"))?;
    Ok(changed > 0)
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

/// `source_metadata_json` field naming the continuation-family group key.
///
/// Context-window continuations rewrite a conversation into a NEW session
/// file with no link field, so readers derive a family key from content that
/// the rewrite preserves (Claude: the first user message's uuid).
pub const CONTINUATION_GROUP_KEY_FIELD: &str = "continuationGroupKey";

/// Serialize the continuation group key into `source_metadata_json` shape.
pub fn continuation_group_metadata_json(group_key: Option<&str>) -> Option<String> {
    let group_key = group_key.map(str::trim).filter(|key| !key.is_empty())?;
    Some(serde_json::json!({ CONTINUATION_GROUP_KEY_FIELD: group_key }).to_string())
}

/// Demote continuation-superseded sessions: within each group of top-level
/// sessions sharing a continuation group key, only the newest sibling (by
/// `updated_at_ms`, then `source_session_id`) stays listable; every other
/// currently-listable sibling flips to `listable = 0`.
///
/// Demote-only by design: winners are never promoted here, so a winner that
/// is unlistable for another reason (managed mirror, subagent) stays hidden.
/// Runs after every sync; if a demoted file later changes on disk its
/// re-parse resets `listable = 1` and the next election re-demotes it.
pub fn demote_superseded_continuations_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_session_id, source_metadata_json, updated_at_ms, listable
             FROM imported_history_session_cache
             WHERE source = ?1
               AND COALESCE(parent_session_id, '') = ''
               AND COALESCE(source_metadata_json, '') != ''",
        )
        .map_err(|err| format!("Failed to prepare continuation election query: {err}"))?;
    let rows = stmt
        .query_map([source], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)? != 0,
            ))
        })
        .map_err(|err| format!("Failed to query continuation election rows: {err}"))?;

    // group key -> (winner-ordering key, listable losers seen so far)
    struct Family {
        winner: (i64, String),
        listable_ids: Vec<(String, (i64, String))>,
    }
    let mut families: HashMap<String, Family> = HashMap::new();
    for row in rows {
        let (source_session_id, metadata_json, updated_at_ms, listable) =
            row.map_err(|err| format!("Failed to read continuation election row: {err}"))?;
        let Some(group_key) = serde_json::from_str::<serde_json::Value>(&metadata_json)
            .ok()
            .as_ref()
            .and_then(|metadata| metadata.get(CONTINUATION_GROUP_KEY_FIELD))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let ordering = (updated_at_ms, source_session_id.clone());
        let family = families.entry(group_key).or_insert_with(|| Family {
            winner: ordering.clone(),
            listable_ids: Vec::new(),
        });
        if ordering > family.winner {
            family.winner = ordering.clone();
        }
        if listable {
            family.listable_ids.push((source_session_id, ordering));
        }
    }

    let losers = families
        .values()
        .flat_map(|family| {
            family
                .listable_ids
                .iter()
                .filter(|(_, ordering)| *ordering != family.winner)
                .map(|(id, _)| id.clone())
        })
        .collect::<Vec<_>>();
    for source_session_id in &losers {
        conn.execute(
            "UPDATE imported_history_session_cache
             SET listable = 0
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![source, source_session_id],
        )
        .map_err(|err| format!("Failed to demote superseded continuation: {err}"))?;
    }
    Ok(losers.len())
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
