//! OpenAI API Key Validation
//!
//! Validates OpenAI API keys and fetches available models.
//!
//! Supported token formats:
//! - `sk-*` - Standard OpenAI API key
//! - `sk-proj-*` - Workspace-scoped API key

use log::{debug, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::types::ValidationResult;

const DEFAULT_API_URL: &str = "https://api.openai.com";
const DEFAULT_TIMEOUT_SECS: u64 = 15;

// Per-provider model prefixes to filter out fine-tuned / irrelevant models.
const OPENAI_MODEL_PREFIXES: &[&str] = &["gpt-4", "gpt-5", "codex", "o1", "o3", "o4"];
const DEEPSEEK_MODEL_PREFIXES: &[&str] = &["deepseek"];
const GROQ_MODEL_PREFIXES: &[&str] = &["llama", "mixtral", "gemma", "qwen", "deepseek", "mistral"];

/// Return the model-name filter for a given provider, or None to accept all models.
fn model_prefixes_for_provider(provider: Option<&str>) -> Option<&'static [&'static str]> {
    match provider {
        Some("deepseek_api") => Some(DEEPSEEK_MODEL_PREFIXES),
        Some("groq_api") => Some(GROQ_MODEL_PREFIXES),
        Some("openai_api") | None => Some(OPENAI_MODEL_PREFIXES),
        // Other OpenAI-compatible providers: accept all models from their API
        Some(_) => None,
    }
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelInfo>,
}

#[derive(Debug, Deserialize)]
struct ModelInfo {
    id: String,
    /// OpenAI-compat aggregators/proxies (openrouter, zenmux, …) expose the
    /// model's context window here; official OpenAI omits it. `#[serde(default)]`
    /// keeps deserialization working for both.
    #[serde(default)]
    context_length: Option<u64>,
}

/// Minimal chat completion request for auth verification.
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

/// OpenAI credential validator
pub struct OpenAIValidator {
    client: Client,
    timeout: Duration,
}

impl OpenAIValidator {
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

