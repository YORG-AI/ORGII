use super::*;

fn managed_replay_test_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(
        "CREATE TABLE code_session_chunks (
                chunk_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                function TEXT NOT NULL,
                args_json TEXT NOT NULL,
                result_json TEXT NOT NULL,
                thread_id TEXT,
                process_id TEXT,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE code_session_history_mutations (
                session_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL
             );",
    )
    .expect("managed replay schema");
}

fn insert_managed_replay_chunk(
    conn: &rusqlite::Connection,
    session_id: &str,
    chunk_id: &str,
    sequence: i64,
    function: &str,
) {
    let action_type = match function {
        "user_message" => "user",
        "assistant_message" => "assistant",
        _ => "tool_call",
    };
    conn.execute(
        "INSERT INTO code_session_chunks(
                chunk_id,session_id,action_type,function,args_json,result_json,
                thread_id,process_id,sequence,created_at
             ) VALUES(?1,?2,?3,?4,'{}','{}',NULL,NULL,?5,?6)",
        rusqlite::params![
            chunk_id,
            session_id,
            action_type,
            function,
            sequence,
            format!("2026-07-22T00:00:{sequence:02}Z")
        ],
    )
    .expect("insert managed replay chunk");
}

fn managed_replay_limits(max_turns: usize) -> ReplayLimits {
    ReplayLimits {
        max_turns,
        max_events: 200,
        max_ipc_bytes: 4 * 1024 * 1024,
    }
}

#[test]
fn managed_chunk_replacement_resets_old_window_but_append_stays_delta() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("managed replay test DB");
    crate::agent_sessions::cli::init_cli_agent_tables(&conn).expect("managed CLI schema");
    for session_id in ["cliagent-epoch-old", "cliagent-epoch-new"] {
        conn.execute(
            "INSERT INTO code_sessions(session_id,created_at,updated_at)
                 VALUES(?1,'2026-07-23T00:00:00Z','2026-07-23T00:00:00Z')",
            [session_id],
        )
        .expect("managed replay session");
    }
    drop(conn);

    let make_chunk = |chunk_id: &str, session_id: &str, output: &str| {
        let mut chunk = ActivityChunk::new(session_id, "tool_result", "run_command_line");
        chunk.chunk_id = chunk_id.to_string();
        chunk.args = serde_json::json!({"command":"printf replay"});
        chunk.result = serde_json::json!({"output":output});
        chunk.created_at = "2026-07-23T00:00:00Z".to_string();
        chunk
    };
    let original = make_chunk("epoch-shell", "cliagent-epoch-old", "AAAA");
    crate::agent_sessions::cli::persistence::insert_chunk(&original, 0)
        .expect("initial managed append");
    let opened = managed_chunk_open_window("cliagent-epoch-old", managed_replay_limits(1))
        .expect("initial managed window");
    assert_eq!(opened.cursor.generation, "chunks-0");

    let appended = make_chunk("epoch-append", "cliagent-epoch-old", "tail");
    crate::agent_sessions::cli::persistence::insert_chunk(&appended, 1)
        .expect("managed append delta");
    let append_delta = managed_chunk_poll_delta(
        "cliagent-epoch-old",
        &opened.cursor,
        managed_replay_limits(1),
    )
    .expect("managed append poll");
    assert!(!append_delta.reset_required);
    assert_eq!(append_delta.cursor.generation, opened.cursor.generation);
    assert_eq!(append_delta.chunks.len(), 1);

    crate::agent_sessions::cli::persistence::insert_chunk(&original, 0)
        .expect("idempotent managed replace");
    let unchanged = managed_chunk_poll_delta(
        "cliagent-epoch-old",
        &append_delta.cursor,
        managed_replay_limits(1),
    )
    .expect("idempotent managed poll");
    assert!(!unchanged.reset_required);
    assert!(unchanged.chunks.is_empty());

    let changed = make_chunk("epoch-shell", "cliagent-epoch-old", "BBBB");
    crate::agent_sessions::cli::persistence::insert_chunk(&changed, 0)
        .expect("same-length managed replacement");
    let reset = managed_chunk_poll_delta(
        "cliagent-epoch-old",
        &append_delta.cursor,
        managed_replay_limits(1),
    )
    .expect("managed replacement reset");
    assert!(reset.reset_required);
    assert_eq!(reset.cursor.generation, "chunks-1");

    let moved = make_chunk("epoch-shell", "cliagent-epoch-new", "BBBB");
    crate::agent_sessions::cli::persistence::insert_chunk(&moved, 0)
        .expect("cross-session managed replacement");
    let old_reset = managed_chunk_poll_delta(
        "cliagent-epoch-old",
        &reset.cursor,
        managed_replay_limits(1),
    )
    .expect("old session reset after move");
    assert!(old_reset.reset_required);
    assert_eq!(old_reset.cursor.generation, "chunks-2");
    let new_window = managed_chunk_open_window("cliagent-epoch-new", managed_replay_limits(1))
        .expect("new session window after move");
    assert_eq!(new_window.cursor.generation, "chunks-1");
    assert!(new_window
        .chunks
        .iter()
        .any(|chunk| chunk.chunk.chunk_id == "epoch-shell"));
}

