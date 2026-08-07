//! Tauri commands for agent/provider discovery.
//!
//! Runtime queries that read from KEY_SERVICE, detect installed binaries,
//! and merge static registry data with live state.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use integrations::cli_binary_resolver::resolve_cli_binary_for_registry_name;

use crate::key_store::KEY_SERVICE;
use crate::provider_config::{
    get_all_provider_configs as get_all_configs_impl, get_provider_config as get_config_impl,
    ProviderConfig,
};

use super::data::supported_setup_methods_for_agent;
use super::data::{
    api_provider_registry, cli_agent_registry, cli_env_config, cli_install_methods,
    cli_uninstall_methods, infer_install_method, CliConfigPathKind,
};
use super::{AvailableAgent, AvailableApiProvider, CliConfigFile};

const AVAILABLE_AGENTS_CACHE_TTL: Duration = Duration::from_secs(60);
const PROTOCOL_ANTHROPIC_MESSAGES: &str = "Anthropic Messages";
const PROTOCOL_ANTHROPIC_COMPATIBLE: &str = "Anthropic-compatible";
const PROTOCOL_GEMINI: &str = "Gemini";
const PROTOCOL_LOCAL_OPENAI_COMPATIBLE: &str = "vLLM / local OpenAI-compatible";
const PROTOCOL_OPENAI_COMPATIBLE: &str = "OpenAI-compatible";
const PROTOCOL_OPENROUTER: &str = "OpenRouter";

fn protocol_for_api_provider(provider: &str) -> &str {
    match provider {
        "anthropic_api" | "azure_anthropic_api" => PROTOCOL_ANTHROPIC_MESSAGES,
        "moonshot_api" => PROTOCOL_ANTHROPIC_COMPATIBLE,
        "gemini_api" => PROTOCOL_GEMINI,
        "openrouter_api" => PROTOCOL_OPENROUTER,
        "vllm_api" => PROTOCOL_LOCAL_OPENAI_COMPATIBLE,
        _ => PROTOCOL_OPENAI_COMPATIBLE,
    }
}

fn supported_protocols_for_api_providers(providers: &[&str]) -> Vec<String> {
    let mut protocols: Vec<String> = Vec::new();
    for provider in providers {
        let protocol = protocol_for_api_provider(provider).to_string();
        if !protocols.contains(&protocol) {
            protocols.push(protocol);
        }
    }
    protocols
}

fn native_subscription_labels_for_agent(agent_name: &str) -> Vec<String> {
    let labels = match agent_name {
        "cursor_cli" => &["Cursor account / Cursor subscription"][..],
        "claude_code" => &["Claude Pro / Max account", "Anthropic Console account"],
        "codex" => &["ChatGPT account", "OpenAI API account"],
        "kiro" => &["Kiro account"],
        "copilot" => &["GitHub Copilot subscription"],
        "opencode" => &["opencode account"],
        "amp" => &["Amp subscription / AMP_API_KEY"],
        "cline" => &["Cline account"],
        "grok_cli" => &["xAI account / Grok subscription"],
        "devin" => &["Devin account"],
        "rovo" => &["Atlassian account with Rovo entitlement"],
        "aug" => &["Augment Code account"],
        "codebuff" => &["Codebuff account"],
        "continue_cli" => &["Continue Hub account"],
        "droid" => &["Factory account / Droid subscription"],
        "mistral_vibe" => &["Mistral account"],
        "omp" => &["OMP account"],
        "pi" => &["Pi account"],
        _ => &[],
    };

    labels.iter().map(|label| label.to_string()).collect()
}

