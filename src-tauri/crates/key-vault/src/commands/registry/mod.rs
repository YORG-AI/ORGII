//! Agent and API provider registry.
//!
//! Single source of truth for CLI agent metadata, API provider metadata,
//! compatibility mappings, and install/uninstall methods.
//!
//! - `data` — static registry entries and helper functions (pure data, no Tauri)
//! - `commands` — `#[tauri::command]` fns that query the registry at runtime

mod commands;
mod data;

use data::{AcpSupport, CliConfigFormat};

// Re-export Tauri commands
pub use commands::*;
// Re-export for crate-internal consumers (tests)
#[cfg(test)]
pub(crate) use data::infer_install_method;

/// Return whether the central CLI registry allows an API provider for an agent.
///
/// Runtime integrations should use this instead of duplicating provider lists.
pub fn is_cli_provider_compatible(agent_name: &str, provider_name: &str) -> bool {
    data::cli_agent_registry()
        .into_iter()
        .find(|agent| agent.name == agent_name)
        .is_some_and(|agent| agent.compatible_api_providers.contains(&provider_name))
}

pub fn cli_agent_display_name(agent_name: &str) -> Option<&'static str> {
    data::cli_agent_registry()
        .into_iter()
        .find(|agent| agent.name == agent_name)
        .map(|agent| agent.display_name)
}

// ============================================
// Shared types (serialized to frontend via JSON)
// ============================================

/// A single install/uninstall method for a CLI agent.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallMethod {
    pub id: String,
    pub label: String,
    pub command: String,
}

/// Environment variable configuration for an agent or API provider.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnvConfig {
    pub api_key_env_var: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url_env_var: Option<String>,
    pub supports_base_url: bool,
    pub api_key_placeholder_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url_placeholder: Option<String>,
}

/// Documented user-editable config file for a CLI agent.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigFile {
    pub id: String,
    pub label: String,
    pub path: String,
    pub format: CliConfigFormat,
    pub secret_bearing: bool,
}

/// Agent availability info — single source of truth for CLI agent metadata.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgent {
    pub name: String,
    pub display_name: String,
    pub installed: bool,
    pub has_keys: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_via: Option<String>,
    pub description: String,
    pub brand_color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
    pub has_subscription_plan: bool,
    pub native_subscription_labels: Vec<String>,
    pub compatible_api_providers: Vec<String>,
    pub supported_protocols: Vec<String>,
    pub config_files: Vec<CliConfigFile>,
    pub install_methods: Vec<CliInstallMethod>,
    pub uninstall_methods: Vec<CliInstallMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_config: Option<AgentEnvConfig>,
    pub is_complex_setup: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_setup_method: Option<String>,
    /// Setup methods available in the Key Vault GenericSetup wizard flow.
    pub supported_setup_methods: Vec<String>,
    pub popular: bool,
    /// Icon provider key for ModelIcon lookup (e.g., "cursor", "claude_code")
    pub icon_provider: String,
    /// Paired API provider for brand grouping (e.g., "anthropic_api" for claude_code)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired_api_provider: Option<String>,
    /// Whether ORGII Rust agents (OS Agent, SDE Agent) can use this CLI's credentials.
    /// True for all CLI agents except Cursor (which uses gRPC, not OpenAI-compatible REST).
    pub supports_rust_agents: bool,
    pub acp_support: AcpSupport,
    /// Whether this agent can use ORGII Pool (Token Market) billing.
    /// Only Rust-native agents support ORGII Pool; all CLI agents are false.
    pub supports_orgii_pool: bool,
    /// Bare binary name used to launch the agent in a PTY shell (e.g. "claude", "gemini").
    /// Matches the `command` field in `CLI_BINARY_METADATA` / `CliAgentEntry.binary`.
    pub command: String,
    /// Whether this CLI agent accepts an initial prompt from ORGII's GUI composer
    /// (e.g. via --prompt flag or stdin injection). When false the session creator
    /// shows a Start button instead of the text composer (pure-TUI mode).
    pub supports_gui: bool,
}

/// API provider info — single source of truth for API key provider metadata.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableApiProvider {
    pub name: String,
    pub display_name: String,
    pub has_keys: bool,
    pub description: String,
    pub brand_color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
    /// Icon provider key for ModelIcon lookup (e.g., "openai", "claude")
    pub icon_provider: String,
    /// Paired CLI agent for brand grouping (e.g., "codex" for openai_api)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired_cli_agent: Option<String>,
    pub popular: bool,
    // From provider_config:
    pub api_key_env_var: String,
    pub supports_base_url: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_base_url: Option<String>,
    pub supported_protocols: Vec<String>,
    pub default_protocol: String,
    // Agent compatibility:
    /// CLI agents that can use this API provider (e.g., ["codex"] for openai_api)
    pub compatible_cli_agents: Vec<String>,
    /// Whether ORGII Rust agents (OS Agent, SDE Agent) can use this provider.
    /// True for all API providers (they use OpenAI-compatible REST APIs).
    pub supports_rust_agents: bool,
}

#[cfg(test)]
mod compatibility_tests {
    use super::{cli_agent_display_name, is_cli_provider_compatible};

    #[test]
    fn compatibility_comes_from_the_central_cli_registry() {
        assert!(is_cli_provider_compatible("codex", "openai_api"));
        assert!(is_cli_provider_compatible("claude_code", "anthropic_api"));
        assert!(!is_cli_provider_compatible("unknown", "openai_api"));
        assert_eq!(cli_agent_display_name("opencode"), Some("OpenCode"));
        assert_eq!(cli_agent_display_name("unknown"), None);
    }
}
