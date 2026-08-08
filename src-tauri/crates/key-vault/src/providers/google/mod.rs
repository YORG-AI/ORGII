//! Google/Gemini API Key Validation
//!
//! Validates Google API keys for Gemini and fetches available models.
//!
//! Supports two modes:
//! - Native Google API (key starts with 'AI') - uses Google's API format
//! - Proxy mode (key starts with 'sk-') - uses OpenAI-compatible format

use log::{debug, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::types::ValidationResult;

const DEFAULT_API_URL: &str = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Deserialize)]
struct NativeModelsResponse {
    models: Vec<NativeModelInfo>,
}

#[derive(Debug, Deserialize)]
struct NativeModelInfo {
    name: String,
}

/// Proxy response format - supports both OpenAI format (data) and Gemini format (models)
#[derive(Debug, Deserialize)]
struct ProxyModelsResponse {
    #[serde(default)]
    data: Vec<ProxyModelInfo>,
    #[serde(default)]
    models: Vec<ProxyModelInfo>,
}

#[derive(Debug, Deserialize)]
struct ProxyModelInfo {
    id: String,
}

/// Minimal chat completion request for proxy auth verification.
#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

/// Google/Gemini credential validator
pub struct GoogleValidator {
    client: Client,
    timeout: Duration,
}

impl GoogleValidator {
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

    /// Validate a Google/Gemini API key.
    ///
    /// `test_model` is an optional model name (e.g. from user's manual input)
    /// used to verify auth when /v1/models is empty or unavailable.
    pub async fn validate(
        &self,
        api_key: &str,
        base_url: Option<&str>,
        test_model: Option<&str>,
    ) -> ValidationResult {
        info!(
            "[Google] Validating key (base_url={:?}, test_model={:?})",
            base_url, test_model
        );

        // Format validation
        if api_key.is_empty() {
            return ValidationResult::failure("No API key provided");
        }

        // Detect mode: proxy mode if base_url is provided OR key starts with sk-
        let is_proxy_mode = base_url.is_some() || api_key.starts_with("sk-");
        debug!(
            "[Google] Mode: {}",
            if is_proxy_mode { "proxy" } else { "native" }
        );

        // Skip format check in proxy mode (custom base_url provided)
        if !is_proxy_mode && !api_key.starts_with("AI") {
            return ValidationResult::failure(
                "Google/Gemini key should start with 'AI' (native) or provide a base URL for proxy mode",
            );
        }

        // Get available models
        let models_result = if is_proxy_mode {
            self.get_models_proxy(api_key, base_url.unwrap()).await
        } else {
            self.get_models_native(api_key, base_url).await
        };

        match models_result {
            Ok(models) => {
                info!("[Google] Models returned: {}", models.len());
                if models.is_empty() {
                    if let (Some(url), Some(model)) = (base_url, test_model) {
                        info!(
                            "[Google] No models — running completion test with model: {}",
                            model
                        );
                        match self.test_completion(api_key, url, model).await {
                            Ok(()) => {
                                info!("[Google] Completion test passed");
                                ValidationResult::success("API key valid (add models manually)")
                            }
                            Err(e) if e == "Invalid API key" => {
                                warn!("[Google] Completion test: invalid API key");
                                ValidationResult::failure("Invalid API key")
                            }
                            Err(e) => {
                                debug!("[Google] Completion test non-auth error: {}", e);
                                let mut result = ValidationResult::success(
                                    "API key accepted (model listing not available — add models manually)",
                                );
                                result.is_degraded = true;
                                result
                            }
                        }
                    } else {
                        info!("[Google] No models, no test_model — returning degraded");
                        let mut result = ValidationResult::success(
                            "API key valid (no models auto-detected — add models manually)",
                        );
                        result.is_degraded = true;
                        result
                    }
                } else if is_proxy_mode {
                    // Proxy mode: /v1/models may be public, verify auth with a
                    // lightweight completion call using the first discovered model.
                    let proxy_url = base_url.unwrap();
                    info!(
                        "[Google] Proxy mode — verifying auth via completion test with model: {}",
                        models[0]
                    );
                    match self.test_completion(api_key, proxy_url, &models[0]).await {
                        Ok(()) => {
                            info!("[Google] Proxy auth verified, {} models", models.len());
                            ValidationResult::success("API key valid").with_models(models)
                        }
                        Err(e) if e == "Invalid API key" => {
                            warn!("[Google] Proxy auth failed: invalid API key");
                            ValidationResult::failure("Invalid API key")
                        }
                        Err(e) => {
                            debug!("[Google] Proxy completion test non-auth error: {}", e);
                            let mut result =
                                ValidationResult::success("API key valid").with_models(models);
                            result.is_degraded = true;
                            result
                        }
                    }
                } else {
                    // Native mode: Google API validates auth via ?key= param
                    info!("[Google] Native mode — {} models", models.len());
                    ValidationResult::success("API key valid").with_models(models)
                }
            }
            Err(e) if e == "Invalid API key" => {
                warn!("[Google] Models fetch: invalid API key");
                ValidationResult::failure("Invalid API key")
            }
            Err(e) if e.starts_with("Request failed:") => {
                warn!("[Google] Models fetch unreachable: {}", e);
                ValidationResult::failure(&format!("Cannot reach endpoint: {}", e))
            }
            Err(ref _e) => {
                info!("[Google] Models fetch failed (non-auth): {}", _e);
                if let (Some(url), Some(model)) = (base_url, test_model) {
                    info!(
                        "[Google] Falling back to completion test with model: {}",
                        model
                    );
                    match self.test_completion(api_key, url, model).await {
                        Ok(()) => {
                            info!("[Google] Completion test passed");
                            ValidationResult::success("API key valid (model listing not available)")
                        }
                        Err(e) if e == "Invalid API key" => {
                            warn!("[Google] Completion test: invalid API key");
                            ValidationResult::failure("Invalid API key")
                        }
                        Err(_) => {
                            let mut result = ValidationResult::success(
                                "API key accepted (model listing not available — add models manually)",
                            );
                            result.is_degraded = true;
                            result
                        }
                    }
                } else {
                    let mut result = ValidationResult::success(
                        "API key accepted (model listing not available — add models manually)",
                    );
                    result.is_degraded = true;
                    result
                }
            }
        }
    }

