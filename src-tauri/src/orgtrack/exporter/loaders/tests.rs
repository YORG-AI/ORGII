use sha2::{Digest, Sha256};

use super::*;
use crate::orgtrack::types::{OrgtrackRawEvent, OrgtrackRawEventSource, OrgtrackSessionTrajectory};

fn create_native_trajectory_tables(conn: &rusqlite::Connection) {
    conn.execute_batch(
        "CREATE TABLE events (
             id TEXT PRIMARY KEY,
             session_id TEXT NOT NULL,
             function_name TEXT,
             args_json TEXT,
             result_json TEXT,
             history_sequence INTEGER,
             created_at TEXT
         );
         CREATE TABLE code_session_chunks (
             chunk_id TEXT PRIMARY KEY,
             session_id TEXT NOT NULL,
             function TEXT,
             args_json TEXT,
             result_json TEXT,
             sequence INTEGER,
             created_at TEXT
         );",
    )
    .expect("native trajectory tables");
}

#[test]
fn streaming_trajectory_matches_legacy_pretty_json_golden() {
    let mut conn = rusqlite::Connection::open_in_memory().expect("trajectory DB");
    create_native_trajectory_tables(&conn);
    let args = "{\"command\":\"printf \\\"你🙂\\n\\u0000\"\"}";
    conn.execute(
        "INSERT INTO events(
             id,session_id,function_name,args_json,result_json,history_sequence,created_at
         ) VALUES('event-1','plain-session','Shell',?1,NULL,2,'2026-07-22T01:02:03Z')",
        [args],
    )
    .expect("event fixture");
    let chunk_result = "{\"output\":\"done\\t\\\\quoted\"}";
    conn.execute(
        "INSERT INTO code_session_chunks(
             chunk_id,session_id,function,args_json,result_json,sequence,created_at
         ) VALUES('chunk-1','plain-session','Read',NULL,?1,7,NULL)",
        [chunk_result],
    )
    .expect("chunk fixture");

    let expected = OrgtrackSessionTrajectory {
        schema_version: 1,
        tier: OrgtrackTier::Trajectory,
        session_id: "plain-session".to_string(),
        raw_events: vec![
            OrgtrackRawEvent {
                source: OrgtrackRawEventSource::Event,
                name: Some("Shell".to_string()),
                args_json: Some(args.to_string()),
                result_json: None,
                sequence: Some(2),
                created_at: Some("2026-07-22T01:02:03Z".to_string()),
            },
            OrgtrackRawEvent {
                source: OrgtrackRawEventSource::CodeSessionChunk,
                name: Some("Read".to_string()),
                args_json: None,
                result_json: Some(chunk_result.to_string()),
                sequence: Some(7),
                created_at: None,
            },
        ],
    };
    let legacy = serde_json::to_string_pretty(&expected).expect("legacy trajectory JSON");
    let mut streamed = Vec::new();
    write_session_trajectory(
        &mut conn,
        &mut streamed,
        1,
        OrgtrackTier::Trajectory,
        "plain-session",
    )
    .expect("stream trajectory");

    assert_eq!(String::from_utf8(streamed).unwrap(), legacy);
}

#[test]
fn native_ten_mib_payload_stream_matches_legacy_hash_across_utf8_boundary() {
    let mut conn = rusqlite::Connection::open_in_memory().expect("trajectory DB");
    create_native_trajectory_tables(&conn);
    let mut large = "A".repeat(TRAJECTORY_PAYLOAD_RANGE_BYTES - 1);
    large.push('🙂');
    large.push_str(&"B".repeat(10 * 1024 * 1024 - large.len()));
    let result_json = format!("{{\"output\":\"{large}\"}}");
    conn.execute(
        "INSERT INTO events(
             id,session_id,function_name,args_json,result_json,history_sequence,created_at
         ) VALUES('large','plain-large','Shell','{}',?1,1,'2026-07-22T00:00:00Z')",
        [&result_json],
    )
    .expect("large event fixture");

    let expected = OrgtrackSessionTrajectory {
        schema_version: 1,
        tier: OrgtrackTier::Trajectory,
        session_id: "plain-large".to_string(),
        raw_events: vec![OrgtrackRawEvent {
            source: OrgtrackRawEventSource::Event,
            name: Some("Shell".to_string()),
            args_json: Some("{}".to_string()),
            result_json: Some(result_json),
            sequence: Some(1),
            created_at: Some("2026-07-22T00:00:00Z".to_string()),
        }],
    };
    let mut legacy_hash = Sha256::new();
    serde_json::to_writer_pretty(&mut legacy_hash, &expected).expect("legacy hash");

    let mut streamed_hash = Sha256::new();
    write_session_trajectory(
        &mut conn,
        &mut streamed_hash,
        1,
        OrgtrackTier::Trajectory,
        "plain-large",
    )
    .expect("stream large trajectory");

    assert_eq!(streamed_hash.finalize(), legacy_hash.finalize());
}