#[test]
fn readerless_managed_cli_pages_compact_turn_headers_without_duplicates() {
    let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
    managed_replay_test_schema(&conn);
    conn.execute(
        "INSERT INTO code_session_history_mutations VALUES(?1, 3)",
        ["cliagent-turns"],
    )
    .expect("managed replay generation");
    for (chunk_id, sequence, function) in [
        ("u0", 0, "user_message"),
        ("a0", 1, "assistant_message"),
        ("u1", 2, "user_message"),
        ("t1", 3, "run_command_line"),
        ("a1", 4, "assistant_message"),
        ("u2", 5, "user_message"),
        ("a2", 6, "assistant_message"),
    ] {
        insert_managed_replay_chunk(&conn, "cliagent-turns", chunk_id, sequence, function);
    }

    let latest = managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        None,
        None,
        None,
        managed_replay_limits(1),
    )
    .expect("latest managed turn");
    assert_eq!(latest.cursor.generation, "chunks-3");
    assert_eq!(latest.total_turn_count, 3);
    assert_eq!(latest.total_event_count, 7);
    assert!(latest.has_older);
    assert_eq!(latest.turn_headers.len(), 1);
    assert_eq!(latest.turn_headers[0].turn_id, "u2");
    assert_eq!(latest.turn_headers[0].turn_index, 2);
    assert_eq!(latest.turn_headers[0].start_sequence, 5);
    assert_eq!(latest.turn_headers[0].end_sequence, Some(6));
    assert_eq!(latest.turn_headers[0].event_count, 2);
    assert_eq!(
        latest
            .chunks
            .iter()
            .map(|chunk| (chunk.sequence, chunk.turn_index))
            .collect::<Vec<_>>(),
        vec![(5, 2), (6, 2)]
    );

    let middle = managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        None,
        None,
        Some(1),
        managed_replay_limits(1),
    )
    .expect("middle managed turn by index");
    assert_eq!(middle.turn_headers[0].turn_id, "u1");
    assert_eq!(
        middle
            .chunks
            .iter()
            .map(|chunk| (chunk.sequence, chunk.turn_index))
            .collect::<Vec<_>>(),
        vec![(2, 1), (3, 1), (4, 1)]
    );

    let oldest = managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        None,
        Some("u0"),
        None,
        managed_replay_limits(1),
    )
    .expect("oldest managed turn by id");
    assert!(!oldest.has_older);
    assert_eq!(oldest.turn_headers[0].turn_index, 0);
    assert_eq!(
        oldest
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );

    let prior = managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        Some(latest.turn_headers[0].start_sequence),
        None,
        None,
        managed_replay_limits(1),
    )
    .expect("managed turn before latest");
    assert_eq!(prior.turn_headers[0].turn_id, "u1");
    assert_eq!(prior.cursor.generation, latest.cursor.generation);
    assert_eq!(prior.cursor.revision, latest.cursor.revision);
    assert_ne!(
        prior.cursor.through_sequence,
        latest.cursor.through_sequence
    );
    assert_eq!(
        prior
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>(),
        vec![2, 3, 4]
    );
    assert!(prior.chunks.iter().all(|chunk| !latest
        .chunks
        .iter()
        .any(|item| item.sequence == chunk.sequence)));

    let latest_two = managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        None,
        None,
        None,
        managed_replay_limits(2),
    )
    .expect("latest two managed turns");
    assert_eq!(
        latest_two
            .turn_headers
            .iter()
            .map(|header| (&header.turn_id, header.turn_index))
            .collect::<Vec<_>>(),
        vec![(&"u1".to_string(), 1), (&"u2".to_string(), 2)]
    );
    assert_eq!(
        latest_two
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>(),
        vec![2, 3, 4, 5, 6]
    );

    assert!(managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        None,
        Some("a1"),
        None,
        managed_replay_limits(1),
    )
    .expect_err("non-anchor turn id must fail")
    .contains("no longer available"));
    assert!(managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-turns",
        None,
        None,
        Some(3),
        managed_replay_limits(1),
    )
    .expect_err("stale turn index must fail")
    .contains("no longer available"));
}

