//! Z.ai Team quota lookup for explicitly scoped BigModel team credentials.
//!
//! Team plans exist only on the China BigModel host. The endpoint, region,
//! organization, and project are therefore fixed before the request starts:
//! one GET, no region probing, and no subscription/plan-label follow-up.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde_json::Value;

use crate::key_store::ModelKey;
use crate::providers::quota_http::get_json_with_headers;
use crate::providers::quota_windows::{json_time_to_rfc3339, quota_from_windows, QuotaWindow};
use crate::types::QuotaInfo;

pub(crate) const ORGANIZATION_METADATA_KEY: &str = "zai_team_organization_id";
pub(crate) const PROJECT_METADATA_KEY: &str = "zai_team_project_id";

const ZAI_TEAM_QUOTA_URL: &str = "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2";
const PLAN_TYPE_DEFAULT: &str = "Z.ai Team";
const QUOTA_SOURCE: &str = "zai_team_monitor";
const TOKENS_LIMIT_TYPE: &str = "TOKENS_LIMIT";
const TIME_LIMIT_TYPE: &str = "TIME_LIMIT";
const MAX_API_KEY_HEADER_BYTES: usize = 16 * 1024;
const MAX_SCOPE_HEADER_BYTES: usize = 8 * 1024;

const ORGANIZATION_HEADER: HeaderName = HeaderName::from_static("bigmodel-organization");
const PROJECT_HEADER: HeaderName = HeaderName::from_static("bigmodel-project");

pub(crate) struct ZaiTeamScope<'a> {
    pub(crate) organization_id: &'a str,
    pub(crate) project_id: &'a str,
}

/// Resolve Team scope only from the provider-specific metadata pair.
///
/// A partial pair is deliberately not accepted: silently falling back to a
/// personal Zhipu lookup would cache data for a different billing scope.
pub(crate) fn team_scope_from_key(key: &ModelKey) -> Option<ZaiTeamScope<'_>> {
    let organization_id = key
        .account_metadata
        .get(ORGANIZATION_METADATA_KEY)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let project_id = key
        .account_metadata
        .get(PROJECT_METADATA_KEY)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(ZaiTeamScope {
        organization_id,
        project_id,
    })
}

pub(crate) fn has_partial_team_scope(key: &ModelKey) -> bool {
    let has_organization = metadata_value(key, ORGANIZATION_METADATA_KEY).is_some();
    let has_project = metadata_value(key, PROJECT_METADATA_KEY).is_some();
    has_organization != has_project
}

fn metadata_value<'a>(key: &'a ModelKey, name: &str) -> Option<&'a str> {
    key.account_metadata
        .get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub struct ZaiTeamQuotaFetcher;

impl ZaiTeamQuotaFetcher {
    pub fn new() -> Self {
        Self
    }

    /// Fetch Team quota from the single China endpoint.
    pub(crate) async fn fetch_quota(
        &self,
        api_key: &str,
        scope: ZaiTeamScope<'_>,
    ) -> Result<QuotaInfo, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("ZAI Team account has no API key".to_string());
        }

        let mut headers = HeaderMap::with_capacity(3);
        headers.insert(AUTHORIZATION, bearer_header_value(api_key)?);
        headers.insert(
            ORGANIZATION_HEADER,
            secret_header_value(
                scope.organization_id,
                "ZAI Team organization ID",
                MAX_SCOPE_HEADER_BYTES,
            )?,
        );
        headers.insert(
            PROJECT_HEADER,
            secret_header_value(
                scope.project_id,
                "ZAI Team project ID",
                MAX_SCOPE_HEADER_BYTES,
            )?,
        );

        let body = get_json_with_headers("ZAI Team", ZAI_TEAM_QUOTA_URL, headers)
            .await
            .map_err(|error| error.to_string())?;
        parse_zai_team_quota(&body)
    }
}

impl Default for ZaiTeamQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

fn secret_header_value(value: &str, field: &str, max_bytes: usize) -> Result<HeaderValue, String> {
    if value.len() > max_bytes {
        return Err(format!(
            "{field} exceeds the {max_bytes}-byte request-header limit"
        ));
    }
    HeaderValue::from_str(value).map_err(|_| format!("{field} is not a valid HTTP header value"))
}

