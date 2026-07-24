use super::*;
use std::io::Write;

use crate::store::sqlite::SqliteRecordStore;

#[test]
fn qoder_wrapped_user_text_is_preserved_without_internal_context() {
    let events = normalize_line(
        ImportedHistorySourceId::Qoder,
        &json!({
            "role":"user", "message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder><user_query>hello</user_query>"}]}
        }),
    );
    assert!(matches!(&events[0].kind, NormalizedKind::UserText(text) if text == "hello"));
}

#[test]
fn anthropic_tool_use_and_result_normalize_without_full_transcript() {
    let call = normalize_line(
        ImportedHistorySourceId::Omp,
        &json!({
            "type":"assistant", "message":{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"bash","input":{"command":"pwd"}}]}
        }),
    );
    let result = normalize_line(
        ImportedHistorySourceId::Omp,
        &json!({
            "type":"user", "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"/repo"}]}
        }),
    );
    assert!(matches!(&call[0].kind, NormalizedKind::ToolUse(tool) if tool.call_id == "c1"));
    assert!(
        matches!(&result[0].kind, NormalizedKind::ToolResult { output, .. } if output == "/repo")
    );
}

#[test]
fn trae_line_stays_one_turn() {
    let events = normalize_line(
        ImportedHistorySourceId::Trae,
        &json!({
            "intent":"fix it", "outcome":"done", "actions":["edit"], "learned":[]
        }),
    );
    assert_eq!(events.len(), 2);
    assert!(events[0].starts_turn);
    assert!(!events[1].starts_turn);
}

