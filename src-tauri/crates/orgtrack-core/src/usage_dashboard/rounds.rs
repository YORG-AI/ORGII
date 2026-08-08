//! The unified per-round request log: native per-turn expansion, real
//! imported round rows, and the session-level fallback for imported sources
//! without round-level history. [`visit_rounds`] streams this set without
//! retaining it; [`UsageRoundRow`] is the shared per-round shape consumed by
//! the headline accumulator and the request-log page.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::pricing;

use super::{fetch_scoped_sessions, iso_to_ms, ScopedSession, UsageFilter};

const SCOPED_SESSION_TABLE: &str = "usage_dashboard_scoped_session";

/// A native per-turn token row selected inside the dashboard's scope/window.
struct NativeTurn {
    row_id: i64,
    session_id: String,
    created_at: String,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
}

struct ScopedSessionTableGuard<'a> {
    conn: &'a Connection,
}

impl Drop for ScopedSessionTableGuard<'_> {
    fn drop(&mut self) {
        let _ = self
            .conn
            .execute(&format!("DELETE FROM {SCOPED_SESSION_TABLE}"), []);
    }
}

/// Materialize only the already bucket/session-scoped ids. Both imported and
/// native round queries join this tiny temp table, so source filters are applied
/// before token rows cross the SQLite/Rust boundary.
fn prepare_scoped_session_table<'a>(
    conn: &'a Connection,
    sessions: &[ScopedSession],
) -> Result<ScopedSessionTableGuard<'a>, String> {
    conn.execute_batch(&format!(
        "CREATE TEMP TABLE IF NOT EXISTS {SCOPED_SESSION_TABLE} (
            session_id TEXT PRIMARY KEY,
            is_native INTEGER NOT NULL
         ) WITHOUT ROWID;
         DELETE FROM {SCOPED_SESSION_TABLE};
         SAVEPOINT usage_dashboard_scoped_session_load;"
    ))
    .map_err(|err| err.to_string())?;

    let load_result = (|| {
        let mut insert = conn
            .prepare(&format!(
                "INSERT INTO {SCOPED_SESSION_TABLE} (session_id, is_native)
                 VALUES (?1, ?2)"
            ))
            .map_err(|err| err.to_string())?;
        for session in sessions {
            insert
                .execute(rusqlite::params![
                    session.session_id,
                    i64::from(session.tokens_source == crate::session_usage::TOKENS_SOURCE_NATIVE)
                ])
                .map_err(|err| err.to_string())?;
        }
        Ok::<(), String>(())
    })();

    if let Err(err) = load_result {
        let _ = conn.execute_batch(
            "ROLLBACK TO usage_dashboard_scoped_session_load;
             RELEASE usage_dashboard_scoped_session_load;",
        );
        let _ = conn.execute(&format!("DELETE FROM {SCOPED_SESSION_TABLE}"), []);
        return Err(err);
    }
    conn.execute_batch("RELEASE usage_dashboard_scoped_session_load;")
        .map_err(|err| err.to_string())?;
    Ok(ScopedSessionTableGuard { conn })
}

fn native_turn_query(filter: &UsageFilter) -> (String, Vec<String>) {
    let mut clauses = vec!["scoped.is_native = 1".to_string()];
    let mut params = Vec::new();
    if let Some(start) = filter.start_ms.and_then(rfc3339_ms_bound) {
        params.push(start);
        clauses.push(format!("stu.created_at >= ?{}", params.len()));
    }
    if let Some(end) = filter
        .end_ms
        .and_then(|end| rfc3339_ms_bound(end.saturating_add(1)))
    {
        params.push(end);
        clauses.push(format!("stu.created_at < ?{}", params.len()));
    }
    (
        format!(
            "SELECT stu.id, stu.session_id, stu.created_at, stu.model,
                    stu.input_tokens, stu.output_tokens,
                    stu.cache_read_tokens, stu.cache_write_tokens
             FROM session_token_usage stu
             INNER JOIN {SCOPED_SESSION_TABLE} scoped
                     ON scoped.session_id = stu.session_id
             WHERE {}
             ORDER BY stu.session_id, stu.created_at, stu.id",
            clauses.join(" AND ")
        ),
        params,
    )
}

