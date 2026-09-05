//! Offline credential-suggestion probe.
//!
//! Answers "which credentials for other coding tools already live on this
//! machine?" cheaply enough to run on every Key Vault visit: file stats,
//! JSON/YAML/shell-profile parsing, and a read-only SQLite lookup. No
//! network I/O, and no OS keychain *reads* (only an existence check on
//! macOS, which does not prompt).
//!
//! Secrets are reduced to a short fingerprint and never leave this module.
//! The per-agent detectors in the sibling modules remain the only path that
//! hands key material to the save pipeline — see
//! `commands::validate::suggestions` for the import side.

mod cc_switch;
mod codex_config;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::claude::{
    claude_credentials_paths_in, claude_keychain_account, claude_keychain_service_candidates,
    oauth_access_token_from_credentials_json,
};
use super::copilot::extract_github_token_from_config;
use super::cursor::{cursor_state_db_path_in, read_cursor_access_token};
use cc_switch::{cc_switch_db_path_in, read_cc_switch_credentials};
use codex_config::{codex_config_path_in, parse_codex_model_providers};
use super::helpers::{
    claude_config_paths_in, extract_export_value, get_home_dir, openai_config_paths_in,
    ClaudeConfig, OpenAIConfig,
};
use crate::commands::registry::data::{api_provider_registry, cli_agent_registry, cli_env_config};
use crate::commands::{OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL};
use crate::key_store::{AuthMethod, ModelKey, ModelType};
use crate::provider_config::get_provider_config;
use crate::providers::kiro::KIRO_TOKEN_KEY;

// ============================================
// Public types
// ============================================

/// Where a suggested credential was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionSourceKind {
    /// Process environment variable.
    Env,
    /// `export VAR=...` in a shell profile (`~/.zshrc`, `~/.bashrc`, ...).
    ShellProfile,
    /// A tool's JSON config file carrying an API key.
    ConfigFile,
    /// A tool's OAuth token store on disk.
    OauthStore,
    /// An OS keychain item (existence only — never read here).
    Keychain,
    /// A tool's local state database.
    StateDb,
    /// A profile managed by cc-switch (`~/.cc-switch/cc-switch.db`).
    CcSwitch,
}

impl SuggestionSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SuggestionSourceKind::Env => "env",
            SuggestionSourceKind::ShellProfile => "shell_profile",
            SuggestionSourceKind::ConfigFile => "config_file",
            SuggestionSourceKind::OauthStore => "oauth_store",
            SuggestionSourceKind::Keychain => "keychain",
            SuggestionSourceKind::StateDb => "state_db",
            SuggestionSourceKind::CcSwitch => "cc_switch",
        }
    }
}

/// One importable credential found on the local machine. Carries no secret
/// material: `fingerprint` is a truncated SHA-256 of the secret used to
/// match against vault entries and against the full detector's output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSuggestion {
    /// Stable identity: `{agent_type}:{source_kind}:{source_label}`.
    pub id: String,
    /// `ModelType::as_str()` of the vault entry this would become.
    pub agent_type: String,
    /// `"api_key"` or `"oauth"`.
    pub auth_method: String,
    pub source_kind: SuggestionSourceKind,
    /// Env var name, or a `~`-abbreviated path plus a qualifier.
    pub source_label: String,
    /// Absolute path when the source is a file.
    pub source_path: Option<String>,
    /// Machine-readable locator inside the source, used to re-read the
    /// secret at import time: the env var name inside a settings file, the
    /// provider id inside an auth file, or `app_type:id` of a cc-switch
    /// profile. `None` when the file itself is the credential.
    #[serde(default)]
    pub source_ref: Option<String>,
    /// Truncated SHA-256 of the secret. `None` when the secret cannot be
    /// read offline (keychain items, opaque state stores).
    pub fingerprint: Option<String>,
    /// The vault already holds this secret (or, for fingerprint-less
    /// sources, an OAuth entry for the same agent).
    pub already_imported: bool,
}

// ============================================
// Probe context (injectable for tests)
// ============================================

