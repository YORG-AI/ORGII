//! Codex model catalog payloads and their mapping to `DiscoveredModel`.

use crate::types::DiscoveredModel;
use serde::Deserialize;

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
pub(super) struct CodexModelListResponse {
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

pub(super) fn parse_codex_models_response(body: &str) -> Result<Vec<String>, String> {
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

pub(super) fn discovered_models_from_app_server(
    response: CodexModelListResponse,
) -> Vec<DiscoveredModel> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
