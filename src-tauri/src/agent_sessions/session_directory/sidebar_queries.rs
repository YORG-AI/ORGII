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
mod tests {
    use super::*;
    use crate::test_utils::test_env;
    use core_types::key_source::KeySource;
    use orgtrack_core::sources::imported_history::{
        cache::upsert_imported_session_cache_from_conn,
        metadata::{
            ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_CODEX_APP,
            SOURCE_OPENCODE,
        },
    };

    fn seed_native(
        session_id: &str,
        name: &str,
        updated_at: &str,
        org_id: Option<&str>,
        workspace_path: Option<&str>,
        pinned: bool,
    ) {
        session_persistence::upsert_session(&session_persistence::UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: name.to_string(),
            status: agent_core::session::SessionStatus::Completed
                .as_str()
                .to_string(),
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            session_type: session_type::CODING.to_string(),
            org_id: org_id.map(str::to_string),
            workspace_path: workspace_path.map(str::to_string),
            pinned,
            key_source: KeySource::OwnKey,
            ..Default::default()
        })
        .expect("seed native sidebar discovery row");
    }

    fn seed_cli(session_id: &str, updated_at: &str) {
        let conn = get_connection().expect("open sandbox DB");
        conn.execute(
            "INSERT INTO code_sessions
                 (session_id, name, status, flow, runner, cli_agent_type,
                  created_at, updated_at)
             VALUES (?1, ?1, 'completed', 'quick', 'local', 'opencode', ?2, ?2)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at",
            params![session_id, updated_at],
        )
        .expect("seed managed CLI sidebar row");
    }

    fn imported_input(
        source: &'static str,
        source_session_id: &str,
        name: &str,
        updated_at_ms: i64,
        repo_path: Option<&str>,
    ) -> ImportedHistoryCacheInput {
        ImportedHistoryCacheInput {
            source,
            source_session_id: source_session_id.to_string(),
            session_id: format!("{source}-{source_session_id}"),
            source_path: format!("/tmp/{source_session_id}.jsonl"),
            source_record_key: source_session_id.to_string(),
            source_mtime_ms: updated_at_ms,
            source_size_bytes: 1,
            source_fingerprint: format!("fingerprint-{source_session_id}"),
            parser_version: 1,
            name: name.to_string(),
            created_at_ms: updated_at_ms,
            updated_at_ms,
            model: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            repo_path: repo_path.map(str::to_string),
            branch: None,
            impact: ImportedHistoryImpactStats::default(),
            listable: true,
            source_metadata_json: None,
            parent_session_id: None,
        }
    }

    fn candidate_ids(rows: Vec<SidebarSessionCandidate>) -> Vec<String> {
        rows.into_iter().map(|row| row.session_id).collect()
    }

    #[test]
    fn org_scope_normalizes_personal_and_accepts_cloud_aliases() {
        let _sandbox = test_env::sandbox();
        for (session_id, org_id) in [
            ("personal-null", None),
            ("personal-empty", Some("")),
            ("personal-explicit", Some(PERSONAL_ORG_ID)),
            ("cloud-namespaced", Some("cloud:alpha")),
            ("cloud-bare", Some("alpha")),
            ("cloud-other", Some("beta")),
        ] {
            seed_native(
                session_id,
                "scope needle",
                "2026-07-26T12:00:00Z",
                org_id,
                Some("/repo"),
                false,
            );
        }
        let conn = get_connection().expect("open sandbox DB");
        let query = |org_ids: Vec<String>| {
            candidate_ids(
                query_search_or_pinned_candidates(
                    &conn,
                    SearchOrPinnedRequest {
                        query: Some("scope needle"),
                        pinned_only: false,
                        org_ids: Some(&org_ids),
                        include_external: false,
                        disabled_sources: &[],
                        before: None,
                        limit: 50,
                        offset: 0,
                    },
                )
                .expect("query scoped search"),
            )
        };

        let personal = query(vec![PERSONAL_ORG_ID.to_string()]);
        assert_eq!(
            personal.into_iter().collect::<BTreeSet<_>>(),
            [
                "personal-null".to_string(),
                "personal-empty".to_string(),
                "personal-explicit".to_string()
            ]
            .into_iter()
            .collect()
        );
        let cloud = query(vec!["cloud:alpha".to_string(), "alpha".to_string()]);
        assert_eq!(
            cloud.into_iter().collect::<BTreeSet<_>>(),
            ["cloud-namespaced".to_string(), "cloud-bare".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn search_and_pinned_predicates_run_before_the_page_limit() {
        let _sandbox = test_env::sandbox();
        for index in 0..60 {
            seed_native(
                &format!("newer-{index:02}"),
                "ordinary newer row",
                &format!("2026-07-26T12:{index:02}:00Z"),
                None,
                Some("/new"),
                false,
            );
        }
        seed_native(
            "old-unique-search",
            "uniquely searchable historical row",
            "2026-07-01T00:00:00Z",
            None,
            Some("/old"),
            false,
        );
        seed_native(
            "old-pinned",
            "old pinned row",
            "2026-06-03T00:00:00Z",
            None,
            Some("/old"),
            true,
        );
        seed_native(
            "older-pinned",
            "older pinned row",
            "2026-06-02T00:00:00Z",
            None,
            Some("/old"),
            true,
        );
        seed_native(
            "oldest-pinned",
            "oldest pinned row",
            "2026-06-01T00:00:00Z",
            None,
            Some("/old"),
            true,
        );
        let conn = get_connection().expect("open sandbox DB");
        let personal = vec![PERSONAL_ORG_ID.to_string()];

        let search = query_search_or_pinned_candidates(
            &conn,
            SearchOrPinnedRequest {
                query: Some("uniquely searchable"),
                pinned_only: false,
                org_ids: Some(&personal),
                include_external: false,
                disabled_sources: &[],
                before: None,
                limit: 50,
                offset: 0,
            },
        )
        .expect("search old row");
        assert_eq!(candidate_ids(search), vec!["old-unique-search"]);

        let pinned = query_search_or_pinned_candidates(
            &conn,
            SearchOrPinnedRequest {
                query: None,
                pinned_only: true,
                org_ids: Some(&personal),
                include_external: true,
                disabled_sources: &[],
                before: None,
                limit: 2,
                offset: 0,
            },
        )
        .expect("query old pinned row");
        assert_eq!(candidate_ids(pinned), vec!["old-pinned", "older-pinned"]);
        seed_native(
            "new-pinned",
            "new pinned row",
            "2026-07-27T00:00:00Z",
            None,
            Some("/new"),
            true,
        );
        let pinned_tail = query_search_or_pinned_candidates(
            &conn,
            SearchOrPinnedRequest {
                query: None,
                pinned_only: true,
                org_ids: Some(&personal),
                include_external: false,
                disabled_sources: &[],
                before: Some(SidebarSeekCursor {
                    updated_at: "2026-06-02T00:00:00Z",
                    session_id: "older-pinned",
                }),
                limit: 50,
                offset: 2,
            },
        )
        .expect("query stable pinned tail");
        assert_eq!(candidate_ids(pinned_tail), vec!["oldest-pinned"]);
    }

    #[test]
    fn native_and_cli_seek_pages_ignore_newer_mutations_without_skipping_static_rows() {
        let _sandbox = test_env::sandbox();
        for (session_id, updated_at) in [
            ("sdeagent-four", "2026-07-26T04:00:00Z"),
            ("sdeagent-three", "2026-07-26T03:00:00Z"),
            ("sdeagent-two", "2026-07-26T02:00:00Z"),
            ("sdeagent-one", "2026-07-26T01:00:00Z"),
        ] {
            seed_native(session_id, session_id, updated_at, None, None, false);
        }
        let first = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: None,
            limit: 2,
            offset: 0,
        })
        .expect("first native seek page");
        assert_eq!(
            first
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            ["sdeagent-four", "sdeagent-three"]
        );
        let cursor_updated_at = first[1].updated_at.clone();
        let cursor_session_id = first[1].session_id.clone();

        // A new top row and an already-consumed row moving to the top cannot
        // shift a descending seek boundary or make page two repeat them.
        seed_native(
            "sdeagent-new",
            "new",
            "2026-07-26T06:00:00Z",
            None,
            None,
            false,
        );
        seed_native(
            "sdeagent-four",
            "four",
            "2026-07-26T05:00:00Z",
            None,
            None,
            false,
        );
        let second = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: Some(SidebarSeekCursor {
                updated_at: &cursor_updated_at,
                session_id: &cursor_session_id,
            }),
            limit: 2,
            // A cursor must win over a stale compatibility offset.
            offset: 99,
        })
        .expect("second native seek page");
        assert_eq!(
            second
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            ["sdeagent-two", "sdeagent-one"]
        );

        for (session_id, updated_at) in [
            ("cliagent-four", "2026-07-26T04:00:00Z"),
            ("cliagent-three", "2026-07-26T03:00:00Z"),
            ("cliagent-two", "2026-07-26T02:00:00Z"),
            ("cliagent-one", "2026-07-26T01:00:00Z"),
        ] {
            seed_cli(session_id, updated_at);
        }
        let first_cli = load_scoped_cli_page(CliPageRequest {
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: None,
            limit: 2,
            offset: 0,
        })
        .expect("first CLI seek page");
        let cli_cursor_updated_at = first_cli[1].updated_at.clone();
        let cli_cursor_session_id = first_cli[1].session_id.clone();
        seed_cli("cliagent-new", "2026-07-26T06:00:00Z");
        seed_cli("cliagent-four", "2026-07-26T05:00:00Z");
        let second_cli = load_scoped_cli_page(CliPageRequest {
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: Some(SidebarSeekCursor {
                updated_at: &cli_cursor_updated_at,
                session_id: &cli_cursor_session_id,
            }),
            limit: 2,
            offset: 99,
        })
        .expect("second CLI seek page");
        assert_eq!(
            second_cli
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            ["cliagent-two", "cliagent-one"]
        );
    }

    #[test]
    fn refreshed_first_page_surfaces_an_unconsumed_row_that_moves_above_the_cursor() {
        let _sandbox = test_env::sandbox();
        for (session_id, updated_at) in [
            ("sdeagent-three", "2026-07-26T03:00:00Z"),
            ("sdeagent-two", "2026-07-26T02:00:00Z"),
            ("sdeagent-one", "2026-07-26T01:00:00Z"),
        ] {
            seed_native(session_id, session_id, updated_at, None, None, false);
        }
        let first = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: None,
            limit: 1,
            offset: 0,
        })
        .expect("first page");
        let cursor_updated_at = first[0].updated_at.clone();
        let cursor_session_id = first[0].session_id.clone();

        // Keyset pagination is a stable walk of the old tail. A row that was
        // not consumed and then becomes newer than the cursor belongs to the
        // live/refresh head, not to the old-tail continuation.
        seed_native(
            "sdeagent-two",
            "two moved",
            "2026-07-26T04:00:00Z",
            None,
            None,
            false,
        );
        let tail = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: Some(SidebarSeekCursor {
                updated_at: &cursor_updated_at,
                session_id: &cursor_session_id,
            }),
            limit: 10,
            offset: 0,
        })
        .expect("stable old tail");
        assert_eq!(
            tail.iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            ["sdeagent-one"]
        );
        let refreshed = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: None,
            missing_repo_path: false,
            updated_after_ms: None,
            updated_before_ms: None,
            before: None,
            limit: 1,
            offset: 0,
        })
        .expect("refreshed head");
        assert_eq!(refreshed[0].session_id, "sdeagent-two");
    }

    #[test]
    fn workspace_facets_include_old_only_and_no_workspace_groups() {
        let _sandbox = test_env::sandbox();
        seed_native(
            "new-main",
            "new main",
            "2026-07-26T12:00:00Z",
            None,
            Some("/repo/main"),
            false,
        );
        seed_native(
            "old-only",
            "old only",
            "2026-06-01T00:00:00Z",
            None,
            Some("/repo/old-only/"),
            false,
        );
        seed_native(
            "no-workspace",
            "no workspace",
            "2026-05-01T00:00:00Z",
            None,
            None,
            false,
        );
        seed_native(
            "pinned-only-workspace",
            "pinned only workspace",
            "2026-04-01T00:00:00Z",
            None,
            Some("/repo/pinned-only"),
            true,
        );
        let conn = get_connection().expect("open sandbox DB");
        let personal = vec![PERSONAL_ORG_ID.to_string()];
        let first = query_workspace_facets(
            &conn,
            WorkspaceFacetQuery {
                org_ids: &personal,
                include_external: false,
                disabled_sources: &[],
                before: None,
                limit: 2,
                offset: 0,
            },
        )
        .expect("query workspace facets");
        assert_eq!(
            first
                .iter()
                .map(|facet| facet.repo_path.as_deref())
                .collect::<Vec<_>>(),
            [Some("/repo/main"), Some("/repo/old-only")]
        );
        seed_native(
            "new-workspace",
            "new workspace",
            "2026-07-27T00:00:00Z",
            None,
            Some("/repo/new"),
            false,
        );
        let tail = query_workspace_facets(
            &conn,
            WorkspaceFacetQuery {
                org_ids: &personal,
                include_external: false,
                disabled_sources: &[],
                before: Some(WorkspaceFacetSeekCursor {
                    last_updated_at_ms: first[1].last_updated_at_ms,
                    repo_path: first[1].repo_path.as_deref(),
                }),
                limit: 50,
                offset: 2,
            },
        )
        .expect("query stable workspace tail");
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].repo_path, None);
        assert!(
            first
                .iter()
                .chain(tail.iter())
                .all(|facet| facet.repo_path.as_deref() != Some("/repo/pinned-only")),
            "a workspace represented only by pinned rows belongs in Pinned, not an empty section"
        );
    }

    #[test]
    fn imported_discovery_is_personal_listable_and_source_gated() {
        let _sandbox = test_env::sandbox();
        let mut conn = get_connection().expect("open sandbox DB");
        let mut hidden = imported_input(
            SOURCE_CODEX_APP,
            "hidden",
            "imported needle hidden",
            300,
            Some("/hidden"),
        );
        hidden.listable = false;
        let mut child = imported_input(
            SOURCE_CODEX_APP,
            "child",
            "imported needle child",
            250,
            Some("/child"),
        );
        child.parent_session_id = Some("codex_app-root".to_string());
        upsert_imported_session_cache_from_conn(
            &mut conn,
            &[
                imported_input(
                    SOURCE_CODEX_APP,
                    "visible",
                    "imported needle visible",
                    200,
                    Some("/visible"),
                ),
                imported_input(
                    SOURCE_OPENCODE,
                    "disabled",
                    "imported needle disabled",
                    100,
                    Some("/disabled"),
                ),
                hidden,
                child,
            ],
        )
        .expect("seed imported sidebar rows");

        let personal = vec![PERSONAL_ORG_ID.to_string()];
        let disabled = vec![SOURCE_OPENCODE.to_string()];
        let rows = query_search_or_pinned_candidates(
            &conn,
            SearchOrPinnedRequest {
                query: Some("imported needle"),
                pinned_only: false,
                org_ids: Some(&personal),
                include_external: true,
                disabled_sources: &disabled,
                before: None,
                limit: 50,
                offset: 0,
            },
        )
        .expect("query imported discovery");
        assert_eq!(candidate_ids(rows), vec!["codex_app-visible"]);

        let cloud = vec!["cloud:alpha".to_string(), "alpha".to_string()];
        let rows = query_search_or_pinned_candidates(
            &conn,
            SearchOrPinnedRequest {
                query: Some("imported needle"),
                pinned_only: false,
                org_ids: Some(&cloud),
                include_external: true,
                disabled_sources: &[],
                before: None,
                limit: 50,
                offset: 0,
            },
        )
        .expect("query cloud imported discovery");
        assert!(rows.is_empty());
    }
}
