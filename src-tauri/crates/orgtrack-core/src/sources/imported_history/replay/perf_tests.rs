//! Explicit #443 memory acceptance harnesses.
//!
//! These stay ignored in the normal unit suite because they write a 300 MiB
//! deterministic fixture and sample OS peak RSS. Run the named test in an
//! otherwise idle process before merging replay/index changes.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;

use rusqlite::params;

use super::{
    open_window, poll_delta, ImportedHistorySourceId, ReplayLimits, HARD_MAX_EVENTS,
    HARD_MAX_IPC_BYTES, HARD_MAX_TURNS,
};
use crate::store::sqlite::SqliteRecordStore;

const MIB: usize = 1024 * 1024;
const THIRTY_MIB: u64 = 30 * MIB as u64;
const THREE_HUNDRED_MIB: u64 = 300 * MIB as u64;
#[cfg(unix)]
const RSS_CHILD_ENV: &str = "ORGII_ISSUE_443_RSS_CHILD";
#[cfg(unix)]
const RSS_FIXTURE_PATH_ENV: &str = "ORGII_ISSUE_443_RSS_FIXTURE_PATH";

struct TempFixture {
    root: PathBuf,
    path: PathBuf,
}

impl TempFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "orgii-issue-443-rss-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir(&root).expect("create isolated replay fixture directory");
        let path = root.join("session.jsonl");
        Self { root, path }
    }
}

impl Drop for TempFixture {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "failed to clean #443 replay fixture {}: {error}",
                    self.root.display()
                );
            }
        }
    }
}

fn assistant_line() -> Vec<u8> {
    let body = "r".repeat(32 * 1024);
    let mut line = serde_json::json!({
        "timestamp": "2026-07-22T00:00:01Z",
        "type": "event_msg",
        "payload": { "type": "agent_message", "message": body },
    })
    .to_string()
    .into_bytes();
    line.push(b'\n');
    line
}

fn extend_fixture(path: &Path, target_bytes: u64) {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open deterministic replay fixture");
    let mut writer = BufWriter::with_capacity(1024 * 1024, file);
    let line = assistant_line();
    let mut size = std::fs::metadata(path).map_or(0, |metadata| metadata.len());
    if size == 0 {
        let user = serde_json::json!({
            "timestamp": "2026-07-22T00:00:00Z",
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "RSS fixture" },
        })
        .to_string();
        writer.write_all(user.as_bytes()).expect("write user row");
        writer.write_all(b"\n").expect("finish user row");
        size = (user.len() + 1) as u64;
    }
    while size < target_bytes {
        writer.write_all(&line).expect("extend replay fixture");
        size = size.saturating_add(line.len() as u64);
    }
    writer.flush().expect("flush replay fixture");
}

#[cfg(unix)]
fn peak_rss_bytes() -> usize {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    assert_eq!(result, 0, "getrusage failed");
    let peak = unsafe { usage.assume_init() }.ru_maxrss as usize;
    #[cfg(target_os = "macos")]
    {
        peak
    }
    #[cfg(not(target_os = "macos"))]
    {
        peak.saturating_mul(1024)
    }
}

#[cfg(unix)]
fn sqlite_memory_bytes(reset_highwater: bool) -> (usize, usize) {
    let mut current = 0_i64;
    let mut highwater = 0_i64;
    let status = unsafe {
        rusqlite::ffi::sqlite3_status64(
            rusqlite::ffi::SQLITE_STATUS_MEMORY_USED,
            &mut current,
            &mut highwater,
            i32::from(reset_highwater),
        )
    };
    assert_eq!(status, rusqlite::ffi::SQLITE_OK, "sqlite3_status64 failed");
    (current.max(0) as usize, highwater.max(0) as usize)
}

