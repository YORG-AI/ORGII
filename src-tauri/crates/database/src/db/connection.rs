//! Database Connection Management
//!
//! Two physical SQLite files:
//! - `~/.orgii/sessions.db`           — sessions, CLI agents, inbox, dev
//!   records, lineage, orchestrator, plan approvals, agent-core unified
//!   session persistence. Entry point: `get_connection()`.
//! - `~/.orgii/projects/projects.db`  — projects, work items, labels,
//!   milestones, members. Entry point: `get_projects_connection()`.
//!
//! Splitting projects out lets the cross-device sync layer (Linear /
//! GitHub / ORGII Cloud) treat the project DB as a self-contained
//! export bundle without touching the much larger and more sensitive
//! sessions DB. Cross-DB JOINs (e.g. work item ↔ session conversation)
//! remain possible via `ATTACH DATABASE` on whichever side reads.
//!
//! ## Schema-init dispatcher
//!
//! The actual `CREATE TABLE` DDL is owned by the `app` crate (each domain
//! module — `agent_sessions`, `inbox`, `orgtrack_core`, `agent_core::*` —
//! contributes its own `init_*_tables`). At app startup, `app::run()` calls
//! [`register_sessions_init`] / [`register_projects_init`] with a function
//! pointer that walks every domain initializer in the right order. The
//! database crate never imports those modules; the dispatcher is just a
//! `OnceLock<InitFn>` per physical DB.
//!
//! If no initializer is registered (e.g. a test that only needs the
//! connection for raw SQL), the connection is returned with PRAGMAs
//! applied and no schema attempted.

use rusqlite::{Connection, Result as SqliteResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};

/// Per-connection PRAGMA settings (must run on every new connection).
///
/// Touching these settings affects every caller of [`get_connection`]; the
/// projects DB layers `PRAGMA foreign_keys = ON` on top inside
/// [`get_projects_connection`].
pub fn configure_connection(conn: &Connection) -> SqliteResult<()> {
    // `busy_timeout = 15000` is intentionally a *backstop*, not the primary
    // contention strategy. The in-process writer serializer in
    // `db::writer` queues writers in Rust so the file lock should rarely
    // see contention; the 15s timeout only matters for the small set of
    // call sites that have not yet been migrated to the serializer and
    // for the cross-process case (e.g. another `orgii` instance running
    // against the same `~/.orgii/sessions.db`).
    //
    // `wal_autocheckpoint = 2000` raises the WAL flush threshold from the
    // 1000-page default. Under streaming agent load the WAL accumulates
    // thousands of small frames per second; checkpointing on every full
    // WAL would stall foreground writers. 2000 ≈ 8MB at the default
    // 4KB page, which Linux/macOS/Windows can all flush in well under
    // the writer's typical hold time.
    conn.execute_batch(
        "PRAGMA busy_timeout = 15000;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -64000;
         PRAGMA temp_store = MEMORY;
         PRAGMA wal_autocheckpoint = 2000;",
    )?;
    Ok(())
}

/// Resolve the path to `~/.orgii/sessions.db`, creating its parent directory
/// on demand and migrating an old `{data_local_dir}/orgii/cache/sessions.db`
/// once if it still exists.
///
/// The migration WAL-checkpoints the source first (TRUNCATE mode) so a
/// half-synced WAL can never produce a corrupt copy at the new path.
pub fn get_db_path() -> PathBuf {
    let new_path = app_paths::sessions_db();
    let new_dir = new_path.parent().unwrap_or(Path::new("."));

    std::fs::create_dir_all(new_dir).ok();

    if !new_path.exists() {
        let old_path = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("orgii")
            .join("cache")
            .join("sessions.db");

        if old_path.exists() {
            // Checkpoint the WAL first so all data is in the main DB file.
            // This avoids copying a half-synced WAL which could produce a corrupt DB.
            if let Ok(old_conn) = Connection::open(&old_path) {
                // TRUNCATE mode flushes WAL into the main DB and removes the WAL file
                if let Err(err) = old_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
                    eprintln!(
                        "[DB Migration] WAL checkpoint failed (proceeding anyway): {}",
                        err
                    );
                }
                drop(old_conn);
            }

            // Copy the main DB file (WAL should be empty/removed after checkpoint)
            if let Err(err) = std::fs::copy(&old_path, &new_path) {
                eprintln!(
                    "[DB Migration] Failed to copy {} → {}: {}",
                    old_path.display(),
                    new_path.display(),
                    err
                );
            } else {
                println!(
                    "[DB Migration] Migrated sessions.db to {}",
                    new_path.display()
                );
                // Copy WAL/SHM files as a safety net (should be empty after checkpoint)
                for suffix in &["-wal", "-shm"] {
                    let old_extra = old_path.with_extension(format!("db{}", suffix));
                    let new_extra = new_path.with_extension(format!("db{}", suffix));
                    if old_extra.exists() {
                        std::fs::copy(&old_extra, &new_extra).ok();
                    }
                }
            }
        }
    }

    new_path
}

/// Type signature shared by the per-DB schema initializers registered from
/// the `app` crate. Function pointers (rather than trait objects) keep the
/// registration cell `Copy` and avoid an `Arc<dyn>` round trip.
pub type InitFn = fn(&Connection) -> SqliteResult<()>;

fn sessions_init_cell() -> &'static OnceLock<InitFn> {
    static CELL: OnceLock<InitFn> = OnceLock::new();
    &CELL
}

fn projects_init_cell() -> &'static OnceLock<InitFn> {
    static CELL: OnceLock<InitFn> = OnceLock::new();
    &CELL
}

