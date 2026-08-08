//! OpenRouter API-key hard-limit lookup.
//!
//! The `/api/v1/key` response already contains the key's hard limit, usage,
//! and remaining amount. We intentionally do not call `/credits`: doing so
//! doubles steady-state traffic without improving the hard-limit meter.

use serde_json::Value;

use crate::providers::quota_http::get_bearer_json;
use crate::types::{QuotaInfo, UsageItem};

const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";
const KEY_QUOTA_SOURCE: &str = "openrouter_key";
const HARD_LIMIT_QUOTA_SOURCE: &str = "openrouter_key_limit";

pub struct OpenRouterQuotaFetcher;

impl OpenRouterQuotaFetcher {
    pub fn new() -> Self {
        Self
    }

    /// Fetch quota with exactly one `/api/v1/key` request per attempt.
    pub async fn fetch_quota(&self, api_key: &str) -> Result<QuotaInfo, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("OpenRouter account has no API key".to_string());
        }

        let body = get_bearer_json("OpenRouter", OPENROUTER_KEY_URL, api_key)
            .await
            .map_err(|error| error.to_string())?;
        parse_openrouter_quota(&body)
    }
}

impl Default for OpenRouterQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_openrouter_quota(body: &Value) -> Result<QuotaInfo, String> {
    let data = body
        .get("data")
        .filter(|data| data.is_object())
        .ok_or_else(|| "OpenRouter quota HTTP 200 response has no data object".to_string())?;
    let limit = data.get("limit").and_then(finite_number);
    let plan_type = openrouter_plan_type(data, limit.is_some_and(|value| value > 0.0));

    let Some(limit) = limit.filter(|value| *value > 0.0) else {
        return Ok(QuotaInfo {
            remaining_percentage: 100.0,
            plan_type: Some(plan_type),
            is_unlimited: true,
            quota_source: Some(KEY_QUOTA_SOURCE.to_string()),
            ..Default::default()
        });
    };

    let usage = data
        .get("usage")
        .and_then(finite_number)
        .map(|value| value.max(0.0));
    let remaining = data
        .get("limit_remaining")
        .and_then(finite_number)
        .map(|value| value.max(0.0));
    if usage.is_none() && remaining.is_none() {
        return Err(
            "OpenRouter quota HTTP 200 hard-limit response has neither usage nor remaining"
                .to_string(),
        );
    }

    let remaining_percentage = remaining
        .map(|value| (value / limit) * 100.0)
        .unwrap_or_else(|| ((limit - usage.unwrap_or_default()).max(0.0) / limit) * 100.0)
        .clamp(0.0, 100.0);
    let used_percentage = 100.0 - remaining_percentage;
    let usage_type = match data
        .get("limit_reset")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("daily") => "daily",
        Some("weekly") => "weekly",
        Some("monthly") => "monthly",
        _ => "billing",
    };

    let item = UsageItem {
        usage_type: usage_type.to_string(),
        enabled: true,
        used: Some(used_percentage.round() as i64),
        limit: Some(100),
        remaining: Some(remaining_percentage.round() as i64),
        remaining_percentage,
        reset_time: None,
    };

    Ok(QuotaInfo {
        remaining_percentage,
        used: item.used,
        limit: item.limit,
        remaining: item.remaining,
        plan_type: Some(plan_type),
        is_unlimited: false,
        quota_source: Some(HARD_LIMIT_QUOTA_SOURCE.to_string()),
        usage_items: vec![item],
        ..Default::default()
    })
}

fn openrouter_plan_type(data: &Value, has_hard_limit: bool) -> String {
    if data.get("is_management_key").and_then(Value::as_bool) == Some(true) {
        return "Management".to_string();
    }
    match data.get("is_free_tier").and_then(Value::as_bool) {
        Some(true) => "Free".to_string(),
        Some(false) => "Pay-as-you-go".to_string(),
        None if has_hard_limit => "API key limit".to_string(),
        None => "Unlimited".to_string(),
    }
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
    fn hard_limit_becomes_one_percentage_window() {
        let quota = parse_openrouter_quota(&json!({
            "data": {
                "limit": "20.5",
                "usage": "5.125",
                "limit_remaining": "15.375",
                "limit_reset": "monthly",
                "is_free_tier": false
            }
        }))
        .unwrap();

        assert_eq!(quota.remaining_percentage, 75.0);
        assert_eq!(quota.plan_type.as_deref(), Some("Pay-as-you-go"));
        assert!(!quota.is_unlimited);
        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "monthly");
        assert_eq!(quota.usage_items[0].remaining_percentage, 75.0);
    }

    #[test]
    fn usage_is_used_when_remaining_is_absent() {
        let quota = parse_openrouter_quota(&json!({
            "data": {"limit": 10, "usage": 2.5, "limit_reset": "daily"}
        }))
        .unwrap();

        assert_eq!(quota.remaining_percentage, 75.0);
        assert_eq!(quota.usage_items[0].usage_type, "daily");
    }

    #[test]
    fn no_hard_limit_is_typed_payg_without_a_meter() {
        let quota = parse_openrouter_quota(&json!({
            "data": {"limit": null, "usage": 42.5, "is_free_tier": false}
        }))
        .unwrap();

        assert_eq!(quota.plan_type.as_deref(), Some("Pay-as-you-go"));
        assert!(quota.is_unlimited);
        assert_eq!(quota.remaining_percentage, 100.0);
        assert!(quota.usage_items.is_empty());
    }

    #[test]
    fn untyped_no_limit_is_explicitly_unlimited() {
        let quota = parse_openrouter_quota(&json!({"data": {}})).unwrap();
        assert_eq!(quota.plan_type.as_deref(), Some("Unlimited"));
        assert!(quota.is_unlimited);
    }
}
