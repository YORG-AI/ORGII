use super::*;
use crate::store::sqlite::SqliteRecordStore;

fn codex_fixture() -> (rusqlite::Connection, std::path::PathBuf, String) {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory replay DB");
    SqliteRecordStore::init_tables(&conn).expect("replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    let path = std::env::temp_dir().join(format!(
        "orgii-codex-replay-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let session_id = "codexapp-replay-fixture".to_string();
    conn.execute(
        "INSERT INTO imported_history_session_cache (
                source, source_session_id, session_id, source_path
             ) VALUES ('codex_app', 'replay-fixture', ?1, ?2)",
        rusqlite::params![session_id, path.to_string_lossy()],
    )
    .expect("cache fixture source");
    (conn, path, session_id)
}

fn jsonl(payload: serde_json::Value) -> String {
    serde_json::json!({
        "timestamp": "2026-07-22T00:00:00Z",
        "type": "event_msg",
        "payload": payload,
    })
    .to_string()
}

#[test]
fn limits_are_always_hard_bounded() {
    let limits = ReplayLimits {
        max_turns: usize::MAX,
        max_events: usize::MAX,
        max_ipc_bytes: usize::MAX,
    }
    .bounded();
    assert_eq!(limits.max_turns, HARD_MAX_TURNS);
    assert_eq!(limits.max_events, HARD_MAX_EVENTS);
    assert_eq!(limits.max_ipc_bytes, HARD_MAX_IPC_BYTES);
}

#[test]
fn compact_only_fields_are_explicit_for_compatibility_serializers() {
    for key in [
        "_replayTruncated",
        "_preview",
        crate::development_artifact::REPLAY_GIT_ARTIFACTS_FIELD,
    ] {
        assert!(is_compact_only_replay_field(key), "{key}");
    }
    assert!(!is_compact_only_replay_field("output"));
    assert!(!is_compact_only_replay_field("path"));
}

#[test]
fn payload_encoding_is_explicit_on_new_wire_rows_and_inferred_only_for_legacy_rows() {
    let legacy_root: ReplayPayloadDescriptor = serde_json::from_value(serde_json::json!({
        "fieldPath":"args",
        "kind":"tool_arguments",
        "spans":[],
        "totalBytes":12
    }))
    .expect("legacy root descriptor");
    let legacy_nested: ReplayPayloadDescriptor = serde_json::from_value(serde_json::json!({
        "fieldPath":"result.content.0.text",
        "kind":"assistant_content",
        "spans":[],
        "totalBytes":12
    }))
    .expect("legacy nested descriptor");
    assert_eq!(
        legacy_root.resolved_encoding(),
        ReplayPayloadEncoding::JsonValue
    );
    assert_eq!(
        legacy_nested.resolved_encoding(),
        ReplayPayloadEncoding::Utf8Text
    );

    let descriptor = ReplayPayloadDescriptor {
        field_path: "args".to_string(),
        kind: ReplayPayloadKind::ToolArguments,
        encoding: ReplayPayloadEncoding::JsonValue,
        body_projection: Some(ReplayPayloadBodyProjection {
            field_path: "args.command".to_string(),
            text: "cargo test".to_string(),
            truncated: false,
        }),
        spans: Vec::new(),
        total_bytes: 12,
        source_ordinal: None,
        source_key: None,
    };
    let wire = serde_json::to_value(descriptor).expect("descriptor wire JSON");
    assert_eq!(wire["encoding"], "json_value");
    assert_eq!(wire["bodyProjection"]["fieldPath"], "args.command");
    assert_eq!(wire["bodyProjection"]["text"], "cargo test");
}

#[test]
fn root_body_projection_uses_semantic_priority_and_utf8_byte_limit() {
    let value = serde_json::json!({
        "description":"lower-priority",
        "command":format!("BEGIN{}END", "你".repeat(20))
    });
    let projection = replay_payload_body_projection("args", &value, None, 20, false)
        .expect("semantic body projection");
    assert_eq!(projection.field_path, "args.command");
    assert!(projection.text.starts_with("BEGIN"));
    assert!(projection.text.len() <= 20);
    assert!(projection.truncated);
    assert!(std::str::from_utf8(projection.text.as_bytes()).is_ok());
}