#[cfg(unix)]
fn disk_cache_diagnostics(conn: &rusqlite::Connection, cache_path: &Path) {
    let mut cache_used = 0;
    let mut ignored_highwater = 0;
    let status = unsafe {
        rusqlite::ffi::sqlite3_db_status(
            conn.handle(),
            rusqlite::ffi::SQLITE_DBSTATUS_CACHE_USED,
            &mut cache_used,
            &mut ignored_highwater,
            0,
        )
    };
    assert_eq!(status, rusqlite::ffi::SQLITE_OK, "sqlite3_db_status failed");

    let (event_count, compact_text_bytes): (u64, u64) = conn
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(
                        length(args_preview_json)
                        + length(result_preview_json)
                        + length(payloads_json)
                    ), 0)
               FROM imported_replay_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("measure compact replay rows");
    let page_count: u64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .expect("read replay cache page count");
    let page_size: u64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("read replay cache page size");
    let main_file_bytes = std::fs::metadata(cache_path).map_or(0, |metadata| metadata.len());
    let mut wal_path = cache_path.as_os_str().to_os_string();
    wal_path.push("-wal");
    let wal_file_bytes =
        std::fs::metadata(PathBuf::from(wal_path)).map_or(0, |metadata| metadata.len());

    eprintln!(
        "#443 disk cache: events={event_count}, compact text={:.1} MiB, SQLite page cache={:.1} MiB, logical pages={:.1} MiB, files main={:.1} MiB/WAL={:.1} MiB",
        compact_text_bytes as f64 / MIB as f64,
        cache_used as f64 / MIB as f64,
        page_count.saturating_mul(page_size) as f64 / MIB as f64,
        main_file_bytes as f64 / MIB as f64,
        wal_file_bytes as f64 / MIB as f64,
    );
}

fn replay_fixture(path: &Path, cache_path: &Path) -> (rusqlite::Connection, String) {
    let conn = rusqlite::Connection::open(cache_path).expect("open disk-backed replay cache");
    // Mirror `database::db::configure_connection`, which is applied to the
    // production sessions DB before replay cache tables are used. Measuring
    // an in-memory database here would count every compact-index page as
    // resident application memory and would not model production.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -64000;
         PRAGMA temp_store = MEMORY;
         PRAGMA busy_timeout = 15000;
         PRAGMA wal_autocheckpoint = 2000;",
    )
    .expect("configure production-like replay cache connection");
    SqliteRecordStore::init_tables(&conn).expect("initialize replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("initialize source cache");
    let session_id = "codexapp-issue-443-rss".to_string();
    conn.execute(
        "INSERT INTO imported_history_session_cache (
             source, source_session_id, session_id, source_path
         ) VALUES ('codex_app', 'issue-443-rss', ?1, ?2)",
        params![session_id, path.to_string_lossy()],
    )
    .expect("register replay source");
    (conn, session_id)
}

#[cfg(unix)]
fn run_isolated_rss_child() {
    // The parent owns cleanup so even a crashing/aborting child cannot leave a
    // 300 MiB fixture behind after the parent observes its exit.
    let fixture = TempFixture::new();
    let current_exe = std::env::current_exe().expect("resolve the Rust test executable");
    let status = Command::new(current_exe)
        .arg("jsonl_cold_index_and_growth_have_bounded_peak_rss")
        .arg("--ignored")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env(RSS_CHILD_ENV, "1")
        .env(RSS_FIXTURE_PATH_ENV, &fixture.path)
        .status()
        .expect("spawn isolated #443 RSS test child");
    assert!(
        status.success(),
        "isolated #443 RSS test child exited with {status}"
    );
}

