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
//!   `session_token_usage` rows (a real curve); imported sessions contribute a
//!   single lumped point at their last-activity time. A session is never in
//!   both halves.
//! - Cost mirrors the projection: `cost_usd` is recorded metered spend when
//!   known, else the list-price estimate (see [`crate::session_usage`]).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::pricing;

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
) -> Result<Vec<ScopedSession>, String> {
    // The bucket predicate is the only structural difference, so build it once.
    let bucket_predicate = if bucket.is_some() {
        "outer_bucket = ?1".to_string()
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
    Ok(summarize_rounds(&collect_rounds(conn, filter)?))
}

/// Fold a per-round set into the headline [`UsageSummary`].
fn summarize_rounds(rounds: &[UsageRoundRow]) -> UsageSummary {
    let mut summary = UsageSummary::default();
    let mut per_bucket: BTreeMap<String, BucketSummary> = BTreeMap::new();
    let mut sessions_seen: HashSet<String> = HashSet::new();
    let mut bucket_sessions: HashMap<String, HashSet<String>> = HashMap::new();

    for round in rounds {
        summary.request_count += 1;
        if sessions_seen.insert(round.session_id.clone()) {
            summary.session_count += 1;
        }
        summary.input_tokens += round.input_tokens;
        summary.output_tokens += round.output_tokens;
        summary.cache_read_tokens += round.cache_read_tokens;
        summary.cache_write_tokens += round.cache_write_tokens;
        summary.cost_usd += round.cost_usd;

        let entry = per_bucket
            .entry(round.bucket.clone())
            .or_insert_with(|| BucketSummary {
                bucket: round.bucket.clone(),
                ..BucketSummary::default()
            });
        entry.real_total_tokens += round.real_total_tokens;
        entry.cost_usd += round.cost_usd;
        if bucket_sessions
            .entry(round.bucket.clone())
            .or_default()
            .insert(round.session_id.clone())
        {
            entry.session_count += 1;
        }
    }

    summary.real_total_tokens = summary
        .input_tokens
        .saturating_add(summary.output_tokens)
        .saturating_add(summary.cache_read_tokens)
        .saturating_add(summary.cache_write_tokens);
    summary.total_tokens = summary.real_total_tokens;
    // Rounds carry list-price estimates; recorded metered spend isn't tracked
    // per round, so the headline == estimated here.
    summary.estimated_cost_usd = summary.cost_usd;
    summary.cache_hit_rate = cache_hit_rate(
        summary.input_tokens,
        summary.cache_write_tokens,
        summary.cache_read_tokens,
    );
    summary.by_bucket = per_bucket.into_values().collect();
    summary
}

/// Per-session table rows for the filter's scope, sorted and paginated.
pub fn usage_sessions(
    conn: &Connection,
    filter: &UsageFilter,
    sort: SessionSort,
    offset: usize,
    limit: usize,
) -> Result<Vec<UsageSessionRow>, String> {
    let sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref())?;
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

/// One per-round row read from `imported_history_round_usage`.
struct ImportedRound {
    session_id: String,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    created_at_ms: i64,
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

fn fetch_imported_rounds(
    conn: &Connection,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<Vec<ImportedRound>, String> {
    if !table_exists(conn, "imported_history_round_usage") {
        return Ok(Vec::new());
    }
    // Bound the scan to the time window (created_at_ms is indexed) so a large
    // all-time round table isn't loaded on every refresh.
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<i64> = Vec::new();
    if let Some(start) = start_ms {
        clauses.push(format!("created_at_ms >= ?{}", params.len() + 1));
        params.push(start);
    }
    if let Some(end) = end_ms {
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
         FROM imported_history_round_usage{where_sql}"
    );
    let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(ImportedRound {
                session_id: row.get(0)?,
                model: row
                    .get::<_, String>(1)
                    .map(|model| Some(model).filter(|value| !value.is_empty()))?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                cache_read_tokens: row.get(4)?,
                cache_write_tokens: row.get(5)?,
                created_at_ms: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
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

/// The unified per-round request log for the filter's scope: real per-round
/// rows where a source emits them (codex/claude in `imported_history_round_usage`,
/// native org2 turns in `session_token_usage`), and one synthesized fallback
/// round from the session totals for imported sources that have none
/// (cursor/opencode/…). Rounds outside the time window are dropped.
fn collect_rounds(conn: &Connection, filter: &UsageFilter) -> Result<Vec<UsageRoundRow>, String> {
    let mut sessions = fetch_scoped_sessions(conn, filter.bucket.as_deref())?;
    if let Some(session_id) = filter.session_id.as_deref() {
        sessions.retain(|session| session.session_id == session_id);
    }

    let mut imported_by: HashMap<String, Vec<ImportedRound>> = HashMap::new();
    for round in fetch_imported_rounds(conn, filter.start_ms, filter.end_ms)? {
        imported_by
            .entry(round.session_id.clone())
            .or_default()
            .push(round);
    }
    let mut native_by: HashMap<String, Vec<NativeTurn>> = HashMap::new();
    for turn in fetch_native_turns(conn)? {
        native_by
            .entry(turn.session_id.clone())
            .or_default()
            .push(turn);
    }

    let mut rows = Vec::new();
    for session in &sessions {
        if let Some(mut imported) = imported_by.remove(&session.session_id) {
            imported.sort_by_key(|round| round.created_at_ms);
            for (index, round) in imported.into_iter().enumerate() {
                if !filter.contains(round.created_at_ms) {
                    continue;
                }
                rows.push(build_round_row(
                    session,
                    index,
                    round.model,
                    round.input_tokens,
                    round.output_tokens,
                    round.cache_read_tokens,
                    round.cache_write_tokens,
                    round.created_at_ms,
                ));
            }
        } else if session.tokens_source == crate::session_usage::TOKENS_SOURCE_NATIVE {
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
                rows.push(build_round_row(
                    session,
                    index,
                    turn.model,
                    turn.input_tokens,
                    turn.output_tokens,
                    turn.cache_read_tokens,
                    turn.cache_write_tokens,
                    ms,
                ));
            }
        } else if session.last_active_ms > 0
            && filter.contains(session.last_active_ms)
            && session.real_total_tokens() > 0
        {
            // Fallback: one synthesized round from the session totals (the
            // projection's input is already fresh).
            rows.push(build_round_row(
                session,
                0,
                session.model.clone(),
                session.input_tokens,
                session.output_tokens,
                session.cache_read_tokens,
                session.cache_write_tokens,
                session.last_active_ms,
            ));
        }
    }
    Ok(rows)
}

/// Sort a per-round set in place by the chosen key (descending).
fn sort_rounds(rows: &mut [UsageRoundRow], sort: SessionSort) {
    match sort {
        SessionSort::Cost => rows.sort_by(|a, b| {
            b.cost_usd
                .partial_cmp(&a.cost_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        SessionSort::Tokens => rows.sort_by_key(|row| std::cmp::Reverse(row.real_total_tokens)),
        SessionSort::Recent => rows.sort_by_key(|row| std::cmp::Reverse(row.created_at_ms)),
    }
}

/// Bucket a per-round set into a time series.
fn bucket_rounds(rounds: &[UsageRoundRow], bucket_unit: TrendBucket) -> Vec<UsageTrendPoint> {
    let mut points: HashMap<i64, UsageTrendPoint> = HashMap::new();
    for round in rounds {
        if round.created_at_ms <= 0 {
            continue;
        }
        let key = bucket_unit.floor(round.created_at_ms);
        let point = points.entry(key).or_insert_with(|| UsageTrendPoint {
            bucket_ms: key,
            ..UsageTrendPoint::default()
        });
        point.input_tokens += round.input_tokens;
        point.output_tokens += round.output_tokens;
        point.cache_write_tokens += round.cache_write_tokens;
        point.cache_read_tokens += round.cache_read_tokens;
        point.cost_usd += round.cost_usd;
    }
    let mut series: Vec<UsageTrendPoint> = points.into_values().collect();
    series.sort_by_key(|point| point.bucket_ms);
    series
}

/// Per-round request-log rows for the filter's scope, sorted and paginated.
pub fn usage_rounds(
    conn: &Connection,
    filter: &UsageFilter,
    sort: SessionSort,
    offset: usize,
    limit: usize,
) -> Result<Vec<UsageRoundRow>, String> {
    let mut rows = collect_rounds(conn, filter)?;
    sort_rounds(&mut rows, sort);
    Ok(rows.into_iter().skip(offset).take(limit).collect())
}

/// Time-bucketed token + cost series, aggregated from the same per-round set as
/// the request log — a fine curve for every source.
pub fn usage_trends(
    conn: &Connection,
    filter: &UsageFilter,
    bucket_unit: TrendBucket,
) -> Result<Vec<UsageTrendPoint>, String> {
    Ok(bucket_rounds(&collect_rounds(conn, filter)?, bucket_unit))
}

/// Everything the dashboard needs in one shot: summary + trends + the request
/// log page, all from a SINGLE `collect_rounds` pass. The frontend calls this
/// instead of three separate commands, so a refresh scans the round store once
/// (not three times).
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
) -> Result<UsageOverview, String> {
    let mut all = collect_rounds(conn, filter)?;
    let summary = summarize_rounds(&all);
    let trends = bucket_rounds(&all, bucket_unit);
    let round_models = all
        .iter()
        .filter_map(|row| row.model.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let has_unknown_round_model = all.iter().any(|row| row.model.is_none());
    all.retain(|row| round_query.matches(row));
    let round_total = all.len();
    sort_rounds(&mut all, sort);
    let rounds = all.into_iter().skip(offset).take(limit).collect();
    Ok(UsageOverview {
        summary,
        trends,
        rounds,
        round_total,
        round_models,
        has_unknown_round_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_usage::recompute_session_usage;
    use crate::store::sqlite::SqliteRecordStore;
    use rusqlite::params;

    fn fixture_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        SqliteRecordStore::init_tables(&conn).expect("init orgtrack tables");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("init source cache tables");
        conn.execute_batch(
            "CREATE TABLE session_token_usage (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id         TEXT NOT NULL,
                session_type       TEXT NOT NULL DEFAULT 'code',
                model              TEXT,
                account_id         TEXT,
                input_tokens       INTEGER NOT NULL DEFAULT 0,
                output_tokens      INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens       INTEGER NOT NULL DEFAULT 0,
                context_tokens     INTEGER NOT NULL DEFAULT 0,
                created_at         TEXT NOT NULL
             );
             CREATE TABLE code_sessions (
                session_id     TEXT PRIMARY KEY,
                name           TEXT,
                cli_agent_type TEXT,
                model          TEXT,
                account_id     TEXT,
                key_source     TEXT,
                updated_at     TEXT
             );
             CREATE TABLE agent_sessions (
                session_id TEXT PRIMARY KEY,
                name       TEXT,
                model      TEXT,
                account_id TEXT,
                key_source TEXT,
                updated_at TEXT
             );",
        )
        .expect("create app-owned tables");
        conn
    }

    fn insert_code_session(
        conn: &Connection,
        session_id: &str,
        cli_agent_type: &str,
        name: &str,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT INTO code_sessions (session_id, name, cli_agent_type, model, account_id, key_source, updated_at)
             VALUES (?1, ?2, ?3, 'claude-sonnet-4-5', 'acct-1', 'own_key', ?4)",
            params![session_id, name, cli_agent_type, updated_at],
        )
        .expect("insert code session");
    }

    fn insert_turn(
        conn: &Connection,
        session_id: &str,
        model: &str,
        tokens: (i64, i64, i64, i64),
        created_at: &str,
    ) {
        let (input, output, cache_read, cache_write) = tokens;
        let total = input + output + cache_read + cache_write;
        conn.execute(
            "INSERT INTO session_token_usage
                (session_id, session_type, model, account_id, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, total_tokens, context_tokens, created_at)
             VALUES (?1, 'code', ?2, 'acct-1', ?3, ?4, ?5, ?6, ?7, 0, ?8)",
            params![
                session_id,
                model,
                input,
                output,
                cache_read,
                cache_write,
                total,
                created_at
            ],
        )
        .expect("insert turn");
    }

    fn insert_imported(
        conn: &Connection,
        source: &str,
        session_id: &str,
        model: &str,
        tokens: (i64, i64),
        updated_at_ms: i64,
        listable: i64,
    ) {
        let (input, output) = tokens;
        conn.execute(
            "INSERT INTO imported_history_session_cache
                (source, source_session_id, session_id, name, model,
                 input_tokens, output_tokens, updated_at_ms, listable, updated_at)
             VALUES (?1, ?2, ?3, 'Imported Session', ?4, ?5, ?6, ?7, ?8, '2026-07-16T00:00:00Z')",
            params![
                source,
                session_id,
                session_id,
                model,
                input,
                output,
                updated_at_ms,
                listable
            ],
        )
        .expect("insert imported cache row");
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_round(
        conn: &Connection,
        source: &str,
        session_id: &str,
        seq: i64,
        model: &str,
        tokens: (i64, i64, i64, i64),
        created_at_ms: i64,
    ) {
        let (input, output, cache_read, cache_write) = tokens;
        conn.execute(
            "INSERT INTO imported_history_round_usage
                (source, source_session_id, session_id, seq, model,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                source,
                session_id,
                session_id,
                seq,
                model,
                input,
                output,
                cache_read,
                cache_write,
                created_at_ms
            ],
        )
        .expect("insert imported round row");
    }

    #[test]
    fn rounds_fallback_when_no_round_rows() {
        // No imported_history_round_usage rows: native sessions expand to their
        // per-turn rows, imported codex gets one synthesized fallback round.
        let conn = seeded_conn();
        let rows = usage_rounds(&conn, &UsageFilter::default(), SessionSort::Recent, 0, 100)
            .expect("rounds");
        // claude 2 native turns + org2 1 native turn + codex 1 fallback = 4.
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|r| r.session_id != "mirror-claude"));
        let claude: Vec<_> = rows
            .iter()
            .filter(|r| r.session_id == "cli-claude")
            .collect();
        assert_eq!(claude.len(), 2);
        let codex: Vec<_> = rows
            .iter()
            .filter(|r| r.session_id == "ext-codex")
            .collect();
        assert_eq!(codex.len(), 1);
    }

    #[test]
    fn rounds_use_real_rows_and_session_filter() {
        let conn = seeded_conn();
        // Give the imported codex session two real rounds (replaces the fallback).
        insert_round(
            &conn,
            "codex_app",
            "ext-codex",
            0,
            "gpt-5",
            (100_000, 10_000, 50_000, 0),
            ms("2026-07-18T02:00:00Z"),
        );
        insert_round(
            &conn,
            "codex_app",
            "ext-codex",
            1,
            "gpt-5",
            (120_000, 12_000, 0, 0),
            ms("2026-07-18T02:10:00Z"),
        );

        let rows = usage_rounds(&conn, &UsageFilter::default(), SessionSort::Recent, 0, 100)
            .expect("rounds");
        // claude 2 + org2 1 + codex 2 real = 5.
        assert_eq!(rows.len(), 5);
        let codex: Vec<_> = rows
            .iter()
            .filter(|r| r.session_id == "ext-codex")
            .collect();
        assert_eq!(codex.len(), 2);
        assert_eq!(codex.iter().map(|r| r.input_tokens).sum::<i64>(), 220_000);

        // Session filter narrows to just that session's rounds.
        let filter = UsageFilter {
            session_id: Some("ext-codex".to_string()),
            ..UsageFilter::default()
        };
        let only = usage_rounds(&conn, &filter, SessionSort::Recent, 0, 100).expect("filtered");
        assert_eq!(only.len(), 2);
        assert!(only.iter().all(|r| r.session_id == "ext-codex"));
    }

    #[test]
    fn overview_filters_and_pages_rounds_without_narrowing_summary() {
        let conn = seeded_conn();
        let query = UsageRoundQuery::from_wire(
            Some("claude-sonnet-4-5".to_string()),
            false,
            Some("claude".to_string()),
        );

        let first = usage_overview(
            &conn,
            &UsageFilter::default(),
            &query,
            SessionSort::Recent,
            0,
            1,
            TrendBucket::Hour,
        )
        .expect("overview");

        // Summary/trends remain scoped to the whole dashboard, while the
        // request log is filtered and transfers one server-side page.
        assert_eq!(first.summary.request_count, 4);
        assert_eq!(first.round_total, 2);
        assert_eq!(first.rounds.len(), 1);
        assert_eq!(first.rounds[0].session_id, "cli-claude");
        assert_eq!(
            first.round_models,
            vec![
                "claude-opus-4-5".to_string(),
                "claude-sonnet-4-5".to_string(),
                "gpt-5".to_string(),
            ]
        );
        assert!(!first.has_unknown_round_model);

        let second = usage_overview(
            &conn,
            &UsageFilter::default(),
            &query,
            SessionSort::Recent,
            1,
            1,
            TrendBucket::Hour,
        )
        .expect("second page");
        assert_eq!(second.round_total, 2);
        assert_eq!(second.rounds.len(), 1);
        assert_ne!(first.rounds[0].round_id, second.rounds[0].round_id);
    }

    #[test]
    fn round_query_distinguishes_unknown_models() {
        let known = UsageRoundRow {
            model: Some("gpt-5".to_string()),
            ..UsageRoundRow::default()
        };
        let unknown = UsageRoundRow::default();
        let query = UsageRoundQuery::from_wire(Some("gpt-5".to_string()), true, None);

        assert!(!query.matches(&known));
        assert!(query.matches(&unknown));
    }

    /// Build a small realistic DB: one native claude session (2 turns), one
    /// native org2 (rust-agent) session, one purely-imported codex session, and
    /// a listable=0 mirror of the native claude session (the double-count trap).
    fn seeded_conn() -> Connection {
        let conn = fixture_conn();

        // Native claude CLI session — 2 turns.
        insert_code_session(
            &conn,
            "cli-claude",
            "claude",
            "Claude run",
            "2026-07-18T03:00:00Z",
        );
        insert_turn(
            &conn,
            "cli-claude",
            "claude-sonnet-4-5",
            (1_000_000, 100_000, 200_000, 50_000),
            "2026-07-18T03:00:00Z",
        );
        insert_turn(
            &conn,
            "cli-claude",
            "claude-sonnet-4-5",
            (500_000, 50_000, 0, 0),
            "2026-07-18T05:00:00Z",
        );
        recompute_session_usage(&conn, "cli-claude")
            .unwrap()
            .expect("claude projected");

        // Org2 rust-agent session — 1 turn. Owner lives in agent_sessions.
        conn.execute(
            "INSERT INTO agent_sessions (session_id, name, model, account_id, key_source, updated_at)
             VALUES ('agent-1', 'Org2 agent', 'claude-opus-4-5', 'acct-1', 'own_key', '2026-07-18T04:00:00Z')",
            [],
        )
        .unwrap();
        insert_turn(
            &conn,
            "agent-1",
            "claude-opus-4-5",
            (200_000, 20_000, 0, 0),
            "2026-07-18T04:00:00Z",
        );
        recompute_session_usage(&conn, "agent-1")
            .unwrap()
            .expect("agent projected");

        // Purely-imported codex session (listable=1) — session-level tokens.
        let codex_ms = ms("2026-07-18T02:00:00Z");
        insert_imported(
            &conn,
            "codex_app",
            "ext-codex",
            "gpt-5",
            (400_000, 40_000),
            codex_ms,
            1,
        );
        recompute_session_usage(&conn, "ext-codex")
            .unwrap()
            .expect("codex projected");

        // Managed mirror of the native claude session (listable=0, different
        // session_id) — must be excluded from every rollup.
        let mirror_ms = ms("2026-07-18T03:30:00Z");
        insert_imported(
            &conn,
            "claude_code",
            "mirror-claude",
            "claude-sonnet-4-5",
            (1_500_000, 150_000),
            mirror_ms,
            0,
        );
        recompute_session_usage(&conn, "mirror-claude")
            .unwrap()
            .expect("mirror projected");

        conn
    }

    fn ms(iso: &str) -> i64 {
        iso_to_ms(iso).expect("valid iso")
    }

    #[test]
    fn iso_parsing_handles_z_offset_and_space() {
        assert_eq!(iso_to_ms("2026-07-18T00:00:00Z"), Some(1_784_332_800_000));
        assert_eq!(
            iso_to_ms("2026-07-18T00:00:00+00:00"),
            iso_to_ms("2026-07-18T00:00:00Z")
        );
        assert_eq!(
            iso_to_ms("2026-07-18 00:00:00"),
            iso_to_ms("2026-07-18T00:00:00Z")
        );
        assert_eq!(iso_to_ms(""), None);
        assert_eq!(iso_to_ms("not-a-date"), None);
    }

    #[test]
    fn summary_excludes_mirror_and_buckets_sources() {
        let conn = seeded_conn();
        let summary = usage_summary(&conn, &UsageFilter::default()).expect("summary");

        // 3 real sessions (claude native, org2, codex imported) — mirror dropped.
        assert_eq!(summary.session_count, 3);
        // Native claude: 1.5M in / 150k out / 200k cache_read / 50k cache_write.
        // Org2: 200k in / 20k out. Codex imported: 400k in / 40k out.
        assert_eq!(summary.input_tokens, 1_500_000 + 200_000 + 400_000);
        assert_eq!(summary.output_tokens, 150_000 + 20_000 + 40_000);
        assert_eq!(summary.cache_read_tokens, 200_000);
        assert_eq!(summary.cache_write_tokens, 50_000);
        assert_eq!(
            summary.real_total_tokens,
            summary.input_tokens
                + summary.output_tokens
                + summary.cache_read_tokens
                + summary.cache_write_tokens
        );
        // Requests: claude 2 turns + org2 1 turn + codex 1 imported session = 4.
        assert_eq!(summary.request_count, 4);
        // Cost is the sum of the three projection cost_usd values (all > 0).
        assert!(summary.cost_usd > 0.0);

        // Per-bucket breakdown: claude, codex, org2 (sorted).
        let buckets: Vec<&str> = summary
            .by_bucket
            .iter()
            .map(|b| b.bucket.as_str())
            .collect();
        assert_eq!(buckets, vec!["claude", "codex", "org2"]);
        let claude = summary
            .by_bucket
            .iter()
            .find(|b| b.bucket == "claude")
            .unwrap();
        assert_eq!(claude.session_count, 1);
    }

    #[test]
    fn bucket_filter_scopes_to_one_source() {
        let conn = seeded_conn();
        let filter = UsageFilter {
            bucket: Some(BUCKET_CLAUDE.to_string()),
            ..UsageFilter::default()
        };
        let summary = usage_summary(&conn, &filter).expect("summary");
        assert_eq!(summary.session_count, 1);
        assert_eq!(summary.input_tokens, 1_500_000);
        assert_eq!(summary.request_count, 2);
    }

    #[test]
    fn time_window_filters_sessions_by_last_activity() {
        let conn = seeded_conn();
        // Window covering only 02:00–02:30 → just the codex imported session.
        let filter = UsageFilter {
            bucket: None,
            start_ms: Some(ms("2026-07-18T01:30:00Z")),
            end_ms: Some(ms("2026-07-18T02:30:00Z")),
            ..UsageFilter::default()
        };
        let summary = usage_summary(&conn, &filter).expect("summary");
        assert_eq!(summary.session_count, 1);
        assert_eq!(
            summary.by_bucket.first().map(|b| b.bucket.as_str()),
            Some("codex")
        );
    }

    #[test]
    fn sessions_table_sorts_and_excludes_mirror() {
        let conn = seeded_conn();
        let rows = usage_sessions(&conn, &UsageFilter::default(), SessionSort::Cost, 0, 100)
            .expect("sessions");
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.session_id != "mirror-claude"));
        // Sorted by cost descending.
        for pair in rows.windows(2) {
            assert!(pair[0].cost_usd >= pair[1].cost_usd);
        }
        // Native claude row has a turn count; imported codex row has none.
        let claude = rows.iter().find(|r| r.session_id == "cli-claude").unwrap();
        assert_eq!(claude.turn_count, 2);
        assert_eq!(claude.name, "Claude run");
        let codex = rows.iter().find(|r| r.session_id == "ext-codex").unwrap();
        assert_eq!(codex.turn_count, 0);
        assert_eq!(
            codex.tokens_source,
            crate::session_usage::TOKENS_SOURCE_IMPORTED
        );
    }

    #[test]
    fn sessions_table_paginates() {
        let conn = seeded_conn();
        let page = usage_sessions(&conn, &UsageFilter::default(), SessionSort::Recent, 1, 1)
            .expect("sessions");
        assert_eq!(page.len(), 1);
    }

    #[test]
    fn trends_use_per_turn_native_and_lumped_imported() {
        let conn = seeded_conn();
        let series =
            usage_trends(&conn, &UsageFilter::default(), TrendBucket::Hour).expect("trends");
        // Distinct hour buckets: codex 02:00, claude 03:00, org2 04:00, claude 05:00.
        let keys: Vec<i64> = series.iter().map(|p| p.bucket_ms).collect();
        assert_eq!(
            keys,
            vec![
                ms("2026-07-18T02:00:00Z"),
                ms("2026-07-18T03:00:00Z"),
                ms("2026-07-18T04:00:00Z"),
                ms("2026-07-18T05:00:00Z"),
            ]
        );
        // The 03:00 native claude turn carries its full split; mirror excluded.
        let three = series
            .iter()
            .find(|p| p.bucket_ms == ms("2026-07-18T03:00:00Z"))
            .unwrap();
        assert_eq!(three.input_tokens, 1_000_000);
        assert_eq!(three.cache_read_tokens, 200_000);
        assert!(three.cost_usd > 0.0);
        // The 02:00 imported codex point is lumped session-level.
        let two = series
            .iter()
            .find(|p| p.bucket_ms == ms("2026-07-18T02:00:00Z"))
            .unwrap();
        assert_eq!(two.input_tokens, 400_000);
    }

    #[test]
    fn trends_day_bucket_collapses_hours() {
        let conn = seeded_conn();
        let series =
            usage_trends(&conn, &UsageFilter::default(), TrendBucket::Day).expect("trends");
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].bucket_ms, ms("2026-07-18T00:00:00Z"));
    }
}
