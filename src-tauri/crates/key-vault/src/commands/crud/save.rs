use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use regex::Regex;

use super::{key_info_from_entry, KeyInfo, SaveKeyRequest};
use crate::commands::validate::{invalidate_key_quota_runtime, quota_credential_revision};
use crate::key_store::{
    is_claude_official_oauth_token, is_official_anthropic_endpoint, AuthMethod, DefaultVariant,
    HealthStatus, ModelKey, ModelType, ModelVariant, ProviderProtocol, KEY_SERVICE,
};

/// Filter out model IDs containing dated snapshot suffixes (YYYY-MM-DD pattern).
/// These are point-in-time snapshots that shouldn't be persisted as enabled.
pub(super) fn filter_dated_models(models: Vec<String>) -> Vec<String> {
    let date_pattern = Regex::new(r"\b\d{4}-\d{2}-\d{2}\b").unwrap();
    models
        .into_iter()
        .filter(|m| !date_pattern.is_match(m))
        .collect()
}

fn is_cursor_web_session_token(token: &str) -> bool {
    let jwt = token.split("%3A%3A").nth(1).unwrap_or(token);
    let payload = match jwt.split('.').nth(1) {
        Some(payload) => payload,
        None => return false,
    };
    let decoded = match URL_SAFE_NO_PAD.decode(payload) {
        Ok(decoded) => decoded,
        Err(_) => return false,
    };
    let value = match serde_json::from_slice::<serde_json::Value>(&decoded) {
        Ok(value) => value,
        Err(_) => return false,
    };

    value.get("type").and_then(|value| value.as_str()) == Some("web")
}

/// Drop stale relay routing from a ClaudeCode row that carries official
/// Anthropic OAuth material.
///
/// Re-detecting Claude Code OAuth on top of an account row that was earlier
/// configured for a third-party relay leaves the relay's `base_url` (and a
/// possible `protocol: openai`) on the row, because `save_key` only
/// overwrites fields present in the request. The Rust agent then sends the
/// `sk-ant-oat…` bearer token to the relay, which 401s (issue #276). Official
/// OAuth tokens have exactly one valid endpoint, so the relay routing state
/// is unambiguously stale. Relay ClaudeCode accounts (non-`sk-ant-oat`
/// tokens) are left untouched.
fn normalize_claude_official_oauth_routing(entry: &mut ModelKey) {
    if entry.model_type != ModelType::ClaudeCode
        || entry.auth_method != AuthMethod::Oauth
        || !entry
            .session_token
            .as_deref()
            .is_some_and(is_claude_official_oauth_token)
    {
        return;
    }

    if !is_official_anthropic_endpoint(entry.base_url.as_deref()) {
        entry.base_url = None;
    }
    entry.protocol = None;
}