    /// Validate an OpenAI-compatible API key.
    ///
    /// `provider` is the credential type (e.g. `"openai_api"`, `"deepseek_api"`)
    /// and controls which model-name prefixes are accepted.
    ///
    /// `test_model` is an optional model name (e.g. from user's manual input)
    /// used to verify auth when /v1/models is empty or unavailable.
    ///
    /// Auth and model discovery are decoupled: a 401 means the key is invalid,
    /// but other failures (404, empty list, parse error) still count as
    /// `valid=true` with `is_degraded=true` so the user can add models manually.
    pub async fn validate(
        &self,
        api_key: &str,
        base_url: Option<&str>,
        provider: Option<&str>,
        test_model: Option<&str>,
    ) -> ValidationResult {
        info!(
            "[OpenAI] Validating key (provider={:?}, base_url={:?}, test_model={:?})",
            provider, base_url, test_model
        );

        if api_key.is_empty() {
            return ValidationResult::failure("No API key provided");
        }

        // Skip format check if custom base_url is provided (proxy mode)
        if base_url.is_none() && !api_key.starts_with("sk-") {
            return ValidationResult::failure("OpenAI key should start with 'sk-'");
        }

        match self.get_models(api_key, base_url, provider).await {
            Ok((models, contexts)) => {
                info!("[OpenAI] /v1/models returned {} models", models.len());
                if models.is_empty() {
                    // No models detected — try test_model for auth verification if available
                    if let (Some(url), Some(model)) = (base_url, test_model) {
                        info!(
                            "[OpenAI] No models — running completion test with model: {}",
                            model
                        );
                        match self.test_completion(api_key, url, model).await {
                            Ok(()) => {
                                info!("[OpenAI] Completion test passed");
                                ValidationResult::success("API key valid (add models manually)")
                            }
                            Err(e) if e == "Invalid API key" => {
                                warn!("[OpenAI] Completion test: invalid API key");
                                ValidationResult::failure("Invalid API key")
                            }
                            Err(e) => {
                                debug!("[OpenAI] Completion test non-auth error: {}", e);
                                let mut result = ValidationResult::success(
                                    "API key accepted (model listing not available — add models manually)",
                                );
                                result.is_degraded = true;
                                result
                            }
                        }
                    } else {
                        info!("[OpenAI] No models, no test_model — returning degraded");
                        let mut result = ValidationResult::success(
                            "API key valid (no models auto-detected — add models manually)",
                        );
                        result.is_degraded = true;
                        result
                    }
                } else if let Some(url) = base_url {
                    // Proxy mode: /v1/models may be public, verify auth with a
                    // lightweight completion call using the first discovered model.
                    info!(
                        "[OpenAI] Proxy mode — verifying auth via completion test with model: {}",
                        models[0]
                    );
                    match self.test_completion(api_key, url, &models[0]).await {
                        Ok(()) => {
                            info!("[OpenAI] Proxy auth verified, {} models", models.len());
                            ValidationResult::success("API key valid")
                                .with_models(models)
                                .with_contexts(contexts)
                        }
                        Err(e) if e == "Invalid API key" => {
                            warn!("[OpenAI] Proxy auth failed: invalid API key");
                            ValidationResult::failure("Invalid API key")
                        }
                        Err(e) => {
                            debug!("[OpenAI] Proxy completion test non-auth error: {}", e);
                            let mut result = ValidationResult::success("API key valid")
                                .with_models(models)
                                .with_contexts(contexts);
                            result.is_degraded = true;
                            result
                        }
                    }
                } else {
                    // Official API: /v1/models already validates auth
                    info!("[OpenAI] Official API — {} models", models.len());
                    ValidationResult::success("API key valid")
                        .with_models(models)
                        .with_contexts(contexts)
                }
            }
            Err(e) if e == "Invalid API key" => {
                warn!("[OpenAI] /v1/models: invalid API key");
                ValidationResult::failure("Invalid API key")
            }
            Err(e) if e.starts_with("Request failed:") => {
                warn!("[OpenAI] /v1/models unreachable: {}", e);
                ValidationResult::failure(&format!("Cannot reach endpoint: {}", e))
            }
            Err(ref _e) => {
                info!("[OpenAI] /v1/models failed (non-auth): {}", _e);
                // /v1/models failed with non-auth error — try test_model if available
                if let (Some(url), Some(model)) = (base_url, test_model) {
                    info!(
                        "[OpenAI] Falling back to completion test with model: {}",
                        model
                    );
                    match self.test_completion(api_key, url, model).await {
                        Ok(()) => {
                            info!("[OpenAI] Completion test passed");
                            ValidationResult::success("API key valid (model listing not available)")
                        }
                        Err(e) if e == "Invalid API key" => {
                            warn!("[OpenAI] Completion test: invalid API key");
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

    /// Fetch and filter models from an OpenAI-compatible `/v1/models` endpoint.
    /// If base_url already ends with `/v1`, append `/models` only to avoid doubling the path.
    /// When a custom base_url is provided (proxy/gateway), skip provider-specific filtering
    /// since the proxy may serve models from multiple providers.
    ///
    /// Returns the model ids alongside any `context_length` the endpoint exposed
    /// (empty map when the endpoint only returns ids, e.g. official OpenAI).
    async fn get_models(
        &self,
        api_key: &str,
        base_url: Option<&str>,
        provider: Option<&str>,
    ) -> Result<(Vec<String>, HashMap<String, u64>), String> {
        let url = base_url.unwrap_or(DEFAULT_API_URL).trim_end_matches('/');
        // Support both /v1 (OpenAI standard) and /v4 (Zhipu API)
        let endpoint = if url.ends_with("/v1") || url.ends_with("/v4") {
            format!("{}/models", url)
        } else {
            format!("{}/v1/models", url)
        };

        debug!("[OpenAI] Fetching models from: {}", endpoint);

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        debug!("[OpenAI] /v1/models response status: {}", response.status());

        if response.status() == 401 {
            return Err("Invalid API key".to_string());
        }

        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }

        let data: ModelsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let models = data.data;
        let mut all_ids: Vec<String> = Vec::with_capacity(models.len());
        let mut contexts: HashMap<String, u64> = HashMap::new();
        for m in models {
            if let Some(ctx) = m.context_length.filter(|ctx| *ctx > 0) {
                contexts.insert(m.id.clone(), ctx);
            }
            all_ids.push(m.id);
        }

        let has_custom_url = base_url.is_some();
        let (useful_ids, useful_contexts) = if has_custom_url {
            (all_ids, contexts)
        } else {
            match model_prefixes_for_provider(provider) {
                Some(prefixes) => {
                    let kept: std::collections::HashSet<String> = all_ids
                        .iter()
                        .filter(|id| {
                            let id_lower = id.to_lowercase();
                            prefixes.iter().any(|prefix| id_lower.contains(prefix))
                        })
                        .cloned()
                        .collect();
                    let filtered_contexts = contexts
                        .into_iter()
                        .filter(|(id, _)| kept.contains(id))
                        .collect();
                    let filtered_ids = all_ids.into_iter().filter(|id| kept.contains(id)).collect();
                    (filtered_ids, filtered_contexts)
                }
                None => (all_ids, contexts),
            }
        };

        Ok((useful_ids, useful_contexts))
    }

    /// Verify the API key by sending a minimal chat completion request.
    /// Many proxies serve /v1/models publicly without auth, so this is the
    /// only reliable way to check whether the key is actually accepted.
    /// Sends max_tokens=1 to minimize cost.
    pub async fn test_completion(
        &self,
        api_key: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), String> {
        let url = base_url.trim_end_matches('/');
        // Support both /v1 (OpenAI standard) and /v4 (Zhipu API)
        let endpoint = if url.ends_with("/v1") || url.ends_with("/v4") {
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

        debug!("[OpenAI] Sending completion test to: {}", endpoint);

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
        debug!("[OpenAI] Completion test response status: {}", status);

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Invalid API key".to_string());
        }

        // 200 = success, 429 = rate-limited (key is valid, just throttled)
        if status.is_success() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(());
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

        if !api_key.starts_with("sk-") {
            return (false, "OpenAI key should start with 'sk-'".to_string());
        }

        (true, "Format OK".to_string())
    }
}

impl Default for OpenAIValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "../tests/openai_tests.rs"]
mod tests;
