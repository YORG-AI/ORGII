//! Tauri commands for the cross-backend session directory.
//!
//! Provides the Tauri command endpoints that the frontend calls to list
//! sessions across all backends (command names keep their historical
//! `session_aggregate_*` wire ids for frontend compatibility).

use std::collections::HashSet;

use database::db::get_connection;
use orgtrack_core::sources::cursor_ide::history::CURSORIDE_SESSION_PREFIX;
use orgtrack_core::sources::imported_history::{
    cache::query_imported_sidebar_page_from_conn,
    metadata::{is_imported_history_source, SOURCE_CURSOR_IDE},
};

use super::aggregation::list_all_sessions;
use super::types::{
    ExternalHistorySidebarBatchResponse, ExternalHistorySidebarBucketPage,
    ExternalHistorySidebarResponse, ExternalHistorySidebarSourceRequest, SessionFilter,
    SessionListResponse,
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
            if !seen_sources.insert(source.clone()) {
                return Err("External history sidebar sources must be unique".to_string());
            }
            if !is_imported_history_source(&source) {
                return Err(format!("Unknown external history source: {source}"));
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
                let mut page = query_imported_sidebar_page_from_conn(
                    &conn,
                    &source,
                    request.start_ms,
                    request.end_ms,
                    limit,
                    request.offset,
                )?;
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
