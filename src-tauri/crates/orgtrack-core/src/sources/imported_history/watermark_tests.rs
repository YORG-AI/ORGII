use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::*;
use crate::sources::imported_history::paths as imported_paths;

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn
}

fn temp_transcript(tag: &str, content: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "orgii-imported-watermark-test-{tag}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("transcript.jsonl");
    fs::write(&path, content).expect("write fixture");
    path
}

fn cleanup(path: &Path) {
    fs::remove_file(path).ok();
    if let Some(dir) = path.parent() {
        fs::remove_dir(dir).ok();
    }
}

fn stat(path: &Path) -> (i64, i64) {
    imported_paths::file_metadata_signature(path, "Test").expect("stat fixture")
}

fn read_all(reader: &mut WatermarkedTranscriptReader) -> Vec<(String, bool)> {
    let mut lines = Vec::new();
    while let Some(line) = reader.next_line().expect("read line") {
        lines.push((line.text, line.terminated));
    }
    lines
}

#[test]
fn resume_reads_only_the_appended_suffix() {
    let path = temp_transcript("resume", "alpha\nbeta\n");
    let (mtime, size) = stat(&path);

    let mut full =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    assert!(full.resume_state_json().is_none());
    assert_eq!(
        read_all(&mut full),
        vec![("alpha".to_string(), true), ("beta".to_string(), true)]
    );
    let watermark = full.into_watermark(1, mtime, size, "state-1".to_string());
    assert_eq!(watermark.byte_offset, "alpha\nbeta\n".len() as i64);

    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, b"gamma\n"))
        .expect("append");
    let (mtime_after, size_after) = stat(&path);
    let mut resumed = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        mtime_after,
        size_after,
    )
    .expect("open resumed");
    assert_eq!(resumed.resume_state_json(), Some("state-1"));
    assert_eq!(read_all(&mut resumed), vec![("gamma".to_string(), true)]);
    let next = resumed.into_watermark(1, mtime_after, size_after, "state-2".to_string());
    assert_eq!(next.byte_offset, "alpha\nbeta\ngamma\n".len() as i64);

    cleanup(&path);
}

#[test]
fn unterminated_tail_is_returned_but_never_watermarked() {
    let path = temp_transcript("tail", "alpha\npart");
    let (mtime, size) = stat(&path);

    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    assert_eq!(
        read_all(&mut reader),
        vec![("alpha".to_string(), true), ("part".to_string(), false)]
    );
    let watermark = reader.into_watermark(1, mtime, size, "state-1".to_string());
    assert_eq!(watermark.byte_offset, "alpha\n".len() as i64);

    fs::write(&path, "alpha\npartial-done\n").expect("complete tail");
    let (mtime_after, size_after) = stat(&path);
    let mut resumed = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        mtime_after,
        size_after,
    )
    .expect("open resumed");
    assert_eq!(resumed.resume_state_json(), Some("state-1"));
    assert_eq!(
        read_all(&mut resumed),
        vec![("partial-done".to_string(), true)]
    );

    cleanup(&path);
}

#[test]
fn prefix_mutation_forces_a_full_reparse() {
    let path = temp_transcript("mutated", "aa\nbb\n");
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    read_all(&mut reader);
    let watermark = reader.into_watermark(1, mtime, size, "state-1".to_string());

    fs::write(&path, "xx\nbb\ncc\n").expect("rewrite prefix");
    let (mtime_after, size_after) = stat(&path);
    let mut reopened = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        mtime_after,
        size_after,
    )
    .expect("open reopened");
    assert!(reopened.resume_state_json().is_none());
    assert_eq!(
        read_all(&mut reopened),
        vec![
            ("xx".to_string(), true),
            ("bb".to_string(), true),
            ("cc".to_string(), true)
        ]
    );

    cleanup(&path);
}

#[test]
fn size_regression_and_parser_version_change_force_a_full_reparse() {
    let path = temp_transcript("invalidate", "aa\nbb\n");
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    read_all(&mut reader);
    let watermark = reader.into_watermark(1, mtime, size, "state-1".to_string());

    fs::write(&path, "aa\n").expect("truncate");
    let (mtime_shrunk, size_shrunk) = stat(&path);
    let shrunk = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        mtime_shrunk,
        size_shrunk,
    )
    .expect("open shrunk");
    assert!(shrunk.resume_state_json().is_none());

    fs::write(&path, "aa\nbb\n").expect("restore");
    let (mtime_restored, size_restored) = stat(&path);
    let bumped = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        2,
        mtime_restored,
        size_restored,
    )
    .expect("open bumped parser version");
    assert!(bumped.resume_state_json().is_none());

    let regressed_mtime = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        watermark.source_mtime_ms - 1,
        size_restored,
    )
    .expect("open regressed mtime");
    assert!(regressed_mtime.resume_state_json().is_none());

    cleanup(&path);
}

#[test]
fn watermark_rows_roundtrip_and_clear() {
    let conn = fixture_conn();
    let watermark = ImportedParseWatermark {
        byte_offset: 42,
        source_size_bytes: 50,
        source_mtime_ms: 1_234,
        prefix_hash: "abcd".to_string(),
        parser_version: 9,
        state_json: "{\"created_at_ms\":1}".to_string(),
    };

    assert_eq!(
        read_parse_watermark_from_conn(&conn, "claude_code", "sess-1").expect("read empty"),
        None
    );
    write_parse_watermark_from_conn(&conn, "claude_code", "sess-1", &watermark).expect("write");
    assert_eq!(
        read_parse_watermark_from_conn(&conn, "claude_code", "sess-1").expect("read"),
        Some(watermark.clone())
    );
    assert_eq!(
        read_parse_watermark_from_conn(&conn, "codex_app", "sess-1").expect("read other source"),
        None
    );

    clear_parse_watermark_from_conn(&conn, "claude_code", "sess-1").expect("clear");
    assert_eq!(
        read_parse_watermark_from_conn(&conn, "claude_code", "sess-1").expect("read cleared"),
        None
    );
}

#[test]
fn malformed_watermark_row_degrades_to_none_and_self_heals() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO imported_history_parse_watermarks (
            source, source_session_id, byte_offset, source_size_bytes,
            source_mtime_ms, prefix_hash, parser_version, state_json
         ) VALUES ('claude_code', 'sess-1', 'garbage', 50, 1234, 'abcd', 9, '{}')",
        [],
    )
    .expect("insert malformed row");

    assert_eq!(
        read_parse_watermark_from_conn(&conn, "claude_code", "sess-1")
            .expect("malformed row reads as absent"),
        None
    );

    let healed = ImportedParseWatermark {
        byte_offset: 42,
        source_size_bytes: 50,
        source_mtime_ms: 1_234,
        prefix_hash: "abcd".to_string(),
        parser_version: 9,
        state_json: "{\"created_at_ms\":1}".to_string(),
    };
    write_parse_watermark_from_conn(&conn, "claude_code", "sess-1", &healed).expect("rewrite");
    assert_eq!(
        read_parse_watermark_from_conn(&conn, "claude_code", "sess-1").expect("read healed"),
        Some(healed)
    );
}
