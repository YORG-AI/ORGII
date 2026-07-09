use std::env;
use std::fs;

use super::helpers::{
    create_detected_key, get_home_dir, get_openai_config_paths, validate_openai_key, OpenAIConfig,
};
use super::{DetectedKey, QuotaInfo};
use core_types::providers::{
    CodexCliAuthConfig, CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY,
};

/// Detect Codex/OpenAI keys and OAuth sessions from local config
/// Returns BOTH OAuth and API key entries when both exist (for user selection modal)
pub(super) async fn detect_codex_keys() -> Vec<DetectedKey> {
    let mut keys = vec![];

    // 1. Check Codex CLI auth.json first (most common for Codex CLI users)
    // This returns BOTH OAuth and API key if both exist
    if let Some(home) = get_home_dir() {
        let codex_auth_path = home.join(".codex/auth.json");
        let codex_creds = read_codex_auth_config(&codex_auth_path).await;
        keys.extend(codex_creds);
    }

    // 2. Check environment variable (only if not already found in auth.json)
    if let Ok(api_key) = env::var("OPENAI_API_KEY") {
        if !api_key.is_empty() {
            // Don't add duplicate if we already have this API key from auth.json
            let already_has_key = keys
                .iter()
                .any(|c| c.api_key.as_ref().map(|k| k == &api_key).unwrap_or(false));

            if !already_has_key {
                let mut cred = create_detected_key("env_openai", "Environment Variable", "api_key");
                cred.api_key = Some(api_key.clone());

                // Validate the key
                let validation = validate_openai_key(&api_key, None).await;
                cred.validated = Some(validation.0);
                cred.validation_message = validation.1;
                cred.available_models = validation.2;

                keys.push(cred);
            }
        }
    }

    // 3. Check other OpenAI config files (only if not already found)
    let config_paths = get_openai_config_paths();
    for path in config_paths {
        if let Some(cred) = read_openai_config(&path).await {
            // Don't add duplicate keys
            let already_has = keys.iter().any(|c| {
                c.api_key
                    .as_ref()
                    .map(|k| k == cred.api_key.as_ref().unwrap_or(&String::new()))
                    .unwrap_or(false)
            });
            if !already_has {
                keys.push(cred);
            }
        }
    }

    keys
}

/// Read Codex CLI auth.json format (~/.codex/auth.json)
/// Returns BOTH OAuth and API key entries if both exist (for user selection modal)
///
/// For OAuth flow, we need to pass:
/// - session_token = access_token (for immediate use)
/// - env_vars[CODEX_REFRESH_TOKEN_ENV_KEY] = refresh_token (for backend to refresh)
/// - env_vars[CODEX_ID_TOKEN_ENV_KEY] = id_token (for auth.json generation)
async fn read_codex_auth_config(path: &std::path::PathBuf) -> Vec<DetectedKey> {
    let mut keys = vec![];

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return keys,
    };

    let config: CodexCliAuthConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => return keys,
    };

    // 1. Check for OAuth tokens (access_token from `codex auth login`)
    if let Some(tokens) = &config.tokens {
        if let Some(access_token) = &tokens.access_token {
            if !access_token.is_empty() {
                let mut cred = create_detected_key("codex_oauth", "OpenAI", "oauth");

                // session_token = access_token (used for API calls)
                cred.session_token = Some(access_token.clone());

                // Build env_vars with refresh_token and id_token for the hosted service
                let mut env_vars = std::collections::HashMap::new();

                if let Some(refresh_token) = &tokens.refresh_token {
                    if !refresh_token.is_empty() {
                        env_vars.insert(
                            CODEX_REFRESH_TOKEN_ENV_KEY.to_string(),
                            refresh_token.clone(),
                        );
                    }
                }

                if let Some(id_token) = &tokens.id_token {
                    if !id_token.is_empty() {
                        env_vars.insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), id_token.clone());
                    }
                }

                if !env_vars.is_empty() {
                    cred.env_vars = Some(env_vars);
                }

                // Validate using the access token as bearer token
                let validation = validate_codex_access_token(access_token).await;
                cred.validated = Some(validation.0);
                cred.validation_message = validation.1;
                cred.available_models = validation.2;
                cred.quota_info = validation.3;

                keys.push(cred);
            }
        }
    }

    // 2. Check for OPENAI_API_KEY (separate API key option)
    if let Some(api_key) = &config.openai_api_key {
        if !api_key.is_empty() {
            let mut cred =
                create_detected_key("codex_api_key", "Codex CLI API Key (OpenAI)", "api_key");
            cred.api_key = Some(api_key.clone());

            let validation = validate_openai_key(api_key, None).await;
            cred.validated = Some(validation.0);
            cred.validation_message = validation.1;
            cred.available_models = validation.2;

            keys.push(cred);
        }
    }

    keys
}

