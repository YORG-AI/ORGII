//! Codex CLI credential validation.
//!
//! Validates Codex credentials supporting:
//! - OAuth authentication (ChatGPT Plus/Pro subscription via chatgpt.com)
//! - API key authentication (OpenAI API key via api.openai.com)
//! - Quota fetching from ChatGPT usage API

use crate::providers::openai::OpenAIValidator;
use crate::providers::quota_windows::{quota_from_windows, unix_seconds_to_rfc3339, QuotaWindow};
use crate::types::{QuotaInfo, ValidationResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// ChatGPT usage API endpoint
const USAGE_API_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_MODELS_API_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const CODEX_MODELS_CLIENT_VERSION: &str = "0.124.0";
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.124.0 (orgii, cli)";
const APP_SERVER_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Deserialize)]
struct CodexModelsResponse {
    #[serde(default)]
    models: Vec<CodexModelInfo>,
}

#[derive(Debug, Deserialize)]
struct CodexModelInfo {
    slug: String,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    supported_in_api: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindow {
    used_percent: Option<f64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimitsPayload {
    primary: Option<CodexRateLimitWindow>,
    secondary: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitResetCredits {
    available_count: Option<u64>,
    total_earned_count: Option<u64>,
    next_expires_at: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitsResponse {
    rate_limits: Option<CodexRateLimitsPayload>,
    rate_limit_reset_credits: Option<CodexRateLimitResetCredits>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    id: Option<u64>,
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest<'a, T> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: T,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification<'a, T> {
    jsonrpc: &'static str,
    method: &'a str,
    params: T,
}

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
                    let mut result = self.parse_usage_response(resp).await;
                    if result.valid {
                        match self.list_models(access_token, None).await {
                            Ok(models) if !models.is_empty() => {
                                result = result.with_models(models);
                            }
                            Ok(_) => {}
                            Err(err) => {
                                log::warn!("[CodexValidation] Model discovery failed: {}", err);
                            }
                        }
                    }
                    result
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
        let token = access_token.trim();
        if token.is_empty() {
            return Err("Codex OAuth access token is empty".to_string());
        }

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
        let cleanup_result = tokio::fs::remove_dir_all(&codex_home).await;
        if let Err(err) = cleanup_result {
            log::warn!(
                "[CodexRateLimit] Failed to remove temporary Codex home {}: {}",
                codex_home.display(),
                err
            );
        }
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

fn parse_usage_window_reset(window: &serde_json::Value) -> Option<String> {
    window
        .get("reset_at")
        .or_else(|| window.get("resets_at"))
        .or_else(|| window.get("resetAt"))
        .or_else(|| window.get("resetsAt"))
        .and_then(|value| {
            if let Some(ts) = value.as_i64() {
                unix_seconds_to_rfc3339(ts)
            } else {
                value.as_str().map(str::to_string).and_then(|text| {
                    crate::providers::quota_windows::normalize_reset_time(&text).or(Some(text))
                })
            }
        })
}

fn parse_usage_window_percent(window: &serde_json::Value) -> Option<f64> {
    window
        .get("used_percent")
        .or_else(|| window.get("usedPercent"))
        .or_else(|| window.get("percent_used"))
        .or_else(|| window.get("percentUsed"))
        .or_else(|| window.get("usage_percent"))
        .or_else(|| window.get("usagePercent"))
        .or_else(|| window.get("utilization"))
        .and_then(|value| value.as_f64())
}

fn push_usage_window(
    windows: &mut Vec<QuotaWindow>,
    usage_type: fn(f64, Option<String>) -> QuotaWindow,
    window: Option<&serde_json::Value>,
) {
    if let Some(window) = window {
        if let Some(used_percent) = parse_usage_window_percent(window) {
            windows.push(usage_type(used_percent, parse_usage_window_reset(window)));
        }
    }
}

fn quota_from_usage_json(data: &serde_json::Value) -> Option<QuotaInfo> {
    let rate_limit = data
        .get("rate_limit")
        .or_else(|| data.get("rate_limits"))
        .unwrap_or(data);
    let mut windows = Vec::new();

    push_usage_window(
        &mut windows,
        QuotaWindow::session,
        rate_limit
            .get("primary_window")
            .or_else(|| rate_limit.get("primary"))
            .or_else(|| rate_limit.get("five_hour"))
            .or_else(|| data.get("five_hour")),
    );
    push_usage_window(
        &mut windows,
        QuotaWindow::weekly,
        rate_limit
            .get("secondary_window")
            .or_else(|| rate_limit.get("secondary"))
            .or_else(|| rate_limit.get("seven_day"))
            .or_else(|| data.get("seven_day")),
    );

    if windows.is_empty() {
        return None;
    }

    let plan_type = data
        .get("plan_type")
        .and_then(|v| v.as_str())
        .unwrap_or("plus")
        .to_lowercase();

    Some(quota_from_windows(&plan_type, "codex_usage_api", windows))
}

fn extract_account_id_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    value
        .get("https://api.openai.com/auth.chatgpt_account_id")
        .or_else(|| value.get("chatgpt_account_id"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn parse_codex_models_response(body: &str) -> Result<Vec<String>, String> {
    let parsed: CodexModelsResponse = serde_json::from_str(body)
        .map_err(|err| format!("Codex OAuth model discovery parse failed: {err}"))?;
    let mut models = Vec::new();
    for model in parsed.models {
        if model.slug.is_empty() {
            continue;
        }
        if model.visibility.as_deref() == Some("hidden") {
            continue;
        }
        if model.supported_in_api == Some(false) {
            continue;
        }
        if !models.contains(&model.slug) {
            models.push(model.slug);
        }
    }
    Ok(models)
}

async fn write_temporary_codex_home(
    access_token: &str,
    refresh_token: Option<&str>,
    id_token: Option<&str>,
) -> Result<PathBuf, String> {
    let codex_home =
        std::env::temp_dir().join(format!("orgii-codex-quota-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&codex_home)
        .await
        .map_err(|err| format!("Failed to create temporary Codex home: {err}"))?;

    let account_id = id_token.and_then(extract_account_id_from_id_token);
    let auth_json = serde_json::json!({
        "OPENAI_API_KEY": serde_json::Value::Null,
        "tokens": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": id_token,
            "account_id": account_id,
        },
        "last_refresh": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
    });

    let auth_path = codex_home.join("auth.json");
    let auth_bytes = serde_json::to_vec_pretty(&auth_json)
        .map_err(|err| format!("Failed to serialize Codex auth file: {err}"))?;
    tokio::fs::write(&auth_path, auth_bytes)
        .await
        .map_err(|err| format!("Failed to write Codex auth file: {err}"))?;
    app_paths::set_sensitive_file_permissions(&auth_path)
        .map_err(|err| format!("Failed to secure Codex auth file: {err}"))?;

    Ok(codex_home)
}

async fn run_codex_rate_limits_rpc(codex_home: &PathBuf) -> Result<QuotaInfo, String> {
    let mut child = Command::new("codex");
    child
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .env("CODEX_HOME", codex_home)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    child.creation_flags(app_platform::CREATE_NO_WINDOW);

    let mut child = child
        .spawn()
        .map_err(|err| format!("Failed to start Codex app-server: {err}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout unavailable".to_string())?;
    let stderr = child.stderr.take();

    let stderr_task = stderr.map(|stream| {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stream).lines();
            let mut output = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                if output.len() < 20_000 {
                    output.push_str(&line);
                    output.push('\n');
                }
            }
            output
        })
    });

    let rpc = async {
        write_json_rpc_request(
            &mut stdin,
            1,
            "initialize",
            serde_json::json!({
                "clientInfo": { "name": "orgii", "version": "1.0.0" }
            }),
        )
        .await?;

        let mut reader = BufReader::new(stdout).lines();
        wait_for_rpc_id::<serde_json::Value>(&mut reader, 1).await?;

        write_json_rpc_notification(&mut stdin, "initialized", serde_json::json!({})).await?;
        write_json_rpc_request(
            &mut stdin,
            2,
            "account/rateLimits/read",
            serde_json::json!({}),
        )
        .await?;

        let payload = wait_for_rpc_id::<CodexRateLimitsResponse>(&mut reader, 2).await?;
        Ok::<QuotaInfo, String>(quota_from_codex_rate_limits_response(payload))
    };

    let mut result =
        match tokio::time::timeout(std::time::Duration::from_secs(APP_SERVER_TIMEOUT_SECS), rpc)
            .await
        {
            Ok(result) => result,
            Err(_) => Err("Codex app-server rate-limit request timed out".to_string()),
        };

    if let Err(err) = child.kill().await {
        log::debug!(
            "[CodexRateLimit] Failed to kill Codex app-server after quota fetch: {}",
            err
        );
    }
    let _ = child.wait().await;

    if let Some(task) = stderr_task {
        if let Ok(stderr_output) = task.await {
            if let Err(ref error_message) = result {
                if !stderr_output.trim().is_empty() {
                    result = Err(format!("{error_message}: {}", stderr_output.trim()));
                }
            }
        }
    }

    result
}

async fn write_json_rpc_request<T: Serialize>(
    stdin: &mut tokio::process::ChildStdin,
    id: u64,
    method: &str,
    params: T,
) -> Result<(), String> {
    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method,
        params,
    };
    write_json_line(stdin, &request).await
}

async fn write_json_rpc_notification<T: Serialize>(
    stdin: &mut tokio::process::ChildStdin,
    method: &str,
    params: T,
) -> Result<(), String> {
    let notification = JsonRpcNotification {
        jsonrpc: "2.0",
        method,
        params,
    };
    write_json_line(stdin, &notification).await
}

async fn write_json_line<T: Serialize>(
    stdin: &mut tokio::process::ChildStdin,
    value: &T,
) -> Result<(), String> {
    let mut line = serde_json::to_vec(value)
        .map_err(|err| format!("Failed to serialize Codex JSON-RPC message: {err}"))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|err| format!("Failed to write Codex JSON-RPC message: {err}"))
}

async fn wait_for_rpc_id<T: for<'de> Deserialize<'de>>(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: u64,
) -> Result<T, String> {
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|err| format!("Failed to read Codex JSON-RPC output: {err}"))?
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcResponse<T>>(trimmed) {
            Ok(response) => response,
            Err(_) => continue,
        };
        if response.id != Some(expected_id) {
            continue;
        }
        if let Some(error) = response.error {
            return Err(format!("Codex app-server RPC failed: {}", error.message));
        }
        return response
            .result
            .ok_or_else(|| "Codex app-server RPC response omitted result".to_string());
    }

    Err("Codex app-server exited before returning rate limits".to_string())
}

fn quota_from_codex_rate_limits_response(response: CodexRateLimitsResponse) -> QuotaInfo {
    let mut windows = Vec::new();
    if let Some(rate_limits) = response.rate_limits {
        if let Some(primary) = rate_limits.primary {
            if let Some(used_percent) = primary.used_percent {
                windows.push(QuotaWindow::session(
                    used_percent,
                    primary.resets_at.and_then(unix_seconds_to_rfc3339),
                ));
            }
        }
        if let Some(secondary) = rate_limits.secondary {
            if let Some(used_percent) = secondary.used_percent {
                windows.push(QuotaWindow::weekly(
                    used_percent,
                    secondary.resets_at.and_then(unix_seconds_to_rfc3339),
                ));
            }
        }
    }

    let mut quota = quota_from_windows("codex", "codex_app_server", windows);
    if let Some(reset_credits) = response.rate_limit_reset_credits {
        quota.named_message = Some(format_codex_reset_credits(reset_credits));
    }
    quota
}

fn format_codex_reset_credits(reset_credits: CodexRateLimitResetCredits) -> String {
    let available = reset_credits.available_count.unwrap_or(0);
    let total = reset_credits.total_earned_count.unwrap_or(available);
    let expiry = reset_credits.next_expires_at.and_then(|value| match value {
        serde_json::Value::Number(number) => number.as_i64().and_then(unix_seconds_to_rfc3339),
        serde_json::Value::String(value) => Some(value),
        _ => None,
    });

    match expiry {
        Some(expires_at) => {
            format!("Reset credits: {available}/{total}, next expires {expires_at}")
        }
        None => format!("Reset credits: {available}/{total}"),
    }
}

impl Default for CodexValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "../tests/codex_tests.rs"]
mod tests;

