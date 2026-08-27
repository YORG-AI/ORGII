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
/// than one route: a credential type (Zhipu API vs Coding Plan subscription),
/// a regional split, a product tier (OpenCode Zen vs Go), or an AWS region (Bedrock).
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
        label: "Global API",
        base_url: "https://api.z.ai/api/paas/v4",
        anthropic_base_url: Some("https://api.z.ai/api/anthropic"),
    },
    ProviderEndpointSpec {
        id: "global-subscription",
        label: "Global Subscription",
        base_url: "https://api.z.ai/api/coding/paas/v4",
        anthropic_base_url: Some("https://api.z.ai/api/anthropic"),
    },
    ProviderEndpointSpec {
        id: "cn",
        label: "China API",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        anthropic_base_url: Some("https://open.bigmodel.cn/api/anthropic"),
    },
    ProviderEndpointSpec {
        id: "cn-subscription",
        label: "China Subscription",
        base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
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

const ATLASCLOUD_ENDPOINTS: &[ProviderEndpointSpec] = &[ProviderEndpointSpec {
    id: "default",
    label: "Atlas Cloud",
    base_url: "https://api.atlascloud.ai/v1",
    anthropic_base_url: Some("https://api.atlascloud.ai"),
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
        "copilot" => ProviderConfig::new("GITHUB_TOKEN", None, false, None),
        "kiro" => ProviderConfig::new("KIRO_SESSION_TOKEN", None, false, None),
        "kimi_cli" => {
            ProviderConfig::new("MOONSHOT_API_KEY", Some("MOONSHOT_BASE_URL"), true, None)
                .with_endpoints(MOONSHOT_ENDPOINTS)
        }
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
        "atlascloud_api" => ProviderConfig::with_protocols(
            "ATLASCLOUD_API_KEY",
            Some("ATLASCLOUD_BASE_URL"),
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(ATLASCLOUD_ENDPOINTS),
        "deepseek_api" => ProviderConfig::new(
            "DEEPSEEK_API_KEY",
            None,
            true,
            Some("https://api.deepseek.com"),
        ),
        "gemini_api" => ProviderConfig::with_protocols(
            "GEMINI_API_KEY",
            None,
            true,
            Some("https://generativelanguage.googleapis.com/v1beta"),
            &["gemini"],
            "gemini",
        ),
        "groq_api" => ProviderConfig::new(
            "GROQ_API_KEY",
            None,
            true,
            Some("https://api.groq.com/openai/v1"),
        ),
        "xai_api" => ProviderConfig::new("XAI_API_KEY", None, true, Some("https://api.x.ai/v1")),
        "zhipu_api" => ProviderConfig::with_protocols(
            "ZHIPU_API_KEY",
            None,
            true,
            None,
            &["openai", "anthropic"],
            "openai",
        )
        .with_endpoints(ZHIPU_ENDPOINTS),
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
        "copilot",
        "kiro",
        "kimi_cli",
        "opencode",
        // API providers
        "anthropic_api",
        "openai_api",
        "atlascloud_api",
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
#[path = "provider_config_tests.rs"]
mod tests;
