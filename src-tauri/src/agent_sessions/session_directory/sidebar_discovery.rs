//! Bounded search and pinned-row hydration for the workstation sidebar.
//!
//! Candidate selection stays in compact SQL tables; only the bounded result
//! IDs are hydrated into the public aggregate record shape.

use crate::agent_sessions::cli::persistence as cli_session_persistence;
use agent_core::session::persistence::{self as session_persistence, session_type};
use database::db::get_connection;
use orgtrack_core::sources::imported_history::cache as imported_history_cache;

use super::agent_org_annotations::annotate_agent_org_root_rows;
use super::aggregation::apply_sorting;
use super::conversion::{
    cli_session_to_aggregate_record, human_session_to_aggregate_record,
    imported_history_to_aggregate_record, os_session_to_aggregate_record,
    sde_session_to_aggregate_record, AgentMetadataResolver,
};
use super::sidebar_queries::{
    self, SearchOrPinnedRequest, SidebarSeekCursor, SIDEBAR_COMPACT_PAGE_LIMIT,
};
use super::status::decorate_imported_live_status;
use super::types::{SessionFilter, SessionListResponse};

pub(super) fn bounded_search_or_pinned_page(
    filter: &SessionFilter,
) -> Result<Option<SessionListResponse>, String> {
    let has_query = filter
        .text_query
        .as_deref()
        .is_some_and(|query| !query.trim().is_empty());
    let pinned_only = filter.pinned_only == Some(true);
    if !has_query && !pinned_only {
        return Ok(None);
    }
    if filter.before_updated_at.is_some() != filter.before_session_id.is_some() {
        return Err("beforeUpdatedAt and beforeSessionId must be provided together".to_string());
    }
    if filter.category.is_some()
        || filter.session_ids.is_some()
        || filter.status.is_some()
        || filter.key_source.is_some()
        || filter.repo_path.is_some()
        || filter.repo_path_exact.is_some()
        || filter.missing_repo_path.is_some()
        || filter.org_id.is_some()
        || filter.project_slug.is_some()
        || filter.work_item_id.is_some()
        || filter.external_history_source.is_some()
        || filter.created_after_ms.is_some()
        || filter.created_before_ms.is_some()
        || filter.updated_after_ms.is_some()
        || filter.updated_before_ms.is_some()
        || filter.active_only == Some(true)
        || filter
            .sort_by
            .as_deref()
            .is_some_and(|value| value != "updated_at")
        || filter
            .sort_order
            .as_deref()
            .is_some_and(|value| value != "desc")
    {
        return Ok(None);
    }

    let conn = get_connection().map_err(|error| format!("Failed to open session DB: {error}"))?;
    let candidates = sidebar_queries::query_search_or_pinned_candidates(
        &conn,
        SearchOrPinnedRequest {
            query: filter.text_query.as_deref(),
            pinned_only,
            org_ids: filter.org_ids.as_deref(),
            include_external: filter.include_external_history.unwrap_or(true),
            disabled_sources: filter
                .disabled_external_history_sources
                .as_deref()
                .unwrap_or(&[]),
            before: filter
                .before_updated_at
                .as_deref()
                .zip(filter.before_session_id.as_deref())
                .map(|(updated_at, session_id)| SidebarSeekCursor {
                    updated_at,
                    session_id,
                }),
            limit: filter.limit.unwrap_or(SIDEBAR_COMPACT_PAGE_LIMIT),
            offset: filter.offset.unwrap_or(0),
        },
    )?;

    let mut resolver = AgentMetadataResolver::new();
    let mut sessions = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if candidate.source == orgtrack_core::canonical::SOURCE_ORGII_CLI_SESSIONS {
            let Some(session) = cli_session_persistence::get_session(&candidate.session_id)
                .map_err(|error| {
                    format!(
                        "Failed to hydrate bounded CLI sidebar row {}: {error}",
                        candidate.session_id
                    )
                })?
            else {
                continue;
            };
            sessions.push(cli_session_to_aggregate_record(session));
            continue;
        }
        if candidate.source == orgtrack_core::canonical::SOURCE_ORGII_RUST_AGENTS {
            let Some(session) =
                session_persistence::get_session(&candidate.session_id).map_err(|error| {
                    format!(
                        "Failed to hydrate bounded agent sidebar row {}: {error}",
                        candidate.session_id
                    )
                })?
            else {
                continue;
            };
            let record = match session.session_type.as_str() {
                value if value == session_type::DESKTOP => {
                    os_session_to_aggregate_record(session, &mut resolver)
                }
                value if value == session_type::HUMAN => human_session_to_aggregate_record(session),
                _ => sde_session_to_aggregate_record(session, &mut resolver),
            };
            sessions.push(record);
            continue;
        }

        let Some((source, cached)) =
            imported_history_cache::query_cached_session_by_session_id_from_conn(
                &conn,
                &candidate.session_id,
            )?
        else {
            continue;
        };
        if source != candidate.source {
            continue;
        }
        let mut record = imported_history_to_aggregate_record(cached.to_row(), &source);
        decorate_imported_live_status(std::slice::from_mut(&mut record));
        sessions.push(record);
    }
    annotate_agent_org_root_rows(&mut sessions)?;
    apply_sorting(&mut sessions, Some(filter));
    Ok(Some(SessionListResponse { sessions }))
}
