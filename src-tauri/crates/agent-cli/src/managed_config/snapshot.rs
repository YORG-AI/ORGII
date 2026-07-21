//! Target snapshots, pending mutations, and versioned Default backups.

use app_paths as paths;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::dto::CliConfigTargetFileManifest;
use super::file_io::{now_nanos, sha256_bytes, write_sensitive_file_atomic};

#[derive(Debug, Clone)]
pub(super) struct TargetSnapshot {
    pub(super) id: String,
    pub(super) target_path: PathBuf,
    pub(super) existed: bool,
    pub(super) bytes: Vec<u8>,
    pub(super) hash: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) enum TargetMutation {
    Write(Vec<u8>),
    Remove,
}

pub(super) fn read_target_snapshots(
    targets: &[CliConfigTargetFileManifest],
) -> Result<BTreeMap<String, TargetSnapshot>, String> {
    let mut snapshots = BTreeMap::new();
    for target in targets {
        let target_path = PathBuf::from(&target.target_path);
        let existed = target_path.exists();
        let bytes = if existed {
            std::fs::read(&target_path)
                .map_err(|err| format!("Failed to read {}: {err}", target_path.display()))?
        } else {
            Vec::new()
        };
        let hash = existed.then(|| sha256_bytes(&bytes));
        let snapshot = TargetSnapshot {
            id: target.id.clone(),
            target_path,
            existed,
            bytes,
            hash,
        };
        if snapshots.insert(target.id.clone(), snapshot).is_some() {
            return Err(format!("Duplicate CLI config target id: {}", target.id));
        }
    }
    Ok(snapshots)
}

fn versioned_default_backup_path(
    agent_name: &str,
    target: &CliConfigTargetFileManifest,
    snapshot: &TargetSnapshot,
) -> PathBuf {
    let file_name = Path::new(&target.target_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let hash = snapshot
        .hash
        .as_deref()
        .unwrap_or("missing")
        .trim_start_matches("sha256:");
    let short_hash = &hash[..hash.len().min(12)];
    paths::cli_config_profile_default_dir(agent_name)
        .join(format!("{}-{short_hash}-{file_name}", now_nanos()))
}

pub(super) fn ensure_default_backup_from_snapshot(
    agent_name: &str,
    mut target: CliConfigTargetFileManifest,
    snapshot: &TargetSnapshot,
    refresh_existing: bool,
) -> Result<CliConfigTargetFileManifest, String> {
    let backup_path = PathBuf::from(&target.default_backup_path);
    let is_new_target = target.last_applied_hash.is_none()
        && target.original_hash.is_none()
        && !target.default_was_missing
        && !backup_path.exists();

    if !refresh_existing && !is_new_target {
        if target.default_was_missing || backup_path.exists() {
            return Ok(target);
        }
        return Err(format!(
            "Default backup is missing for {}. Restore it before applying ORGII Managed again.",
            target.target_path
        ));
    }

    if snapshot.existed {
        let backup_path = versioned_default_backup_path(agent_name, &target, snapshot);
        write_sensitive_file_atomic(&backup_path, &snapshot.bytes)?;
        target.default_backup_path = backup_path.to_string_lossy().to_string();
        target.original_hash = snapshot.hash.clone();
        target.default_was_missing = false;
    } else {
        target.original_hash = None;
        target.default_was_missing = true;
    }

    Ok(target)
}
