//! `orgtrack_core_session_signals` — the per-session projection behind the
//! builder profile.
//!
//! Derived state, exactly like [`crate::session_usage`]: one immutable row per
//! session, safe to drop and rebuild, keyed by [`SIGNALS_VERSION`] so an
//! extractor change invalidates stale rows automatically.
//!
//! **Lazily, not eagerly.** Extracting signals means parsing a transcript, and
//! there are tens of thousands of them. A row is computed on demand and cached;
//! [`backfill_session_signals`] tops up the rest in bounded batches, driven by
//! the panel while it is open. A profile is an aggregate, so a fill limited to
//! sessions the user happened to open would bias it — the newest-first batch
//! top-up is what keeps it representative.
//!
//! Rows hold aggregates only: counts, ratios, shares and activity spans. No
//! message text and no file paths are persisted here.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::signals::{self, SessionSignals, SIGNALS_VERSION};
use crate::sources::imported_history::load_activity_chunks_for_session;

/// Table owned by this module.
pub const TABLE: &str = "orgtrack_core_session_signals";

/// Add a column to an existing table. `CREATE TABLE IF NOT EXISTS` is a no-op
/// once the table exists, so every column added after the first release needs
/// one of these or installs that already have the table break on the next read.
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let existing = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in existing {
        if name? == column {
            return Ok(());
        }
    }
    drop(statement);
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS orgtrack_core_session_signals (
            session_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            signals_version INTEGER NOT NULL,
            started_at_ms INTEGER NOT NULL DEFAULT 0,
            active_secs REAL NOT NULL DEFAULT 0,
            active_spans_json TEXT NOT NULL DEFAULT '[]',
            has_edit INTEGER NOT NULL DEFAULT 0,
            postedit_turns INTEGER NOT NULL DEFAULT 0,
            unreadable INTEGER NOT NULL DEFAULT 0,
            signals_json TEXT NOT NULL,
            computed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ocss_source ON orgtrack_core_session_signals(source);
        CREATE INDEX IF NOT EXISTS idx_ocss_started ON orgtrack_core_session_signals(started_at_ms);
        CREATE INDEX IF NOT EXISTS idx_ocss_version ON orgtrack_core_session_signals(signals_version);
        CREATE TABLE IF NOT EXISTS orgtrack_core_profile_cache (
            scope_key TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            computed_at TEXT NOT NULL
        );
        ",
    )?;
    // Columns added after the table shipped.
    ensure_column(conn, TABLE, "unreadable", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .map_err(|err| err.to_string())
}

