//! Unified rules management.
//!
//! Rules are markdown files in `.orgii/rules/` that provide conventions and
//! guidelines injected into agent system prompts.
//!
//! Three scopes:
//! - **Global**: `~/.orgii/rules/*.md` — apply to all workspace-scoped SDE sessions.
//! - **Workspace**: `{workspace}/.orgii/rules/*.md` — apply to one workspace.
//! - **Personal**: `~/.orgii/personal/rules/*.md` — apply only to OS Agent (channel sessions).
//!
//! The Personal scope prevents OS Agent-specific rules from polluting the
//! Global dir that is shared with workspace sessions.
//!
//! Per-rule agent scope and enabled state stored in `rules-config.json`.
//! Users can import rules from `.cursor/rules/*.mdc` (workspace-scoped only).

pub(crate) mod activation;
mod commands;
pub mod config;
pub(crate) mod metadata;

// Wildcard re-export needed: #[tauri::command] generates hidden __cmd__* items
pub use commands::*;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::warn;

use self::config::PoliciesConfig;

const APPROX_CHARS_PER_TOKEN: usize = 4;

/// Filename prefix for auto-generated behavior companion rules.
pub(crate) const BEHAVIOR_PREFIX: &str = "behavior--";

/// Policy source scope.
///
/// Reachable via the `policies_list` Tauri command's `PolicyInfo::source`
/// field, so it must stay `pub`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicySource {
    Global,
    Workspace,
    /// OS Agent personal workspace: `~/.orgii/personal/rules/`.
    /// Exclusive to channel (OS Agent) sessions.
    Personal,
}

/// Policy kind: manually created rule or auto-generated from an automation rule.
///
/// Reachable via `PolicyInfo::kind`; must stay `pub`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyKind {
    Rule,
    Behavior,
}

/// Metadata for a policy file. Returned by `policies_list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyInfo {
    pub name: String,
    pub path: PathBuf,
    pub source: PolicySource,
    pub enabled: bool,
    pub estimated_tokens: usize,
    pub kind: PolicyKind,
    /// Agent IDs this policy applies to. Empty = all agents.
    pub agents: Vec<String>,
    /// Repo paths the policy is restricted to. `None` = no restriction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_repo_paths: Option<Vec<String>>,
    /// Repo paths the policy must not apply to. `None` = no exclusions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_exclude_repo_paths: Option<Vec<String>>,
}

// ============================================
// Internal helpers
// ============================================

pub(crate) fn global_policies_dir() -> PathBuf {
    app_paths::orgii_root().join("rules")
}

fn workspace_policies_dir(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".orgii").join("rules")
}

/// OS Agent personal workspace rules: `~/.orgii/personal/rules/`.
///
/// Thin alias over `paths::personal_rules_dir()` kept here so existing
/// module-internal call sites don't need to change; external callers
/// should prefer the paths.rs helper directly.
pub(crate) fn personal_policies_dir() -> PathBuf {
    app_paths::personal_rules_dir()
}

pub(in crate::specialization) fn policies_dir_for_source(
    source: PolicySource,
    workspace_path: Option<&Path>,
) -> Result<PathBuf, String> {
    match source {
        PolicySource::Global => Ok(global_policies_dir()),
        PolicySource::Personal => Ok(personal_policies_dir()),
        PolicySource::Workspace => workspace_path
            .map(workspace_policies_dir)
            .ok_or_else(|| "Workspace path required for workspace-scoped policies".to_string()),
    }
}

pub(in crate::specialization) fn config_for_source(
    source: PolicySource,
    workspace_path: Option<&Path>,
) -> Result<PoliciesConfig, String> {
    match source {
        PolicySource::Global => PoliciesConfig::load_global(),
        PolicySource::Personal => {
            let path = app_paths::personal_rules_config();
            PoliciesConfig::load_from_path(&path)
        }
        PolicySource::Workspace => match workspace_path {
            Some(pp) => PoliciesConfig::load_for_workspace(pp),
            None => Ok(PoliciesConfig::default()),
        },
    }
}

pub(in crate::specialization) fn save_config_for_source(
    config: &PoliciesConfig,
    source: PolicySource,
    workspace_path: Option<&Path>,
) -> Result<(), String> {
    match source {
        PolicySource::Global => config.save_global(),
        PolicySource::Personal => {
            let path = app_paths::personal_rules_config();
            PoliciesConfig::save_to(&path, config)
        }
        PolicySource::Workspace => match workspace_path {
            Some(pp) => config.save_for_workspace(pp),
            None => Err("Workspace path required for workspace-scoped config".to_string()),
        },
    }
}

