//! Index store setup: resolve the on-disk SQLite target, open connections with
//! every table the loading + analysis paths expect, and small store queries.

use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use orgtrack_core::store::sqlite::SqliteRecordStore;

use crate::Options;

/// Where this invocation's index lives. A `--db` path persists; otherwise a
/// per-process temp file is used and deleted on exit. We never use `:memory:`
/// so provider scans can run on worker threads with their own connections to
/// the same file (see [`scan_all`]) — the timeout guard needs that isolation.
pub(crate) struct DbTarget {
    pub(crate) path: String,
    pub(crate) temp: bool,
}

impl Drop for DbTarget {
    fn drop(&mut self) {
        if self.temp {
            for suffix in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(format!("{}{suffix}", self.path));
            }
        }
    }
}

/// Resolve the index path, creating parent dirs for a persistent `--db`.
pub(crate) fn db_target(opts: &Options) -> Result<DbTarget, String> {
    match &opts.db {
        Some(path) if path != ":memory:" => {
            if let Some(parent) = Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .map_err(|err| format!("cannot create {}: {err}", parent.display()))?;
                }
            }
            Ok(DbTarget {
                path: path.clone(),
                temp: false,
            })
        }
        _ => {
            let path = std::env::temp_dir()
                .join(format!("orgtrack-{}.db", std::process::id()))
                .to_string_lossy()
                .into_owned();
            for suffix in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(format!("{path}{suffix}"));
            }
            Ok(DbTarget { path, temp: true })
        }
    }
}

/// Open a connection to the index with a generous busy timeout (so a worker
/// still finishing a write doesn't fail a concurrent open) and initialize
/// every table the loading and analysis paths touch. `orgtrack_core` owns its
/// own tables; the three `session_token_usage` / `code_sessions` /
/// `agent_sessions` tables are owned by the desktop app in production, so a
/// standalone index creates them empty (the analytics reader references them
/// unconditionally). All the loaders and the usage reader guard *optional* app
/// tables with `table_exists`, so an empty index is a first-class store. Every
/// statement is `IF NOT EXISTS`, so opening repeatedly (once per worker) is
/// safe.
pub(crate) fn open_conn(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|err| format!("cannot open {path}: {err}"))?;
    conn.busy_timeout(Duration::from_secs(30))
        .map_err(|err| format!("set busy timeout: {err}"))?;
    // WAL so a reader (analytics) never blocks on a writer (a still-running or
    // abandoned scan worker) and vice-versa — the worker-per-provider model
    // relies on concurrent connections to the same file not deadlocking.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    SqliteRecordStore::init_tables(&conn).map_err(|err| format!("init tables: {err}"))?;
    SqliteRecordStore::init_source_cache_tables(&conn)
        .map_err(|err| format!("init source cache tables: {err}"))?;
    init_host_compat_tables(&conn)?;
    Ok(conn)
}

/// Empty stand-ins for the desktop app's session tables so the analytics
/// reader's unconditional joins resolve against a bare index. Schema mirrors
/// the app's; only the columns the reader selects matter.
pub(crate) fn init_host_compat_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_token_usage (
             id                 INTEGER PRIMARY KEY AUTOINCREMENT,
             session_id         TEXT NOT NULL,
             session_type       TEXT NOT NULL DEFAULT 'code',
             model              TEXT,
             account_id         TEXT,
             input_tokens       INTEGER NOT NULL DEFAULT 0,
             output_tokens      INTEGER NOT NULL DEFAULT 0,
             cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
             cache_write_tokens INTEGER NOT NULL DEFAULT 0,
             total_tokens       INTEGER NOT NULL DEFAULT 0,
             context_tokens     INTEGER NOT NULL DEFAULT 0,
             created_at         TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS code_sessions (
             session_id     TEXT PRIMARY KEY,
             name           TEXT,
             cli_agent_type TEXT,
             cli_session_id TEXT,
             model          TEXT,
             account_id     TEXT,
             key_source     TEXT,
             updated_at     TEXT
         );
         CREATE TABLE IF NOT EXISTS agent_sessions (
             session_id TEXT PRIMARY KEY,
             name       TEXT,
             model      TEXT,
             account_id TEXT,
             key_source TEXT,
             updated_at TEXT
         );",
    )
    .map_err(|err| format!("init host-compat tables: {err}"))
}

/// Actual number of projected usage rows in the index — the truthful
/// "projected" figure regardless of whether the bridge reported a per-session
/// failure.
pub(crate) fn count_usage_rows(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM orgtrack_core_session_usage", [], |row| {
        row.get(0)
    })
    .unwrap_or(0)
}