/// Register the schema initializer for `~/.orgii/sessions.db`.
///
/// Called once from `app::run()` before any consumer opens a connection.
/// Subsequent calls are silently ignored (the cell is `OnceLock`); this
/// keeps tests safe — they may re-enter `run`-style setup and a second
/// register is a no-op rather than a panic.
pub fn register_sessions_init(init_fn: InitFn) {
    let _ = sessions_init_cell().set(init_fn);
}

/// Register the schema initializer for `~/.orgii/projects/projects.db`.
///
/// Same semantics as [`register_sessions_init`].
pub fn register_projects_init(init_fn: InitFn) {
    let _ = projects_init_cell().set(init_fn);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InitState {
    Initializing,
    Ready,
}

#[derive(Debug, Default)]
struct InitBarrier {
    states: Mutex<HashMap<PathBuf, InitState>>,
    ready: Condvar,
}

/// Per-physical-path schema barrier.
///
/// We intentionally do NOT use `std::sync::Once` here: in production the
/// path is stable and reaches `Ready`, while in tests `ORGII_HOME` rotates
/// per sandbox. `Initializing` is observable so concurrent first callers
/// wait for DDL completion instead of receiving a connection to a
/// half-created schema.
fn init_barrier() -> &'static InitBarrier {
    static INITIALIZED: OnceLock<InitBarrier> = OnceLock::new();
    INITIALIZED.get_or_init(InitBarrier::default)
}

/// Open a SQLite file at `db_path`, apply per-connection PRAGMAs, and run
/// `init_fn` exactly once per physical path per process.
///
/// On init failure the path is removed from the barrier so the next caller
/// retries — a transient I/O blip on first touch should not disable schema
/// migration for the rest of the process lifetime.
fn open_with_init(db_path: &Path, init_fn: Option<InitFn>) -> SqliteResult<Connection> {
    let conn = Connection::open(db_path)?;

    let Some(init_fn) = init_fn else {
        configure_connection(&conn)?;
        return Ok(conn);
    };

    let barrier = init_barrier();
    let mut states = barrier
        .states
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    loop {
        match states.get(db_path) {
            Some(InitState::Ready) => {
                drop(states);
                configure_connection(&conn)?;
                return Ok(conn);
            }
            Some(InitState::Initializing) => {
                states = barrier
                    .ready
                    .wait(states)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            None => {
                states.insert(db_path.to_path_buf(), InitState::Initializing);
                break;
            }
        }
    }
    drop(states);

    let initialized = configure_connection(&conn).and_then(|()| init_fn(&conn));
    match initialized {
        Ok(()) => {
            let mut states = barrier
                .states
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            states.insert(db_path.to_path_buf(), InitState::Ready);
            barrier.ready.notify_all();
        }
        Err(err) => {
            let mut states = barrier
                .states
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            states.remove(db_path);
            barrier.ready.notify_all();
            tracing::error!(
                "[database::db] schema init failed for {}: {}",
                db_path.display(),
                err
            );
            return Err(err);
        }
    }

    Ok(conn)
}

/// Open a connection to `~/.orgii/sessions.db`.
///
/// Schema includes sessions, CLI agents, inbox, dev records, lineage,
/// orchestrator state, plan approvals, and the agent-core unified
/// session layer — but only when the `app` crate has called
/// [`register_sessions_init`] at startup. Without a registered initializer
/// the connection is returned with PRAGMAs applied and no schema attempted
/// (sufficient for raw-SQL tests).
///
/// # Example
/// ```ignore
/// use database::db::get_connection;
///
/// let conn = get_connection()?;
/// conn.execute("INSERT INTO ...", params![...])?;
/// ```
pub fn get_connection() -> SqliteResult<Connection> {
    open_with_init(&get_db_path(), sessions_init_cell().get().copied())
}

/// Open a connection to `~/.orgii/projects/projects.db`.
///
/// Schema includes projects, work items, labels, milestones, and
/// members. The parent directory is created on demand. Foreign-key
/// enforcement is enabled here (and only here) so the cascade-delete
/// rules in the project schema fire as designed.
///
/// # Example
/// ```ignore
/// use database::db::get_projects_connection;
///
/// let conn = get_projects_connection()?;
/// conn.execute("INSERT INTO projects ...", params![...])?;
/// ```
pub fn get_projects_connection() -> SqliteResult<Connection> {
    let path = app_paths::projects_db();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = open_with_init(&path, projects_init_cell().get().copied())?;
    // Foreign-key enforcement is per-connection in SQLite. The `projects`
    // schema relies on `ON DELETE CASCADE` to keep work items, labels,
    // milestones, and members consistent; we opt in here without
    // touching `configure_connection`, which is shared with sessions.db
    // and modules that have not been audited for cascade safety.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static SLOW_INIT_CALLS: AtomicUsize = AtomicUsize::new(0);

    fn slow_test_init(conn: &Connection) -> SqliteResult<()> {
        SLOW_INIT_CALLS.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(75));
        conn.execute_batch("CREATE TABLE cold_start_barrier (id INTEGER PRIMARY KEY);")
    }

    #[test]
    fn concurrent_first_connections_wait_for_schema_completion() {
        SLOW_INIT_CALLS.store(0, Ordering::SeqCst);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = Arc::new(std::env::temp_dir().join(format!(
            "orgii-schema-barrier-{}-{nonce}.db",
            std::process::id()
        )));
        let start = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let path = Arc::clone(&path);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    let conn = open_with_init(&path, Some(slow_test_init))
                        .expect("open initialized connection");
                    conn.query_row("SELECT COUNT(*) FROM cold_start_barrier", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("schema is complete before connection returns")
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        for handle in handles {
            assert_eq!(handle.join().expect("connection thread"), 0);
        }
        assert_eq!(SLOW_INIT_CALLS.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_file(path.as_ref());
    }
}
