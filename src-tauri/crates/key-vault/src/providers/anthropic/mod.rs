//! Anthropic API Key Validation
//!
//! Validates Anthropic API keys and fetches available models.
//!
//! Supported token formats:
//! - `sk-ant-*` - Standard Anthropic API key
//! - `sk_*` - Alternative format
//!
//! Proxy support:
//! When a custom base_url is provided (proxy mode), the validator first tries
//! GET /v1/models to auto-detect models. If that fails (many proxies don't
//! implement /v1/models), it falls back to a lightweight POST /v1/messages
//! call using a `test_model` name (from the user's manual model mapping).
//! This validates the API key without requiring /v1/models support.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::types::{DiscoveredModel, ValidationResult};

const DEFAULT_API_URL: &str = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_SECS: u64 = 10;
const ANTHROPIC_VERSION: &str = "2023-06-01";
const CLAUDE_CODE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_CODE_OAUTH_USER_AGENT: &str = "claude-cli/2.1.78 (orgii, cli)";

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelInfo>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    last_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelInfo {
    id: String,
    /// Anthropic-compat proxies/aggregators expose the context window here;
    /// official Anthropic omits it.
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    max_input_tokens: Option<u64>,
    #[serde(default)]
    max_tokens: Option<u64>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Deserialize, Default)]
struct ModelCapabilities {
    #[serde(default)]
    effort: Option<EffortCapability>,
    #[serde(default)]
    thinking: Option<ThinkingCapability>,
}

#[derive(Debug, Deserialize, Default)]
struct CapabilitySupport {
    #[serde(default)]
    supported: bool,
}

#[derive(Debug, Deserialize, Default)]
struct EffortCapability {
    #[serde(default)]
    supported: bool,
    #[serde(default)]
    low: CapabilitySupport,
    #[serde(default)]
    medium: CapabilitySupport,
    #[serde(default)]
    high: CapabilitySupport,
    #[serde(default)]
    xhigh: CapabilitySupport,
    #[serde(default)]
    max: CapabilitySupport,
}

#[derive(Debug, Deserialize, Default)]
struct ThinkingCapability {
    #[serde(default)]
    supported: bool,
    #[serde(default)]
    types: ThinkingTypes,
}

#[derive(Debug, Deserialize, Default)]
struct ThinkingTypes {
    #[serde(default)]
    adaptive: CapabilitySupport,
    #[serde(default)]
    enabled: CapabilitySupport,
}

#[derive(Clone, Copy)]
enum ModelsAuth<'a> {
    ApiKey(&'a str),
    ClaudeCodeOauth(&'a str),
}

fn discovered_model_from_anthropic(model: ModelInfo) -> DiscoveredModel {
    let capabilities = model.capabilities.unwrap_or_default();
    let effort = capabilities.effort.unwrap_or_default();
    let thinking = capabilities.thinking.unwrap_or_default();
    let mut supported_efforts = Vec::new();
    if effort.supported {
        for (name, support) in [
            ("low", effort.low),
            ("medium", effort.medium),
            ("high", effort.high),
            ("xhigh", effort.xhigh),
            ("max", effort.max),
        ] {
            if support.supported {
                supported_efforts.push(name.to_string());
            }
        }
    }

    DiscoveredModel {
        id: model.id,
        display_name: model.display_name,
        context_window: model.max_input_tokens.or(model.context_length),
        max_output_tokens: model.max_tokens,
        supported_efforts,
        default_effort: effort.supported.then(|| "high".to_string()),
        supports_adaptive_thinking: thinking.supported && thinking.types.adaptive.supported,
        supports_manual_thinking: thinking.supported && thinking.types.enabled.supported,
        is_default: false,
    }
}

/// Minimal messages request for proxy fallback validation
#[derive(Debug, Serialize)]
struct MessagesRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
}

/// Anthropic credential validator
pub struct AnthropicValidator {
    client: Client,
    timeout: Duration,
}

