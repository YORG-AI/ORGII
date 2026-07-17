//! Zhipu (BigModel / Z.ai) GLM Coding Plan quota fetching.
//!
//! Zhipu exposes coding-plan usage/quota via a `monitor` API, mirrored from the
//! official `zai-org/zai-coding-plugins` (`glm-plan-usage`) plugin:
//!   - Quota limit: `{base}/api/monitor/usage/quota/limit`
//!
//! Auth uses the raw API key in the `Authorization` header (no `Bearer` prefix).
//!
//! The endpoint returns two `TOKENS_LIMIT` windows — the 5-hour window (first)
//! and the weekly window (second) — plus a `TIME_LIMIT` monthly MCP allowance
//! that we ignore. Pay-as-you-go API keys have no coding-plan quota; for those
//! the endpoint returns 4xx or empty limits and we surface a "Pay-as-you-go"
//! `QuotaInfo` (unlimited, no usage bar) instead of an error.

use serde::Deserialize;
use std::time::Duration;

use crate::providers::quota_windows::{quota_from_windows, QuotaWindow};
use crate::types::QuotaInfo;

const HTTP_TIMEOUT_SECS: u64 = 15;

/// Default host when the key has no stored base URL (China / BigModel).
const DEFAULT_HOST: &str = "https://open.bigmodel.cn";
/// Global (Z.ai) host.
const ZAI_HOST: &str = "https://api.z.ai";

/// The monitor endpoint returns the 5-hour and weekly prompt windows both typed
/// as `TOKENS_LIMIT` (the weekly one is the second entry). `TIME_LIMIT` is the
/// monthly MCP allowance, which we intentionally do not surface.
const TOKENS_LIMIT_TYPE: &str = "TOKENS_LIMIT";

const SESSION_USAGE_TYPE: &str = "session";
const WEEKLY_USAGE_TYPE: &str = "weekly";
const QUOTA_SOURCE: &str = "zhipu_monitor";
const PLAN_TYPE_CODING: &str = "GLM Coding Plan";
const PLAN_TYPE_PAYG: &str = "Pay-as-you-go";

/// `{ "data": { "limits": [...] } }` wrapper returned by the monitor endpoint.
#[derive(Debug, Deserialize)]
struct QuotaLimitEnvelope {
    #[serde(default)]
    data: Option<QuotaLimitData>,
}

#[derive(Debug, Deserialize)]
struct QuotaLimitData {
    #[serde(default)]
    limits: Vec<QuotaLimit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaLimit {
    /// `TOKENS_LIMIT` (5-hour and weekly prompt windows) or `TIME_LIMIT`
    /// (monthly MCP allowance, which we ignore).
    #[serde(default)]
    r#type: Option<String>,
    /// Percentage of the window consumed (0-100).
    #[serde(default)]
    percentage: Option<f64>,
}

/// Zhipu GLM Coding Plan quota fetcher.
pub struct ZhipuQuotaFetcher {
    client: reqwest::Client,
    http_timeout: Duration,
}

impl ZhipuQuotaFetcher {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            http_timeout: Duration::from_secs(HTTP_TIMEOUT_SECS),
        }
    }

    /// Resolve the monitor API host from the key's stored base URL.
    ///
    /// Global (Z.ai) keys use `api.z.ai`; everything else (BigModel China,
    /// including `dev.bigmodel.cn`) falls back to `open.bigmodel.cn`.
    fn resolve_host(base_url: Option<&str>) -> &'static str {
        match base_url {
            Some(url) if url.contains("z.ai") => ZAI_HOST,
            _ => DEFAULT_HOST,
        }
    }

    /// Fetch GLM Coding Plan quota for a Zhipu API key.
    ///
    /// # Arguments
    /// * `api_key` - Zhipu API key (coding-plan or pay-as-you-go).
    /// * `base_url` - The key's stored base URL, used to pick China vs Global host.
    pub async fn fetch_quota(
        &self,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("No API key provided".to_string());
        }

        let host = Self::resolve_host(base_url);
        let url = format!("{host}/api/monitor/usage/quota/limit");

        let response = self
            .client
            .get(&url)
            .header("Authorization", api_key)
            .header("Accept-Language", "en-US,en")
            .header("Content-Type", "application/json")
            .timeout(self.http_timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = response.status();

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Zhipu API key is invalid or expired".to_string());
        }

        // A non-plan (pay-as-you-go) key has no coding-plan quota; the monitor
        // endpoint rejects it. Surface a Pay-as-you-go card instead of an error.
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
            return Ok(payg_quota());
        }

        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }

        let envelope: QuotaLimitEnvelope = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {e}"))?;

        let limits = envelope.data.map(|data| data.limits).unwrap_or_default();

        Ok(parse_quota_limits(limits))
    }
}

impl Default for ZhipuQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a Pay-as-you-go `QuotaInfo` (no coding-plan quota to report).
fn payg_quota() -> QuotaInfo {
    QuotaInfo {
        remaining_percentage: 100.0,
        is_unlimited: true,
        plan_type: Some(PLAN_TYPE_PAYG.to_string()),
        quota_source: Some(QUOTA_SOURCE.to_string()),
        ..Default::default()
    }
}

