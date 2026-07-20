use crate::key_store::{
    AuthMethod, CliOAuthTokenSync, CliOAuthTokenSyncOutcome, HealthStatus, KeyService, KeyStore,
    ModelKey, ModelType, KEY_SERVICE,
};
use chrono::{TimeZone, Utc};
use std::collections::HashMap;
use tempfile::tempdir;

#[test]
fn test_agent_type_conversion() {
    assert_eq!(
        ModelType::from_str("cursor_cli"),
        Some(ModelType::CursorCli)
    );
    assert_eq!(ModelType::from_str("cursor"), Some(ModelType::CursorCli));
    assert_eq!(
        ModelType::from_str("claude_code"),
        Some(ModelType::ClaudeCode)
    );
    assert_eq!(ModelType::from_str("copilot"), Some(ModelType::Copilot));
    assert_eq!(ModelType::from_str("unknown"), None);
}

#[test]
fn test_key_crud() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    // Create
    let mut cred = ModelKey::new(ModelType::CursorCli);
    cred.name = Some("Test Cursor".to_string());
    cred.api_key = Some("key_test123".to_string());

    let saved = service.save_key(cred.clone()).unwrap();
    assert_eq!(saved.name, Some("Test Cursor".to_string()));

    // Read
    let loaded = service.get_key(&ModelType::CursorCli, None).unwrap();
    assert_eq!(loaded.api_key, Some("key_test123".to_string()));

    // List
    let all = service.list_keys();
    assert_eq!(all.len(), 1);

    // Update
    let mut updated = loaded.clone();
    updated.api_key = Some("key_updated".to_string());
    service.save_key(updated).unwrap();

    let reloaded = service.get_key_by_id(&loaded.id).unwrap();
    assert_eq!(reloaded.api_key, Some("key_updated".to_string()));

    // Delete
    let deleted = service.delete_key(&ModelType::CursorCli, None).unwrap();
    assert!(deleted);

    let empty = service.list_keys();
    assert_eq!(empty.len(), 0);
}

#[test]
fn retired_gemini_cli_credentials_do_not_corrupt_the_vault() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let codex_key = ModelKey::new(ModelType::Codex);
    let codex_id = codex_key.id.clone();
    service.save_key(codex_key).unwrap();

    let storage_file = temp_dir.path().join("credentials.json");
    let mut stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&storage_file).unwrap()).unwrap();
    let credentials = stored
        .get_mut("credentials")
        .and_then(serde_json::Value::as_object_mut)
        .unwrap();
    let mut retired = credentials.get(&codex_id).unwrap().clone();
    retired["id"] = serde_json::Value::String("retired-gemini-cli".to_string());
    retired["agent_type"] = serde_json::Value::String("gemini_cli".to_string());
    credentials.insert("retired-gemini-cli".to_string(), retired);
    std::fs::write(&storage_file, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();

    let keys = service.list_keys();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].model_type, ModelType::Codex);

    service
        .save_key(ModelKey::new(ModelType::AnthropicApi))
        .unwrap();
    let persisted = std::fs::read_to_string(storage_file).unwrap();
    assert!(!persisted.contains("gemini_cli"));
}

#[test]
fn invalid_credential_does_not_hide_valid_siblings_and_survives_writes() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let codex_key = ModelKey::new(ModelType::Codex);
    let codex_id = codex_key.id.clone();
    service.save_key(codex_key).unwrap();

    let storage_file = temp_dir.path().join("credentials.json");
    let mut stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&storage_file).unwrap()).unwrap();
    let credentials = stored
        .get_mut("credentials")
        .and_then(serde_json::Value::as_object_mut)
        .unwrap();
    let mut future_credential = credentials.get(&codex_id).unwrap().clone();
    future_credential["id"] = serde_json::Value::String("future-account".to_string());
    future_credential["agent_type"] = serde_json::Value::String("future_provider".to_string());
    credentials.insert("future-account".to_string(), future_credential.clone());
    std::fs::write(&storage_file, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();

    let keys = service.list_keys_checked().unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].model_type, ModelType::Codex);
    assert!(service
        .get_key_checked(&ModelType::Codex, Some(&codex_id))
        .unwrap()
        .is_some());
    let invalid_error = service.get_key_by_id_checked("future-account").unwrap_err();
    assert!(invalid_error.contains("is invalid and was preserved"));

    service
        .save_key(ModelKey::new(ModelType::AnthropicApi))
        .unwrap();
    let persisted: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(storage_file).unwrap()).unwrap();
    assert_eq!(
        persisted["credentials"]["future-account"],
        future_credential
    );
    assert_eq!(
        persisted["credentials"].as_object().unwrap().len(),
        3,
        "two valid credentials plus the preserved future credential"
    );
}

#[test]
fn checked_list_reports_when_every_credential_is_invalid() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let key = service.save_key(ModelKey::new(ModelType::Codex)).unwrap();
    let storage_file = temp_dir.path().join("credentials.json");
    let mut stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&storage_file).unwrap()).unwrap();
    stored["credentials"][&key.id]["agent_type"] =
        serde_json::Value::String("future_provider".to_string());
    std::fs::write(&storage_file, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();

    let error = service.list_keys_checked().unwrap_err();
    assert!(error.contains("No valid credentials could be loaded"));
    assert!(error.contains("1 invalid credential(s) were preserved"));
}

#[test]
fn checked_list_reports_malformed_root_json() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));
    std::fs::write(temp_dir.path().join("credentials.json"), "{").unwrap();

    let error = service.list_keys_checked().unwrap_err();
    assert!(error.contains("Corrupted credentials file"));
}

