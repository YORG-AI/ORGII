use super::*;

#[test]
fn test_get_provider_config_openai() {
    let config = get_provider_config("openai_api");
    assert_eq!(config.api_key_env_var, "OPENAI_API_KEY");
    assert!(config.supports_base_url);
    assert_eq!(
        config.default_base_url,
        Some("https://api.openai.com/v1".to_string())
    );
}

#[test]
fn test_get_provider_config_atlascloud() {
    let config = get_provider_config("atlascloud_api");
    assert_eq!(config.api_key_env_var, "ATLASCLOUD_API_KEY");
    assert_eq!(
        config.base_url_env_var,
        Some("ATLASCLOUD_BASE_URL".to_string())
    );
    assert!(config.supports_base_url);
    assert_eq!(
        config.default_base_url,
        Some("https://api.atlascloud.ai/v1".to_string())
    );
    assert_eq!(config.supported_protocols, vec!["openai", "anthropic"]);
    assert_eq!(config.default_protocol, "openai");
    assert_eq!(
        config.default_anthropic_base_url(),
        Some("https://api.atlascloud.ai".to_string())
    );
}

#[test]
fn test_get_provider_config_case_insensitive() {
    let config = get_provider_config("OPENAI_API");
    assert_eq!(config.api_key_env_var, "OPENAI_API_KEY");
}

#[test]
fn test_get_provider_config_azure() {
    let config = get_provider_config("azure_openai_api");
    assert_eq!(config.api_key_env_var, "AZURE_OPENAI_API_KEY");
    assert_eq!(
        config.base_url_env_var,
        Some("AZURE_OPENAI_ENDPOINT".to_string())
    );
    assert!(config.supports_base_url);
    assert!(config.default_base_url.is_none()); // No default for Azure
}

#[test]
fn test_get_provider_config_zenmux() {
    let config = get_provider_config("zenmux_api");
    assert_eq!(config.api_key_env_var, "ZENMUX_API_KEY");
    assert!(config.base_url_env_var.is_none());
    assert!(config.supports_base_url);
    assert_eq!(
        config.default_base_url,
        Some("https://zenmux.ai/api/v1".to_string())
    );
    assert_eq!(config.supported_protocols, vec!["openai", "anthropic"]);
    assert_eq!(config.default_protocol, "openai");
    assert_eq!(
        config.default_anthropic_base_url(),
        Some("https://zenmux.ai/api/anthropic".to_string())
    );
}

#[test]
fn test_get_provider_config_longcat() {
    let config = get_provider_config("longcat_api");
    assert_eq!(config.api_key_env_var, "LONGCAT_API_KEY");
    assert!(config.base_url_env_var.is_none());
    assert!(config.supports_base_url);
    assert_eq!(
        config.default_base_url,
        Some("https://api.longcat.chat/openai".to_string())
    );
    assert_eq!(config.supported_protocols, vec!["openai", "anthropic"]);
    assert_eq!(config.default_protocol, "openai");
    assert_eq!(
        config.default_anthropic_base_url(),
        Some("https://api.longcat.chat/anthropic".to_string())
    );
}

#[test]
fn test_get_all_provider_configs() {
    let configs = get_all_provider_configs();
    assert!(!configs.is_empty());
    // Should have at least the main providers
    assert!(configs.iter().any(|(k, _)| k == "openai_api"));
    assert!(configs.iter().any(|(k, _)| k == "anthropic_api"));
    assert!(configs.iter().any(|(k, _)| k == "atlascloud_api"));
    assert!(configs.iter().any(|(k, _)| k == "zenmux_api"));
    assert!(configs.iter().any(|(k, _)| k == "cursor_cli"));
}

