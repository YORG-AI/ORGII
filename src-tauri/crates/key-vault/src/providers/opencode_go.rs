use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use reqwest::header::{ACCEPT, COOKIE, ORIGIN, REFERER};
use uuid::Uuid;

use crate::types::{QuotaInfo, UsageItem};

const OPENCODE_BASE_URL: &str = "https://opencode.ai";
const OPENCODE_SERVER_URL: &str = "https://opencode.ai/_server";
const WORKSPACES_SERVER_ID: &str =
    "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PAGE_TEXT_BYTES: usize = 10_000_000;
const OPENCODE_WORKSPACE_ID_KEYS: &[&str] = &[
    "opencode_workspace_id",
    "OPENCODE_WORKSPACE_ID",
    "workspace_id",
    "workspaceId",
];

pub struct OpenCodeGoQuotaFetcher {
    client: reqwest::Client,
}

#[derive(Debug, Clone, Copy)]
struct ParsedSubscription {
    rolling_usage_percent: f64,
    weekly_usage_percent: f64,
    monthly_usage_percent: Option<f64>,
    rolling_reset_in_sec: i64,
    weekly_reset_in_sec: i64,
    monthly_reset_in_sec: Option<i64>,
}

impl OpenCodeGoQuotaFetcher {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    pub async fn fetch_quota(
        &self,
        cookie: &str,
        workspace_id_override: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        let normalized_cookie = normalize_cookie_input(cookie);
        if normalized_cookie.is_empty() {
            return Err("OpenCode Go session cookie is not configured".to_string());
        }

        let cookie_header = filter_auth_cookie(&normalized_cookie);
        if cookie_header.is_empty() {
            return Err(
                "No OpenCode auth cookie found; paste auth=... or __Host-auth=... from opencode.ai"
                    .to_string(),
            );
        }

        let workspace_ids = self
            .resolve_workspace_ids(&cookie_header, workspace_id_override)
            .await?;
        if workspace_ids.is_empty() {
            return Err("No OpenCode workspace ID found. OpenCode Go quota needs an opencode.ai auth cookie and a workspace id such as wrk_... or wk_.... Save the workspace id in account metadata/env as OPENCODE_WORKSPACE_ID if it cannot be auto-discovered.".to_string());
        }

        let mut last_error = String::new();
        for workspace_id in workspace_ids {
            match self
                .fetch_workspace_quota(&cookie_header, &workspace_id)
                .await
            {
                Ok(quota) => return Ok(quota),
                Err(err) => last_error = err,
            }
        }

        Err(if last_error.is_empty() {
            "Could not parse OpenCode Go usage data from any workspace".to_string()
        } else {
            last_error
        })
    }

    async fn resolve_workspace_ids(
        &self,
        cookie_header: &str,
        workspace_id_override: Option<&str>,
    ) -> Result<Vec<String>, String> {
        if let Some(workspace_id) = workspace_id_override.and_then(valid_workspace_id) {
            return Ok(vec![workspace_id.to_string()]);
        }

        if let Some(workspace_id) = workspace_id_override.filter(|value| !value.trim().is_empty()) {
            return Err(format!(
                "Invalid OpenCode workspace ID format: {}",
                workspace_id.trim()
            ));
        }

        let instance_id = format!("server-fn:{}", Uuid::new_v4());
        let workspaces_url = format!("{OPENCODE_SERVER_URL}?id={WORKSPACES_SERVER_ID}");
        let response = self
            .client
            .get(workspaces_url)
            .timeout(REQUEST_TIMEOUT)
            .header(COOKIE, cookie_header)
            .header("X-Server-Id", WORKSPACES_SERVER_ID)
            .header("X-Server-Instance", instance_id)
            .header(ACCEPT, "text/javascript, application/json;q=0.9, */*;q=0.8")
            .header(ORIGIN, OPENCODE_BASE_URL)
            .header(REFERER, OPENCODE_BASE_URL)
            .send()
            .await
            .map_err(|err| format!("OpenCode workspaces request failed: {err}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "OpenCode workspaces fetch failed ({})",
                response.status().as_u16()
            ));
        }

        let text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read OpenCode workspaces response: {err}"))?;
        Ok(parse_workspace_ids(&text))
    }

    async fn fetch_workspace_quota(
        &self,
        cookie_header: &str,
        workspace_id: &str,
    ) -> Result<QuotaInfo, String> {
        let usage_page_url = format!("{OPENCODE_BASE_URL}/workspace/{workspace_id}/go");
        let response = self
            .client
            .get(usage_page_url)
            .timeout(REQUEST_TIMEOUT)
            .header(COOKIE, cookie_header)
            .header(
                ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header(ORIGIN, OPENCODE_BASE_URL)
            .header(REFERER, OPENCODE_BASE_URL)
            .send()
            .await
            .map_err(|err| format!("OpenCode usage page request failed: {err}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "OpenCode usage page fetch failed ({})",
                response.status().as_u16()
            ));
        }

        let page_text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read OpenCode usage page: {err}"))?;
        let parsed = parse_subscription_from_page_text(&page_text)
            .ok_or_else(|| "Could not parse OpenCode Go usage data from page".to_string())?;

        Ok(subscription_to_quota(parsed, workspace_id))
    }
}

