use std::env;
use std::fs;

use serde::Deserialize;

use super::helpers::{create_detected_key, get_home_dir};
use super::DetectedKey;
use crate::commands::validate_opencode_key;

const OPENCODE_ZEN_PROVIDER_ID: &str = "opencode";
const OPENCODE_GO_PROVIDER_ID: &str = "opencode-go";
const OPENCODE_ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
const OPENCODE_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

#[derive(Debug, Deserialize)]
struct OpenCodeAuthEntry {
    #[serde(rename = "type")]
    auth_type: String,
    key: Option<String>,
}

pub(super) async fn detect_opencode_keys() -> Vec<DetectedKey> {
    let mut keys = vec![];

    if let Some(home) = get_home_dir() {
        keys.extend(read_opencode_auth_config(&home.join(".local/share/opencode/auth.json")).await);
    }

    for (env_name, provider_id, base_url) in [
        (
            "OPENCODE_API_KEY",
            OPENCODE_ZEN_PROVIDER_ID,
            OPENCODE_ZEN_BASE_URL,
        ),
        (
            "OPENCODE_GO_API_KEY",
            OPENCODE_GO_PROVIDER_ID,
            OPENCODE_GO_BASE_URL,
        ),
    ] {
        if let Ok(api_key) = env::var(env_name) {
            if api_key.is_empty()
                || keys
                    .iter()
                    .any(|key| key.api_key.as_ref() == Some(&api_key))
            {
                continue;
            }

            let mut cred = create_detected_key(
                &format!("env_{provider_id}"),
                &format!("Environment Variable ({env_name})"),
                "api_key",
            );
            cred.api_key = Some(api_key.clone());
            cred.base_url = Some(base_url.to_string());

            let validation = validate_opencode_key(&api_key, Some(base_url)).await;
            cred.validated = Some(validation.valid);
            cred.validation_message = Some(validation.message);
            cred.available_models = Some(validation.models_available);

            keys.push(cred);
        }
    }

    keys
}

async fn read_opencode_auth_config(path: &std::path::Path) -> Vec<DetectedKey> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return vec![],
    };

    let entries: std::collections::HashMap<String, OpenCodeAuthEntry> =
        match serde_json::from_str(&content) {
            Ok(entries) => entries,
            Err(_) => return vec![],
        };

    let mut keys = vec![];
    for (provider_id, entry) in entries {
        if entry.auth_type != "api" {
            continue;
        }
        let Some(api_key) = entry.key.filter(|key| !key.is_empty()) else {
            continue;
        };
        let Some(base_url) = opencode_base_url(&provider_id) else {
            continue;
        };

        let mut cred = create_detected_key(
            &format!("opencode_{provider_id}"),
            &format!("OpenCode {}", opencode_provider_label(&provider_id)),
            "api_key",
        );
        cred.api_key = Some(api_key.clone());
        cred.base_url = Some(base_url.to_string());

        let validation = validate_opencode_key(&api_key, Some(base_url)).await;
        cred.validated = Some(validation.valid);
        cred.validation_message = Some(validation.message);
        cred.available_models = Some(validation.models_available);

        keys.push(cred);
    }

    keys
}

fn opencode_base_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        OPENCODE_ZEN_PROVIDER_ID => Some(OPENCODE_ZEN_BASE_URL),
        OPENCODE_GO_PROVIDER_ID => Some(OPENCODE_GO_BASE_URL),
        _ => None,
    }
}

fn opencode_provider_label(provider_id: &str) -> &'static str {
    match provider_id {
        OPENCODE_GO_PROVIDER_ID => "Go",
        _ => "Zen",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::install_crypto_provider_for_tests;

    #[tokio::test]
    async fn read_opencode_auth_config_detects_go_key() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        std::fs::write(
            &path,
            r#"{"opencode-go":{"type":"api","key":"opencode-test-key"}}"#,
        )
        .unwrap();

        let keys = read_opencode_auth_config(&path).await;

        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].id, "opencode_opencode-go");
        assert_eq!(keys[0].name, "OpenCode Go");
        assert_eq!(keys[0].auth_method, "api_key");
        assert_eq!(keys[0].api_key.as_deref(), Some("opencode-test-key"));
        assert_eq!(keys[0].base_url.as_deref(), Some(OPENCODE_GO_BASE_URL));
    }

    #[tokio::test]
    async fn read_opencode_auth_config_ignores_unknown_provider() {
        install_crypto_provider_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        std::fs::write(
            &path,
            r#"{"unknown":{"type":"api","key":"opencode-test-key"}}"#,
        )
        .unwrap();

        let keys = read_opencode_auth_config(&path).await;

        assert!(keys.is_empty());
    }
}
