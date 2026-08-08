use std::collections::{HashMap, HashSet};
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

/// Fold independent per-session count/size components into the `u64` half of
/// an activity-signature tuple.
///
/// SipHash (`DefaultHasher`) has no structural cancellation: a change in any
/// single component changes the fold except with ~2^-64 probability. The
/// simpler folds are strictly worse here — XOR masks two components that
/// happen to take equal values, and addition masks one component growing
/// while another shrinks by the same amount, both plausible while a provider
/// streams into several rows at once. Signatures are only compared in memory
/// within one app run, so cross-version hash stability is not required.
pub fn fold_activity_signature_components(components: &[i64]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    components.hash(&mut hasher);
    hasher.finish()
}

/// Real on-disk footprint of a SQLite store: the main database file plus its
/// `-wal` sidecar (where a not-yet-checkpointed live session's bytes land).
///
/// This is a cooldown/tiering input only — it deliberately is NOT part of any
/// change-detection signature, because the shared store grows whenever an
/// unrelated session writes.
pub fn sqlite_store_size_bytes(db_path: &Path) -> Option<u64> {
    let main = db_path.metadata().ok()?;
    let wal_len = sqlite_sidecar_path(db_path, "-wal")
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Some(main.len() + wal_len)
}

/// Read a session-local change signature from an OpenCode-family SQLite store.
///
/// Unlike the database file/WAL signature, this changes only when the selected
/// session changes. That prevents an open replay from being reparsed every
/// time an unrelated session writes to the shared database.
///
/// The OpenCode-family `part` table has no `time_updated` column, and a
/// streaming turn UPDATEs its current `part.data` in place — changing neither
/// `MAX(time_created)` nor `MAX(rowid)`. `SUM(length(part.data))` over the
/// session's parts is folded in so in-flight transcript growth changes the
/// signature. (`SUM` skips NULL data rows; those still move `MAX(rowid)` on
/// insert.)
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
    sqlite_session_activity_signature_from_conn(&conn, source_session_id, source_name)
}

/// Read the same session-local activity signature from an already-open store.
///
/// Metadata scans use this form so all sessions share one read-only connection
/// instead of reopening the SQLite database once per session.
pub fn sqlite_session_activity_signature_from_conn(
    conn: &Connection,
    source_session_id: &str,
    source_name: &str,
) -> Result<Option<(i64, u64)>, String> {
    conn.query_row(
        "SELECT MAX(
                    COALESCE(s.time_updated, 0),
                    COALESCE((SELECT MAX(p.time_created)
                              FROM part p WHERE p.session_id = s.id), 0)
                ),
                COALESCE((SELECT MAX(p.rowid)
                          FROM part p WHERE p.session_id = s.id), 0),
                COALESCE((SELECT SUM(length(CAST(p.data AS BLOB)))
                          FROM part p WHERE p.session_id = s.id), 0)
         FROM session s
         WHERE s.id = ?1",
        [source_session_id],
        |row| {
            let updated_at = row.get::<_, Option<i64>>(0)?.unwrap_or_default();
            let last_part_rowid = row.get::<_, Option<i64>>(1)?.unwrap_or_default();
            let total_part_bytes = row.get::<_, Option<i64>>(2)?.unwrap_or_default();
            Ok((
                updated_at,
                fold_activity_signature_components(&[last_part_rowid, total_part_bytes]),
            ))
        },
    )
    .optional()
    .map_err(|err| {
        format!("Failed to read {source_name} session signature {source_session_id}: {err}")
    })
}

