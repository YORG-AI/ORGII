//! Kimi Code quota lookup for explicitly pinned Kimi Code API accounts.
//!
//! This intentionally supports only the fixed Kimi Code API route. It does not
//! inspect CLI credentials, refresh OAuth tokens, read browser cookies, or
//! probe Kimi's multi-request web membership endpoints.

use serde_json::Value;

use crate::providers::quota_http::get_bearer_json;
use crate::providers::quota_windows::{json_time_to_rfc3339, quota_from_windows, QuotaWindow};
use crate::types::QuotaInfo;

const KIMI_CODE_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
const KIMI_CODE_HOST: &str = "api.kimi.com";
const PLAN_TYPE_DEFAULT: &str = "Kimi Code";
const QUOTA_SOURCE: &str = "kimi_code_usage";
const MAX_API_KEY_BYTES: usize = 64 * 1024;
const MAX_PLAN_LABEL_BYTES: usize = 64;
const MAX_LIMIT_ROWS: usize = 32;
const SESSION_MAX_MINUTES: f64 = 6.0 * 60.0;

pub struct KimiCodeQuotaFetcher;

impl KimiCodeQuotaFetcher {
    pub fn new() -> Self {
        Self
    }

    /// Fetch the fixed Kimi Code usage endpoint with exactly one GET.
    pub async fn fetch_quota(
        &self,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("Kimi Code account has no API key".to_string());
        }
        if api_key.len() > MAX_API_KEY_BYTES {
            return Err(format!(
                "Kimi Code API key exceeds the {MAX_API_KEY_BYTES}-byte request-header limit"
            ));
        }
        validate_kimi_code_base_url(base_url)?;

        let body = get_bearer_json("Kimi Code", KIMI_CODE_USAGE_URL, api_key)
            .await
            .map_err(|error| error.to_string())?;
        parse_kimi_code_quota(&body)
    }
}

impl Default for KimiCodeQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn has_supported_base_url(base_url: Option<&str>) -> bool {
    validate_kimi_code_base_url(base_url).is_ok()
}

fn validate_kimi_code_base_url(base_url: Option<&str>) -> Result<(), String> {
    let base_url = base_url
        .map(str::trim)
        .filter(|base_url| !base_url.is_empty())
        .ok_or_else(|| {
            "Kimi Code quota requires an explicitly saved api.kimi.com/coding base URL".to_string()
        })?;
    let parsed = url::Url::parse(base_url)
        .map_err(|error| format!("Invalid Kimi Code base URL: {error}"))?;
    let path = parsed.path().trim_end_matches('/');
    let is_supported = parsed.scheme() == "https"
        && parsed.host_str() == Some(KIMI_CODE_HOST)
        && parsed.port_or_known_default() == Some(443)
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
        && matches!(path, "/coding" | "/coding/v1");
    if is_supported {
        Ok(())
    } else {
        Err(
            "Kimi Code quota base URL must be https://api.kimi.com/coding or \
             https://api.kimi.com/coding/v1"
                .to_string(),
        )
    }
}

fn parse_kimi_code_quota(body: &Value) -> Result<QuotaInfo, String> {
    let mut session = None;
    if let Some(limits) = body.get("limits").and_then(Value::as_array) {
        for entry in limits.iter().take(MAX_LIMIT_ROWS) {
            let Some(window_minutes) = entry.get("window").and_then(kimi_window_minutes) else {
                continue;
            };
            if window_minutes > SESSION_MAX_MINUTES {
                continue;
            }
            let Some(detail) = entry.get("detail") else {
                continue;
            };
            if let Some((used_percent, reset_time)) = parse_quota_detail(detail) {
                session = Some(QuotaWindow::session(used_percent, reset_time));
                break;
            }
        }
    }

    let weekly = body
        .get("usage")
        .and_then(parse_quota_detail)
        .map(|(used_percent, reset_time)| QuotaWindow::weekly(used_percent, reset_time));

    let mut windows = Vec::with_capacity(2);
    if let Some(session) = session {
        windows.push(session);
    }
    if let Some(weekly) = weekly {
        windows.push(weekly);
    }
    if windows.is_empty() {
        return Err(
            "Kimi Code quota HTTP 200 response has no usable session or weekly window".to_string(),
        );
    }

    let plan_type = body
        .pointer("/user/membership/level")
        .and_then(Value::as_str)
        .and_then(normalize_plan_label)
        .unwrap_or_else(|| PLAN_TYPE_DEFAULT.to_string());
    Ok(quota_from_windows(&plan_type, QUOTA_SOURCE, windows))
}

fn parse_quota_detail(detail: &Value) -> Option<(f64, Option<String>)> {
    let limit = detail.get("limit").and_then(finite_number)?;
    if limit <= 0.0 {
        return None;
    }
    let remaining = detail
        .get("remaining")
        .and_then(finite_number)
        .map(|remaining| remaining.max(0.0));
    let used = detail
        .get("used")
        .and_then(finite_number)
        .map(|used| used.max(0.0))
        .or_else(|| remaining.map(|remaining| (limit - remaining).max(0.0)))?;
    let used_percent = (used / limit * 100.0).clamp(0.0, 100.0);
    let reset_time = detail.get("resetTime").and_then(json_time_to_rfc3339);
    Some((used_percent, reset_time))
}

