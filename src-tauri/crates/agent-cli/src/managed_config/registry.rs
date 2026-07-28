//! Managed CLI adapter registry.
//!
//! Owns the per-agent constants, the config-target specs each adapter
//! writes, and the availability lookup for agents ORGII cannot manage.

pub(super) const CODEX_AGENT: &str = "codex";
pub(super) const CODEX_CONFIG_FILE_ID: &str = "config";
pub(super) const CODEX_CONFIG_FILE_NAME: &str = "config.toml";
pub(super) const CLAUDE_CODE_AGENT: &str = "claude_code";
pub(super) const CLAUDE_CODE_CONFIG_FILE_ID: &str = "settings";
pub(super) const CLAUDE_CODE_CONFIG_FILE_NAME: &str = "settings.json";
pub(super) const OPENCODE_AGENT: &str = "opencode";
pub(super) const OPENCODE_CONFIG_FILE_ID: &str = "config";
pub(super) const OPENCODE_CONFIG_FILE_NAME: &str = "opencode.jsonc";
pub(super) const AIDER_AGENT: &str = "aider";
pub(super) const AIDER_CONFIG_FILE_ID: &str = "config";
pub(super) const AIDER_CONFIG_FILE_NAME: &str = ".aider.conf.yml";
pub(super) const KIMI_CLI_AGENT: &str = "kimi_cli";
pub(super) const KIMI_CLI_CONFIG_FILE_ID: &str = "config";
pub(super) const KIMI_CLI_CONFIG_FILE_NAME: &str = "config.toml";
pub(super) const GOOSE_AGENT: &str = "goose";
pub(super) const GOOSE_CONFIG_FILE_ID: &str = "config";
pub(super) const GOOSE_CONFIG_FILE_NAME: &str = "config.yaml";
pub(super) const GOOSE_SECRETS_FILE_ID: &str = "secrets";
pub(super) const GOOSE_SECRETS_FILE_NAME: &str = "secrets.yaml";
pub(super) const CLINE_AGENT: &str = "cline";
pub(super) const CLINE_PROVIDERS_FILE_ID: &str = "providers";
pub(super) const CLINE_PROVIDERS_FILE_NAME: &str = "providers.json";
pub(super) const KILO_AGENT: &str = "kilo";
pub(super) const KILO_CONFIG_FILE_ID: &str = "config";
pub(super) const KILO_CONFIG_FILE_NAME: &str = "kilo.jsonc";
pub(super) const HERMES_AGENT: &str = "hermes";
pub(super) const HERMES_CONFIG_FILE_ID: &str = "config";
pub(super) const HERMES_CONFIG_FILE_NAME: &str = "config.yaml";
pub(super) const OPENCLAW_AGENT: &str = "openclaw";
pub(super) const OPENCLAW_CONFIG_FILE_ID: &str = "config";
pub(super) const OPENCLAW_CONFIG_FILE_NAME: &str = "openclaw.json";
pub(super) const QWEN_CODE_AGENT: &str = "qwen_code";
pub(super) const QWEN_CODE_SETTINGS_FILE_ID: &str = "settings";
pub(super) const QWEN_CODE_SETTINGS_FILE_NAME: &str = "settings.json";
pub(super) const MIMO_CODE_AGENT: &str = "mimo_code";
pub(super) const MIMO_CODE_CONFIG_FILE_ID: &str = "config";
pub(super) const MIMO_CODE_CONFIG_FILE_NAME: &str = "mimocode.json";
pub(super) const CONTINUE_CLI_AGENT: &str = "continue_cli";
pub(super) const CONTINUE_CLI_CONFIG_FILE_ID: &str = "config";
pub(super) const CONTINUE_CLI_CONFIG_FILE_NAME: &str = "config.yaml";
pub(super) const DROID_AGENT: &str = "droid";
pub(super) const DROID_SETTINGS_FILE_ID: &str = "settings";
pub(super) const DROID_SETTINGS_FILE_NAME: &str = "settings.json";
pub(super) const MISTRAL_VIBE_AGENT: &str = "mistral_vibe";
pub(super) const MISTRAL_VIBE_CONFIG_FILE_ID: &str = "config";
pub(super) const MISTRAL_VIBE_CONFIG_FILE_NAME: &str = "config.toml";
pub(super) const MISTRAL_VIBE_ENV_FILE_ID: &str = "env";
pub(super) const MISTRAL_VIBE_ENV_FILE_NAME: &str = ".env";
pub(super) const AUTOHAND_AGENT: &str = "autohand";
pub(super) const AUTOHAND_CONFIG_FILE_ID: &str = "config";
pub(super) const AUTOHAND_CONFIG_FILE_NAME: &str = "config.json";
pub(super) const OMP_AGENT: &str = "omp";
pub(super) const OMP_MODELS_FILE_ID: &str = "models";
pub(super) const OMP_MODELS_FILE_NAME: &str = "models.yml";
pub(super) const OMP_SETTINGS_FILE_ID: &str = "settings";
pub(super) const OMP_SETTINGS_FILE_NAME: &str = "config.yml";
pub(super) const PI_AGENT: &str = "pi";
pub(super) const PI_SETTINGS_FILE_ID: &str = "settings";
pub(super) const PI_SETTINGS_FILE_NAME: &str = "settings.json";
pub(super) const PI_MODELS_FILE_ID: &str = "models";
pub(super) const PI_MODELS_FILE_NAME: &str = "models.json";
pub(super) const ORGII_PROVIDER_ID: &str = "orgii";
pub(super) const ORGII_PROVIDER_NAME: &str = "ORGII";
pub(super) const DEFAULT_ORGII_MODEL: &str = "orgii-current-model";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliManagedProxyProtocol {
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliManagedConfigAvailability {
    Supported(CliManagedProxyProtocol),
    Unavailable(&'static str),
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ManagedConfigGenerator {
    CodexToml,
    ClaudeCodeJson,
    OpenCodeJsonc,
    AiderYaml,
    KimiToml,
    GooseYaml,
    GooseSecretsYaml,
    ClineProvidersJson,
    KiloJsonc,
    HermesYaml,
    OpenClawJsonc,
    QwenCodeJson,
    MimoCodeJson,
    ContinueYaml,
    DroidJson,
    MistralVibeToml,
    MistralVibeEnv,
    AutohandJson,
    OmpModelsYaml,
    OmpSettingsYaml,
    PiSettingsJson,
    PiModelsJson,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ManagedConfigTargetSpec {
    pub(super) file_id: &'static str,
    pub(super) profile_file_name: &'static str,
    pub(super) generator: ManagedConfigGenerator,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CliManagedConfigAdapter {
    pub(super) agent_name: &'static str,
    pub(super) proxy_protocol: CliManagedProxyProtocol,
    pub(super) targets: &'static [ManagedConfigTargetSpec],
}

const CODEX_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    CODEX_CONFIG_FILE_ID,
    CODEX_CONFIG_FILE_NAME,
    ManagedConfigGenerator::CodexToml,
)];
const CLAUDE_CODE_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    CLAUDE_CODE_CONFIG_FILE_ID,
    CLAUDE_CODE_CONFIG_FILE_NAME,
    ManagedConfigGenerator::ClaudeCodeJson,
)];
const OPENCODE_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    OPENCODE_CONFIG_FILE_ID,
    OPENCODE_CONFIG_FILE_NAME,
    ManagedConfigGenerator::OpenCodeJsonc,
)];
const AIDER_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    AIDER_CONFIG_FILE_ID,
    AIDER_CONFIG_FILE_NAME,
    ManagedConfigGenerator::AiderYaml,
)];
const KIMI_CLI_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    KIMI_CLI_CONFIG_FILE_ID,
    KIMI_CLI_CONFIG_FILE_NAME,
    ManagedConfigGenerator::KimiToml,
)];
const GOOSE_TARGETS: &[ManagedConfigTargetSpec] = &[
    managed_target(
        GOOSE_CONFIG_FILE_ID,
        GOOSE_CONFIG_FILE_NAME,
        ManagedConfigGenerator::GooseYaml,
    ),
    managed_target(
        GOOSE_SECRETS_FILE_ID,
        GOOSE_SECRETS_FILE_NAME,
        ManagedConfigGenerator::GooseSecretsYaml,
    ),
];
const CLINE_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    CLINE_PROVIDERS_FILE_ID,
    CLINE_PROVIDERS_FILE_NAME,
    ManagedConfigGenerator::ClineProvidersJson,
)];
const KILO_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    KILO_CONFIG_FILE_ID,
    KILO_CONFIG_FILE_NAME,
    ManagedConfigGenerator::KiloJsonc,
)];
const HERMES_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    HERMES_CONFIG_FILE_ID,
    HERMES_CONFIG_FILE_NAME,
    ManagedConfigGenerator::HermesYaml,
)];
const OPENCLAW_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    OPENCLAW_CONFIG_FILE_ID,
    OPENCLAW_CONFIG_FILE_NAME,
    ManagedConfigGenerator::OpenClawJsonc,
)];
const QWEN_CODE_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    QWEN_CODE_SETTINGS_FILE_ID,
    QWEN_CODE_SETTINGS_FILE_NAME,
    ManagedConfigGenerator::QwenCodeJson,
)];
const MIMO_CODE_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    MIMO_CODE_CONFIG_FILE_ID,
    MIMO_CODE_CONFIG_FILE_NAME,
    ManagedConfigGenerator::MimoCodeJson,
)];
const CONTINUE_CLI_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    CONTINUE_CLI_CONFIG_FILE_ID,
    CONTINUE_CLI_CONFIG_FILE_NAME,
    ManagedConfigGenerator::ContinueYaml,
)];
const DROID_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    DROID_SETTINGS_FILE_ID,
    DROID_SETTINGS_FILE_NAME,
    ManagedConfigGenerator::DroidJson,
)];
const MISTRAL_VIBE_TARGETS: &[ManagedConfigTargetSpec] = &[
    managed_target(
        MISTRAL_VIBE_CONFIG_FILE_ID,
        MISTRAL_VIBE_CONFIG_FILE_NAME,
        ManagedConfigGenerator::MistralVibeToml,
    ),
    managed_target(
        MISTRAL_VIBE_ENV_FILE_ID,
        MISTRAL_VIBE_ENV_FILE_NAME,
        ManagedConfigGenerator::MistralVibeEnv,
    ),
];
const AUTOHAND_TARGETS: &[ManagedConfigTargetSpec] = &[managed_target(
    AUTOHAND_CONFIG_FILE_ID,
    AUTOHAND_CONFIG_FILE_NAME,
    ManagedConfigGenerator::AutohandJson,
)];
const OMP_TARGETS: &[ManagedConfigTargetSpec] = &[
    managed_target(
        OMP_MODELS_FILE_ID,
        OMP_MODELS_FILE_NAME,
        ManagedConfigGenerator::OmpModelsYaml,
    ),
    managed_target(
        OMP_SETTINGS_FILE_ID,
        OMP_SETTINGS_FILE_NAME,
        ManagedConfigGenerator::OmpSettingsYaml,
    ),
];
const PI_TARGETS: &[ManagedConfigTargetSpec] = &[
    managed_target(
        PI_SETTINGS_FILE_ID,
        PI_SETTINGS_FILE_NAME,
        ManagedConfigGenerator::PiSettingsJson,
    ),
    managed_target(
        PI_MODELS_FILE_ID,
        PI_MODELS_FILE_NAME,
        ManagedConfigGenerator::PiModelsJson,
    ),
];

