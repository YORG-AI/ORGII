//! Feishu / gateway status-bar rendering.
//!
//! OpenClaw injects a status-bar instruction into the prompt and asks the LLM
//! to echo it at the end. ORG-2 can do better for external channels: append
//! the bar in Rust after the model returns, so it is deterministic and does
//! not consume prompt/output tokens.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::state::AgentSession;

const ZENMUX_TTL: Duration = Duration::from_secs(300);
const ZENMUX_MGMT_KEY: &str =
    "sk-mg-v1-7eb0ee4075005d1865dfc2f3de2d4cd7ef2a214523e5caec01b2684b23744a59";

#[derive(Clone, Default)]
struct ZenmuxBarCache {
    text: Option<String>,
    fetched_at: Option<Instant>,
}

static ZENMUX_CACHE: OnceLock<Mutex<ZenmuxBarCache>> = OnceLock::new();

fn zenmux_cache() -> &'static Mutex<ZenmuxBarCache> {
    ZENMUX_CACHE.get_or_init(|| Mutex::new(ZenmuxBarCache::default()))
}

#[derive(Debug, Deserialize)]
struct ManagementEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct SubscriptionDetail {
    quota_5_hour: QuotaWindow,
    quota_7_day: QuotaWindow,
}

#[derive(Debug, Deserialize)]
struct QuotaWindow {
    usage_percentage: f64,
    resets_at: Option<String>,
}

/// Append a deterministic status bar for Feishu channel replies.
///
/// For now this is deliberately channel-scoped to Feishu because P2's goal is
/// replacing OpenClaw as the Feishu entrypoint. The helper is pure string
/// post-processing: it never changes model input and never blocks delivery on
/// ZenMux API failures.
pub async fn append_status_bar_for_channel(
    channel: &str,
    content: String,
    session: &AgentSession,
    total_tokens: i64,
    context_tokens: i64,
) -> String {
    if channel != "feishu" && !channel.starts_with("feishu:") {
        return content;
    }
    if content.trim().is_empty() {
        return content;
    }

    let model = session
        .runtime
        .read()
        .await
        .as_ref()
        .map(|rt| rt.model.clone())
        .unwrap_or_default();

    let context_total = session
        .runtime
        .read()
        .await
        .as_ref()
        .map(|rt| rt.resolved.context_window as i64)
        .unwrap_or(200_000)
        .max(1);

    // Per-session cumulative usage from `session_token_usage`: msg# is the
    // round count, and the equivalent-token figure sums total_tokens across
    // rounds (mirrors the OpenClaw status bar's cumulative weighting). Sync
    // DB read off the async path via spawn_blocking. agent-core owns the
    // same sessions.db, so we query the table directly (the writer side goes
    // through the `session_bridge` registered fn — there is no read bridge).
    let session_id = session.id.clone();
    let (msg_num, cumulative_total) = tokio::task::spawn_blocking(move || {
        query_session_usage(&session_id)
            .map(|(count, sum)| (count + 1, sum + total_tokens))
            .unwrap_or((0, total_tokens))
    })
    .await
    .unwrap_or((0, total_tokens));

    let zenmux = get_zenmux_bar_text()
        .await
        .unwrap_or_else(|| "ZenMux: (unavailable)".into());
    let session_label = session_context_label(&session.id);
    let bar = build_status_bar(
        cumulative_total,
        context_tokens,
        context_total,
        msg_num,
        &zenmux,
        &model,
        session_label.as_deref(),
    );
    format!("{}\n\n{}", content.trim_end(), bar)
}

