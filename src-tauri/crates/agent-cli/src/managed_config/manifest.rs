//! Profile manifest storage: where the Default backup, managed profile and
//! manifest live on disk, plus manifest read/write and target resolution.

use app_paths as paths;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::dto::{CliConfigProfileManifest, CliConfigTargetFileManifest};
use super::file_io::write_sensitive_file_atomic;
use super::registry::managed_config_adapter;

fn default_backup_path(agent_name: &str, file_name: &str) -> PathBuf {
    paths::cli_config_profile_default_dir(agent_name).join(file_name)
}

fn managed_profile_path(agent_name: &str, file_name: &str) -> PathBuf {
    paths::cli_config_profile_orgii_dir(agent_name).join(file_name)
}

pub(super) fn manifest_path(agent_name: &str) -> PathBuf {
    paths::cli_config_profile_manifest(agent_name)
}

pub(super) fn read_manifest(agent_name: &str) -> Result<Option<CliConfigProfileManifest>, String> {
    let path = manifest_path(agent_name);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("Invalid {}: {err}", path.display()))
}

pub(super) fn manifest_bytes(manifest: &CliConfigProfileManifest) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(manifest)
        .map_err(|err| format!("Failed to serialize CLI config manifest: {err}"))
}

pub(super) fn write_manifest(manifest: &CliConfigProfileManifest) -> Result<(), String> {
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

pub(super) fn agent_manifest_targets(
    agent_name: &str,
) -> Result<Vec<CliConfigTargetFileManifest>, String> {
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

pub(super) fn targets_with_fallbacks(
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