#[test]
fn imported_deferred_payload_is_exported_in_full_without_preview_marker() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
    SqliteRecordStore::init_tables(&conn).expect("replay index tables");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache tables");
    let directory = tempfile::tempdir().expect("Codex trajectory fixture");
    let transcript_path = directory.path().join("rollout.jsonl");
    let imported_id = "codexapp-trajectory-deferred";
    conn.execute(
        "INSERT INTO imported_history_session_cache(
             source,source_session_id,session_id,source_path
         ) VALUES('codex_app','trajectory-deferred',?1,?2)",
        params![imported_id, transcript_path.to_string_lossy()],
    )
    .expect("Codex cache fixture");
    let output = format!("BEGIN:{}:END", "payload🙂".repeat(1024 * 1024));
    let line = |payload: Value| {
        serde_json::json!({
            "timestamp":"2026-07-22T00:00:00Z",
            "type":"event_msg",
            "payload":payload
        })
        .to_string()
    };
    let transcript = format!(
        "{}\n{}\n{}\n",
        line(serde_json::json!({"type":"user_message","message":"run"})),
        line(serde_json::json!({
            "type":"function_call",
            "name":"shell_command",
            "arguments":"{\"command\":\"printf payload\"}",
            "call_id":"call-trajectory"
        })),
        line(serde_json::json!({
            "type":"function_call_output",
            "call_id":"call-trajectory",
            "output":output
        }))
    );
    std::fs::write(&transcript_path, transcript).expect("Codex transcript");

    let mut streamed = Vec::new();
    write_session_trajectory_with_imported_id(
        &mut conn,
        &mut streamed,
        1,
        OrgtrackTier::Trajectory,
        "managed-session",
        Some(imported_id),
    )
    .expect("stream imported trajectory");
    let trajectory: OrgtrackSessionTrajectory =
        serde_json::from_slice(&streamed).expect("valid trajectory JSON");
    let shell = trajectory
        .raw_events
        .iter()
        .find(|event| event.name.as_deref() == Some("run_command_line"))
        .expect("Shell trajectory event");
    let result: Value =
        serde_json::from_str(shell.result_json.as_deref().unwrap()).expect("Shell result JSON");
    let restored = result
        .get("output")
        .and_then(Value::as_str)
        .expect("restored Shell output");
    assert_eq!(restored.len(), output.len());
    assert_eq!(
        Sha256::digest(restored.as_bytes()),
        Sha256::digest(output.as_bytes())
    );
    assert!(!restored.contains("[payload truncated]"));
    assert_eq!(
        TRAJECTORY_PAYLOAD_RANGE_BYTES,
        replay::HARD_MAX_PAYLOAD_RANGE_BYTES
    );
}