fn build_status_bar(
    total_tokens: i64,
    context_tokens: i64,
    context_total: i64,
    msg_num: i64,
    zenmux: &str,
    model: &str,
    session_label: Option<&str>,
) -> String {
    let equiv_k = (total_tokens.max(0) + 999) / 1000;
    // Match the OpenClaw current extension threshold: 1,000k weighted tokens.
    let equiv_pct = ((total_tokens.max(0) as f64) / 1_000_000.0 * 100.0).round() as i64;
    let ctx_k = (context_tokens.max(0) + 999) / 1000;
    let ctx_total_k = (context_total + 999) / 1000;
    let ctx_pct = ((context_tokens.max(0) as f64) / (context_total as f64) * 100.0).round() as i64;

    let mut parts = vec![
        format!("📊 等效: {}k ({}%)", equiv_k, equiv_pct),
        "压缩: 0次".to_string(),
        format!("Context: {}k/{}k ({}%)", ctx_k, ctx_total_k, ctx_pct),
        format!("ZenMux {}", zenmux),
    ];
    if let Some(label) = session_label.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("📌 {}", label));
    }
    if msg_num > 0 {
        parts.push(format!("msg#{}", msg_num));
    }
    let short = shorten_model(model);
    if !short.is_empty() {
        parts.push(format!("🤖 {}", short));
    }
    parts.join(" · ")
}

fn session_context_label(session_id: &str) -> Option<String> {
    let row = crate::session::persistence::get_session(session_id)
        .ok()
        .flatten()?;
    let mut pieces = Vec::new();
    if let Some(project) = row.project_slug.filter(|s| !s.trim().is_empty()) {
        pieces.push(format!("项目:{}", project));
    } else if let Some(project) = row.project_name.filter(|s| !s.trim().is_empty()) {
        pieces.push(format!("项目:{}", project));
    }
    if let Some(item) = row.work_item_id.filter(|s| !s.trim().is_empty()) {
        pieces.push(format!("任务:{}", item));
    }
    if pieces.is_empty() {
        let name = row.name.trim();
        if !name.is_empty() && name != session_id {
            pieces.push(format!(
                "会话:{}",
                crate::utils::safe_truncate_chars_to_string(name, 24)
            ));
        }
    }
    if pieces.is_empty() {
        None
    } else {
        Some(pieces.join("/"))
    }
}

fn shorten_model(model: &str) -> String {
    let base = model.split(':').next().unwrap_or(model);
    let last = base.rsplit('/').next().unwrap_or(base);
    last.strip_prefix("claude-").unwrap_or(last).to_string()
}

/// Returns `(round_count, total_tokens_sum)` for a session from
/// `session_token_usage`. Direct query against agent-core's own sessions.db
/// connection — there is no read-side bridge, only the write-side
/// `session_bridge::record_token_usage`.
fn query_session_usage(session_id: &str) -> Option<(i64, i64)> {
    let conn = crate::foundation::db_bridge::get_connection().ok()?;
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(total_tokens), 0) \
         FROM session_token_usage WHERE session_id = ?1",
        [session_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .ok()
}

async fn get_zenmux_bar_text() -> Option<String> {
    let cached = {
        let guard = zenmux_cache().lock().ok()?;
        guard
            .fetched_at
            .filter(|ts| ts.elapsed() < ZENMUX_TTL)
            .and_then(|_| guard.text.clone())
    };
    if cached.is_some() {
        return cached;
    }

    match fetch_zenmux_bar_text().await {
        Some(text) => {
            if let Ok(mut guard) = zenmux_cache().lock() {
                guard.text = Some(text.clone());
                guard.fetched_at = Some(Instant::now());
            }
            Some(text)
        }
        None => zenmux_cache()
            .lock()
            .ok()
            .and_then(|guard| guard.text.clone()),
    }
}

