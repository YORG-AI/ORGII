//! CRUD for project asset files (images, attachments, large blobs).
//!
//! Assets live on disk, not in the DB. The store is per-project under
//! `~/.orgii/projects/assets/{project_id}/`. Each public function takes
//! the project SLUG (the same identifier every other IO module uses);
//! we resolve `slug → project_id` once via a single indexed read, then
//! resolve the on-disk path from the ID. Centralising this lookup
//! keeps the assets dir keyed by stable identity even if the slug is
//! later renamed.
//!
//! Writes are atomic via a `.tmp` file + rename so a crash mid-write
//! never leaves a half-baked binary on disk.

use std::fs;

use crate::projects::io::projects::read_project;
use crate::projects::paths::project_assets_dir;

/// Save a binary asset to the project's assets directory and return
/// the relative `assets/{filename}` path that markdown bodies should
/// reference.
///
/// The relative form is what gets persisted in work-item bodies; the
/// absolute path is resolved by `resolve_asset_path` at render time so
/// renaming or moving the orgii root is harmless.
pub fn save_asset(project_slug: &str, filename: &str, data: &[u8]) -> Result<String, String> {
    validate_asset_filename(filename)?;

    let project_id = resolve_project_id(project_slug)?;
    let dir = project_assets_dir(&project_id);
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create assets dir: {}", err))?;

    let target = dir.join(filename);
    let temp = target.with_extension("tmp");
    fs::write(&temp, data).map_err(|err| format!("Failed to write asset {}: {}", filename, err))?;
    fs::rename(&temp, &target)
        .map_err(|err| format!("Failed to rename asset {}: {}", filename, err))?;

    Ok(format!("assets/{}", filename))
}

/// Delete an asset by filename. Returns an error if the file does not
/// exist so callers can distinguish a missing reference from a silent
/// no-op (the legacy contract — sync flows depend on this signal).
pub fn delete_asset(project_slug: &str, filename: &str) -> Result<(), String> {
    validate_asset_filename(filename)?;

    let project_id = resolve_project_id(project_slug)?;
    let path = project_assets_dir(&project_id).join(filename);
    if !path.exists() {
        return Err(format!("Asset '{}' not found", filename));
    }
    fs::remove_file(&path).map_err(|err| format!("Failed to delete asset '{}': {}", filename, err))
}

/// List every filename in the project's assets directory, sorted
/// lexicographically. Returns an empty list (NOT an error) when the
/// directory doesn't exist yet — newly-created projects have no
/// assets dir until the first `save_asset` call.
pub fn list_assets(project_slug: &str) -> Result<Vec<String>, String> {
    let project_id = resolve_project_id(project_slug)?;
    let dir = project_assets_dir(&project_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&dir).map_err(|err| format!("Failed to read assets dir: {}", err))?;

    let mut filenames = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Dir entry error: {}", err))?;
        // Skip the `.tmp` files left behind by an interrupted write.
        // They're not real assets and surfacing them would let a half-
        // written upload bleed into the UI.
        if entry.path().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.ends_with(".tmp") {
                    filenames.push(name.to_string());
                }
            }
        }
    }
    filenames.sort();
    Ok(filenames)
}

