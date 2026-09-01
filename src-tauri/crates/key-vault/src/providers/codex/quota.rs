//! Codex quota mapping for the ChatGPT usage API and the app-server rate-limit RPC.

use crate::providers::quota_windows::{quota_from_windows, unix_seconds_to_rfc3339, QuotaWindow};
use crate::types::QuotaInfo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindow {
    used_percent: Option<f64>,
    window_duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimitsPayload {
    primary: Option<CodexRateLimitWindow>,
    secondary: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitResetCredits {
    available_count: Option<u64>,
    total_earned_count: Option<u64>,
    next_expires_at: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexRateLimitsResponse {
    rate_limits: Option<CodexRateLimitsPayload>,
    rate_limit_reset_credits: Option<CodexRateLimitResetCredits>,
}

fn parse_usage_window_reset(window: &serde_json::Value) -> Option<String> {
    window
        .get("reset_at")
        .or_else(|| window.get("resets_at"))
        .or_else(|| window.get("resetAt"))
        .or_else(|| window.get("resetsAt"))
        .and_then(|value| {
            if let Some(ts) = value.as_i64() {
                unix_seconds_to_rfc3339(ts)
            } else {
                value.as_str().map(str::to_string).and_then(|text| {
                    crate::providers::quota_windows::normalize_reset_time(&text).or(Some(text))
                })
            }
        })
}

fn parse_usage_window_percent(window: &serde_json::Value) -> Option<f64> {
    window
        .get("used_percent")
        .or_else(|| window.get("usedPercent"))
        .or_else(|| window.get("percent_used"))
        .or_else(|| window.get("percentUsed"))
        .or_else(|| window.get("usage_percent"))
        .or_else(|| window.get("usagePercent"))
        .or_else(|| window.get("utilization"))
        .and_then(|value| value.as_f64())
}

fn parse_usage_window_duration_minutes(window: &serde_json::Value) -> Option<i64> {
    window
        .get("window_duration_mins")
        .or_else(|| window.get("windowDurationMins"))
        .or_else(|| window.get("window_minutes"))
        .or_else(|| window.get("windowMinutes"))
        .and_then(|value| value.as_i64())
        .filter(|minutes| *minutes > 0)
        .or_else(|| {
            window
                .get("limit_window_seconds")
                .or_else(|| window.get("limitWindowSeconds"))
                .and_then(|value| value.as_i64())
                .filter(|seconds| *seconds > 0)
                .map(|seconds| seconds.saturating_add(59) / 60)
        })
}

fn codex_quota_window(
    used_percent: f64,
    reset_time: Option<String>,
    window_duration_mins: Option<i64>,
    fallback: fn(f64, Option<String>) -> QuotaWindow,
) -> QuotaWindow {
    match window_duration_mins {
        // Codex currently reports a 300-minute session window and a
        // 10,080-minute weekly window. Classify by the supplied duration so a
        // temporarily absent 5-hour limit cannot relabel the weekly window.
        Some(minutes) if minutes >= 24 * 60 => QuotaWindow::weekly(used_percent, reset_time),
        Some(_) => QuotaWindow::session(used_percent, reset_time),
        None => fallback(used_percent, reset_time),
    }
}

fn push_usage_window(
    windows: &mut Vec<QuotaWindow>,
    fallback_usage_type: fn(f64, Option<String>) -> QuotaWindow,
    window: Option<&serde_json::Value>,
) {
    if let Some(window) = window {
        if let Some(used_percent) = parse_usage_window_percent(window) {
            windows.push(codex_quota_window(
                used_percent,
                parse_usage_window_reset(window),
                parse_usage_window_duration_minutes(window),
                fallback_usage_type,
            ));
        }
    }
}

pub(super) fn quota_from_usage_json(data: &serde_json::Value) -> Option<QuotaInfo> {
    let rate_limit = data
        .get("rate_limit")
        .or_else(|| data.get("rate_limits"))
        .unwrap_or(data);
    let mut windows = Vec::new();

    let primary_window = rate_limit
        .get("primary_window")
        .or_else(|| rate_limit.get("primary"));
    let five_hour_window = rate_limit
        .get("five_hour")
        .or_else(|| data.get("five_hour"));
    let weekly_window = rate_limit
        .get("secondary_window")
        .or_else(|| rate_limit.get("secondary"))
        .or_else(|| rate_limit.get("seven_day"))
        .or_else(|| data.get("seven_day"));

    if primary_window.is_some() {
        // Older payloads did not include the window duration. When OpenAI
        // returns only a generic primary window, it is the surviving weekly
        // limit; when a secondary window is also present, primary is the 5h
        // limit. Explicit duration metadata always wins in codex_quota_window.
        let fallback: fn(f64, Option<String>) -> QuotaWindow = if weekly_window.is_some() {
            QuotaWindow::session
        } else {
            QuotaWindow::weekly
        };
        push_usage_window(&mut windows, fallback, primary_window);
    } else {
        push_usage_window(&mut windows, QuotaWindow::session, five_hour_window);
    }
    push_usage_window(&mut windows, QuotaWindow::weekly, weekly_window);

    if windows.is_empty() {
        return None;
    }

    let plan_type = data
        .get("plan_type")
        .and_then(|v| v.as_str())
        .unwrap_or("plus")
        .to_lowercase();

    Some(quota_from_windows(&plan_type, "codex_usage_api", windows))
}

pub(super) fn quota_from_codex_rate_limits_response(
    response: CodexRateLimitsResponse,
) -> QuotaInfo {
    let mut windows = Vec::new();
    if let Some(rate_limits) = response.rate_limits {
        let primary_fallback: fn(f64, Option<String>) -> QuotaWindow =
            if rate_limits.secondary.is_some() {
                QuotaWindow::session
            } else {
                QuotaWindow::weekly
            };
        if let Some(primary) = rate_limits.primary {
            if let Some(used_percent) = primary.used_percent {
                windows.push(codex_quota_window(
                    used_percent,
                    primary.resets_at.and_then(unix_seconds_to_rfc3339),
                    primary.window_duration_mins,
                    primary_fallback,
                ));
            }
        }
        if let Some(secondary) = rate_limits.secondary {
            if let Some(used_percent) = secondary.used_percent {
                windows.push(codex_quota_window(
                    used_percent,
                    secondary.resets_at.and_then(unix_seconds_to_rfc3339),
                    secondary.window_duration_mins,
                    QuotaWindow::weekly,
                ));
            }
        }
    }

    let mut quota = quota_from_windows("codex", "codex_app_server", windows);
    if let Some(reset_credits) = response.rate_limit_reset_credits {
        quota.named_message = Some(format_codex_reset_credits(reset_credits));
    }
    quota
}

fn format_codex_reset_credits(reset_credits: CodexRateLimitResetCredits) -> String {
    let available = reset_credits.available_count.unwrap_or(0);
    let total = reset_credits.total_earned_count.unwrap_or(available);
    let expiry = reset_credits.next_expires_at.and_then(|value| match value {
        serde_json::Value::Number(number) => number.as_i64().and_then(unix_seconds_to_rfc3339),
        serde_json::Value::String(value) => Some(value),
        _ => None,
    });

    match expiry {
        Some(expires_at) => {
            format!("Reset credits: {available}/{total}, next expires {expires_at}")
        }
        None => format!("Reset credits: {available}/{total}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_usage_api_maps_primary_and_secondary_windows() {
        let payload = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": { "used_percent": 25.0, "reset_at": 1_783_418_400 },
                "secondary_window": { "used_percent": 60.0, "resets_at": 1_783_938_000 }
            }
        });

        let quota = quota_from_usage_json(&payload).expect("usage windows");

        assert_eq!(quota.plan_type.as_deref(), Some("plus"));
        assert_eq!(quota.quota_source.as_deref(), Some("codex_usage_api"));
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert!((quota.usage_items[0].remaining_percentage - 75.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-07-07T10:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert!((quota.usage_items[1].remaining_percentage - 40.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[1].reset_time.as_deref(),
            Some("2026-07-13T10:20:00Z")
        );
        assert!((quota.remaining_percentage - 40.0).abs() < 0.01);
    }

    #[test]
    fn codex_usage_api_rejects_missing_windows() {
        let payload = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": { "limit_reached": false }
        });
        assert!(quota_from_usage_json(&payload).is_none());
    }

    #[test]
    fn codex_usage_api_maps_five_hour_and_seven_day_windows() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "five_hour": { "utilization": 10.0, "resets_at": "2026-07-07T18:00:00+08:00" },
            "seven_day": { "utilization": 55.0, "resets_at": "2026-07-13T18:00:00+08:00" }
        });

        let quota = quota_from_usage_json(&payload).expect("usage windows");

        assert_eq!(quota.plan_type.as_deref(), Some("pro"));
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert!((quota.usage_items[0].remaining_percentage - 90.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-07-07T10:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert!((quota.usage_items[1].remaining_percentage - 45.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[1].reset_time.as_deref(),
            Some("2026-07-13T10:00:00Z")
        );
    }

    #[test]
    fn codex_rate_limits_response_maps_windows_and_reset_credits() {
        let response = CodexRateLimitsResponse {
            rate_limits: Some(CodexRateLimitsPayload {
                primary: Some(CodexRateLimitWindow {
                    used_percent: Some(30.0),
                    window_duration_mins: Some(300),
                    resets_at: Some(1_783_418_400),
                }),
                secondary: Some(CodexRateLimitWindow {
                    used_percent: Some(65.0),
                    window_duration_mins: Some(10_080),
                    resets_at: Some(1_783_938_000),
                }),
            }),
            rate_limit_reset_credits: Some(CodexRateLimitResetCredits {
                available_count: Some(2),
                total_earned_count: Some(3),
                next_expires_at: Some(serde_json::json!(1_783_418_400)),
            }),
        };

        let quota = quota_from_codex_rate_limits_response(response);

        assert_eq!(quota.plan_type.as_deref(), Some("codex"));
        assert_eq!(quota.quota_source.as_deref(), Some("codex_app_server"));
        assert_eq!(quota.reset_time.as_deref(), Some("2026-07-07T10:00:00Z"));
        assert!((quota.remaining_percentage - 35.0).abs() < 0.01);
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert_eq!(
            quota.named_message.as_deref(),
            Some("Reset credits: 2/3, next expires 2026-07-07T10:00:00Z")
        );
    }

    #[test]
    fn codex_rate_limits_response_classifies_lone_weekly_primary_by_duration() {
        let quota = quota_from_codex_rate_limits_response(CodexRateLimitsResponse {
            rate_limits: Some(CodexRateLimitsPayload {
                primary: Some(CodexRateLimitWindow {
                    used_percent: Some(44.0),
                    window_duration_mins: Some(10_080),
                    resets_at: Some(1_783_938_000),
                }),
                secondary: None,
            }),
            rate_limit_reset_credits: None,
        });

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
        assert!((quota.usage_items[0].remaining_percentage - 56.0).abs() < 0.01);
    }

    #[test]
    fn codex_usage_api_classifies_primary_window_by_duration() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 44.0,
                    "window_duration_mins": 10_080,
                    "reset_at": 1_783_938_000
                }
            }
        });

        let quota = quota_from_usage_json(&payload).expect("weekly window");

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
        assert!((quota.usage_items[0].remaining_percentage - 56.0).abs() < 0.01);
    }

    #[test]
    fn codex_usage_api_treats_legacy_lone_primary_as_weekly() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 44.0,
                    "reset_at": 1_783_938_000
                }
            }
        });

        let quota = quota_from_usage_json(&payload).expect("weekly window");

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
    }

    #[test]
    fn codex_rate_limits_response_handles_missing_payload() {
        let quota = quota_from_codex_rate_limits_response(CodexRateLimitsResponse {
            rate_limits: None,
            rate_limit_reset_credits: None,
        });

        assert_eq!(quota.remaining_percentage, 100.0);
        assert!(quota.usage_items.is_empty());
    }
}
