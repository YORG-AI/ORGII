use std::collections::HashMap;

use integrations::cli_binary_resolver::{metadata_for_id, CliBinaryId};
use key_vault::key_store::ModelType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CliPermissionMode {
    Plan,
    #[default]
    FullPermission,
    AutoEdit,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliLaunchProfileDefaults {
    pub agent_type: ModelType,
    pub command_args: &'static [&'static str],
    pub mode_defaults: &'static [CliLaunchProfileModeDefaults],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliLaunchProfileModeDefaults {
    pub mode: CliPermissionMode,
    pub args: &'static [&'static str],
    pub env: &'static [(&'static str, &'static str)],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLaunchProfileModeDefaultsView {
    pub mode: CliPermissionMode,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliLaunchProfileOverride {
    pub permission_mode: Option<CliPermissionMode>,
    pub command_override: Option<String>,
    pub args_override: Option<Vec<String>>,
    pub env_override: Option<HashMap<String, String>>,
    /// Experimental transport selector. Absent (default) = per-turn shell-out.
    /// `"app-server"` on the codex profile switches managed sessions to the
    /// long-lived `codex app-server` JSON-RPC transport.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLaunchProfileView {
    pub agent_name: String,
    pub permission_mode: CliPermissionMode,
    pub default_command: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub manual_args: Vec<String>,
    pub full_permission_args: Vec<String>,
    pub manual_env: HashMap<String, String>,
    pub full_permission_env: HashMap<String, String>,
    pub supported_permission_modes: Vec<CliPermissionMode>,
    pub mode_defaults: Vec<CliLaunchProfileModeDefaultsView>,
    pub command_overridden: bool,
    pub args_overridden: bool,
    pub env_overridden: bool,
    pub effective_command: Vec<String>,
    pub required_args: Vec<String>,
    /// Experimental transport selector (see [`CliLaunchProfileOverride::transport`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCliLaunchProfile {
    pub permission_mode: CliPermissionMode,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// Experimental transport selector (see [`CliLaunchProfileOverride::transport`]).
    pub transport: Option<String>,
}

/// Launch-profile `transport` value selecting the `codex app-server`
/// JSON-RPC transport instead of the per-turn `codex exec --json` shell-out.
pub const CLI_TRANSPORT_APP_SERVER: &str = "app-server";

/// Gate predicate for the experimental codex app-server transport: only the
/// codex agent honors the flag, and only when the launch profile explicitly
/// opts in. Absent flag (the default) keeps the shell-out path.
pub fn uses_codex_app_server(agent: &ModelType, profile: &ResolvedCliLaunchProfile) -> bool {
    matches!(agent, ModelType::Codex)
        && profile.transport.as_deref() == Some(CLI_TRANSPORT_APP_SERVER)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLaunchProfileUpdate {
    pub agent_name: String,
    pub permission_mode: CliPermissionMode,
    pub command_override: Option<String>,
    pub args_override: Option<Vec<String>>,
    pub env_override: Option<HashMap<String, String>>,
    /// Experimental transport selector. `None` (the UI never sends it)
    /// preserves any stored value so flipping args/mode via the settings UI
    /// doesn't silently clear the app-server opt-in.
    #[serde(default)]
    pub transport: Option<String>,
}
pub fn cli_binary_id_for_agent(agent: &ModelType) -> Option<CliBinaryId> {
    match agent {
        ModelType::CursorCli => Some(CliBinaryId::CursorCli),
        ModelType::ClaudeCode => Some(CliBinaryId::ClaudeCode),
        ModelType::Codex => Some(CliBinaryId::Codex),
        ModelType::Kiro => Some(CliBinaryId::Kiro),
        ModelType::Copilot => Some(CliBinaryId::Copilot),
        ModelType::OpenCode => Some(CliBinaryId::OpenCode),
        ModelType::KimiCli => Some(CliBinaryId::KimiCli),
        ModelType::Aider => Some(CliBinaryId::Aider),
        ModelType::Goose => Some(CliBinaryId::Goose),
        ModelType::Amp => Some(CliBinaryId::Amp),
        ModelType::Cline => Some(CliBinaryId::Cline),
        ModelType::Kilo => Some(CliBinaryId::Kilo),
        ModelType::Grok => Some(CliBinaryId::Grok),
        ModelType::Devin => Some(CliBinaryId::Devin),
        ModelType::Rovo => Some(CliBinaryId::Rovo),
        ModelType::Hermes => Some(CliBinaryId::Hermes),
        ModelType::OpenClaw => Some(CliBinaryId::OpenClaw),
        ModelType::Aug => Some(CliBinaryId::Aug),
        ModelType::Codebuff => Some(CliBinaryId::Codebuff),
        ModelType::QwenCode => Some(CliBinaryId::QwenCode),
        ModelType::MimoCode => Some(CliBinaryId::MimoCode),
        ModelType::Antigravity => Some(CliBinaryId::Antigravity),
        ModelType::Continue => Some(CliBinaryId::Continue),
        ModelType::Droid => Some(CliBinaryId::Droid),
        ModelType::MistralVibe => Some(CliBinaryId::MistralVibe),
        ModelType::Autohand => Some(CliBinaryId::Autohand),
        ModelType::Omp => Some(CliBinaryId::Omp),
        ModelType::Pi => Some(CliBinaryId::Pi),
        ModelType::QoderCli => Some(CliBinaryId::QoderCli),
        ModelType::TraeCli => Some(CliBinaryId::TraeCli),
        _ => None,
    }
}

pub fn bare_command_for_agent(agent: &ModelType) -> Option<&'static str> {
    cli_binary_id_for_agent(agent).map(|id| metadata_for_id(id).command)
}

