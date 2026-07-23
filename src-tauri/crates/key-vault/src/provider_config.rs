//! Provider configuration module.
//!
//! Single source of truth for provider-specific settings:
//! - Default base URLs for API providers
//! - Environment variable names for API keys and base URLs
//! - Provider capabilities (supports custom base URL, auth method, etc.)
//! - Selectable endpoints (region / tier variants) per provider

use serde::Serialize;

/// A selectable endpoint for a provider.
///
/// Endpoints model the cases where one brand ships the same API behind more
/// than one host: a regional split (Zhipu's `api.z.ai` vs `open.bigmodel.cn`),
/// a product tier (OpenCode Zen vs Go), or an AWS region (Bedrock).
///
/// The first entry of a provider's endpoint list is its default and supplies
/// [`ProviderConfig::default_base_url`]. A provider with two or more endpoints
/// renders an endpoint picker in the Key Vault wizard; a provider with exactly
/// one endpoint has nothing to pick, but the entry still carries the provider's
/// Anthropic-protocol URL when it exposes one.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProviderEndpointSpec {
    /// Stable identifier, unique within one provider (e.g. "cn", "global", "zen").
    pub id: &'static str,
    /// Display label. Untranslated, matching `display_name` on registry entries.
    pub label: &'static str,
    /// Base URL for the OpenAI-compatible protocol.
    pub base_url: &'static str,
    /// Base URL for the Anthropic-compatible protocol, when this endpoint
    /// exposes one. `None` means "fall back to `base_url`".
    ///
    /// Anthropic URLs must NOT carry a `/v1` suffix — the Anthropic validator
    /// and client both append `/v1/messages` and `/v1/models` themselves.
    pub anthropic_base_url: Option<&'static str>,
}

/// Wire form of [`ProviderEndpointSpec`], returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderEndpoint {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub anthropic_base_url: Option<String>,
}

impl From<&ProviderEndpointSpec> for ProviderEndpoint {
    fn from(spec: &ProviderEndpointSpec) -> Self {
        Self {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            base_url: spec.base_url.to_string(),
            anthropic_base_url: spec.anthropic_base_url.map(str::to_string),
        }
    }
}

// ============================================
// Endpoint tables
// ============================================
//
// The first entry of each table is the provider's default endpoint. For a
// regional split the international host goes first: ORGII's default audience is
// outside mainland China, and a user on the China endpoint is far more likely to
// know they need it than the reverse. Reordering a table changes
// `default_base_url`, which changes where accounts that stored no explicit base
// URL resolve to — see `endpoint_defaults_prefer_international`.

const OPENCODE_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "zen",
        label: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/v1",
        anthropic_base_url: None,
    },
    ProviderEndpointSpec {
        id: "go",
        label: "OpenCode Go",
        base_url: "https://opencode.ai/zen/go/v1",
        anthropic_base_url: None,
    },
];

const ZHIPU_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "global",
        label: "Global (Z.ai)",
        base_url: "https://api.z.ai/api/paas/v4",
        anthropic_base_url: Some("https://api.z.ai/api/anthropic"),
    },
    ProviderEndpointSpec {
        id: "cn",
        label: "China (BigModel)",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        anthropic_base_url: Some("https://open.bigmodel.cn/api/anthropic"),
    },
];

const MINIMAX_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "global",
        label: "Global",
        base_url: "https://api.minimax.io/v1",
        anthropic_base_url: Some("https://api.minimax.io/anthropic"),
    },
    ProviderEndpointSpec {
        id: "cn",
        label: "China",
        base_url: "https://api.minimaxi.com/v1",
        anthropic_base_url: Some("https://api.minimaxi.com/anthropic"),
    },
];

const MOONSHOT_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "global",
        label: "Global",
        base_url: "https://api.moonshot.ai/v1",
        anthropic_base_url: Some("https://api.moonshot.ai/anthropic"),
    },
    ProviderEndpointSpec {
        id: "cn",
        label: "China",
        base_url: "https://api.moonshot.cn/v1",
        anthropic_base_url: Some("https://api.moonshot.cn/anthropic"),
    },
];

const DASHSCOPE_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "intl",
        label: "International",
        base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        anthropic_base_url: None,
    },
    ProviderEndpointSpec {
        id: "cn",
        label: "China",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        anthropic_base_url: None,
    },
];

const SILICONFLOW_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "global",
        label: "Global",
        base_url: "https://api.siliconflow.com/v1",
        anthropic_base_url: Some("https://api.siliconflow.com"),
    },
    ProviderEndpointSpec {
        id: "cn",
        label: "China",
        base_url: "https://api.siliconflow.cn/v1",
        anthropic_base_url: Some("https://api.siliconflow.cn"),
    },
];