pub(super) const MANAGED_CONFIG_ADAPTERS: &[CliManagedConfigAdapter] = &[
    managed_adapter(
        CODEX_AGENT,
        CliManagedProxyProtocol::OpenAiResponses,
        CODEX_TARGETS,
    ),
    managed_adapter(
        CLAUDE_CODE_AGENT,
        CliManagedProxyProtocol::AnthropicMessages,
        CLAUDE_CODE_TARGETS,
    ),
    managed_adapter(
        OPENCODE_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        OPENCODE_TARGETS,
    ),
    managed_adapter(
        AIDER_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        AIDER_TARGETS,
    ),
    managed_adapter(
        KIMI_CLI_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        KIMI_CLI_TARGETS,
    ),
    managed_adapter(
        GOOSE_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        GOOSE_TARGETS,
    ),
    managed_adapter(
        CLINE_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        CLINE_TARGETS,
    ),
    managed_adapter(
        KILO_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        KILO_TARGETS,
    ),
    managed_adapter(
        HERMES_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        HERMES_TARGETS,
    ),
    managed_adapter(
        OPENCLAW_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        OPENCLAW_TARGETS,
    ),
    managed_adapter(
        QWEN_CODE_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        QWEN_CODE_TARGETS,
    ),
    managed_adapter(
        MIMO_CODE_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        MIMO_CODE_TARGETS,
    ),
    managed_adapter(
        CONTINUE_CLI_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        CONTINUE_CLI_TARGETS,
    ),
    managed_adapter(
        DROID_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        DROID_TARGETS,
    ),
    managed_adapter(
        MISTRAL_VIBE_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        MISTRAL_VIBE_TARGETS,
    ),
    managed_adapter(
        AUTOHAND_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        AUTOHAND_TARGETS,
    ),
    managed_adapter(
        OMP_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        OMP_TARGETS,
    ),
    managed_adapter(
        PI_AGENT,
        CliManagedProxyProtocol::OpenAiChatCompletions,
        PI_TARGETS,
    ),
];