macro_rules! mode_defaults {
    ($( $mode:ident => ($args:expr, $env:expr) ),+ $(,)?) => {
        &[
            $(
                CliLaunchProfileModeDefaults {
                    mode: CliPermissionMode::$mode,
                    args: $args,
                    env: $env,
                },
            )+
        ]
    };
}

pub const CLI_LAUNCH_PROFILE_DEFAULTS: &[CliLaunchProfileDefaults] = &[
    CliLaunchProfileDefaults {
        agent_type: ModelType::CursorCli,
        command_args: &["agent"],
        mode_defaults: mode_defaults![
            Plan => (&["--mode", "plan"], &[]),
            Manual => (&[], &[]),
            FullPermission => (&["--force", "--approve-mcps"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::ClaudeCode,
        command_args: &[],
        mode_defaults: mode_defaults![
            Plan => (&["--permission-mode", "plan"], &[]),
            Manual => (&["--permission-mode", "manual"], &[]),
            AutoEdit => (&["--permission-mode", "acceptEdits"], &[]),
            FullPermission => (&["--dangerously-skip-permissions"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Codex,
        command_args: &["exec"],
        mode_defaults: mode_defaults![
            Plan => (&["--sandbox", "read-only", "-c", "approval_policy=on-request"], &[]),
            Manual => (&["--sandbox", "workspace-write", "-c", "approval_policy=on-request"], &[]),
            AutoEdit => (&["--sandbox", "workspace-write", "-c", "approval_policy=never"], &[]),
            FullPermission => (&["--dangerously-bypass-approvals-and-sandbox"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Copilot,
        command_args: &[],
        mode_defaults: mode_defaults![
            Plan => (&["--mode", "plan"], &[]),
            Manual => (&["--mode", "interactive"], &[]),
            AutoEdit => (&["--allow-tool", "write"], &[]),
            FullPermission => (&["--allow-all", "--no-ask-user"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Kiro,
        command_args: &["acp"],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--trust-all-tools"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::OpenCode,
        command_args: &["acp"],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::KimiCli,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Aider,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--yes-always"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Goose,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&[], &[("GOOSE_MODE", "auto")]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Amp,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--dangerously-allow-all"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Cline,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--auto-approve", "true"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Kilo,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Grok,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--permission-mode", "bypassPermissions"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Devin,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--permission-mode", "bypass"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Rovo,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--yolo"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Hermes,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--yolo"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::OpenClaw,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Aug,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Codebuff,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::QwenCode,
        command_args: &[],
        mode_defaults: mode_defaults![
            Plan => (&["--approval-mode", "plan"], &[]),
            Manual => (&["--approval-mode", "default"], &[]),
            AutoEdit => (&["--approval-mode", "auto_edit"], &[]),
            FullPermission => (&["--approval-mode", "yolo"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::MimoCode,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Antigravity,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--dangerously-skip-permissions"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Continue,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--allow", "*"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Droid,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::MistralVibe,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--agent", "auto-approve"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Autohand,
        command_args: &[],
        mode_defaults: mode_defaults![
            Manual => (&[], &[]),
            FullPermission => (&["--unrestricted"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Omp,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::Pi,
        command_args: &[],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::QoderCli,
        command_args: &[],
        mode_defaults: mode_defaults![
            Plan => (&["--permission-mode", "plan"], &[]),
            Manual => (&["--permission-mode", "default"], &[]),
            AutoEdit => (&["--permission-mode", "accept_edits"], &[]),
            FullPermission => (&["--permission-mode", "bypass_permissions"], &[]),
        ],
    },
    CliLaunchProfileDefaults {
        agent_type: ModelType::TraeCli,
        command_args: &["interactive"],
        mode_defaults: mode_defaults![Manual => (&[], &[])],
    },
];

pub fn defaults_for_agent(agent_type: &ModelType) -> Option<&'static CliLaunchProfileDefaults> {
    CLI_LAUNCH_PROFILE_DEFAULTS
        .iter()
        .find(|defaults| &defaults.agent_type == agent_type)
}

pub fn default_profile_for_mode(
    defaults: &CliLaunchProfileDefaults,
    mode: CliPermissionMode,
) -> Option<&CliLaunchProfileModeDefaults> {
    defaults
        .mode_defaults
        .iter()
        .find(|profile| profile.mode == mode)
}

pub fn supports_permission_mode(
    defaults: &CliLaunchProfileDefaults,
    mode: CliPermissionMode,
) -> bool {
    default_profile_for_mode(defaults, mode).is_some()
}

pub fn supported_permission_modes(defaults: &CliLaunchProfileDefaults) -> Vec<CliPermissionMode> {
    defaults
        .mode_defaults
        .iter()
        .map(|profile| profile.mode)
        .collect()
}

pub fn default_permission_mode(defaults: &CliLaunchProfileDefaults) -> CliPermissionMode {
    if supports_permission_mode(defaults, CliPermissionMode::FullPermission) {
        CliPermissionMode::FullPermission
    } else if supports_permission_mode(defaults, CliPermissionMode::Manual) {
        CliPermissionMode::Manual
    } else {
        defaults
            .mode_defaults
            .first()
            .map(|profile| profile.mode)
            .unwrap_or_default()
    }
}

pub fn mode_defaults_view(
    defaults: &CliLaunchProfileDefaults,
) -> Vec<CliLaunchProfileModeDefaultsView> {
    defaults
        .mode_defaults
        .iter()
        .map(|profile| CliLaunchProfileModeDefaultsView {
            mode: profile.mode,
            args: static_args_to_vec(profile.args),
            env: static_env_to_map(profile.env),
        })
        .collect()
}

pub fn default_args_for_mode(
    defaults: &CliLaunchProfileDefaults,
    mode: CliPermissionMode,
) -> Vec<String> {
    default_profile_for_mode(defaults, mode)
        .map(|profile| static_args_to_vec(profile.args))
        .unwrap_or_default()
}

pub fn default_env_for_mode(
    defaults: &CliLaunchProfileDefaults,
    mode: CliPermissionMode,
) -> HashMap<String, String> {
    default_profile_for_mode(defaults, mode)
        .map(|profile| static_env_to_map(profile.env))
        .unwrap_or_default()
}

pub fn static_env_to_map(
    values: &'static [(&'static str, &'static str)],
) -> HashMap<String, String> {
    values
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

pub fn static_args_to_vec(values: &'static [&'static str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qoder_cli_exposes_documented_permission_modes() {
        let defaults = defaults_for_agent(&ModelType::QoderCli).expect("Qoder CLI defaults");
        assert_eq!(
            default_args_for_mode(defaults, CliPermissionMode::Plan),
            vec!["--permission-mode", "plan"]
        );
        assert_eq!(
            default_args_for_mode(defaults, CliPermissionMode::FullPermission),
            vec!["--permission-mode", "bypass_permissions"]
        );
    }

    #[test]
    fn trae_cli_starts_in_interactive_mode() {
        let defaults = defaults_for_agent(&ModelType::TraeCli).expect("Trae CLI defaults");
        assert_eq!(defaults.command_args, &["interactive"]);
        assert_eq!(
            supported_permission_modes(defaults),
            vec![CliPermissionMode::Manual]
        );
    }
}