async fn detect_cli_installation(
    agent_name: &str,
    binary: &str,
    current_path: &str,
) -> (bool, Option<String>, String) {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut which_command = tokio::process::Command::new(which_cmd);
    which_command.arg(binary).env("PATH", current_path);
    #[cfg(windows)]
    which_command.creation_flags(app_platform::CREATE_NO_WINDOW);

    if let Ok(output) = which_command.output().await {
        if output.status.success() {
            let first_path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let installed_via = if first_path.is_empty() {
                None
            } else {
                infer_install_method(&first_path)
            };
            return (true, installed_via, binary.to_string());
        }
    }

    if let Some(resolution) = resolve_cli_binary_for_registry_name(agent_name) {
        if resolution.installed() {
            return (
                true,
                infer_install_method(&resolution.command),
                resolution.metadata.command.to_string(),
            );
        }
    }

    (false, None, binary.to_string())
}

fn resolve_cli_config_path(kind: CliConfigPathKind, relative_path: &str) -> String {
    let base = match kind {
        CliConfigPathKind::HomeRelative => app_paths::home_dir(),
        CliConfigPathKind::XdgConfigRelative => std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| app_paths::home_dir().join(".config")),
        CliConfigPathKind::AppDataRelative => std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| app_paths::home_dir().join(".config")),
    };
    base.join(relative_path).to_string_lossy().to_string()
}

#[derive(Clone)]
struct AvailableAgentsCacheEntry {
    path: String,
    key_signature: String,
    binary_signature: String,
    captured_at: Instant,
    agents: Vec<AvailableAgent>,
}

static AVAILABLE_AGENTS_CACHE: OnceLock<Mutex<Option<AvailableAgentsCacheEntry>>> = OnceLock::new();

fn cached_available_agents(
    path: &str,
    key_signature: &str,
    binary_signature: &str,
) -> Option<Vec<AvailableAgent>> {
    let cache = AVAILABLE_AGENTS_CACHE.get_or_init(|| Mutex::new(None));
    let Ok(cache) = cache.lock() else {
        return None;
    };
    let Some(entry) = cache.as_ref() else {
        return None;
    };
    if entry.path == path
        && entry.key_signature == key_signature
        && entry.binary_signature == binary_signature
        && entry.captured_at.elapsed() < AVAILABLE_AGENTS_CACHE_TTL
    {
        return Some(entry.agents.clone());
    }
    None
}

fn store_available_agents_cache(
    path: String,
    key_signature: String,
    binary_signature: String,
    agents: Vec<AvailableAgent>,
) {
    let cache = AVAILABLE_AGENTS_CACHE.get_or_init(|| Mutex::new(None));
    let Ok(mut cache) = cache.lock() else {
        return;
    };
    *cache = Some(AvailableAgentsCacheEntry {
        path,
        key_signature,
        binary_signature,
        captured_at: Instant::now(),
        agents,
    });
}

