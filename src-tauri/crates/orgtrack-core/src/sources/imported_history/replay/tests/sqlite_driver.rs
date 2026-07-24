use super::*;
use crate::projectors::turn_metadata::TurnMetadataAccumulator;
use crate::sources::imported_history::replay::{
    materialize_payload_artifact, open_window, poll_delta, prepare_pinned_scan, read_payload_range,
    scan_window_after, scan_window_after_generation, ReplayLimits,
};
use crate::store::sqlite::SqliteRecordStore;

fn hash_text(text: &str) -> u64 {
    text.as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn read_full_payload(
    cache: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
) -> String {
    let mut restored = String::new();
    let mut offset = 0_u64;
    loop {
        let range = read_payload_range(
            cache,
            source,
            session_id,
            generation,
            event_id,
            field_path,
            offset,
            Some(256 * 1024),
        )
        .expect("SQLite replay payload range");
        assert_eq!(range.offset, offset);
        assert!(range.next_offset > offset || range.eof);
        restored.push_str(&range.text);
        offset = range.next_offset;
        if range.eof {
            assert_eq!(offset, range.total_bytes);
            break;
        }
    }
    restored
}

fn temp_db(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "orgii-replay-{label}-{}-{}.sqlite",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

fn cache_conn(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    path: &Path,
) -> (Connection, String) {
    let conn = Connection::open_in_memory().expect("cache DB");
    SqliteRecordStore::init_tables(&conn).expect("replay tables");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache");
    let session_id = format!(
        "{}{}",
        source.descriptor().session_prefix,
        source_session_id
    );
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path
             ) VALUES(?1,?2,?3,?4)",
        params![
            source.as_str(),
            source_session_id,
            session_id,
            path.to_string_lossy()
        ],
    )
    .expect("cache source path");
    (conn, session_id)
}

fn create_part_db(path: &Path, session_id: &str) -> Connection {
    let conn = Connection::open(path).expect("source DB");
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
             CREATE TABLE session(
               id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER
             );
             CREATE TABLE message(
               id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT
             );
             CREATE TABLE part(
               id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,
               time_created INTEGER,data TEXT
             );",
    )
    .expect("part schema");
    conn.execute("INSERT INTO session VALUES(?1,1,1)", [session_id])
        .expect("session row");
    conn
}

fn insert_part(conn: &Connection, session_id: &str, ordinal: usize, role: &str, part: Value) {
    let message_id = format!("message-{ordinal:06}");
    let part_id = format!("part-{ordinal:06}");
    let timestamp = ordinal as i64 + 1;
    conn.execute(
        "INSERT INTO message(id,session_id,time_created,data) VALUES(?1,?2,?3,?4)",
        params![
            message_id,
            session_id,
            timestamp,
            serde_json::json!({"role":role}).to_string()
        ],
    )
    .expect("message row");
    conn.execute(
        "INSERT INTO part(id,message_id,session_id,time_created,data)
             VALUES(?1,?2,?3,?4,?5)",
        params![part_id, message_id, session_id, timestamp, part.to_string()],
    )
    .expect("part row");
}

fn create_kv_db(path: &Path, composer_id: &str) -> Connection {
    let conn = Connection::open(path).expect("KV source DB");
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
             CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
    )
    .expect("KV schema");
    write_kv_transcript(&conn, composer_id, &[1, 2]);
    conn
}

fn write_kv_transcript(conn: &Connection, composer_id: &str, bubble_types: &[i64]) {
    let headers = bubble_types
            .iter()
            .enumerate()
            .map(|(index, bubble_type)| {
                serde_json::json!({"bubbleId":format!("b{index}"),"type":bubble_type})
            })
            .collect::<Vec<_>>();
    let composer = serde_json::json!({
        "composerId":composer_id,
        "createdAt":1,
        "lastUpdatedAt":bubble_types.len() as i64,
        "fullConversationHeadersOnly":headers,
    });
    conn.execute(
        "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![format!("composerData:{composer_id}"), composer.to_string()],
    )
    .expect("composer row");
    for (index, bubble_type) in bubble_types.iter().copied().enumerate() {
        let bubble = serde_json::json!({
            "bubbleId":format!("b{index}"),
            "type":bubble_type,
            "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
            "text":if bubble_type == 1 { format!("user {index}") } else { format!("assistant {index}") },
        });
        conn.execute(
            "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![
                format!("bubbleId:{composer_id}:b{index}"),
                bubble.to_string()
            ],
        )
        .expect("bubble row");
    }
}

