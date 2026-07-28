use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

use super::*;

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn
}

fn temp_tree(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "orgii-scan-snapshot-test-{tag}-{}",
        std::process::id()
    ));
    fs::remove_dir_all(&dir).ok();
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

type WalkResult = (
    Vec<PathBuf>,
    HashMap<String, DirScanSnapshot>,
    usize,
    usize,
);

fn walk(previous: &HashMap<String, DirScanSnapshot>, root: &Path) -> WalkResult {
    let mut walker = SnapshotDirWalker::new(previous, "jsonl", "Test");
    let mut files = Vec::new();
    walker.collect_files(root, &mut files).expect("walk");
    let enumerated = walker.dirs_enumerated;
    let reused = walker.dirs_reused;
    (files, walker.into_snapshots(), enumerated, reused)
}

#[test]
fn snapshot_rows_roundtrip_and_replace() {
    let conn = fixture_conn();
    let mut snapshots = HashMap::new();
    snapshots.insert(
        "/tmp/a".to_string(),
        DirScanSnapshot {
            dir_mtime_ns: 10,
            scanned_at_ns: 20,
            subdirs: vec!["sub".to_string()],
            files: vec!["x.jsonl".to_string()],
        },
    );

    write_dir_snapshots_from_conn(&conn, "claude_code", &snapshots).expect("write");
    assert_eq!(read_dir_snapshots_from_conn(&conn, "claude_code"), snapshots);
    assert!(read_dir_snapshots_from_conn(&conn, "codex_app").is_empty());

    let mut replacement = HashMap::new();
    replacement.insert("/tmp/b".to_string(), DirScanSnapshot::default());
    write_dir_snapshots_from_conn(&conn, "claude_code", &replacement).expect("rewrite");
    assert_eq!(
        read_dir_snapshots_from_conn(&conn, "claude_code"),
        replacement
    );
}

#[test]
fn legacy_or_garbage_snapshot_rows_read_as_absent_and_heal() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO imported_history_scan_snapshots (
            source, directory_path, dir_mtime_ns, file_count, snapshot_version, entries_json
         ) VALUES ('claude_code', '/tmp/garbage', 1, 1, ?1, 'not-json')",
        [SCAN_SNAPSHOT_VERSION],
    )
    .expect("insert garbage json row");
    conn.execute(
        "INSERT INTO imported_history_scan_snapshots (
            source, directory_path, dir_mtime_ns, file_count, snapshot_version, entries_json
         ) VALUES ('claude_code', '/tmp/wrong-type', 'nope', 1, ?1, 42)",
        [SCAN_SNAPSHOT_VERSION],
    )
    .expect("insert wrong-type row");
    conn.execute(
        "INSERT INTO imported_history_scan_snapshots (
            source, directory_path, dir_mtime_ns, file_count, snapshot_version, entries_json
         ) VALUES ('claude_code', '/tmp/future', 1, 1, 999,
                   '{\"dir_mtime_ns\":1,\"scanned_at_ns\":2,\"subdirs\":[],\"files\":[]}')",
        [],
    )
    .expect("insert future-version row");

    assert!(read_dir_snapshots_from_conn(&conn, "claude_code").is_empty());

    let bare = Connection::open_in_memory().expect("open bare db");
    assert!(read_dir_snapshots_from_conn(&bare, "claude_code").is_empty());

    let mut healed = HashMap::new();
    healed.insert(
        "/tmp/healed".to_string(),
        DirScanSnapshot {
            dir_mtime_ns: 5,
            scanned_at_ns: 6,
            subdirs: Vec::new(),
            files: vec!["y.jsonl".to_string()],
        },
    );
    write_dir_snapshots_from_conn(&conn, "claude_code", &healed).expect("heal");
    assert_eq!(read_dir_snapshots_from_conn(&conn, "claude_code"), healed);
}

