use super::*;

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