const ZENMUX_ENDPOINTS: &[ProviderEndpointSpec] = &[ProviderEndpointSpec {
    id: "default",
    label: "ZenMux",
    base_url: "https://zenmux.ai/api/v1",
    anthropic_base_url: Some("https://zenmux.ai/api/anthropic"),
}];

const LONGCAT_ENDPOINTS: &[ProviderEndpointSpec] = &[ProviderEndpointSpec {
    id: "default",
    label: "LongCat",
    base_url: "https://api.longcat.chat/openai",
    anthropic_base_url: Some("https://api.longcat.chat/anthropic"),
}];

const AIHUBMIX_ENDPOINTS: &[ProviderEndpointSpec] = &[ProviderEndpointSpec {
    id: "default",
    label: "AiHubMix",
    base_url: "https://aihubmix.com/v1",
    anthropic_base_url: Some("https://aihubmix.com"),
}];

const MODELSCOPE_ENDPOINTS: &[ProviderEndpointSpec] = &[ProviderEndpointSpec {
    id: "default",
    label: "ModelScope",
    base_url: "https://api-inference.modelscope.cn/v1",
    anthropic_base_url: Some("https://api-inference.modelscope.cn"),
}];

const CHERRYIN_ENDPOINTS: &[ProviderEndpointSpec] = &[ProviderEndpointSpec {
    id: "default",
    label: "CherryIN",
    base_url: "https://open.cherryin.net/v1",
    anthropic_base_url: Some("https://open.cherryin.net"),
}];

/// AWS Bedrock via the `bedrock-mantle` endpoint, which serves both an
/// OpenAI-compatible (`/openai/v1`) and an Anthropic-compatible (`/anthropic`)
/// surface authenticated with a Bedrock API key as a bearer / `x-api-key`
/// token. Regions beyond these are reachable via a custom base URL.
const BEDROCK_ENDPOINTS: &[ProviderEndpointSpec] = &[
    ProviderEndpointSpec {
        id: "us-east-1",
        label: "us-east-1 (N. Virginia)",
        base_url: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
        anthropic_base_url: Some("https://bedrock-mantle.us-east-1.api.aws/anthropic"),
    },
    ProviderEndpointSpec {
        id: "us-west-2",
        label: "us-west-2 (Oregon)",
        base_url: "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
        anthropic_base_url: Some("https://bedrock-mantle.us-west-2.api.aws/anthropic"),
    },
    ProviderEndpointSpec {
        id: "eu-central-1",
        label: "eu-central-1 (Frankfurt)",
        base_url: "https://bedrock-mantle.eu-central-1.api.aws/openai/v1",
        anthropic_base_url: Some("https://bedrock-mantle.eu-central-1.api.aws/anthropic"),
    },
    ProviderEndpointSpec {
        id: "ap-northeast-1",
        label: "ap-northeast-1 (Tokyo)",
        base_url: "https://bedrock-mantle.ap-northeast-1.api.aws/openai/v1",
        anthropic_base_url: Some("https://bedrock-mantle.ap-northeast-1.api.aws/anthropic"),
    },
];

/// Provider configuration returned to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderConfig {
    /// Default env var name for API key (e.g., "ANTHROPIC_API_KEY")
    pub api_key_env_var: String,
    /// Default env var name for base URL (e.g., "AZURE_OPENAI_ENDPOINT")
    pub base_url_env_var: Option<String>,
    /// Whether this provider supports custom base URL (proxy)
    pub supports_base_url: bool,
    /// Default base URL for API calls (used when user doesn't provide one)
    pub default_base_url: Option<String>,
    pub supported_protocols: Vec<String>,
    pub default_protocol: String,
    /// Selectable endpoints. Empty when the provider has a single implicit
    /// endpoint and no Anthropic-protocol URL of its own.
    pub endpoints: Vec<ProviderEndpoint>,
}

impl ProviderConfig {
    fn new(
        api_key_env_var: &str,
        base_url_env_var: Option<&str>,
        supports_base_url: bool,
        default_base_url: Option<&str>,
    ) -> Self {
        Self::with_protocols(
            api_key_env_var,
            base_url_env_var,
            supports_base_url,
            default_base_url,
            &["openai"],
            "openai",
        )
    }

    fn with_protocols(
        api_key_env_var: &str,
        base_url_env_var: Option<&str>,
        supports_base_url: bool,
        default_base_url: Option<&str>,
        supported_protocols: &[&str],
        default_protocol: &str,
    ) -> Self {
        Self {
            api_key_env_var: api_key_env_var.to_string(),
            base_url_env_var: base_url_env_var.map(str::to_string),
            supports_base_url,
            default_base_url: default_base_url.map(str::to_string),
            supported_protocols: supported_protocols
                .iter()
                .map(|value| value.to_string())
                .collect(),
            default_protocol: default_protocol.to_string(),
            endpoints: Vec::new(),
        }
    }

