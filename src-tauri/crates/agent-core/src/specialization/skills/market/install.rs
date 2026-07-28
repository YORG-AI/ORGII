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

fn split_skills_sh_slug(slug: &str) -> Result<(String, String, String), String> {
    let parts: Vec<&str> = slug.trim().trim_matches('/').split('/').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.trim().is_empty()) {
        return Err(
            "Skill slug must be a skills.sh id in the form '<owner>/<repo>/<skill>'".to_string(),
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

pub(super) fn install_skill_snapshot(
    snapshot: &SkillDownloadResponse,
    skill_dir: &Path,
) -> Result<PathBuf, String> {
    if skill_dir.exists() {
        fs::remove_dir_all(skill_dir)
            .map_err(|err| format!("Failed to clean existing skill directory: {err}"))?;
    }
    fs::create_dir_all(skill_dir)
        .map_err(|err| format!("Failed to create skill directory: {err}"))?;

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

    let skill_path = skill_dir.join("SKILL.md");
    if !skill_path.exists() {
        return Err("Failed to install skill snapshot: SKILL.md was not written".to_string());
    }

    Ok(skill_path)
}

/// Install a skill from skills.sh into `~/.orgii/skills/`.
#[tauri::command]
pub async fn skills_hub_install(
    app_state: tauri::State<'_, AgentAppState>,
    slug: String,
) -> Result<HubInstallResult, String> {
    if slug.trim().is_empty() {
        return Err("Skill slug is required".to_string());
    }

    let client = build_http_client()?;
    let snapshot = fetch_skill_snapshot(&client, &slug).await?;
    let content = snapshot_skill_md(&snapshot).unwrap_or_default();

    let skill_name = extract_skill_name(content).unwrap_or_else(|| slug.clone());

    let skills_dir = global_skills_dir();
    let skill_dir = skills_dir.join(&skill_name);

    let skill_path = install_skill_snapshot(&snapshot, &skill_dir)?;
    let detail = build_detail_from_snapshot(&slug, &snapshot);
    if let Ok(json) = serde_json::to_string_pretty(&detail) {
        if let Err(err) = fs::write(skill_dir.join(CACHE_FILENAME), json) {
            log::warn!("[Skills] Failed to write skills.sh detail cache for '{skill_name}': {err}");
        }
    }
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
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Skill name is required".to_string());
    }

    let skill_dir = global_skills_dir().join(&name);

    if !skill_dir.exists() {
        return Err(format!("Skill directory not found: {name}"));
    }

    fs::remove_dir_all(&skill_dir)
        .map_err(|err| format!("Failed to remove skill directory: {err}"))?;
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