/// Validate Codex access token using CodexValidator
/// Returns (valid, message, models, quota_info) tuple for DetectedKey
async fn validate_codex_access_token(
    access_token: &str,
) -> (bool, Option<String>, Option<Vec<String>>, Option<QuotaInfo>) {
    use crate::providers::codex::CodexValidator;

    let validator = CodexValidator::new();
    let result = validator.validate_oauth(access_token).await;

    // Convert key_vault::types::QuotaInfo to auto_detect::QuotaInfo
    let quota_info = result.quota_info.map(|q| QuotaInfo {
        remaining_percentage: Some(q.remaining_percentage),
        used: q.used,
        limit: q.limit,
        remaining: q.remaining,
        reset_time: q.reset_time,
        plan_type: q.plan_type,
        quota_source: q.quota_source,
        is_unlimited: Some(q.is_unlimited),
        usage_items: q.usage_items,
        auto_message: q.auto_message,
        named_message: q.named_message,
    });

    (
        result.valid,
        Some(result.message),
        if result.models_available.is_empty() {
            None
        } else {
            Some(result.models_available)
        },
        quota_info,
    )
}

async fn read_openai_config(path: &std::path::PathBuf) -> Option<DetectedKey> {
    // A missing config file is a normal "no detection" outcome and stays
    // silent (Rule 6 — missing ⇒ empty). Read errors and JSON-parse
    // errors instead surface via `warn!` so a corrupt or unreadable
    // OpenAI Codex config file is visible to the user instead of
    // silently producing a "no Codex key found" result.
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "auto_detect::codex: config read failed; skipping"
            );
            return None;
        }
    };
    let config: OpenAIConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "auto_detect::codex: config JSON parse failed; skipping"
            );
            return None;
        }
    };
    let api_key = config.api_key?;

    if api_key.is_empty() {
        return None;
    }

    let mut cred = create_detected_key(
        &format!("file_{}", path.file_name()?.to_string_lossy()),
        &format!("Config File ({})", path.display()),
        "api_key",
    );
    cred.api_key = Some(api_key.clone());

    // Validate
    let validation = validate_openai_key(&api_key, None).await;
    cred.validated = Some(validation.0);
    cred.validation_message = validation.1;
    cred.available_models = validation.2;

    Some(cred)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::install_crypto_provider_for_tests;

    // Both `read_codex_auth_config` and `read_openai_config` call
    // validators that construct `reqwest::Client`s. We assert structural
    // fields (id, name, auth_method, api_key, session_token, env_vars) —
    // not `validated` / `validation_message` / `available_models`, since
    // those depend on whether the test machine has network access and on
    // the live response from OpenAI/Codex.

    fn write(path: &std::path::Path, body: &str) {
        std::fs::write(path, body).expect("write fixture");
    }

    // ── read_codex_auth_config ────────────────────────────────────────

    #[tokio::test]
    async fn read_codex_auth_config_missing_file_returns_empty() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does_not_exist.json");
        let keys = read_codex_auth_config(&path).await;
        assert!(keys.is_empty());
    }

    #[tokio::test]
    async fn read_codex_auth_config_malformed_json_returns_empty() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(&path, "{not valid json");
        let keys = read_codex_auth_config(&path).await;
        assert!(keys.is_empty());
    }

    #[tokio::test]
    async fn read_codex_auth_config_oauth_with_all_tokens() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(
            &path,
            r#"{
              "tokens": {
                "access_token": "access-abc",
                "refresh_token": "refresh-def",
                "id_token": "id-ghi"
              }
            }"#,
        );

        let keys = read_codex_auth_config(&path).await;
        assert_eq!(keys.len(), 1, "expected single OAuth entry");
        let oauth = &keys[0];
        assert_eq!(oauth.id, "codex_oauth");
        assert_eq!(oauth.auth_method, "oauth");
        assert_eq!(oauth.session_token.as_deref(), Some("access-abc"));
        assert!(oauth.api_key.is_none());

        let env = oauth.env_vars.as_ref().expect("env_vars set");
        assert_eq!(
            env.get(CODEX_REFRESH_TOKEN_ENV_KEY).map(String::as_str),
            Some("refresh-def")
        );
        // CODEX_ID_TOKEN_ENV_KEY's literal value is owned by core_types;
        // assert presence by looking up via the same constant.
        assert_eq!(
            env.get(core_types::providers::CODEX_ID_TOKEN_ENV_KEY)
                .map(String::as_str),
            Some("id-ghi")
        );
    }

    #[tokio::test]
    async fn read_codex_auth_config_oauth_only_access_token() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(&path, r#"{ "tokens": { "access_token": "access-only" } }"#);

        let keys = read_codex_auth_config(&path).await;
        assert_eq!(keys.len(), 1);
        let oauth = &keys[0];
        assert_eq!(oauth.session_token.as_deref(), Some("access-only"));
        // No refresh/id tokens → env_vars stays None (the function only
        // sets it when at least one of refresh/id is non-empty).
        assert!(oauth.env_vars.is_none());
    }

    #[tokio::test]
    async fn read_codex_auth_config_empty_access_token_skipped() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(
            &path,
            r#"{ "tokens": { "access_token": "", "refresh_token": "r" } }"#,
        );

        let keys = read_codex_auth_config(&path).await;
        assert!(
            keys.is_empty(),
            "empty access_token must not produce an OAuth entry"
        );
    }

    #[tokio::test]
    async fn read_codex_auth_config_api_key_only() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(&path, r#"{ "OPENAI_API_KEY": "sk-test-1234567890" }"#);

        let keys = read_codex_auth_config(&path).await;
        assert_eq!(keys.len(), 1);
        let api = &keys[0];
        assert_eq!(api.id, "codex_api_key");
        assert_eq!(api.auth_method, "api_key");
        assert_eq!(api.api_key.as_deref(), Some("sk-test-1234567890"));
        assert!(api.session_token.is_none());
        assert!(api.env_vars.is_none());
    }

    #[tokio::test]
    async fn read_codex_auth_config_empty_api_key_skipped() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(&path, r#"{ "OPENAI_API_KEY": "" }"#);

        let keys = read_codex_auth_config(&path).await;
        assert!(keys.is_empty());
    }

    #[tokio::test]
    async fn read_codex_auth_config_both_oauth_and_api_key() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write(
            &path,
            r#"{
              "OPENAI_API_KEY": "sk-test-1234567890",
              "tokens": {
                "access_token": "access-xyz",
                "refresh_token": "refresh-xyz"
              }
            }"#,
        );

        let keys = read_codex_auth_config(&path).await;
        assert_eq!(keys.len(), 2, "expected both OAuth and API key entries");

        // Order is OAuth first (per the function), then API key.
        assert_eq!(keys[0].auth_method, "oauth");
        assert_eq!(keys[0].id, "codex_oauth");
        assert_eq!(keys[1].auth_method, "api_key");
        assert_eq!(keys[1].id, "codex_api_key");
    }

    // ── read_openai_config ────────────────────────────────────────────

    #[tokio::test]
    async fn read_openai_config_missing_file_returns_none() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert!(read_openai_config(&path).await.is_none());
    }

    #[tokio::test]
    async fn read_openai_config_malformed_json_returns_none() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write(&path, "this is not json");
        assert!(read_openai_config(&path).await.is_none());
    }

    #[tokio::test]
    async fn read_openai_config_no_api_key_field_returns_none() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write(&path, r#"{ "organization": "org-foo" }"#);
        assert!(read_openai_config(&path).await.is_none());
    }

    #[tokio::test]
    async fn read_openai_config_empty_api_key_returns_none() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write(&path, r#"{ "api_key": "" }"#);
        assert!(read_openai_config(&path).await.is_none());
    }

    #[tokio::test]
    async fn read_openai_config_valid_returns_detected_key() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openai-fixture.json");
        write(&path, r#"{ "api_key": "sk-fixture-1234567890" }"#);

        let cred = read_openai_config(&path).await.expect("Some(DetectedKey)");
        assert_eq!(cred.id, "file_openai-fixture.json");
        assert!(cred.name.contains("openai-fixture.json"));
        assert!(cred.name.starts_with("Config File ("));
        assert_eq!(cred.auth_method, "api_key");
        assert_eq!(cred.api_key.as_deref(), Some("sk-fixture-1234567890"));
    }
}