/// Scan a directory for `.md` / `.mdc` files, deduplicated by stem (preferring `.md`).
fn scan_md_files(dir: &Path) -> std::collections::HashMap<String, PathBuf> {
    use std::collections::HashMap;

    // ENOENT is the legitimate "no policies dir yet" case and
    // should stay silent. Any other I/O error means the user's
    // configured policies are silently invisible — the LLM
    // would then run without the rules the user expected.
    // Warn so the cause (permission flip / disk fault) surfaces.
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    dir = %dir.display(),
                    error = %err,
                    "policies::scan_md_files: read_dir failed; policies from this dir will be silently invisible to the LLM"
                );
            }
            return HashMap::new();
        }
    };

    let mut by_stem: HashMap<String, PathBuf> = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "md" && ext != "mdc" {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let prefer_current = match by_stem.get(&name) {
            None => true,
            Some(prev) => {
                let prev_ext = prev.extension().and_then(|e| e.to_str()).unwrap_or("");
                prev_ext == "mdc" && ext == "md"
            }
        };
        if prefer_current {
            by_stem.insert(name, path);
        }
    }
    by_stem
}

fn scan_policies_dir(dir: &Path, source: PolicySource, config: &PoliciesConfig) -> Vec<PolicyInfo> {
    scan_md_files(dir)
        .into_iter()
        .map(|(name, path)| {
            let content_len = std::fs::metadata(&path)
                .map(|m| m.len() as usize)
                .unwrap_or(0);
            let kind = if name.starts_with(BEHAVIOR_PREFIX) {
                PolicyKind::Behavior
            } else {
                PolicyKind::Rule
            };
            PolicyInfo {
                enabled: !config.is_disabled(&name),
                agents: config.agents_for(&name).to_vec(),
                scope_repo_paths: config.scope_repo_paths_for(&name),
                scope_exclude_repo_paths: config.scope_exclude_repo_paths_for(&name),
                name,
                path,
                source,
                estimated_tokens: content_len / APPROX_CHARS_PER_TOKEN,
                kind,
            }
        })
        .collect()
}

pub(super) fn list_policies_merged(
    workspace_path: Option<&Path>,
) -> Result<Vec<PolicyInfo>, String> {
    let global_config = PoliciesConfig::load_global()?;
    let mut all_policies =
        scan_policies_dir(&global_policies_dir(), PolicySource::Global, &global_config);

    if let Some(pp) = workspace_path {
        let workspace_config = PoliciesConfig::load_for_workspace(pp)?;
        let workspace_policies = scan_policies_dir(
            &workspace_policies_dir(pp),
            PolicySource::Workspace,
            &workspace_config,
        );
        all_policies.extend(workspace_policies);
    }

    // Personal rules are always listed regardless of workspace context — they
    // belong to OS Agent unconditionally and must always be manageable in the UI.
    let personal_config_path = app_paths::personal_rules_config();
    let personal_config = PoliciesConfig::load_from_path(&personal_config_path).unwrap_or_default();
    let personal_policies = scan_policies_dir(
        &personal_policies_dir(),
        PolicySource::Personal,
        &personal_config,
    );
    all_policies.extend(personal_policies);

    all_policies.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .reverse()
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(all_policies)
}

pub(crate) fn parse_source(source: &str) -> Result<PolicySource, String> {
    match source {
        "global" => Ok(PolicySource::Global),
        "workspace" => Ok(PolicySource::Workspace),
        "personal" => Ok(PolicySource::Personal),
        _ => Err(format!("Unknown policy source: {}", source)),
    }
}

#[cfg(test)]
mod tests;

// ============================================
// Agent-aware policy loading (for system prompt)
// ============================================

/// Load enabled policies filtered by agent ID and repo path for injection
/// into the system prompt.
///
/// `workspace_path` is also used as the repo identifier for `applies_to_repo`
/// — it's the same path the prompt pipeline would use as
/// `workspace.working_dir()`, which keeps the wizard's frontend repo list
/// (paths from `reposAtom`) and the runtime check on the same key.
pub fn load_enabled_policies(workspace_path: &Path, agent_id: &str) -> Vec<(String, String)> {
    let set = load_enabled_policy_set(workspace_path, agent_id);
    flatten_policy_set_for_prompt(set)
}

