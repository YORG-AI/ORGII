//! Core aggregation logic for combining sessions from multiple backends.
//!
//! This module provides the main `list_all_sessions` function that loads sessions
//! from CLI, Coding, and OS Agent backends and applies filters, sorting, and
//! pagination. It is a pure read: orgtrack mirroring happens on the session
//! write paths (see `orgtrack_adapter`), never during listing.

use std::collections::HashSet;

use crate::agent_sessions::cli::persistence as cli_session_persistence;
use agent_core::coordination::agent_org_runs::{AgentOrgRunRecord, AgentOrgRunStore};
use agent_core::definitions::orgs::OrgDefinition;
use agent_core::session::persistence::{self as session_persistence, session_type};
use chrono::DateTime;
use core_types::key_source::KeySource;
use database::db::get_connection;
use orgtrack_core::sources::imported_history::cache as imported_history_cache;
use orgtrack_core::sources::imported_history::catalog as imported_history_catalog;
use orgtrack_core::sources::imported_history::replay::ImportedHistorySourceId;
use orgtrack_core::sources::imported_history::IMPORTED_STATUS_COMPLETED;

const AGENT_ORG_ICON_ID: &str = "network";

use super::conversion::{
    cli_session_to_aggregate_record, human_session_to_aggregate_record,
    imported_history_to_aggregate_record, os_session_to_aggregate_record,
    sde_session_to_aggregate_record, AgentMetadataResolver,
};
use super::display::matches_text_query;
use super::types::{SessionAggregateRecord, SessionFilter, SessionListResponse};

const IMPORTED_HISTORY_PAGE_SIZE: usize = 500;

/// Refresh only the compact imported-history catalog. Transcript hydration is
/// deliberately not part of the directory/listing contract.
pub fn resync_external_history_source(
    conn: &mut rusqlite::Connection,
    source: &str,
) -> Result<(), String> {
    imported_history_catalog::refresh_source(conn, ImportedHistorySourceId::parse(source)?)
}

/// How long after the last transcript write a hook-less CLI still counts as
/// running. Scan cadence (60s focused) bounds how fresh `updated_at` can be,
/// so the effective "running" window is roughly one to two scan ticks.
const IMPORTED_MTIME_ACTIVE_WINDOW_MS: i64 = 60_000;

/// Live-status decoration for imported rows: a fresh lifecycle-hook state
/// wins; otherwise a transcript updated moments ago flips the row to
/// `running` — the only liveness signal CLIs without any hook surface
/// (aider, goose, cline, warp, ...) can give us.
fn decorate_imported_live_status(records: &mut [SessionAggregateRecord]) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    for record in records.iter_mut() {
        if let Some((status, _entry)) =
            crate::orgtrack::agent_live_status::effective_live_status(&record.session_id)
        {
            record.status = status.to_string();
            record.is_active = super::status::is_active_status(status);
            continue;
        }
        if record.status == IMPORTED_STATUS_COMPLETED {
            let recently_updated = DateTime::parse_from_rfc3339(&record.updated_at)
                .map(|updated| {
                    now_ms - updated.timestamp_millis() < IMPORTED_MTIME_ACTIVE_WINDOW_MS
                })
                .unwrap_or(false);
            if recently_updated {
                record.status = "running".to_string();
                record.is_active = true;
            }
        }
    }
}

