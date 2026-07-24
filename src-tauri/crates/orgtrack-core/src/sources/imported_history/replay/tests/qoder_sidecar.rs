use super::*;
use std::io::Write;

use crate::store::sqlite::SqliteRecordStore;

fn unique_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "orgii-qoder-sidecar-{label}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

fn fixture_log() -> String {
    [
            r#"2026-07-16 19:42:04.351 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=current_model_update"#,
            r#"2026-07-16 19:42:09.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=tool_call, toolCallId=call-a"#,
            r#"2026-07-16 19:42:09.200 [info] [SubAgentService] Registered SubAgent: {"parentToolCallId":"call-a","parentSessionId":"task-aaa111.session.execution","agentType":"GeneralPurpose","rawInputDescription":"inspect","prompt":"inspect memory"}"#,
            r#"2026-07-16 19:42:09.500 [info] ToolInvoke : run_in_terminal"#,
            r#"{"command":"vm_stat","cwd":"/workspace/a"}"#,
            r#"2026-07-16 19:42:09.600 [info] [ChatSessionService] ACP progress: task-bbb222.session.execution, rid=u, type=current_model_update"#,
            // No path signal while both windows overlap: must stay unowned.
            r#"2026-07-16 19:42:10.000 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-x, grep_search, {"query":"ambiguous"}"#,
            r#"2026-07-16 19:42:11.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=chat_finish"#,
            r#"2026-07-16 19:42:12.000 [info] [ChatSessionService] ACP progress: task-bbb222.session.execution, rid=u, type=chat_finish"#,
        ]
        .join("\n")
            + "\n"
}

fn prepare_replay_db(
    conn: &mut rusqlite::Connection,
    source_session_id: &str,
    display_session_id: &str,
) {
    SqliteRecordStore::init_tables(conn).expect("replay schema");
    SqliteRecordStore::init_source_cache_tables(conn).expect("source cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,repo_path
             ) VALUES(?1,?2,?3,?4)",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            display_session_id,
            "/workspace/a"
        ],
    )
    .expect("cache row");
    let tx = conn.transaction().expect("primary tx");
    tx.execute(
        "INSERT INTO imported_replay_turns(
                 source,source_session_id,generation,turn_index,turn_id,
                 start_sequence,end_sequence,started_at,event_count
             ) VALUES(?1,?2,'g',0,'qoder-turn-0',0,?3,'2026-07-16T00:00:00Z',0)",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            QODER_PRIMARY_SEQUENCE_STEP - 1
        ],
    )
    .expect("turn");
    let mut stats = ReplayStats::default();
    let user = imported_history::user_message_chunk(
        display_session_id,
        "qoder",
        0,
        "2026-07-16T00:00:00Z",
        "check memory",
    );
    upsert_chunk(
        &tx,
        ImportedHistorySourceId::Qoder,
        source_session_id,
        "g",
        1,
        0,
        0,
        &user,
        &[],
        ReplaySourceSpan { start: 0, end: 1 },
        &mut stats,
    )
    .expect("user");
    let assistant = imported_history::assistant_message_chunk(
        display_session_id,
        "qoder",
        QODER_PRIMARY_SEQUENCE_STEP as usize,
        "2026-07-16T00:00:01Z",
        "done",
    );
    upsert_chunk(
        &tx,
        ImportedHistorySourceId::Qoder,
        source_session_id,
        "g",
        1,
        0,
        QODER_PRIMARY_SEQUENCE_STEP,
        &assistant,
        &[],
        ReplaySourceSpan { start: 2, end: 3 },
        &mut stats,
    )
    .expect("assistant");
    tx.commit().expect("primary commit");
}

fn probed_file(path: &Path) -> ProbedFile {
    let metadata = fs::metadata(path).expect("fixture metadata");
    let canonical = fs::canonicalize(path).expect("fixture canonical path");
    ProbedFile {
        identity: file_identity(&canonical, &metadata),
        size_bytes: metadata.len(),
        mtime_ns: metadata_mtime_ns(&metadata),
        path: canonical,
    }
}

