//! Disk-usage and storage-management Tauri commands.
//!
//! Composes `~/.orgii/` path helpers from the `app_paths` workspace crate
//! into a single per-category storage report consumed by the Settings →
//! Disk Usage UI, plus a one-shot "clear category" command.
//!
//! Path helpers themselves live in `app_paths`. Callers that just need a
//! single path (e.g. `app_paths::logs_dir()`) should import from there
//! directly instead of going through this module.

use std::path::{Path, PathBuf};

use app_paths::{
    agent_worktrees_root, claude_code_cli_profile_root, codex_cli_profile_root,
    codex_hosted_cli_profile_root, cursor_cli_profile_root, cursor_config_root, diagnostics_dir,
    extensions_dir, file_history_root, kiro_cli_profile_root, logs_dir, lsp_bin_dir, models_dir,
    opencode_cli_profile_root, orgii_root, personal_workspace, screenshots_dir, semantic_index_dir,
    session_images_dir, sessions_db, sidecar_bin_dir, tool_results_root,
};

/// Tauri command: path where agent memory (KG) is stored: `~/.orgii/sessions.db`.
#[tauri::command]
pub fn get_memory_storage_path() -> String {
    sessions_db().to_string_lossy().to_string()
}

/// Tauri command: cross-platform system temp directory.
#[tauri::command]
pub fn get_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

/// A single storage category for the disk-usage report.
#[derive(serde::Serialize, Clone, Debug)]
pub struct StorageCategory {
    pub key: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    pub exists: bool,
    /// True if the path is a directory (open folder); false if a file (reveal in explorer).
    pub is_folder: bool,
}

/// Full disk-usage report returned to the frontend.
#[derive(serde::Serialize, Clone, Debug)]
pub struct DiskUsageReport {
    pub root_path: String,
    pub categories: Vec<StorageCategory>,
    pub total_bytes: u64,
}

/// Recursively compute the size of a directory (or single file) in bytes.
fn dir_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    if path.is_file() {
        return path.metadata().map(|m| m.len()).unwrap_or(0);
    }
    let mut total: u64 = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            } else if ft.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    total
}

/// Tauri command: compute disk usage for all known storage locations.
#[tauri::command]
pub fn get_disk_usage() -> DiskUsageReport {
    let categories_spec: Vec<(&str, &str, PathBuf)> = vec![
        ("sessionsDb", "Sessions Database", sessions_db()),
        ("logs", "Logs", logs_dir()),
        ("fileHistory", "Session File History", file_history_root()),
        (
            "personalWorkspace",
            "OS Agent Workspace",
            personal_workspace(),
        ),
        ("cursorConfig", "Session CLI Configs", cursor_config_root()),
        (
            "cursorCliProfiles",
            "Cursor CLI Profiles",
            cursor_cli_profile_root(),
        ),
        (
            "claudeCodeCliProfiles",
            "Claude Code CLI Profiles",
            claude_code_cli_profile_root(),
        ),
        (
            "codexCliProfiles",
            "Codex CLI Profiles",
            codex_cli_profile_root(),
        ),
        (
            "codexHostedCliProfiles",
            "Hosted Codex Session Profiles",
            codex_hosted_cli_profile_root(),
        ),
        (
            "kiroCliProfiles",
            "Kiro CLI Profiles",
            kiro_cli_profile_root(),
        ),
        (
            "opencodeCliProfiles",
            "OpenCode CLI Profiles",
            opencode_cli_profile_root(),
        ),
        ("extensions", "Extensions", extensions_dir()),
        ("sessionImages", "Chat Images", session_images_dir()),
        ("screenshots", "Browser Screenshots", screenshots_dir()),
        ("toolResults", "Oversized Tool Results", tool_results_root()),
        ("diagnostics", "Diagnostics Queue", diagnostics_dir()),
        ("models", "Downloaded Models", models_dir()),
        (
            "semanticIndex",
            "Semantic Search Index",
            semantic_index_dir(),
        ),
        (
            "agentWorktrees",
            "Agent Session Worktrees",
            agent_worktrees_root(),
        ),
        ("lspBin", "LSP Server Binaries", lsp_bin_dir()),
        (
            "sidecarBin",
            "Downloaded Sidecar Binaries",
            sidecar_bin_dir(),
        ),
    ];

    let categories: Vec<StorageCategory> = categories_spec
        .into_iter()
        .map(|(key, label, path)| {
            let size_bytes = dir_size(&path);
            let is_folder = path.exists() && path.is_dir();
            StorageCategory {
                key: key.to_string(),
                label: label.to_string(),
                path: path.to_string_lossy().to_string(),
                size_bytes,
                exists: path.exists(),
                is_folder,
            }
        })
        .collect();

    let total_bytes = categories.iter().map(|c| c.size_bytes).sum();

    DiskUsageReport {
        root_path: orgii_root().to_string_lossy().to_string(),
        categories,
        total_bytes,
    }
}

