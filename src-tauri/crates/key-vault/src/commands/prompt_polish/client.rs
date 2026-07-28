//! OpenAI-compatible MiniCPM/vLLM client plumbing: request/response DTOs,
//! URL builders, auth, and model/account selection.

use serde::{Deserialize, Serialize};

use crate::key_store::{ModelKey, ModelType, KEY_SERVICE};

use super::text::clean_optional;

#[derive(Debug)]
pub(super) struct PromptPolishSelection {
    pub(super) key: ModelKey,
    pub(super) model: String,
}
#[derive(Debug, Serialize)]
pub(super) struct ChatCompletionRequest<'a> {
    pub(super) model: &'a str,
    pub(super) messages: Vec<ChatCompletionMessage<'a>>,
    pub(super) temperature: f32,
    pub(super) max_tokens: u32,
    pub(super) stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) chat_template_kwargs: Option<ChatTemplateKwargs>,
}
#[derive(Debug, Serialize)]
pub(super) struct ChatCompletionMessage<'a> {
    pub(super) role: &'a str,
    pub(super) content: &'a str,
}
#[derive(Debug, Serialize)]
pub(super) struct ChatTemplateKwargs {
    enable_thinking: bool,
}
pub(super) fn minicpm_no_think_kwargs() -> Option<ChatTemplateKwargs> {
    Some(ChatTemplateKwargs {
        enable_thinking: false,
    })
}
#[derive(Debug, Deserialize)]
pub(super) struct ChatCompletionResponse {
    #[serde(default)]
    pub(super) choices: Vec<ChatCompletionChoice>,
}
#[derive(Debug, Deserialize)]
pub(super) struct ChatCompletionChoice {
    pub(super) message: Option<ChatCompletionResponseMessage>,
    pub(super) text: Option<String>,
}
#[derive(Debug, Deserialize)]
pub(super) struct ChatCompletionResponseMessage {
    pub(super) content: Option<serde_json::Value>,
}
#[derive(Debug, Deserialize)]
pub(super) struct ChatCompletionBenchmarkResponse {
    #[serde(default)]
    pub(super) choices: Vec<ChatCompletionChoice>,
    pub(super) usage: Option<ChatCompletionUsage>,
}
#[derive(Debug, Deserialize)]
pub(super) struct ChatCompletionUsage {
    pub(super) prompt_tokens: Option<u32>,
    pub(super) completion_tokens: Option<u32>,
    pub(super) total_tokens: Option<u32>,
}
#[derive(Debug, Deserialize)]
struct OpenAiErrorResponse {
    error: Option<OpenAiErrorBody>,
}
#[derive(Debug, Deserialize)]
struct OpenAiErrorBody {
    message: Option<String>,
    #[serde(rename = "type")]
    error_type: Option<String>,
}
fn push_unique(candidates: &mut Vec<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() || candidates.iter().any(|candidate| candidate == trimmed) {
        return;
    }
    candidates.push(trimmed.to_string());
}
fn model_candidates(key: &ModelKey) -> Vec<String> {
    let mut candidates = Vec::new();

    for model in &key.enabled_models {
        push_unique(&mut candidates, model);
    }
    for model in &key.available_models {
        push_unique(&mut candidates, model);
    }
    for alias in &key.model_aliases {
        push_unique(&mut candidates, &alias.alias);
    }
    for variant in &key.model_variants {
        push_unique(&mut candidates, &variant.model);
    }
    for default_variant in &key.default_variants {
        push_unique(&mut candidates, &default_variant.model);
    }

    candidates
}
fn select_prompt_polish_model(
    key: &ModelKey,
    requested_model: Option<&str>,
) -> Result<String, String> {
    if let Some(model) = clean_optional(requested_model) {
        return Ok(model);
    }

    model_candidates(key)
        .into_iter()
        .find(|model| model.to_lowercase().contains("minicpm"))
        .ok_or_else(|| {
            format!(
                "No MiniCPM model configured for local model account {}",
                key.name.as_deref().unwrap_or(&key.id)
            )
        })
}
pub(super) fn select_prompt_polish_account(
    account_id: Option<&str>,
    requested_model: Option<&str>,
) -> Result<PromptPolishSelection, String> {
    if let Some(account_id) = clean_optional(account_id) {
        let key = KEY_SERVICE
            .get_key_by_id(&account_id)
            .ok_or_else(|| format!("Local model account not found: {account_id}"))?;
        if key.model_type != ModelType::VllmApi {
            return Err(format!(
                "Account {} is {}, expected vllm_api",
                account_id,
                key.model_type.as_str()
            ));
        }
        if !key.enabled {
            return Err(format!("Local model account {account_id} is disabled"));
        }
        let model = select_prompt_polish_model(&key, requested_model)?;
        return Ok(PromptPolishSelection { key, model });
    }

    let keys = KEY_SERVICE
        .get_all_keys_for_agent(&ModelType::VllmApi)
        .into_iter()
        .filter(|key| key.enabled)
        .collect::<Vec<_>>();

    if keys.is_empty() {
        return Err("No local vLLM/MiniCPM account configured".to_string());
    }

    for key in keys {
        if let Ok(model) = select_prompt_polish_model(&key, requested_model) {
            return Ok(PromptPolishSelection { key, model });
        }
    }

    Err("No MiniCPM model configured in local vLLM accounts".to_string())
}
pub(super) fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("MiniCPM account has no base URL".to_string());
    }

    if trimmed.ends_with("/chat/completions") {
        return Ok(trimmed.to_string());
    }
    if trimmed.ends_with("/v1") {
        return Ok(format!("{trimmed}/chat/completions"));
    }
    Ok(format!("{trimmed}/v1/chat/completions"))
}
pub(super) fn models_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("MiniCPM account has no base URL".to_string());
    }

    if trimmed.ends_with("/models") {
        return Ok(trimmed.to_string());
    }
    if trimmed.ends_with("/v1") {
        return Ok(format!("{trimmed}/models"));
    }
    Ok(format!("{trimmed}/v1/models"))
}
pub(super) fn key_base_url(key: &ModelKey) -> Result<&str, String> {
    key.base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "MiniCPM account has no base URL".to_string())
}
pub(super) fn with_optional_bearer(
    request: reqwest::RequestBuilder,
    key: &ModelKey,
) -> reqwest::RequestBuilder {
    if let Some(api_key) = key
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request.bearer_auth(api_key)
    } else {
        request
    }
}
pub(super) fn content_value_to_string(value: serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text),
        serde_json::Value::Array(parts) => {
            let text = parts
                .into_iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(|value| value.as_str())
                        .map(ToOwned::to_owned)
                })
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}
pub(super) fn chat_response_text(
    response: ChatCompletionResponse,
    empty_message: &str,
) -> Result<String, String> {
    chat_choices_text(response.choices, empty_message)
}
pub(super) fn chat_choices_text(
    choices: Vec<ChatCompletionChoice>,
    empty_message: &str,
) -> Result<String, String> {
    choices
        .into_iter()
        .find_map(|choice| {
            choice
                .message
                .and_then(|message| message.content)
                .and_then(content_value_to_string)
                .or(choice.text)
        })
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| empty_message.to_string())
}
pub(super) fn provider_error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(error_response) = serde_json::from_str::<OpenAiErrorResponse>(body) {
        if let Some(error) = error_response.error {
            if let Some(message) = error.message {
                if let Some(error_type) = error.error_type {
                    return format!(
                        "MiniCPM request failed: HTTP {status} {error_type}: {message}"
                    );
                }
                return format!("MiniCPM request failed: HTTP {status}: {message}");
            }
        }
    }

    let excerpt = body.trim();
    if excerpt.is_empty() {
        format!("MiniCPM request failed: HTTP {status}")
    } else {
        format!(
            "MiniCPM request failed: HTTP {status}: {}",
            excerpt.chars().take(500).collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key_store::{ModelAlias, ModelVariant};

    fn vllm_key() -> ModelKey {
        let mut key = ModelKey::new(ModelType::VllmApi);
        key.id = "local-1".to_string();
        key.name = Some("Local Models".to_string());
        key.enabled = true;
        key.base_url = Some("http://127.0.0.1:8000/v1".to_string());
        key
    }

    #[test]
    fn selects_minicpm_from_enabled_models_first() {
        let mut key = vllm_key();
        key.enabled_models = vec![
            "qwen2.5-coder".to_string(),
            "openbmb/minicpm5:latest".to_string(),
        ];
        key.available_models = vec!["openbmb/minicpm4".to_string()];

        let selected = select_prompt_polish_model(&key, None).unwrap();

        assert_eq!(selected, "openbmb/minicpm5:latest");
    }

    #[test]
    fn selects_minicpm_from_aliases_when_model_lists_are_empty() {
        let mut key = vllm_key();
        key.model_aliases = vec![ModelAlias {
            display_name: "MiniCPM".to_string(),
            alias: "openbmb/minicpm5:latest".to_string(),
            icon: None,
        }];

        let selected = select_prompt_polish_model(&key, None).unwrap();

        assert_eq!(selected, "openbmb/minicpm5:latest");
    }

    #[test]
    fn honors_explicit_requested_model() {
        let key = vllm_key();

        let selected = select_prompt_polish_model(&key, Some("custom-local-model")).unwrap();

        assert_eq!(selected, "custom-local-model");
    }

    #[test]
    fn fails_without_minicpm_candidate() {
        let mut key = vllm_key();
        key.model_variants = vec![ModelVariant {
            model: "qwen2.5-coder".to_string(),
            base_model: "qwen2.5-coder".to_string(),
            reasoning: None,
            fast: true,
            context_window: None,
        }];

        let error = select_prompt_polish_model(&key, None).unwrap_err();

        assert!(error.contains("No MiniCPM model configured"));
    }

    #[test]
    fn builds_chat_completions_url() {
        assert_eq!(
            chat_completions_url("http://127.0.0.1:8000").unwrap(),
            "http://127.0.0.1:8000/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://127.0.0.1:8000/v1").unwrap(),
            "http://127.0.0.1:8000/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://127.0.0.1:8000/v1/chat/completions").unwrap(),
            "http://127.0.0.1:8000/v1/chat/completions"
        );
    }

    #[test]
    fn serializes_minicpm_no_think_chat_template_kwargs() {
        let body = ChatCompletionRequest {
            model: "openbmb/MiniCPM5-1B",
            messages: vec![ChatCompletionMessage {
                role: "user",
                content: "hello",
            }],
            temperature: 0.0,
            max_tokens: 16,
            stream: false,
            chat_template_kwargs: minicpm_no_think_kwargs(),
        };

        let value = serde_json::to_value(&body).unwrap();

        assert_eq!(
            value["chat_template_kwargs"]["enable_thinking"],
            serde_json::Value::Bool(false)
        );
    }
}
