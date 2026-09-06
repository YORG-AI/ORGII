//! Tauri commands for skill CRUD operations.
//!
//! Disabled-skills storage is keyed by agent definition ID. Every caller
//! that reads or toggles per-agent skill enablement MUST pass `agent_id`
//! explicitly — the old workspace-presence heuristic (silently writing
//! builtin:sde / builtin:os) made a custom-agent context toggle a
//! BUILTIN's skills, so it was removed.

use std::fs;
use std::path::PathBuf;

use super::scanner::SkillsLoader;
use super::types::SkillInfo;
use crate::specialization::skills::builtin;

use crate::core::definitions::store::AgentDefinitionsStore;
use crate::core::definitions::AgentSkillsConfig;
use crate::session::prompt::cache::PromptCacheInvalidationReason;
use crate::skills::provenance::refresh_existing_consent;
use crate::state::AgentAppState;

/// Read the disabled-skills list from `AgentDefinition.skills_config.exclude`.
///
/// Reads through the registered `AgentDefinitionsStore` (the same
/// singleton `agent_def_get` and `agent_def_update_patch` use) so
/// `skills_toggle` writes are visible immediately, with no
/// new-instance / split-brain hop.
fn load_disabled_skills_for(store: &AgentDefinitionsStore, agent_id: &str) -> Vec<String> {
    store
        .get(agent_id)
        .and_then(|def| def.skills_config.map(|s| s.exclude))
        .unwrap_or_default()
}

/// Toggle a skill enabled/disabled in `AgentDefinition.skills_config.exclude`.
fn toggle_disabled_skill_for(
    store: &AgentDefinitionsStore,
    agent_id: &str,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    let apply = |def: &mut crate::core::definitions::AgentDefinition| {
        let cfg = def
            .skills_config
            .get_or_insert_with(AgentSkillsConfig::default);
        if enabled {
            cfg.exclude.retain(|skill| skill != name);
        } else if !cfg.exclude.iter().any(|s| s == name) {
            cfg.exclude.push(name.to_string());
        }
    };
    if agent_id.starts_with(crate::definitions::builtin::BUILTIN_PREFIX) {
        store.update_with_overlay(agent_id, apply).map(|_| ())
    } else {
        store.update(agent_id, apply).map(|_| ())
    }
}

/// Global skills directory: `~/.orgii/skills/`.
pub fn global_skills_dir() -> PathBuf {
    app_paths::global_skills_dir()
}

/// Build a SkillsLoader for a workspace (workspace `.orgii/` plus in-place skill roots and global/user roots).
pub(super) fn loader_for_workspace(workspace_path: Option<&str>) -> SkillsLoader {
    let base = match workspace_path {
        Some(path) => {
            let path = PathBuf::from(path);
            if path.file_name().and_then(|name| name.to_str()) == Some(".orgii") {
                path
            } else {
                path.join(".orgii")
            }
        }
        None => global_skills_dir()
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(std::env::temp_dir),
    };
    SkillsLoader::new(&base).with_builtin_dir(global_skills_dir())
}

const EMBEDDED_BUILTIN_SKILL_SOURCE: &str = "embedded_builtin";

fn append_embedded_builtin_skills(skills: &mut Vec<SkillInfo>) {
    let existing_names: std::collections::HashSet<String> =
        skills.iter().map(|skill| skill.name.clone()).collect();
    for mut skill in builtin::list_builtin_skills() {
        if existing_names.contains(&skill.name) {
            continue;
        }
        skill.source = EMBEDDED_BUILTIN_SKILL_SOURCE.to_string();
        skills.push(skill);
    }
}

/// List skills and mark enabled/disabled based on the given disabled list.
pub fn list_skills_with_config(
    workspace_path: Option<&str>,
    disabled_skills: &[String],
) -> Vec<SkillInfo> {
    let loader = loader_for_workspace(workspace_path);
    let mut skills = loader.list_skills();
    append_embedded_builtin_skills(&mut skills);
    for skill in &mut skills {
        skill.enabled = !disabled_skills.contains(&skill.name);
    }
    skills
}