fn load_imported_history_sessions(
    filter: Option<&SessionFilter>,
) -> Result<Vec<SessionAggregateRecord>, String> {
    let conn =
        get_connection().map_err(|err| format!("Failed to open orgtrack cache DB: {err}"))?;
    let mut records = Vec::new();
    let source_filter = filter.and_then(|filter| filter.external_history_source.as_deref());
    let disabled_sources: std::collections::HashSet<&str> = filter
        .and_then(|filter| filter.disabled_external_history_sources.as_ref())
        .map(|sources| sources.iter().map(String::as_str).collect())
        .unwrap_or_default();

    if let Some(session_ids) = filter
        .and_then(|filter| filter.session_ids.as_ref())
        .filter(|session_ids| !session_ids.is_empty())
    {
        for session_id in session_ids {
            let Some((source, session)) =
                imported_history_cache::query_cached_session_by_session_id_from_conn(
                    &conn, session_id,
                )?
            else {
                continue;
            };
            if source_filter.is_some_and(|expected| expected != source.as_str())
                || disabled_sources.contains(source.as_str())
            {
                continue;
            }
            records.push(imported_history_to_aggregate_record(
                session.to_row(),
                &source,
            ));
        }
        decorate_imported_live_status(&mut records);
        return Ok(records);
    }

    let requested_limit = filter
        .and_then(|filter| filter.limit)
        .unwrap_or(IMPORTED_HISTORY_PAGE_SIZE);
    let requested_offset = filter.and_then(|filter| filter.offset).unwrap_or(0);
    let page_limit = requested_limit.min(IMPORTED_HISTORY_PAGE_SIZE);
    let page_offset = if source_filter.is_some() {
        requested_offset
    } else {
        0
    };

    for source in ImportedHistorySourceId::ALL {
        let source_id = source.as_str();
        if source_filter.is_some_and(|expected| expected != source_id) {
            continue;
        }
        if disabled_sources.contains(source_id) {
            continue;
        }
        let page = imported_history_cache::query_imported_session_page_from_conn(
            &conn,
            source_id,
            page_limit,
            page_offset,
        )?;
        records.extend(
            page.sessions
                .into_iter()
                .map(|row| imported_history_to_aggregate_record(row, source_id)),
        );
    }

    decorate_imported_live_status(&mut records);
    Ok(records)
}

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
fn plain_native_page(
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
            ImportedHistorySourceId::ALL
                .iter()
                .map(|source| source.as_str())
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

pub fn list_all_sessions(filter: Option<&SessionFilter>) -> Result<SessionListResponse, String> {
    if let Some(page) = plain_native_page(filter)? {
        return Ok(page);
    }
    let category_filter = filter.and_then(|filter| filter.category.as_deref());
    let wants_category = |category: &str| -> bool {
        category_filter
            .map(|raw| raw.split(',').map(str::trim).any(|value| value == category))
            .unwrap_or(true)
    };

    let load_cli = wants_category("cli");
    let load_external_history = wants_category("external_history")
        || filter
            .and_then(|filter| filter.external_history_source.as_ref())
            .is_some();
    let load_agent = wants_category("agent");
    let load_os = wants_category("os");
    let load_human = wants_category("human");
    let mut all_sessions: Vec<SessionAggregateRecord> = Vec::new();
    let mut metadata_resolver = (load_agent || load_os).then(AgentMetadataResolver::new);

    if load_cli {
        let cli_sessions = cli_session_persistence::list_sessions()
            .map_err(|err| format!("Failed to load CLI sessions: {}", err))?;
        all_sessions.reserve(cli_sessions.len());
        for session in cli_sessions {
            all_sessions.push(cli_session_to_aggregate_record(session));
        }
    }

    let include_external_history = filter
        .and_then(|filter| filter.include_external_history)
        .unwrap_or(true);
    if include_external_history && (load_cli || load_external_history) {
        match load_imported_history_sessions(filter) {
            Ok(imported_sessions) => all_sessions.extend(imported_sessions),
            Err(err) => {
                tracing::warn!(error = %err, "session_directory: failed to load orgtrack imported history sessions")
            }
        }
    }

    if load_agent {
        let sde_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::CODING.to_string()),
            ..Default::default()
        };
        let sde_sessions = session_persistence::list_sessions(&sde_filter)
            .map_err(|err| format!("Failed to load SDE Agent sessions: {}", err))?;
        all_sessions.reserve(sde_sessions.len());
        let resolver = metadata_resolver
            .as_mut()
            .expect("agent metadata resolver initialized for agent sessions");
        for session in sde_sessions {
            all_sessions.push(sde_session_to_aggregate_record(session, resolver));
        }

        let org_member_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::ORG_MEMBER.to_string()),
            ..Default::default()
        };
        let org_member_sessions = session_persistence::list_sessions(&org_member_filter)
            .map_err(|err| format!("Failed to load Agent Org member sessions: {}", err))?;
        all_sessions.reserve(org_member_sessions.len());
        let resolver = metadata_resolver
            .as_mut()
            .expect("agent metadata resolver initialized for org member sessions");
        for session in org_member_sessions {
            all_sessions.push(sde_session_to_aggregate_record(session, resolver));
        }

        annotate_agent_org_root_rows(&mut all_sessions)?;
    }

    if load_os {
        let os_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::DESKTOP.to_string()),
            ..Default::default()
        };
        let os_sessions = session_persistence::list_sessions(&os_filter)
            .map_err(|err| format!("Failed to load OS Agent sessions: {}", err))?;
        all_sessions.reserve(os_sessions.len());
        let resolver = metadata_resolver
            .as_mut()
            .expect("agent metadata resolver initialized for OS sessions");
        for session in os_sessions {
            all_sessions.push(os_session_to_aggregate_record(session, resolver));
        }
    }
    if load_human {
        let human_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::HUMAN.to_string()),
            ..Default::default()
        };
        let human_sessions = session_persistence::list_sessions(&human_filter)
            .map_err(|err| format!("Failed to load Human sessions: {err}"))?;
        all_sessions.extend(
            human_sessions
                .into_iter()
                .map(human_session_to_aggregate_record),
        );
    }
    // Apply filters
    if let Some(filter) = filter {
        apply_filters(&mut all_sessions, filter)?;
    }

    // Apply sorting
    apply_sorting(&mut all_sessions, filter);

    // Source-specific external pages already apply their source offset at load time.
    if let Some(filter) = filter {
        if filter.external_history_source.is_none() {
            apply_pagination(&mut all_sessions, filter);
        }
    }

    Ok(SessionListResponse {
        sessions: all_sessions,
    })
}