fn command_path_candidates(dir: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            return vec![dir.join(command)];
        }

        let path_ext = std::env::var("PATHEXT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());

        path_ext
            .split(';')
            .filter_map(|extension| {
                let extension = extension.trim();
                if extension.is_empty() {
                    None
                } else if extension.starts_with('.') {
                    Some(dir.join(format!("{command}{extension}")))
                } else {
                    Some(dir.join(format!("{command}.{extension}")))
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![dir.join(command)]
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn binary_cache_fingerprint(path: &Path) -> String {
    let Ok(metadata) = fs::metadata(path) else {
        return path.to_string_lossy().to_string();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| format!("{}.{}", duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or_else(|| "unknown".to_string());
    format!("{}:{}:{}", path.to_string_lossy(), metadata.len(), modified)
}

fn path_binary_signature(registry_entries: &[(&str, &str)], path: &str) -> String {
    let path_dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    registry_entries
        .iter()
        .map(|(name, binary)| {
            let fingerprint = path_dirs
                .iter()
                .flat_map(|dir| command_path_candidates(dir, binary))
                .find(|candidate| is_executable_file(candidate))
                .map(|candidate| binary_cache_fingerprint(&candidate))
                .unwrap_or_else(|| "-".to_string());
            format!("{name}={fingerprint}")
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// Get available CLI agents with full metadata (install methods, env config, etc.).
/// Single source of truth — frontend reads this instead of hardcoding.
#[tauri::command]
pub async fn get_available_agents() -> Result<Vec<AvailableAgent>, String> {
    let registry = cli_agent_registry();
    let stored_keys = KEY_SERVICE.list_keys();

    // Explicitly pass the current PATH so the augmented login-shell PATH
    // (set by app_paths::augment_path_from_shell at startup) is visible even
    // if the async tokio runtime was initialised before the env was updated.
    let current_path = std::env::var("PATH").unwrap_or_default();
    let mut key_signature_parts: Vec<String> = stored_keys
        .iter()
        .map(|key| format!("{}:{}", key.id, key.model_type.as_str()))
        .collect();
    key_signature_parts.sort();
    let current_key_signature = key_signature_parts.join("|");
    let binary_signature_entries: Vec<(&str, &str)> = registry
        .iter()
        .map(|entry| (entry.name, entry.binary))
        .collect();
    let current_binary_signature = path_binary_signature(&binary_signature_entries, &current_path);
    if let Some(agents) = cached_available_agents(
        &current_path,
        &current_key_signature,
        &current_binary_signature,
    ) {
        return Ok(agents);
    }
    tracing::debug!("[get_available_agents] PATH={}", current_path);

    let mut results = Vec::new();
    for entry in &registry {
        let (installed, installed_via, resolved_command) =
            detect_cli_installation(entry.name, entry.binary, &current_path).await;
        tracing::debug!(
            "[get_available_agents] {} ({}) → installed={} resolved_command={}",
            entry.display_name,
            entry.binary,
            installed,
            resolved_command
        );

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
            native_subscription_labels: native_subscription_labels_for_agent(entry.name),
            compatible_api_providers: entry
                .compatible_api_providers
                .iter()
                .map(|s| s.to_string())
                .collect(),
            supported_protocols: supported_protocols_for_api_providers(
                entry.compatible_api_providers,
            ),
            config_files: entry
                .config_files
                .iter()
                .map(|config| CliConfigFile {
                    id: config.id.to_string(),
                    label: config.label.to_string(),
                    path: resolve_cli_config_path(config.path_kind, config.relative_path),
                    format: config.format,
                    secret_bearing: config.secret_bearing,
                })
                .collect(),
            install_methods: cli_install_methods(entry.name),
            uninstall_methods: cli_uninstall_methods(entry.name),
            env_config: cli_env_config(entry.name),
            is_complex_setup: entry.is_complex_setup,
            default_setup_method: entry.default_setup_method.map(String::from),
            supported_setup_methods: supported_setup_methods_for_agent(
                entry.name,
                entry.is_complex_setup,
            )
            .iter()
            .map(|method| (*method).to_string())
            .collect(),
            popular: entry.popular,
            icon_provider: entry.icon_provider.to_string(),
            paired_api_provider: entry.paired_api_provider.map(String::from),
            supports_rust_agents: entry.supports_rust_agents,
            acp_support: entry.acp_support,
            supports_orgii_pool: false,
            command: resolved_command,
            supports_gui: entry.supports_gui,
        });
    }

    store_available_agents_cache(
        current_path,
        current_key_signature,
        current_binary_signature,
        results.clone(),
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(path: &Path) {
        fs::write(path, "@echo off\r\nexit /b 0\r\n").unwrap();
    }

    #[test]
    fn path_binary_signature_changes_when_binary_appears_in_existing_path_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().to_string_lossy().to_string();
        let entries = [("codex", "codex")];

        let before = path_binary_signature(&entries, &path);
        make_executable(&temp_dir.path().join("codex"));
        let after = path_binary_signature(&entries, &path);

        assert_ne!(before, after);
        assert!(before.contains("codex=-"));
        assert!(after.contains("codex="));
        assert!(!after.contains("codex=-"));
    }
}
