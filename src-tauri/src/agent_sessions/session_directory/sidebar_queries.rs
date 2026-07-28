//! Bounded SQLite queries used by the workstation session sidebar.
//!
//! These queries deliberately read the three compact source tables directly:
//! `agent_sessions`, `code_sessions`, and
//! `imported_history_session_cache`. The canonical orgtrack directory is a
//! useful projection, but older native/managed rows can predate that mirror.
//! Sidebar discovery must therefore never depend on a backfill having run.

use std::collections::BTreeSet;

use agent_core::session::persistence::{self as session_persistence, session_type};
use database::db::get_connection;
use orgtrack_core::canonical::{SOURCE_ORGII_CLI_SESSIONS, SOURCE_ORGII_RUST_AGENTS};
use rusqlite::{params, Connection};

use crate::agent_sessions::cli::persistence as cli_session_persistence;

pub(super) const PERSONAL_ORG_ID: &str = "personal-org";
pub(super) const SIDEBAR_COMPACT_PAGE_LIMIT: usize = 51;
const LEGACY_SDE_SESSION_PREFIX: &str = "agentsession-";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SidebarSessionCandidate {
    pub session_id: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WorkspaceFacetRow {
    pub repo_path: Option<String>,
    pub last_updated_at_ms: i64,
    pub session_count: usize,
}

pub(super) struct RustAgentGroupPageRequest<'a> {
    pub group: &'a str,
    pub org_ids: Option<&'a [String]>,
    pub repo_path: Option<&'a str>,
    pub missing_repo_path: bool,
    pub updated_after_ms: Option<i64>,
    pub updated_before_ms: Option<i64>,
    pub before: Option<SidebarSeekCursor<'a>>,
    pub limit: usize,
    pub offset: usize,
}

pub(super) struct CliPageRequest<'a> {
    pub org_ids: Option<&'a [String]>,
    pub repo_path: Option<&'a str>,
    pub missing_repo_path: bool,
    pub updated_after_ms: Option<i64>,
    pub updated_before_ms: Option<i64>,
    pub before: Option<SidebarSeekCursor<'a>>,
    pub limit: usize,
    pub offset: usize,
}

/// Stable descending-page boundary for native and managed CLI rows.
///
/// Values come from the exact `ORDER BY updated_at DESC, session_id DESC`
/// tuple. Imported history has a separate millisecond cursor because its
/// compact cache stores timestamps as integers.
#[derive(Clone, Copy)]
pub(super) struct SidebarSeekCursor<'a> {
    pub updated_at: &'a str,
    pub session_id: &'a str,
}

pub(super) struct SearchOrPinnedRequest<'a> {
    pub query: Option<&'a str>,
    pub pinned_only: bool,
    pub org_ids: Option<&'a [String]>,
    pub include_external: bool,
    pub disabled_sources: &'a [String],
    pub before: Option<SidebarSeekCursor<'a>>,
    pub limit: usize,
    pub offset: usize,
}

pub(super) struct WorkspaceFacetQuery<'a> {
    pub org_ids: &'a [String],
    pub include_external: bool,
    pub disabled_sources: &'a [String],
    pub before: Option<WorkspaceFacetSeekCursor<'a>>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Clone, Copy)]
pub(super) struct WorkspaceFacetSeekCursor<'a> {
    pub last_updated_at_ms: i64,
    pub repo_path: Option<&'a str>,
}

fn normalize_org_ids(org_ids: Option<&[String]>) -> Result<Option<String>, String> {
    let Some(org_ids) = org_ids else {
        return Ok(None);
    };
    let normalized = org_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>();
    if normalized.is_empty() {
        return Err("Sidebar org scope must contain at least one org id".to_string());
    }
    serde_json::to_string(&normalized)
        .map(Some)
        .map_err(|error| format!("Failed to serialize sidebar org scope for SQLite: {error}"))
}

