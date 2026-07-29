//! Per-(UTC day, bucket) usage rollup for member-runtime sharing.
//!
//! [`usage_daily_rollup`] folds the SAME streamed per-round set as the
//! dashboard headline ([`visit_rounds`] — mirror rows excluded, per-round
//! cost via `pricing::resolve_pricing`) into one row per UTC-day-floor ×
//! source bucket. Unlike the desktop dashboard it always scopes to ALL
//! sources: the pushed team totals must include the long-tail `other` bucket
//! the local view hides, or member aggregates silently undercount.
//!
//! Day attribution uses [`TrendBucket::Day`] floors (UTC), matching the
//! `MemberUsageDay` contract in `features/Org2Cloud/memberRuntime/types.ts`
//! where every member reports UTC days so team aggregation is
//! timezone-consistent.

use std::collections::{BTreeMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use super::rounds::visit_rounds;
use super::{TrendBucket, UsageFilter};

/// One (UTC-day-floor, bucket) aggregate row.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyRollupRow {
    /// Start of the UTC day, epoch ms ([`TrendBucket::Day`] floor).
    pub day_start_ms: i64,
    /// Source bucket: claude | codex | cursor | org2 | other.
    pub bucket: String,
    /// Fresh input tokens (cache excluded, request-log semantics).
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Cache-inclusive total (same semantics as the dashboard headline).
    pub total_tokens: i64,
    pub cost_usd: f64,
    /// Distinct sessions observed in this (day, bucket).
    pub sessions: i64,
    /// Rounds observed in this (day, bucket).
    pub requests: i64,
}

/// Wire wrapper for the `usage_dashboard_daily_rollup` command.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyRollup {
    /// Rows sorted by (`day_start_ms`, `bucket`); all-zero cells omitted.
    pub days: Vec<DailyRollupRow>,
}

#[derive(Default)]
struct RollupCell {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
    requests: i64,
    session_ids: HashSet<String>,
}

/// Aggregate the `[start_ms, end_ms]` window (inclusive, epoch ms) into
/// per-(UTC day, bucket) rows across ALL sources.
pub fn usage_daily_rollup(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<DailyRollup, String> {
    let filter = UsageFilter {
        bucket: None,
        start_ms: Some(start_ms),
        end_ms: Some(end_ms),
        session_id: None,
        // Team rollups must be complete — include the `other` bucket the
        // desktop dashboard's default scope drops.
        all_sources: true,
    };

    // BTreeMap keys give the required (day, bucket) output ordering for free.
    let mut cells: BTreeMap<(i64, String), RollupCell> = BTreeMap::new();
    visit_rounds(conn, &filter, |round| {
        // Rounds without a usable timestamp cannot be attributed to a UTC
        // day (mirrors the trend accumulator's `created_at_ms > 0` gate).
        if round.created_at_ms <= 0 {
            return Ok(());
        }
        let day_start_ms = TrendBucket::Day.floor(round.created_at_ms);
        let cell = cells
            .entry((day_start_ms, round.bucket.clone()))
            .or_default();
        cell.input_tokens += round.input_tokens;
        cell.output_tokens += round.output_tokens;
        cell.cache_read_tokens += round.cache_read_tokens;
        cell.cache_write_tokens += round.cache_write_tokens;
        cell.total_tokens += round.real_total_tokens;
        cell.cost_usd += round.cost_usd;
        cell.requests += 1;
        cell.session_ids.insert(round.session_id);
        Ok(())
    })?;

    let days = cells
        .into_iter()
        // Cells whose rounds carried no tokens and no cost are noise (the
        // per-push row cap is small); drop them.
        .filter(|(_, cell)| cell.total_tokens > 0 || cell.cost_usd > 0.0)
        .map(|((day_start_ms, bucket), cell)| DailyRollupRow {
            day_start_ms,
            bucket,
            input_tokens: cell.input_tokens,
            output_tokens: cell.output_tokens,
            cache_read_tokens: cell.cache_read_tokens,
            cache_write_tokens: cell.cache_write_tokens,
            total_tokens: cell.total_tokens,
            cost_usd: cell.cost_usd,
            sessions: cell.session_ids.len() as i64,
            requests: cell.requests,
        })
        .collect();

    Ok(DailyRollup { days })
}
