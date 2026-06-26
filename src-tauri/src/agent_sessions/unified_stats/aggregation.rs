//! Core aggregation logic for combining sessions from multiple backends.
//!
//! This module provides the main `list_all_sessions` function that loads sessions
//! from CLI, Coding, and OS Agent backends, applies filters, sorting, and pagination,
//! and computes statistics.

use crate::agent_sessions::cli::persistence as cli_session_persistence;
use agent_core::coordination::agent_org_runs::{AgentOrgRunRecord, AgentOrgRunStore};
use agent_core::definitions::orgs::OrgDefinition;
use agent_core::session::persistence::{self as session_persistence, session_type};
use chrono::DateTime;
use core_types::key_source::KeySource;
use database::db::get_connection;
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::codex::app as codex_app_history;
use orgtrack_core::sources::cursor_ide::history as cursor_ide_history;
use orgtrack_core::sources::cursor_ide::history::CursorIdeSessionPage;
use orgtrack_core::sources::imported_history::cache as imported_history_cache;
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE, SOURCE_OPENCODE, SOURCE_WINDSURF,
    SOURCE_WORKBUDDY,
};
use orgtrack_core::sources::imported_history::ImportedHistorySessionPage;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;

const AGENT_ORG_ICON_ID: &str = "network";

use super::conversion::{
    cli_session_to_aggregate_record, cursor_ide_history_to_aggregate_record,
    imported_history_to_aggregate_record, os_session_to_aggregate_record,
    sde_session_to_aggregate_record, AgentMetadataResolver,
};
use super::display::matches_text_query;
use super::status::{is_active_status, is_completed_status, is_failed_status};
use super::types::{
    CategoryStats, KeySourceStats, SessionAggregateRecord, SessionCategory, SessionFilter,
    SessionListResponse, SessionStats,
};

const IMPORTED_HISTORY_PAGE_SIZE: usize = 500;

enum ExternalHistoryPage {
    Imported(ImportedHistorySessionPage),
    CursorIde(CursorIdeSessionPage),
}

struct ExternalHistorySourceLoader {
    source: &'static str,
    load_page: fn(&mut rusqlite::Connection, usize, usize) -> Result<ExternalHistoryPage, String>,
}

fn load_claude_code_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    claude_code_history::list_claude_code_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_codex_app_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    codex_app_history::list_codex_app_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_cursor_ide_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cursor_ide_history::list_cursor_ide_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::CursorIde)
}

fn load_opencode_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    opencode_history::list_opencode_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_windsurf_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    windsurf_history::list_windsurf_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_workbuddy_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    workbuddy_history::list_workbuddy_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

const EXTERNAL_HISTORY_SOURCE_LOADERS: &[ExternalHistorySourceLoader] = &[
    ExternalHistorySourceLoader {
        source: SOURCE_CLAUDE_CODE,
        load_page: load_claude_code_external_history_page,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CODEX_APP,
        load_page: load_codex_app_external_history_page,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CURSOR_IDE,
        load_page: load_cursor_ide_external_history_page,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_OPENCODE,
        load_page: load_opencode_external_history_page,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WINDSURF,
        load_page: load_windsurf_external_history_page,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WORKBUDDY,
        load_page: load_workbuddy_external_history_page,
    },
];

fn append_external_history_page(
    records: &mut Vec<SessionAggregateRecord>,
    source: &str,
    page: ExternalHistoryPage,
) -> usize {
    match page {
        ExternalHistoryPage::Imported(page) => {
            let page_len = page.sessions.len();
            records.extend(
                page.sessions
                    .into_iter()
                    .map(|row| imported_history_to_aggregate_record(row, source)),
            );
            page_len
        }
        ExternalHistoryPage::CursorIde(page) => {
            let page_len = page.sessions.len();
            records.extend(
                page.sessions
                    .into_iter()
                    .map(|row| cursor_ide_history_to_aggregate_record(row, source)),
            );
            page_len
        }
    }
}