/// Contract guard: every protocol the registry can emit must be a member of
/// the frontend's `ProviderProtocolSchema` zod enum. `get_available_api_providers`
/// validates its output against that enum in dev, so a protocol added here but
/// not mirrored there silently fails validation at runtime (see the gemini_api
/// regression). This reads the schema's real owner file so the two can't drift.
#[test]
fn every_registry_protocol_is_known_to_the_frontend_zod_enum() {
    // key-vault crate dir -> repo root is three levels up (src-tauri/crates/key-vault).
    let validation_ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src/api/tauri/rpc/schemas/validationValueObjects.ts");
    let source = std::fs::read_to_string(&validation_ts)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", validation_ts.display()));

    // Extract the members of `ProviderProtocolSchema = z.enum([ ... ])`.
    let enum_body = source
        .split_once("ProviderProtocolSchema = z.enum([")
        .and_then(|(_, rest)| rest.split_once("])"))
        .map(|(members, _)| members)
        .expect(
            "could not locate ProviderProtocolSchema z.enum([...]) in \
                 validationValueObjects.ts",
        );
    let frontend_protocols: std::collections::HashSet<&str> = enum_body
        .split(',')
        .map(|token| token.trim().trim_matches(['"', '\'']))
        .filter(|token| !token.is_empty())
        .collect();

    let mut missing: Vec<String> = Vec::new();
    for (provider, config) in get_all_provider_configs() {
        for protocol in config
            .supported_protocols
            .iter()
            .chain(std::iter::once(&config.default_protocol))
        {
            if !frontend_protocols.contains(protocol.as_str()) {
                missing.push(format!("{provider}: {protocol:?}"));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "these registry protocols are missing from ProviderProtocolSchema in \
             src/api/tauri/rpc/schemas/validation.ts (add them there to fix): {missing:?}"
    );
}

#[test]
fn all_registered_cli_agents_have_provider_configs() {
    let configs = get_all_provider_configs();
    for agent in [
        "cursor_cli",
        "claude_code",
        "codex",
        "copilot",
        "kiro",
        "kimi_cli",
        "opencode",
    ] {
        let config = configs
            .iter()
            .find(|(model_type, _)| model_type == agent)
            .map(|(_, config)| config)
            .unwrap_or_else(|| panic!("missing provider config for {agent}"));
        assert_ne!(
            config.api_key_env_var, "API_KEY",
            "{agent} used generic fallback"
        );
    }
}

/// Regional splits default to the international host; China is opt-in.
/// Guards against a reorder silently repointing every new account.
#[test]
fn endpoint_defaults_prefer_international() {
    for (model_type, expected_default_id) in [
        ("zhipu_api", "global"),
        ("minimax_api", "global"),
        ("siliconflow_api", "global"),
        ("moonshot_api", "global"),
        ("kimi_cli", "global"),
        ("dashscope_api", "intl"),
    ] {
        let config = get_provider_config(model_type);
        let first = config
            .endpoints
            .first()
            .unwrap_or_else(|| panic!("{model_type} declares no endpoints"));
        assert_eq!(
            first.id, expected_default_id,
            "{model_type} must default to its international endpoint"
        );
        assert_eq!(
            config.default_base_url.as_deref(),
            Some(first.base_url.as_str()),
            "{model_type} default_base_url must track its first endpoint"
        );
        // The China endpoint stays reachable — this is a reorder, not a removal.
        assert!(
            config.endpoints.iter().any(|e| e.id == "cn"),
            "{model_type} must still offer its China endpoint"
        );
    }
}

#[test]
fn kimi_and_opencode_cli_configs_match_setup_registry() {
    let kimi = get_provider_config("kimi_cli");
    assert_eq!(kimi.api_key_env_var, "MOONSHOT_API_KEY");
    assert_eq!(kimi.base_url_env_var, Some("MOONSHOT_BASE_URL".to_string()));
    assert!(kimi.supports_base_url);
    assert_eq!(
        kimi.default_base_url,
        Some("https://api.moonshot.ai/v1".to_string())
    );

    let opencode = get_provider_config("opencode");
    assert_eq!(opencode.api_key_env_var, "OPENCODE_API_KEY");
    assert_eq!(
        opencode.base_url_env_var,
        Some("OPENCODE_BASE_URL".to_string())
    );
    assert!(opencode.supports_base_url);
    assert_eq!(
        opencode.default_base_url,
        Some("https://opencode.ai/zen/v1".to_string())
    );
}

/// `default_base_url` is derived from the first endpoint, never written
/// twice. A drift here means a call site passed an explicit default that
/// `with_endpoints` then silently overwrote.
#[test]
fn default_base_url_matches_first_endpoint() {
    for (model_type, config) in get_all_provider_configs() {
        let Some(first) = config.endpoints.first() else {
            continue;
        };
        assert_eq!(
            config.default_base_url.as_deref(),
            Some(first.base_url.as_str()),
            "{model_type}: default_base_url must equal the first endpoint's base_url"
        );
    }
}

/// Endpoint ids are the wire identity of a selection; duplicates would make
/// the wizard's picker ambiguous.
#[test]
fn endpoint_ids_are_unique_per_provider() {
    for (model_type, config) in get_all_provider_configs() {
        let mut ids: Vec<&str> = config
            .endpoints
            .iter()
            .map(|endpoint| endpoint.id.as_str())
            .collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "{model_type}: duplicate endpoint ids");
    }
}

/// The Anthropic validator and client append `/v1/...` themselves, so an
/// Anthropic base URL that already ends in `/v1` would double the segment.
#[test]
fn anthropic_endpoint_urls_have_no_v1_suffix() {
    for (model_type, config) in get_all_provider_configs() {
        for endpoint in &config.endpoints {
            let Some(url) = &endpoint.anthropic_base_url else {
                continue;
            };
            assert!(
                !url.ends_with("/v1"),
                "{model_type}/{}: anthropic_base_url must not end with /v1 ({url})",
                endpoint.id
            );
        }
    }
}

/// A provider that advertises the Anthropic protocol must be able to route
/// it without the user hand-typing a URL — except `custom_api`, whose whole
/// point is that the user supplies the endpoint, and the Azure/`claude_code`
/// entries which carry their URL elsewhere.
#[test]
fn anthropic_capable_providers_expose_an_anthropic_url() {
    const URL_SUPPLIED_ELSEWHERE: &[&str] = &[
        "custom_api",
        "vllm_api",
        "azure_anthropic_api",
        "claude_code",
        "anthropic_api",
    ];

    for (model_type, config) in get_all_provider_configs() {
        if URL_SUPPLIED_ELSEWHERE.contains(&model_type.as_str()) {
            continue;
        }
        if !config
            .supported_protocols
            .iter()
            .any(|protocol| protocol == "anthropic")
        {
            continue;
        }
        assert!(
            config.default_anthropic_base_url().is_some(),
            "{model_type} advertises the anthropic protocol but has no anthropic base URL"
        );
    }
}

#[test]
fn region_and_tier_providers_expose_multiple_endpoints() {
    for model_type in [
        "opencode",
        "zhipu_api",
        "minimax_api",
        "moonshot_api",
        "dashscope_api",
        "siliconflow_api",
        "bedrock_api",
    ] {
        let config = get_provider_config(model_type);
        assert!(
            config.endpoints.len() > 1,
            "{model_type} should offer a choice of endpoints"
        );
    }
}

#[test]
fn zhipu_separates_regions_and_credential_types() {
    let config = get_provider_config("zhipu_api");
    let endpoints: Vec<(&str, &str)> = config
        .endpoints
        .iter()
        .map(|endpoint| (endpoint.id.as_str(), endpoint.base_url.as_str()))
        .collect();
    assert_eq!(
        endpoints,
        vec![
            ("global", "https://api.z.ai/api/paas/v4"),
            ("global-subscription", "https://api.z.ai/api/coding/paas/v4"),
            ("cn", "https://open.bigmodel.cn/api/paas/v4"),
            (
                "cn-subscription",
                "https://open.bigmodel.cn/api/coding/paas/v4"
            ),
        ]
    );
    assert_eq!(
        config.default_base_url,
        Some("https://api.z.ai/api/paas/v4".to_string())
    );
}

#[test]
fn minimax_keeps_global_default_and_offers_china() {
    let config = get_provider_config("minimax_api");
    assert_eq!(
        config.default_base_url,
        Some("https://api.minimax.io/v1".to_string())
    );
    assert!(config
        .endpoints
        .iter()
        .any(|endpoint| endpoint.base_url == "https://api.minimaxi.com/v1"));
}

#[test]
fn opencode_endpoints_cover_zen_and_go() {
    let config = get_provider_config("opencode");
    let urls: Vec<&str> = config
        .endpoints
        .iter()
        .map(|endpoint| endpoint.base_url.as_str())
        .collect();
    assert_eq!(
        urls,
        vec![
            "https://opencode.ai/zen/v1",
            "https://opencode.ai/zen/go/v1"
        ]
    );
}

#[test]
fn custom_provider_has_no_default_endpoint() {
    let config = get_provider_config("custom_api");
    assert!(config.supports_base_url);
    assert!(config.default_base_url.is_none());
    assert!(config.endpoints.is_empty());
    assert_eq!(config.supported_protocols, vec!["openai", "anthropic"]);
}

#[test]
fn bedrock_endpoints_are_regional_mantle_hosts() {
    let config = get_provider_config("bedrock_api");
    assert_eq!(config.api_key_env_var, "AWS_BEARER_TOKEN_BEDROCK");
    assert_eq!(config.endpoints.len(), 4);
    for endpoint in &config.endpoints {
        assert!(
            endpoint
                .base_url
                .starts_with(&format!("https://bedrock-mantle.{}.api.aws/", endpoint.id)),
            "endpoint {} must target its own region host",
            endpoint.id
        );
        assert!(endpoint.anthropic_base_url.is_some());
    }
}

#[test]
fn new_aggregators_are_openai_and_anthropic_capable() {
    for model_type in [
        "aihubmix_api",
        "modelscope_api",
        "cherryin_api",
        "siliconflow_api",
    ] {
        let config = get_provider_config(model_type);
        assert_eq!(
            config.supported_protocols,
            vec!["openai", "anthropic"],
            "{model_type} should speak both protocols"
        );
        assert!(config.default_anthropic_base_url().is_some());
        assert!(config.supports_base_url);
    }
}