/// Read activity signatures for every session in one bounded SQLite pass.
///
/// A metadata scan already needs one row per session. Aggregating `part` once
/// avoids an N+1 query pattern and, more importantly, avoids quadratic work on
/// provider databases that do not index `part.session_id`.
pub fn sqlite_all_session_activity_signatures_from_conn(
    conn: &Connection,
    source_name: &str,
) -> Result<HashMap<String, (i64, u64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id,
                    MAX(COALESCE(s.time_updated, 0), COALESCE(parts.last_created_at, 0)),
                    COALESCE(parts.last_rowid, 0),
                    COALESCE(parts.total_data_bytes, 0)
             FROM session s
             LEFT JOIN (
                 SELECT session_id,
                        MAX(time_created) AS last_created_at,
                        MAX(rowid) AS last_rowid,
                        COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS total_data_bytes
                 FROM part
                 GROUP BY session_id
             ) parts ON parts.session_id = s.id",
        )
        .map_err(|err| format!("Failed to prepare {source_name} activity signatures: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let source_session_id = row.get::<_, String>(0)?;
            let updated_at = row.get::<_, Option<i64>>(1)?.unwrap_or_default();
            let last_part_rowid = row.get::<_, Option<i64>>(2)?.unwrap_or_default();
            let total_part_bytes = row.get::<_, Option<i64>>(3)?.unwrap_or_default();
            Ok((
                source_session_id,
                (
                    updated_at,
                    fold_activity_signature_components(&[last_part_rowid, total_part_bytes]),
                ),
            ))
        })
        .map_err(|err| format!("Failed to query {source_name} activity signatures: {err}"))?;

    let mut signatures = HashMap::new();
    for row in rows {
        let (source_session_id, signature) =
            row.map_err(|err| format!("Failed to read {source_name} activity signature: {err}"))?;
        signatures.insert(source_session_id, signature);
    }
    Ok(signatures)
}

fn sqlite_sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut raw = OsString::from(db_path.as_os_str());
    raw.push(suffix);
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_db(label: &str) -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!(
            "orgii-imported-{label}-{}-{}.sqlite",
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
        (path, conn)
    }

    #[test]
    fn shared_sqlite_signature_ignores_unrelated_session_writes() {
        let (path, conn) = fixture_db("signature");

        let before =
            sqlite_session_activity_signature(&path, "a", "Test").expect("signature before");
        conn.execute("INSERT INTO part VALUES ('b2', 'b', 30, '{}')", [])
            .expect("update unrelated session");
        conn.execute("UPDATE session SET time_updated = 30 WHERE id = 'b'", [])
            .expect("touch unrelated session");
        conn.execute(
            "UPDATE part SET data = '{\"streamed\":\"other session tail\"}' WHERE id = 'b1'",
            [],
        )
        .expect("in-place update of unrelated session part");
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

    #[test]
    fn shared_sqlite_signature_tracks_in_place_part_updates() {
        let (path, conn) = fixture_db("inplace");

        let before =
            sqlite_session_activity_signature(&path, "a", "Test").expect("signature before");
        // A streaming turn grows its current part's data in place: rowid,
        // time_created, and session.time_updated are all untouched.
        conn.execute(
            "UPDATE part SET data = '{\"streamed\":\"longer in-place tail\"}' WHERE id = 'a1'",
            [],
        )
        .expect("in-place update of open session part");
        let grown = sqlite_session_activity_signature(&path, "a", "Test").expect("signature grown");
        assert_ne!(grown, before);

        drop(conn);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn store_size_bytes_sums_main_file_and_wal_sidecar() {
        let (path, conn) = fixture_db("size");
        drop(conn);
        let main_len = path.metadata().expect("main metadata").len();
        let wal = path.with_extension("sqlite-wal");
        std::fs::write(&wal, vec![0u8; 128]).expect("write wal sidecar");

        let total = sqlite_store_size_bytes(&path).expect("store size");
        assert_eq!(total, main_len + 128);

        std::fs::remove_file(&wal).ok();
        assert_eq!(
            sqlite_store_size_bytes(&path).expect("store size without wal"),
            main_len
        );
        assert!(sqlite_store_size_bytes(Path::new("Z:/definitely/missing.sqlite")).is_none());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn shared_sqlite_signature_tolerates_null_part_data() {
        let (path, conn) = fixture_db("null");

        let before =
            sqlite_session_activity_signature(&path, "a", "Test").expect("signature before");
        conn.execute("INSERT INTO part VALUES ('a2', 'a', 40, NULL)", [])
            .expect("insert NULL-data part");
        // SUM skips the NULL row but the probe must not error, and the insert
        // still moves MAX(rowid)/MAX(time_created).
        let with_null = sqlite_session_activity_signature(&path, "a", "Test")
            .expect("signature with NULL part data");
        assert_ne!(with_null, before);
        assert!(with_null.is_some());

        drop(conn);
        std::fs::remove_file(path).ok();
    }
}
