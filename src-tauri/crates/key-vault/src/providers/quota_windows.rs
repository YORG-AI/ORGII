use chrono::{DateTime, SecondsFormat, Utc};

use crate::types::{QuotaInfo, UsageItem};

pub(crate) const SESSION_USAGE_TYPE: &str = "session";
pub(crate) const WEEKLY_USAGE_TYPE: &str = "weekly";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct QuotaWindow {
    pub usage_type: &'static str,
    pub used_percent: f64,
    pub reset_time: Option<String>,
}

impl QuotaWindow {
    pub(crate) fn session(used_percent: f64, reset_time: Option<String>) -> Self {
        Self {
            usage_type: SESSION_USAGE_TYPE,
            used_percent,
            reset_time,
        }
    }

    pub(crate) fn weekly(used_percent: f64, reset_time: Option<String>) -> Self {
        Self {
            usage_type: WEEKLY_USAGE_TYPE,
            used_percent,
            reset_time,
        }
    }
}

pub(crate) fn unix_seconds_to_rfc3339(seconds: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Secs, true))
}

pub(crate) fn normalize_reset_time(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| {
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        })
        .ok()
}

pub(crate) fn quota_from_windows(
    plan_type: &str,
    quota_source: &str,
    windows: Vec<QuotaWindow>,
) -> QuotaInfo {
    let mut usage_items = Vec::new();
    let mut max_used = 0.0_f64;
    let mut reset_time = None;

    for window in windows {
        let used_percent = clamp_percent(window.used_percent);
        let remaining_percent = 100.0 - used_percent;
        max_used = max_used.max(used_percent);
        if reset_time.is_none() {
            reset_time = window.reset_time.clone();
        }

        usage_items.push(UsageItem {
            usage_type: window.usage_type.to_string(),
            enabled: true,
            used: Some(used_percent.round() as i64),
            limit: Some(100),
            remaining: Some(remaining_percent.round() as i64),
            remaining_percentage: remaining_percent,
            reset_time: window.reset_time.clone(),
        });
    }

    let remaining_percentage = 100.0 - max_used;

    QuotaInfo {
        remaining_percentage,
        used: Some(max_used.round() as i64),
        limit: Some(100),
        remaining: Some(remaining_percentage.round() as i64),
        reset_time,
        plan_type: Some(plan_type.to_string()),
        quota_source: Some(quota_source.to_string()),
        is_unlimited: false,
        usage_items,
        ..Default::default()
    }
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

#[cfg(test)]
#[path = "quota_windows_tests.rs"]
mod tests;
