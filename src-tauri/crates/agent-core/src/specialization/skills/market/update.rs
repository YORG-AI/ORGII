//! Detect and apply in-place skill refreshes from their recorded origin.

use std::fs;
use std::path::{Path, PathBuf};

use crate::session::prompt::cache::PromptCacheInvalidationReason;
use crate::skills::loader::commands::validate_skill_name;
use crate::skills::provenance::{read_provenance, SkillOrigin, SkillProvenance};
use crate::state::AgentAppState;

use super::cache::CACHE_FILENAME;
use super::http::build_http_client;
use super::install::{
    build_detail_from_snapshot, fetch_skill_snapshot, publish_skill_snapshot, skills_root,
};
use super::types::{HubInstallResult, HubSkillDetail, SkillUpdateInfo};

#[derive(Debug)]
struct InstalledSkillsShSkill {
    name: String,
    directory: PathBuf,
    provenance: SkillProvenance,
}

fn cached_detail(skill_dir: &Path) -> Option<HubSkillDetail> {
    let raw = fs::read_to_string(skill_dir.join(CACHE_FILENAME)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn provenance_or_legacy(
    skill_dir: &Path,
    name: &str,
    expected_slug: Option<&str>,
) -> Option<(SkillProvenance, String)> {
    if let Ok(Some(provenance)) = read_provenance(skill_dir) {
        if provenance.name == name
            && provenance.origin.provider == "skills_sh"
            && expected_slug.is_none_or(|slug| provenance.origin.locator == slug)
        {
            let installed_version = cached_detail(skill_dir)
                .and_then(|detail| detail.snapshot_hash.filter(|hash| !hash.is_empty()))
                .unwrap_or_default();
            return Some((provenance, installed_version));
        }
    }

    // Compatibility for pre-provenance skills.sh installs. Their cache is the
    // old authoritative locator; the first successful refresh writes the new
    // sidecar without changing the directory/binding name.
    let detail = cached_detail(skill_dir)?;
    let slug = detail.slug.trim().trim_matches('/');
    if slug.is_empty() || expected_slug.is_some_and(|expected| expected != slug) {
        return None;
    }
    let installed_version = detail
        .snapshot_hash
        .filter(|hash| !hash.is_empty())
        .unwrap_or(detail.version);
    Some((
        SkillProvenance {
            schema_version: 1,
            id: format!("skills_sh:{slug}"),
            name: name.to_string(),
            origin: SkillOrigin {
                provider: "skills_sh".to_string(),
                locator: slug.to_string(),
            },
            // Rebuilt from the fetched staged bundle before it is published.
            consent: crate::skills::provenance::SkillConsentDigests {
                identity_digest: String::new(),
                content_digest: String::new(),
                schema_digest: String::new(),
            },
        },
        installed_version,
    ))
}

fn find_installed(
    workspace_path: Option<&str>,
    requested_name: Option<&str>,
    requested_slug: Option<&str>,
) -> Result<InstalledSkillsShSkill, String> {
    let root = skills_root(workspace_path);
    if !root.exists() {
        return Err(format!("Skills directory not found: {}", root.display()));
    }
    let requested_slug = requested_slug.map(|slug| slug.trim().trim_matches('/'));
    let entries = fs::read_dir(&root)
        .map_err(|err| format!("Failed to read skills directory {}: {err}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read skill entry: {err}"))?;
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if requested_name.is_some_and(|requested| requested != name) {
            continue;
        }
        let directory = entry.path();
        let Some((provenance, _installed_version)) =
            provenance_or_legacy(&directory, &name, requested_slug)
        else {
            continue;
        };
        return Ok(InstalledSkillsShSkill {
            name,
            directory,
            provenance,
        });
    }
    Err(format!(
        "Installed skills.sh skill not found (name={}, slug={}) in {}",
        requested_name.unwrap_or("*"),
        requested_slug.unwrap_or("*"),
        root.display()
    ))
}

async fn refresh_installed(
    app_state: &AgentAppState,
    installed: InstalledSkillsShSkill,
) -> Result<HubInstallResult, String> {
    let client = build_http_client()?;
    let snapshot = fetch_skill_snapshot(&client, &installed.provenance.origin.locator).await?;
    let detail = build_detail_from_snapshot(&installed.provenance.origin.locator, &snapshot);
    let (skill_path, _) = publish_skill_snapshot(
        &snapshot,
        &installed.directory,
        installed.provenance.id,
        installed.name.clone(),
        installed.provenance.origin,
        &detail,
    )?;
    crate::skills::loader::SkillsLoader::invalidate_all_caches();
    app_state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
        .await;
    Ok(HubInstallResult {
        name: installed.name,
        path: skill_path.to_string_lossy().into_owned(),
    })
}

/// Check installed user-scope and requested workspace-scope skills. This is
/// user-triggered and sequential by design; the 200 ms gap avoids hammering
/// skills.sh when a workspace has many origins.
#[tauri::command]
pub async fn skills_check_updates(
    workspace_paths: Option<Vec<String>>,
) -> Result<Vec<SkillUpdateInfo>, String> {
    let mut roots: Vec<(Option<String>, PathBuf)> = vec![(None, skills_root(None))];
    for workspace in workspace_paths.unwrap_or_default() {
        if workspace.trim().is_empty() {
            continue;
        }
        let root = skills_root(Some(&workspace));
        if !roots.iter().any(|(_, existing)| existing == &root) {
            roots.push((Some(workspace), root));
        }
    }

    let mut candidates = Vec::new();
    for (workspace_path, root) in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some((provenance, installed_version)) =
                provenance_or_legacy(&entry.path(), &name, None)
            {
                candidates.push((workspace_path.clone(), name, provenance, installed_version));
            }
        }
    }

    let client = build_http_client()?;
    let mut updates = Vec::new();
    for (workspace_path, name, provenance, installed_version) in candidates {
        let snapshot = match fetch_skill_snapshot(&client, &provenance.origin.locator).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                log::warn!("[Skills] Update check failed for '{name}': {err}");
                continue;
            }
        };
        if !snapshot.hash.is_empty() && snapshot.hash != installed_version {
            updates.push(SkillUpdateInfo {
                name,
                slug: provenance.origin.locator,
                installed_version,
                latest_version: snapshot.hash,
                changelog: None,
                workspace_path,
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Ok(updates)
}

/// Compatibility update entry point. Existing callers supply only `slug` and
/// therefore target the user scope; workspace callers should also pass the
/// stable installed `name` and `workspacePath`.
#[tauri::command]
pub async fn skills_hub_update(
    app_state: tauri::State<'_, AgentAppState>,
    slug: String,
    name: Option<String>,
    workspace_path: Option<String>,
) -> Result<HubInstallResult, String> {
    if slug.trim().is_empty() {
        return Err("Skill slug is required".to_string());
    }
    if let Some(name) = name.as_deref() {
        validate_skill_name(name)?;
    }
    let installed = find_installed(
        workspace_path.as_deref(),
        name.as_deref(),
        Some(slug.trim().trim_matches('/')),
    )?;
    refresh_installed(&app_state, installed).await
}

/// Refresh by the recorded origin, so callers never need to trust a new slug
/// or a name from the fetched bundle.
#[tauri::command]
pub async fn skills_refresh(
    app_state: tauri::State<'_, AgentAppState>,
    name: String,
    workspace_path: Option<String>,
) -> Result<HubInstallResult, String> {
    if name.trim().is_empty() {
        return Err("Skill name is required".to_string());
    }
    validate_skill_name(&name)?;
    let installed = find_installed(workspace_path.as_deref(), Some(&name), None)?;
    refresh_installed(&app_state, installed).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::provenance::{build_provenance, schema_value, write_provenance};

    #[test]
    fn lookup_uses_stable_directory_name_and_recorded_origin() {
        let workspace = tempfile::tempdir().unwrap();
        let skill_dir = workspace.path().join(".orgii/skills/stable-name");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: renamed-upstream\n---\nbody",
        )
        .unwrap();
        let origin = SkillOrigin {
            provider: "skills_sh".into(),
            locator: "owner/repo/original".into(),
        };
        let provenance = build_provenance(
            "skills_sh:owner/repo/original".into(),
            "stable-name".into(),
            origin,
            &skill_dir,
            &schema_value(&skill_dir).unwrap(),
        )
        .unwrap();
        write_provenance(&skill_dir, &provenance).unwrap();

        let found = find_installed(
            workspace.path().to_str(),
            Some("stable-name"),
            Some("owner/repo/original"),
        )
        .unwrap();
        assert_eq!(found.name, "stable-name");
        assert_eq!(found.provenance.id, "skills_sh:owner/repo/original");
    }
}