/// Everything the probe touches outside the filesystem, so tests can run
/// against a temp HOME with a synthetic environment.
pub(crate) struct ProbeContext<'a> {
    pub home: Option<PathBuf>,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// `(service, account)` → whether a keychain item exists. Must not
    /// read the item's secret.
    pub keychain_item_exists: &'a dyn Fn(&str, Option<&str>) -> bool,
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
fn keychain_item_exists(service: &str, account: Option<&str>) -> bool {
    use std::process::Command;

    // No `-w`: attribute lookup only, which never triggers the ACL prompt
    // that reading the password would.
    let mut args = vec!["find-generic-password", "-s", service];
    if let Some(account) = account {
        args.push("-a");
        args.push(account);
    }
    Command::new("security")
        .args(&args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn keychain_item_exists(_service: &str, _account: Option<&str>) -> bool {
    false
}

/// Probe the real machine. `stored` is the current vault contents, used to
/// flag suggestions that are already imported.
pub fn probe_credential_suggestions(stored: &[ModelKey]) -> Vec<CredentialSuggestion> {
    let ctx = ProbeContext {
        home: get_home_dir(),
        env: &process_env,
        keychain_item_exists: &keychain_item_exists,
    };
    probe_with(&ctx, stored)
}

// ============================================
// Fingerprints
// ============================================

/// Truncated SHA-256 of a secret. Long enough to be collision-free for a
/// handful of keys, short enough to be harmless if it leaks into logs.
pub fn secret_fingerprint(secret: &str) -> String {
    let digest = Sha256::digest(secret.trim().as_bytes());
    format!("{:x}", digest)[..16].to_string()
}

/// Every fingerprint a stored vault entry can be matched by: API key,
/// session token (both the full Cursor `{uid}%3A%3A{jwt}` form and the bare
/// JWT), and OAuth material stashed in `env_vars`.
fn stored_fingerprints(stored: &[ModelKey]) -> HashSet<String> {
    let mut set = HashSet::new();
    for key in stored {
        if let Some(api_key) = key.api_key.as_deref() {
            set.insert(secret_fingerprint(api_key));
        }
        if let Some(token) = key.session_token.as_deref() {
            set.insert(secret_fingerprint(token));
            if let Some(bare) = token.split("%3A%3A").nth(1) {
                set.insert(secret_fingerprint(bare));
            }
        }
        for value in key.env_vars.values() {
            if !value.trim().is_empty() {
                set.insert(secret_fingerprint(value));
            }
        }
    }
    set
}

fn stored_has_oauth_for(stored: &[ModelKey], agent: &str) -> bool {
    stored.iter().any(|key| {
        key.model_type.as_str() == agent
            && key.auth_method == AuthMethod::Oauth
            && (key.session_token.is_some() || !key.env_vars.is_empty())
    })
}

// ============================================
// Env-var ownership table
// ============================================

/// Which vault entry an env var should become, derived from the CLI and
/// API-provider registries so new providers are covered automatically.
#[derive(Debug, Clone)]
pub(crate) struct EnvOwner {
    pub var: String,
    pub agent: String,
    pub auth_method: &'static str,
    /// Companion base-URL variable (`ANTHROPIC_BASE_URL`, ...).
    pub base_url_var: Option<String>,
    /// Base URL implied by the variable itself (OpenCode Zen/Go, or a
    /// Codex `model_providers` relay).
    pub fixed_base_url: Option<String>,
}

/// Providers whose "key" is not a single bearer secret and cannot be
/// imported from one env var.
const ENV_SKIP_PROVIDERS: &[&str] = &[
    "custom_api",
    "vllm_api",
    "bedrock_api",
    "azure_openai_api",
    "azure_anthropic_api",
    "orgii_orchestrator",
];

/// CLI agents whose vault entry needs OAuth/session material, so an API-key
/// env var alone is not a usable import.
const ENV_SKIP_CLI_AGENTS: &[&str] = &["cursor_cli", "kiro"];

/// Bespoke variables the per-agent detectors already understand. Listed
/// first so they win over the generic registry mapping.
fn bespoke_env_owners() -> Vec<EnvOwner> {
    vec![
        EnvOwner {
            var: "ANTHROPIC_AUTH_TOKEN".into(),
            agent: "claude_code".into(),
            auth_method: "api_key",
            base_url_var: Some("ANTHROPIC_BASE_URL".into()),
            fixed_base_url: None,
        },
        EnvOwner {
            var: "GH_TOKEN".into(),
            agent: "copilot".into(),
            auth_method: "api_key",
            base_url_var: None,
            fixed_base_url: None,
        },
        EnvOwner {
            var: "GITHUB_TOKEN".into(),
            agent: "copilot".into(),
            auth_method: "api_key",
            base_url_var: None,
            fixed_base_url: None,
        },
        EnvOwner {
            var: "OPENCODE_API_KEY".into(),
            agent: "opencode".into(),
            auth_method: "api_key",
            base_url_var: None,
            fixed_base_url: Some(OPENCODE_ZEN_BASE_URL.to_string()),
        },
        EnvOwner {
            var: "OPENCODE_GO_API_KEY".into(),
            agent: "opencode".into(),
            auth_method: "api_key",
            base_url_var: None,
            fixed_base_url: Some(OPENCODE_GO_BASE_URL.to_string()),
        },
    ]
}

/// Build the env-var → owner table. Generic provider keys (`OPENAI_API_KEY`,
/// `ANTHROPIC_API_KEY`, ...) are attributed to the API provider, never to a
/// CLI that merely consumes them; CLI agents only own their bespoke
/// variables (`AMP_API_KEY`, `DEVIN_API_KEY`, ...). Relay variables declared
/// in `~/.codex/config.toml` (`env_key`) are owned by Codex with the relay's
/// base URL. First claim wins.
#[cfg(test)]
pub(crate) fn env_owners() -> Vec<EnvOwner> {
    env_owners_in(get_home_dir().as_deref(), &process_env)
}

pub(crate) fn env_owners_in(
    home: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<EnvOwner> {
    let mut owners: Vec<EnvOwner> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();

    let mut claim = |owner: EnvOwner, owners: &mut Vec<EnvOwner>| {
        if owner.var.is_empty() || owner.var.starts_with("AWS_") {
            return;
        }
        if claimed.insert(owner.var.clone()) {
            owners.push(owner);
        }
    };

    for owner in bespoke_env_owners() {
        claim(owner, &mut owners);
    }

    let cli_agents = cli_agent_registry();

    for provider in api_provider_registry() {
        if ENV_SKIP_PROVIDERS.contains(&provider.name) {
            continue;
        }
        let config = get_provider_config(provider.name);
        // Provider configs mostly leave the base-URL variable unset; the
        // CLI that consumes the same key (claude_code → ANTHROPIC_BASE_URL,
        // codex → OPENAI_BASE_URL) knows it, and `<PREFIX>_BASE_URL` is the
        // convention every other provider follows.
        let base_url_var = config.base_url_env_var.clone().or_else(|| {
            cli_agents
                .iter()
                .filter_map(|agent| cli_env_config(agent.name))
                .find(|cfg| cfg.api_key_env_var == config.api_key_env_var)
                .and_then(|cfg| cfg.base_url_env_var)
                .or_else(|| {
                    config
                        .api_key_env_var
                        .strip_suffix("_API_KEY")
                        .map(|prefix| format!("{prefix}_BASE_URL"))
                })
        });
        claim(
            EnvOwner {
                var: config.api_key_env_var.clone(),
                agent: provider.name.to_string(),
                auth_method: "api_key",
                base_url_var,
                fixed_base_url: None,
            },
            &mut owners,
        );
    }

    for owner in codex_relay_env_owners(home, env) {
        claim(owner, &mut owners);
    }

    for agent in &cli_agents {
        if ENV_SKIP_CLI_AGENTS.contains(&agent.name) {
            continue;
        }
        let Some(config) = cli_env_config(agent.name) else {
            continue;
        };
        claim(
            EnvOwner {
                var: config.api_key_env_var.clone(),
                agent: agent.name.to_string(),
                auth_method: "api_key",
                base_url_var: config.base_url_env_var.clone(),
                fixed_base_url: None,
            },
            &mut owners,
        );
    }

    owners
}

#[cfg(test)]
pub(crate) fn env_owner_for(var: &str) -> Option<EnvOwner> {
    env_owners().into_iter().find(|owner| owner.var == var)
}

/// `[model_providers.*]` entries in the Codex config that name an
/// `env_key` become Codex-owned env vars carrying the relay base URL.
fn codex_relay_env_owners(
    home: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<EnvOwner> {
    let Some(path) = codex_config_path_in(env("CODEX_HOME").as_deref(), home) else {
        return Vec::new();
    };
    let Some(content) = read_if_present(&path) else {
        return Vec::new();
    };
    parse_codex_model_providers(&content)
        .into_iter()
        .filter_map(|provider| {
            let var = provider.env_key?;
            Some(EnvOwner {
                var,
                agent: "codex".into(),
                auth_method: "api_key",
                base_url_var: None,
                fixed_base_url: provider.base_url,
            })
        })
        .collect()
}

/// Shell profiles scanned for `export VAR=...` lines, in load order.
pub(crate) fn shell_profile_paths(home: &Path) -> Vec<PathBuf> {
    [
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".bash_profile",
        ".bashrc",
        ".profile",
    ]
    .iter()
    .map(|name| home.join(name))
    .collect()
}

// ============================================
// Probe
// ============================================

struct Candidate {
    agent: String,
    auth_method: &'static str,
    kind: SuggestionSourceKind,
    label: String,
    path: Option<PathBuf>,
    reference: Option<String>,
    secret: Option<String>,
}

fn abbreviate_home(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if let Ok(rest) = path.strip_prefix(home) {
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

fn read_if_present(path: &Path) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(content) if !content.trim().is_empty() => Some(content),
        Ok(_) => None,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            tracing::debug!(
                path = %path.display(),
                error = %err,
                "auto_detect::suggestions: read failed; skipping"
            );
            None
        }
    }
}

pub(crate) fn probe_with(ctx: &ProbeContext<'_>, stored: &[ModelKey]) -> Vec<CredentialSuggestion> {
    let home = ctx.home.as_deref();
    let mut candidates: Vec<Candidate> = Vec::new();

    // Order matters: the first candidate for a given (agent, fingerprint)
    // wins, so richer sources come before env vars and shell profiles.
    probe_cc_switch(home, &mut candidates);
    probe_claude(ctx, home, &mut candidates);
    probe_claude_settings(ctx, home, &mut candidates);
    probe_codex(home, &mut candidates);
    probe_cursor(home, &mut candidates);
    probe_copilot(home, &mut candidates);
    probe_kiro(ctx, home, &mut candidates);
    probe_opencode(home, &mut candidates);
    probe_config_files(home, &mut candidates);
    probe_env(ctx, home, &mut candidates);


    let known = stored_fingerprints(stored);
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut out = Vec::new();

    for candidate in candidates {
        let fingerprint = candidate.secret.as_deref().map(secret_fingerprint);
        if let Some(fp) = &fingerprint {
            if !seen.insert((candidate.agent.clone(), fp.clone())) {
                continue;
            }
        }
        let already_imported = match &fingerprint {
            Some(fp) => known.contains(fp),
            None => stored_has_oauth_for(stored, &candidate.agent),
        };
        let id = match &candidate.reference {
            Some(reference) => format!(
                "{}:{}:{}:{}",
                candidate.agent,
                candidate.kind.as_str(),
                candidate.label,
                reference
            ),
            None => format!(
                "{}:{}:{}",
                candidate.agent,
                candidate.kind.as_str(),
                candidate.label
            ),
        };
        out.push(CredentialSuggestion {
            id,
            agent_type: candidate.agent,
            auth_method: candidate.auth_method.to_string(),
            source_kind: candidate.kind,
            source_label: candidate.label,
            source_path: candidate.path.map(|path| path.display().to_string()),
            source_ref: candidate.reference,
            fingerprint,
            already_imported,
        });
    }

    out
}

fn probe_claude(ctx: &ProbeContext<'_>, home: Option<&Path>, out: &mut Vec<Candidate>) {
    let config_dir = (ctx.env)("CLAUDE_CONFIG_DIR");
    for path in claude_credentials_paths_in(config_dir.as_deref(), home) {
        let Some(json) = read_if_present(&path) else {
            continue;
        };
        if let Some(token) = oauth_access_token_from_credentials_json(&json) {
            out.push(Candidate {
                agent: "claude_code".into(),
                auth_method: "oauth",
                kind: SuggestionSourceKind::OauthStore,
                label: abbreviate_home(&path, home),
                path: Some(path),
                reference: None,
                secret: Some(token),
            });
        }
    }

    let mut config_dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = config_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        config_dirs.push(PathBuf::from(dir));
    }
    if let Some(home) = home {
        config_dirs.push(home.join(".claude"));
    }
    let account = claude_keychain_account();
    for service in claude_keychain_service_candidates(&config_dirs) {
        if (ctx.keychain_item_exists)(&service, Some(&account)) {
            out.push(Candidate {
                agent: "claude_code".into(),
                auth_method: "oauth",
                kind: SuggestionSourceKind::Keychain,
                label: service,
                path: None,
                reference: None,
                secret: None,
            });
            break;
        }
    }
}

fn probe_codex(home: Option<&Path>, out: &mut Vec<Candidate>) {
    let Some(home) = home else { return };
    let path = home.join(".codex/auth.json");
    let Some(content) = read_if_present(&path) else {
        return;
    };
    let Ok(config) = serde_json::from_str::<core_types::providers::CodexCliAuthConfig>(&content)
    else {
        return;
    };
    let label = abbreviate_home(&path, Some(home));

    if let Some(token) = config
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.access_token.as_deref())
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        out.push(Candidate {
            agent: "codex".into(),
            auth_method: "oauth",
            kind: SuggestionSourceKind::OauthStore,
            label: label.clone(),
            path: Some(path.clone()),
            reference: None,
            secret: Some(token.to_string()),
        });
    }
    if let Some(api_key) = config
        .openai_api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        out.push(Candidate {
            agent: "codex".into(),
            auth_method: "api_key",
            kind: SuggestionSourceKind::ConfigFile,
            label,
            path: Some(path),
            reference: Some("OPENAI_API_KEY".into()),
            secret: Some(api_key.to_string()),
        });
    }
}

