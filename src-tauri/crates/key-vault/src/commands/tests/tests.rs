use crate::commands::validate::validate_token_format;

#[test]
fn test_format_validation_from_credentials_file() {
    use serde::Deserialize;
    use std::collections::HashMap;
    use std::fs;

    #[derive(Deserialize)]
    struct CredentialsFile {
        credentials: HashMap<String, StoredCredential>,
    }

    #[derive(Deserialize)]
    struct StoredCredential {
        name: String,
        agent_type: String,
        api_key: Option<String>,
    }

    let creds_path = app_paths::keys();

    if !creds_path.exists() {
        println!("Credentials file not found, skipping test");
        return;
    }

    let contents = fs::read_to_string(&creds_path).expect("Failed to read credentials file");
    let creds_file: CredentialsFile =
        serde_json::from_str(&contents).expect("Failed to parse credentials file");

    println!("\n=== Validating credentials from {:?} ===\n", creds_path);

    for (id, cred) in &creds_file.credentials {
        let api_key = cred.api_key.clone().unwrap_or_default();

        if api_key.is_empty() {
            println!(
                "  [{}] {} ({}) - SKIP: No API key",
                id, cred.name, cred.agent_type
            );
            continue;
        }

        let result = validate_token_format(cred.agent_type.clone(), api_key);

        match result {
            Ok((valid, msg)) => {
                let status = if valid { "PASS" } else { "FAIL" };
                println!(
                    "  [{}] {} ({}) - {}: {}",
                    id, cred.name, cred.agent_type, status, msg
                );
            }
            Err(e) => {
                println!(
                    "  [{}] {} ({}) - ERROR: {}",
                    id, cred.name, cred.agent_type, e
                );
            }
        }
    }

    println!("\n=== Format validation complete ===\n");
}

#[cfg(not(windows))]
#[test]
fn test_infer_install_homebrew() {
    use crate::commands::registry::infer_install_method;

    assert_eq!(
        infer_install_method("/opt/homebrew/bin/cursor").as_deref(),
        Some("homebrew")
    );
    assert_eq!(
        infer_install_method("/usr/local/Cellar/foo/1.0/bin/foo").as_deref(),
        Some("homebrew")
    );
}

#[cfg(not(windows))]
#[test]
fn test_infer_install_npm() {
    use crate::commands::registry::infer_install_method;

    assert_eq!(
        infer_install_method("/projects/app/node_modules/.bin/cursor").as_deref(),
        Some("npm")
    );
    assert_eq!(
        infer_install_method("/Users/x/.nvm/versions/node/v20/bin/cursor").as_deref(),
        Some("npm")
    );
}

#[cfg(not(windows))]
#[test]
fn test_infer_install_cargo() {
    use crate::commands::registry::infer_install_method;

    assert_eq!(
        infer_install_method("/Users/x/.cargo/bin/cursor-agent").as_deref(),
        Some("cargo")
    );
}

#[cfg(not(windows))]
#[test]
fn test_infer_install_pip() {
    use crate::commands::registry::infer_install_method;

    assert_eq!(
        infer_install_method("/Users/x/.local/pipx/venvs/foo/bin/foo").as_deref(),
        Some("pip")
    );
    assert_eq!(
        infer_install_method("/home/x/Library/Python/3.11/bin/poetry").as_deref(),
        Some("pip")
    );
}

#[cfg(not(windows))]
#[test]
fn test_infer_install_curl() {
    use crate::commands::registry::infer_install_method;

    assert_eq!(
        infer_install_method("/usr/local/bin/cursor").as_deref(),
        Some("curl")
    );
}

#[test]
fn test_infer_install_unknown() {
    use crate::commands::registry::infer_install_method;

    assert_eq!(
        infer_install_method("/opt/unique-nonstandard-path/bin/my-tool").as_deref(),
        None
    );
}

/// Guards the `save_key` command's `SaveKeyRequest.model_variants` ->
/// `ModelVariant` mapping (crud.rs). A regression that hardcodes
/// `context_window: None` here would silently erase provider-reported context
/// windows on every save, so this test must exercise the conversion directly
/// (not the storage layer, which preserves the field trivially).
#[test]
fn test_model_variant_info_to_variant_preserves_context_window() {
    use crate::commands::crud::ModelVariantInfo;
    use crate::key_store::ModelVariant;

    let with_ctx = ModelVariantInfo {
        model: "gpt-4o".to_string(),
        base_model: "gpt-4o".to_string(),
        reasoning: None,
        fast: false,
        context_window: Some(128_000),
    };
    assert_eq!(ModelVariant::from(with_ctx).context_window, Some(128_000));

    let without_ctx = ModelVariantInfo {
        model: "gpt-4o".to_string(),
        base_model: "gpt-4o".to_string(),
        reasoning: None,
        fast: false,
        context_window: None,
    };
    assert_eq!(ModelVariant::from(without_ctx).context_window, None);

    let zero_ctx = ModelVariantInfo {
        model: "gpt-4o".to_string(),
        base_model: "gpt-4o".to_string(),
        reasoning: None,
        fast: false,
        context_window: Some(0),
    };
    assert_eq!(ModelVariant::from(zero_ctx).context_window, None);
}