fn kimi_window_minutes(window: &Value) -> Option<f64> {
    let duration = window.get("duration").and_then(finite_number)?;
    if duration <= 0.0 {
        return None;
    }
    match window
        .get("timeUnit")
        .or_else(|| window.get("time_unit"))
        .and_then(Value::as_str)?
    {
        "TIME_UNIT_MINUTE" => Some(duration),
        "TIME_UNIT_HOUR" => Some(duration * 60.0),
        "TIME_UNIT_DAY" => Some(duration * 24.0 * 60.0),
        "TIME_UNIT_WEEK" => Some(duration * 7.0 * 24.0 * 60.0),
        _ => None,
    }
}

fn finite_number(value: &Value) -> Option<f64> {
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    number.is_finite().then_some(number)
}

fn normalize_plan_label(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_PLAN_LABEL_BYTES {
        return None;
    }
    let label = raw
        .strip_prefix("LEVEL_")
        .unwrap_or(raw)
        .replace('_', " ")
        .split_whitespace()
        .map(title_case_ascii)
        .collect::<Vec<_>>()
        .join(" ");
    (!label.is_empty() && label.len() <= MAX_PLAN_LABEL_BYTES).then_some(label)
}

fn title_case_ascii(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) if first.is_ascii() => first
            .to_ascii_uppercase()
            .to_string()
            .chars()
            .chain(chars.flat_map(char::to_lowercase))
            .collect(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_url_accepts_only_the_fixed_kimi_code_route() {
        for supported in [
            "https://api.kimi.com/coding",
            "https://api.kimi.com/coding/",
            "https://api.kimi.com/coding/v1",
            "https://api.kimi.com/coding/v1/",
        ] {
            assert!(has_supported_base_url(Some(supported)), "{supported}");
        }
        for rejected in [
            "https://api.moonshot.ai/v1",
            "https://api.kimi.com",
            "https://api.kimi.com/coding/v2",
            "http://api.kimi.com/coding",
            "https://api.kimi.com.evil.test/coding",
            "https://api.kimi.com/coding?region=other",
        ] {
            assert!(!has_supported_base_url(Some(rejected)), "{rejected}");
        }
        assert!(!has_supported_base_url(None));
        assert_eq!(KIMI_CODE_USAGE_URL, "https://api.kimi.com/coding/v1/usages");
    }

    #[test]
    fn canonical_response_maps_five_hour_and_weekly_windows() {
        let quota = parse_kimi_code_quota(&json!({
            "usage": {
                "limit": "2048",
                "used": "214",
                "remaining": "1834",
                "resetTime": "2026-07-14T00:00:00Z"
            },
            "limits": [{
                "window": {
                    "duration": 300,
                    "timeUnit": "TIME_UNIT_MINUTE"
                },
                "detail": {
                    "limit": "200",
                    "used": "139",
                    "remaining": "61",
                    "resetTime": "2026-07-08T05:00:00Z"
                }
            }],
            "user": {
                "membership": {
                    "level": "LEVEL_PRO_PLUS"
                }
            }
        }))
        .unwrap();

        assert_eq!(quota.plan_type.as_deref(), Some("Pro Plus"));
        assert_eq!(quota.quota_source.as_deref(), Some(QUOTA_SOURCE));
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert_eq!(quota.usage_items[0].remaining_percentage, 30.5);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-07-08T05:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert!((quota.usage_items[1].remaining_percentage - 89.55078125).abs() < f64::EPSILON);
    }

    #[test]
    fn parser_uses_limit_minus_remaining_when_used_is_absent() {
        let quota = parse_kimi_code_quota(&json!({
            "usage": {
                "limit": "100",
                "remaining": "75"
            }
        }))
        .unwrap();

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
        assert_eq!(quota.usage_items[0].remaining_percentage, 75.0);
    }

    #[test]
    fn parser_rejects_empty_success_and_bounds_limit_rows() {
        let error = parse_kimi_code_quota(&json!({"limits": []})).unwrap_err();
        assert!(error.contains("HTTP 200"));
        assert!(error.contains("no usable"));

        let limits = (0..MAX_LIMIT_ROWS + 10)
            .map(|index| {
                json!({
                    "window": {
                        "duration": if index == MAX_LIMIT_ROWS + 1 { 300 } else { 7 },
                        "timeUnit": if index == MAX_LIMIT_ROWS + 1 {
                            "TIME_UNIT_MINUTE"
                        } else {
                            "TIME_UNIT_DAY"
                        }
                    },
                    "detail": {"limit": 100, "remaining": 50}
                })
            })
            .collect::<Vec<_>>();
        let error = parse_kimi_code_quota(&json!({"limits": limits})).unwrap_err();
        assert!(error.contains("no usable"));
    }

    #[tokio::test]
    async fn oversized_api_key_is_rejected_before_request_construction() {
        let api_key = "x".repeat(MAX_API_KEY_BYTES + 1);
        let error = KimiCodeQuotaFetcher::new()
            .fetch_quota(&api_key, Some("https://api.kimi.com/coding"))
            .await
            .unwrap_err();
        assert!(error.contains("request-header limit"));
    }
}