pub fn workspace_id_override_from_key(key: &crate::key_store::ModelKey) -> Option<&str> {
    OPENCODE_WORKSPACE_ID_KEYS
        .iter()
        .find_map(|name| {
            key.account_metadata
                .get(*name)
                .or_else(|| key.env_vars.get(*name))
        })
        .map(String::as_str)
}

fn normalize_cookie_input(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains(';') || starts_with_auth_cookie_name(trimmed) {
        return trimmed.to_string();
    }
    if trimmed.starts_with("Fe26.2**") || is_structured_bare_token(trimmed) {
        return format!("auth={trimmed}");
    }
    trimmed.to_string()
}

fn starts_with_auth_cookie_name(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("auth=") || lower.starts_with("__host-auth=")
}

fn is_structured_bare_token(value: &str) -> bool {
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_')
}

fn filter_auth_cookie(raw: &str) -> String {
    raw.split(';')
        .filter_map(|pair| {
            let trimmed = pair.trim();
            let (name, _value) = trimmed.split_once('=')?;
            let normalized_name = name.trim();
            if normalized_name == "auth" || normalized_name == "__Host-auth" {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn valid_workspace_id(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    let rest = trimmed
        .strip_prefix("wrk_")
        .or_else(|| trimmed.strip_prefix("wk_"))?;
    if !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        Some(trimmed)
    } else {
        None
    }
}

fn parse_workspace_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for marker in ["wrk_", "wk_"] {
        let mut search_start = 0;
        while let Some(relative_index) = text[search_start..].find(marker) {
            let id_start = search_start + relative_index;
            let id_end = text[id_start..]
                .char_indices()
                .find_map(|(offset, ch)| {
                    if ch.is_ascii_alphanumeric() || ch == '_' {
                        None
                    } else {
                        Some(id_start + offset)
                    }
                })
                .unwrap_or(text.len());
            let id = &text[id_start..id_end];
            if valid_workspace_id(id).is_some() && !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
            search_start = id_end.saturating_add(1);
        }
    }
    ids
}

fn parse_subscription_from_page_text(text: &str) -> Option<ParsedSubscription> {
    if text.is_empty() || text.len() > MAX_PAGE_TEXT_BYTES {
        return None;
    }

    let rolling_block = extract_usage_block(text, "rollingUsage")?;
    let weekly_block = extract_usage_block(text, "weeklyUsage")?;
    let monthly_block = extract_usage_block(text, "monthlyUsage");

    let rolling_usage_percent =
        clamp_percent(extract_top_level_number(rolling_block, "usagePercent")?);
    let rolling_reset_in_sec = extract_top_level_number(rolling_block, "resetInSec")? as i64;
    let weekly_usage_percent =
        clamp_percent(extract_top_level_number(weekly_block, "usagePercent")?);
    let weekly_reset_in_sec = extract_top_level_number(weekly_block, "resetInSec")? as i64;
    let monthly_usage_percent = monthly_block
        .and_then(|block| extract_top_level_number(block, "usagePercent"))
        .map(clamp_percent);
    let monthly_reset_in_sec = monthly_block
        .and_then(|block| extract_top_level_number(block, "resetInSec"))
        .map(|value| value as i64);

    Some(ParsedSubscription {
        rolling_usage_percent,
        weekly_usage_percent,
        monthly_usage_percent,
        rolling_reset_in_sec,
        weekly_reset_in_sec,
        monthly_reset_in_sec,
    })
}

fn extract_usage_block<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut search_start = 0;
    let needle = format!("{key}:");
    while let Some(relative_index) = text[search_start..].find(&needle) {
        let after_key = search_start + relative_index + needle.len();
        let search_window = &text[after_key..text.len().min(after_key + 30)];
        let Some(brace_offset) = search_window.find('{') else {
            search_start = after_key;
            continue;
        };
        let open_brace = after_key + brace_offset;
        let Some(block) = balanced_object_block(text, open_brace) else {
            search_start = after_key;
            continue;
        };
        if extract_top_level_number(block, "usagePercent").is_some()
            && extract_top_level_number(block, "resetInSec").is_some()
        {
            return Some(block);
        }
        search_start = open_brace.saturating_add(1);
    }
    None
}

fn balanced_object_block(text: &str, open_brace: usize) -> Option<&str> {
    let mut depth = 0_i32;
    for (relative_index, ch) in text[open_brace..].char_indices() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(&text[open_brace..open_brace + relative_index + ch.len_utf8()]);
            }
        }
    }
    None
}