fn probe_cursor(home: Option<&Path>, out: &mut Vec<Candidate>) {
    let Some(home) = home else { return };
    let path = cursor_state_db_path_in(home);
    if !path.exists() {
        return;
    }
    match read_cursor_access_token(&path) {
        Ok(Some(token)) => out.push(Candidate {
            agent: "cursor_cli".into(),
            auth_method: "oauth",
            kind: SuggestionSourceKind::StateDb,
            label: abbreviate_home(&path, Some(home)),
            path: Some(path),
            reference: None,
            secret: Some(token),
        }),
        Ok(None) => {}
        Err(err) => {
            tracing::debug!(error = %err, "auto_detect::suggestions: cursor state db unreadable");
        }
    }
}

fn probe_copilot(home: Option<&Path>, out: &mut Vec<Candidate>) {
    let Some(home) = home else { return };
    let path = home.join(".config/gh/hosts.yml");
    let Some(content) = read_if_present(&path) else {
        return;
    };
    if let Some(token) = extract_github_token_from_config(&content) {
        out.push(Candidate {
            agent: "copilot".into(),
            auth_method: "oauth",
            kind: SuggestionSourceKind::OauthStore,
            label: abbreviate_home(&path, Some(home)),
            path: Some(path),
            reference: None,
            secret: Some(token),
        });
    }
}

/// Kiro state stores whose presence means `kiro-cli login` has run.
pub(crate) fn kiro_state_db_candidates(ctx: &ProbeContext<'_>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join("Library/Application Support/kiro-cli/data.sqlite3"));
        if let Some(xdg) = (ctx.env)("XDG_DATA_HOME") {
            paths.push(PathBuf::from(xdg).join("kiro-cli/data.sqlite3"));
        }
        paths.push(home.join(".local/share/kiro-cli/data.sqlite3"));
    }
    if let Some(appdata) = (ctx.env)("APPDATA") {
        paths.push(PathBuf::from(appdata).join("kiro-cli/data.sqlite3"));
    }
    paths
}

fn probe_kiro(ctx: &ProbeContext<'_>, home: Option<&Path>, out: &mut Vec<Candidate>) {
    if (ctx.keychain_item_exists)(KIRO_TOKEN_KEY, None) {
        out.push(Candidate {
            agent: "kiro".into(),
            auth_method: "oauth",
            kind: SuggestionSourceKind::Keychain,
            label: KIRO_TOKEN_KEY.to_string(),
            path: None,
            reference: None,
            secret: None,
        });
        return;
    }
    if let Some(path) = kiro_state_db_candidates(ctx, home)
        .into_iter()
        .find(|path| path.exists())
    {
        out.push(Candidate {
            agent: "kiro".into(),
            auth_method: "oauth",
            kind: SuggestionSourceKind::StateDb,
            label: abbreviate_home(&path, home),
            path: Some(path),
            reference: None,
            secret: None,
        });
    }
}

