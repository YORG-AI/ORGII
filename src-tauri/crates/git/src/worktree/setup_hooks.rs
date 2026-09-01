//! Discovery and orchestration of the per-repo `worktrees.json` setup hooks
//! that run inside a freshly created worktree.

use std::path::Path;
use std::time::Duration;

use tracing::info;

use super::run_worktree_setup_command_with_timeout;

const WORKTREE_CONFIG_DIR: &str = ".cursor";
const WORKTREE_CONFIG_FILE: &str = "worktrees.json";
/// Legacy config path (pre-.cursor migration). Checked as a fallback so
/// existing repos that have not migrated still get their hooks executed.
const WORKTREE_CONFIG_LEGACY_DIR: &str = ".orgii";
const SETUP_WORKTREE_KEY: &str = "setup-worktree";
const SETUP_WORKTREE_UNIX_KEY: &str = "setup-worktree-unix";
const SETUP_WORKTREE_WINDOWS_KEY: &str = "setup-worktree-windows";
const WORKTREE_SETUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

pub(super) fn run_worktree_setup_hooks(
    repo_path: &Path,
    worktree_path: &Path,
) -> Result<(), String> {
    // Prefer the canonical path; fall back to the legacy .orgii path so that
    // repos which have not migrated yet still have their hooks executed.
    let config_path = {
        let canonical = repo_path
            .join(WORKTREE_CONFIG_DIR)
            .join(WORKTREE_CONFIG_FILE);
        if canonical.exists() {
            canonical
        } else {
            let legacy = repo_path
                .join(WORKTREE_CONFIG_LEGACY_DIR)
                .join(WORKTREE_CONFIG_FILE);
            if legacy.exists() {
                info!(
                    "[worktree] Using legacy config at {}; consider migrating to {}",
                    legacy.display(),
                    repo_path
                        .join(WORKTREE_CONFIG_DIR)
                        .join(WORKTREE_CONFIG_FILE)
                        .display()
                );
                legacy
            } else {
                return Ok(());
            }
        }
    };

    let content = std::fs::read_to_string(&config_path)
        .map_err(|err| format!("failed to read {}: {}", config_path.display(), err))?;
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse {}: {}", config_path.display(), err))?;

    let mut commands = setup_commands_for_platform(&parsed)?;
    if commands.is_empty() {
        return Ok(());
    }

    info!(
        "[worktree] Running {} setup hook(s) in {}",
        commands.len(),
        worktree_path.display()
    );

    for command in commands.drain(..) {
        run_worktree_setup_command(repo_path, worktree_path, &command)?;
    }

    Ok(())
}

fn setup_commands_for_platform(config: &serde_json::Value) -> Result<Vec<String>, String> {
    let mut commands = read_setup_command_array(config, SETUP_WORKTREE_KEY)?;
    let platform_key = if cfg!(windows) {
        SETUP_WORKTREE_WINDOWS_KEY
    } else {
        SETUP_WORKTREE_UNIX_KEY
    };
    commands.extend(read_setup_command_array(config, platform_key)?);
    Ok(commands)
}

fn read_setup_command_array(config: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    let Some(value) = config.get(key) else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .ok_or_else(|| format!("{} must be an array of shell command strings", key))?;
    let mut commands = Vec::with_capacity(array.len());
    for entry in array {
        let command = entry
            .as_str()
            .ok_or_else(|| format!("{} entries must be shell command strings", key))?
            .trim();
        if !command.is_empty() {
            commands.push(command.to_string());
        }
    }
    Ok(commands)
}

fn run_worktree_setup_command(
    repo_path: &Path,
    worktree_path: &Path,
    command: &str,
) -> Result<(), String> {
    run_worktree_setup_command_with_timeout(
        repo_path,
        worktree_path,
        command,
        WORKTREE_SETUP_COMMAND_TIMEOUT,
    )
}