#[test]
fn reserved_sequence_is_stable_and_inside_primary_gap() {
    let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
    conn.execute_batch(
        "CREATE TABLE imported_replay_events(
                source TEXT,source_session_id TEXT,generation TEXT,sequence INTEGER,event_id TEXT
             );",
    )
    .expect("schema");
    let tx = conn.transaction().expect("tx");
    let first = sidecar_sequence(
        &tx,
        "p/task",
        "g",
        QODER_PRIMARY_SEQUENCE_STEP,
        1_784_691_200_000,
        "qoder-log-a",
    )
    .expect("sequence");
    let second = sidecar_sequence(
        &tx,
        "p/task",
        "g",
        QODER_PRIMARY_SEQUENCE_STEP,
        1_784_691_200_001,
        "qoder-log-b",
    )
    .expect("sequence");
    assert!(first > QODER_PRIMARY_SEQUENCE_STEP);
    assert!(first < QODER_PRIMARY_SEQUENCE_STEP * 2);
    assert!(second > first);
}

#[test]
fn torn_tail_is_not_acknowledged() {
    let mut reader = BufReader::new(&b"complete\npartial"[..]);
    let (_, bytes) = read_complete_line(&mut reader)
        .expect("line")
        .expect("complete");
    assert_eq!(bytes, 9);
    assert!(read_complete_line(&mut reader).expect("tail").is_none());
}

