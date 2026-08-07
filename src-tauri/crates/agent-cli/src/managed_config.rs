//! Managed CLI config profiles.
//!
//! This module owns the Default <-> ORGII Managed switch for CLI config files.
//! The first managed agents expose stable user-level config files and can route
//! model traffic through a local proxy without MITM interception.

mod adapters;

use app_paths as paths;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CODEX_AGENT: &str = "codex";
const CODEX_CONFIG_FILE_ID: &str = "config";
const CODEX_CONFIG_FILE_NAME: &str = "config.toml";
const CLAUDE_CODE_AGENT: &str = "claude_code";
const CLAUDE_CODE_CONFIG_FILE_ID: &str = "settings";
const CLAUDE_CODE_CONFIG_FILE_NAME: &str = "settings.json";
const OPENCODE_AGENT: &str = "opencode";
const OPENCODE_CONFIG_FILE_ID: &str = "config";
const OPENCODE_CONFIG_FILE_NAME: &str = "opencode.jsonc";
const AIDER_AGENT: &str = "aider";
const AIDER_CONFIG_FILE_ID: &str = "config";
const AIDER_CONFIG_FILE_NAME: &str = ".aider.conf.yml";
const KIMI_CLI_AGENT: &str = "kimi_cli";
const KIMI_CLI_CONFIG_FILE_ID: &str = "config";
const KIMI_CLI_CONFIG_FILE_NAME: &str = "config.toml";
const GOOSE_AGENT: &str = "goose";
const GOOSE_CONFIG_FILE_ID: &str = "config";
const GOOSE_CONFIG_FILE_NAME: &str = "config.yaml";
const GOOSE_SECRETS_FILE_ID: &str = "secrets";
const GOOSE_SECRETS_FILE_NAME: &str = "secrets.yaml";
const CLINE_AGENT: &str = "cline";
const CLINE_PROVIDERS_FILE_ID: &str = "providers";
const CLINE_PROVIDERS_FILE_NAME: &str = "providers.json";
const KILO_AGENT: &str = "kilo";
const KILO_CONFIG_FILE_ID: &str = "config";
const KILO_CONFIG_FILE_NAME: &str = "kilo.jsonc";
const HERMES_AGENT: &str = "hermes";
const HERMES_CONFIG_FILE_ID: &str = "config";
const HERMES_CONFIG_FILE_NAME: &str = "config.yaml";
const OPENCLAW_AGENT: &str = "openclaw";
const OPENCLAW_CONFIG_FILE_ID: &str = "config";
const OPENCLAW_CONFIG_FILE_NAME: &str = "openclaw.json";
const QWEN_CODE_AGENT: &str = "qwen_code";
const QWEN_CODE_SETTINGS_FILE_ID: &str = "settings";
const QWEN_CODE_SETTINGS_FILE_NAME: &str = "settings.json";
const MIMO_CODE_AGENT: &str = "mimo_code";
const MIMO_CODE_CONFIG_FILE_ID: &str = "config";
const MIMO_CODE_CONFIG_FILE_NAME: &str = "mimocode.json";
const CONTINUE_CLI_AGENT: &str = "continue_cli";
const CONTINUE_CLI_CONFIG_FILE_ID: &str = "config";
const CONTINUE_CLI_CONFIG_FILE_NAME: &str = "config.yaml";
const DROID_AGENT: &str = "droid";
const DROID_SETTINGS_FILE_ID: &str = "settings";
const DROID_SETTINGS_FILE_NAME: &str = "settings.json";
const MISTRAL_VIBE_AGENT: &str = "mistral_vibe";
const MISTRAL_VIBE_CONFIG_FILE_ID: &str = "config";
const MISTRAL_VIBE_CONFIG_FILE_NAME: &str = "config.toml";
const MISTRAL_VIBE_ENV_FILE_ID: &str = "env";
const MISTRAL_VIBE_ENV_FILE_NAME: &str = ".env";
const AUTOHAND_AGENT: &str = "autohand";
const AUTOHAND_CONFIG_FILE_ID: &str = "config";
const AUTOHAND_CONFIG_FILE_NAME: &str = "config.json";
const OMP_AGENT: &str = "omp";
const OMP_MODELS_FILE_ID: &str = "models";
const OMP_MODELS_FILE_NAME: &str = "models.yml";
const OMP_SETTINGS_FILE_ID: &str = "settings";
const OMP_SETTINGS_FILE_NAME: &str = "config.yml";
const PI_AGENT: &str = "pi";
const PI_SETTINGS_FILE_ID: &str = "settings";
const PI_SETTINGS_FILE_NAME: &str = "settings.json";
const PI_MODELS_FILE_ID: &str = "models";
const PI_MODELS_FILE_NAME: &str = "models.json";
#[cfg(test)]
const DEFAULT_PROXY_URL: &str = "http://127.0.0.1:17888";
const DEFAULT_PROXY_PORT: u16 = 17888;
const PROXY_PORT_ENV: &str = "ORGII_CLI_PROXY_PORT";
const ORGII_PROVIDER_ID: &str = "orgii";
const ORGII_PROVIDER_NAME: &str = "ORGII";
const DEFAULT_ORGII_MODEL: &str = "orgii-current-model";
const TRANSACTION_DIR_NAME: &str = "transaction";
const TRANSACTION_JOURNAL_FILE_NAME: &str = "journal.json";

static CONFIG_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn managed_proxy_port() -> u16 {
    std::env::var(PROXY_PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PROXY_PORT)
}

pub fn managed_proxy_url() -> String {
    format!("http://127.0.0.1:{}", managed_proxy_port())
}

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
enum ManagedConfigGenerator {
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
struct ManagedConfigTargetSpec {
    file_id: &'static str,
    profile_file_name: &'static str,
    generator: ManagedConfigGenerator,
}

#[derive(Debug, Clone, Copy)]
struct CliManagedConfigAdapter {
    agent_name: &'static str,
    proxy_protocol: CliManagedProxyProtocol,
    targets: &'static [ManagedConfigTargetSpec],
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

const MANAGED_CONFIG_ADAPTERS: &[CliManagedConfigAdapter] = &[
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

fn managed_config_adapter(agent_name: &str) -> Option<&'static CliManagedConfigAdapter> {
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigMode {
    Default,
    OrgiiManaged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigTargetFileManifest {
    pub id: String,
    pub target_path: String,
    pub default_backup_path: String,
    pub managed_profile_path: String,
    pub original_hash: Option<String>,
    pub last_applied_hash: Option<String>,
    #[serde(default)]
    pub default_was_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigProfileManifest {
    pub agent: String,
    pub mode: CliConfigMode,
    pub target_files: Vec<CliConfigTargetFileManifest>,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub proxy_token: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigTargetFileStatus {
    pub id: String,
    pub target_path: String,
    pub default_backup_path: String,
    pub managed_profile_path: String,
    pub target_exists: bool,
    pub has_default_backup: bool,
    pub default_was_missing: bool,
    pub original_hash: Option<String>,
    pub last_applied_hash: Option<String>,
    pub current_hash: Option<String>,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigManagedStatus {
    pub agent_name: String,
    pub supported: bool,
    pub mode: CliConfigMode,
    pub has_default_backup: bool,
    pub conflict: bool,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub proxy_url: Option<String>,
    pub target_files: Vec<CliConfigTargetFileStatus>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManagedConfigSelection {
    pub agent_name: String,
    pub mode: CliConfigMode,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub proxy_url: Option<String>,
    pub proxy_token: Option<String>,
}

#[derive(Debug, Default)]
pub struct CliConfigShutdownRestoreReport {
    pub restored_agents: Vec<String>,
    pub failed_agents: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
struct TargetSnapshot {
    id: String,
    target_path: PathBuf,
    existed: bool,
    bytes: Vec<u8>,
    hash: Option<String>,
}

#[derive(Debug, Clone)]
enum TargetMutation {
    Write(Vec<u8>),
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliConfigTransactionTarget {
    id: String,
    target_path: String,
    rollback_path: String,
    target_existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliConfigTransactionJournal {
    agent: String,
    final_manifest_hash: String,
    target_files: Vec<CliConfigTransactionTarget>,
    created_at: String,
}

fn default_backup_path(agent_name: &str, file_name: &str) -> PathBuf {
    paths::cli_config_profile_default_dir(agent_name).join(file_name)
}

fn managed_profile_path(agent_name: &str, file_name: &str) -> PathBuf {
    paths::cli_config_profile_orgii_dir(agent_name).join(file_name)
}

fn manifest_path(agent_name: &str) -> PathBuf {
    paths::cli_config_profile_manifest(agent_name)
}

fn transaction_dir(agent_name: &str) -> PathBuf {
    paths::cli_config_profile_agent_dir(agent_name).join(TRANSACTION_DIR_NAME)
}

fn transaction_journal_path(agent_name: &str) -> PathBuf {
    transaction_dir(agent_name).join(TRANSACTION_JOURNAL_FILE_NAME)
}

fn config_operation_guard() -> Result<MutexGuard<'static, ()>, String> {
    CONFIG_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "CLI config operation lock is poisoned".to_string())
}

fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn generate_proxy_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn file_hash(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|err| format!("Failed to read {} for hashing: {err}", path.display()))?;
    Ok(Some(sha256_bytes(&bytes)))
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_nanos()
    ))
}

fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("Failed to create {}: {err}", dir.display()))?;
    }

    let tmp = unique_temp_path(path);
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)
            .map_err(|err| format!("Failed to create {}: {err}", tmp.display()))?;
        use std::io::Write;
        file.write_all(bytes)
            .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
        file.sync_all()
            .map_err(|err| format!("Failed to flush {}: {err}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|err| {
            format!(
                "Failed to move {} to {}: {err}",
                tmp.display(),
                path.display()
            )
        })?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_sensitive_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_file_atomic(path, bytes)?;
    if let Err(err) = app_paths::set_sensitive_file_permissions(path) {
        tracing::warn!(path = %path.display(), error = %err, "Failed to secure CLI config profile file");
    }
    Ok(())
}

fn read_manifest(agent_name: &str) -> Result<Option<CliConfigProfileManifest>, String> {
    let path = manifest_path(agent_name);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("Invalid {}: {err}", path.display()))
}

fn manifest_bytes(manifest: &CliConfigProfileManifest) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(manifest)
        .map_err(|err| format!("Failed to serialize CLI config manifest: {err}"))
}

