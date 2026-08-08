//! Tauri commands for the cross-backend session directory.
//!
//! Provides the Tauri command endpoints that the frontend calls to list
//! sessions across all backends (command names keep their historical
//! `session_aggregate_*` wire ids for frontend compatibility).

use std::collections::HashSet;

use database::db::get_connection;
use orgtrack_core::sources::cursor_ide::history::CURSORIDE_SESSION_PREFIX;
use orgtrack_core::sources::imported_history::{
    cache as imported_cache,
    cache::query_imported_sidebar_page_from_conn,
    metadata::{is_imported_history_source, SOURCE_CURSOR_IDE},
};

use super::aggregation::{list_all_sessions, list_native_sidebar_sessions};
use super::types::{
    ExternalHistorySidebarBatchResponse, ExternalHistorySidebarBucketPage,
    ExternalHistorySidebarResponse, ExternalHistorySidebarSourceRequest,
    NativeSidebarSessionCursor, NativeSidebarSessionPageResponse, NativeSidebarSessionStream,
    SessionFilter, SessionListResponse,
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

/// List one independent native sidebar stream. Unlike the legacy aggregate
/// category page, stream membership is resolved before SQL pagination.
#[tauri::command]
pub async fn session_native_sidebar_page(
    stream: NativeSidebarSessionStream,
    cursor: Option<NativeSidebarSessionCursor>,
    limit: usize,
) -> Result<NativeSidebarSessionPageResponse, String> {
    tokio::task::spawn_blocking(move || {
        list_native_sidebar_sessions(stream, cursor.as_ref(), limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
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
        // One read for the whole batch: pins are a small ORGII-owned set, and
        // a per-row lookup would turn a page render into N queries.
        let pinned_ids = imported_cache::pinned_imported_session_ids_from_conn(&conn)?;
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
            let mut source_error: Option<String> = None;
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
                // One provider's unreadable store must not decide whether the
                // others are visible: this batch is the sidebar's only source
                // of imported rows, so propagating here retired every source's
                // rows at once. Contract violations above stay hard errors —
                // those are caller bugs, not a provider's disk.
                let mut page = match query_imported_sidebar_page_from_conn(
                    &conn,
                    &source,
                    request.start_ms,
                    request.end_ms,
                    limit,
                    request.offset,
                ) {
                    Ok(page) => page,
                    Err(err) => {
                        tracing::warn!(
                            source = %source,
                            bucket = ?request.bucket,
                            error = %err,
                            "external history sidebar: skipping source whose store failed to read"
                        );
                        source_error = Some(err);
                        break;
                    }
                };
                if source == SOURCE_CURSOR_IDE {
                    for session in &mut page.sessions {
                        if !session.session_id.starts_with(CURSORIDE_SESSION_PREFIX) {
                            session.session_id =
                                format!("{CURSORIDE_SESSION_PREFIX}{}", session.session_id);
                        }
                    }
                }
                for session in &mut page.sessions {
                    session.pinned = pinned_ids.contains(&session.session_id);
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
                buckets: if source_error.is_some() {
                    Vec::new()
                } else {
                    pages
                },
                error: source_error,
            });
        }
        Ok(ExternalHistorySidebarBatchResponse { sources })
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