#[test]
fn compact_sidecar_matches_legacy_attribution_and_order() {
    let path = unique_path("differential.log");
    fs::write(&path, fixture_log()).expect("fixture");
    let source_session_id = "project-a/task-aaa";
    let display_session_id = "qoderapp-project-a/task-aaa";
    let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
    prepare_replay_db(&mut conn, source_session_id, display_session_id);
    let tx = conn.transaction().expect("sidecar tx");
    ensure_raw_table(&tx).expect("raw table");
    let mut stats = ReplayStats::default();
    let file = probed_file(&path);
    let (offset, inserted) =
        ingest_file(&tx, source_session_id, "g", &file, 0, &mut stats).expect("ingest");
    assert!(inserted);
    assert_eq!(offset, file.size_bytes);
    assert!(fold_sidecar_events(
        &tx,
        display_session_id,
        source_session_id,
        "g",
        2,
        &mut stats,
    )
    .expect("fold"));
    tx.commit().expect("commit");

    let mut statement = conn
        .prepare(
            "SELECT function_name,args_preview_json,result_preview_json,sequence
                 FROM imported_replay_events
                 WHERE event_id LIKE 'qoder-log-%' ORDER BY sequence",
        )
        .expect("query");
    let indexed = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                serde_json::from_str::<Value>(&row.get::<_, String>(1)?).unwrap(),
                serde_json::from_str::<Value>(&row.get::<_, String>(2)?).unwrap(),
                row.get::<_, i64>(3)?,
            ))
        })
        .expect("rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("indexed events");
    assert_eq!(indexed.len(), 2);
    assert_eq!(indexed[0].0, "subagent");
    assert_eq!(indexed[0].1["agentType"], "GeneralPurpose");
    assert_eq!(indexed[0].2["call_id"], "call-a");
    assert_eq!(indexed[1].0, imported_history::FUNCTION_RUN_COMMAND_LINE);
    assert_eq!(indexed[1].1["cmd"], "vm_stat");
    assert!(indexed
        .iter()
        .all(|event| { event.3 > 0 && event.3 < QODER_PRIMARY_SEQUENCE_STEP }));

    let base = vec![
        imported_history::user_message_chunk(display_session_id, "qoder", 0, "", "check memory"),
        imported_history::assistant_message_chunk(display_session_id, "qoder", 1, "", "done"),
    ];
    let legacy = log_enrichment::enrich_chunks_from_log_fixture(
        display_session_id,
        "task-aaa",
        "project-a",
        Some("/workspace/a"),
        base,
        &fixture_log(),
    );
    let legacy_tools = legacy
        .iter()
        .filter(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
        .collect::<Vec<_>>();
    assert_eq!(legacy_tools.len(), indexed.len());
    for (legacy, current) in legacy_tools.iter().zip(indexed.iter()) {
        assert_eq!(legacy.function, current.0);
        assert_eq!(legacy.args, current.1);
        assert_eq!(legacy.result["call_id"], current.2["call_id"]);
        assert_eq!(legacy.result["raw_tool_name"], current.2["raw_tool_name"]);
        assert_eq!(legacy.result["recovered_from"], current.2["recovered_from"]);
    }
    drop(statement);
    let _ = fs::remove_file(path);
}

#[test]
fn append_reads_only_new_complete_bytes_and_upserts_only_new_tool() {
    let path = unique_path("append.log");
    fs::write(&path, fixture_log()).expect("fixture");
    let source_session_id = "project-a/task-aaa";
    let display_session_id = "qoderapp-project-a/task-aaa";
    let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
    prepare_replay_db(&mut conn, source_session_id, display_session_id);
    let first_offset;
    {
        let tx = conn.transaction().expect("initial tx");
        ensure_raw_table(&tx).expect("raw table");
        let mut stats = ReplayStats::default();
        let file = probed_file(&path);
        first_offset = ingest_file(&tx, source_session_id, "g", &file, 0, &mut stats)
            .expect("initial ingest")
            .0;
        fold_sidecar_events(
            &tx,
            display_session_id,
            source_session_id,
            "g",
            2,
            &mut stats,
        )
        .expect("initial fold");
        tx.commit().expect("initial commit");
    }
    let append = [
            r#"2026-07-16 19:42:13.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=tool_call, toolCallId=call-new"#,
            r#"2026-07-16 19:42:13.100 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-new, read_file, {"file_path":"/workspace/a/src/lib.rs"}"#,
        ]
        .join("\n")
            + "\n";
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open append")
        .write_all(append.as_bytes())
        .expect("append");
    let tx = conn.transaction().expect("append tx");
    let mut stats = ReplayStats::default();
    let file = probed_file(&path);
    let (next_offset, inserted) =
        ingest_file(&tx, source_session_id, "g", &file, first_offset, &mut stats)
            .expect("append ingest");
    assert!(inserted);
    assert_eq!(stats.parsed_bytes, append.len() as u64);
    assert_eq!(next_offset, first_offset + append.len() as u64);
    fold_sidecar_events(
        &tx,
        display_session_id,
        source_session_id,
        "g",
        3,
        &mut stats,
    )
    .expect("append fold");
    assert_eq!(stats.upserted_events, 1);
    tx.commit().expect("append commit");

    let tx = conn.transaction().expect("unchanged tx");
    let mut unchanged = ReplayStats::default();
    let file = probed_file(&path);
    let (same_offset, inserted) = ingest_file(
        &tx,
        source_session_id,
        "g",
        &file,
        next_offset,
        &mut unchanged,
    )
    .expect("unchanged ingest");
    assert_eq!(same_offset, next_offset);
    assert!(!inserted);
    assert_eq!(unchanged.parsed_bytes, 0);
    assert_eq!(unchanged.parsed_rows, 0);
    tx.rollback().expect("rollback unchanged");
    let _ = fs::remove_file(path);
}

#[test]
fn rotation_or_truncation_breaks_lineage_but_new_log_does_not() {
    let original_path = unique_path("lineage-original.log");
    fs::write(&original_path, fixture_log()).expect("original");
    let original = probed_file(&original_path);
    let cursor = QoderSidecarCursor {
        version: SIDECAR_CURSOR_VERSION,
        signature: "old".to_string(),
        edit_signature: String::new(),
        files: vec![SidecarFileCursor {
            path: original.path.to_string_lossy().into_owned(),
            identity: original.identity.clone(),
            byte_offset: original.size_bytes,
            boundary_fingerprint: boundary_fingerprint(&original.path, original.size_bytes)
                .expect("boundary"),
        }],
    };
    let cursor_json = json!({ "qoder_sidecar": cursor }).to_string();
    let new_path = unique_path("lineage-new.log");
    fs::write(&new_path, "new launch\n").expect("new log");
    let with_new = SidecarProbe {
        files: vec![original.clone(), probed_file(&new_path)],
        signature: "new".to_string(),
        edit_signature: String::new(),
    };
    assert!(cursor_lineage_matches(&cursor_json, &with_new));

    fs::write(&original_path, "short\n").expect("truncate");
    let truncated = SidecarProbe {
        files: vec![probed_file(&original_path), probed_file(&new_path)],
        signature: "truncated".to_string(),
        edit_signature: String::new(),
    };
    assert!(!cursor_lineage_matches(&cursor_json, &truncated));

    let missing = SidecarProbe {
        files: vec![probed_file(&new_path)],
        signature: "missing".to_string(),
        edit_signature: String::new(),
    };
    assert!(!cursor_lineage_matches(&cursor_json, &missing));
    let _ = fs::remove_file(original_path);
    let _ = fs::remove_file(new_path);
}

#[test]
fn backend_watch_paths_include_transcript_and_project_spill_root_without_duplicates() {
    let root = unique_path("watch-root");
    let transcript = root
        .join("project-a")
        .join("conversation-history")
        .join("task-aaa")
        .join("task-aaa.jsonl");
    let spill_root = root.join("project-a").join("agent-tools");
    fs::create_dir_all(transcript.parent().expect("transcript parent")).expect("history dirs");
    fs::create_dir_all(&spill_root).expect("spill root");
    fs::write(&transcript, "{}\n").expect("transcript");
    let conn = rusqlite::Connection::open_in_memory().expect("DB");
    SqliteRecordStore::init_tables(&conn).expect("schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path
             ) VALUES(?1,?2,?3,?4)",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            "project-a/task-aaa",
            "qoderapp-project-a/task-aaa",
            transcript.to_string_lossy()
        ],
    )
    .expect("cache row");
    let paths = crate::sources::imported_history::replay::watch_paths(
        &conn,
        ImportedHistorySourceId::Qoder,
        "qoderapp-project-a/task-aaa",
    )
    .expect("watch paths");
    assert!(paths.contains(&fs::canonicalize(&transcript).expect("canonical transcript")));
    assert!(paths.contains(&fs::canonicalize(&spill_root).expect("canonical spill")));
    let mut unique = paths.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(paths.len(), unique.len());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn unchanged_transcript_sidecar_append_is_delta_and_rotation_is_reset() {
    let transcript_path = unique_path("e2e.jsonl");
    let log_path = unique_path("e2e.log");
    fs::write(
            &transcript_path,
            concat!(
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<user_query>check memory</user_query>\"}]}}\n",
                "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n"
            ),
        )
        .expect("transcript");
    fs::write(&log_path, fixture_log()).expect("log");
    let source_session_id = "project-a/task-aaa";
    let display_session_id = "qoderapp-project-a/task-aaa";
    let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
    SqliteRecordStore::init_tables(&conn).expect("schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path,repo_path
             ) VALUES(?1,?2,?3,?4,?5)",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            display_session_id,
            transcript_path.to_string_lossy(),
            "/workspace/a"
        ],
    )
    .expect("cache row");
    log_enrichment::with_qoder_log_paths_for_test(vec![log_path.clone()], || {
        let opened = crate::sources::imported_history::replay::open_window(
            &mut conn,
            ImportedHistorySourceId::Qoder,
            display_session_id,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("initial open");
        let functions = opened
            .chunks
            .iter()
            .map(|chunk| chunk.chunk.function.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            functions,
            vec![
                imported_history::FUNCTION_USER_MESSAGE,
                "subagent",
                imported_history::FUNCTION_RUN_COMMAND_LINE,
                imported_history::FUNCTION_ASSISTANT,
            ]
        );

        let append = [
                r#"2026-07-16 19:42:13.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=tool_call, toolCallId=call-new"#,
                r#"2026-07-16 19:42:13.100 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-new, read_file, {"file_path":"/workspace/a/src/lib.rs"}"#,
            ]
            .join("\n")
                + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .expect("open append")
            .write_all(append.as_bytes())
            .expect("append");
        let delta = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            ImportedHistorySourceId::Qoder,
            display_session_id,
            &opened.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("append delta");
        assert!(!delta.reset_required);
        assert_eq!(delta.stats.parsed_bytes, append.len() as u64);
        assert_eq!(delta.stats.upserted_events, 1);
        assert_eq!(delta.chunks.len(), 1);
        assert_eq!(
            delta.chunks[0].chunk.function,
            imported_history::FUNCTION_READ_FILE
        );

        let unchanged = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            ImportedHistorySourceId::Qoder,
            display_session_id,
            &delta.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("unchanged poll");
        assert!(!unchanged.reset_required);
        assert!(unchanged.chunks.is_empty());
        assert_eq!(unchanged.stats.parsed_bytes, 0);
        assert_eq!(unchanged.stats.parsed_rows, 0);
        assert_eq!(unchanged.stats.normalized_events, 0);
        assert_eq!(unchanged.stats.upserted_events, 0);

        let ambiguous =
                "2026-07-16 19:42:14.000 [info] [ChatSessionService] ACP progress: task-aaa222.session.execution, rid=u, type=current_model_update\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .expect("open ambiguous append")
            .write_all(ambiguous.as_bytes())
            .expect("append ambiguous task");
        let conservative = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            ImportedHistorySourceId::Qoder,
            display_session_id,
            &unchanged.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("ambiguous task delta");
        assert!(!conservative.reset_required);
        assert!(conservative.chunks.is_empty());
        assert_eq!(conservative.stats.removed_events, 3);
        assert_eq!(conservative.removed_event_ids.len(), 3);

        fs::write(
                &log_path,
                concat!(
                    "2026-07-16 20:00:00.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=current_model_update\n",
                    "2026-07-16 20:00:00.100 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-r, read_file, {\"file_path\":\"/workspace/a/rotated.rs\"}\n"
                ),
            )
            .expect("rotate");
        let reset = crate::sources::imported_history::replay::poll_delta(
            &mut conn,
            ImportedHistorySourceId::Qoder,
            display_session_id,
            &conservative.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("rotation reset");
        assert!(reset.reset_required);
        assert_ne!(reset.cursor.generation, conservative.cursor.generation);
    });
    let _ = fs::remove_file(transcript_path);
    let _ = fs::remove_file(log_path);
}

#[test]
#[ignore = "30 MiB deterministic sidecar streaming stress"]
fn large_log_streams_without_materializing_irrelevant_rows() {
    let path = unique_path("large.log");
    let mut file = fs::File::create(&path).expect("large fixture");
    let irrelevant = "2026-07-16 19:42:00.000 [info] heartbeat heartbeat heartbeat\n";
    let block = irrelevant.repeat(1024);
    let mut written = 0_usize;
    while written < 30 * 1024 * 1024 {
        file.write_all(block.as_bytes()).expect("write large log");
        written = written.saturating_add(block.len());
    }
    file.write_all(fixture_log().as_bytes())
        .expect("write events");
    drop(file);
    let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
    prepare_replay_db(
        &mut conn,
        "project-a/task-aaa",
        "qoderapp-project-a/task-aaa",
    );
    let tx = conn.transaction().expect("tx");
    ensure_raw_table(&tx).expect("table");
    let mut stats = ReplayStats::default();
    let probed = probed_file(&path);
    ingest_file(&tx, "project-a/task-aaa", "g", &probed, 0, &mut stats).expect("stream large");
    let rows: i64 = tx
        .query_row(&format!("SELECT COUNT(*) FROM {RAW_TABLE}"), [], |row| {
            row.get(0)
        })
        .expect("raw count");
    assert_eq!(stats.parsed_bytes, probed.size_bytes);
    assert_eq!(rows, 8);
    tx.rollback().expect("rollback");
    let _ = fs::remove_file(path);
}