impl AnthropicValidator {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }

    pub fn with_timeout(timeout_secs: u64) -> Self {
        Self {
            client: Client::new(),
            timeout: Duration::from_secs(timeout_secs),
        }
    }

    /// Validate an Anthropic API key
    ///
    /// # Arguments
    /// * `api_key` - The API key to validate
    /// * `base_url` - Optional custom base URL (for proxies)
    /// * `test_model` - Optional model name to test with (from user's manual model mapping).
    ///   Used as fallback when /v1/models is not supported by the proxy.
    pub async fn validate(
        &self,
        api_key: &str,
        base_url: Option<&str>,
        test_model: Option<&str>,
    ) -> ValidationResult {
        let key_preview = if api_key.len() > 12 {
            format!("{}...{}", &api_key[..8], &api_key[api_key.len() - 4..])
        } else {
            api_key.to_string()
        };
        debug!(
            "[Anthropic] Validating key: {}, base_url: {:?}, test_model: {:?}",
            key_preview,
            base_url.unwrap_or("(official)"),
            test_model.unwrap_or("(none)")
        );

        // Format validation
        if api_key.is_empty() {
            warn!("[Anthropic] Empty API key");
            return ValidationResult::failure("No API key provided");
        }

        // Skip format check if custom base_url is provided (proxy mode)
        if base_url.is_none() && !api_key.starts_with("sk-ant-") && !api_key.starts_with("sk_") {
            warn!("[Anthropic] Invalid key format: {}", key_preview);
            return ValidationResult::failure("Anthropic key should start with 'sk-ant-' or 'sk_'");
        }

        // Get available models — auth and model discovery are decoupled:
        // 401 = key invalid, other failures = key may work, user can add models manually.
        match self.get_models(api_key, base_url).await {
            Ok((models, contexts)) => {
                if models.is_empty() {
                    warn!("[Anthropic] No models returned for key: {}", key_preview);
                    let mut result = ValidationResult::success(
                        "API key valid (no models auto-detected — add models manually)",
                    );
                    result.is_degraded = true;
                    result
                } else if base_url.is_some() {
                    // Proxy mode: /v1/models may be public, verify auth with
                    // a lightweight /v1/messages call using the first model.
                    let probe_model = test_model.unwrap_or(&models[0]);
                    debug!(
                        "[Anthropic] Proxy mode — verifying auth via /v1/messages with model: {}",
                        probe_model
                    );
                    match self.test_messages(api_key, base_url, probe_model).await {
                        Ok(()) => {
                            info!(
                                "[Anthropic] ✅ Valid! {} models available: {:?}",
                                models.len(),
                                &models[..models.len().min(3)]
                            );
                            ValidationResult::success("API key valid")
                                .with_models(models)
                                .with_contexts(contexts)
                        }
                        Err(e) if e == "Invalid API key" => {
                            warn!("[Anthropic] Proxy auth verification failed: {}", e);
                            ValidationResult::failure("Invalid API key")
                        }
                        Err(_) => {
                            // Non-auth error — key might still work
                            info!(
                                "[Anthropic] Auth probe inconclusive, accepting with {} models",
                                models.len()
                            );
                            let mut result = ValidationResult::success("API key valid")
                                .with_models(models)
                                .with_contexts(contexts);
                            result.is_degraded = true;
                            result
                        }
                    }
                } else {
                    // Official API: /v1/models already validates auth
                    info!(
                        "[Anthropic] ✅ Valid! {} models available: {:?}",
                        models.len(),
                        &models[..models.len().min(3)]
                    );
                    ValidationResult::success("API key valid")
                        .with_models(models)
                        .with_contexts(contexts)
                }
            }
            Err(models_err) if models_err == "Invalid API key" => {
                warn!("[Anthropic] Auth failed: {}", models_err);
                ValidationResult::failure("Invalid API key")
            }
            Err(models_err) if models_err.starts_with("Request failed:") => {
                warn!("[Anthropic] Cannot reach endpoint: {}", models_err);
                ValidationResult::failure(&format!("Cannot reach endpoint: {}", models_err))
            }
            Err(models_err) => {
                // /v1/models returned non-401 error (404, 405, etc.)
                // Try messages fallback if we have proxy + test_model
                if base_url.is_some() {
                    if let Some(model) = test_model {
                        debug!(
                            "[Anthropic] /v1/models failed ({}), trying /v1/messages fallback with model: {}",
                            models_err, model
                        );
                        match self.test_messages(api_key, base_url, model).await {
                            Ok(()) => {
                                debug!(
                                    "[Anthropic] Messages fallback succeeded for key: {}",
                                    key_preview
                                );
                                ValidationResult::success("API key valid (proxy)")
                            }
                            Err(msg_err) if msg_err == "Invalid API key" => {
                                warn!("[Anthropic] Messages fallback auth failed: {}", msg_err);
                                ValidationResult::failure("Invalid API key")
                            }
                            Err(_msg_err) => {
                                // Messages also failed but not auth — key might still work
                                let mut result = ValidationResult::success(
                                    "API key accepted (model listing not available — add models manually)",
                                );
                                result.is_degraded = true;
                                result
                            }
                        }
                    } else {
                        // Proxy but no test_model — accept key, let user add models manually
                        debug!(
                            "[Anthropic] /v1/models failed on proxy ({}), accepting key as degraded",
                            models_err
                        );
                        let mut result = ValidationResult::success(
                            "API key accepted (model listing not available — add models manually)",
                        );
                        result.is_degraded = true;
                        result
                    }
                } else {
                    // Official API — non-auth error is unusual, still accept as degraded
                    warn!(
                        "[Anthropic] /v1/models failed ({}), accepting as degraded",
                        models_err
                    );
                    let mut result = ValidationResult::success(
                        "API key accepted (model listing not available — add models manually)",
                    );
                    result.is_degraded = true;
                    result
                }
            }
        }
    }

    /// Get list of Anthropic models from API
    async fn get_models(
        &self,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<(Vec<String>, HashMap<String, u64>), String> {
        let models = self
            .get_model_catalog(
                base_url.unwrap_or(DEFAULT_API_URL),
                ModelsAuth::ApiKey(api_key),
            )
            .await?;
        let mut ids: Vec<String> = Vec::with_capacity(models.len());
        let mut contexts: HashMap<String, u64> = HashMap::new();
        for m in models {
            if let Some(ctx) = m.context_window.filter(|ctx| *ctx > 0) {
                contexts.insert(m.id.clone(), ctx);
            }
            ids.push(m.id);
        }

        Ok((ids, contexts))
    }

    /// Fetch the account-visible Claude Code OAuth catalog with the same
    /// pagination and capability parsing used by API-key validation.
    pub async fn get_oauth_model_catalog(
        &self,
        access_token: &str,
    ) -> Result<Vec<DiscoveredModel>, String> {
        if access_token.trim().is_empty() {
            return Err("Claude Code OAuth access token is empty".to_string());
        }
        self.get_model_catalog(
            DEFAULT_API_URL,
            ModelsAuth::ClaudeCodeOauth(access_token.trim()),
        )
        .await
    }

    async fn get_model_catalog(
        &self,
        base_url: &str,
        auth: ModelsAuth<'_>,
    ) -> Result<Vec<DiscoveredModel>, String> {
        let endpoint = format!("{}/v1/models", base_url.trim_end_matches('/'));
        debug!("[Anthropic] Fetching models from: {}", endpoint);

        let mut after_id: Option<String> = None;
        let mut models: Vec<DiscoveredModel> = Vec::new();
        loop {
            let mut request = self
                .client
                .get(&endpoint)
                .query(&[("limit", "1000")])
                .header("anthropic-version", ANTHROPIC_VERSION)
                .timeout(self.timeout);
            if let Some(cursor) = after_id.as_deref() {
                request = request.query(&[("after_id", cursor)]);
            }
            request = match auth {
                ModelsAuth::ApiKey(api_key) => request.header("x-api-key", api_key),
                ModelsAuth::ClaudeCodeOauth(access_token) => request
                    .header("Authorization", format!("Bearer {access_token}"))
                    .header("anthropic-beta", CLAUDE_CODE_OAUTH_BETA)
                    .header("User-Agent", CLAUDE_CODE_OAUTH_USER_AGENT)
                    .header("x-app", "cli"),
            };

            let response = request
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err("Invalid Anthropic credential: HTTP 401".to_string());
            }
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status().as_u16()));
            }

            let page: ModelsResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {e}"))?;
            for model in page.data {
                if model.id.is_empty() || models.iter().any(|item| item.id == model.id) {
                    continue;
                }
                models.push(discovered_model_from_anthropic(model));
            }

            if !page.has_more {
                break;
            }
            let next = page
                .last_id
                .filter(|cursor| !cursor.is_empty())
                .ok_or_else(|| "Anthropic model pagination omitted last_id".to_string())?;
            if after_id.as_deref() == Some(next.as_str()) {
                return Err("Anthropic model pagination cursor did not advance".to_string());
            }
            after_id = Some(next);
        }

        Ok(models)
    }

    /// Test the API key by sending a minimal messages request.
    /// Used as fallback when /v1/models is not supported (common with proxies).
    /// Sends max_tokens=1 to minimize cost — we only care whether the key is accepted.
    pub async fn test_messages(
        &self,
        api_key: &str,
        base_url: Option<&str>,
        model: &str,
    ) -> Result<(), String> {
        let url = base_url.unwrap_or(DEFAULT_API_URL);
        let endpoint = format!("{}/v1/messages", url);
        debug!(
            "[Anthropic] Testing messages endpoint: {} with model: {}",
            endpoint, model
        );

        let body = MessagesRequest {
            model: model.to_string(),
            max_tokens: 1,
            messages: vec![Message {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
        };

        let response = self
            .client
            .post(&endpoint)
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();

        if status == 401 {
            return Err("Invalid API key".to_string());
        }

        // 200 = success, but also treat other "not auth failure" codes as partial success:
        // - 400 = bad request (model may be wrong, but key is valid)
        // - 429 = rate limited (key is valid, just throttled)
        // - 404 = model not found on this proxy (key may be valid)
        if status.is_success() || status.as_u16() == 429 {
            return Ok(());
        }

        // Read body for better error messages. A body-read failure
        // here is itself diagnostic — preserve it in the debug log
        // and the returned error so the user sees "HTTP 502 (body
        // read failed: ...)" instead of a bare "HTTP 502" with no
        // hint that the response body was unreachable.
        let body_text = match response.text().await {
            Ok(t) => t,
            Err(err) => format!("(body read failed: {})", err),
        };
        if !body_text.is_empty() {
            debug!("[Anthropic] Messages response body: {}", body_text);
        }

        Err(format!("HTTP {}", status.as_u16()))
    }

    /// Validate token format without making API calls
    pub fn validate_format(&self, api_key: &str) -> (bool, String) {
        if api_key.is_empty() {
            return (false, "API key is required".to_string());
        }

        if api_key.len() < 10 {
            return (false, "API key is too short".to_string());
        }

        if !api_key.starts_with("sk-ant-") && !api_key.starts_with("sk_") {
            return (
                false,
                "Anthropic key should start with 'sk-ant-' or 'sk_'".to_string(),
            );
        }

        (true, "Format OK".to_string())
    }
}

impl Default for AnthropicValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "../tests/anthropic_tests.rs"]
mod tests;