#[test]
fn test_mask_api_key() {
    let mut cred = ModelKey::new(ModelType::CursorCli);
    cred.api_key = Some("key_1234567890abcdef".to_string());

    assert_eq!(
        cred.mask_api_key(),
        Some("key_************cdef".to_string())
    );

    cred.api_key = Some("short".to_string());
    assert_eq!(cred.mask_api_key(), Some("*****".to_string()));
}

/// E2E test using real credentials file
#[test]
fn test_e2e_with_real_keys() {
    println!("\n=== E2E Test: Rust Key Store ===\n");

    // Use the global service (reads ~/.orgii/credentials.json)
    let service = &KEY_SERVICE;

    // 1. List all keys
    let all_creds = service.list_keys();
    println!("1. List all credentials: {} found", all_creds.len());
    for cred in &all_creds {
        println!(
            "   - [{}] {} ({}) - health: {:?}",
            cred.id,
            cred.name.as_deref().unwrap_or("unnamed"),
            cred.model_type.as_str(),
            cred.health_status
        );
    }

    // 2. Get credentials by agent type
    println!("\n2. Get by agent type:");
    for agent_type in &[
        ModelType::CursorCli,
        ModelType::ClaudeCode,
        ModelType::Codex,
        ModelType::Copilot,
    ] {
        let creds = service.get_all_keys_for_agent(agent_type);
        if !creds.is_empty() {
            println!("   {} - {} credential(s)", agent_type.as_str(), creds.len());
        }
    }

    // 3. Test get by ID (using first credential if available)
    if let Some(first) = all_creds.first() {
        println!("\n3. Get by ID: {}", first.id);
        let by_id = service.get_key_by_id(&first.id);
        assert!(by_id.is_some());
        println!("   Found: {:?}", by_id.as_ref().map(|c| c.name.clone()));
    }

    // 4. Test env var generation
    println!("\n4. Get env vars for agents:");
    for agent_type in &[ModelType::CursorCli, ModelType::ClaudeCode] {
        let env = service.get_env_for_agent(agent_type, None);
        if !env.is_empty() {
            println!(
                "   {} env vars: {:?}",
                agent_type.as_str(),
                env.keys().collect::<Vec<_>>()
            );
        }
    }

    // 5. Test create/update/delete (in temp location to not affect real data)
    println!("\n5. CRUD operations (temp storage):");
    let temp_dir = tempdir().unwrap();
    let temp_service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    // Create
    let mut new_cred = ModelKey::new(ModelType::Copilot);
    new_cred.name = Some("E2E Test Copilot".to_string());
    new_cred.api_key = Some("ghp_test123456789".to_string());
    new_cred.health_status = HealthStatus::Unknown;

    let saved = temp_service.save_key(new_cred).unwrap();
    println!(
        "   Created: {} (id={})",
        saved.name.as_deref().unwrap(),
        saved.id
    );

    // Update health
    let updated = temp_service
        .update_key_health(
            &saved.id,
            HealthStatus::Valid,
            None,
            Some(vec!["gpt-4".to_string(), "gpt-3.5-turbo".to_string()]),
            None,
            None,
            None,
        )
        .unwrap();
    println!(
        "   Updated health: {:?}",
        updated.as_ref().map(|c| c.health_status.clone())
    );

    // Delete
    let deleted = temp_service.delete_key_by_id(&saved.id).unwrap();
    println!("   Deleted: {}", deleted);

    // Verify empty
    let remaining = temp_service.list_keys();
    assert_eq!(remaining.len(), 0);
    println!("   Verified: storage is empty");

    println!("\n=== E2E Test Complete ===\n");
}

/// `update_key_health` writes provider-reported context windows onto
/// `model_variants`; a subsequent `save_key` (e.g. the user editing an
/// unrelated field) must preserve them. Regression guard for the
/// account-aware context-window feature.
#[test]
fn test_context_window_survives_save_key_roundtrip() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut cred = ModelKey::new(ModelType::OpenaiApi);
    cred.name = Some("Ctx Test".to_string());
    cred.api_key = Some("sk-test".to_string());
    let saved = service.save_key(cred).unwrap();

    // Provider's /v1/models reports a context window for this account.
    let mut contexts = HashMap::new();
    contexts.insert("gpt-4o".to_string(), 128_000u64);
    service
        .update_key_health(
            &saved.id,
            HealthStatus::Valid,
            None,
            Some(vec!["gpt-4o".to_string()]),
            None,
            None,
            Some(&contexts),
        )
        .unwrap();

    let loaded = service.get_key_by_id(&saved.id).unwrap();
    let variant = loaded
        .model_variants
        .iter()
        .find(|v| v.model == "gpt-4o")
        .expect("gpt-4o variant written by update_key_health");
    assert_eq!(variant.context_window, Some(128_000));

    // Round-trip through save_key with the entry as-is.
    service.save_key(loaded).unwrap();
    let reloaded = service.get_key_by_id(&saved.id).unwrap();
    let variant_after = reloaded
        .model_variants
        .iter()
        .find(|v| v.model == "gpt-4o")
        .unwrap();
    assert_eq!(
        variant_after.context_window,
        Some(128_000),
        "save_key must not erase provider-reported context_window"
    );
}

