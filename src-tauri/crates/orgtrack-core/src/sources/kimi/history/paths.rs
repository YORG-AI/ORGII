//! Kimi filesystem roots plus the symlink- and layout-exact path guards.

use std::fs;
use std::path::{Component, Path, PathBuf};

use super::identity::{KimiLayout, MAX_ID_BYTES};

/// Candidate roots used by both importer and source detection.
///
/// An ambient `KIMI_CODE_HOME` is honored only when it resolves within the
/// current external-history identity. Secondary instances therefore cannot
/// inherit the primary user's custom Kimi path accidentally.
pub fn kimi_history_candidate_paths() -> Vec<PathBuf> {
    let home = app_paths::external_history_home_dir();
    vec![
        home.join(".kimi").join("sessions"),
        kimi_code_home_for(&home, std::env::var_os("KIMI_CODE_HOME").as_deref()).join("sessions"),
    ]
}

pub(super) fn kimi_code_home_for(home: &Path, configured: Option<&std::ffi::OsStr>) -> PathBuf {
    let fallback = home.join(".kimi-code");
    let Some(configured) = configured.filter(|value| !value.is_empty()) else {
        return fallback;
    };
    let configured_path = Path::new(configured);
    let candidate = if configured_path.is_absolute() {
        configured_path.to_path_buf()
    } else if configured_path
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
    {
        home.join(configured_path)
    } else {
        return fallback;
    };
    if candidate
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return fallback;
    }
    let canonical_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let canonical_candidate =
        fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.to_path_buf());
    if canonical_candidate.starts_with(&canonical_home) {
        candidate
    } else {
        fallback
    }
}

pub(super) fn source_id_for_relative(layout: KimiLayout, relative: &Path) -> Option<String> {
    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let parts = match layout {
        KimiLayout::Legacy if components.len() == 3 && components[2] == "wire.jsonl" => {
            vec!["cli", components[0], components[1]]
        }
        KimiLayout::Code
            if components.len() == 5
                && components[2] == "agents"
                && components[4] == "wire.jsonl" =>
        {
            vec!["code", components[0], components[1], components[3]]
        }
        _ => return None,
    };
    if parts
        .iter()
        .any(|part| part.is_empty() || part.len() > MAX_ID_BYTES || *part == "." || *part == "..")
    {
        return None;
    }
    Some(parts.join("/"))
}

pub(super) fn ensure_exact_safe_history_file(
    path: &Path,
    root: &Path,
    identity_home: &Path,
    layout: KimiLayout,
) -> Result<(), String> {
    ensure_safe_history_root(root, identity_home)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Kimi history path escaped its configured root".to_string())?;
    if source_id_for_relative(layout, relative).is_none() {
        return Err("Kimi history path does not match the exact provider layout".to_string());
    }

    let mut current = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err("Kimi history path contains an unsafe component".to_string());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|err| {
            format!(
                "Failed to inspect Kimi history {}: {err}",
                current.display()
            )
        })?;
        let is_leaf = components.peek().is_none();
        if metadata.file_type().is_symlink()
            || (is_leaf && !metadata.is_file())
            || (!is_leaf && !metadata.is_dir())
        {
            return Err(format!(
                "Refusing unsafe Kimi history path: {}",
                current.display()
            ));
        }
    }

    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect Kimi history {}: {err}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Refusing unsafe Kimi history path: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(super) fn ensure_safe_history_root(root: &Path, identity_home: &Path) -> Result<(), String> {
    ensure_safe_descendant(root, identity_home, false)
}

pub(super) fn ensure_safe_descendant(
    path: &Path,
    identity_home: &Path,
    leaf_is_file: bool,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(identity_home)
        .map_err(|_| "Kimi path escaped its external-history identity".to_string())?;
    let mut current = fs::canonicalize(identity_home).map_err(|error| {
        format!(
            "Failed to resolve Kimi external-history identity {}: {error}",
            identity_home.display()
        )
    })?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err("Kimi path contains an unsafe component".to_string());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            format!("Failed to inspect Kimi path {}: {error}", current.display())
        })?;
        let is_leaf = components.peek().is_none();
        if metadata.file_type().is_symlink()
            || (is_leaf && leaf_is_file && !metadata.is_file())
            || ((!is_leaf || !leaf_is_file) && !metadata.is_dir())
        {
            return Err(format!("Refusing unsafe Kimi path: {}", current.display()));
        }
    }
    Ok(())
}
