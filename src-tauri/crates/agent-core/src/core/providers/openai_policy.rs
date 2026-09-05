//! OpenAI endpoint and wire-policy decisions.
//!
//! This module is intentionally OpenAI-scoped. It decides between public
//! OpenAI Responses and OpenAI-compatible Chat Completions for one selected
//! account/endpoint/model alias. Native Anthropic and Codex native keep their
//! own request contracts.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::registry::{provider_id, ProviderSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChatTokenLimitField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OpenAiChatWirePolicy {
    pub token_limit_field: ChatTokenLimitField,
    pub send_temperature: bool,
    pub send_tool_choice_auto: bool,
    pub send_stream_options: bool,
}

impl OpenAiChatWirePolicy {
    pub(crate) fn clean_main_compatible(model: &str) -> Self {
        Self {
            token_limit_field: chat_token_limit_field_hint(model),
            send_temperature: false,
            send_tool_choice_auto: true,
            send_stream_options: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenAiEndpointPolicy {
    ChatCompletions(OpenAiChatWirePolicy),
    Responses,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct OpenAiCapabilityCacheKey {
    account_id: String,
    provider_name: String,
    base_url_fingerprint: Option<String>,
    model_alias: String,
}

impl OpenAiCapabilityCacheKey {
    pub(crate) fn new(
        account_id: Option<&str>,
        provider_name: &'static str,
        base_url: Option<&str>,
        model_alias: &str,
    ) -> Option<Self> {
        let account_id = account_id?.trim();
        if account_id.is_empty() {
            return None;
        }
        Some(Self {
            account_id: account_id.to_string(),
            provider_name: provider_name.to_string(),
            base_url_fingerprint: base_url
                .map(str::trim)
                .filter(|base| !base.is_empty())
                .map(normalize_base_url),
            model_alias: model_alias.trim().to_ascii_lowercase(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EndpointLearningReason {
    ChatCompletionsRejectedModel,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OpenAiChatWirePreference {
    pub token_limit_field: Option<ChatTokenLimitField>,
    pub send_stream_options: Option<bool>,
    pub send_temperature: Option<bool>,
    pub send_tool_choice_auto: Option<bool>,
}

pub(crate) struct OpenAiCapabilityCache {
    responses_endpoint_reasons: Mutex<HashMap<OpenAiCapabilityCacheKey, EndpointLearningReason>>,
    chat_wire_preferences: Mutex<HashMap<OpenAiCapabilityCacheKey, OpenAiChatWirePreference>>,
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedOpenAiCapabilityCache {
    #[serde(default)]
    responses_endpoint_reasons: Vec<PersistedEndpointReason>,
    #[serde(default)]
    chat_wire_preferences: Vec<PersistedChatWirePreference>,
}

#[derive(Serialize, Deserialize)]
struct PersistedEndpointReason {
    key: OpenAiCapabilityCacheKey,
    reason: EndpointLearningReason,
}

#[derive(Serialize, Deserialize)]
struct PersistedChatWirePreference {
    key: OpenAiCapabilityCacheKey,
    preference: OpenAiChatWirePreference,
}

impl Default for OpenAiCapabilityCache {
    fn default() -> Self {
        let persisted = load_persisted_cache().unwrap_or_default();
        Self {
            responses_endpoint_reasons: Mutex::new(
                persisted
                    .responses_endpoint_reasons
                    .into_iter()
                    .map(|entry| (entry.key, entry.reason))
                    .collect(),
            ),
            chat_wire_preferences: Mutex::new(
                persisted
                    .chat_wire_preferences
                    .into_iter()
                    .map(|entry| (entry.key, entry.preference))
                    .collect(),
            ),
        }
    }
}

impl OpenAiCapabilityCache {
    pub(crate) fn responses_endpoint_reason(
        &self,
        key: &OpenAiCapabilityCacheKey,
    ) -> Option<EndpointLearningReason> {
        self.responses_endpoint_reasons.lock().get(key).cloned()
    }

    pub(crate) fn remember_responses_endpoint_reason(
        &self,
        key: OpenAiCapabilityCacheKey,
        reason: EndpointLearningReason,
    ) {
        self.responses_endpoint_reasons.lock().insert(key, reason);
        self.persist();
    }

    pub(crate) fn chat_wire_preference(
        &self,
        key: &OpenAiCapabilityCacheKey,
    ) -> Option<OpenAiChatWirePreference> {
        self.chat_wire_preferences.lock().get(key).cloned()
    }

    pub(crate) fn remember_chat_wire_preference(
        &self,
        key: OpenAiCapabilityCacheKey,
        preference: OpenAiChatWirePreference,
    ) {
        let mut preferences = self.chat_wire_preferences.lock();
        let entry = preferences.entry(key).or_default();
        if preference.token_limit_field.is_some() {
            entry.token_limit_field = preference.token_limit_field;
        }
        if preference.send_stream_options.is_some() {
            entry.send_stream_options = preference.send_stream_options;
        }
        if preference.send_temperature.is_some() {
            entry.send_temperature = preference.send_temperature;
        }
        if preference.send_tool_choice_auto.is_some() {
            entry.send_tool_choice_auto = preference.send_tool_choice_auto;
        }
        drop(preferences);
        self.persist();
    }

    fn persist(&self) {
        #[cfg(not(test))]
        {
            let responses_endpoint_reasons = self.responses_endpoint_reasons.lock().clone();
            let chat_wire_preferences = self.chat_wire_preferences.lock().clone();
            persist_cache_snapshot(&responses_endpoint_reasons, &chat_wire_preferences);
        }
    }

    #[cfg(test)]
    fn clear(&self) {
        self.responses_endpoint_reasons.lock().clear();
        self.chat_wire_preferences.lock().clear();
    }
}

static OPENAI_CAPABILITY_CACHE: OnceLock<OpenAiCapabilityCache> = OnceLock::new();

pub(crate) fn openai_capability_cache() -> &'static OpenAiCapabilityCache {
    OPENAI_CAPABILITY_CACHE.get_or_init(OpenAiCapabilityCache::default)
}

fn load_persisted_cache() -> Option<PersistedOpenAiCapabilityCache> {
    let path = app_paths::provider_capabilities_cache();
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content)
        .map_err(|err| {
            tracing::warn!(
                "[provider-capabilities] Ignoring invalid cache {}: {}",
                path.display(),
                err
            );
        })
        .ok()
}

#[cfg(not(test))]
fn persist_cache_snapshot(
    responses_endpoint_reasons: &HashMap<OpenAiCapabilityCacheKey, EndpointLearningReason>,
    chat_wire_preferences: &HashMap<OpenAiCapabilityCacheKey, OpenAiChatWirePreference>,
) {
    let path = app_paths::provider_capabilities_cache();
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            tracing::warn!(
                "[provider-capabilities] Failed to create cache dir {}: {}",
                parent.display(),
                err
            );
            return;
        }
    }
    let persisted = PersistedOpenAiCapabilityCache {
        responses_endpoint_reasons: responses_endpoint_reasons
            .iter()
            .map(|(key, reason)| PersistedEndpointReason {
                key: key.clone(),
                reason: reason.clone(),
            })
            .collect(),
        chat_wire_preferences: chat_wire_preferences
            .iter()
            .map(|(key, preference)| PersistedChatWirePreference {
                key: key.clone(),
                preference: preference.clone(),
            })
            .collect(),
    };
    let Ok(content) = serde_json::to_string_pretty(&persisted) else {
        tracing::warn!("[provider-capabilities] Failed to serialize cache");
        return;
    };
    if let Err(err) = std::fs::write(&path, content) {
        tracing::warn!(
            "[provider-capabilities] Failed to write cache {}: {}",
            path.display(),
            err
        );
    }
}

pub(crate) fn resolve_openai_endpoint_policy(
    spec: &'static ProviderSpec,
    account_id: Option<&str>,
    custom_base_url: Option<&str>,
    model_alias: &str,
) -> OpenAiEndpointPolicy {
    if let Some(key) =
        OpenAiCapabilityCacheKey::new(account_id, spec.name, custom_base_url, model_alias)
    {
        if openai_capability_cache()
            .responses_endpoint_reason(&key)
            .is_some()
        {
            return OpenAiEndpointPolicy::Responses;
        }
    }

    if is_direct_public_openai(spec, custom_base_url)
        && direct_openai_known_requires_responses(model_alias)
    {
        return OpenAiEndpointPolicy::Responses;
    }

    OpenAiEndpointPolicy::ChatCompletions(resolve_openai_chat_wire_policy(
        spec,
        account_id,
        custom_base_url,
        model_alias,
    ))
}

pub(crate) fn resolve_openai_chat_wire_policy(
    spec: &'static ProviderSpec,
    account_id: Option<&str>,
    custom_base_url: Option<&str>,
    model_alias: &str,
) -> OpenAiChatWirePolicy {
    let mut policy = OpenAiChatWirePolicy::clean_main_compatible(model_alias);
    if let Some(key) =
        OpenAiCapabilityCacheKey::new(account_id, spec.name, custom_base_url, model_alias)
    {
        if let Some(preference) = openai_capability_cache().chat_wire_preference(&key) {
            if let Some(token_limit_field) = preference.token_limit_field {
                policy.token_limit_field = token_limit_field;
            }
            if let Some(send_stream_options) = preference.send_stream_options {
                policy.send_stream_options = send_stream_options;
            }
            if let Some(send_temperature) = preference.send_temperature {
                policy.send_temperature = send_temperature;
            }
            if let Some(send_tool_choice_auto) = preference.send_tool_choice_auto {
                policy.send_tool_choice_auto = send_tool_choice_auto;
            }
        }
    }
    policy
}

pub(crate) fn remember_openai_responses_required(
    spec: &'static ProviderSpec,
    account_id: Option<&str>,
    custom_base_url: Option<&str>,
    model_alias: &str,
) {
    if let Some(key) =
        OpenAiCapabilityCacheKey::new(account_id, spec.name, custom_base_url, model_alias)
    {
        openai_capability_cache().remember_responses_endpoint_reason(
            key,
            EndpointLearningReason::ChatCompletionsRejectedModel,
        );
    }
}

pub(crate) fn remember_openai_chat_wire_preference(
    spec: &'static ProviderSpec,
    account_id: Option<&str>,
    custom_base_url: Option<&str>,
    model_alias: &str,
    preference: OpenAiChatWirePreference,
) {
    if let Some(key) =
        OpenAiCapabilityCacheKey::new(account_id, spec.name, custom_base_url, model_alias)
    {
        openai_capability_cache().remember_chat_wire_preference(key, preference);
    }
}

pub(crate) fn openai_error_requires_responses(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    let mentions_responses = lower.contains("responses api")
        || lower.contains("/responses")
        || lower.contains("responses endpoint")
        || lower.contains("v1/responses");
    let rejects_chat = lower.contains("chat.completions")
        || lower.contains("chat completions")
        || lower.contains("/chat/completions")
        || lower.contains("v1/chat/completions")
        || lower.contains("not supported with this model")
        || lower.contains("not supported for this model");

    mentions_responses && rejects_chat
}

pub(crate) fn openai_chat_wire_preference_from_error(
    body: &str,
    current_policy: OpenAiChatWirePolicy,
) -> Option<OpenAiChatWirePreference> {
    let lower = body.to_ascii_lowercase();
    let mut preference = OpenAiChatWirePreference::default();

    if lower.contains("unsupported parameter") || lower.contains("unknown parameter") {
        if mentions_unsupported_field(&lower, "max_tokens") {
            preference.token_limit_field = Some(ChatTokenLimitField::MaxCompletionTokens);
        } else if mentions_unsupported_field(&lower, "max_completion_tokens") {
            preference.token_limit_field = Some(ChatTokenLimitField::MaxTokens);
        } else if lower.contains("stream_options") {
            preference.send_stream_options = Some(false);
        } else if lower.contains("temperature") {
            preference.send_temperature = Some(false);
        } else if lower.contains("tool_choice") {
            preference.send_tool_choice_auto = Some(false);
        }
    }

    if lower.contains("unsupported value") && lower.contains("temperature") {
        preference.send_temperature = Some(false);
    }

    if preference.token_limit_field == Some(current_policy.token_limit_field)
        || preference.send_stream_options == Some(current_policy.send_stream_options)
        || preference.send_temperature == Some(current_policy.send_temperature)
        || preference.send_tool_choice_auto == Some(current_policy.send_tool_choice_auto)
    {
        return None;
    }

    if preference == OpenAiChatWirePreference::default() {
        None
    } else {
        Some(preference)
    }
}

#[cfg(test)]
fn openai_error_is_unsupported_parameter(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("unsupported parameter") || lower.contains("unknown parameter")
}

fn is_direct_public_openai(spec: &ProviderSpec, custom_base_url: Option<&str>) -> bool {
    spec.name == provider_id::OPENAI && custom_base_url.is_none()
}

fn direct_openai_known_requires_responses(model: &str) -> bool {
    super::openai_responses::direct_openai_model_prefers_responses(model)
}

fn chat_token_limit_field_hint(model: &str) -> ChatTokenLimitField {
    super::openai_compat::types::chat_token_limit_field_hint(model)
}

fn mentions_unsupported_field(lower_body: &str, field: &str) -> bool {
    lower_body.contains(&format!("'{}'", field))
        || lower_body.contains(&format!("\"{}\"", field))
        || lower_body.contains(&format!("parameter: {}", field))
        || lower_body.contains(&format!("parameter `{}`", field))
}

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::registry::{find_by_name, provider_id};
    use serial_test::serial;

    fn openai_spec() -> &'static ProviderSpec {
        find_by_name(provider_id::OPENAI).expect("openai provider")
    }

    fn openrouter_spec() -> &'static ProviderSpec {
        find_by_name(provider_id::OPENROUTER).expect("openrouter provider")
    }

    #[test]
    #[serial]
    fn astra_uses_responses_directly_and_preserves_custom_endpoint_policy() {
        openai_capability_cache().clear();
        let model = "gpt-6-astra-high";
        assert_eq!(
            resolve_openai_endpoint_policy(openai_spec(), Some("astra-direct"), None, model),
            OpenAiEndpointPolicy::Responses
        );
        let custom = resolve_openai_endpoint_policy(
            openai_spec(),
            Some("astra-relay"),
            Some("https://relay.example/v1"),
            model,
        );
        assert!(matches!(
            custom,
            OpenAiEndpointPolicy::ChatCompletions(OpenAiChatWirePolicy {
                token_limit_field: ChatTokenLimitField::MaxCompletionTokens,
                send_temperature: false,
                ..
            })
        ));
    }

    #[test]
    #[serial]
    fn custom_base_url_defaults_to_chat_even_for_future_model_alias() {
        openai_capability_cache().clear();
        let policy = resolve_openai_endpoint_policy(
            openai_spec(),
            Some("acct-relay"),
            Some("https://relay.example/v1"),
            "gpt-5.5-high",
        );
        assert!(matches!(policy, OpenAiEndpointPolicy::ChatCompletions(_)));
    }

    #[test]
    #[serial]
    fn direct_openai_known_future_model_can_start_on_responses() {
        openai_capability_cache().clear();
        let policy =
            resolve_openai_endpoint_policy(openai_spec(), Some("acct-openai"), None, "gpt-5.4-pro");
        assert!(matches!(policy, OpenAiEndpointPolicy::Responses));
    }

    #[test]
    #[serial]
    fn cached_responses_preference_overrides_custom_base_default() {
        openai_capability_cache().clear();
        remember_openai_responses_required(
            openai_spec(),
            Some("acct-relay"),
            Some("https://relay.example/v1/"),
            "o5.5-high",
        );
        let policy = resolve_openai_endpoint_policy(
            openai_spec(),
            Some("acct-relay"),
            Some("https://relay.example/v1"),
            "O5.5-HIGH",
        );
        assert!(matches!(policy, OpenAiEndpointPolicy::Responses));
    }

    #[test]
    #[serial]
    fn cache_is_scoped_by_account_and_base_url() {
        openai_capability_cache().clear();
        remember_openai_responses_required(
            openai_spec(),
            Some("acct-a"),
            Some("https://relay-a.example/v1"),
            "o5.5-high",
        );
        let same_model_other_account = resolve_openai_endpoint_policy(
            openai_spec(),
            Some("acct-b"),
            Some("https://relay-a.example/v1"),
            "o5.5-high",
        );
        let same_account_other_base = resolve_openai_endpoint_policy(
            openai_spec(),
            Some("acct-a"),
            Some("https://relay-b.example/v1"),
            "o5.5-high",
        );
        assert!(matches!(
            same_model_other_account,
            OpenAiEndpointPolicy::ChatCompletions(_)
        ));
        assert!(matches!(
            same_account_other_base,
            OpenAiEndpointPolicy::ChatCompletions(_)
        ));
    }

    #[test]
    fn unsupported_parameter_does_not_imply_responses() {
        let body = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
        assert!(openai_error_is_unsupported_parameter(body));
        assert!(!openai_error_requires_responses(body));
    }

    #[test]
    fn endpoint_contract_error_can_require_responses() {
        let body =
            "This model is not supported in v1/chat/completions. Use the Responses API instead.";
        assert!(openai_error_requires_responses(body));
    }

    #[test]
    fn max_tokens_error_learns_max_completion_tokens_without_endpoint_switch() {
        let current_policy = OpenAiChatWirePolicy::clean_main_compatible("proxy-defined-model");
        let body = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
        let preference =
            openai_chat_wire_preference_from_error(body, current_policy).expect("wire preference");
        assert_eq!(
            preference.token_limit_field,
            Some(ChatTokenLimitField::MaxCompletionTokens)
        );
        assert!(!openai_error_requires_responses(body));
    }

    #[test]
    #[serial]
    fn cached_chat_wire_preference_overrides_model_hint() {
        openai_capability_cache().clear();
        remember_openai_chat_wire_preference(
            openai_spec(),
            Some("acct-relay"),
            Some("https://relay.example/v1"),
            "proxy-defined-model",
            OpenAiChatWirePreference {
                token_limit_field: Some(ChatTokenLimitField::MaxCompletionTokens),
                ..OpenAiChatWirePreference::default()
            },
        );
        let policy = resolve_openai_chat_wire_policy(
            openai_spec(),
            Some("acct-relay"),
            Some("https://relay.example/v1/"),
            "proxy-defined-model",
        );
        assert_eq!(
            policy.token_limit_field,
            ChatTokenLimitField::MaxCompletionTokens
        );
    }

    #[test]
    #[serial]
    fn aggregators_do_not_use_direct_openai_responses_policy() {
        openai_capability_cache().clear();
        let policy =
            resolve_openai_endpoint_policy(openrouter_spec(), Some("acct-or"), None, "gpt-5.4-pro");
        assert!(matches!(policy, OpenAiEndpointPolicy::ChatCompletions(_)));
    }
}