#[test]
fn test_update_key_health_clears_stale_context_window_when_provider_omits_it() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut cred = ModelKey::new(ModelType::OpenaiApi);
    cred.name = Some("Ctx Clear Test".to_string());
    cred.api_key = Some("sk-test".to_string());
    let saved = service.save_key(cred).unwrap();

    let mut contexts = HashMap::new();
    contexts.insert("gpt-4o".to_string(), 128_000u64);
    service
        .update_key_health(
            &saved.id,
            HealthStatus::Valid,
            None,
            Some(vec!["gpt-4o".to_string()]),
            None,
            None,
            Some(&contexts),
        )
        .unwrap();

    service
        .update_key_health(
            &saved.id,
            HealthStatus::Valid,
            None,
            Some(vec!["gpt-4o".to_string()]),
            None,
            None,
            Some(&HashMap::new()),
        )
        .unwrap();

    let loaded = service.get_key_by_id(&saved.id).unwrap();
    let variant = loaded
        .model_variants
        .iter()
        .find(|v| v.model == "gpt-4o")
        .expect("variant remains for reasoning/default metadata");
    assert_eq!(
        variant.context_window, None,
        "missing context_length in a fresh provider response must clear stale override"
    );
}

#[test]
fn test_update_key_health_preserves_context_window_without_model_refresh() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut cred = ModelKey::new(ModelType::OpenaiApi);
    cred.name = Some("Ctx Preserve Test".to_string());
    cred.api_key = Some("sk-test".to_string());
    let saved = service.save_key(cred).unwrap();

    let mut contexts = HashMap::new();
    contexts.insert("gpt-4o".to_string(), 128_000u64);
    service
        .update_key_health(
            &saved.id,
            HealthStatus::Valid,
            None,
            Some(vec!["gpt-4o".to_string()]),
            None,
            None,
            Some(&contexts),
        )
        .unwrap();

    service
        .update_key_health(
            &saved.id,
            HealthStatus::Valid,
            None,
            None,
            None,
            None,
            Some(&HashMap::new()),
        )
        .unwrap();

    let loaded = service.get_key_by_id(&saved.id).unwrap();
    let variant = loaded
        .model_variants
        .iter()
        .find(|v| v.model == "gpt-4o")
        .expect("variant remains after health-only update");
    assert_eq!(
        variant.context_window,
        Some(128_000),
        "health-only updates must not clear provider context_window overrides"
    );
}

/// E2E coverage for the same tolerant loader used by the Tauri `list_keys`
/// command. Never print raw file contents: they contain live secrets.
#[test]
fn test_parse_real_credentials_file() {
    let creds_path = app_paths::keys();

    if !creds_path.exists() {
        println!("Credentials file not found at {:?}, skipping", creds_path);
        return;
    }

    println!("\n=== Parsing Real Credentials File ===\n");
    println!("Path: {:?}", creds_path);

    let keys = KEY_SERVICE
        .list_keys_checked()
        .expect("production Key Vault loader should read real credentials");
    println!("SUCCESS: Parsed {} valid keys", keys.len());

    println!("\n=== Parse Test Complete ===\n");
}

// --- get_proxy_env_for_agent + store + ModelType helpers ---

const PROXY_TEST_TOKEN: &str = "test_token";
const PROXY_TEST_URL: &str = "https://proxy.example.com";

fn assert_common_proxy_env(env: &HashMap<String, String>) {
    assert_eq!(
        env.get("ORGII_PROXY_TOKEN").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert_eq!(
        env.get("ORGII_PROXY_URL").map(|value| value.as_str()),
        Some(PROXY_TEST_URL)
    );
    assert_eq!(env.get("CI").map(|value| value.as_str()), Some("true"));
}

#[test]
fn test_proxy_env_cursor_cli() {
    let env = KeyService::get_proxy_env_for_agent(
        &ModelType::CursorCli,
        PROXY_TEST_TOKEN,
        PROXY_TEST_URL,
    );
    assert_common_proxy_env(&env);
    assert_eq!(
        env.get("CURSOR_API_KEY").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
}

#[test]
fn test_cursor_cli_token_only_env_uses_session_token_without_api_key() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));
    let mut key = ModelKey::new(ModelType::CursorCli);
    key.auth_method = AuthMethod::Oauth;
    key.api_key = None;
    key.session_token = Some("cursor-session-token".to_string());
    key.enabled = true;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let env = service.get_env_for_agent(&ModelType::CursorCli, Some(&key_id));
    assert_eq!(
        env.get("CURSOR_SESSION_TOKEN").map(|value| value.as_str()),
        Some("cursor-session-token")
    );
    assert!(!env.contains_key("CURSOR_API_KEY"));
}

