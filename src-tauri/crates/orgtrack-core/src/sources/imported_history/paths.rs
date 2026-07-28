use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

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

/// Read a session-local change signature from an OpenCode-family SQLite store.
///
/// Unlike the database file/WAL signature, this changes only when the selected
/// session changes. That prevents an open replay from being reparsed every
/// time an unrelated session writes to the shared database.
pub fn sqlite_session_activity_signature(
    db_path: &Path,
    source_session_id: &str,
    source_name: &str,
) -> Result<Option<(i64, u64)>, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| {
        format!(
            "Failed to open {source_name} database {}: {err}",
            db_path.display()
        )
    })?;
    conn.query_row(
        "SELECT MAX(
                    COALESCE(s.time_updated, 0),
                    COALESCE((SELECT MAX(p.time_created)
                              FROM part p WHERE p.session_id = s.id), 0)
                ),
                COALESCE((SELECT MAX(p.rowid)
                          FROM part p WHERE p.session_id = s.id), 0)
         FROM session s
         WHERE s.id = ?1",
        [source_session_id],
        |row| {
            let updated_at = row.get::<_, Option<i64>>(0)?.unwrap_or_default();
            let last_part_rowid = row.get::<_, Option<i64>>(1)?.unwrap_or_default();
            Ok((updated_at, last_part_rowid.max(0) as u64))
        },
    )
    .optional()
    .map_err(|err| {
        format!("Failed to read {source_name} session signature {source_session_id}: {err}")
    })
}

fn sqlite_sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut raw = OsString::from(db_path.as_os_str());
    raw.push(suffix);
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_sqlite_signature_ignores_unrelated_session_writes() {
        let path = std::env::temp_dir().join(format!(
            "orgii-imported-signature-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::remove_file(&path).ok();
        let conn = Connection::open(&path).expect("open fixture");
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
             CREATE TABLE part (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
             );
             INSERT INTO session VALUES ('a', 10), ('b', 20);
             INSERT INTO part VALUES ('a1', 'a', 10, '{}'), ('b1', 'b', 20, '{}');",
        )
        .expect("seed fixture");

        let before =
            sqlite_session_activity_signature(&path, "a", "Test").expect("signature before");
        conn.execute("INSERT INTO part VALUES ('b2', 'b', 30, '{}')", [])
            .expect("update unrelated session");
        conn.execute("UPDATE session SET time_updated = 30 WHERE id = 'b'", [])
            .expect("touch unrelated session");
        let unrelated =
            sqlite_session_activity_signature(&path, "a", "Test").expect("signature unrelated");
        assert_eq!(unrelated, before);

        conn.execute("INSERT INTO part VALUES ('a2', 'a', 40, '{}')", [])
            .expect("update selected session");
        let changed =
            sqlite_session_activity_signature(&path, "a", "Test").expect("signature changed");
        assert_ne!(changed, before);

        drop(conn);
        std::fs::remove_file(path).ok();
    }
}
