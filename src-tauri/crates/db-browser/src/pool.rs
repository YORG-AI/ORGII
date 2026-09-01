//! Per-process connection pool for DB Browser.
//!
//! Connections are keyed by a `connection_id` string generated from the file path.
//! Each connection is a `rusqlite::Connection` opened in read-write mode.
//! The pool is capped at `MAX_CONNECTIONS` to prevent leaks.

use rusqlite::{Connection, OpenFlags, Result as SqliteResult};
use std::collections::HashMap;
use std::sync::Mutex;

const MAX_CONNECTIONS: usize = 16;

static POOL: std::sync::LazyLock<Mutex<HashMap<String, Connection>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn connection_id_for(path: &str) -> String {
    format!("db:{}", path)
}

/// Open a connection. Returns the `connection_id`.
/// If already open, returns the existing ID.
pub fn open(path: &str) -> SqliteResult<String> {
    let id = connection_id_for(path);
    let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());

    if pool.contains_key(&id) {
        return Ok(id);
    }

    // Evict oldest if at cap (simple FIFO)
    if pool.len() >= MAX_CONNECTIONS {
        if let Some(oldest_key) = pool.keys().next().cloned() {
            pool.remove(&oldest_key);
        }
    }

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    // Tune for interactive browsing without touching the journal mode —
    // the user's file may intentionally use DELETE or MEMORY journal mode.
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -8000;",
    )?;

    pool.insert(id.clone(), conn);

    Ok(id)
}

/// Close a connection.
pub fn close(connection_id: &str) {
    let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
    pool.remove(connection_id);
}

/// Execute a closure with a reference to the connection.
/// Returns an error if the connection is not found.
pub fn with<F, T>(connection_id: &str, func: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> SqliteResult<T>,
{
    let pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
    let conn = pool
        .get(connection_id)
        .ok_or_else(|| format!("DB connection not found: {}", connection_id))?;
    func(conn).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a real SQLite file the pool can open read-write.
    fn seeded_db(dir: &std::path::Path, name: &str) -> String {
        let path = dir.join(name);
        let conn = Connection::open(&path).expect("create db");
        conn.execute_batch("CREATE TABLE t (a); INSERT INTO t VALUES (1)")
            .expect("seed");
        drop(conn);
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn open_derives_the_connection_id_from_the_file_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = seeded_db(dir.path(), "ids.sqlite");

        let id = open(&path).expect("open");
        assert_eq!(id, format!("db:{path}"));
        close(&id);
    }

    #[test]
    fn open_is_idempotent_and_reuses_the_pooled_connection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = seeded_db(dir.path(), "idempotent.sqlite");

        let first = open(&path).expect("first open");
        let second = open(&path).expect("second open");
        assert_eq!(first, second);

        // The second call must not have replaced the live connection: a
        // temp table created through the first handle is still visible.
        with(&first, |conn| {
            conn.execute_batch("CREATE TEMP TABLE marker (x)")
        })
        .expect("create temp table");
        let seen = with(&second, |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM temp.sqlite_master WHERE name = 'marker'",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("read temp table");
        assert_eq!(seen, 1);

        close(&first);
    }

    #[test]
    fn open_fails_for_a_path_that_does_not_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nope.sqlite");

        // The pool opens READ_WRITE without CREATE, so browsing must never
        // conjure an empty database at a mistyped path.
        assert!(open(missing.to_str().unwrap()).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn with_runs_the_closure_against_the_pooled_connection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = seeded_db(dir.path(), "with.sqlite");
        let id = open(&path).expect("open");

        let count = with(&id, |conn| {
            conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get::<_, i64>(0))
        })
        .expect("with");
        assert_eq!(count, 1);

        close(&id);
    }

    #[test]
    fn with_reports_the_missing_connection_id_after_close() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = seeded_db(dir.path(), "closed.sqlite");
        let id = open(&path).expect("open");
        close(&id);

        let err = with(&id, |conn| conn.query_row("SELECT 1", [], |_| Ok(()))).unwrap_err();
        assert!(err.contains("DB connection not found"));
        assert!(err.contains(&id), "the error names the id the caller sent");
    }

    #[test]
    fn close_is_a_no_op_for_an_unknown_connection_id() {
        close("db:/never/opened.sqlite");
    }

    #[test]
    fn with_surfaces_closure_errors_as_strings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = seeded_db(dir.path(), "err.sqlite");
        let id = open(&path).expect("open");

        let err = with(&id, |conn| {
            conn.query_row("SELECT * FROM missing", [], |_| Ok(()))
        })
        .unwrap_err();
        assert!(err.contains("missing"), "got {err}");

        close(&id);
    }
}
