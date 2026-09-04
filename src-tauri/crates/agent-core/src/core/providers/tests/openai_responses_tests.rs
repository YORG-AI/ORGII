//! Tests for OpenAI Responses API module.

use crate::providers::openai_responses::client::OpenAIResponsesClient;
use crate::providers::openai_responses::{
    direct_openai_model_prefers_responses, extract_gpt5_version,
};

#[test]
fn direct_openai_model_prefers_responses_for_astra() {
    for model in ["gpt-6-astra", "GPT-6-ASTRA", "gpt-6-astra-ultra-fast"] {
        assert!(direct_openai_model_prefers_responses(model), "{model}");
    }
}

#[test]
fn direct_openai_model_prefers_responses_gpt4_models() {
    assert!(!direct_openai_model_prefers_responses("gpt-4o"));
    assert!(!direct_openai_model_prefers_responses("gpt-4-turbo"));
}

#[test]
fn direct_openai_model_prefers_responses_non_openai_models() {
    assert!(!direct_openai_model_prefers_responses("claude-sonnet-4"));
    assert!(!direct_openai_model_prefers_responses("deepseek-v3"));
}

#[test]
fn direct_openai_model_prefers_responses_gpt5_below_5_4() {
    assert!(!direct_openai_model_prefers_responses("gpt-5"));
    assert!(!direct_openai_model_prefers_responses("gpt-5.0"));
    assert!(!direct_openai_model_prefers_responses("gpt-5.3"));
    assert!(!direct_openai_model_prefers_responses("gpt-5.3-codex"));
}

#[test]
fn direct_openai_model_prefers_responses_gpt5_4_and_above() {
    assert!(direct_openai_model_prefers_responses("gpt-5.4"));
    assert!(direct_openai_model_prefers_responses("gpt-5.4-pro"));
    assert!(direct_openai_model_prefers_responses("gpt-5.5"));
    assert!(direct_openai_model_prefers_responses("gpt-5.6-turbo"));
    assert!(direct_openai_model_prefers_responses("GPT-5.4-PRO"));
}

#[test]
fn extract_gpt5_version_base_model() {
    assert_eq!(extract_gpt5_version("gpt-5"), Some(5.0));
    assert_eq!(extract_gpt5_version("gpt-5-turbo"), Some(5.0));
}

#[test]
fn extract_gpt5_version_with_minor() {
    assert_eq!(extract_gpt5_version("gpt-5.3"), Some(5.3));
    assert_eq!(extract_gpt5_version("gpt-5.3-codex"), Some(5.3));
    assert_eq!(extract_gpt5_version("gpt-5.4-pro"), Some(5.4));
    assert_eq!(extract_gpt5_version("openai/gpt-5.4"), Some(5.4));
}

#[test]
fn extract_gpt5_version_non_gpt5() {
    assert_eq!(extract_gpt5_version("gpt-4o"), None);
    assert_eq!(extract_gpt5_version("claude-3"), None);
}

#[test]
fn build_request_omits_temperature_for_gpt5_4() {
    let req =
        OpenAIResponsesClient::build_responses_request(&[], None, "gpt-5.4-pro", 4096, 0.7, false);
    assert!(
        req.temperature.is_none(),
        "GPT-5.4 should not have temperature"
    );
}

#[test]
fn build_request_omits_temperature_for_o1() {
    let req =
        OpenAIResponsesClient::build_responses_request(&[], None, "o1-preview", 4096, 0.7, false);
    assert!(req.temperature.is_none(), "o1 should not have temperature");
}

#[test]
fn build_request_omits_temperature_for_o3() {
    let req =
        OpenAIResponsesClient::build_responses_request(&[], None, "o3-mini", 4096, 0.7, false);
    assert!(req.temperature.is_none(), "o3 should not have temperature");
}

#[test]
fn build_request_omits_temperature_for_gpt5_3() {
    let req =
        OpenAIResponsesClient::build_responses_request(&[], None, "gpt-5.3", 4096, 0.7, false);
    assert!(
        req.temperature.is_none(),
        "temperature should never be sent"
    );
}

// -- Unconditional tool-image sidecar → input_image user followup --

use crate::turn_executor::helpers::STRUCTURED_SIDECAR_KEY;
use serde_json::Value;

fn tool_msg_with_image() -> Value {
    serde_json::json!({
        "role": "tool",
        "tool_call_id": "call_1",
        "content": "[image breadcrumb]",
        STRUCTURED_SIDECAR_KEY: {
            "content_blocks": [
                { "type": "image", "mime_type": "image/png", "data": "AAAA" }
            ]
        }
    })
}

#[test]
fn build_request_always_lifts_tool_images() {
    let messages = vec![tool_msg_with_image()];
    let req = OpenAIResponsesClient::build_responses_request(
        &messages, None, "gpt-5.4", 4096, 0.7, false,
    );
    let input = &req.input;
    assert_eq!(input.len(), 2, "function_call_output + follow-up user");
    assert_eq!(input[0]["type"], "function_call_output");
    assert_eq!(input[1]["role"], "user");
    assert_eq!(input[1]["content"][1]["type"], "input_image");
    assert_eq!(
        input[1]["content"][1]["image_url"],
        "data:image/png;base64,AAAA"
    );
}

#[test]
fn build_request_lifts_tool_images_for_any_model_name() {
    // Proxies, custom deployment names, and private hosts must all
    // get image expansion — the whole point of the §17 correction.
    let messages = vec![tool_msg_with_image()];
    for name in [
        "my-company-vision-v1",
        "openrouter/anthropic/claude-3.5-sonnet",
        "azure-prod-deploy",
        "internal-qwen-vl",
    ] {
        let req =
            OpenAIResponsesClient::build_responses_request(&messages, None, name, 4096, 0.7, false);
        assert_eq!(
            req.input.len(),
            2,
            "expected image expansion for model {name}"
        );
    }
}

// The `capabilities()` hook and `ProviderCapabilities` struct were
// removed entirely — they had no
// production readers after the gating logic was deleted. If a future
// capability declaration is needed, re-introduce the hook together
// with its read site (no-dead-code check).