#[test]
fn test_proxy_env_claude_code() {
    let env = KeyService::get_proxy_env_for_agent(
        &ModelType::ClaudeCode,
        PROXY_TEST_TOKEN,
        PROXY_TEST_URL,
    );
    assert_common_proxy_env(&env);
    assert_eq!(
        env.get("ANTHROPIC_AUTH_TOKEN").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert_eq!(
        env.get("ANTHROPIC_BASE_URL").map(|value| value.as_str()),
        Some(PROXY_TEST_URL)
    );
}

#[test]
fn test_proxy_env_codex() {
    let env =
        KeyService::get_proxy_env_for_agent(&ModelType::Codex, PROXY_TEST_TOKEN, PROXY_TEST_URL);
    assert_common_proxy_env(&env);
    assert_eq!(
        env.get("OPENAI_API_KEY").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert_eq!(
        env.get("PROXY_TOKEN").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert!(!env.contains_key("OPENAI_BASE_URL"));
}

#[test]
fn test_proxy_env_copilot() {
    let env =
        KeyService::get_proxy_env_for_agent(&ModelType::Copilot, PROXY_TEST_TOKEN, PROXY_TEST_URL);
    assert_common_proxy_env(&env);
    assert_eq!(
        env.get("COPILOT_GITHUB_TOKEN").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert!(!env.contains_key("GH_TOKEN"));
    assert!(!env.contains_key("GITHUB_TOKEN"));
}

#[test]
fn test_proxy_env_kiro() {
    let env =
        KeyService::get_proxy_env_for_agent(&ModelType::Kiro, PROXY_TEST_TOKEN, PROXY_TEST_URL);
    assert_common_proxy_env(&env);
    assert_eq!(
        env.get("KIRO_ACCESS_TOKEN").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert_eq!(
        env.get("KIRO_REFRESH_TOKEN").map(|value| value.as_str()),
        Some("proxy_managed")
    );
}

#[test]
fn test_proxy_env_anthropic_api() {
    let env = KeyService::get_proxy_env_for_agent(
        &ModelType::AnthropicApi,
        PROXY_TEST_TOKEN,
        PROXY_TEST_URL,
    );
    assert_common_proxy_env(&env);
    assert_eq!(
        env.get("ANTHROPIC_API_KEY").map(|value| value.as_str()),
        Some(PROXY_TEST_TOKEN)
    );
    assert_eq!(
        env.get("ANTHROPIC_BASE_URL").map(|value| value.as_str()),
        Some(PROXY_TEST_URL)
    );
}

#[test]
fn test_store_get_with_key_id() {
    let mut store = KeyStore::default();
    let mut first = ModelKey::new(ModelType::CursorCli);
    first.name = Some("First".to_string());
    let first_id = first.id.clone();
    let mut second = ModelKey::new(ModelType::CursorCli);
    second.name = Some("Second".to_string());
    let second_id = second.id.clone();

    store.set(first);
    store.set(second);

    assert_eq!(
        store
            .get(&ModelType::CursorCli, Some(&first_id))
            .and_then(|credential| credential.name.as_deref()),
        Some("First")
    );
    assert_eq!(
        store
            .get(&ModelType::CursorCli, Some(&second_id))
            .and_then(|credential| credential.name.as_deref()),
        Some("Second")
    );
}

#[test]
fn test_store_delete_with_key_id() {
    let mut store = KeyStore::default();
    let mut first = ModelKey::new(ModelType::Codex);
    first.name = Some("Keep".to_string());
    let first_id = first.id.clone();
    let mut second = ModelKey::new(ModelType::Codex);
    second.name = Some("Remove".to_string());
    let second_id = second.id.clone();

    store.set(first);
    store.set(second);

    assert!(store.delete(&ModelType::Codex, Some(&second_id)));

    assert!(store.get_by_id(&second_id).is_none());
    let remaining = store.get(&ModelType::Codex, Some(&first_id)).unwrap();
    assert_eq!(remaining.name.as_deref(), Some("Keep"));
    assert_eq!(store.get_all(&ModelType::Codex).len(), 1);
}

#[test]
fn test_store_get_no_id_returns_oldest() {
    let mut store = KeyStore::default();
    let mut older = ModelKey::new(ModelType::OpenaiApi);
    older.created_at = Utc.with_ymd_and_hms(2020, 6, 1, 12, 0, 0).unwrap();
    older.name = Some("Oldest".to_string());
    let older_id = older.id.clone();

    let mut newer = ModelKey::new(ModelType::OpenaiApi);
    newer.created_at = Utc.with_ymd_and_hms(2024, 1, 15, 8, 30, 0).unwrap();
    newer.name = Some("Newer".to_string());

    store.set(newer);
    store.set(older.clone());

    let picked = store
        .get(&ModelType::OpenaiApi, None)
        .expect("expected a credential");
    assert_eq!(picked.id, older_id);
    assert_eq!(picked.name.as_deref(), Some("Oldest"));
}

#[test]
fn test_agent_type_classification() {
    let cli_cursor = ModelType::CursorCli;
    assert!(cli_cursor.is_cli_agent());
    assert!(!cli_cursor.is_api_key_provider());
    assert!(cli_cursor.needs_mitm_proxy());

    let cli_codex = ModelType::Codex;
    assert!(cli_codex.is_cli_agent());
    assert!(!cli_codex.is_api_key_provider());
    assert!(!cli_codex.needs_mitm_proxy());

    let cli_claude = ModelType::ClaudeCode;
    assert!(cli_claude.is_cli_agent());
    assert!(!cli_claude.is_api_key_provider());
    assert!(!cli_claude.needs_mitm_proxy());

    let cli_copilot = ModelType::Copilot;
    assert!(cli_copilot.is_cli_agent());
    assert!(!cli_copilot.is_api_key_provider());
    assert!(cli_copilot.needs_mitm_proxy());

    let api_anthropic = ModelType::AnthropicApi;
    assert!(!api_anthropic.is_cli_agent());
    assert!(api_anthropic.is_api_key_provider());
    assert!(!api_anthropic.needs_mitm_proxy());

    let api_openai = ModelType::OpenaiApi;
    assert!(!api_openai.is_cli_agent());
    assert!(api_openai.is_api_key_provider());
    assert!(!api_openai.needs_mitm_proxy());
}

#[test]
fn test_claude_code_oauth_env_uses_auth_token_without_exporting_refresh_token() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut claude_key = ModelKey::new(ModelType::ClaudeCode);
    claude_key.auth_method = AuthMethod::Oauth;
    claude_key.session_token = Some("oauth-session-token".to_string());
    claude_key.api_key = Some("sk-should-not-export".to_string());
    claude_key.env_vars.insert(
        "CLAUDE_CODE_REFRESH_TOKEN".to_string(),
        "oauth-refresh-token".to_string(),
    );
    let key_id = claude_key.id.clone();
    service.save_key(claude_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_AUTH_TOKEN").map(|v| v.as_str()),
        Some("oauth-session-token"),
    );
    assert!(!env.contains_key("CLAUDE_CODE_OAUTH_REFRESH_TOKEN"));
    assert!(!env.contains_key("CLAUDE_CODE_OAUTH_SCOPES"));
    assert!(!env.contains_key("ANTHROPIC_API_KEY"));
}

#[test]
fn test_claude_code_official_oauth_env_drops_stale_relay_base_url() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    // A row persisted before save_key normalized routing: official OAuth
    // token + relay base_url left behind by an earlier relay configuration
    // (issue #276). The env export must not send the OAuth token there.
    let mut claude_key = ModelKey::new(ModelType::ClaudeCode);
    claude_key.auth_method = AuthMethod::Oauth;
    claude_key.session_token = Some("sk-ant-oat01-abc".to_string());
    claude_key.base_url = Some("https://relay.example.com/v1".to_string());
    claude_key.env_vars.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        "https://relay.example.com/v1".to_string(),
    );
    let key_id = claude_key.id.clone();
    service.save_key(claude_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_AUTH_TOKEN").map(|v| v.as_str()),
        Some("sk-ant-oat01-abc"),
    );
    assert!(!env.contains_key("ANTHROPIC_BASE_URL"));
}

#[test]
fn test_claude_code_relay_oauth_env_keeps_relay_base_url() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    // Relay-issued token (not sk-ant-oat): the relay base_url is the
    // account's real endpoint and must keep flowing to the CLI unchanged.
    let mut claude_key = ModelKey::new(ModelType::ClaudeCode);
    claude_key.auth_method = AuthMethod::Oauth;
    claude_key.session_token = Some("sk-relay-issued-token".to_string());
    claude_key.base_url = Some("https://relay.example.com/v1".to_string());
    let key_id = claude_key.id.clone();
    service.save_key(claude_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_AUTH_TOKEN").map(|v| v.as_str()),
        Some("sk-relay-issued-token"),
    );
    assert_eq!(
        env.get("ANTHROPIC_BASE_URL").map(|v| v.as_str()),
        Some("https://relay.example.com/v1"),
    );
}

#[test]
fn test_codex_cli_oauth_sync_does_not_overwrite_newer_key_vault_token() {
    use core_types::providers::CODEX_REFRESH_TOKEN_ENV_KEY;

    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::Codex);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("newer-key-vault-access".to_string());
    key.env_vars.insert(
        CODEX_REFRESH_TOKEN_ENV_KEY.to_string(),
        "newer-key-vault-refresh".to_string(),
    );
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let outcome = service
        .sync_cli_oauth_tokens_if_current(
            &key_id,
            ModelType::Codex,
            Some("launched-access"),
            CliOAuthTokenSync {
                access_token: Some("cli-access".to_string()),
                refresh_token: Some("cli-refresh".to_string()),
                id_token: Some("cli-id".to_string()),
            },
        )
        .unwrap();

    assert!(matches!(
        outcome,
        CliOAuthTokenSyncOutcome::SkippedNewerKeyVaultToken
    ));
    let stored = service.get_key_by_id(&key_id).unwrap();
    assert_eq!(
        stored.session_token.as_deref(),
        Some("newer-key-vault-access")
    );
    assert_eq!(
        stored
            .env_vars
            .get(CODEX_REFRESH_TOKEN_ENV_KEY)
            .map(|value| value.as_str()),
        Some("newer-key-vault-refresh")
    );
}