fn disabled_sources_json(disabled_sources: &[String]) -> Result<String, String> {
    let normalized = disabled_sources
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>();
    serde_json::to_string(&normalized)
        .map_err(|error| format!("Failed to serialize disabled sidebar sources: {error}"))
}

fn escaped_like_pattern(query: Option<&str>) -> Option<String> {
    let query = query?.trim();
    if query.is_empty() {
        return None;
    }
    let escaped = query
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Some(format!("%{escaped}%"))
}

pub(super) fn load_scoped_rust_agent_group_page(
    request: RustAgentGroupPageRequest<'_>,
) -> Result<Vec<session_persistence::UnifiedSessionRecord>, String> {
    let RustAgentGroupPageRequest {
        group,
        org_ids,
        repo_path,
        missing_repo_path,
        updated_after_ms,
        updated_before_ms,
        before,
        limit,
        offset,
    } = request;
    if repo_path.is_some() && missing_repo_path {
        return Err(
            "Native session page cannot combine repo_path and missing_repo_path".to_string(),
        );
    }
    let org_ids_json = normalize_org_ids(org_ids)?;
    let conn = get_connection().map_err(|err| format!("Failed to open session DB: {err}"))?;
    let sql = "SELECT s.session_id
               FROM agent_sessions s
               WHERE (s.parent_session_id IS NULL OR s.parent_session_id = '')
                 AND s.status != ?1
                 AND (
                   (?2 = 'sde'
                     AND s.session_type = ?3
                     AND (s.session_id LIKE ?4 OR s.session_id LIKE ?5)
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                     ))
                   OR (?2 = 'agent_org'
                     AND EXISTS (
                       SELECT 1 FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                     ))
                   OR (?2 = 'os'
                     AND s.session_type = ?6
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                     ))
                   OR (?2 = 'wingman'
                     AND s.session_type = ?3
                     AND s.session_id LIKE ?7
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                     ))
                   OR (?2 = 'custom'
                     AND s.session_type = ?3
                     AND s.session_id NOT LIKE ?4
                     AND s.session_id NOT LIKE ?5
                     AND s.session_id NOT LIKE ?7
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                     ))
                   OR (?2 = 'human'
                     AND s.session_type = ?8
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                     ))
                 )
                 AND (?9 IS NULL
                   OR COALESCE(NULLIF(TRIM(s.org_id), ''), 'personal-org')
                      IN (SELECT value FROM json_each(?9)))
                 AND (?10 IS NULL
                   OR RTRIM(COALESCE(s.workspace_path, ''), '/') =
                      RTRIM(?10, '/'))
                 AND (?11 = 0 OR TRIM(COALESCE(s.workspace_path, '')) = '')
                 AND (?12 IS NULL
                   OR CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000 >= ?12)
                 AND (?13 IS NULL
                   OR CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000 < ?13)
                 AND (?14 IS NULL
                   OR s.updated_at < ?14
                   OR (s.updated_at = ?14 AND s.session_id < ?15))
               ORDER BY s.updated_at DESC, s.session_id DESC
               LIMIT ?16 OFFSET ?17";
    let like_prefix = |prefix: &str| format!("{prefix}%");
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("Failed to prepare Rust-agent group page: {err}"))?;
    let session_ids = stmt
        .query_map(
            params![
                agent_core::session::SessionStatus::Archived.as_str(),
                group,
                session_type::CODING,
                like_prefix(core_types::session::SDE_SESSION_PREFIX),
                like_prefix(LEGACY_SDE_SESSION_PREFIX),
                session_type::DESKTOP,
                like_prefix(core_types::session::WINGMAN_SESSION_PREFIX),
                session_type::HUMAN,
                org_ids_json,
                repo_path,
                i64::from(missing_repo_path),
                updated_after_ms,
                updated_before_ms,
                before.map(|cursor| cursor.updated_at),
                before.map(|cursor| cursor.session_id),
                limit.min(i64::MAX as usize) as i64,
                if before.is_some() {
                    0
                } else {
                    offset.min(i64::MAX as usize) as i64
                },
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("Failed to query Rust-agent group page: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read Rust-agent group page: {err}"))?;

    session_ids
        .into_iter()
        .map(|session_id| {
            session_persistence::get_session(&session_id)
                .map_err(|err| format!("Failed to hydrate Rust-agent session {session_id}: {err}"))?
                .ok_or_else(|| {
                    format!("Rust-agent session disappeared while listing: {session_id}")
                })
        })
        .collect()
}