fn extract_top_level_number(obj_text: &str, field_name: &str) -> Option<f64> {
    let bytes = obj_text.as_bytes();
    let mut index = 0;
    let mut depth = 0_i32;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                depth += 1;
                index += 1;
            }
            b'}' => {
                depth -= 1;
                index += 1;
            }
            _ if depth == 1 && obj_text[index..].starts_with(field_name) => {
                let after_field = index + field_name.len();
                let remaining = &obj_text[after_field..];
                let trimmed = remaining.trim_start();
                if !trimmed.starts_with(':') {
                    index += 1;
                    continue;
                }
                let number_start = after_field + remaining.len() - trimmed.len() + 1;
                return parse_number_prefix(&obj_text[number_start..]);
            }
            _ => index += 1,
        }
    }
    None
}

fn parse_number_prefix(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let mut end = 0;
    for (index, ch) in trimmed.char_indices() {
        if ch.is_ascii_digit() || ch == '-' || ch == '.' {
            end = index + ch.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    trimmed[..end]
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

fn subscription_to_quota(parsed: ParsedSubscription, workspace_id: &str) -> QuotaInfo {
    let mut usage_items = vec![
        usage_item("session", parsed.rolling_usage_percent),
        usage_item("weekly", parsed.weekly_usage_percent),
    ];

    if let (Some(monthly_usage_percent), Some(_monthly_reset_in_sec)) =
        (parsed.monthly_usage_percent, parsed.monthly_reset_in_sec)
    {
        usage_items.push(usage_item("monthly", monthly_usage_percent));
    }

    let reset_time = [
        Some(parsed.rolling_reset_in_sec),
        Some(parsed.weekly_reset_in_sec),
        parsed.monthly_reset_in_sec,
    ]
    .into_iter()
    .flatten()
    .filter(|seconds| *seconds >= 0)
    .min()
    .map(|seconds| (Utc::now() + ChronoDuration::seconds(seconds)).to_rfc3339());

    let remaining_percentage = usage_items
        .iter()
        .map(|item| item.remaining_percentage)
        .fold(100.0_f64, f64::min);

    QuotaInfo {
        remaining_percentage,
        plan_type: Some("OpenCode Go".to_string()),
        quota_source: Some("opencode_go".to_string()),
        reset_time,
        usage_items,
        auto_message: Some(format!("OpenCode workspace {workspace_id}")),
        ..Default::default()
    }
}

fn usage_item(usage_type: &str, used_percent: f64) -> UsageItem {
    UsageItem {
        usage_type: usage_type.to_string(),
        enabled: true,
        used: Some(used_percent.round() as i64),
        limit: Some(100),
        remaining: Some((100.0 - used_percent).round() as i64),
        remaining_percentage: 100.0 - used_percent,
        reset_time: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_opencode_cookie() {
        assert_eq!(normalize_cookie_input("Fe26.2**abc"), "auth=Fe26.2**abc");
        assert_eq!(normalize_cookie_input("auth=abc"), "auth=abc");
    }

    #[test]
    fn filters_only_auth_cookies() {
        assert_eq!(
            filter_auth_cookie("foo=bar; auth=abc; __Host-auth=def; other=secret"),
            "auth=abc; __Host-auth=def"
        );
    }

    #[test]
    fn parses_workspace_ids() {
        let text = r#"foo id:"wrk_abc123" bar "id":"wk_DEF456" id:"wrk_abc123""#;
        assert_eq!(parse_workspace_ids(text), vec!["wrk_abc123", "wk_DEF456"]);
    }

    #[test]
    fn parses_subscription_from_react_flight_text() {
        let text = r#"
            monthlyUsage:null,
            rollingUsage:$R[28]={usagePercent:40,resetInSec:123,nested:{usagePercent:99}},
            weeklyUsage:{usagePercent:55.5,resetInSec:456},
            monthlyUsage:$R[29]={usagePercent:75,resetInSec:789}
        "#;
        let parsed = parse_subscription_from_page_text(text).expect("parsed subscription");
        assert_eq!(parsed.rolling_usage_percent, 40.0);
        assert_eq!(parsed.rolling_reset_in_sec, 123);
        assert_eq!(parsed.weekly_usage_percent, 55.5);
        assert_eq!(parsed.weekly_reset_in_sec, 456);
        assert_eq!(parsed.monthly_usage_percent, Some(75.0));
        assert_eq!(parsed.monthly_reset_in_sec, Some(789));
    }

    #[test]
    fn converts_subscription_to_quota_items() {
        let quota = subscription_to_quota(
            ParsedSubscription {
                rolling_usage_percent: 40.0,
                weekly_usage_percent: 55.0,
                monthly_usage_percent: Some(75.0),
                rolling_reset_in_sec: 1,
                weekly_reset_in_sec: 2,
                monthly_reset_in_sec: Some(3),
            },
            "wrk_abc",
        );

        assert_eq!(quota.plan_type.as_deref(), Some("OpenCode Go"));
        assert_eq!(quota.quota_source.as_deref(), Some("opencode_go"));
        assert_eq!(quota.remaining_percentage, 25.0);
        assert_eq!(quota.usage_items.len(), 3);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert_eq!(quota.usage_items[0].remaining_percentage, 60.0);
    }
}