// ============================================
// Tauri commands
// ============================================

/// List all discovered skills (workspace + global) with availability and enabled status.
///
/// `agent_id` lets callers (custom-agent detail view, AgentWizard) edit
/// the right agent's exclusion list; when omitted we fall back to the
/// workspace-presence heuristic for backward compatibility.
/// When `agent_id` is supplied, `enabled` reflects the union of the
/// app-global disabled list and that agent's exclusion list; otherwise it
/// reflects only the app-global list (the Extensions hub view).
#[tauri::command]
pub async fn skills_list(
    store: tauri::State<'_, std::sync::Arc<AgentDefinitionsStore>>,
    workspace_path: Option<String>,
    agent_id: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    SkillsLoader::invalidate_all_caches();
    let mut disabled = crate::state::integrations_store::integrations_store()
        .snapshot()
        .excluded_skills;
    if let Some(owner) = agent_id.as_deref().filter(|id| !id.trim().is_empty()) {
        for skill in load_disabled_skills_for(&store, owner) {
            if !disabled.contains(&skill) {
                disabled.push(skill);
            }
        }
    }
    Ok(list_skills_with_config(
        workspace_path.as_deref(),
        &disabled,
    ))
}

/// Read a skill's full SKILL.md content by name.
#[tauri::command]
pub async fn skills_read(workspace_path: Option<String>, name: String) -> Result<String, String> {
    let loader = loader_for_workspace(workspace_path.as_deref());
    loader
        .load_skill(&name)
        .ok_or_else(|| format!("Skill '{}' not found", name))
}

/// Toggle a skill on/off.
///
/// With `agent_id`: per-agent toggle on that definition's
/// `skills_config.exclude` (store chokepoints fire persistence + the
/// defs-changed event). Without `agent_id`: app-global toggle on
/// `IntegrationsConfig.excluded_skills` — off for EVERY agent (the
/// Extensions hub semantics; previously this silently wrote builtin:os's
/// overlay and never applied to other agents).
#[tauri::command]
pub async fn skills_toggle(
    store: tauri::State<'_, std::sync::Arc<AgentDefinitionsStore>>,
    app_state: tauri::State<'_, AgentAppState>,
    workspace_path: Option<String>,
    agent_id: Option<String>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let _ = workspace_path; // catalog scope is irrelevant for ownership
    match agent_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(owner) => {
            toggle_disabled_skill_for(&store, owner, &name, enabled)?;
            app_state
                .invalidate_prompt_caches_for_agent_definition(
                    owner,
                    PromptCacheInvalidationReason::AgentDefinitionChanged,
                )
                .await;
        }
        None => {
            app_state
                .integrations
                .update(|cfg| -> Result<(), std::convert::Infallible> {
                    if enabled {
                        cfg.excluded_skills.retain(|skill| skill != &name);
                    } else if !cfg.excluded_skills.iter().any(|s| s == &name) {
                        cfg.excluded_skills.push(name.clone());
                    }
                    Ok(())
                })
                .map_err(|err| err.to_string())?;
            app_state
                .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
                .await;
        }
    }
    Ok(())
}

/// Validate a skill name per the Agent Skills spec:
/// non-empty, kebab-case, max 64 chars, no consecutive hyphens, not already taken.
#[tauri::command]
pub async fn skills_validate_name(
    name: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    validate_skill_name(&name)?;

    let loader = loader_for_workspace(workspace_path.as_deref());
    let mut existing = loader.list_skills();
    append_embedded_builtin_skills(&mut existing);
    if existing.iter().any(|s| s.name == name) {
        return Err(format!("A skill named '{}' already exists", name));
    }

    Ok(())
}