#[tokio::test]
async fn test_claude_concurrent_refreshes_once_without_consuming_rotating_token_twice() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let token_url = format!("http://{}/token", listener.local_addr().unwrap());
    let request_count = Arc::new(AtomicUsize::new(0));
    let server_request_count = Arc::clone(&request_count);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        server_request_count.fetch_add(1, Ordering::SeqCst);
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request_text = String::from_utf8_lossy(&buffer[..bytes_read]);
        let normalized_request_text = request_text.to_lowercase();
        assert!(normalized_request_text.contains("user-agent: claude-cli/1.0.56 (external, cli)"));
        assert!(normalized_request_text.contains("origin: https://claude.ai"));
        assert!(!normalized_request_text.contains("scope"));
        thread::sleep(Duration::from_millis(150));
        let body = r#"{"access_token":"fresh-claude-access","refresh_token":"fresh-claude-refresh","expires_in":28800}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
    });

    std::env::set_var("CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE", token_url);
    let temp_dir = tempdir().unwrap();
    let service = Arc::new(KeyService::new(Some(temp_dir.path().to_path_buf())));

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("expired-claude-access".to_string());
    key.env_vars.insert(
        "CLAUDE_CODE_REFRESH_TOKEN".to_string(),
        "old-claude-refresh".to_string(),
    );
    key.env_vars
        .insert("CLAUDE_CODE_EXPIRES_AT".to_string(), "0".to_string());
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let first_service = Arc::clone(&service);
    let second_service = Arc::clone(&service);
    let first_key_id = key_id.clone();
    let second_key_id = key_id.clone();
    let (first, second) = tokio::time::timeout(Duration::from_secs(3), async move {
        tokio::join!(
            first_service.refresh_claude_code_oauth_key(&first_key_id, "expired-claude-access",),
            second_service.refresh_claude_code_oauth_key(&second_key_id, "expired-claude-access",),
        )
    })
    .await
    .expect("Claude concurrent refresh should not deadlock");

    std::env::remove_var("CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE");
    server.join().unwrap();

    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(first.session_token.as_deref(), Some("fresh-claude-access"));
    assert_eq!(second.session_token.as_deref(), Some("fresh-claude-access"));
    assert_eq!(
        first
            .env_vars
            .get("CLAUDE_CODE_REFRESH_TOKEN")
            .map(|value| value.as_str()),
        Some("fresh-claude-refresh"),
    );
}

