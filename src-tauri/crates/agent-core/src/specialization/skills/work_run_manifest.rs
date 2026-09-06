//! WorkItemRun skill consent snapshots.
//!
//! Project management owns Run persistence; this module owns skill discovery,
//! resolved agent policy, and consent validation. A small function-pointer
//! bridge keeps those dependency directions intact.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use project_management::projects::types::{
    WorkItemRunSkillManifestEntry, WorkItemRunSkillOrigin, WorkItemRunTargetSnapshot,
};

use super::builtin;
use super::loader::{global_skills_dir, SkillInfo, SkillsLoader};

/// Loader plus the include list and the excluded set resolved alongside it.
type ConfiguredLoader = (SkillsLoader, Vec<String>, HashSet<String>);

/// Register the owning-boundary resolver. First registration wins so app
/// setup and tests can call this idempotently.
pub fn register() {
    project_management::work_run_service::register_skill_manifest_resolver(resolve);
}

fn loader_workspace(workspace_path: Option<&str>) -> PathBuf {
    workspace_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if path.file_name().and_then(|name| name.to_str()) == Some(".orgii") {
                path
            } else {
                path.join(".orgii")
            }
        })
        .unwrap_or_else(|| {
            global_skills_dir()
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(std::env::temp_dir)
        })
}

fn build_manifest(
    skills: Vec<SkillInfo>,
    include: &[String],
) -> Vec<WorkItemRunSkillManifestEntry> {
    let mut seen_names = HashSet::new();
    let include_all = include.is_empty();
    let mut manifest: Vec<_> = skills
        .into_iter()
        .filter(|skill| seen_names.insert(skill.name.clone()))
        .filter(|skill| {
            skill.enabled
                && skill.available
                && skill.consent_valid
                && !skill.id.trim().is_empty()
                && !skill.identity_digest.trim().is_empty()
                && !skill.content_digest.trim().is_empty()
                && !skill.schema_digest.trim().is_empty()
                && (include_all || include.iter().any(|name| name == &skill.name))
        })
        .map(|skill| WorkItemRunSkillManifestEntry {
            id: skill.id,
            name: skill.name,
            source: skill.source,
            origin: skill.origin.map(|origin| WorkItemRunSkillOrigin {
                provider: origin.provider,
                locator: origin.locator,
            }),
            identity_digest: skill.identity_digest,
            content_digest: skill.content_digest,
            schema_digest: skill.schema_digest,
        })
        .collect();
    manifest.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    manifest
}

/// Resolve exactly the effective, available catalog for the target agent. An
/// Agent Org Run starts at its coordinator, so that coordinator definition is
/// the owning binding; member catalogs belong to their later delegated runs.
pub fn resolve(
    snapshot: &WorkItemRunTargetSnapshot,
) -> Result<Vec<WorkItemRunSkillManifestEntry>, String> {
    let Some((loader, include, excluded)) = configured_loader(snapshot)? else {
        return Ok(Vec::new());
    };

    let mut skills = loader.list_skills_fresh();
    let existing: HashSet<String> = skills.iter().map(|skill| skill.name.clone()).collect();
    skills.extend(
        builtin::list_builtin_skills()
            .into_iter()
            .filter(|skill| !existing.contains(&skill.name)),
    );
    // Embedded builtins do not pass through the filesystem loader, so apply
    // the same resolved exclusion list after appending them.
    for skill in &mut skills {
        if excluded.contains(&skill.name) {
            skill.enabled = false;
        }
    }
    Ok(build_manifest(skills, &include))
}

fn configured_loader(
    snapshot: &WorkItemRunTargetSnapshot,
) -> Result<Option<ConfiguredLoader>, String> {
    let explicit_agent_id = snapshot
        .agent_definition_id
        .as_deref()
        .filter(|id| !id.trim().is_empty());
    let agent_id = match explicit_agent_id {
        Some(agent_id) => agent_id.to_string(),
        None => {
            let Some(org_id) = snapshot
                .agent_org_id
                .as_deref()
                .filter(|id| !id.trim().is_empty())
            else {
                return Ok(None);
            };
            let org = crate::definitions::orgs::orgs_store().get(org_id)?;
            let coordinator = org.agent_id.trim();
            if coordinator.is_empty()
                || crate::definitions::orgs::is_cli_agent_org_reference(coordinator)
            {
                return Ok(None);
            }
            coordinator.to_string()
        }
    };

    let store = crate::definitions::definitions_store();
    let definition = crate::definitions::resolve_definition_by_id(&agent_id, Some(store.as_ref()))?;
    let config = definition.skills_config.unwrap_or_default();
    if !config.enabled.unwrap_or(true) {
        return Ok(None);
    }

    let mut disabled = crate::state::integrations_store::integrations_store()
        .snapshot()
        .excluded_skills;
    for name in &config.exclude {
        if !disabled.contains(name) {
            disabled.push(name.clone());
        }
    }
    let excluded: HashSet<String> = disabled.iter().cloned().collect();

    let mut loader = SkillsLoader::new(&loader_workspace(snapshot.workspace_path.as_deref()))
        .with_builtin_dir(global_skills_dir())
        .with_disabled_skills(disabled)
        .with_agent_id(agent_id)
        .with_load_workspace_resources(definition.load_workspace_resources.unwrap_or(true));
    if !config.source_dirs.is_empty() {
        loader = loader.with_extra_source_dirs(&config.source_dirs);
    }
    let include = config.include;
    Ok(Some((loader, include, excluded)))
}