pub(crate) fn load_enabled_unconditional_policies_with_workspace_scope(
    workspace_path: &Path,
    agent_id: &str,
    load_workspace_resources: bool,
) -> Vec<(String, String)> {
    let set = load_enabled_policy_set_with_workspace_scope(
        workspace_path,
        agent_id,
        load_workspace_resources,
    );
    flatten_unconditional_for_prompt(set)
}

pub(crate) fn load_enabled_policy_set(
    workspace_path: &Path,
    agent_id: &str,
) -> metadata::PolicySet {
    load_enabled_policy_set_with_workspace_scope(workspace_path, agent_id, true)
}

pub(crate) fn load_enabled_policy_set_with_workspace_scope(
    workspace_path: &Path,
    agent_id: &str,
    load_workspace_resources: bool,
) -> metadata::PolicySet {
    let repo_path = workspace_path.to_string_lossy();
    let repo_path = Some(repo_path.as_ref());
    let mut merged = metadata::PolicySet::default();

    match PoliciesConfig::load_global() {
        Ok(global_config) => merge_policy_set(
            &mut merged,
            metadata::load_policy_set(&global_policies_dir(), &global_config, agent_id, repo_path),
        ),
        Err(err) => warn!(
            "[policies] Skipping global policies because config failed to load: {}",
            err
        ),
    }

    if load_workspace_resources {
        match PoliciesConfig::load_for_workspace(workspace_path) {
            Ok(workspace_config) => merge_policy_set(
                &mut merged,
                metadata::load_policy_set(
                    &workspace_policies_dir(workspace_path),
                    &workspace_config,
                    agent_id,
                    repo_path,
                ),
            ),
            Err(err) => warn!(
                "[policies] Skipping workspace policies because config failed to load: {}",
                err
            ),
        }
    }

    sort_policy_set(&mut merged);
    merged
}

/// Load enabled policies for OS Agent (channel sessions).
///
/// Only loads from `~/.orgii/personal/rules/` — NOT from global or workspace dirs.
/// This isolates OS Agent rules so they don't appear in workspace SDE sessions,
/// and prevents OS Agent from accidentally writing rules to the shared global dir.
///
/// Repo-scoped policies in the personal dir are not loaded (no repo context).
pub fn load_enabled_policies_for_os_agent(agent_id: &str) -> Vec<(String, String)> {
    let set = load_enabled_policy_set_for_os_agent(agent_id);
    flatten_policy_set_for_prompt(set)
}

pub(crate) fn load_enabled_unconditional_policies_for_os_agent(
    agent_id: &str,
) -> Vec<(String, String)> {
    let set = load_enabled_policy_set_for_os_agent(agent_id);
    flatten_unconditional_for_prompt(set)
}

pub(crate) fn load_enabled_policy_set_for_os_agent(agent_id: &str) -> metadata::PolicySet {
    let personal_dir = personal_policies_dir();
    let config_path = app_paths::personal_rules_config();
    let personal_config = match PoliciesConfig::load_from_path(&config_path) {
        Ok(config) => config,
        Err(err) => {
            warn!(
                "[policies] Skipping personal policies because config failed to load: {}",
                err
            );
            return metadata::PolicySet::default();
        }
    };

    let mut set = metadata::load_policy_set(&personal_dir, &personal_config, agent_id, None);
    sort_policy_set(&mut set);
    set
}

fn merge_policy_set(target: &mut metadata::PolicySet, source: metadata::PolicySet) {
    target.unconditional.extend(source.unconditional);
    target.conditional.extend(source.conditional);
}

fn sort_policy_set(set: &mut metadata::PolicySet) {
    set.unconditional
        .sort_by(|left, right| left.name.cmp(&right.name));
    set.conditional
        .sort_by(|left, right| left.name.cmp(&right.name));
}

fn flatten_policy_set_for_prompt(set: metadata::PolicySet) -> Vec<(String, String)> {
    let mut policies = flatten_unconditional_for_prompt(set.clone());
    policies.extend(
        set.conditional
            .into_iter()
            .map(|policy| (policy.name, policy.content)),
    );
    policies.sort_by(|left, right| left.0.cmp(&right.0));
    policies
}

fn flatten_unconditional_for_prompt(set: metadata::PolicySet) -> Vec<(String, String)> {
    let mut policies: Vec<(String, String)> = set
        .unconditional
        .into_iter()
        .map(|policy| (policy.name, policy.content))
        .collect();
    policies.sort_by(|left, right| left.0.cmp(&right.0));
    policies
}
