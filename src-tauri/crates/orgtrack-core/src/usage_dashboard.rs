//! Cross-session usage/cost aggregation for the Usage dashboard.
//!
//! Read-only rollups over the per-session projection
//! (`orgtrack_core_session_usage`, see [`crate::session_usage`]) plus the
//! underlying token stores. No writes, no schema changes. Three read shapes:
//! a headline [`UsageSummary`], a time-bucketed [`UsageTrendPoint`] series, and
//! a per-session [`UsageSessionRow`] table. Per-call drill-in is served by the
//! existing `session_llm_usage_spans` / `session_tool_usage` read commands and
//! is not computed here.
//!
//! Invariants the math depends on:
//!
//! - **No double-count.** A native managed session and its imported mirror
//!   project under *different* session_ids (the mirror carries
//!   `imported_history_session_cache.listable = 0`). Every rollup excludes
//!   mirror rows, or native sessions count twice.
//! - **One bucket per session.** Each in-scope session is attributed to exactly
//!   one source bucket derived from the projection `source` +
//!   `code_sessions.cli_agent_type`.
//! - **One trend source per session.** Trends split by the projection's
//!   `tokens_source`: native sessions contribute their per-turn
//!   `session_token_usage` rows. Imported sessions use their stored round rows
//!   when available and otherwise contribute one fallback point at their
//!   last-activity time. A session is never in both halves.
//! - Cost mirrors the projection: `cost_usd` is recorded metered spend when
//!   known, else the list-price estimate (see [`crate::session_usage`]).

mod accumulator;
mod overview;
mod rounds;
#[cfg(test)]
mod tests;

use accumulator::UsageHeadlineAccumulator;
pub use overview::{usage_overview, usage_rounds, usage_trends, UsageOverview};
pub use rounds::UsageRoundRow;
use rounds::visit_rounds;

use rusqlite::Connection;
use serde::Serialize;

/// Source buckets surfaced as dashboard filters.
pub const BUCKET_CLAUDE: &str = "claude";
pub const BUCKET_CODEX: &str = "codex";
pub const BUCKET_CURSOR: &str = "cursor";
pub const BUCKET_ORG2: &str = "org2";
/// Anything outside the four scoped buckets (opencode, windsurf, …). Hidden
/// from the default "all" view; only reachable by an explicit bucket filter.
pub const BUCKET_OTHER: &str = "other";

/// The buckets the dashboard shows when no explicit filter is set.
pub const SCOPED_BUCKETS: [&str; 4] = [BUCKET_CLAUDE, BUCKET_CODEX, BUCKET_CURSOR, BUCKET_ORG2];

/// Milliseconds in one hour / day, for trend bucketing.
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

/// Dashboard scope: an optional source bucket plus an optional `[start, end]`
/// activity window (epoch milliseconds, inclusive).
#[derive(Debug, Clone, Default)]
pub struct UsageFilter {
    /// `None` = the four [`SCOPED_BUCKETS`]; `Some(bucket)` = only that bucket.
    pub bucket: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Restrict to a single session (for the request-log session filter).
    pub session_id: Option<String>,
    /// When `true` and no `bucket` is set, include every source — the long-tail
    /// providers and plugin sources that map to the `other` bucket — instead of
    /// only the four [`SCOPED_BUCKETS`]. The desktop dashboard leaves this
    /// `false` (its default); the CLI opts in so `usage` covers all tools.
    pub all_sources: bool,
}

impl UsageFilter {
    /// Whether an activity timestamp (epoch ms) falls inside the window.
    fn contains(&self, ts_ms: i64) -> bool {
        if let Some(start) = self.start_ms {
            if ts_ms < start {
                return false;
            }
        }
        if let Some(end) = self.end_ms {
            if ts_ms > end {
                return false;
            }
        }
        true
    }
}

/// Time granularity of a [`UsageTrendPoint`] series.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrendBucket {
    Hour,
    Day,
}

impl TrendBucket {
    fn size_ms(self) -> i64 {
        match self {
            TrendBucket::Hour => HOUR_MS,
            TrendBucket::Day => DAY_MS,
        }
    }

    fn floor(self, ts_ms: i64) -> i64 {
        let size = self.size_ms();
        (ts_ms / size) * size
    }
}

