//! Lock-held managed-config operations: status, selection, and the
//! Default <-> ORGII Managed switch itself.
//!
//! Every function here assumes the caller already holds the config
//! operation guard and has recovered any pending transaction.

use std::collections::BTreeMap;
use std::path::PathBuf;

use super::dto::{
    CliConfigManagedStatus, CliConfigMode, CliConfigProfileManifest, CliConfigTargetFileStatus,
    CliManagedConfigSelection,
};
use super::file_io::{file_hash, now_stamp, sha256_bytes, write_sensitive_file_atomic};
use super::generators::generate_managed_configs;
use super::manifest::{agent_manifest_targets, read_manifest, targets_with_fallbacks};
use super::proxy::{generate_proxy_token, managed_proxy_url};
use super::registry::{supported_agent, unavailable_agent_message};
use super::snapshot::{ensure_default_backup_from_snapshot, read_target_snapshots, TargetMutation};
use super::transaction::execute_transaction;

pub(super) fn status_for_unlocked(agent_name: &str) -> Result<CliConfigManagedStatus, String> {
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

pub(super) fn managed_selection_for_agent_unlocked(
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

pub(super) fn enable_agent_orgii_managed_unlocked(
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

pub(super) fn restore_agent_default_unlocked(
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