/// Pure name validation (no uniqueness check).
pub(crate) fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if name.len() > 64 {
        return Err("Skill name must be at most 64 characters".to_string());
    }
    let valid_kebab = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid_kebab || name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Err(
            "Skill name must be kebab-case (lowercase letters, digits, single hyphens)".to_string(),
        );
    }
    Ok(())
}

/// Validate frontmatter field lengths per the Agent Skills spec.
pub(super) fn validate_frontmatter_fields(frontmatter: &str) -> Result<(), String> {
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(after) = trimmed.strip_prefix("description:") {
            let val = after.trim().trim_matches('"').trim_matches('\'');
            if val.len() > 1024 {
                return Err("Description must be at most 1024 characters".to_string());
            }
        } else if let Some(after) = trimmed.strip_prefix("compatibility:") {
            let val = after.trim().trim_matches('"').trim_matches('\'');
            if val.len() > 500 {
                return Err("Compatibility must be at most 500 characters".to_string());
            }
        }
    }
    Ok(())
}

/// Create a new skill. Writes to workspace `.orgii/skills/` when `workspace_path`
/// is provided, otherwise to the global `~/.orgii/skills/`.
#[tauri::command]
pub async fn skills_create(
    app_state: tauri::State<'_, AgentAppState>,
    name: String,
    frontmatter: String,
    body: String,
    workspace_path: Option<String>,
) -> Result<SkillInfo, String> {
    validate_skill_name(&name)?;
    validate_frontmatter_fields(&frontmatter)?;

    let dir = match workspace_path {
        Some(ref pp) => PathBuf::from(pp).join(".orgii/skills").join(&name),
        None => global_skills_dir().join(&name),
    };
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create skill directory: {}", err))?;

    let skill_file = dir.join("SKILL.md");
    if skill_file.exists() {
        return Err(format!(
            "Skill '{}' already exists at {}",
            name,
            skill_file.display()
        ));
    }

    let content = if frontmatter.is_empty() {
        body
    } else {
        format!("---\n{}\n---\n\n{}", frontmatter.trim(), body)
    };

    fs::write(&skill_file, &content).map_err(|err| format!("Failed to write SKILL.md: {}", err))?;

    SkillsLoader::invalidate_all_caches();
    app_state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
        .await;

    let loader = loader_for_workspace(workspace_path.as_deref());
    let skills = loader.list_skills();
    skills
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| "Skill created but not found in scan".to_string())
}

/// Update an existing skill's SKILL.md content at the given path.
#[tauri::command]
pub async fn skills_update(
    app_state: tauri::State<'_, AgentAppState>,
    skill_path: String,
    frontmatter: String,
    body: String,
) -> Result<(), String> {
    let path = PathBuf::from(&skill_path);
    if !path.exists() {
        return Err(format!("Skill file not found: {}", skill_path));
    }

    let content = if frontmatter.is_empty() {
        body
    } else {
        format!("---\n{}\n---\n\n{}", frontmatter.trim(), body)
    };

    validate_frontmatter_fields(&frontmatter)?;

    fs::write(&path, content).map_err(|err| format!("Failed to write SKILL.md: {}", err))?;
    let skill_dir = path
        .parent()
        .ok_or_else(|| format!("Skill path has no parent directory: {skill_path}"))?;
    refresh_existing_consent(skill_dir)?;
    SkillsLoader::invalidate_all_caches();
    app_state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
        .await;
    Ok(())
}

