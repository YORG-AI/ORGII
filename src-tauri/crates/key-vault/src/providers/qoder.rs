//! Qoder web-session credit quota lookup.
//!
//! The stored cookie is used only on an explicitly pinned Qoder region. Usage
//! costs one GET. A second same-region request is allowed solely to fill a
//! missing plan label after usable quota has already been parsed.

use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, COOKIE, ORIGIN, REFERER, USER_AGENT,
};
use serde_json::Value;

use crate::providers::quota_http::get_json_with_headers;
use crate::providers::quota_windows::json_time_to_rfc3339;
use crate::types::{QuotaInfo, UsageItem};

const GLOBAL_ORIGIN: &str = "https://qoder.com";
const CN_ORIGIN: &str = "https://qoder.com.cn";
const QUOTA_SOURCE: &str = "qoder_big_model_credits";
const PLAN_TYPE_DEFAULT: &str = "Qoder";
const MAX_COOKIE_BYTES: usize = 64 * 1024;
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QoderRegion {
    Global,
    Cn,
}

impl QoderRegion {
    fn origin(self) -> &'static str {
        match self {
            Self::Global => GLOBAL_ORIGIN,
            Self::Cn => CN_ORIGIN,
        }
    }

    fn usage_url(self) -> String {
        format!("{}/api/v2/me/usages/big_model_credits", self.origin())
    }

    fn plan_url(self) -> String {
        format!("{}/api/v1/me/userplan", self.origin())
    }
}

pub struct QoderQuotaFetcher;

impl QoderQuotaFetcher {
    pub fn new() -> Self {
        Self
    }

    /// Fetch usage in one request, with at most one plan-label-only fallback.
    pub async fn fetch_quota(
        &self,
        cookie: &str,
        base_url: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        let cookie = cookie.trim();
        if cookie.is_empty() {
            return Err("Qoder account has no saved cookie or token".to_string());
        }
        let region = resolve_region(base_url)?;
        let headers = qoder_headers(cookie, region)?;
        let body = get_json_with_headers("Qoder", &region.usage_url(), headers.clone())
            .await
            .map_err(|error| error.to_string())?;
        let mut quota = parse_qoder_quota(&body)?;

        if quota.plan_type.as_deref() == Some(PLAN_TYPE_DEFAULT) {
            if let Ok(plan_body) =
                get_json_with_headers("Qoder plan", &region.plan_url(), headers).await
            {
                if let Some(plan) = parse_qoder_plan_label(&plan_body) {
                    quota.plan_type = Some(plan);
                }
            }
        }
        Ok(quota)
    }
}

impl Default for QoderQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

fn resolve_region(base_url: Option<&str>) -> Result<QoderRegion, String> {
    let Some(base_url) = base_url
        .map(str::trim)
        .filter(|base_url| !base_url.is_empty())
    else {
        return Ok(QoderRegion::Global);
    };
    let parsed =
        url::Url::parse(base_url).map_err(|error| format!("Invalid Qoder base URL: {error}"))?;
    match parsed.host_str().map(|host| host.to_ascii_lowercase()) {
        Some(host) if matches!(host.as_str(), "qoder.com" | "www.qoder.com") => {
            Ok(QoderRegion::Global)
        }
        Some(host) if matches!(host.as_str(), "qoder.com.cn" | "www.qoder.com.cn") => {
            Ok(QoderRegion::Cn)
        }
        _ => Err("Qoder base URL must select qoder.com or qoder.com.cn".to_string()),
    }
}

pub(crate) fn has_supported_region(base_url: Option<&str>) -> bool {
    resolve_region(base_url).is_ok()
}

fn qoder_headers(cookie: &str, region: QoderRegion) -> Result<HeaderMap, String> {
    let origin = region.origin();
    let mut headers = HeaderMap::with_capacity(8);
    headers.insert(COOKIE, header_value(cookie, "Qoder cookie")?);
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
    headers.insert(ORIGIN, HeaderValue::from_static(origin));
    headers.insert(
        REFERER,
        header_value(&format!("{origin}/account/usage"), "Qoder referrer")?,
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("x-requested-with"),
        HeaderValue::from_static("XMLHttpRequest"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("bx-v"),
        HeaderValue::from_static("2.5.35"),
    );
    Ok(headers)
}

fn header_value(value: &str, field: &str) -> Result<HeaderValue, String> {
    if value.len() > MAX_COOKIE_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_COOKIE_BYTES}-byte request-header limit"
        ));
    }
    HeaderValue::from_str(value).map_err(|_| format!("{field} is not a valid HTTP header value"))
}

