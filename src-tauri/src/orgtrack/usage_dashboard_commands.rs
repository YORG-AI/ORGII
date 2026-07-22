//! Tauri commands for the Usage dashboard (chat pane → Runtime → Usage).
//!
//! Thin wrappers over [`orgtrack_core::usage_dashboard`] — read-only rollups of
//! the local session DB (`~/.orgii/sessions.db`). No scanning, no proxy: they
//! only aggregate what the existing pipeline already stored. Per-call drill-in
//! is served by the existing `get_session_llm_usage_spans` /
//! `get_session_tool_usage_attributions` commands, not here.

use database::db::get_connection;
use orgtrack_core::pricing;
use orgtrack_core::usage_dashboard::{
    self, SessionSort, TrendBucket, UsageFilter, UsageOverview, UsageRoundQuery, UsageRoundRow,
    UsageSessionRow, UsageSummary, UsageTrendPoint,
};

/// Per-Mtok list rates for one model, resolved from the bundled pricing catalog.
/// Fetched lazily by the dashboard when a cost tooltip opens; the frontend
/// multiplies these by a round's token counts to show the per-line breakdown.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricingWire {
    pub model: Option<String>,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
}

/// Resolve list-price rates for a model id (pure catalog lookup, no DB).
#[tauri::command]
pub async fn usage_dashboard_model_pricing(
    model: Option<String>,
) -> Result<ModelPricingWire, String> {
    let rates = pricing::resolve_pricing(model.as_deref());
    Ok(ModelPricingWire {
        model,
        input_per_mtok: rates.input_per_mtok,
        output_per_mtok: rates.output_per_mtok,
        cache_read_per_mtok: rates.cache_read_per_mtok,
        cache_write_per_mtok: rates.cache_creation_per_mtok,
    })
}

const DAY_MS: i64 = 86_400_000;
/// Sessions-table page cap, so a huge history can't return an unbounded blob.
const MAX_SESSION_ROWS: usize = 1_000;
/// Request-log page cap (rounds are finer-grained, so allow more).
const MAX_ROUND_ROWS: usize = 5_000;

fn open_conn() -> Result<rusqlite::Connection, String> {
    get_connection().map_err(|err| format!("Failed to open sessions DB: {err}"))
}

fn build_filter(
    bucket: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    session_id: Option<String>,
) -> UsageFilter {
    UsageFilter {
        // Treat blank/"all" as no bucket filter (the four scoped buckets).
        bucket: bucket.filter(|value| !value.is_empty() && value != "all"),
        start_ms,
        end_ms,
        session_id: session_id.filter(|value| !value.is_empty()),
        // The desktop dashboard scopes to the four primary buckets.
        all_sources: false,
    }
}

/// Choose hourly vs daily buckets: hourly for windows up to ~24h (matching the
/// reference dashboard), daily otherwise. An open-ended window defaults to days.
fn resolve_trend_bucket(
    explicit: Option<&str>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> TrendBucket {
    match explicit {
        Some("hour") => return TrendBucket::Hour,
        Some("day") => return TrendBucket::Day,
        _ => {}
    }
    match (start_ms, end_ms) {
        (Some(start), Some(end)) if end.saturating_sub(start) <= DAY_MS => TrendBucket::Hour,
        _ => TrendBucket::Day,
    }
}

/// Headline totals (tokens, cost, cache-hit rate, per-bucket breakdown) for the
/// current scope.
#[tauri::command]
pub async fn usage_dashboard_summary(
    bucket: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    session_id: Option<String>,
) -> Result<UsageSummary, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let filter = build_filter(bucket, start_ms, end_ms, session_id);
        usage_dashboard::usage_summary(&conn, &filter)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Time-bucketed token + cost series for the trends chart.
#[tauri::command]
pub async fn usage_dashboard_trends(
    bucket: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    session_id: Option<String>,
    bucket_unit: Option<String>,
) -> Result<Vec<UsageTrendPoint>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let filter = build_filter(bucket, start_ms, end_ms, session_id);
        let unit = resolve_trend_bucket(bucket_unit.as_deref(), start_ms, end_ms);
        usage_dashboard::usage_trends(&conn, &filter, unit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Optional summary/trends and request-log page from one round-store scan.
#[tauri::command]
pub async fn usage_dashboard_overview(
    bucket: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    session_id: Option<String>,
    sort: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    model: Option<String>,
    unknown_model: Option<bool>,
    search: Option<String>,
    bucket_unit: Option<String>,
    include_headline: Option<bool>,
    include_rounds: Option<bool>,
) -> Result<UsageOverview, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let filter = build_filter(bucket, start_ms, end_ms, session_id);
        let unit = resolve_trend_bucket(bucket_unit.as_deref(), start_ms, end_ms);
        let sort = SessionSort::parse(sort.as_deref());
        let round_query = UsageRoundQuery::from_wire(model, unknown_model.unwrap_or(false), search);
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_ROUND_ROWS).min(MAX_ROUND_ROWS);
        usage_dashboard::usage_overview(
            &conn,
            &filter,
            &round_query,
            sort,
            offset,
            limit,
            unit,
            include_headline.unwrap_or(true),
            include_rounds.unwrap_or(true),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Per-round request-log rows for the current scope, sorted and paginated.
#[tauri::command]
pub async fn usage_dashboard_rounds(
    bucket: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    session_id: Option<String>,
    sort: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<UsageRoundRow>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let filter = build_filter(bucket, start_ms, end_ms, session_id);
        let sort = SessionSort::parse(sort.as_deref());
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_ROUND_ROWS).min(MAX_ROUND_ROWS);
        usage_dashboard::usage_rounds(&conn, &filter, sort, offset, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Per-session table rows for the current scope, sorted and paginated. The row
/// total for pagination is `usage_dashboard_summary`'s `sessionCount`.
#[tauri::command]
pub async fn usage_dashboard_sessions(
    bucket: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    session_id: Option<String>,
    sort: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<UsageSessionRow>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let filter = build_filter(bucket, start_ms, end_ms, session_id);
        let sort = SessionSort::parse(sort.as_deref());
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_SESSION_ROWS).min(MAX_SESSION_ROWS);
        usage_dashboard::usage_sessions(&conn, &filter, sort, offset, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
