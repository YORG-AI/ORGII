//! SQLite CRUD operations for session event persistence
//!
//! All functions are synchronous (`rusqlite`) and must be called from a
//! blocking thread (e.g. inside `tokio::task::spawn_blocking`).
//!
//! Operations: `save_events`, `load_events`, `delete_session`,
//! `update_session_metadata`, `get_session_metadata`.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

use database::db::get_db_path;

use super::connection::{begin_immediate, get_connection, with_sessions_writer};
use super::sequence::{get_next_sequence, increment_sequence, reset_sequence};
use super::types::{
    CacheStats, CachedEvent, CachedSession, CrossSessionSearchHit, SearchResult, SessionMetadata,
};

/// TS-side per-delta placeholder IDs are live-only display artifacts and must
/// never be persisted (see `cache_bridge::is_ts_placeholder_id` for the full
/// rationale). This is the last line of defense: every `save_events` caller
/// should already have filtered them upstream, but duplicating the check here
/// means a future caller that forgets cannot pollute the DB.
fn is_ts_placeholder_id(id: &str) -> bool {
    id.starts_with("stream-msg-ts-") || id.starts_with("stream-think-ts-")
}

/// Return the `history_sequence` already persisted for `event_id`, if the
/// row exists. Used by `save_events` so a frontend re-submission cannot
/// clobber the server-assigned sequence.
fn existing_event_sequence(
    conn: &Connection,
    session_id: &str,
    event_id: &str,
) -> SqliteResult<Option<i64>> {
    conn.query_row(
        "SELECT history_sequence FROM events
         WHERE session_id = ?1 AND id = ?2",
        params![session_id, event_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|opt| opt.flatten())
}

pub(crate) fn normalize_session_sequences(conn: &Connection, session_id: &str) -> SqliteResult<()> {
    let mut stmt = conn.prepare_cached(
        "SELECT id FROM events
         WHERE session_id = ?1
         ORDER BY created_at ASC, COALESCE(history_sequence, rowid) ASC, id ASC",
    )?;
    let event_ids = stmt
        .query_map([session_id], |row| row.get::<_, String>(0))?
        .collect::<SqliteResult<Vec<_>>>()?;

    for (idx, event_id) in event_ids.iter().enumerate() {
        conn.execute(
            "UPDATE events
             SET history_sequence = ?1
             WHERE session_id = ?2 AND id = ?3
               AND (history_sequence IS NULL OR history_sequence != ?1)",
            params![idx as i64, session_id, event_id],
        )?;
    }

    reset_sequence(session_id, event_ids.len() as i64);
    Ok(())
}

fn upsert_event_rows(
    conn: &Connection,
    session_id: &str,
    events: &[CachedEvent],
) -> SqliteResult<bool> {
    get_next_sequence(conn, session_id)?;
    let mut content_changed = false;

    // Conflict target is the PRIMARY KEY (id). The table also carries
    // UNIQUE(id, session_id), but that constraint cannot conflict without
    // the PK conflicting on the same row, so the single target is unambiguous.
    let mut stmt = conn.prepare_cached(
        "INSERT INTO events
         (id, session_id, event_type, function_name, thread_id, args_json, result_json,
          content, created_at, meta_json, history_sequence)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
             session_id       = excluded.session_id,
             event_type       = excluded.event_type,
             function_name    = excluded.function_name,
             thread_id        = excluded.thread_id,
             args_json        = excluded.args_json,
             result_json      = excluded.result_json,
             content          = excluded.content,
             created_at       = excluded.created_at,
             meta_json        = excluded.meta_json,
             history_sequence = excluded.history_sequence
         WHERE events.session_id       IS NOT excluded.session_id
            OR events.event_type       IS NOT excluded.event_type
            OR events.function_name    IS NOT excluded.function_name
            OR events.thread_id        IS NOT excluded.thread_id
            OR events.args_json        IS NOT excluded.args_json
            OR events.result_json      IS NOT excluded.result_json
            OR events.content          IS NOT excluded.content
            OR events.created_at       IS NOT excluded.created_at
            OR events.meta_json        IS NOT excluded.meta_json
            OR events.history_sequence IS NOT excluded.history_sequence",
    )?;

    for event in events {
        if is_ts_placeholder_id(&event.id) {
            continue;
        }
        // The frontend's in-memory event cache does NOT track the server-owned
        // sequence stamp. Keep a persisted value on resubmission and allocate
        // a new monotonic value only for a genuinely new event.
        let seq = match event.history_sequence {
            Some(seq) => seq,
            None => existing_event_sequence(conn, session_id, &event.id)?
                .unwrap_or_else(|| increment_sequence(session_id)),
        };

        content_changed |= stmt.execute(params![
            event.id,
            event.session_id,
            event.event_type,
            event.function_name,
            event.thread_id,
            event.args_json,
            event.result_json,
            event.content,
            event.created_at,
            event.meta_json,
            seq,
        ])? > 0;
    }
    Ok(content_changed)
}

fn refresh_session_metadata_from_events(
    conn: &Connection,
    session_id: &str,
    content_changed: bool,
) -> SqliteResult<usize> {
    let (event_count, time_start, time_end): (i64, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT COUNT(*), MIN(created_at), MAX(created_at)
             FROM events WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;

    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO sessions
         (session_id, event_count, cached_at, content_revision, time_range_start, time_range_end, specs_json)
         VALUES (?1, ?2, ?3, CASE WHEN ?6 THEN 1 ELSE 0 END, ?4, ?5, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
             event_count      = excluded.event_count,
             cached_at        = excluded.cached_at,
             content_revision = CASE
                 WHEN ?6 THEN sessions.content_revision + 1
                 ELSE sessions.content_revision
             END,
             time_range_start = excluded.time_range_start,
             time_range_end   = excluded.time_range_end",
        params![
            session_id,
            event_count,
            now,
            time_start,
            time_end,
            content_changed
        ],
    )?;
    Ok(event_count.max(0) as usize)
}

/// Save events to cache.
///
/// Runs under the process-wide writer serializer (`with_sessions_writer`)
/// with `BEGIN IMMEDIATE` so concurrent callers queue in Rust instead of
/// racing for `SQLITE_BUSY` mid-transaction.
///
/// Events are upserted (`ON CONFLICT(id) DO UPDATE ... WHERE <changed>`),
/// not `INSERT OR REPLACE`d: re-submitting an unchanged batch (which the
/// frontend does after every reload) is a true no-op that preserves rowids
/// and writes nothing, and a real change updates the row in place instead
/// of cycling a delete + insert.
///
/// `rebuild_turn_index` is **debounced** to run asynchronously rather
/// than synchronously at the tail of every batch. The streaming agent
/// pipeline emits hundreds of events per second across parent + child
/// sessions; doing an in-line rebuild after each batch doubles the
/// writer-mutex traffic (events INSERT, then index DELETE+INSERT) and
/// re-runs `normalize_session_sequences` over the full tail every time.
/// The turn index is eventually consistent — `load_turn_index` calls
/// `ensure_turn_index_fresh` which detects drift and rebuilds lazily,
/// so any reader always sees correct results. See
/// `turn_index_debounce` for the coalescing scheduler.
pub fn save_events(session_id: &str, events: &[CachedEvent]) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;

        let content_changed = upsert_event_rows(&conn, session_id, events)?;

        // `save_events` is incremental: callers may submit one newly
        // materialized Agent Org inbox event after a session already contains
        // a much older and a much newer event.  Deriving the cached range from
        // only this batch would shrink the session metadata and make history
        // pagination skip durable events.  Recompute from the transaction's
        // full event set instead.
        refresh_session_metadata_from_events(&conn, session_id, content_changed)?;
        normalize_session_sequences(&conn, session_id)?;

        tx.commit()?;
        Ok(())
    })?;
    super::turn_index_debounce::schedule(session_id);
    Ok(())
}