fn resolve_included(
    snapshot: &WorkItemRunTargetSnapshot,
) -> Result<Vec<WorkItemRunSkillManifestEntry>, String> {
    let Some((loader, include, _excluded)) = configured_loader(snapshot)? else {
        return Ok(Vec::new());
    };
    let names = if include.is_empty() {
        snapshot
            .skill_manifest
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>()
    } else {
        include.clone()
    };
    let skills = names
        .iter()
        .filter_map(|name| loader.find_skill_fresh(name))
        .collect();
    Ok(build_manifest(skills, &include))
}

/// Refuse to launch a new Session when the consented catalog changed after
/// enqueue. Legacy and targets without an ORGII agent definition keep their
/// pre-manifest empty behavior.
pub fn verify(snapshot: &WorkItemRunTargetSnapshot) -> Result<(), String> {
    let Some(expected_digest) = snapshot.skill_manifest_digest.as_deref() else {
        return Ok(());
    };
    let captured_digest =
        project_management::work_run_service::skill_manifest_digest(&snapshot.skill_manifest)?;
    // The enqueue snapshot already names the effective skills. Revalidate
    // only those bundles (or the definition's explicit include list) instead
    // of recursively hashing every unrelated skill source a second time.
    let current = resolve_included(snapshot)?;
    let current_digest = project_management::work_run_service::skill_manifest_digest(&current)?;
    if captured_digest == expected_digest
        && current_digest == expected_digest
        && current == snapshot.skill_manifest
    {
        Ok(())
    } else {
        Err(
            "skill consent is not configured for this WorkItemRun because the current manifest changed after enqueue; enqueue a new Run to approve it"
                .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::loader::DescriptionQuality;
    use crate::skills::provenance::SkillOrigin;

    fn skill(name: &str, enabled: bool, available: bool, consent_valid: bool) -> SkillInfo {
        SkillInfo {
            id: format!("workspace:{name}"),
            name: name.to_string(),
            path: format!("/private/body/{name}/SKILL.md").into(),
            source: "workspace".into(),
            origin: Some(SkillOrigin {
                provider: "skills_sh".into(),
                locator: format!("owner/repo/{name}"),
            }),
            identity_digest: format!("identity:{name}"),
            content_digest: format!("content:{name}"),
            schema_digest: format!("schema:{name}"),
            consent_valid,
            always: false,
            available,
            enabled,
            required_bins: Vec::new(),
            required_env: Vec::new(),
            description: "body must not be snapshotted".into(),
            estimated_tokens: 1,
            full_content_tokens: 2,
            description_quality: DescriptionQuality::Good,
            version: String::new(),
            license: String::new(),
            compatibility: String::new(),
            missing_bins: Vec::new(),
            missing_env: Vec::new(),
            bundled_files: vec!["secret.txt".into()],
        }
    }

    #[test]
    fn manifest_keeps_only_included_available_consented_identity_and_digests() {
        let manifest = build_manifest(
            vec![
                skill("kept", true, true, true),
                skill("disabled", false, true, true),
                skill("missing-bin", true, false, true),
                skill("drifted", true, true, false),
            ],
            &["kept".into(), "drifted".into()],
        );
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].name, "kept");
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(!json.contains("private/body"));
        assert!(!json.contains("body must not be snapshotted"));
        assert!(!json.contains("secret.txt"));
        assert!(json.contains("content:kept"));
    }

    #[test]
    fn manifest_deduplicates_by_loader_precedence() {
        let first = skill("same", true, true, true);
        let mut second = first.clone();
        second.id = "builtin:same".into();
        second.source = "builtin".into();
        let manifest = build_manifest(vec![first, second], &[]);
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].id, "workspace:same");
    }

    #[test]
    fn verification_error_is_a_non_retryable_configuration_message() {
        let message = "skill consent is not configured for this WorkItemRun because the current manifest changed after enqueue";
        let failure = project_management::work_run_service::classify_failure(message, false);
        assert_eq!(
            failure.class,
            project_management::projects::types::WorkItemRunFailureClass::Configuration
        );
        assert!(!failure.retryable);
    }
}
