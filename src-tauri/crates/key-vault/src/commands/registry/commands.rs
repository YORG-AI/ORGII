//! Tauri commands for agent/provider discovery.
//!
//! Runtime queries that read from KEY_SERVICE, detect installed binaries,
//! and merge static registry data with live state.

use crate::key_store::KEY_SERVICE;
use crate::provider_config::{
    get_all_provider_configs as get_all_configs_impl, get_provider_config as get_config_impl,
    ProviderConfig,
};

use super::data::{
    api_provider_registry, cli_agent_registry, cli_env_config, cli_install_methods,
    cli_uninstall_methods, infer_install_method,
};
use super::{AvailableAgent, AvailableApiProvider};

/// Get available CLI agents with full metadata (install methods, env config, etc.).
/// Single source of truth — frontend reads this instead of hardcoding.
#[tauri::command]
pub async fn get_available_agents() -> Result<Vec<AvailableAgent>, String> {
    let registry = cli_agent_registry();
    let stored_keys = KEY_SERVICE.list_keys();

    let which_cmd = if cfg!(windows) { "where" } else { "which" };

    // Explicitly pass the current PATH so the augmented login-shell PATH
    // (set by app_paths::augment_path_from_shell at startup) is visible even
    // if the async tokio runtime was initialised before the env was updated.
    let current_path = std::env::var("PATH").unwrap_or_default();
    tracing::debug!("[get_available_agents] PATH={}", current_path);

    let mut results = Vec::new();
    for entry in &registry {
        let mut which_command = tokio::process::Command::new(which_cmd);
        which_command.arg(entry.binary).env("PATH", &current_path);
        // Suppress the console window each `where`/`which` probe would flash on
        // Windows — this loops over every registered agent, so it's a burst.
        #[cfg(windows)]
        which_command.creation_flags(app_platform::CREATE_NO_WINDOW);
        let output = which_command.output().await.ok();

        let installed = output.as_ref().map(|o| o.status.success()).unwrap_or(false);
        tracing::debug!(
            "[get_available_agents] {} ({}) → installed={}",
            entry.display_name,
            entry.binary,
            installed
        );

        let installed_via = if installed {
            output.as_ref().and_then(|o| {
                let path = String::from_utf8_lossy(&o.stdout);
                let first_line = path.lines().next().unwrap_or("").trim();
                if first_line.is_empty() {
                    None
                } else {
                    infer_install_method(first_line)
                }
            })
        } else {
            None
        };

        // A CLI agent is considered "configured" if the vault holds either:
        //   (a) a key whose model_type matches the agent's own name, OR
        //   (b) a key whose model_type matches any of the agent's
        //       compatible_api_providers (e.g. "anthropic_api" for claude_code).
        let has_key = stored_keys.iter().any(|k| {
            k.model_type.as_str() == entry.name
                || entry
                    .compatible_api_providers
                    .contains(&k.model_type.as_str())
        });

        results.push(AvailableAgent {
            name: entry.name.to_string(),
            display_name: entry.display_name.to_string(),
            installed,
            has_keys: has_key,
            installed_via,
            description: entry.description.to_string(),
            brand_color: entry.brand_color.to_string(),
            docs_url: Some(entry.docs_url.to_string()),
            has_subscription_plan: entry.has_subscription_plan,
            compatible_api_providers: entry
                .compatible_api_providers
                .iter()
                .map(|s| s.to_string())
                .collect(),
            install_methods: cli_install_methods(entry.name),
            uninstall_methods: cli_uninstall_methods(entry.name),
            env_config: cli_env_config(entry.name),
            is_complex_setup: entry.is_complex_setup,
            default_setup_method: entry.default_setup_method.map(String::from),
            popular: entry.popular,
            icon_provider: entry.icon_provider.to_string(),
            paired_api_provider: entry.paired_api_provider.map(String::from),
            supports_rust_agents: entry.supports_rust_agents,
            supports_orgii_pool: false,
        });
    }

    Ok(results)
}

/// Get available API providers with full metadata.
/// Single source of truth — frontend reads this instead of hardcoding.
#[tauri::command]
pub fn get_available_api_providers() -> Vec<AvailableApiProvider> {
    let registry = api_provider_registry();
    let cli_registry = cli_agent_registry();
    let stored_keys = KEY_SERVICE.list_keys();

    registry
        .into_iter()
        .map(|entry| {
            let has_key = stored_keys
                .iter()
                .any(|k| k.model_type.as_str() == entry.name);

            let config = get_config_impl(entry.name);

            // Find CLI agents that list this provider in their compatible_api_providers
            let compatible_cli_agents: Vec<String> = cli_registry
                .iter()
                .filter(|cli| cli.compatible_api_providers.contains(&entry.name))
                .map(|cli| cli.name.to_string())
                .collect();

            AvailableApiProvider {
                name: entry.name.to_string(),
                display_name: entry.display_name.to_string(),
                has_keys: has_key,
                description: entry.description.to_string(),
                brand_color: entry.brand_color.to_string(),
                docs_url: Some(entry.docs_url.to_string()),
                icon_provider: entry.icon_provider.to_string(),
                paired_cli_agent: entry.paired_cli_agent.map(String::from),
                popular: entry.popular,
                api_key_env_var: config.api_key_env_var,
                supports_base_url: config.supports_base_url,
                default_base_url: config.default_base_url,
                supported_protocols: config.supported_protocols,
                default_protocol: config.default_protocol,
                compatible_cli_agents,
                supports_rust_agents: entry.supports_rust_agents,
            }
        })
        .collect()
}

// ============================================
// Provider Config Commands
// ============================================

/// Get configuration for a single provider (base URL, env vars, etc.).
/// Single source of truth for provider settings.
#[tauri::command]
pub fn get_provider_config(model_type: String) -> ProviderConfig {
    get_config_impl(&model_type)
}

/// Get configuration for all providers at once.
/// Frontend can cache this on startup instead of making per-provider calls.
#[tauri::command]
pub fn get_all_provider_configs() -> std::collections::HashMap<String, ProviderConfig> {
    get_all_configs_impl().into_iter().collect()
}
