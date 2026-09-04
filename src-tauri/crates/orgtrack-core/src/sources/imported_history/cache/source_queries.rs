use rusqlite::{types::Value as SqlValue, Connection};

use super::session_row::{query_cached_sessions_by_filter_from_conn, ImportedHistoryCachedSession};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedHistorySourceStats {
    pub source: String,
    pub session_count: usize,
    pub subagent_count: usize,
    pub last_used_at_ms: Option<i64>,
}

/// Aggregate every cached source in one indexed GROUP BY. Runtime's Scanning
/// inventory previously issued two commands per source (and Cursor loaded its
/// entire external database); this keeps the inventory read inside ORGII's
/// incremental cache and transfers one compact row per source.
pub fn all_source_stats_from_conn(
    conn: &Connection,
) -> Result<Vec<ImportedHistorySourceStats>, String> {
    const IS_SUBAGENT: &str =
        "(COALESCE(parent_session_id, '') != '' OR source_session_id LIKE '%:subagent:%')";
    let sql = format!(
        "SELECT source, \
            COALESCE(SUM(CASE WHEN {IS_SUBAGENT} THEN 0 ELSE 1 END), 0), \
            COALESCE(SUM(CASE WHEN {IS_SUBAGENT} THEN 1 ELSE 0 END), 0), \
            MAX(updated_at_ms) \
         FROM imported_history_session_cache \
         GROUP BY source"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|err| format!("Failed to prepare imported history stats query: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ImportedHistorySourceStats {
                source: row.get(0)?,
                session_count: row.get::<_, i64>(1)? as usize,
                subagent_count: row.get::<_, i64>(2)? as usize,
                last_used_at_ms: row.get(3)?,
            })
        })
        .map_err(|err| format!("Failed to query imported history stats: {err}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| format!("Failed to read imported history stats: {err}"))
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

/// Cheap whole-source content signature for staleness checks: row count, the
/// newest cache-write stamp, and the listable sum. It changes whenever ANY
/// caller's sync inserts, re-parses, prunes, or (de)lists rows for the source
/// — including continuation demotions applied during a sync triggered by a
/// different surface, which per-call "did MY call write" reporting cannot
/// see. The frontend compares it against the signature captured at its last
/// roster reload to decide whether the sidebar is stale.
pub fn query_source_cache_signature_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<String, String> {
    conn.query_row(
        "SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') || ':' || COALESCE(SUM(listable), 0)
         FROM imported_history_session_cache WHERE source = ?1",
        [source],
        |row| row.get::<_, String>(0),
    )
    .map_err(|err| format!("Failed to compute imported history cache signature for {source}: {err}"))
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
