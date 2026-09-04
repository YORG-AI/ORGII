//! Skill environment variable storage.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Path to the skill env config file: `~/.orgii/skill-env.json`.
fn skill_env_path() -> PathBuf {
    app_paths::orgii_root().join("skill-env.json")
}

/// Load skill env vars from `~/.orgii/skill-env.json`.
///
/// Returns empty map if file is missing (first-run is normal). If the
/// file exists but is unreadable or invalid JSON, we log a warning and
/// return empty rather than crashing. We do NOT silently fold corrupted
/// content into a default save (callers only call save_to with explicit
/// user-provided content), so this is safe.
fn load_skill_env() -> HashMap<String, String> {
    let path = skill_env_path();
    if !path.exists() {
        return HashMap::new();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "skill-env.json is unreadable; using empty defaults"
            );
            return HashMap::new();
        }
    };
    match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "skill-env.json is invalid JSON; using empty defaults"
            );
            HashMap::new()
        }
    }
}

/// Load skill env vars from disk and inject them into the current process.
///
/// Called once at app startup so that `std::env::var()` checks in
/// `check_requirements` work even when the app is launched from the GUI
/// (which does not inherit shell environment variables on macOS).
pub fn load_and_apply_skill_env() {
    let env_vars = load_skill_env();
    for (key, value) in &env_vars {
        if !value.is_empty() {
            std::env::set_var(key, value);
        }
    }
    if !env_vars.is_empty() {
        tracing::info!(
            "[skills] Loaded {} env var(s) from skill-env.json",
            env_vars.len()
        );
    }
}
