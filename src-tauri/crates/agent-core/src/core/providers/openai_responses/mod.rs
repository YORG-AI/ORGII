//! OpenAI Responses API client.
//!
//! Speaks the OpenAI Responses API format against the public OpenAI API
//! (`api.openai.com/v1/responses`).
//!
//! Direct public OpenAI policy may start known GPT-5.4+ public model names on
//! this endpoint. Custom relays must not infer endpoint requirements from model aliases.
//!
//! Key differences from CodexNativeClient:
//! - Uses standard OpenAI API endpoint (not Codex native backend)
//! - Supports `max_output_tokens` (but NOT `temperature` for reasoning models)
//! - Standard Bearer authentication (no chatgpt-account-id header)

pub mod client;
pub mod streaming;

pub use client::OpenAIResponsesClient;

/// Direct-public-OpenAI startup hint for known model names.
///
/// This must only be used after the caller has already proven the request is
/// going to OpenAI's public API, not a custom base URL or aggregator. Runtime
/// endpoint switching for relays is learned from structured protocol errors.
pub(crate) fn direct_openai_model_prefers_responses(model: &str) -> bool {
    let model_lower = model.to_lowercase();

    // Astra tool calling requires Responses, including for effort variants.
    if model_lower.contains("gpt-6-astra") {
        return true;
    }

    if !model_lower.contains("gpt-5") {
        return false;
    }

    if let Some(version) = extract_gpt5_version(&model_lower) {
        return version >= 5.4;
    }

    false
}

/// Extract the GPT-5 version number from a model name.
///
/// Examples:
/// - "gpt-5.4-pro" → Some(5.4)
/// - "gpt-5.3-codex" → Some(5.3)
/// - "gpt-5" → Some(5.0)
/// - "gpt-4o" → None
pub(crate) fn extract_gpt5_version(model_lower: &str) -> Option<f32> {
    let start = model_lower.find("gpt-5")?;
    let after_gpt5 = &model_lower[start + 5..];

    if after_gpt5.is_empty()
        || after_gpt5.starts_with('-')
            && !after_gpt5[1..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
    {
        return Some(5.0);
    }

    if !after_gpt5.starts_with('.') {
        return Some(5.0);
    }

    let version_str = &after_gpt5[1..];
    let end = version_str
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(version_str.len());
    let minor_str = &version_str[..end];

    if let Ok(minor) = minor_str.parse::<f32>() {
        Some(5.0 + minor / 10.0)
    } else {
        Some(5.0)
    }
}
