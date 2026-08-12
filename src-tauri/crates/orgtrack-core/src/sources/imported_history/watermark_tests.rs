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
fn same_size_mtime_change_forces_a_full_reparse() {
    let path = temp_transcript("same-size-rewrite", "aa\nbb\n");
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    read_all(&mut reader);
    let watermark = reader.into_watermark(1, mtime, size, "state-1".to_string());

    fs::write(&path, "cc\ndd\n").expect("same-size rewrite");
    let mut reopened =
        WatermarkedTranscriptReader::open(&path, "Test", Some(&watermark), 1, mtime + 1, size)
            .expect("open rewritten");
    assert!(reopened.resume_state_json().is_none());
    assert_eq!(
        read_all(&mut reopened),
        vec![("cc".to_string(), true), ("dd".to_string(), true)]
    );

    cleanup(&path);
}

#[test]
fn rotated_file_identity_forces_a_full_reparse() {
    let path = temp_transcript("rotation", "old\n");
    let old_path = path.with_extension("old");
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    read_all(&mut reader);
    let watermark = reader.into_watermark(1, mtime, size, "state-1".to_string());

    fs::rename(&path, &old_path).expect("rotate old file");
    fs::write(&path, "new\nappended\n").expect("create replacement");
    let (rotated_mtime, rotated_size) = stat(&path);
    let mut reopened = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        rotated_mtime.max(mtime),
        rotated_size,
    )
    .expect("open replacement");
    assert!(reopened.resume_state_json().is_none());
    assert_eq!(
        read_all(&mut reopened),
        vec![("new".to_string(), true), ("appended".to_string(), true)]
    );

    fs::remove_file(&old_path).ok();
    cleanup(&path);
}

/// A record whose JSON structure alone blows the buffer cannot be salvaged by
/// truncating string values, so it is skipped — but the parse must continue,
/// with the watermark landing past it so a resume does not re-read it.
#[test]
fn unsalvageable_line_is_skipped_without_stopping_the_parse() {
    let path = temp_transcript("oversized", "stable\n");
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    assert_eq!(
        reader.next_line().expect("read stable"),
        Some(TranscriptLine {
            text: "stable".to_string(),
            terminated: true,
        })
    );
    let watermark = reader.into_watermark(1, mtime, size, "stable-state".to_string());

    let oversized = vec![b'x'; MAX_JSONL_LINE_BYTES + 1];
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            std::io::Write::write_all(&mut file, &oversized)?;
            std::io::Write::write_all(&mut file, b"\nafter\n")
        })
        .expect("append oversized record");
    let (mtime_after, size_after) = stat(&path);
    let mut resumed = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&watermark),
        1,
        mtime_after,
        size_after,
    )
    .expect("open appended file");
    assert_eq!(resumed.resume_state_json(), Some("stable-state"));
    assert_eq!(read_all(&mut resumed), vec![("after".to_string(), true)]);
    let after_skip = resumed.into_watermark(1, mtime_after, size_after, "after-state".to_string());
    assert_eq!(after_skip.byte_offset, size_after);

    // The seam the skip left behind must still validate, or the next scan
    // would cold-reparse the whole file and skip the same record again.
    let mut reopened = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&after_skip),
        1,
        mtime_after,
        size_after,
    )
    .expect("reopen after skip");
    assert_eq!(reopened.resume_state_json(), Some("after-state"));
    assert!(read_all(&mut reopened).is_empty());

    cleanup(&path);
}

/// The common real-world case: one record carrying a multi-megabyte string
/// value — a base64 image in a `tool_result`, a long command's output. It must
/// survive as a parseable record with every structural field intact; only the
/// oversized value shortens.
#[test]
fn oversized_string_value_is_truncated_and_the_record_still_parses() {
    let payload = "A".repeat(MAX_JSON_STRING_BYTES + 4096);
    let record = format!(
        r#"{{"type":"user","uuid":"abc-123","message":{{"role":"user","content":[{{"type":"tool_result","data":"{payload}"}}]}},"tail":"kept"}}"#
    );
    let path = temp_transcript("truncate-string", &format!("{record}\n"));
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open");
    let line = reader
        .next_line()
        .expect("read record")
        .expect("one record");

    let value: serde_json::Value =
        serde_json::from_str(&line.text).expect("truncated record is valid JSON");
    assert_eq!(value["type"], "user");
    assert_eq!(value["uuid"], "abc-123");
    assert_eq!(value["message"]["role"], "user");
    // Everything after the truncated value survives — truncation consumes the
    // value's interior, never the structure around it.
    assert_eq!(value["tail"], "kept");
    let data = value["message"]["content"][0]["data"]
        .as_str()
        .expect("data is a string");
    assert!(data.starts_with("AAA"));
    assert!(data.ends_with("...[truncated]"));
    assert!(data.len() < payload.len());
    assert_eq!(reader.next_line().expect("read eof"), None);

    cleanup(&path);
}