fn write_manifest(manifest: &CliConfigProfileManifest) -> Result<(), String> {
    let path = manifest_path(&manifest.agent);
    write_sensitive_file_atomic(&path, &manifest_bytes(manifest)?)
}

fn manifest_target(
    agent_name: &str,
    file_id: &str,
    file_name: &str,
    target_path: &Path,
) -> CliConfigTargetFileManifest {
    CliConfigTargetFileManifest {
        id: file_id.to_string(),
        target_path: target_path.to_string_lossy().to_string(),
        default_backup_path: default_backup_path(agent_name, file_name)
            .to_string_lossy()
            .to_string(),
        managed_profile_path: managed_profile_path(agent_name, file_name)
            .to_string_lossy()
            .to_string(),
        original_hash: None,
        last_applied_hash: None,
        default_was_missing: false,
    }
}

fn supported_agent(agent_name: &str) -> bool {
    managed_config_adapter(agent_name).is_some()
}

fn unavailable_agent_message(agent_name: &str) -> String {
    managed_config_unavailable_reason_for_agent(agent_name)
        .map(str::to_string)
        .unwrap_or_else(|| format!("ORGII managed config is not registered for {agent_name}"))
}

fn agent_manifest_targets(agent_name: &str) -> Result<Vec<CliConfigTargetFileManifest>, String> {
    let adapter = managed_config_adapter(agent_name)
        .ok_or_else(|| format!("Unsupported CLI managed config agent: {agent_name}"))?;
    adapter
        .targets
        .iter()
        .map(|target| {
            let target_path =
                crate::generic_config::resolve_config_path(agent_name, target.file_id)?;
            Ok(manifest_target(
                agent_name,
                target.file_id,
                target.profile_file_name,
                &target_path,
            ))
        })
        .collect()
}

fn targets_with_fallbacks(
    manifest: Option<&CliConfigProfileManifest>,
    fallback_targets: &[CliConfigTargetFileManifest],
) -> Vec<CliConfigTargetFileManifest> {
    let mut by_id: BTreeMap<String, CliConfigTargetFileManifest> = manifest
        .map(|manifest| {
            manifest
                .target_files
                .iter()
                .cloned()
                .map(|target| (target.id.clone(), target))
                .collect()
        })
        .unwrap_or_default();

    for target in fallback_targets {
        by_id
            .entry(target.id.clone())
            .or_insert_with(|| target.clone());
    }

    let mut targets = Vec::new();
    for fallback in fallback_targets {
        if let Some(target) = by_id.remove(&fallback.id) {
            targets.push(target);
        }
    }
    targets.extend(by_id.into_values());
    targets
}

fn read_target_snapshots(
    targets: &[CliConfigTargetFileManifest],
) -> Result<BTreeMap<String, TargetSnapshot>, String> {
    let mut snapshots = BTreeMap::new();
    for target in targets {
        let target_path = PathBuf::from(&target.target_path);
        let existed = target_path.exists();
        let bytes = if existed {
            std::fs::read(&target_path)
                .map_err(|err| format!("Failed to read {}: {err}", target_path.display()))?
        } else {
            Vec::new()
        };
        let hash = existed.then(|| sha256_bytes(&bytes));
        let snapshot = TargetSnapshot {
            id: target.id.clone(),
            target_path,
            existed,
            bytes,
            hash,
        };
        if snapshots.insert(target.id.clone(), snapshot).is_some() {
            return Err(format!("Duplicate CLI config target id: {}", target.id));
        }
    }
    Ok(snapshots)
}

fn versioned_default_backup_path(
    agent_name: &str,
    target: &CliConfigTargetFileManifest,
    snapshot: &TargetSnapshot,
) -> PathBuf {
    let file_name = Path::new(&target.target_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let hash = snapshot
        .hash
        .as_deref()
        .unwrap_or("missing")
        .trim_start_matches("sha256:");
    let short_hash = &hash[..hash.len().min(12)];
    paths::cli_config_profile_default_dir(agent_name)
        .join(format!("{}-{short_hash}-{file_name}", now_nanos()))
}

fn ensure_default_backup_from_snapshot(
    agent_name: &str,
    mut target: CliConfigTargetFileManifest,
    snapshot: &TargetSnapshot,
    refresh_existing: bool,
) -> Result<CliConfigTargetFileManifest, String> {
    let backup_path = PathBuf::from(&target.default_backup_path);
    let is_new_target = target.last_applied_hash.is_none()
        && target.original_hash.is_none()
        && !target.default_was_missing
        && !backup_path.exists();

    if !refresh_existing && !is_new_target {
        if target.default_was_missing || backup_path.exists() {
            return Ok(target);
        }
        return Err(format!(
            "Default backup is missing for {}. Restore it before applying ORGII Managed again.",
            target.target_path
        ));
    }

    if snapshot.existed {
        let backup_path = versioned_default_backup_path(agent_name, &target, snapshot);
        write_sensitive_file_atomic(&backup_path, &snapshot.bytes)?;
        target.default_backup_path = backup_path.to_string_lossy().to_string();
        target.original_hash = snapshot.hash.clone();
        target.default_was_missing = false;
    } else {
        target.original_hash = None;
        target.default_was_missing = true;
    }

    Ok(target)
}

fn cleanup_transaction_dir(agent_name: &str) -> Result<(), String> {
    let dir = transaction_dir(agent_name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|err| format!("Failed to remove {}: {err}", dir.display()))?;
    }
    Ok(())
}

fn read_transaction_journal(
    agent_name: &str,
) -> Result<Option<CliConfigTransactionJournal>, String> {
    let path = transaction_journal_path(agent_name);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let journal: CliConfigTransactionJournal = serde_json::from_str(&raw)
        .map_err(|err| format!("Invalid CLI config transaction {}: {err}", path.display()))?;
    if journal.agent != agent_name {
        return Err(format!(
            "CLI config transaction agent mismatch: expected {agent_name}, found {}",
            journal.agent
        ));
    }
    Ok(Some(journal))
}

