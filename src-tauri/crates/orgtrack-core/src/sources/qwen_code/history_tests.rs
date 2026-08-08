use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::*;

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn
}

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "orgii-qwen-history-test-{tag}-{}",
        std::process::id()
    ));
    fs::remove_dir_all(&root).ok();
    fs::create_dir_all(&root).expect("create temp root");
    root
}

fn write_session(root: &Path, project: &str, filename: &str, content: &str) -> PathBuf {
    let chats = root.join(project).join("chats");
    fs::create_dir_all(&chats).expect("create chats");
    let path = chats.join(filename);
    fs::write(&path, content).expect("write transcript");
    path
}

fn discover_without_snapshots(root: &Path) -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let snapshots = HashMap::new();
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&snapshots, "jsonl", "Qwen Code");
    discover_records(root, &mut walker)
}

fn user_line(session_id: &str) -> String {
    format!(
        "{{\"uuid\":\"u1\",\"sessionId\":\"{session_id}\",\"timestamp\":\"2026-07-30T10:00:00.000Z\",\"type\":\"user\",\"cwd\":\"/repo\",\"gitBranch\":\"main\",\"message\":{{\"role\":\"user\",\"parts\":[{{\"text\":\"Fix the cache\"}}]}}}}\n"
    )
}

fn assistant_line(
    session_id: &str,
    timestamp: &str,
    prompt: i64,
    candidates: i64,
    thoughts: i64,
    cached: i64,
) -> String {
    assistant_line_with_total(
        session_id, timestamp, prompt, candidates, thoughts, cached, None,
    )
}

fn assistant_line_with_total(
    session_id: &str,
    timestamp: &str,
    prompt: i64,
    candidates: i64,
    thoughts: i64,
    cached: i64,
    total: Option<i64>,
) -> String {
    let mut usage = json!({
        "promptTokenCount": prompt,
        "candidatesTokenCount": candidates,
        "thoughtsTokenCount": thoughts,
        "cachedContentTokenCount": cached,
    });
    if let Some(total) = total {
        usage["totalTokenCount"] = json!(total);
    }
    format!(
        "{}\n",
        json!({
            "uuid": format!("a-{timestamp}"),
            "sessionId": session_id,
            "timestamp": timestamp,
            "type": "assistant",
            "model": "qwen3.5-plus",
            "message": {"role": "model", "parts": [{"text": "Done"}]},
            "usageMetadata": usage,
        })
    )
}

fn base_transcript(session_id: &str) -> String {
    format!(
        "{}{}",
        user_line(session_id),
        assistant_line(session_id, "2026-07-30T10:00:01.000Z", 100, 20, 5, 30,)
    )
}

