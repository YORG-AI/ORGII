use std::io::{BufWriter, Write};

use super::*;
use crate::projectors::turn_metadata::TurnMetadataAccumulator;

fn replay_cache(path: &Path) -> (rusqlite::Connection, String) {
    use crate::store::sqlite::SqliteRecordStore;

    let cache = rusqlite::Connection::open_in_memory().expect("replay cache");
    SqliteRecordStore::init_tables(&cache).expect("replay tables");
    SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
    let session_id = "clineapp-cline-1".to_string();
    cache
        .execute(
            "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES('cline','cline-1',?1,?2)",
            params![session_id, path.to_string_lossy()],
        )
        .expect("cache Cline source");
    (cache, session_id)
}

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "orgii-cline-replay-{name}-{}-{}.json",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

fn metadata_from_chunks(chunks: &[ActivityChunk]) -> TurnMetadataAccumulator {
    let mut metadata = TurnMetadataAccumulator::new();
    for chunk in chunks {
        metadata.add_event_values_at(
            Some(&chunk.function),
            &chunk.args,
            &chunk.result,
            &chunk.created_at,
        );
    }
    metadata
}

#[test]
fn invalid_partial_rewrite_is_reported_not_ready() {
    let path = temp_path("partial");
    std::fs::write(&path, br#"{"messages":[{"role":"user","content":["#).expect("partial fixture");
    assert!(visit_messages(&path, |_| Ok(())).is_err());
    std::fs::write(
        &path,
        br#"{"messages":[{"role":"user","content":[{"type":"text","text":"ok"}]}]}"#,
    )
    .expect("complete fixture");
    visit_messages(&path, |_| Ok(())).expect("complete probe");
    let _ = std::fs::remove_file(path);
}

#[test]
fn sink_failures_are_not_misclassified_as_invalid_source_snapshots() {
    let path = temp_path("sink-error");
    std::fs::write(
        &path,
        br#"{"messages":[{"role":"user","content":[{"type":"text","text":"ok"}]}]}"#,
    )
    .expect("valid Cline fixture");
    let error = visit_messages(&path, |_| Err("replay index write failed".to_string()))
        .expect_err("sink failure must propagate");
    assert!(error.starts_with("process Cline replay source"));
    assert!(error.contains("replay index write failed"));
    assert!(!error.starts_with("parse Cline replay source"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn thirty_mib_document_streams_one_message_at_a_time() {
    let path = temp_path("30mib");
    let file = File::create(&path).expect("fixture file");
    let mut writer = BufWriter::new(file);
    writer.write_all(br#"{"messages":["#).unwrap();
    let padding = "x".repeat(30 * 1024);
    for index in 0..1024 {
        if index > 0 {
            writer.write_all(b",").unwrap();
        }
        serde_json::to_writer(
            &mut writer,
            &json!({
                "role":"assistant",
                "content":[{"type":"text","text":padding}],
                "ts":1_700_000_000_000_i64 + index,
            }),
        )
        .unwrap();
    }
    writer.write_all(b"]}").unwrap();
    writer.flush().unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() >= 30 * 1024 * 1024);
    let mut count = 0_u64;
    visit_messages(&path, |_| {
        count += 1;
        Ok(())
    })
    .expect("stream 30 MiB fixture");
    assert_eq!(count, 1024);
    let _ = std::fs::remove_file(path);
}

#[test]
fn cline_compact_projection_matches_full_large_edit_and_git_output() {
    let path = temp_path("metadata");
    let large_edit = "new line\n".repeat(2_000);
    let git_output = format!(
        "[feature cab1234] metadata\n{}\nhttps://github.com/acme/cline/pull/99",
        "middle".repeat(14 * 1024)
    );
    assert!(
        large_edit.len() > crate::sources::imported_history::replay::NORMAL_PAYLOAD_PREVIEW_BYTES
    );
    assert!(git_output.len() > 80 * 1024);
    let transcript = json!({
        "messages":[
            {"role":"user","content":[{"type":"text","text":"<user_input mode=\"act\">metadata</user_input>"}],"ts":1_700_000_000_000_i64},
            {"role":"assistant","content":[{
                "type":"tool_use","id":"edit-1","name":"editor",
                "input":{"path":"src/cline-large.rs","old_text":"old\nvalue","new_text":large_edit}
            }],"ts":1_700_000_000_001_i64},
            {"role":"user","content":[{
                "type":"tool_result","tool_use_id":"edit-1","content":"done"
            }],"ts":1_700_000_000_002_i64},
            {"role":"assistant","content":[{
                "type":"tool_use","id":"git-1","name":"run_commands",
                "input":{"commands":["git commit -m metadata"]}
            }],"ts":1_700_000_000_003_i64},
            {"role":"user","content":[{
                "type":"tool_result","tool_use_id":"git-1",
                "content":[{"result":git_output,"success":true}]
            }],"ts":1_700_000_000_004_i64}
        ]
    });
    std::fs::write(&path, transcript.to_string()).expect("Cline metadata transcript");
    let (mut cache, session_id) = replay_cache(&path);
    let legacy =
        crate::sources::cline::history::load_cline_history_for_session(&cache, &session_id)
            .expect("load full Cline metadata baseline");
    let expected = metadata_from_chunks(&legacy);
    assert_eq!(expected.modified_files()[0].path, "src/cline-large.rs");
    assert_eq!(expected.modified_files()[0].additions, 2_000);
    assert_eq!(expected.modified_files()[0].deletions, 2);
    assert!(expected
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("cab1234")));
    // The legacy full loader caps one Cline tool result at 50k chars, so
    // the tail PR URL is the exact metadata that the bounded adapter must
    // improve on rather than reproduce losing.
    assert!(!expected
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.pr_number == Some(99)));

    let projected = crate::sources::imported_history::replay::project_turn_metadata(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        None,
    )
    .expect("project compact Cline metadata");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].modified_files, expected.modified_files());
    assert_eq!(
        serde_json::to_value(&projected[0].resource_interactions).unwrap(),
        serde_json::to_value(expected.resource_interactions()).unwrap()
    );
    assert!(projected[0]
        .git_artifacts
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("cab1234")));
    assert!(projected[0]
        .git_artifacts
        .iter()
        .any(|artifact| artifact.pr_number == Some(99)));
    let _ = std::fs::remove_file(path);
}

