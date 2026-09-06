//! Install / uninstall a skills.sh skill into `~/.orgii/skills/`.
//!
//! Also exposes snapshot download helpers to the `detail` and `update`
//! submodules, which re-use them for previews and overwrites.

use std::fs;
use std::path::{Path, PathBuf};

use reqwest::Client;

use crate::session::prompt::cache::PromptCacheInvalidationReason;
use crate::state::AgentAppState;
use crate::utils::http_retry::send_with_retry;
use app_paths::global_skills_dir;

use super::cache::CACHE_FILENAME;
use super::http::{build_http_client, SKILLS_SH_BASE_URL, SKILLS_SH_DOWNLOAD_PATH};
use super::types::{HubInstallResult, HubSkillDetail, SkillDownloadResponse};
use crate::skills::loader::commands::validate_skill_name;
use crate::skills::provenance::{
    build_provenance, schema_value, write_provenance, SkillOrigin, SkillProvenance,
};

fn split_skills_sh_slug(slug: &str) -> Result<(String, String, String), String> {
    let parts: Vec<&str> = slug.trim().trim_matches('/').split('/').collect();
    let safe_segment = |part: &&str| {
        !part.is_empty()
            && *part != "."
            && *part != ".."
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    };
    if parts.len() != 3 || !parts.iter().all(safe_segment) {
        return Err(
            "Skill slug must be a credential-free skills.sh id in the form '<owner>/<repo>/<skill>'"
                .to_string(),
        );
    }

    Ok((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
    ))
}

pub(super) fn snapshot_skill_md(snapshot: &SkillDownloadResponse) -> Option<&str> {
    snapshot
        .files
        .iter()
        .find(|file| file.path.eq_ignore_ascii_case("SKILL.md"))
        .map(|file| file.contents.as_str())
}

/// Fetch a skill snapshot from skills.sh by public id (`owner/repo/skill`).
pub(super) async fn fetch_skill_snapshot(
    client: &Client,
    slug: &str,
) -> Result<SkillDownloadResponse, String> {
    let (owner, repo, skill) = split_skills_sh_slug(slug)?;

    let file_url = format!(
        "{SKILLS_SH_BASE_URL}{SKILLS_SH_DOWNLOAD_PATH}/{}/{}/{}",
        urlencoding::encode(&owner),
        urlencoding::encode(&repo),
        urlencoding::encode(&skill)
    );
    let resp = send_with_retry(
        client,
        |c| c.get(&file_url).header("Accept", "application/json"),
        &format!("skills.sh download for '{slug}'"),
    )
    .await?;

    if !resp.status().is_success() {
        return Err(format!(
            "skills.sh download endpoint returned status {} for skill '{slug}'",
            resp.status()
        ));
    }

    let snapshot = resp
        .json::<SkillDownloadResponse>()
        .await
        .map_err(|err| format!("Failed to parse skills.sh download response: {err}"))?;

    if snapshot.files.is_empty() {
        return Err(format!("skills.sh snapshot is empty for skill '{slug}'"));
    }

    let skill_md = snapshot_skill_md(&snapshot)
        .ok_or_else(|| format!("skills.sh snapshot has no SKILL.md for skill '{slug}'"))?;
    if skill_md.trim().is_empty() {
        return Err(format!("SKILL.md is empty for skill '{slug}'"));
    }

    Ok(snapshot)
}
fn safe_join_skill_file(skill_dir: &Path, relative_path: &str) -> Option<PathBuf> {
    let normalized = relative_path.replace('\\', "/");
    if normalized.starts_with('/') || normalized.trim().is_empty() {
        return None;
    }

    let mut target = PathBuf::from(skill_dir);
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        target.push(segment);
    }

    Some(target)
}