/// Map a category key back to its filesystem path.
fn category_path(key: &str) -> Option<PathBuf> {
    match key {
        "logs" => Some(logs_dir()),
        "fileHistory" => Some(file_history_root()),
        "personalWorkspace" => Some(personal_workspace()),
        "cursorConfig" => Some(cursor_config_root()),
        "cursorCliProfiles" => Some(cursor_cli_profile_root()),
        "claudeCodeCliProfiles" => Some(claude_code_cli_profile_root()),
        "codexCliProfiles" => Some(codex_cli_profile_root()),
        "codexHostedCliProfiles" => Some(codex_hosted_cli_profile_root()),
        "kiroCliProfiles" => Some(kiro_cli_profile_root()),
        "opencodeCliProfiles" => Some(opencode_cli_profile_root()),
        "extensions" => Some(extensions_dir()),
        "sessionImages" => Some(session_images_dir()),
        "agentWorktrees" => Some(agent_worktrees_root()),
        "screenshots" => Some(screenshots_dir()),
        "toolResults" => Some(tool_results_root()),
        "diagnostics" => Some(diagnostics_dir()),
        "models" => Some(models_dir()),
        "semanticIndex" => Some(semantic_index_dir()),
        "lspBin" => Some(lsp_bin_dir()),
        "sidecarBin" => Some(sidecar_bin_dir()),
        _ => None,
    }
}

/// Categories that must NOT be cleared from the UI.
const PROTECTED_CATEGORIES: &[&str] = &["sessionsDb"];

/// Tauri command: clear (delete contents of) a storage category.
///
/// Returns the number of bytes freed. Protected categories (e.g. sessionsDb)
/// are rejected with an error.
#[tauri::command]
pub fn clear_storage_category(key: String) -> Result<u64, String> {
    if PROTECTED_CATEGORIES.contains(&key.as_str()) {
        return Err(format!("Category '{}' cannot be cleared", key));
    }

    let path = category_path(&key).ok_or_else(|| format!("Unknown storage category: {}", key))?;

    if !path.exists() {
        return Ok(0);
    }

    let freed = dir_size(&path);

    if path.is_file() {
        std::fs::remove_file(&path)
            .map_err(|err| format!("Failed to remove {}: {}", path.display(), err))?;
    } else {
        std::fs::remove_dir_all(&path)
            .map_err(|err| format!("Failed to remove {}: {}", path.display(), err))?;
        // Recreate the empty directory so future writes don't fail.
        std::fs::create_dir_all(&path)
            .map_err(|err| format!("Failed to recreate {}: {}", path.display(), err))?;
    }

    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_usage_categories_have_clear_paths_except_protected_files() {
        let report = get_disk_usage();
        for category in report.categories {
            if PROTECTED_CATEGORIES.contains(&category.key.as_str()) {
                continue;
            }
            assert!(
                category_path(&category.key).is_some(),
                "{} should be clearable or explicitly protected",
                category.key
            );
        }
    }

    #[test]
    fn new_storage_roots_are_reported() {
        let report = get_disk_usage();
        let keys: std::collections::HashSet<_> = report
            .categories
            .iter()
            .map(|category| category.key.as_str())
            .collect();

        for expected in [
            "toolResults",
            "diagnostics",
            "models",
            "semanticIndex",
            "cursorCliProfiles",
            "kiroCliProfiles",
            "opencodeCliProfiles",
            "sidecarBin",
        ] {
            assert!(keys.contains(expected), "missing {expected}");
        }
    }
}
