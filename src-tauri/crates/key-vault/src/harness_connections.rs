//! One coherent selection for direct native connections and managed proxy routing.
use crate::key_store::{AuthMethod, ModelKey, ProviderProtocol};
use crate::provider_config::get_provider_config;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessProtocol {
    AnthropicMessages,
    OpenaiResponses,
}

// No Debug/Serialize: resolved connections contain decrypted credentials.
pub struct ResolvedHarnessConnection {
    pub key_id: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub protocol: HarnessProtocol,
    pub requires_test: bool,
    /// Private fingerprint binds test receipts to all request-affecting fields.
    pub revision: String,
}

pub fn resolve(
    agent: &str,
    key: &ModelKey,
    model: Option<&str>,
) -> Result<ResolvedHarnessConnection, String> {
    let protocol = match agent {
        "claude_code" => HarnessProtocol::AnthropicMessages,
        "codex" => HarnessProtocol::OpenaiResponses,
        _ => return Err("Direct connections support Claude Code and Codex".into()),
    };
    if !key.enabled {
        return Err("Selected connection is disabled".into());
    }
    if key.auth_method != AuthMethod::ApiKey {
        return Err(
            "Select an API key connection; subscription login is preserved separately".into(),
        );
    }
    let api_key = key
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Selected connection has no API key")?
        .to_string();
    let provider = key.model_type.as_str();
    let config = get_provider_config(provider);
    let required = match protocol {
        HarnessProtocol::AnthropicMessages => "anthropic",
        HarnessProtocol::OpenaiResponses => "openai",
    };
    let custom = provider == "custom_api";
    if (custom && key.protocol.map(|value| value.as_str()) != Some(required))
        || (!custom
            && !config
                .supported_protocols
                .iter()
                .any(|value| value == required))
    {
        return Err(format!(
            "This connection does not expose the {required} protocol required by this harness"
        ));
    }
    // An explicitly chosen Anthropic endpoint is not a Responses endpoint.
    if protocol == HarnessProtocol::OpenaiResponses
        && key.protocol == Some(ProviderProtocol::Anthropic)
    {
        return Err("This connection selects Anthropic Messages, not OpenAI Responses".into());
    }
    let explicit = key
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let endpoint = if required == "anthropic" {
        explicit
            .and_then(|url| {
                config
                    .endpoints
                    .iter()
                    .find(|entry| entry.base_url.trim_end_matches('/') == url.trim_end_matches('/'))
            })
            .and_then(|entry| entry.anthropic_base_url.clone())
            .or_else(|| explicit.map(str::to_string))
            .or_else(|| config.default_anthropic_base_url())
            .or(config.default_base_url)
    } else {
        explicit.map(str::to_string).or(config.default_base_url)
    }
    .ok_or("This connection needs an endpoint")?;
    let url = url::Url::parse(&endpoint).map_err(|_| "Invalid connection endpoint")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use an HTTP(S) endpoint without embedded credentials, query, or fragment".into(),
        );
    }
    let models = if key.enabled_models.is_empty() {
        &key.available_models
    } else {
        &key.enabled_models
    };
    let model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| models.first().map(String::as_str))
        .ok_or("Select a model for this connection")?;
    if !models.iter().any(|candidate| candidate == model) {
        return Err("Model is not enabled for the selected connection".into());
    }
    let base_url = if required == "anthropic" {
        endpoint
            .trim_end_matches('/')
            .strip_suffix("/v1")
            .unwrap_or(endpoint.trim_end_matches('/'))
            .to_string()
    } else {
        endpoint.trim_end_matches('/').to_string()
    };
    let official = match protocol {
        HarnessProtocol::AnthropicMessages => base_url == "https://api.anthropic.com",
        HarnessProtocol::OpenaiResponses => base_url == "https://api.openai.com/v1",
    };
    let fields = serde_json::json!([
        agent,
        key.id,
        provider,
        model,
        base_url,
        api_key,
        key.protocol,
        key.enabled_models
    ]);
    let revision = format!("{:x}", Sha256::digest(fields.to_string().as_bytes()));
    Ok(ResolvedHarnessConnection {
        key_id: key.id.clone(),
        provider: provider.into(),
        model: model.into(),
        base_url,
        api_key,
        protocol,
        requires_test: !official,
        revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key_store::ModelType;

    fn key() -> ModelKey {
        let mut key = ModelKey::new(ModelType::CustomApi);
        key.api_key = Some("synthetic-key".into());
        key.protocol = Some(ProviderProtocol::OpenAi);
        key.base_url = Some("https://gateway.example/v1".into());
        key.available_models = vec!["test-model".into()];
        key
    }

    #[test]
    fn custom_responses_requires_test_and_revision_tracks_credential() {
        let mut key = key();
        let first = resolve("codex", &key, None).unwrap();
        assert!(first.requires_test);
        key.api_key = Some("new-key".into());
        assert_ne!(
            first.revision,
            resolve("codex", &key, None).unwrap().revision
        );
    }

    #[test]
    fn incompatible_auth_protocol_and_model_never_fall_back() {
        let mut key = key();
        assert!(resolve("claude_code", &key, None).is_err());
        assert!(resolve("codex", &key, Some("wrong-model")).is_err());
        key.enabled = false;
        assert!(resolve("codex", &key, None).is_err());
        key.enabled = true;
        key.auth_method = AuthMethod::Oauth;
        assert!(resolve("codex", &key, None).is_err());
    }

    #[test]
    fn anthropic_path_is_normalized_without_changing_custom_prefix() {
        let mut key = key();
        key.protocol = Some(ProviderProtocol::Anthropic);
        key.base_url = Some("https://gateway.example/anthropic/v1/".into());
        assert_eq!(
            resolve("claude_code", &key, None).unwrap().base_url,
            "https://gateway.example/anthropic"
        );
        key.base_url = Some("https://secret@gateway.example".into());
        assert!(resolve("claude_code", &key, None).is_err());
    }
}
