//! Cross-process coordination for ORGII instances sharing native CLI targets.
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use fs2::FileExt;

fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|_| "Cannot resolve CLI configuration target".into());
    }
    let parent = path
        .parent()
        .ok_or("CLI configuration target has no parent")?;
    Ok(canonical_target(parent)?.join(path.file_name().ok_or("Invalid CLI target")?))
}

pub(super) fn lock_targets(agent: &str) -> Result<Vec<File>, String> {
    if !super::registry::supported_agent(agent) {
        return Ok(Vec::new());
    }
    let mut paths = super::manifest::agent_manifest_targets(agent)?
        .into_iter()
        .map(|target| canonical_target(Path::new(&target.target_path)))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(manifest) = super::manifest::read_manifest(agent)? {
        for target in manifest.target_files {
            paths.push(canonical_target(Path::new(&target.target_path))?);
        }
    }
    paths.push(canonical_target(&super::manifest::manifest_path(agent))?);
    paths.sort();
    paths.dedup();
    paths.into_iter().map(|path| {
        let hash = super::file_io::sha256_bytes(path.to_string_lossy().as_bytes());
        let lock_path = std::env::temp_dir().join(format!("orgii-cli-{}.lock", hash.trim_start_matches("sha256:")));
        if lock_path.is_symlink() {
            return Err("CLI configuration lock must not be a symbolic link".into());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&lock_path).map_err(|_| "Cannot open CLI configuration lock")?;
        file.try_lock_exclusive().map_err(|_| "Another ORGII process is changing this harness configuration. Try again when it finishes.")?;
        Ok(file)
    }).collect()
}