fn load_external_history_source(
    conn: &mut rusqlite::Connection,
    records: &mut Vec<SessionAggregateRecord>,
    loader: &ExternalHistorySourceLoader,
) -> Result<(), String> {
    let mut offset = 0;
    loop {
        let page = (loader.load_page)(conn, IMPORTED_HISTORY_PAGE_SIZE, offset)?;
        let page_has_more = match &page {
            ExternalHistoryPage::Imported(page) => page.has_more,
            ExternalHistoryPage::CursorIde(page) => page.has_more,
        };
        let page_len = append_external_history_page(records, loader.source, page);
        if !page_has_more || page_len == 0 {
            break;
        }
        offset = offset.saturating_add(page_len);
    }
    Ok(())
}

fn cached_external_history_rows_in_range(
    source: &'static str,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<SessionAggregateRecord>, String> {
    let conn =
        get_connection().map_err(|err| format!("Failed to open orgtrack cache DB: {err}"))?;
    let rows = imported_history_cache::query_cached_sessions_in_range_from_conn(
        &conn, source, start_ms, end_ms,
    )?;
    Ok(rows
        .into_iter()
        .map(|row| imported_history_to_aggregate_record(row.to_row(), source))
        .collect())
}

pub fn cached_external_history_sessions_in_range(
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<SessionAggregateRecord>, String> {
    let handles = EXTERNAL_HISTORY_SOURCE_LOADERS
        .iter()
        .map(|loader| {
            let source = loader.source;
            std::thread::spawn(move || {
                cached_external_history_rows_in_range(source, start_ms, end_ms)
            })
        })
        .collect::<Vec<_>>();

    let mut records = Vec::new();
    for handle in handles {
        let mut source_records = handle
            .join()
            .map_err(|_| "External history cache worker panicked".to_string())??;
        records.append(&mut source_records);
    }
    Ok(records)
}

fn load_imported_history_sessions() -> Result<Vec<SessionAggregateRecord>, String> {
    let mut conn =
        get_connection().map_err(|err| format!("Failed to open orgtrack cache DB: {err}"))?;
    let mut records = Vec::new();

    for loader in EXTERNAL_HISTORY_SOURCE_LOADERS {
        load_external_history_source(&mut conn, &mut records, loader)?;
    }

    Ok(records)
}

// ============================================================================
// Core Aggregation
// ============================================================================

/// Load sessions from the requested sources and compute statistics.
pub fn list_all_sessions(filter: Option<&SessionFilter>) -> Result<SessionListResponse, String> {
    let category_filter = filter.and_then(|filter| filter.category.as_deref());
    let wants_category = |category: &str| -> bool {
        category_filter
            .map(|raw| raw.split(',').map(str::trim).any(|value| value == category))
            .unwrap_or(true)
    };

    let load_cli = wants_category("cli");
    let load_agent = wants_category("agent");
    let load_os = wants_category("os");
    let mut all_sessions: Vec<SessionAggregateRecord> = Vec::new();
    let mut metadata_resolver = (load_agent || load_os).then(AgentMetadataResolver::new);

    if load_cli {
        let cli_sessions = cli_session_persistence::list_sessions()
            .map_err(|err| format!("Failed to load CLI sessions: {}", err))?;
        all_sessions.reserve(cli_sessions.len());
        for session in cli_sessions {
            all_sessions.push(cli_session_to_aggregate_record(session));
        }

        let include_external_history = filter
            .and_then(|filter| filter.include_external_history)
            .unwrap_or(true);
        if include_external_history {
            match load_imported_history_sessions() {
                Ok(imported_sessions) => all_sessions.extend(imported_sessions),
                Err(err) => {
                    tracing::warn!(error = %err, "unified_stats: failed to load orgtrack imported history sessions")
                }
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
    let skip_orgtrack_upsert = filter
        .map(|filter| filter.skip_orgtrack_upsert)
        .unwrap_or(false);
    if !skip_orgtrack_upsert {
        if let Err(err) = super::orgtrack_adapter::upsert_aggregate_sessions(&all_sessions) {
            tracing::warn!(error = %err, "unified_stats: failed to upsert orgtrack core sessions");
        }
    }

    // Apply filters
    if let Some(filter) = filter {
        apply_filters(&mut all_sessions, filter)?;
    }

    // Compute statistics (before applying limit/offset)
    let stats = compute_stats(&all_sessions);

    // Apply sorting
    apply_sorting(&mut all_sessions, filter);

    // Apply offset and limit
    if let Some(filter) = filter {
        apply_pagination(&mut all_sessions, filter);
    }

    Ok(SessionListResponse {
        sessions: all_sessions,
        stats,
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
    if let Some(ref category) = filter.category {
        let categories: Vec<&str> = category.split(',').map(|s| s.trim()).collect();
        sessions.retain(|session| {
            let cat_str = session.category.as_str();
            categories.contains(&cat_str)
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
                sessions.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase()));
            } else {
                sessions.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
// Statistics Computation
// ============================================================================

/// Compute statistics for a set of sessions.
pub fn compute_stats(sessions: &[SessionAggregateRecord]) -> SessionStats {
    let total = sessions.len();
    let mut active = 0;
    let mut completed = 0;
    let mut failed = 0;
    let mut by_category = CategoryStats::default();
    let mut by_key_source = KeySourceStats::default();

    for session in sessions {
        // Status counts
        if is_active_status(&session.status) {
            active += 1;
        } else if is_completed_status(&session.status) {
            completed += 1;
        } else if is_failed_status(&session.status) {
            failed += 1;
        }

        // Category counts
        match session.category {
            SessionCategory::Cli => by_category.cli += 1,
            SessionCategory::Agent => by_category.agent += 1,
            SessionCategory::Os => by_category.os += 1,
        }

        // Key source counts
        match session.key_source {
            KeySource::OwnKey => by_key_source.own_key += 1,
            KeySource::HostedKey => by_key_source.hosted_key += 1,
        }
    }

    SessionStats {
        total,
        active,
        completed,
        failed,
        by_category,
        by_key_source,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::unified_stats::display::generate_display_label;

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
            user_input: None,
            repo_path: None,
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
    fn test_compute_stats_empty() {
        let sessions: Vec<SessionAggregateRecord> = vec![];
        let stats = compute_stats(&sessions);

        assert_eq!(stats.total, 0);
        assert_eq!(stats.active, 0);
        assert_eq!(stats.completed, 0);
        assert_eq!(stats.failed, 0);
        assert_eq!(stats.by_category.cli, 0);
        assert_eq!(stats.by_category.agent, 0);
        assert_eq!(stats.by_category.os, 0);
        assert_eq!(stats.by_key_source.own_key, 0);
        assert_eq!(stats.by_key_source.hosted_key, 0);
    }

    #[test]
    fn test_compute_stats_mixed_sessions() {
        let sessions = vec![
            make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey),
            make_session("2", "completed", SessionCategory::Cli, KeySource::OwnKey),
            make_session("3", "failed", SessionCategory::Agent, KeySource::HostedKey),
            make_session("4", "pending", SessionCategory::Os, KeySource::OwnKey),
            make_session("5", "cancelled", SessionCategory::Cli, KeySource::HostedKey),
        ];

        let stats = compute_stats(&sessions);

        assert_eq!(stats.total, 5);
        assert_eq!(stats.active, 2); // running, pending
        assert_eq!(stats.completed, 1);
        assert_eq!(stats.failed, 2); // failed, cancelled

        // By category
        assert_eq!(stats.by_category.cli, 3);
        assert_eq!(stats.by_category.agent, 1);
        assert_eq!(stats.by_category.os, 1);

        // By key source
        assert_eq!(stats.by_key_source.own_key, 3);
        assert_eq!(stats.by_key_source.hosted_key, 2);
    }

    #[test]
    fn test_compute_stats_all_active() {
        let sessions = vec![
            make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey),
            make_session("2", "pending", SessionCategory::Cli, KeySource::OwnKey),
            make_session("3", "idle", SessionCategory::Cli, KeySource::OwnKey),
        ];

        let stats = compute_stats(&sessions);

        assert_eq!(stats.total, 3);
        assert_eq!(stats.active, 3);
        assert_eq!(stats.completed, 0);
        assert_eq!(stats.failed, 0);
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
}