#[test]
fn qwen_preserves_cache_inclusive_input_and_avoids_overlapping_thoughts() {
    let root = temp_root("usage");
    write_session(
        &root,
        "repo-a",
        "session-a.jsonl",
        &base_transcript("session-a"),
    );
    let mut conn = fixture_conn();
    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("sync Qwen");

    let page =
        imported_cache::query_imported_session_page_from_conn(&conn, SOURCE_QWEN_CODE, 10, 0)
            .expect("query page");
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(page.sessions[0].session_id, "qwencodeapp-session-a");
    assert_eq!(page.sessions[0].name, "Fix the cache");
    // candidates strictly dominates thoughts, so Qwen treats thoughts as
    // potentially already included.
    assert_eq!(page.sessions[0].total_tokens, 120);

    let session_usage: (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
             FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![SOURCE_QWEN_CODE, "repo-a/session-a"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read session usage");
    assert_eq!(session_usage, (100, 20, 30, 0));

    let round_usage: (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
             FROM imported_history_round_usage
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![SOURCE_QWEN_CODE, "repo-a/session-a"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read round usage");
    // Per-round input is fresh; cached tokens remain separately visible.
    assert_eq!(round_usage, (70, 20, 30, 0));
    fs::remove_dir_all(root).ok();
}

#[test]
fn total_token_count_is_authoritative_for_output() {
    let root = temp_root("usage-total");
    let content = format!(
        "{}{}",
        user_line("session-a"),
        assistant_line_with_total(
            "session-a",
            "2026-07-30T10:00:01.000Z",
            100,
            70,
            50,
            30,
            Some(180),
        )
    );
    write_session(&root, "repo-a", "session-a.jsonl", &content);
    let mut conn = fixture_conn();
    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("sync Qwen");

    let session_usage: (i64, i64) = conn
        .query_row(
            "SELECT input_tokens, output_tokens
             FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![SOURCE_QWEN_CODE, "repo-a/session-a"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read session usage");
    assert_eq!(session_usage, (100, 80));
    let round_output: i64 = conn
        .query_row(
            "SELECT output_tokens
             FROM imported_history_round_usage
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![SOURCE_QWEN_CODE, "repo-a/session-a"],
            |row| row.get(0),
        )
        .expect("read round usage");
    assert_eq!(round_output, 80);
    fs::remove_dir_all(root).ok();
}

#[test]
fn output_fallback_distinguishes_overlap_from_disjoint_thoughts() {
    let usage = |candidates, thoughts| QwenUsageMetadata {
        candidates_token_count: Some(candidates),
        thoughts_token_count: Some(thoughts),
        ..QwenUsageMetadata::default()
    };
    assert_eq!(qwen_output_tokens(&usage(150, 120), 100), 150);
    assert_eq!(qwen_output_tokens(&usage(50, 120), 100), 170);
    assert_eq!(qwen_output_tokens(&usage(80, 80), 100), 160);
    assert_eq!(qwen_output_tokens(&usage(-10, -5), 100), 0);

    let below_prompt_total = QwenUsageMetadata {
        total_token_count: Some(80),
        candidates_token_count: Some(1_000),
        thoughts_token_count: Some(1_000),
        ..QwenUsageMetadata::default()
    };
    assert_eq!(qwen_output_tokens(&below_prompt_total, 100), 0);
}

#[test]
fn warm_append_parses_only_the_new_suffix() {
    let root = temp_root("append");
    let path = write_session(
        &root,
        "repo-a",
        "session-a.jsonl",
        &base_transcript("session-a"),
    );
    let mut conn = fixture_conn();
    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("cold sync");
    let before = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_QWEN_CODE,
        "repo-a/session-a",
    )
    .expect("read watermark")
    .expect("watermark exists");

    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            file.write_all(
                assistant_line("session-a", "2026-07-30T10:00:02.000Z", 10, 4, 1, 2).as_bytes(),
            )
        })
        .expect("append assistant");
    let record = discover_without_snapshots(&root)
        .expect("discover")
        .pop()
        .expect("record");
    let parsed = parse_qwen_session_meta(&record, Some(&before), &root).expect("parse warm append");

    assert!(parsed.resumed);
    assert_eq!(parsed.lines_processed, 1);
    assert_eq!(parsed.input.input_tokens, 110);
    assert_eq!(parsed.input.output_tokens, 24);
    assert_eq!(parsed.input.cache_read_tokens, 32);
    assert!(parsed.watermark.byte_offset > before.byte_offset);
    fs::remove_dir_all(root).ok();
}

#[test]
fn changed_append_seam_cold_parses_only_that_file() {
    let root = temp_root("seam");
    let path = write_session(
        &root,
        "repo-a",
        "session-a.jsonl",
        &base_transcript("session-a"),
    );
    let mut conn = fixture_conn();
    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("cold sync");
    let before = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_QWEN_CODE,
        "repo-a/session-a",
    )
    .expect("read watermark")
    .expect("watermark exists");

    let rewritten = base_transcript("session-a").replacen(
        "\"candidatesTokenCount\":20",
        "\"candidatesTokenCount\":21",
        1,
    );
    fs::write(
        &path,
        format!(
            "{}{}",
            rewritten,
            assistant_line("session-a", "2026-07-30T10:00:02.000Z", 10, 4, 1, 2,)
        ),
    )
    .expect("rewrite and append");
    let record = discover_without_snapshots(&root)
        .expect("discover")
        .pop()
        .expect("record");
    let parsed =
        parse_qwen_session_meta(&record, Some(&before), &root).expect("parse invalidated seam");

    assert!(!parsed.resumed);
    assert_eq!(parsed.lines_processed, 3);
    assert_eq!(parsed.input.output_tokens, 25);
    fs::remove_dir_all(root).ok();
}

#[test]
fn discovery_accepts_only_the_exact_bounded_layout() {
    let root = temp_root("layout");
    fs::write(root.join("root.jsonl"), base_transcript("root")).expect("write root file");
    write_session(
        &root,
        "repo-a",
        "session-a.jsonl",
        &base_transcript("session-a"),
    );
    let nested = root.join("repo-a/chats/nested");
    fs::create_dir_all(&nested).expect("create nested");
    fs::write(nested.join("foreign.jsonl"), base_transcript("foreign")).expect("write nested file");

    let records = discover_without_snapshots(&root).expect("discover exact");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].source_session_id, "repo-a/session-a");
    fs::remove_dir_all(root).ok();
}

#[test]
fn cold_sync_processes_a_fixed_batch_and_leaves_the_remainder_eligible() {
    let root = temp_root("batch");
    for index in 0..=MAX_CHANGED_SESSIONS_PER_SYNC {
        let session_id = format!("session-{index:03}");
        write_session(
            &root,
            "repo-a",
            &format!("{session_id}.jsonl"),
            &base_transcript(&session_id),
        );
    }
    let mut conn = fixture_conn();

    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("first bounded sync");
    let first_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache WHERE source = ?1",
            [SOURCE_QWEN_CODE],
            |row| row.get(0),
        )
        .expect("count first batch");
    assert_eq!(first_count, MAX_CHANGED_SESSIONS_PER_SYNC as i64);

    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("continue bounded sync");
    let final_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache WHERE source = ?1",
            [SOURCE_QWEN_CODE],
            |row| row.get(0),
        )
        .expect("count completed cache");
    assert_eq!(final_count, (MAX_CHANGED_SESSIONS_PER_SYNC + 1) as i64);
    fs::remove_dir_all(root).ok();
}

