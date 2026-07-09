//! GitHub Copilot PAT Validation
//!
//! Validates GitHub Personal Access Tokens (PAT) for Copilot access
//! and fetches quota information from the GitHub API.
//!
//! Supported token formats:
//! - `github_pat_*` - Fine-grained PAT
//! - `ghp_*` - Classic PAT
//! - `gho_*` - OAuth token
//! - `ghu_*` - User-to-server token

use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

use crate::types::{QuotaInfo, UsageItem, ValidationResult};

// GitHub Copilot API
const COPILOT_ENTITLEMENT_URL: &str = "https://api.github.com/copilot_internal/user";
const GITHUB_API_VERSION: &str = "2022-11-28";
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Copilot quota snapshot from API response
#[derive(Debug, Deserialize)]
struct QuotaSnapshot {
    entitlement: Option<i64>,
    remaining: Option<i64>,
    percent_remaining: Option<f64>,
    #[serde(default)]
    unlimited: bool,
}

/// Copilot entitlement API response
#[derive(Debug, Deserialize)]
struct CopilotEntitlementResponse {
    copilot_plan: Option<String>,
    access_type_sku: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    chat_enabled: bool,
    quota_reset_date_utc: Option<String>,
    quota_reset_date: Option<String>,
    limited_user_reset_date: Option<String>,
    quota_snapshots: Option<QuotaSnapshots>,
}

#[derive(Debug, Deserialize)]
struct QuotaSnapshots {
    chat: Option<QuotaSnapshot>,
    completions: Option<QuotaSnapshot>,
    premium_interactions: Option<QuotaSnapshot>,
}

/// Copilot credential validator
pub struct CopilotValidator {
    client: Client,
    timeout: Duration,
}