// ============================================================================
// Filtering
// ============================================================================

fn parse_epoch_millis(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn apply_filters(
    sessions: &mut Vec<SessionAggregateRecord>,
    filter: &SessionFilter,
) -> Result<(), String> {
    if let Some(session_ids) = filter
        .session_ids
        .as_ref()
        .filter(|session_ids| !session_ids.is_empty())
    {
        let session_ids = session_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        sessions.retain(|session| session_ids.contains(session.session_id.as_str()));
    }

    if let Some(ref category) = filter.category {
        let categories: Vec<&str> = category.split(',').map(|s| s.trim()).collect();
        sessions.retain(|session| {
            let cat_str = session.category.as_str();
            categories.contains(&cat_str)
                || (categories.contains(&"external_history")
                    && session.external_history_source.is_some())
        });
    }

    if let Some(ref external_history_source) = filter.external_history_source {
        sessions.retain(|session| {
            session.external_history_source.as_deref() == Some(external_history_source.as_str())
        });
    }

    if let Some(ref status) = filter.status {
        let statuses: Vec<&str> = status.split(',').map(|s| s.trim()).collect();
        sessions.retain(|session| statuses.contains(&session.status.as_str()));
    }

    if let Some(ref key_source) = filter.key_source {
        // Reject typo'd / unknown values instead of silently mapping them
        // to OwnKey, which would mis-filter the entire result set.
        let ks = KeySource::parse(key_source)
            .ok_or_else(|| format!("Unknown key_source filter: {key_source:?}"))?;
        sessions.retain(|session| session.key_source == ks);
    }

    if let Some(created_after_ms) = filter.created_after_ms {
        sessions.retain(|session| {
            parse_epoch_millis(&session.created_at)
                .map(|created_at_ms| created_at_ms >= created_after_ms)
                .unwrap_or(false)
        });
    }

    if let Some(created_before_ms) = filter.created_before_ms {
        sessions.retain(|session| {
            parse_epoch_millis(&session.created_at)
                .map(|created_at_ms| created_at_ms <= created_before_ms)
                .unwrap_or(false)
        });
    }

    if let Some(ref repo_path) = filter.repo_path {
        sessions.retain(|session| {
            session
                .repo_path
                .as_ref()
                .map(|p| p.starts_with(repo_path))
                .unwrap_or(false)
        });
    }

    if let Some(ref org_id) = filter.org_id {
        sessions.retain(|session| session.org_id.as_deref() == Some(org_id.as_str()));
    }

    if let Some(ref project_slug) = filter.project_slug {
        sessions.retain(|session| session.project_slug.as_deref() == Some(project_slug.as_str()));
    }

    if let Some(ref work_item_id) = filter.work_item_id {
        sessions.retain(|session| session.work_item_id.as_deref() == Some(work_item_id.as_str()));
    }

    // Text search filter
    if let Some(ref query) = filter.text_query {
        if !query.trim().is_empty() {
            sessions.retain(|session| matches_text_query(session, query));
        }
    }

    // Active only filter
    if filter.active_only == Some(true) {
        sessions.retain(|session| session.is_active);
    }

    Ok(())
}

// ============================================================================
// Sorting
// ============================================================================

fn apply_sorting(sessions: &mut [SessionAggregateRecord], filter: Option<&SessionFilter>) {
    let sort_by = filter
        .as_ref()
        .and_then(|f| f.sort_by.as_deref())
        .unwrap_or("updated_at");
    let sort_desc = filter
        .as_ref()
        .and_then(|f| f.sort_order.as_deref())
        .map(|order| order != "asc")
        .unwrap_or(true);

    match sort_by {
        "created_at" => {
            if sort_desc {
                sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            } else {
                sessions.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            }
        }
        "name" => {
            if sort_desc {
                sessions.sort_by_key(|session| std::cmp::Reverse(session.name.to_lowercase()));
            } else {
                sessions.sort_by_key(|a| a.name.to_lowercase());
            }
        }
        _ => {
            // Default: updated_at
            if sort_desc {
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            } else {
                sessions.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
            }
        }
    }
}

// ============================================================================
// Pagination
// ============================================================================

fn apply_pagination(sessions: &mut Vec<SessionAggregateRecord>, filter: &SessionFilter) {
    if let Some(offset) = filter.offset {
        if offset < sessions.len() {
            *sessions = sessions.drain(offset..).collect();
        } else {
            sessions.clear();
        }
    }
    if let Some(limit) = filter.limit {
        sessions.truncate(limit);
    }
}

fn agent_org_display_name(run: &AgentOrgRunRecord) -> String {
    run.org_snapshot_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<OrgDefinition>(json).ok())
        .map(|org| org.name)
        .unwrap_or_else(|| run.org_id.clone())
}

