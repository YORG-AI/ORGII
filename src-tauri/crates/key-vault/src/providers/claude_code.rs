use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use crate::providers::quota_windows::{normalize_reset_time, quota_from_windows, QuotaWindow};
use crate::types::QuotaInfo;

const OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT: &str = "claude-code/2.1.0";
const DEFAULT_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Deserialize)]
struct OAuthUsageWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthUsageResponse {
    five_hour: Option<OAuthUsageWindow>,
    seven_day: Option<OAuthUsageWindow>,
}

#[derive(Debug, Deserialize)]
struct OAuthProfileResponse {
    account: Option<OAuthProfileAccount>,
    organization: Option<OAuthProfileOrganization>,
}

#[derive(Debug, Deserialize)]
struct OAuthProfileAccount {
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthProfileOrganization {
    uuid: Option<String>,
    name: Option<String>,
    organization_type: Option<String>,
    rate_limit_tier: Option<String>,
}

pub struct ClaudeCodeQuotaFetcher {
    client: reqwest::Client,
    timeout: Duration,
}

pub struct ClaudeCodeQuotaRefresh {
    pub quota: QuotaInfo,
    pub account_metadata: HashMap<String, String>,
}

impl ClaudeCodeQuotaFetcher {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }

    pub async fn fetch_quota_refresh(
        &self,
        access_token: &str,
    ) -> Result<ClaudeCodeQuotaRefresh, String> {
        let token = access_token.trim();
        if token.is_empty() {
            return Err("Claude Code OAuth access token is empty".to_string());
        }

        let (usage_result, account_metadata) = tokio::join!(
            self.fetch_usage_body(token),
            self.fetch_account_metadata(token),
        );

        let mut quota = parse_oauth_usage_response(&usage_result?)?;
        if let Some(plan_type) = account_metadata
            .get("rate_limit_tier")
            .map(String::as_str)
            .filter(|tier| !tier.is_empty())
        {
            quota.plan_type = Some(plan_type.to_string());
        }

        Ok(ClaudeCodeQuotaRefresh {
            quota,
            account_metadata,
        })
    }

    pub async fn fetch_quota(&self, access_token: &str) -> Result<QuotaInfo, String> {
        Ok(self.fetch_quota_refresh(access_token).await?.quota)
    }

    pub async fn fetch_account_metadata(&self, access_token: &str) -> HashMap<String, String> {
        match self.fetch_profile_body(access_token.trim()).await {
            Ok(body) => parse_oauth_profile_metadata(&body).unwrap_or_default(),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "Claude Code OAuth profile lookup failed; continuing without identity metadata"
                );
                HashMap::new()
            }
        }
    }

    async fn fetch_usage_body(&self, access_token: &str) -> Result<String, String> {
        let response = self
            .client
            .get(OAUTH_USAGE_URL)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("anthropic-beta", OAUTH_BETA_HEADER)
            .header("User-Agent", CLAUDE_CODE_USER_AGENT)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|err| format!("Claude Code OAuth usage request failed: {err}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| format!("Claude Code OAuth usage body read failed: {err}"))?;

        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "Claude Code OAuth usage unauthorized: HTTP {}",
                status.as_u16()
            ));
        }
        if !status.is_success() {
            return Err(format!(
                "Claude Code OAuth usage failed: HTTP {}: {}",
                status.as_u16(),
                body
            ));
        }

        Ok(body)
    }

    async fn fetch_profile_body(&self, access_token: &str) -> Result<String, String> {
        if access_token.is_empty() {
            return Err("Claude Code OAuth access token is empty".to_string());
        }

        let response = self
            .client
            .get(OAUTH_PROFILE_URL)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("anthropic-beta", OAUTH_BETA_HEADER)
            .header("User-Agent", CLAUDE_CODE_USER_AGENT)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|err| format!("Claude Code OAuth profile request failed: {err}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| format!("Claude Code OAuth profile body read failed: {err}"))?;

        if !status.is_success() {
            return Err(format!(
                "Claude Code OAuth profile failed: HTTP {}: {}",
                status.as_u16(),
                body
            ));
        }

        Ok(body)
    }
}

impl Default for ClaudeCodeQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_oauth_usage_response(body: &str) -> Result<QuotaInfo, String> {
    let response: OAuthUsageResponse = serde_json::from_str(body)
        .map_err(|err| format!("Claude Code OAuth usage parse failed: {err}"))?;
    Ok(quota_from_usage_response(response))
}

fn quota_from_usage_response(response: OAuthUsageResponse) -> QuotaInfo {
    let mut windows = Vec::new();

    if let Some(window) = response.five_hour {
        if let Some(utilization) = window.utilization {
            windows.push(QuotaWindow::session(
                utilization,
                window.resets_at.as_deref().and_then(normalize_reset_time),
            ));
        }
    }

    if let Some(window) = response.seven_day {
        if let Some(utilization) = window.utilization {
            windows.push(QuotaWindow::weekly(
                utilization,
                window.resets_at.as_deref().and_then(normalize_reset_time),
            ));
        }
    }

    quota_from_windows("claude_code", "oauth_usage", windows)
}

fn parse_oauth_profile_metadata(body: &str) -> Result<HashMap<String, String>, String> {
    let parsed: OAuthProfileResponse = serde_json::from_str(body)
        .map_err(|err| format!("Claude Code OAuth profile parse failed: {err}"))?;

    let mut metadata = HashMap::new();
    if let Some(email) = parsed
        .account
        .and_then(|account| normalize_metadata_field(account.email))
    {
        metadata.insert("email".to_string(), email);
    }
    if let Some(organization) = parsed.organization {
        if let Some(uuid) = normalize_metadata_field(organization.uuid) {
            metadata.insert("organization_uuid".to_string(), uuid);
        }
        if let Some(name) = normalize_metadata_field(organization.name) {
            metadata.insert("organization_name".to_string(), name);
        }
        if let Some(organization_type) =
            normalize_metadata_field(organization.organization_type)
        {
            metadata.insert("organization_type".to_string(), organization_type);
        }
        if let Some(rate_limit_tier) = normalize_metadata_field(organization.rate_limit_tier) {
            metadata.insert("rate_limit_tier".to_string(), rate_limit_tier);
        }
    }

    Ok(metadata)
}

fn normalize_metadata_field(value: Option<String>) -> Option<String> {
    value
        .map(|field| field.trim().to_string())
        .filter(|field| !field.is_empty())
}

#[cfg(test)]
#[path = "claude_code_tests.rs"]
mod tests;