#[test]
fn preview_is_utf8_safe_and_bounded() {
    let preview = head_preview(&"你".repeat(10_000), NORMAL_PAYLOAD_PREVIEW_BYTES);
    assert!(preview.is_char_boundary(preview.len()));
    assert!(preview.len() < NORMAL_PAYLOAD_PREVIEW_BYTES + 64);
}

#[test]
fn compact_sqlite_rows_keep_line_stats_and_full_output_git_summary() {
    let mut edit = ActivityChunk::new("opencodeapp-s1", "tool_call", "edit_file");
    edit.args = serde_json::json!({
        "file_path":"src/large.rs",
        "content":"line\n".repeat(4_000)
    });
    edit.result = serde_json::json!({
        "linesAdded":7,
        "linesRemoved":3,
        "output":"x".repeat(16 * 1024)
    });
    compact_chunk(&mut edit, "part-edit");
    let mut edit_metadata = TurnMetadataAccumulator::new();
    edit_metadata.add_event_values_at(
        Some(&edit.function),
        &edit.args,
        &edit.result,
        "2026-07-22T00:00:00Z",
    );
    assert_eq!(edit_metadata.modified_files()[0].path, "src/large.rs");
    assert_eq!(edit_metadata.modified_files()[0].additions, 7);
    assert_eq!(edit_metadata.modified_files()[0].deletions, 3);

    let mut shell = ActivityChunk::new(
        "opencodeapp-s1",
        "tool_call",
        imported_history::FUNCTION_RUN_COMMAND_LINE,
    );
    shell.args = serde_json::json!({"command":"git commit -m metadata"});
    shell.result = serde_json::json!({
        "output":format!(
            "[feature abc1234] metadata\n{}\nhttps://github.com/acme/repo/pull/42",
            "middle".repeat(10 * 1024)
        )
    });
    compact_chunk(&mut shell, "part-shell");
    let mut shell_metadata = TurnMetadataAccumulator::new();
    shell_metadata.add_event_values_at(
        Some(&shell.function),
        &shell.args,
        &shell.result,
        "2026-07-22T00:00:01Z",
    );
    assert!(shell_metadata
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
    assert!(shell_metadata
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.pr_number == Some(42)));
}

#[test]
fn stable_id_ignores_rowid_and_uses_provider_key() {
    let first = stable_event_id(ImportedHistorySourceId::OpenCode, "part-1");
    let second = stable_event_id(ImportedHistorySourceId::OpenCode, "part-1");
    assert_eq!(first, second);
}

