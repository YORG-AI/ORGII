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
use agent_core::session::persistence::{
    self as session_persistence, list_agent_org_root_sessions_page,
    list_standalone_coding_sessions_page, list_unpinned_sessions_by_type_page, session_type,
};
use agent_core::session::SessionStatus;
use chrono::DateTime;
use core_types::key_source::KeySource;
use database::db::get_connection;
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::cline::history as cline_history;
use orgtrack_core::sources::codex::app as codex_app_history;
use orgtrack_core::sources::copilot::history as copilot_history;
use orgtrack_core::sources::cursor_cli::history as cursor_cli_history;
use orgtrack_core::sources::cursor_ide::history as cursor_ide_history;
use orgtrack_core::sources::cursor_ide::history::CursorIdeSessionPage;
use orgtrack_core::sources::imported_history::cache as imported_history_cache;
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CLINE, SOURCE_CODEX_APP, SOURCE_COPILOT, SOURCE_CURSOR_CLI,
    SOURCE_CURSOR_IDE, SOURCE_KIMI, SOURCE_MIMO_CODE, SOURCE_OMP, SOURCE_OPENCODE, SOURCE_PI,
    SOURCE_QODER, SOURCE_QODER_CLI, SOURCE_QWEN_CODE, SOURCE_TRAE, SOURCE_WARP, SOURCE_WINDSURF,
    SOURCE_WORKBUDDY, SOURCE_ZCODE,
};
use orgtrack_core::sources::imported_history::ImportedHistorySessionPage;
use orgtrack_core::sources::imported_history::IMPORTED_STATUS_COMPLETED;
use orgtrack_core::sources::kimi::history as kimi_history;
use orgtrack_core::sources::mimo_code::history as mimo_code_history;
use orgtrack_core::sources::omp::history as omp_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::pi::history as pi_history;
use orgtrack_core::sources::qoder::history as qoder_history;
use orgtrack_core::sources::qoder_cli::history as qoder_cli_history;
use orgtrack_core::sources::qwen_code::history as qwen_code_history;
use orgtrack_core::sources::trae::history as trae_history;
use orgtrack_core::sources::warp::history as warp_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;
use orgtrack_core::sources::zcode::history as zcode_history;
use rusqlite::params;

const AGENT_ORG_ICON_ID: &str = "network";

use super::conversion::{
    cli_session_to_aggregate_record, cursor_ide_history_to_aggregate_record,
    human_session_to_aggregate_record, imported_history_to_aggregate_record,
    os_session_to_aggregate_record, sde_session_to_aggregate_record, AgentMetadataResolver,
};
use super::display::matches_text_query;
use super::types::{
    NativeSidebarSessionCursor, NativeSidebarSessionPageResponse, NativeSidebarSessionStream,
    SessionAggregateRecord, SessionFilter, SessionListResponse,
};

const IMPORTED_HISTORY_PAGE_SIZE: usize = 500;
pub const NATIVE_SIDEBAR_PAGE_MAX_LIMIT: usize = 50;

enum ExternalHistoryPage {
    Imported(ImportedHistorySessionPage),
    CursorIde(CursorIdeSessionPage),
}

type ExternalHistoryPageLoader =
    fn(&mut rusqlite::Connection, usize, usize) -> Result<ExternalHistoryPage, String>;

struct ExternalHistorySourceLoader {
    source: &'static str,
    load_page: ExternalHistoryPageLoader,
    /// Filtered cache-snapshot reader for continuation pages. Sources whose
    /// page-zero loader filters beyond the generic cache predicate (Cursor
    /// IDE's listable-session check) must re-apply that filter on "Load
    /// more", or offsets computed against page zero's filtered stream
    /// misalign — duplicating rows already shown and surfacing rows page
    /// zero hides. `None` = the generic cache page matches page zero.
    load_continuation_page: Option<ExternalHistoryPageLoader>,
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

fn load_cursor_ide_external_history_continuation_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cursor_ide_history::list_cursor_ide_sessions_paginated_cached(conn, limit, offset)
        .map(ExternalHistoryPage::CursorIde)
}

fn load_cursor_cli_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cursor_cli_history::list_cursor_cli_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
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

fn load_trae_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    trae_history::list_trae_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_cline_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cline_history::list_cline_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_warp_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    warp_history::list_warp_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_zcode_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    zcode_history::list_zcode_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_qoder_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    qoder_history::list_qoder_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_mimo_code_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    mimo_code_history::list_mimo_code_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_omp_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    omp_history::list_omp_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_pi_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    pi_history::list_pi_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_qoder_cli_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    qoder_cli_history::list_qoder_cli_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_qwen_code_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    qwen_code_history::list_qwen_code_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_kimi_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    kimi_history::list_kimi_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_copilot_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    copilot_history::list_copilot_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