/// Parse the monitor `limits[]` into a `QuotaInfo`.
///
/// The two `TOKENS_LIMIT` windows map to `session` (5-hour, first) and `weekly`
/// (second). `TIME_LIMIT` (monthly MCP) is ignored.
fn parse_quota_limits(limits: Vec<QuotaLimit>) -> QuotaInfo {
    // Collect the prompt windows in order; the first is the 5-hour window and
    // the second is the weekly window.
    let token_windows: Vec<f64> = limits
        .iter()
        .filter(|limit| limit.r#type.as_deref() == Some(TOKENS_LIMIT_TYPE))
        .map(|limit| limit.percentage.unwrap_or(0.0))
        .collect();

    // No prompt windows → pay-as-you-go (no coding-plan quota).
    if token_windows.is_empty() {
        return payg_quota();
    }

    let mut windows: Vec<QuotaWindow> = Vec::new();
    if let Some(used_percent) = token_windows.first() {
        windows.push(QuotaWindow {
            usage_type: SESSION_USAGE_TYPE,
            used_percent: *used_percent,
            reset_time: None,
        });
    }
    if let Some(used_percent) = token_windows.get(1) {
        windows.push(QuotaWindow {
            usage_type: WEEKLY_USAGE_TYPE,
            used_percent: *used_percent,
            reset_time: None,
        });
    }

    quota_from_windows(PLAN_TYPE_CODING, QUOTA_SOURCE, windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_host_defaults_to_bigmodel() {
        assert_eq!(ZhipuQuotaFetcher::resolve_host(None), DEFAULT_HOST);
        assert_eq!(
            ZhipuQuotaFetcher::resolve_host(Some("https://open.bigmodel.cn/api/paas/v4")),
            DEFAULT_HOST
        );
        assert_eq!(
            ZhipuQuotaFetcher::resolve_host(Some("https://dev.bigmodel.cn/api/paas/v4")),
            DEFAULT_HOST
        );
    }

    #[test]
    fn resolve_host_picks_zai_for_global() {
        assert_eq!(
            ZhipuQuotaFetcher::resolve_host(Some("https://api.z.ai/api/paas/v4")),
            ZAI_HOST
        );
        assert_eq!(
            ZhipuQuotaFetcher::resolve_host(Some("https://api.z.ai/api/anthropic")),
            ZAI_HOST
        );
    }

    #[test]
    fn empty_limits_is_payg() {
        let quota = parse_quota_limits(Vec::new());
        assert_eq!(quota.plan_type.as_deref(), Some(PLAN_TYPE_PAYG));
        assert!(quota.is_unlimited);
        assert!(quota.usage_items.is_empty());
    }

    #[test]
    fn tokens_limit_drives_session_window() {
        let quota = parse_quota_limits(vec![QuotaLimit {
            r#type: Some(TOKENS_LIMIT_TYPE.to_string()),
            percentage: Some(25.0),
        }]);
        assert_eq!(quota.plan_type.as_deref(), Some(PLAN_TYPE_CODING));
        assert!(!quota.is_unlimited);
        assert!((quota.remaining_percentage - 75.0).abs() < f64::EPSILON);
        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, SESSION_USAGE_TYPE);
    }

    #[test]
    fn two_windows_map_to_session_and_weekly() {
        // First TOKENS_LIMIT → session (5h), second → weekly. TIME_LIMIT ignored.
        let quota = parse_quota_limits(vec![
            QuotaLimit {
                r#type: Some(TOKENS_LIMIT_TYPE.to_string()),
                percentage: Some(0.0),
            },
            QuotaLimit {
                r#type: Some(TOKENS_LIMIT_TYPE.to_string()),
                percentage: Some(72.0),
            },
            QuotaLimit {
                r#type: Some("TIME_LIMIT".to_string()),
                percentage: Some(3.0),
            },
        ]);
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, SESSION_USAGE_TYPE);
        assert!((quota.usage_items[0].remaining_percentage - 100.0).abs() < f64::EPSILON);
        assert_eq!(quota.usage_items[1].usage_type, WEEKLY_USAGE_TYPE);
        assert!((quota.usage_items[1].remaining_percentage - 28.0).abs() < f64::EPSILON);
        // No MCP item.
        assert!(quota
            .usage_items
            .iter()
            .all(|item| item.usage_type != "mcp"));
    }

    #[test]
    fn time_limit_only_is_payg() {
        // Only a monthly MCP window and no prompt windows → pay-as-you-go.
        let quota = parse_quota_limits(vec![QuotaLimit {
            r#type: Some("TIME_LIMIT".to_string()),
            percentage: Some(40.0),
        }]);
        assert_eq!(quota.plan_type.as_deref(), Some(PLAN_TYPE_PAYG));
        assert!(quota.is_unlimited);
        assert!(quota.usage_items.is_empty());
    }
}