#[test]
fn readerless_large_single_turn_pages_from_actual_window_start_without_gaps() {
    let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
    managed_replay_test_schema(&conn);
    let session_id = "cliagent-large-single-turn";
    conn.execute(
        "INSERT INTO code_session_history_mutations VALUES(?1, 11)",
        [session_id],
    )
    .expect("managed replay generation");
    insert_managed_replay_chunk(&conn, session_id, "user-0", 0, "user_message");
    for sequence in 1..=450_i64 {
        insert_managed_replay_chunk(
            &conn,
            session_id,
            &format!("assistant-{sequence}"),
            sequence,
            "assistant_message",
        );
    }
    let filtered_page = normalize_window(
        managed_chunk_read_window_from_conn(
            &conn,
            session_id,
            None,
            None,
            None,
            managed_replay_limits(1),
        )
        .expect("filtered large-turn page"),
        session_id,
    );
    assert!(filtered_page.events.is_empty());
    assert_eq!(filtered_page.window_start_sequence, Some(251));
    assert!(filtered_page.has_older);
    conn.execute(
        "UPDATE code_session_chunks
             SET result_json=json_object('content',chunk_id)
             WHERE session_id=?1",
        [session_id],
    )
    .expect("make large-turn chunks visible to normalization");

    let latest_chunks = managed_chunk_read_window_from_conn(
        &conn,
        session_id,
        None,
        None,
        None,
        managed_replay_limits(1),
    )
    .expect("latest large-turn page");
    let latest_sequences = latest_chunks
        .chunks
        .iter()
        .map(|chunk| chunk.sequence)
        .collect::<Vec<_>>();
    assert_eq!(latest_sequences.len(), 200);
    assert_eq!(latest_sequences.first(), Some(&251));
    assert_eq!(latest_sequences.last(), Some(&450));
    let latest = normalize_window(latest_chunks, session_id);
    assert_eq!(latest.window_start_sequence, Some(251));
    assert_eq!(latest.turn_headers[0].start_sequence, 0);
    assert!(latest.has_older);

    let middle_chunks = managed_chunk_read_window_from_conn(
        &conn,
        session_id,
        latest.window_start_sequence,
        None,
        None,
        managed_replay_limits(1),
    )
    .expect("middle large-turn page");
    let middle_sequences = middle_chunks
        .chunks
        .iter()
        .map(|chunk| chunk.sequence)
        .collect::<Vec<_>>();
    assert_eq!(middle_sequences.len(), 200);
    assert_eq!(middle_sequences.first(), Some(&51));
    assert_eq!(middle_sequences.last(), Some(&250));
    let middle = normalize_window(middle_chunks, session_id);
    assert_eq!(middle.window_start_sequence, Some(51));
    assert_eq!(middle.turn_headers[0].start_sequence, 0);
    assert!(middle.has_older);
    assert_eq!(middle.cursor.generation, latest.cursor.generation);
    assert_eq!(middle.cursor.revision, latest.cursor.revision);

    let oldest_chunks = managed_chunk_read_window_from_conn(
        &conn,
        session_id,
        middle.window_start_sequence,
        None,
        None,
        managed_replay_limits(1),
    )
    .expect("oldest large-turn page");
    let oldest_sequences = oldest_chunks
        .chunks
        .iter()
        .map(|chunk| chunk.sequence)
        .collect::<Vec<_>>();
    assert_eq!(oldest_sequences.len(), 51);
    assert_eq!(oldest_sequences.first(), Some(&0));
    assert_eq!(oldest_sequences.last(), Some(&50));
    let oldest = normalize_window(oldest_chunks, session_id);
    assert_eq!(oldest.window_start_sequence, Some(0));
    assert!(!oldest.has_older);

    let mut sequences = oldest_sequences
        .into_iter()
        .chain(middle_sequences)
        .chain(latest_sequences)
        .collect::<Vec<_>>();
    sequences.sort_unstable();
    sequences.dedup();
    assert_eq!(sequences, (0..=450_i64).collect::<Vec<_>>());
}

