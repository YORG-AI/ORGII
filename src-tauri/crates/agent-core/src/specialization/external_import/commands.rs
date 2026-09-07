//! Tauri commands for external-agent artifact auto-import.

use std::path::{Path, PathBuf};

use super::detect::detect_all;
use super::types::{
    frontmatter_declares_readonly, readonly_excluded_tool_names, DetectedItem, ImportItemReport,
    ImportReport, ImportSelection, ImportStatus, ItemKind, SourceScope,
};
use crate::core::definitions::schema::{AgentDefinition, AgentTier, AgentToolSelection};
use crate::core::definitions::store::AgentDefinitionsStore;
use crate::specialization::mcp::config::{
    global_config_path, update_config_file, workspace_config_path, McpConfigFile,
};
use crate::specialization::policies::config::PolicyConfig;
use crate::specialization::policies::{
    config_for_source, policies_dir_for_source, save_config_for_source, PolicySource,
};
use crate::specialization::skills::loader::SkillsLoader;

/// Scan the user's machine for importable artifacts authored for other
/// coding agents (Cursor IDE / Claude Code / Copilot / Kiro in Phase 1).
///
/// `repo_path` scopes workspace-local detection. When `None`, only
/// user-global sources are scanned.
#[tauri::command]
pub async fn external_import_detect(
    repo_path: Option<String>,
) -> Result<Vec<DetectedItem>, String> {
    tokio::task::spawn_blocking(move || {
        let path = repo_path.map(PathBuf::from);
        Ok(detect_all(path.as_deref()))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Apply a list of `ImportSelection`s to ORGII-managed targets. Returns
/// a per-item report so partial failures are visible to the wizard.
///
/// `AgentDefinition` imports route through the live
/// `AgentDefinitionsStore` so the new agent is visible in-process
/// immediately (no app restart needed). Policy imports write directly to
/// disk. User-global skill imports can still be copied into ORGII's user
/// skill directory, but workspace-local skills are parsed in place by the
/// skill loader and are not forked into `.orgii/skills`.
#[tauri::command]
pub async fn external_import_apply(
    selections: Vec<ImportSelection>,
    state: tauri::State<'_, std::sync::Arc<AgentDefinitionsStore>>,
) -> Result<ImportReport, String> {
    Ok(apply_selections(selections, &state))
}

/// Internal entry-point: same behaviour as the Tauri command, exposed
/// without the `tauri::State` wrapper so unit tests and other backend
/// callers can reuse the import pipeline.
pub fn apply_selections(
    selections: Vec<ImportSelection>,
    store: &AgentDefinitionsStore,
) -> ImportReport {
    let mut items = Vec::with_capacity(selections.len());
    let mut skill_imported = false;
    for selection in selections {
        let kind = selection.kind;
        let report = apply_single(selection, store);
        if kind == ItemKind::Skill && report.status == ImportStatus::Imported {
            skill_imported = true;
        }
        items.push(report);
    }
    if skill_imported {
        SkillsLoader::invalidate_all_caches();
    }
    ImportReport { items }
}

fn apply_single(selection: ImportSelection, store: &AgentDefinitionsStore) -> ImportItemReport {
    let target_name = selection.target_name.clone();
    let kind = selection.kind;
    let source_path = selection.source_path.clone();
    let target_repo_path = selection.target_repo_path.as_deref();

    match selection.kind {
        ItemKind::Policy => match apply_policy_import(&selection, target_repo_path) {
            Ok(()) => ImportItemReport {
                source_path,
                target_name,
                kind,
                status: ImportStatus::Imported,
                error: None,
            },
            Err(err) => ImportItemReport {
                source_path,
                target_name,
                kind,
                status: ImportStatus::Failed,
                error: Some(err),
            },
        },
        ItemKind::Skill => {
            if matches!(selection.source_scope, SourceScope::WorkspaceLocal { .. }) {
                return ImportItemReport {
                    source_path,
                    target_name,
                    kind,
                    status: ImportStatus::Skipped,
                    error: Some(
                        "Workspace-local skills are loaded in place and are not copied into .orgii/skills"
                            .to_string(),
                    ),
                };
            }
            match apply_skill_import(&selection, target_repo_path) {
                Ok(()) => ImportItemReport {
                    source_path,
                    target_name,
                    kind,
                    status: ImportStatus::Imported,
                    error: None,
                },
                Err(err) => ImportItemReport {
                    source_path,
                    target_name,
                    kind,
                    status: ImportStatus::Failed,
                    error: Some(err),
                },
            }
        }
        ItemKind::Mcp => match apply_mcp_import(&selection, target_repo_path) {
            Ok(()) => ImportItemReport {
                source_path,
                target_name,
                kind,
                status: ImportStatus::Imported,
                error: None,
            },
            Err(err) => ImportItemReport {
                source_path,
                target_name,
                kind,
                status: ImportStatus::Failed,
                error: Some(err),
            },
        },
        ItemKind::AgentDefinition => match apply_agent_definition_import(&selection, store) {
            Ok(()) => ImportItemReport {
                source_path,
                target_name,
                kind,
                status: ImportStatus::Imported,
                error: None,
            },
            Err(err) => ImportItemReport {
                source_path,
                target_name,
                kind,
                status: ImportStatus::Failed,
                error: Some(err),
            },
        },
    }
}

fn apply_policy_import(
    selection: &ImportSelection,
    target_repo_path: Option<&Path>,
) -> Result<(), String> {
    if !is_safe_target_name(&selection.target_name) {
        return Err(format!(
            "Invalid target name '{}': only [A-Za-z0-9._-] characters are allowed",
            selection.target_name
        ));
    }

    let (target_source, workspace_path) = policy_target_source(target_repo_path);

    let dir = policies_dir_for_source(target_source, workspace_path)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("Failed to create target directory: {}", err))?;
    }

    let target_md = dir.join(format!("{}.md", selection.target_name));
    let target_mdc = dir.join(format!("{}.mdc", selection.target_name));

    if !selection.overwrite && (target_md.exists() || target_mdc.exists()) {
        return Err(format!(
            "Target '{}' already exists; pass `overwrite: true` to replace it",
            selection.target_name
        ));
    }

    let raw = std::fs::read_to_string(&selection.source_path)
        .map_err(|err| format!("Failed to read source: {}", err))?;

    let provenance = provenance_comment(&selection.source_path);
    let body = format!("{}\n{}", provenance, raw);

    std::fs::write(&target_md, body).map_err(|err| format!("Failed to write target: {}", err))?;

    write_imported_policy_config(&selection.target_name, target_source, workspace_path)?;

    Ok(())
}

fn write_imported_policy_config(
    policy_name: &str,
    target_source: PolicySource,
    workspace_path: Option<&Path>,
) -> Result<(), String> {
    let mut config = config_for_source(target_source, workspace_path)?;
    let scope_repo_paths = match (target_source, workspace_path) {
        (PolicySource::Workspace, Some(path)) => Some(vec![path.to_string_lossy().into_owned()]),
        _ => None,
    };

    config.policies.insert(
        policy_name.to_string(),
        PolicyConfig {
            agents: Vec::new(),
            disabled: false,
            scope_repo_paths,
            scope_exclude_repo_paths: None,
        },
    );
    save_config_for_source(&config, target_source, workspace_path)
}

/// Map an import target repo to the ORGII policy scope it lands under.
///
/// Workspace-local imports land in that workspace's rule directory. User-global
/// imports land in the personal/User rule directory so they do not become shared
/// global rules for every coding workspace.
fn policy_target_source(target_repo_path: Option<&Path>) -> (PolicySource, Option<&Path>) {
    match target_repo_path {
        Some(repo_path) => (PolicySource::Workspace, Some(repo_path)),
        None => (PolicySource::Personal, None),
    }
}

fn provenance_comment(source: &Path) -> String {
    format!("<!-- imported from: {} -->", source.display())
}

/// Reject names that would escape the target dir or contain shell-unsafe
/// characters. Mirrors the constraint we already enforce on
/// `policies_create`.
fn is_safe_target_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// ============================================================
// Skill import
// ============================================================

/// Imports a user-global skill source into ORGII's skill directory.
/// Workspace-local skills are loaded directly from their source workspace
/// directories and must not be copied into `.orgii/skills`.
///
/// Two source layouts are supported:
///   1. Directory layout — `<dir>/SKILL.md` (Claude Code skills dir).
///      We copy the whole bundled directory so referenced assets
///      (scripts, examples) come along.
///   2. Single-file layout — `<file>.md` (Claude Code commands).
///      We write the body to `<target>/SKILL.md` directly.
fn apply_skill_import(
    selection: &ImportSelection,
    target_repo_path: Option<&Path>,
) -> Result<(), String> {
    if !is_safe_target_name(&selection.target_name) {
        return Err(format!(
            "Invalid target name '{}': only [A-Za-z0-9._-] characters are allowed",
            selection.target_name
        ));
    }

    let target_root = skill_target_root(target_repo_path).join(&selection.target_name);
    let target_skill_md = target_root.join("SKILL.md");

    if !selection.overwrite && target_skill_md.exists() {
        return Err(format!(
            "Skill '{}' already exists; pass `overwrite: true` to replace it",
            selection.target_name
        ));
    }

    if !target_root.exists() {
        std::fs::create_dir_all(&target_root)
            .map_err(|err| format!("Failed to create target skill directory: {}", err))?;
    }

    let source_bundle_dir = if selection
        .source_path
        .file_name()
        .and_then(|name| name.to_str())
        == Some("SKILL.md")
    {
        selection.source_path.parent()
    } else {
        None
    };

    if let Some(source_dir) = source_bundle_dir.or_else(|| {
        selection
            .source_path
            .is_dir()
            .then_some(selection.source_path.as_path())
    }) {
        // Bundled skill — copy the whole directory tree.
        copy_dir_recursive(source_dir, &target_root)?;
        // Make sure SKILL.md ended up where we expect; if the source
        // dir was structured around a different filename we surface
        // that as an error rather than silently produce a half-broken
        // skill.
        if !target_skill_md.exists() {
            return Err(format!(
                "Source directory '{}' does not contain a SKILL.md",
                source_dir.display()
            ));
        }
    } else {
        let raw = std::fs::read_to_string(&selection.source_path)
            .map_err(|err| format!("Failed to read source: {}", err))?;
        let provenance = provenance_comment(&selection.source_path);
        let body = format!("{}\n{}", provenance, raw);
        std::fs::write(&target_skill_md, body)
            .map_err(|err| format!("Failed to write SKILL.md: {}", err))?;
    }

    Ok(())
}

fn skill_target_root(target_repo_path: Option<&Path>) -> PathBuf {
    match target_repo_path {
        Some(repo_path) => repo_path.join(".orgii").join("skills"),
        None => app_paths::global_skills_dir(),
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    if !to.exists() {
        std::fs::create_dir_all(to)
            .map_err(|err| format!("Failed to create '{}': {}", to.display(), err))?;
    }
    let entries = std::fs::read_dir(from).map_err(|err| format!("read_dir failed: {}", err))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let dest = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else if path.is_file() {
            std::fs::copy(&path, &dest)
                .map_err(|err| format!("copy {} → {}: {}", path.display(), dest.display(), err))?;
        }
    }
    Ok(())
}

// ============================================================
// MCP import
// ============================================================

fn load_external_mcp_config(path: &Path) -> Result<McpConfigFile, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read MCP config {}: {}", path.display(), err))?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|err| format!("Failed to parse MCP config {}: {}", path.display(), err))?;
    let Some(servers) = value
        .get_mut("mcpServers")
        .and_then(|entry| entry.as_object_mut())
    else {
        return Ok(McpConfigFile::default());
    };

    for server in servers.values_mut() {
        let Some(server_obj) = server.as_object_mut() else {
            continue;
        };
        if !server_obj.contains_key("type") {
            let inferred = if server_obj.contains_key("url") {
                "streamableHttp"
            } else {
                "stdio"
            };
            server_obj.insert(
                "type".to_string(),
                serde_json::Value::String(inferred.to_string()),
            );
        }
        if server_obj.get("type").and_then(|entry| entry.as_str()) == Some("http") {
            server_obj.insert(
                "type".to_string(),
                serde_json::Value::String("streamableHttp".to_string()),
            );
        }
    }

    serde_json::from_value(value).map_err(|err| {
        format!(
            "Failed to parse MCP server entries {}: {}",
            path.display(),
            err
        )
    })
}