fn fixture_lines(source: ImportedHistorySourceId) -> (String, String) {
    match source {
            ImportedHistorySourceId::ClaudeCode => (
                json!({"type":"user","timestamp":"2026-07-22T00:00:00Z","message":{"role":"user","content":"hello"}}).to_string(),
                json!({"type":"assistant","timestamp":"2026-07-22T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}).to_string(),
            ),
            ImportedHistorySourceId::WorkBuddy => (
                json!({"type":"message","timestamp":"2026-07-22T00:00:00Z","role":"user","content":"hello"}).to_string(),
                json!({"type":"message","timestamp":"2026-07-22T00:00:01Z","role":"assistant","content":"world"}).to_string(),
            ),
            ImportedHistorySourceId::Trae => (
                json!({"intent":"hello","outcome":"ok","actions":[],"learned":[],"message_summary_time":"2026-07-22 08:00:00"}).to_string(),
                json!({"intent":"again","outcome":"done","actions":[],"learned":[],"message_summary_time":"2026-07-22 08:00:01"}).to_string(),
            ),
            ImportedHistorySourceId::Qoder => (
                json!({"role":"user","message":{"content":[{"type":"text","text":"<user_query>hello</user_query>"}]}}).to_string(),
                json!({"role":"assistant","message":{"content":[{"type":"text","text":"world"}]}}).to_string(),
            ),
            ImportedHistorySourceId::Omp | ImportedHistorySourceId::QoderCli => (
                json!({"type":"user","timestamp":1_753_152_000_000_i64,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}).to_string(),
                json!({"type":"assistant","timestamp":1_753_152_001_000_i64,"message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}).to_string(),
            ),
            _ => unreachable!("JSONL conformance source"),
        }
}

fn state_from(outcome: &JsonlSyncOutcome, source: ImportedHistorySourceId) -> ReplayIndexState {
    ReplayIndexState {
        generation: "generation-1".to_string(),
        revision: 1,
        parser_version: 1,
        source_identity: source.as_str().to_string(),
        driver_cursor_json: outcome.driver_cursor_json.clone(),
        indexed_size_bytes: outcome.indexed_size_bytes,
        indexed_mtime_ns: 0,
        total_events: outcome.total_events,
        total_turns: outcome.total_turns,
        state_updated_at_ms: 0,
    }
}

#[test]
fn every_jsonl_adapter_obeys_incremental_and_partial_tail_contract() {
    let sources = [
        ImportedHistorySourceId::ClaudeCode,
        ImportedHistorySourceId::WorkBuddy,
        ImportedHistorySourceId::Trae,
        ImportedHistorySourceId::Qoder,
        ImportedHistorySourceId::Omp,
        ImportedHistorySourceId::QoderCli,
    ];
    for source in sources {
        let (first, second) = fixture_lines(source);
        let path = std::env::temp_dir().join(format!(
            "orgii-{}-jsonl-replay-{}-{}.jsonl",
            source.as_str(),
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(&path, format!("{first}\n")).expect("write cold fixture");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache replay schema");

        let cold = {
            let tx = conn.transaction().expect("cold transaction");
            let outcome = sync(
                &tx,
                source,
                &format!("{}fixture", source.descriptor().session_prefix),
                "fixture",
                &path,
                "generation-1",
                1,
                None,
                "sample-1",
            )
            .expect("cold sync");
            tx.commit().expect("commit cold sync");
            outcome
        };
        assert!(cold.stats.parsed_rows >= 1, "{} cold", source.as_str());
        assert!(cold.total_events >= 1, "{} cold events", source.as_str());
        let cold_state = state_from(&cold, source);

        let unchanged = {
            let tx = conn.transaction().expect("unchanged transaction");
            let outcome = sync(
                &tx,
                source,
                &format!("{}fixture", source.descriptor().session_prefix),
                "fixture",
                &path,
                "generation-1",
                2,
                Some(&cold_state),
                "sample-1",
            )
            .expect("unchanged sync");
            tx.commit().expect("commit unchanged sync");
            outcome
        };
        assert_eq!(
            unchanged.stats.parsed_rows,
            0,
            "{} unchanged",
            source.as_str()
        );
        assert_eq!(
            unchanged.stats.parsed_bytes,
            0,
            "{} unchanged bytes",
            source.as_str()
        );

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append fixture");
        file.write_all(second.as_bytes()).expect("write torn tail");
        file.flush().expect("flush torn tail");
        let partial = {
            let tx = conn.transaction().expect("partial transaction");
            let outcome = sync(
                &tx,
                source,
                &format!("{}fixture", source.descriptor().session_prefix),
                "fixture",
                &path,
                "generation-1",
                2,
                Some(&cold_state),
                "sample-2",
            )
            .expect("partial sync");
            tx.commit().expect("commit partial sync");
            outcome
        };
        assert_eq!(partial.stats.parsed_rows, 0, "{} partial", source.as_str());
        assert_eq!(partial.indexed_size_bytes, cold.indexed_size_bytes);

        file.write_all(b"\n").expect("complete tail");
        file.flush().expect("flush complete tail");
        drop(file);
        let completed = {
            let tx = conn.transaction().expect("append transaction");
            let outcome = sync(
                &tx,
                source,
                &format!("{}fixture", source.descriptor().session_prefix),
                "fixture",
                &path,
                "generation-1",
                2,
                Some(&cold_state),
                "sample-2",
            )
            .expect("append sync");
            tx.commit().expect("commit append sync");
            outcome
        };
        assert_eq!(completed.stats.parsed_rows, 1, "{} append", source.as_str());
        assert!(completed.indexed_size_bytes > cold.indexed_size_bytes);

        fs::write(
            &path,
            format!("{}\n{}\n", second, "x".repeat(first.len() + 32)),
        )
        .expect("replace fixture");
        assert!(!cursor_matches_source(&path, &completed.driver_cursor_json));
        let _ = fs::remove_file(path);
    }
}

#[test]
fn every_jsonl_adapter_conforms_through_public_open_poll_and_reset() {
    let sources = [
        ImportedHistorySourceId::ClaudeCode,
        ImportedHistorySourceId::WorkBuddy,
        ImportedHistorySourceId::Trae,
        ImportedHistorySourceId::Qoder,
        ImportedHistorySourceId::Omp,
        ImportedHistorySourceId::QoderCli,
    ];
    for source in sources {
        let (first, second) = fixture_lines(source);
        let source_session_id = format!("public-{}", source.as_str());
        let session_id = format!(
            "{}{}",
            source.descriptor().session_prefix,
            source_session_id
        );
        let path = std::env::temp_dir().join(format!(
            "orgii-public-{}-{}-{}.jsonl",
            source.as_str(),
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(&path, format!("{first}\n")).expect("write public fixture");
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("base schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache (
                    source, source_session_id, session_id, source_path
                 ) VALUES (?1, ?2, ?3, ?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                path.to_string_lossy()
            ],
        )
        .expect("cache public source");

        let opened = crate::sources::imported_history::replay::open_window(
            &mut conn,
            source,
            &session_id,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("public cold open");
        assert!(!opened.chunks.is_empty(), "{} cold window", source.as_str());
        assert!(
            opened.stats.parsed_rows >= 1,
            "{} cold telemetry",
            source.as_str()
        );
        let unchanged = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            source,
            &session_id,
            &opened.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("public unchanged poll");
        assert_eq!(
            unchanged.stats.parsed_rows,
            0,
            "{} unchanged",
            source.as_str()
        );
        assert!(unchanged.chunks.is_empty());

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append public");
        file.write_all(second.as_bytes())
            .expect("write public partial");
        file.flush().expect("flush public partial");
        let partial = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            source,
            &session_id,
            &opened.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("public partial poll");
        assert_eq!(partial.stats.parsed_rows, 0, "{} partial", source.as_str());
        assert_eq!(partial.cursor.revision, opened.cursor.revision);

        file.write_all(b"\n").expect("complete public tail");
        file.flush().expect("flush public complete");
        drop(file);
        let completed = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            source,
            &session_id,
            &opened.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("public append poll");
        assert!(
            !completed.chunks.is_empty(),
            "{} append delta",
            source.as_str()
        );
        assert_eq!(completed.stats.parsed_rows, 1);

        // Truncation publishes a new generation atomically and asks the
        // caller to replace its bounded window.
        fs::write(&path, format!("{first}\n")).expect("truncate public fixture");
        let reset = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            source,
            &session_id,
            &completed.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("public reset poll");
        assert!(reset.reset_required, "{} truncate reset", source.as_str());
        assert_ne!(reset.cursor.generation, completed.cursor.generation);
        let _ = fs::remove_file(path);
    }
}

#[test]
fn shared_jsonl_open_window_and_range_are_end_to_end_bounded() {
    let source = ImportedHistorySourceId::ClaudeCode;
    let session_id = "claudecodeapp-range-fixture";
    let source_session_id = "range-fixture";
    let large = format!("BEGIN-{}-END", "你".repeat(10_000));
    let user = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:00Z",
        "message":{"role":"user","content":"hello"}
    });
    let assistant = json!({
        "type":"assistant", "timestamp":"2026-07-22T00:00:01Z",
        "message":{"role":"assistant","content":[{"type":"text","text":large}]}
    });
    let path = std::env::temp_dir().join(format!(
        "orgii-claude-range-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(&path, format!("{user}\n{assistant}\n")).expect("range fixture");
    let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
    SqliteRecordStore::init_tables(&conn).expect("base schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
        params![
            source.as_str(),
            source_session_id,
            session_id,
            path.to_string_lossy()
        ],
    )
    .expect("cache source path");

    let opened = crate::sources::imported_history::replay::open_window(
        &mut conn,
        source,
        session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open bounded Claude replay");
    let assistant = opened
        .chunks
        .iter()
        .find(|chunk| chunk.chunk.function == imported_history::FUNCTION_ASSISTANT)
        .expect("assistant preview");
    // The canonical assistant result intentionally mirrors the preview in
    // `content` and `observation`; each field remains under the 8 KiB
    // preview cap even though the serialized compatibility shape is ~16 KiB.
    assert!(serde_json::to_vec(&assistant.chunk).unwrap().len() < 20 * 1024);
    assert_eq!(assistant.payloads.len(), 1);

    let mut reconstructed = String::new();
    let mut offset = 0;
    loop {
        let range = crate::sources::imported_history::replay::read_payload_range(
            &mut conn,
            source,
            session_id,
            &opened.cursor.generation,
            &assistant.chunk.chunk_id,
            "result.content",
            offset,
            Some(1024),
        )
        .expect("range read");
        assert!(range.text.len() <= 1024);
        reconstructed.push_str(&range.text);
        offset = range.next_offset;
        if range.eof {
            break;
        }
    }
    assert_eq!(reconstructed, large);
    let _ = fs::remove_file(path);
}

#[test]
fn shared_jsonl_ten_mib_shell_ranges_never_reparse_the_source_row() {
    fn update_hash(mut hash: u64, text: &str) -> u64 {
        for byte in text.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    let source = ImportedHistorySourceId::ClaudeCode;
    let session_id = "claudecodeapp-large-shell-artifact";
    let source_session_id = "large-shell-artifact";
    let output = format!("BEGIN:{}:END", "x".repeat(10 * 1024 * 1024));
    let user = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:00Z",
        "message":{"role":"user","content":"run a large command"}
    });
    let call = json!({
        "type":"assistant", "timestamp":"2026-07-22T00:00:01Z",
        "message":{"role":"assistant","content":[{
            "type":"tool_use", "id":"shell-large", "name":"Bash",
            "input":{"command":"printf payload"}
        }]}
    });
    let result = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:02Z",
        "message":{"role":"user","content":[{
            "type":"tool_result", "tool_use_id":"shell-large", "content":output.clone()
        }]}
    });
    let path = std::env::temp_dir().join(format!(
        "orgii-claude-large-shell-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(&path, format!("{user}\n{call}\n{result}\n")).expect("large Claude JSONL");
    let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
    SqliteRecordStore::init_tables(&conn).expect("base schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
        params![
            source.as_str(),
            source_session_id,
            session_id,
            path.to_string_lossy()
        ],
    )
    .expect("cache source path");

    let opened = crate::sources::imported_history::replay::open_window(
        &mut conn,
        source,
        session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("index large Claude Shell output");
    assert_eq!(opened.stats.parsed_rows, 3);
    let shell = opened
        .chunks
        .iter()
        .find(|chunk| chunk.chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
        .expect("Claude Shell event");
    let artifact_count = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source=?1 AND generation=?2",
            params![source.as_str(), &opened.cursor.generation],
            |row| row.get::<_, i64>(0),
        )
        .expect("Claude artifact count");
    assert_eq!(artifact_count, 1);

    reset_payload_fallback_decodes();
    let mut actual_hash = 0xcbf29ce484222325_u64;
    let mut actual_bytes = 0_usize;
    let mut offset = 0_u64;
    loop {
        let range = crate::sources::imported_history::replay::read_payload_range(
            &mut conn,
            source,
            session_id,
            &opened.cursor.generation,
            &shell.chunk.chunk_id,
            "result.output",
            offset,
            Some(crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES),
        )
        .expect("read Claude artifact page");
        assert!(
            range.text.len()
                <= crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES
        );
        assert!(range.next_offset > offset || range.eof);
        actual_hash = update_hash(actual_hash, &range.text);
        actual_bytes = actual_bytes.saturating_add(range.text.len());
        offset = range.next_offset;
        if range.eof {
            break;
        }
    }
    assert_eq!(actual_bytes, output.len());
    assert_eq!(actual_hash, update_hash(0xcbf29ce484222325, &output));
    assert_eq!(payload_fallback_decodes(), 0);
    let _ = fs::remove_file(path);
}

#[test]
fn large_real_driver_rows_keep_edit_and_git_metadata_projection() {
    let source = ImportedHistorySourceId::ClaudeCode;
    let session_id = "claudecodeapp-metadata-fixture";
    let source_session_id = "metadata-fixture";
    let user = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:00Z",
        "message":{"role":"user","content":"edit and commit"}
    });
    let edit_call = json!({
        "type":"assistant", "timestamp":"2026-07-22T00:00:01Z",
        "message":{"role":"assistant","content":[{
            "type":"tool_use", "id":"edit-1", "name":"Edit",
            "input":{
                "file_path":"src/large.rs",
                "old_string":"old\n".repeat(3_000),
                "new_string":"new\n".repeat(3_000)
            }
        }]}
    });
    let edit_result = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:02Z",
        "message":{"role":"user","content":[{
            "type":"tool_result", "tool_use_id":"edit-1", "content":"updated"
        }]},
        "toolUseResult":{
            "filePath":"src/large.rs",
            "structuredPatch":[{
                "oldStart":1,"oldLines":1,"newStart":1,"newLines":2,
                "lines":["-old","+new","+another"]
            }]
        }
    });
    let git_command = format!("git commit -m metadata # {}", "x".repeat(40 * 1024));
    let git_call = json!({
        "type":"assistant", "timestamp":"2026-07-22T00:00:03Z",
        "message":{"role":"assistant","content":[{
            "type":"tool_use", "id":"git-1", "name":"Bash",
            "input":{"command":git_command}
        }]}
    });
    let git_output = format!(
        "[feature abc1234] metadata\n{}\nhttps://github.com/acme/repo/pull/42\n{}",
        "middle".repeat(8 * 1024),
        "tail".repeat(12 * 1024)
    );
    let git_result = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:04Z",
        "message":{"role":"user","content":[{
            "type":"tool_result", "tool_use_id":"git-1", "content":git_output
        }]}
    });
    let path = std::env::temp_dir().join(format!(
        "orgii-claude-metadata-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(
        &path,
        format!("{user}\n{edit_call}\n{edit_result}\n{git_call}\n{git_result}\n"),
    )
    .expect("metadata fixture");
    let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
    SqliteRecordStore::init_tables(&conn).expect("base schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
        params![
            source.as_str(),
            source_session_id,
            session_id,
            path.to_string_lossy()
        ],
    )
    .expect("cache metadata source");

    let opened = crate::sources::imported_history::replay::open_window(
        &mut conn,
        source,
        session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("index metadata fixture");
    let turn_id = opened.turn_headers[0].turn_id.clone();
    let projected = crate::sources::imported_history::replay::project_turn_metadata(
        &mut conn,
        source,
        session_id,
        Some(std::slice::from_ref(&turn_id)),
    )
    .expect("project compact driver rows");

    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].modified_files.len(), 1);
    assert_eq!(projected[0].modified_files[0].path, "src/large.rs");
    assert_eq!(projected[0].modified_files[0].additions, 2);
    assert_eq!(projected[0].modified_files[0].deletions, 1);
    assert!(projected[0]
        .git_artifacts
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
    assert!(projected[0]
        .git_artifacts
        .iter()
        .any(|artifact| artifact.pr_number == Some(42)));

    let (edit_args, git_args, git_result): (String, String, String) = conn
        .query_row(
            "SELECT
                    MAX(CASE WHEN function_name LIKE 'edit%' THEN args_preview_json END),
                    MAX(CASE WHEN function_name='run_command_line' THEN args_preview_json END),
                    MAX(CASE WHEN function_name='run_command_line' THEN result_preview_json END)
                 FROM imported_replay_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("compact metadata rows");
    assert!(edit_args.len() < 20 * 1024);
    assert!(edit_args.contains("src/large.rs"));
    assert!(git_args.len() < 100 * 1024);
    assert!(git_result.contains("_replayGitArtifacts"));
    let _ = fs::remove_file(path);
}

#[test]
fn cross_line_tool_result_updates_the_stable_call_without_cursor_payload() {
    let source = ImportedHistorySourceId::Omp;
    let call = json!({
        "type":"assistant", "timestamp":"2026-07-22T00:00:00Z",
        "message":{"role":"assistant","content":[{
            "type":"tool_use","id":"call-1","name":"bash","input":{"command":"pwd"}
        }]}
    });
    let result = json!({
        "type":"user", "timestamp":"2026-07-22T00:00:01Z",
        "message":{"role":"user","content":[{
            "type":"tool_result","tool_use_id":"call-1","content":"/repo"
        }]}
    });
    let path = std::env::temp_dir().join(format!(
        "orgii-omp-tool-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(&path, format!("{call}\n")).expect("tool call fixture");
    let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
    SqliteRecordStore::init_tables(&conn).expect("base schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    let cold = {
        let tx = conn.transaction().expect("cold transaction");
        let outcome = sync(
            &tx,
            source,
            "ompapp-tool-fixture",
            "tool-fixture",
            &path,
            "generation-1",
            1,
            None,
            "sample-1",
        )
        .expect("index tool call");
        tx.commit().expect("commit tool call");
        outcome
    };
    let event_before: (String, String) = conn
        .query_row(
            "SELECT event_id, result_preview_json FROM imported_replay_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("pending tool event");
    assert!(!event_before.1.contains("/repo"));

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append result");
    writeln!(file, "{result}").expect("write tool result");
    drop(file);
    let state = state_from(&cold, source);
    let completed = {
        let tx = conn.transaction().expect("result transaction");
        let outcome = sync(
            &tx,
            source,
            "ompapp-tool-fixture",
            "tool-fixture",
            &path,
            "generation-1",
            2,
            Some(&state),
            "sample-2",
        )
        .expect("index tool result");
        tx.commit().expect("commit tool result");
        outcome
    };
    let event_after: (String, String) = conn
        .query_row(
            "SELECT event_id, result_preview_json FROM imported_replay_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("completed tool event");
    assert_eq!(event_after.0, event_before.0);
    assert!(event_after.1.contains("/repo"));
    assert_eq!(completed.total_events, 1);
    assert!(!completed.driver_cursor_json.contains("/repo"));
    let _ = fs::remove_file(path);
}

#[test]
fn ten_mib_single_line_keeps_only_preview_locator_and_compact_cursor() {
    let source = ImportedHistorySourceId::ClaudeCode;
    let session_id = "claudecodeapp-ten-mib-fixture";
    let source_session_id = "ten-mib-fixture";
    let body = "x".repeat(10 * 1024 * 1024);
    let line = json!({
        "type":"assistant", "timestamp":"2026-07-22T00:00:00Z",
        "message":{"role":"assistant","content":[{"type":"text","text":body}]}
    });
    let path = std::env::temp_dir().join(format!(
        "orgii-claude-ten-mib-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(&path, format!("{line}\n")).expect("10 MiB fixture");
    let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
    SqliteRecordStore::init_tables(&conn).expect("base schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES (?1, ?2, ?3, ?4)",
        params![
            source.as_str(),
            source_session_id,
            session_id,
            path.to_string_lossy()
        ],
    )
    .expect("cache 10 MiB source");

    let opened = crate::sources::imported_history::replay::open_window(
        &mut conn,
        source,
        session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open 10 MiB bounded replay");
    assert_eq!(opened.chunks.len(), 1);
    assert!(opened.stats.parsed_bytes >= 10 * 1024 * 1024);
    assert!(serde_json::to_vec(&opened.chunks[0].chunk).unwrap().len() < 20 * 1024);
    assert_eq!(opened.chunks[0].payloads[0].total_bytes, 10 * 1024 * 1024);
    let cursor_json: String = conn
        .query_row(
            "SELECT driver_cursor_json FROM imported_replay_state
                 WHERE source=?1 AND source_session_id=?2",
            params![source.as_str(), source_session_id],
            |row| row.get(0),
        )
        .expect("compact cursor");
    assert!(cursor_json.len() < 64 * 1024);
    assert!(!cursor_json.contains(&"x".repeat(1024)));

    let unchanged = crate::sources::imported_history::replay::poll_delta(
        &mut conn,
        source,
        session_id,
        &opened.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("unchanged 10 MiB poll");
    assert_eq!(unchanged.stats.parsed_bytes, 0);
    assert_eq!(unchanged.stats.parsed_rows, 0);
    assert!(unchanged.chunks.is_empty());
    let _ = fs::remove_file(path);
}