#[cfg(unix)]
#[test]
fn discovery_does_not_follow_directory_or_file_symlinks() {
    use std::os::unix::fs::symlink;

    let root = temp_root("symlinks");
    let real = temp_root("symlink-target");
    let target = write_session(
        &real,
        "repo-real",
        "target.jsonl",
        &base_transcript("target"),
    );
    symlink(real.join("repo-real"), root.join("linked-project")).expect("link project");
    let chats = root.join("repo-a/chats");
    fs::create_dir_all(&chats).expect("create chats");
    symlink(&target, chats.join("linked-file.jsonl")).expect("link file");

    assert!(discover_without_snapshots(&root)
        .expect("discover")
        .is_empty());
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(real).ok();
}

#[test]
fn oversized_append_is_skipped_and_the_sync_still_succeeds() {
    let root = temp_root("oversized");
    let path = write_session(
        &root,
        "repo-a",
        "session-a.jsonl",
        &base_transcript("session-a"),
    );
    let mut conn = fixture_conn();
    sync_qwen_code_history_cache_at_root(&mut conn, &root).expect("cold sync");
    let before = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_QWEN_CODE,
        "repo-a/session-a",
    )
    .expect("read watermark")
    .expect("watermark exists");

    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            file.write_all(&vec![
                b'x';
                imported_history::watermark::MAX_JSONL_LINE_BYTES + 1
            ])?;
            file.write_all(b"\n")
        })
        .expect("append oversized record");
    sync_qwen_code_history_cache_at_root(&mut conn, &root)
        .expect("oversized append skipped, sync still succeeds");

    let after = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_QWEN_CODE,
        "repo-a/session-a",
    )
    .expect("read watermark")
    .expect("watermark remains");
    let cached =
        imported_cache::query_cached_session_from_conn(&conn, SOURCE_QWEN_CODE, "repo-a/session-a")
            .expect("read cache")
            .expect("cache remains");
    // The skipped record contributed nothing, so the parsed totals are
    // unchanged — but the watermark must move past it, or every later scan
    // would re-read and re-skip the same bytes.
    assert_eq!(cached.output_tokens, 20);
    assert!(after.byte_offset > before.byte_offset);
    fs::remove_dir_all(root).ok();
}

#[test]
fn activity_replay_is_bounded_and_pairs_qwen_tool_results() {
    let root = temp_root("activity");
    let content = format!(
        "{}{}{}",
        user_line("session-a"),
        "{\"sessionId\":\"session-a\",\"timestamp\":\"2026-07-30T10:00:01.000Z\",\"type\":\"assistant\",\"message\":{\"role\":\"model\",\"parts\":[{\"text\":\"thinking\",\"thought\":true},{\"text\":\"answer\"},{\"functionCall\":{\"id\":\"call-1\",\"name\":\"run_shell_command\",\"args\":{\"command\":\"pwd\"}}}]}}\n",
        "{\"sessionId\":\"session-a\",\"timestamp\":\"2026-07-30T10:00:02.000Z\",\"type\":\"tool_result\",\"message\":{\"role\":\"user\",\"parts\":[{\"functionResponse\":{\"id\":\"call-1\",\"name\":\"run_shell_command\",\"response\":{\"output\":\"/repo\"}}}]}}\n"
    );
    let path = write_session(&root, "repo-a", "session-a.jsonl", &content);
    let chunks =
        load_activity_from_path(&path, &root, "qwencodeapp-session-a").expect("load activity");

    assert_eq!(chunks.len(), 4);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(chunks[1].function, imported_history::FUNCTION_THINKING);
    assert_eq!(chunks[2].function, imported_history::FUNCTION_ASSISTANT);
    assert_eq!(
        chunks[3].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(chunks[3].result["output"], "/repo");
    fs::remove_dir_all(root).ok();
}

#[test]
fn parse_state_keeps_only_a_fixed_recent_round_window() {
    let mut state = QwenParseState::default();
    for seq in 0..=MAX_STORED_ROUNDS as i64 {
        state.push_round(StoredRoundUsage {
            seq,
            model: Some("qwen".to_string()),
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            created_at_ms: seq,
        });
    }
    assert_eq!(state.rounds.len(), MAX_STORED_ROUNDS);
    assert_eq!(state.rounds.front().expect("first retained").seq, 1);
    assert!(
        serde_json::to_vec(&state).expect("encode state").len() <= MAX_STATE_JSON_BYTES,
        "bounded rounds must fit the persisted state cap"
    );
}