/// Resolve the absolute filesystem path for an asset. Used by Tauri's
/// `convertFileSrc` to render images via the asset protocol.
pub fn resolve_asset_path(project_slug: &str, filename: &str) -> Result<String, String> {
    validate_asset_filename(filename)?;

    let project_id = resolve_project_id(project_slug)?;
    let path = project_assets_dir(&project_id).join(filename);
    if !path.exists() {
        return Err(format!("Asset '{}' not found", filename));
    }
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

fn resolve_project_id(project_slug: &str) -> Result<String, String> {
    Ok(read_project(project_slug)?.meta.id)
}

/// Reject filenames that try to escape the assets directory (path
/// traversal) or smuggle in directory components. This matches the
/// legacy file-layer's implicit assumption — `project_assets_dir(id)
/// .join(filename)` would happily resolve `../foo` under the orgii root
/// and we want a hard, explicit error instead of silent corruption.
fn validate_asset_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("Asset filename cannot be empty".to_string());
    }
    if filename.contains('/') || filename.contains('\\') {
        return Err(format!(
            "Asset filename '{}' must not contain path separators",
            filename
        ));
    }
    if filename == "." || filename == ".." {
        return Err(format!("Asset filename '{}' is reserved", filename));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::projects::write_project;
    use crate::projects::types::ProjectMeta;
    use test_helpers::test_env;

    fn project_meta(id: &str) -> ProjectMeta {
        ProjectMeta {
            id: id.to_string(),
            name: "Demo".to_string(),
            org_id: "personal-org".to_string(),
            workspace_id: None,
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn seed() {
        write_project("demo", &project_meta("p1"), "", true).expect("project");
    }

    #[test]
    fn save_returns_relative_path() {
        let _sandbox = test_env::sandbox();
        seed();
        let rel = save_asset("demo", "logo.png", b"PNGDATA").expect("save");
        assert_eq!(rel, "assets/logo.png");
    }

    #[test]
    fn save_then_resolve_returns_existing_absolute_path() {
        let _sandbox = test_env::sandbox();
        seed();
        save_asset("demo", "logo.png", b"PNGDATA").expect("save");

        let abs = resolve_asset_path("demo", "logo.png").expect("resolve");
        assert!(abs.ends_with("logo.png"));
        assert!(std::path::Path::new(&abs).exists());
    }

    #[test]
    fn save_overwrites_existing_asset() {
        let _sandbox = test_env::sandbox();
        seed();
        save_asset("demo", "doc.txt", b"v1").expect("v1");
        save_asset("demo", "doc.txt", b"v2-longer").expect("v2");

        let abs = resolve_asset_path("demo", "doc.txt").expect("resolve");
        let bytes = std::fs::read(abs).expect("read");
        assert_eq!(bytes, b"v2-longer");
    }

    #[test]
    fn list_returns_empty_for_project_without_assets_dir() {
        let _sandbox = test_env::sandbox();
        seed();
        let list = list_assets("demo").expect("list");
        assert!(list.is_empty());
    }

    #[test]
    fn list_returns_sorted_filenames_and_skips_tmp_writes() {
        // Drop a stray `.tmp` directly under the assets dir to mimic
        // a crashed save. `list_assets` must hide it from the UI.
        let _sandbox = test_env::sandbox();
        seed();
        save_asset("demo", "b.png", b"b").expect("b");
        save_asset("demo", "a.png", b"a").expect("a");
        let dir = project_assets_dir("p1");
        std::fs::write(dir.join("c.tmp"), b"crash").expect("tmp");

        let list = list_assets("demo").expect("list");
        assert_eq!(list, vec!["a.png".to_string(), "b.png".into()]);
    }

    #[test]
    fn delete_removes_file_and_subsequent_resolve_fails() {
        let _sandbox = test_env::sandbox();
        seed();
        save_asset("demo", "logo.png", b"x").expect("save");
        delete_asset("demo", "logo.png").expect("delete");

        let err = resolve_asset_path("demo", "logo.png").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn delete_unknown_file_errors_so_callers_can_detect_drift() {
        let _sandbox = test_env::sandbox();
        seed();
        let err = delete_asset("demo", "ghost.png").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn unknown_project_slug_errors_uniformly() {
        let _sandbox = test_env::sandbox();
        // No `seed()` — project doesn't exist.
        for op in [
            save_asset("ghost", "x.png", b"x").err(),
            delete_asset("ghost", "x.png").err(),
            list_assets("ghost").err(),
            resolve_asset_path("ghost", "x.png").err(),
        ] {
            assert!(
                op.as_deref().unwrap_or("").to_lowercase().contains("ghost"),
                "expected ghost in error, got {:?}",
                op
            );
        }
    }

    #[test]
    fn rejects_path_traversal_filenames() {
        let _sandbox = test_env::sandbox();
        seed();
        for bad in [
            "../escape.png",
            "sub/inner.png",
            "..\\win.png",
            "",
            ".",
            "..",
        ] {
            let err = save_asset("demo", bad, b"x").unwrap_err();
            assert!(
                !err.is_empty(),
                "expected save_asset to reject filename {:?}",
                bad
            );
        }
    }

    #[test]
    fn resolve_rejects_traversal_even_if_target_exists() {
        // Even if some malicious caller has placed a file at a relative
        // location, validation must reject the request before we touch
        // the filesystem at all.
        let _sandbox = test_env::sandbox();
        seed();
        let err = resolve_asset_path("demo", "../etc/passwd").unwrap_err();
        assert!(err.contains("path separators"));
    }
}
