use super::*;
use crate::store::sqlite::SqliteRecordStore;

#[test]
fn previews_respect_utf8_boundaries() {
    let text = "你".repeat(10_000);
    let (head, head_truncated) = head_preview(&text, 8 * 1024);
    let (tail, tail_truncated) = tail_preview(&text, 8 * 1024);
    assert!(head_truncated && tail_truncated);
    assert!(head.is_char_boundary(head.len()));
    assert!(tail.is_char_boundary(tail.len()));
}

#[test]
fn pending_cursor_never_contains_complete_large_output() {
    let mut background = PendingBackgroundGroup {
        calls: Vec::new(),
        spans: Vec::new(),
        output_preview: String::new(),
        output_bytes: 0,
        git_artifacts: Vec::new(),
    };
    append_background_output(
        &mut background,
        &"x".repeat(1024 * 1024),
        ReplaySourceSpan { start: 0, end: 1 },
    );
    assert!(background.output_preview.len() <= SHELL_PAYLOAD_PREVIEW_BYTES);
    assert_eq!(background.output_bytes, 1024 * 1024);
}

#[test]
fn codex_fallback_payload_range_reports_adjusted_utf8_offsets() {
    let line = serde_json::json!({
        "timestamp":"2026-07-22T00:00:00Z",
        "type":"event_msg",
        "payload":{"type":"agent_message","message":"a你b"}
    })
    .to_string();
    let path = std::env::temp_dir().join(format!(
        "orgii-codex-utf8-fallback-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(&path, format!("{line}\n")).expect("Codex UTF-8 fixture");
    let descriptor = ReplayPayloadDescriptor {
        field_path: "result.content".to_string(),
        kind: ReplayPayloadKind::AgentMessage,
        encoding: ReplayPayloadEncoding::Utf8Text,
        body_projection: None,
        spans: vec![ReplaySourceSpan {
            start: 0,
            end: line.len() as u64 + 1,
        }],
        total_bytes: "a你b".len() as u64,
        source_ordinal: None,
        source_key: None,
    };
    let range = read_payload(
        &path,
        &serde_json::to_string(&vec![descriptor]).expect("Codex payload locator"),
        "event",
        "result.content",
        2,
        1,
    )
    .expect("Codex UTF-8 fallback range");
    assert_eq!(range.offset, 4);
    assert_eq!(range.next_offset, 5);
    assert_eq!(range.text, "b");
    assert!(range.eof);
    let _ = fs::remove_file(path);
}

#[test]
fn ten_mib_tool_args_stay_out_of_index_and_cursor_but_reconstruct_exactly() {
    let command = format!("printf start {} end", "中🙂x".repeat(1_250_000));
    let arguments = serde_json::json!({
        "command": command,
        "workdir": "/tmp/project",
        "path": "src/lib.rs"
    });
    let line: CodexJsonlLine = serde_json::from_value(serde_json::json!({
        "timestamp": "2026-07-22T00:00:00Z",
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "name": "shell_command",
            "arguments": serde_json::to_string(&arguments).unwrap(),
            "call_id": "call-large-args"
        }
    }))
    .expect("Codex tool line");
    let (_, mut calls) =
        pending_tool_calls_from_payload(&line.payload, "").expect("normalized Codex call");
    assert_eq!(calls.len(), 1);
    let full_args = serde_json::to_string(&calls[0].args).expect("full normalized args");
    assert!(full_args.len() > 10 * 1024 * 1024);
    let (descriptor, encoded) =
        compact_codex_tool_args(&mut calls[0], ReplaySourceSpan { start: 0, end: 1 }, 0)
            .expect("large args descriptor");
    let assigned = AssignedToolCall {
        call: calls.remove(0),
        sequence: 0,
        turn_index: 0,
        args_payload: Some(descriptor.clone()),
    };
    let compact_args_bytes = serde_json::to_vec(&assigned.call.args).unwrap().len();
    assert!(
        compact_args_bytes < 80 * 1024,
        "compact args unexpectedly use {compact_args_bytes} bytes"
    );
    assert!(serde_json::to_vec(&assigned).unwrap().len() < 96 * 1024);
    assert_eq!(descriptor.total_bytes, full_args.len() as u64);
    assert_eq!(encoded, full_args);
    assert_eq!(
        payload_text(&descriptor, &line).as_deref(),
        Some(full_args.as_str())
    );
}

#[test]
fn cross_record_output_is_streamed_into_one_artifact_without_concatenation() {
    let path = std::env::temp_dir().join(format!(
        "orgii-codex-cross-record-artifact-{}-{}.jsonl",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let lines = ["first-你", "second-🙂"]
        .into_iter()
        .map(|output| {
            serde_json::json!({
                "timestamp":"2026-07-22T00:00:00Z",
                "type":"response_item",
                "payload":{
                    "type":"function_call_output",
                    "call_id":"background-call",
                    "output":output
                }
            })
            .to_string()
        })
        .collect::<Vec<_>>();
    let mut source = String::new();
    let mut spans = Vec::new();
    for line in &lines {
        let start = source.len() as u64;
        source.push_str(line);
        source.push('\n');
        spans.push(ReplaySourceSpan {
            start,
            end: source.len() as u64,
        });
    }
    fs::write(&path, source).expect("cross-record source");

    let mut conn = rusqlite::Connection::open_in_memory().expect("artifact DB");
    SqliteRecordStore::init_tables(&conn).expect("base schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("artifact schema");
    let tx = conn.transaction().expect("artifact transaction");
    let expected = "first-你second-🙂";
    stream_codex_output_artifact(
        &tx,
        "session",
        "generation",
        "event",
        &path,
        &spans,
        expected.len() as u64,
    )
    .expect("stream cross-record artifact");
    let payload = tx
        .query_row(
            "SELECT artifact.payload
                 FROM imported_replay_payload_artifact_refs AS ref
                 JOIN imported_replay_payload_artifacts AS artifact
                   ON artifact.source=ref.source
                  AND artifact.source_session_id=ref.source_session_id
                  AND artifact.generation=ref.generation
                  AND artifact.content_hash=ref.content_hash
                 WHERE ref.event_id='event' AND ref.field_path='result.output'",
            [],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .expect("read streamed artifact");
    assert_eq!(payload, expected.as_bytes());
    let _ = fs::remove_file(path);
}
