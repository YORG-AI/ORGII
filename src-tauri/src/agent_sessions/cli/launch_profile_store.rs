use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use key_vault::key_store::ModelType;
use serde::{Deserialize, Serialize};

use super::session_runner::launch_profiles::{
    bare_command_for_agent, default_args_for_mode, default_env_for_mode, default_permission_mode,
    defaults_for_agent, mode_defaults_view, static_args_to_vec, supported_permission_modes,
    supports_permission_mode, CliLaunchProfileDefaults, CliLaunchProfileOverride,
    CliLaunchProfileUpdate, CliLaunchProfileView, CliPermissionMode, ResolvedCliLaunchProfile,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliLaunchProfileStore {
    profiles: HashMap<String, CliLaunchProfileOverride>,
}

fn store_path() -> PathBuf {
    app_paths::orgii_root()
        .join("config")
        .join("cli_launch_profiles.json")
}

fn read_store() -> Result<CliLaunchProfileStore, String> {
    let path = store_path();
    if !path.exists() {
        return Ok(CliLaunchProfileStore::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read CLI launch profiles: {err}"))?;
    serde_json::from_str(&content)
        .map_err(|err| format!("Failed to parse CLI launch profiles: {err}"))
}

fn write_store(store: &CliLaunchProfileStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create CLI launch profile directory: {err}"))?;
    }
    let content = serde_json::to_string_pretty(store)
        .map_err(|err| format!("Failed to serialize CLI launch profiles: {err}"))?;
    fs::write(&path, content)
        .map_err(|err| format!("Failed to write CLI launch profiles: {err}"))?;
    Ok(())
}

fn parse_cli_agent(agent_name: &str) -> Result<ModelType, String> {
    let agent_type = ModelType::from_str(agent_name)
        .ok_or_else(|| format!("Unknown CLI agent type: {agent_name}"))?;
    if !agent_type.is_cli_agent() {
        return Err(format!("Model type is not a CLI agent: {agent_name}"));
    }
    Ok(agent_type)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_optional_args(value: Option<Vec<String>>) -> Option<Vec<String>> {
    value.map(|items| {
        items
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    })
}

fn normalize_optional_env(
    value: Option<HashMap<String, String>>,
) -> Option<HashMap<String, String>> {
    value.map(|items| {
        items
            .into_iter()
            .filter_map(|(key, value)| {
                let key = key.trim();
                if key.is_empty() {
                    None
                } else {
                    Some((key.to_string(), value))
                }
            })
            .collect()
    })
}

fn normalize_permission_mode(
    defaults: &CliLaunchProfileDefaults,
    mode: Option<CliPermissionMode>,
) -> CliPermissionMode {
    mode.filter(|mode| supports_permission_mode(defaults, *mode))
        .unwrap_or_else(|| default_permission_mode(defaults))
}

pub fn resolve_cli_launch_profile(
    agent_type: &ModelType,
) -> Result<ResolvedCliLaunchProfile, String> {
    let defaults = defaults_for_agent(agent_type)
        .ok_or_else(|| format!("No CLI launch defaults for {}", agent_type.as_str()))?;
    let store = read_store()?;
    let override_profile = store.profiles.get(agent_type.as_str());
    let permission_mode = normalize_permission_mode(
        defaults,
        override_profile.and_then(|profile| profile.permission_mode),
    );
    let default_command = bare_command_for_agent(agent_type)
        .ok_or_else(|| format!("No CLI binary metadata for {}", agent_type.as_str()))?
        .to_string();
    let command = override_profile
        .and_then(|profile| profile.command_override.clone())
        .filter(|command| !command.trim().is_empty())
        .unwrap_or(default_command);
    let args = override_profile
        .and_then(|profile| profile.args_override.clone())
        .unwrap_or_else(|| default_args_for_mode(defaults, permission_mode));
    let env = override_profile
        .and_then(|profile| profile.env_override.clone())
        .unwrap_or_else(|| default_env_for_mode(defaults, permission_mode));
    let transport = override_profile.and_then(|profile| profile.transport.clone());

    Ok(ResolvedCliLaunchProfile {
        permission_mode,
        command,
        args,
        env,
        transport,
    })
}

pub fn cli_launch_profile_get(agent_name: String) -> Result<CliLaunchProfileView, String> {
    let agent_type = parse_cli_agent(&agent_name)?;
    let defaults = defaults_for_agent(&agent_type)
        .ok_or_else(|| format!("No CLI launch defaults for {}", agent_type.as_str()))?;
    let store = read_store()?;
    let override_profile = store.profiles.get(agent_type.as_str());
    let permission_mode = normalize_permission_mode(
        defaults,
        override_profile.and_then(|profile| profile.permission_mode),
    );
    let default_command = bare_command_for_agent(&agent_type)
        .ok_or_else(|| format!("No CLI binary metadata for {}", agent_type.as_str()))?
        .to_string();
    let command = override_profile
        .and_then(|profile| profile.command_override.clone())
        .filter(|command| !command.trim().is_empty())
        .unwrap_or_else(|| default_command.clone());
    let args = override_profile
        .and_then(|profile| profile.args_override.clone())
        .unwrap_or_else(|| default_args_for_mode(defaults, permission_mode));
    let env = override_profile
        .and_then(|profile| profile.env_override.clone())
        .unwrap_or_else(|| default_env_for_mode(defaults, permission_mode));

    let required_args = static_args_to_vec(defaults.command_args);
    let mut effective_command = vec![command.clone()];
    effective_command.extend(required_args.clone());
    effective_command.extend(args.clone());

    Ok(CliLaunchProfileView {
        agent_name: agent_type.as_str().to_string(),
        permission_mode,
        default_command,
        command,
        args,
        env,
        manual_args: default_args_for_mode(defaults, CliPermissionMode::Manual),
        full_permission_args: default_args_for_mode(defaults, CliPermissionMode::FullPermission),
        manual_env: default_env_for_mode(defaults, CliPermissionMode::Manual),
        full_permission_env: default_env_for_mode(defaults, CliPermissionMode::FullPermission),
        supported_permission_modes: supported_permission_modes(defaults),
        mode_defaults: mode_defaults_view(defaults),
        command_overridden: override_profile
            .and_then(|profile| profile.command_override.as_ref())
            .is_some(),
        args_overridden: override_profile
            .and_then(|profile| profile.args_override.as_ref())
            .is_some(),
        env_overridden: override_profile
            .and_then(|profile| profile.env_override.as_ref())
            .is_some(),
        effective_command,
        required_args,
        transport: override_profile.and_then(|profile| profile.transport.clone()),
    })
}

pub fn cli_launch_profile_update(
    update: CliLaunchProfileUpdate,
) -> Result<CliLaunchProfileView, String> {
    let agent_type = parse_cli_agent(&update.agent_name)?;
    let defaults = defaults_for_agent(&agent_type)
        .ok_or_else(|| format!("No CLI launch defaults for {}", agent_type.as_str()))?;
    if !supports_permission_mode(defaults, update.permission_mode) {
        return Err(format!(
            "Permission mode {:?} is not supported for {}",
            update.permission_mode,
            agent_type.as_str()
        ));
    }
    let mut store = read_store()?;
    // The transport opt-in is experimental and not surfaced in the settings
    // UI; carry the stored value forward when the update doesn't mention it
    // so editing args/mode can't silently flip a session back to shell-out.
    // Clearing is done via `cli_launch_profile_reset` or hand-editing
    // `~/.orgii/config/cli_launch_profiles.json`.
    let existing_transport = store
        .profiles
        .get(agent_type.as_str())
        .and_then(|profile| profile.transport.clone());
    store.profiles.insert(
        agent_type.as_str().to_string(),
        CliLaunchProfileOverride {
            permission_mode: Some(update.permission_mode),
            command_override: normalize_optional_string(update.command_override),
            args_override: normalize_optional_args(update.args_override),
            env_override: normalize_optional_env(update.env_override),
            transport: normalize_optional_string(update.transport).or(existing_transport),
        },
    );
    write_store(&store)?;
    cli_launch_profile_get(agent_type.as_str().to_string())
}

pub fn cli_launch_profile_reset(agent_name: String) -> Result<CliLaunchProfileView, String> {
    let agent_type = parse_cli_agent(&agent_name)?;
    let mut store = read_store()?;
    store.profiles.remove(agent_type.as_str());
    write_store(&store)?;
    cli_launch_profile_get(agent_type.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::super::session_runner::launch_profiles::CliPermissionMode;
    use super::*;

    #[test]
    fn default_profile_has_full_permission_args() {
        let defaults = defaults_for_agent(&ModelType::ClaudeCode).expect("claude defaults");
        assert_eq!(
            default_args_for_mode(defaults, CliPermissionMode::FullPermission),
            vec!["--dangerously-skip-permissions".to_string()]
        );
        assert_eq!(
            default_args_for_mode(defaults, CliPermissionMode::Manual),
            vec!["--permission-mode".to_string(), "manual".to_string()]
        );
        assert_eq!(
            default_args_for_mode(defaults, CliPermissionMode::AutoEdit),
            vec!["--permission-mode".to_string(), "acceptEdits".to_string()]
        );
    }

    #[test]
    fn goose_full_permission_uses_env() {
        let defaults = defaults_for_agent(&ModelType::Goose).expect("goose defaults");
        assert!(default_args_for_mode(defaults, CliPermissionMode::FullPermission).is_empty());
        assert_eq!(
            default_env_for_mode(defaults, CliPermissionMode::FullPermission)
                .get("GOOSE_MODE")
                .map(String::as_str),
            Some("auto")
        );
    }

    #[test]
    fn opencode_does_not_expose_noop_full_permission() {
        let defaults = defaults_for_agent(&ModelType::OpenCode).expect("opencode defaults");
        assert_eq!(
            supported_permission_modes(defaults),
            vec![CliPermissionMode::Manual]
        );
        assert_eq!(default_permission_mode(defaults), CliPermissionMode::Manual);
    }
}