fn apply_mcp_import(
    selection: &ImportSelection,
    target_repo_path: Option<&Path>,
) -> Result<(), String> {
    if !is_safe_target_name(&selection.target_name) {
        return Err(format!(
            "Invalid target name '{}': only [A-Za-z0-9._-] characters are allowed",
            selection.target_name
        ));
    }

    let source_config = load_external_mcp_config(&selection.source_path)?;
    let server_config = source_config
        .mcp_servers
        .get(&selection.target_name)
        .cloned()
        .ok_or_else(|| {
            format!(
                "MCP server '{}' was not found in {}",
                selection.target_name,
                selection.source_path.display()
            )
        })?;

    let target_path = match target_repo_path {
        Some(repo_path) => workspace_config_path(repo_path),
        None => global_config_path(),
    };
    update_config_file(&target_path, move |target_config| {
        if !selection.overwrite
            && target_config
                .mcp_servers
                .contains_key(&selection.target_name)
        {
            return Err(format!(
                "MCP server '{}' already exists; pass `overwrite: true` to replace it",
                selection.target_name
            ));
        }
        target_config
            .mcp_servers
            .insert(selection.target_name.clone(), server_config);
        Ok(())
    })
}

// ============================================================
// AgentDefinition import
// ============================================================

/// Reads a Claude Code `agents/*.md` file (frontmatter + body) and
/// appends a corresponding `AgentDefinition` to the live
/// `AgentDefinitionsStore`. Routing through the store (rather than
/// writing the JSON file directly) keeps the in-memory state and the
/// on-disk file in sync, so the imported agent is visible in the
/// AgentOrgs panel without an app restart.
///
/// Frontmatter `name` becomes `AgentDefinition.name`, `description`
/// flows through, and the markdown body becomes `soul_content`. The
/// produced agent is `built_in: false`, `tier: Secondary` (custom
/// default), and uses `selection.target_name` as the `id`.
fn apply_agent_definition_import(
    selection: &ImportSelection,
    store: &AgentDefinitionsStore,
) -> Result<(), String> {
    if !is_safe_target_name(&selection.target_name) {
        return Err(format!(
            "Invalid target name '{}': only [A-Za-z0-9._-] characters are allowed",
            selection.target_name
        ));
    }

    let raw = std::fs::read_to_string(&selection.source_path)
        .map_err(|err| format!("Failed to read source: {}", err))?;
    let (frontmatter, body) = split_frontmatter_for_apply(&raw);

    let description = frontmatter
        .iter()
        .find(|(k, _)| k == "description")
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let display_name = frontmatter
        .iter()
        .find(|(k, _)| k == "name")
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| selection.target_name.clone());

    let provenance = provenance_comment(&selection.source_path);
    let soul_content = format!("{}\n{}", provenance, body);

    // `readonly: true` from Cursor / Codex subagent frontmatter has no
    // direct counterpart on `AgentDefinition`. The detector emits a
    // `ReadonlyDowngraded` fidelity warning for the wizard; here we
    // enforce the actual constraint by subtracting every write-capable
    // builtin tool through `AgentToolSelection.excluded_tools`. The
    // tool-name list lives in `types.rs` so detect and apply stay in
    // sync — see `readonly_excluded_tool_names`.
    let tools = if frontmatter_declares_readonly(&frontmatter) {
        AgentToolSelection {
            excluded_tools: readonly_excluded_tool_names(),
            ..Default::default()
        }
    } else {
        AgentToolSelection::default()
    };

    let new_agent = AgentDefinition {
        id: selection.target_name.clone(),
        name: display_name,
        description,
        built_in: false,
        tier: AgentTier::Secondary,
        soul_content: Some(soul_content),
        tools,
        ..Default::default()
    };

    let mut agents = store
        .agents
        .lock()
        .map_err(|err| format!("Lock error on agent-definitions store: {}", err))?;

    if let Some(idx) = agents.iter().position(|a| a.id == selection.target_name) {
        if !selection.overwrite {
            return Err(format!(
                "Agent definition '{}' already exists; pass `overwrite: true` to replace it",
                selection.target_name
            ));
        }
        agents[idx] = new_agent;
    } else {
        agents.push(new_agent);
    }

    store.persist(&agents);
    Ok(())
}