async fn fetch_zenmux_bar_text() -> Option<String> {
    let resp = reqwest::Client::new()
        .get("https://zenmux.ai/api/v1/management/subscription/detail")
        .header("Authorization", format!("Bearer {}", ZENMUX_MGMT_KEY))
        .send()
        .await
        .ok()?;
    let envelope: ManagementEnvelope<SubscriptionDetail> = resp.json().await.ok()?;
    let h5_pct = envelope.data.quota_5_hour.usage_percentage * 100.0;
    let d7_pct = envelope.data.quota_7_day.usage_percentage * 100.0;
    let h5_reset = fmt_reset(envelope.data.quota_5_hour.resets_at.as_deref());
    let d7_reset = fmt_reset(envelope.data.quota_7_day.resets_at.as_deref());
    Some(format!(
        "5h:{:.1}%{} / 7d:{:.1}%{}",
        h5_pct,
        h5_reset.map(|s| format!("↻{}", s)).unwrap_or_default(),
        d7_pct,
        d7_reset.map(|s| format!("↻{}", s)).unwrap_or_default()
    ))
}

fn fmt_reset(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let dt = DateTime::parse_from_rfc3339(raw).ok()?.with_timezone(&Utc);
    let cst = dt + chrono::Duration::hours(8);
    let delta = dt - Utc::now();
    let secs = delta.num_seconds();
    let sign = if secs < 0 { "-" } else { "" };
    let abs = secs.abs();
    let days = abs / 86_400;
    let hours = (abs % 86_400) / 3_600;
    let mins = (abs % 3_600) / 60;
    let remain = if days >= 1 {
        format!("{}{}d{}h", sign, days, hours)
    } else if hours >= 1 {
        format!("{}{}h{:02}m", sign, hours, mins)
    } else {
        format!("{}{}m", sign, mins)
    };
    let label = if delta.num_hours() >= 12 {
        cst.format("%-m/%-d %H:%M").to_string()
    } else {
        cst.format("%H:%M").to_string()
    };
    Some(format!("{}({})", label, remain))
}

// ── Public quota API for GUI monitoring panel ────────────────────────────

/// Structured ZenMux quota status for the GUI monitoring panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZenmuxQuotaStatus {
    pub quota_5h_pct: f64,
    pub quota_7d_pct: f64,
    pub resets_5h: Option<String>,
    pub resets_7d: Option<String>,
}

/// Fetch ZenMux quota as structured data (cached, same 5-min TTL as the bar
/// text). Returns `None` when the API is unreachable and no stale value exists.
pub async fn get_zenmux_quota() -> Option<ZenmuxQuotaStatus> {
    // Re-use the existing bar-text fetch path to populate the cache, then
    // parse fresh data ourselves. This avoids duplicating HTTP + cache logic.
    let resp = reqwest::Client::new()
        .get("https://zenmux.ai/api/v1/management/subscription/detail")
        .header("Authorization", format!("Bearer {}", ZENMUX_MGMT_KEY))
        .send()
        .await
        .ok()?;
    let envelope: ManagementEnvelope<SubscriptionDetail> = resp.json().await.ok()?;
    Some(ZenmuxQuotaStatus {
        quota_5h_pct: (envelope.data.quota_5_hour.usage_percentage * 100.0 * 10.0).round() / 10.0,
        quota_7d_pct: (envelope.data.quota_7_day.usage_percentage * 100.0 * 10.0).round() / 10.0,
        resets_5h: envelope.data.quota_5_hour.resets_at,
        resets_7d: envelope.data.quota_7_day.resets_at,
    })
}

/// Query per-session token usage summary. Public so the monitoring Tauri
/// command can access it without duplicating the SQL.
pub fn get_session_token_summary(session_id: &str) -> Option<(i64, i64)> {
    query_session_usage(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_bar_has_expected_shape() {
        let bar = build_status_bar(
            12_345,
            67_890,
            200_000,
            7,
            "5h:1.0% / 7d:2.0%",
            "anthropic/claude-sonnet-4.6:anthropic",
            Some("项目:org2"),
        );
        assert!(bar.contains("📊 等效: 13k (1%)"));
        assert!(bar.contains("Context: 68k/200k (34%)"));
        assert!(bar.contains("ZenMux 5h:1.0% / 7d:2.0%"));
        assert!(bar.contains("📌 项目:org2"));
        assert!(bar.contains("msg#7"));
        assert!(bar.contains("🤖 sonnet-4.6"));
    }
}