#[derive(Debug, Deserialize)]
struct OpenCodeAuthEntry {
    #[serde(rename = "type")]
    auth_type: String,
    key: Option<String>,
}

pub(crate) const OPENCODE_AUTH_RELATIVE: &str = ".local/share/opencode/auth.json";

/// OpenCode `auth.json` provider id → (vault agent, implied base URL).
/// OpenCode's own Zen/Go keys stay on the `opencode` agent (validated via
/// its detector); third-party keys land on the matching API provider so
/// every compatible CLI can reuse them.
pub(crate) fn opencode_provider_target(provider_id: &str) -> Option<(&'static str, Option<&'static str>)> {
    Some(match provider_id {
        "opencode" => ("opencode", Some(OPENCODE_ZEN_BASE_URL)),
        "opencode-go" => ("opencode", Some(OPENCODE_GO_BASE_URL)),
        "anthropic" => ("anthropic_api", None),
        "openai" => ("openai_api", None),
        "deepseek" => ("deepseek_api", None),
        "google" => ("gemini_api", None),
        "openrouter" => ("openrouter_api", None),
        "groq" => ("groq_api", None),
        "xai" => ("xai_api", None),
        "zhipuai" | "zhipu" | "zai" => ("zhipu_api", None),
        "moonshotai" | "moonshot" => ("moonshot_api", None),
        "alibaba" | "dashscope" => ("dashscope_api", None),
        "minimax" => ("minimax_api", None),
        "siliconflow" => ("siliconflow_api", None),
        "modelscope" => ("modelscope_api", None),
        _ => return None,
    })
}

fn probe_opencode(home: Option<&Path>, out: &mut Vec<Candidate>) {
    let Some(home) = home else { return };
    let path = home.join(OPENCODE_AUTH_RELATIVE);
    let Some(content) = read_if_present(&path) else {
        return;
    };
    let Ok(entries) =
        serde_json::from_str::<std::collections::BTreeMap<String, OpenCodeAuthEntry>>(&content)
    else {
        return;
    };
    for (provider_id, entry) in entries {
        if entry.auth_type != "api" {
            continue;
        }
        let Some((agent, _)) = opencode_provider_target(&provider_id) else {
            continue;
        };
        let Some(key) = entry.key.filter(|key| !key.trim().is_empty()) else {
            continue;
        };
        out.push(Candidate {
            agent: agent.into(),
            auth_method: "api_key",
            kind: SuggestionSourceKind::ConfigFile,
            label: abbreviate_home(&path, Some(home)),
            path: Some(path.clone()),
            reference: Some(provider_id),
            secret: Some(key),
        });
    }
}

/// cc-switch profiles. Listed before the Claude settings file because
/// cc-switch writes its current profile into that file too — same token,
/// and the cc-switch row carries the human-readable profile name.
fn probe_cc_switch(home: Option<&Path>, out: &mut Vec<Candidate>) {
    let Some(home) = home else { return };
    let path = cc_switch_db_path_in(home);
    if !path.exists() {
        return;
    }
    let creds = match read_cc_switch_credentials(&path) {
        Ok(creds) => creds,
        Err(err) => {
            tracing::debug!(error = %err, "auto_detect::suggestions: cc-switch db unreadable");
            return;
        }
    };
    for cred in creds {
        out.push(Candidate {
            agent: cred.agent.into(),
            auth_method: "api_key",
            kind: SuggestionSourceKind::CcSwitch,
            label: cred.name.clone(),
            path: Some(path.clone()),
            reference: Some(cred.reference()),
            secret: Some(cred.secret),
        });
    }
}

