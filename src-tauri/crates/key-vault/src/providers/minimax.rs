//! MiniMax Token Plan quota lookup with region-locked compatibility fallback.

use reqwest::StatusCode;
use serde_json::Value;

use crate::providers::quota_http::{get_bearer_json, QuotaHttpError};
use crate::providers::quota_windows::{json_time_to_rfc3339, quota_from_windows, QuotaWindow};
use crate::types::QuotaInfo;

const TOKEN_PLAN_URL_EN: &str = "https://api.minimax.io/v1/token_plan/remains";
const LEGACY_URL_EN: &str = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const TOKEN_PLAN_URL_CN: &str = "https://api.minimaxi.com/v1/token_plan/remains";
const LEGACY_URL_CN: &str = "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const PLAN_TYPE: &str = "MiniMax Token Plan";
const QUOTA_SOURCE: &str = "minimax_token_plan";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MiniMaxRegion {
    En,
    Cn,
}

impl MiniMaxRegion {
    fn urls(self) -> (&'static str, &'static str) {
        match self {
            Self::En => (TOKEN_PLAN_URL_EN, LEGACY_URL_EN),
            Self::Cn => (TOKEN_PLAN_URL_CN, LEGACY_URL_CN),
        }
    }
}

pub struct MiniMaxQuotaFetcher;

impl MiniMaxQuotaFetcher {
    pub fn new() -> Self {
        Self
    }

    /// Fetch one region only. The normal path is one request; a sequential
    /// legacy request is allowed only when the token-plan route is incompatible.
    pub async fn fetch_quota(
        &self,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("MiniMax account has no API key".to_string());
        }

        let region = resolve_region(base_url)?;
        let (token_plan_url, legacy_url) = region.urls();
        match fetch_and_parse(api_key, token_plan_url).await {
            Ok(quota) => Ok(quota),
            Err(error) if error.legacy_compatible => fetch_and_parse(api_key, legacy_url)
                .await
                .map_err(|legacy_error| legacy_error.message),
            Err(error) => Err(error.message),
        }
    }
}

impl Default for MiniMaxQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

struct MiniMaxAttemptError {
    message: String,
    legacy_compatible: bool,
}

async fn fetch_and_parse(api_key: &str, url: &str) -> Result<QuotaInfo, MiniMaxAttemptError> {
    let body = get_bearer_json("MiniMax", url, api_key)
        .await
        .map_err(minimax_http_error)?;
    parse_minimax_quota(&body).map_err(|error| MiniMaxAttemptError {
        message: error.message,
        legacy_compatible: error.legacy_compatible
            && (url == TOKEN_PLAN_URL_EN || url == TOKEN_PLAN_URL_CN),
    })
}

fn minimax_http_error(error: QuotaHttpError) -> MiniMaxAttemptError {
    let legacy_compatible = is_legacy_compatible_status(error.status());
    MiniMaxAttemptError {
        message: error.to_string(),
        legacy_compatible,
    }
}

fn is_legacy_compatible_status(status: Option<StatusCode>) -> bool {
    matches!(
        status,
        Some(
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::NOT_FOUND
                | StatusCode::METHOD_NOT_ALLOWED
        )
    )
}

fn resolve_region(base_url: Option<&str>) -> Result<MiniMaxRegion, String> {
    let Some(base_url) = base_url
        .map(str::trim)
        .filter(|base_url| !base_url.is_empty())
    else {
        return Ok(MiniMaxRegion::En);
    };
    let parsed =
        url::Url::parse(base_url).map_err(|error| format!("Invalid MiniMax base URL: {error}"))?;
    match parsed.host_str() {
        Some("api.minimax.io") => Ok(MiniMaxRegion::En),
        Some("api.minimaxi.com") => Ok(MiniMaxRegion::Cn),
        _ => Err("MiniMax base URL must select api.minimax.io or api.minimaxi.com".to_string()),
    }
}

#[derive(Debug)]
struct MiniMaxParseError {
    message: String,
    legacy_compatible: bool,
}

fn parse_minimax_quota(body: &Value) -> Result<QuotaInfo, MiniMaxParseError> {
    validate_base_response(body)?;
    let rows = body
        .pointer("/data/model_remains")
        .and_then(Value::as_array)
        .or_else(|| body.get("model_remains").and_then(Value::as_array))
        .ok_or_else(|| MiniMaxParseError {
            message: "MiniMax quota HTTP 200 response has no model_remains array".to_string(),
            legacy_compatible: true,
        })?;
    let general = rows
        .iter()
        .find(|row| row.get("model_name").and_then(Value::as_str) == Some("general"))
        .ok_or_else(|| MiniMaxParseError {
            message: "MiniMax quota HTTP 200 response has no general quota row".to_string(),
            legacy_compatible: true,
        })?;

    let mut windows = Vec::with_capacity(2);
    if !is_placeholder_lane(
        general,
        "current_interval_remaining_percent",
        "current_interval_status",
    ) {
        if let Some(remaining) = general
            .get("current_interval_remaining_percent")
            .and_then(finite_number)
        {
            windows.push(QuotaWindow::session(
                100.0 - remaining.clamp(0.0, 100.0),
                general.get("end_time").and_then(json_time_to_rfc3339),
            ));
        }
    }
    if !is_placeholder_lane(
        general,
        "current_weekly_remaining_percent",
        "current_weekly_status",
    ) {
        if let Some(remaining) = general
            .get("current_weekly_remaining_percent")
            .and_then(finite_number)
        {
            windows.push(QuotaWindow::weekly(
                100.0 - remaining.clamp(0.0, 100.0),
                general
                    .get("weekly_end_time")
                    .and_then(json_time_to_rfc3339),
            ));
        }
    }

    if windows.is_empty() {
        return Err(MiniMaxParseError {
            message: "MiniMax quota HTTP 200 response has no usable quota windows".to_string(),
            legacy_compatible: true,
        });
    }
    Ok(quota_from_windows(PLAN_TYPE, QUOTA_SOURCE, windows))
}

