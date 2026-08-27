use super::*;

#[test]
fn revision_is_stable_across_map_insertion_order() {
    let mut first = crate::key_store::ModelKey::new(ModelType::Codex);
    first.env_vars.insert("B".into(), "two".into());
    first.env_vars.insert("A".into(), "one".into());
    let mut second = first.clone();
    second.env_vars.clear();
    second.env_vars.insert("A".into(), "one".into());
    second.env_vars.insert("B".into(), "two".into());

    assert_eq!(
        quota_credential_revision(&first),
        quota_credential_revision(&second)
    );
}

#[test]
fn revision_changes_for_secrets_endpoint_and_quota_scope() {
    let mut key = crate::key_store::ModelKey::new(ModelType::OpenCode);
    key.session_token = Some("cookie-a".into());
    let initial = quota_credential_revision(&key);

    key.session_token = Some("cookie-b".into());
    let changed_secret = quota_credential_revision(&key);
    assert_ne!(initial, changed_secret);

    key.base_url = Some("https://example.test".into());
    let changed_endpoint = quota_credential_revision(&key);
    assert_ne!(changed_secret, changed_endpoint);

    key.account_metadata
        .insert("opencode_workspace_id".into(), "wrk_account".into());
    assert_ne!(changed_endpoint, quota_credential_revision(&key));
}

#[test]
fn revision_ignores_display_only_account_metadata() {
    let mut key = crate::key_store::ModelKey::new(ModelType::ClaudeCode);
    key.session_token = Some("token".into());
    let initial = quota_credential_revision(&key);

    key.name = Some("Renamed account".into());
    key.account_metadata
        .insert("rate_limit_tier".into(), "pro".into());
    assert_eq!(initial, quota_credential_revision(&key));
}

#[test]
fn quota_status_wire_shape_uses_frontend_camel_case() {
    let status = KeyQuotaRefreshStatusInfo {
        key_id: "account".into(),
        generation: 3,
        freshness: "fresh_success".into(),
        cache_expires_at: Some("2026-07-31T00:00:00Z".into()),
        last_good: Some(QuotaInfo::default()),
        last_good_at: Some("2026-07-31T00:00:00Z".into()),
        last_attempt: Some(KeyQuotaRefreshAttemptInfo {
            generation: 3,
            status: "succeeded".into(),
            started_at: "2026-07-31T00:00:00Z".into(),
            finished_at: Some("2026-07-31T00:00:01Z".into()),
            error: None,
        }),
    };
    let wire = serde_json::to_value(status).unwrap();

    assert_eq!(wire["keyId"], "account");
    assert!(wire.get("cacheExpiresAt").is_some());
    assert!(wire.get("lastGoodAt").is_some());
    assert!(wire["lastAttempt"].get("startedAt").is_some());
    assert!(wire.get("key_id").is_none());
}
