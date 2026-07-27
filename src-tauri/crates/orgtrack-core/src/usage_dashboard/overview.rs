//! Trend series, paginated request log, and the combined [`usage_overview`]
//! streaming pass that backs both. Request-log paging spills matched rounds
//! into a temp table (sorted/indexed there) instead of collecting them in
//! memory, so a single pass over [`visit_rounds`] can serve headline totals,
//! trend buckets, and an arbitrary page of the request log together.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde::Serialize;

use super::accumulator::UsageHeadlineAccumulator;
use super::rounds::{visit_rounds, UsageRoundRow};
use super::{
    SessionSort, TrendBucket, UsageFilter, UsageRoundQuery, UsageSummary, UsageTrendPoint,
};

const ROUND_PAGE_TABLE: &str = "usage_dashboard_round_page";

fn prepare_round_page_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_dashboard_round_page (
            row_sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
            round_id           TEXT NOT NULL,
            session_id         TEXT NOT NULL,
            session_name       TEXT NOT NULL,
            bucket             TEXT NOT NULL,
            source             TEXT NOT NULL,
            model              TEXT,
            input_tokens       INTEGER NOT NULL,
            output_tokens      INTEGER NOT NULL,
            cache_read_tokens  INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            real_total_tokens  INTEGER NOT NULL,
            cost_usd           REAL NOT NULL,
            created_at_ms      INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS usage_dashboard_round_page_recent_idx
             ON usage_dashboard_round_page(created_at_ms DESC, row_sequence ASC);
         CREATE INDEX IF NOT EXISTS usage_dashboard_round_page_tokens_idx
             ON usage_dashboard_round_page(real_total_tokens DESC, row_sequence ASC);
         CREATE INDEX IF NOT EXISTS usage_dashboard_round_page_cost_idx
             ON usage_dashboard_round_page(cost_usd DESC, row_sequence ASC);
         DELETE FROM usage_dashboard_round_page;",
    )
    .map_err(|err| err.to_string())
}

fn clear_round_page_table(conn: &Connection) {
    let _ = conn.execute(&format!("DELETE FROM {ROUND_PAGE_TABLE}"), []);
}

fn read_round_page(
    conn: &Connection,
    sort: SessionSort,
    offset: usize,
    limit: usize,
) -> Result<Vec<UsageRoundRow>, String> {
    let order_by = match sort {
        SessionSort::Cost => "cost_usd DESC, row_sequence ASC",
        SessionSort::Tokens => "real_total_tokens DESC, row_sequence ASC",
        SessionSort::Recent => "created_at_ms DESC, row_sequence ASC",
    };
    let sql = format!(
        "SELECT round_id, session_id, session_name, bucket, source, model,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                real_total_tokens, cost_usd, created_at_ms
         FROM {ROUND_PAGE_TABLE}
         ORDER BY {order_by}
         LIMIT ?1 OFFSET ?2"
    );
    let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(
            [
                i64::try_from(limit).unwrap_or(i64::MAX),
                i64::try_from(offset).unwrap_or(i64::MAX),
            ],
            |row| {
                Ok(UsageRoundRow {
                    round_id: row.get(0)?,
                    session_id: row.get(1)?,
                    session_name: row.get(2)?,
                    bucket: row.get(3)?,
                    source: row.get(4)?,
                    model: row.get(5)?,
                    input_tokens: row.get(6)?,
                    output_tokens: row.get(7)?,
                    cache_read_tokens: row.get(8)?,
                    cache_write_tokens: row.get(9)?,
                    real_total_tokens: row.get(10)?,
                    cost_usd: row.get(11)?,
                    created_at_ms: row.get(12)?,
                })
            },
        )
        .map_err(|err| err.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
}

/// Per-round request-log rows for the filter's scope, sorted and paginated.
pub fn usage_rounds(
    conn: &Connection,
    filter: &UsageFilter,
    sort: SessionSort,
    offset: usize,
    limit: usize,
) -> Result<Vec<UsageRoundRow>, String> {
    Ok(usage_overview(
        conn,
        filter,
        &UsageRoundQuery::default(),
        sort,
        offset,
        limit,
        TrendBucket::Day,
        false,
        false,
        true,
    )?
    .rounds)
}

/// Time-bucketed token + cost series, aggregated from the same per-round set as
/// the request log — a fine curve for every source.
pub fn usage_trends(
    conn: &Connection,
    filter: &UsageFilter,
    bucket_unit: TrendBucket,
) -> Result<Vec<UsageTrendPoint>, String> {
    let mut accumulator = UsageHeadlineAccumulator::new(bucket_unit, false, true);
    visit_rounds(conn, filter, |round| {
        accumulator.observe(&round);
        Ok(())
    })?;
    Ok(accumulator.finish().1)
}

/// Optional headline aggregates and request-log page from a single
/// streaming pass. Callers can request only the part of the dashboard
/// they are updating without retaining the raw round set between calls.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub summary: UsageSummary,
    pub trends: Vec<UsageTrendPoint>,
    pub rounds: Vec<UsageRoundRow>,
    /// Total request-log rows after table-only search/model filtering.
    pub round_total: usize,
    /// Known models in the dashboard scope, before table-only filtering.
    pub round_models: Vec<String>,
    pub has_unknown_round_model: bool,
}

