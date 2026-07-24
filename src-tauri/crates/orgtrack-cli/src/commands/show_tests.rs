use super::*;

fn payload(
    field_path: &str,
    encoding: replay::ReplayPayloadEncoding,
    total_bytes: usize,
) -> ReplayPayloadDescriptor {
    ReplayPayloadDescriptor {
        field_path: field_path.to_string(),
        kind: replay::ReplayPayloadKind::ToolOutput,
        encoding,
        body_projection: None,
        spans: Vec::new(),
        total_bytes: total_bytes as u64,
        source_ordinal: None,
        source_key: None,
    }
}

fn range_for(text: &str, field_path: &str, offset: u64, max_bytes: usize) -> ReplayPayloadRange {
    let start = offset as usize;
    let end = (start + max_bytes).min(text.len());
    ReplayPayloadRange {
        event_id: "event-1".to_string(),
        field_path: field_path.to_string(),
        offset,
        next_offset: end as u64,
        eof: end == text.len(),
        total_bytes: text.len() as u64,
        text: text[start..end].to_string(),
    }
}

#[test]
fn streamed_json_restores_root_and_nested_array_payloads() {
    let args_full = r#"{"command":"FULL_ROOT_COMMAND"}"#;
    let result_full = "FULL_NESTED_\"quoted\"\\path\nnext";
    let indexed = ReplayIndexedChunk {
        sequence: 7,
        turn_index: 2,
        chunk: ActivityChunk::new("codex-test", "tool_call", "shell")
            .with_args(serde_json::json!({
                "command": "ARGS_TAIL_PREVIEW",
                "_preview": "compact-only"
            }))
            .with_result(serde_json::json!({
                "content": [{"text": "ARRAY_TAIL_PREVIEW", "kind": "text"}]
            })),
        payloads: vec![
            payload(
                "args",
                replay::ReplayPayloadEncoding::JsonValue,
                args_full.len(),
            ),
            payload(
                "result.content.0.text",
                replay::ReplayPayloadEncoding::Utf8Text,
                result_full.len(),
            ),
        ],
    };
    let mut offsets = Vec::new();
    let mut output = Vec::new();

    write_indexed_chunk_json_with_reader(
        &mut output,
        &indexed,
        &mut |field_path, offset, max_bytes| {
            offsets.push((field_path.to_string(), offset));
            let text = match field_path {
                "args" => args_full,
                "result.content.0.text" => result_full,
                other => panic!("unexpected payload path {other}"),
            };
            Ok(range_for(text, field_path, offset, max_bytes))
        },
    )
    .expect("streamed JSON should rebuild both payload shapes");

    let value: serde_json::Value = serde_json::from_slice(&output).expect("valid JSON");
    assert_eq!(value["args"]["command"], "FULL_ROOT_COMMAND");
    assert!(value["args"].get("_preview").is_none());
    assert_eq!(value["result"]["content"][0]["text"], result_full);
    assert_eq!(value["result"]["content"][0]["kind"], "text");
    assert!(!String::from_utf8(output).unwrap().contains("TAIL_PREVIEW"));
    assert_eq!(
        offsets,
        vec![
            ("args".to_string(), 0),
            ("result.content.0.text".to_string(), 0)
        ]
    );
}

#[test]
fn streamed_markdown_and_csv_use_canonical_payload_not_preview() {
    let canonical = "FULL,\"quoted\"\nsecond-line";
    let indexed = ReplayIndexedChunk {
        sequence: 1,
        turn_index: 0,
        chunk: ActivityChunk::new("claude_code-test", "assistant", "assistant")
            .with_result(serde_json::json!({"observation": "TAIL_PREVIEW"})),
        payloads: vec![payload(
            "result.observation",
            replay::ReplayPayloadEncoding::Utf8Text,
            canonical.len(),
        )],
    };
    let mut markdown = Vec::new();
    write_indexed_chunk_md_with_reader(
        &mut markdown,
        &indexed,
        &mut |field_path, offset, max_bytes| {
            Ok(range_for(canonical, field_path, offset, max_bytes))
        },
    )
    .expect("markdown payload should stream");
    let markdown = String::from_utf8(markdown).unwrap();
    assert!(markdown.contains(canonical));
    assert!(!markdown.contains("TAIL_PREVIEW"));

    let mut csv = Vec::new();
    write_indexed_chunk_csv_with_reader(
        &mut csv,
        &indexed,
        &mut |field_path, offset, max_bytes| {
            Ok(range_for(canonical, field_path, offset, max_bytes))
        },
    )
    .expect("CSV payload should stream");
    let csv = String::from_utf8(csv).unwrap();
    assert!(csv.contains("FULL,"));
    assert!(csv.contains("\"\"quoted\"\" second-line"));
    assert!(!csv.contains("TAIL_PREVIEW"));
}

#[test]
fn root_body_projection_keeps_markdown_and_csv_bounded_without_payload_reads() {
    let mut descriptor = payload(
        "args",
        replay::ReplayPayloadEncoding::JsonValue,
        10 * 1024 * 1024,
    );
    descriptor.body_projection = Some(replay::ReplayPayloadBodyProjection {
        field_path: "args.command".to_string(),
        text: "cargo test --workspace".to_string(),
        truncated: true,
    });
    let indexed = ReplayIndexedChunk {
        sequence: 1,
        turn_index: 0,
        chunk: ActivityChunk::new("codex-test", "tool_call", "shell")
            .with_args(serde_json::json!({"command":"COMPACT_PREVIEW"})),
        payloads: vec![descriptor],
    };

    let mut markdown = Vec::new();
    write_indexed_chunk_md_with_reader(&mut markdown, &indexed, &mut |_, _, _| {
        panic!("bounded body projection must not hydrate the root payload")
    })
    .expect("projected markdown");
    let markdown = String::from_utf8(markdown).unwrap();
    assert!(markdown.contains("cargo test --workspace"));
    assert!(markdown.contains("large replay body truncated"));
    assert!(!markdown.contains("COMPACT_PREVIEW"));

    let mut csv = Vec::new();
    write_indexed_chunk_csv_with_reader(&mut csv, &indexed, &mut |_, _, _| {
        panic!("bounded body projection must not hydrate the root payload")
    })
    .expect("projected CSV");
    let csv = String::from_utf8(csv).unwrap();
    assert!(csv.contains("cargo test --workspace"));
    assert!(csv.contains("large replay body truncated"));
    assert!(!csv.contains("COMPACT_PREVIEW"));
}

#[test]
fn explicit_encoding_not_path_shape_controls_json_reconstruction() {
    let canonical = r#"{"text":"FULL_OBJECT","kind":"text"}"#;
    let indexed = ReplayIndexedChunk {
        sequence: 1,
        turn_index: 0,
        chunk: ActivityChunk::new("codex-test", "assistant", "assistant")
            .with_result(serde_json::json!({"content":["COMPACT_PREVIEW"]})),
        payloads: vec![payload(
            "result.content.0",
            replay::ReplayPayloadEncoding::JsonValue,
            canonical.len(),
        )],
    };
    let mut output = Vec::new();
    write_indexed_chunk_json_with_reader(
        &mut output,
        &indexed,
        &mut |field_path, offset, max_bytes| {
            Ok(range_for(canonical, field_path, offset, max_bytes))
        },
    )
    .expect("nested JSON value payload");
    let restored: serde_json::Value = serde_json::from_slice(&output).expect("valid JSON");
    assert_eq!(restored["result"]["content"][0]["text"], "FULL_OBJECT");
    assert_eq!(restored["result"]["content"][0]["kind"], "text");
}