/// A record can blow the buffer in aggregate while every single value stays
/// under budget — the real Claude `tool_result` carrying several images has
/// exactly this shape. A per-value budget alone would skip it; the allowance
/// has to tighten as the record fills so it still parses.
#[test]
fn many_under_budget_values_are_truncated_rather_than_overflowing() {
    let value = "B".repeat(MAX_JSON_STRING_BYTES - 1);
    let values = (0..24)
        .map(|index| format!(r#""k{index}":"{value}""#))
        .collect::<Vec<_>>()
        .join(",");
    let record = format!(r#"{{{values},"tail":"kept"}}"#);
    // Every value is legal on its own, and together they far exceed the cap.
    assert!(record.len() > MAX_JSONL_LINE_BYTES);
    let path = temp_transcript("aggregate", &format!("{record}\n"));
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open");
    let line = reader
        .next_line()
        .expect("read record")
        .expect("one record");

    let parsed: serde_json::Value =
        serde_json::from_str(&line.text).expect("truncated record is valid JSON");
    // The record survives with all 24 keys and the trailing field intact.
    assert_eq!(parsed["tail"], "kept");
    assert_eq!(parsed["k0"].as_str().expect("k0").len(), value.len());
    assert!(parsed["k23"]
        .as_str()
        .expect("k23")
        .ends_with("...[truncated]"));
    assert!(line.text.len() <= MAX_JSONL_LINE_BYTES);
    assert_eq!(reader.next_line().expect("read eof"), None);

    cleanup(&path);
}

/// Cuts have to land between complete units. Splitting `\"` leaves a dangling
/// backslash and splitting `é` leaves half an escape — either one makes
/// the entire record unparseable. Alignment is swept so the budget runs out at
/// every offset within the repeating unit.
#[test]
fn truncation_never_splits_an_escape_sequence() {
    let unit = r#"\"é"#;
    for offset in 0..unit.len() {
        let payload = format!(
            "{}{}",
            "z".repeat(offset),
            unit.repeat(MAX_JSON_STRING_BYTES / unit.len() + 64)
        );
        let record = format!(r#"{{"v":"{payload}","tail":"kept"}}"#);
        let path = temp_transcript(&format!("escape-{offset}"), &format!("{record}\n"));
        let (mtime, size) = stat(&path);
        let mut reader =
            WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open");
        let line = reader
            .next_line()
            .expect("read record")
            .expect("one record");
        let value: serde_json::Value = serde_json::from_str(&line.text).unwrap_or_else(|err| {
            panic!("offset {offset}: truncated record must stay valid JSON: {err}")
        });
        assert_eq!(value["tail"], "kept");
        assert!(value["v"].as_str().expect("v").ends_with("...[truncated]"));
        cleanup(&path);
    }
}

/// Cutting inside a multi-byte character would make the record invalid UTF-8,
/// which fails the whole read rather than just that value. Alignment is swept
/// so the budget runs out at every byte of a 4-byte character.
#[test]
fn truncation_never_splits_a_multibyte_character() {
    for offset in 0..4 {
        let payload = format!(
            "{}{}",
            "z".repeat(offset),
            "🌍".repeat(MAX_JSON_STRING_BYTES / 4 + 64)
        );
        let record = format!(r#"{{"v":"{payload}","tail":"kept"}}"#);
        let path = temp_transcript(&format!("utf8-{offset}"), &format!("{record}\n"));
        let (mtime, size) = stat(&path);
        let mut reader =
            WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open");
        let line = reader
            .next_line()
            .unwrap_or_else(|err| panic!("offset {offset}: must stay valid UTF-8: {err}"))
            .expect("one record");
        let value: serde_json::Value =
            serde_json::from_str(&line.text).expect("truncated record is valid JSON");
        assert_eq!(value["tail"], "kept");
        cleanup(&path);
    }
}

/// Values under the budget must come through byte for byte — truncation is
/// strictly an over-budget path, not a lossy default.
#[test]
fn values_under_the_budget_pass_through_untouched() {
    let record = r#"{"type":"user","v":"short \"quoted\" é value","n":42}"#;
    let path = temp_transcript("untouched", &format!("{record}\n"));
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open");
    assert_eq!(
        reader.next_line().expect("read record"),
        Some(TranscriptLine {
            text: record.to_string(),
            terminated: true,
        })
    );

    cleanup(&path);
}

/// The cap bounds the reader's buffer; it must not silently truncate a record
/// that merely happens to be large.
#[test]
fn a_record_at_the_size_limit_is_still_returned_whole() {
    let body = "y".repeat(MAX_JSONL_LINE_BYTES - 1);
    let path = temp_transcript("at-limit", &format!("{body}\n"));
    let (mtime, size) = stat(&path);
    let mut reader =
        WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size).expect("open full");
    assert_eq!(
        reader.next_line().expect("read at-limit record"),
        Some(TranscriptLine {
            text: body,
            terminated: true,
        })
    );
    assert_eq!(reader.next_line().expect("read eof"), None);

    cleanup(&path);
}

/// A live writer part-way through appending a huge record: the tail is not yet
/// complete, so it must not advance the watermark past bytes a later append
/// will extend.
#[test]
fn unterminated_oversized_tail_does_not_advance_the_watermark() {
    let path = temp_transcript("oversized-tail", "stable\n");
    let (mtime, size) = stat(&path);
    let committed = {
        let mut reader = WatermarkedTranscriptReader::open(&path, "Test", None, 1, mtime, size)
            .expect("open full");
        assert!(read_all(&mut reader).len() == 1);
        reader.into_watermark(1, mtime, size, "stable-state".to_string())
    };

    let oversized = vec![b'x'; MAX_JSONL_LINE_BYTES + 1];
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, &oversized))
        .expect("append unterminated oversized record");
    let (mtime_after, size_after) = stat(&path);
    let mut resumed = WatermarkedTranscriptReader::open(
        &path,
        "Test",
        Some(&committed),
        1,
        mtime_after,
        size_after,
    )
    .expect("open appended file");
    assert!(read_all(&mut resumed).is_empty());
    let after = resumed.into_watermark(1, mtime_after, size_after, "stable-state".to_string());
    assert_eq!(after.byte_offset, committed.byte_offset);

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
