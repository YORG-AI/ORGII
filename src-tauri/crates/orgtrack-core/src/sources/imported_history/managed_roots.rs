//! Extra discovery roots for CLI stores written by ORGII-managed sessions.
//!
//! Managed (GUI-launched) CLI runs redirect their config dirs into
//! per-account — and, for hosted-key Claude, per-session — profile dirs
//! under `~/.orgii/` (see `app_paths::*_cli_profile_root`). Native-transcript
//! mode makes those stores the transcript of record, so each source's
//! discovery walks them in addition to the user's default store location.

use std::path::{Path, PathBuf};

/// Children of an ORGII CLI profile root, each mapped through `suffix`
/// components, keeping only paths that exist. A missing root (no managed
/// sessions ever launched) yields an empty list.
pub fn profile_root_children(root: &Path, suffix: &[&str]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| {
            let mut path = entry.path();
            for component in suffix {
                path = path.join(component);
            }
            path
        })
        .filter(|path| path.is_dir())
        .collect();
    // Deterministic ordering keeps discovery fingerprints stable across scans.
    children.sort();
    children
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_existing_suffixed_children_only() {
        let root =
            std::env::temp_dir().join(format!("orgii-managed-roots-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("account-a").join("projects")).unwrap();
        std::fs::create_dir_all(root.join("account-b")).unwrap(); // no projects/
        std::fs::write(root.join("stray-file"), b"x").unwrap();

        let children = profile_root_children(&root, &["projects"]);
        assert_eq!(children, vec![root.join("account-a").join("projects")]);

        assert!(profile_root_children(&root.join("missing"), &["projects"]).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