fn bearer_header_value(api_key: &str) -> Result<HeaderValue, String> {
    if api_key.len() > MAX_API_KEY_HEADER_BYTES.saturating_sub("Bearer ".len()) {
        return Err(format!(
            "ZAI Team API key exceeds the {MAX_API_KEY_HEADER_BYTES}-byte \
             request-header limit"
        ));
    }
    secret_header_value(
        &format!("Bearer {api_key}"),
        "ZAI Team API key",
        MAX_API_KEY_HEADER_BYTES,
    )
}

fn parse_zai_team_quota(body: &Value) -> Result<QuotaInfo, String> {
    let data = body
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "ZAI Team quota HTTP 200 response has no data object".to_string())?;
    let limits = data
        .get("limits")
        .and_then(Value::as_array)
        .ok_or_else(|| "ZAI Team quota HTTP 200 response has no limits array".to_string())?;

    let mut token_count = 0_usize;
    let mut shortest: Option<(&Value, f64, f64)> = None;
    let mut longest: Option<(&Value, f64, f64)> = None;
    for limit in limits
        .iter()
        .filter(|limit| limit_type(limit).eq_ignore_ascii_case(TOKENS_LIMIT_TYPE))
    {
        let Some(percent) = used_percent(limit) else {
            continue;
        };
        token_count += 1;
        let minutes = window_minutes(limit).unwrap_or(f64::MAX);
        if shortest.is_none_or(|(_, _, shortest_minutes)| minutes < shortest_minutes) {
            shortest = Some((limit, percent, minutes));
        }
        if longest.is_none_or(|(_, _, longest_minutes)| minutes >= longest_minutes) {
            longest = Some((limit, percent, minutes));
        }
    }

    let mut windows = Vec::with_capacity(3);
    if token_count == 1 {
        if let Some((limit, percent, _)) = shortest {
            if is_session_window(limit) {
                windows.push(QuotaWindow::session(percent, reset_time(limit)));
            } else {
                windows.push(QuotaWindow::weekly(percent, reset_time(limit)));
            }
        }
    } else if token_count > 1 {
        if let (Some((session, session_percent, _)), Some((weekly, weekly_percent, _))) =
            (shortest, longest)
        {
            windows.push(QuotaWindow::session(session_percent, reset_time(session)));
            windows.push(QuotaWindow::weekly(weekly_percent, reset_time(weekly)));
        }
    }

    if let Some((limit, percent)) = limits
        .iter()
        .find(|limit| limit_type(limit).eq_ignore_ascii_case(TIME_LIMIT_TYPE))
        .and_then(|limit| used_percent(limit).map(|percent| (limit, percent)))
    {
        windows.push(QuotaWindow {
            usage_type: "mcp_monthly",
            used_percent: percent,
            reset_time: reset_time(limit),
        });
    }

    if windows.is_empty() {
        return Err("ZAI Team quota HTTP 200 response has no usable quota windows".to_string());
    }

    let plan = plan_label(data).unwrap_or(PLAN_TYPE_DEFAULT);
    let mut quota = quota_from_windows(plan, QUOTA_SOURCE, windows);
    quota.limit_type = Some("team".to_string());
    Ok(quota)
}

