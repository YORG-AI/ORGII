use serde::Deserialize;

use crate::types::ValidationResult;

#[derive(Debug, Deserialize)]
struct OpenCodeModelsResponse {
    #[serde(default)]
    data: Vec<OpenCodeModelInfo>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeModelInfo {
    id: String,
}

pub const OPENCODE_ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
pub const OPENCODE_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

pub(super) fn resolve_opencode_base_url(base_url: Option<&str>) -> &str {
    base_url.unwrap_or(OPENCODE_ZEN_BASE_URL)
}

/// Validate an OpenCode Zen/Go key by listing models without issuing a completion request.
pub async fn validate_opencode_key(api_key: &str, base_url: Option<&str>) -> ValidationResult {
    if api_key.is_empty() {
        return ValidationResult::failure("No API key provided");
    }

    match fetch_opencode_models(api_key, resolve_opencode_base_url(base_url)).await {
        Ok(models) => ValidationResult::success("API key valid").with_models(models),
        Err(err) => ValidationResult::failure(&err),
    }
}

async fn fetch_opencode_models(api_key: &str, base_url: &str) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/models", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(endpoint)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("Request failed: {err}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Invalid API key".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let models: OpenCodeModelsResponse = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse response: {err}"))?;
    Ok(models.data.into_iter().map(|model| model.id).collect())
}