#[test]
fn cline_public_replay_keeps_last_valid_generation_during_partial_rewrite() {
    let path = temp_path("atomic");
    let large_text = "cline-large-".repeat(900_000);
    let initial = json!({
        "messages":[
            {"role":"user","content":[{"type":"text","text":"<user_input mode=\"act\">hello</user_input>"}],"ts":1_700_000_000_000_i64},
            {"role":"assistant","content":[{"type":"text","text":large_text}],"ts":1_700_000_000_001_i64}
        ]
    });
    std::fs::write(&path, initial.to_string()).expect("initial Cline transcript");
    let (mut cache, session_id) = replay_cache(&path);
    let opened = crate::sources::imported_history::replay::open_window(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open Cline bounded replay");
    assert_eq!(opened.chunks.len(), 2);
    assert_eq!(take_sync_attempts(), 1, "initial document indexed once");
    let assistant = opened
        .chunks
        .iter()
        .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
        .expect("Cline assistant");
    let artifact_count = cache
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source='cline' AND generation=?1",
            [&opened.cursor.generation],
            |row| row.get::<_, i64>(0),
        )
        .expect("count deduplicated Cline artifacts");
    let artifact_ref_count = cache
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs
                 WHERE source='cline' AND generation=?1",
            [&opened.cursor.generation],
            |row| row.get::<_, i64>(0),
        )
        .expect("count Cline artifact refs");
    assert_eq!(
        artifact_count, 1,
        "identical compatibility fields share bytes"
    );
    assert_eq!(artifact_ref_count, 2);
    let first_range = crate::sources::imported_history::replay::read_payload_range(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        &opened.cursor.generation,
        &assistant.chunk.chunk_id,
        "result.content",
        0,
        Some(2048),
    )
    .expect("Cline payload artifact");
    assert_eq!(first_range.text, large_text[..2048]);

    std::fs::write(&path, br#"{"messages":[{"role":"assistant","content":["#)
        .expect("partial Cline rewrite");
    let partial = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        &opened.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("serve previous Cline generation");
    assert!(partial.stats.not_ready);
    assert!(!partial.reset_required);
    assert_eq!(partial.cursor.generation, opened.cursor.generation);
    assert_eq!(partial.stats.parsed_bytes, 0);
    assert_eq!(partial.stats.parsed_rows, 0);
    assert_eq!(partial.stats.upserted_events, 0);
    assert_eq!(take_sync_attempts(), 1, "invalid snapshot parsed once");
    let rejected_rows = cache
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_rejected_snapshots
                 WHERE source='cline' AND source_session_id='cline-1'
                   AND rejection_kind='cline_invalid_document'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("count rejected Cline snapshot");
    assert_eq!(rejected_rows, 1);

    for _ in 0..20 {
        let unchanged_invalid = crate::sources::imported_history::replay::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            &opened.cursor,
            crate::sources::imported_history::replay::ReplayLimits::default(),
        )
        .expect("serve unchanged rejected Cline snapshot");
        assert!(unchanged_invalid.stats.not_ready);
        assert!(!unchanged_invalid.reset_required);
        assert_eq!(
            unchanged_invalid.cursor.generation,
            opened.cursor.generation
        );
        assert_eq!(unchanged_invalid.stats.parsed_bytes, 0);
        assert_eq!(unchanged_invalid.stats.parsed_rows, 0);
        assert_eq!(unchanged_invalid.stats.upserted_events, 0);
    }
    assert_eq!(
        take_sync_attempts(),
        0,
        "unchanged rejected snapshot must not be reparsed"
    );
    let old_range = crate::sources::imported_history::replay::read_payload_range(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        &opened.cursor.generation,
        &assistant.chunk.chunk_id,
        "result.content",
        2048,
        Some(2048),
    )
    .expect("old Cline artifact during invalid rewrite");
    assert_eq!(old_range.text, large_text[2048..4096]);

    let complete = json!({
        "messages":[
            {"role":"user","content":[{"type":"text","text":"hello"}]},
            {"role":"assistant","content":[{"type":"text","text":"done"}]},
            {"role":"user","content":[{"type":"text","text":"second"}]},
            {"role":"assistant","content":[{"type":"text","text":"second done"}]}
        ]
    });
    std::fs::write(&path, complete.to_string()).expect("complete Cline rewrite");
    let reset = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        &opened.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("publish complete Cline generation");
    assert!(reset.reset_required);
    assert_ne!(reset.cursor.generation, opened.cursor.generation);
    assert_eq!(reset.chunks.len(), 2);
    assert_eq!(take_sync_attempts(), 1, "changed snapshot retried once");
    let rejected_rows = cache
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_rejected_snapshots
                 WHERE source='cline' AND source_session_id='cline-1'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("count cleared Cline rejection watermark");
    assert_eq!(rejected_rows, 0, "successful publish clears watermark");

    let unchanged = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Cline,
        &session_id,
        &reset.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("unchanged Cline poll");
    assert_eq!(unchanged.stats.parsed_rows, 0);
    assert_eq!(unchanged.stats.upserted_events, 0);
    let _ = std::fs::remove_file(path);
}