const MANAGED_CONFIG_UNAVAILABLE: &[(&str, &str)] = &[
    (
        "cursor_cli",
        "Cursor CLI uses Cursor account/subscription authentication and does not expose a Provider base URL switch",
    ),
    (
        "kiro",
        "Kiro CLI is tied to AWS/Kiro account authentication and has no compatible Provider redirect setting",
    ),
    (
        "copilot",
        "GitHub Copilot CLI uses GitHub subscription authentication and does not accept an external Provider base URL",
    ),
    (
        "amp",
        "Amp uses its own subscription API and does not provide a third-party Provider redirect setting",
    ),
    (
        "grok_cli",
        "Grok CLI currently exposes XAI_API_KEY or cached account auth, but no stable persisted base URL config for managed switching",
    ),
    (
        "devin",
        "Devin CLI is backed by a Cognition account and does not expose a compatible external Provider config",
    ),
    (
        "rovo",
        "Rovo Dev uses Atlassian account/subscription authentication and does not expose a compatible Provider redirect setting",
    ),
    (
        "aug",
        "Augment CLI uses OAuth session authentication and does not expose a compatible Provider base URL setting",
    ),
    (
        "codebuff",
        "Codebuff uses its hosted account service and has no stable local Provider config target",
    ),
    (
        "antigravity",
        "Antigravity uses its own account-backed runtime and has no stable local Provider config target",
    ),
    (
        "qoder_cli",
        "Qoder CLI uses Qoder account/subscription authentication and does not expose a compatible Provider base URL setting",
    ),
    (
        "trae_cli",
        "Trae Agent is configured per-invocation and exposes no stable persisted config file for managed switching",
    ),
];