#[test]
fn lifecycle_source_binding_preserves_existing_catalog_metadata() {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory replay DB");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");
    let source_session_id = "rollout-2026-07-22T00-00-00-fixture";
    let session_id = format!("codexapp-{source_session_id}");
    let source_path = std::env::temp_dir().join(format!(
        "orgii-replay-binding-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::write(&source_path, b"{}\n").expect("write replay source");
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path,name,input_tokens,listable
             ) VALUES('codex_app',?1,?2,'/stale/path','curated title',42,1)",
        rusqlite::params![source_session_id, session_id],
    )
    .expect("insert catalog metadata");

    bind_source_path(
        &conn,
        ImportedHistorySourceId::CodexApp,
        source_session_id,
        &session_id,
        &source_path,
    )
    .expect("bind lifecycle source");

    let (bound_path, title, input_tokens, listable): (String, String, i64, i64) = conn
        .query_row(
            "SELECT source_path,name,input_tokens,listable
                   FROM imported_history_session_cache
                  WHERE source='codex_app' AND source_session_id=?1",
            [source_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read rebound catalog row");
    assert_eq!(
        std::path::PathBuf::from(bound_path),
        source_path.canonicalize().expect("canonical source")
    );
    assert_eq!(title, "curated title");
    assert_eq!(input_tokens, 42);
    assert_eq!(listable, 1);

    let mismatch = bind_source_path(
        &conn,
        ImportedHistorySourceId::CodexApp,
        "different-source-key",
        &session_id,
        &source_path,
    )
    .expect_err("source identity mismatch");
    assert!(mismatch.contains("Replay source identity mismatch"));
    let _ = std::fs::remove_file(source_path);
}

#[test]
fn every_registered_adapter_is_incremental() {
    for source in ImportedHistorySourceId::ALL {
        ensure_supported(source).expect("all 15 imported sources have bounded replay");
    }
}

#[test]
fn codex_append_is_incremental_and_partial_tail_is_retried() {
    use std::io::Write;

    let (mut conn, path, session_id) = codex_fixture();
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"hello"}))
        ),
    )
    .expect("initial JSONL");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open bounded replay");
    assert_eq!(opened.chunks.len(), 1);
    let cursor = opened.cursor;

    let partial = jsonl(serde_json::json!({
        "type":"agent_message",
        "message":"arrives only after newline"
    }));
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append fixture");
    file.write_all(partial.as_bytes()).expect("partial record");
    file.flush().expect("flush partial");
    let partial_delta = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &cursor,
        ReplayLimits::default(),
    )
    .expect("poll partial tail");
    assert!(partial_delta.chunks.is_empty());
    assert_eq!(partial_delta.stats.parsed_bytes, 0);
    assert_eq!(partial_delta.cursor.revision, cursor.revision);

    file.write_all(b"\n").expect("finish record");
    file.flush().expect("flush newline");
    drop(file);
    let completed_delta = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &cursor,
        ReplayLimits::default(),
    )
    .expect("poll completed record");
    assert_eq!(completed_delta.chunks.len(), 1);
    assert!(completed_delta.stats.parsed_bytes > 0);
    assert_eq!(
        completed_delta.chunks[0].chunk.function,
        super::super::FUNCTION_ASSISTANT
    );
    let mut unchanged_cursor = completed_delta.cursor;
    for poll in 0..20 {
        let unchanged = poll_delta(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &unchanged_cursor,
            ReplayLimits::default(),
        )
        .unwrap_or_else(|error| panic!("unchanged poll {poll} failed: {error}"));
        assert!(unchanged.chunks.is_empty(), "unchanged poll {poll}");
        assert_eq!(
            unchanged.stats,
            ReplayStats::default(),
            "unchanged poll {poll} must parse, normalize, upsert, and send nothing"
        );
        unchanged_cursor = unchanged.cursor;
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn unchanged_integrity_sample_refreshes_the_sixty_second_watermark() {
    let (mut conn, path, session_id) = codex_fixture();
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"hello"}))
        ),
    )
    .expect("initial JSONL");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open bounded replay");

    conn.execute(
        "UPDATE imported_replay_state SET updated_at='1970-01-01T00:00:00Z'
             WHERE source='codex_app' AND source_session_id='replay-fixture'",
        [],
    )
    .expect("expire integrity watermark");
    index::take_file_sample_count();
    let before_touch = chrono::Utc::now().timestamp_millis();
    let sampled = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .expect("integrity poll");
    assert_eq!(sampled.stats, ReplayStats::default());
    assert_eq!(index::take_file_sample_count(), 1);
    let touched = index::load_state(&conn, ImportedHistorySourceId::CodexApp, "replay-fixture")
        .expect("load touched replay state")
        .expect("touched replay state");
    assert!(touched.state_updated_at_ms >= before_touch);

    let fast = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &sampled.cursor,
        ReplayLimits::default(),
    )
    .expect("metadata-only poll");
    assert_eq!(fast.stats, ReplayStats::default());
    assert_eq!(
        index::take_file_sample_count(),
        0,
        "the refreshed watermark must prevent another full integrity sample"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn codex_same_inode_growing_rewrite_resets_generation() {
    let (mut conn, path, session_id) = codex_fixture();
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"old"}))
        ),
    )
    .expect("initial JSONL");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open initial generation");

    // `fs::write` truncates and rewrites the existing inode.  Make the
    // replacement longer than the previous complete-line cursor so size
    // metadata alone would look exactly like an append.
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({
                "type":"user_message",
                "message":"replacement-is-deliberately-longer-than-old"
            }))
        ),
    )
    .expect("same-inode growing rewrite");
    let delta = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .expect("poll rewritten source");
    assert!(delta.reset_required);
    assert_ne!(delta.cursor.generation, opened.cursor.generation);
    let replacement = serde_json::to_string(
        &delta
            .chunks
            .iter()
            .map(|chunk| &chunk.chunk)
            .collect::<Vec<_>>(),
    )
    .expect("replacement chunks");
    assert!(replacement.contains("replacement-is-deliberately-longer-than-old"));
    assert!(!replacement.contains("\"old\""));
    let _ = std::fs::remove_file(path);
}