/// Move a skill between scopes (global ↔ workspace).
///
/// Returns the new on-disk path of the moved `SKILL.md`. The source
/// directory is moved as a whole so bundled files / scripts / refs
/// follow the skill. Refuses to clobber an existing skill at the
/// destination.
///
/// `target_scope` is `"global"` or `"workspace"`. When moving *to* a
/// workspace scope, `workspace_path` must be supplied.
#[tauri::command]
pub async fn skills_move(
    app_state: tauri::State<'_, AgentAppState>,
    skill_path: String,
    target_scope: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let src_skill_md = PathBuf::from(&skill_path);
    if !src_skill_md.exists() {
        return Err(format!("Skill file not found: {}", skill_path));
    }
    let src_dir = src_skill_md
        .parent()
        .ok_or_else(|| format!("Skill path has no parent directory: {}", skill_path))?
        .to_path_buf();
    let skill_name = src_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Could not derive skill name from path: {}", skill_path))?
        .to_string();

    let dest_dir = match target_scope.as_str() {
        "global" => global_skills_dir().join(&skill_name),
        "workspace" => {
            let pp = workspace_path
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "workspace_path is required when moving a skill to workspace scope".to_string()
                })?;
            PathBuf::from(pp).join(".orgii/skills").join(&skill_name)
        }
        other => return Err(format!("Unknown target_scope: {}", other)),
    };

    if src_dir == dest_dir {
        return Ok(src_skill_md.to_string_lossy().into_owned());
    }
    if dest_dir.exists() {
        return Err(format!(
            "A skill named '{}' already exists at {}",
            skill_name,
            dest_dir.display()
        ));
    }

    if let Some(parent) = dest_dir.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create destination directory: {}", err))?;
    }

    // Try a simple rename first; fall back to copy + remove for cross-device
    // moves (e.g. workspace on a different filesystem than `~/.orgii`).
    if let Err(rename_err) = fs::rename(&src_dir, &dest_dir) {
        copy_dir_recursive(&src_dir, &dest_dir).map_err(|err| {
            format!(
                "Failed to copy skill (rename also failed: {}): {}",
                rename_err, err
            )
        })?;
        fs::remove_dir_all(&src_dir)
            .map_err(|err| format!("Failed to remove source after copy: {}", err))?;
    }

    let new_skill_md = dest_dir.join("SKILL.md");
    SkillsLoader::invalidate_all_caches();
    app_state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
        .await;
    Ok(new_skill_md.to_string_lossy().into_owned())
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let next_dest = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &next_dest)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &next_dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tempdir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "orgii-skills-move-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn list_skills_with_config_keeps_embedded_builtin_uri() {
        let skills = list_skills_with_config(None, &[]);
        let skill = skills
            .iter()
            .find(|candidate| candidate.name == "create-orgii-agent")
            .expect("create-orgii-agent should be listed");

        assert_eq!(skill.source, EMBEDDED_BUILTIN_SKILL_SOURCE);
        assert_eq!(
            skill.path.to_string_lossy(),
            "builtin://create-orgii-agent/SKILL.md"
        );
    }

    #[test]
    fn copy_dir_recursive_handles_nested_files() {
        let src = unique_tempdir("copy-src");
        let dest = unique_tempdir("copy-dest");
        let nested = src.join("scripts");
        fs::create_dir_all(&nested).unwrap();
        fs::write(src.join("SKILL.md"), b"# skill").unwrap();
        fs::write(nested.join("run.sh"), b"echo hi").unwrap();

        copy_dir_recursive(&src, &dest).unwrap();

        assert!(dest.join("SKILL.md").exists());
        assert!(dest.join("scripts/run.sh").exists());

        fs::remove_dir_all(&src).ok();
        fs::remove_dir_all(&dest).ok();
    }

    #[test]
    fn collect_org_skill_files_skips_non_utf8_attachment() {
        let skill_dir = unique_tempdir("org-share-binary");
        fs::write(skill_dir.join("SKILL.md"), b"# skill").unwrap();
        fs::write(skill_dir.join("reference.md"), b"# reference notes").unwrap();
        let non_utf8_bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8, 0xff, 0xe0];
        fs::write(skill_dir.join("attachment.docx"), &non_utf8_bytes).unwrap();

        let files = collect_org_skill_files(&skill_dir).expect("collection should not error");
        let mut relative_paths: Vec<&str> = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        relative_paths.sort();

        assert_eq!(relative_paths, vec!["reference.md"]);

        fs::remove_dir_all(&skill_dir).ok();
    }

    #[test]
    fn collect_org_skill_files_skips_non_utf8_bytes_with_unlisted_extension() {
        let skill_dir = unique_tempdir("org-share-binary-fallback");
        fs::write(skill_dir.join("SKILL.md"), b"# skill").unwrap();
        fs::write(skill_dir.join("notes.txt"), b"plain text notes").unwrap();
        let non_utf8_bytes: Vec<u8> = vec![0xff, 0xfe, 0x00, 0x01, 0x02, 0x80, 0x81];
        fs::write(skill_dir.join("blob.dat"), &non_utf8_bytes).unwrap();

        let files = collect_org_skill_files(&skill_dir).expect("collection should not error");
        let mut relative_paths: Vec<&str> = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        relative_paths.sort();

        assert_eq!(relative_paths, vec!["notes.txt"]);

        fs::remove_dir_all(&skill_dir).ok();
    }
}