const fn managed_target(
    file_id: &'static str,
    profile_file_name: &'static str,
    generator: ManagedConfigGenerator,
) -> ManagedConfigTargetSpec {
    ManagedConfigTargetSpec {
        file_id,
        profile_file_name,
        generator,
    }
}

const fn managed_adapter(
    agent_name: &'static str,
    proxy_protocol: CliManagedProxyProtocol,
    targets: &'static [ManagedConfigTargetSpec],
) -> CliManagedConfigAdapter {
    CliManagedConfigAdapter {
        agent_name,
        proxy_protocol,
        targets,
    }
}

pub(super) fn managed_config_adapter(agent_name: &str) -> Option<&'static CliManagedConfigAdapter> {
    MANAGED_CONFIG_ADAPTERS
        .iter()
        .find(|adapter| adapter.agent_name == agent_name)
}

pub fn managed_proxy_protocol_for_agent(agent_name: &str) -> Option<CliManagedProxyProtocol> {
    managed_config_adapter(agent_name).map(|adapter| adapter.proxy_protocol)
}

pub fn managed_config_availability_for_agent(agent_name: &str) -> CliManagedConfigAvailability {
    if let Some(adapter) = managed_config_adapter(agent_name) {
        return CliManagedConfigAvailability::Supported(adapter.proxy_protocol);
    }
    MANAGED_CONFIG_UNAVAILABLE
        .iter()
        .find(|(name, _)| *name == agent_name)
        .map(|(_, reason)| CliManagedConfigAvailability::Unavailable(reason))
        .unwrap_or(CliManagedConfigAvailability::Unknown)
}

pub fn managed_config_unavailable_reason_for_agent(agent_name: &str) -> Option<&'static str> {
    match managed_config_availability_for_agent(agent_name) {
        CliManagedConfigAvailability::Unavailable(reason) => Some(reason),
        CliManagedConfigAvailability::Supported(_) | CliManagedConfigAvailability::Unknown => None,
    }
}

pub(super) fn supported_agent(agent_name: &str) -> bool {
    managed_config_adapter(agent_name).is_some()
}

pub(super) fn unavailable_agent_message(agent_name: &str) -> String {
    managed_config_unavailable_reason_for_agent(agent_name)
        .map(str::to_string)
        .unwrap_or_else(|| format!("ORGII managed config is not registered for {agent_name}"))
}
