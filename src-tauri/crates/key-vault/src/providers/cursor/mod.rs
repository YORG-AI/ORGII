//! Cursor CLI credential validation
//!
//! Validates Cursor API keys via CLI subprocess and fetches quota
//! information from the Cursor API.
//!
//! Validation flow:
//! 1. Format validation (key_* or crsr_* prefix)
//! 2. Get available models via CLI --list-models
//! 3. Fetch quota via Cursor API (if session token provided)
//!
//! Note: Uses subprocess calls to the `cursor` CLI binary.

pub mod models;
pub(crate) mod quota;
pub mod usage_export;

pub use models::CursorNativeModel;

use reqwest::Client;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

use crate::types::ValidationResult;

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const HTTP_TIMEOUT_SECS: u64 = 30;

/// Cursor credential validator
pub struct CursorValidator {
    pub(crate) client: Client,
    pub(crate) cli_timeout: Duration,
    pub(crate) http_timeout: Duration,
    pub(crate) usage_api_url: String,
}

impl CursorValidator {
    /// Create a new validator with default settings
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            cli_timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
            http_timeout: Duration::from_secs(HTTP_TIMEOUT_SECS),
            usage_api_url: quota::CURSOR_USAGE_API_URL.to_string(),
        }
    }

    /// Create a new validator with custom timeout
    pub fn with_timeout(cli_timeout_secs: u64) -> Self {
        Self {
            client: Client::new(),
            cli_timeout: Duration::from_secs(cli_timeout_secs),
            http_timeout: Duration::from_secs(HTTP_TIMEOUT_SECS),
            usage_api_url: quota::CURSOR_USAGE_API_URL.to_string(),
        }
    }

    /// Validate a Cursor API key
    ///
    /// # Arguments
    /// * `api_key` - Cursor API key (starts with "key_" or "crsr_")
    /// * `session_token` - Optional session token for quota fetching
    ///
    /// # Returns
    /// ValidationResult with quota info. Model list is always empty —
    /// the frontend derives models from backend tunables / reference prices.
    pub async fn validate(&self, api_key: &str, session_token: Option<&str>) -> ValidationResult {
        if api_key.is_empty() {
            return ValidationResult::failure("No API key provided");
        }

        let (valid_format, format_msg) = self.validate_format(api_key);
        if !valid_format {
            return ValidationResult::failure(&format_msg);
        }

        // Validate key via HTTP /v0/models (fast, ~2s).
        // Only checks whether the key is accepted (2xx vs 401/403).
        // The returned model list is NOT used (it's inaccurate).
        // Actual models come from the backend tunables / reference prices.
        match self.try_http_validate_key(api_key).await {
            Ok(()) => {
                log::info!("[CursorValidation] ✅ API key validated via /v0/models");
            }
            Err(e) => {
                log::warn!("[CursorValidation] ❌ Key validation failed: {}", e);
                return ValidationResult::failure(&format!("Invalid API key: {}", e));
            }
        }

        // Return empty model list — frontend derives models from tunables
        let models: Vec<String> = Vec::new();

        let quota_info = if let Some(token) = session_token {
            match self.fetch_quota(token).await {
                Ok(quota) => Some(quota),
                Err(e) => {
                    log::warn!("Failed to fetch quota: {}", e);
                    None
                }
            }
        } else {
            None
        };

        let mut result = ValidationResult::success("API key valid").with_models(models);

        if let Some(quota) = quota_info {
            result = result.with_quota(quota);
        }

        result
    }

    /// Validate API key by hitting Cursor's /v0/models endpoint.
    /// A 2xx response means the key is valid. The response body is
    /// intentionally discarded — model lists come from tunables.
    async fn try_http_validate_key(&self, api_key: &str) -> Result<(), String> {
        let url = "https://api.cursor.com/v0/models";

        let response = self
            .client
            .get(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .timeout(self.http_timeout)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if response.status().is_success() {
            Ok(())
        } else if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            Err("Invalid API key".to_string())
        } else {
            Err(format!(
                "Unexpected status: HTTP {}",
                response.status().as_u16()
            ))
        }
    }

    /// Validate API key format without making API calls
    pub fn validate_format(&self, api_key: &str) -> (bool, String) {
        if api_key.is_empty() {
            return (false, "No API key provided".to_string());
        }

        if !api_key.starts_with("key_") && !api_key.starts_with("crsr_") {
            return (
                false,
                "Cursor API key should start with 'key_' or 'crsr_'".to_string(),
            );
        }

        if api_key.len() < 20 {
            return (false, "API key too short".to_string());
        }

        (true, "Format valid".to_string())
    }

    /// Test if a specific model works with the API key (runtime check)
    pub async fn check_model(&self, api_key: &str, model: &str) -> (bool, String) {
        let mut command = Command::new("cursor");
        command
            .args([
                "agent",
                "--api-key",
                api_key,
                "-p",
                "--model",
                model,
                "output 1<end>",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Suppress the console window on Windows.
        #[cfg(windows)]
        command.creation_flags(app_platform::CREATE_NO_WINDOW);
        let result = timeout(self.cli_timeout, command.output()).await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let combined = format!("{}{}", stdout, stderr);
                let output_lower = combined.to_lowercase();

                if output_lower.contains("rate limit")
                    || output_lower.contains("resource_exhausted")
                {
                    return (false, "Rate limited".to_string());
                }

                if output_lower.contains("not supported") || output_lower.contains("not available")
                {
                    return (false, "Model not available".to_string());
                }

                if output_lower.contains("invalid") && output_lower.contains("key") {
                    return (false, "Invalid API key".to_string());
                }

                if output.status.success() && combined.len() > 10 {
                    return (true, "Model works".to_string());
                }

                (
                    false,
                    format!("Test failed (exit code {:?})", output.status.code()),
                )
            }
            Ok(Err(e)) => (false, format!("CLI error: {}", e)),
            Err(_) => (false, "Timeout".to_string()),
        }
    }
}

impl Default for CursorValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "../tests/cursor_tests.rs"]
mod tests;