/// Tear off `---\n…---\n` YAML frontmatter for the apply path. Returns
/// `(pairs, body)` regardless of whether the frontmatter was present /
/// parseable — malformed frontmatter is treated as "no frontmatter,
/// keep the body verbatim" so a single bad agent file never blocks an
/// import batch.
fn split_frontmatter_for_apply(raw: &str) -> (Vec<(String, String)>, String) {
    if !raw.starts_with("---") {
        return (Vec::new(), raw.to_string());
    }
    let after_open = raw.strip_prefix("---").unwrap_or(raw);
    let after_open = after_open.strip_prefix('\n').unwrap_or(after_open);
    let Some(close_idx) = after_open.find("\n---") else {
        return (Vec::new(), raw.to_string());
    };
    let yaml = &after_open[..close_idx];
    let rest = &after_open[close_idx..];
    let rest = rest.strip_prefix("\n---").unwrap_or(rest);
    let rest = rest.strip_prefix('\n').unwrap_or(rest);

    let parsed: serde_yaml::Value = match serde_yaml::from_str(yaml) {
        Ok(v) => v,
        Err(_) => return (Vec::new(), raw.to_string()),
    };

    let mut pairs = Vec::new();
    if let serde_yaml::Value::Mapping(map) = parsed {
        for (key, value) in map {
            let key_str = match key {
                serde_yaml::Value::String(s) => s,
                other => format!("{:?}", other),
            };
            let value_str = match value {
                serde_yaml::Value::String(s) => s,
                serde_yaml::Value::Bool(b) => b.to_string(),
                serde_yaml::Value::Number(n) => n.to_string(),
                serde_yaml::Value::Null => String::new(),
                other => serde_json::to_string(&other).unwrap_or_default(),
            };
            pairs.push((key_str, value_str));
        }
    }

    (pairs, rest.to_string())
}