impl CopilotValidator {
    /// Create a new validator with default settings
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }

    /// Create a new validator with custom timeout
    pub fn with_timeout(timeout_secs: u64) -> Self {
        Self {
            client: Client::new(),
            timeout: Duration::from_secs(timeout_secs),
        }
    }

    /// Validate a GitHub token (PAT or OAuth)
    ///
    /// # Arguments
    /// * `token` - GitHub PAT (github_pat_*, ghp_*) or OAuth token (gho_*, ghu_*)
    ///
    /// # Returns
    /// ValidationResult with quota info if successful
    pub async fn validate(&self, token: &str) -> ValidationResult {
        // Format validation
        if token.is_empty() {
            return ValidationResult::failure("No token provided");
        }

        // Validate token format
        let (valid_format, format_msg) = self.validate_format(token);
        if !valid_format {
            return ValidationResult::failure(&format_msg);
        }

        // Fetch quota/entitlement
        match self.fetch_quota(token).await {
            Ok(quota_info) => {
                // Check if user has Copilot access
                if let Some(ref plan_type) = quota_info.plan_type {
                    if plan_type.to_lowercase().contains("none") {
                        return ValidationResult::failure(
                            "No Copilot subscription found for this account",
                        )
                        .with_quota(quota_info);
                    }
                }

                let plan_name = quota_info
                    .plan_type
                    .clone()
                    .unwrap_or_else(|| "account".to_string());

                let models = self.get_available_models(&quota_info);

                ValidationResult::success(&format!("Copilot {} validated", plan_name))
                    .with_models(models)
                    .with_quota(quota_info)
            }
            Err(e) => {
                if e.contains("401") {
                    ValidationResult::failure("Copilot token expired or invalid")
                } else if e.contains("403") {
                    ValidationResult::failure("No Copilot access - check subscription")
                } else {
                    ValidationResult::failure(&format!("GitHub API error: {}", e))
                }
            }
        }
    }

    /// Validate token format without making API calls
    pub fn validate_format(&self, token: &str) -> (bool, String) {
        if token.is_empty() {
            return (false, "No token provided".to_string());
        }

        // Fine-grained PAT
        if token.starts_with("github_pat_") {
            if token.len() > 20 {
                return (true, "Valid GitHub fine-grained PAT format".to_string());
            }
            return (false, "Token too short".to_string());
        }

        // Classic PAT
        if token.starts_with("ghp_") {
            if token.len() > 20 {
                return (true, "Valid GitHub classic PAT format".to_string());
            }
            return (false, "Token too short".to_string());
        }

        // OAuth tokens
        if token.starts_with("gho_") || token.starts_with("ghu_") {
            if token.len() > 20 {
                return (true, "Valid GitHub OAuth token format".to_string());
            }
            return (false, "Token too short".to_string());
        }

        // Older format tokens (40+ chars)
        if token.len() >= 40 {
            return (true, "Token format appears valid".to_string());
        }

        (false, "Unknown token format".to_string())
    }

    /// Fetch quota/entitlement from GitHub Copilot API
    pub async fn fetch_quota(&self, token: &str) -> Result<QuotaInfo, String> {
        let response = self
            .client
            .get(COPILOT_ENTITLEMENT_URL)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .header("User-Agent", "orgii/1.0")
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }

        let data: CopilotEntitlementResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(self.parse_entitlement_response(data))
    }

    /// Parse Copilot entitlement API response into QuotaInfo
    fn parse_entitlement_response(&self, data: CopilotEntitlementResponse) -> QuotaInfo {
        let mut usage_items: Vec<UsageItem> = Vec::new();

        // Plan type
        let copilot_plan = data.copilot_plan.clone().unwrap_or_default();
        let access_sku = data.access_type_sku.clone().unwrap_or_default();
        let plan_type = self.get_plan_display_name(&copilot_plan, &access_sku);

        // Is this a free/limited plan?
        let sku_lower = access_sku.to_lowercase();
        let is_free = sku_lower.contains("free") || sku_lower.contains("limited");
        let is_unlimited = !is_free
            && (copilot_plan == "individual"
                || copilot_plan == "business"
                || copilot_plan == "enterprise");

        // Reset date
        let reset_time = data
            .quota_reset_date_utc
            .or(data.quota_reset_date)
            .or(data.limited_user_reset_date);

        // Parse quota snapshots
        if let Some(snapshots) = data.quota_snapshots {
            // Chat quota
            if let Some(chat) = snapshots.chat {
                if !chat.unlimited {
                    let entitlement = chat.entitlement.unwrap_or(50);
                    let remaining = chat.remaining.unwrap_or(0);
                    let pct = chat
                        .percent_remaining
                        .unwrap_or_else(|| (remaining as f64 / entitlement as f64) * 100.0);

                    usage_items.push(UsageItem {
                        usage_type: "chat".to_string(),
                        enabled: true,
                        used: Some(entitlement - remaining),
                        limit: Some(entitlement),
                        remaining: Some(remaining),
                        remaining_percentage: pct,
                        reset_time: None,
                    });
                }
            }

            // Completions quota
            if let Some(completions) = snapshots.completions {
                if !completions.unlimited {
                    let entitlement = completions.entitlement.unwrap_or(2000);
                    let remaining = completions.remaining.unwrap_or(0);
                    let pct = completions
                        .percent_remaining
                        .unwrap_or_else(|| (remaining as f64 / entitlement as f64) * 100.0);

                    usage_items.push(UsageItem {
                        usage_type: "completions".to_string(),
                        enabled: true,
                        used: Some(entitlement - remaining),
                        limit: Some(entitlement),
                        remaining: Some(remaining),
                        remaining_percentage: pct,
                        reset_time: None,
                    });
                }
            }

            // Premium interactions quota
            if let Some(premium) = snapshots.premium_interactions {
                if !premium.unlimited {
                    let entitlement = premium.entitlement.unwrap_or(50);
                    let remaining = premium.remaining.unwrap_or(0);
                    let pct = premium
                        .percent_remaining
                        .unwrap_or_else(|| (remaining as f64 / entitlement as f64) * 100.0);

                    usage_items.push(UsageItem {
                        usage_type: "premium".to_string(),
                        enabled: true,
                        used: Some(entitlement - remaining),
                        limit: Some(entitlement),
                        remaining: Some(remaining),
                        remaining_percentage: pct,
                        reset_time: None,
                    });
                }
            }
        }

        // Calculate overall remaining percentage
        // Use the lowest remaining percentage (most constrained resource)
        let remaining_pct = if is_unlimited {
            100.0
        } else if !usage_items.is_empty() {
            usage_items
                .iter()
                .map(|item| item.remaining_percentage)
                .fold(f64::MAX, f64::min)
        } else if is_free {
            // Free plan with no snapshots - add synthetic items
            usage_items.push(UsageItem {
                usage_type: "chat".to_string(),
                enabled: true,
                used: Some(0),
                limit: Some(50),
                remaining: Some(50),
                remaining_percentage: 100.0,
                reset_time: None,
            });
            usage_items.push(UsageItem {
                usage_type: "completions".to_string(),
                enabled: true,
                used: Some(0),
                limit: Some(2000),
                remaining: Some(2000),
                remaining_percentage: 100.0,
                reset_time: None,
            });
            100.0
        } else {
            -1.0
        };

        QuotaInfo {
            remaining_percentage: remaining_pct,
            plan_type: Some(plan_type),
            is_unlimited,
            reset_time,
            usage_items,
            ..Default::default()
        }
    }

    /// Get human-readable plan name
    pub(crate) fn get_plan_display_name(&self, copilot_plan: &str, access_sku: &str) -> String {
        let sku = access_sku.to_lowercase();
        let plan = copilot_plan.to_lowercase();

        if sku.contains("pro") || plan.contains("pro") {
            return "Pro".to_string();
        }
        if plan == "individual" || sku.contains("individual") {
            return "Pro".to_string();
        }
        if sku.contains("business") || plan == "business" {
            return "Business".to_string();
        }
        if sku.contains("enterprise") || plan == "enterprise" {
            return "Enterprise".to_string();
        }
        if sku.contains("free") || plan.contains("free") {
            return "Free".to_string();
        }

        if !copilot_plan.is_empty() {
            let mut chars = copilot_plan.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Unknown".to_string(),
            }
        } else if !access_sku.is_empty() {
            let mut chars = access_sku.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Unknown".to_string(),
            }
        } else {
            "Unknown".to_string()
        }
    }

    /// Get list of available models based on plan.
    ///
    /// Returns an empty list — Copilot doesn't expose a models API endpoint.
    /// The frontend derives available models from the backend reference prices
    /// (tunables.py copilot section), which is the single source of truth.
    fn get_available_models(&self, _quota_info: &QuotaInfo) -> Vec<String> {
        Vec::new()
    }
}

impl Default for CopilotValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "../tests/copilot_tests.rs"]
mod tests;