fn write_skill_snapshot(snapshot: &SkillDownloadResponse, skill_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(skill_dir)
        .map_err(|err| format!("Failed to create staged skill directory: {err}"))?;
    for file in &snapshot.files {
        let Some(path) = safe_join_skill_file(skill_dir, &file.path) else {
            log::warn!(
                "[Skills] Skipping unsafe skills.sh snapshot path: {}",
                file.path
            );
            continue;
        };

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create skill file directory: {err}"))?;
        }

        fs::write(&path, &file.contents)
            .map_err(|err| format!("Failed to write skill snapshot file: {err}"))?;
    }

    if !skill_dir.join("SKILL.md").is_file() {
        return Err("Failed to install skill snapshot: SKILL.md was not written".to_string());
    }
    Ok(())
}

fn sibling_temp_path(skill_dir: &Path, kind: &str) -> Result<PathBuf, String> {
    let parent = skill_dir
        .parent()
        .ok_or_else(|| format!("Skill directory has no parent: {}", skill_dir.display()))?;
    let name = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Skill directory has no UTF-8 name: {}", skill_dir.display()))?;
    Ok(parent.join(format!(
        ".{name}.orgii-{kind}-{}",
        uuid::Uuid::new_v4().simple()
    )))
}

/// Publish a fully prepared skill directory without ever deleting the current
/// installation first. The backup rename is the rollback point; a failed
/// publish restores it before returning.
fn atomic_replace_skill_dir(staged_dir: &Path, skill_dir: &Path) -> Result<(), String> {
    let parent = skill_dir
        .parent()
        .ok_or_else(|| format!("Skill directory has no parent: {}", skill_dir.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create skills parent {}: {err}", parent.display()))?;
    let backup_dir = sibling_temp_path(skill_dir, "backup")?;

    if skill_dir.exists() {
        fs::rename(skill_dir, &backup_dir).map_err(|err| {
            format!(
                "Failed to stage current skill {} for replacement: {err}",
                skill_dir.display()
            )
        })?;
    }

    if let Err(err) = fs::rename(staged_dir, skill_dir) {
        if backup_dir.exists() {
            if let Err(restore_err) = fs::rename(&backup_dir, skill_dir) {
                return Err(format!(
                    "Failed to publish skill ({err}) and failed to restore previous installation ({restore_err}); backup remains at {}",
                    backup_dir.display()
                ));
            }
        }
        return Err(format!("Failed to publish staged skill: {err}"));
    }

    if backup_dir.exists() {
        if let Err(err) = fs::remove_dir_all(&backup_dir) {
            log::warn!(
                "[Skills] Published skill but could not remove old backup at {}: {err}",
                backup_dir.display()
            );
        }
    }
    Ok(())
}

pub(super) fn publish_skill_snapshot(
    snapshot: &SkillDownloadResponse,
    skill_dir: &Path,
    id: String,
    stable_name: String,
    origin: SkillOrigin,
    detail: &HubSkillDetail,
) -> Result<(PathBuf, SkillProvenance), String> {
    let staged_dir = sibling_temp_path(skill_dir, "staging")?;
    let prepared = (|| {
        write_skill_snapshot(snapshot, &staged_dir)?;
        let schema = schema_value(&staged_dir)?;
        let provenance = build_provenance(id, stable_name, origin, &staged_dir, &schema)?;
        write_provenance(&staged_dir, &provenance)?;
        let detail_json = serde_json::to_vec_pretty(detail)
            .map_err(|err| format!("Failed to serialize skills.sh detail cache: {err}"))?;
        fs::write(staged_dir.join(CACHE_FILENAME), detail_json)
            .map_err(|err| format!("Failed to stage skills.sh detail cache: {err}"))?;
        Ok::<SkillProvenance, String>(provenance)
    })();
    let provenance = match prepared {
        Ok(provenance) => provenance,
        Err(err) => {
            let _ = fs::remove_dir_all(&staged_dir);
            return Err(err);
        }
    };
    if let Err(err) = atomic_replace_skill_dir(&staged_dir, skill_dir) {
        let _ = fs::remove_dir_all(&staged_dir);
        return Err(err);
    }
    Ok((skill_dir.join("SKILL.md"), provenance))
}

pub(super) fn skills_root(workspace_path: Option<&str>) -> PathBuf {
    workspace_path
        .filter(|path| !path.trim().is_empty())
        .map(|path| PathBuf::from(path).join(".orgii").join("skills"))
        .unwrap_or_else(global_skills_dir)
}

fn stable_name_from_snapshot(
    snapshot: &SkillDownloadResponse,
    slug: &str,
) -> Result<String, String> {
    let content = snapshot_skill_md(snapshot).unwrap_or_default();
    let name = extract_skill_name(content).unwrap_or_else(|| {
        slug.trim()
            .trim_matches('/')
            .split('/')
            .next_back()
            .unwrap_or_default()
            .to_string()
    });
    validate_skill_name(&name)?;
    Ok(name)
}

/// Install a skill from skills.sh into the user scope or directly into a
/// repository's `.orgii/skills/` shared workspace scope.
#[tauri::command]
pub async fn skills_hub_install(
    app_state: tauri::State<'_, AgentAppState>,
    slug: String,
    workspace_path: Option<String>,
) -> Result<HubInstallResult, String> {
    if slug.trim().is_empty() {
        return Err("Skill slug is required".to_string());
    }

    let client = build_http_client()?;
    let snapshot = fetch_skill_snapshot(&client, &slug).await?;
    let skill_name = stable_name_from_snapshot(&snapshot, &slug)?;
    let skills_dir = skills_root(workspace_path.as_deref());
    let skill_dir = skills_dir.join(&skill_name);
    if skill_dir.exists() {
        return Err(format!(
            "Skill '{}' already exists at {}; use refresh instead of install",
            skill_name,
            skill_dir.display()
        ));
    }

    let detail = build_detail_from_snapshot(&slug, &snapshot);
    let origin = SkillOrigin {
        provider: "skills_sh".to_string(),
        locator: slug.trim().trim_matches('/').to_string(),
    };
    let stable_id = format!("skills_sh:{}", origin.locator);
    let (skill_path, _) = publish_skill_snapshot(
        &snapshot,
        &skill_dir,
        stable_id,
        skill_name.clone(),
        origin,
        &detail,
    )?;
    crate::skills::loader::SkillsLoader::invalidate_all_caches();
    app_state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
        .await;

    Ok(HubInstallResult {
        name: skill_name,
        path: skill_path.to_string_lossy().to_string(),
    })
}
pub(super) fn build_detail_from_snapshot(
    slug: &str,
    snapshot: &SkillDownloadResponse,
) -> HubSkillDetail {
    let skill_md = snapshot_skill_md(snapshot).map(|content| content.to_string());
    let skill_md_ref = skill_md.as_deref().unwrap_or_default();
    let name = extract_skill_name(skill_md_ref).unwrap_or_else(|| {
        slug.trim()
            .trim_matches('/')
            .split('/')
            .next_back()
            .unwrap_or(slug)
            .to_string()
    });
    let description = extract_skill_description(skill_md_ref).unwrap_or_default();
    let parts: Vec<&str> = slug.trim().trim_matches('/').split('/').collect();
    let source = if parts.len() >= 2 {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    };
    let skill_id = parts.get(2).map(|value| (*value).to_string());

    HubSkillDetail {
        slug: slug.to_string(),
        name,
        description,
        version: snapshot.hash.clone(),
        stats: None,
        owner: None,
        created_at: None,
        updated_at: None,
        changelog: None,
        skill_md,
        source,
        skill_id,
        installs: None,
        snapshot_hash: Some(snapshot.hash.clone()),
    }
}

/// Uninstall a skill by removing its directory from `~/.orgii/skills/`.
#[tauri::command]
pub async fn skills_hub_uninstall(
    app_state: tauri::State<'_, AgentAppState>,
    name: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Skill name is required".to_string());
    }
    validate_skill_name(&name)?;

    let skill_dir = skills_root(workspace_path.as_deref()).join(&name);

    if !skill_dir.exists() {
        return Err(format!("Skill directory not found: {name}"));
    }

    fs::remove_dir_all(&skill_dir)
        .map_err(|err| format!("Failed to remove skill directory: {err}"))?;
    crate::skills::loader::SkillsLoader::invalidate_all_caches();
    app_state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
        .await;

    Ok(())
}

fn extract_frontmatter_scalar(content: &str, key: &str) -> Option<String> {
    let after_start = content.strip_prefix("---")?;
    let end_idx = after_start.find("---")?;
    let frontmatter = &after_start[..end_idx];
    let prefix = format!("{key}:");

    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(after) = trimmed.strip_prefix(&prefix) {
            let value = after.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

/// Extract the `name` field from YAML frontmatter.
pub(super) fn extract_skill_name(content: &str) -> Option<String> {
    extract_frontmatter_scalar(content, "name")
}

/// Extract the `description` field from YAML frontmatter.
pub(super) fn extract_skill_description(content: &str) -> Option<String> {
    extract_frontmatter_scalar(content, "description")
}

#[cfg(test)]
mod tests {
    use super::super::types::SkillSnapshotFile;
    use super::*;
    use crate::skills::loader::SkillsLoader;
    use crate::skills::provenance::read_provenance;

    fn snapshot(hash: &str, upstream_name: &str, body: &str) -> SkillDownloadResponse {
        SkillDownloadResponse {
            hash: hash.to_string(),
            files: vec![SkillSnapshotFile {
                path: "SKILL.md".to_string(),
                contents: format!("---\nname: {upstream_name}\ndescription: test\n---\n{body}"),
            }],
        }
    }

    #[test]
    fn staged_refresh_preserves_stable_identity_and_binding_name() {
        let root = tempfile::tempdir().unwrap();
        let orgii_dir = root.path().join(".orgii");
        let skill_dir = orgii_dir.join("skills/stable-name");
        let slug = "owner/repo/original";
        let first = snapshot("h1", "stable-name", "first");
        let first_detail = build_detail_from_snapshot(slug, &first);
        publish_skill_snapshot(
            &first,
            &skill_dir,
            format!("skills_sh:{slug}"),
            "stable-name".into(),
            SkillOrigin {
                provider: "skills_sh".into(),
                locator: slug.into(),
            },
            &first_detail,
        )
        .unwrap();

        let second = snapshot("h2", "renamed-upstream", "second");
        let second_detail = build_detail_from_snapshot(slug, &second);
        publish_skill_snapshot(
            &second,
            &skill_dir,
            format!("skills_sh:{slug}"),
            "stable-name".into(),
            SkillOrigin {
                provider: "skills_sh".into(),
                locator: slug.into(),
            },
            &second_detail,
        )
        .unwrap();

        assert!(skill_dir.join("SKILL.md").exists());
        assert!(!orgii_dir.join("skills/renamed-upstream").exists());
        let provenance = read_provenance(&skill_dir).unwrap().unwrap();
        assert_eq!(provenance.name, "stable-name");
        assert_eq!(provenance.id, format!("skills_sh:{slug}"));
        assert!(fs::read_to_string(skill_dir.join("SKILL.md"))
            .unwrap()
            .contains("second"));

        let include = vec!["stable-name".to_string()];
        let listing =
            SkillsLoader::new(&orgii_dir).build_skill_listing_entries(&[], Some(&include));
        assert_eq!(listing.len(), 1);
        assert_eq!(listing[0].name, "stable-name");
    }

    #[test]
    fn invalid_staged_snapshot_leaves_current_installation_untouched() {
        let root = tempfile::tempdir().unwrap();
        let skill_dir = root.path().join("stable-name");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "original").unwrap();
        let invalid = SkillDownloadResponse {
            hash: "bad".into(),
            files: vec![SkillSnapshotFile {
                path: "README.md".into(),
                contents: "missing skill".into(),
            }],
        };
        let detail = build_detail_from_snapshot("owner/repo/original", &invalid);
        let result = publish_skill_snapshot(
            &invalid,
            &skill_dir,
            "skills_sh:owner/repo/original".into(),
            "stable-name".into(),
            SkillOrigin {
                provider: "skills_sh".into(),
                locator: "owner/repo/original".into(),
            },
            &detail,
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            "original"
        );
    }
}
