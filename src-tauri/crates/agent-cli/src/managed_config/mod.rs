//! Managed CLI config profiles.
//!
//! This module owns the Default <-> ORGII Managed switch for CLI config files.
//! The first managed agents expose stable user-level config files and can route
//! model traffic through a local proxy without MITM interception.
//!
//! The module is split by concern: the adapter registry lives in
//! [`registry`], the on-disk manifest in [`manifest`], crash-safe writes in
//! [`transaction`], and content generation in [`generators`]/[`adapters`].
//! This file keeps the public surface plus the operation lock that
//! serializes every switch.

mod adapters;
mod dto;
mod file_io;
mod generators;
mod manifest;
mod operations;
mod proxy;
mod registry;
mod snapshot;
mod transaction;

#[cfg(test)]
mod tests;

use std::sync::{Mutex, MutexGuard, OnceLock};

use manifest::read_manifest;
use operations::{
    enable_agent_orgii_managed_unlocked, managed_selection_for_agent_unlocked,
    restore_agent_default_unlocked, status_for_unlocked,
};
use registry::{supported_agent, unavailable_agent_message, MANAGED_CONFIG_ADAPTERS};
use transaction::recover_pending_transaction_unlocked;

/// Keep a small amount of Codex-native recovery without combining it with
/// ORGII's whole-process overload replay.
pub const CODEX_REQUEST_MAX_RETRIES: i64 = 2;
pub const CODEX_STREAM_MAX_RETRIES: i64 = 2;

/// Write the complete, ORGII-owned Codex profile used by one hosted session.
///
/// This deliberately does not merge with the user's global Codex config: the
/// caller points `CODEX_HOME` at a session-scoped directory, eliminating
/// cross-session and cross-instance last-writer-wins routing.
pub fn write_codex_hosted_profile(
    profile_dir: &std::path::Path,
    proxy_url: &str,
) -> Result<(), String> {
    let content = generators::generate_codex_hosted_profile(proxy_url)?;
    let config_path = profile_dir.join("config.toml");
    if std::fs::read_to_string(&config_path).ok().as_deref() == Some(content.as_str()) {
        return Ok(());
    }
    file_io::write_sensitive_file_atomic(&config_path, content.as_bytes())
}

/// Crash-safe replace of a CLI profile file: write an owner-only sibling temp
/// file, fsync, then rename over the target. The payload is never on disk
/// group- or world-readable, so callers holding credentials only need
/// [`app_paths::set_sensitive_file_permissions`] to pin the destination's
/// permissions (and to cover Windows ACLs) — and get to decide for themselves
/// whether a failure there is fatal.
pub fn write_cli_profile_file_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    file_io::write_file_atomic(path, bytes)
}

pub use dto::{
    CliConfigManagedStatus, CliConfigMode, CliConfigProfileManifest,
    CliConfigShutdownRestoreReport, CliConfigTargetFileManifest, CliConfigTargetFileStatus,
    CliManagedConfigSelection,
};
pub use proxy::{managed_proxy_port, managed_proxy_url, set_managed_proxy_port_default};
pub use registry::{
    managed_config_availability_for_agent, managed_config_unavailable_reason_for_agent,
    managed_proxy_protocol_for_agent, CliManagedConfigAvailability, CliManagedProxyProtocol,
};

static CONFIG_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn config_operation_guard() -> Result<MutexGuard<'static, ()>, String> {
    CONFIG_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "CLI config operation lock is poisoned".to_string())
}

pub fn managed_selection_for_agent(
    agent_name: &str,
) -> Result<Option<CliManagedConfigSelection>, String> {
    let _guard = config_operation_guard()?;
    recover_pending_transaction_unlocked(agent_name)?;
    managed_selection_for_agent_unlocked(agent_name)
}

pub fn enable_orgii_managed(
    agent_name: &str,
    key_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    force: bool,
) -> Result<CliConfigManagedStatus, String> {
    let _guard = config_operation_guard()?;
    recover_pending_transaction_unlocked(agent_name)?;
    if !supported_agent(agent_name) {
        return Err(unavailable_agent_message(agent_name));
    }
    enable_agent_orgii_managed_unlocked(agent_name, key_id, provider, model, force)
}

/// Restore active managed CLI configs before the ORGII process exits.
///
/// Shutdown restoration is deliberately non-forcing: a config edited outside
/// ORGII is left untouched and reported instead of being overwritten.
pub fn restore_managed_configs_for_shutdown() -> Result<CliConfigShutdownRestoreReport, String> {
    let _guard = config_operation_guard()?;
    let mut report = CliConfigShutdownRestoreReport::default();

    for adapter in MANAGED_CONFIG_ADAPTERS {
        let agent_name = adapter.agent_name;
        if let Err(err) = recover_pending_transaction_unlocked(agent_name) {
            report.failed_agents.push((agent_name.to_string(), err));
            continue;
        }

        let managed_active = match read_manifest(agent_name) {
            Ok(Some(manifest)) => manifest.mode == CliConfigMode::OrgiiManaged,
            Ok(None) => false,
            Err(err) => {
                report.failed_agents.push((agent_name.to_string(), err));
                continue;
            }
        };
        if !managed_active {
            continue;
        }
        match restore_agent_default_unlocked(agent_name, false) {
            Ok(_) => report.restored_agents.push(agent_name.to_string()),
            Err(err) => report.failed_agents.push((agent_name.to_string(), err)),
        }
    }

    Ok(report)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_get_status(agent_name: String) -> Result<CliConfigManagedStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = config_operation_guard()?;
        recover_pending_transaction_unlocked(&agent_name)?;
        status_for_unlocked(&agent_name)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_restore_default(
    agent_name: String,
    force: bool,
) -> Result<CliConfigManagedStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = config_operation_guard()?;
        recover_pending_transaction_unlocked(&agent_name)?;
        if !supported_agent(&agent_name) {
            return Err(unavailable_agent_message(&agent_name));
        }
        restore_agent_default_unlocked(&agent_name, force)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