    /// Attach selectable endpoints.
    ///
    /// The first endpoint is the provider's default, so it also supplies
    /// `default_base_url` — call sites pass `None` for that argument and let
    /// the endpoint table be the single place a base URL is written down.
    fn with_endpoints(mut self, endpoints: &'static [ProviderEndpointSpec]) -> Self {
        debug_assert!(
            !endpoints.is_empty(),
            "with_endpoints requires at least one endpoint"
        );
        self.default_base_url = endpoints.first().map(|spec| spec.base_url.to_string());
        self.endpoints = endpoints.iter().map(ProviderEndpoint::from).collect();
        self
    }

    /// Anthropic-protocol base URL of the default endpoint, when it exposes one.
    ///
    /// Callers that know which endpoint the account uses should read
    /// `endpoints` directly; this is the fallback for "no base URL supplied".
    pub fn default_anthropic_base_url(&self) -> Option<String> {
        self.endpoints
            .first()
            .and_then(|endpoint| endpoint.anthropic_base_url.clone())
    }
}

/// Get provider configuration for a given model type.
///
/// Returns configuration including env var names and default base URLs.
/// This is the single source of truth - frontend should NOT duplicate these values.
pub fn get_provider_config(model_type: &str) -> ProviderConfig {
    match model_type.to_lowercase().as_str() {
        "cursor_cli" => ProviderConfig::new("CURSOR_API_KEY", None, false, None),
        "claude_code" => ProviderConfig::with_protocols(
            "ANTHROPIC_API_KEY",
            None,
            false,
            None,
            &["anthropic"],
            "anthropic",
        ),
        "codex" => ProviderConfig::new("OPENAI_API_KEY", None, false, None),
        "gemini_cli" => ProviderConfig::new("GEMINI_API_KEY", None, false, None),
        "copilot" => ProviderConfig::new("GITHUB_TOKEN", None, false, None),
        "kiro" => ProviderConfig::new("KIRO_SESSION_TOKEN", None, false, None),
        "kimi_cli" => ProviderConfig::new("MOONSHOT_API_KEY", Some("MOONSHOT_BASE_URL"), true, None)
            .with_endpoints(MOONSHOT_ENDPOINTS),
        "opencode" => {
            ProviderConfig::new("OPENCODE_API_KEY", Some("OPENCODE_BASE_URL"), true, None)
                .with_endpoints(OPENCODE_ENDPOINTS)
        }
        "anthropic_api" => ProviderConfig::with_protocols(
            "ANTHROPIC_API_KEY",
            None,
            true,
            Some("https://api.anthropic.com/v1"),
            &["anthropic"],
            "anthropic",
        ),
        "openai_api" => ProviderConfig::new(
            "OPENAI_API_KEY",
            None,
            true,
            Some("https://api.openai.com/v1"),
        ),
        "deepseek_api" => ProviderConfig::new(
            "DEEPSEEK_API_KEY",
            None,
            true,
            Some("https://api.deepseek.com"),
        ),
        "gemini_api" => ProviderConfig::new(
            "GEMINI_API_KEY",
            None,
            true,
            Some("https://generativelanguage.googleapis.com/v1beta"),
        ),
        "groq_api" => ProviderConfig::new(
            "GROQ_API_KEY",
            None,
            true,
            Some("https://api.groq.com/openai/v1"),
        ),
        "xai_api" => ProviderConfig::new("XAI_API_KEY", None, true, Some("https://api.x.ai/v1")),
        "zhipu_api" => {
            ProviderConfig::with_protocols(
                "ZHIPU_API_KEY",
                None,
                true,
                None,
                &["openai", "anthropic"],
                "openai",
            )
            .with_endpoints(ZHIPU_ENDPOINTS)
        }
        "dashscope_api" => ProviderConfig::new("DASHSCOPE_API_KEY", None, true, None)
            .with_endpoints(DASHSCOPE_ENDPOINTS),
        "moonshot_api" => ProviderConfig::with_protocols(
            "MOONSHOT_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(MOONSHOT_ENDPOINTS),
        "openrouter_api" => ProviderConfig::new(
            "OPENROUTER_API_KEY",
            None,
            true,
            Some("https://openrouter.ai/api/v1"),
        ),
        "zenmux_api" => ProviderConfig::with_protocols(
            "ZENMUX_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(ZENMUX_ENDPOINTS),
        "minimax_api" => ProviderConfig::with_protocols(
            "MINIMAX_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(MINIMAX_ENDPOINTS),
        "longcat_api" => ProviderConfig::with_protocols(
            "LONGCAT_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(LONGCAT_ENDPOINTS),
        "siliconflow_api" => ProviderConfig::with_protocols(
            "SILICONFLOW_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(SILICONFLOW_ENDPOINTS),
        "modelscope_api" => ProviderConfig::with_protocols(
            "MODELSCOPE_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(MODELSCOPE_ENDPOINTS),
        "aihubmix_api" => ProviderConfig::with_protocols(
            "AIHUBMIX_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(AIHUBMIX_ENDPOINTS),
        "cherryin_api" => ProviderConfig::with_protocols(
            "CHERRYIN_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(CHERRYIN_ENDPOINTS),
        "bedrock_api" => ProviderConfig::with_protocols(
            "AWS_BEARER_TOKEN_BEDROCK",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(BEDROCK_ENDPOINTS),
        // Fully user-defined gateway: the user supplies base URL and protocol,
        // so there is no endpoint table and no default base URL to offer.
        "custom_api" => ProviderConfig::with_protocols(
            "CUSTOM_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        ),
        // Embeddings use the OpenAI-compatible `/embeddings` wire format but
        // are intentionally excluded from generation provider selection.
        "embedding_api" => ProviderConfig::new("EMBEDDING_API_KEY", None, true, None),
        "vllm_api" => ProviderConfig::with_protocols(
            "VLLM_API_KEY",
            None,
            true,
            Some("http://localhost:8000/v1"),
            &["openai", "anthropic"],
            "openai",
        ),
        "azure_openai_api" => ProviderConfig::new(
            "AZURE_OPENAI_API_KEY",
            Some("AZURE_OPENAI_ENDPOINT"),
            true,
            None,
        ),
        "azure_anthropic_api" => ProviderConfig::with_protocols(
            "AZURE_ANTHROPIC_API_KEY",
            Some("AZURE_ANTHROPIC_ENDPOINT"),
            true,
            None,
            &["anthropic"],
            "anthropic",
        ),
        "orgii_orchestrator" => {
            ProviderConfig::new("ORGII_API_KEY", None, true, Some("https://api.orgii.ai/v1"))
        }
        _ => ProviderConfig::new("API_KEY", None, false, None),
    }
}

/// Get all provider configs at once.
/// Frontend can cache this on startup instead of making per-provider calls.
pub fn get_all_provider_configs() -> Vec<(String, ProviderConfig)> {
    let model_types = vec![
        // CLI agents
        "cursor_cli",
        "claude_code",
        "codex",
        "gemini_cli",
        "copilot",
        "kiro",
        "kimi_cli",
        "opencode",
        // API providers
        "anthropic_api",
        "openai_api",
        "deepseek_api",
        "gemini_api",
        "groq_api",
        "xai_api",
        "zhipu_api",
        "dashscope_api",
        "moonshot_api",
        "openrouter_api",
        "zenmux_api",
        "minimax_api",
        "longcat_api",
        "siliconflow_api",
        "modelscope_api",
        "aihubmix_api",
        "cherryin_api",
        "bedrock_api",
        "custom_api",
        "embedding_api",
        "vllm_api",
        "azure_openai_api",
        "azure_anthropic_api",
        "orgii_orchestrator",
    ];

    model_types
        .into_iter()
        .map(|mt| (mt.to_string(), get_provider_config(mt)))
        .collect()
}

#[cfg(test)]
mod tests {
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
        assert!(configs.iter().any(|(k, _)| k == "zenmux_api"));
        assert!(configs.iter().any(|(k, _)| k == "cursor_cli"));
        let embedding = configs
            .iter()
            .find(|(k, _)| k == "embedding_api")
            .expect("embedding provider config");
        assert_eq!(embedding.1.api_key_env_var, "EMBEDDING_API_KEY");
        assert!(embedding.1.supports_base_url);
    }

    #[test]
    fn all_registered_cli_agents_have_provider_configs() {
        let configs = get_all_provider_configs();
        for agent in [
            "cursor_cli",
            "claude_code",
            "codex",
            "gemini_cli",
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
    fn zhipu_offers_china_and_global_endpoints() {
        let config = get_provider_config("zhipu_api");
        let ids: Vec<&str> = config
            .endpoints
            .iter()
            .map(|endpoint| endpoint.id.as_str())
            .collect();
        assert_eq!(ids, vec!["global", "cn"]);
        assert_eq!(
            config.endpoints[0].base_url,
            "https://api.z.ai/api/paas/v4",
            "global Zhipu traffic goes to z.ai"
        );
        assert_eq!(
            config.endpoints[1].base_url,
            "https://open.bigmodel.cn/api/paas/v4",
            "China Zhipu traffic goes to bigmodel.cn"
        );
        // The international host is the default; China is opt-in.
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
}
