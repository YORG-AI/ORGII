//! Codex CLI credential validation.
//!
//! Validates Codex credentials supporting:
//! - OAuth authentication (ChatGPT Plus/Pro subscription via chatgpt.com)
//! - API key authentication (OpenAI API key via api.openai.com)
//! - Quota fetching from ChatGPT usage API

use crate::providers::openai::OpenAIValidator;
use crate::providers::quota_windows::{quota_from_windows, unix_seconds_to_rfc3339, QuotaWindow};
use crate::types::{DiscoveredModel, QuotaInfo, ValidationResult};
use integrations::cli_binary_resolver::{resolve_cli_binary_command, CliBinaryId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

/// ChatGPT usage API endpoint
const USAGE_API_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_MODELS_API_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const CODEX_MODELS_CLIENT_VERSION: &str = "0.124.0";
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.124.0 (orgii, cli)";
const APP_SERVER_TIMEOUT_SECS: u64 = 10;
const APP_SERVER_SHUTDOWN_TIMEOUT_SECS: u64 = 2;

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
struct CodexModelListResponse {
    #[serde(default)]
    data: Vec<CodexAppServerModelInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerModelInfo {
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    default_reasoning_effort: Option<String>,
    #[serde(default)]
    supported_reasoning_efforts: Vec<CodexReasoningEffortInfo>,
    #[serde(default)]
    is_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexReasoningEffortInfo {
    reasoning_effort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindow {
    used_percent: Option<f64>,
    window_duration_mins: Option<i64>,
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

fn parse_usage_window_duration_minutes(window: &serde_json::Value) -> Option<i64> {
    window
        .get("window_duration_mins")
        .or_else(|| window.get("windowDurationMins"))
        .or_else(|| window.get("window_minutes"))
        .or_else(|| window.get("windowMinutes"))
        .and_then(|value| value.as_i64())
        .filter(|minutes| *minutes > 0)
        .or_else(|| {
            window
                .get("limit_window_seconds")
                .or_else(|| window.get("limitWindowSeconds"))
                .and_then(|value| value.as_i64())
                .filter(|seconds| *seconds > 0)
                .map(|seconds| seconds.saturating_add(59) / 60)
        })
}

fn codex_quota_window(
    used_percent: f64,
    reset_time: Option<String>,
    window_duration_mins: Option<i64>,
    fallback: fn(f64, Option<String>) -> QuotaWindow,
) -> QuotaWindow {
    match window_duration_mins {
        // Codex currently reports a 300-minute session window and a
        // 10,080-minute weekly window. Classify by the supplied duration so a
        // temporarily absent 5-hour limit cannot relabel the weekly window.
        Some(minutes) if minutes >= 24 * 60 => QuotaWindow::weekly(used_percent, reset_time),
        Some(_) => QuotaWindow::session(used_percent, reset_time),
        None => fallback(used_percent, reset_time),
    }
}

fn push_usage_window(
    windows: &mut Vec<QuotaWindow>,
    fallback_usage_type: fn(f64, Option<String>) -> QuotaWindow,
    window: Option<&serde_json::Value>,
) {
    if let Some(window) = window {
        if let Some(used_percent) = parse_usage_window_percent(window) {
            windows.push(codex_quota_window(
                used_percent,
                parse_usage_window_reset(window),
                parse_usage_window_duration_minutes(window),
                fallback_usage_type,
            ));
        }
    }
}

fn quota_from_usage_json(data: &serde_json::Value) -> Option<QuotaInfo> {
    let rate_limit = data
        .get("rate_limit")
        .or_else(|| data.get("rate_limits"))
        .unwrap_or(data);
    let mut windows = Vec::new();

    let primary_window = rate_limit
        .get("primary_window")
        .or_else(|| rate_limit.get("primary"));
    let five_hour_window = rate_limit
        .get("five_hour")
        .or_else(|| data.get("five_hour"));
    let weekly_window = rate_limit
        .get("secondary_window")
        .or_else(|| rate_limit.get("secondary"))
        .or_else(|| rate_limit.get("seven_day"))
        .or_else(|| data.get("seven_day"));

    if primary_window.is_some() {
        // Older payloads did not include the window duration. When OpenAI
        // returns only a generic primary window, it is the surviving weekly
        // limit; when a secondary window is also present, primary is the 5h
        // limit. Explicit duration metadata always wins in codex_quota_window.
        let fallback: fn(f64, Option<String>) -> QuotaWindow = if weekly_window.is_some() {
            QuotaWindow::session
        } else {
            QuotaWindow::weekly
        };
        push_usage_window(&mut windows, fallback, primary_window);
    } else {
        push_usage_window(&mut windows, QuotaWindow::session, five_hour_window);
    }
    push_usage_window(&mut windows, QuotaWindow::weekly, weekly_window);

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

fn discovered_models_from_app_server(response: CodexModelListResponse) -> Vec<DiscoveredModel> {
    let mut models = Vec::new();
    for model in response.data {
        if model.hidden {
            continue;
        }
        let id = model.model.filter(|id| !id.is_empty()).unwrap_or(model.id);
        if id.is_empty() || models.iter().any(|item: &DiscoveredModel| item.id == id) {
            continue;
        }
        let mut supported_efforts = Vec::new();
        for effort in model.supported_reasoning_efforts {
            if !effort.reasoning_effort.is_empty()
                && !supported_efforts.contains(&effort.reasoning_effort)
            {
                supported_efforts.push(effort.reasoning_effort);
            }
        }
        models.push(DiscoveredModel {
            id,
            display_name: model.display_name,
            supported_efforts,
            default_effort: model.default_reasoning_effort,
            is_default: model.is_default,
            ..DiscoveredModel::default()
        });
    }
    models
}

async fn write_temporary_codex_home(
    access_token: &str,
    refresh_token: Option<&str>,
    id_token: Option<&str>,
) -> Result<PathBuf, String> {
    let codex_home =
        std::env::temp_dir().join(format!("orgii-codex-app-server-{}", uuid::Uuid::new_v4()));
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

async fn cleanup_temporary_codex_home(codex_home: &PathBuf, operation: &str) {
    if let Err(err) = tokio::fs::remove_dir_all(codex_home).await {
        log::warn!(
            "[CodexAppServer] Failed to remove temporary Codex home after {} ({}): {}",
            operation,
            codex_home.display(),
            err
        );
    }
}

async fn run_codex_rate_limits_rpc(codex_home: &PathBuf) -> Result<QuotaInfo, String> {
    let payload: CodexRateLimitsResponse = run_codex_app_server_rpc(
        codex_home,
        "account/rateLimits/read",
        serde_json::json!({}),
        "rate-limit request",
    )
    .await?;
    Ok(quota_from_codex_rate_limits_response(payload))
}

async fn run_codex_model_list_rpc(codex_home: &PathBuf) -> Result<Vec<DiscoveredModel>, String> {
    let payload: CodexModelListResponse = run_codex_app_server_rpc(
        codex_home,
        "model/list",
        serde_json::json!({ "limit": 1000, "includeHidden": false }),
        "model-list request",
    )
    .await?;
    Ok(discovered_models_from_app_server(payload))
}

async fn run_codex_app_server_rpc<T: DeserializeOwned>(
    codex_home: &PathBuf,
    method: &str,
    params: serde_json::Value,
    operation: &str,
) -> Result<T, String> {
    let codex_binary = resolve_cli_binary_command(CliBinaryId::Codex);
    let mut child = Command::new(&codex_binary);
    child
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .env("CODEX_HOME", codex_home)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // npm's `codex` entry point launches the native binary as a descendant.
    // Isolate the wrapper tree so timeout cleanup cannot orphan the native
    // app-server with our stdout/stderr handles still open.
    #[cfg(unix)]
    child.process_group(0);

    #[cfg(windows)]
    child.creation_flags(app_platform::CREATE_NO_WINDOW);

    let mut child = child
        .spawn()
        .map_err(|err| format!("Failed to start Codex app-server via {codex_binary}: {err}"))?;
    let child_pid = child.id();

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
        write_json_rpc_request(&mut stdin, 2, method, params).await?;
        wait_for_rpc_id::<T>(&mut reader, 2).await
    };

    let mut result =
        match tokio::time::timeout(std::time::Duration::from_secs(APP_SERVER_TIMEOUT_SECS), rpc)
            .await
        {
            Ok(result) => result,
            Err(_) => Err(format!("Codex app-server {operation} timed out")),
        };

    drop(stdin);
    terminate_codex_app_server_tree(&mut child, child_pid, operation).await;

    if let Some(mut task) = stderr_task {
        match tokio::time::timeout(
            std::time::Duration::from_secs(APP_SERVER_SHUTDOWN_TIMEOUT_SECS),
            &mut task,
        )
        .await
        {
            Ok(Ok(stderr_output)) => {
                if let Err(ref error_message) = result {
                    if !stderr_output.trim().is_empty() {
                        result = Err(format!("{error_message}: {}", stderr_output.trim()));
                    }
                }
            }
            Ok(Err(err)) => log::debug!(
                "[CodexAppServer] stderr reader failed after {}: {}",
                operation,
                err
            ),
            Err(_) => {
                task.abort();
                log::warn!(
                    "[CodexAppServer] stderr pipe did not close after {}; reader aborted",
                    operation
                );
            }
        }
    }

    result
}

async fn terminate_codex_app_server_tree(
    child: &mut Child,
    child_pid: Option<u32>,
    operation: &str,
) {
    #[cfg(unix)]
    if let Some(pid) = child_pid {
        // SAFETY: this child was spawned as the leader of a dedicated process
        // group. Sending SIGKILL does not touch Rust-managed memory.
        let status = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        if status != 0 {
            log::debug!(
                "[CodexAppServer] Failed to kill process group after {}: {}",
                operation,
                std::io::Error::last_os_error()
            );
        }
    }

    #[cfg(windows)]
    if let Some(pid) = child_pid {
        // The npm `cmd.exe` shim can exit before cleanup while node.exe and the
        // native Codex binary keep its pipe handles open. A Toolhelp snapshot
        // retains their original parent PIDs, so it can still find that orphaned
        // tree after the wrapper is gone; `taskkill /T` cannot.
        match tokio::time::timeout(
            std::time::Duration::from_secs(APP_SERVER_SHUTDOWN_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || terminate_windows_process_tree(pid)),
        )
        .await
        {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(err))) => log::warn!(
                "[CodexAppServer] Failed to terminate Windows process tree after {}: {}",
                operation,
                err
            ),
            Ok(Err(err)) => log::warn!(
                "[CodexAppServer] Windows process cleanup task failed after {}: {}",
                operation,
                err
            ),
            Err(_) => log::warn!(
                "[CodexAppServer] Windows process cleanup timed out after {}",
                operation
            ),
        }
    }

    if let Err(err) = child.start_kill() {
        log::debug!(
            "[CodexAppServer] Direct child already stopped after {}: {}",
            operation,
            err
        );
    }
    if tokio::time::timeout(
        std::time::Duration::from_secs(APP_SERVER_SHUTDOWN_TIMEOUT_SECS),
        child.wait(),
    )
    .await
    .is_err()
    {
        log::warn!(
            "[CodexAppServer] Direct child did not exit after {} within {}s",
            operation,
            APP_SERVER_SHUTDOWN_TIMEOUT_SECS
        );
    }
}

#[cfg(windows)]
fn terminate_windows_process_tree(root_pid: u32) -> Result<(), String> {
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    const MAX_SNAPSHOT_PROCESSES: usize = 8_192;
    const MAX_TREE_PROCESSES: usize = 32;

    // SAFETY: the returned snapshot handle is checked and closed on every path.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "CreateToolhelp32Snapshot failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut processes = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` has the required size and remains valid while the snapshot
    // is enumerated.
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while has_entry {
        if processes.len() >= MAX_SNAPSHOT_PROCESSES {
            // SAFETY: `snapshot` is a valid handle owned by this function.
            unsafe { CloseHandle(snapshot) };
            return Err(format!(
                "process snapshot exceeded {MAX_SNAPSHOT_PROCESSES} entries"
            ));
        }
        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: same initialized entry and valid snapshot as above.
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: `snapshot` is a valid handle owned by this function.
    unsafe { CloseHandle(snapshot) };

    // Seed the traversal with the captured wrapper PID even when the wrapper has
    // already exited and is absent from the snapshot.
    let mut known = HashSet::from([root_pid]);
    let mut frontier = HashSet::from([root_pid]);
    let mut descendants = Vec::new();
    let mut depth = 0usize;
    while !frontier.is_empty() {
        let mut next_frontier = HashSet::new();
        for &(pid, parent_pid) in &processes {
            if frontier.contains(&parent_pid) && known.insert(pid) {
                if descendants.len() >= MAX_TREE_PROCESSES {
                    return Err(format!(
                        "process tree rooted at {root_pid} exceeded {MAX_TREE_PROCESSES} entries"
                    ));
                }
                descendants.push((pid, depth + 1));
                next_frontier.insert(pid);
            }
        }
        frontier = next_frontier;
        depth += 1;
    }

    descendants.sort_unstable_by_key(|&(_, process_depth)| std::cmp::Reverse(process_depth));
    for (pid, _) in descendants {
        // SAFETY: the handle is checked before use and closed after termination.
        let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            continue;
        }
        // The process may exit between snapshot enumeration and this call. That
        // is already the desired state, so termination failures are non-fatal.
        unsafe {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }

    Ok(())
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

    Err("Codex app-server exited before returning the requested response".to_string())
}

fn quota_from_codex_rate_limits_response(response: CodexRateLimitsResponse) -> QuotaInfo {
    let mut windows = Vec::new();
    if let Some(rate_limits) = response.rate_limits {
        let primary_fallback: fn(f64, Option<String>) -> QuotaWindow =
            if rate_limits.secondary.is_some() {
                QuotaWindow::session
            } else {
                QuotaWindow::weekly
            };
        if let Some(primary) = rate_limits.primary {
            if let Some(used_percent) = primary.used_percent {
                windows.push(codex_quota_window(
                    used_percent,
                    primary.resets_at.and_then(unix_seconds_to_rfc3339),
                    primary.window_duration_mins,
                    primary_fallback,
                ));
            }
        }
        if let Some(secondary) = rate_limits.secondary {
            if let Some(used_percent) = secondary.used_percent {
                windows.push(codex_quota_window(
                    used_percent,
                    secondary.resets_at.and_then(unix_seconds_to_rfc3339),
                    secondary.window_duration_mins,
                    QuotaWindow::weekly,
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
                    window_duration_mins: Some(300),
                    resets_at: Some(1_783_418_400),
                }),
                secondary: Some(CodexRateLimitWindow {
                    used_percent: Some(65.0),
                    window_duration_mins: Some(10_080),
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
        assert_eq!(quota.usage_items[0].usage_type, "session");
        assert_eq!(quota.usage_items[1].usage_type, "weekly");
        assert_eq!(
            quota.named_message.as_deref(),
            Some("Reset credits: 2/3, next expires 2026-07-07T10:00:00Z")
        );
    }

    #[test]
    fn codex_rate_limits_response_classifies_lone_weekly_primary_by_duration() {
        let quota = quota_from_codex_rate_limits_response(CodexRateLimitsResponse {
            rate_limits: Some(CodexRateLimitsPayload {
                primary: Some(CodexRateLimitWindow {
                    used_percent: Some(44.0),
                    window_duration_mins: Some(10_080),
                    resets_at: Some(1_783_938_000),
                }),
                secondary: None,
            }),
            rate_limit_reset_credits: None,
        });

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
        assert!((quota.usage_items[0].remaining_percentage - 56.0).abs() < 0.01);
    }

    #[test]
    fn codex_usage_api_classifies_primary_window_by_duration() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 44.0,
                    "window_duration_mins": 10_080,
                    "reset_at": 1_783_938_000
                }
            }
        });

        let quota = quota_from_usage_json(&payload).expect("weekly window");

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
        assert!((quota.usage_items[0].remaining_percentage - 56.0).abs() < 0.01);
    }

    #[test]
    fn codex_usage_api_treats_legacy_lone_primary_as_weekly() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 44.0,
                    "reset_at": 1_783_938_000
                }
            }
        });

        let quota = quota_from_usage_json(&payload).expect("weekly window");

        assert_eq!(quota.usage_items.len(), 1);
        assert_eq!(quota.usage_items[0].usage_type, "weekly");
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

    #[test]
    fn app_server_models_preserve_efforts_defaults_and_visibility() {
        let response: CodexModelListResponse = serde_json::from_value(serde_json::json!({
            "data": [
                {
                    "id": "gpt-5.6-sol",
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6 Sol",
                    "defaultReasoningEffort": "high",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low" },
                        { "reasoningEffort": "high" },
                        { "reasoningEffort": "max" }
                    ],
                    "isDefault": true
                },
                {
                    "id": "hidden-model",
                    "hidden": true
                }
            ]
        }))
        .expect("Codex model/list response");

        let models = discovered_models_from_app_server(response);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.6-sol");
        assert_eq!(models[0].display_name.as_deref(), Some("GPT-5.6 Sol"));
        assert_eq!(models[0].default_effort.as_deref(), Some("high"));
        assert_eq!(models[0].supported_efforts, vec!["low", "high", "max"]);
        assert!(models[0].is_default);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn app_server_shutdown_terminates_wrapper_descendants() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 60 & helper=$!; echo $helper; wait"])
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn wrapper process");
        let child_pid = child.id();
        let stdout = child.stdout.take().expect("wrapper stdout");
        let mut reader = BufReader::new(stdout).lines();
        let helper_pid: i32 = reader
            .next_line()
            .await
            .expect("read helper pid")
            .expect("helper pid line")
            .trim()
            .parse()
            .expect("numeric helper pid");

        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            terminate_codex_app_server_tree(&mut child, child_pid, "test shutdown"),
        )
        .await
        .expect("bounded wrapper shutdown");

        let mut helper_alive = true;
        for _ in 0..20 {
            // SAFETY: signal 0 performs an existence check only.
            helper_alive = unsafe { libc::kill(helper_pid, 0) == 0 };
            if !helper_alive {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(!helper_alive, "descendant process {helper_pid} survived");
    }

    #[cfg(windows)]
    async fn windows_process_is_alive(pid: u32) -> bool {
        let script = format!(
            "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(app_platform::CREATE_NO_WINDOW);
        command
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn app_server_shutdown_terminates_windows_wrapper_descendants() {
        let script = r#"
$pingPath = Join-Path $env:SystemRoot 'System32\ping.exe'
$descendant = Start-Process -FilePath $pingPath -ArgumentList '-t','127.0.0.1' -NoNewWindow -PassThru
[Console]::Out.WriteLine($descendant.Id)
[Console]::Out.Flush()
"#;
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(app_platform::CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn Windows wrapper process");
        let child_pid = child.id();
        let stdout = child.stdout.take().expect("wrapper stdout");
        let mut reader = BufReader::new(stdout).lines();
        let descendant_pid: u32 = reader
            .next_line()
            .await
            .expect("read descendant pid")
            .expect("descendant pid line")
            .trim()
            .parse()
            .expect("numeric descendant pid");
        assert!(windows_process_is_alive(descendant_pid).await);

        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("wrapper wait stayed bounded")
            .expect("wrapper exited");
        assert!(
            windows_process_is_alive(descendant_pid).await,
            "test requires the descendant to outlive its wrapper"
        );

        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            terminate_codex_app_server_tree(&mut child, child_pid, "test shutdown"),
        )
        .await
        .expect("bounded Windows wrapper shutdown");

        let mut descendant_alive = true;
        for _ in 0..20 {
            descendant_alive = windows_process_is_alive(descendant_pid).await;
            if !descendant_alive {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if descendant_alive {
            let _ = Command::new("taskkill")
                .args(["/PID", &descendant_pid.to_string(), "/T", "/F"])
                .creation_flags(app_platform::CREATE_NO_WINDOW)
                .output()
                .await;
        }
        assert!(
            !descendant_alive,
            "descendant process {descendant_pid} survived"
        );
    }
}
