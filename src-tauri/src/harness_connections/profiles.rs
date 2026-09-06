//! Profile commands resolve credentials only on the backend.
use super::*;
use agent_cli::managed_config::provider_profiles;
use key_vault::harness_connections::{resolve_claude_profile, ConnectionAuthScheme};
use sha2::{Digest, Sha256};

pub(super) fn resolve_profile(
    profile: &ClaudeProviderProfile,
) -> Result<ResolvedHarnessConnection, String> {
    profile.validate()?;
    let key = KEY_SERVICE
        .get_key_by_id(&profile.key_id)
        .ok_or("Selected credential no longer exists")?;
    let options = DesktopConnectionOptions {
        endpoint: Some(profile.endpoint.clone()),
        auth_scheme: Some(if profile.auth_scheme == "x-api-key" {
            ConnectionAuthScheme::ApiKey
        } else {
            ConnectionAuthScheme::Bearer
        }),
    };
    let model = &profile.models.roles[&profile.models.default_role].model;
    let mut connection = resolve_claude_profile(&profile.target, &key, model, &options)?;
    bind_revision(&mut connection, profile);
    Ok(connection)
}
fn bind_revision(connection: &mut ResolvedHarnessConnection, profile: &ClaudeProviderProfile) {
    connection.revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::json!([connection.revision, profile])
                .to_string()
                .as_bytes()
        )
    );
}
pub(super) fn selection(
    agent: &str,
    key: &str,
    model: &str,
    options: Option<&DesktopConnectionOptions>,
    profile: Option<&ClaudeProviderProfile>,
) -> Result<ResolvedHarnessConnection, String> {
    if let Some(profile) = profile {
        if profile.target != agent
            || profile.key_id != key
            || options.is_some()
            || profile
                .models
                .roles
                .get(&profile.models.default_role)
                .map(|m| m.model.as_str())
                != Some(model)
        {
            return Err("Profile and connection selection disagree".into());
        }
        resolve_profile(profile)
    } else {
        selected(agent, key, Some(model), options)
    }
}
#[tauri::command(rename_all = "camelCase")]
pub async fn harness_profile_save(
    profile: ClaudeProviderProfile,
) -> Result<ClaudeProviderProfile, String> {
    tokio::task::spawn_blocking(move || {
        let connection = resolve_profile(&profile)?;
        let mut profile = profile;
        profile.endpoint = connection.base_url;
        provider_profiles::save(profile)
    })
    .await
    .map_err(|_| "Profile save failed")?
}
#[tauri::command(rename_all = "camelCase")]
pub async fn harness_profile_delete(
    agent_name: String,
    id: String,
    revision: u32,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || provider_profiles::delete(&agent_name, &id, revision))
        .await
        .map_err(|_| "Profile deletion failed")?
}
#[tauri::command(rename_all = "camelCase")]
pub async fn harness_profile_models(
    agent_name: String,
    key_id: String,
    endpoint: String,
    auth_scheme: ConnectionAuthScheme,
    request_id: String,
) -> Result<Vec<String>, String> {
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    {
        let mut tests = TESTS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Model discovery unavailable")?;
        if tests.len() >= 4 || tests.contains_key(&request_id) {
            return Err("A connection request is already running".into());
        }
        tests.insert(request_id.clone(), cancel);
    }
    let result = tokio::select! {
        _ = cancelled => Err("Model discovery cancelled".to_string()),
        result = tokio::time::timeout(Duration::from_secs(20), async {
            let key = KEY_SERVICE.get_key_by_id(&key_id).ok_or("Selected credential no longer exists")?;
            let connection = key_vault::harness_connections::resolve_claude_endpoint(&agent_name, &key, &endpoint, auth_scheme)?;
            super::probe::models(&connection).await
        }) => result.unwrap_or_else(|_| Err("Model discovery timed out; enter model IDs manually".into())),
    };
    if let Ok(mut tests) = TESTS.get_or_init(Default::default).lock() {
        tests.remove(&request_id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use key_vault::key_store::{ModelKey, ModelType, ProviderProtocol};
    fn profile() -> ClaudeProviderProfile {
        let entry = serde_json::json!({"model":"gateway/model", "displayName":"Friendly", "context1m":false});
        serde_json::from_value(serde_json::json!({"id":"fixture", "revision":1, "name":"Provider", "target":"claude_code", "keyId":"key", "endpoint":"https://gateway.example/prefix", "authScheme":"x-api-key", "models":{"defaultRole":"sonnet", "roles":{"sonnet":entry,"opus":entry,"fable":entry,"haiku":entry}}})).unwrap()
    }
    #[test]
    fn receipts_bind_the_entire_profile_and_credential_not_just_the_default_model() {
        let p = profile();
        let mut key = ModelKey::new(ModelType::CustomApi);
        key.id = p.key_id.clone();
        key.api_key = Some("synthetic-key".into());
        key.protocol = Some(ProviderProtocol::Anthropic);
        let resolve = |p: &ClaudeProviderProfile, key: &ModelKey| {
            let options = DesktopConnectionOptions {
                endpoint: Some(p.endpoint.clone()),
                auth_scheme: Some(if p.auth_scheme == "x-api-key" {
                    ConnectionAuthScheme::ApiKey
                } else {
                    ConnectionAuthScheme::Bearer
                }),
            };
            let mut value = resolve_claude_profile(
                &p.target,
                key,
                &p.models.roles[&p.models.default_role].model,
                &options,
            )
            .unwrap();
            bind_revision(&mut value, p);
            value
        };
        let first = resolve(&p, &key);
        let token = uuid::Uuid::new_v4().to_string();
        RECEIPTS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(token.clone(), (first.revision.clone(), Instant::now()));
        assert!(require_receipt(&first, Some(&token)).is_ok());
        let mut changed = p.clone();
        changed
            .models
            .roles
            .get_mut(&agent_cli::managed_config::claude_models::ClaudeRole::Opus)
            .unwrap()
            .model = "different-model".into();
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        changed = p.clone();
        changed
            .models
            .roles
            .get_mut(&agent_cli::managed_config::claude_models::ClaudeRole::Sonnet)
            .unwrap()
            .context_1m = true;
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        changed = p.clone();
        changed.target = "claude_desktop".into();
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        changed = p.clone();
        changed.auth_scheme = "bearer".into();
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        changed = p.clone();
        changed.endpoint = "https://other.example".into();
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        changed = p.clone();
        changed.revision += 1;
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        key.api_key = Some("rotated-key".into());
        assert!(require_receipt(&resolve(&p, &key), Some(&token)).is_err());
        RECEIPTS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&token);
    }
    #[test]
    fn mixed_legacy_options_or_different_target_are_rejected_before_credentials_are_read() {
        let p = profile();
        assert!(selection("claude_desktop", "key", "gateway/model", None, Some(&p)).is_err());
        assert!(selection(
            "claude_code",
            "key",
            "gateway/model",
            Some(&DesktopConnectionOptions::default()),
            Some(&p)
        )
        .is_err());
        assert!(selection("claude_code", "other-key", "gateway/model", None, Some(&p)).is_err());
    }
}
