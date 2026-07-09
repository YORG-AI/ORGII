use super::*;
use crate::providers::quota_windows::{SESSION_USAGE_TYPE, WEEKLY_USAGE_TYPE};

#[test]
fn parses_oauth_usage_windows() {
    let quota = parse_oauth_usage_response(
        r#"{
            "five_hour": { "utilization": 42.5, "resets_at": "2026-07-07T18:00:00+08:00" },
            "seven_day": { "utilization": 80, "resets_at": "2026-07-13T18:00:00+08:00" }
        }"#,
    )
    .unwrap();

    assert_eq!(quota.plan_type.as_deref(), Some("claude_code"));
    assert_eq!(quota.quota_source.as_deref(), Some("oauth_usage"));
    assert_eq!(quota.reset_time.as_deref(), Some("2026-07-07T10:00:00Z"));
    assert!((quota.remaining_percentage - 20.0).abs() < 0.01);
    assert_eq!(quota.usage_items.len(), 2);
    assert_eq!(quota.usage_items[0].usage_type, SESSION_USAGE_TYPE);
    assert!((quota.usage_items[0].remaining_percentage - 57.5).abs() < 0.01);
    assert_eq!(
        quota.usage_items[0].reset_time.as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
    assert_eq!(quota.usage_items[1].usage_type, WEEKLY_USAGE_TYPE);
    assert!((quota.usage_items[1].remaining_percentage - 20.0).abs() < 0.01);
    assert_eq!(
        quota.usage_items[1].reset_time.as_deref(),
        Some("2026-07-13T10:00:00Z")
    );
}

#[test]
fn ignores_missing_windows() {
    let quota = parse_oauth_usage_response(
        r#"{
            "five_hour": { "resets_at": "2026-07-07T18:00:00+08:00" }
        }"#,
    )
    .unwrap();

    assert_eq!(quota.usage_items.len(), 0);
    assert_eq!(quota.remaining_percentage, 100.0);
}

#[test]
fn applies_profile_rate_limit_tier_to_plan_type() {
    let metadata = parse_oauth_profile_metadata(
        r#"{
            "organization": { "rate_limit_tier": "max_20x" }
        }"#,
    )
    .unwrap();

    assert_eq!(metadata.get("rate_limit_tier").map(String::as_str), Some("max_20x"));
}

#[test]
fn rejects_invalid_json() {
    let err = parse_oauth_usage_response("not-json").unwrap_err();
    assert!(err.contains("parse failed"));
}