fn annotate_agent_org_root_rows(sessions: &mut [SessionAggregateRecord]) -> Result<(), String> {
    let root_session_ids: std::collections::HashMap<String, (String, String)> =
        AgentOrgRunStore::list_runs(usize::MAX)?
            .into_iter()
            .filter_map(|run| {
                let root_session_id = run.root_session_id.clone()?;
                let org_name = agent_org_display_name(&run);
                Some((root_session_id, (run.org_id, org_name)))
            })
            .collect();
    if root_session_ids.is_empty() {
        return Ok(());
    }

    for session in sessions {
        if let Some((org_id, org_name)) = root_session_ids.get(&session.session_id) {
            session.agent_icon_id = Some(AGENT_ORG_ICON_ID.to_string());
            session.agent_org_id = Some(org_id.clone());
            session.agent_org_name = Some(org_name.clone());
        }
    }

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::session_directory::display::generate_display_label;
    use crate::agent_sessions::session_directory::status::is_active_status;
    use crate::agent_sessions::session_directory::types::SessionCategory;

    fn make_session(
        id: &str,
        status: &str,
        category: SessionCategory,
        key_source: KeySource,
    ) -> SessionAggregateRecord {
        let name = format!("Session {}", id);
        SessionAggregateRecord {
            session_id: id.to_string(),
            name: name.clone(),
            status: status.to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T01:00:00Z".to_string(),
            category,
            external_history_source: None,
            user_input: None,
            repo_path: None,
            storage_path: None,
            repo_name: None,
            branch: None,
            model: Some("gpt-4".to_string()),
            account_id: None,
            cli_agent_type: None,
            key_source,
            tier: None,
            pid: None,
            total_tokens: 1000,
            worktree_path: None,
            worktree_branch: None,
            base_branch: None,
            merge_status: None,
            background: false,
            org_id: None,
            project_id: None,
            project_name: None,
            project_slug: None,
            work_item_id: None,
            agent_role: None,
            is_active: is_active_status(status),
            display_label: generate_display_label(&name, None),
            parent_session_id: None,
            org_member_id: None,
            agent_org_id: None,
            agent_org_name: None,
            agent_definition_id: None,
            agent_icon_id: None,
            agent_display_name: None,
            agent_exec_mode: None,
            draft_text: None,
            reply_target_event_id: None,
            pinned: false,
            files_changed: None,
            lines_added: None,
            lines_removed: None,
            touched_files: None,
        }
    }

    #[test]
    fn apply_filters_accepts_known_key_source() {
        let mut sessions = vec![
            make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey),
            make_session("2", "running", SessionCategory::Cli, KeySource::HostedKey),
        ];

        let filter = SessionFilter {
            key_source: Some("hosted_key".to_string()),
            ..Default::default()
        };
        apply_filters(&mut sessions, &filter).expect("known key_source must be Ok");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "2");
    }

    #[test]
    fn apply_filters_matches_canonical_session_ids_exactly() {
        let mut sessions = vec![
            make_session(
                "session-1",
                "completed",
                SessionCategory::Cli,
                KeySource::OwnKey,
            ),
            make_session(
                "session-10",
                "completed",
                SessionCategory::Cli,
                KeySource::OwnKey,
            ),
        ];
        let filter = SessionFilter {
            session_ids: Some(vec!["session-1".to_string()]),
            ..Default::default()
        };

        apply_filters(&mut sessions, &filter).expect("session ID filter");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-1");
    }

    #[test]
    fn apply_filters_rejects_unknown_key_source() {
        let mut sessions = vec![make_session(
            "1",
            "running",
            SessionCategory::Cli,
            KeySource::OwnKey,
        )];

        let filter = SessionFilter {
            // Typo: missing "_key" suffix. Previously silently mapped to
            // OwnKey and mis-filtered the entire response.
            key_source: Some("market".to_string()),
            ..Default::default()
        };
        let err =
            apply_filters(&mut sessions, &filter).expect_err("unknown key_source must be rejected");
        assert!(
            err.contains("Unknown key_source filter"),
            "expected explicit rejection, got: {err}"
        );
    }

    #[test]
    fn pagination_does_not_append_org_member_children_for_visible_roots() {
        let root = make_session(
            "root-session",
            "running",
            SessionCategory::Agent,
            KeySource::OwnKey,
        );
        let mut paged_sessions = vec![root];
        let filter = SessionFilter {
            limit: Some(1),
            ..Default::default()
        };
        apply_pagination(&mut paged_sessions, &filter);

        assert_eq!(
            paged_sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["root-session"]
        );
    }

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
