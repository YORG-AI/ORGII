use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// Return `(modified_at_ns, size_bytes)` for `path`.
///
/// The modified time is reported at **nanosecond** granularity (stored in the
/// `source_mtime_ms`-named columns/fields, which now carry nanoseconds) so that
/// rapid in-place edits within the same millisecond still change the signature.
/// The value stays an `i64` count of nanoseconds since the Unix epoch, which is
/// well within range until the year 2262.
pub fn file_metadata_signature(path: &Path, source_name: &str) -> Result<(i64, i64), String> {
    let metadata = path
        .metadata()
        .map_err(|err| format!("Failed to read {source_name} file metadata: {err}"))?;
    let modified_at_ns = metadata
        .modified()
        .map_err(|err| format!("Failed to read {source_name} file modified time: {err}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| format!("{source_name} file modified time is before Unix epoch: {err}"))?
        .as_nanos() as i64;
    Ok((modified_at_ns, metadata.len() as i64))
}

/// Build a change-signature component from a SQLite database's WAL/`-shm`
/// sidecar files.
///
/// Writes to a SQLite database in WAL mode land in the `-wal` sidecar and are
/// only folded back into the main file at checkpoint time. Reading only the
/// main file's mtime/size therefore misses not-yet-checkpointed sessions. This
/// folds each sidecar's size and nanosecond mtime into a compact string so a
/// pending write invalidates dependent caches. Missing sidecars contribute a
/// stable placeholder so checkpoint (which deletes `-wal`) also changes it.
pub fn sqlite_sidecar_signature(db_path: &Path) -> String {
    ["-wal", "-shm"]
        .iter()
        .map(
            |suffix| match sqlite_sidecar_path(db_path, suffix).metadata() {
                Ok(metadata) => {
                    let mtime_ns = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|since| since.as_nanos() as i64)
                        .unwrap_or_default();
                    format!("{suffix}:{}:{mtime_ns}", metadata.len())
                }
                Err(_) => format!("{suffix}:-"),
            },
        )
        .collect::<Vec<_>>()
        .join("|")
}

fn sqlite_sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut raw = OsString::from(db_path.as_os_str());
    raw.push(suffix);
    PathBuf::from(raw)
}
