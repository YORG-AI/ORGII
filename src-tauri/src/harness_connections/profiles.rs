//! Profile commands resolve credentials only on the backend.
use super::*;
use agent_cli::managed_config::provider_profiles;
use key_vault::harness_connections::{resolve_provider_profile, ConnectionAuthScheme};
use sha2::{Digest, Sha256};

pub(super) fn resolve_profile(
    profile: &HarnessProviderProfile,
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
    let model = profile.models.default_model()?;
    let mut connection = resolve_provider_profile(&profile.target, &key, model, &options)?;
    bind_revision(&mut connection, profile);
    Ok(connection)
}
fn bind_revision(connection: &mut ResolvedHarnessConnection, profile: &HarnessProviderProfile) {
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
    profile: Option<&HarnessProviderProfile>,
) -> Result<ResolvedHarnessConnection, String> {
    if let Some(profile) = profile {
        if profile.target != agent
            || profile.key_id != key
            || options.is_some()
            || profile.models.default_model()? != model
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
    profile: HarnessProviderProfile,
) -> Result<HarnessProviderProfile, String> {
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
            let connection = key_vault::harness_connections::resolve_provider_endpoint(&agent_name, &key, &endpoint, auth_scheme)?;
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
    fn profile() -> HarnessProviderProfile {
        let entry = serde_json::json!({"model":"gateway/model", "displayName":"Friendly", "context1m":false});
        serde_json::from_value(serde_json::json!({"id":"fixture", "revision":1, "name":"Provider", "target":"claude_code", "keyId":"key", "endpoint":"https://gateway.example/prefix", "authScheme":"x-api-key", "models":{"defaultRole":"sonnet", "roles":{"sonnet":entry,"opus":entry,"fable":entry,"haiku":entry}}})).unwrap()
    }
    fn claude_models_mut(
        p: &mut HarnessProviderProfile,
    ) -> &mut agent_cli::managed_config::claude_models::ClaudeModels {
        match &mut p.models {
            agent_cli::managed_config::profile_models::ProfileModels::Claude(m) => m,
            _ => panic!("Expected Claude fixture"),
        }
    }
    #[test]
    fn codex_receipts_cover_reasoning_context_revision_endpoint_and_key() {
        let mut p = profile();
        p.target = "codex".into();
        p.auth_scheme = "bearer".into();
        p.models = serde_json::from_value(serde_json::json!({"model":"vendor/manual", "reasoningEffort":"high", "contextWindow":64000, "autoCompactTokenLimit":50000})).unwrap();
        let mut key = ModelKey::new(ModelType::CustomApi);
        key.id = p.key_id.clone();
        key.api_key = Some("synthetic-key".into());
        key.protocol = Some(ProviderProtocol::OpenAi);
        let fingerprint = |p: &HarnessProviderProfile, key: &ModelKey| {
            p.validate().unwrap();
            let mut c = resolve_provider_profile(
                &p.target,
                key,
                p.models.default_model().unwrap(),
                &DesktopConnectionOptions {
                    endpoint: Some(p.endpoint.clone()),
                    auth_scheme: Some(ConnectionAuthScheme::Bearer),
                },
            )
            .unwrap();
            bind_revision(&mut c, p);
            c.revision
        };
        let first = fingerprint(&p, &key);
        for (field, value) in [
            ("model", serde_json::json!("another/model")),
            ("reasoningEffort", serde_json::json!("low")),
            ("contextWindow", serde_json::json!(65000)),
            ("autoCompactTokenLimit", serde_json::json!(51000)),
        ] {
            let mut json = serde_json::to_value(&p).unwrap();
            json["models"][field] = value;
            assert_ne!(
                first,
                fingerprint(&serde_json::from_value(json).unwrap(), &key)
            );
        }
        let mut changed = p.clone();
        changed.revision += 1;
        assert_ne!(first, fingerprint(&changed, &key));
        changed = p.clone();
        changed.endpoint = "https://other.example/v1".into();
        assert_ne!(first, fingerprint(&changed, &key));
        key.api_key = Some("rotated-synthetic".into());
        assert_ne!(first, fingerprint(&p, &key));
        assert!(selection("claude_code", &p.key_id, "vendor/manual", None, Some(&p)).is_err());
    }
    #[test]
    fn receipts_bind_the_entire_profile_and_credential_not_just_the_default_model() {
        let p = profile();
        let mut key = ModelKey::new(ModelType::CustomApi);
        key.id = p.key_id.clone();
        key.api_key = Some("synthetic-key".into());
        key.protocol = Some(ProviderProtocol::Anthropic);
        let resolve = |p: &HarnessProviderProfile, key: &ModelKey| {
            let options = DesktopConnectionOptions {
                endpoint: Some(p.endpoint.clone()),
                auth_scheme: Some(if p.auth_scheme == "x-api-key" {
                    ConnectionAuthScheme::ApiKey
                } else {
                    ConnectionAuthScheme::Bearer
                }),
            };
            let mut value = resolve_provider_profile(
                &p.target,
                key,
                p.models.default_model().unwrap(),
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
        claude_models_mut(&mut changed)
            .roles
            .get_mut(&agent_cli::managed_config::claude_models::ClaudeRole::Opus)
            .unwrap()
            .model = "different-model".into();
        assert!(require_receipt(&resolve(&changed, &key), Some(&token)).is_err());
        changed = p.clone();
        claude_models_mut(&mut changed)
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
