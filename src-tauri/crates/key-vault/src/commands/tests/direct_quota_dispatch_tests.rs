use super::*;

#[tokio::test]
async fn direct_provider_variants_reach_their_stored_key_dispatch_arms() {
    for (model_type, expected_provider, expected_secret) in [
        (ModelType::DeepseekApi, "DeepSeek", "no API key"),
        (ModelType::OpenrouterApi, "OpenRouter", "no API key"),
        (ModelType::MinimaxApi, "MiniMax", "no API key"),
        (ModelType::MoonshotApi, "Kimi Code", "no API key"),
        (ModelType::QoderCli, "Qoder", "no saved cookie or token"),
    ] {
        let key = crate::key_store::ModelKey::new(model_type);
        let error = fetch_quota_for_key(&key).await.unwrap_err();
        assert!(
            error.contains(expected_provider) && error.contains(expected_secret),
            "unexpected dispatch error: {error}"
        );
    }
}

#[tokio::test]
async fn wave_two_providers_reach_validation_time_dispatch_arms() {
    for (agent_type, expected_provider) in [
        ("deepseek_api", "DeepSeek"),
        ("openrouter_api", "OpenRouter"),
        ("minimax_api", "MiniMax"),
    ] {
        let error = fetch_key_quota(agent_type.to_string(), " ".to_string())
            .await
            .unwrap_err();
        assert!(
            error.contains(expected_provider) && error.contains("no API key"),
            "unexpected dispatch error: {error}"
        );
    }
}

#[test]
fn quota_refresh_capability_matches_supported_dispatches() {
    for model_type in [
        ModelType::CursorCli,
        ModelType::Copilot,
        ModelType::OpenCode,
        ModelType::ZhipuApi,
        ModelType::DeepseekApi,
        ModelType::OpenrouterApi,
        ModelType::MinimaxApi,
        ModelType::MoonshotApi,
        ModelType::QoderCli,
    ] {
        let is_kimi_code = model_type == ModelType::MoonshotApi;
        let mut key = crate::key_store::ModelKey::new(model_type);
        key.api_key = Some("api-key".to_string());
        key.session_token = Some("session-token".to_string());
        if is_kimi_code {
            key.base_url = Some("https://api.kimi.com/coding".to_string());
        }
        assert!(key_can_refresh_quota(&key));
    }

    let mut oauth_key = crate::key_store::ModelKey::new(ModelType::ClaudeCode);
    assert!(!key_can_refresh_quota(&oauth_key));
    oauth_key.auth_method = AuthMethod::Oauth;
    assert!(!key_can_refresh_quota(&oauth_key));
    oauth_key.session_token = Some("access-token".to_string());
    assert!(key_can_refresh_quota(&oauth_key));

    assert!(!key_can_refresh_quota(&crate::key_store::ModelKey::new(
        ModelType::AnthropicApi
    )));
}

#[test]
fn zai_team_capability_requires_complete_scope_and_revision_tracks_it() {
    let mut key = crate::key_store::ModelKey::new(ModelType::ZhipuApi);
    key.api_key = Some("api-key".to_string());
    assert!(key_can_refresh_quota(&key));
    assert!(!quota_refresh_uses_strict_request_count(&key));
    let personal_revision = quota_credential_revision(&key);

    key.account_metadata
        .insert(ZAI_TEAM_ORGANIZATION_METADATA_KEY.into(), "org-1".into());
    assert!(!key_can_refresh_quota(&key));
    let partial_revision = quota_credential_revision(&key);
    assert_ne!(personal_revision, partial_revision);

    key.account_metadata
        .insert(ZAI_TEAM_PROJECT_METADATA_KEY.into(), "project-1".into());
    assert!(key_can_refresh_quota(&key));
    assert!(quota_refresh_uses_strict_request_count(&key));
    assert_ne!(partial_revision, quota_credential_revision(&key));
}

#[test]
fn qoder_capability_requires_an_explicit_saved_secret() {
    let mut key = crate::key_store::ModelKey::new(ModelType::QoderCli);
    assert!(!key_can_refresh_quota(&key));
    key.session_token = Some("session=qoder".into());
    assert!(key_can_refresh_quota(&key));
    assert!(quota_refresh_uses_strict_request_count(&key));
    key.base_url = Some("https://example.com".into());
    assert!(!key_can_refresh_quota(&key));
}

#[test]
fn kimi_code_capability_is_fixed_route_and_strict_one_attempt() {
    let mut key = crate::key_store::ModelKey::new(ModelType::MoonshotApi);
    key.api_key = Some("kimi-code-key".into());
    assert!(!key_can_refresh_quota(&key));
    assert!(!quota_refresh_uses_strict_request_count(&key));

    key.base_url = Some("https://api.moonshot.ai/v1".into());
    assert!(!key_can_refresh_quota(&key));
    assert!(!quota_refresh_uses_strict_request_count(&key));

    let ordinary_revision = quota_credential_revision(&key);
    key.base_url = Some("https://api.kimi.com/coding/".into());
    assert!(key_can_refresh_quota(&key));
    assert!(quota_refresh_uses_strict_request_count(&key));
    assert_ne!(ordinary_revision, quota_credential_revision(&key));
}

#[test]
fn stored_cookie_resolution_skips_blank_preferred_values() {
    assert_eq!(
        first_non_empty_secret(Some("  "), Some(" fallback-cookie ")),
        Some("fallback-cookie")
    );
    assert_eq!(
        first_non_empty_secret(Some(" preferred-cookie "), Some("fallback-cookie")),
        Some("preferred-cookie")
    );
    assert_eq!(first_non_empty_secret(Some(" "), None), None);
}