pub(super) fn load_scoped_cli_page(
    request: CliPageRequest<'_>,
) -> Result<Vec<cli_session_persistence::CodeSession>, String> {
    let CliPageRequest {
        org_ids,
        repo_path,
        missing_repo_path,
        updated_after_ms,
        updated_before_ms,
        before,
        limit,
        offset,
    } = request;
    if repo_path.is_some() && missing_repo_path {
        return Err("CLI page cannot combine repo_path and missing_repo_path".to_string());
    }
    let org_ids_json = normalize_org_ids(org_ids)?;
    let conn = get_connection().map_err(|err| format!("Failed to open session DB: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT cs.session_id
             FROM code_sessions cs
             WHERE (cs.parent_session_id IS NULL OR cs.parent_session_id = '')
               AND (?1 IS NULL
                 OR COALESCE(NULLIF(TRIM(cs.org_id), ''), 'personal-org')
                    IN (SELECT value FROM json_each(?1)))
               AND (?2 IS NULL
                 OR RTRIM(COALESCE(cs.repo_path, ''), '/') = RTRIM(?2, '/'))
               AND (?3 = 0 OR TRIM(COALESCE(cs.repo_path, '')) = '')
               AND (?4 IS NULL
                 OR CAST(strftime('%s', cs.updated_at) AS INTEGER) * 1000 >= ?4)
               AND (?5 IS NULL
                 OR CAST(strftime('%s', cs.updated_at) AS INTEGER) * 1000 < ?5)
               AND (?6 IS NULL
                 OR cs.updated_at < ?6
                 OR (cs.updated_at = ?6 AND cs.session_id < ?7))
             ORDER BY cs.updated_at DESC, cs.session_id DESC
             LIMIT ?8 OFFSET ?9",
        )
        .map_err(|err| format!("Failed to prepare scoped CLI page: {err}"))?;
    let session_ids = stmt
        .query_map(
            params![
                org_ids_json,
                repo_path,
                i64::from(missing_repo_path),
                updated_after_ms,
                updated_before_ms,
                before.map(|cursor| cursor.updated_at),
                before.map(|cursor| cursor.session_id),
                limit.min(i64::MAX as usize) as i64,
                if before.is_some() {
                    0
                } else {
                    offset.min(i64::MAX as usize) as i64
                },
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("Failed to query scoped CLI page: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read scoped CLI page: {err}"))?;

    session_ids
        .into_iter()
        .map(|session_id| {
            cli_session_persistence::get_session(&session_id)
                .map_err(|err| format!("Failed to hydrate CLI session {session_id}: {err}"))?
                .ok_or_else(|| format!("CLI session disappeared while listing: {session_id}"))
        })
        .collect()
}

pub(super) fn query_search_or_pinned_candidates(
    conn: &Connection,
    request: SearchOrPinnedRequest<'_>,
) -> Result<Vec<SidebarSessionCandidate>, String> {
    let SearchOrPinnedRequest {
        query,
        pinned_only,
        org_ids,
        include_external,
        disabled_sources,
        before,
        limit,
        offset,
    } = request;
    let search_pattern = escaped_like_pattern(query);
    if search_pattern.is_none() && !pinned_only {
        return Ok(Vec::new());
    }
    let org_ids_json = normalize_org_ids(org_ids)?;
    let disabled_sources_json = disabled_sources_json(disabled_sources)?;
    let sql = format!(
        "WITH candidates AS (
           SELECT s.session_id,
                  '{rust_source}' AS source,
                  COALESCE(CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000, 0)
                    AS updated_ms
           FROM agent_sessions s
           WHERE (s.parent_session_id IS NULL OR s.parent_session_id = '')
             AND s.status != 'archived'
             AND s.session_type IN ('{coding}', '{org_member}', '{desktop}', '{human}')
             AND (?1 IS NULL
               OR COALESCE(NULLIF(TRIM(s.org_id), ''), 'personal-org')
                  IN (SELECT value FROM json_each(?1)))
             AND (?2 IS NULL
               OR LOWER(COALESCE(s.name, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(s.user_input, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(s.workspace_path, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(s.model, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(s.worktree_branch, '')) LIKE ?2 ESCAPE '\\')
             AND (?3 = 0 OR COALESCE(s.pinned, 0) = 1)
           UNION ALL
           SELECT cs.session_id,
                  '{cli_source}' AS source,
                  COALESCE(CAST(strftime('%s', cs.updated_at) AS INTEGER) * 1000, 0)
                    AS updated_ms
           FROM code_sessions cs
           WHERE (cs.parent_session_id IS NULL OR cs.parent_session_id = '')
             AND (?1 IS NULL
               OR COALESCE(NULLIF(TRIM(cs.org_id), ''), 'personal-org')
                  IN (SELECT value FROM json_each(?1)))
             AND (?2 IS NULL
               OR LOWER(COALESCE(cs.name, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cs.user_input, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cs.repo_path, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cs.model, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cs.branch, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cs.cli_agent_type, '')) LIKE ?2 ESCAPE '\\')
             AND (?3 = 0 OR COALESCE(cs.pinned, 0) = 1)
           UNION ALL
           SELECT cache.session_id,
                  cache.source,
                  cache.updated_at_ms
           FROM imported_history_session_cache cache
           WHERE ?3 = 0
             AND ?4 = 1
             AND (?1 IS NULL
               OR EXISTS (
                 SELECT 1 FROM json_each(?1) WHERE value = 'personal-org'
               ))
             AND cache.listable = 1
             AND cache.parent_session_id = ''
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?5) disabled
               WHERE disabled.value = cache.source
             )
             AND (?2 IS NULL
               OR LOWER(COALESCE(cache.name, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cache.repo_path, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cache.model, '')) LIKE ?2 ESCAPE '\\'
               OR LOWER(COALESCE(cache.branch, '')) LIKE ?2 ESCAPE '\\')
         )
         SELECT session_id, source
         FROM candidates
         WHERE (?6 IS NULL
           OR updated_ms < COALESCE(CAST(strftime('%s', ?6) AS INTEGER) * 1000, 0)
           OR (
             updated_ms = COALESCE(CAST(strftime('%s', ?6) AS INTEGER) * 1000, 0)
             AND session_id < ?7
           ))
         ORDER BY updated_ms DESC, session_id DESC
         LIMIT ?8 OFFSET ?9",
        rust_source = SOURCE_ORGII_RUST_AGENTS,
        cli_source = SOURCE_ORGII_CLI_SESSIONS,
        coding = session_type::CODING,
        org_member = session_type::ORG_MEMBER,
        desktop = session_type::DESKTOP,
        human = session_type::HUMAN,
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare bounded sidebar search: {error}"))?;
    let rows = stmt
        .query_map(
            params![
                org_ids_json,
                search_pattern,
                i64::from(pinned_only),
                i64::from(include_external),
                disabled_sources_json,
                before.map(|cursor| cursor.updated_at),
                before.map(|cursor| cursor.session_id),
                limit.min(SIDEBAR_COMPACT_PAGE_LIMIT) as i64,
                if before.is_some() {
                    0
                } else {
                    offset.min(i64::MAX as usize) as i64
                },
            ],
            |row| {
                Ok(SidebarSessionCandidate {
                    session_id: row.get(0)?,
                    source: row.get(1)?,
                })
            },
        )
        .map_err(|error| format!("Failed to query bounded sidebar search: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read bounded sidebar search: {error}"))
}

pub(super) fn query_workspace_facets(
    conn: &Connection,
    query: WorkspaceFacetQuery<'_>,
) -> Result<Vec<WorkspaceFacetRow>, String> {
    let WorkspaceFacetQuery {
        org_ids,
        include_external,
        disabled_sources,
        before,
        limit,
        offset,
    } = query;
    let org_ids_json = normalize_org_ids(Some(org_ids))?
        .ok_or_else(|| "Workspace facets require an org scope".to_string())?;
    let disabled_sources_json = disabled_sources_json(disabled_sources)?;
    let sql = format!(
        "WITH source_rows AS (
           SELECT s.workspace_path AS workspace_path,
                  COALESCE(CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000, 0)
                    AS updated_ms
           FROM agent_sessions s
           WHERE (s.parent_session_id IS NULL OR s.parent_session_id = '')
             AND s.status != 'archived'
             AND COALESCE(s.pinned, 0) = 0
             AND s.session_type IN ('{coding}', '{org_member}', '{desktop}', '{human}')
             AND COALESCE(NULLIF(TRIM(s.org_id), ''), 'personal-org')
                 IN (SELECT value FROM json_each(?1))
           UNION ALL
           SELECT cs.repo_path,
                  COALESCE(CAST(strftime('%s', cs.updated_at) AS INTEGER) * 1000, 0)
                    AS updated_ms
           FROM code_sessions cs
           WHERE (cs.parent_session_id IS NULL OR cs.parent_session_id = '')
             AND COALESCE(cs.pinned, 0) = 0
             AND COALESCE(NULLIF(TRIM(cs.org_id), ''), 'personal-org')
                 IN (SELECT value FROM json_each(?1))
           UNION ALL
           SELECT cache.repo_path, cache.updated_at_ms
           FROM imported_history_session_cache cache
           WHERE ?2 = 1
             AND EXISTS (
               SELECT 1 FROM json_each(?1) WHERE value = 'personal-org'
             )
             AND cache.listable = 1
             AND cache.parent_session_id = ''
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?3) disabled
               WHERE disabled.value = cache.source
             )
         ),
         normalized AS (
           SELECT CASE
                    WHEN TRIM(COALESCE(workspace_path, '')) = '' THEN ''
                    WHEN RTRIM(TRIM(workspace_path), '/') = '' THEN '/'
                    ELSE RTRIM(TRIM(workspace_path), '/')
                  END AS workspace_key,
                  updated_ms
           FROM source_rows
         )
         SELECT workspace_key, MAX(updated_ms), COUNT(*)
         FROM normalized
         GROUP BY workspace_key
         HAVING (?4 IS NULL
           OR MAX(updated_ms) < ?4
           OR (MAX(updated_ms) = ?4 AND workspace_key > ?5))
         ORDER BY MAX(updated_ms) DESC, workspace_key ASC
         LIMIT ?6 OFFSET ?7",
        coding = session_type::CODING,
        org_member = session_type::ORG_MEMBER,
        desktop = session_type::DESKTOP,
        human = session_type::HUMAN,
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare sidebar workspace facets: {error}"))?;
    let rows = stmt
        .query_map(
            params![
                org_ids_json,
                i64::from(include_external),
                disabled_sources_json,
                before.map(|cursor| cursor.last_updated_at_ms),
                before.and_then(|cursor| cursor.repo_path).unwrap_or(""),
                limit.min(SIDEBAR_COMPACT_PAGE_LIMIT) as i64,
                if before.is_some() {
                    0
                } else {
                    offset.min(i64::MAX as usize) as i64
                },
            ],
            |row| {
                let path: String = row.get(0)?;
                Ok(WorkspaceFacetRow {
                    repo_path: if path.is_empty() { None } else { Some(path) },
                    last_updated_at_ms: row.get(1)?,
                    session_count: row.get::<_, i64>(2)?.max(0) as usize,
                })
            },
        )
        .map_err(|error| format!("Failed to query sidebar workspace facets: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read sidebar workspace facets: {error}"))
}

#[cfg(test)]
mod tests;
