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

/// Configuration targets are distinct from vault providers and executable agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionTarget {
    ClaudeCode,
    ClaudeDesktop,
    Codex,
}
impl TryFrom<&str> for ConnectionTarget {
    type Error = String;
    fn try_from(value: &str) -> Result<Self, String> {
        match value {
            "claude_code" => Ok(Self::ClaudeCode),
            "claude_desktop" => Ok(Self::ClaudeDesktop),
            "codex" => Ok(Self::Codex),
            _ => Err("Unsupported connection target".into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ConnectionAuthScheme {
    #[serde(rename = "bearer")]
    Bearer,
    #[serde(rename = "x-api-key")]
    ApiKey,
}
impl ConnectionAuthScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::ApiKey => "x-api-key",
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopConnectionOptions {
    pub endpoint: Option<String>,
    pub auth_scheme: Option<ConnectionAuthScheme>,
}

// No Debug/Serialize: resolved connections contain decrypted credentials.
pub struct ResolvedHarnessConnection {
    pub key_id: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub protocol: HarnessProtocol,
    pub auth_scheme: ConnectionAuthScheme,
    pub requires_test: bool,
    /// Private fingerprint binds test receipts to all request-affecting fields.
    pub revision: String,
}

/// Credential/protocol eligibility is independent of the endpoint and model
/// fields the user is still editing. Applying always resolves the full profile.
pub fn validate_connection_key(agent: &str, key: &ModelKey) -> Result<HarnessProtocol, String> {
    let target = ConnectionTarget::try_from(agent)?;
    let protocol = match target {
        ConnectionTarget::ClaudeCode | ConnectionTarget::ClaudeDesktop => {
            HarnessProtocol::AnthropicMessages
        }
        ConnectionTarget::Codex => HarnessProtocol::OpenaiResponses,
    };
    if !key.enabled {
        return Err("Selected connection is disabled".into());
    }
    if key.auth_method != AuthMethod::ApiKey {
        return Err(
            "Select an API key connection; subscription login is preserved separately".into(),
        );
    }
    key.api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Selected connection has no API key")?;
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
    Ok(protocol)
}

pub fn resolve(
    agent: &str,
    key: &ModelKey,
    model: Option<&str>,
) -> Result<ResolvedHarnessConnection, String> {
    resolve_with_options(agent, key, model, None)
}

pub fn resolve_with_options(
    agent: &str,
    key: &ModelKey,
    model: Option<&str>,
    options: Option<&DesktopConnectionOptions>,
) -> Result<ResolvedHarnessConnection, String> {
    resolve_internal(agent, key, model, options, false)
}
/// Profile endpoints and model catalogs are independent of shared credentials.
pub fn resolve_claude_profile(
    agent: &str,
    key: &ModelKey,
    model: &str,
    options: &DesktopConnectionOptions,
) -> Result<ResolvedHarnessConnection, String> {
    if !matches!(
        ConnectionTarget::try_from(agent)?,
        ConnectionTarget::ClaudeCode | ConnectionTarget::ClaudeDesktop
    ) {
        return Err("Claude profiles cannot configure another app".into());
    }
    resolve_internal(agent, key, Some(model), Some(options), true)
}
fn resolve_internal(
    agent: &str,
    key: &ModelKey,
    model: Option<&str>,
    options: Option<&DesktopConnectionOptions>,
    profile: bool,
) -> Result<ResolvedHarnessConnection, String> {
    let target = ConnectionTarget::try_from(agent)?;
    if !profile && options.is_some() && target != ConnectionTarget::ClaudeDesktop {
        return Err("Desktop settings cannot be applied to another app".into());
    }
    let protocol = validate_connection_key(agent, key)?;
    let api_key = key
        .api_key
        .as_deref()
        .ok_or("Selected connection has no API key")?
        .trim()
        .to_string();
    let provider = key.model_type.as_str();
    let config = get_provider_config(provider);
    let required = match protocol {
        HarnessProtocol::AnthropicMessages => "anthropic",
        HarnessProtocol::OpenaiResponses => "openai",
    };
    let explicit = options
        .and_then(|options| options.endpoint.as_deref())
        .or(key.base_url.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let endpoint = if profile {
        explicit.map(str::to_string)
    } else if required == "anthropic" {
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
    if !profile
        && target != ConnectionTarget::ClaudeDesktop
        && !models.iter().any(|candidate| candidate == model)
    {
        return Err("Model is not enabled for the selected connection".into());
    }
    let base_url = normalize_endpoint(&endpoint, protocol)?;
    let official = match protocol {
        HarnessProtocol::AnthropicMessages => base_url == "https://api.anthropic.com",
        HarnessProtocol::OpenaiResponses => base_url == "https://api.openai.com/v1",
    };
    let auth_scheme = options.and_then(|options| options.auth_scheme).unwrap_or(
        if protocol == HarnessProtocol::AnthropicMessages && official {
            ConnectionAuthScheme::ApiKey
        } else {
            ConnectionAuthScheme::Bearer
        },
    );
    let fields = serde_json::json!([
        agent,
        key.id,
        provider,
        model,
        base_url,
        api_key,
        key.protocol,
        key.enabled_models,
        auth_scheme
    ]);
    let revision = format!("{:x}", Sha256::digest(fields.to_string().as_bytes()));
    Ok(ResolvedHarnessConnection {
        key_id: key.id.clone(),
        provider: provider.into(),
        model: model.into(),
        base_url,
        api_key,
        protocol,
        auth_scheme,
        requires_test: profile || !official || target == ConnectionTarget::ClaudeDesktop,
        revision,
    })
}

// Endpoint discovery intentionally does not resolve or validate any model selection.
pub struct ResolvedClaudeEndpoint {
    pub base_url: String,
    pub api_key: String,
    pub auth_scheme: ConnectionAuthScheme,
}
pub fn resolve_claude_endpoint(
    agent: &str,
    key: &ModelKey,
    endpoint: &str,
    auth_scheme: ConnectionAuthScheme,
) -> Result<ResolvedClaudeEndpoint, String> {
    if !matches!(
        ConnectionTarget::try_from(agent)?,
        ConnectionTarget::ClaudeCode | ConnectionTarget::ClaudeDesktop
    ) {
        return Err("Claude endpoints cannot configure another app".into());
    }
    let protocol = validate_connection_key(agent, key)?;
    Ok(ResolvedClaudeEndpoint {
        base_url: normalize_endpoint(endpoint, protocol)?,
        api_key: key
            .api_key
            .as_deref()
            .ok_or("Selected connection has no API key")?
            .trim()
            .to_string(),
        auth_scheme,
    })
}
fn normalize_endpoint(endpoint: &str, protocol: HarnessProtocol) -> Result<String, String> {
    let endpoint = endpoint.trim();
    let url = url::Url::parse(endpoint).map_err(|_| "Invalid connection endpoint")?;
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
    let base_url = if protocol == HarnessProtocol::AnthropicMessages {
        endpoint
            .trim_end_matches('/')
            .strip_suffix("/v1")
            .unwrap_or(endpoint.trim_end_matches('/'))
            .to_string()
    } else {
        endpoint.trim_end_matches('/').to_string()
    };
    Ok(base_url)
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
    fn discovery_and_profile_models_do_not_depend_on_the_shared_key_catalog() {
        let mut key = key();
        key.protocol = Some(ProviderProtocol::Anthropic);
        key.available_models.clear();
        let endpoint = resolve_claude_endpoint(
            "claude_code",
            &key,
            "https://gateway.example/prefix/v1/",
            ConnectionAuthScheme::ApiKey,
        )
        .unwrap();
        assert_eq!(endpoint.base_url, "https://gateway.example/prefix");
        let options = DesktopConnectionOptions {
            endpoint: Some(endpoint.base_url.clone()),
            auth_scheme: Some(ConnectionAuthScheme::ApiKey),
        };
        let profile =
            resolve_claude_profile("claude_code", &key, "arbitrary/provider-id", &options).unwrap();
        assert_eq!(profile.model, "arbitrary/provider-id");
        assert!(profile.requires_test);
        assert!(resolve("claude_code", &key, Some("arbitrary/provider-id")).is_err());
        assert!(resolve_claude_endpoint(
            "codex",
            &key,
            "https://gateway.example",
            ConnectionAuthScheme::ApiKey
        )
        .is_err());
        assert!(resolve_claude_endpoint(
            "claude_code",
            &key,
            "https://secret@gateway.example",
            ConnectionAuthScheme::ApiKey
        )
        .is_err());
        assert!(key.available_models.is_empty());
    }

    #[test]
    fn desktop_overrides_are_scoped_and_receipts_bind_endpoint_auth_and_target() {
        let mut key = key();
        key.protocol = Some(ProviderProtocol::Anthropic);
        key.available_models = vec!["claude-sonnet-5".into()];
        let original_endpoint = key.base_url.clone();
        let mut options = DesktopConnectionOptions {
            endpoint: Some("https://desktop.example/prefix/v1/".into()),
            auth_scheme: Some(ConnectionAuthScheme::ApiKey),
        };
        let first = resolve_with_options("claude_desktop", &key, None, Some(&options)).unwrap();
        assert_eq!(first.base_url, "https://desktop.example/prefix");
        assert_eq!(first.auth_scheme, ConnectionAuthScheme::ApiKey);
        assert!(first.requires_test);
        assert_eq!(key.base_url, original_endpoint);
        assert!(resolve_with_options("claude_code", &key, None, Some(&options)).is_err());
        assert_ne!(
            first.revision,
            resolve("claude_code", &key, None).unwrap().revision
        );
        options.auth_scheme = Some(ConnectionAuthScheme::Bearer);
        assert_ne!(
            first.revision,
            resolve_with_options("claude_desktop", &key, None, Some(&options))
                .unwrap()
                .revision
        );
        options.auth_scheme = Some(ConnectionAuthScheme::ApiKey);
        options.endpoint = Some("https://another.example".into());
        assert_ne!(
            first.revision,
            resolve_with_options("claude_desktop", &key, None, Some(&options))
                .unwrap()
                .revision
        );
        options.endpoint = Some("https://user:secret@desktop.example".into());
        assert!(resolve_with_options("claude_desktop", &key, None, Some(&options)).is_err());
        assert!(resolve("unknown_desktop", &key, None).is_err());
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
