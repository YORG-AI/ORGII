//! Test helpers for downstream workspace crates.
//!
//! Only compiled when the `testing` feature is enabled (typically via a
//! crate's `[dev-dependencies]`). Keeps the runtime surface of `app_utils`
//! free of `tempfile` for production builds.

use std::path::PathBuf;
use tempfile::TempDir;

/// Create a temp directory pre-populated with files.
///
/// Each entry is `(relative_path, content)`. Parent directories are created
/// automatically.
///
/// Returns `(TempDir, root_path)` — keep the `TempDir` alive for the duration
/// of the test or the directory will be deleted.
pub fn temp_dir_with_files(entries: &[(&str, &str)]) -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("failed to create temp dir");
    for (rel_path, content) in entries {
        let full = dir.path().join(rel_path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        std::fs::write(&full, content).expect("failed to write temp file");
    }
    let root = dir.path().to_path_buf();
    (dir, root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_dir_with_files_creates_nested_fixtures_and_keeps_root_alive() {
        let (dir, root) = temp_dir_with_files(&[
            ("README.md", "root"),
            ("src/nested/main.rs", "fn main() {}"),
        ]);

        assert_eq!(root, dir.path());
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).expect("read root fixture"),
            "root"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/nested/main.rs")).expect("read nested fixture"),
            "fn main() {}"
        );
    }
}
