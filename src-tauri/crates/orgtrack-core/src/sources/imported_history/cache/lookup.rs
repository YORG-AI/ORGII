use std::time::UNIX_EPOCH;

use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};

use super::continuation::has_newer_continuation_sibling;
use super::session_row::{query_cached_sessions_by_filter_from_conn, ImportedHistoryCachedSession};

pub fn get_cached_source_path_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT source_path FROM imported_history_session_cache \
         WHERE source = ?1 AND source_session_id = ?2",
        params![source, source_session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("Failed to query imported history source path: {err}"))
}

/// Like [`get_cached_source_path_from_conn`], but also matches a
/// `-`-bounded suffix of the cached key. Codex imports key on the rollout
/// file stem (`rollout-<timestamp>-<thread-uuid>`) while runner bindings
/// carry the bare thread uuid; newest wins when several rollouts share a
/// thread (resume forks).
pub fn get_cached_source_path_by_suffix_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT source_path FROM imported_history_session_cache \
         WHERE source = ?1 \
           AND (source_session_id = ?2 OR source_session_id LIKE '%-' || ?2) \
         ORDER BY updated_at_ms DESC LIMIT 1",
        params![source, source_session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("Failed to query imported history source path: {err}"))
}

/// Freshness stat of one imported session's transcript source file, keyed by
/// the app-level (prefixed) session id the frontend holds. Returns `Ok(None)`
/// when the session is not cached or the file is gone — callers fall back to
/// a full refresh, which re-syncs the cache.
///
/// SQLite-backed stores (Cursor, OpenCode, ZCode, …) run in WAL mode, where
/// commits land in the `-wal` sibling without touching the main db's mtime
/// until a checkpoint. Fold the sibling into the signature so those sources
/// don't read as permanently unchanged.
pub fn stat_imported_transcript_by_session_id_from_conn(
    conn: &Connection,
    source: &str,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let path: Option<String> = conn
        .query_row(
            "SELECT source_path FROM imported_history_session_cache \
             WHERE source = ?1 AND session_id = ?2 AND source_path != ''",
            params![source, session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Failed to query imported history source path: {err}"))?;
    let Some(path) = path else {
        return Ok(None);
    };

    let Ok(main) = std::fs::metadata(&path) else {
        return Ok(None);
    };
    let mut mtime_ms = metadata_mtime_epoch_ms(&main);
    let mut size_bytes = main.len();
    if let Ok(wal) = std::fs::metadata(format!("{path}-wal")) {
        mtime_ms = mtime_ms.max(metadata_mtime_epoch_ms(&wal));
        size_bytes += wal.len();
    }
    Ok(Some((mtime_ms, size_bytes)))
}

fn metadata_mtime_epoch_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn query_cached_session_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<ImportedHistoryCachedSession>, String> {
    let sessions = query_cached_sessions_by_filter_from_conn(
        conn,
        source,
        "source_session_id = ?2",
        &[SqlValue::from(source_session_id.to_string())],
        1,
        0,
    )?;
    Ok(sessions.into_iter().next())
}

/// Resolve one canonical session ID without scanning paginated source rows.
///
/// Sidebar deep links use the canonical ID rendered by the rest of ORGII,
/// while the cache primary key is `(source, source_session_id)`. Resolve the
/// source first, then reuse the canonical row decoder so the targeted and
/// paginated paths cannot drift in field handling.
///
/// Continuation-superseded siblings resolve to `None`: a context-window
/// continuation copies the whole conversation into a newer session file, so
/// the family's newest sibling is the only row exact-id resolution may
/// surface. Without this, by-id hydration (deep links, open-tab/pinned row
/// hydration, cloud My-sessions hydration) re-adds rows the listing demoted
/// and one conversation shows once per continuation rewrite. Other unlistable
/// rows (subagents, managed mirrors) still resolve — callers rely on that for
/// parent placement and replay.
///
/// Existence checks that must treat a demoted sibling as still-present (the
/// cloud vanished-session sweep) use
/// `query_cached_session_by_session_id_including_superseded_from_conn`.
pub fn query_cached_session_by_session_id_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, ImportedHistoryCachedSession)>, String> {
    query_cached_session_by_session_id_impl(conn, session_id, false)
}

/// Exact-id resolution WITHOUT the continuation-supersession filter: a row
/// demoted by the continuation election still resolves. The cloud
/// vanished-session sweep confirms suspects through this path — a superseded
/// sibling has not vanished locally, and reporting it absent would retract
/// the team's shared cloud session on every context-window continuation.
pub fn query_cached_session_by_session_id_including_superseded_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, ImportedHistoryCachedSession)>, String> {
    query_cached_session_by_session_id_impl(conn, session_id, true)
}

fn query_cached_session_by_session_id_impl(
    conn: &Connection,
    session_id: &str,
    include_continuation_superseded: bool,
) -> Result<Option<(String, ImportedHistoryCachedSession)>, String> {
    let source = conn
        .query_row(
            "SELECT source FROM imported_history_session_cache WHERE session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| {
            format!("Failed to resolve imported history source for {session_id}: {err}")
        })?;
    let Some(source) = source else {
        return Ok(None);
    };
    let sessions = query_cached_sessions_by_filter_from_conn(
        conn,
        &source,
        "session_id = ?2",
        &[SqlValue::from(session_id.to_string())],
        1,
        0,
    )?;
    let Some(session) = sessions.into_iter().next() else {
        return Ok(None);
    };
    if !include_continuation_superseded && has_newer_continuation_sibling(conn, &source, &session)?
    {
        return Ok(None);
    }
    Ok(Some((source, session)))
}