/// Headline totals across every in-scope session, plus a per-bucket breakdown.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub session_count: i64,
    /// Native turns + one per imported session — the "requests" headline.
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// input + output + cache_read + cache_write.
    pub real_total_tokens: i64,
    /// Projection `total_tokens` sum (writer-reported total; may differ from
    /// `real_total_tokens` for total-only sources).
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub estimated_cost_usd: f64,
    pub recorded_cost_usd: f64,
    /// cache_read / (input + cache_write + cache_read), range 0–1.
    pub cache_hit_rate: f64,
    pub by_bucket: Vec<BucketSummary>,
}

/// Per-bucket slice of a [`UsageSummary`] (for legend / breakdown chips).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketSummary {
    pub bucket: String,
    pub session_count: i64,
    pub real_total_tokens: i64,
    pub cost_usd: f64,
}

/// One row of the per-session table.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSessionRow {
    pub session_id: String,
    pub name: String,
    pub bucket: String,
    pub source: String,
    pub model: Option<String>,
    pub tokens_source: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub real_total_tokens: i64,
    pub cost_usd: f64,
    pub estimated_cost_usd: f64,
    pub recorded_cost_usd: f64,
    pub cache_hit_rate: f64,
    /// Native per-turn count; 0 for imported sessions (no per-turn store).
    pub turn_count: i64,
    /// Last activity, epoch ms (0 = unknown).
    pub last_active_ms: i64,
}

/// One point of the trend series (tokens + cost in one time bucket).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPoint {
    /// Start of the bucket, epoch ms.
    pub bucket_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
}

/// Sort key for the per-session table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSort {
    Cost,
    Tokens,
    Recent,
}

impl SessionSort {
    /// Parse a wire string; unknown values fall back to `Recent`.
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("recent") {
            "cost" => SessionSort::Cost,
            "tokens" => SessionSort::Tokens,
            _ => SessionSort::Recent,
        }
    }
}

/// Optional model constraint for the request-log table. Kept separate from
/// [`UsageFilter`] because it narrows only the table; headline totals and the
/// trend chart continue to describe the whole dashboard scope.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum UsageRoundModelFilter {
    #[default]
    All,
    Unknown,
    Exact(String),
}

/// Search/model constraints applied only to the paginated request log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageRoundQuery {
    model: UsageRoundModelFilter,
    search: Option<String>,
}

impl UsageRoundQuery {
    /// Build the typed query from the Tauri wire fields. `unknown_model` wins
    /// over `model` so malformed callers cannot create contradictory filters.
    pub fn from_wire(model: Option<String>, unknown_model: bool, search: Option<String>) -> Self {
        let model = if unknown_model {
            UsageRoundModelFilter::Unknown
        } else if let Some(model) = model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            UsageRoundModelFilter::Exact(model)
        } else {
            UsageRoundModelFilter::All
        };
        let search = search
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty());
        Self { model, search }
    }

    fn matches(&self, row: &UsageRoundRow) -> bool {
        let matches_model = match &self.model {
            UsageRoundModelFilter::All => true,
            UsageRoundModelFilter::Unknown => row.model.is_none(),
            UsageRoundModelFilter::Exact(model) => row.model.as_ref() == Some(model),
        };
        if !matches_model {
            return false;
        }

        let Some(search) = self.search.as_deref() else {
            return true;
        };
        row.session_name.to_lowercase().contains(search)
            || row.source.to_lowercase().contains(search)
            || row
                .model
                .as_deref()
                .is_some_and(|model| model.to_lowercase().contains(search))
    }
}

// ============================================================================
// Internal: the deduped, bucket-scoped session set (the shared read model)
// ============================================================================

/// One projected session already filtered to the bucket scope and with mirror
/// rows removed. Time filtering is applied by callers (summary/table filter by
/// `last_active_ms`; trends filter their turns by `created_at`).
#[derive(Debug, Clone)]
struct ScopedSession {
    session_id: String,
    name: String,
    bucket: String,
    source: String,
    model: Option<String>,
    tokens_source: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
    estimated_cost_usd: f64,
    recorded_cost_usd: f64,
    turn_count: i64,
    last_active_ms: i64,
}