#[tokio::test]
async fn test_codex_refresh_uses_form_body_and_concurrent_refreshes_once() {
    use core_types::providers::CODEX_REFRESH_TOKEN_ENV_KEY;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let token_url = format!("http://{}/token", listener.local_addr().unwrap());
    let request_count = Arc::new(AtomicUsize::new(0));
    let server_request_count = Arc::clone(&request_count);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        server_request_count.fetch_add(1, Ordering::SeqCst);
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request_text = String::from_utf8_lossy(&buffer[..bytes_read]);
        let normalized_request_text = request_text.to_lowercase();
        assert!(normalized_request_text.contains("content-type: application/x-www-form-urlencoded"));
        assert!(request_text.contains("grant_type=refresh_token"));
        assert!(request_text.contains("refresh_token=old-codex-refresh"));
        assert!(request_text.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(!normalized_request_text.contains("application/json"));
        thread::sleep(Duration::from_millis(150));
        let body = r#"{"access_token":"fresh-codex-access","refresh_token":"fresh-codex-refresh","id_token":"fresh-codex-id"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
    });

    std::env::set_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE", token_url);
    let temp_dir = tempdir().unwrap();
    let service = Arc::new(KeyService::new(Some(temp_dir.path().to_path_buf())));

    let mut key = ModelKey::new(ModelType::Codex);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("expired-codex-access".to_string());
    key.env_vars.insert(
        CODEX_REFRESH_TOKEN_ENV_KEY.to_string(),
        "old-codex-refresh".to_string(),
    );
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let first_service = Arc::clone(&service);
    let second_service = Arc::clone(&service);
    let first_key_id = key_id.clone();
    let second_key_id = key_id.clone();
    let (first, second) = tokio::time::timeout(Duration::from_secs(3), async move {
        tokio::join!(
            first_service.refresh_codex_oauth_key(&first_key_id, "expired-codex-access",),
            second_service.refresh_codex_oauth_key(&second_key_id, "expired-codex-access",),
        )
    })
    .await
    .expect("Codex concurrent refresh should not deadlock");

    std::env::remove_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE");
    server.join().unwrap();

    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(first.session_token.as_deref(), Some("fresh-codex-access"));
    assert_eq!(second.session_token.as_deref(), Some("fresh-codex-access"));
    assert_eq!(
        first
            .env_vars
            .get(CODEX_REFRESH_TOKEN_ENV_KEY)
            .map(|value| value.as_str()),
        Some("fresh-codex-refresh"),
    );
}

#[test]
fn test_claude_oauth_refresh_failures_cool_down_without_disabling_key() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let first = service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap()
        .unwrap();
    assert_eq!(first.oauth_refresh_failure_count, 1);
    assert_eq!(first.health_status, HealthStatus::Degraded);
    assert!(first.enabled);
    assert!(first.temporary_unavailable_until.is_some());

    service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap();
    let third = service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap()
        .unwrap();

    assert_eq!(third.oauth_refresh_failure_count, 3);
    assert_eq!(third.health_status, HealthStatus::Degraded);
    assert!(third.enabled);
    assert!(third.last_oauth_refresh_failed_at.is_some());
    assert!(service.is_key_temporarily_unavailable(&third));
}

#[test]
fn test_non_claude_oauth_refresh_failures_disable_key_after_threshold() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::Codex);
    key.auth_method = AuthMethod::Oauth;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap();
    service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap();
    let third = service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap()
        .unwrap();

    assert_eq!(third.oauth_refresh_failure_count, 3);
    assert_eq!(third.health_status, HealthStatus::Invalid);
    assert!(!third.enabled);
    assert!(third.last_oauth_refresh_failed_at.is_some());
}

#[test]
fn test_claude_oauth_upstream_401_marks_temporary_unavailable() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let marked = service
        .mark_claude_oauth_upstream_health(
            &key_id,
            401,
            "auth_error",
            Some("Invalid authentication credentials"),
            None,
        )
        .unwrap()
        .unwrap();

    assert!(marked.enabled);
    assert_eq!(marked.health_status, HealthStatus::Degraded);
    assert_eq!(marked.last_upstream_status, Some(401));
    assert_eq!(
        marked.last_upstream_error_type.as_deref(),
        Some("auth_error")
    );
    assert!(service.is_key_temporarily_unavailable(&marked));

    let cleared = service
        .clear_claude_oauth_upstream_health(&key_id)
        .unwrap()
        .unwrap();
    assert_eq!(cleared.temporary_unavailable_until, None);
    assert_eq!(cleared.temporary_unavailable_reason, None);
    assert_eq!(cleared.rate_limit_reset_at, None);
}

#[test]
fn test_permanent_oauth_refresh_failure_disables_key_immediately() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let disabled = service
        .record_oauth_refresh_failure(
            &key_id,
            "Claude Code OAuth refresh failed with HTTP 400 Bad Request: Refresh token not found or invalid",
        )
        .unwrap()
        .unwrap();

    assert_eq!(disabled.oauth_refresh_failure_count, 1);
    assert_eq!(disabled.health_status, HealthStatus::Invalid);
    assert!(!disabled.enabled);
    assert!(disabled.last_oauth_refresh_failed_at.is_some());
}

