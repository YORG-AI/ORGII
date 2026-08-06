//! Path syntax validation on [`SecurityPolicy`].
//!
//! Split from `policy/mod.rs` purely for file-size hygiene; these
//! methods retain access to private fields because Rust permits child
//! modules to read parent-module privates.
//!
//! Path *containment* (is this path inside the session's allowed
//! roots?) is NOT decided here — the single source of truth for that
//! is `core::session::workspace::SessionWorkspace::is_path_allowed`.
//! This module only rejects syntactically dangerous paths and the
//! user-configured forbidden list.

use std::path::{Component, Path, PathBuf};

use super::SecurityPolicy;

impl SecurityPolicy {
    /// Validate path *syntax* and the configured forbidden list.
    ///
    /// Rejects null bytes, `..` components, URL-encoded traversal, and
    /// any path inside `forbidden_paths`. Containment against the
    /// session workspace is the caller's responsibility (combine with
    /// `SessionWorkspace::is_path_allowed` when `workspace_only`).
    pub fn validate_path_syntax(&self, path: &str) -> Result<(), String> {
        if path.contains('\0') {
            return Err("Path contains null bytes.".into());
        }

        let parsed = Path::new(path);

        for component in parsed.components() {
            if matches!(component, Component::ParentDir) {
                return Err("Path traversal (..) is not allowed.".into());
            }
        }

        let lower = path.to_lowercase();
        if lower.contains("..%2f")
            || lower.contains("%2f..")
            || lower.contains("..%5c")
            || lower.contains("%5c..")
        {
            return Err("URL-encoded path traversal is not allowed.".into());
        }

        let expanded = expand_home(path);
        if self.is_forbidden_path(&expanded) {
            return Err(format!("Path '{}' is in a forbidden location.", path));
        }

        Ok(())
    }

    /// Validate a resolved path against explicit forbidden roots.
    ///
    /// This second pass follows existing symlinks (and the parent of a new
    /// file) before comparing roots, so an exemption can never be used to
    /// tunnel into a forbidden directory through a symlink spelling.
    pub fn validate_resolved_path(&self, path: &Path) -> Result<(), String> {
        let canonical = canonicalize_candidate(path);
        if self.is_forbidden_path(&canonical) {
            return Err(format!(
                "Path '{}' is in a forbidden location.",
                path.display()
            ));
        }
        Ok(())
    }

    fn is_forbidden_path(&self, path: &Path) -> bool {
        self.forbidden_paths.iter().any(|forbidden| {
            let canonical = canonicalize_candidate(&expand_home(forbidden));
            path.starts_with(&canonical)
        })
    }
}

fn canonicalize_candidate(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }

    // A new target may be several components below an existing symlink.
    // Resolve the nearest existing ancestor rather than only its immediate
    // parent, then restore the missing tail so forbidden-root checks retain
    // the symlink's actual destination.
    let mut ancestor = path;
    let mut missing_suffix = Vec::new();
    loop {
        if let Ok(canonical_ancestor) = ancestor.canonicalize() {
            return missing_suffix
                .iter()
                .rev()
                .fold(canonical_ancestor, |resolved, component| {
                    resolved.join(component)
                });
        }

        let Some(file_name) = ancestor.file_name() else {
            break;
        };
        missing_suffix.push(file_name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }

    crate::foundation::tool_infra::file::normalize_lexical(path)
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    }
    if let Some(suffix) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(suffix);
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::{AutonomyLevel, CommandRiskRules};

    #[test]
    fn canonical_forbidden_root_wins_over_a_symlink_spelling() {
        let temp = tempfile::tempdir().unwrap();
        let forbidden = temp.path().join("forbidden");
        let alias = temp.path().join("alias");
        std::fs::create_dir_all(&forbidden).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&forbidden, &alias).unwrap();

        let policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            true,
            Vec::new(),
            Vec::new(),
            vec![forbidden.to_string_lossy().into_owned()],
            true,
            CommandRiskRules::default(),
        );
        #[cfg(unix)]
        let candidate = alias.join("new-parent").join("new-file.txt");
        #[cfg(not(unix))]
        let candidate = forbidden.join("new-parent").join("new-file.txt");

        assert!(policy.validate_resolved_path(&candidate).is_err());
    }
}