/// Append one replay-import batch without rescanning the already written
/// prefix. The caller must invoke [`finalize_deferred_event_import`] after the
/// last batch; until then no session metadata or turn index is published.
pub fn save_events_deferred(session_id: &str, events: &[CachedEvent]) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        upsert_event_rows(&conn, session_id, events)?;
        tx.commit()?;
        Ok(())
    })
}

/// Publish a deferred replay import with one O(n) metadata/sequence pass and
/// schedule one turn-index rebuild. This replaces O(page_count × n) work.
pub fn finalize_deferred_event_import(session_id: &str) -> SqliteResult<usize> {
    let event_count = with_sessions_writer(|| -> SqliteResult<usize> {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        let count = refresh_session_metadata_from_events(&conn, session_id, true)?;
        normalize_session_sequences(&conn, session_id)?;
        tx.commit()?;
        Ok(count)
    })?;
    super::turn_index_debounce::schedule(session_id);
    Ok(event_count)
}

/// Count persisted events for a session without loading them.
///
/// A pure read: no sequence normalization and no writer serializer, so it
/// stays cheap even while a large import batch holds the writer lock. Used
/// as the cache-hit probe for imported replays, where `load_events` on a
/// 100k-event session just to check non-emptiness is prohibitive.
pub fn count_events(session_id: &str) -> SqliteResult<i64> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )
}