/// `settings.json` candidates whose `env` block may carry provider keys:
/// `$CLAUDE_CONFIG_DIR/settings.json`, `~/.claude/settings.json`,
/// `~/.claude/settings.local.json`. This is where cc-switch and every relay
/// guide put `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`.
pub(crate) fn claude_settings_paths_in(config_dir: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(dir) = config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        paths.push(PathBuf::from(dir).join("settings.json"));
        paths.push(PathBuf::from(dir).join("settings.local.json"));
    }
    if let Some(home) = home {
        for name in ["settings.json", "settings.local.json"] {
            let path = home.join(".claude").join(name);
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// Non-empty string entries of a settings file's `env` object.
fn settings_env_entries(content: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else {
        return Vec::new();
    };
    let Some(env) = value.get("env").and_then(|e| e.as_object()) else {
        return Vec::new();
    };
    env.iter()
        .filter_map(|(k, v)| {
            let v = v.as_str()?.trim();
            (!v.is_empty()).then(|| (k.clone(), v.to_string()))
        })
        .collect()
}

fn probe_claude_settings(ctx: &ProbeContext<'_>, home: Option<&Path>, out: &mut Vec<Candidate>) {
    let owners = env_owners_in(home, ctx.env);
    let config_dir = (ctx.env)("CLAUDE_CONFIG_DIR");
    for path in claude_settings_paths_in(config_dir.as_deref(), home) {
        let Some(content) = read_if_present(&path) else {
            continue;
        };
        for (var, value) in settings_env_entries(&content) {
            let Some(owner) = owners.iter().find(|owner| owner.var == var) else {
                continue;
            };
            out.push(Candidate {
                agent: owner.agent.clone(),
                auth_method: owner.auth_method,
                kind: SuggestionSourceKind::ConfigFile,
                label: abbreviate_home(&path, home),
                path: Some(path.clone()),
                reference: Some(var),
                secret: Some(value),
            });
        }
    }
}

/// Plain JSON config files carrying a provider API key. Attributed to the
/// API provider (not a CLI) because that is the vault entry every
/// compatible CLI can reuse.
fn probe_config_files(home: Option<&Path>, out: &mut Vec<Candidate>) {
    let Some(home) = home else { return };

    for path in claude_config_paths_in(home) {
        let Some(content) = read_if_present(&path) else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<ClaudeConfig>(&content) else {
            continue;
        };
        if let Some(key) = config.api_key.filter(|key| !key.trim().is_empty()) {
            out.push(Candidate {
                agent: "anthropic_api".into(),
                auth_method: "api_key",
                kind: SuggestionSourceKind::ConfigFile,
                label: abbreviate_home(&path, Some(home)),
                path: Some(path),
                reference: None,
                secret: Some(key),
            });
        }
    }

    for path in openai_config_paths_in(home) {
        let Some(content) = read_if_present(&path) else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<OpenAIConfig>(&content) else {
            continue;
        };
        if let Some(key) = config.api_key.filter(|key| !key.trim().is_empty()) {
            out.push(Candidate {
                agent: "openai_api".into(),
                auth_method: "api_key",
                kind: SuggestionSourceKind::ConfigFile,
                label: abbreviate_home(&path, Some(home)),
                path: Some(path),
                reference: None,
                secret: Some(key),
            });
        }
    }
}

fn probe_env(ctx: &ProbeContext<'_>, home: Option<&Path>, out: &mut Vec<Candidate>) {
    let owners = env_owners_in(home, ctx.env);

    for owner in &owners {
        if let Some(value) = (ctx.env)(&owner.var) {
            out.push(Candidate {
                agent: owner.agent.clone(),
                auth_method: owner.auth_method,
                kind: SuggestionSourceKind::Env,
                label: owner.var.clone(),
                path: None,
                reference: None,
                secret: Some(value),
            });
        }
    }

    let Some(home) = home else { return };
    for profile in shell_profile_paths(home) {
        let Some(content) = read_if_present(&profile) else {
            continue;
        };
        for owner in &owners {
            if let Some(value) = extract_export_value(&content, &owner.var) {
                out.push(Candidate {
                    agent: owner.agent.clone(),
                    auth_method: owner.auth_method,
                    kind: SuggestionSourceKind::ShellProfile,
                    label: owner.var.clone(),
                    path: Some(profile.clone()),
                    reference: None,
                    secret: Some(value),
                });
            }
        }
    }
}

// ============================================
// Re-resolution (import side)
// ============================================

/// Re-read the secret behind an env / shell-profile / plain-config
/// suggestion at import time, plus its companion base URL. Returns `None`
/// when the source has disappeared since the probe.
pub fn resolve_generic_secret(
    suggestion: &CredentialSuggestion,
) -> Option<(String, Option<String>)> {
    let ctx = ProbeContext {
        home: get_home_dir(),
        env: &process_env,
        keychain_item_exists: &keychain_item_exists,
    };
    resolve_generic_secret_with(&ctx, suggestion)
}

pub(crate) fn resolve_generic_secret_with(
    ctx: &ProbeContext<'_>,
    suggestion: &CredentialSuggestion,
) -> Option<(String, Option<String>)> {
    match suggestion.source_kind {
        SuggestionSourceKind::Env => {
            let secret = (ctx.env)(&suggestion.source_label)?;
            let owner = env_owner_in(ctx, &suggestion.source_label);
            let base_url = owner.as_ref().and_then(|owner| {
                owner
                    .fixed_base_url
                    .clone()
                    .or_else(|| owner.base_url_var.as_deref().and_then(|var| (ctx.env)(var)))
            });
            Some((secret, base_url))
        }
        SuggestionSourceKind::ShellProfile => {
            let path = PathBuf::from(suggestion.source_path.as_deref()?);
            let content = read_if_present(&path)?;
            let secret = extract_export_value(&content, &suggestion.source_label)?;
            let owner = env_owner_in(ctx, &suggestion.source_label);
            let base_url = owner.as_ref().and_then(|owner| {
                owner.fixed_base_url.clone().or_else(|| {
                    owner
                        .base_url_var
                        .as_deref()
                        .and_then(|var| extract_export_value(&content, var))
                })
            });
            Some((secret, base_url))
        }
        SuggestionSourceKind::CcSwitch => {
            let path = PathBuf::from(suggestion.source_path.as_deref()?);
            let reference = suggestion.source_ref.as_deref()?;
            let cred = read_cc_switch_credentials(&path)
                .ok()?
                .into_iter()
                .find(|cred| cred.reference() == reference)?;
            Some((cred.secret, cred.base_url))
        }
        SuggestionSourceKind::ConfigFile => {
            let path = PathBuf::from(suggestion.source_path.as_deref()?);
            let content = read_if_present(&path)?;
            let value: serde_json::Value = serde_json::from_str(&content).ok()?;
            if let Some(reference) = suggestion.source_ref.as_deref() {
                // Settings file: `env.<VAR>` plus the owner's companion URL var.
                if let Some(env) = value.get("env").and_then(|e| e.as_object()) {
                    let secret = env
                        .get(reference)
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?
                        .to_string();
                    let owner = env_owner_in(ctx, reference);
                    let base_url = owner.as_ref().and_then(|owner| {
                        owner.fixed_base_url.clone().or_else(|| {
                            owner.base_url_var.as_deref().and_then(|var| {
                                env.get(var)
                                    .and_then(|v| v.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_string)
                            })
                        })
                    });
                    return Some((secret, base_url));
                }
                // OpenCode auth file: `<provider>.key`.
                if let Some(entry) = value.get(reference).and_then(|e| e.as_object()) {
                    let secret = entry
                        .get("key")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?
                        .to_string();
                    let base_url = opencode_provider_target(reference)
                        .and_then(|(_, url)| url)
                        .map(str::to_string);
                    return Some((secret, base_url));
                }
                return None;
            }
            let secret = ["apiKey", "api_key"]
                .iter()
                .find_map(|field| value.get(field).and_then(|v| v.as_str()))
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let base_url = ["baseUrl", "base_url"]
                .iter()
                .find_map(|field| value.get(field).and_then(|v| v.as_str()))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some((secret, base_url))
        }
        SuggestionSourceKind::OauthStore
        | SuggestionSourceKind::Keychain
        | SuggestionSourceKind::StateDb => None,
    }
}

fn env_owner_in(ctx: &ProbeContext<'_>, var: &str) -> Option<EnvOwner> {
    env_owners_in(ctx.home.as_deref(), ctx.env)
        .into_iter()
        .find(|owner| owner.var == var)
}

/// Whether the agent's full detector (`auto_detect_key`) owns this source,
/// in which case import must go through it to pick up refresh tokens,
/// account metadata and validation.
pub fn resolves_via_detector(suggestion: &CredentialSuggestion) -> bool {
    match suggestion.source_kind {
        SuggestionSourceKind::OauthStore
        | SuggestionSourceKind::Keychain
        | SuggestionSourceKind::StateDb => true,
        // Only the files the agent's own detector reads: Codex's auth.json
        // key and OpenCode's own Zen/Go keys. Settings-file env entries and
        // third-party OpenCode providers resolve generically.
        SuggestionSourceKind::ConfigFile => matches!(
            (
                suggestion.agent_type.as_str(),
                suggestion.source_ref.as_deref(),
            ),
            ("codex", Some("OPENAI_API_KEY")) | ("opencode", Some("opencode" | "opencode-go"))
        ),
        SuggestionSourceKind::Env
        | SuggestionSourceKind::ShellProfile
        | SuggestionSourceKind::CcSwitch => false,
    }
}

/// Whether a `ModelType` exists for the suggestion's agent string.
pub fn suggestion_model_type(suggestion: &CredentialSuggestion) -> Option<ModelType> {
    ModelType::from_str(&suggestion.agent_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    type EnvFn<'a> = Box<dyn Fn(&str) -> Option<String> + 'a>;
    type KeychainFn<'a> = Box<dyn Fn(&str, Option<&str>) -> bool + 'a>;
    /// Owned pieces a test needs to assemble a `ProbeContext`.
    type TestProbe<'a> = (PathBuf, EnvFn<'a>, KeychainFn<'a>);

    fn ctx<'a>(
        home: &Path,
        env: &'a HashMap<&'static str, &'static str>,
        keychain: &'a HashSet<String>,
    ) -> TestProbe<'a> {
        let env_fn = move |name: &str| env.get(name).map(|v| v.to_string());
        let keychain_fn = move |service: &str, _account: Option<&str>| keychain.contains(service);
        (home.to_path_buf(), Box::new(env_fn), Box::new(keychain_fn))
    }

    fn run(
        home: &Path,
        env: &HashMap<&'static str, &'static str>,
        keychain: &HashSet<String>,
        stored: &[ModelKey],
    ) -> Vec<CredentialSuggestion> {
        let (home, env_fn, keychain_fn) = ctx(home, env, keychain);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        probe_with(&ctx, stored)
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    fn stored_key(agent: ModelType, api_key: Option<&str>, session_token: Option<&str>) -> ModelKey {
        let mut key = ModelKey::new(agent);
        key.api_key = api_key.map(str::to_string);
        key.session_token = session_token.map(str::to_string);
        key.auth_method = if session_token.is_some() {
            AuthMethod::Oauth
        } else {
            AuthMethod::ApiKey
        };
        key
    }

    #[test]
    fn generic_provider_env_vars_belong_to_the_api_provider_not_a_cli() {
        let dir = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            ("ANTHROPIC_API_KEY", "sk-ant-api03-test"),
            ("OPENAI_API_KEY", "sk-proj-test"),
            ("DEEPSEEK_API_KEY", "sk-deepseek-test"),
        ]);
        let out = run(dir.path(), &env, &HashSet::new(), &[]);

        let agents: Vec<&str> = out.iter().map(|s| s.agent_type.as_str()).collect();
        assert!(agents.contains(&"anthropic_api"), "{agents:?}");
        assert!(agents.contains(&"openai_api"), "{agents:?}");
        assert!(agents.contains(&"deepseek_api"), "{agents:?}");
        assert!(!agents.contains(&"cline"), "cline must not claim ANTHROPIC_API_KEY");
        assert!(!agents.contains(&"aider"), "aider must not claim OPENAI_API_KEY");
        assert!(out.iter().all(|s| s.fingerprint.is_some()));
        assert!(out
            .iter()
            .all(|s| s.source_kind == SuggestionSourceKind::Env));
    }

    #[test]
    fn bespoke_cli_env_vars_are_suggested_for_that_cli() {
        let dir = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            ("OPENCODE_GO_API_KEY", "opencode-go-test"),
            ("GH_TOKEN", "gho_test"),
            ("CURSOR_API_KEY", "key_cursor_should_be_skipped_because_session_is_required"),
        ]);
        let out = run(dir.path(), &env, &HashSet::new(), &[]);

        let opencode = out
            .iter()
            .find(|s| s.agent_type == "opencode")
            .expect("opencode suggestion");
        assert_eq!(opencode.source_label, "OPENCODE_GO_API_KEY");
        assert!(out.iter().any(|s| s.agent_type == "copilot"));
        assert!(!out.iter().any(|s| s.agent_type == "cursor_cli"));
    }

    #[test]
    fn shell_profile_exports_are_found_and_deduped_against_env() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".zshrc"),
            "# keys\nexport ANTHROPIC_API_KEY=\"sk-ant-api03-same\"\nexport XAI_API_KEY='xai-only-in-profile'\n",
        );
        let env = HashMap::from([("ANTHROPIC_API_KEY", "sk-ant-api03-same")]);
        let out = run(dir.path(), &env, &HashSet::new(), &[]);

        let anthropic: Vec<_> = out
            .iter()
            .filter(|s| s.agent_type == "anthropic_api")
            .collect();
        assert_eq!(anthropic.len(), 1, "same secret in env + profile is one row");
        assert_eq!(anthropic[0].source_kind, SuggestionSourceKind::Env);

        let xai = out
            .iter()
            .find(|s| s.agent_type == "xai_api")
            .expect("xai from profile");
        assert_eq!(xai.source_kind, SuggestionSourceKind::ShellProfile);
        assert_eq!(xai.source_label, "XAI_API_KEY");
        assert_eq!(
            xai.source_path.as_deref(),
            Some(dir.path().join(".zshrc").to_str().unwrap())
        );
    }

    #[test]
    fn already_imported_matches_stored_secrets_by_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let env = HashMap::from([("ANTHROPIC_API_KEY", "sk-ant-api03-stored")]);
        let stored = vec![stored_key(
            ModelType::ClaudeCode,
            Some("sk-ant-api03-stored"),
            None,
        )];
        let out = run(dir.path(), &env, &HashSet::new(), &stored);

        let anthropic = out
            .iter()
            .find(|s| s.agent_type == "anthropic_api")
            .unwrap();
        assert!(
            anthropic.already_imported,
            "secret stored under a compatible CLI still counts as imported"
        );
        assert_eq!(
            anthropic.fingerprint.as_deref(),
            Some(secret_fingerprint("sk-ant-api03-stored").as_str())
        );
    }

    #[test]
    fn codex_auth_json_yields_oauth_and_api_key_rows() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".codex/auth.json"),
            r#"{"OPENAI_API_KEY":"sk-codex-file","tokens":{"access_token":"eyJ.codex.access","refresh_token":"rt","id_token":"it"}}"#,
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);

        let codex: Vec<_> = out.iter().filter(|s| s.agent_type == "codex").collect();
        assert_eq!(codex.len(), 2, "{codex:?}");
        let oauth = codex.iter().find(|s| s.auth_method == "oauth").unwrap();
        assert_eq!(oauth.source_kind, SuggestionSourceKind::OauthStore);
        assert_eq!(oauth.source_label, "~/.codex/auth.json");
        let api = codex.iter().find(|s| s.auth_method == "api_key").unwrap();
        assert_eq!(api.source_kind, SuggestionSourceKind::ConfigFile);
        assert_eq!(api.source_label, "~/.codex/auth.json");
        assert_eq!(api.source_ref.as_deref(), Some("OPENAI_API_KEY"));
        assert!(resolves_via_detector(oauth));
        assert!(resolves_via_detector(api));
    }

    #[test]
    fn claude_credentials_file_and_keychain_are_oauth_suggestions() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".claude/.credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-file","refreshToken":"r","expiresAt":1}}"#,
        );
        let keychain = HashSet::from(["Claude Code-credentials".to_string()]);
        let stored = vec![stored_key(
            ModelType::ClaudeCode,
            None,
            Some("sk-ant-oat01-other-session"),
        )];
        let out = run(dir.path(), &HashMap::new(), &keychain, &stored);

        let claude: Vec<_> = out
            .iter()
            .filter(|s| s.agent_type == "claude_code")
            .collect();
        let file = claude
            .iter()
            .find(|s| s.source_kind == SuggestionSourceKind::OauthStore)
            .expect("file row");
        assert!(file.fingerprint.is_some());
        assert!(!file.already_imported, "different token than the stored one");

        let keychain_row = claude
            .iter()
            .find(|s| s.source_kind == SuggestionSourceKind::Keychain)
            .expect("keychain row");
        assert!(keychain_row.fingerprint.is_none(), "keychain is never read");
        assert!(
            keychain_row.already_imported,
            "fingerprint-less OAuth rows fall back to 'vault has OAuth for this agent'"
        );
    }

    #[test]
    fn opencode_and_gh_cli_stores_are_found() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".local/share/opencode/auth.json"),
            r#"{"opencode-go":{"type":"api","key":"go-key"},"anthropic":{"type":"api","key":"anthropic-key"},"unknownprov":{"type":"api","key":"x"},"github-copilot":{"type":"oauth","refresh":"r"}}"#,
        );
        write(
            &dir.path().join(".config/gh/hosts.yml"),
            "github.com:\n    oauth_token: gho_from_gh\n    user: someone\n",
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);

        let opencode: Vec<_> = out.iter().filter(|s| s.agent_type == "opencode").collect();
        assert_eq!(opencode.len(), 1);
        assert_eq!(opencode[0].source_ref.as_deref(), Some("opencode-go"));
        assert!(resolves_via_detector(opencode[0]));
        let anthropic = out
            .iter()
            .find(|s| s.agent_type == "anthropic_api")
            .expect("third-party opencode entries map to the API provider");
        assert_eq!(anthropic.source_ref.as_deref(), Some("anthropic"));
        assert!(!resolves_via_detector(anthropic));

        let copilot = out.iter().find(|s| s.agent_type == "copilot").unwrap();
        assert_eq!(copilot.source_kind, SuggestionSourceKind::OauthStore);
        assert_eq!(
            copilot.fingerprint.as_deref(),
            Some(secret_fingerprint("gho_from_gh").as_str())
        );
    }

    #[test]
    fn plain_config_files_go_to_the_api_provider_and_resolve_generically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".config/anthropic/config.json");
        write(
            &path,
            r#"{"apiKey":"sk-ant-api03-cfg","baseUrl":"https://relay.example/v1"}"#,
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);
        let row = out
            .iter()
            .find(|s| s.agent_type == "anthropic_api")
            .expect("anthropic row");
        assert_eq!(row.source_kind, SuggestionSourceKind::ConfigFile);
        assert!(!resolves_via_detector(row));

        let empty_env = HashMap::new();
        let empty_keychain = HashSet::new();
        let (home, env_fn, keychain_fn) = ctx(dir.path(), &empty_env, &empty_keychain);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        let (secret, base_url) = resolve_generic_secret_with(&ctx, row).unwrap();
        assert_eq!(secret, "sk-ant-api03-cfg");
        assert_eq!(base_url.as_deref(), Some("https://relay.example/v1"));
    }

    #[test]
    fn shell_profile_resolution_picks_up_companion_base_url() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".bashrc"),
            "export ANTHROPIC_API_KEY=sk-ant-api03-profile\nexport ANTHROPIC_BASE_URL=https://proxy.example\n",
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);
        let row = out.iter().find(|s| s.agent_type == "anthropic_api").unwrap();

        let empty_env = HashMap::new();
        let empty_keychain = HashSet::new();
        let (home, env_fn, keychain_fn) = ctx(dir.path(), &empty_env, &empty_keychain);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        let (secret, base_url) = resolve_generic_secret_with(&ctx, row).unwrap();
        assert_eq!(secret, "sk-ant-api03-profile");
        assert_eq!(base_url.as_deref(), Some("https://proxy.example"));
    }

    #[test]
    fn empty_machine_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn env_owner_table_has_no_duplicate_vars_and_skips_unusable_providers() {
        let owners = env_owners();
        let mut vars = HashSet::new();
        for owner in &owners {
            assert!(vars.insert(owner.var.clone()), "duplicate {}", owner.var);
            assert!(!owner.var.starts_with("AWS_"));
            assert!(!ENV_SKIP_PROVIDERS.contains(&owner.agent.as_str()));
            assert!(!ENV_SKIP_CLI_AGENTS.contains(&owner.agent.as_str()));
        }
        assert_eq!(
            env_owner_for("ANTHROPIC_API_KEY").map(|o| o.agent),
            Some("anthropic_api".to_string())
        );
        assert_eq!(
            env_owner_for("OPENCODE_API_KEY").and_then(|o| o.fixed_base_url),
            Some(OPENCODE_ZEN_BASE_URL.to_string())
        );
        assert_eq!(
            env_owner_for("ANTHROPIC_API_KEY").and_then(|o| o.base_url_var),
            Some("ANTHROPIC_BASE_URL".to_string()),
            "provider rows borrow the companion base-URL var from the CLI table"
        );
        assert_eq!(
            env_owner_for("DEEPSEEK_API_KEY").and_then(|o| o.base_url_var),
            Some("DEEPSEEK_BASE_URL".to_string()),
            "falls back to the <PREFIX>_BASE_URL convention"
        );
    }

    fn probe_ctx<'a>(
        home: &Path,
        env: &'a HashMap<&'static str, &'static str>,
    ) -> TestProbe<'a> {
        let env_fn = move |name: &str| env.get(name).map(|v| v.to_string());
        let keychain_fn = |_: &str, _: Option<&str>| false;
        (home.to_path_buf(), Box::new(env_fn), Box::new(keychain_fn))
    }

    #[test]
    fn cc_switch_profiles_become_named_suggestions() {
        let dir = tempfile::tempdir().unwrap();
        cc_switch::fixtures::write_db(
            &cc_switch::cc_switch_db_path_in(dir.path()),
            &cc_switch::fixtures::sample_rows(),
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);

        let rows: Vec<_> = out
            .iter()
            .filter(|s| s.source_kind == SuggestionSourceKind::CcSwitch)
            .collect();
        let mut labels: Vec<&str> = rows.iter().map(|s| s.source_label.as_str()).collect();
        labels.sort();
        assert_eq!(labels, vec!["Codex Relay", "Gemini Key", "Longcat"], "{out:?}");

        let longcat = rows.iter().find(|s| s.source_label == "Longcat").unwrap();
        assert_eq!(longcat.agent_type, "claude_code");
        assert_eq!(longcat.source_ref.as_deref(), Some("claude:longcat"));
        assert!(!resolves_via_detector(longcat));

        let empty_env = HashMap::new();
        let (home, env_fn, keychain_fn) = probe_ctx(dir.path(), &empty_env);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        let (secret, base_url) = resolve_generic_secret_with(&ctx, longcat).unwrap();
        assert_eq!(secret, "ak_longcat_relay_token_0001");
        assert_eq!(base_url.as_deref(), Some("https://api.longcat.chat/anthropic"));

        let codex = rows.iter().find(|s| s.source_label == "Codex Relay").unwrap();
        let (secret, base_url) = resolve_generic_secret_with(&ctx, codex).unwrap();
        assert_eq!(secret, "sk-relay-codex-0001");
        assert_eq!(base_url.as_deref(), Some("https://relay.example/v1"));
    }

    #[test]
    fn cc_switch_current_profile_dedupes_against_claude_settings() {
        let dir = tempfile::tempdir().unwrap();
        cc_switch::fixtures::write_db(
            &cc_switch::cc_switch_db_path_in(dir.path()),
            &cc_switch::fixtures::sample_rows(),
        );
        // cc-switch writes the active profile into settings.json.
        write(
            &dir.path().join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"ak_longcat_relay_token_0001","ANTHROPIC_BASE_URL":"https://api.longcat.chat/anthropic"},"hooks":{}}"#,
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);
        let claude: Vec<_> = out.iter().filter(|s| s.agent_type == "claude_code").collect();
        assert_eq!(claude.len(), 1, "same token appears once: {claude:?}");
        assert_eq!(claude[0].source_kind, SuggestionSourceKind::CcSwitch);
        assert_eq!(claude[0].source_label, "Longcat");
    }

    #[test]
    fn claude_settings_env_block_is_found_and_resolves_with_base_url() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"relay-token-1","ANTHROPIC_BASE_URL":"https://relay.example/anthropic","CLAUDE_CODE_MAX_OUTPUT_TOKENS":"4096"},"hooks":{}}"#,
        );
        write(
            &dir.path().join(".claude/settings.local.json"),
            r#"{"env":{"OPENAI_API_KEY":"sk-local-openai"}}"#,
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);

        let claude = out
            .iter()
            .find(|s| s.agent_type == "claude_code")
            .expect("ANTHROPIC_AUTH_TOKEN → claude_code");
        assert_eq!(claude.source_kind, SuggestionSourceKind::ConfigFile);
        assert_eq!(claude.source_label, "~/.claude/settings.json");
        assert_eq!(claude.source_ref.as_deref(), Some("ANTHROPIC_AUTH_TOKEN"));
        assert!(!resolves_via_detector(claude));

        let openai = out
            .iter()
            .find(|s| s.agent_type == "openai_api")
            .expect("OPENAI_API_KEY in settings.local.json → openai_api");
        assert_eq!(openai.source_label, "~/.claude/settings.local.json");

        let empty_env = HashMap::new();
        let (home, env_fn, keychain_fn) = probe_ctx(dir.path(), &empty_env);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        let (secret, base_url) = resolve_generic_secret_with(&ctx, claude).unwrap();
        assert_eq!(secret, "relay-token-1");
        assert_eq!(base_url.as_deref(), Some("https://relay.example/anthropic"));
    }

    #[test]
    fn codex_model_provider_env_key_is_owned_by_codex_with_relay_url() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".codex/config.toml"),
            "model_provider = \"myrelay\"\n[model_providers.myrelay]\nname = \"My Relay\"\nbase_url = \"https://relay.example/openai/v1\"\nenv_key = \"MYRELAY_API_KEY\"\n[model_providers.oai]\nbase_url = \"https://api.openai.com/v1\"\nenv_key = \"OPENAI_API_KEY\"\n[model_providers.longcat]\nbase_url = \"https://api.longcat.chat/openai/v1\"\nenv_key = \"LONGCAT_API_KEY\"\n",
        );
        let env = HashMap::from([
            ("MYRELAY_API_KEY", "ak_relay_env"),
            ("OPENAI_API_KEY", "sk-real-openai"),
            ("LONGCAT_API_KEY", "ak_longcat_env"),
        ]);
        let out = run(dir.path(), &env, &HashSet::new(), &[]);

        let codex = out
            .iter()
            .find(|s| s.agent_type == "codex" && s.source_label == "MYRELAY_API_KEY")
            .unwrap_or_else(|| panic!("bespoke relay var → codex: {out:?}"));
        assert_eq!(codex.source_kind, SuggestionSourceKind::Env);
        // A generic provider key stays with its provider even when Codex
        // config also references it.
        assert!(out
            .iter()
            .any(|s| s.agent_type == "openai_api" && s.source_label == "OPENAI_API_KEY"));
        assert!(!out
            .iter()
            .any(|s| s.agent_type == "codex" && s.source_label == "OPENAI_API_KEY"));
        // Same for a key ORGII has a first-class provider for (LongCat).
        assert!(out
            .iter()
            .any(|s| s.agent_type == "longcat_api" && s.source_label == "LONGCAT_API_KEY"));

        let (home, env_fn, keychain_fn) = probe_ctx(dir.path(), &env);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        let (secret, base_url) = resolve_generic_secret_with(&ctx, codex).unwrap();
        assert_eq!(secret, "ak_relay_env");
        assert_eq!(base_url.as_deref(), Some("https://relay.example/openai/v1"));
    }

    #[test]
    fn opencode_third_party_entry_resolves_generically() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(OPENCODE_AUTH_RELATIVE),
            r#"{"deepseek":{"type":"api","key":"sk-deepseek-from-opencode"}}"#,
        );
        let out = run(dir.path(), &HashMap::new(), &HashSet::new(), &[]);
        let row = out.iter().find(|s| s.agent_type == "deepseek_api").unwrap();
        assert_eq!(row.source_ref.as_deref(), Some("deepseek"));

        let empty_env = HashMap::new();
        let (home, env_fn, keychain_fn) = probe_ctx(dir.path(), &empty_env);
        let ctx = ProbeContext {
            home: Some(home),
            env: env_fn.as_ref(),
            keychain_item_exists: keychain_fn.as_ref(),
        };
        let (secret, base_url) = resolve_generic_secret_with(&ctx, row).unwrap();
        assert_eq!(secret, "sk-deepseek-from-opencode");
        assert_eq!(base_url, None);
    }
}

/// Read the selected source again at import time. Model and protocol are data,
/// never executable snippets. Fingerprint changes require a fresh selection.
pub(crate) fn cc_switch_connection_metadata(
    selection: &CredentialSuggestion,
) -> Result<Option<(String, String)>, String> {
    if selection.source_kind != SuggestionSourceKind::CcSwitch {
        return Ok(None);
    }
    let path = PathBuf::from(
        selection
            .source_path
            .as_deref()
            .ok_or("Missing cc-switch source")?,
    );
    let reference = selection
        .source_ref
        .as_deref()
        .ok_or("Missing cc-switch profile reference")?;
    let credential = read_cc_switch_credentials(&path)?
        .into_iter()
        .find(|entry| entry.reference() == reference)
        .ok_or("cc-switch profile no longer exists")?;
    if selection.agent_type != credential.agent
        || selection.fingerprint.as_deref() != Some(secret_fingerprint(&credential.secret).as_str())
    {
        return Err("cc-switch profile changed; refresh the import list".into());
    }
    let protocol = match credential.agent {
        "claude_code" => "anthropic",
        "codex" => "openai",
        _ => return Ok(None),
    };
    Ok(credential.model.map(|model| (model, protocol.to_string())))
}