/// Save or update a key
#[tauri::command]
pub async fn save_key(request: SaveKeyRequest) -> Result<KeyInfo, String> {
    tokio::task::spawn_blocking(move || {
        let agent_type =
            ModelType::from_str(&request.agent_type).ok_or("Unknown agent type".to_string())?;

        // Load existing key if updating
        let existing = match request.id.as_deref() {
            Some(id) => KEY_SERVICE.get_key_by_id_checked(id)?,
            None => None,
        };

        let prior_quota_revision = existing.as_ref().map(quota_credential_revision);
        let mut entry = if let Some(existing) = existing {
            existing
        } else {
            ModelKey::new(agent_type.clone())
        };
        let mut received_oauth_material = false;

        // Update fields
        if let Some(id) = request.id {
            entry.id = id;
        }
        if let Some(name) = request.name {
            entry.name = Some(name);
        }
        if let Some(desc) = request.description {
            entry.description = if desc.is_empty() { None } else { Some(desc) };
        }
        entry.model_type = agent_type;
        if let Some(key) = request.api_key {
            let key = key.trim().to_string();
            entry.api_key = if key.is_empty() { None } else { Some(key) };
        }
        if let Some(token) = request.session_token {
            let token = token.trim().to_string();
            received_oauth_material = !token.is_empty();
            entry.session_token = if token.is_empty() { None } else { Some(token) };
        }
        if let Some(url) = request.base_url {
            entry.base_url = Some(url);
        }
        if let Some(protocol) = request.protocol {
            entry.protocol = match protocol.as_str() {
                "openai" => Some(ProviderProtocol::OpenAi),
                "anthropic" => Some(ProviderProtocol::Anthropic),
                _ => return Err(format!("Unknown provider protocol: {}", protocol)),
            };
        }
        if let Some(env) = request.env_vars {
            received_oauth_material =
                received_oauth_material || env.values().any(|value| !value.trim().is_empty());
            entry.env_vars = env;
        }
        if let Some(metadata) = request.account_metadata {
            entry.account_metadata = metadata;
        }
        if let Some(models) = request.available_models {
            entry.available_models = models;
        }
        if let Some(enabled) = request.enabled_models {
            // Filter out dated snapshot models (containing YYYY-MM-DD pattern)
            entry.enabled_models = filter_dated_models(enabled);
        }
        if let Some(aliases) = request.model_aliases {
            entry.model_aliases = aliases
                .into_iter()
                .map(|a| crate::key_store::ModelAlias {
                    display_name: a.display_name,
                    alias: a.alias,
                    icon: a.icon,
                })
                .collect();
        }
        if let Some(variants) = request.model_variants {
            entry.model_variants = variants.into_iter().map(ModelVariant::from).collect();
        }
        if let Some(default_variants) = request.default_variants {
            entry.default_variants = default_variants
                .into_iter()
                .map(|variant| DefaultVariant {
                    base_model: variant.base_model,
                    model: variant.model,
                })
                .collect();
        }
        if let Some(quota) = request.quota_info {
            entry.quota_info = Some(quota);
        }
        if let Some(local) = request.has_local_key {
            entry.has_local_key = local;
        }
        if let Some(listed) = request.is_listed {
            entry.is_listed = listed;
        }
        if let Some(auth) = request.auth_method {
            entry.auth_method = match auth.as_str() {
                "oauth" => AuthMethod::Oauth,
                _ => AuthMethod::ApiKey,
            };
        }
        if let Some(listing) = request.listing_id {
            entry.listing_id = if listing.is_empty() {
                None
            } else {
                Some(listing)
            };
        }
        if let Some(enabled) = request.enabled {
            entry.enabled = enabled;
            if enabled && entry.auth_method == AuthMethod::Oauth {
                entry.oauth_refresh_failure_count = 0;
                entry.last_oauth_refresh_failed_at = None;
                entry.last_validation_error = None;
                entry.temporary_unavailable_until = None;
                entry.temporary_unavailable_reason = None;
                entry.last_upstream_status = None;
                entry.last_upstream_error_type = None;
                entry.rate_limit_reset_at = None;
                if entry.health_status == HealthStatus::Invalid {
                    entry.health_status = HealthStatus::Unknown;
                }
            }
        }

        // Normalize OAuth keys: only keep session_token, clear api_key.
        // Cursor is the exception: we persist both credentials and let each
        // runtime entry point choose the one it needs.
        if entry.auth_method == AuthMethod::Oauth && entry.model_type != ModelType::CursorCli {
            if entry.api_key.is_some() && entry.session_token.is_none() {
                entry.session_token = entry.api_key.take();
            }
            entry.api_key = None;
        }

        normalize_claude_official_oauth_routing(&mut entry);

        if entry.auth_method == AuthMethod::Oauth && received_oauth_material {
            entry.oauth_refresh_failure_count = 0;
            entry.last_oauth_refresh_failed_at = None;
            entry.last_validation_error = None;
            entry.temporary_unavailable_until = None;
            entry.temporary_unavailable_reason = None;
            entry.last_upstream_status = None;
            entry.last_upstream_error_type = None;
            entry.rate_limit_reset_at = None;
        }

        if entry.model_type == ModelType::CursorCli {
            if let Some(api_key) = entry.api_key.as_deref() {
                if !(api_key.starts_with("key_") || api_key.starts_with("crsr_"))
                    || api_key.len() <= 20
                {
                    return Err("Cursor API key should start with 'key_' or 'crsr_'".to_string());
                }
            }
            let session_token = entry.session_token.as_deref().unwrap_or_default();
            if session_token.is_empty() {
                return Err("Cursor requires a session token before saving".to_string());
            }
            if is_cursor_web_session_token(session_token) {
                return Err(
                    "Cursor web login tokens cannot be used for native chat; please sign in again"
                        .to_string(),
                );
            }
        }

        let saved = KEY_SERVICE.save_key(entry)?;
        let saved_quota_revision = quota_credential_revision(&saved);
        if prior_quota_revision.as_deref() != Some(saved_quota_revision.as_str()) {
            invalidate_key_quota_runtime(&saved.id);
        }
        key_info_from_entry(saved)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_anthropic_endpoint_accepts_empty_and_official_urls() {
        assert!(is_official_anthropic_endpoint(None));
        assert!(is_official_anthropic_endpoint(Some("")));
        assert!(is_official_anthropic_endpoint(Some("  ")));
        assert!(is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com"
        )));
        assert!(is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com/v1"
        )));
        assert!(is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com:443/v1"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://relay.example.com/v1"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "http://api.anthropic.com"
        )));
        // Lookalike hosts must not pass the boundary check.
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com.evil.example/v1"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.community"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com@evil.example/"
        )));
        assert!(!is_official_anthropic_endpoint(Some(
            "https://api.anthropic.com:pass@evil.example/"
        )));
    }

    #[test]
    fn official_claude_oauth_token_requires_oat_prefix() {
        assert!(is_claude_official_oauth_token("sk-ant-oat01-abc"));
        assert!(is_claude_official_oauth_token("  sk-ant-oat01-abc  "));
        assert!(!is_claude_official_oauth_token("sk-ant-api03-abc"));
        assert!(!is_claude_official_oauth_token("sk-relay-key"));
        assert!(!is_claude_official_oauth_token(""));
    }

    fn claude_oauth_entry(token: &str) -> ModelKey {
        let mut entry = ModelKey::new(ModelType::ClaudeCode);
        entry.auth_method = AuthMethod::Oauth;
        entry.session_token = Some(token.to_string());
        entry
    }

    #[test]
    fn official_oauth_save_drops_stale_relay_routing() {
        let mut entry = claude_oauth_entry("sk-ant-oat01-abc");
        entry.base_url = Some("https://relay.example.com/v1".to_string());
        entry.protocol = Some(ProviderProtocol::OpenAi);

        normalize_claude_official_oauth_routing(&mut entry);

        assert_eq!(entry.base_url, None);
        assert_eq!(entry.protocol, None);
    }

    #[test]
    fn official_oauth_save_keeps_explicit_official_base_url() {
        let mut entry = claude_oauth_entry("sk-ant-oat01-abc");
        entry.base_url = Some("https://api.anthropic.com/v1".to_string());

        normalize_claude_official_oauth_routing(&mut entry);

        assert_eq!(
            entry.base_url.as_deref(),
            Some("https://api.anthropic.com/v1")
        );
    }

    #[test]
    fn relay_claude_oauth_save_keeps_relay_routing_untouched() {
        let mut entry = claude_oauth_entry("sk-relay-issued-token");
        entry.base_url = Some("https://relay.example.com/v1".to_string());
        entry.protocol = Some(ProviderProtocol::OpenAi);

        normalize_claude_official_oauth_routing(&mut entry);

        assert_eq!(
            entry.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );
        assert_eq!(entry.protocol, Some(ProviderProtocol::OpenAi));
    }

    #[test]
    fn non_claude_and_api_key_rows_are_never_normalized() {
        let mut api_key_entry = ModelKey::new(ModelType::ClaudeCode);
        api_key_entry.api_key = Some("sk-ant-oat01-misfiled".to_string());
        api_key_entry.base_url = Some("https://relay.example.com/v1".to_string());
        normalize_claude_official_oauth_routing(&mut api_key_entry);
        assert_eq!(
            api_key_entry.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );

        let mut anthropic_entry = ModelKey::new(ModelType::AnthropicApi);
        anthropic_entry.auth_method = AuthMethod::Oauth;
        anthropic_entry.session_token = Some("sk-ant-oat01-abc".to_string());
        anthropic_entry.base_url = Some("https://relay.example.com/v1".to_string());
        normalize_claude_official_oauth_routing(&mut anthropic_entry);
        assert_eq!(
            anthropic_entry.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );
    }
}