#[test]
fn test_oauth_refresh_reset_clears_failure_state_without_reenabling_key() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::Codex);
    key.auth_method = AuthMethod::Oauth;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap();
    service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap();
    let disabled = service
        .record_oauth_refresh_failure(&key_id, "temporary network timeout")
        .unwrap()
        .unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.health_status, HealthStatus::Invalid);

    service.reset_oauth_refresh_failures(&key_id).unwrap();

    let reset = service.get_key_by_id(&key_id).unwrap();
    assert!(!reset.enabled);
    assert_eq!(reset.oauth_refresh_failure_count, 0);
    assert!(reset.last_oauth_refresh_failed_at.is_none());
    assert!(reset.last_validation_error.is_none());
    assert_eq!(reset.health_status, HealthStatus::Unknown);
}

#[test]
fn test_cross_type_env_moonshot_as_claude_code() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut moonshot_key = ModelKey::new(ModelType::MoonshotApi);
    moonshot_key.api_key = Some("sk-kimi-test123".to_string());
    moonshot_key.base_url = Some("https://api.kimi.com/coding/".to_string());
    let key_id = moonshot_key.id.clone();
    service.save_key(moonshot_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_API_KEY").map(|v| v.as_str()),
        Some("sk-kimi-test123"),
    );
    assert_eq!(
        env.get("ANTHROPIC_BASE_URL").map(|v| v.as_str()),
        Some("https://api.kimi.com/coding/"),
    );
    // Model override vars must be set for cross-type keys so Claude Code
    // doesn't reject "kimi-for-coding" during its built-in model validation.
    assert_eq!(
        env.get("ANTHROPIC_MODEL").map(|v| v.as_str()),
        Some("kimi-for-coding"),
    );
    assert_eq!(
        env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")
            .map(|v| v.as_str()),
        Some("kimi-for-coding"),
    );
    assert_eq!(
        env.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
            .map(|v| v.as_str()),
        Some("1"),
    );
    assert!(!env.contains_key("MOONSHOT_API_KEY"));
}

#[test]
fn test_cross_type_env_zenmux_as_claude_code_uses_anthropic_endpoint() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut zenmux_key = ModelKey::new(ModelType::ZenmuxApi);
    zenmux_key.api_key = Some("sk-zenmux-test123".to_string());
    zenmux_key.enabled_models = vec!["claude-sonnet-4-20250514".to_string()];
    let key_id = zenmux_key.id.clone();
    service.save_key(zenmux_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_API_KEY").map(|value| value.as_str()),
        Some("sk-zenmux-test123"),
    );
    assert_eq!(
        env.get("ANTHROPIC_BASE_URL").map(|value| value.as_str()),
        Some("https://zenmux.ai/api/anthropic"),
    );
    assert_eq!(
        env.get("ANTHROPIC_MODEL").map(|value| value.as_str()),
        Some("claude-sonnet-4-20250514"),
    );
    assert_eq!(
        env.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
            .map(|value| value.as_str()),
        Some("1"),
    );
    assert!(!env.contains_key("ZENMUX_API_KEY"));
}

#[test]
fn test_cross_type_env_zenmux_as_codex_uses_openai_endpoint() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut zenmux_key = ModelKey::new(ModelType::ZenmuxApi);
    zenmux_key.api_key = Some("sk-zenmux-test123".to_string());
    let key_id = zenmux_key.id.clone();
    service.save_key(zenmux_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::Codex, Some(&key_id));
    assert_eq!(
        env.get("OPENAI_API_KEY").map(|value| value.as_str()),
        Some("sk-zenmux-test123"),
    );
    assert_eq!(
        env.get("OPENAI_BASE_URL").map(|value| value.as_str()),
        Some("https://zenmux.ai/api/v1"),
    );
    assert!(!env.contains_key("ZENMUX_API_KEY"));
}

#[test]
fn test_cross_type_enabled_models_first_wins() {
    // Regression guard: when a key has both `available_models` (raw probe
    // result, possibly containing legacy names the proxy rejects) and
    // `enabled_models` (the user's curated KeyVault selection), the override
    // model must come from `enabled_models[0]`. Otherwise a disabled-but-
    // still-listed legacy model can silently override the user's choice and
    // produce 4xx from proxies like key.simpleai.com.cn.
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut anth_key = ModelKey::new(ModelType::AnthropicApi);
    anth_key.api_key = Some("sk-ant-curated".to_string());
    anth_key.base_url = Some("https://proxy.example.com".to_string());
    anth_key.available_models = vec![
        "claude-3-5-sonnet-20240620".to_string(), // legacy, rejected by proxy
        "claude-sonnet-4-6".to_string(),
    ];
    anth_key.enabled_models = vec![
        "claude-sonnet-4-6".to_string(),
        "claude-3-5-sonnet-20240620".to_string(),
    ];
    let key_id = anth_key.id.clone();
    service.save_key(anth_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_MODEL").map(|v| v.as_str()),
        Some("claude-sonnet-4-6"),
    );
    assert_eq!(
        env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")
            .map(|v| v.as_str()),
        Some("claude-sonnet-4-6"),
    );
}