#[test]
fn imported_nested_array_payload_uses_indexed_path_and_explicit_encoding() {
    use orgtrack_core::sources::imported_history::replay::{
        ReplayPayloadEncoding, ReplayPayloadKind,
    };
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let mut conn = rusqlite::Connection::open_in_memory().expect("array replay DB");
    SqliteRecordStore::init_tables(&conn).expect("replay index tables");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache tables");
    let source_session_id = "array-source";
    let session_id = "codexapp-array-source";
    let generation = "array-generation";
    let event_id = "array-event";
    let field_path = "result.content.0.text";
    let canonical = "FULL_ARRAY_\"quoted\"\\path\nnext";
    let descriptor = ReplayPayloadDescriptor {
        field_path: field_path.to_string(),
        kind: ReplayPayloadKind::AssistantContent,
        encoding: ReplayPayloadEncoding::Utf8Text,
        body_projection: None,
        spans: Vec::new(),
        total_bytes: canonical.len() as u64,
        source_ordinal: None,
        source_key: None,
    };
    conn.execute(
        "INSERT INTO imported_history_session_cache(
             source,source_session_id,session_id,source_path
         ) VALUES('codex_app',?1,?2,'/unused/provider.jsonl')",
        params![source_session_id, session_id],
    )
    .expect("array source binding");
    conn.execute(
        "INSERT INTO imported_replay_events(
             source,source_session_id,generation,sequence,event_id,turn_index,
             action_type,function_name,created_at,payloads_json,content_hash
         ) VALUES('codex_app',?1,?2,1,?3,0,'assistant','assistant',
                  '2026-07-23T00:00:00Z',?4,'event-hash')",
        params![
            source_session_id,
            generation,
            event_id,
            serde_json::to_string(&vec![descriptor.clone()]).expect("payload descriptor JSON")
        ],
    )
    .expect("array replay event");
    conn.execute(
        "INSERT INTO imported_replay_payload_artifacts(
             source,source_session_id,generation,content_hash,payload
         ) VALUES('codex_app',?1,?2,'payload-hash',?3)",
        params![source_session_id, generation, canonical.as_bytes()],
    )
    .expect("array payload artifact");
    conn.execute(
        "INSERT INTO imported_replay_payload_artifact_refs(
             source,source_session_id,generation,event_id,field_path,content_hash
         ) VALUES('codex_app',?1,?2,?3,?4,'payload-hash')",
        params![source_session_id, generation, event_id, field_path],
    )
    .expect("array payload ref");

    let compact = serde_json::json!({
        "content":[{"text":"ARRAY_PREVIEW","kind":"text"}]
    });
    let mut encoded = Vec::new();
    write_replay_value_json_string(
        &mut conn,
        &mut encoded,
        ImportedHistorySourceId::CodexApp,
        session_id,
        generation,
        event_id,
        "result",
        &compact,
        &[descriptor],
    )
    .expect("serialize nested array payload");
    let inner: String = serde_json::from_slice(&encoded).expect("outer resultJson string");
    let restored: Value = serde_json::from_str(&inner).expect("inner result JSON");
    assert_eq!(restored["content"][0]["text"], canonical);
    assert_eq!(restored["content"][0]["kind"], "text");
    assert!(!inner.contains("ARRAY_PREVIEW"));
}

#[test]
fn sqlite_root_descriptor_restores_path_and_ten_mib_omitted_sibling_exactly() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let directory = tempfile::tempdir().expect("OpenCode trajectory fixture");
    let source_path = directory.path().join("opencode.db");
    let source_conn = rusqlite::Connection::open(&source_path).expect("OpenCode source DB");
    source_conn
        .execute_batch(
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
             );
             INSERT INTO session VALUES('s1',1,1);
             INSERT INTO message VALUES(
               'message-1','s1',1,'{\"role\":\"assistant\"}'
             );",
        )
        .expect("OpenCode source schema");
    let mut content = "C".repeat(10 * 1024 * 1024 - 4);
    content.push('🙂');
    let source_args = serde_json::json!({
        "path":"src/large.txt",
        "content":content,
    });
    let part = serde_json::json!({
        "type":"tool",
        "tool":"edit",
        "callID":"call-large-edit",
        "state":{
            "status":"completed",
            "input":source_args,
            "output":"updated"
        }
    });
    source_conn
        .execute(
            "INSERT INTO part(id,message_id,session_id,time_created,data)
             VALUES('part-1','message-1','s1',1,?1)",
            [part.to_string()],
        )
        .expect("OpenCode large edit row");

    let mut cache = rusqlite::Connection::open_in_memory().expect("replay cache DB");
    SqliteRecordStore::init_tables(&cache).expect("replay index tables");
    SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
    let imported_id = "opencodeapp-s1";
    cache
        .execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path
             ) VALUES('opencode','s1',?1,?2)",
            params![imported_id, source_path.to_string_lossy()],
        )
        .expect("OpenCode cache fixture");

    let mut streamed = Vec::new();
    write_session_trajectory_with_imported_id(
        &mut cache,
        &mut streamed,
        1,
        OrgtrackTier::Trajectory,
        "managed-opencode",
        Some(imported_id),
    )
    .expect("stream OpenCode trajectory");
    let trajectory: OrgtrackSessionTrajectory =
        serde_json::from_slice(&streamed).expect("valid OpenCode trajectory JSON");
    let edit = trajectory
        .raw_events
        .iter()
        .find(|event| event.name.as_deref() == Some("edit_file_by_replace"))
        .expect("edit trajectory event");
    let restored: Value =
        serde_json::from_str(edit.args_json.as_deref().unwrap()).expect("restored edit args JSON");
    let expected = serde_json::json!({
        "action":"edit",
        "file_path":"src/large.txt",
        "payload":source_args,
    });
    assert_eq!(
        restored, expected,
        "root range must restore omitted siblings"
    );
    let restored_content = restored
        .pointer("/payload/content")
        .and_then(Value::as_str)
        .expect("restored edit content");
    assert_eq!(restored_content.len(), content.len());
    assert_eq!(
        Sha256::digest(restored_content.as_bytes()),
        Sha256::digest(content.as_bytes())
    );
    assert!(restored.get("_replayTruncated").is_none());
    assert!(restored.get("_preview").is_none());
}