#[test]
fn codex_delta_honors_max_turns_across_many_new_turns() {
    use std::io::Write;

    let (mut conn, path, session_id) = codex_fixture();
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"seed"}))
        ),
    )
    .expect("seed JSONL");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open seed");
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append turns");
    for turn in 0..11 {
        writeln!(
            file,
            "{}",
            jsonl(serde_json::json!({
                "type":"user_message",
                "message":format!("turn-{turn}")
            }))
        )
        .expect("append turn");
    }
    drop(file);
    let limits = ReplayLimits {
        max_turns: 10,
        max_events: 200,
        max_ipc_bytes: HARD_MAX_IPC_BYTES,
    };
    let first = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor,
        limits,
    )
    .expect("first bounded delta");
    assert_eq!(
        first
            .chunks
            .iter()
            .map(|chunk| chunk.turn_index)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        10
    );
    let second = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &first.cursor,
        limits,
    )
    .expect("remaining turn delta");
    assert_eq!(
        second
            .chunks
            .iter()
            .map(|chunk| chunk.turn_index)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn codex_large_body_is_source_backed_and_range_bounded() {
    let (mut conn, path, session_id) = codex_fixture();
    let large = format!("BEGIN-{}-END", "你".repeat(10_000));
    std::fs::write(
        &path,
        format!(
            "{}\n{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"hello"})),
            jsonl(serde_json::json!({"type":"agent_message","message":large.clone()})),
        ),
    )
    .expect("large JSONL");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open bounded replay");
    let assistant = opened
        .chunks
        .iter()
        .find(|chunk| chunk.chunk.function == super::super::FUNCTION_ASSISTANT)
        .expect("assistant event");
    assert!(serde_json::to_vec(&assistant.chunk).unwrap().len() < 16 * 1024);
    assert_eq!(assistant.payloads.len(), 1);

    let mut reconstructed = String::new();
    let mut offset = 0_u64;
    loop {
        let range = read_payload_range(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor.generation,
            &assistant.chunk.chunk_id,
            "result.content",
            offset,
            Some(1024),
        )
        .expect("read source-backed payload range");
        assert!(range.text.len() <= 1024);
        reconstructed.push_str(&range.text);
        offset = range.next_offset;
        if range.eof {
            break;
        }
    }
    assert_eq!(reconstructed, large);
    let _ = std::fs::remove_file(path);
}

#[test]
fn compact_ipc_budget_counts_payload_descriptors_and_fails_closed() {
    let (mut conn, path, session_id) = codex_fixture();
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({
                "type":"agent_message",
                "message":"x".repeat(20_000)
            }))
        ),
    )
    .expect("descriptor fixture");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open descriptor fixture");
    assert_eq!(opened.chunks.len(), 1);
    let chunk_only = serde_json::to_vec(&opened.chunks[0].chunk)
        .expect("serialize chunk")
        .len();
    let descriptors = serde_json::to_vec(&opened.chunks[0].payloads)
        .expect("serialize descriptors")
        .len();
    assert!(descriptors > 0);

    let error = read_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        None,
        ReplayLimits {
            max_turns: 1,
            max_events: 200,
            max_ipc_bytes: chunk_only,
        },
    )
    .expect_err("descriptor bytes must not bypass the compact limit");
    assert!(error.contains("compact window budget"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn codex_ten_mib_shell_payload_is_materialized_once_and_generation_scoped() {
    fn hash_text(text: &str) -> u64 {
        text.as_bytes()
            .iter()
            .fold(0xcbf29ce484222325_u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
            })
    }

    fn transcript(output: &str) -> String {
        format!(
            "{}\n{}\n{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"run it"})),
            jsonl(serde_json::json!({
                "type":"function_call",
                "name":"shell_command",
                "arguments":"{\"command\":\"printf payload\"}",
                "call_id":"call-large-output"
            })),
            jsonl(serde_json::json!({
                "type":"function_call_output",
                "call_id":"call-large-output",
                "output":output
            })),
        )
    }

    let (mut conn, path, session_id) = codex_fixture();
    let old_output = format!("OLD:{}:END", "A".repeat(10 * 1024 * 1024));
    std::fs::write(&path, transcript(&old_output)).expect("10 MiB Codex transcript");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("index 10 MiB Codex transcript");
    assert_eq!(opened.stats.parsed_rows, 3);
    let shell = opened
        .chunks
        .iter()
        .find(|chunk| chunk.chunk.function == super::super::FUNCTION_RUN_COMMAND_LINE)
        .expect("Codex Shell event");
    let artifact_count = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source='codex_app' AND generation=?1",
            [&opened.cursor.generation],
            |row| row.get::<_, i64>(0),
        )
        .expect("Codex artifact count");
    assert_eq!(artifact_count, 1);

    codex_jsonl::reset_payload_fallback_decodes();
    let mut reconstructed = String::with_capacity(old_output.len());
    let mut offset = 0_u64;
    loop {
        let range = read_payload_range(
            &mut conn,
            ImportedHistorySourceId::CodexApp,
            &session_id,
            &opened.cursor.generation,
            &shell.chunk.chunk_id,
            "result.output",
            offset,
            Some(HARD_MAX_PAYLOAD_RANGE_BYTES),
        )
        .expect("read Codex Shell artifact page");
        assert!(range.text.len() <= HARD_MAX_PAYLOAD_RANGE_BYTES);
        assert!(range.next_offset > offset || range.eof);
        reconstructed.push_str(&range.text);
        offset = range.next_offset;
        if range.eof {
            break;
        }
    }
    assert_eq!(hash_text(&reconstructed), hash_text(&old_output));
    assert_eq!(reconstructed.len(), old_output.len());
    assert_eq!(codex_jsonl::payload_fallback_decodes(), 0);

    let new_output = format!("NEW:{}:END", "B".repeat(10 * 1024 * 1024));
    assert_eq!(new_output.len(), old_output.len());
    std::fs::write(&path, transcript(&new_output)).expect("same-size replacement");
    let replaced = poll_delta(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .expect("replace Codex generation");
    assert!(replaced.reset_required);
    assert_ne!(replaced.cursor.generation, opened.cursor.generation);
    let replacement_shell = replaced
        .chunks
        .iter()
        .find(|chunk| chunk.chunk.function == super::super::FUNCTION_RUN_COMMAND_LINE)
        .expect("replacement Shell event");
    let replacement = read_payload_range(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &replaced.cursor.generation,
        &replacement_shell.chunk.chunk_id,
        "result.output",
        0,
        Some(64),
    )
    .expect("replacement artifact page");
    assert!(replacement.text.starts_with("NEW:BBBB"));
    assert_eq!(codex_jsonl::payload_fallback_decodes(), 0);
    let generations = conn
        .query_row(
            "SELECT COUNT(DISTINCT generation) FROM imported_replay_payload_artifacts
                 WHERE source='codex_app'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("live artifact generations");
    assert_eq!(generations, 1, "replaced generation artifacts are retired");
    let _ = std::fs::remove_file(path);
}

#[test]
fn pinned_generation_scan_rejects_a_mixed_snapshot() {
    let (mut conn, path, session_id) = codex_fixture();
    std::fs::write(
        &path,
        format!(
            "{}\n",
            jsonl(serde_json::json!({"type":"user_message","message":"pinned"}))
        ),
    )
    .expect("pinned scan fixture");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open pinned generation");
    let error = scan_window_after_generation(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        "another-generation",
        opened.cursor.revision,
        -1,
        ReplayLimits::default(),
    )
    .expect_err("derived snapshots must not mix generations");
    assert!(error.contains("expected another-generation"));
    let error = scan_window_after_generation(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor.generation,
        opened.cursor.revision.saturating_add(1),
        -1,
        ReplayLimits::default(),
    )
    .expect_err("derived snapshots must not mix revisions");
    assert!(error.contains(&format!("@{}", opened.cursor.revision.saturating_add(1))));
    let pinned = scan_window_after_generation(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        &session_id,
        &opened.cursor.generation,
        opened.cursor.revision,
        -1,
        ReplayLimits::default(),
    )
    .expect("scan pinned generation");
    assert_eq!(pinned.cursor.generation, opened.cursor.generation);
    let _ = std::fs::remove_file(path);
}

#[test]
fn pinned_scan_preparation_restarts_only_twice() {
    let attempts = std::cell::Cell::new(0usize);
    let error = retry_pinned_scan_preparation("codexapp-changing", || {
        attempts.set(attempts.get().saturating_add(1));
        Ok(None)
    })
    .expect_err("continuously changing source must stop");
    assert_eq!(attempts.get(), MAX_PINNED_SCAN_RESTARTS + 1);
    assert!(error.contains("kept changing"));
    assert!(error.contains("after 2 restarts"));
}