#[cfg(test)]
mod model_discovery_tests {
    use super::*;

    #[test]
    fn codex_usage_api_maps_primary_and_secondary_windows() {
        let payload = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": { "used_percent": 25.0, "reset_at": 1_783_418_400 },
                "secondary_window": { "used_percent": 60.0, "resets_at": 1_783_938_000 }
            }
        });

        let quota = quota_from_usage_json(&payload).expect("usage windows");

        assert_eq!(quota.plan_type.as_deref(), Some("plus"));
        assert_eq!(quota.quota_source.as_deref(), Some("codex_usage_api"));
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert!((quota.usage_items[0].remaining_percentage - 75.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-07-07T10:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert!((quota.usage_items[1].remaining_percentage - 40.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[1].reset_time.as_deref(),
            Some("2026-07-13T10:20:00Z")
        );
        assert!((quota.remaining_percentage - 40.0).abs() < 0.01);
    }

    #[test]
    fn codex_usage_api_rejects_missing_windows() {
        let payload = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": { "limit_reached": false }
        });
        assert!(quota_from_usage_json(&payload).is_none());
    }

    #[test]
    fn codex_usage_api_maps_five_hour_and_seven_day_windows() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "five_hour": { "utilization": 10.0, "resets_at": "2026-07-07T18:00:00+08:00" },
            "seven_day": { "utilization": 55.0, "resets_at": "2026-07-13T18:00:00+08:00" }
        });

        let quota = quota_from_usage_json(&payload).expect("usage windows");

        assert_eq!(quota.plan_type.as_deref(), Some("pro"));
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert!((quota.usage_items[0].remaining_percentage - 90.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[0].reset_time.as_deref(),
            Some("2026-07-07T10:00:00Z")
        );
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert!((quota.usage_items[1].remaining_percentage - 45.0).abs() < 0.01);
        assert_eq!(
            quota.usage_items[1].reset_time.as_deref(),
            Some("2026-07-13T10:00:00Z")
        );
    }

    #[test]
    fn codex_rate_limits_response_maps_windows_and_reset_credits() {
        let response = CodexRateLimitsResponse {
            rate_limits: Some(CodexRateLimitsPayload {
                primary: Some(CodexRateLimitWindow {
                    used_percent: Some(30.0),
                    resets_at: Some(1_783_418_400),
                }),
                secondary: Some(CodexRateLimitWindow {
                    used_percent: Some(65.0),
                    resets_at: Some(1_783_938_000),
                }),
            }),
            rate_limit_reset_credits: Some(CodexRateLimitResetCredits {
                available_count: Some(2),
                total_earned_count: Some(3),
                next_expires_at: Some(serde_json::json!(1_783_418_400)),
            }),
        };

        let quota = quota_from_codex_rate_limits_response(response);

        assert_eq!(quota.plan_type.as_deref(), Some("codex"));
        assert_eq!(quota.quota_source.as_deref(), Some("codex_app_server"));
        assert_eq!(quota.reset_time.as_deref(), Some("2026-07-07T10:00:00Z"));
        assert!((quota.remaining_percentage - 35.0).abs() < 0.01);
        assert_eq!(quota.usage_items.len(), 2);
        assert_eq!(
            quota.named_message.as_deref(),
            Some("Reset credits: 2/3, next expires 2026-07-07T10:00:00Z")
        );
    }

    #[test]
    fn codex_rate_limits_response_handles_missing_payload() {
        let quota = quota_from_codex_rate_limits_response(CodexRateLimitsResponse {
            rate_limits: None,
            rate_limit_reset_credits: None,
        });

        assert_eq!(quota.remaining_percentage, 100.0);
        assert!(quota.usage_items.is_empty());
    }

    #[test]
    fn codex_models_response_parses_filters_and_deduplicates() {
        let models = parse_codex_models_response(
            r#"{
                "models": [
                    { "slug": "gpt-5.5", "visibility": "list", "supported_in_api": true },
                    { "slug": "gpt-5.2-codex", "visibility": "list", "supported_in_api": true },
                    { "slug": "gpt-5.2-codex", "visibility": "list", "supported_in_api": true },
                    { "slug": "hidden-model", "visibility": "hidden", "supported_in_api": true },
                    { "slug": "unsupported", "visibility": "list", "supported_in_api": false },
                    { "slug": "" }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(
            models,
            vec!["gpt-5.5".to_string(), "gpt-5.2-codex".to_string()]
        );
    }

    #[test]
    fn codex_models_response_rejects_invalid_json() {
        let err = parse_codex_models_response("not json").unwrap_err();
        assert!(err.contains("parse failed"));
    }
}
