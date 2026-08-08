use super::*;

#[test]
fn quota_from_windows_uses_most_constrained_window() {
    let quota = quota_from_windows(
        "claude_code",
        "oauth_usage",
        vec![
            QuotaWindow::session(25.4, Some("2026-07-07T10:00:00Z".to_string())),
            QuotaWindow::weekly(72.6, Some("2026-07-13T10:00:00Z".to_string())),
        ],
    );

    assert_eq!(quota.plan_type.as_deref(), Some("claude_code"));
    assert_eq!(quota.quota_source.as_deref(), Some("oauth_usage"));
    assert!((quota.remaining_percentage - 27.4).abs() < 0.01);
    assert_eq!(quota.used, Some(73));
    assert_eq!(quota.remaining, Some(27));
    assert_eq!(quota.reset_time.as_deref(), Some("2026-07-07T10:00:00Z"));
    assert_eq!(quota.usage_items.len(), 2);
    assert_eq!(quota.usage_items[0].usage_type, SESSION_USAGE_TYPE);
    assert!((quota.usage_items[0].remaining_percentage - 74.6).abs() < 0.01);
    assert_eq!(
        quota.usage_items[0].reset_time.as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
    assert_eq!(quota.usage_items[1].usage_type, WEEKLY_USAGE_TYPE);
    assert!((quota.usage_items[1].remaining_percentage - 27.4).abs() < 0.01);
    assert_eq!(
        quota.usage_items[1].reset_time.as_deref(),
        Some("2026-07-13T10:00:00Z")
    );
}

#[test]
fn quota_from_windows_clamps_invalid_percent_values() {
    let quota = quota_from_windows(
        "codex",
        "app_server",
        vec![
            QuotaWindow::session(-10.0, None),
            QuotaWindow::weekly(f64::INFINITY, None),
            QuotaWindow {
                usage_type: "monthly",
                used_percent: 130.0,
                reset_time: None,
            },
        ],
    );

    assert_eq!(quota.remaining_percentage, 0.0);
    assert_eq!(quota.usage_items[0].remaining_percentage, 100.0);
    assert_eq!(quota.usage_items[1].remaining_percentage, 100.0);
    assert_eq!(quota.usage_items[2].remaining_percentage, 0.0);
}

#[test]
fn unix_seconds_to_rfc3339_formats_utc_seconds() {
    assert_eq!(
        unix_seconds_to_rfc3339(1_783_418_400).as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
}

#[test]
fn normalize_reset_time_rejects_non_datetime_text() {
    assert_eq!(
        normalize_reset_time("2026-07-07T18:00:00+08:00").as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
    assert_eq!(normalize_reset_time("tomorrow"), None);
}

#[test]
fn json_time_normalizes_seconds_milliseconds_and_rfc3339() {
    assert_eq!(
        json_time_to_rfc3339(&serde_json::json!(1_783_418_400)).as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
    assert_eq!(
        json_time_to_rfc3339(&serde_json::json!(1_783_418_400_000_i64)).as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
    assert_eq!(
        json_time_to_rfc3339(&serde_json::json!("2026-07-07T18:00:00+08:00")).as_deref(),
        Some("2026-07-07T10:00:00Z")
    );
}