#[test]
fn claude_native_key_info_exposes_output_config_effort_variants() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{AuthMethod, ModelKey, ModelType, ModelVariant};

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("access-token".to_string());
    key.available_models = vec![
        "claude-opus-4-8".to_string(),
        "claude-fable-5".to_string(),
        "claude-haiku-4-5".to_string(),
    ];
    key.model_variants = vec![ModelVariant {
        model: "claude-opus-4-8".to_string(),
        base_model: "claude-opus-4-8".to_string(),
        reasoning: Some("always_on".to_string()),
        fast: false,
        context_window: Some(200_000),
    }];

    let info = KeyInfo::from(key);
    let opus_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "claude-opus-4-8")
        .collect();

    assert_eq!(opus_variants.len(), 11);
    assert!(opus_variants
        .iter()
        .any(|variant| variant.model == "claude-opus-4-8-high"));
    assert!(opus_variants
        .iter()
        .any(|variant| variant.model == "claude-opus-4-8-thinking-high"));
    assert!(opus_variants
        .iter()
        .any(|variant| variant.model == "claude-opus-4-8-xhigh"));
    assert!(opus_variants
        .iter()
        .any(|variant| variant.model == "claude-opus-4-8-thinking-max"));
    let record_row = opus_variants
        .iter()
        .find(|variant| variant.model == "claude-opus-4-8")
        .expect("stored record row must survive synthesis");
    assert_eq!(record_row.reasoning.as_deref(), Some("always_on"));
    assert_eq!(record_row.context_window, Some(200_000));
    assert!(info
        .model_variants
        .iter()
        .all(|variant| variant.base_model != "claude-haiku-4-5"));
    assert!(info.default_variants.iter().any(|variant| {
        variant.base_model == "claude-opus-4-8" && variant.model == "claude-opus-4-8-high"
    }));

    let fable_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "claude-fable-5")
        .collect();
    let fable_model_ids: Vec<_> = fable_variants
        .iter()
        .map(|variant| variant.model.as_str())
        .collect();
    assert_eq!(fable_model_ids.len(), 6);
    assert_eq!(
        fable_model_ids,
        vec![
            "claude-fable-5-low",
            "claude-fable-5-medium",
            "claude-fable-5-high",
            "claude-fable-5-xhigh",
            "claude-fable-5-max",
            "claude-fable-5-ultracode",
        ]
    );
    assert!(info.default_variants.iter().any(|variant| {
        variant.base_model == "claude-fable-5" && variant.model == "claude-fable-5-high"
    }));
}

#[test]
fn codex_key_info_exposes_requested_gpt_effort_and_speed_variants() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{AuthMethod, ModelKey, ModelType};

    let mut key = ModelKey::new(ModelType::Codex);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("access-token".to_string());
    key.available_models = vec![
        "gpt-5.5".to_string(),
        "gpt-5.4".to_string(),
        "gpt-5.4-mini".to_string(),
        "gpt-5.3-codex".to_string(),
        "gpt-5.2".to_string(),
        "gpt-4.1".to_string(),
    ];

    let info = KeyInfo::from(key);
    let gpt55_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "gpt-5.5")
        .collect();
    assert_eq!(gpt55_variants.len(), 8);
    assert!(gpt55_variants
        .iter()
        .any(|variant| variant.model == "gpt-5.5-high" && !variant.fast));
    assert!(gpt55_variants
        .iter()
        .any(|variant| variant.model == "gpt-5.5-high-fast" && variant.fast));

    let mini_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "gpt-5.4-mini")
        .collect();
    assert_eq!(mini_variants.len(), 4);
    assert!(mini_variants.iter().all(|variant| !variant.fast));
    assert!(info
        .model_variants
        .iter()
        .all(|variant| variant.base_model != "gpt-4.1"));
    assert!(info
        .default_variants
        .iter()
        .any(|variant| variant.base_model == "gpt-5.5" && variant.model == "gpt-5.5-medium"));
}

#[test]
fn codex_gpt_5_6_ultra_tier_limited_to_sol_and_terra() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{AuthMethod, ModelKey, ModelType};

    let mut key = ModelKey::new(ModelType::Codex);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("access-token".to_string());
    key.available_models = vec![
        "gpt-5.6-sol".to_string(),
        "gpt-5.6-terra".to_string(),
        "gpt-5.6-luna".to_string(),
    ];

    let info = KeyInfo::from(key);

    // sol/terra: low/medium/high/xhigh/ultra × {non-fast, fast} = 10 variants.
    for base in ["gpt-5.6-sol", "gpt-5.6-terra"] {
        let variants: Vec<_> = info
            .model_variants
            .iter()
            .filter(|variant| variant.base_model == base)
            .collect();
        assert_eq!(variants.len(), 10, "{base} should expose ultra tier");
        assert!(variants
            .iter()
            .any(|variant| variant.model == format!("{base}-ultra") && !variant.fast));
        assert!(variants
            .iter()
            .any(|variant| variant.model == format!("{base}-ultra-fast") && variant.fast));
    }

    // luna: no ultra tier → low/medium/high/xhigh × {non-fast, fast} = 8 variants.
    let luna_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "gpt-5.6-luna")
        .collect();
    assert_eq!(luna_variants.len(), 8);
    assert!(luna_variants
        .iter()
        .all(|variant| variant.model != "gpt-5.6-luna-ultra"));
    assert!(luna_variants
        .iter()
        .any(|variant| variant.model == "gpt-5.6-luna-high-fast" && variant.fast));
}

