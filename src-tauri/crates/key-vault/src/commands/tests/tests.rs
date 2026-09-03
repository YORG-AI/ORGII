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

/// Claude Fable 5.1 (`claude-fable-5-1`) is the newest Claude model. It ships
/// in the baked Claude Code OAuth catalog and, being the same family as Fable
/// 5, must get the Fable effort ladder (the five Anthropic rungs plus
/// `ultracode`) rather than the generic Anthropic one. The `-1` minor-version
/// segment must not be mistaken for an effort suffix.
#[test]
fn claude_fable_5_1_is_catalogued_and_gets_the_fable_effort_ladder() {
    use crate::commands::crud::KeyInfo;
    use crate::commands::crud::{
        CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS, CLAUDE_CODE_OAUTH_MODELS,
    };
    use crate::key_store::{AuthMethod, ModelKey, ModelType};

    assert!(CLAUDE_CODE_OAUTH_MODELS.contains(&"claude-fable-5-1"));
    assert!(CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS.contains(&"claude-fable-5-1"));

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("access-token".to_string());
    key.available_models = vec!["claude-fable-5-1".to_string()];

    let info = KeyInfo::from(key);
    let model_ids: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "claude-fable-5-1")
        .map(|variant| variant.model.as_str())
        .collect();
    assert_eq!(
        model_ids,
        vec![
            "claude-fable-5-1-low",
            "claude-fable-5-1-medium",
            "claude-fable-5-1-high",
            "claude-fable-5-1-xhigh",
            "claude-fable-5-1-max",
            "claude-fable-5-1-ultracode",
        ]
    );
    assert!(info.default_variants.iter().any(|variant| {
        variant.base_model == "claude-fable-5-1" && variant.model == "claude-fable-5-1-high"
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
fn codex_gpt_5_6_exposes_max_and_limits_ultra_to_sol_and_terra() {
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

    // sol/terra: low/medium/high/xhigh/max/ultra × {non-fast, fast}.
    for base in ["gpt-5.6-sol", "gpt-5.6-terra"] {
        let variants: Vec<_> = info
            .model_variants
            .iter()
            .filter(|variant| variant.base_model == base)
            .collect();
        assert_eq!(
            variants.len(),
            12,
            "{base} should expose max and ultra tiers"
        );
        assert_eq!(
            variants
                .iter()
                .filter(|variant| !variant.fast)
                .map(|variant| variant.reasoning.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert!(variants
            .iter()
            .any(|variant| variant.model == format!("{base}-ultra") && !variant.fast));
        assert!(variants
            .iter()
            .any(|variant| variant.model == format!("{base}-ultra-fast") && variant.fast));
    }

    // luna: low/medium/high/xhigh/max × {non-fast, fast}; no Ultra.
    let luna_variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "gpt-5.6-luna")
        .collect();
    assert_eq!(luna_variants.len(), 10);
    assert!(luna_variants
        .iter()
        .all(|variant| variant.model != "gpt-5.6-luna-ultra"));
    assert!(luna_variants
        .iter()
        .any(|variant| variant.model == "gpt-5.6-luna-high-fast" && variant.fast));
    for base in ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
        for suffix in ["max", "max-fast"] {
            assert!(info.model_variants.iter().any(|variant| {
                variant.model == format!("{base}-{suffix}")
                    && variant.reasoning.as_deref() == Some("max")
            }));
        }
    }
}

#[test]
fn live_codex_catalog_preserves_capabilities_and_completes_builtin_models() {
    use crate::commands::crud::CODEX_OAUTH_MODELS;
    use crate::commands::validate::{resolved_oauth_catalog, OAuthModelCatalogSource};
    use crate::types::DiscoveredModel;

    let catalog = resolved_oauth_catalog(
        "codex",
        vec![
            DiscoveredModel {
                id: "account-visible-model".to_string(),
                context_window: Some(777_000),
                supported_efforts: vec!["low".to_string(), "high".to_string()],
                default_effort: Some("high".to_string()),
                is_default: true,
                ..DiscoveredModel::default()
            },
            DiscoveredModel {
                id: "gpt-5.6-sol".to_string(),
                context_window: Some(1_050_000),
                supported_efforts: vec!["ultra".to_string()],
                default_effort: Some("ultra".to_string()),
                ..DiscoveredModel::default()
            },
        ],
        OAuthModelCatalogSource::Live,
    )
    .expect("resolved live catalog");

    let expected_models: Vec<_> = ["account-visible-model", "gpt-5.6-sol"]
        .into_iter()
        .map(str::to_string)
        .chain(
            CODEX_OAUTH_MODELS
                .iter()
                .filter(|model| **model != "gpt-5.6-sol")
                .map(|model| (*model).to_string()),
        )
        .collect();
    assert_eq!(catalog.models, expected_models);
    for model in ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
        assert!(catalog.models.iter().any(|available| available == model));
    }
    assert_eq!(
        catalog.default_enabled_models,
        vec![
            "account-visible-model",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
        ]
    );
    assert_eq!(
        catalog.model_context_lengths.get("account-visible-model"),
        Some(&777_000)
    );
    assert_eq!(
        catalog.model_context_lengths.get("gpt-5.6-sol"),
        Some(&1_050_000)
    );
    assert_eq!(
        catalog
            .models
            .iter()
            .filter(|model| model.as_str() == "gpt-5.6-sol")
            .count(),
        1
    );
    assert_eq!(catalog.source, OAuthModelCatalogSource::Live);
    let account_variants: Vec<_> = catalog
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "account-visible-model")
        .collect();
    assert_eq!(account_variants.len(), 2);
    assert!(catalog
        .model_variants
        .iter()
        .any(|variant| variant.model == "account-visible-model-high"));
    assert!(catalog.default_variants.iter().any(|variant| {
        variant.base_model == "account-visible-model"
            && variant.model == "account-visible-model-high"
    }));
}

#[test]
fn live_claude_catalog_remains_account_visible_only() {
    use crate::commands::validate::{resolved_oauth_catalog, OAuthModelCatalogSource};
    use crate::types::DiscoveredModel;

    let catalog = resolved_oauth_catalog(
        "claude_code",
        vec![DiscoveredModel {
            id: "account-visible-claude".to_string(),
            is_default: true,
            ..DiscoveredModel::default()
        }],
        OAuthModelCatalogSource::Live,
    )
    .expect("resolved Claude live catalog");

    assert_eq!(catalog.models, vec!["account-visible-claude"]);
    assert_eq!(
        catalog.default_enabled_models,
        vec!["account-visible-claude"]
    );
}

#[test]
fn claude_opus_5_fallback_exposes_effort_variants() {
    use crate::commands::crud::KeyInfo;
    use crate::key_store::{AuthMethod, ModelKey, ModelType};

    let mut key = ModelKey::new(ModelType::ClaudeCode);
    key.auth_method = AuthMethod::Oauth;
    key.session_token = Some("access-token".to_string());
    key.available_models = vec!["claude-opus-5".to_string()];

    let info = KeyInfo::from(key);
    let variants: Vec<_> = info
        .model_variants
        .iter()
        .filter(|variant| variant.base_model == "claude-opus-5")
        .collect();
    assert_eq!(variants.len(), 5);
    assert!(variants
        .iter()
        .any(|variant| variant.model == "claude-opus-5-max"));
    assert!(info.default_variants.iter().any(|variant| {
        variant.base_model == "claude-opus-5" && variant.model == "claude-opus-5-high"
    }));
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