fn rollback_transaction(journal: &CliConfigTransactionJournal) -> Result<(), String> {
    let mut errors = Vec::new();
    for target in &journal.target_files {
        let target_path = PathBuf::from(&target.target_path);
        let result = if target.target_existed {
            let rollback_path = PathBuf::from(&target.rollback_path);
            std::fs::read(&rollback_path)
                .map_err(|err| format!("Failed to read {}: {err}", rollback_path.display()))
                .and_then(|bytes| write_sensitive_file_atomic(&target_path, &bytes))
        } else if target_path.exists() {
            std::fs::remove_file(&target_path)
                .map_err(|err| format!("Failed to remove {}: {err}", target_path.display()))
        } else {
            Ok(())
        };
        if let Err(err) = result {
            errors.push(err);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn recover_pending_transaction_unlocked(agent_name: &str) -> Result<(), String> {
    let Some(journal) = read_transaction_journal(agent_name)? else {
        let dir = transaction_dir(agent_name);
        if dir.exists() {
            cleanup_transaction_dir(agent_name)?;
        }
        return Ok(());
    };

    if file_hash(&manifest_path(agent_name))? == Some(journal.final_manifest_hash.clone()) {
        cleanup_transaction_dir(agent_name)?;
        return Ok(());
    }

    rollback_transaction(&journal)?;
    cleanup_transaction_dir(agent_name)
}

fn begin_transaction(
    agent_name: &str,
    snapshots: &BTreeMap<String, TargetSnapshot>,
    final_manifest: &CliConfigProfileManifest,
) -> Result<CliConfigTransactionJournal, String> {
    recover_pending_transaction_unlocked(agent_name)?;
    let rollback_dir = transaction_dir(agent_name).join("rollback");
    std::fs::create_dir_all(&rollback_dir)
        .map_err(|err| format!("Failed to create {}: {err}", rollback_dir.display()))?;

    let mut target_files = Vec::new();
    for (index, snapshot) in snapshots.values().enumerate() {
        if file_hash(&snapshot.target_path)? != snapshot.hash {
            cleanup_transaction_dir(agent_name)?;
            return Err(format!(
                "CLI config changed while ORGII was preparing the switch: {}",
                snapshot.target_path.display()
            ));
        }

        let rollback_path = rollback_dir.join(format!("{index}-{}.bak", snapshot.id));
        if snapshot.existed {
            write_sensitive_file_atomic(&rollback_path, &snapshot.bytes)?;
        }
        target_files.push(CliConfigTransactionTarget {
            id: snapshot.id.clone(),
            target_path: snapshot.target_path.to_string_lossy().to_string(),
            rollback_path: rollback_path.to_string_lossy().to_string(),
            target_existed: snapshot.existed,
        });
    }

    let journal = CliConfigTransactionJournal {
        agent: agent_name.to_string(),
        final_manifest_hash: sha256_bytes(&manifest_bytes(final_manifest)?),
        target_files,
        created_at: now_stamp(),
    };
    let bytes = serde_json::to_vec_pretty(&journal)
        .map_err(|err| format!("Failed to serialize CLI config transaction: {err}"))?;
    write_sensitive_file_atomic(&transaction_journal_path(agent_name), &bytes)?;
    Ok(journal)
}

fn execute_transaction(
    agent_name: &str,
    snapshots: &BTreeMap<String, TargetSnapshot>,
    mutations: &BTreeMap<String, TargetMutation>,
    final_manifest: &CliConfigProfileManifest,
) -> Result<(), String> {
    let journal = begin_transaction(agent_name, snapshots, final_manifest)?;
    let result = (|| {
        for (id, mutation) in mutations {
            let snapshot = snapshots
                .get(id)
                .ok_or_else(|| format!("Missing CLI config snapshot for target {id}"))?;
            match mutation {
                TargetMutation::Write(bytes) => {
                    write_sensitive_file_atomic(&snapshot.target_path, bytes)?
                }
                TargetMutation::Remove => {
                    if snapshot.target_path.exists() {
                        std::fs::remove_file(&snapshot.target_path).map_err(|err| {
                            format!("Failed to remove {}: {err}", snapshot.target_path.display())
                        })?;
                    }
                }
            }
        }
        write_manifest(final_manifest)
    })();

    if let Err(operation_error) = result {
        let rollback_result = rollback_transaction(&journal);
        if rollback_result.is_ok() {
            let _ = cleanup_transaction_dir(agent_name);
            return Err(operation_error);
        }
        return Err(format!(
            "{operation_error}; rollback also failed: {}",
            rollback_result.unwrap_err()
        ));
    }

    if let Err(err) = cleanup_transaction_dir(agent_name) {
        tracing::warn!(agent = agent_name, error = %err, "Committed CLI config transaction left cleanup files");
    }
    Ok(())
}

fn status_for_unlocked(agent_name: &str) -> Result<CliConfigManagedStatus, String> {
    if !supported_agent(agent_name) {
        return Ok(CliConfigManagedStatus {
            agent_name: agent_name.to_string(),
            supported: false,
            mode: CliConfigMode::Default,
            has_default_backup: false,
            conflict: false,
            selected_key_id: None,
            selected_provider: None,
            selected_model: None,
            proxy_url: None,
            target_files: Vec::new(),
            message: Some(unavailable_agent_message(agent_name)),
        });
    }

    let manifest = read_manifest(agent_name)?;
    let fallback_targets = agent_manifest_targets(agent_name)?;
    let (mode, selected_key_id, selected_provider, selected_model, proxy_url, targets) =
        if let Some(manifest) = &manifest {
            (
                manifest.mode,
                manifest.selected_key_id.clone(),
                manifest.selected_provider.clone(),
                manifest.selected_model.clone(),
                manifest.proxy_url.clone(),
                targets_with_fallbacks(Some(manifest), &fallback_targets),
            )
        } else {
            (
                CliConfigMode::Default,
                None,
                None,
                None,
                Some(managed_proxy_url()),
                fallback_targets,
            )
        };

    let mut any_backup = false;
    let mut any_conflict = false;
    let target_files: Vec<CliConfigTargetFileStatus> = targets
        .into_iter()
        .map(|target| {
            let target_path = PathBuf::from(&target.target_path);
            let default_backup_path = PathBuf::from(&target.default_backup_path);
            let current_hash = file_hash(&target_path)?;
            let has_default_backup = target.default_was_missing || default_backup_path.exists();
            let conflict = mode == CliConfigMode::OrgiiManaged
                && target.last_applied_hash.is_some()
                && current_hash != target.last_applied_hash;
            any_backup |= has_default_backup;
            any_conflict |= conflict;
            Ok(CliConfigTargetFileStatus {
                id: target.id,
                target_path: target.target_path,
                default_backup_path: target.default_backup_path,
                managed_profile_path: target.managed_profile_path,
                target_exists: target_path.exists(),
                has_default_backup,
                default_was_missing: target.default_was_missing,
                original_hash: target.original_hash,
                last_applied_hash: target.last_applied_hash,
                current_hash,
                conflict,
            })
        })
        .collect::<Result<_, String>>()?;

    Ok(CliConfigManagedStatus {
        agent_name: agent_name.to_string(),
        supported: true,
        mode,
        has_default_backup: any_backup,
        conflict: any_conflict,
        selected_key_id,
        selected_provider,
        selected_model,
        proxy_url,
        target_files,
        message: None,
    })
}

pub fn managed_selection_for_agent(
    agent_name: &str,
) -> Result<Option<CliManagedConfigSelection>, String> {
    let _guard = config_operation_guard()?;
    recover_pending_transaction_unlocked(agent_name)?;
    managed_selection_for_agent_unlocked(agent_name)
}

fn managed_selection_for_agent_unlocked(
    agent_name: &str,
) -> Result<Option<CliManagedConfigSelection>, String> {
    if !supported_agent(agent_name) {
        return Ok(None);
    }

    let Some(manifest) = read_manifest(agent_name)? else {
        return Ok(None);
    };

    if manifest.mode != CliConfigMode::OrgiiManaged {
        return Ok(None);
    }

    Ok(Some(CliManagedConfigSelection {
        agent_name: manifest.agent,
        mode: manifest.mode,
        selected_key_id: manifest.selected_key_id,
        selected_provider: manifest.selected_provider,
        selected_model: manifest.selected_model,
        proxy_url: manifest.proxy_url,
        proxy_token: manifest.proxy_token,
    }))
}

fn proxy_route_base_url(
    proxy_url: &str,
    agent_name: &str,
    proxy_token: &str,
    suffix: &str,
) -> String {
    let root = proxy_url.trim().trim_end_matches('/');
    format!("{root}/cli/{agent_name}/{proxy_token}/{suffix}")
}

fn codex_proxy_base_url(proxy_url: &str, proxy_token: &str) -> String {
    proxy_route_base_url(proxy_url, CODEX_AGENT, proxy_token, "v1")
}

fn claude_code_proxy_base_url(proxy_url: &str, proxy_token: &str) -> String {
    proxy_route_base_url(proxy_url, CLAUDE_CODE_AGENT, proxy_token, "claude")
}

fn openai_chat_proxy_base_url(proxy_url: &str, agent_name: &str, proxy_token: &str) -> String {
    proxy_route_base_url(proxy_url, agent_name, proxy_token, "v1")
}

fn generate_codex_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config: toml::Value = if existing_content.trim().is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        toml::from_str(existing_content).map_err(|err| format!("Invalid Codex TOML: {err}"))?
    };

    let Some(root) = config.as_table_mut() else {
        return Err("Codex config must be a TOML table".to_string());
    };

    let model = selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ORGII_MODEL);
    root.insert("model".to_string(), toml::Value::String(model.to_string()));
    root.insert(
        "model_provider".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );

    if !matches!(root.get("model_providers"), Some(toml::Value::Table(_))) {
        root.insert(
            "model_providers".to_string(),
            toml::Value::Table(toml::map::Map::new()),
        );
    }

    let Some(toml::Value::Table(providers)) = root.get_mut("model_providers") else {
        return Err("Failed to build Codex model_providers table".to_string());
    };

    let mut orgii = toml::map::Map::new();
    orgii.insert(
        "name".to_string(),
        toml::Value::String(ORGII_PROVIDER_NAME.to_string()),
    );
    orgii.insert(
        "base_url".to_string(),
        toml::Value::String(codex_proxy_base_url(proxy_url, proxy_token)),
    );
    orgii.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(false),
    );
    orgii.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    providers.insert(ORGII_PROVIDER_ID.to_string(), toml::Value::Table(orgii));

    toml::to_string_pretty(&config).map_err(|err| format!("TOML serialize error: {err}"))
}

fn selected_model_or_default(selected_model: Option<&str>) -> &str {
    selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ORGII_MODEL)
}