fn fetch_native_turns(conn: &Connection, filter: &UsageFilter) -> Result<Vec<NativeTurn>, String> {
    let (sql, params) = native_turn_query(filter);
    let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(NativeTurn {
                row_id: row.get(0)?,
                session_id: row.get(1)?,
                created_at: row.get(2)?,
                model: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                cache_read_tokens: row.get(6)?,
                cache_write_tokens: row.get(7)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
}

/// Format an epoch-millisecond instant the same way every native turn's
/// `created_at` is written: `session_persistence::token_usage::
/// insert_token_usage_record` stamps `Utc::now().to_rfc3339()`, which uses a
/// fixed `+00:00` offset and chrono's `AutoSi` fractional-second precision
/// (the fewest digits that represent the value exactly). Comparing strings in
/// that same format sorts identically to comparing the underlying instants,
/// which lets [`fetch_native_turns`] push a time bound into SQL instead of
/// pulling every row through the app layer to filter in Rust.
fn rfc3339_ms_bound(ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

/// List-price cost for a token split at a model's rates.
fn turn_cost(
    model: Option<&str>,
    input: i64,
    output: i64,
    cache_write: i64,
    cache_read: i64,
) -> f64 {
    let pricing = pricing::resolve_pricing(model);
    let per = |tokens: i64, rate: f64| (tokens.max(0) as f64 / 1_000_000.0) * rate;
    per(input, pricing.input_per_mtok)
        + per(output, pricing.output_per_mtok)
        + per(cache_write, pricing.cache_creation_per_mtok)
        + per(cache_read, pricing.cache_read_per_mtok)
}

/// One request-log row: a single assistant round / LLM call. `input_tokens` is
/// FRESH (cache excluded); `real_total_tokens` re-adds cache.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRoundRow {
    /// `session_id#stable_database_row_or_sequence_id`.
    pub round_id: String,
    pub session_id: String,
    pub session_name: String,
    pub bucket: String,
    pub source: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub real_total_tokens: i64,
    pub cost_usd: f64,
    pub created_at_ms: i64,
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        [name],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

#[allow(clippy::too_many_arguments)]
fn build_round_row(
    session: &ScopedSession,
    stable_key: i64,
    model: Option<String>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    created_at_ms: i64,
) -> UsageRoundRow {
    let model = model.or_else(|| session.model.clone());
    let cost = turn_cost(model.as_deref(), input, output, cache_write, cache_read);
    UsageRoundRow {
        round_id: format!("{}#{stable_key}", session.session_id),
        session_id: session.session_id.clone(),
        session_name: session.name.clone(),
        bucket: session.bucket.clone(),
        source: session.source.clone(),
        model,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        real_total_tokens: input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write),
        cost_usd: cost,
        created_at_ms,
    }
}

/// Visit the unified per-round request log without retaining it. Real
/// imported rounds are streamed directly from SQLite; native rows remain a
/// small per-session buffer because their mixed timestamp formats must be
/// parsed before ordering. A synthesized fallback row is emitted for imported
/// sources that do not provide round-level history.
pub(super) fn visit_rounds(
    conn: &Connection,
    filter: &UsageFilter,
    visit: impl FnMut(UsageRoundRow) -> Result<(), String>,
) -> Result<(), String> {
    visit_rounds_inner(conn, filter, visit)
}

/// Compatibility entry point for the unattended rollup. Every dashboard read
/// now applies its available time/source/session scope in SQL; stable native
/// row ids and imported sequence ids keep request-log ids independent of the
/// chosen window.
pub(super) fn visit_rounds_windowed(
    conn: &Connection,
    filter: &UsageFilter,
    visit: impl FnMut(UsageRoundRow) -> Result<(), String>,
) -> Result<(), String> {
    visit_rounds_inner(conn, filter, visit)
}

fn visit_rounds_inner(
    conn: &Connection,
    filter: &UsageFilter,
    mut visit: impl FnMut(UsageRoundRow) -> Result<(), String>,
) -> Result<(), String> {
    let mut sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref(), filter.all_sources)?;
    if let Some(session_id) = filter.session_id.as_deref() {
        sessions.retain(|session| session.session_id == session_id);
    }
    let _scoped_session_table = prepare_scoped_session_table(conn, &sessions)?;

    let session_indexes: HashMap<String, usize> = sessions
        .iter()
        .enumerate()
        .map(|(index, session)| (session.session_id.clone(), index))
        .collect();
    let mut imported_session_ids = HashSet::new();
    if table_exists(conn, "imported_history_round_usage") {
        let mut clauses: Vec<String> = Vec::new();
        let mut params: Vec<i64> = Vec::new();
        if let Some(start) = filter.start_ms {
            clauses.push(format!("rounds.created_at_ms >= ?{}", params.len() + 1));
            params.push(start);
        }
        if let Some(end) = filter.end_ms {
            clauses.push(format!("rounds.created_at_ms <= ?{}", params.len() + 1));
            params.push(end);
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT rounds.session_id, rounds.model,
                    rounds.input_tokens, rounds.output_tokens,
                    rounds.cache_read_tokens, rounds.cache_write_tokens,
                    rounds.created_at_ms, rounds.seq
             FROM imported_history_round_usage rounds
             INNER JOIN {SCOPED_SESSION_TABLE} scoped
                     ON scoped.session_id = rounds.session_id{where_sql}
             ORDER BY rounds.session_id, rounds.created_at_ms, rounds.seq"
        );
        let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(params))
            .map_err(|err| err.to_string())?;
        while let Some(row) = rows.next().map_err(|err| err.to_string())? {
            let session_id: String = row.get(0).map_err(|err| err.to_string())?;
            let Some(&session_index) = session_indexes.get(&session_id) else {
                continue;
            };
            if !imported_session_ids.contains(&session_id) {
                imported_session_ids.insert(session_id.clone());
            }
            let model = row
                .get::<_, Option<String>>(1)
                .map_err(|err| err.to_string())?
                .filter(|value| !value.is_empty());
            let round = build_round_row(
                &sessions[session_index],
                row.get(7).map_err(|err| err.to_string())?,
                model,
                row.get(2).map_err(|err| err.to_string())?,
                row.get(3).map_err(|err| err.to_string())?,
                row.get(4).map_err(|err| err.to_string())?,
                row.get(5).map_err(|err| err.to_string())?,
                row.get(6).map_err(|err| err.to_string())?,
            );
            visit(round)?;
        }
    }

    let native_turns = fetch_native_turns(conn, filter)?;
    let mut native_by: HashMap<String, Vec<NativeTurn>> = HashMap::new();
    for turn in native_turns {
        if !session_indexes.contains_key(&turn.session_id)
            || imported_session_ids.contains(&turn.session_id)
        {
            continue;
        }
        native_by
            .entry(turn.session_id.clone())
            .or_default()
            .push(turn);
    }

    for session in &sessions {
        if imported_session_ids.contains(&session.session_id) {
            continue;
        }
        if session.tokens_source == crate::session_usage::TOKENS_SOURCE_NATIVE {
            let mut turns: Vec<(i64, NativeTurn)> = native_by
                .remove(&session.session_id)
                .unwrap_or_default()
                .into_iter()
                .map(|turn| (iso_to_ms(&turn.created_at).unwrap_or(0), turn))
                .collect();
            turns.sort_by_key(|(ms, turn)| (*ms, turn.row_id));
            for (ms, turn) in turns {
                if !filter.contains(ms) {
                    continue;
                }
                visit(build_round_row(
                    session,
                    turn.row_id,
                    turn.model,
                    turn.input_tokens,
                    turn.output_tokens,
                    turn.cache_read_tokens,
                    turn.cache_write_tokens,
                    ms,
                ))?;
            }
        } else if session.last_active_ms > 0
            && filter.contains(session.last_active_ms)
            && session.real_total_tokens() > 0
        {
            // Fallback: one synthesized round from the session totals (the
            // projection's input is already fresh).
            visit(build_round_row(
                session,
                0,
                session.model.clone(),
                session.input_tokens,
                session.output_tokens,
                session.cache_read_tokens,
                session.cache_write_tokens,
                session.last_active_ms,
            ))?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn native_turn_candidates_for_filter(
    conn: &Connection,
    filter: &UsageFilter,
) -> Result<usize, String> {
    let mut sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref(), filter.all_sources)?;
    if let Some(session_id) = filter.session_id.as_deref() {
        sessions.retain(|session| session.session_id == session_id);
    }
    let _scoped_session_table = prepare_scoped_session_table(conn, &sessions)?;
    Ok(fetch_native_turns(conn, filter)?.len())
}

#[cfg(test)]
pub(super) fn native_turn_query_plan(
    conn: &Connection,
    filter: &UsageFilter,
) -> Result<Vec<String>, String> {
    let mut sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref(), filter.all_sources)?;
    if let Some(session_id) = filter.session_id.as_deref() {
        sessions.retain(|session| session.session_id == session_id);
    }
    let _scoped_session_table = prepare_scoped_session_table(conn, &sessions)?;
    let (sql, params) = native_turn_query(filter);
    let mut statement = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), |row| row.get(3))
        .map_err(|err| err.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
}