pub fn upsert(conn: &Connection, s: &SessionSignals) -> Result<(), String> {
    let spans = serde_json::to_string(&s.active_spans).map_err(|e| e.to_string())?;
    let blob = serde_json::to_string(s).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO orgtrack_core_session_signals (
             session_id, source, signals_version, started_at_ms, active_secs,
             active_spans_json, has_edit, postedit_turns, signals_json, computed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(session_id) DO UPDATE SET
             source = excluded.source,
             signals_version = excluded.signals_version,
             started_at_ms = excluded.started_at_ms,
             active_secs = excluded.active_secs,
             active_spans_json = excluded.active_spans_json,
             has_edit = excluded.has_edit,
             postedit_turns = excluded.postedit_turns,
             signals_json = excluded.signals_json,
             computed_at = excluded.computed_at",
        params![
            s.session_id,
            s.source,
            s.signals_version,
            s.started_at_ms,
            s.active_secs,
            spans,
            i64::from(s.has_edit),
            s.postedit_turns,
            blob,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

/// Parse a transcript and cache its signals. This is the expensive path; every
/// caller should prefer [`load_signals`] and let the backfill do the work.
pub fn recompute_session_signals(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionSignals>, String> {
    let Some(chunks) = load_activity_chunks_for_session(conn, session_id)? else {
        return Ok(None);
    };
    let source = source_of(conn, session_id).unwrap_or_else(|| "unknown".to_string());
    let s = signals::extract(session_id, &source, &chunks);
    upsert(conn, &s)?;
    Ok(Some(s))
}

fn source_of(conn: &Connection, session_id: &str) -> Option<String> {
    for sql in [
        "SELECT source FROM orgtrack_core_sessions WHERE session_id = ?1",
        "SELECT source FROM imported_history_session_cache WHERE session_id = ?1",
    ] {
        if let Ok(Some(v)) = conn
            .query_row(sql, params![session_id], |row| row.get::<_, String>(0))
            .optional()
        {
            return Some(v);
        }
    }
    // Imported ids are prefixed with their provider slug: `claudecodeapp-<id>`.
    session_id.split_once('-').map(|(p, _)| p.to_string())
}

/// Cached signal rows, newest first. `sources` empty means every source.
pub fn load_signals(
    conn: &Connection,
    sources: &[String],
    since_ms: Option<i64>,
    limit: usize,
) -> Result<Vec<SessionSignals>, String> {
    if !table_exists(conn, TABLE)? {
        return Ok(Vec::new());
    }
    let mut sql = format!(
        "SELECT signals_json FROM {TABLE}
         WHERE signals_version = {SIGNALS_VERSION} AND unreadable = 0"
    );
    if !sources.is_empty() {
        let list = sources
            .iter()
            .map(|s| format!("'{}'", s.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" AND source IN ({list})"));
    }
    if let Some(ms) = since_ms {
        sql.push_str(&format!(" AND started_at_ms >= {ms}"));
    }
    sql.push_str(&format!(" ORDER BY started_at_ms DESC LIMIT {limit}"));

    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let blob = row.map_err(|e| e.to_string())?;
        if let Ok(s) = serde_json::from_str::<SessionSignals>(&blob) {
            out.push(s);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Computed-profile cache
//
// Signal rows make transcript parsing a once-per-session cost, but scoring is
// not free: a panel load computes a dozen-plus full profiles (global, one per
// tool, one per drift window), and each axis runs an anchor-sensitivity search.
// Measured at ~1s for a partial corpus, and it grows with history.
//
// So the finished payload is cached too, keyed by a fingerprint of the input
// set. Any new or re-extracted session changes the fingerprint and the next
// read recomputes; nothing has to remember to invalidate.
// ---------------------------------------------------------------------------

/// Identity of the current signal corpus. Changes whenever a row is added or
/// recomputed, or the extractor version moves.
///
/// Row deletion without a count change would not be caught, but rows are only
/// removed by a full rebuild, which changes the count.
pub fn corpus_fingerprint(conn: &Connection) -> Result<String, String> {
    if !table_exists(conn, TABLE)? {
        return Ok(format!("{SIGNALS_VERSION}:empty"));
    }
    let (count, newest): (i64, Option<String>) = conn
        .query_row(
            &format!(
                "SELECT COUNT(*), MAX(computed_at) FROM {TABLE}
                 WHERE signals_version = {SIGNALS_VERSION}"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "{SIGNALS_VERSION}:{count}:{}",
        newest.unwrap_or_default()
    ))
}

fn init_cache_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS orgtrack_core_profile_cache (
             scope_key TEXT PRIMARY KEY,
             fingerprint TEXT NOT NULL,
             payload_json TEXT NOT NULL,
             computed_at TEXT NOT NULL
         );",
    )
    .map_err(|err| err.to_string())
}

/// Cached payload for `scope_key`, if it was computed from this exact corpus.
pub fn cached_payload(
    conn: &Connection,
    scope_key: &str,
    fingerprint: &str,
) -> Result<Option<String>, String> {
    if !table_exists(conn, "orgtrack_core_profile_cache")? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT payload_json FROM orgtrack_core_profile_cache
         WHERE scope_key = ?1 AND fingerprint = ?2",
        params![scope_key, fingerprint],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub fn put_payload(
    conn: &Connection,
    scope_key: &str,
    fingerprint: &str,
    payload: &str,
) -> Result<(), String> {
    init_cache_table(conn)?;
    conn.execute(
        "INSERT INTO orgtrack_core_profile_cache
             (scope_key, fingerprint, payload_json, computed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope_key) DO UPDATE SET
             fingerprint = excluded.fingerprint,
             payload_json = excluded.payload_json,
             computed_at = excluded.computed_at",
        params![
            scope_key,
            fingerprint,
            payload,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

/// How much of the corpus has been processed so far. `extracted` counts every
/// session with a current-version row — including unreadable tombstones, so a
/// corpus with a few broken transcripts can still reach 100%. `unreadable`
/// reports those tombstones separately.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub extracted: i64,
    pub known: i64,
    pub stale: i64,
    pub unreadable: i64,
}

pub fn coverage(conn: &Connection) -> Result<Coverage, String> {
    if !table_exists(conn, TABLE)? {
        return Ok(Coverage::default());
    }
    let count = |sql: &str| -> i64 {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
    };
    let known = if table_exists(conn, "imported_history_session_cache")? {
        count("SELECT COUNT(*) FROM imported_history_session_cache")
    } else {
        0
    };
    Ok(Coverage {
        extracted: count(&format!(
            "SELECT COUNT(*) FROM {TABLE} WHERE signals_version = {SIGNALS_VERSION}"
        )),
        known,
        stale: count(&format!(
            "SELECT COUNT(*) FROM {TABLE} WHERE signals_version <> {SIGNALS_VERSION}"
        )),
        unreadable: count(&format!(
            "SELECT COUNT(*) FROM {TABLE}
             WHERE signals_version = {SIGNALS_VERSION} AND unreadable = 1"
        )),
    })
}

/// A session whose transcript yields no chunks (or fails to read) gets a
/// tombstone row: excluded from every reader, but it leaves the candidate set,
/// so the backfill cannot pin its batch on the same failures forever. A
/// [`SIGNALS_VERSION`] bump retries each of them once per extractor generation.
fn mark_unreadable(conn: &Connection, session_id: &str) -> Result<(), String> {
    let source = source_of(conn, session_id).unwrap_or_else(|| "unknown".to_string());
    conn.execute(
        &format!(
            "INSERT INTO {TABLE} (
                 session_id, source, signals_version, unreadable, signals_json, computed_at
             ) VALUES (?1, ?2, {SIGNALS_VERSION}, 1, '{{}}', ?3)
             ON CONFLICT(session_id) DO UPDATE SET
                 signals_version = excluded.signals_version,
                 unreadable = 1,
                 signals_json = excluded.signals_json,
                 computed_at = excluded.computed_at"
        ),
        params![session_id, source, chrono::Utc::now().to_rfc3339()],
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

/// Process up to `limit` sessions that have no current row. Newest first, so a
/// partially-filled profile describes recent behaviour rather than a random
/// slice of history.
///
/// Returns the number of sessions *processed* — extracted or tombstoned — so a
/// batch of unreadable transcripts still reports progress and the caller keeps
/// draining the backlog behind them.
pub fn backfill_session_signals(conn: &Connection, limit: usize) -> Result<usize, String> {
    if limit == 0 || !table_exists(conn, "imported_history_session_cache")? {
        return Ok(0);
    }
    init_tables(conn).map_err(|e| e.to_string())?;

    let mut candidates: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let sql = format!(
        "SELECT session_id FROM imported_history_session_cache
         WHERE session_id NOT IN (
             SELECT session_id FROM {TABLE} WHERE signals_version = {SIGNALS_VERSION}
         )
         ORDER BY created_at_ms DESC
         LIMIT ?1"
    );
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![limit as i64], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let id = row.map_err(|e| e.to_string())?;
        if seen.insert(id.clone()) {
            candidates.push(id);
        }
    }
    drop(statement);

    let mut done = 0usize;
    for id in candidates {
        match recompute_session_signals(conn, &id) {
            Ok(Some(_)) => done += 1,
            // No chunks, or the transcript would not read. Tombstone it so it
            // stops occupying the front of every future batch; if even the
            // tombstone write fails, skip it and let a later batch retry.
            Ok(None) | Err(_) => {
                if mark_unreadable(conn, &id).is_ok() {
                    done += 1;
                }
            }
        }
    }
    Ok(done)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

/// Read-only smoke test against the real local database.
///
/// Ignored by default: it depends on machine-local history, and it must never
/// write to a store the running app owns. Run with
/// `cargo test -p orgtrack_core real_local_history -- --ignored --nocapture`.
#[cfg(test)]
#[path = "store_real_data_tests.rs"]
mod real_data;

/// What the readers actually emit, counted over real local history.
///
/// The taxonomy in `signals::classify_tool` has to match reality across three
/// providers, and only Cursor has a full canonical map — Claude Code and Codex
/// pass most tool names through verbatim. This test prints what is really there
/// so the mapping is fixed from evidence rather than from guesswork, and so
/// drift in any reader shows up as `OTHER`.
#[cfg(test)]
#[path = "store_taxonomy_tests.rs"]
mod taxonomy;

/// What a panel load actually costs, on real local history.
#[cfg(test)]
#[path = "store_cost_tests.rs"]
mod cost;