const EXTERNAL_HISTORY_SOURCE_LOADERS: &[ExternalHistorySourceLoader] = &[
    ExternalHistorySourceLoader {
        source: SOURCE_CLAUDE_CODE,
        load_page: load_claude_code_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CODEX_APP,
        load_page: load_codex_app_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CURSOR_IDE,
        load_page: load_cursor_ide_external_history_page,
        load_continuation_page: Some(load_cursor_ide_external_history_continuation_page),
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CURSOR_CLI,
        load_page: load_cursor_cli_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_OPENCODE,
        load_page: load_opencode_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WINDSURF,
        load_page: load_windsurf_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WORKBUDDY,
        load_page: load_workbuddy_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_TRAE,
        load_page: load_trae_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CLINE,
        load_page: load_cline_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WARP,
        load_page: load_warp_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_ZCODE,
        load_page: load_zcode_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_QODER,
        load_page: load_qoder_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_MIMO_CODE,
        load_page: load_mimo_code_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_OMP,
        load_page: load_omp_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_PI,
        load_page: load_pi_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_QODER_CLI,
        load_page: load_qoder_cli_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_QWEN_CODE,
        load_page: load_qwen_code_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_COPILOT,
        load_page: load_copilot_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_KIMI,
        load_page: load_kimi_external_history_page,
        load_continuation_page: None,
    },
];