/// Collect a skill's bundled files as `OrgSkillFile` entries, skipping
/// attachments that are not valid UTF-8 text (binary extension match or a
/// failed UTF-8 read) so a single non-text attachment does not fail the
/// whole org share.
fn collect_org_skill_files(
    skill_dir: &std::path::Path,
) -> Result<Vec<project_management::org_skills::OrgSkillFile>, String> {
    let mut skipped_binary_files = Vec::new();
    let files = super::helpers::collect_bundled_files(skill_dir)
        .into_iter()
        .filter_map(|relative_path| {
            if super::helpers::is_binary_by_extension(&relative_path) {
                skipped_binary_files.push(relative_path);
                return None;
            }
            match std::fs::read_to_string(skill_dir.join(&relative_path)) {
                Ok(content) => Some(Ok(project_management::org_skills::OrgSkillFile {
                    relative_path,
                    content,
                })),
                Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
                    skipped_binary_files.push(relative_path);
                    None
                }
                Err(err) => Some(Err(format!("Failed to read {relative_path}: {err}"))),
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    if !skipped_binary_files.is_empty() {
        tracing::warn!(
            skill_dir = %skill_dir.display(),
            files = ?skipped_binary_files,
            "skills_share_to_org: skipped non-UTF-8 bundled files"
        );
    }
    Ok(files)
}

/// Snapshot a local skill (SKILL.md, bundled files, provenance sidecar)
/// into the org-shared store, from which every member's materialization
/// and the sync carrier flow. The store enforces the size cap.
#[tauri::command]
pub async fn skills_share_to_org(
    skill_path: String,
    org_id: String,
    description: Option<String>,
    shared_by: Option<String>,
) -> Result<project_management::org_skills::OrgSkill, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::PathBuf::from(&skill_path);
        let skill_dir = if path.is_dir() {
            path
        } else {
            path.parent()
                .map(std::path::Path::to_path_buf)
                .ok_or_else(|| format!("Invalid skill path: {skill_path}"))?
        };
        let name = skill_dir
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
            .ok_or_else(|| format!("Invalid skill directory: {skill_path}"))?;
        let skill_md = std::fs::read_to_string(skill_dir.join("SKILL.md"))
            .map_err(|err| format!("Failed to read SKILL.md: {err}"))?;
        let files = collect_org_skill_files(&skill_dir)?;
        let provenance = crate::specialization::skills::provenance::read_provenance(&skill_dir)?
            .map(|record| serde_json::to_value(record).map_err(|err| err.to_string()))
            .transpose()?;
        let id = provenance
            .as_ref()
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
            .map(str::to_string);
        project_management::org_skills::share(
            project_management::org_skills::ShareOrgSkillRequest {
                org_id,
                id,
                name,
                description: description.unwrap_or_default(),
                skill_md,
                files,
                provenance,
                shared_by,
            },
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