#[cfg(unix)]
fn run_rss_workload() {
    let fixture_path = PathBuf::from(
        std::env::var_os(RSS_FIXTURE_PATH_ENV)
            .expect("isolated #443 RSS child requires a parent-owned fixture path"),
    );
    let cache_path = fixture_path
        .parent()
        .expect("fixture path must have an isolated parent directory")
        .join("replay-cache.sqlite");
    extend_fixture(&fixture_path, THIRTY_MIB);
    let (mut conn, session_id) = replay_fixture(&fixture_path, &cache_path);
    let limits = ReplayLimits {
        max_turns: HARD_MAX_TURNS,
        max_events: HARD_MAX_EVENTS,
        max_ipc_bytes: HARD_MAX_IPC_BYTES,
    };

    let baseline_peak = peak_rss_bytes();
    let (cold_sqlite_baseline, _) = sqlite_memory_bytes(true);
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        limits,
    )
    .expect("cold-index 30 MiB fixture");
    let cold_peak = peak_rss_bytes();
    let (cold_sqlite_current, cold_sqlite_highwater) = sqlite_memory_bytes(false);
    let cold_delta = cold_peak.saturating_sub(baseline_peak);
    eprintln!(
        "#443 RSS: baseline={:.1} MiB, 30 MiB cold peak={:.1} MiB, delta={:.1} MiB",
        baseline_peak as f64 / MIB as f64,
        cold_peak as f64 / MIB as f64,
        cold_delta as f64 / MIB as f64
    );
    eprintln!(
        "#443 SQLite heap (cold): baseline={:.1} MiB, current={:.1} MiB, highwater={:.1} MiB",
        cold_sqlite_baseline as f64 / MIB as f64,
        cold_sqlite_current as f64 / MIB as f64,
        cold_sqlite_highwater as f64 / MIB as f64,
    );
    assert!(
        cold_delta <= 128 * MIB,
        "30 MiB cold index grew peak RSS by {cold_delta} bytes"
    );

    extend_fixture(&fixture_path, THREE_HUNDRED_MIB);
    let before_growth_peak = peak_rss_bytes();
    let (growth_sqlite_baseline, _) = sqlite_memory_bytes(true);
    let delta = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor,
        limits,
    )
    .expect("incrementally index fixture growth to 300 MiB");
    assert!(delta.stats.parsed_bytes >= 260 * MIB as u64);
    let grown_peak = peak_rss_bytes();
    let (growth_sqlite_current, growth_sqlite_highwater) = sqlite_memory_bytes(false);
    let growth_delta = grown_peak.saturating_sub(before_growth_peak);
    eprintln!(
        "#443 RSS: before growth={:.1} MiB, 300 MiB peak={:.1} MiB, delta={:.1} MiB, parsed={:.1} MiB",
        before_growth_peak as f64 / MIB as f64,
        grown_peak as f64 / MIB as f64,
        growth_delta as f64 / MIB as f64,
        delta.stats.parsed_bytes as f64 / MIB as f64
    );
    eprintln!(
        "#443 SQLite heap (growth): baseline={:.1} MiB, current={:.1} MiB, highwater={:.1} MiB",
        growth_sqlite_baseline as f64 / MIB as f64,
        growth_sqlite_current as f64 / MIB as f64,
        growth_sqlite_highwater as f64 / MIB as f64,
    );
    disk_cache_diagnostics(&conn, &cache_path);
    assert!(
        growth_delta <= 64 * MIB,
        "30 -> 300 MiB indexing grew peak RSS by {growth_delta} bytes"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "#443 serial OS RSS stress; writes a deterministic 300 MiB JSONL fixture"]
fn jsonl_cold_index_and_growth_have_bounded_peak_rss() {
    if std::env::var_os(RSS_CHILD_ENV).is_some() {
        run_rss_workload();
    } else {
        run_isolated_rss_child();
    }
}

#[test]
fn deterministic_generator_reaches_requested_size_without_one_large_allocation() {
    let fixture = TempFixture::new();
    let _ = File::create(&fixture.path).expect("create small generator fixture");
    extend_fixture(&fixture.path, MIB as u64);
    assert!(
        std::fs::metadata(&fixture.path)
            .expect("fixture metadata")
            .len()
            >= MIB as u64
    );
}