fn generate_claude_code_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config: serde_json::Value = if existing_content.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(existing_content)
            .map_err(|err| format!("Invalid Claude Code JSON: {err}"))?
    };

    let Some(root) = config.as_object_mut() else {
        return Err("Claude Code settings must be a JSON object".to_string());
    };

    let model = selected_model_or_default(selected_model);
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );

    if !matches!(root.get("env"), Some(serde_json::Value::Object(_))) {
        root.insert(
            "env".to_string(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }

    let Some(serde_json::Value::Object(env)) = root.get_mut("env") else {
        return Err("Failed to build Claude Code env object".to_string());
    };

    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        serde_json::Value::String(proxy_token.to_string()),
    );
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        serde_json::Value::String(claude_code_proxy_base_url(proxy_url, proxy_token)),
    );
    env.insert(
        "ANTHROPIC_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string(),
        serde_json::Value::String("1".to_string()),
    );
    env.insert(
        "DISABLE_INTERLEAVED_THINKING".to_string(),
        serde_json::Value::String("1".to_string()),
    );

    serde_json::to_string_pretty(&config)
        .map(|value| format!("{value}\n"))
        .map_err(|err| format!("JSON serialize error: {err}"))
}

fn quote_env_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn env_line_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, _) = trimmed.split_once('=')?;
    let key = key.trim();
    if key.is_empty()
        || !key
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(key.to_string())
}

fn upsert_env_file(existing_content: &str, values: &[(&str, String)]) -> String {
    let replacements: BTreeMap<&str, String> = values.iter().cloned().collect();
    let mut seen = BTreeSet::new();
    let mut lines = Vec::new();

    for line in existing_content.lines() {
        if let Some(key) = env_line_key(line) {
            if let Some(value) = replacements.get(key.as_str()) {
                if seen.insert(key.clone()) {
                    lines.push(format!("{key}={}", quote_env_value(value)));
                }
                continue;
            }
        }
        lines.push(line.to_string());
    }

    for (key, value) in values {
        if !seen.contains(*key) {
            lines.push(format!("{key}={}", quote_env_value(value)));
        }
    }

    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn generate_opencode_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    adapters::generate_open_code_family_managed_config(
        existing_content,
        selected_model,
        proxy_url,
        proxy_token,
        OPENCODE_AGENT,
        "OpenCode",
        true,
    )
}

fn generate_aider_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config: serde_yaml::Value = if existing_content.trim().is_empty() {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(existing_content)
            .map_err(|err| format!("Invalid Aider YAML: {err}"))?
    };
    let Some(root) = config.as_mapping_mut() else {
        return Err("Aider config must be a YAML mapping".to_string());
    };

    let model = selected_model_or_default(selected_model);
    let aider_model = if model.starts_with("openai/") {
        model.to_string()
    } else {
        format!("openai/{model}")
    };
    root.insert(
        serde_yaml::Value::String("model".to_string()),
        serde_yaml::Value::String(aider_model),
    );
    root.insert(
        serde_yaml::Value::String("openai-api-base".to_string()),
        serde_yaml::Value::String(openai_chat_proxy_base_url(
            proxy_url,
            AIDER_AGENT,
            proxy_token,
        )),
    );
    root.insert(
        serde_yaml::Value::String("openai-api-key".to_string()),
        serde_yaml::Value::String(proxy_token.to_string()),
    );

    serde_yaml::to_string(&config).map_err(|err| format!("Aider YAML serialize error: {err}"))
}