#[test]
fn test_cross_type_falls_back_to_available_models_when_enabled_empty() {
    // When `enabled_models` is empty (key has not been curated yet via the
    // KeyVault UI), the override must fall back to `available_models[0]`.
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut anth_key = ModelKey::new(ModelType::AnthropicApi);
    anth_key.api_key = Some("sk-ant-uncurated".to_string());
    anth_key.base_url = Some("https://proxy.example.com".to_string());
    anth_key.available_models = vec!["claude-sonnet-4-6".to_string()];
    // enabled_models intentionally left empty (default).
    let key_id = anth_key.id.clone();
    service.save_key(anth_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_MODEL").map(|v| v.as_str()),
        Some("claude-sonnet-4-6"),
    );
}

#[test]
fn test_cross_type_exact_match_takes_priority() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut claude_key = ModelKey::new(ModelType::ClaudeCode);
    claude_key.api_key = Some("sk-ant-native".to_string());
    let claude_id = claude_key.id.clone();
    service.save_key(claude_key).unwrap();

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some(&claude_id));
    assert_eq!(
        env.get("ANTHROPIC_API_KEY").map(|v| v.as_str()),
        Some("sk-ant-native"),
    );
}

#[test]
fn test_cross_type_no_key_returns_empty() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let env = service.get_env_for_agent(&ModelType::ClaudeCode, Some("nonexistent-id"));
    assert!(env.is_empty());
}

#[test]
fn test_disabled_key_returns_empty_env() {
    // Account-level `enabled = false` must short-circuit env-var
    // injection so the master toggle in the UI actually takes effect.
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::AnthropicApi);
    key.api_key = Some("sk-ant-test".to_string());
    key.enabled = false;
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let env = service.get_env_for_agent(&ModelType::AnthropicApi, Some(&key_id));
    assert!(
        env.is_empty(),
        "disabled key must not contribute env vars, got: {:?}",
        env
    );

    // Re-enable and verify the env now flows.
    let mut updates = ModelKey::new(ModelType::AnthropicApi);
    updates.id = key_id.clone();
    updates.enabled = true;
    updates.api_key = Some("sk-ant-test".to_string());
    service.save_key(updates).unwrap();
    let env = service.get_env_for_agent(&ModelType::AnthropicApi, Some(&key_id));
    assert_eq!(
        env.get("ANTHROPIC_API_KEY").map(|v| v.as_str()),
        Some("sk-ant-test"),
    );
}

#[test]
fn test_kiro_env_vars_not_clobbered_by_empty_api_key() {
    // Sign-In wizard stores Kiro tokens in env_vars and leaves
    // session_token / api_key empty. The Kiro arm in
    // agent_env_builder used to overwrite KIRO_REFRESH_TOKEN with
    // the empty `entry.api_key`, breaking the env_vars channel.
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::Kiro);
    key.api_key = Some("".to_string());
    key.session_token = None;
    key.env_vars
        .insert("KIRO_ACCESS_TOKEN".to_string(), "access-real".to_string());
    key.env_vars
        .insert("KIRO_REFRESH_TOKEN".to_string(), "refresh-real".to_string());
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let env = service.get_env_for_agent(&ModelType::Kiro, Some(&key_id));
    assert_eq!(
        env.get("KIRO_ACCESS_TOKEN").map(|v| v.as_str()),
        Some("access-real"),
    );
    assert_eq!(
        env.get("KIRO_REFRESH_TOKEN").map(|v| v.as_str()),
        Some("refresh-real"),
        "empty api_key must not clobber env_vars-supplied refresh token",
    );
}

#[test]
fn test_kiro_api_key_maps_to_kiro_api_key_not_refresh_token() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::Kiro);
    key.api_key = Some("kiro-api-key".to_string());
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let env = service.get_env_for_agent(&ModelType::Kiro, Some(&key_id));
    assert_eq!(
        env.get("KIRO_API_KEY").map(|value| value.as_str()),
        Some("kiro-api-key"),
    );
    assert_eq!(env.get("KIRO_REFRESH_TOKEN"), None);
}

#[test]
fn test_kiro_full_token_json_expands_to_cli_env_vars() {
    let temp_dir = tempdir().unwrap();
    let service = KeyService::new(Some(temp_dir.path().to_path_buf()));

    let mut key = ModelKey::new(ModelType::Kiro);
    key.session_token = Some(
        serde_json::json!({
            "access_token": "aoa-json",
            "refresh_token": "aor-json",
            "expires_at": "2030-01-01T00:00:00Z",
            "region": "us-west-2",
            "start_url": "https://d-json.awsapps.com/start",
            "client_id": "client-json",
            "client_secret": "secret-json"
        })
        .to_string(),
    );
    let key_id = key.id.clone();
    service.save_key(key).unwrap();

    let env = service.get_env_for_agent(&ModelType::Kiro, Some(&key_id));
    assert_eq!(
        env.get("KIRO_ACCESS_TOKEN").map(|value| value.as_str()),
        Some("aoa-json"),
    );
    assert_eq!(
        env.get("KIRO_REFRESH_TOKEN").map(|value| value.as_str()),
        Some("aor-json"),
    );
    assert_eq!(
        env.get("KIRO_REGION").map(|value| value.as_str()),
        Some("us-west-2"),
    );
    assert_eq!(
        env.get("KIRO_START_URL").map(|value| value.as_str()),
        Some("https://d-json.awsapps.com/start"),
    );
    assert_eq!(
        env.get("KIRO_CLIENT_ID").map(|value| value.as_str()),
        Some("client-json"),
    );
    assert_eq!(
        env.get("KIRO_CLIENT_SECRET").map(|value| value.as_str()),
        Some("secret-json"),
    );
}
