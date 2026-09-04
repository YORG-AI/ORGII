//! SQL-paginated fast paths that bypass the full merge.
//!
//! `plain_native_page` serves the sidebar's per-category page straight from the
//! owning source table; `plain_directory_page` serves the flat (no-category)
//! page from one indexed `orgtrack_core_sessions` window.

use std::collections::HashSet;

use agent_core::session::persistence::{self as session_persistence, session_type};
use database::db::get_connection;
use orgtrack_core::sources::imported_history::cache as imported_history_cache;

use super::agent_org::annotate_agent_org_root_rows;
use super::external_history::EXTERNAL_HISTORY_SOURCE_LOADERS;
use super::sorting::apply_sorting;
use crate::agent_sessions::cli::persistence as cli_session_persistence;
use crate::agent_sessions::session_directory::conversion::{
    cli_session_to_aggregate_record, human_session_to_aggregate_record,
    imported_history_to_aggregate_record, os_session_to_aggregate_record,
    sde_session_to_aggregate_record, AgentMetadataResolver,
};
use crate::agent_sessions::session_directory::types::{
    SessionAggregateRecord, SessionFilter, SessionListResponse,
};

// ============================================================================
// Core Aggregation
// ============================================================================

/// Load sessions from the requested sources and compute statistics.
/// SQL-paginated fast path for the sidebar's per-category page shape.
///
/// The hot sidebar refresh asks for exactly one native category ordered by
/// `updated_at DESC` with a limit/offset and external history excluded
/// (`fetchAggregatePage` in the frontend). For that shape the page can come
/// straight from the source table with a SQL `LIMIT`, instead of loading
/// every row from every store and slicing in memory. Any other filter shape
/// returns `None` and takes the full merge path below.
///
/// The filter is destructured exhaustively on purpose: adding a field to
/// `SessionFilter` must fail compilation here so the new field's fast-path
/// semantics are decided explicitly.
pub(super) fn plain_native_page(
    filter: Option<&SessionFilter>,
) -> Result<Option<SessionListResponse>, String> {
    let Some(filter) = filter else {
        return Ok(None);
    };
    let SessionFilter {
        session_ids,
        category,
        status,
        key_source,
        repo_path,
        org_id,
        project_slug,
        work_item_id,
        limit,
        offset,
        text_query,
        sort_by,
        sort_order,
        include_external_history,
        external_history_source,
        disabled_external_history_sources: _,
        created_after_ms,
        created_before_ms,
        active_only,
        // Only meaningful with session_ids, and plain requires session_ids
        // to be absent, so the flag cannot affect the fast path.
        include_continuation_superseded: _,
    } = filter;

    let plain = session_ids.is_none()
        && status.is_none()
        && key_source.is_none()
        && repo_path.is_none()
        && org_id.is_none()
        && project_slug.is_none()
        && work_item_id.is_none()
        && text_query.is_none()
        && external_history_source.is_none()
        && created_after_ms.is_none()
        && created_before_ms.is_none()
        && active_only.is_none_or(|active| !active)
        && sort_by.as_deref().is_none_or(|key| key == "updated_at")
        && sort_order.as_deref().is_none_or(|order| order == "desc");
    if !plain {
        return Ok(None);
    }

    let limit = limit.unwrap_or(usize::MAX);
    let offset = offset.unwrap_or(0);

    // The single-category pages read one source table directly, which is
    // only equivalent to the merge path when imported history is excluded.
    // The flat (no-category) page handles external rows itself.
    if category.is_some() && *include_external_history != Some(false) {
        return Ok(None);
    }

    let mut sessions = match category.as_deref() {
        Some("cli") => {
            let page = cli_session_persistence::list_sessions_page(limit, offset)
                .map_err(|err| format!("Failed to load CLI session page: {}", err))?;
            page.into_iter()
                .map(cli_session_to_aggregate_record)
                .collect::<Vec<_>>()
        }
        Some("agent") => {
            let sde_filter = agent_core::session::SessionListFilter {
                type_names: Some(vec![
                    session_type::CODING.to_string(),
                    session_type::ORG_MEMBER.to_string(),
                ]),
                limit: Some(limit),
                offset: Some(offset),
                ..Default::default()
            };
            let page = session_persistence::list_sessions(&sde_filter)
                .map_err(|err| format!("Failed to load agent session page: {}", err))?;
            let mut resolver = AgentMetadataResolver::new();
            let mut rows = page
                .into_iter()
                .map(|session| sde_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>();
            annotate_agent_org_root_rows(&mut rows)?;
            rows
        }
        Some("os") => {
            let os_filter = agent_core::session::SessionListFilter {
                type_name: Some(session_type::DESKTOP.to_string()),
                limit: Some(limit),
                offset: Some(offset),
                ..Default::default()
            };
            let page = session_persistence::list_sessions(&os_filter)
                .map_err(|err| format!("Failed to load OS session page: {}", err))?;
            let mut resolver = AgentMetadataResolver::new();
            page.into_iter()
                .map(|session| os_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>()
        }
        Some("human") => {
            let human_filter = agent_core::session::SessionListFilter {
                type_name: Some(session_type::HUMAN.to_string()),
                limit: Some(limit),
                offset: Some(offset),
                ..Default::default()
            };
            session_persistence::list_sessions(&human_filter)
                .map_err(|err| format!("Failed to load Human session page: {err}"))?
                .into_iter()
                .map(human_session_to_aggregate_record)
                .collect::<Vec<_>>()
        }
        None => return plain_directory_page(filter, limit, offset),
        _ => return Ok(None),
    };

    // The source queries already order by `updated_at DESC`; re-sorting via
    // the shared path keeps tie-break behavior identical to the merge path.
    apply_sorting(&mut sessions, Some(filter));
    Ok(Some(SessionListResponse { sessions }))
}

/// Directory page over `orgtrack_core_sessions` for the plain flat-list
/// shape (no category restriction): one indexed SQL page across every
/// source instead of loading each store in full and merging.
///
/// Rows are hydrated from their owning store; rows the merge path would
/// never surface (gateway/subagent sessions, rows whose session was
/// deleted mid-read) are skipped and refilled from the next SQL page, so
/// the returned page stays full. With a non-zero `offset` those skips can
/// shift page boundaries slightly; the flat list's callers paginate from
/// offset 0 (per-category pagination has its own exact fast path above).
///
/// Pure read: no source rescan is triggered — freshness comes from the
/// startup scan, watcher-driven rescans, and write-path mirrors, exactly
/// like the cache-only external sidebar batch command.
fn plain_directory_page(
    filter: &SessionFilter,
    limit: usize,
    offset: usize,
) -> Result<Option<SessionListResponse>, String> {
    // Unbounded hydration would defeat the point; require a bounded page.
    if limit == usize::MAX {
        return Ok(None);
    }
    let include_external = filter.include_external_history.unwrap_or(true);
    let disabled_sources: HashSet<&str> = filter
        .disabled_external_history_sources
        .as_ref()
        .map(|sources| sources.iter().map(String::as_str).collect())
        .unwrap_or_default();

    let mut sources: Vec<&str> = vec![
        orgtrack_core::canonical::SOURCE_ORGII_CLI_SESSIONS,
        orgtrack_core::canonical::SOURCE_ORGII_RUST_AGENTS,
    ];
    if include_external {
        sources.extend(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .map(|loader| loader.source)
                .filter(|source| !disabled_sources.contains(source)),
        );
    }

    let conn = get_connection().map_err(|err| format!("Failed to open session DB: {err}"))?;
    let placeholders = (1..=sources.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT session_id, source FROM orgtrack_core_sessions
         WHERE source IN ({placeholders})
         ORDER BY updated_at DESC LIMIT ?{limit_idx} OFFSET ?{offset_idx}",
        limit_idx = sources.len() + 1,
        offset_idx = sources.len() + 2,
    );

    let mut resolver = AgentMetadataResolver::new();
    let mut sessions: Vec<SessionAggregateRecord> = Vec::with_capacity(limit);
    let mut page_offset = offset;
    // Fill loop: hydrate SQL pages until the requested page is full or the
    // directory runs out of rows. Over-fetches one row per round so "page
    // shorter than asked" reliably means exhaustion.
    while sessions.len() < limit {
        let batch = limit - sessions.len() + 1;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = sources
            .iter()
            .map(|source| Box::new(source.to_string()) as Box<dyn rusqlite::ToSql>)
            .collect();
        params.push(Box::new(batch.min(i64::MAX as usize) as i64));
        params.push(Box::new(page_offset.min(i64::MAX as usize) as i64));
        let param_refs: Vec<&dyn rusqlite::ToSql> =
            params.iter().map(|param| param.as_ref()).collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("directory page prepare: {err}"))?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("directory page query: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("directory page rows: {err}"))?;
        let fetched = rows.len();

        for (session_id, source) in rows {
            if sessions.len() >= limit {
                break;
            }
            match source.as_str() {
                s if s == orgtrack_core::canonical::SOURCE_ORGII_CLI_SESSIONS => {
                    if let Some(session) = cli_session_persistence::get_session(&session_id)
                        .map_err(|err| format!("hydrate cli session: {err}"))?
                    {
                        sessions.push(cli_session_to_aggregate_record(session));
                    }
                }
                s if s == orgtrack_core::canonical::SOURCE_ORGII_RUST_AGENTS => {
                    let Some(record) = session_persistence::get_session(&session_id)
                        .map_err(|err| format!("hydrate agent session: {err}"))?
                    else {
                        continue;
                    };
                    match record.session_type.as_str() {
                        t if t == session_type::CODING || t == session_type::ORG_MEMBER => {
                            sessions.push(sde_session_to_aggregate_record(record, &mut resolver));
                        }
                        t if t == session_type::DESKTOP => {
                            sessions.push(os_session_to_aggregate_record(record, &mut resolver));
                        }
                        t if t == session_type::HUMAN => {
                            sessions.push(human_session_to_aggregate_record(record));
                        }
                        // Gateway/subagent/custom sessions are infrastructure
                        // the merge path never lists either.
                        _ => continue,
                    }
                }
                _ => {
                    if let Some((cached_source, session)) =
                        imported_history_cache::query_cached_session_by_session_id_from_conn(
                            &conn,
                            &session_id,
                        )?
                    {
                        sessions.push(imported_history_to_aggregate_record(
                            session.to_row(),
                            &cached_source,
                        ));
                    }
                }
            }
        }

        if fetched < batch {
            break; // directory exhausted
        }
        page_offset += fetched;
    }

    annotate_agent_org_root_rows(&mut sessions)?;
    apply_sorting(&mut sessions, Some(filter));
    Ok(Some(SessionListResponse { sessions }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_page_filter() -> SessionFilter {
        SessionFilter {
            category: Some("cli".to_string()),
            include_external_history: Some(false),
            limit: Some(20),
            offset: Some(0),
            sort_by: Some("updated_at".to_string()),
            sort_order: Some("desc".to_string()),
            ..SessionFilter::default()
        }
    }

    #[test]
    fn plain_native_page_rejects_non_plain_filters() {
        // Missing filter entirely, or any shape the SQL page can't express,
        // must fall through to the merge path (Ok(None)).
        assert!(plain_native_page(None).unwrap().is_none());

        let mut with_text = plain_page_filter();
        with_text.text_query = Some("bug".to_string());
        assert!(plain_native_page(Some(&with_text)).unwrap().is_none());

        let mut with_status = plain_page_filter();
        with_status.status = Some("running".to_string());
        assert!(plain_native_page(Some(&with_status)).unwrap().is_none());

        let mut with_external = plain_page_filter();
        with_external.include_external_history = Some(true);
        assert!(plain_native_page(Some(&with_external)).unwrap().is_none());

        let mut external_unset = plain_page_filter();
        external_unset.include_external_history = None;
        assert!(plain_native_page(Some(&external_unset)).unwrap().is_none());

        let mut multi_category = plain_page_filter();
        multi_category.category = Some("cli,agent".to_string());
        assert!(plain_native_page(Some(&multi_category)).unwrap().is_none());

        let mut sorted_by_name = plain_page_filter();
        sorted_by_name.sort_by = Some("name".to_string());
        assert!(plain_native_page(Some(&sorted_by_name)).unwrap().is_none());
    }
}