fn generate_managed_configs(
    agent_name: &str,
    existing_contents: &BTreeMap<String, String>,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<BTreeMap<String, String>, String> {
    let adapter = managed_config_adapter(agent_name)
        .ok_or_else(|| format!("ORGII managed config is not available for {agent_name}"))?;
    let content = |file_id: &str| {
        existing_contents
            .get(file_id)
            .map(String::as_str)
            .unwrap_or("")
    };
    let mut files = BTreeMap::new();
    for target in adapter.targets {
        let existing_content = content(target.file_id);
        let generated = match target.generator {
            ManagedConfigGenerator::CodexToml => generate_codex_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::ClaudeCodeJson => generate_claude_code_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OpenCodeJsonc => generate_opencode_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::AiderYaml => generate_aider_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::KimiToml => adapters::generate_kimi_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::GooseYaml => adapters::generate_goose_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::GooseSecretsYaml => {
                adapters::generate_goose_secrets(existing_content, proxy_token)?
            }
            ManagedConfigGenerator::ClineProvidersJson => adapters::generate_cline_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::KiloJsonc => {
                adapters::generate_open_code_family_managed_config(
                    existing_content,
                    selected_model,
                    proxy_url,
                    proxy_token,
                    KILO_AGENT,
                    "Kilo",
                    true,
                )?
            }
            ManagedConfigGenerator::HermesYaml => adapters::generate_hermes_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OpenClawJsonc => adapters::generate_openclaw_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::QwenCodeJson => adapters::generate_qwen_code_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::MimoCodeJson => {
                adapters::generate_open_code_family_managed_config(
                    existing_content,
                    selected_model,
                    proxy_url,
                    proxy_token,
                    MIMO_CODE_AGENT,
                    "MiMo Code",
                    false,
                )?
            }
            ManagedConfigGenerator::ContinueYaml => adapters::generate_continue_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::DroidJson => adapters::generate_droid_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::MistralVibeToml => adapters::generate_mistral_vibe_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::MistralVibeEnv => {
                adapters::generate_mistral_vibe_env(existing_content, proxy_token)
            }
            ManagedConfigGenerator::AutohandJson => adapters::generate_autohand_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OmpModelsYaml => adapters::generate_omp_models_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OmpSettingsYaml => {
                adapters::generate_omp_settings_config(existing_content, selected_model)?
            }
            ManagedConfigGenerator::PiSettingsJson => {
                adapters::generate_pi_settings_config(existing_content, selected_model)?
            }
            ManagedConfigGenerator::PiModelsJson => adapters::generate_pi_models_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
        };
        files.insert(target.file_id.to_string(), generated);
    }
    Ok(files)
}

fn enable_agent_orgii_managed_unlocked(
    agent_name: &str,
    key_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    force: bool,
) -> Result<CliConfigManagedStatus, String> {
    let fallback_targets = agent_manifest_targets(agent_name)?;
    let existing_manifest = read_manifest(agent_name)?;
    let targets = targets_with_fallbacks(existing_manifest.as_ref(), &fallback_targets);
    let snapshots = read_target_snapshots(&targets)?;
    let mut current_contents = BTreeMap::new();

    for target in &targets {
        let snapshot = snapshots
            .get(&target.id)
            .ok_or_else(|| format!("Missing CLI config snapshot for target {}", target.id))?;
        let content = String::from_utf8(snapshot.bytes.clone()).map_err(|err| {
            format!(
                "CLI config must be UTF-8 text ({}): {err}",
                snapshot.target_path.display()
            )
        })?;
        current_contents.insert(target.id.clone(), content);
    }

    if let Some(existing_manifest) = &existing_manifest {
        if existing_manifest.mode == CliConfigMode::OrgiiManaged && !force {
            for target in &existing_manifest.target_files {
                if let Some(last_hash) = &target.last_applied_hash {
                    let current_hash = snapshots
                        .get(&target.id)
                        .and_then(|snapshot| snapshot.hash.as_ref());
                    if current_hash != Some(last_hash) {
                        return Err(
                            "Current CLI config was modified outside ORGII. Restore or force apply before overwriting it."
                                .to_string(),
                        );
                    }
                }
            }
        }
    }

    let proxy_url = managed_proxy_url();
    let proxy_token = generate_proxy_token();
    let managed_contents = generate_managed_configs(
        agent_name,
        &current_contents,
        model.as_deref(),
        &proxy_url,
        &proxy_token,
    )?;

    let now = now_stamp();
    let refresh_default_backup = existing_manifest
        .as_ref()
        .is_none_or(|manifest| manifest.mode == CliConfigMode::Default);
    let mut manifest = existing_manifest.unwrap_or_else(|| CliConfigProfileManifest {
        agent: agent_name.to_string(),
        mode: CliConfigMode::Default,
        target_files: fallback_targets.clone(),
        selected_key_id: None,
        selected_provider: None,
        selected_model: None,
        proxy_url: Some(managed_proxy_url()),
        proxy_token: None,
        created_at: now.clone(),
        updated_at: now.clone(),
    });

    let mut managed_targets = Vec::new();
    let mut mutations = BTreeMap::new();
    for target in targets {
        let Some(managed_content) = managed_contents.get(&target.id) else {
            continue;
        };
        let snapshot = snapshots
            .get(&target.id)
            .ok_or_else(|| format!("Missing CLI config snapshot for target {}", target.id))?;
        let mut target = ensure_default_backup_from_snapshot(
            agent_name,
            target,
            snapshot,
            refresh_default_backup,
        )?;
        let managed_hash = sha256_bytes(managed_content.as_bytes());

        let managed_path = PathBuf::from(&target.managed_profile_path);
        write_sensitive_file_atomic(&managed_path, managed_content.as_bytes())?;

        target.last_applied_hash = Some(managed_hash);
        mutations.insert(
            target.id.clone(),
            TargetMutation::Write(managed_content.as_bytes().to_vec()),
        );
        managed_targets.push(target);
    }

    manifest.mode = CliConfigMode::OrgiiManaged;
    manifest.target_files = managed_targets;
    manifest.selected_key_id = key_id;
    manifest.selected_provider = provider;
    manifest.selected_model = model;
    manifest.proxy_url = Some(proxy_url);
    manifest.proxy_token = Some(proxy_token);
    manifest.updated_at = now_stamp();
    execute_transaction(agent_name, &snapshots, &mutations, &manifest)?;
    status_for_unlocked(agent_name)
}

fn restore_agent_default_unlocked(
    agent_name: &str,
    force: bool,
) -> Result<CliConfigManagedStatus, String> {
    let mut manifest = read_manifest(agent_name)?
        .ok_or_else(|| format!("No Default backup exists for {agent_name} yet"))?;
    if manifest.mode == CliConfigMode::Default {
        return status_for_unlocked(agent_name);
    }
    let snapshots = read_target_snapshots(&manifest.target_files)?;
    let mut mutations = BTreeMap::new();

    for target in &manifest.target_files {
        if manifest.mode == CliConfigMode::OrgiiManaged && !force {
            if let Some(last_hash) = &target.last_applied_hash {
                let current_hash = snapshots
                    .get(&target.id)
                    .and_then(|snapshot| snapshot.hash.as_ref());
                if current_hash != Some(last_hash) {
                    return Err(
                        "Current CLI config was modified outside ORGII. Force restore to overwrite it."
                            .to_string(),
                    );
                }
            }
        }

        if target.default_was_missing {
            mutations.insert(target.id.clone(), TargetMutation::Remove);
        } else {
            let backup_path = PathBuf::from(&target.default_backup_path);
            if !backup_path.exists() {
                return Err(format!(
                    "Default backup does not exist: {}",
                    backup_path.display()
                ));
            }
            let bytes = std::fs::read(&backup_path)
                .map_err(|err| format!("Failed to read {}: {err}", backup_path.display()))?;
            if target.original_hash.as_ref() != Some(&sha256_bytes(&bytes)) {
                return Err(format!(
                    "Default backup hash mismatch: {}",
                    backup_path.display()
                ));
            }
            mutations.insert(target.id.clone(), TargetMutation::Write(bytes));
        }
    }

    manifest.mode = CliConfigMode::Default;
    manifest.updated_at = now_stamp();
    execute_transaction(agent_name, &snapshots, &mutations, &manifest)?;
    status_for_unlocked(agent_name)
}

pub fn enable_orgii_managed(
    agent_name: &str,
    key_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    force: bool,
) -> Result<CliConfigManagedStatus, String> {
    let _guard = config_operation_guard()?;
    recover_pending_transaction_unlocked(agent_name)?;
    if !supported_agent(agent_name) {
        return Err(unavailable_agent_message(agent_name));
    }
    enable_agent_orgii_managed_unlocked(agent_name, key_id, provider, model, force)
}

/// Restore active managed CLI configs before the ORGII process exits.
///
/// Shutdown restoration is deliberately non-forcing: a config edited outside
/// ORGII is left untouched and reported instead of being overwritten.
pub fn restore_managed_configs_for_shutdown() -> Result<CliConfigShutdownRestoreReport, String> {
    let _guard = config_operation_guard()?;
    let mut report = CliConfigShutdownRestoreReport::default();

    for adapter in MANAGED_CONFIG_ADAPTERS {
        let agent_name = adapter.agent_name;
        if let Err(err) = recover_pending_transaction_unlocked(agent_name) {
            report.failed_agents.push((agent_name.to_string(), err));
            continue;
        }

        let managed_active = match read_manifest(agent_name) {
            Ok(Some(manifest)) => manifest.mode == CliConfigMode::OrgiiManaged,
            Ok(None) => false,
            Err(err) => {
                report.failed_agents.push((agent_name.to_string(), err));
                continue;
            }
        };
        if !managed_active {
            continue;
        }
        match restore_agent_default_unlocked(agent_name, false) {
            Ok(_) => report.restored_agents.push(agent_name.to_string()),
            Err(err) => report.failed_agents.push((agent_name.to_string(), err)),
        }
    }

    Ok(report)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_get_status(agent_name: String) -> Result<CliConfigManagedStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = config_operation_guard()?;
        recover_pending_transaction_unlocked(&agent_name)?;
        status_for_unlocked(&agent_name)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_restore_default(
    agent_name: String,
    force: bool,
) -> Result<CliConfigManagedStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = config_operation_guard()?;
        recover_pending_transaction_unlocked(&agent_name)?;
        if !supported_agent(&agent_name) {
            return Err(unavailable_agent_message(&agent_name));
        }
        restore_agent_default_unlocked(&agent_name, force)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    const TEST_PROXY_TOKEN: &str = "test-proxy-token";
    static TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct OrgiiHomeGuard {
        previous: Option<OsString>,
    }

    impl OrgiiHomeGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::var_os("ORGII_HOME");
            std::env::set_var("ORGII_HOME", path);
            Self { previous }
        }
    }

    impl Drop for OrgiiHomeGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("ORGII_HOME", value),
                None => std::env::remove_var("ORGII_HOME"),
            }
        }
    }

    fn test_target(
        id: &str,
        target_path: &Path,
        profile_root: &Path,
    ) -> CliConfigTargetFileManifest {
        CliConfigTargetFileManifest {
            id: id.to_string(),
            target_path: target_path.to_string_lossy().to_string(),
            default_backup_path: profile_root
                .join("default")
                .join(format!("{id}.bak"))
                .to_string_lossy()
                .to_string(),
            managed_profile_path: profile_root
                .join("managed")
                .join(format!("{id}.txt"))
                .to_string_lossy()
                .to_string(),
            original_hash: None,
            last_applied_hash: None,
            default_was_missing: false,
        }
    }

    fn test_manifest(
        agent_name: &str,
        targets: Vec<CliConfigTargetFileManifest>,
    ) -> CliConfigProfileManifest {
        CliConfigProfileManifest {
            agent: agent_name.to_string(),
            mode: CliConfigMode::OrgiiManaged,
            target_files: targets,
            selected_key_id: Some("key-1".to_string()),
            selected_provider: Some("openai_api".to_string()),
            selected_model: Some("gpt-test".to_string()),
            proxy_url: Some(DEFAULT_PROXY_URL.to_string()),
            proxy_token: Some(TEST_PROXY_TOKEN.to_string()),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        }
    }

    fn generated_for(agent_name: &str, existing: &[(&str, &str)]) -> BTreeMap<String, String> {
        let existing_contents = existing
            .iter()
            .map(|(id, content)| ((*id).to_string(), (*content).to_string()))
            .collect();
        generate_managed_configs(
            agent_name,
            &existing_contents,
            Some("test-model"),
            DEFAULT_PROXY_URL,
            TEST_PROXY_TOKEN,
        )
        .unwrap()
    }

    fn central_cli_registry_agent_names() -> Vec<&'static str> {
        include_str!("../../key-vault/src/commands/registry/data/cli_agents.rs")
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("name: \"")
                    .and_then(|value| value.strip_suffix("\","))
            })
            .collect()
    }

    #[test]
    fn codex_managed_config_preserves_existing_settings() {
        let raw = r#"
model = "gpt-5"
approval_policy = "on-request"

[features]
shell_tool = true
"#;

        let generated = generate_codex_managed_config(
            raw,
            Some("gpt-5-codex"),
            DEFAULT_PROXY_URL,
            TEST_PROXY_TOKEN,
        )
        .unwrap();
        let parsed: toml::Value = toml::from_str(&generated).unwrap();

        assert_eq!(parsed["model"].as_str(), Some("gpt-5-codex"));
        assert_eq!(parsed["model_provider"].as_str(), Some("orgii"));
        assert_eq!(parsed["approval_policy"].as_str(), Some("on-request"));
        assert_eq!(parsed["features"]["shell_tool"].as_bool(), Some(true));
        assert_eq!(
            parsed["model_providers"]["orgii"]["base_url"].as_str(),
            Some("http://127.0.0.1:17888/cli/codex/test-proxy-token/v1")
        );
        assert!(parsed["model_providers"]["orgii"].get("env_key").is_none());
        assert_eq!(
            parsed["model_providers"]["orgii"]["requires_openai_auth"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn codex_managed_config_uses_placeholder_model_when_missing() {
        let generated =
            generate_codex_managed_config("", None, "http://localhost:9999", TEST_PROXY_TOKEN)
                .unwrap();
        let parsed: toml::Value = toml::from_str(&generated).unwrap();

        assert_eq!(parsed["model"].as_str(), Some(DEFAULT_ORGII_MODEL));
        assert_eq!(
            parsed["model_providers"]["orgii"]["base_url"].as_str(),
            Some("http://localhost:9999/cli/codex/test-proxy-token/v1")
        );
    }

    #[test]
    fn claude_code_managed_config_preserves_existing_settings() {
        let raw = r#"
{
  "permissions": {
    "allow": ["Bash(git status:*)"]
  },
  "env": {
    "CUSTOM_FLAG": "keep"
  }
}
"#;

        let generated = generate_claude_code_managed_config(
            raw,
            Some("claude-sonnet-4-5"),
            DEFAULT_PROXY_URL,
            TEST_PROXY_TOKEN,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&generated).unwrap();

        assert_eq!(parsed["model"].as_str(), Some("claude-sonnet-4-5"));
        assert_eq!(
            parsed["permissions"]["allow"][0].as_str(),
            Some("Bash(git status:*)")
        );
        assert_eq!(parsed["env"]["CUSTOM_FLAG"].as_str(), Some("keep"));
        assert_eq!(
            parsed["env"]["ANTHROPIC_BASE_URL"].as_str(),
            Some("http://127.0.0.1:17888/cli/claude_code/test-proxy-token/claude")
        );
        assert_eq!(
            parsed["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
            Some(TEST_PROXY_TOKEN)
        );
        assert_eq!(
            parsed["env"]["ANTHROPIC_MODEL"].as_str(),
            Some("claude-sonnet-4-5")
        );
    }

    #[test]
    fn proxy_base_urls_include_authenticated_route() {
        assert_eq!(
            codex_proxy_base_url(DEFAULT_PROXY_URL, TEST_PROXY_TOKEN),
            "http://127.0.0.1:17888/cli/codex/test-proxy-token/v1"
        );
        assert_eq!(
            claude_code_proxy_base_url(DEFAULT_PROXY_URL, TEST_PROXY_TOKEN),
            "http://127.0.0.1:17888/cli/claude_code/test-proxy-token/claude"
        );
    }

    #[test]
    fn managed_adapter_registry_exposes_protocols_and_targets() {
        assert_eq!(
            managed_proxy_protocol_for_agent(CODEX_AGENT),
            Some(CliManagedProxyProtocol::OpenAiResponses)
        );
        assert_eq!(
            managed_proxy_protocol_for_agent(OPENCODE_AGENT),
            Some(CliManagedProxyProtocol::OpenAiChatCompletions)
        );
        assert_eq!(
            managed_proxy_protocol_for_agent(AIDER_AGENT),
            Some(CliManagedProxyProtocol::OpenAiChatCompletions)
        );
        assert!(!supported_agent("amp"));

        let opencode_targets = agent_manifest_targets(OPENCODE_AGENT).unwrap();
        assert_eq!(opencode_targets.len(), 1);
        assert_eq!(opencode_targets[0].id, OPENCODE_CONFIG_FILE_ID);
        let aider_targets = agent_manifest_targets(AIDER_AGENT).unwrap();
        assert_eq!(aider_targets.len(), 1);
        assert_eq!(aider_targets[0].id, AIDER_CONFIG_FILE_ID);
    }

    #[test]
    fn every_central_cli_registry_entry_has_an_explicit_managed_config_result() {
        let agent_names = central_cli_registry_agent_names();
        assert_eq!(agent_names.len(), 26);

        let mut supported = 0;
        let mut unavailable = 0;
        for agent_name in agent_names {
            match managed_config_availability_for_agent(agent_name) {
                CliManagedConfigAvailability::Supported(_) => supported += 1,
                CliManagedConfigAvailability::Unavailable(reason) => {
                    unavailable += 1;
                    assert!(!reason.trim().is_empty(), "missing reason for {agent_name}");
                }
                CliManagedConfigAvailability::Unknown => {
                    panic!("central CLI registry entry is not classified: {agent_name}")
                }
            }
        }

        assert_eq!(supported, 18);
        assert_eq!(unavailable, 8);
    }

    #[test]
    fn every_managed_adapter_resolves_all_declared_targets() {
        for adapter in MANAGED_CONFIG_ADAPTERS {
            let targets = agent_manifest_targets(adapter.agent_name).unwrap();
            assert_eq!(
                targets.len(),
                adapter.targets.len(),
                "{}",
                adapter.agent_name
            );
            assert!(!targets.is_empty(), "{}", adapter.agent_name);
        }

        let omp_targets = agent_manifest_targets(OMP_AGENT).unwrap();
        assert!(omp_targets[0]
            .target_path
            .replace('\\', "/")
            .ends_with("/.oh-omp/agent/models.yml"));
        assert!(omp_targets[1]
            .target_path
            .replace('\\', "/")
            .ends_with("/.oh-omp/agent/config.yml"));

        if std::env::var_os("GOOSE_PATH_ROOT").is_none() {
            let goose_targets = agent_manifest_targets(GOOSE_AGENT).unwrap();
            let config_path = goose_targets[0].target_path.replace('\\', "/");
            let secrets_path = goose_targets[1].target_path.replace('\\', "/");
            #[cfg(target_os = "windows")]
            {
                assert!(config_path.ends_with("/Block/goose/config/config.yaml"));
                assert!(secrets_path.ends_with("/Block/goose/config/secrets.yaml"));
            }
            #[cfg(not(target_os = "windows"))]
            {
                assert!(config_path.ends_with("/goose/config.yaml"));
                assert!(secrets_path.ends_with("/goose/secrets.yaml"));
            }
        }
    }

    #[test]
    fn opencode_managed_config_preserves_jsonc_and_adds_orgii_provider() {
        let raw = r#"
{
  // Keep existing providers and settings.
  "theme": "system",
  "provider": {
    "existing": {
      "npm": "@ai-sdk/openai"
    },
  },
}
"#;

        let generated = generate_opencode_managed_config(
            raw,
            Some("deepseek-chat"),
            DEFAULT_PROXY_URL,
            TEST_PROXY_TOKEN,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&generated).unwrap();

        assert_eq!(parsed["theme"].as_str(), Some("system"));
        assert!(parsed["provider"]["existing"].is_object());
        assert_eq!(
            parsed["provider"]["orgii"]["options"]["baseURL"].as_str(),
            Some("http://127.0.0.1:17888/cli/opencode/test-proxy-token/v1")
        );
        assert_eq!(
            parsed["provider"]["orgii"]["options"]["apiKey"].as_str(),
            Some(TEST_PROXY_TOKEN)
        );
        assert_eq!(parsed["model"].as_str(), Some("orgii/deepseek-chat"));
        assert_eq!(parsed["small_model"].as_str(), Some("orgii/deepseek-chat"));
    }

    #[test]
    fn aider_managed_config_preserves_yaml_and_uses_openai_compatible_model() {
        let raw = r#"
auto-commits: false
map-tokens: 2048
"#;

        let generated = generate_aider_managed_config(
            raw,
            Some("anthropic/claude-sonnet-4"),
            DEFAULT_PROXY_URL,
            TEST_PROXY_TOKEN,
        )
        .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&generated).unwrap();

        assert_eq!(parsed["auto-commits"].as_bool(), Some(false));
        assert_eq!(parsed["map-tokens"].as_u64(), Some(2048));
        assert_eq!(
            parsed["model"].as_str(),
            Some("openai/anthropic/claude-sonnet-4")
        );
        assert_eq!(
            parsed["openai-api-base"].as_str(),
            Some("http://127.0.0.1:17888/cli/aider/test-proxy-token/v1")
        );
        assert_eq!(parsed["openai-api-key"].as_str(), Some(TEST_PROXY_TOKEN));
    }

    #[test]
    fn kimi_and_goose_managed_configs_select_the_orgii_model() {
        let kimi = generated_for(
            KIMI_CLI_AGENT,
            &[(KIMI_CLI_CONFIG_FILE_ID, "theme = \"dark\"\n")],
        );
        let kimi: toml::Value = toml::from_str(&kimi[KIMI_CLI_CONFIG_FILE_ID]).unwrap();
        assert_eq!(kimi["theme"].as_str(), Some("dark"));
        assert_eq!(kimi["default_model"].as_str(), Some("orgii/test-model"));
        assert_eq!(
            kimi["providers"]["orgii"]["base_url"].as_str(),
            Some("http://127.0.0.1:17888/cli/kimi_cli/test-proxy-token/v1")
        );
        assert_eq!(
            kimi["models"]["orgii/test-model"]["provider"].as_str(),
            Some("orgii")
        );

        let goose = generated_for(
            GOOSE_AGENT,
            &[
                (
                    GOOSE_CONFIG_FILE_ID,
                    "extensions:\n  developer:\n    enabled: true\n",
                ),
                (GOOSE_SECRETS_FILE_ID, "EXISTING_SECRET: keep\n"),
            ],
        );
        let goose_config: serde_yaml::Value =
            serde_yaml::from_str(&goose[GOOSE_CONFIG_FILE_ID]).unwrap();
        let goose_secrets: serde_yaml::Value =
            serde_yaml::from_str(&goose[GOOSE_SECRETS_FILE_ID]).unwrap();
        assert_eq!(goose_config["active_provider"].as_str(), Some("openai"));
        assert_eq!(
            goose_config["providers"]["openai"]["model"].as_str(),
            Some("test-model")
        );
        assert_eq!(
            goose_config["OPENAI_BASE_URL"].as_str(),
            Some("http://127.0.0.1:17888/cli/goose/test-proxy-token/v1")
        );
        assert_eq!(
            goose_config["extensions"]["developer"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(goose_secrets["EXISTING_SECRET"].as_str(), Some("keep"));
        assert_eq!(
            goose_secrets["OPENAI_API_KEY"].as_str(),
            Some(TEST_PROXY_TOKEN)
        );
    }

    #[test]
    fn cline_kilo_and_mimo_configs_activate_the_managed_provider() {
        let cline = generated_for(
            CLINE_AGENT,
            &[(
                CLINE_PROVIDERS_FILE_ID,
                r#"{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"provider":"cline"},"updatedAt":"2026-01-01T00:00:00.000Z","tokenSource":"oauth"}}}"#,
            )],
        );
        let cline: serde_json::Value =
            serde_json::from_str(&cline[CLINE_PROVIDERS_FILE_ID]).unwrap();
        assert_eq!(cline["lastUsedProvider"].as_str(), Some("orgii"));
        assert!(cline["providers"]["cline"].is_object());
        assert!(chrono::DateTime::parse_from_rfc3339(
            cline["providers"]["orgii"]["updatedAt"].as_str().unwrap()
        )
        .is_ok());
        assert_eq!(
            cline["providers"]["orgii"]["settings"]["model"].as_str(),
            Some("test-model")
        );
        assert_eq!(
            cline["providers"]["orgii"]["settings"]["protocol"].as_str(),
            Some("openai-chat")
        );
        assert_eq!(
            cline["providers"]["orgii"]["settings"]["client"].as_str(),
            Some("openai-compatible")
        );
        assert_eq!(
            cline["providers"]["orgii"]["settings"]["baseUrl"].as_str(),
            Some("http://127.0.0.1:17888/cli/cline/test-proxy-token/v1")
        );

        let kilo = generated_for(
            KILO_AGENT,
            &[(KILO_CONFIG_FILE_ID, "{ enabled_providers: ['existing'] }")],
        );
        let kilo: serde_json::Value = serde_json::from_str(&kilo[KILO_CONFIG_FILE_ID]).unwrap();
        assert_eq!(kilo["model"].as_str(), Some("orgii/test-model"));
        assert!(kilo["enabled_providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str() == Some("orgii")));
        assert_eq!(
            kilo["provider"]["orgii"]["options"]["baseURL"].as_str(),
            Some("http://127.0.0.1:17888/cli/kilo/test-proxy-token/v1")
        );

        let mimo = generated_for(
            MIMO_CODE_AGENT,
            &[(MIMO_CODE_CONFIG_FILE_ID, "{\"theme\":\"dark\"}")],
        );
        let mimo: serde_json::Value =
            serde_json::from_str(&mimo[MIMO_CODE_CONFIG_FILE_ID]).unwrap();
        assert_eq!(mimo["theme"].as_str(), Some("dark"));
        assert_eq!(mimo["model"].as_str(), Some("orgii/test-model"));
        assert_eq!(
            mimo["provider"]["orgii"]["options"]["baseURL"].as_str(),
            Some("http://127.0.0.1:17888/cli/mimo_code/test-proxy-token/v1")
        );
    }

    #[test]
    fn hermes_openclaw_and_qwen_configs_preserve_existing_values() {
        let hermes = generated_for(
            HERMES_AGENT,
            &[(HERMES_CONFIG_FILE_ID, "display:\n  compact: true\n")],
        );
        let hermes: serde_yaml::Value =
            serde_yaml::from_str(&hermes[HERMES_CONFIG_FILE_ID]).unwrap();
        assert_eq!(hermes["display"]["compact"].as_bool(), Some(true));
        assert_eq!(hermes["model"]["provider"].as_str(), Some("custom"));
        assert_eq!(hermes["model"]["default"].as_str(), Some("test-model"));

        let openclaw = generated_for(
            OPENCLAW_AGENT,
            &[(OPENCLAW_CONFIG_FILE_ID, "{ logging: { level: 'debug' } }")],
        );
        let openclaw: serde_json::Value =
            serde_json::from_str(&openclaw[OPENCLAW_CONFIG_FILE_ID]).unwrap();
        assert_eq!(openclaw["logging"]["level"].as_str(), Some("debug"));
        assert_eq!(
            openclaw["agents"]["defaults"]["model"]["primary"].as_str(),
            Some("orgii/test-model")
        );
        assert_eq!(
            openclaw["models"]["providers"]["orgii"]["api"].as_str(),
            Some("openai-completions")
        );

        let qwen = generated_for(
            QWEN_CODE_AGENT,
            &[(QWEN_CODE_SETTINGS_FILE_ID, "{\"theme\":\"dark\"}")],
        );
        let qwen: serde_json::Value =
            serde_json::from_str(&qwen[QWEN_CODE_SETTINGS_FILE_ID]).unwrap();
        assert_eq!(qwen["theme"].as_str(), Some("dark"));
        assert_eq!(
            qwen["security"]["auth"]["selectedType"].as_str(),
            Some("orgii")
        );
        assert_eq!(qwen["providerProtocol"]["orgii"].as_str(), Some("openai"));
        assert_eq!(
            qwen["modelProviders"]["orgii"][0]["baseUrl"].as_str(),
            Some("http://127.0.0.1:17888/cli/qwen_code/test-proxy-token/v1")
        );
    }

    #[test]
    fn continue_droid_and_autohand_configs_select_the_managed_model() {
        let continue_config = generated_for(
            CONTINUE_CLI_AGENT,
            &[(
                CONTINUE_CLI_CONFIG_FILE_ID,
                "name: Existing\nversion: 2.0.0\nmodels: []\n",
            )],
        );
        let continue_config: serde_yaml::Value =
            serde_yaml::from_str(&continue_config[CONTINUE_CLI_CONFIG_FILE_ID]).unwrap();
        assert_eq!(continue_config["name"].as_str(), Some("Existing"));
        assert_eq!(continue_config["models"][0]["name"].as_str(), Some("ORGII"));
        assert_eq!(
            continue_config["models"][0]["model"].as_str(),
            Some("test-model")
        );
        assert!(!continue_config["models"][0]["roles"]
            .as_sequence()
            .unwrap()
            .iter()
            .any(|role| role.as_str() == Some("apply")));

        let droid = generated_for(
            DROID_AGENT,
            &[(DROID_SETTINGS_FILE_ID, "{\"theme\":\"dark\"}")],
        );
        let droid: serde_json::Value =
            serde_json::from_str(&droid[DROID_SETTINGS_FILE_ID]).unwrap();
        assert_eq!(droid["theme"].as_str(), Some("dark"));
        assert_eq!(droid["model"].as_str(), Some("test-model"));
        assert_eq!(
            droid["customModels"][0]["displayName"].as_str(),
            Some("ORGII")
        );
        assert_eq!(
            droid["customModels"][0]["baseUrl"].as_str(),
            Some("http://127.0.0.1:17888/cli/droid/test-proxy-token/v1")
        );

        let autohand = generated_for(
            AUTOHAND_AGENT,
            &[(AUTOHAND_CONFIG_FILE_ID, "{\"telemetry\":false}")],
        );
        let autohand: serde_json::Value =
            serde_json::from_str(&autohand[AUTOHAND_CONFIG_FILE_ID]).unwrap();
        assert_eq!(autohand["telemetry"].as_bool(), Some(false));
        assert_eq!(autohand["provider"].as_str(), Some("openai"));
        assert_eq!(autohand["openai"]["model"].as_str(), Some("test-model"));
    }

    #[test]
    fn vibe_omp_and_pi_multi_file_configs_are_complete() {
        let vibe = generated_for(
            MISTRAL_VIBE_AGENT,
            &[
                (MISTRAL_VIBE_CONFIG_FILE_ID, "theme = \"dark\"\n"),
                (MISTRAL_VIBE_ENV_FILE_ID, "EXISTING=keep\n"),
            ],
        );
        let vibe_config: toml::Value = toml::from_str(&vibe[MISTRAL_VIBE_CONFIG_FILE_ID]).unwrap();
        assert_eq!(vibe_config["theme"].as_str(), Some("dark"));
        assert_eq!(vibe_config["active_model"].as_str(), Some("orgii"));
        assert_eq!(vibe_config["providers"][0]["name"].as_str(), Some("orgii"));
        assert_eq!(
            vibe_config["models"][0]["name"].as_str(),
            Some("test-model")
        );
        assert!(vibe[MISTRAL_VIBE_ENV_FILE_ID].contains("EXISTING=keep"));
        assert!(vibe[MISTRAL_VIBE_ENV_FILE_ID].contains("ORGII_API_KEY=\"test-proxy-token\""));

        let omp = generated_for(
            OMP_AGENT,
            &[
                (OMP_MODELS_FILE_ID, "providers: {}\n"),
                (OMP_SETTINGS_FILE_ID, "theme:\n  dark: titanium\n"),
            ],
        );
        let omp_models: serde_yaml::Value = serde_yaml::from_str(&omp[OMP_MODELS_FILE_ID]).unwrap();
        let omp_settings: serde_yaml::Value =
            serde_yaml::from_str(&omp[OMP_SETTINGS_FILE_ID]).unwrap();
        assert_eq!(
            omp_models["providers"]["orgii"]["models"][0]["id"].as_str(),
            Some("test-model")
        );
        assert_eq!(
            omp_settings["modelRoles"]["default"].as_str(),
            Some("orgii/test-model")
        );
        assert!(omp_settings["modelRoles"].get("task").is_none());
        assert_eq!(omp_settings["theme"]["dark"].as_str(), Some("titanium"));

        let pi = generated_for(
            PI_AGENT,
            &[
                (PI_SETTINGS_FILE_ID, "{\"theme\":\"dark\"}"),
                (PI_MODELS_FILE_ID, "{\"providers\":{}}"),
            ],
        );
        let pi_settings: serde_json::Value =
            serde_json::from_str(&pi[PI_SETTINGS_FILE_ID]).unwrap();
        let pi_models: serde_json::Value = serde_json::from_str(&pi[PI_MODELS_FILE_ID]).unwrap();
        assert_eq!(pi_settings["theme"].as_str(), Some("dark"));
        assert_eq!(pi_settings["defaultProvider"].as_str(), Some("orgii"));
        assert_eq!(pi_settings["defaultModel"].as_str(), Some("test-model"));
        assert_eq!(
            pi_models["providers"]["orgii"]["models"][0]["id"].as_str(),
            Some("test-model")
        );
    }

    #[test]
    fn generated_proxy_token_has_256_bits() {
        let token = generate_proxy_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn atomic_write_replaces_existing_file_without_delete_gap() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        std::fs::write(&path, b"old").unwrap();

        write_file_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn transaction_rolls_back_prior_targets_when_later_write_fails() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_a_path = temp.path().join("a.json");
        let blocked_parent = temp.path().join("blocked-parent");
        let target_b_path = blocked_parent.join("b.json");
        std::fs::write(&target_a_path, b"original-a").unwrap();
        std::fs::write(&blocked_parent, b"not-a-directory").unwrap();

        let profile_root = temp.path().join("profiles");
        let target_a = test_target("a", &target_a_path, &profile_root);
        let target_b = test_target("b", &target_b_path, &profile_root);
        let targets = vec![target_a.clone(), target_b.clone()];
        let snapshots = read_target_snapshots(&targets).unwrap();
        let manifest = test_manifest("test-agent", targets);
        let mutations = BTreeMap::from([
            (
                "a".to_string(),
                TargetMutation::Write(b"managed-a".to_vec()),
            ),
            (
                "b".to_string(),
                TargetMutation::Write(b"managed-b".to_vec()),
            ),
        ]);

        let result = execute_transaction("test-agent", &snapshots, &mutations, &manifest);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&target_a_path).unwrap(), b"original-a");
        assert!(!target_b_path.exists());
        assert!(!transaction_journal_path("test-agent").exists());
    }

    #[test]
    fn pending_transaction_recovers_exact_pre_operation_content() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_path = temp.path().join("config.toml");
        std::fs::write(&target_path, b"original").unwrap();
        let target = test_target("config", &target_path, &temp.path().join("profiles"));
        let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();
        let manifest = test_manifest("test-agent", vec![target]);

        begin_transaction("test-agent", &snapshots, &manifest).unwrap();
        write_file_atomic(&target_path, b"managed").unwrap();
        recover_pending_transaction_unlocked("test-agent").unwrap();

        assert_eq!(std::fs::read(&target_path).unwrap(), b"original");
        assert!(!transaction_journal_path("test-agent").exists());
    }

    #[test]
    fn committed_transaction_cleanup_does_not_undo_target_changes() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_path = temp.path().join("config.toml");
        std::fs::write(&target_path, b"original").unwrap();
        let target = test_target("config", &target_path, &temp.path().join("profiles"));
        let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();
        let manifest = test_manifest("test-agent", vec![target]);

        begin_transaction("test-agent", &snapshots, &manifest).unwrap();
        write_file_atomic(&target_path, b"managed").unwrap();
        write_manifest(&manifest).unwrap();
        recover_pending_transaction_unlocked("test-agent").unwrap();

        assert_eq!(std::fs::read(&target_path).unwrap(), b"managed");
        assert!(!transaction_journal_path("test-agent").exists());
    }

    #[test]
    fn refreshed_default_backups_are_versioned_and_never_overwritten() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_path = temp.path().join("config.toml");
        let profile_root = temp.path().join("profiles");
        let target = test_target("config", &target_path, &profile_root);

        std::fs::write(&target_path, b"default-v1").unwrap();
        let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();
        let first = ensure_default_backup_from_snapshot(
            "test-agent",
            target,
            snapshots.get("config").unwrap(),
            true,
        )
        .unwrap();

        std::fs::write(&target_path, b"default-v2").unwrap();
        let snapshots = read_target_snapshots(std::slice::from_ref(&first)).unwrap();
        let second = ensure_default_backup_from_snapshot(
            "test-agent",
            first.clone(),
            snapshots.get("config").unwrap(),
            true,
        )
        .unwrap();

        assert_ne!(first.default_backup_path, second.default_backup_path);
        assert_eq!(
            std::fs::read(&first.default_backup_path).unwrap(),
            b"default-v1"
        );
        assert_eq!(
            std::fs::read(&second.default_backup_path).unwrap(),
            b"default-v2"
        );
    }

    #[test]
    fn restore_is_a_noop_when_default_mode_is_already_active() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_path = temp.path().join("config.toml");
        let profile_root = temp.path().join("profiles");
        let mut target = test_target("config", &target_path, &profile_root);
        let backup_path = PathBuf::from(&target.default_backup_path);
        std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
        std::fs::write(&backup_path, b"older-default").unwrap();
        std::fs::write(&target_path, b"new-user-change").unwrap();
        target.original_hash = Some(sha256_bytes(b"older-default"));
        target.last_applied_hash = Some(sha256_bytes(b"managed"));

        let mut manifest = test_manifest(CODEX_AGENT, vec![target]);
        manifest.mode = CliConfigMode::Default;
        write_manifest(&manifest).unwrap();

        restore_agent_default_unlocked(CODEX_AGENT, false).unwrap();

        assert_eq!(std::fs::read(&target_path).unwrap(), b"new-user-change");
    }

    #[test]
    fn shutdown_restores_active_managed_config_without_forcing() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_path = temp.path().join("config.toml");
        let profile_root = temp.path().join("profiles");
        let mut target = test_target("config", &target_path, &profile_root);
        let backup_path = PathBuf::from(&target.default_backup_path);
        std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
        std::fs::write(&backup_path, b"default-config").unwrap();
        std::fs::write(&target_path, b"managed-config").unwrap();
        target.original_hash = Some(sha256_bytes(b"default-config"));
        target.last_applied_hash = Some(sha256_bytes(b"managed-config"));
        write_manifest(&test_manifest(CODEX_AGENT, vec![target])).unwrap();

        let report = restore_managed_configs_for_shutdown().unwrap();

        assert_eq!(report.restored_agents, vec![CODEX_AGENT.to_string()]);
        assert!(report.failed_agents.is_empty());
        assert_eq!(std::fs::read(&target_path).unwrap(), b"default-config");
        assert_eq!(
            read_manifest(CODEX_AGENT).unwrap().unwrap().mode,
            CliConfigMode::Default
        );
    }

    #[test]
    fn shutdown_leaves_externally_modified_managed_config_untouched() {
        let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
        let target_path = temp.path().join("config.toml");
        let profile_root = temp.path().join("profiles");
        let mut target = test_target("config", &target_path, &profile_root);
        let backup_path = PathBuf::from(&target.default_backup_path);
        std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
        std::fs::write(&backup_path, b"default-config").unwrap();
        std::fs::write(&target_path, b"external-change").unwrap();
        target.original_hash = Some(sha256_bytes(b"default-config"));
        target.last_applied_hash = Some(sha256_bytes(b"managed-config"));
        write_manifest(&test_manifest(CODEX_AGENT, vec![target])).unwrap();

        let report = restore_managed_configs_for_shutdown().unwrap();

        assert!(report.restored_agents.is_empty());
        assert_eq!(report.failed_agents.len(), 1);
        assert_eq!(report.failed_agents[0].0, CODEX_AGENT);
        assert_eq!(std::fs::read(&target_path).unwrap(), b"external-change");
        assert_eq!(
            read_manifest(CODEX_AGENT).unwrap().unwrap().mode,
            CliConfigMode::OrgiiManaged
        );
    }

    #[test]
    fn missing_managed_mode_backup_is_never_recreated_from_active_config() {
        let temp = tempfile::tempdir().unwrap();
        let target_path = temp.path().join("config.toml");
        std::fs::write(&target_path, b"managed-content").unwrap();
        let mut target = test_target("config", &target_path, &temp.path().join("profiles"));
        target.original_hash = Some(sha256_bytes(b"original-content"));
        target.last_applied_hash = Some(sha256_bytes(b"managed-content"));
        let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();

        let result = ensure_default_backup_from_snapshot(
            "test-agent",
            target,
            snapshots.get("config").unwrap(),
            false,
        );

        assert!(result.is_err());
    }
}
