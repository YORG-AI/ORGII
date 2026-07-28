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

pub(super) fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("Failed to create {}: {err}", dir.display()))?;
    }

    let tmp = unique_temp_path(path);
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)
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