#[test]
fn all_five_sqlite_sources_open_bounded_and_poll_unchanged_without_parsing() {
    for source in [
        ImportedHistorySourceId::OpenCode,
        ImportedHistorySourceId::MimoCode,
        ImportedHistorySourceId::ZCode,
    ] {
        let path = temp_db(source.as_str());
        let writer = create_part_db(&path, "s1");
        insert_part(
            &writer,
            "s1",
            0,
            "user",
            serde_json::json!({"type":"text","text":"hello"}),
        );
        insert_part(
            &writer,
            "s1",
            1,
            "assistant",
            serde_json::json!({"type":"text","text":"world"}),
        );
        let (mut cache, session_id) = cache_conn(source, "s1", &path);
        let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
            .expect("open part replay");
        assert_eq!(opened.chunks.len(), 2, "{}", source.as_str());
        let unchanged = poll_delta(
            &mut cache,
            source,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("unchanged part poll");
        assert_eq!(unchanged.stats, ReplayStats::default());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }

    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let path = temp_db(source.as_str());
        let writer = create_kv_db(&path, "c1");
        let (mut cache, session_id) = cache_conn(source, "c1", &path);
        let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
            .expect("open KV replay");
        assert_eq!(opened.chunks.len(), 2, "{}", source.as_str());
        let unchanged = poll_delta(
            &mut cache,
            source,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("unchanged KV poll");
        assert_eq!(unchanged.stats, ReplayStats::default());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn opencode_append_update_delete_and_checkpoint_are_incremental() {
    let path = temp_db("opencode-delta");
    let writer = create_part_db(&path, "s1");
    insert_part(
        &writer,
        "s1",
        0,
        "user",
        serde_json::json!({"type":"text","text":"hello"}),
    );
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
    let opened = open_window(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open replay");

    let tx = writer.unchecked_transaction().expect("append transaction");
    for ordinal in 1..=1_000 {
        insert_part(
            &tx,
            "s1",
            ordinal,
            "assistant",
            serde_json::json!({"type":"text","text":format!("answer {ordinal}")}),
        );
    }
    tx.execute("UPDATE session SET time_updated=2 WHERE id='s1'", [])
        .unwrap();
    tx.commit().unwrap();
    let mut appended = poll_delta(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .expect("append delta");
    assert!(appended.stats.parsed_rows <= 1_010);
    assert_eq!(appended.stats.parsed_rows, 1_000);
    assert_eq!(appended.stats.upserted_events, 1_000);
    let mut append_ids = std::collections::HashSet::new();
    loop {
        for chunk in &appended.chunks {
            assert!(
                append_ids.insert(chunk.chunk.chunk_id.clone()),
                "append delta repeated an event"
            );
        }
        if append_ids.len() == 1_000 {
            break;
        }
        assert!(!appended.chunks.is_empty(), "append continuation stalled");
        appended = poll_delta(
            &mut cache,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &appended.cursor,
            ReplayLimits::default(),
        )
        .expect("continued append delta");
        assert_eq!(appended.stats.parsed_rows, 0);
        assert_eq!(appended.stats.upserted_events, 0);
    }
    assert_eq!(append_ids.len(), 1_000);

    writer
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
        .unwrap();
    let checkpoint = poll_delta(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &appended.cursor,
        ReplayLimits::default(),
    )
    .expect("checkpoint poll");
    assert_eq!(checkpoint.stats, ReplayStats::default());

    writer
        .execute(
            "UPDATE part SET data=?1 WHERE id='part-000000'",
            [serde_json::json!({"type":"text","text":"edited"}).to_string()],
        )
        .unwrap();
    writer
        .execute("UPDATE session SET time_updated=3 WHERE id='s1'", [])
        .unwrap();
    let updated = poll_delta(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &checkpoint.cursor,
        ReplayLimits::default(),
    )
    .expect("update delta");
    assert_eq!(updated.stats.parsed_rows, 1);
    assert_eq!(updated.chunks.len(), 1);

    writer
        .execute("DELETE FROM part WHERE id='part-000000'", [])
        .unwrap();
    writer
        .execute("UPDATE session SET time_updated=4 WHERE id='s1'", [])
        .unwrap();
    let deleted = poll_delta(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &updated.cursor,
        ReplayLimits::default(),
    )
    .expect("delete delta");
    assert_eq!(deleted.removed_event_ids.len(), 1);
    assert_eq!(deleted.stats.removed_events, 1);

    writer
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
        .unwrap();
    let vacuumed = poll_delta(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &deleted.cursor,
        ReplayLimits::default(),
    )
    .expect("VACUUM reset");
    assert!(vacuumed.reset_required);
    assert_ne!(vacuumed.cursor.generation, deleted.cursor.generation);
    drop(writer);
    let _ = std::fs::remove_file(path);
}

#[test]
fn cursor_and_windsurf_kv_updates_and_deletes_are_deltas() {
    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let path = temp_db(&format!("{}-delta", source.as_str()));
        let writer = create_kv_db(&path, "c1");
        let (mut cache, session_id) = cache_conn(source, "c1", &path);
        let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
            .expect("open KV delta fixture");

        let updated_bubble = serde_json::json!({
            "bubbleId":"b1","type":2,"createdAt":"2026-07-22T00:00:01Z",
            "text":"assistant edited"
        });
        writer
            .execute(
                "UPDATE cursorDiskKV SET value=?1 WHERE key='bubbleId:c1:b1'",
                [updated_bubble.to_string()],
            )
            .unwrap();
        let composer = serde_json::json!({
            "composerId":"c1","createdAt":1,"lastUpdatedAt":99,
            "fullConversationHeadersOnly":[
                {"bubbleId":"b0","type":1},{"bubbleId":"b1","type":2}
            ]
        });
        writer
            .execute(
                "UPDATE cursorDiskKV SET value=?1 WHERE key='composerData:c1'",
                [composer.to_string()],
            )
            .unwrap();
        let updated = poll_delta(
            &mut cache,
            source,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("KV update delta");
        assert_eq!(updated.stats.parsed_rows, 1, "{}", source.as_str());
        assert_eq!(updated.chunks.len(), 1, "{}", source.as_str());

        writer
            .execute("DELETE FROM cursorDiskKV WHERE key='bubbleId:c1:b0'", [])
            .unwrap();
        let composer = serde_json::json!({
            "composerId":"c1","createdAt":1,"lastUpdatedAt":100,
            "fullConversationHeadersOnly":[{"bubbleId":"b1","type":2}]
        });
        writer
            .execute(
                "UPDATE cursorDiskKV SET value=?1 WHERE key='composerData:c1'",
                [composer.to_string()],
            )
            .unwrap();
        let deleted = poll_delta(
            &mut cache,
            source,
            &session_id,
            &updated.cursor,
            ReplayLimits::default(),
        )
        .expect("KV delete delta");
        assert_eq!(deleted.removed_event_ids.len(), 1, "{}", source.as_str());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn kv_cold_open_reads_only_latest_turn_and_older_turn_hydrates_by_index() {
    let path = temp_db("cursor-lazy-turn");
    let writer = create_kv_db(&path, "c1");
    write_kv_transcript(&writer, "c1", &[1, 2, 1, 2]);
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::CursorIde, "c1", &path);
    let opened = open_window(
        &mut cache,
        ImportedHistorySourceId::CursorIde,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("cold bounded KV replay");
    assert_eq!(opened.stats.parsed_rows, 2);
    assert_eq!(opened.chunks.len(), 2);
    assert_eq!(opened.total_turn_count, 2);
    assert_eq!(opened.total_event_count, 4);

    let older = crate::sources::imported_history::replay::read_turn_window_at_index(
        &mut cache,
        ImportedHistorySourceId::CursorIde,
        &session_id,
        0,
        ReplayLimits::default(),
    )
    .expect("hydrate older KV turn");
    assert_eq!(older.chunks.len(), 2);
    assert_eq!(older.turn_headers[0].turn_index, 0);
    drop(writer);
    let _ = std::fs::remove_file(path);
}

#[test]
fn kv_cold_forward_scan_hydrates_turns_in_order_without_gaps() {
    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let path = temp_db(&format!("{}-forward-scan", source.as_str()));
        let writer = create_kv_db(&path, "c1");
        write_kv_transcript(&writer, "c1", &[1, 2, 1, 2, 1, 2]);
        let (mut cache, session_id) = cache_conn(source, "c1", &path);
        let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
            .expect("cold bounded KV replay");
        assert_eq!(opened.stats.parsed_rows, 2, "{}", source.as_str());

        let limits = ReplayLimits {
            max_turns: 1,
            max_events: 1,
            max_ipc_bytes: 4 * 1024 * 1024,
        };
        let mut after_sequence = -1;
        let mut sequences = Vec::new();
        for _ in 0..10 {
            let scan = scan_window_after(&mut cache, source, &session_id, after_sequence, limits)
                .expect("bounded forward KV scan");
            sequences.extend(scan.chunks.iter().map(|chunk| chunk.sequence));
            assert!(scan.cursor.through_sequence > after_sequence || !scan.has_more);
            after_sequence = scan.cursor.through_sequence;
            if !scan.has_more {
                break;
            }
        }
        assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn kv_prepare_then_strict_scan_crosses_three_lazy_turns() {
    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let path = temp_db(&format!("{}-cursor-continuation", source.as_str()));
        let writer = create_kv_db(&path, "c1");
        write_kv_transcript(&writer, "c1", &[1, 2, 1, 2, 1, 2]);
        let (mut cache, session_id) = cache_conn(source, "c1", &path);
        open_window(&mut cache, source, &session_id, ReplayLimits::default())
            .expect("cold bounded KV replay");

        let limits = ReplayLimits {
            max_turns: 1,
            max_events: 1,
            max_ipc_bytes: 4 * 1024 * 1024,
        };
        let prepared = prepare_pinned_scan(&mut cache, source, &session_id, limits)
            .expect("prepare stable lazy KV scan");
        let pinned_generation = prepared.generation.clone();
        let pinned_revision = prepared.revision;
        let mut after_sequence = -1;
        let mut sequences = Vec::new();
        for _ in 0..10 {
            let scan = scan_window_after_generation(
                &mut cache,
                source,
                &session_id,
                &pinned_generation,
                pinned_revision,
                after_sequence,
                limits,
            )
            .expect("strict scan across prepared KV turns");
            sequences.extend(scan.chunks.iter().map(|chunk| chunk.sequence));
            assert_eq!(scan.cursor.generation, pinned_generation);
            assert_eq!(scan.cursor.revision, pinned_revision);
            assert!(scan.cursor.through_sequence > after_sequence || !scan.has_more);
            after_sequence = scan.cursor.through_sequence;
            if !scan.has_more {
                break;
            }
        }
        assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn kv_reorder_rebuilds_stable_events_without_sequence_collisions() {
    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let path = temp_db(&format!("{}-reorder", source.as_str()));
        let writer = create_kv_db(&path, "c1");
        write_kv_transcript(&writer, "c1", &[1, 2, 2]);
        let (mut cache, session_id) = cache_conn(source, "c1", &path);
        let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
            .expect("open KV reorder fixture");

        let reordered = serde_json::json!({
            "composerId":"c1","createdAt":1,"lastUpdatedAt":99,
            "fullConversationHeadersOnly":[
                {"bubbleId":"b0","type":1},
                {"bubbleId":"b2","type":2},
                {"bubbleId":"b1","type":2}
            ]
        });
        writer
            .execute(
                "UPDATE cursorDiskKV SET value=?1 WHERE key='composerData:c1'",
                [reordered.to_string()],
            )
            .unwrap();
        let delta = poll_delta(
            &mut cache,
            source,
            &session_id,
            &opened.cursor,
            ReplayLimits::default(),
        )
        .expect("reordered KV delta");
        assert!(!delta.reset_required, "{}", source.as_str());
        assert_eq!(delta.removed_event_ids.len(), 0, "{}", source.as_str());

        let reordered_window = crate::sources::imported_history::replay::read_turn_window_at_index(
            &mut cache,
            source,
            &session_id,
            0,
            ReplayLimits::default(),
        )
        .expect("read reordered KV turn");
        let actual = reordered_window
            .chunks
            .iter()
            .map(|chunk| (chunk.sequence, chunk.chunk.chunk_id.clone()))
            .collect::<Vec<_>>();
        let expected = vec![
            (0, stable_event_id(source, "bubbleId:c1:b0")),
            (1, stable_event_id(source, "bubbleId:c1:b2")),
            (2, stable_event_id(source, "bubbleId:c1:b1")),
        ];
        assert_eq!(actual, expected, "{}", source.as_str());
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn unknown_sqlite_schema_is_explicit_and_never_falls_back() {
    let path = temp_db("unknown-schema");
    let source_conn = Connection::open(&path).unwrap();
    source_conn
        .execute_batch("CREATE TABLE unrelated(id INTEGER PRIMARY KEY,value TEXT);")
        .unwrap();
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
    let error = open_window(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        ReplayLimits::default(),
    )
    .unwrap_err();
    assert!(error.contains("Unsupported opencode replay schema"));
    assert!(error.contains("will not fall back"));
    drop(source_conn);
    let _ = std::fs::remove_file(path);
}

#[test]
fn sqlite_wal_path_plus_ten_mib_content_uses_exact_root_args_artifact() {
    let path = temp_db("opencode-root-args");
    let writer = create_part_db(&path, "s1");
    let original_args = serde_json::json!({
        "path":"src/huge.txt",
        "content":format!("BEGIN{}END", "你".repeat((10 * 1024 * 1024) / 3)),
    });
    let expected_json = serde_json::to_string(&original_args).expect("expected args JSON");
    let source_part = serde_json::json!({
        "type":"tool",
        "tool":"custom_tool",
        "callID":"call-root-args",
        "state":{
            "status":"completed",
            "input":original_args,
            "output":"ok"
        }
    });
    insert_part(&writer, "s1", 0, "assistant", source_part);
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
    let opened = open_window(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open SQLite root args fixture");
    let indexed = opened.chunks.first().expect("custom tool event");
    assert_eq!(indexed.chunk.args["path"], "src/huge.txt");
    assert_eq!(indexed.chunk.args["_replayTruncated"], true);
    assert!(indexed.chunk.args.get("content").is_none());
    assert_eq!(indexed.payloads.len(), 1);
    assert_eq!(indexed.payloads[0].field_path, "args");
    assert!(indexed.payloads[0].source_key.is_none());

    let generation = opened.cursor.generation.clone();
    let event_id = indexed.chunk.chunk_id.clone();
    let restored = read_full_payload(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &generation,
        &event_id,
        "args",
    );
    assert_eq!(restored.len(), expected_json.len());
    assert_eq!(hash_text(&restored), hash_text(&expected_json));
    assert_eq!(
        serde_json::from_str::<Value>(&restored).expect("restored args JSON"),
        serde_json::from_str::<Value>(&expected_json).expect("baseline args JSON")
    );
    assert!(!restored.contains("_replayTruncated"));
    assert!(!restored.contains("[payload truncated]"));
    let artifact_count = cache
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs
                 WHERE source='opencode' AND generation=?1 AND event_id=?2 AND field_path='args'",
            params![generation, event_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("root args artifact ref");
    assert_eq!(artifact_count, 1);
    drop(writer);
    let _ = std::fs::remove_file(path);
}

#[test]
fn same_length_sqlite_row_update_replaces_materialized_payload_hash() {
    let path = temp_db("opencode-same-length-shell-update");
    let writer = create_part_db(&path, "s1");
    let first_output = format!("BEGIN{}END", "A".repeat(96 * 1024));
    let second_output = format!("BEGIN{}END", "B".repeat(96 * 1024));
    assert_eq!(first_output.len(), second_output.len());
    let part = |output: &str| {
        serde_json::json!({
            "type":"tool",
            "tool":"bash",
            "callID":"call-same-length",
            "state":{
                "status":"completed",
                "input":{"command":"emit same length"},
                "output":output
            }
        })
    };
    insert_part(&writer, "s1", 0, "assistant", part(&first_output));
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
    let opened = open_window(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open same-length SQLite Shell fixture");
    let indexed = opened.chunks.first().expect("SQLite Shell event");
    let event_id = indexed.chunk.chunk_id.clone();
    assert!(indexed
        .payloads
        .iter()
        .any(|payload| payload.field_path == "result.output"));
    let first_hash = {
        let tx = cache.transaction().expect("first payload artifact");
        let locator = materialize_payload_artifact(
            &tx,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &opened.cursor.generation,
            &event_id,
            "result.output",
        )
        .expect("materialize first SQLite Shell payload");
        tx.commit().expect("commit first payload artifact");
        locator.content_hash
    };

    writer
        .execute(
            "UPDATE part SET data=?1 WHERE id='part-000000'",
            [part(&second_output).to_string()],
        )
        .expect("same-length SQLite row update");
    writer
        .execute("UPDATE session SET time_updated=2 WHERE id='s1'", [])
        .expect("advance SQLite session clock");
    let updated = poll_delta(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .expect("poll same-length SQLite update");
    assert!(!updated.reset_required);
    assert_eq!(updated.cursor.generation, opened.cursor.generation);
    assert_eq!(updated.stats.parsed_rows, 1);

    let second_hash = {
        let tx = cache.transaction().expect("updated payload artifact");
        let locator = materialize_payload_artifact(
            &tx,
            ImportedHistorySourceId::OpenCode,
            &session_id,
            &updated.cursor.generation,
            &event_id,
            "result.output",
        )
        .expect("materialize changed SQLite Shell payload");
        tx.commit().expect("commit changed payload artifact");
        locator.content_hash
    };
    assert_ne!(first_hash, second_hash, "content, not length, is identity");
    let restored = read_full_payload(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &updated.cursor.generation,
        &event_id,
        "result.output",
    );
    assert_eq!(restored, second_output);
    assert_eq!(
        cache
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                     WHERE source='opencode' AND generation=?1",
                [&updated.cursor.generation],
                |row| row.get::<_, i64>(0),
            )
            .expect("live same-length artifact count"),
        1
    );
    drop(writer);
    let _ = std::fs::remove_file(path);
}

#[test]
fn sqlite_git_projection_metadata_does_not_leak_from_exact_result() {
    let path = temp_db("opencode-git-root-result");
    let writer = create_part_db(&path, "s1");
    let output = format!(
        "[feature abc1234] exact\n{}\nhttps://github.com/acme/repo/pull/42",
        "middle".repeat(8 * 1024)
    );
    let source_part = serde_json::json!({
        "type":"tool",
        "tool":"bash",
        "callID":"call-git",
        "state":{
            "status":"completed",
            "input":{"command":"git commit -m exact"},
            "output":output
        }
    });
    let expected = crate::sources::opencode::history::replay_chunk_from_part_json(
        "opencodeapp-s1",
        "opencode",
        0,
        "part-000000".to_string(),
        "message-000000".to_string(),
        "assistant".to_string(),
        &source_part.to_string(),
        1,
    )
    .expect("normalize old full result")
    .expect("old full tool event");
    insert_part(&writer, "s1", 0, "assistant", source_part);
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
    let opened = open_window(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open SQLite Git fixture");
    let indexed = opened.chunks.first().expect("Git shell event");
    assert!(indexed.chunk.result.get("_replayGitArtifacts").is_some());
    assert_eq!(
        indexed
            .payloads
            .iter()
            .map(|payload| payload.field_path.as_str())
            .collect::<Vec<_>>(),
        vec!["result"]
    );
    let restored = read_full_payload(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &opened.cursor.generation,
        &indexed.chunk.chunk_id,
        "result",
    );
    let restored: Value = serde_json::from_str(&restored).expect("restored exact result");
    assert_eq!(restored, expected.result);
    assert!(restored.get("_replayGitArtifacts").is_none());
    drop(writer);
    let _ = std::fs::remove_file(path);
}

#[test]
fn ten_megabyte_command_keeps_semantic_preview_and_round_trips_by_range() {
    let path = temp_db("opencode-large-args");
    let writer = create_part_db(&path, "s1");
    let command = format!("BEGIN{}END", "你".repeat((10 * 1024 * 1024) / 3));
    insert_part(
        &writer,
        "s1",
        0,
        "assistant",
        serde_json::json!({
            "type":"tool",
            "tool":"bash",
            "callID":"call-1",
            "state":{"status":"completed","input":{"command":command},"output":"ok"}
        }),
    );
    let (mut cache, session_id) = cache_conn(ImportedHistorySourceId::OpenCode, "s1", &path);
    let opened = open_window(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        ReplayLimits::default(),
    )
    .expect("open large args");
    let event = opened.chunks.first().expect("tool event");
    let preview = event
        .chunk
        .args
        .get("command")
        .and_then(Value::as_str)
        .expect("semantic command preview");
    assert!(preview.len() < SHELL_PAYLOAD_PREVIEW_BYTES + 64);
    let payload = event
        .payloads
        .iter()
        .find(|payload| payload.field_path == "args")
        .expect("root args payload");
    assert_eq!(payload.encoding, ReplayPayloadEncoding::JsonValue);
    let projection = payload
        .body_projection
        .as_ref()
        .expect("bounded root body projection");
    assert_eq!(projection.field_path, "args.cmd");
    assert!(projection.truncated);
    assert!(projection.text.len() <= SHELL_PAYLOAD_PREVIEW_BYTES);

    let reconstructed = read_full_payload(
        &mut cache,
        ImportedHistorySourceId::OpenCode,
        &session_id,
        &opened.cursor.generation,
        &event.chunk.chunk_id,
        "args",
    );
    let reconstructed: Value =
        serde_json::from_str(&reconstructed).expect("complete normalized args JSON");
    assert_eq!(reconstructed["command"], command);
    assert_eq!(reconstructed["cmd"], command);
    assert_eq!(reconstructed["payload"]["command"], command);
    assert!(reconstructed.get("_replayTruncated").is_none());
    drop(writer);
    let _ = std::fs::remove_file(path);
}