#[test]
fn glm_5_2_plus_gets_high_max_ladder_and_max_default() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{AuthMethod, ModelKey, ModelType};

    let mut key = ModelKey::new(ModelType::ZhipuApi);
    key.auth_method = AuthMethod::ApiKey;
    key.api_key = Some("zhipu-key".to_string());
    key.available_models = vec![
        "glm-5.2".to_string(),
        "glm-5.1".to_string(),
        "glm-5".to_string(),
        "glm-5-turbo".to_string(),
    ];

    let info = KeyInfo::from(key);

    // GLM 5.2 → exactly High + Max (Baseline is the bare model row), no fast.
    let glm52_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "glm-5.2")
        .collect();
    assert_eq!(glm52_variants.len(), 2);
    assert!(glm52_variants
        .iter()
        .any(|variant| variant.model == "glm-5.2-high" && !variant.fast));
    assert!(glm52_variants
        .iter()
        .any(|variant| variant.model == "glm-5.2-max" && !variant.fast));

    // GLM 5.1 and older, and the distinct glm-5-turbo sub-model, get no ladder.
    assert!(info
        .model_variants
        .iter()
        .all(|variant| variant.base_model != "glm-5.1"));
    assert!(info
        .model_variants
        .iter()
        .all(|variant| variant.base_model != "glm-5"));
    assert!(info
        .model_variants
        .iter()
        .all(|variant| variant.base_model != "glm-5-turbo"));

    // GLM 5.2 defaults to Max (recommended for coding).
    assert!(info
        .default_variants
        .iter()
        .any(|variant| variant.base_model == "glm-5.2" && variant.model == "glm-5.2-max"));
}

#[test]
fn relay_claude_code_key_gets_no_synthesized_effort_variants() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{AuthMethod, ModelKey, ModelType, ModelVariant};

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("mirror-token".to_string());
    key.base_url = Some("https://claude-relay.example/api".to_string());
    key.available_models = vec!["claude-opus-4-8".to_string()];
    key.model_variants = vec![ModelVariant {
        model: "claude-opus-4-8".to_string(),
        base_model: "claude-opus-4-8".to_string(),
        reasoning: None,
        fast: false,
        context_window: Some(128_000),
    }];

    let info = KeyInfo::from(key);
    // Third-party relay: stored rows pass through untouched, nothing added.
    assert_eq!(info.model_variants.len(), 1);
    assert_eq!(info.model_variants[0].model, "claude-opus-4-8");
    assert_eq!(info.model_variants[0].context_window, Some(128_000));
}

#[test]
fn third_party_anthropic_protocol_key_keeps_record_rows_untouched() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{ModelKey, ModelType, ModelVariant, ProviderProtocol};

    let mut key = ModelKey::new(ModelType::OpenrouterApi);
    key.protocol = Some(ProviderProtocol::Anthropic);
    key.available_models = vec!["claude-sonnet-4-6".to_string()];
    key.model_variants = vec![ModelVariant {
        model: "claude-sonnet-4-6".to_string(),
        base_model: "claude-sonnet-4-6".to_string(),
        reasoning: None,
        fast: false,
        context_window: Some(131_072),
    }];

    let info = KeyInfo::from(key);
    // Anthropic-protocol third parties are NOT native: no synthesis, and the
    // provider-reported context window row survives for the usage display.
    assert_eq!(info.model_variants.len(), 1);
    assert_eq!(info.model_variants[0].context_window, Some(131_072));
    assert_eq!(info.model_variants[0].reasoning, None);
}

#[test]
fn sonnet_ladders_follow_reference_effort_limits() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{ModelKey, ModelType};

    let mut key = ModelKey::new(ModelType::AnthropicApi);
    key.api_key = Some("sk-ant-test".to_string());
    key.available_models = vec![
        "claude-sonnet-4-6".to_string(),
        "claude-sonnet-5".to_string(),
    ];

    let info = KeyInfo::from(key);
    assert!(info
        .model_variants
        .iter()
        .any(|variant| variant.model == "claude-sonnet-4-6-high"));
    assert!(info
        .model_variants
        .iter()
        .any(|variant| variant.model == "claude-sonnet-4-6-thinking-high"));
    assert!(info
        .model_variants
        .iter()
        .any(|variant| variant.model == "claude-sonnet-4-6-max"));
    assert!(info
        .model_variants
        .iter()
        .any(|variant| variant.model == "claude-sonnet-5-thinking-xhigh"));
}