#[derive(Debug)]
struct CreditSummary {
    used: f64,
    limit: f64,
    remaining: f64,
    usage_percentage: Option<f64>,
}

fn parse_qoder_quota(body: &Value) -> Result<QuotaInfo, String> {
    let payload = body
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(body);
    let total = payload
        .get("totalQuota")
        .or_else(|| payload.get("total_quota"))
        .and_then(quota_summary)
        .and_then(parse_credit_summary)
        .ok_or_else(|| {
            "Qoder quota HTTP 200 response has no usable totalQuota.quotaSummary".to_string()
        })?;
    let shared = payload
        .get("sharedQuota")
        .or_else(|| payload.get("shared_quota"))
        .and_then(quota_summary)
        .and_then(parse_credit_summary);

    let used = total.used + shared.as_ref().map_or(0.0, |summary| summary.used);
    let limit = total.limit + shared.as_ref().map_or(0.0, |summary| summary.limit);
    let remaining = total.remaining + shared.as_ref().map_or(0.0, |summary| summary.remaining);
    let used_percent = if limit > 0.0 {
        (used / limit * 100.0).clamp(0.0, 100.0)
    } else {
        total.usage_percentage.unwrap_or(100.0)
    };
    let remaining_percent = 100.0 - used_percent;
    let reset_time = payload
        .get("nextResetAt")
        .or_else(|| payload.get("next_reset_at"))
        .and_then(json_time_to_rfc3339);
    let plan_type = parse_qoder_plan_label(body).unwrap_or_else(|| PLAN_TYPE_DEFAULT.to_string());

    Ok(QuotaInfo {
        remaining_percentage: remaining_percent,
        used: Some(used.round() as i64),
        limit: Some(limit.round() as i64),
        remaining: Some(remaining.round() as i64),
        reset_time: reset_time.clone(),
        plan_type: Some(plan_type),
        quota_source: Some(QUOTA_SOURCE.to_string()),
        usage_items: vec![UsageItem {
            usage_type: "credits".to_string(),
            enabled: true,
            used: Some(used.round() as i64),
            limit: Some(limit.round() as i64),
            remaining: Some(remaining.round() as i64),
            remaining_percentage: remaining_percent,
            reset_time,
        }],
        ..Default::default()
    })
}

fn quota_summary(value: &Value) -> Option<&Value> {
    value
        .get("quotaSummary")
        .or_else(|| value.get("quota_summary"))
}

fn parse_credit_summary(summary: &Value) -> Option<CreditSummary> {
    let used = finite_number(
        summary
            .get("usedValue")
            .or_else(|| summary.get("used_value")),
    )?;
    let limit = finite_number(
        summary
            .get("limitValue")
            .or_else(|| summary.get("limit_value")),
    )?;
    if used < 0.0 || limit < 0.0 {
        return None;
    }
    let remaining = finite_number(
        summary
            .get("remainingValue")
            .or_else(|| summary.get("remaining_value")),
    )
    .unwrap_or_else(|| (limit - used).max(0.0))
    .max(0.0);
    let usage_percentage = finite_number(
        summary
            .get("usagePercentage")
            .or_else(|| summary.get("usage_percentage")),
    )
    .map(|percentage| percentage.clamp(0.0, 100.0));
    Some(CreditSummary {
        used,
        limit,
        remaining,
        usage_percentage,
    })
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    number.is_finite().then_some(number)
}

fn parse_qoder_plan_label(body: &Value) -> Option<String> {
    let data = body.get("data").filter(|value| value.is_object());
    let subscription = data
        .and_then(|value| value.get("subscription"))
        .or_else(|| body.get("subscription"));
    let current = data
        .and_then(|value| {
            value
                .get("current")
                .or_else(|| value.get("currentPlan"))
                .or_else(|| value.get("current_plan"))
        })
        .or_else(|| {
            body.get("current")
                .or_else(|| body.get("currentPlan"))
                .or_else(|| body.get("current_plan"))
        });

    [Some(body), data, subscription, current]
        .into_iter()
        .flatten()
        .find_map(first_plan_label)
}

