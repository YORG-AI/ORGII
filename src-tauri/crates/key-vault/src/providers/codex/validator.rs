//! `CodexValidator`: credential validation, model discovery and quota entry points.

use super::app_server::{
    cleanup_temporary_codex_home, run_codex_model_list_rpc, run_codex_rate_limits_rpc,
    write_temporary_codex_home,
};
use super::id_token::extract_account_id_from_id_token;
use super::model_discovery::parse_codex_models_response;
use super::quota::quota_from_usage_json;
use crate::providers::openai::OpenAIValidator;
use crate::types::{DiscoveredModel, QuotaInfo, ValidationResult};

/// ChatGPT usage API endpoint
const USAGE_API_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_MODELS_API_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const CODEX_MODELS_CLIENT_VERSION: &str = "0.124.0";
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.124.0 (orgii, cli)";

/// Codex CLI validator
pub struct CodexValidator {
    timeout: std::time::Duration,
}

impl CodexValidator {
    pub fn new() -> Self {
        Self {
            timeout: std::time::Duration::from_secs(10),
        }
    }

    /// Validate Codex credential (OAuth or API key)
    ///
    /// If session_token (OAuth) is provided, validates against ChatGPT API.
    /// Otherwise falls back to OpenAI API key validation.
    pub async fn validate(
        &self,
        api_key: &str,
        session_token: Option<&str>,
        base_url: Option<&str>,
    ) -> ValidationResult {
        // OAuth takes priority if session_token is provided
        if let Some(token) = session_token {
            if !token.is_empty() {
                return self.validate_oauth(token).await;
            }
        }

        // Fall back to OpenAI API key validation
        if !api_key.is_empty() {
            let openai = OpenAIValidator::new();
            return openai
                .validate(api_key, base_url, Some("openai_api"), None)
                .await;
        }

        ValidationResult::failure("No API key or OAuth token provided")
    }

    /// Validate OAuth token against ChatGPT usage API
    ///
    /// Codex OAuth tokens (from `codex auth login`) work with chatgpt.com,
    /// not api.openai.com. The token is a JWT from OpenAI's Auth0.
    pub async fn validate_oauth(&self, access_token: &str) -> ValidationResult {
        let client = reqwest::Client::new();
        let response = client
            .get(USAGE_API_URL)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Accept", "application/json")
            .timeout(self.timeout)
            .send()
            .await;

        match response {
            Ok(resp) => {
                if resp.status().is_success() {
                    // Authentication and model discovery are separate
                    // boundaries. Wizard callers resolve the catalog exactly
                    // once through `oauth_model_catalog` after this succeeds.
                    self.parse_usage_response(resp).await
                } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                    || resp.status() == reqwest::StatusCode::FORBIDDEN
                {
                    ValidationResult::failure(
                        "OAuth token expired - please run 'codex auth login' again",
                    )
                } else {
                    ValidationResult::success("Codex CLI session (validation skipped)")
                }
            }
            Err(err) => {
                log::warn!("[CodexValidation] Usage API request failed: {}", err);
                ValidationResult::failure(&format!("Could not reach Codex usage API: {}", err))
            }
        }
    }

    /// Fetch the account-visible Codex model list from ChatGPT's Codex backend.
    ///
    /// This mirrors Codex CLI's `/models?client_version=...` discovery path.
    /// `id_token` is optional for older/local credentials, but when present we
    /// extract the ChatGPT account id and send it so multi-account sessions are
    /// scoped the same way runtime Codex requests are scoped.
    pub async fn list_models(
        &self,
        access_token: &str,
        id_token: Option<&str>,
    ) -> Result<Vec<String>, String> {
        self.discover_models(access_token, None, id_token)
            .await
            .map(|models| models.into_iter().map(|model| model.id).collect())
    }

