//! Timestamp, hashing and atomic file-write primitives used by every
//! managed-config write path.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub(super) fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

pub(super) fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

pub(super) fn file_hash(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|err| format!("Failed to read {} for hashing: {err}", path.display()))?;
    Ok(Some(sha256_bytes(&bytes)))
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_nanos()
    ))
}

/// Create the staging file for an atomic write, owner-only.
///
/// The mode has to be set at creation because the temp file holds the payload
/// before the caller gets a chance to tighten permissions on the destination:
/// with a 0002 umask a plain create lands at 0664, so a credential would be
/// group-readable for the whole write, and would stay that way in a temp file
/// left behind by a crash.
///
/// There is no loose variant because nothing here wants one — every
/// destination in this module ends up 0600 anyway, via
/// [`app_paths::set_sensitive_file_permissions`].
fn create_staging_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    // The name carries pid + nanos, so `create_new` never collides in
    // practice; it does guarantee we never inherit the mode of a file somebody
    // else left at this path.
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Crash-safe replace: write an owner-only sibling temp file, fsync, then
/// rename over the target.
pub(super) fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("Failed to create {}: {err}", dir.display()))?;
    }

    let tmp = unique_temp_path(path);
    let result = (|| {
        let mut file = create_staging_file(&tmp)
            .map_err(|err| format!("Failed to create {}: {err}", tmp.display()))?;
        use std::io::Write;
        file.write_all(bytes)
            .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
        file.sync_all()
            .map_err(|err| format!("Failed to flush {}: {err}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|err| {
            format!(
                "Failed to move {} to {}: {err}",
                tmp.display(),
                path.display()
            )
        })?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub(super) fn write_sensitive_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_file_atomic(path, bytes)?;
    if let Err(err) = app_paths::set_sensitive_file_permissions(path) {
        tracing::warn!(path = %path.display(), error = %err, "Failed to secure CLI config profile file");
    }
    Ok(())
}