fn first_plan_label(value: &Value) -> Option<String> {
    [
        "plan_tier",
        "planTier",
        "plan",
        "tier",
        "name",
        "product_name",
        "productName",
        "subscription_type",
        "subscriptionType",
    ]
    .into_iter()
    .find_map(|field| value.get(field).and_then(Value::as_str))
    .and_then(normalize_plan_label)
}

fn normalize_plan_label(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let uppercase = raw.to_ascii_uppercase();
    let without_prefix = if uppercase.starts_with("ORGANIZATION_PLAN_TIER_") {
        &raw["ORGANIZATION_PLAN_TIER_".len()..]
    } else if uppercase.starts_with("PLAN_TIER_") {
        &raw["PLAN_TIER_".len()..]
    } else {
        raw
    };
    let normalized = without_prefix
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let known = match normalized.as_str() {
        "free" | "community" | "communityedition" | "community edition" => {
            Some("Community Edition")
        }
        "protrial" | "pro trial" => Some("Pro Trial"),
        "pro" => Some("Pro"),
        "proplus" | "pro plus" | "pro+" => Some("Pro+"),
        "ultra" => Some("Ultra"),
        "team" | "teams" => Some("Teams"),
        "enterprise" => Some("Enterprise"),
        _ => None,
    };
    Some(
        known
            .map(str::to_string)
            .unwrap_or_else(|| title_case(&normalized)),
    )
}

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut characters = word.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().chain(characters).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_url_pins_exactly_one_region() {
        assert_eq!(resolve_region(None).unwrap(), QoderRegion::Global);
        assert_eq!(
            resolve_region(Some("https://qoder.com/account")).unwrap(),
            QoderRegion::Global
        );
        assert_eq!(
            resolve_region(Some("https://www.qoder.com.cn/account")).unwrap(),
            QoderRegion::Cn
        );
        assert!(resolve_region(Some("https://example.com")).is_err());
        assert!(!has_supported_region(Some("https://example.com")));
    }

    #[test]
    fn parser_combines_total_and_shared_credits() {
        let quota = parse_qoder_quota(&json!({
            "data": {
                "planTier": "PLAN_TIER_PRO_PLUS",
                "totalQuota": {
                    "quotaSummary": {
                        "usedValue": "20",
                        "limitValue": 100,
                        "remainingValue": 80
                    }
                },
                "shared_quota": {
                    "quota_summary": {
                        "used_value": 10,
                        "limit_value": "100",
                        "remaining_value": 90
                    }
                },
                "nextResetAt": 1785564000000_i64
            }
        }))
        .unwrap();

        assert_eq!(quota.plan_type.as_deref(), Some("Pro+"));
        assert_eq!(quota.used, Some(30));
        assert_eq!(quota.limit, Some(200));
        assert_eq!(quota.remaining, Some(170));
        assert_eq!(quota.remaining_percentage, 85.0);
        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "credits");
        assert_eq!(quota.reset_time.as_deref(), Some("2026-08-01T06:00:00Z"));
    }

    #[test]
    fn plan_parser_handles_nested_subscription_and_known_tiers() {
        assert_eq!(
            parse_qoder_plan_label(&json!({
                "data": {
                    "subscription": {"subscription_type": "ORGANIZATION_PLAN_TIER_TEAM"}
                }
            }))
            .as_deref(),
            Some("Teams")
        );
        assert_eq!(
            parse_qoder_plan_label(&json!({"data": {"current_plan": {"name": "alpha-plan"}}}))
                .as_deref(),
            Some("Alpha Plan")
        );
    }

    #[test]
    fn parser_rejects_missing_total_summary() {
        let error = parse_qoder_quota(&json!({"data": {}})).unwrap_err();
        assert!(error.contains("HTTP 200"));
        assert!(error.contains("totalQuota.quotaSummary"));
    }

    #[test]
    fn cookie_header_has_an_explicit_memory_bound() {
        let oversized = "x".repeat(MAX_COOKIE_BYTES + 1);
        let error = header_value(&oversized, "Qoder cookie").unwrap_err();
        assert!(error.contains("request-header limit"));
    }
}