#[test]
fn walker_reuses_unchanged_directories_and_detects_changes() {
    let root = temp_tree("walker");
    fs::create_dir_all(root.join("sub/deep")).expect("create dirs");
    fs::write(root.join("a.jsonl"), "a").expect("write a");
    fs::write(root.join("skip.txt"), "s").expect("write skip");
    fs::write(root.join("sub/b.jsonl"), "b").expect("write b");
    fs::write(root.join("sub/deep/c.jsonl"), "c").expect("write c");
    std::thread::sleep(Duration::from_millis(5));

    let empty = HashMap::new();
    let (cold_files, snapshots, cold_enumerated, cold_reused) = walk(&empty, &root);
    assert_eq!(cold_files.len(), 3);
    assert_eq!(cold_enumerated, 3);
    assert_eq!(cold_reused, 0);

    let (warm_files, warm_snapshots, warm_enumerated, warm_reused) = walk(&snapshots, &root);
    assert_eq!(warm_files, cold_files);
    assert_eq!(warm_enumerated, 0);
    assert_eq!(warm_reused, 3);
    assert_eq!(warm_snapshots, snapshots);

    fs::write(root.join("sub/d.jsonl"), "d").expect("write d");
    std::thread::sleep(Duration::from_millis(5));
    let (added_files, added_snapshots, added_enumerated, added_reused) =
        walk(&warm_snapshots, &root);
    assert_eq!(added_files.len(), 4);
    assert!(added_files.contains(&root.join("sub/d.jsonl")));
    assert_eq!(added_enumerated, 1);
    assert_eq!(added_reused, 2);

    fs::remove_file(root.join("a.jsonl")).expect("remove a");
    std::thread::sleep(Duration::from_millis(5));
    let (removed_files, _, removed_enumerated, _) = walk(&added_snapshots, &root);
    assert_eq!(removed_files.len(), 3);
    assert!(!removed_files
        .iter()
        .any(|path| path.file_name() == Some(std::ffi::OsStr::new("a.jsonl"))));
    assert_eq!(removed_enumerated, 1);

    fs::remove_dir_all(&root).ok();
}

#[test]
fn walker_ignores_racy_snapshot_whose_scan_did_not_postdate_dir_mtime() {
    let root = temp_tree("racy");
    fs::write(root.join("a.jsonl"), "a").expect("write a");
    std::thread::sleep(Duration::from_millis(5));

    let empty = HashMap::new();
    let (files, snapshots, _, _) = walk(&empty, &root);
    let mut racy = snapshots.clone();
    for snapshot in racy.values_mut() {
        snapshot.scanned_at_ns = snapshot.dir_mtime_ns;
    }

    let (racy_files, _, racy_enumerated, racy_reused) = walk(&racy, &root);
    assert_eq!(racy_files, files);
    assert_eq!(racy_reused, 0);
    assert_eq!(racy_enumerated, 1);

    fs::remove_dir_all(&root).ok();
}

#[test]
#[ignore]
fn bench_walker_cold_vs_warm() {
    let root = temp_tree("bench");
    for dir_index in 0..250 {
        let dir = root.join(format!("proj-{dir_index:03}"));
        fs::create_dir_all(&dir).expect("create bench dir");
        for file_index in 0..10 {
            fs::write(dir.join(format!("s-{file_index:02}.jsonl")), "x").expect("write bench file");
        }
    }
    std::thread::sleep(Duration::from_millis(10));

    let empty = HashMap::new();
    let started = std::time::Instant::now();
    let (cold_files, snapshots, cold_enumerated, _) = walk(&empty, &root);
    let cold = started.elapsed();

    let started = std::time::Instant::now();
    let (warm_files, _, warm_enumerated, warm_reused) = walk(&snapshots, &root);
    let warm = started.elapsed();

    println!(
        "bench_walker cold={cold:?} ({} files, {cold_enumerated} dirs enumerated) \
         warm={warm:?} ({} files, {warm_reused} dirs reused, {warm_enumerated} dirs enumerated)",
        cold_files.len(),
        warm_files.len(),
    );
    assert_eq!(cold_files.len(), warm_files.len());

    fs::remove_dir_all(&root).ok();
}