    /// Discover the account-visible Codex catalog through the public
    /// app-server protocol. The legacy private HTTP route is retained only as
    /// a compatibility fallback for machines where the Codex binary cannot be
    /// launched.
    pub async fn discover_models(
        &self,
        access_token: &str,
        refresh_token: Option<&str>,
        id_token: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, String> {
        let token = access_token.trim();
        if token.is_empty() {
            return Err("Codex OAuth access token is empty".to_string());
        }

        let app_server_error = match self
            .list_models_via_app_server(token, refresh_token, id_token)
            .await
        {
            Ok(models) if !models.is_empty() => return Ok(models),
            Ok(_) => {
                log::warn!(
                    "[CodexModels] app-server returned an empty model catalog; using compatibility fallback"
                );
                None
            }
            Err(err) => {
                log::warn!(
                    "[CodexModels] app-server model discovery failed ({err}); using compatibility fallback"
                );
                Some(err)
            }
        };

        match self.list_models_via_private_backend(token, id_token).await {
            Ok(models) => Ok(models
                .into_iter()
                .map(|id| DiscoveredModel {
                    id,
                    ..DiscoveredModel::default()
                })
                .collect()),
            Err(private_error) => {
                if let Some(auth_error) = app_server_error.filter(|error| {
                    let lower = error.to_lowercase();
                    lower.contains("401")
                        || lower.contains("403")
                        || lower.contains("unauthorized")
                        || lower.contains("forbidden")
                        || lower.contains("invalid token")
                        || lower.contains("token expired")
                }) {
                    Err(auth_error)
                } else {
                    Err(private_error)
                }
            }
        }
    }

    async fn list_models_via_app_server(
        &self,
        access_token: &str,
        refresh_token: Option<&str>,
        id_token: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, String> {
        let codex_home = write_temporary_codex_home(access_token, refresh_token, id_token).await?;
        let discovery_result = run_codex_model_list_rpc(&codex_home).await;
        cleanup_temporary_codex_home(&codex_home, "model discovery").await;
        discovery_result
    }

    async fn list_models_via_private_backend(
        &self,
        access_token: &str,
        id_token: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let token = access_token.trim();

        let mut request = reqwest::Client::new()
            .get(CODEX_MODELS_API_URL)
            .query(&[("client_version", CODEX_MODELS_CLIENT_VERSION)])
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", CODEX_USER_AGENT)
            .header("originator", "codex_cli_rs")
            .header("Accept", "application/json")
            .timeout(self.timeout);

        if let Some(account_id) = id_token.and_then(extract_account_id_from_id_token) {
            request = request.header("ChatGPT-Account-ID", account_id);
        }

        let response = request
            .send()
            .await
            .map_err(|err| format!("Codex OAuth model discovery request failed: {err}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| format!("Codex OAuth model discovery body read failed: {err}"))?;

        if !status.is_success() {
            return Err(format!(
                "Codex OAuth model discovery failed: HTTP {}: {}",
                status.as_u16(),
                body
            ));
        }

        parse_codex_models_response(&body)
    }

    /// Fetch OAuth quota for refresh flows: usage API first, then app-server RPC.
    pub async fn fetch_oauth_quota(
        &self,
        access_token: &str,
        refresh_token: Option<&str>,
        id_token: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        match self.fetch_usage_api_quota(access_token).await {
            Ok(quota) => Ok(quota),
            Err(usage_api_err) => {
                log::warn!(
                    "[CodexQuota] Usage API quota fetch failed ({usage_api_err}); falling back to app-server"
                );
                self.fetch_app_server_quota(access_token, refresh_token, id_token)
                    .await
            }
        }
    }

    /// Fetch quota from ChatGPT's wham usage API (primary + secondary windows).
    pub async fn fetch_usage_api_quota(&self, access_token: &str) -> Result<QuotaInfo, String> {
        let token = access_token.trim();
        if token.is_empty() {
            return Err("Codex OAuth access token is empty".to_string());
        }

        let response = reqwest::Client::new()
            .get(USAGE_API_URL)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|err| format!("Codex usage API request failed: {err}"))?;

        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "Codex usage API unauthorized: HTTP {}",
                status.as_u16()
            ));
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<empty body>".to_string());
            return Err(format!(
                "Codex usage API failed: HTTP {}: {}",
                status.as_u16(),
                body
            ));
        }

        let data = response
            .json::<serde_json::Value>()
            .await
            .map_err(|err| format!("Codex usage API parse failed: {err}"))?;

        quota_from_usage_json(&data).ok_or_else(|| {
            "Codex usage API response did not include primary or secondary windows".to_string()
        })
    }

    pub async fn fetch_app_server_quota(
        &self,
        access_token: &str,
        refresh_token: Option<&str>,
        id_token: Option<&str>,
    ) -> Result<QuotaInfo, String> {
        let token = access_token.trim();
        if token.is_empty() {
            return Err("Codex OAuth access token is empty".to_string());
        }

        let codex_home = write_temporary_codex_home(token, refresh_token, id_token).await?;
        let quota_result = run_codex_rate_limits_rpc(&codex_home).await;
        cleanup_temporary_codex_home(&codex_home, "quota fetch").await;
        quota_result
    }

    /// Parse ChatGPT usage API response
    async fn parse_usage_response(&self, resp: reqwest::Response) -> ValidationResult {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            let plan_type = data
                .get("plan_type")
                .and_then(|p| p.as_str())
                .unwrap_or("plus");

            // Try to extract quota info
            let quota_info = self.extract_quota_info(&data);

            let mut result =
                ValidationResult::success(&format!("Valid Codex session ({})", plan_type));

            if let Some(quota) = quota_info {
                result = result.with_quota(quota);
            }

            result
        } else {
            ValidationResult::failure("Failed to parse Codex usage API response")
        }
    }

    /// Extract quota information from ChatGPT usage API response
    ///
    /// API returns:
    /// ```json
    /// {
    ///   "rate_limit": {
    ///     "primary_window": { "used_percent": 0, "reset_at": 1234567890 },
    ///     "secondary_window": { "used_percent": 0, "reset_at": 1234567890 },
    ///     "limit_reached": false
    ///   },
    ///   "plan_type": "plus"
    /// }
    /// ```
    fn extract_quota_info(&self, data: &serde_json::Value) -> Option<QuotaInfo> {
        quota_from_usage_json(data)
    }

    /// Validate token format (fast check, no API call)
    pub fn validate_format(&self, token: &str) -> (bool, String) {
        if token.is_empty() {
            return (false, "Token is empty".to_string());
        }

        // Codex OAuth tokens are JWTs (start with "eyJ")
        if token.starts_with("eyJ") {
            return (true, "Valid JWT format".to_string());
        }

        // OpenAI API keys start with "sk-"
        if token.starts_with("sk-") {
            return (true, "Valid OpenAI API key format".to_string());
        }

        (false, "Unknown token format".to_string())
    }
}

impl Default for CodexValidator {
    fn default() -> Self {
        Self::new()
    }
}
