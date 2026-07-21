//! Crash-safe config switching: a journalled transaction that rolls every
//! target back when any write in the batch fails.

use app_paths as paths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

use super::dto::CliConfigProfileManifest;
use super::file_io::{file_hash, now_stamp, sha256_bytes, write_sensitive_file_atomic};
use super::manifest::{manifest_bytes, manifest_path, write_manifest};
use super::snapshot::{TargetMutation, TargetSnapshot};

const TRANSACTION_DIR_NAME: &str = "transaction";
const TRANSACTION_JOURNAL_FILE_NAME: &str = "journal.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliConfigTransactionTarget {
    id: String,
    target_path: String,
    rollback_path: String,
    target_existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CliConfigTransactionJournal {
    agent: String,
    final_manifest_hash: String,
    target_files: Vec<CliConfigTransactionTarget>,
    created_at: String,
}

fn transaction_dir(agent_name: &str) -> PathBuf {
    paths::cli_config_profile_agent_dir(agent_name).join(TRANSACTION_DIR_NAME)
}

pub(super) fn transaction_journal_path(agent_name: &str) -> PathBuf {
    transaction_dir(agent_name).join(TRANSACTION_JOURNAL_FILE_NAME)
}

fn cleanup_transaction_dir(agent_name: &str) -> Result<(), String> {
    let dir = transaction_dir(agent_name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|err| format!("Failed to remove {}: {err}", dir.display()))?;
    }
    Ok(())
}

fn read_transaction_journal(
    agent_name: &str,
) -> Result<Option<CliConfigTransactionJournal>, String> {
    let path = transaction_journal_path(agent_name);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let journal: CliConfigTransactionJournal = serde_json::from_str(&raw)
        .map_err(|err| format!("Invalid CLI config transaction {}: {err}", path.display()))?;
    if journal.agent != agent_name {
        return Err(format!(
            "CLI config transaction agent mismatch: expected {agent_name}, found {}",
            journal.agent
        ));
    }
    Ok(Some(journal))
}

fn rollback_transaction(journal: &CliConfigTransactionJournal) -> Result<(), String> {
    let mut errors = Vec::new();
    for target in &journal.target_files {
        let target_path = PathBuf::from(&target.target_path);
        let result = if target.target_existed {
            let rollback_path = PathBuf::from(&target.rollback_path);
            std::fs::read(&rollback_path)
                .map_err(|err| format!("Failed to read {}: {err}", rollback_path.display()))
                .and_then(|bytes| write_sensitive_file_atomic(&target_path, &bytes))
        } else if target_path.exists() {
            std::fs::remove_file(&target_path)
                .map_err(|err| format!("Failed to remove {}: {err}", target_path.display()))
        } else {
            Ok(())
        };
        if let Err(err) = result {
            errors.push(err);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(super) fn recover_pending_transaction_unlocked(agent_name: &str) -> Result<(), String> {
    let Some(journal) = read_transaction_journal(agent_name)? else {
        let dir = transaction_dir(agent_name);
        if dir.exists() {
            cleanup_transaction_dir(agent_name)?;
        }
        return Ok(());
    };

    if file_hash(&manifest_path(agent_name))? == Some(journal.final_manifest_hash.clone()) {
        cleanup_transaction_dir(agent_name)?;
        return Ok(());
    }

    rollback_transaction(&journal)?;
    cleanup_transaction_dir(agent_name)
}

pub(super) fn begin_transaction(
    agent_name: &str,
    snapshots: &BTreeMap<String, TargetSnapshot>,
    final_manifest: &CliConfigProfileManifest,
) -> Result<CliConfigTransactionJournal, String> {
    recover_pending_transaction_unlocked(agent_name)?;
    let rollback_dir = transaction_dir(agent_name).join("rollback");
    std::fs::create_dir_all(&rollback_dir)
        .map_err(|err| format!("Failed to create {}: {err}", rollback_dir.display()))?;

    let mut target_files = Vec::new();
    for (index, snapshot) in snapshots.values().enumerate() {
        if file_hash(&snapshot.target_path)? != snapshot.hash {
            cleanup_transaction_dir(agent_name)?;
            return Err(format!(
                "CLI config changed while ORGII was preparing the switch: {}",
                snapshot.target_path.display()
            ));
        }

        let rollback_path = rollback_dir.join(format!("{index}-{}.bak", snapshot.id));
        if snapshot.existed {
            write_sensitive_file_atomic(&rollback_path, &snapshot.bytes)?;
        }
        target_files.push(CliConfigTransactionTarget {
            id: snapshot.id.clone(),
            target_path: snapshot.target_path.to_string_lossy().to_string(),
            rollback_path: rollback_path.to_string_lossy().to_string(),
            target_existed: snapshot.existed,
        });
    }

    let journal = CliConfigTransactionJournal {
        agent: agent_name.to_string(),
        final_manifest_hash: sha256_bytes(&manifest_bytes(final_manifest)?),
        target_files,
        created_at: now_stamp(),
    };
    let bytes = serde_json::to_vec_pretty(&journal)
        .map_err(|err| format!("Failed to serialize CLI config transaction: {err}"))?;
    write_sensitive_file_atomic(&transaction_journal_path(agent_name), &bytes)?;
    Ok(journal)
}

pub(super) fn execute_transaction(
    agent_name: &str,
    snapshots: &BTreeMap<String, TargetSnapshot>,
    mutations: &BTreeMap<String, TargetMutation>,
    final_manifest: &CliConfigProfileManifest,
) -> Result<(), String> {
    let journal = begin_transaction(agent_name, snapshots, final_manifest)?;
    let result = (|| {
        for (id, mutation) in mutations {
            let snapshot = snapshots
                .get(id)
                .ok_or_else(|| format!("Missing CLI config snapshot for target {id}"))?;
            match mutation {
                TargetMutation::Write(bytes) => {
                    write_sensitive_file_atomic(&snapshot.target_path, bytes)?
                }
                TargetMutation::Remove => {
                    if snapshot.target_path.exists() {
                        std::fs::remove_file(&snapshot.target_path).map_err(|err| {
                            format!("Failed to remove {}: {err}", snapshot.target_path.display())
                        })?;
                    }
                }
            }
        }
        write_manifest(final_manifest)
    })();

    if let Err(operation_error) = result {
        let rollback_result = rollback_transaction(&journal);
        if rollback_result.is_ok() {
            let _ = cleanup_transaction_dir(agent_name);
            return Err(operation_error);
        }
        return Err(format!(
            "{operation_error}; rollback also failed: {}",
            rollback_result.unwrap_err()
        ));
    }

    if let Err(err) = cleanup_transaction_dir(agent_name) {
        tracing::warn!(agent = agent_name, error = %err, "Committed CLI config transaction left cleanup files");
    }
    Ok(())
}