impl ScopedSession {
    fn real_total_tokens(&self) -> i64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_write_tokens)
    }
}

/// SQL `CASE` expression that maps a projection row (alias `u`) + optional
/// `code_sessions` row (alias `cs`) to a source bucket string. Kept in one
/// place so every query buckets identically.
fn bucket_case_sql() -> &'static str {
    "CASE
        WHEN u.source = 'orgii_rust_agents' THEN 'org2'
        WHEN u.source = 'claude_code' THEN 'claude'
        WHEN u.source = 'codex_app' THEN 'codex'
        WHEN u.source IN ('cursor_ide', 'cursor_cli') THEN 'cursor'
        WHEN u.source = 'orgii_cli_sessions' THEN
            CASE
                WHEN lower(coalesce(cs.cli_agent_type, '')) LIKE 'claude%' THEN 'claude'
                WHEN lower(coalesce(cs.cli_agent_type, '')) LIKE 'codex%' THEN 'codex'
                WHEN lower(coalesce(cs.cli_agent_type, '')) LIKE 'cursor%' THEN 'cursor'
                ELSE 'org2'
            END
        ELSE 'other'
    END"
}

/// Parse an ISO-8601 / RFC-3339 timestamp to epoch milliseconds. Handles the
/// `Z`, offset, and space-separated variants written across stores; returns
/// `None` for empty or unparseable values.
fn iso_to_ms(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp_millis());
    }
    // Fallbacks for non-offset timestamps (assume UTC).
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Some(naive.and_utc().timestamp_millis());
        }
    }
    None
}