#[test]
fn imported_trajectory_prepares_three_lazy_kv_turns_before_strict_scan() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let directory = tempfile::tempdir().expect("lazy trajectory fixture");
        let source_path = directory.path().join(format!("{}.db", source.as_str()));
        let source_conn = rusqlite::Connection::open(&source_path).expect("KV source DB");
        source_conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
            )
            .expect("KV source schema");
        let headers = (0..6)
            .map(|index| {
                serde_json::json!({
                    "bubbleId":format!("b{index}"),
                    "type":if index % 2 == 0 { 1 } else { 2 },
                })
            })
            .collect::<Vec<_>>();
        source_conn
            .execute(
                "INSERT INTO cursorDiskKV(key,value) VALUES('composerData:c1',?1)",
                [serde_json::json!({
                    "composerId":"c1",
                    "createdAt":1,
                    "lastUpdatedAt":6,
                    "fullConversationHeadersOnly":headers,
                })
                .to_string()],
            )
            .expect("composer row");
        for index in 0..6 {
            source_conn
                .execute(
                    "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                    params![
                        format!("bubbleId:c1:b{index}"),
                        serde_json::json!({
                            "bubbleId":format!("b{index}"),
                            "type":if index % 2 == 0 { 1 } else { 2 },
                            "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
                            "text":format!("message {index}"),
                        })
                        .to_string(),
                    ],
                )
                .expect("bubble row");
        }

        let mut cache = rusqlite::Connection::open_in_memory().expect("replay cache");
        SqliteRecordStore::init_tables(&cache).expect("replay tables");
        SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
        let imported_id = format!("{}c1", source.descriptor().session_prefix);
        cache
            .execute(
                "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES(?1,'c1',?2,?3)",
                params![source.as_str(), imported_id, source_path.to_string_lossy()],
            )
            .expect("cache source path");

        let mut sequences = Vec::new();
        for_each_imported_replay_chunk(&mut cache, &imported_id, |_conn, _generation, chunk| {
            sequences.push(chunk.sequence);
            Ok(())
        })
        .expect("strict lazy trajectory scan");
        assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
    }
}

#[test]
fn same_generation_revision_change_rejects_pinned_trajectory_cursor() {
    let cursor = ReplayCursor {
        source_id: "codex_app".to_string(),
        session_id: "codexapp-revision".to_string(),
        generation: "same-generation".to_string(),
        revision: 12,
        through_sequence: 99,
    };
    let error = validate_pinned_replay_cursor("codexapp-revision", "same-generation", 11, &cursor)
        .expect_err("same-generation revision mutation must abort export");
    assert!(error.contains("same-generation@11"));
    assert!(error.contains("same-generation@12"));
}

#[test]
fn imported_trajectory_omits_compact_only_replay_markers() {
    let mut conn = rusqlite::Connection::open_in_memory().expect("marker DB");
    let value = serde_json::json!({
        "output":"legacy output",
        "_replayTruncated":true,
        "_replayGitArtifacts":[{"kind":"commit","sha":"abc1234"}]
    });
    let mut encoded = Vec::new();
    write_replay_value_json_string(
        &mut conn,
        &mut encoded,
        ImportedHistorySourceId::CodexApp,
        "codexapp-marker",
        "generation",
        "event",
        "result",
        &value,
        &[],
    )
    .expect("serialize compatible replay result");
    let inner: String = serde_json::from_slice(&encoded).expect("outer argsJson string");
    let restored: Value = serde_json::from_str(&inner).expect("inner result JSON");
    assert_eq!(restored, serde_json::json!({"output":"legacy output"}));
}