    /// Get list of Google models from native API
    async fn get_models_native(
        &self,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let url = base_url.unwrap_or(DEFAULT_API_URL);
        let endpoint = format!("{}/v1beta/models", url);

        let response = self
            .client
            .get(&endpoint)
            .query(&[("key", api_key)])
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if response.status() == 400 || response.status() == 403 {
            return Err("Invalid API key".to_string());
        }

        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }

        let data: NativeModelsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        // Extract model names and filter to Gemini models
        let gemini_models: Vec<String> = data
            .models
            .into_iter()
            .map(|m| m.name.replace("models/", ""))
            .filter(|name| name.to_lowercase().contains("gemini"))
            .collect();

        Ok(gemini_models)
    }

    /// Get list of models from OpenAI-compatible proxy
    async fn get_models_proxy(&self, api_key: &str, base_url: &str) -> Result<Vec<String>, String> {
        let endpoint = format!("{}/v1/models", base_url);

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if response.status() == 401 {
            return Err("Invalid API key".to_string());
        }

        if response.status() == 404 {
            // /v1/models not supported, return defaults
            return Ok(vec![
                "gemini-2.0-flash".to_string(),
                "gemini-1.5-pro".to_string(),
                "gemini-1.5-flash".to_string(),
            ]);
        }

        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }

        let data: ProxyModelsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        // Support both OpenAI format (data) and Gemini format (models)
        let models: Vec<String> = if !data.data.is_empty() {
            data.data.into_iter().map(|m| m.id).collect()
        } else {
            data.models.into_iter().map(|m| m.id).collect()
        };

        if models.is_empty() {
            // Return defaults if no models returned
            Ok(vec![
                "gemini-2.0-flash".to_string(),
                "gemini-1.5-pro".to_string(),
            ])
        } else {
            Ok(models)
        }
    }

    /// Verify the API key on a proxy by sending a minimal chat completion request.
    /// Many proxies serve /v1/models publicly without auth.
    /// Sends max_tokens=1 to minimize cost.
    async fn test_completion(
        &self,
        api_key: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), String> {
        let url = base_url.trim_end_matches('/');
        let endpoint = if url.ends_with("/v1") {
            format!("{}/chat/completions", url)
        } else {
            format!("{}/v1/chat/completions", url)
        };

        let body = ChatCompletionRequest {
            model: model.to_string(),
            max_tokens: 1,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
        };

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Invalid API key".to_string());
        }

        if status.is_success() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(());
        }

        Err(format!("HTTP {}", status.as_u16()))
    }

    /// Validate token format without making API calls
    /// Note: Format validation is relaxed - any non-empty key is accepted
    /// since proxy APIs may use different key formats
    pub fn validate_format(&self, api_key: &str) -> (bool, String) {
        if api_key.is_empty() {
            return (false, "API key is required".to_string());
        }

        if api_key.len() < 10 {
            return (false, "API key is too short".to_string());
        }

        // Accept any key format - proxy APIs may use different formats
        // The actual validation happens when we call the API

        (true, "Format OK".to_string())
    }
}

impl Default for GoogleValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "../tests/google_tests.rs"]
mod tests;
