//! Imported (external) history rows for the merge path.
//!
//! Turns the registry's provider pages into `SessionAggregateRecord`s, applies
//! the live-status decoration those rows cannot carry themselves, and honours
//! the session-id / source / disabled-source shapes of `SessionFilter`.

use chrono::DateTime;
use database::db::get_connection;
use orgtrack_core::sources::imported_history::cache as imported_history_cache;
use orgtrack_core::sources::imported_history::IMPORTED_STATUS_COMPLETED;

use super::external_history::{
    ExternalHistoryPage, EXTERNAL_HISTORY_SOURCE_LOADERS, IMPORTED_HISTORY_PAGE_SIZE,
};
use crate::agent_sessions::session_directory::conversion::{
    cursor_ide_history_to_aggregate_record, imported_history_to_aggregate_record,
};
use crate::agent_sessions::session_directory::types::{SessionAggregateRecord, SessionFilter};

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
            record.is_active = super::super::status::is_active_status(status);
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

pub(super) fn load_imported_history_sessions(
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