fn limit_type(limit: &Value) -> &str {
    limit
        .get("type")
        .or_else(|| limit.get("limit_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    number.is_finite().then_some(number)
}

fn used_percent(limit: &Value) -> Option<f64> {
    let total = finite_number(limit.get("usage"));
    let remaining = finite_number(limit.get("remaining"));
    let current = finite_number(
        limit
            .get("currentValue")
            .or_else(|| limit.get("current_value")),
    );
    if let Some(total) = total.filter(|total| *total > 0.0) {
        let used = match (remaining, current) {
            (Some(remaining), Some(current)) => (total - remaining).max(current),
            (Some(remaining), None) => total - remaining,
            (None, Some(current)) => current,
            (None, None) => return fallback_percent(limit),
        };
        return Some((used.clamp(0.0, total) / total * 100.0).clamp(0.0, 100.0));
    }
    fallback_percent(limit)
}

fn fallback_percent(limit: &Value) -> Option<f64> {
    finite_number(
        limit
            .get("percentage")
            .or_else(|| limit.get("usedPercent"))
            .or_else(|| limit.get("used_percent")),
    )
    .map(|percent| percent.clamp(0.0, 100.0))
}

fn window_minutes(limit: &Value) -> Option<f64> {
    let unit = finite_number(limit.get("unit"))?;
    let number = finite_number(limit.get("number"))?;
    if number <= 0.0 {
        return None;
    }
    match unit {
        5.0 => Some(number),
        3.0 => Some(number * 60.0),
        1.0 => Some(number * 24.0 * 60.0),
        6.0 => Some(number * 7.0 * 24.0 * 60.0),
        _ => None,
    }
}

fn is_session_window(limit: &Value) -> bool {
    window_minutes(limit).is_some_and(|minutes| minutes <= 6.0 * 60.0)
}

fn reset_time(limit: &Value) -> Option<String> {
    limit
        .get("nextResetTime")
        .or_else(|| limit.get("next_reset_time"))
        .and_then(json_time_to_rfc3339)
}

fn plan_label(data: &serde_json::Map<String, Value>) -> Option<&str> {
    [
        "planName",
        "plan_name",
        "packageName",
        "package_name",
        "plan",
        "plan_type",
        "planType",
        "level",
    ]
    .into_iter()
    .find_map(|field| data.get(field).and_then(Value::as_str))
    .map(str::trim)
    .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key_store::ModelType;
    use serde_json::json;

    #[test]
    fn scope_requires_both_provider_specific_metadata_values() {
        let mut key = ModelKey::new(ModelType::ZhipuApi);
        assert!(team_scope_from_key(&key).is_none());
        assert!(!has_partial_team_scope(&key));

        key.account_metadata
            .insert(ORGANIZATION_METADATA_KEY.into(), " org-1 ".into());
        assert!(team_scope_from_key(&key).is_none());
        assert!(has_partial_team_scope(&key));

        key.account_metadata
            .insert(PROJECT_METADATA_KEY.into(), "project-1".into());
        let scope = team_scope_from_key(&key).unwrap();
        assert_eq!(scope.organization_id, "org-1");
        assert_eq!(scope.project_id, "project-1");
        assert!(!has_partial_team_scope(&key));
    }

    #[test]
    fn parser_uses_exact_windows_and_includes_monthly_mcp() {
        let quota = parse_zai_team_quota(&json!({
            "data": {
                "planName": "GLM TEAM",
                "limits": [
                    {
                        "type": "TOKENS_LIMIT",
                        "unit": 6,
                        "number": 1,
                        "usage": 1000,
                        "remaining": 250,
                        "currentValue": 700
                    },
                    {
                        "type": "TOKENS_LIMIT",
                        "unit": 3,
                        "number": 5,
                        "percentage": 20,
                        "nextResetTime": 1783418400
                    },
                    {
                        "type": "TIME_LIMIT",
                        "percentage": "40",
                        "next_reset_time": "2026-08-01T02:00:00+08:00"
                    }
                ]
            }
        }))
        .unwrap();

        assert_eq!(quota.plan_type.as_deref(), Some("GLM TEAM"));
        assert_eq!(quota.quota_source.as_deref(), Some(QUOTA_SOURCE));
        assert_eq!(quota.limit_type.as_deref(), Some("team"));
        assert_eq!(quota.usage_items.len(), 3);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert_eq!(quota.usage_items[0].remaining_percentage, 80.0);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-07-07T10:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert_eq!(quota.usage_items[1].remaining_percentage, 25.0);
        assert_eq!(quota.usage_items[2].usage_type, "mcp_monthly");
        assert_eq!(quota.usage_items[2].remaining_percentage, 60.0);
        assert_eq!(
            quota.usage_items[2].reset_time.as_deref(),
            Some("2026-07-31T18:00:00Z")
        );
        assert_eq!(quota.remaining_percentage, 25.0);
    }

    #[test]
    fn parser_rejects_empty_success_payloads() {
        let error = parse_zai_team_quota(&json!({"data": {"limits": []}})).unwrap_err();
        assert!(error.contains("HTTP 200"));
        assert!(error.contains("no usable quota windows"));
    }

    #[test]
    fn team_headers_have_explicit_memory_bounds() {
        let oversized = "x".repeat(MAX_SCOPE_HEADER_BYTES + 1);
        let error = secret_header_value(&oversized, "ZAI Team project ID", MAX_SCOPE_HEADER_BYTES)
            .unwrap_err();
        assert!(error.contains("request-header limit"));

        let oversized_key = "x".repeat(MAX_API_KEY_HEADER_BYTES);
        let key_error = bearer_header_value(&oversized_key).unwrap_err();
        assert!(key_error.contains("request-header limit"));
    }
}
