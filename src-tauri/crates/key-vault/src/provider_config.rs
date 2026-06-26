//! Provider configuration module.
//!
//! Single source of truth for provider-specific settings:
//! - Default base URLs for API providers
//! - Environment variable names for API keys and base URLs
//! - Provider capabilities (supports custom base URL, auth method, etc.)

use serde::Serialize;

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
        }
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
        "kimi_cli" => ProviderConfig::new(
            "MOONSHOT_API_KEY",
            Some("MOONSHOT_BASE_URL"),
            true,
            Some("https://api.moonshot.cn/v1"),
        ),
        "opencode" => ProviderConfig::new("OPENCODE_API_KEY", None, false, None),
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
        "zhipu_api" => ProviderConfig::with_protocols(
            "ZHIPU_API_KEY",
            None,
            true,
            Some("https://open.bigmodel.cn/api/paas/v4"),
            &["openai", "anthropic"],
            "openai",
        ),
        "dashscope_api" => ProviderConfig::new(
            "DASHSCOPE_API_KEY",
            None,
            true,
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        ),
        "moonshot_api" => ProviderConfig::new(
            "MOONSHOT_API_KEY",
            None,
            true,
            Some("https://api.moonshot.cn/v1"),
        ),
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
            Some("https://zenmux.ai/api/v1"),
            &["openai", "anthropic"],
            "openai",
        ),
        "minimax_api" => ProviderConfig::new(
            "MINIMAX_API_KEY",
            None,
            true,
            Some("https://api.minimax.io/v1"),
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

    #[test]
    fn kimi_and_opencode_cli_configs_match_setup_registry() {
        let kimi = get_provider_config("kimi_cli");
        assert_eq!(kimi.api_key_env_var, "MOONSHOT_API_KEY");
        assert_eq!(kimi.base_url_env_var, Some("MOONSHOT_BASE_URL".to_string()));
        assert!(kimi.supports_base_url);
        assert_eq!(
            kimi.default_base_url,
            Some("https://api.moonshot.cn/v1".to_string())
        );

        let opencode = get_provider_config("opencode");
        assert_eq!(opencode.api_key_env_var, "OPENCODE_API_KEY");
        assert!(!opencode.supports_base_url);
        assert!(opencode.default_base_url.is_none());
    }
}