#[test]
fn readerless_managed_cli_uses_one_fallback_turn_without_user_rows() {
    let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
    managed_replay_test_schema(&conn);
    insert_managed_replay_chunk(&conn, "cliagent-fallback", "a0", 10, "assistant_message");
    insert_managed_replay_chunk(&conn, "cliagent-fallback", "t0", 11, "run_command_line");

    let window = managed_chunk_read_window_from_conn(
        &conn,
        "cliagent-fallback",
        None,
        None,
        None,
        managed_replay_limits(1),
    )
    .expect("managed fallback turn");
    assert_eq!(window.total_turn_count, 1);
    assert_eq!(window.turn_headers[0].turn_id, "a0");
    assert_eq!(window.turn_headers[0].start_sequence, 10);
    assert_eq!(window.turn_headers[0].end_sequence, Some(11));
    assert_eq!(window.turn_headers[0].event_count, 2);
    assert_eq!(
        window
            .chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>(),
        vec![10, 11]
    );
}

#[test]
fn readerless_managed_cli_compacts_ten_mib_row_and_ranges_without_full_column_reads() {
    let conn = rusqlite::Connection::open_in_memory().expect("managed replay DB");
    conn.execute_batch(
        "CREATE TABLE code_session_chunks (
                chunk_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                function TEXT NOT NULL,
                args_json TEXT NOT NULL,
                result_json TEXT NOT NULL,
                thread_id TEXT,
                process_id TEXT,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE code_session_history_mutations (
                session_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL
             );
             INSERT INTO code_session_history_mutations VALUES('cliagent-large', 7);",
    )
    .expect("managed chunks schema");
    let full = format!("{}END", "中🙂shell-output\n".repeat(550_000));
    let expected_payload_hash = sha256_hex(full.as_bytes());
    let result_json =
        serde_json::to_string(&serde_json::json!({"output":full})).expect("large managed result");
    assert!(result_json.len() > 10 * 1024 * 1024);
    conn.execute(
        "INSERT INTO code_session_chunks VALUES(
                'chunk-large','cliagent-large','tool_call','run_command_line',
                '{\"command\":\"printf test\"}',?1,NULL,NULL,0,'2026-07-22T00:00:00Z'
             )",
        [result_json],
    )
    .expect("insert managed chunk");

    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
    let chunks = query_managed_chunks(
        &conn,
        "cliagent-large",
        "sequence < ?2",
        i64::MAX,
        None,
        ReplayLimits {
            max_turns: 1,
            max_events: 200,
            max_ipc_bytes: 4 * 1024 * 1024,
        },
        true,
    )
    .expect("bounded managed open row");
    assert_eq!(chunks.len(), 1);
    assert!(serde_json::to_vec(&chunks[0].chunk).unwrap().len() < 64 * 1024);
    assert_eq!(chunks[0].payloads.len(), 1);
    assert_eq!(chunks[0].payloads[0].field_path, "result.output");
    assert!(
        MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
            <= MANAGED_CHUNK_INLINE_JSON_MAX_BYTES,
        "open must not copy a source-sized SQLite JSON column into Rust"
    );
    assert!(
        chunks[0]
            .chunk
            .result
            .get("output")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|preview| preview.len() < 64 * 1024 && preview.is_char_boundary(0)),
        "projected preview must remain bounded valid UTF-8"
    );

    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
    let unchanged = query_managed_chunks(
        &conn,
        "cliagent-large",
        "sequence > ?2",
        0,
        None,
        ReplayLimits {
            max_turns: 1,
            max_events: 200,
            max_ipc_bytes: 4 * 1024 * 1024,
        },
        false,
    )
    .expect("unchanged managed poll");
    assert!(unchanged.is_empty());
    assert_eq!(
        MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed),
        0,
        "unchanged poll must not fetch any JSON field"
    );

    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
    let mut rebuilt_hash = Sha256::new();
    let mut offset = 0_u64;
    let mut calls = 0_usize;
    loop {
        let range = managed_chunk_payload_range_from_conn(
            &conn,
            "cliagent-large",
            "chunk-large",
            "result.output",
            offset,
            64 * 1024,
        )
        .expect("managed payload range");
        assert!(range.text.len() <= 64 * 1024);
        rebuilt_hash.update(range.text.as_bytes());
        calls += 1;
        if range.eof {
            break;
        }
        assert!(range.next_offset > offset);
        offset = range.next_offset;
    }
    assert!(calls > 100);
    assert_eq!(
        format!("{:x}", rebuilt_hash.finalize()),
        expected_payload_hash
    );
    assert!(
        MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed) <= 64 * 1024 + 4,
        "payload-range must only fetch the requested slice plus UTF-8 boundary bytes"
    );

    #[derive(Default)]
    struct HashingSink {
        bytes: u64,
        hash: Sha256,
    }

    impl std::io::Write for HashingSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self.bytes.saturating_add(bytes.len() as u64);
            self.hash.update(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
    let mut export_sink = HashingSink::default();
    let export_generation = stream_managed_chunk_replay_events_from_conn(
        &conn,
        "cliagent-large",
        "testing managed export",
        |event, read_payload| write_hydrated_event_json(&mut export_sink, event, read_payload),
    )
    .expect("stream managed export");
    assert_eq!(export_generation, "chunks-7");
    assert!(export_sink.bytes > full.len() as u64);
    assert!(
        MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
            <= EXPORT_PAYLOAD_RANGE_BYTES + MANAGED_CHUNK_UTF8_BOUNDARY_BYTES,
        "streamed export must not fetch a source-sized SQLite JSON column"
    );

    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
    let mut cloud_hash = Sha256::new();
    let mut cloud_ranges = 0_usize;
    let cloud_generation = stream_managed_chunk_replay_events_from_conn(
        &conn,
        "cliagent-large",
        "testing managed Cloud spool",
        |event, read_payload| {
            let payload_ref = event
                .payload_refs
                .iter()
                .find(|payload_ref| payload_ref.field_path == "result.output")
                .ok_or_else(|| "managed Cloud payload locator is missing".to_string())?;
            let mut offset = 0_u64;
            loop {
                let range = read_payload(payload_ref, offset)?;
                cloud_hash.update(range.text.as_bytes());
                cloud_ranges = cloud_ranges.saturating_add(1);
                if range.eof {
                    break;
                }
                if range.next_offset <= offset {
                    return Err("managed Cloud payload cursor did not advance".to_string());
                }
                offset = range.next_offset;
            }
            Ok(())
        },
    )
    .expect("stream managed Cloud spool");
    assert_eq!(cloud_generation, "chunks-7");
    assert!(cloud_ranges > 20);
    assert_eq!(
        format!("{:x}", cloud_hash.finalize()),
        expected_payload_hash
    );
    assert!(
        MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
            <= EXPORT_PAYLOAD_RANGE_BYTES + MANAGED_CHUNK_UTF8_BOUNDARY_BYTES,
        "Cloud spool must share the bounded database/range path"
    );

    let invalid = "x".repeat(128 * 1024);
    conn.execute(
        "INSERT INTO code_session_chunks VALUES(
                'chunk-invalid','cliagent-large','tool_call','tool',
                '{}',?1,NULL,NULL,1,'2026-07-22T00:00:01Z'
             )",
        [invalid],
    )
    .expect("insert oversized non-JSON managed chunk");
    MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.store(0, Ordering::Relaxed);
    let error = query_managed_chunks(
        &conn,
        "cliagent-large",
        "sequence > ?2",
        0,
        None,
        ReplayLimits {
            max_turns: 1,
            max_events: 200,
            max_ipc_bytes: 4 * 1024 * 1024,
        },
        false,
    )
    .expect_err("oversized non-JSON must preserve fail-closed semantics");
    assert!(error.contains("invalid JSON"));
    assert!(
        MANAGED_CHUNK_MAX_DB_JSON_FIELD_BYTES.load(Ordering::Relaxed)
            <= replay::NORMAL_PAYLOAD_PREVIEW_BYTES + MANAGED_CHUNK_UTF8_BOUNDARY_BYTES,
        "invalid oversized JSON must fail without copying the full column"
    );
}