/// Load all events for a session.
///
/// `normalize_session_sequences` is a writer (per-row UPDATEs) so it
/// runs under the writer serializer. The subsequent SELECT does not
/// need the lock and runs on the same connection after the guard
/// drops.
pub fn load_events(session_id: &str) -> SqliteResult<Vec<CachedEvent>> {
    let conn = get_connection()?;
    with_sessions_writer(|| -> SqliteResult<()> {
        normalize_session_sequences(&conn, session_id)?;
        Ok(())
    })?;
    let mut stmt = conn.prepare_cached(
        "SELECT id, session_id, event_type, function_name, thread_id,
                args_json, result_json, content, created_at, meta_json, history_sequence
         FROM events
         WHERE session_id = ?1
         ORDER BY history_sequence ASC, created_at ASC, id ASC",
    )?;

    let events = stmt
        .query_map([session_id], |row| {
            Ok(CachedEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                event_type: row.get(2)?,
                function_name: row.get(3)?,
                thread_id: row.get(4)?,
                args_json: row.get(5)?,
                result_json: row.get(6)?,
                content: row.get(7)?,
                created_at: row.get(8)?,
                meta_json: row.get(9)?,
                history_sequence: row.get(10)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(events)
}

/// Byte radius of the excerpt window taken on each side of the first match
/// (snapped outward to char boundaries).
const EXCERPT_RADIUS_BYTES: usize = 60;

/// Escape `%`, `_`, and `\` so a user-supplied query matches literally
/// inside a `LIKE '%' || ? || '%' ESCAPE '\'` pattern.
fn escape_like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + 4);
    for ch in query.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// Byte offset of the first ASCII-case-insensitive occurrence of `needle`
/// in `haystack`. Mirrors SQLite's default `LIKE` semantics (ASCII-only
/// case folding) so the excerpt window lands on the same match the SQL
/// predicate found. Both offsets of a hit are guaranteed char boundaries:
/// a valid-UTF-8 needle can never start or end mid-sequence in a
/// valid-UTF-8 haystack.
fn ascii_case_insensitive_find(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Rust-side replacement for the FTS5 `snippet()` auxiliary function: the
/// first case-insensitive match of `query` in `content` is wrapped in
/// `<mark>` tags with ~[`EXCERPT_RADIUS_BYTES`] of context on each side and
/// `...` on the clipped edges. Falls back to a plain content prefix when the
/// match is in another searched column (`function_name` / `args_json`) or
/// `content` is empty.
fn build_excerpt(content: &str, query: &str) -> String {
    match ascii_case_insensitive_find(content, query) {
        Some(start) => {
            let end = start + query.len();
            let win_start =
                floor_char_boundary(content, start.saturating_sub(EXCERPT_RADIUS_BYTES));
            let win_end = ceil_char_boundary(content, end + EXCERPT_RADIUS_BYTES);
            let mut excerpt = String::with_capacity(win_end - win_start + 19);
            if win_start > 0 {
                excerpt.push_str("...");
            }
            excerpt.push_str(&content[win_start..start]);
            excerpt.push_str("<mark>");
            excerpt.push_str(&content[start..end]);
            excerpt.push_str("</mark>");
            excerpt.push_str(&content[end..win_end]);
            if win_end < content.len() {
                excerpt.push_str("...");
            }
            excerpt
        }
        None => {
            let prefix_end = floor_char_boundary(content, 2 * EXCERPT_RADIUS_BYTES);
            let mut excerpt = content[..prefix_end].to_string();
            if prefix_end < content.len() {
                excerpt.push_str("...");
            }
            excerpt
        }
    }
}

/// Substring search within a session.
///
/// LIKE scan over `events` — the FTS5 index was dropped (see
/// `schema::drop_events_fts`). Matching is ASCII-case-insensitive (SQLite
/// `LIKE` default; non-ASCII case differences do not match) and `%`/`_` in
/// the query are escaped so they match literally. Results are newest-first;
/// `rank` is the 0-based position in that order, preserving the FTS-era
/// "ascending rank = better" wire contract.
pub fn search_events(session_id: &str, query: &str, limit: i64) -> SqliteResult<Vec<SearchResult>> {
    let conn = get_connection()?;
    let pattern = escape_like_pattern(query);

    let mut stmt = conn.prepare_cached(
        "SELECT id, session_id, event_type, function_name, thread_id,
                args_json, result_json, content, created_at, meta_json, history_sequence
         FROM events
         WHERE session_id = ?1
           AND (content LIKE '%' || ?2 || '%' ESCAPE '\\'
                OR function_name LIKE '%' || ?2 || '%' ESCAPE '\\'
                OR args_json LIKE '%' || ?2 || '%' ESCAPE '\\')
         ORDER BY created_at DESC
         LIMIT ?3",
    )?;

    let events = stmt
        .query_map(params![session_id, pattern, limit], |row| {
            Ok(CachedEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                event_type: row.get(2)?,
                function_name: row.get(3)?,
                thread_id: row.get(4)?,
                args_json: row.get(5)?,
                result_json: row.get(6)?,
                content: row.get(7)?,
                created_at: row.get(8)?,
                meta_json: row.get(9)?,
                history_sequence: row.get(10)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(events
        .into_iter()
        .enumerate()
        .map(|(idx, event)| {
            let snippet = build_excerpt(&event.content, query);
            SearchResult {
                event,
                rank: idx as f64,
                snippet,
            }
        })
        .collect())
}

/// Substring search across all sessions. Agent events and Human-session notes
/// share one bounded result set. Returns one hit per session — the most recent
/// matching entry (`MAX(created_at)`; SQLite's bare-column guarantee pins
/// `content` to that row). Sessions are ordered newest-hit first; `rank` is the
/// 0-based position in that order. LIKE semantics are documented on
/// [`search_events`]. Each source is reduced to at most the requested limit
/// before the final merge, and public callers are capped at 100 results. The
/// caller should join with the session list API to resolve display names.
pub fn search_all_sessions(query: &str, limit: i64) -> SqliteResult<Vec<CrossSessionSearchHit>> {
    if query.trim().is_empty() || limit <= 0 {
        return Ok(Vec::new());
    }

    let conn = get_connection()?;
    let pattern = escape_like_pattern(query);
    let limit = limit.min(100);

    let mut stmt = conn.prepare_cached(
        "WITH latest_events AS (
             SELECT session_id, content, MAX(created_at) AS created_at
             FROM events
             WHERE content LIKE '%' || ?1 || '%' ESCAPE '\\'
                OR function_name LIKE '%' || ?1 || '%' ESCAPE '\\'
                OR args_json LIKE '%' || ?1 || '%' ESCAPE '\\'
             GROUP BY session_id
             ORDER BY created_at DESC
             LIMIT ?2
         ),
         latest_human_entries AS (
             SELECT session_id, body AS content, MAX(created_at) AS created_at
             FROM human_session_entries
             WHERE body LIKE '%' || ?1 || '%' ESCAPE '\\'
             GROUP BY session_id
             ORDER BY created_at DESC
             LIMIT ?2
         ),
         candidates AS (
             SELECT session_id, content, created_at FROM latest_events
             UNION ALL
             SELECT session_id, content, created_at FROM latest_human_entries
         )
         SELECT session_id, content, MAX(created_at) AS created_at
         FROM candidates
         GROUP BY session_id
         ORDER BY created_at DESC
         LIMIT ?2",
    )?;

    let rows = stmt
        .query_map(params![pattern, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(rows
        .into_iter()
        .enumerate()
        .map(
            |(idx, (session_id, content, timestamp))| CrossSessionSearchHit {
                session_id,
                snippet: build_excerpt(&content, query),
                timestamp,
                rank: idx as f64,
            },
        )
        .collect())
}

/// Get session metadata
pub fn get_session_metadata(session_id: &str) -> SqliteResult<Option<SessionMetadata>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare_cached(
        "SELECT session_id, event_count, cached_at, content_revision, time_range_start, time_range_end, specs_json
         FROM sessions WHERE session_id = ?1",
    )?;

    let result = stmt.query_row([session_id], |row| {
        Ok(SessionMetadata {
            session_id: row.get(0)?,
            event_count: row.get(1)?,
            cached_at: row.get(2)?,
            content_revision: row.get(3)?,
            time_range_start: row.get(4)?,
            time_range_end: row.get(5)?,
            specs_json: row.get(6)?,
        })
    });

    match result {
        Ok(meta) => Ok(Some(meta)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Delete a session and its events.
///
/// All four DELETEs run inside a single `BEGIN IMMEDIATE` transaction
/// under the writer serializer so the cascade is atomic with respect to
/// other writers — a concurrent `save_events` cannot observe a half-
/// deleted session (events gone, sessions row still present).
pub fn delete_session(session_id: &str) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        tx.execute("DELETE FROM events WHERE session_id = ?1", [session_id])?;
        tx.execute(
            "DELETE FROM session_turns WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute(
            "DELETE FROM session_turn_index_state WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute("DELETE FROM sessions WHERE session_id = ?1", [session_id])?;
        tx.commit()?;
        app_paths::cleanup_scratchpad_by_session_id(session_id);
        Ok(())
    })
}

/// Clear sessions older than TTL.
///
/// The lookup is split from the deletes so the writer lock is held only
/// while DELETEs and the optional `incremental_vacuum` run. SELECTs are
/// concurrent under WAL and do not need the writer lock.
pub fn clear_old_sessions(max_age_hours: i64) -> SqliteResult<i64> {
    let cutoff = Utc::now().timestamp() - (max_age_hours * 3600);

    let session_ids: Vec<String> = {
        let conn = get_connection()?;
        // `session_id` is `TEXT NOT NULL`, so `row.get(0)` should never
        // fail in practice — but if it does (e.g. future schema drift),
        // surfacing the error prevents silently skipping the per-session
        // cleanup while the bulk `DELETE FROM sessions` below still
        // succeeds and orphans the child rows.
        let mut stmt = conn.prepare("SELECT session_id FROM sessions WHERE cached_at < ?1")?;
        let ids = stmt
            .query_map([cutoff], |row| row.get(0))?
            .collect::<SqliteResult<Vec<String>>>()?;
        ids
    };

    let count = session_ids.len() as i64;

    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;
        for sid in &session_ids {
            tx.execute("DELETE FROM events WHERE session_id = ?1", [sid])?;
            // Best-effort cascade of session-keyed satellite tables owned by
            // other crates (same `sessions.db`). `let _ =` tolerates a table
            // not yet existing on a fresh DB, matching `agent_snapshots`.
            let _ = tx.execute("DELETE FROM agent_snapshots WHERE session_id = ?1", [sid]);
            let _ = tx.execute("DELETE FROM goal_loop_state WHERE session_id = ?1", [sid]);
            let _ = tx.execute(
                "DELETE FROM agent_member_interventions WHERE session_id = ?1",
                [sid],
            );
        }
        tx.execute("DELETE FROM sessions WHERE cached_at < ?1", [cutoff])?;
        tx.commit()?;

        // `incremental_vacuum` is a top-level PRAGMA and cannot run
        // inside the transaction. Reclaim space immediately after the
        // commit while still inside the writer lock so a concurrent
        // writer doesn't sneak between commit and vacuum.
        if count > 0 {
            conn.execute_batch("PRAGMA incremental_vacuum(100);")?;
        }
        Ok(())
    })?;

    Ok(count)
}

/// Get all session metadata
pub fn get_all_sessions() -> SqliteResult<Vec<SessionMetadata>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT session_id, event_count, cached_at, content_revision, time_range_start, time_range_end, specs_json
         FROM sessions ORDER BY cached_at DESC",
    )?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(SessionMetadata {
                session_id: row.get(0)?,
                event_count: row.get(1)?,
                cached_at: row.get(2)?,
                content_revision: row.get(3)?,
                time_range_start: row.get(4)?,
                time_range_end: row.get(5)?,
                specs_json: row.get(6)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(sessions)
}

/// Get cache statistics
pub fn get_cache_stats() -> SqliteResult<CacheStats> {
    let conn = get_connection()?;

    let total_sessions: i64 =
        conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;

    let total_events: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?;

    let db_path = get_db_path();
    let db_size_bytes = std::fs::metadata(&db_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    Ok(CacheStats {
        total_sessions,
        total_events,
        db_size_bytes,
    })
}

/// Helper to update session metadata after modifications.
/// Preserves existing specs_json when updating time range and event count.
pub(crate) fn update_session_metadata(conn: &Connection, session_id: &str) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    // Get new time range
    let time_range: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT MIN(created_at), MAX(created_at) FROM events WHERE session_id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((None, None));

    conn.execute(
        "INSERT INTO sessions (session_id, event_count, cached_at, content_revision, time_range_start, time_range_end, specs_json)
         VALUES (?1,
                 (SELECT COUNT(*) FROM events WHERE session_id = ?1),
                 ?2, 1, ?3, ?4, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
             event_count = excluded.event_count,
             cached_at   = excluded.cached_at,
             content_revision = sessions.content_revision + 1,
             time_range_start = excluded.time_range_start,
             time_range_end   = excluded.time_range_end",
        params![session_id, now, time_range.0, time_range.1],
    )?;

    Ok(())
}

/// Save a full session (events + specs + explicit timeRange) atomically.
///
/// Replaces all existing events for the session, sets specs_json, and
/// stores the caller-supplied timeRange instead of deriving it from events.
/// This is the preferred write path when the caller already has specs/timeRange
/// (e.g. migrated from IndexedDB).
pub fn save_session(session: &CachedSession) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let tx = begin_immediate(&conn)?;

        tx.execute(
            "DELETE FROM events WHERE session_id = ?1",
            [&session.session_id],
        )?;

        super::sequence::reset_sequence(&session.session_id, 0);

        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO events
             (id, session_id, event_type, function_name, thread_id, args_json, result_json,
              content, created_at, meta_json, history_sequence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;

        let mut persisted_count: i64 = 0;
        for (idx, event) in session.events.iter().enumerate() {
            if is_ts_placeholder_id(&event.id) {
                continue;
            }
            let seq = event.history_sequence.unwrap_or(idx as i64 + 1);
            stmt.execute(params![
                event.id,
                event.session_id,
                event.event_type,
                event.function_name,
                event.thread_id,
                event.args_json,
                event.result_json,
                event.content,
                event.created_at,
                event.meta_json,
                seq,
            ])?;
            persisted_count += 1;
        }
        drop(stmt);

        let now = Utc::now().timestamp();
        tx.execute(
            "INSERT INTO sessions
                 (session_id, event_count, cached_at, content_revision, time_range_start, time_range_end, specs_json)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
             ON CONFLICT(session_id) DO UPDATE SET
                 event_count = excluded.event_count,
                 cached_at = excluded.cached_at,
                 content_revision = sessions.content_revision + 1,
                 time_range_start = excluded.time_range_start,
                 time_range_end = excluded.time_range_end,
                 specs_json = excluded.specs_json",
            params![
                session.session_id,
                persisted_count,
                now,
                session.time_range_start,
                session.time_range_end,
                session.specs_json,
            ],
        )?;

        tx.commit()?;
        super::turn_index::rebuild_turn_index(&session.session_id)?;
        Ok(())
    })
}

/// Load full session data: events + specs_json + timeRange.
pub fn load_session(session_id: &str) -> SqliteResult<Option<CachedSession>> {
    let meta = get_session_metadata(session_id)?;
    let Some(meta) = meta else {
        return Ok(None);
    };
    let events = load_events(session_id)?;
    Ok(Some(CachedSession {
        session_id: session_id.to_string(),
        events,
        specs_json: meta.specs_json,
        time_range_start: meta.time_range_start,
        time_range_end: meta.time_range_end,
    }))
}

/// Update specs_json for an existing session without touching events.
pub fn update_session_specs(session_id: &str, specs_json: &str) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let affected = conn.execute(
            "UPDATE sessions SET specs_json = ?2 WHERE session_id = ?1",
            params![session_id, specs_json],
        )?;
        Ok(affected > 0)
    })
}

/// Find all events with a given `function_name` whose persisted
/// `meta_json.displayStatus` is `awaiting_user`, across all sessions.
///
/// Used by the startup plan-event repair scan: stranded `create_plan`
/// tool-call events whose pending-plan row was archived without the FE
/// patch ever landing must be finalized or they wedge the planning
/// indicator forever.
pub fn find_awaiting_user_events_by_function(
    function_name: &str,
) -> SqliteResult<Vec<CachedEvent>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, session_id, event_type, function_name, thread_id,
                args_json, result_json, content, created_at, meta_json, history_sequence
         FROM events
         WHERE function_name = ?1
           AND meta_json LIKE '%\"displayStatus\":\"awaiting_user\"%'",
    )?;
    let rows = stmt
        .query_map(params![function_name], |row| {
            Ok(CachedEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                event_type: row.get(2)?,
                function_name: row.get(3)?,
                thread_id: row.get(4)?,
                args_json: row.get(5)?,
                result_json: row.get(6)?,
                content: row.get(7)?,
                created_at: row.get(8)?,
                meta_json: row.get(9)?,
                history_sequence: row.get(10)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

/// Get event by ID
pub fn get_event(session_id: &str, event_id: &str) -> SqliteResult<Option<CachedEvent>> {
    let conn = get_connection()?;
    with_sessions_writer(|| -> SqliteResult<()> {
        normalize_session_sequences(&conn, session_id)?;
        Ok(())
    })?;

    let result = conn.query_row(
        "SELECT id, session_id, event_type, function_name, thread_id,
                args_json, result_json, content, created_at, meta_json, history_sequence
         FROM events
         WHERE session_id = ?1 AND id = ?2",
        params![session_id, event_id],
        |row| {
            Ok(CachedEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                event_type: row.get(2)?,
                function_name: row.get(3)?,
                thread_id: row.get(4)?,
                args_json: row.get(5)?,
                result_json: row.get(6)?,
                content: row.get(7)?,
                created_at: row.get(8)?,
                meta_json: row.get(9)?,
                history_sequence: row.get(10)?,
            })
        },
    );

    match result {
        Ok(event) => Ok(Some(event)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
#[path = "crud_tests.rs"]
mod tests;