/// Discover a source's current records and incrementally re-sync its metadata
/// cache, discarding the returned page. This runs the exact sync the
/// sidebar/list path performs (re-parsing every record whose signature changed,
/// e.g. after a parser-version bump), so a manual update can refresh counts and
/// names immediately instead of waiting for a lazy list load.
pub fn resync_external_history_source(
    conn: &mut rusqlite::Connection,
    source: &str,
) -> Result<bool, String> {
    let loader = EXTERNAL_HISTORY_SOURCE_LOADERS
        .iter()
        .find(|loader| loader.source == source)
        .ok_or_else(|| format!("Unknown external history source: {source}"))?;
    let changes_before = conn.total_changes();
    (loader.load_page)(conn, IMPORTED_HISTORY_PAGE_SIZE, 0)?;
    Ok(conn.total_changes() > changes_before)
}

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
    let mut conn =
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
        let include_superseded = filter
            .and_then(|filter| filter.include_continuation_superseded)
            .unwrap_or(false);
        for session_id in session_ids {
            let resolved = if include_superseded {
                imported_history_cache::query_cached_session_by_session_id_including_superseded_from_conn(
                    &conn, session_id,
                )?
            } else {
                imported_history_cache::query_cached_session_by_session_id_from_conn(
                    &conn, session_id,
                )?
            };
            let Some((source, session)) = resolved else {
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

    for loader in EXTERNAL_HISTORY_SOURCE_LOADERS {
        if source_filter.is_some_and(|source| source != loader.source) {
            continue;
        }
        if disabled_sources.contains(loader.source) {
            continue;
        }
        // Page zero is the explicit freshness boundary: it discovers the
        // provider and incrementally updates its cache. Follow-up "Load more"
        // pages read that stable cache snapshot directly. Re-running a full
        // provider scan for every offset made pagination multiply filesystem
        // and SQLite work without improving freshness.
        let loaded = if page_offset == 0 {
            (loader.load_page)(&mut conn, page_limit, page_offset)
        } else if let Some(load_continuation_page) = loader.load_continuation_page {
            load_continuation_page(&mut conn, page_limit, page_offset)
        } else {
            imported_history_cache::query_imported_session_page_from_conn(
                &conn,
                loader.source,
                page_limit,
                page_offset,
            )
            .map(ExternalHistoryPage::Imported)
        };
        // One provider's on-disk store must not decide whether the others are
        // visible. Propagating here dropped every source after the failing one
        // from the sidebar — and Claude Code, the most likely to hit an
        // unreadable transcript, is first in the list.
        let page = match loaded {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(
                    source = loader.source,
                    error = %error,
                    "session_directory: skipping external history source that failed to load"
                );
                continue;
            }
        };
        append_external_history_page(&mut records, loader.source, page);
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
    let requested_root_ids = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect::<Vec<_>>();
    if requested_root_ids.is_empty() {
        return Ok(());
    }
    let mut root_session_ids = std::collections::HashMap::new();
    for run in AgentOrgRunStore::list_runs_for_root_session_ids(&requested_root_ids)? {
        let Some(root_session_id) = run.root_session_id.clone() else {
            continue;
        };
        let org_name = agent_org_display_name(&run);
        root_session_ids
            .entry(root_session_id)
            .or_insert((run.org_id, org_name));
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

/// Load a bounded page for one native sidebar stream.
///
/// The store applies stream membership and pin state before LIMIT. We
/// over-fetch one row to compute `has_more`; continuation uses the final
/// `(updated_at, session_id)` key instead of a cache-derived offset.
pub fn list_native_sidebar_sessions(
    stream: NativeSidebarSessionStream,
    cursor: Option<&NativeSidebarSessionCursor>,
    limit: usize,
) -> Result<NativeSidebarSessionPageResponse, String> {
    if limit == 0 || limit > NATIVE_SIDEBAR_PAGE_MAX_LIMIT {
        return Err(format!(
            "Native sidebar page limit must be between 1 and {NATIVE_SIDEBAR_PAGE_MAX_LIMIT}"
        ));
    }
    let fetch_limit = limit
        .checked_add(1)
        .ok_or_else(|| "Native sidebar page limit overflow".to_string())?;
    let persistence_cursor =
        cursor.map(|cursor| (cursor.updated_at.as_str(), cursor.session_id.as_str()));

    let mut sessions = match stream {
        NativeSidebarSessionStream::PinnedNative => {
            list_pinned_native_sidebar_sessions(fetch_limit, cursor)?
        }
        NativeSidebarSessionStream::StandaloneAgent => {
            let page = list_standalone_coding_sessions_page(fetch_limit, persistence_cursor)?;
            let mut resolver = AgentMetadataResolver::new();
            page.into_iter()
                .map(|session| sde_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>()
        }
        NativeSidebarSessionStream::AgentOrgRoot => {
            let page = list_agent_org_root_sessions_page(fetch_limit, persistence_cursor)?;
            let mut resolver = AgentMetadataResolver::new();
            let mut sessions = page
                .into_iter()
                .map(|session| sde_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>();
            annotate_agent_org_root_rows(&mut sessions)?;
            sessions
        }
        NativeSidebarSessionStream::OsAgent => {
            let page = list_unpinned_sessions_by_type_page(
                session_type::DESKTOP,
                fetch_limit,
                persistence_cursor,
            )?;
            let mut resolver = AgentMetadataResolver::new();
            page.into_iter()
                .map(|session| os_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>()
        }
        NativeSidebarSessionStream::CliAgent => {
            let page = cli_session_persistence::list_unpinned_root_sessions_page(
                fetch_limit,
                persistence_cursor,
            )
            .map_err(|err| format!("Failed to load CLI sidebar page: {err}"))?;
            page.into_iter()
                .map(cli_session_to_aggregate_record)
                .collect::<Vec<_>>()
        }
        NativeSidebarSessionStream::HumanSession => {
            let page = list_unpinned_sessions_by_type_page(
                session_type::HUMAN,
                fetch_limit,
                persistence_cursor,
            )?;
            page.into_iter()
                .map(human_session_to_aggregate_record)
                .collect::<Vec<_>>()
        }
    };
    let has_more = sessions.len() > limit;
    sessions.truncate(limit);
    let next_cursor = sessions.last().map(|session| NativeSidebarSessionCursor {
        updated_at: session.updated_at.clone(),
        session_id: session.session_id.clone(),
    });

    Ok(NativeSidebarSessionPageResponse {
        sessions,
        next_cursor,
        has_more,
    })
}

#[derive(Debug, Clone, Copy)]
enum PinnedNativeSource {
    Agent,
    Cli,
}

struct PinnedNativeRow {
    source: PinnedNativeSource,
    session_id: String,
}

/// Query the global pinned stream in one ordered SQL page, then hydrate each
/// row from its owning native store. Imported history is intentionally absent:
/// those sources do not persist ORGII pin state.
fn list_pinned_native_sidebar_sessions(
    limit: usize,
    cursor: Option<&NativeSidebarSessionCursor>,
) -> Result<Vec<SessionAggregateRecord>, String> {
    let conn = get_connection().map_err(|err| format!("Failed to open session DB: {err}"))?;
    let bounded_limit = limit.min(i64::MAX as usize) as i64;
    let base = "
        SELECT s.session_id, s.updated_at, 'agent' AS source_kind
        FROM agent_sessions s
        WHERE s.pinned = 1
          AND s.status != ?1
          AND s.parent_session_id IS NULL
          AND s.session_type IN (?2, ?3, ?4)
        {agent_cursor}
        UNION ALL
        SELECT c.session_id, c.updated_at, 'cli' AS source_kind
        FROM code_sessions c
        WHERE c.pinned = 1
          AND c.parent_session_id IS NULL
        {cli_cursor}
        ORDER BY updated_at DESC, session_id DESC
        LIMIT {limit_parameter}";
    let rows = if let Some(cursor) = cursor {
        let cursor_predicate = "AND (updated_at < ?5 OR (updated_at = ?5 AND session_id < ?6))";
        let sql = base
            .replace("{agent_cursor}", cursor_predicate)
            .replace("{cli_cursor}", cursor_predicate)
            .replace("{limit_parameter}", "?7");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Prepare pinned sidebar page: {err}"))?;
        let rows = stmt
            .query_map(
                params![
                    SessionStatus::Archived.as_str(),
                    session_type::CODING,
                    session_type::DESKTOP,
                    session_type::HUMAN,
                    cursor.updated_at.as_str(),
                    cursor.session_id.as_str(),
                    bounded_limit
                ],
                |row| {
                    let source = match row.get::<_, String>(2)?.as_str() {
                        "agent" => PinnedNativeSource::Agent,
                        "cli" => PinnedNativeSource::Cli,
                        _ => unreachable!("pinned source is a SQL literal"),
                    };
                    Ok(PinnedNativeRow {
                        session_id: row.get(0)?,
                        source,
                    })
                },
            )
            .map_err(|err| format!("Query pinned sidebar page: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Read pinned sidebar page: {err}"))?;
        rows
    } else {
        let sql = base
            .replace("{agent_cursor}", "")
            .replace("{cli_cursor}", "")
            .replace("{limit_parameter}", "?5");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Prepare pinned sidebar page: {err}"))?;
        let rows = stmt
            .query_map(
                params![
                    SessionStatus::Archived.as_str(),
                    session_type::CODING,
                    session_type::DESKTOP,
                    session_type::HUMAN,
                    bounded_limit
                ],
                |row| {
                    let source = match row.get::<_, String>(2)?.as_str() {
                        "agent" => PinnedNativeSource::Agent,
                        "cli" => PinnedNativeSource::Cli,
                        _ => unreachable!("pinned source is a SQL literal"),
                    };
                    Ok(PinnedNativeRow {
                        session_id: row.get(0)?,
                        source,
                    })
                },
            )
            .map_err(|err| format!("Query pinned sidebar page: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Read pinned sidebar page: {err}"))?;
        rows
    };

    let mut resolver = AgentMetadataResolver::new();
    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        match row.source {
            PinnedNativeSource::Cli => {
                if let Some(session) = cli_session_persistence::get_session(&row.session_id)
                    .map_err(|err| format!("Hydrate pinned CLI session: {err}"))?
                {
                    sessions.push(cli_session_to_aggregate_record(session));
                }
            }
            PinnedNativeSource::Agent => {
                let Some(session) = session_persistence::get_session(&row.session_id)
                    .map_err(|err| format!("Hydrate pinned agent session: {err}"))?
                else {
                    continue;
                };
                match session.session_type.as_str() {
                    session_type::CODING => {
                        sessions.push(sde_session_to_aggregate_record(session, &mut resolver));
                    }
                    session_type::DESKTOP => {
                        sessions.push(os_session_to_aggregate_record(session, &mut resolver));
                    }
                    session_type::HUMAN => {
                        sessions.push(human_session_to_aggregate_record(session));
                    }
                    _ => {}
                }
            }
        }
    }
    annotate_agent_org_root_rows(&mut sessions)?;
    Ok(sessions)
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
    use agent_core::session::persistence::UnifiedSessionRecord;

    #[test]
    fn pi_external_history_loader_is_registered_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_PI)
                .count(),
            1
        );
    }

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
            repo_root_path: None,
            repo_remote_urls: None,
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
            product_mode: None,
            draft_text: None,
            reply_target_event_id: None,
            pinned: false,
            files_changed: None,
            lines_added: None,
            lines_removed: None,
            touched_files: None,
            client_origin: None,
            client_origin_raw: None,
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
    fn desktop_external_history_loaders_include_qwen_code_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_QWEN_CODE)
                .count(),
            1
        );
    }

    #[test]
    fn desktop_external_history_loaders_include_kimi_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_KIMI)
                .count(),
            1
        );
    }

    #[test]
    fn desktop_external_history_loaders_include_copilot_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_COPILOT)
                .count(),
            1
        );
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

    #[test]
    fn native_sidebar_page_rejects_unbounded_limits_before_querying() {
        for invalid_limit in [0, NATIVE_SIDEBAR_PAGE_MAX_LIMIT + 1] {
            let error = list_native_sidebar_sessions(
                NativeSidebarSessionStream::StandaloneAgent,
                None,
                invalid_limit,
            )
            .expect_err("invalid native sidebar limit must fail");
            assert!(error.contains("between 1 and 50"));
        }
    }

    #[test]
    fn pinned_native_page_merges_agent_and_cli_roots_in_stable_order() {
        let _sandbox = crate::test_utils::test_env::sandbox();
        let conn = get_connection().expect("sandbox database");

        for (session_id, session_type, updated_at, pinned, parent, status) in [
            (
                "sdeagent-pinned",
                session_type::CODING,
                "2026-07-30T14:00:00Z",
                true,
                None,
                "idle",
            ),
            (
                "osagent-pinned",
                session_type::DESKTOP,
                "2026-07-30T12:00:00Z",
                true,
                None,
                "idle",
            ),
            (
                "humansession-pinned",
                session_type::HUMAN,
                "2026-07-30T11:00:00Z",
                true,
                None,
                "completed",
            ),
            (
                "sdeagent-unpinned",
                session_type::CODING,
                "2026-07-30T16:00:00Z",
                false,
                None,
                "idle",
            ),
            (
                "sdeagent-worker",
                session_type::CODING,
                "2026-07-30T15:00:00Z",
                true,
                Some("sdeagent-pinned"),
                "running",
            ),
            (
                "sdeagent-archived",
                session_type::CODING,
                "2026-07-30T13:00:00Z",
                true,
                None,
                "archived",
            ),
        ] {
            session_persistence::upsert_session(&UnifiedSessionRecord {
                session_id: session_id.to_string(),
                name: session_id.to_string(),
                status: status.to_string(),
                session_type: session_type.to_string(),
                parent_session_id: parent.map(str::to_string),
                created_at: updated_at.to_string(),
                updated_at: updated_at.to_string(),
                pinned,
                ..Default::default()
            })
            .expect("seed native session");
        }

        for (session_id, updated_at, pinned, parent) in [
            ("cliagent-pinned", "2026-07-30T13:00:00Z", true, None),
            ("cliagent-unpinned", "2026-07-30T17:00:00Z", false, None),
            (
                "cliagent-worker",
                "2026-07-30T16:00:00Z",
                true,
                Some("cliagent-pinned"),
            ),
        ] {
            conn.execute(
                "INSERT INTO code_sessions (
                    session_id, cli_agent_type, created_at, updated_at,
                    pinned, parent_session_id
                 ) VALUES (?1, 'codex', ?2, ?2, ?3, ?4)",
                params![session_id, updated_at, pinned, parent],
            )
            .expect("seed CLI session");
        }

        let page = list_native_sidebar_sessions(NativeSidebarSessionStream::PinnedNative, None, 10)
            .expect("load global pinned page");

        assert_eq!(
            page.sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "sdeagent-pinned",
                "cliagent-pinned",
                "osagent-pinned",
                "humansession-pinned",
            ]
        );
        assert!(page.sessions.iter().all(|session| session.pinned));
        assert!(!page.has_more);
    }

    #[test]
    fn native_sidebar_wire_contract_is_camel_case_and_rejects_unknown_streams() {
        let response = NativeSidebarSessionPageResponse {
            sessions: Vec::new(),
            next_cursor: Some(NativeSidebarSessionCursor {
                updated_at: "2026-07-30T12:00:00Z".to_string(),
                session_id: "sdeagent-10".to_string(),
            }),
            has_more: true,
        };
        let value = serde_json::to_value(response).expect("serialize page");

        assert_eq!(value["nextCursor"]["updatedAt"], "2026-07-30T12:00:00Z");
        assert_eq!(value["nextCursor"]["sessionId"], "sdeagent-10");
        assert_eq!(value["hasMore"], true);
        assert!(
            serde_json::from_value::<NativeSidebarSessionStream>(serde_json::json!(
                "unknownStream"
            ))
            .is_err()
        );
    }
}
