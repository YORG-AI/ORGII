//! Cursor quota fetching and usage response parsing

use serde::Deserialize;

use crate::types::{QuotaInfo, UsageItem};

use super::CursorValidator;

pub(crate) const CURSOR_USAGE_API_URL: &str = "https://api2.cursor.sh";
const CURSOR_AUTO_COMPOSER_USAGE_TYPE: &str = "cursor_auto_composer";
const CURSOR_API_USAGE_TYPE: &str = "cursor_api";

fn cursor_remaining_percentage(detail: &UsageDetail, fallback: f64) -> f64 {
    detail
        .total_percent_used
        .map(|percent_used| (100.0 - percent_used).clamp(0.0, 100.0))
        .unwrap_or(fallback)
}

/// Cursor usage summary API response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSummaryResponse {
    membership_type: Option<String>,
    #[serde(default)]
    is_unlimited: bool,
    individual_usage: Option<IndividualUsage>,
    team_usage: Option<TeamUsage>,
    auto_model_selected_display_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndividualUsage {
    plan: Option<UsageDetail>,
    overall: Option<UsageDetail>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TeamUsage {
    pooled: Option<UsageDetail>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(super) struct UsageDetail {
    #[serde(default)]
    enabled: bool,
    used: Option<i64>,
    limit: Option<i64>,
    remaining: Option<i64>,
    breakdown: Option<UsageBreakdown>,
    total_percent_used: Option<f64>,
    auto_percent_used: Option<f64>,
    api_percent_used: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(super) struct UsageBreakdown {
    included: Option<i64>,
    bonus: Option<i64>,
    total: Option<i64>,
}

impl CursorValidator {
    /// Fetch quota from Cursor API
    ///
    /// Tries both token formats:
    /// 1. Bearer token with just JWT
    /// 2. Cookie with full token (user_id%3A%3AJWT or just JWT)
    ///
    /// # Arguments
    /// * `session_token` - Cursor session token (format: user_id%3A%3AJWT or just JWT)
    pub async fn fetch_quota(&self, session_token: &str) -> Result<QuotaInfo, String> {
        if session_token.is_empty() {
            return Err("No session token provided".to_string());
        }

        // Decode URL-encoded token and extract JWT
        let decoded_token = urlencoding::decode(session_token)
            .map(|s| s.into_owned())
            .unwrap_or_else(|_| session_token.to_string());

        let jwt_token = if decoded_token.contains("::") {
            decoded_token.split("::").last().unwrap_or(&decoded_token)
        } else {
            &decoded_token
        };

        let url = format!("{}/auth/usage-summary", self.usage_api_url);

        // Try 1: Bearer token with just JWT
        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", jwt_token))
            .header("Content-Type", "application/json")
            .timeout(self.http_timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();

        // If auth failed, try alternative format with Cookie
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            // Try 2: Cookie with full token (original format)
            let response_alt = self
                .client
                .get(&url)
                .header(
                    "Cookie",
                    format!("WorkosCursorSessionToken={}", session_token),
                )
                .header("Content-Type", "application/json")
                .timeout(self.http_timeout)
                .send()
                .await
                .map_err(|e| format!("Request failed (retry): {}", e))?;

            let status_alt = response_alt.status();
            if status_alt == reqwest::StatusCode::UNAUTHORIZED {
                return Err("Session token expired or invalid".to_string());
            }
            if !status_alt.is_success() {
                return Err(format!("HTTP {}", status_alt.as_u16()));
            }

            let data: UsageSummaryResponse = response_alt
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            return Ok(self.parse_usage_response(data));
        }

        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }

        let data: UsageSummaryResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(self.parse_usage_response(data))
    }

    /// Parse Cursor usage-summary API response into QuotaInfo
    pub(crate) fn parse_usage_response(&self, data: UsageSummaryResponse) -> QuotaInfo {
        let mut usage_items: Vec<UsageItem> = Vec::new();

        let plan_type = data
            .membership_type
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let is_unlimited = data.is_unlimited;

        // Parse individualUsage
        let individual = data.individual_usage.unwrap_or(IndividualUsage {
            plan: None,
            overall: None,
        });

        let mut total_remaining_pct: Option<f64> = None;

        // Plan usage
        if let Some(ref plan_data) = individual.plan {
            if plan_data.enabled {
                // Get total from breakdown (includes bonus), fallback to limit
                let plan_total = plan_data
                    .breakdown
                    .as_ref()
                    .and_then(|breakdown| breakdown.total)
                    .or(plan_data.limit)
                    .unwrap_or(0);

                let plan_remaining = plan_data.remaining.unwrap_or(0).min(plan_total);

                let fallback_total_remaining_pct = cursor_remaining_percentage(
                    plan_data,
                    if plan_total > 0 {
                        ((plan_remaining as f64 / plan_total as f64) * 100.0).clamp(0.0, 100.0)
                    } else {
                        100.0
                    },
                );
                total_remaining_pct = Some(fallback_total_remaining_pct);
                let auto_remaining_pct = plan_data
                    .auto_percent_used
                    .map(|percent_used| (100.0 - percent_used).clamp(0.0, 100.0))
                    .unwrap_or(fallback_total_remaining_pct);
                let api_remaining_pct = plan_data
                    .api_percent_used
                    .map(|percent_used| (100.0 - percent_used).clamp(0.0, 100.0));

                usage_items.push(UsageItem {
                    usage_type: CURSOR_AUTO_COMPOSER_USAGE_TYPE.to_string(),
                    enabled: true,
                    used: plan_data.used,
                    limit: Some(plan_total),
                    remaining: Some(plan_remaining),
                    remaining_percentage: auto_remaining_pct,
                    reset_time: None,
                });

                if let Some(remaining_percentage) = api_remaining_pct {
                    usage_items.push(UsageItem {
                        usage_type: CURSOR_API_USAGE_TYPE.to_string(),
                        enabled: true,
                        used: None,
                        limit: None,
                        remaining: None,
                        remaining_percentage,
                        reset_time: None,
                    });
                }
            }
        }

        // Overall usage (enterprise individual quota)
        if let Some(ref overall_data) = individual.overall {
            if overall_data.enabled {
                let used = overall_data.used.unwrap_or(0);
                let limit = overall_data.limit.unwrap_or(0);
                let remaining = overall_data.remaining.unwrap_or(0).min(limit);
                let remaining_pct = cursor_remaining_percentage(
                    overall_data,
                    if limit > 0 {
                        ((remaining as f64 / limit as f64) * 100.0).clamp(0.0, 100.0)
                    } else {
                        100.0
                    },
                );

                usage_items.push(UsageItem {
                    usage_type: CURSOR_AUTO_COMPOSER_USAGE_TYPE.to_string(),
                    enabled: true,
                    used: Some(used),
                    limit: Some(limit),
                    remaining: Some(remaining),
                    remaining_percentage: remaining_pct,
                    reset_time: None,
                });
            }
        }

        // Team pooled usage
        if let Some(team) = data.team_usage {
            if let Some(pooled) = team.pooled {
                if pooled.enabled {
                    let used = pooled.used.unwrap_or(0);
                    let limit = pooled.limit.unwrap_or(0);
                    let remaining = pooled.remaining.unwrap_or(0).min(limit);
                    let remaining_pct = cursor_remaining_percentage(
                        &pooled,
                        if limit > 0 {
                            ((remaining as f64 / limit as f64) * 100.0).clamp(0.0, 100.0)
                        } else {
                            100.0
                        },
                    );

                    usage_items.push(UsageItem {
                        usage_type: CURSOR_AUTO_COMPOSER_USAGE_TYPE.to_string(),
                        enabled: true,
                        used: Some(used),
                        limit: Some(limit),
                        remaining: Some(remaining),
                        remaining_percentage: remaining_pct,
                        reset_time: None,
                    });
                }
            }
        }

        // If unlimited and no usage items, create synthetic item
        if is_unlimited && usage_items.is_empty() {
            usage_items.push(UsageItem {
                usage_type: CURSOR_AUTO_COMPOSER_USAGE_TYPE.to_string(),
                enabled: true,
                used: Some(0),
                limit: Some(0),
                remaining: Some(0),
                remaining_percentage: 100.0,
                reset_time: None,
            });
        }

        // Calculate overall remaining percentage
        let remaining_pct = total_remaining_pct.unwrap_or_else(|| {
            if !usage_items.is_empty() {
                usage_items[0].remaining_percentage
            } else {
                0.0
            }
        });

        QuotaInfo {
            remaining_percentage: remaining_pct,
            plan_type: Some(plan_type),
            is_unlimited,
            usage_items,
            auto_message: data.auto_model_selected_display_message,
            ..Default::default()
        }
    }
}
