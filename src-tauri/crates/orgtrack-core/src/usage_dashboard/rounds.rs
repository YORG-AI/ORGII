//! The unified per-round request log: native per-turn expansion, real
//! imported round rows, and the session-level fallback for imported sources
//! without round-level history. [`visit_rounds`] streams this set without
//! retaining it; [`UsageRoundRow`] is the shared per-round shape consumed by
//! the headline accumulator and the request-log page.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::pricing;

use super::{fetch_scoped_sessions, iso_to_ms, ScopedSession, UsageFilter};

/// A native per-turn token row, pulled once and filtered in Rust.
struct NativeTurn {
    session_id: String,
    created_at: String,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
}

fn fetch_native_turns(conn: &Connection) -> Result<Vec<NativeTurn>, String> {
    let mut statement = conn
        .prepare(
            "SELECT session_id, created_at, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
             FROM session_token_usage",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(NativeTurn {
                session_id: row.get(0)?,
                created_at: row.get(1)?,
                model: row.get(2)?,
                input_tokens: row.get(3)?,
                output_tokens: row.get(4)?,
                cache_read_tokens: row.get(5)?,
                cache_write_tokens: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
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
    /// `session_id#index` — stable within a fetch.
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
    index: usize,
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
        round_id: format!("{}#{index}", session.session_id),
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
    mut visit: impl FnMut(UsageRoundRow) -> Result<(), String>,
) -> Result<(), String> {
    let mut sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref(), filter.all_sources)?;
    if let Some(session_id) = filter.session_id.as_deref() {
        sessions.retain(|session| session.session_id == session_id);
    }

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
            clauses.push(format!("created_at_ms >= ?{}", params.len() + 1));
            params.push(start);
        }
        if let Some(end) = filter.end_ms {
            clauses.push(format!("created_at_ms <= ?{}", params.len() + 1));
            params.push(end);
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, created_at_ms
             FROM imported_history_round_usage{where_sql}
             ORDER BY session_id, created_at_ms, seq"
        );
        let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(params))
            .map_err(|err| err.to_string())?;
        let mut current_session_id = String::new();
        let mut current_index = 0usize;
        while let Some(row) = rows.next().map_err(|err| err.to_string())? {
            let session_id: String = row.get(0).map_err(|err| err.to_string())?;
            let Some(&session_index) = session_indexes.get(&session_id) else {
                continue;
            };
            if current_session_id != session_id {
                current_session_id.clone_from(&session_id);
                current_index = 0;
            }
            if !imported_session_ids.contains(&session_id) {
                imported_session_ids.insert(session_id.clone());
            }
            let model = row
                .get::<_, Option<String>>(1)
                .map_err(|err| err.to_string())?
                .filter(|value| !value.is_empty());
            let round = build_round_row(
                &sessions[session_index],
                current_index,
                model,
                row.get(2).map_err(|err| err.to_string())?,
                row.get(3).map_err(|err| err.to_string())?,
                row.get(4).map_err(|err| err.to_string())?,
                row.get(5).map_err(|err| err.to_string())?,
                row.get(6).map_err(|err| err.to_string())?,
            );
            current_index += 1;
            visit(round)?;
        }
    }

    let mut native_by: HashMap<String, Vec<NativeTurn>> = HashMap::new();
    for turn in fetch_native_turns(conn)? {
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
            turns.sort_by_key(|(ms, _)| *ms);
            for (index, (ms, turn)) in turns.into_iter().enumerate() {
                if !filter.contains(ms) {
                    continue;
                }
                visit(build_round_row(
                    session,
                    index,
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
