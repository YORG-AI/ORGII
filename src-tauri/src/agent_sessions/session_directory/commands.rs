//! Tauri commands for the cross-backend session directory.
//!
//! Provides the Tauri command endpoints that the frontend calls to list
//! sessions across all backends (command names keep their historical
//! `session_aggregate_*` wire ids for frontend compatibility).

use std::collections::HashSet;

use database::db::get_connection;
use orgtrack_core::sources::cursor_ide::history::CURSORIDE_SESSION_PREFIX;
use orgtrack_core::sources::imported_history::{
    cache::{query_imported_sidebar_scoped_page_from_conn, ImportedHistorySidebarPageQuery},
    metadata::{is_imported_history_source, SOURCE_CURSOR_IDE},
};

use super::aggregation::list_all_sessions;
use super::sidebar_queries::{
    query_workspace_facets, WorkspaceFacetQuery, WorkspaceFacetSeekCursor,
};
use super::types::{
    ExternalHistorySidebarBatchResponse, ExternalHistorySidebarBucketPage,
    ExternalHistorySidebarCursor, ExternalHistorySidebarResponse,
    ExternalHistorySidebarSourceRequest, SessionFilter, SessionListResponse, SessionWorkspaceFacet,
    SessionWorkspaceFacetRequest, SessionWorkspaceFacetResponse,
};

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get all sessions with statistics.
///
/// This replaces the frontend's parallel loading from 3 Tauri commands
/// (`osagent_list_sessions`, `sde_session_get_sessions`, `cli_agent_list`)
/// with a single session_aggregate_list command.
#[tauri::command]
pub async fn session_aggregate_list(
    filter: Option<SessionFilter>,
) -> Result<SessionListResponse, String> {
    tokio::task::spawn_blocking(move || list_all_sessions(filter.as_ref()))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

const EXTERNAL_HISTORY_SIDEBAR_BUCKET_MAX_LIMIT: usize = 50;

/// List lightweight external-history rows from ORGII's SQLite cache only.
/// The command never scans or opens an external provider's storage.
#[tauri::command]
pub async fn session_external_history_sidebar_list(
    requests: Vec<ExternalHistorySidebarSourceRequest>,
) -> Result<ExternalHistorySidebarBatchResponse, String> {
    tokio::task::spawn_blocking(move || {
        let conn =
            get_connection().map_err(|err| format!("Failed to open ORGII session cache: {err}"))?;
        let mut sources = Vec::with_capacity(requests.len());
        let mut seen_sources = HashSet::with_capacity(requests.len());
        for source_request in requests {
            let source = source_request.source;
            let repo_path = source_request.repo_path;
            let missing_repo_path = source_request.missing_repo_path;
            if !seen_sources.insert(source.clone()) {
                return Err("External history sidebar sources must be unique".to_string());
            }
            if !is_imported_history_source(&source) {
                return Err(format!("Unknown external history source: {source}"));
            }
            if repo_path.is_some() && missing_repo_path {
                return Err(
                    "External history sidebar scope cannot combine repoPath and missingRepoPath"
                        .to_string(),
                );
            }
            let mut pages = Vec::with_capacity(source_request.buckets.len());
            let mut seen_buckets = HashSet::with_capacity(source_request.buckets.len());
            for request in source_request.buckets {
                if !seen_buckets.insert(request.bucket) {
                    return Err("External history sidebar buckets must be unique".to_string());
                }
                if request.limit == 0 {
                    return Err(
                        "External history sidebar bucket limit must be positive".to_string()
                    );
                }
                if request
                    .start_ms
                    .zip(request.end_ms)
                    .is_some_and(|(start, end)| start >= end)
                {
                    return Err(
                        "External history sidebar bucket start must precede end".to_string()
                    );
                }
                let limit = request.limit.min(EXTERNAL_HISTORY_SIDEBAR_BUCKET_MAX_LIMIT);
                let mut page = query_imported_sidebar_scoped_page_from_conn(
                    &conn,
                    ImportedHistorySidebarPageQuery {
                        source: &source,
                        start_ms: request.start_ms,
                        end_ms: request.end_ms,
                        repo_path: repo_path.as_deref(),
                        missing_repo_path,
                        before_updated_at_ms: request
                            .before
                            .as_ref()
                            .map(|cursor| cursor.updated_at_ms),
                        before_session_id: request
                            .before
                            .as_ref()
                            .map(|cursor| cursor.session_id.as_str()),
                        limit,
                        offset: request.offset,
                    },
                )?;
                let next_cursor =
                    page.next_cursor
                        .as_ref()
                        .map(|cursor| ExternalHistorySidebarCursor {
                            updated_at_ms: cursor.updated_at_ms,
                            session_id: cursor.session_id.clone(),
                        });
                if source == SOURCE_CURSOR_IDE {
                    for session in &mut page.sessions {
                        if !session.session_id.starts_with(CURSORIDE_SESSION_PREFIX) {
                            session.session_id =
                                format!("{CURSORIDE_SESSION_PREFIX}{}", session.session_id);
                        }
                    }
                }
                // Live status decoration happens at this desktop boundary
                // (not in the core query): hook-derived state first, then
                // the transcript-recency fallback for hook-less CLIs.
                for session in &mut page.sessions {
                    if let Some((status, is_active)) =
                        crate::orgtrack::agent_live_status::live_status_for_imported_row(
                            &session.session_id,
                            &session.updated_at,
                        )
                    {
                        session.status = Some(status.to_string());
                        session.is_active = Some(is_active);
                    }
                }
                pages.push(ExternalHistorySidebarBucketPage {
                    bucket: request.bucket,
                    sessions: page.sessions,
                    has_more: page.has_more,
                    next_cursor,
                });
            }
            sources.push(ExternalHistorySidebarResponse {
                source,
                buckets: pages,
            });
        }
        Ok(ExternalHistorySidebarBatchResponse { sources })
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Discover bounded workspace groups without hydrating session transcripts.
#[tauri::command]
pub async fn session_sidebar_workspace_facets(
    request: SessionWorkspaceFacetRequest,
) -> Result<SessionWorkspaceFacetResponse, String> {
    tokio::task::spawn_blocking(move || {
        if request.org_ids.iter().all(|value| value.trim().is_empty()) {
            return Err("Workspace facets require at least one org id".to_string());
        }
        if request.limit == 0 {
            return Err("Workspace facet limit must be positive".to_string());
        }
        let page_limit = request.limit.min(50);
        let conn = get_connection()
            .map_err(|error| format!("Failed to open ORGII session cache: {error}"))?;
        let mut rows = query_workspace_facets(
            &conn,
            WorkspaceFacetQuery {
                org_ids: &request.org_ids,
                include_external: request.include_external_history,
                disabled_sources: &request.disabled_external_history_sources,
                before: request
                    .before
                    .as_ref()
                    .map(|cursor| WorkspaceFacetSeekCursor {
                        last_updated_at_ms: cursor.last_updated_at_ms,
                        repo_path: cursor.repo_path.as_deref(),
                    }),
                limit: page_limit.saturating_add(1),
                offset: request.offset,
            },
        )?;
        let has_more = rows.len() > page_limit;
        rows.truncate(page_limit);
        Ok(SessionWorkspaceFacetResponse {
            facets: rows
                .into_iter()
                .map(|row| SessionWorkspaceFacet {
                    repo_path: row.repo_path,
                    last_updated_at_ms: row.last_updated_at_ms,
                    session_count: row.session_count,
                })
                .collect(),
            has_more,
        })
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?
}