fn validate_base_response(body: &Value) -> Result<(), MiniMaxParseError> {
    let Some(base_response) = body.get("base_resp").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(status_code) = base_response.get("status_code").and_then(finite_number) else {
        return Ok(());
    };
    if status_code == 0.0 {
        return Ok(());
    }
    let status_message = base_response
        .get("status_msg")
        .and_then(Value::as_str)
        .unwrap_or("unknown provider error");
    let lower_message = status_message.to_ascii_lowercase();
    let legacy_compatible = lower_message.contains("log in")
        || lower_message.contains("login")
        || lower_message
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "cookie" | "token" | "auth" | "key" | "expired" | "invalid"
                )
            });
    Err(MiniMaxParseError {
        message: format!(
            "MiniMax quota HTTP 200 provider error code {status_code}: {status_message}"
        ),
        legacy_compatible,
    })
}

fn is_placeholder_lane(row: &Value, percent_field: &str, status_field: &str) -> bool {
    if row.get(status_field).and_then(finite_number) != Some(3.0) {
        return false;
    }
    row.get(percent_field)
        .and_then(finite_number)
        .is_none_or(|percentage| percentage >= 100.0)
}

fn finite_number(value: &Value) -> Option<f64> {
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    number.is_finite().then_some(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_url_pins_exactly_one_region() {
        assert_eq!(resolve_region(None).unwrap(), MiniMaxRegion::En);
        assert_eq!(
            resolve_region(Some("https://api.minimax.io/v1")).unwrap(),
            MiniMaxRegion::En
        );
        assert_eq!(
            resolve_region(Some("https://api.minimaxi.com/anthropic")).unwrap(),
            MiniMaxRegion::Cn
        );
        assert!(resolve_region(Some("https://proxy.example")).is_err());
    }

    #[test]
    fn parses_nested_session_weekly_and_resets() {
        let quota = parse_minimax_quota(&json!({
            "base_resp": {"status_code": 0},
            "data": {"model_remains": [{
                "model_name": "general",
                "current_interval_remaining_percent": "72.5",
                "end_time": 1767225600,
                "current_weekly_remaining_percent": "40",
                "weekly_end_time": 1767830400000_i64
            }]}
        }))
        .unwrap();

        assert_eq!(quota.plan_type.as_deref(), Some(PLAN_TYPE));
        assert_eq!(quota.remaining_percentage, 40.0);
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert_eq!(quota.usage_items[0].remaining_percentage, 72.5);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert_eq!(quota.usage_items[1].remaining_percentage, 40.0);
        assert_eq!(
            quota.usage_items[1].reset_time.as_deref(),
            Some("2026-01-08T00:00:00Z")
        );
    }

    #[test]
    fn accepts_flattened_shape_and_suppresses_placeholder_lane() {
        let quota = parse_minimax_quota(&json!({
            "model_remains": [{
                "model_name": "general",
                "current_interval_remaining_percent": 65,
                "current_weekly_remaining_percent": 100,
                "current_weekly_status": 3
            }]
        }))
        .unwrap();

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].remaining_percentage, 65.0);
    }

    #[test]
    fn provider_error_includes_http_status_context() {
        let error = parse_minimax_quota(&json!({
            "base_resp": {"status_code": 1004, "status_msg": "token expired"}
        }))
        .unwrap_err();
        assert!(error.message.contains("HTTP 200"));
        assert!(error.message.contains("1004"));
        assert!(error.legacy_compatible);
    }

    #[test]
    fn ordinary_provider_error_does_not_trigger_legacy_request() {
        let error = parse_minimax_quota(&json!({
            "base_resp": {"status_code": 2001, "status_msg": "account suspended"}
        }))
        .unwrap_err();
        assert!(!error.legacy_compatible);
    }

    #[test]
    fn fallback_http_statuses_are_narrow() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::METHOD_NOT_ALLOWED,
        ] {
            assert!(is_legacy_compatible_status(Some(status)));
        }
        for status in [StatusCode::TOO_MANY_REQUESTS, StatusCode::BAD_GATEWAY] {
            assert!(!is_legacy_compatible_status(Some(status)));
        }
    }
}