pub fn usage_overview(
    conn: &Connection,
    filter: &UsageFilter,
    round_query: &UsageRoundQuery,
    sort: SessionSort,
    offset: usize,
    limit: usize,
    bucket_unit: TrendBucket,
    include_headline: bool,
    include_trends: bool,
    include_rounds: bool,
) -> Result<UsageOverview, String> {
    if !include_headline && !include_trends && !include_rounds {
        return Ok(UsageOverview::default());
    }

    if include_rounds {
        prepare_round_page_table(conn)?;
    }
    let mut insert = if include_rounds {
        Some(
            conn.prepare(
                "INSERT INTO usage_dashboard_round_page (
                    round_id, session_id, session_name, bucket, source, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    real_total_tokens, cost_usd, created_at_ms
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
                 )",
            )
            .map_err(|err| err.to_string())?,
        )
    } else {
        None
    };
    if include_rounds {
        conn.execute_batch("SAVEPOINT usage_dashboard_round_page_load;")
            .map_err(|err| err.to_string())?;
    }
    let mut accumulator = (include_headline || include_trends)
        .then(|| UsageHeadlineAccumulator::new(bucket_unit, include_headline, include_trends));
    let mut round_total = 0usize;
    let mut round_models = BTreeSet::new();
    let mut has_unknown_round_model = false;

    let visit_result = visit_rounds(conn, filter, |round| {
        if let Some(accumulator) = accumulator.as_mut() {
            accumulator.observe(&round);
        }
        if !include_rounds {
            return Ok(());
        }

        if let Some(model) = round.model.as_ref() {
            if !round_models.contains(model) {
                round_models.insert(model.clone());
            }
        } else {
            has_unknown_round_model = true;
        }
        if !round_query.matches(&round) {
            return Ok(());
        }
        round_total += 1;
        insert
            .as_mut()
            .expect("round-page statement exists when rounds are included")
            .execute(rusqlite::params![
                round.round_id,
                round.session_id,
                round.session_name,
                round.bucket,
                round.source,
                round.model,
                round.input_tokens,
                round.output_tokens,
                round.cache_read_tokens,
                round.cache_write_tokens,
                round.real_total_tokens,
                round.cost_usd,
                round.created_at_ms,
            ])
            .map(|_| ())
            .map_err(|err| err.to_string())
    });
    drop(insert);
    if let Err(err) = visit_result {
        let _ = conn.execute_batch(
            "ROLLBACK TO usage_dashboard_round_page_load;
             RELEASE usage_dashboard_round_page_load;",
        );
        clear_round_page_table(conn);
        return Err(err);
    }
    if include_rounds {
        if let Err(err) = conn.execute_batch("RELEASE usage_dashboard_round_page_load;") {
            clear_round_page_table(conn);
            return Err(err.to_string());
        }
    }

    let (aggregated_summary, aggregated_trends) = accumulator
        .map(UsageHeadlineAccumulator::finish)
        .unwrap_or_default();
    let summary = if include_headline {
        aggregated_summary
    } else {
        UsageSummary::default()
    };
    let trends = if include_trends {
        aggregated_trends
    } else {
        Vec::new()
    };
    let rounds = if include_rounds {
        let result = read_round_page(conn, sort, offset, limit);
        clear_round_page_table(conn);
        result?
    } else {
        Vec::new()
    };
    Ok(UsageOverview {
        summary,
        trends,
        rounds,
        round_total,
        round_models: round_models.into_iter().collect(),
        has_unknown_round_model,
    })
}