/// Fetch the deduped, bucket-scoped session set. Applies the bucket filter and
/// mirror exclusion in SQL; does **not** apply the time window (callers do).
fn fetch_scoped_sessions(
    conn: &Connection,
    bucket: Option<&str>,
    all_sources: bool,
) -> Result<Vec<ScopedSession>, String> {
    // The bucket predicate is the only structural difference, so build it once.
    let bucket_predicate = if bucket.is_some() {
        "outer_bucket = ?1".to_string()
    } else if all_sources {
        // Every source, including the `other` bucket (long-tail + plugins).
        "1 = 1".to_string()
    } else {
        // Default "all" = the four scoped buckets (never `other`).
        let list = SCOPED_BUCKETS
            .iter()
            .map(|b| format!("'{b}'"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("outer_bucket IN ({list})")
    };

    let sql = format!(
        "WITH scoped AS (
            SELECT
                u.session_id AS session_id,
                u.source AS source,
                u.model AS model,
                u.tokens_source AS tokens_source,
                u.input_tokens AS input_tokens,
                u.output_tokens AS output_tokens,
                u.cache_read_tokens AS cache_read_tokens,
                u.cache_write_tokens AS cache_write_tokens,
                u.total_tokens AS total_tokens,
                u.cost_usd AS cost_usd,
                u.estimated_cost_usd AS estimated_cost_usd,
                u.recorded_cost_usd AS recorded_cost_usd,
                {bucket_case} AS outer_bucket,
                coalesce(
                    nullif(cs.name, ''),
                    nullif(ags.name, ''),
                    (SELECT ihc.name FROM imported_history_session_cache ihc
                     WHERE ihc.session_id = u.session_id AND ihc.listable = 1
                     ORDER BY ihc.updated_at_ms DESC LIMIT 1),
                    u.session_id
                ) AS name,
                coalesce(cs.updated_at, ags.updated_at, '') AS owner_updated_at,
                (SELECT max(ihc.updated_at_ms) FROM imported_history_session_cache ihc
                 WHERE ihc.session_id = u.session_id AND ihc.listable = 1) AS imported_updated_ms,
                (SELECT count(*) FROM session_token_usage stu
                 WHERE stu.session_id = u.session_id) AS turn_count
            FROM orgtrack_core_session_usage u
            LEFT JOIN code_sessions cs ON cs.session_id = u.session_id
            LEFT JOIN agent_sessions ags ON ags.session_id = u.session_id
            WHERE u.session_id NOT IN (
                SELECT session_id FROM imported_history_session_cache WHERE listable = 0
            )
        )
        SELECT session_id, source, model, tokens_source,
               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
               cost_usd, estimated_cost_usd, recorded_cost_usd,
               outer_bucket, name, owner_updated_at, imported_updated_ms, turn_count
        FROM scoped
        WHERE {bucket_predicate}",
        bucket_case = bucket_case_sql(),
    );

    let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<ScopedSession> {
        let owner_updated_at: String = row.get(14)?;
        let imported_updated_ms: Option<i64> = row.get(15)?;
        let last_active_ms = iso_to_ms(&owner_updated_at)
            .or(imported_updated_ms)
            .unwrap_or(0);
        Ok(ScopedSession {
            session_id: row.get(0)?,
            source: row.get(1)?,
            model: row.get(2)?,
            tokens_source: row.get(3)?,
            input_tokens: row.get(4)?,
            output_tokens: row.get(5)?,
            cache_read_tokens: row.get(6)?,
            cache_write_tokens: row.get(7)?,
            total_tokens: row.get(8)?,
            cost_usd: row.get(9)?,
            estimated_cost_usd: row.get(10)?,
            recorded_cost_usd: row.get(11)?,
            bucket: row.get(12)?,
            name: row.get(13)?,
            turn_count: row.get(16)?,
            last_active_ms,
        })
    };

    let rows = if let Some(bucket) = bucket {
        statement.query_map([bucket], map_row)
    } else {
        statement.query_map([], map_row)
    }
    .map_err(|err| err.to_string())?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
}

/// Cache-hit rate: cache_read / (input + cache_write + cache_read). `0.0` when
/// there is no cacheable input.
fn cache_hit_rate(input: i64, cache_write: i64, cache_read: i64) -> f64 {
    let denom = input.saturating_add(cache_write).saturating_add(cache_read);
    if denom <= 0 {
        return 0.0;
    }
    cache_read as f64 / denom as f64
}

// ============================================================================
// Public read APIs
// ============================================================================

/// Headline totals for the filter's scope, aggregated from the SAME per-round
/// set as the request log and trends so the three always agree (a session-level
/// summary could disagree with the round table's time filter and blank the
/// panel even when rounds exist).
pub fn usage_summary(conn: &Connection, filter: &UsageFilter) -> Result<UsageSummary, String> {
    let mut accumulator = UsageHeadlineAccumulator::new(TrendBucket::Day, true, false);
    visit_rounds(conn, filter, |round| {
        accumulator.observe(&round);
        Ok(())
    })?;
    Ok(accumulator.finish().0)
}

/// Per-session table rows for the filter's scope, sorted and paginated.
pub fn usage_sessions(
    conn: &Connection,
    filter: &UsageFilter,
    sort: SessionSort,
    offset: usize,
    limit: usize,
) -> Result<Vec<UsageSessionRow>, String> {
    let sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref(), filter.all_sources)?;
    let mut rows: Vec<UsageSessionRow> = sessions
        .into_iter()
        .filter(|session| filter.contains(session.last_active_ms))
        .map(|session| UsageSessionRow {
            cache_hit_rate: cache_hit_rate(
                session.input_tokens,
                session.cache_write_tokens,
                session.cache_read_tokens,
            ),
            real_total_tokens: session.real_total_tokens(),
            session_id: session.session_id,
            name: session.name,
            bucket: session.bucket,
            source: session.source,
            model: session.model,
            tokens_source: session.tokens_source,
            input_tokens: session.input_tokens,
            output_tokens: session.output_tokens,
            cache_read_tokens: session.cache_read_tokens,
            cache_write_tokens: session.cache_write_tokens,
            total_tokens: session.total_tokens,
            cost_usd: session.cost_usd,
            estimated_cost_usd: session.estimated_cost_usd,
            recorded_cost_usd: session.recorded_cost_usd,
            turn_count: session.turn_count,
            last_active_ms: session.last_active_ms,
        })
        .collect();

    match sort {
        SessionSort::Cost => rows.sort_by(|a, b| {
            b.cost_usd
                .partial_cmp(&a.cost_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        SessionSort::Tokens => rows.sort_by_key(|row| std::cmp::Reverse(row.real_total_tokens)),
        SessionSort::Recent => rows.sort_by_key(|row| std::cmp::Reverse(row.last_active_ms)),
    }

    Ok(rows.into_iter().skip(offset).take(limit).collect())
}
